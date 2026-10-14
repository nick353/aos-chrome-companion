import { createHash } from "node:crypto";
import { lstat, mkdir, mkdtemp, readFile, readdir, rename } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { companionLockTransaction } from "./lock-transaction.mjs";

const TOKEN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/iu;
const digest = (bytes) => createHash("sha256").update(bytes).digest("hex");
const preservedIdentity = (before, after) => before.exists === after.exists && before.sha256 === after.sha256
  && JSON.stringify(before.owner) === JSON.stringify(after.owner)
  && ["dev", "ino", "mode", "size", "mtimeMs"].every((field) => before.identity?.[field] === after.identity?.[field])
  && ["dev", "ino", "size", "mtimeMs"].every((field) => before.ownerIdentity?.[field] === after.ownerIdentity?.[field]);

export function lockOwnerLiveness(pid, probeOwner = (owner) => process.kill(owner, 0)) {
  if (!Number.isSafeInteger(pid) || pid < 1) return "unknown";
  try { probeOwner(pid); return "live"; }
  catch (error) { return error?.code === "ESRCH" ? "dead" : "unknown"; }
}

function parseOwner(text, guard) {
  if (!guard && /^[1-9]\d*\s*$/u.test(text) && Number.isSafeInteger(Number(text))) return { pid: Number(text), token: null, legacy: true };
  try {
    const owner = JSON.parse(text);
    if (Number.isSafeInteger(owner?.pid) && owner.pid > 0 && TOKEN.test(owner.token)
      && (guard || owner.schema === "companion_lock.v1")) return { pid: owner.pid, token: owner.token, legacy: false };
  } catch {}
  return null;
}

async function assertParents(path) {
  let current = resolve(dirname(path));
  while (true) {
    const info = await lstat(current);
    if (!info.isDirectory() || info.isSymbolicLink()) throw new Error("companion_lock_maintenance_parent_not_directory");
    const parent = dirname(current);
    if (parent === current) break;
    current = parent;
  }
}

async function snapshot(path, guard, probeOwner) {
  let info;
  try { info = await lstat(path); }
  catch (error) { if (error.code === "ENOENT") return { path, exists: false }; throw error; }
  const identity = { dev: info.dev, ino: info.ino, mode: info.mode, size: info.size, mtimeMs: info.mtimeMs, ctimeMs: info.ctimeMs };
  if (info.isSymbolicLink() || (guard ? !info.isDirectory() : !info.isFile())) return { path, exists: true, identity, ownerState: "unknown", exactBlocker: "companion_lock_maintenance_path_type_invalid" };
  if (guard && (await readdir(path)).sort().join(",") !== "owner.json") return { path, exists: true, identity, ownerState: "unknown", exactBlocker: "companion_lock_maintenance_guard_contents_uncertain" };
  const ownerPath = guard ? join(path, "owner.json") : path;
  const ownerInfo = await lstat(ownerPath);
  if (!ownerInfo.isFile() || ownerInfo.isSymbolicLink() || ownerInfo.size > 16_384) return { path, exists: true, identity, ownerState: "unknown", exactBlocker: "companion_lock_maintenance_owner_type_invalid" };
  const bytes = await readFile(ownerPath);
  const owner = parseOwner(bytes.toString("utf8"), guard);
  return { path, exists: true, identity, ownerIdentity: { dev: ownerInfo.dev, ino: ownerInfo.ino, size: ownerInfo.size, mtimeMs: ownerInfo.mtimeMs, ctimeMs: ownerInfo.ctimeMs }, sha256: digest(bytes),
    owner, ownerState: lockOwnerLiveness(owner?.pid, probeOwner), exactBlocker: owner ? null : "companion_lock_maintenance_owner_malformed" };
}

// Read-only. Age never authorizes reclamation. The exact inode, bytes, PID and
// token are re-read on apply, and recoverable copies retain both original owners.
export async function inspectCompanionLockMaintenance(lockPath, { probeOwner } = {}) {
  const path = resolve(lockPath);
  if (!["setup.lock", "control-plane-sync.lock"].includes(path.split(/[\\/]/u).at(-1))) return { allowed: false, exactBlocker: "companion_lock_maintenance_target_not_supported" };
  try {
    await assertParents(path);
    const guardV2Path = `${path}.guard.v2`;
    if (await lstat(guardV2Path).catch(error => { if (error.code !== "ENOENT") throw error; return null; })) {
      const read = async markerPath => {
        const stat = await lstat(markerPath).catch(error => { if (error.code !== "ENOENT") throw error; return null; });
        if (!stat) return { path: markerPath, exists: false };
        if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 16384 || (stat.mode & 0o022) || process.getuid && stat.uid !== process.getuid()) throw new Error("companion_lock_maintenance_path_type_invalid");
        const bytes = await readFile(markerPath, "utf8"), fresh = await lstat(markerPath);
        if (["dev", "ino", "size", "mtimeMs", "ctimeMs"].some(key => stat[key] !== fresh[key])) throw new Error("companion_lock_maintenance_identity_or_liveness_changed");
        const owner = bytes.trim() ? JSON.parse(bytes) : null;
        return { path: markerPath, exists: true, bytes, sha256: digest(bytes), owner,
          identity: { dev: String(stat.dev), ino: String(stat.ino) }, ownerState: lockOwnerLiveness(owner?.pid, probeOwner) };
      };
      const work = await read(path), guard = await read(guardV2Path);
      const coordinator = await read(`${path}.coordinator`);
      const schemasValid = (!work.exists || work.owner.schema === "companion_lock.v2") && guard.owner.schema === "companion_lock_guard.v2";
      const legacyGuard = await lstat(`${path}.guard`).catch(error => { if (error.code !== "ENOENT") throw error; return null; });
      const exactBlocker = !schemasValid ? "companion_lock_maintenance_owner_malformed"
        : !coordinator.exists || legacyGuard ? "companion_lock_maintenance_mixed_or_missing_coordinator"
          : [work, guard].some(item => item.exists && item.ownerState !== "dead") || lockOwnerLiveness(guard.owner.workPid, probeOwner) !== "dead"
            ? "companion_lock_maintenance_owner_live_or_unknown" : null;
      return { schema: "companion_dead_lock_maintenance.v1", mode: "dry_run", format: "kernel_v2",
        allowed: !exactBlocker, exactBlocker, lockPath: path, work, guard, coordinator, schedulingExclusionVerified: false };
    }
    const work = await snapshot(path, false, probeOwner);
    const guard = await snapshot(`${path}.guard`, true, probeOwner);
    const exactBlocker = [work, guard].find((item) => item.exactBlocker)?.exactBlocker
      ?? (!guard.exists ? "companion_lock_maintenance_guard_missing_use_normal_acquisition" : null)
      ?? ([work, guard].some((item) => item.exists && item.ownerState !== "dead") ? "companion_lock_maintenance_owner_live_or_unknown" : null);
    return { schema: "companion_dead_lock_maintenance.v1", mode: "dry_run", allowed: !exactBlocker, exactBlocker, lockPath: path, work, guard, schedulingExclusionVerified: false };
  } catch (error) {
    return { schema: "companion_dead_lock_maintenance.v1", allowed: false, lockPath: path, exactBlocker: error?.code ?? error.message };
  }
}

export async function recoverCompanionDeadLock(plan, { verifySchedulingExclusion, probeOwner } = {}) {
  const preserved = [];
  let recoveryPath = null;
  const stop = (exactBlocker) => ({ schema: "companion_dead_lock_maintenance.v1", mode: "apply", applied: false, exactBlocker, recoveryPath, preserved });
  if (plan?.schema !== "companion_dead_lock_maintenance.v1" || !plan.allowed || !plan.lockPath) return stop("companion_lock_maintenance_valid_plan_required");
  // Root supplies an independently verified exclusion boundary covering scheduler,
  // native-host, installer and manual/legacy actors. This module never stops them.
  const excluded = async () => {
    if (typeof verifySchedulingExclusion !== "function") return false;
    const evidence = await verifySchedulingExclusion(plan.lockPath);
    const age = Date.now() - Date.parse(evidence?.observedAt);
    return evidence?.excluded === true && evidence?.allEntrypointsExcluded === true && evidence?.legacyActorsExcluded === true
      && evidence?.lockPath === plan.lockPath && typeof evidence?.source === "string" && evidence.source.length > 0 && age >= 0 && age <= 5_000;
  };
  const same = (expected, actual) => JSON.stringify(expected) === JSON.stringify(actual);
  try {
    if (!await excluded()) return stop("companion_lock_maintenance_scheduling_exclusion_required");
    let fresh = await inspectCompanionLockMaintenance(plan.lockPath, { probeOwner });
    if (!fresh.allowed || !same(plan.work, fresh.work) || !same(plan.guard, fresh.guard)) return stop("companion_lock_maintenance_identity_or_liveness_changed");
    const recoveryRoot = join(dirname(plan.lockPath), "lock-recovery");
    await assertParents(join(recoveryRoot, "placeholder" )).catch(async (error) => {
      if (error.code !== "ENOENT") throw error;
      await mkdir(recoveryRoot, { mode: 0o700 });
    });
    await assertParents(join(recoveryRoot, "placeholder"));
    const recoveryRootInfo = await lstat(recoveryRoot);
    if ((recoveryRootInfo.mode & 0o022) !== 0 || (process.getuid && recoveryRootInfo.uid !== process.getuid())) return stop("companion_lock_maintenance_recovery_directory_not_private");
    recoveryPath = await mkdtemp(join(recoveryRoot, "dead-lock-"));
    if (plan.format === "kernel_v2") {
      const fresh = await inspectCompanionLockMaintenance(plan.lockPath, { probeOwner });
      if (!fresh.allowed || !same(plan.work, fresh.work) || !same(plan.guard, fresh.guard) || !same(plan.coordinator, fresh.coordinator)) return stop("companion_lock_maintenance_identity_or_liveness_changed");
      if (!await excluded()) return stop("companion_lock_maintenance_scheduling_exclusion_lost");
      const exclusion = await verifySchedulingExclusion(plan.lockPath);
      const result = await companionLockTransaction("quarantine", plan.lockPath, { maintenance: {
        workIdentity: plan.work.identity, workBytes: plan.work.bytes,
        guardIdentity: plan.guard.identity, guardBytes: plan.guard.bytes,
        coordinatorIdentity: plan.coordinator.identity, recoveryPath,
        exclusion: { ...exclusion, observedAtMs: Date.parse(exclusion?.observedAt) },
      } });
      if (result.applied !== true) return { ...stop(result.exactBlocker ?? "companion_lock_maintenance_result_unknown"), retryAllowed: false, transaction: result };
      return { schema: "companion_dead_lock_maintenance.v1", mode: "apply", ...result, exactBlocker: null,
        schedulingExclusionVerified: true, nextAction: "restore_only_the_excluded_companion_entrypoints_then_converge_once_and_read_fresh_receipt" };
    }
    // The dead guard continues to exclude cooperating actors until the work lock
    // has been preserved. Never recursively remove a guard or overwrite backups.
    if (!await excluded()) return stop("companion_lock_maintenance_scheduling_exclusion_lost");
    fresh = await inspectCompanionLockMaintenance(plan.lockPath, { probeOwner });
    if (!fresh.allowed || !same(plan.work, fresh.work) || !same(plan.guard, fresh.guard)) return stop("companion_lock_maintenance_identity_or_liveness_changed");
    if (plan.work.exists) {
      const destination = join(recoveryPath, "work.lock");
      await rename(plan.work.path, destination);
      preserved.push({ originalPath: plan.work.path, path: destination, sha256: plan.work.sha256 });
      const archived = await snapshot(destination, false, probeOwner);
      const original = await snapshot(plan.work.path, false, probeOwner);
      if (!preservedIdentity(plan.work, archived) || original.exists) return stop("companion_lock_maintenance_work_preservation_not_verified_guard_preserved");
    }
    if (!await excluded()) return stop("companion_lock_maintenance_scheduling_exclusion_lost_guard_preserved");
    const guard = await snapshot(plan.guard.path, true, probeOwner);
    const work = await snapshot(plan.work.path, false, probeOwner);
    if (!same(plan.guard, guard) || guard.ownerState !== "dead" || work.exists) return stop("companion_lock_maintenance_guard_or_work_changed");
    const destination = join(recoveryPath, "guard");
    await rename(plan.guard.path, destination);
    preserved.push({ originalPath: plan.guard.path, path: destination, sha256: plan.guard.sha256 });
    const archivedGuard = await snapshot(destination, true, probeOwner);
    const originalGuard = await snapshot(plan.guard.path, true, probeOwner);
    const originalWork = await snapshot(plan.work.path, false, probeOwner);
    const archivedWork = plan.work.exists ? await snapshot(preserved[0].path, false, probeOwner) : null;
    if (!preservedIdentity(plan.guard, archivedGuard) || originalGuard.exists || originalWork.exists
      || (plan.work.exists && !preservedIdentity(plan.work, archivedWork))) return stop("companion_lock_maintenance_final_preservation_not_verified");
    if (!await excluded()) return stop("companion_lock_maintenance_scheduling_exclusion_lost_after_preservation");
    return { schema: "companion_dead_lock_maintenance.v1", mode: "apply", applied: true, exactBlocker: null, recoveryPath, preserved, schedulingExclusionVerified: true,
      preservationVerified: true, originalsAbsentVerified: true,
      nextAction: "restore_only_the_excluded_companion_entrypoints_then_converge_once_and_read_fresh_receipt" };
  } catch (error) { return stop(error?.code ?? error.message); }
}
