import { createHash } from "node:crypto";
import { isUnresolvedOperationEffect, normalizeTargetIdentity, payloadDigest } from "./task-runtime.mjs";
import { secureEqual } from "./security.mjs";

/**
 * Canonical, user-facing recovery state.
 *
 * The broker historically exposed execution, timeout, reconciliation, and
 * cleanup signals as independent counters.  Those counters are still useful
 * for diagnostics, but callers need one deterministic state and one next
 * action to avoid treating "no active operation" as "fully idle".
 */
export const RECOVERY_STATE_SCHEMA = "aos.chrome_companion.recovery_state.v1";
export const RECOVERY_HANDLE_SCHEMA = "aos.chrome_companion.recovery_handle.v1";
export const RECOVERY_STATES = Object.freeze([
  "working",
  "execution_idle",
  "reconciliation_pending",
  "runtime_update_pending",
  "cleanup_ready",
  "waiting_user",
  "blocked",
  "done",
]);

const ACTIVE_TAB_STATES = new Set([
  "admitted",
  "target_bound",
  "pre_read",
  "executing",
  "post_read",
]);
const RECONCILIATION_TAB_STATES = new Set(["reconciliation_required", "operation_effect_unknown"]);
const TERMINAL_TAB_STATES = new Set(["completed", "failed"]);

function text(value, fallback = null, max = 512) {
  if (typeof value !== "string") return fallback;
  const trimmed = value.trim();
  return trimmed ? trimmed.slice(0, max) : fallback;
}

function count(value) {
  return Number.isSafeInteger(value) && value >= 0 ? value : 0;
}

function list(value) {
  return Array.isArray(value) ? value : [];
}

function taskOf(entry) {
  return text(entry?.taskId ?? entry?.binding?.taskId ?? entry?.task_id);
}

function profileOf(entry) {
  return text(entry?.profileInstanceId ?? entry?.binding?.profileInstanceId ?? entry?.target?.profileInstanceId);
}

function matches(entry, { taskId = null, profileInstanceId = null } = {}) {
  if (!entry || typeof entry !== "object") return false;
  if (taskId !== null && taskOf(entry) !== taskId) return false;
  if (profileInstanceId !== null && profileOf(entry) !== profileInstanceId) return false;
  return true;
}

function isLedgerOnlyTab(entry) {
  return entry?.retentionPolicy === "ledger_only"
    && entry.userHelpRequired !== true;
}

function uniqueStrings(values) {
  return [...new Set(values.filter((value) => typeof value === "string" && value.trim()).map((value) => value.trim()))];
}

function reconciliationIdentity(entry, fallback) {
  if (!entry || typeof entry !== "object") return fallback;
  return entry.idempotencyKey ?? entry.effect?.idempotencyKey ?? entry.operationId ?? entry.capsuleId ?? fallback;
}

function blocker(code, message, details = {}) {
  return { code, message, ...details };
}

function normalizeProfile(profile) {
  if (!profile || typeof profile !== "object") return null;
  return {
    profileInstanceId: text(profile.profileInstanceId),
    connected: profile.connected !== false,
    generation: text(profile.generation),
    buildId: text(profile.buildId),
    expectedBuildId: text(profile.expectedBuildId),
  };
}

/**
 * Derive one canonical state from broker runtime records.  This function is
 * deliberately pure so it can be used by the broker, audit tooling, and
 * deterministic tests without opening a browser or mutating a ledger.
 */
export function deriveRecoveryState({
  taskId = null,
  profileInstanceId = null,
  profile = null,
  sessions = [],
  leases = [],
  pendingOperations = [],
  timedOutOperations = [],
  reconciliationOperations = [],
  taskTabs = [],
  capsules = [],
  queuedCount = 0,
  runtimeUpdatePending = false,
  extraBlockers = [],
  now = new Date().toISOString(),
} = {}) {
  const normalizedProfile = normalizeProfile(profile);
  const scopedSessions = list(sessions).filter((entry) => matches(entry, { taskId, profileInstanceId }));
  const scopedLeases = list(leases).filter((entry) => matches(entry, { taskId, profileInstanceId }));
  const scopedPending = list(pendingOperations).filter((entry) => matches(entry, { taskId, profileInstanceId }));
  // Read-only timeouts are retained as bounded evidence but are not active
  // reconciliation. Only mutation/unknown-effect tombstones block resume.
  const scopedTimedOut = list(timedOutOperations)
    .filter((entry) => matches(entry, { taskId, profileInstanceId }) && isUnresolvedOperationEffect(entry));
  const scopedReconciliation = list(reconciliationOperations)
    .filter((entry) => matches(entry, { taskId, profileInstanceId }) && isUnresolvedOperationEffect(entry));
  const scopedTabs = list(taskTabs).filter((entry) => matches(entry, { taskId, profileInstanceId }));
  const scopedCapsules = list(capsules).filter((entry) => matches(entry, { taskId, profileInstanceId }));

  const userHelpTabs = scopedTabs.filter((entry) => entry.userHelpRequired === true || entry.lifecycleState === "awaiting_user");
  // A ledger-only tab is disposable browser state after owner loss.  Keep the
  // unresolved operation/capsule visible, but do not count its tab as active
  // work or as a reason to hold the profile-wide scheduler gate.
  const reconciliationTabs = scopedTabs.filter((entry) => !isLedgerOnlyTab(entry) && RECONCILIATION_TAB_STATES.has(entry.lifecycleState));
  const activeTabs = scopedTabs.filter((entry) => !isLedgerOnlyTab(entry) && ACTIVE_TAB_STATES.has(entry.lifecycleState));
  const ledgerOnlyTabs = scopedTabs.filter((entry) => isLedgerOnlyTab(entry));
  const terminalTabs = scopedTabs.filter((entry) => TERMINAL_TAB_STATES.has(entry.lifecycleState));
  const reconciliationCapsules = scopedCapsules.filter((entry) => RECONCILIATION_TAB_STATES.has(entry.state));
  const userHelpCapsules = scopedCapsules.filter((entry) => entry.retention?.userHelpRequired === true || entry.state === "awaiting_user");
  const capsuleBlockers = scopedCapsules
    // A terminal capsule may retain the blocker that explained why that run
    // ended.  It remains durable evidence, but it is not a current stop
    // reason for a fresh task or profile-wide recovery state.
    .filter((entry) => !TERMINAL_TAB_STATES.has(entry.state))
    .map((entry) => entry.blocker)
    .filter((entry) => entry && typeof entry === "object" && typeof entry.code === "string")
    .map((entry) => blocker(entry.code, text(entry.message, entry.code, 400), entry.details && typeof entry.details === "object" ? entry.details : {}));

  const reconciliationEntries = [...scopedTimedOut, ...scopedReconciliation, ...scopedCapsules.filter((entry) => RECONCILIATION_TAB_STATES.has(entry.state))];
  const reconciliationOperationIds = new Set(reconciliationEntries.map((entry, index) => reconciliationIdentity(entry, `entry-${index}`)));
  const counts = {
    sessions: scopedSessions.length,
    leases: scopedLeases.length,
    pendingOperations: scopedPending.length,
    timedOutOperations: scopedTimedOut.length,
    queued: count(queuedCount),
    activeTabs: activeTabs.length,
    reconciliationTabs: reconciliationTabs.length,
    ledgerOnlyTabs: ledgerOnlyTabs.length,
    reconciliationOperations: reconciliationOperationIds.size,
    userHelpTabs: userHelpTabs.length,
    userHelpCapsules: userHelpCapsules.length,
    terminalTabs: terminalTabs.length,
  };

  const blockers = [];
  if (normalizedProfile?.connected === false) blockers.push(blocker("profile_not_connected", "Companion profile is not connected"));
  if (normalizedProfile?.expectedBuildId && normalizedProfile.buildId && normalizedProfile.expectedBuildId !== normalizedProfile.buildId) {
    blockers.push(blocker("extension_build_id_mismatch", "Connected Companion build does not match the expected build", {
      expectedBuildId: normalizedProfile.expectedBuildId,
      connectedBuildId: normalizedProfile.buildId,
    }));
  }
  if (userHelpTabs.length > 0 || userHelpCapsules.length > 0) {
    blockers.push(blocker("user_help_required", "A task-owned tab requires an explicit user action", {
      tabIds: userHelpTabs.map((entry) => entry.tabId).filter(Number.isSafeInteger).slice(0, 50),
    }));
  }
  if (scopedTimedOut.length > 0 || scopedReconciliation.length > 0 || reconciliationTabs.length > 0 || reconciliationCapsules.length > 0) {
    blockers.push(blocker("reconciliation_required", "An operation effect is unresolved and must be reconciled before replay or cleanup", {
      timedOutOperationCount: scopedTimedOut.length,
      reconciliationOperationCount: scopedReconciliation.length,
      reconciliationTabCount: reconciliationTabs.length,
      reconciliationCapsuleCount: reconciliationCapsules.length,
    }));
  }
  blockers.push(...capsuleBlockers);
  blockers.push(...list(extraBlockers).filter((entry) => entry && typeof entry === "object" && typeof entry.code === "string"));

  const executionIdle = counts.sessions === 0
    && counts.leases === 0
    && counts.pendingOperations === 0
    && counts.queued === 0
    && counts.activeTabs === 0;
  const fullyIdle = executionIdle && counts.timedOutOperations === 0 && counts.reconciliationTabs === 0 && counts.reconciliationOperations === 0;
  const cleanupReady = terminalTabs.length > 0 && userHelpTabs.length === 0 && reconciliationTabs.length === 0;
  let state;
  let nextAction;
  if (blockers.some((entry) => entry.code === "profile_not_connected" || entry.code === "extension_build_id_mismatch")) {
    state = "blocked";
    nextAction = "reconnect_companion_profile_and_read_fresh_status";
  } else if (userHelpTabs.length > 0 || userHelpCapsules.length > 0) {
    state = "waiting_user";
    nextAction = "complete_the_recorded_user_action_then_read_fresh_status";
  } else if (counts.timedOutOperations > 0 || scopedReconciliation.length > 0 || counts.reconciliationTabs > 0 || counts.reconciliationOperations > 0) {
    state = "reconciliation_pending";
    nextAction = "perform_one_owner_signed_reconciliation_readback_then_cleanup_when_reconciled";
  } else if (!executionIdle) {
    state = "working";
    nextAction = "continue_current_task_and_read_back_the_exact_target";
  } else if (runtimeUpdatePending) {
    state = "runtime_update_pending";
    nextAction = "wait_for_a_fully_idle_boundary_then_apply_one_signed_runtime_refresh";
  } else if (cleanupReady) {
    state = "cleanup_ready";
    nextAction = "run_owner_scoped_terminal_cleanup_and_verify_no_residual_task_tabs";
  } else if (fullyIdle && scopedTabs.length === 0 && scopedCapsules.every((entry) => ["completed", "failed"].includes(entry.state))) {
    state = "done";
    nextAction = "none";
  } else {
    state = "execution_idle";
    nextAction = "read_fresh_status_before_starting_or_resuming_work";
  }

  const secondaryBlockers = blockers.slice(1).filter((entry, index, values) => values.findIndex((candidate) => candidate.code === entry.code) === index);
  const primaryBlocker = blockers[0] ?? null;
  return {
    schema: RECOVERY_STATE_SCHEMA,
    taskId: text(taskId),
    profileInstanceId: text(profileInstanceId ?? normalizedProfile?.profileInstanceId),
    state,
    executionIdle,
    fullyIdle,
    cleanupReady,
    runtimeUpdatePending: runtimeUpdatePending === true,
    primaryBlocker,
    secondaryBlockers,
    nextAction,
    counts,
    observedAt: text(now, new Date().toISOString(), 64),
  };
}

/** Derive a stable profile/task summary from the broker's raw collections. */
export function deriveRecoveryIndex({ profiles = [], sessions = [], leases = [], pendingOperations = [], timedOutOperations = [], reconciliationOperations = [], taskTabs = [], capsules = [], queuedByProfile = new Map(), runtimeUpdatePendingByProfile = new Set(), now } = {}) {
  const profileList = list(profiles);
  const taskIds = new Set();
  for (const entry of [...list(sessions), ...list(leases), ...list(pendingOperations), ...list(timedOutOperations), ...list(reconciliationOperations), ...list(taskTabs), ...list(capsules)]) {
    const taskId = taskOf(entry);
    if (taskId) taskIds.add(taskId);
  }
  const profileStates = profileList.map((profile) => deriveRecoveryState({
    profile,
    profileInstanceId: profile.profileInstanceId,
    sessions,
    leases,
    pendingOperations,
    timedOutOperations,
    reconciliationOperations,
    taskTabs,
    capsules,
    queuedCount: queuedByProfile instanceof Map ? queuedByProfile.get(profile.profileInstanceId) ?? 0 : 0,
    runtimeUpdatePending: runtimeUpdatePendingByProfile instanceof Set && runtimeUpdatePendingByProfile.has(profile.profileInstanceId),
    now,
  }));
  const taskStates = [...taskIds].sort().map((taskId) => {
    const tab = list(taskTabs).find((entry) => taskOf(entry) === taskId);
    const capsule = list(capsules).find((entry) => taskOf(entry) === taskId);
    const reconciliation = list(reconciliationOperations).find((entry) => taskOf(entry) === taskId);
    const profileInstanceId = profileOf(tab) ?? profileOf(capsule) ?? profileOf(reconciliation) ?? profileOf(list(sessions).find((entry) => taskOf(entry) === taskId));
    const profile = profileList.find((entry) => entry.profileInstanceId === profileInstanceId) ?? null;
    return deriveRecoveryState({ taskId, profile, profileInstanceId, sessions, leases, pendingOperations, timedOutOperations, reconciliationOperations, taskTabs, capsules, queuedCount: queuedByProfile instanceof Map ? queuedByProfile.get(profileInstanceId) ?? 0 : 0, now });
  });
  const aggregate = deriveRecoveryState({ profiles: profileList, sessions, leases, pendingOperations, timedOutOperations, reconciliationOperations, taskTabs, capsules, queuedCount: [...(queuedByProfile instanceof Map ? queuedByProfile.values() : [])].reduce((sum, value) => sum + count(value), 0), now });
  return { schema: RECOVERY_STATE_SCHEMA, aggregate, profiles: profileStates, tasks: taskStates };
}

/**
 * Create a signed opaque handle callers can use to carry all target identity
 * fields across a reconnect or handoff.  It is not an authority and cannot
 * authorize a mutation by itself.
 */
export function createRecoveryHandle(secret, {
  taskId,
  runId = null,
  ownerKey = null,
  profileInstanceId = null,
  generation = null,
  tabId = null,
  pageInstanceId = null,
  windowId = null,
  frameId = 0,
  origin = null,
  target = null,
  expiresAt = null,
} = {}) {
  if (typeof secret !== "string" || !secret) throw new TypeError("recovery_handle_secret_required");
  const targetIdentity = normalizeTargetIdentity({
    ...(target && typeof target === "object" ? target : {}),
    taskId,
    sessionId: ownerKey,
    generation,
    profileInstanceId,
    tabId,
    pageInstanceId,
    windowId,
    frameId,
    origin,
  });
  const payload = {
    schema: RECOVERY_HANDLE_SCHEMA,
    taskId: text(taskId),
    runId: text(runId),
    ownerKey: text(ownerKey),
    targetIdentity,
    targetFingerprint: payloadDigest(secret, targetIdentity),
    expiresAt: text(expiresAt),
  };
  const handleId = `recovery_${createHash("sha256").update(JSON.stringify(payload), "utf8").digest("hex").slice(0, 32)}`;
  const signedPayload = { ...payload, handleId };
  return { ...signedPayload, signature: payloadDigest(secret, signedPayload) };
}

export function verifyRecoveryHandle(secret, handle, expected = {}) {
  if (!handle || typeof handle !== "object" || handle.schema !== RECOVERY_HANDLE_SCHEMA) {
    throw new Error("recovery_handle_invalid");
  }
  const signedPayload = {
    schema: handle.schema,
    taskId: handle.taskId ?? null,
    runId: handle.runId ?? null,
    ownerKey: handle.ownerKey ?? null,
    targetIdentity: handle.targetIdentity,
    targetFingerprint: handle.targetFingerprint,
    expiresAt: handle.expiresAt ?? null,
    handleId: handle.handleId,
  };
  if (!secureEqual(payloadDigest(secret, signedPayload), handle.signature)) throw new Error("recovery_handle_signature_invalid");
  if (expected.taskId !== undefined && String(expected.taskId) !== String(handle.taskId)) throw new Error("recovery_handle_task_mismatch");
  if (expected.runId !== undefined && String(expected.runId) !== String(handle.runId)) throw new Error("recovery_handle_run_mismatch");
  if (expected.ownerKey !== undefined && String(expected.ownerKey) !== String(handle.ownerKey)) throw new Error("recovery_handle_owner_mismatch");
  if (handle.expiresAt && Date.parse(handle.expiresAt) <= Date.now()) throw new Error("recovery_handle_expired");
  if (payloadDigest(secret, handle.targetIdentity) !== handle.targetFingerprint) throw new Error("recovery_handle_target_fingerprint_invalid");
  return handle;
}
