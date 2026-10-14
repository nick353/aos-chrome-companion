import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { chmod, lstat, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { companionLockTransaction } from "../src/setup/lock-transaction.mjs";
import { companionBootIdentity } from "../src/setup/lock-identity.mjs";
import { inspectSetupLock } from "../src/shared/doctor-diagnostics.mjs";
import { inspectCompanionLockMaintenance, recoverCompanionDeadLock } from "../src/setup/dead-lock-maintenance.mjs";
import { validateLocatorTree } from "../src/mcp/locator-validation.mjs";
import { materializeTransactionActions } from "../src/mcp/action-materializer.mjs";

const token = "12345678-1234-1234-1234-123456789abc";
async function fixture(run) {
  const root = await realpath(await mkdtemp(join(tmpdir(), "companion-stability-")));
  const actor = spawn(process.execPath, ["-e", "process.exit(0)"], { stdio: "ignore" });
  const pid = actor.pid; await once(actor, "exit");
  try { await run(join(root, "setup.lock"), root, pid); } finally { await rm(root, { recursive: true, force: true }); }
}
const exclusion = path => ({ excluded: true, allEntrypointsExcluded: true, legacyActorsExcluded: true,
  lockPath: path, source: "owned fixture exclusion", observedAt: new Date().toISOString() });

test("nested position selectors and multiple positions fail before materialization or candidate scan", async () => {
  for (const locator of [{ css: "button", nth: 0, last: true }, { css: "button", has: { css: "span", nth: 0 } },
    { css: "button", allOf: [{ anyOf: [{ text: "x", ordinal: 0 }] }] }, { css: "button", nth: -1 }, { css: "button", nth: 5000 }]) {
    assert.throws(() => validateLocatorTree(locator), { code: "semantic_locator_index_invalid" });
    await assert.rejects(materializeTransactionActions([{ method: "page.click", params: { locator } }]), { code: "semantic_locator_index_invalid" });
  }
  assert.deepEqual(validateLocatorTree({ css: "button", nth: 4999, has: { text: "x" } }).nth, 4999);
  const source = await readFile(new URL("../extension/service-worker.js", import.meta.url), "utf8");
  assert.match(source, /const locateAll[^]*?validateLocatorTree\(locator\);/u);
  const server = await readFile(new URL("../src/mcp/server.mjs", import.meta.url), "utf8");
  assert.match(server, /maxTextChars: z.number\(\).int\(\).min\(1_000\)/u);
  assert.match(server, /maxCharsPerPage: z.number\(\).int\(\).min\(100\).max\(20000\)/u);
});

test("crossboot device renumber recovers only stable coordinator binding and dead owners under kernel exclusion", async () => fixture(async (path, root, deadPid) => {
  const initial = await companionLockTransaction("acquire", path);
  assert.equal(initial.schema, "companion_lock.v3");
  assert.equal(initial.bootIdentity, await companionBootIdentity());
  await companionLockTransaction("release", path, initial);
  const dead = { ...JSON.parse(initial.workBytes), pid: deadPid, bootIdentity: "darwin:1:1",
    coordinator: { ...initial.coordinator, dev: String(Number(initial.coordinator.dev) + 1) } };
  await writeFile(path, JSON.stringify(dead), { mode: 0o600 });
  await writeFile(path + ".guard.v2", JSON.stringify({ ...dead, schema: "companion_lock_guard.v3", workPid: deadPid, transactionId: dead.acquireId }), { mode: 0o600 });
  const diagnosed = await inspectSetupLock(path);
  assert.equal(diagnosed.exactBlocker, "companion_lock_dead_v3_recovery_available");
  const recovered = await companionLockTransaction("acquire", path);
  assert.equal(recovered.acquired, true, JSON.stringify(recovered));
  assert.equal(recovered.coordinator.id, initial.coordinator.id);
  await companionLockTransaction("release", path, recovered);
}));

test("inode alone, same-boot device change, live reused PID, changed stable ID and unsafe markers cannot reclaim", async () => fixture(async (path, root, deadPid) => {
  const initial = await companionLockTransaction("acquire", path); await companionLockTransaction("release", path, initial);
  const base = { ...JSON.parse(initial.workBytes), pid: deadPid, bootIdentity: "darwin:1:1",
    coordinator: { ...initial.coordinator, dev: String(Number(initial.coordinator.dev) + 1) } };
  for (const change of [{ coordinator: { ...base.coordinator, id: token } }, { bootIdentity: initial.bootIdentity }, { pid: process.pid }]) {
    const bytes = JSON.stringify({ ...base, ...change }); await writeFile(path, bytes, { mode: 0o600 });
    assert.equal((await companionLockTransaction("acquire", path)).acquired, false);
    assert.equal(await readFile(path, "utf8"), bytes);
  }
  await chmod(path, 0o666);
  assert.equal((await companionLockTransaction("acquire", path)).exactBlocker, "companion_lock_path_not_private");
}));

test("old v2 inspect and failed acquire preserve empty coordinator bytes; explicit excluded maintenance quarantines exact old markers", async () => fixture(async (path, root, deadPid) => {
  await writeFile(path + ".coordinator", "", { mode: 0o600 });
  const stat = await lstat(path + ".coordinator");
  const owner = { schema: "companion_lock.v2", pid: deadPid, token, acquireId: token,
    coordinator: { path: path + ".coordinator", dev: String(stat.dev + 1), ino: String(stat.ino) } };
  const workBytes = JSON.stringify(owner), guardBytes = JSON.stringify({ ...owner, schema: "companion_lock_guard.v2", workPid: deadPid, transactionId: token });
  await writeFile(path, workBytes, { mode: 0o600 }); await writeFile(path + ".guard.v2", guardBytes, { mode: 0o600 });
  assert.equal((await companionLockTransaction("inspect", path)).inspected, true);
  assert.equal((await companionLockTransaction("acquire", path)).acquired, false);
  assert.equal(await readFile(path + ".coordinator", "utf8"), "");
  assert.equal(await readFile(path, "utf8"), workBytes);
  const plan = await inspectCompanionLockMaintenance(path);
  assert.equal(plan.allowed, true, JSON.stringify(plan));
  assert.equal((await recoverCompanionDeadLock(plan)).applied, false);
  const recovered = await recoverCompanionDeadLock(plan, { verifySchedulingExclusion: exclusion });
  assert.equal(recovered.applied, true, JSON.stringify(recovered));
  assert.equal(recovered.kernelExclusionVerified, true);
  assert.equal(await readFile(join(recovered.recoveryPath, "work.lock"), "utf8"), workBytes);
  assert.equal(await readFile(join(recovered.recoveryPath, "guard.v2"), "utf8"), guardBytes);
  assert.equal(await readFile(path + ".coordinator", "utf8"), "");
  await assert.rejects(lstat(path), { code: "ENOENT" });
  const next = await companionLockTransaction("acquire", path); assert.equal(next.acquired, true);
  await companionLockTransaction("release", path, next);
}));
