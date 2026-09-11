/**
 * Supported Companion Extension refresh boundary.
 *
 * A reload is a profile-global lifecycle mutation.  The request may be
 * accepted by the current worker, but the current logical session and all
 * generation-scoped leases become stale immediately afterwards.  Keep the
 * preflight and the post-reload proof explicit so callers cannot mistake an
 * acceptance receipt for a fresh runtime.
 */
export const EXTENSION_REFRESH_BOUNDARY_SCHEMA = "aos.chrome_companion.extension_refresh_boundary.v1";

const ACTIVE_TASK_TAB_LIFECYCLES = new Set([
  "admitted",
  "target_bound",
  "pre_read",
  "executing",
  "post_read",
  "awaiting_user",
  "reconciliation_required",
  "operation_effect_unknown",
]);

// After owner/transport loss a browser tab may be discarded while its
// operation/capsule evidence remains in the ledger.  Such a record is not a
// live profile resource and must not keep a future Extension refresh blocked.
function isLedgerOnlyTaskTab(tab) {
  return tab?.retentionPolicy === "ledger_only" && tab.userHelpRequired !== true;
}

function boundedCount(value) {
  return Number.isSafeInteger(value) && value >= 0 ? value : 0;
}

function profileFor(status, profileInstanceId) {
  const profiles = Array.isArray(status?.profiles) ? status.profiles : [];
  if (profileInstanceId) return profiles.find((profile) => profile?.profileInstanceId === profileInstanceId) ?? null;
  return profiles.length === 1 ? profiles[0] : null;
}

function activeCounts(status, profileInstanceId, ignoreSessionId) {
  const taskTabs = (Array.isArray(status?.taskTabs) ? status.taskTabs : [])
    .filter((tab) => tab?.profileInstanceId === profileInstanceId);
  const sessions = (Array.isArray(status?.logicalSessions) ? status.logicalSessions : [])
    .filter((session) => session?.profileInstanceId === profileInstanceId
      && session?.sessionId !== ignoreSessionId);
  const liveSessionIds = new Set(sessions.map((session) => session.sessionId).filter(Boolean));
  const leases = (Array.isArray(status?.exactTabLeases) ? status.exactTabLeases : [])
    .filter((lease) => lease?.profileInstanceId === profileInstanceId);
  const leasedTabKeys = new Set(leases.map((lease) => `${lease.profileInstanceId}:${lease.tabId}`));
  const pendingOperations = Array.isArray(status?.pendingOperations) ? status.pendingOperations : [];
  const taskTabIsLive = (tab) => {
    if (liveSessionIds.has(tab?.sessionId)) return true;
    if (leasedTabKeys.has(`${tab?.profileInstanceId}:${tab?.tabId}`)) return true;
    // Legacy status producers omitted task-tab session ids. Treat such a tab
    // as live only while another non-ignored session or an exact pending
    // operation still references the same task; an ownerless retained tab is
    // evidence and no longer blocks a profile refresh.
    if (!tab?.sessionId && sessions.length > 0) return true;
    return pendingOperations.some((operation) => operation?.taskId && operation.taskId === tab?.taskId);
  };
  return {
    pendingOperationCount: boundedCount(status?.pendingOperationCount),
    exactTabLeaseCount: boundedCount(status?.exactTabLeaseCount),
    timedOutOperationCount: boundedCount(status?.timedOutOperationActiveCount ?? status?.timedOutOperationCount),
    queueCount: boundedCount(status?.queueCount),
    activeSessionCount: sessions.length,
    activeTaskTabCount: taskTabs.filter((tab) => !isLedgerOnlyTaskTab(tab)
      && ACTIVE_TASK_TAB_LIFECYCLES.has(tab?.lifecycleState)
      && taskTabIsLive(tab)).length,
    reconciliationTabCount: taskTabs.filter((tab) => !isLedgerOnlyTaskTab(tab)
      && ["reconciliation_required", "operation_effect_unknown"].includes(tab?.lifecycleState)
      && taskTabIsLive(tab)).length,
  };
}

function blocker(code, message, details = {}) {
  return { code, message, ...details };
}

/**
 * Decide whether a profile-global reload may be requested.  This is
 * intentionally conservative: status fields that are global or cannot be
 * scoped to the selected profile defer the refresh instead of guessing.
 */
export function planExtensionRefreshBoundary(status, {
  profileInstanceId,
  expectedBuildId,
  ignoreSessionId,
} = {}) {
  const profiles = Array.isArray(status?.profiles) ? status.profiles : [];
  const profile = profileFor(status, profileInstanceId);
  if (!profile && !profileInstanceId && profiles.length > 1) {
    return {
      schema: EXTENSION_REFRESH_BOUNDARY_SCHEMA,
      disposition: "deferred",
      exactBlocker: "profile_selection_ambiguous",
      restartPoint: "choose_profile_instance_then_read_fresh_status",
      profileInstanceId: null,
      counts: null,
    };
  }
  if (!profile) {
    return {
      schema: EXTENSION_REFRESH_BOUNDARY_SCHEMA,
      disposition: "deferred",
      exactBlocker: "profile_not_connected",
      restartPoint: "fresh_companion_status_after_profile_reconnect",
      profileInstanceId: profileInstanceId ?? null,
      counts: null,
    };
  }
  const counts = activeCounts(status, profile.profileInstanceId, ignoreSessionId);
  const blockers = [];
  if (profile.connected !== true) blockers.push(blocker("profile_not_connected", "The selected Companion profile is not connected"));
  if (expectedBuildId && profile.buildId !== expectedBuildId) {
    blockers.push(blocker("extension_build_id_mismatch", "The connected Companion build does not match the requested refresh build", {
      expectedBuildId,
      connectedBuildId: profile.buildId,
    }));
  }
  if (!Array.isArray(profile.capabilities) || !profile.capabilities.includes("extension.reload")) {
    blockers.push(blocker("extension_reload_unavailable", "The connected Companion runtime does not advertise extension.reload"));
  }
  for (const [field, code] of [
    ["pendingOperationCount", "pending_operation"],
    ["exactTabLeaseCount", "active_lease"],
    ["timedOutOperationCount", "timed_out_operation"],
    ["queueCount", "queued_profile_work"],
    ["activeSessionCount", "active_browser_session"],
    ["activeTaskTabCount", "active_browser_task"],
    ["reconciliationTabCount", "reconciliation_required"],
  ]) {
    if (counts[field] > 0) blockers.push(blocker(code, `Companion refresh is deferred while ${field} is non-zero`, { count: counts[field] }));
  }
  if (blockers.length > 0) {
    return {
      schema: EXTENSION_REFRESH_BOUNDARY_SCHEMA,
      disposition: "deferred",
      exactBlocker: blockers[0].code,
      blockers,
      restartPoint: "finish_or_reconcile_profile_work_then_obtain_fresh_status",
      profileInstanceId: profile.profileInstanceId,
      generationBefore: profile.generation ?? null,
      expectedBuildId: expectedBuildId ?? profile.buildId ?? null,
      counts,
    };
  }
  return {
    schema: EXTENSION_REFRESH_BOUNDARY_SCHEMA,
    disposition: "allowed",
    exactBlocker: null,
    blockers: [],
    restartPoint: "request_one_signed_extension_reload_then_read_fresh_status",
    profileInstanceId: profile.profileInstanceId,
    generationBefore: profile.generation ?? null,
    expectedBuildId: expectedBuildId ?? profile.buildId ?? null,
    counts,
  };
}

/**
 * Verify the only acceptable post-reload proof: a connected profile with the
 * expected build and a different generation.  Old sessions, leases, and tab
 * handles are deliberately not accepted as readback.
 */
export function verifyFreshExtensionGeneration(beforeStatus, afterStatus, {
  profileInstanceId,
  expectedBuildId,
} = {}) {
  const before = profileFor(beforeStatus, profileInstanceId);
  const after = profileFor(afterStatus, profileInstanceId ?? before?.profileInstanceId);
  const common = {
    schema: EXTENSION_REFRESH_BOUNDARY_SCHEMA,
    profileInstanceId: profileInstanceId ?? before?.profileInstanceId ?? after?.profileInstanceId ?? null,
    generationBefore: before?.generation ?? null,
    generationAfter: after?.generation ?? null,
    expectedBuildId: expectedBuildId ?? before?.buildId ?? null,
    runtimeIdBefore: before?.extensionRuntimeId ?? null,
    runtimeIdAfter: after?.extensionRuntimeId ?? null,
  };
  if (!after) return { ...common, disposition: "deferred", exactBlocker: "profile_not_connected", restartPoint: "fresh_companion_status_after_profile_reconnect" };
  if (after.connected !== true) return { ...common, disposition: "deferred", exactBlocker: "profile_not_connected", restartPoint: "fresh_companion_status_after_profile_reconnect" };
  if (common.expectedBuildId && after.buildId !== common.expectedBuildId) {
    return {
      ...common,
      disposition: "deferred",
      exactBlocker: "extension_build_id_mismatch",
      observedBuildId: after.buildId ?? null,
      restartPoint: "install_matching_companion_build_then_repeat_one_refresh",
    };
  }
  if (!after.generation || !before?.generation || after.generation === before.generation) {
    return {
      ...common,
      disposition: "deferred",
      exactBlocker: "extension_reload_generation_not_reflected",
      restartPoint: "wait_for_new_extension_hello_then_read_status_again",
    };
  }
  return {
    ...common,
    disposition: "reflected",
    exactBlocker: null,
    freshGeneration: true,
    runtimeIdentityChanged: Boolean(common.runtimeIdBefore && common.runtimeIdAfter && common.runtimeIdBefore !== common.runtimeIdAfter),
    restartPoint: "open_a_new_logical_session_and_reacquire_all_target_leases",
  };
}
