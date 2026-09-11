#!/usr/bin/env node

/**
 * Synchronize the Companion control plane and its local unpacked Extension
 * package into the installed app. Chrome still reloads the user-selected
 * checkout through the signed Extension path; keeping the package copy in
 * lockstep makes source-only Extension changes detectable on the next idle
 * LaunchAgent tick. This remains separate from install-local-macos.mjs so a
 * stale-generation reconciliation tab can remain retained while the broker
 * gains the rebind/readback implementation needed to resolve it.
 */
import { access, chmod, cp, lstat, mkdir, open, readFile, readdir, rename, rm, writeFile } from "node:fs/promises";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { BrokerClient } from "../src/client/broker-client.mjs";
import { connectPeer } from "../src/client/connect.mjs";
import { OPERATION_SCHEMA_DIGEST } from "../src/shared/operation-schema.mjs";
import { controlPlaneFiles } from "../src/shared/control-plane-files.mjs";
import {
  automaticRefreshPlan,
  canSyncControlPlaneArtifacts,
  canRestartResidentBroker,
  deriveMaintenanceProfile,
  resolveRefreshTaskIdentity,
  shouldSuppressRedundantOfflineRestart,
} from "../src/shared/install-refresh.mjs";

const CONTROL_PLANE_SCHEMA = "aos.chrome_companion.control_plane_sync.v1";
const DEFAULT_EXTENSION_ID = "pmoolbkcamcemmfonlaenelcbdlcngmb";
const ACTIVE_TASK_TAB_STATES = new Set([
  "active",
  "executing",
  "pre_read",
  "post_read",
  "target_bound",
  "admitted",
  "awaiting_user",
]);

function isLedgerOnlyTaskTab(tab) {
  return tab?.retentionPolicy === "ledger_only" && tab.userHelpRequired !== true;
}

function parseArgs(argv) {
  const result = {
    apply: false,
    restartBroker: false,
    refreshExtension: true,
    extensionId: DEFAULT_EXTENSION_ID,
  };
  for (let index = 0; index < argv.length; index += 1) {
    const value = argv[index];
    if (value === "--apply") result.apply = true;
    else if (value === "--restart-broker") result.restartBroker = true;
    else if (value === "--skip-extension-refresh") result.refreshExtension = false;
    else if (value === "--extension-id") result.extensionId = argv[++index] ?? "";
    else if (value === "--help") result.help = true;
  }
  return result;
}

function usage() {
  process.stderr.write(
    "Usage: node scripts/sync-control-plane-macos.mjs --apply --restart-broker [--extension-id <id>] [--skip-extension-refresh]\n",
  );
}

function errorText(error) {
  return error instanceof Error ? error.message : String(error);
}

async function exists(path) {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

async function assertNoSymlinkComponents(path, { allowMissingLeaf = true } = {}) {
  const absolute = resolve(path);
  const parts = absolute.split("/").filter(Boolean);
  let current = "/";
  for (const part of parts) {
    current = join(current, part);
    try {
      const value = await lstat(current);
      if (value.isSymbolicLink()) throw new Error(`control_plane_symlink_rejected:${current}`);
    } catch (error) {
      if (error?.code === "ENOENT" && allowMissingLeaf) return;
      throw error;
    }
  }
}

async function assertTreeNoSymlinks(root) {
  await assertNoSymlinkComponents(root, { allowMissingLeaf: false });
  const entries = await readdir(root, { withFileTypes: true });
  for (const entry of entries) {
    const child = join(root, entry.name);
    if (entry.isSymbolicLink()) throw new Error(`control_plane_source_symlink_rejected:${child}`);
    if (entry.isDirectory()) await assertTreeNoSymlinks(child);
  }
}

async function sha256(path) {
  const value = await readFile(path);
  return createHash("sha256").update(value).digest("hex");
}

async function readInstalledLiveStatus(appDir, { autoStart = false } = {}) {
  const moduleUrl = pathToFileURL(join(appDir, "src", "client", "connect.mjs")).href;
  const { connectPeer: connectInstalledPeer } = await import(moduleUrl);
  const peer = await connectInstalledPeer({ role: "client", autoStart });
  const client = new BrokerClient(peer, { autoStart });
  try {
    return await client.request("status.get", {}, { timeoutMs: 5_000 });
  } finally {
    client.close();
  }
}

async function refreshExtensionBeforeRestart({ profile, env = process.env }) {
  const identity = resolveRefreshTaskIdentity(env);
  if (identity.exactBlocker) {
    return {
      schema: "aos.chrome_companion.extension_refresh_boundary.v1",
      result: "deferred",
      disposition: "deferred",
      exactBlocker: identity.exactBlocker,
      details: identity.details,
      restartPoint: "launch_from_one_Codex_task_or_clear_conflicting_task_identity",
      reloadRequested: false,
      externalActionExecuted: false,
      noReplay: true,
    };
  }
  let peer;
  try {
    peer = await connectPeer({ role: "client", autoStart: false, env });
  } catch (error) {
    return {
      schema: "aos.chrome_companion.extension_refresh_boundary.v1",
      result: "deferred",
      disposition: "deferred",
      exactBlocker: error?.code ?? "broker_connection_unavailable",
      error: errorText(error),
      restartPoint: "fresh_companion_status_then_retry_at_idle_boundary",
      reloadRequested: false,
      externalActionExecuted: false,
      noReplay: true,
      ownerSource: identity.source,
    };
  }
  const client = new BrokerClient(peer, { autoStart: false, env });
  let session = null;
  let refreshResult = null;
  try {
    session = await client.request("session.open", {
      profileInstanceId: profile.profileInstanceId,
      ...(identity.taskId ? { taskId: identity.taskId } : {}),
      label: "automatic control-plane Extension refresh",
    }, { timeoutMs: 10_000 });
    const taskId = identity.taskId ?? session.sessionId;
    const timestamp = Date.now();
    refreshResult = await client.requestExtensionReloadAndReadback({
      sessionId: session.sessionId,
      taskId,
      runId: `control-plane-refresh-${process.pid}-${timestamp}`,
      idempotencyKey: `control-plane-refresh-${process.pid}-${timestamp}`,
      profileInstanceId: profile.profileInstanceId,
      expectedBuildId: profile.buildId ?? null,
      reason: "local_install_auto_refresh",
    }, { timeoutMs: 45_000, statusTimeoutMs: 5_000, pollIntervalMs: 250 });
    return {
      ...refreshResult,
      ownerSource: identity.source,
      maintenanceSessionId: session.sessionId,
    };
  } catch (error) {
    return {
      schema: "aos.chrome_companion.extension_refresh_boundary.v1",
      result: "deferred",
      disposition: "deferred",
      exactBlocker: error?.code ?? "extension_refresh_failed",
      error: errorText(error),
      restartPoint: error?.code === "broker_connection_closed"
        ? "fresh_companion_status_only; do_not_repeat_extension_reload"
        : "fresh_status_then_retry_at_idle_boundary",
      reloadRequested: false,
      externalActionExecuted: false,
      noReplay: true,
      ownerSource: identity.source,
      maintenanceSessionId: session?.sessionId ?? null,
    };
  } finally {
    // A reflected reload invalidates the session by design; closing it would
    // be a stale-generation mutation.  A deferred attempt still owns the
    // current session and can be closed safely before the process exits.
    if (session && refreshResult?.result !== "reflected") {
      await client.request("session.close", { sessionId: session.sessionId, taskTerminal: false }, { timeoutMs: 5_000 }).catch(() => {});
    }
    client.close();
  }
}

async function readInstalledLiveStatusUntilReady(appDir, { expectedBuildId = null, timeoutMs = 30_000 } = {}) {
  const deadline = Date.now() + Math.max(5_000, Number(timeoutMs) || 30_000);
  let status = null;
  let lastError = null;
  while (Date.now() <= deadline) {
    try {
      status = await readInstalledLiveStatus(appDir, { autoStart: true });
      lastError = null;
      const profiles = Array.isArray(status?.profiles) ? status.profiles : [];
      const connected = profiles.filter((profile) => profile?.connected === true);
      if (connected.length === 1 && (!expectedBuildId || connected[0].buildId === expectedBuildId)) {
        return { ready: true, status, lastError: null };
      }
    } catch (error) {
      lastError = { code: error?.code ?? "installed_status_read_failed", message: errorText(error) };
    }
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 500));
  }
  return { ready: false, status, lastError };
}

export function maintenanceBoundary(status) {
  const runtimeProfiles = Array.isArray(status?.profiles) ? status.profiles : [];
  const maintenanceProfile = deriveMaintenanceProfile(status);
  const profiles = maintenanceProfile ? [maintenanceProfile] : runtimeProfiles;
  const taskTabs = Array.isArray(status?.taskTabs) ? status.taskTabs : [];
  const liveSessions = (Array.isArray(status?.logicalSessions) ? status.logicalSessions : [])
    .filter((session) => session?.profileInstanceId === profiles[0]?.profileInstanceId);
  const liveSessionIds = new Set(liveSessions.map((session) => session.sessionId).filter(Boolean));
  const leasedTabKeys = new Set((Array.isArray(status?.exactTabLeases) ? status.exactTabLeases : [])
    .filter((lease) => lease?.profileInstanceId === profiles[0]?.profileInstanceId)
    .map((lease) => `${lease.profileInstanceId}:${lease.tabId}`));
  const pendingOperations = Array.isArray(status?.pendingOperations) ? status.pendingOperations : [];
  const taskTabIsLive = (tab) => liveSessionIds.has(tab?.sessionId)
    || leasedTabKeys.has(`${tab?.profileInstanceId}:${tab?.tabId}`)
    || (!tab?.sessionId && liveSessions.length > 0)
    || pendingOperations.some((operation) => operation?.taskId && operation.taskId === tab?.taskId);
  const activeTaskTabs = taskTabs.filter((tab) => !isLedgerOnlyTaskTab(tab)
    && ACTIVE_TASK_TAB_STATES.has(tab?.lifecycleState)
    && taskTabIsLive(tab));
  const activeTimedOutOperations = Number.isSafeInteger(status?.timedOutOperationActiveCount)
    ? status.timedOutOperationActiveCount
    : Number.isSafeInteger(status?.timedOutOperationUnresolvedCount)
      ? status.timedOutOperationUnresolvedCount
      : 0;
  const blockers = [];
  if (Number(status?.logicalSessionCount) > 0) blockers.push("logical_sessions_active");
  if (Number(status?.exactTabLeaseCount) > 0) blockers.push("exact_tab_leases_active");
  if (Number(status?.pendingOperationCount) > 0) blockers.push("pending_operations_active");
  if (activeTimedOutOperations > 0) blockers.push("timed_out_operations_active");
  if (Number(status?.queueCount) > 0) blockers.push("profile_queue_active");
  if (activeTaskTabs.length > 0) blockers.push("active_task_tabs_present");
  const profileShapeValid = profiles.length === 1 && Boolean(profiles[0]?.profileInstanceId);
  const profileConnected = runtimeProfiles.length === 1
    && runtimeProfiles[0]?.profileInstanceId === maintenanceProfile?.profileInstanceId
    && runtimeProfiles[0]?.connected === true;
  const operationallyIdle = blockers.length === 0;
  // A disconnected Chrome instance cannot reflect extension.reload, but it
  // also cannot have a live browser operation.  Permit the file-level source
  // and installed-runtime swap at this point so the next Chrome hello can
  // consume the new package.  Keep `allowed` strict for callers that need the
  // signed profile-global reload boundary.
  const artifactSyncAllowed = profileShapeValid
    && operationallyIdle
    && canSyncControlPlaneArtifacts({
      ...status,
      profiles,
      activeTaskTabCount: activeTaskTabs.length,
      timedOutOperationActiveCount: activeTimedOutOperations,
    });
  if (!profileConnected) blockers.push("companion_profile_not_uniquely_connected");
  return {
    allowed: blockers.length === 0,
    artifactSyncAllowed,
    refreshAllowed: blockers.length === 0,
    profileConnected,
    operationallyIdle,
    blockers,
    profileInstanceId: maintenanceProfile?.profileInstanceId ?? null,
    generation: maintenanceProfile?.generation ?? null,
    timedOutOperationActiveCount: activeTimedOutOperations,
    reconciliationTabCount: taskTabs.filter((tab) => !isLedgerOnlyTaskTab(tab)
      && ["reconciliation_required", "operation_effect_unknown"].includes(tab?.lifecycleState)
      && taskTabIsLive(tab)).length,
    retainedTaskTabCount: taskTabs.length,
    activeTaskTabs: activeTaskTabs.map((tab) => ({ tabId: tab.tabId, taskId: tab.taskId, lifecycleState: tab.lifecycleState })),
  };
}

function brokerProcessRows(appDir) {
  const result = execFileSync("ps", ["-axo", "pid=,ppid=,command="], { encoding: "utf8" });
  const needle = `${appDir}/src/broker/main.mjs`;
  return result.split("\n").map((line) => {
    const match = /^\s*(\d+)\s+(\d+)\s+(.*)$/u.exec(line);
    return match ? { pid: Number(match[1]), ppid: Number(match[2]), command: match[3] } : null;
  }).filter((row) => row && row.command.includes(needle));
}

async function waitForProcessExit(pid, timeoutMs = 8_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      process.kill(pid, 0);
    } catch (error) {
      if (error?.code === "ESRCH") return true;
    }
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 100));
  }
  return false;
}

async function stageControlPlane({ sourceRoot, appDir, stagingDir, extensionStagingDir }) {
  const sourceSrc = join(sourceRoot, "src");
  const installedSrc = join(appDir, "src");
  const sourceExtension = join(sourceRoot, "extension");
  const installedExtension = join(appDir, "extension");
  await assertTreeNoSymlinks(sourceSrc);
  await assertTreeNoSymlinks(sourceExtension);
  await assertNoSymlinkComponents(appDir);
  await assertNoSymlinkComponents(stagingDir);
  await assertNoSymlinkComponents(extensionStagingDir);
  await mkdir(dirname(stagingDir), { recursive: true, mode: 0o700 });
  await rm(stagingDir, { recursive: true, force: true });
  await cp(sourceSrc, stagingDir, { recursive: true, force: false, errorOnExist: true });

  // Keep the build ID paired with the already-loaded unpacked Extension.  A
  // control-plane update must not create a build-mismatch/reconnect loop.
  const installedBuildInfo = join(installedSrc, "shared", "build-info.mjs");
  const stagedBuildInfo = join(stagingDir, "shared", "build-info.mjs");
  if (!await exists(installedBuildInfo)) throw new Error("installed_build_info_missing");
  await cp(installedBuildInfo, stagedBuildInfo, { force: true });
  await chmod(stagedBuildInfo, 0o600);

  // Keep the package copy's install build ID paired with the broker.  The
  // unpacked Extension that Chrome reloads remains the checkout source, so
  // this copy is for drift detection and future installs, not a new browser
  // surface.
  if (!await exists(sourceExtension)) throw new Error("source_extension_missing");
  if (!await exists(installedExtension)) throw new Error("installed_extension_missing");
  await rm(extensionStagingDir, { recursive: true, force: true });
  await cp(sourceExtension, extensionStagingDir, { recursive: true, force: false, errorOnExist: true });
  const installedExtensionBuildInfo = join(installedExtension, "build-info.js");
  const stagedExtensionBuildInfo = join(extensionStagingDir, "build-info.js");
  if (!await exists(installedExtensionBuildInfo)) throw new Error("installed_extension_build_info_missing");
  await cp(installedExtensionBuildInfo, stagedExtensionBuildInfo, { force: true });
  await chmod(stagedExtensionBuildInfo, 0o600);
}

async function atomicSwapSource({ appDir, stagingDir, backupDir, extensionStagingDir, extensionBackupDir }) {
  const installedSrc = join(appDir, "src");
  const installedExtension = join(appDir, "extension");
  await assertNoSymlinkComponents(installedSrc, { allowMissingLeaf: false });
  await assertNoSymlinkComponents(installedExtension, { allowMissingLeaf: false });
  await assertNoSymlinkComponents(backupDir);
  await assertNoSymlinkComponents(extensionBackupDir);
  await rm(backupDir, { recursive: true, force: true });
  await rm(extensionBackupDir, { recursive: true, force: true });
  await rename(installedSrc, backupDir);
  let sourceSwapped = false;
  let extensionBackedUp = false;
  try {
    await rename(stagingDir, installedSrc);
    sourceSwapped = true;
    await rename(installedExtension, extensionBackupDir);
    extensionBackedUp = true;
    await rename(extensionStagingDir, installedExtension);
  } catch (error) {
    if (extensionBackedUp) {
      await rm(installedExtension, { recursive: true, force: true }).catch(() => {});
      await rename(extensionBackupDir, installedExtension).catch(() => {});
    }
    if (sourceSwapped) await rm(installedSrc, { recursive: true, force: true }).catch(() => {});
    await rename(backupDir, installedSrc).catch(() => {});
    throw error;
  }
}

async function writeReceipt(path, receipt) {
  await assertNoSymlinkComponents(path);
  const temporary = `${path}.${process.pid}.tmp`;
  await writeFile(temporary, `${JSON.stringify(receipt, null, 2)}\n`, { mode: 0o600 });
  await rename(temporary, path);
}

async function updateAutoSetupWrapper({ supportDir, appDir, sourceRoot }) {
  const binDir = join(supportDir, "bin");
  const wrapperPath = join(binDir, "aos-chrome-companion-autosetup");
  await assertNoSymlinkComponents(binDir);
  await assertNoSymlinkComponents(wrapperPath);
  await mkdir(binDir, { recursive: true, mode: 0o700 });
  const wrapper = [
    "#!/bin/sh",
    `AOS_CHROME_COMPANION_SETUP_TRIGGER=launch_agent AOS_CHROME_COMPANION_SOURCE_ROOT=${JSON.stringify(sourceRoot)} AOS_CHROME_COMPANION_INSTALL_ROOT=${JSON.stringify(appDir)} exec ${JSON.stringify(process.execPath)} ${JSON.stringify(join(appDir, "scripts", "auto-setup-macos.mjs"))}`,
    "",
  ].join("\n");
  const current = await readFile(wrapperPath, "utf8").catch(() => null);
  if (current === wrapper) return { path: wrapperPath, changed: false };
  const temporary = `${wrapperPath}.${process.pid}.tmp`;
  await assertNoSymlinkComponents(temporary);
  await writeFile(temporary, wrapper, { mode: 0o700 });
  await chmod(temporary, 0o700);
  await rename(temporary, wrapperPath);
  return { path: wrapperPath, changed: true };
}

const args = parseArgs(process.argv.slice(2));
if (args.help) {
  usage();
  process.exit(0);
}
if (process.platform !== "darwin") throw new Error("control_plane_sync_macos_only");
if (!args.apply) {
  usage();
  process.exit(2);
}
if (!/^[a-p]{32}$/u.test(args.extensionId)) throw new Error("companion_extension_id_invalid");

const sourceRoot = resolve(fileURLToPath(new URL("..", import.meta.url)));
const supportDir = join(homedir(), "Library", "Application Support", "AOS Chrome Companion");
const appDir = join(supportDir, "app");
const stagingDir = join(supportDir, `.control-plane-src-staging-${process.pid}`);
const backupDir = join(supportDir, `.control-plane-src-backup-${process.pid}`);
const extensionStagingDir = join(supportDir, `.control-plane-extension-staging-${process.pid}`);
const extensionBackupDir = join(supportDir, `.control-plane-extension-backup-${process.pid}`);
const lockPath = join(supportDir, "control-plane-sync.lock");
const receiptPath = join(supportDir, "control-plane-sync-receipt.json");
let previousReceipt = null;
try {
  previousReceipt = JSON.parse(await readFile(receiptPath, "utf8"));
} catch {
  previousReceipt = null;
}
await assertNoSymlinkComponents(supportDir);
await mkdir(supportDir, { recursive: true, mode: 0o700 });
let lockHandle;
try {
  lockHandle = await open(lockPath, "wx", 0o600);
  await lockHandle.writeFile(`${process.pid}\n`);
  await lockHandle.close();
} catch (error) {
  if (error?.code === "EEXIST") throw new Error("control_plane_sync_in_progress");
  throw error;
}

const receipt = {
  schema: CONTROL_PLANE_SCHEMA,
  startedAt: new Date().toISOString(),
  sourceRoot,
  appDir,
  extensionId: args.extensionId,
  extensionTouched: false,
  brokerRestartRequested: args.restartBroker,
  extensionRefreshRequested: args.restartBroker && args.refreshExtension,
  extensionRefresh: null,
  statusBefore: null,
  boundary: null,
  sourceHashes: {},
  installedHashesBefore: {},
  installedHashesAfter: {},
  changed: false,
  autoSetupWrapper: null,
  brokerProcess: null,
  result: "blocked",
  exactBlockers: [],
};
let exitCode = 0;
try {
  // Read through the installed runtime and allow it to start exactly one
  // broker when the previous process disappeared during an app swap.  Using
  // the source-tree connector here could launch a second broker from a
  // different checkout and would make the runtime proof ambiguous.
  const status = await readInstalledLiveStatus(appDir, { autoStart: true });
  receipt.statusBefore = {
    logicalSessionCount: status.logicalSessionCount,
    exactTabLeaseCount: status.exactTabLeaseCount,
    pendingOperationCount: status.pendingOperationCount,
    timedOutOperationCount: status.timedOutOperationCount,
    timedOutOperationActiveCount: status.timedOutOperationActiveCount ?? status.timedOutOperationUnresolvedCount ?? 0,
    queueCount: status.queueCount,
    taskTabCount: status.taskTabCount,
    ledgerOnlyTaskTabCount: status.ledgerOnlyTaskTabCount ?? 0,
    disposableTaskTabCount: status.disposableTaskTabCount ?? 0,
    quarantinedTaskTabCount: status.quarantinedTaskTabCount,
  };
  receipt.boundary = maintenanceBoundary(status);
  if (!receipt.boundary.artifactSyncAllowed) {
    receipt.exactBlockers = receipt.boundary.blockers;
    receipt.result = "deferred";
    exitCode = 3;
  }

  if (exitCode === 0) {
  const criticalFiles = await controlPlaneFiles(sourceRoot, appDir);
  for (const relative of criticalFiles) {
    const sourcePath = join(sourceRoot, relative);
    const installedPath = join(appDir, relative);
    receipt.sourceHashes[relative] = await exists(sourcePath) ? await sha256(sourcePath) : null;
    receipt.installedHashesBefore[relative] = await exists(installedPath) ? await sha256(installedPath) : null;
  }
  receipt.changed = Object.keys(receipt.sourceHashes).some((key) => receipt.sourceHashes[key] !== receipt.installedHashesBefore[key]);
  receipt.extensionTouched = criticalFiles.some((relative) => relative.startsWith("extension/")
    && receipt.sourceHashes[relative] !== receipt.installedHashesBefore[relative]);
  const { INSTALL_BUILD_ID } = await import(pathToFileURL(join(appDir, "src/shared/build-info.mjs")).href);
  const installedRuntime = { buildId: INSTALL_BUILD_ID, operationSchemaDigest: OPERATION_SCHEMA_DIGEST };
  const schemaUpgradeRestart = !receipt.boundary.profileConnected && canRestartResidentBroker(status, installedRuntime);
  receipt.schemaUpgradeRestart = schemaUpgradeRestart;
  const suppressRedundantOfflineRestart = !schemaUpgradeRestart && shouldSuppressRedundantOfflineRestart({
    changed: receipt.changed,
    restartBroker: args.restartBroker,
    profileConnected: receipt.boundary.profileConnected,
    artifactSyncAllowed: receipt.boundary.artifactSyncAllowed,
    previousResult: previousReceipt?.result ?? null,
  });
  receipt.suppressRedundantOfflineRestart = suppressRedundantOfflineRestart;
  if (suppressRedundantOfflineRestart) {
    // The previous tick already converged the local files and left one
    // explicit pending-refresh boundary.  Keep that state visible without
    // restarting the resident broker on every LaunchAgent tick.
    receipt.result = "applied_pending_refresh";
    receipt.exactBlockers = Array.isArray(previousReceipt?.exactBlockers)
      && previousReceipt.exactBlockers.length > 0
      ? previousReceipt.exactBlockers
      : ["companion_profile_not_connected_after_broker_restart"];
  }
  // An explicit restart request is meaningful even when the source and
  // installed control-plane hashes already match.  The local installer can
  // rotate the build id and leave an older broker process resident; returning
  // early here would make the subsequent Extension refresh bind to that old
  // in-memory build.  Keep the no-op fast path only when no restart was
  // requested.
  if (!receipt.changed && !args.restartBroker) {
    receipt.result = "already_current";
  }

  if (receipt.changed && exitCode === 0) {
    await stageControlPlane({ sourceRoot, appDir, stagingDir, extensionStagingDir });
    await atomicSwapSource({ appDir, stagingDir, backupDir, extensionStagingDir, extensionBackupDir });
    for (const relative of criticalFiles) receipt.installedHashesAfter[relative] = await exists(join(appDir, relative)) ? await sha256(join(appDir, relative)) : null;
    const hashMismatch = criticalFiles.find((relative) => receipt.sourceHashes[relative] !== receipt.installedHashesAfter[relative]);
    if (hashMismatch) throw new Error(`control_plane_hash_mismatch:${hashMismatch}`);
    for (const relative of criticalFiles) {
      if (!/\.(?:mjs|js)$/u.test(relative) || receipt.installedHashesAfter[relative] === null) continue;
      const check = execFileSync(process.execPath, ["--check", join(appDir, relative)], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
      if (check !== "") throw new Error(`control_plane_node_check_unexpected_output:${relative}`);
    }
  }

  if (exitCode === 0) {
    // Keep the LaunchAgent pointed at the source checkout after an app swap.
    // Without this small local config convergence, the next tick would run an
    // installed auto-setup copy that cannot see future source drift.
    receipt.autoSetupWrapper = await updateAutoSetupWrapper({ supportDir, appDir, sourceRoot });
  }

  if (args.restartBroker && exitCode === 0 && !suppressRedundantOfflineRestart) {
    if (args.refreshExtension && schemaUpgradeRestart) {
      receipt.extensionRefresh = { result: "already_loaded_schema", reloadRequested: false, externalActionExecuted: false, profileInstanceId: receipt.boundary.profileInstanceId };
    } else if (args.refreshExtension) {
      const profile = Array.isArray(status?.profiles) && status.profiles.length === 1 ? status.profiles[0] : null;
      const refreshPlan = automaticRefreshPlan({
        restartBroker: args.restartBroker,
        refreshExtension: args.refreshExtension,
        profile,
      });
      if (refreshPlan.disposition !== "allowed") {
        receipt.extensionRefresh = {
          ...refreshPlan,
          result: "deferred",
          disposition: "deferred",
          reloadRequested: false,
          externalActionExecuted: false,
          noReplay: true,
        };
      } else {
        receipt.extensionRefresh = await refreshExtensionBeforeRestart({ profile });
      }
      if (receipt.extensionRefresh?.result !== "reflected") {
        receipt.exactBlockers = [receipt.extensionRefresh?.exactBlocker ?? "extension_refresh_not_reflected"];
        // The source/install swap is already complete and is safe while the
        // browser is closed.  Keep the receipt pending so the next LaunchAgent
        // tick retries exactly one signed reload after the Profile hello.
        if (receipt.boundary.artifactSyncAllowed) {
          receipt.result = "applied_pending_refresh";
        } else {
          receipt.result = "deferred";
          exitCode = 3;
        }
      }
    }

    if (exitCode === 0) {
      // A new task can start while files are staged or refresh is deferred.
      // Re-read live ownership immediately before stopping the resident broker.
      const restartStatus = await readInstalledLiveStatus(appDir, { autoStart: false });
      receipt.restartBoundary = maintenanceBoundary(restartStatus);
      if (!receipt.restartBoundary.artifactSyncAllowed || !canRestartResidentBroker(restartStatus, installedRuntime)) {
        receipt.result = "applied_pending_refresh";
        receipt.exactBlockers = receipt.restartBoundary.blockers;
        exitCode = 3;
      }
    }
    if (exitCode === 0) {
      const rows = brokerProcessRows(appDir);
      if (rows.length > 1) throw new Error("broker_process_ambiguous");
      if (rows.length === 1) {
        const [row] = rows;
        receipt.brokerProcess = { pid: row.pid, ppid: row.ppid, command: row.command, signal: "SIGTERM" };
        process.kill(row.pid, "SIGTERM");
        if (!await waitForProcessExit(row.pid)) throw new Error("broker_graceful_shutdown_timeout");
      }
    }
  }

    if (exitCode === 0 && (receipt.changed || (args.restartBroker && !suppressRedundantOfflineRestart))) {
    // Verify the new broker through the normal connection path.  If no native
    // relay reconnects immediately, autoStart starts exactly this installed
    // broker and the bounded poll waits for the Extension hello.  We never
    // dispatch a second reload when this readback remains disconnected.
    const ready = await readInstalledLiveStatusUntilReady(appDir, {
      expectedBuildId: receipt.extensionRefresh?.verification?.buildIdAfter
        ?? receipt.extensionRefresh?.freshStatus?.profiles?.[0]?.buildId
        ?? status.profiles?.[0]?.buildId
        ?? null,
      timeoutMs: 30_000,
    });
    const after = ready.status;
    if (!ready.ready) {
      receipt.exactBlockers = ["companion_profile_not_connected_after_broker_restart"];
      // A broker restart with no live profile work is still a valid local
      // convergence step.  Do not report it as a failed swap; preserve the
      // pending profile-reflection boundary for the next tick.
      if (receipt.boundary?.artifactSyncAllowed && receipt.extensionRefresh?.result === "deferred") {
        receipt.result = "applied_pending_refresh";
      } else {
        receipt.result = "deferred";
      }
      receipt.statusAfter = after ? {
        logicalSessionCount: after.logicalSessionCount,
        exactTabLeaseCount: after.exactTabLeaseCount,
        pendingOperationCount: after.pendingOperationCount,
        queueCount: after.queueCount,
        taskTabCount: after.taskTabCount,
        quarantinedTaskTabCount: after.quarantinedTaskTabCount,
        brokerStartedAt: after.brokerStartedAt ?? null,
        profileGeneration: after.profiles?.[0]?.generation ?? null,
        connectedProfileCount: Array.isArray(after.profiles) ? after.profiles.filter((profile) => profile.connected === true).length : 0,
      } : null;
      receipt.extensionRefresh = {
        ...(receipt.extensionRefresh ?? {}),
        postRestartReadback: {
          ready: false,
          lastError: ready.lastError,
          restartPoint: "restore_extension_profile_hello_then_fresh_status; do_not_repeat_extension_reload",
        },
      };
      exitCode = 3;
    } else {
      receipt.statusAfter = {
        logicalSessionCount: after.logicalSessionCount,
        exactTabLeaseCount: after.exactTabLeaseCount,
        pendingOperationCount: after.pendingOperationCount,
        queueCount: after.queueCount,
        taskTabCount: after.taskTabCount,
        quarantinedTaskTabCount: after.quarantinedTaskTabCount,
        brokerStartedAt: after.brokerStartedAt ?? null,
        profileGeneration: after.profiles?.[0]?.generation ?? null,
        connectedProfileCount: Array.isArray(after.profiles) ? after.profiles.filter((profile) => profile.connected === true).length : 0,
      };
      receipt.result = receipt.changed ? "applied" : "restarted";
      receipt.exactBlockers = [];
      receipt.extensionRefresh = { ...(receipt.extensionRefresh ?? {}), postRestartReadback: { ready: true, operationSchemaDigest: after.runtimeAttestation?.operationSchemaDigest, generation: after.profiles?.[0]?.generation } };
    }
  }
  }
} catch (error) {
  receipt.exactBlockers = [errorText(error)];
  receipt.result = "failed";
  await rm(stagingDir, { recursive: true, force: true }).catch(() => {});
  await rm(extensionStagingDir, { recursive: true, force: true }).catch(() => {});
  throw error;
} finally {
  await rm(lockPath, { force: true }).catch(() => {});
  await rm(stagingDir, { recursive: true, force: true }).catch(() => {});
  await rm(extensionStagingDir, { recursive: true, force: true }).catch(() => {});
  await writeReceipt(receiptPath, { ...receipt, finishedAt: new Date().toISOString() }).catch(() => {});
}

process.stdout.write(`${JSON.stringify({ ...receipt, finishedAt: new Date().toISOString() }, null, 2)}\n`);
if (exitCode !== 0) process.exit(exitCode);
