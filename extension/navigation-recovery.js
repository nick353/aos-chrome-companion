function failure(code, message, attempted = false) {
  return Object.assign(new Error(message), { code, details: { operationEffectState: attempted ? "unknown" : "none",
    mutationDispatchAttempted: attempted, retryStop: false, originalOperationUnchanged: true } });
}

function origin(url) {
  try { const parsed = new URL(url); return ["http:", "https:"].includes(parsed.protocol) && !parsed.username && !parsed.password ? parsed.origin : null; }
  catch { return null; }
}

// Releasing this exact lease must never replace the operation's result/error.
// Promise.race consumes even a rejection arriving after the cleanup deadline.
async function releaseDebuggerLease(lease) {
  const unresolved = reason => ({ detached: false, reason, reconciliationRequired: true });
  let pending, timer;
  try { pending = lease.release(); }
  catch { return unresolved("release_threw"); }
  try {
    const result = await Promise.race([Promise.resolve(pending).catch(() => unresolved("release_rejected")),
      new Promise(resolve => { timer = setTimeout(() => resolve(unresolved("release_timeout")), 1000); })]);
    if (!result || typeof result !== "object") return unresolved("release_not_verified");
    return result.detached !== true
      ? { ...result, reconciliationRequired: true } : result;
  } catch { return unresolved("release_rejected"); }
  finally { clearTimeout(timer); }
}

// Tab metadata remains available while renderer injection is blocked by a
// pending navigation. Diagnostics never changes document-readiness guards.
export function navigationDiagnostics(tab) {
  const bounded = value => typeof value === "string" ? value.slice(0, 4096) : null;
  return { tabId: tab.id, windowId: tab.windowId, url: bounded(tab.url), pendingUrl: bounded(tab.pendingUrl),
    urlsTruncated: [tab.url, tab.pendingUrl].some(value => typeof value === "string" && value.length > 4096),
    status: tab.status, discarded: tab.discarded === true, pendingNavigationPresent: Boolean(tab.pendingUrl),
    pendingUrlMatchesCommitted: Boolean(tab.pendingUrl) && tab.pendingUrl === tab.url,
    committedDocumentProbeAllowed: !tab.pendingUrl, eventHistoryAvailable: false, readOnly: true, originalOperationUnchanged: true };
}

// Validate the live tuple before returning even read-only metadata. A signed
// historical tuple does not authorize observing a replacement document.
export function exactNavigationDiagnostics(tab, params) {
  const allowed = new Set((params.allowedOrigins ?? []).map(origin).filter(Boolean));
  if (!Number.isSafeInteger(params.tabId) || params.tabId < 0
    || !Number.isSafeInteger(params.expectedWindowId) || params.expectedWindowId < 0
    || typeof params.expectedUrl !== "string"
    || !(params.expectedPendingUrl === null || typeof params.expectedPendingUrl === "string")
    || tab.id !== params.tabId || tab.windowId !== params.expectedWindowId
    || tab.url !== params.expectedUrl || (tab.pendingUrl || null) !== params.expectedPendingUrl
    || !origin(tab.url) || !allowed.has(origin(tab.url))
    || params.targetOrigin !== origin(tab.url)
    || tab.pendingUrl && (!origin(tab.pendingUrl) || !allowed.has(origin(tab.pendingUrl))))
    throw failure("navigation_diagnostics_target_changed", "Live navigation metadata no longer matches the signed exact target");
  return navigationDiagnostics(tab);
}

// This is a new signed exact-target mutation, never a replay or automatic
// cleanup of a previous unknown reload/navigation. Chrome has no tabs.stop API.
export async function stopExactNavigation({ tabs, pool, sendCommand, requirePermission, params, timeoutMs = 5000, onCleanup }) {
  const deadline = Date.now() + Math.min(5000, Math.max(100, timeoutMs));
  let attempted = false, lease, response, originalError, acquisitionIssued = false, acquisitionRejectedSettled = false, cleanupNotified = false;
  const notifyCleanup = async released => {
    if (cleanupNotified) return;
    cleanupNotified = true;
    const reasons = new Set(["detached", "browser_detached", "shared_operation_active", "release_threw", "release_rejected",
      "release_timeout", "release_not_verified", "no_lease_acquired", "detach_failed"]);
    let reason = released?.reason ?? (released?.detached === true ? "detached" : "release_not_verified");
    if (!reasons.has(reason)) reason = "release_not_verified";
    const status = reason === "no_lease_acquired" ? "not_required"
      : released?.detached === true && ["detached", "browser_detached"].includes(reason) ? "detached" : "reconciliation_required";
    let timer;
    try {
      await Promise.race([Promise.resolve().then(() => onCleanup?.({ status, reason })),
        new Promise(resolve => { timer = setTimeout(resolve, 1000); })]);
    } catch { /* The broker's pre-dispatch pending receipt remains authoritative. */ }
    finally { clearTimeout(timer); }
  };
  const bounded = async promise => {
    let timer;
    try { return await Promise.race([promise, new Promise((_, reject) => {
      timer = setTimeout(() => reject(failure("navigation_stop_timeout", "Exact navigation recovery exceeded its bounded deadline", attempted)), Math.max(1, deadline - Date.now()));
    })]); } finally { clearTimeout(timer); }
  };
  try {
  if (params.mutation !== true || params.optIn !== true
    || ![params.operationId, params.taskId, params.sessionId, params.generation].every(value => typeof value === "string" && value)
    || !Number.isSafeInteger(params.tabId) || params.tabId < 0 || !Number.isSafeInteger(params.expectedWindowId) || params.expectedWindowId < 0
    || typeof params.expectedUrl !== "string" || params.expectedUrl.length > 4096
    || !(params.expectedPendingUrl === null || typeof params.expectedPendingUrl === "string" && params.expectedPendingUrl.length <= 4096))
    throw failure("navigation_stop_authority_required", "Stop loading requires opt-in and exact signed tab/window/URL/pendingURL bindings");
  const allowed = new Set((params.allowedOrigins ?? []).map(origin).filter(Boolean));
  if (!allowed.has(origin(params.expectedUrl)) || params.targetOrigin !== origin(params.expectedUrl)
    || params.expectedPendingUrl !== null && !allowed.has(origin(params.expectedPendingUrl)))
    throw failure("target_origin_not_allowed", "Committed and pending navigation origins must both be in the signed allowlist");
  const assertTab = tab => {
    if (tab.id !== params.tabId || tab.windowId !== params.expectedWindowId || tab.url !== params.expectedUrl
      || (tab.pendingUrl || null) !== params.expectedPendingUrl || tab.discarded)
      throw failure("navigation_stop_target_changed", "Exact navigation target changed before stop dispatch");
  };
    const before = await bounded(tabs.get(params.tabId)); assertTab(before);
    if (before.status !== "loading" && !before.pendingUrl)
      return { ...navigationDiagnostics(before), readOnly: false, stopped: false, alreadySettled: true,
        mutationDispatchAttempted: false, operationEffectState: "none" };
    await bounded(requirePermission());
    // A timed-out attachment may complete later. Release that exact lease
    // when it arrives; never attach a replacement or adopt a foreign debugger.
    acquisitionIssued = true;
    const acquisition = Promise.resolve().then(() => pool.acquire(params.tabId)).then(async value => {
      if (Date.now() >= deadline) {
        const released = await releaseDebuggerLease(value);
        await notifyCleanup(released);
        throw failure("navigation_stop_timeout", "Debugger acquisition completed after the deadline");
      }
      lease = value; return value;
    }, async error => {
      acquisitionRejectedSettled = true;
      void notifyCleanup({ reason: "no_lease_acquired" });
      throw error;
    });
    await bounded(acquisition);
    const frame = (await bounded(sendCommand(lease.target, "Page.getFrameTree", {})))?.frameTree?.frame;
    if (!frame?.id || !frame.loaderId || frame.parentId || frame.url !== params.expectedUrl)
      throw failure("navigation_stop_document_unverified", "Debugger main frame does not match the exact committed URL and loader");
    assertTab(await bounded(tabs.get(params.tabId)));
    const verifiedFrame = (await bounded(sendCommand(lease.target, "Page.getFrameTree", {})))?.frameTree?.frame;
    if (verifiedFrame?.id !== frame.id || verifiedFrame?.loaderId !== frame.loaderId || verifiedFrame?.url !== frame.url || verifiedFrame?.parentId)
      throw failure("navigation_stop_document_changed", "Main frame changed before the one stop-loading command");
    if (Date.now() >= deadline) throw failure("navigation_stop_timeout", "Stop deadline expired before dispatch");
    attempted = true;
    await bounded(sendCommand(lease.target, "Page.stopLoading", {}));
    let after;
    do {
      after = await bounded(tabs.get(params.tabId));
      if (after.id !== params.tabId || after.windowId !== params.expectedWindowId || after.url !== params.expectedUrl
        || after.pendingUrl && after.pendingUrl !== params.expectedPendingUrl)
        throw failure("navigation_stop_not_verified", "Exact target changed after stop ACK; do not repeat it", true);
      if (!after.pendingUrl && after.status === "complete") break;
      if (Date.now() + 25 >= deadline) throw failure("navigation_stop_not_verified", "Stop ACK did not establish exact settled tab readback; do not repeat it", true);
      await bounded(new Promise(resolve => setTimeout(resolve, 25)));
    } while (true);
    const afterFrame = (await bounded(sendCommand(lease.target, "Page.getFrameTree", {})))?.frameTree?.frame;
    if (afterFrame?.id !== frame.id || afterFrame?.loaderId !== frame.loaderId || afterFrame?.url !== frame.url || afterFrame?.parentId)
      throw failure("navigation_stop_document_changed", "Main frame changed after stop ACK; preserve the unknown stop result", true);
    const finalTab = await bounded(tabs.get(params.tabId));
    if (finalTab.id !== params.tabId || finalTab.windowId !== params.expectedWindowId || finalTab.url !== params.expectedUrl
      || finalTab.pendingUrl || finalTab.status !== "complete")
      throw failure("navigation_stop_not_verified", "Exact settled tab changed during final frame readback", true);
    return response = { ...navigationDiagnostics(finalTab), readOnly: false, stopped: true, stopAcknowledged: true,
      mainFrameVerified: true, mutationDispatchAttempted: true, operationEffectState: "applied",
      originalOperationUnchanged: true, reloadReplayed: false };
  } catch (error) {
    originalError = error;
    error.details = { ...(error.details ?? {}), operationEffectState: attempted ? "unknown" : "none",
      mutationDispatchAttempted: attempted, retryStop: false, originalOperationUnchanged: true };
    throw error;
  } finally {
    if (lease) {
      const released = await releaseDebuggerLease(lease);
      if (response) response.debuggerRelease = released;
      else if (originalError) originalError.details.debuggerRelease = released;
      await notifyCleanup(released);
    } else if (!acquisitionIssued || acquisitionRejectedSettled) {
      await notifyCleanup({ reason: "no_lease_acquired" });
    }
  }
}
