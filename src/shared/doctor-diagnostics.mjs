import { execFile as execFileCallback } from "node:child_process";
import { connect } from "node:net";
import { access, lstat, readFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import { constants as fsConstants } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";
import { JsonLineDecoder, writeJsonLine } from "./framing.mjs";
import { INSTALL_BUILD_ID } from "./build-info.mjs";
import { OPERATION_SCHEMA, OPERATION_SCHEMA_DIGEST, OPERATION_SCHEMA_VERSION, PROTOCOL_VERSION } from "./constants.mjs";
import { operationRequiresReconciliation, operationEffectStateForEntry } from "./task-runtime.mjs";
import { resolveBrokerSocketPath, resolveDataDir, resolveStatePath } from "./paths.mjs";
import { detectTwoExtensionProfile, DEFAULT_COMPANION_EXTENSION_ID } from "../setup/auto-setup.mjs";
import { controlPlaneFiles } from "./control-plane-files.mjs";

const execFileAsync = promisify(execFileCallback);
const DEFAULT_SOURCE_ROOT = resolve(fileURLToPath(new URL("../..", import.meta.url)));
const DEFAULT_INSTALL_ROOT = join(homedir(), "Library", "Application Support", "AOS Chrome Companion", "app");
const DEFAULT_CHROME_USER_DATA_DIR = join(homedir(), "Library", "Application Support", "Google", "Chrome");

function errorText(error) { return error instanceof Error ? error.message : String(error); }

export async function inspectPath(path) {
  const result = { path: resolve(path), exists: false, type: null, mode: null, size: null, mtime: null };
  try {
    const stat = await lstat(path);
    result.exists = true;
    result.type = stat.isDirectory() ? "directory" : stat.isFile() ? "file" : stat.isSocket() ? "socket" : stat.isSymbolicLink() ? "symlink" : "other";
    result.mode = stat.mode & 0o777;
    result.size = stat.size;
    result.mtime = stat.mtime.toISOString();
  } catch (error) {
    if (error?.code !== "ENOENT") result.error = errorText(error);
  }
  return result;
}

async function readJson(path) {
  const info = await inspectPath(path);
  if (!info.exists) return { info, value: null };
  if (info.type !== "file") return { info, value: null, error: "path_is_not_file" };
  try { return { info, value: JSON.parse(await readFile(path, "utf8")) }; }
  catch (error) { return { info, value: null, error: `invalid_json:${errorText(error)}` }; }
}

function buildIdFromText(value) {
  const match = typeof value === "string" && value.match(/INSTALL_BUILD_ID\s*=\s*["']([^"']+)["']/u);
  return match?.[1] ?? null;
}

function summarizeProfile(profile = {}) {
  return {
    profileInstanceId: profile.profileInstanceId ?? null,
    generation: profile.generation ?? null,
    extensionRuntimeId: profile.extensionRuntimeId ?? null,
    connected: profile.connected === true,
    connectedAt: profile.connectedAt ?? null,
    buildId: profile.buildId ?? null,
    operationSchema: profile.operationSchema ?? null,
    operationSchemaDigest: profile.operationSchemaDigest ?? null,
    operationSchemaVersion: profile.operationSchemaVersion ?? null,
    capabilitiesDigest: profile.capabilitiesDigest ?? null,
    capabilityCount: Array.isArray(profile.capabilities) ? profile.capabilities.length : 0,
  };
}

function summarizeSession(session = {}) {
  return {
    sessionId: session.sessionId ?? null,
    taskId: session.taskId ?? session.ownerTaskId ?? null,
    profileInstanceId: session.profileInstanceId ?? null,
    generation: session.generation ?? null,
    leaseCount: session.leaseCount ?? (Array.isArray(session.leaseIds) ? session.leaseIds.length : null),
    lastSeenAt: session.lastSeenAt ?? null,
  };
}

function summarizeLease(lease = {}) {
  return {
    leaseId: lease.leaseId ?? null,
    sessionId: lease.sessionId ?? null,
    taskId: lease.taskId ?? lease.ownerTaskId ?? null,
    profileInstanceId: lease.profileInstanceId ?? null,
    generation: lease.generation ?? null,
    tabId: Number.isSafeInteger(lease.tabId) ? lease.tabId : null,
    acquiredAt: lease.acquiredAt ?? null,
  };
}

function operationIsUnresolved(entry = {}) {
  const effect = operationEffectStateForEntry(entry);
  if (effect !== "unknown_effect" && entry.state !== "dispatched") return false;
  return operationRequiresReconciliation(entry);
}

function ledgerSummary(saved, journal) {
  const operations = Array.isArray(saved?.operations) ? saved.operations : [];
  const taskTabs = Array.isArray(saved?.taskTabs) ? saved.taskTabs : [];
  const capsules = Array.isArray(saved?.taskCapsules) ? saved.taskCapsules : [];
  const byState = {};
  for (const entry of operations) {
    const state = typeof entry?.state === "string" ? entry.state : "invalid";
    byState[state] = (byState[state] ?? 0) + 1;
  }
  const unresolved = operations.filter(operationIsUnresolved);
  const unresolvedByMethod = {};
  for (const entry of unresolved) {
    const method = entry?.binding?.method ?? entry?.method ?? "unknown";
    unresolvedByMethod[method] = (unresolvedByMethod[method] ?? 0) + 1;
  }
  return {
    schema: saved?.schema ?? null,
    journalSequence: Number.isSafeInteger(saved?.journalSequence) ? saved.journalSequence : null,
    operationCount: operations.length,
    operationStates: byState,
    reconciliationBacklogCount: unresolved.length,
    reconciliationBacklogByMethod: unresolvedByMethod,
    unresolvedOperations: unresolved.slice(0, 100).map((entry) => ({
      operationId: entry.operationId ?? null,
      idempotencyKey: entry.idempotencyKey ?? null,
      state: entry.state ?? null,
      effectState: entry.effectState ?? entry.effect_state ?? null,
      method: entry.binding?.method ?? entry.method ?? null,
      taskId: entry.binding?.taskId ?? entry.taskId ?? null,
      runId: entry.binding?.runId ?? entry.runId ?? null,
    })),
    taskTabCount: taskTabs.length,
    taskCapsuleCount: capsules.length,
    profileBindingCount: Array.isArray(saved?.profileBindings) ? saved.profileBindings.length : 0,
    journal: journal,
  };
}

async function readLedger(statePath) {
  const checkpoint = await readJson(statePath);
  const journalPath = `${statePath}.journal`;
  const journalInfo = await inspectPath(journalPath);
  const journal = {
    path: journalPath,
    exists: journalInfo.exists,
    bytes: journalInfo.size ?? 0,
    completeFrames: 0,
    lastSequence: Number.isSafeInteger(checkpoint.value?.journalSequence) ? checkpoint.value.journalSequence : null,
    trailingPartial: false,
    error: journalInfo.error ?? checkpoint.error ?? null,
  };
  if (journalInfo.exists && journalInfo.type === "file") {
    try {
      const bytes = await readFile(journalPath);
      const completeBytes = bytes.lastIndexOf(10) + 1;
      journal.trailingPartial = completeBytes !== bytes.length;
      for (const line of bytes.subarray(0, completeBytes).toString("utf8").split("\n").filter(Boolean)) {
        const frame = JSON.parse(line);
        if (frame?.schema !== "aos.chrome_companion.ledger_delta.v1" || !Number.isSafeInteger(frame.sequence)) throw new Error("ledger_journal_frame_invalid");
        journal.completeFrames += 1;
        journal.lastSequence = frame.sequence;
      }
      if (journal.trailingPartial) journal.error = "ledger_journal_trailing_partial_frame";
    } catch (error) { journal.error = `invalid_journal:${errorText(error)}`; }
  }
  return { state: checkpoint, ledger: ledgerSummary(checkpoint.value, journal) };
}

export function parseBrokerProcesses(stdout) {
  const processes = [];
  for (const line of String(stdout ?? "").split("\n")) {
    const match = line.match(/^\s*(\d+)\s+(\d+)\s+(.+?)\s*$/u);
    if (!match) continue;
    const [, pid, ppid, command] = match;
    if (!/(?:src[\\/]broker[\\/]main\.mjs|start:broker|aos[- ]chrome[- ]companion[^\n]*broker)/iu.test(command)) continue;
    processes.push({ pid: Number(pid), ppid: Number(ppid), command });
  }
  return processes;
}

async function listBrokerProcesses() {
  try {
    const result = await execFileAsync("ps", ["-axo", "pid=,ppid=,command="], { maxBuffer: 2 * 1024 * 1024 });
    return { processes: parseBrokerProcesses(result.stdout), error: null };
  } catch (error) { return { processes: [], error: `process_list_failed:${errorText(error)}` }; }
}

async function readBrokerStatus({ socketPath, secretPath, timeoutMs = 5_000 }) {
  const secretInfo = await inspectPath(secretPath);
  if (!secretInfo.exists) return { status: null, error: "broker_secret_missing", transport: null };
  let secret;
  try { secret = (await readFile(secretPath, "utf8")).trim(); }
  catch (error) { return { status: null, error: `broker_secret_unreadable:${errorText(error)}`, transport: null }; }
  if (!secret) return { status: null, error: "broker_secret_empty", transport: null };
  return await new Promise((resolvePromise) => {
    const socket = connect(socketPath);
    const decoder = new JsonLineDecoder();
    const requestId = `doctor-${process.pid}-${Date.now()}`;
    let finished = false;
    let readyAt = null;
    const finish = (result) => {
      if (finished) return;
      finished = true;
      clearTimeout(timer);
      socket.destroy();
      resolvePromise({ ...result, transport: { connected: result.status != null, readyAt } });
    };
    const timer = setTimeout(() => finish({ status: null, error: "broker_status_timeout" }), timeoutMs);
    socket.on("error", (error) => finish({ status: null, error: `broker_socket_error:${error.code ?? errorText(error)}` }));
    socket.on("close", () => { if (!finished) finish({ status: null, error: "broker_socket_closed" }); });
    socket.on("data", (chunk) => {
      try {
        for (const message of decoder.push(chunk)) {
          if (message.kind === "peer.ready") {
            readyAt = new Date().toISOString();
            writeJsonLine(socket, { id: requestId, method: "status.get", params: {}, deadlineAt: Date.now() + timeoutMs });
          } else if (message.id === requestId) {
            finish(message.ok === true ? { status: message.result, error: null } : { status: null, error: message.error?.code ?? "broker_status_error" });
          } else if (message.kind === "peer.error") finish({ status: null, error: message.error?.code ?? "broker_peer_error" });
        }
      } catch (error) { finish({ status: null, error: `broker_response_invalid:${errorText(error)}` }); }
    });
    socket.once("connect", () => writeJsonLine(socket, { kind: "peer.hello", role: "client", auth: secret, protocolVersion: PROTOCOL_VERSION }));
  });
}

async function runtimeBuildSchema({ sourceRoot, installedRoot, status }) {
  const sourceBuild = await readFile(join(sourceRoot, "src", "shared", "build-info.mjs"), "utf8").then(buildIdFromText).catch(() => null);
  const sourceExtensionBuild = await readFile(join(sourceRoot, "extension", "build-info.js"), "utf8").then(buildIdFromText).catch(() => null);
  const installedBuild = await readFile(join(installedRoot, "src", "shared", "build-info.mjs"), "utf8").then(buildIdFromText).catch(() => null);
  const installedExtensionBuild = await readFile(join(installedRoot, "extension", "build-info.js"), "utf8").then(buildIdFromText).catch(() => null);
  const controlPlaneDrift = [];
  try {
    const files = await controlPlaneFiles(sourceRoot, installedRoot);
    for (const relative of files) {
      const [sourceBytes, installedBytes] = await Promise.all([
        readFile(join(sourceRoot, relative)).catch(() => null),
        readFile(join(installedRoot, relative)).catch(() => null),
      ]);
      const sourceHash = sourceBytes ? createHash("sha256").update(sourceBytes).digest("hex") : null;
      const installedHash = installedBytes ? createHash("sha256").update(installedBytes).digest("hex") : null;
      if (sourceHash !== installedHash) controlPlaneDrift.push(relative);
    }
  } catch (error) {
    controlPlaneDrift.push(`inspection_failed:${errorText(error)}`);
  }
  const generated = await readJson(join(sourceRoot, "extension", "operation-schema.generated.json"));
  const profiles = Array.isArray(status?.profiles) ? status.profiles.map(summarizeProfile) : [];
  const connectedMismatches = profiles.filter((profile) => profile.connected && (
    profile.buildId !== (status?.expectedBuildId ?? INSTALL_BUILD_ID)
    || profile.operationSchema !== OPERATION_SCHEMA
    || profile.operationSchemaDigest !== OPERATION_SCHEMA_DIGEST
    || profile.operationSchemaVersion !== OPERATION_SCHEMA_VERSION
  )).map((profile) => profile.profileInstanceId);
  const generatedMismatch = generated.value && (
    generated.value.schema !== OPERATION_SCHEMA
    || generated.value.version !== OPERATION_SCHEMA_VERSION
    || generated.value.schemaDigest !== OPERATION_SCHEMA_DIGEST
  );
  // The source tree deliberately keeps the Node build identity at `dev-local`.
  // The local installer stamps the installed Node and Extension trees with a
  // stable install id, while the unpacked Extension source is stamped with
  // that same id. Treat the intentional source-side dev-local value as a
  // development boundary, not as source/install drift.
  const sourceNodeIdentityIsDevelopment = sourceBuild === "dev-local";
  const installationIdentityDrift = Boolean(
    (!sourceNodeIdentityIsDevelopment && installedBuild && sourceBuild && installedBuild !== sourceBuild)
    || (installedExtensionBuild && sourceExtensionBuild && installedExtensionBuild !== sourceExtensionBuild),
  );
  const sourceDrift = controlPlaneDrift.length > 0;
  const runtimeMismatch = connectedMismatches.length > 0;
  return {
    expected: { buildId: status?.expectedBuildId ?? INSTALL_BUILD_ID, operationSchema: OPERATION_SCHEMA, operationSchemaVersion: OPERATION_SCHEMA_VERSION, operationSchemaDigest: OPERATION_SCHEMA_DIGEST },
    source: { buildId: sourceBuild, extensionBuildId: sourceExtensionBuild },
    installed: { root: installedRoot, buildId: installedBuild, extensionBuildId: installedExtensionBuild, exists: installedBuild !== null || installedExtensionBuild !== null },
    controlPlaneDrift,
    installationIdentityDrift,
    generatedSchema: { schema: generated.value?.schema ?? null, version: generated.value?.version ?? null, digest: generated.value?.schemaDigest ?? null, error: generated.error ?? null },
    runtime: { brokerExpectedBuildId: status?.expectedBuildId ?? null, runtimeAttestation: status?.runtimeAttestation ?? null, connectedProfileMismatches: connectedMismatches },
    mismatch: Boolean(generatedMismatch || sourceDrift || runtimeMismatch),
    sourceDrift,
    runtimeMismatch,
    generatedSchemaMismatch: Boolean(generatedMismatch),
  };
}

async function autoSetupSummary({ dataDir, chromeUserDataDir, env, homePath = homedir() }) {
  const statePath = join(dataDir, "setup-state.json");
  const receipt = await readJson(statePath);
  const selectorPath = env.AOS_WEB_OPERATION_BACKEND_CONFIG || env.AUTOMATION_OS_WEB_OPERATION_BACKEND_CONFIG || join(homePath, ".social-flow", "web-operation-backend.json");
  const selector = await readJson(selectorPath);
  const companionExtensionId = receipt.value?.components?.companion_chrome_extension?.extension_id || env.AOS_CHROME_COMPANION_EXTENSION_ID || DEFAULT_COMPANION_EXTENSION_ID;
  let profileDetection = null;
  let detectionError = null;
  try { profileDetection = await detectTwoExtensionProfile({ chromeUserDataDir, companionExtensionId }); }
  catch (error) { detectionError = `profile_detection_failed:${errorText(error)}`; }
  const mismatches = [];
  if (receipt.value?.setup_complete === true && profileDetection && profileDetection.selected?.directory !== "Profile 2") mismatches.push("receipt_ready_but_profile2_not_selected");
  if (receipt.value?.profile_directory && profileDetection?.selected?.directory && receipt.value.profile_directory !== profileDetection.selected.directory) mismatches.push("receipt_profile_directory_mismatch");
  const receiptBackend = receipt.value?.components?.adaptive_selector?.backend;
  if (receiptBackend && selector.value?.backend && receiptBackend !== selector.value.backend) mismatches.push("adaptive_selector_backend_mismatch");
  if (receipt.value?.components?.control_plane_sync?.result === "deferred") mismatches.push("control_plane_sync_deferred");
  if (Array.isArray(receipt.value?.exact_blockers) && receipt.value.exact_blockers.length) mismatches.push("receipt_has_exact_blockers");
  return {
    statePath,
    receipt: { exists: receipt.info.exists, schema: receipt.value?.schema ?? null, setupComplete: receipt.value?.setup_complete === true, companionReady: receipt.value?.companion_ready === true, integrationReady: receipt.value?.integration_ready === true, checkedAt: receipt.value?.checked_at ?? null, exactBlockers: receipt.value?.exact_blockers ?? [], nextAction: receipt.value?.next_action ?? null, error: receipt.error ?? null },
    selector: { path: selectorPath, exists: selector.info.exists, backend: selector.value?.backend ?? null, revision: selector.value?.revision ?? null, error: selector.error ?? null },
    profileDetection: profileDetection ? {
      profiles: profileDetection.profiles,
      common: profileDetection.common,
      selected: profileDetection.selected,
      selectedCompanion: profileDetection.selectedCompanion,
      companionProfiles: profileDetection.companionProfiles,
      installed: profileDetection.installed,
    } : null,
    detectionError,
    mismatch: mismatches.length > 0,
    mismatches,
  };
}

function addBlocker(blockers, code, details = {}) { blockers.push({ code, ...details }); }

export async function collectDoctorDiagnostics(options = {}) {
  const env = { ...process.env, ...(options.env ?? {}) };
  if (options.dataDir) env.AOS_CHROME_COMPANION_DATA_DIR = options.dataDir;
  if (options.socketPath) env.AOS_CHROME_COMPANION_SOCKET = options.socketPath;
  if (options.statePath) env.AOS_CHROME_COMPANION_STATE_FILE = options.statePath;
  const dataDir = resolveDataDir(env);
  const socketPath = resolveBrokerSocketPath(env);
  const statePath = resolveStatePath(env);
  const secretPath = env.AOS_CHROME_COMPANION_SECRET_FILE ?? join(dataDir, "broker-secret");
  const sourceRoot = resolve(options.sourceRoot ?? DEFAULT_SOURCE_ROOT);
  const installedRoot = resolve(options.installedRoot ?? env.AOS_CHROME_COMPANION_INSTALL_ROOT ?? DEFAULT_INSTALL_ROOT);
  const chromeUserDataDir = resolve(options.chromeUserDataDir ?? DEFAULT_CHROME_USER_DATA_DIR);
  const [data, socket, state, secret, brokerProcesses, broker, autoSetup] = await Promise.all([
    inspectPath(dataDir), inspectPath(socketPath), inspectPath(statePath), inspectPath(secretPath),
    options.brokerProcesses ? { processes: options.brokerProcesses, error: null } : listBrokerProcesses(),
    options.status !== undefined ? { status: options.status, error: options.statusError ?? null, transport: { injected: true } } : readBrokerStatus({ socketPath, secretPath }),
    autoSetupSummary({ dataDir, chromeUserDataDir, env }),
  ]);
  const buildSchema = await runtimeBuildSchema({ sourceRoot, installedRoot, status: broker.status });
  const ledger = await readLedger(statePath);
  const status = broker.status;
  const profiles = Array.isArray(status?.profiles) ? status.profiles.map(summarizeProfile) : [];
  const connectedProfiles = profiles.filter((profile) => profile.connected);
  const sessions = Array.isArray(status?.logicalSessions) ? status.logicalSessions.map(summarizeSession) : [];
  const leases = Array.isArray(status?.exactTabLeases) ? status.exactTabLeases.map(summarizeLease) : [];
  const blockers = [];
  const maintenance = [];
  if (broker.error) addBlocker(blockers, broker.error);
  if (brokerProcesses.error) addBlocker(blockers, brokerProcesses.error);
  if (brokerProcesses.processes.length > 1) addBlocker(blockers, "multiple_broker_processes", { count: brokerProcesses.processes.length });
  if (!socket.exists) addBlocker(blockers, "broker_socket_missing");
  else if (socket.type !== "socket") addBlocker(blockers, "broker_socket_not_socket", { type: socket.type });
  if (!data.exists) addBlocker(blockers, "data_dir_missing");
  if (ledger.state.error || ledger.ledger.journal.error) addBlocker(blockers, "ledger_read_failed", { checkpoint: ledger.state.error ?? null, journal: ledger.ledger.journal.error ?? null });
  if (status && connectedProfiles.length === 0) addBlocker(blockers, "no_connected_profiles");
  if (connectedProfiles.length > 1) addBlocker(blockers, "multiple_connected_profiles", { count: connectedProfiles.length });
  if (buildSchema.runtimeMismatch) addBlocker(blockers, "build_or_schema_mismatch");
  if (buildSchema.sourceDrift) maintenance.push({ code: "source_install_control_plane_drift", severity: "high", files: buildSchema.controlPlaneDrift.slice(0, 20), nextAction: "refresh_installed_runtime_at_an_idle_boundary" });
  const activeReconciliationCount = status?.reconciliationPendingActiveCount;
  if (ledger.ledger.reconciliationBacklogCount > 0) {
    const activeReconciliationKnown = Number.isFinite(Number(activeReconciliationCount));
    const activeReconciliation = activeReconciliationKnown && Number(activeReconciliationCount) > 0;
    maintenance.push({
      code: "reconciliation_backlog",
      severity: activeReconciliation || !activeReconciliationKnown ? "high" : "medium",
      durable: ledger.ledger.reconciliationBacklogCount,
      active: activeReconciliationKnown ? Number(activeReconciliationCount) : null,
      nextAction: "inspect_exact_targets_and_reconcile_without_replay",
    });
  }
  if ((status?.reconciliationPendingActiveCount ?? 0) > 0) addBlocker(blockers, "active_reconciliation_backlog", { active: status.reconciliationPendingActiveCount });
  if (sessions.length > 0) maintenance.push({ code: "active_logical_sessions", count: sessions.length });
  if (leases.length > 0) maintenance.push({ code: "active_tab_leases", count: leases.length });
  const terminalCleanupPending = Number(status?.terminalCleanupPendingTaskTabCount ?? 0);
  if (terminalCleanupPending > 0) maintenance.push({ code: "terminal_cleanup_pending", count: terminalCleanupPending, severity: "medium", nextAction: "run_owner_scoped_terminal_cleanup_and_verify_no_residual_task_tabs" });
  const ledgerOperationCount = Math.max(Number(ledger.ledger.operationCount ?? 0), Number(status?.operationLedgerCount ?? 0));
  if (ledgerOperationCount >= 10_000) maintenance.push({ code: "operation_ledger_large", count: ledgerOperationCount, severity: "medium", nextAction: "archive_or_compact_historical_ledger_at_idle_boundary" });
  // Setup/profile convergence is reported under autoSetup.  It does not make
  // an otherwise reachable broker unhealthy; in particular a stale receipt
  // selection is a setup discrepancy, not a connection-health blocker.
  const result = blockers.length === 0 ? "ok" : broker.status || socket.exists || data.exists ? "degraded" : "unavailable";
  return {
    schema: "aos.chrome_companion.doctor_diagnostics.v1",
    generatedAt: new Date(options.now ?? Date.now()).toISOString(),
    readOnly: true,
    result,
    blockers,
    maintenance,
    paths: { dataDir: data.path, socketPath: socket.path, statePath: state.path, secretPath: secret.path, sourceRoot, installedRoot, chromeUserDataDir },
    broker: { processCount: brokerProcesses.processes.length, processes: brokerProcesses.processes, processError: brokerProcesses.error, socket, secret: { ...secret, path: secret.path, size: secret.size }, transport: broker.transport, statusAvailable: Boolean(status), statusError: broker.error },
    buildSchema,
    profiles: { count: profiles.length, connectedCount: connectedProfiles.length, connected: connectedProfiles, all: profiles },
    sessions: { count: sessions.length, items: sessions },
    leases: { count: leases.length, items: leases },
    live: status ? { pendingOperationCount: status.pendingOperationCount ?? null, queueCount: status.queueCount ?? null, reconciliationPendingCount: status.reconciliationPendingCount ?? null, reconciliationPendingActiveCount: status.reconciliationPendingActiveCount ?? null, taskTabCount: status.taskTabCount ?? null, activeTaskTabCount: status.activeTaskTabCount ?? null, terminalCleanupPendingTaskTabCount: status.terminalCleanupPendingTaskTabCount ?? null, operationLedgerCount: status.operationLedgerCount ?? null, recovery: status.recovery ?? null } : null,
    ledger: ledger.ledger,
    autoSetup,
  };
}

export function formatDoctorText(report) {
  const lines = [`AOS Chrome Companion doctor: ${report.result}`, `read-only: ${report.readOnly}`, `broker processes: ${report.broker.processCount}`, `broker socket: ${report.broker.socket.exists ? report.broker.socket.type : "missing"}`, `connected profiles: ${report.profiles.connectedCount}/${report.profiles.count}`, `sessions / leases: ${report.sessions.count} / ${report.leases.count}`, `reconciliation backlog: ${report.ledger.reconciliationBacklogCount}`, `maintenance items: ${(report.maintenance ?? []).length}`];
  if (report.blockers.length) lines.push("blockers:", ...report.blockers.map((blocker) => `- ${blocker.code}`));
  else lines.push("blockers: none");
  if (report.maintenance?.length) lines.push("maintenance:", ...report.maintenance.map((item) => `- ${item.code}${item.count ?? item.durable ? ` (${item.count ?? item.durable})` : ""}${item.nextAction ? ` -> ${item.nextAction}` : ""}`));
  return `${lines.join("\n")}\n`;
}
