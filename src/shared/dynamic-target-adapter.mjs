/**
 * Resolve a task-owned browser target from a fresh inventory.
 *
 * A caller must not choose a tab merely because a tab id or URL looks right.
 * This adapter is deliberately pure: it never claims, leases, closes, or
 * mutates a tab.  It returns a typed no-effect result for every ambiguous or
 * protected state so the broker can decide whether to create a fresh task tab
 * or preserve the exact blocker.
 */

export const DYNAMIC_TARGET_ADAPTER_SCHEMA = "aos.chrome_companion.dynamic_target_adapter.v1";

export const DYNAMIC_TARGET_STATUS = Object.freeze({
  RESOLVED: "resolved",
  NOT_FOUND: "not_found",
  AMBIGUOUS: "ambiguous",
  BUSY: "busy",
  PROTECTED: "protected",
  STALE: "stale_generation",
  FOREIGN: "foreign_owner",
  INVALID: "invalid_descriptor",
});

const PROTECTED_LIFECYCLES = new Set([
  "admitted",
  "target_bound",
  "pre_read",
  "executing",
  "post_read",
  "awaiting_user",
  "reconciliation_required",
  "operation_effect_unknown",
]);

function asString(value) {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function originOf(value) {
  try {
    const parsed = new URL(String(value ?? ""));
    return ["http:", "https:"].includes(parsed.protocol) ? parsed.origin : null;
  } catch {
    return null;
  }
}

function descriptorOrigin(descriptor = {}) {
  return originOf(descriptor.targetOrigin ?? descriptor.origin ?? descriptor.startUrl);
}

function entryOrigin(entry, live) {
  return originOf(entry?.targetIdentity?.origin ?? entry?.origin ?? live?.url);
}

function sameTargetKey(entry, descriptor) {
  const wanted = asString(descriptor.targetKey);
  if (!wanted) return false;
  return asString(entry?.targetKey) === wanted;
}

function sameCanonicalLocator(entry, descriptor) {
  const wanted = asString(descriptor.canonicalLocator);
  if (!wanted) return false;
  return asString(entry?.canonicalLocator) === wanted;
}

function identityFor(entry, live, descriptor, session) {
  const source = entry?.targetIdentity ?? {};
  return {
    schema: "aos.chrome_companion.target_identity.v1",
    taskId: session?.taskId ?? descriptor.taskId ?? entry?.taskId ?? source.taskId ?? null,
    sessionId: session?.sessionId ?? descriptor.sessionId ?? source.sessionId ?? null,
    leaseId: source.leaseId ?? entry?.leaseId ?? null,
    generation: session?.generation ?? descriptor.generation ?? entry?.generation ?? source.generation ?? null,
    profileInstanceId: session?.profileInstanceId ?? descriptor.profileInstanceId ?? entry?.profileInstanceId ?? source.profileInstanceId ?? null,
    tabId: Number.isSafeInteger(live?.id) ? live.id : (Number.isSafeInteger(entry?.tabId) ? entry.tabId : source.tabId ?? null),
    pageInstanceId: source.pageInstanceId ?? entry?.pageInstanceId ?? null,
    windowId: Number.isSafeInteger(live?.windowId) ? live.windowId : (Number.isSafeInteger(entry?.windowId) ? entry.windowId : source.windowId ?? null),
    frameId: Number.isSafeInteger(descriptor.frameId) ? descriptor.frameId : (Number.isSafeInteger(source.frameId) ? source.frameId : 0),
    origin: entryOrigin(entry, live),
  };
}

function invalidResult(reason, details = {}) {
  return {
    schema: DYNAMIC_TARGET_ADAPTER_SCHEMA,
    status: DYNAMIC_TARGET_STATUS.INVALID,
    exactBlocker: reason,
    candidates: [],
    ...details,
  };
}

/**
 * Resolve one exact task target from task-tab records and a fresh tab list.
 *
 * `allowSameOriginReuse` is intentionally opt-in.  When enabled, it still
 * requires exactly one ordinary completed retained tab; it never selects a
 * protected, quarantined, leased, foreign, or stale record.
 */
export function resolveDynamicTaskTarget({
  session,
  descriptor = {},
  taskTabs = [],
  inventory = [],
  leases = [],
  allowSameOriginReuse = false,
  sameOriginSelection = "ambiguous",
} = {}) {
  const taskId = asString(session?.taskId ?? descriptor.taskId);
  const generation = asString(session?.generation ?? descriptor.generation);
  const profileInstanceId = asString(session?.profileInstanceId ?? descriptor.profileInstanceId);
  if (!taskId || !generation || !profileInstanceId || !Array.isArray(taskTabs) || !Array.isArray(inventory)) {
    return invalidResult("dynamic_target_descriptor_incomplete", { taskId, generation, profileInstanceId });
  }
  const allowedOrigins = Array.isArray(descriptor.allowedOrigins)
    ? descriptor.allowedOrigins.map(originOf).filter(Boolean)
    : [];
  const expectedOrigin = descriptorOrigin(descriptor);
  const exactTabId = descriptor.tabId;
  if (exactTabId !== undefined && (!Number.isSafeInteger(exactTabId) || exactTabId < 0)) {
    return invalidResult("dynamic_target_tab_id_invalid");
  }
  if (expectedOrigin && allowedOrigins.length > 0 && !allowedOrigins.includes(expectedOrigin)) {
    return invalidResult("dynamic_target_origin_not_allowlisted", { expectedOrigin, allowedOrigins });
  }

  const liveById = new Map(inventory.filter((tab) => Number.isSafeInteger(tab?.id)).map((tab) => [tab.id, tab]));
  const leaseByTab = new Map((Array.isArray(leases) ? leases : []).map((lease) => [lease?.tabId, lease]));
  const ownEntries = taskTabs.filter((entry) => entry?.taskId === taskId
    && (exactTabId === undefined || (entry.tabId === exactTabId && entry.profileInstanceId === profileInstanceId)));
  const foreignEntries = taskTabs.filter((entry) => entry?.taskId && entry.taskId !== taskId);
  const staleEntries = ownEntries.filter((entry) => entry.generation && entry.generation !== generation);
  const currentEntries = ownEntries.filter((entry) => !entry.generation || entry.generation === generation);
  const missingCurrentEntries = currentEntries.filter((entry) => !liveById.has(entry.tabId));
  const exact = [];
  const sameOrigin = [];
  const protectedMatches = [];
  const busyMatches = [];

  for (const entry of currentEntries) {
    const live = liveById.get(entry.tabId);
    if (!live) continue;
    const origin = entryOrigin(entry, live);
    if (exactTabId !== undefined && (entry.generation !== generation
      || originOf(live.url) !== expectedOrigin
      || !allowedOrigins.includes(originOf(live.url)))) continue;
    if (expectedOrigin && origin !== expectedOrigin) continue;
    if (allowedOrigins.length > 0 && !allowedOrigins.includes(origin)) continue;
    const lease = leaseByTab.get(entry.tabId);
    const leaseOwnedBySession = !lease || lease.sessionId === session.sessionId;
    const isExact = exactTabId !== undefined || sameTargetKey(entry, descriptor) || sameCanonicalLocator(entry, descriptor);
    const ordinaryReuse = entry.lifecycleState === "completed"
      && entry.retentionPolicy === "retain"
      && !entry.resumeToken
      && !entry.quarantine
      && entry.userHelpRequired !== true;
    if (PROTECTED_LIFECYCLES.has(entry.lifecycleState) || entry.userHelpRequired === true || entry.quarantine) {
      if (isExact) protectedMatches.push({ entry, live });
      continue;
    }
    if (!leaseOwnedBySession) {
      if (isExact) busyMatches.push({ entry, live, lease });
      continue;
    }
    if (isExact) exact.push({ entry, live, lease });
    else if (allowSameOriginReuse && ordinaryReuse) sameOrigin.push({ entry, live, lease });
  }

  const publicCandidate = (candidate, resolution) => ({
    schema: DYNAMIC_TARGET_ADAPTER_SCHEMA,
    status: DYNAMIC_TARGET_STATUS.RESOLVED,
    resolution,
    exactBlocker: null,
    targetIdentity: identityFor(candidate.entry, candidate.live, descriptor, session),
    targetFingerprint: candidate.entry.targetFingerprint ?? null,
    entry: candidate.entry,
    live: candidate.live,
    lease: candidate.lease ?? null,
    candidates: [candidate.entry.tabId],
    diagnostics: {
      taskId,
      generation,
      profileInstanceId,
      staleCount: staleEntries.length,
      missingCount: missingCurrentEntries.length,
      foreignCount: foreignEntries.length,
      protectedCount: protectedMatches.length,
      busyCount: busyMatches.length,
    },
  });

  if (exact.length === 1) return publicCandidate(exact[0], "exact");
  if (exact.length > 1) {
    return {
      schema: DYNAMIC_TARGET_ADAPTER_SCHEMA,
      status: DYNAMIC_TARGET_STATUS.AMBIGUOUS,
      exactBlocker: "dynamic_target_multiple_exact_matches",
      candidates: exact.map(({ entry }) => entry.tabId),
      diagnostics: { taskId, generation, profileInstanceId, staleCount: staleEntries.length, foreignCount: foreignEntries.length },
    };
  }
  if (busyMatches.length > 0) {
    return {
      schema: DYNAMIC_TARGET_ADAPTER_SCHEMA,
      status: DYNAMIC_TARGET_STATUS.BUSY,
      exactBlocker: "target_resource_busy",
      candidates: busyMatches.map(({ entry }) => entry.tabId),
      diagnostics: { taskId, generation, profileInstanceId },
    };
  }
  if (protectedMatches.length > 0) {
    return {
      schema: DYNAMIC_TARGET_ADAPTER_SCHEMA,
      status: DYNAMIC_TARGET_STATUS.PROTECTED,
      exactBlocker: protectedMatches[0].entry.lifecycleState === "reconciliation_required"
        || protectedMatches[0].entry.lifecycleState === "operation_effect_unknown"
        ? "reconciliation_required"
        : "task_target_protected",
      candidates: protectedMatches.map(({ entry }) => entry.tabId),
      diagnostics: { taskId, generation, profileInstanceId },
    };
  }
  if (allowSameOriginReuse) {
    if (sameOrigin.length === 1) return publicCandidate(sameOrigin[0], "same_origin_reuse");
    if (sameOrigin.length > 1) {
      // A continuation descriptor may explicitly opt into the latest
      // ordinary retained tab.  This is not a coordinate/URL guess: the
      // selection is deterministic, owner-scoped, and only considers tabs
      // that passed every protected-state check above. Ties remain ambiguous.
      if (sameOriginSelection === "latest") {
        const sorted = [...sameOrigin].sort((left, right) => {
          const leftTime = Date.parse(left.entry.updatedAt ?? left.entry.createdAt ?? "") || 0;
          const rightTime = Date.parse(right.entry.updatedAt ?? right.entry.createdAt ?? "") || 0;
          if (rightTime !== leftTime) return rightTime - leftTime;
          return Number(right.entry.tabId) - Number(left.entry.tabId);
        });
        const topTime = Date.parse(sorted[0].entry.updatedAt ?? sorted[0].entry.createdAt ?? "") || 0;
        const nextTime = Date.parse(sorted[1].entry.updatedAt ?? sorted[1].entry.createdAt ?? "") || 0;
        if (topTime > nextTime) return publicCandidate(sorted[0], "same_origin_latest_reuse");
      }
      return {
        schema: DYNAMIC_TARGET_ADAPTER_SCHEMA,
        status: DYNAMIC_TARGET_STATUS.AMBIGUOUS,
        exactBlocker: "dynamic_target_multiple_same_origin_candidates",
        candidates: sameOrigin.map(({ entry }) => entry.tabId),
        diagnostics: { taskId, generation, profileInstanceId },
      };
    }
  }
  if (staleEntries.length > 0 && currentEntries.length === 0) {
    return {
      schema: DYNAMIC_TARGET_ADAPTER_SCHEMA,
      status: DYNAMIC_TARGET_STATUS.STALE,
      exactBlocker: "target_generation_mismatch",
      candidates: staleEntries.map((entry) => entry.tabId),
      diagnostics: { taskId, generation, profileInstanceId, staleCount: staleEntries.length },
    };
  }
  if (missingCurrentEntries.length > 0 && exactTabId !== undefined) {
    return {
      schema: DYNAMIC_TARGET_ADAPTER_SCHEMA,
      status: DYNAMIC_TARGET_STATUS.NOT_FOUND,
      exactBlocker: "task_target_tab_missing",
      candidates: missingCurrentEntries.map((entry) => entry.tabId),
      diagnostics: { taskId, generation, profileInstanceId, staleCount: staleEntries.length, missingCount: missingCurrentEntries.length },
    };
  }
  return {
    schema: DYNAMIC_TARGET_ADAPTER_SCHEMA,
    status: DYNAMIC_TARGET_STATUS.NOT_FOUND,
    exactBlocker: exactTabId !== undefined
      ? "task_target_unavailable"
      : ownEntries.length === 0 ? "task_target_not_provisioned" : "task_target_unavailable",
    candidates: [],
    diagnostics: {
      taskId,
      generation,
      profileInstanceId,
      staleCount: staleEntries.length,
      missingCount: missingCurrentEntries.length,
      foreignCount: foreignEntries.length,
      protectedCount: protectedMatches.length,
      busyCount: busyMatches.length,
    },
  };
}
