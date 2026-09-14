/**
 * Planning helpers for local install convergence.  These functions are pure
 * so the installer/sync path can be checked without touching Chrome or the
 * resident broker.
 */
export const INSTALL_REFRESH_SCHEMA = "aos.chrome_companion.install_refresh.v1";

function text(value) {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

/**
 * Resolve a maintenance owner without ever guessing a parent Codex task.
 * A local install outside Codex intentionally returns no task id; the caller
 * then binds the signed request to the short-lived session it opens itself.
 */
export function resolveRefreshTaskIdentity(env = process.env) {
  const threadId = text(env?.CODEX_THREAD_ID);
  const sessionId = text(env?.CODEX_SESSION_ID);
  if (threadId && sessionId && threadId !== sessionId) {
    return {
      taskId: null,
      source: "environment_conflict",
      exactBlocker: "codex_thread_identity_conflict",
      details: { threadId, sessionId },
    };
  }
  return {
    taskId: threadId ?? sessionId ?? null,
    source: threadId ? "CODEX_THREAD_ID" : sessionId ? "CODEX_SESSION_ID" : "maintenance_session",
    exactBlocker: null,
    details: null,
  };
}

export function automaticRefreshPlan({ restartBroker = false, refreshExtension = true, profile = null } = {}) {
  if (!restartBroker || !refreshExtension) {
    return { disposition: "not_requested", exactBlocker: null, profileInstanceId: profile?.profileInstanceId ?? null };
  }
  if (!profile?.connected) {
    return {
      disposition: "deferred",
      exactBlocker: "companion_profile_not_uniquely_connected",
      profileInstanceId: profile?.profileInstanceId ?? null,
      restartPoint: "restore_one_connected_companion_profile_then_run_the_next_install_or_sync_tick",
    };
  }
  return {
    disposition: "allowed",
    exactBlocker: null,
    profileInstanceId: profile.profileInstanceId ?? null,
    restartPoint: "request_one_signed_extension_reload_then_restart_broker_and_read_status",
  };
}

/**
 * Source and installed control-plane files may converge while Chrome is
 * closed.  This is deliberately narrower than the signed Extension reload
 * boundary: it admits only an unambiguous single profile with no live browser
 * work, and it never treats historical reconciliation evidence as active.
 */
export function canSyncControlPlaneArtifacts(status = {}) {
  if (!deriveMaintenanceProfile(status)) return false;
  const sessionList = Array.isArray(status?.logicalSessions) ? status.logicalSessions : [];
  const leaseSessionIds = new Set((Array.isArray(status?.exactTabLeases) ? status.exactTabLeases : [])
    .map((lease) => lease?.sessionId).filter(Boolean));
  const pendingSessionIds = new Set((Array.isArray(status?.pendingOperations) ? status.pendingOperations : [])
    .map((operation) => operation?.sessionId).filter(Boolean));
  const taskTabSessionIds = new Set((Array.isArray(status?.taskTabs) ? status.taskTabs : [])
    .map((tab) => tab?.sessionId).filter(Boolean));
  const hasAuthoritativeCounts = Number.isFinite(Number(status?.logicalSessionCount))
    && status?.staleIdleSessionCount !== undefined;
  const computedStaleIdleSessions = sessionList.filter((session) => {
    if (leaseSessionIds.has(session.sessionId) || pendingSessionIds.has(session.sessionId) || taskTabSessionIds.has(session.sessionId)) return false;
    const lastSeen = Date.parse(session.lastSeenAt ?? "");
    return Number.isFinite(lastSeen) && Date.now() - lastSeen >= 5 * 60_000;
  }).length;
  // maintenanceBoundary may already have classified the complete session
  // inventory. Do not subtract stale sessions twice from its live count.
  const staleIdleSessions = Math.max(0, Number(status?.staleIdleSessionCount ?? computedStaleIdleSessions));
  const logicalSessions = hasAuthoritativeCounts
    ? Math.max(0, Number(status.logicalSessionCount))
    : Math.max(0, Number(status?.logicalSessionCount ?? sessionList.length) - staleIdleSessions);
  const activeTimedOut = Number(status?.timedOutOperationActiveCount ?? status?.timedOutOperationUnresolvedCount ?? 0);
  const activeReconciliation = Number(status?.reconciliationPendingActiveCount ?? 0);
  const activeTaskTabs = Number(status?.activeTaskTabCount ?? 0);
  return [
    logicalSessions,
    status?.exactTabLeaseCount,
    status?.pendingOperationCount,
    status?.queueCount,
    activeTimedOut,
    activeReconciliation,
    activeTaskTabs,
  ].every((value) => Number.isFinite(Number(value)) && Number(value) === 0);
}

/**
 * Resolve one maintenance profile without inventing an owner. A resident
 * broker from an older install can briefly report no live Extension profiles
 * even though its durable task-tab ledger still carries one unambiguous
 * Profile 2 identity. That identity is sufficient for an offline artifact
 * swap, but never for a resident broker restart or an Extension reload.
 */
export function deriveMaintenanceProfile(status = {}) {
  const profiles = Array.isArray(status?.profiles) ? status.profiles : [];
  if (profiles.length === 1 && text(profiles[0]?.profileInstanceId)) return profiles[0];
  if (profiles.length !== 0) return null;
  const candidates = new Map();
  const remember = (entry) => {
    const profileInstanceId = text(entry?.profileInstanceId);
    if (!profileInstanceId) return;
    const current = candidates.get(profileInstanceId) ?? { profileInstanceId };
    if (!current.generation && text(entry?.generation)) current.generation = text(entry.generation);
    if (!current.buildId && text(entry?.buildId)) current.buildId = text(entry.buildId);
    candidates.set(profileInstanceId, current);
  };
  for (const tab of Array.isArray(status?.taskTabs) ? status.taskTabs : []) remember(tab);
  for (const session of Array.isArray(status?.logicalSessions) ? status.logicalSessions : []) remember(session);
  for (const lease of Array.isArray(status?.exactTabLeases) ? status.exactTabLeases : []) remember(lease);
  if (candidates.size !== 1) return null;
  return { ...candidates.values().next().value, connected: false, offlineDerived: true };
}

export function shouldSuppressRedundantOfflineRestart({
  changed = false,
  restartBroker = false,
  profileConnected = false,
  artifactSyncAllowed = false,
  previousResult = null,
} = {}) {
  return restartBroker
    && !changed
    && !profileConnected
    && artifactSyncAllowed
    && previousResult === "applied_pending_refresh";
}


export function canRestartResidentBroker(status = {}, installedRuntime = {}) {
  // A lost Native Messaging connection clears live session counts. That is
  // not proof that the user's task has finished; ordinary disconnects wait.
  if (!canSyncControlPlaneArtifacts(status)) return false;
  const profile = deriveMaintenanceProfile(status);
  if (profile?.connected === true) return true;
  // During a schema upgrade the new Extension can already be loaded while
  // the resident broker still expects the old digest. Waiting for a successful
  // hello before restarting would deadlock. Require the broker's actual failed
  // registration, same install/profile, and exactly the installed new schema.
  const expected = status.runtimeAttestation?.operationSchemaDigest;
  const installed = installedRuntime.operationSchemaDigest;
  if (!/^[a-f0-9]{64}$/u.test(installed ?? "") || !/^[a-f0-9]{64}$/u.test(expected ?? "") || installed === expected
    || !installedRuntime.buildId || installedRuntime.buildId !== status.expectedBuildId) return false;
  return (status.profileRegistrationFailures ?? []).some(failure => (
    failure.profileInstanceId === profile?.profileInstanceId
    && failure.expectedBuildId === installedRuntime.buildId
    && failure.receivedBuildId === installedRuntime.buildId
    && failure.exactBlocker?.code === "companion_operation_schema_digest_mismatch"
    && failure.exactBlocker.details?.expectedOperationSchemaDigest === expected
    && failure.exactBlocker.details?.receivedOperationSchemaDigest === installed
  ));
}
