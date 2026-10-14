import assert from "node:assert/strict";
import { lstat, mkdir, mkdtemp, readFile, readdir, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { inspectCompanionLockMaintenance, recoverCompanionDeadLock } from "../src/setup/dead-lock-maintenance.mjs";

const token = "12345678-1234-1234-1234-123456789abc";
const dead = () => { throw Object.assign(new Error("dead"), { code: "ESRCH" }); };
async function fixture(run) {
  const root = await realpath(await mkdtemp(join(tmpdir(), "companion-dead-lock-")));
  const path = join(root, "setup.lock");
  try {
    await writeFile(path, JSON.stringify({ schema: "companion_lock.v1", pid: 123, token }));
    await mkdir(`${path}.guard`);
    await writeFile(join(`${path}.guard`, "owner.json"), JSON.stringify({ pid: 456, token }));
    await run(path, root);
  } finally { await rm(root, { recursive: true, force: true }); }
}
const exclusion = async (lockPath) => ({ lockPath, excluded: true, allEntrypointsExcluded: true, legacyActorsExcluded: true, observedAt: new Date().toISOString(), source: "isolated_fixture_no_scheduler_or_other_actors" });

test("dead-lock dry run writes nothing and apply preserves exact work first and guard last", async () => fixture(async (path, root) => {
  const work = await readFile(path, "utf8");
  const guard = await readFile(join(`${path}.guard`, "owner.json"), "utf8");
  const before = await readdir(root);
  const plan = await inspectCompanionLockMaintenance(path, { probeOwner: dead });
  assert.equal(plan.allowed, true);
  assert.deepEqual(await readdir(root), before);
  assert.equal((await recoverCompanionDeadLock(plan, { probeOwner: dead })).exactBlocker, "companion_lock_maintenance_scheduling_exclusion_required");
  const result = await recoverCompanionDeadLock(plan, { probeOwner: dead, verifySchedulingExclusion: exclusion });
  assert.equal(result.applied, true);
  assert.equal(result.preservationVerified, true);
  assert.equal(result.originalsAbsentVerified, true);
  assert.deepEqual(result.preserved.map((item) => item.originalPath), [path, `${path}.guard`]);
  assert.equal(await readFile(result.preserved[0].path, "utf8"), work);
  assert.equal(await readFile(join(result.preserved[1].path, "owner.json"), "utf8"), guard);
  await assert.rejects(lstat(path), { code: "ENOENT" });
  await assert.rejects(lstat(`${path}.guard`), { code: "ENOENT" });
}));

test("live, EPERM, malformed, extra guard content and changed owner fail closed", async () => fixture(async (path) => {
  for (const probeOwner of [() => {}, () => { throw Object.assign(new Error("restricted"), { code: "EPERM" }); }]) {
    const plan = await inspectCompanionLockMaintenance(path, { probeOwner });
    assert.equal(plan.allowed, false);
    assert.equal(plan.exactBlocker, "companion_lock_maintenance_owner_live_or_unknown");
  }
  const plan = await inspectCompanionLockMaintenance(path, { probeOwner: dead });
  await writeFile(path, JSON.stringify({ schema: "companion_lock.v1", pid: 124, token }));
  const result = await recoverCompanionDeadLock(plan, { probeOwner: dead, verifySchedulingExclusion: exclusion });
  assert.equal(result.exactBlocker, "companion_lock_maintenance_identity_or_liveness_changed");
  assert.equal(result.recoveryPath, null);
  await writeFile(path, "malformed");
  assert.equal((await inspectCompanionLockMaintenance(path, { probeOwner: dead })).allowed, false);
  await writeFile(path, "123\n");
  await writeFile(join(`${path}.guard`, "foreign"), "preserve");
  assert.equal((await inspectCompanionLockMaintenance(path, { probeOwner: dead })).exactBlocker, "companion_lock_maintenance_guard_contents_uncertain");
}));

test("partial apply preserves guard when scheduling exclusion disappears after preserving work", async () => fixture(async (path) => {
  const plan = await inspectCompanionLockMaintenance(path, { probeOwner: dead });
  let calls = 0;
  const result = await recoverCompanionDeadLock(plan, { probeOwner: dead, verifySchedulingExclusion: async (lockPath) => ++calls < 3 ? exclusion(lockPath) : null });
  assert.equal(result.applied, false);
  assert.equal(result.exactBlocker, "companion_lock_maintenance_scheduling_exclusion_lost_guard_preserved");
  assert.equal(result.preserved.length, 1);
  assert.equal((await lstat(`${path}.guard`)).isDirectory(), true);
  assert.equal(JSON.parse(await readFile(result.preserved[0].path, "utf8")).pid, 123);
  const restart = await inspectCompanionLockMaintenance(path, { probeOwner: dead });
  assert.equal(restart.work.exists, false);
  assert.equal((await recoverCompanionDeadLock(restart, { probeOwner: dead, verifySchedulingExclusion: exclusion })).applied, true);
}));

test("dead legacy PID requires fresh exclusion including legacy actors; no age reclaim", async () => fixture(async (path) => {
  await writeFile(path, "123\n");
  const plan = await inspectCompanionLockMaintenance(path, { probeOwner: dead });
  assert.equal(plan.work.owner.legacy, true);
  for (const change of [{ legacyActorsExcluded: false }, { observedAt: "2000-01-01T00:00:00Z" }, { lockPath: "/foreign/setup.lock" }]) {
    const result = await recoverCompanionDeadLock(plan, { probeOwner: dead, verifySchedulingExclusion: async (lockPath) => ({ ...await exclusion(lockPath), ...change }) });
    assert.equal(result.exactBlocker, "companion_lock_maintenance_scheduling_exclusion_required");
    assert.equal(await readFile(path, "utf8"), "123\n");
  }
}));

test("maintenance rejects unsupported targets and symlink aliases", async () => fixture(async (path, root) => {
  assert.equal((await inspectCompanionLockMaintenance(join(root, "state.json"))).exactBlocker, "companion_lock_maintenance_target_not_supported");
  const alias = join(root, "alias");
  await symlink(root, alias);
  assert.equal((await inspectCompanionLockMaintenance(join(alias, "setup.lock"), { probeOwner: dead })).allowed, false);
  await rm(path);
  await symlink(join(`${path}.guard`, "owner.json"), path);
  assert.equal((await inspectCompanionLockMaintenance(path, { probeOwner: dead })).exactBlocker, "companion_lock_maintenance_path_type_invalid");
}));
