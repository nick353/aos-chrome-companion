import assert from "node:assert/strict";
import test from "node:test";
import { navigationDiagnostics, exactNavigationDiagnostics, stopExactNavigation } from "../extension/navigation-recovery.js";

const url = "https://editor.test/body";
test("signed diagnostics validates the live exact tuple before exposing metadata", () => {
  const params = { tabId: 42, expectedWindowId: 9, expectedUrl: url, expectedPendingUrl: url,
    allowedOrigins: ["https://editor.test"], targetOrigin: "https://editor.test" };
  const tab = { id: 42, windowId: 9, url, pendingUrl: url, status: "loading" };
  assert.equal(exactNavigationDiagnostics(tab, params).readOnly, true);
  for (const change of [{ id: 43 }, { windowId: 10 }, { url: "https://foreign.test/body" },
    { pendingUrl: "https://foreign.test/body" }, { pendingUrl: undefined }])
    assert.throws(() => exactNavigationDiagnostics({ ...tab, ...change }, params), { code: "navigation_diagnostics_target_changed" });
  for (const change of [{ allowedOrigins: [] }, { targetOrigin: "https://foreign.test" }, { expectedPendingUrl: undefined }])
    assert.throws(() => exactNavigationDiagnostics(tab, { ...params, ...change }), { code: "navigation_diagnostics_target_changed" });
  const credentialUrl = "https://user:secret@editor.test/body";
  assert.throws(() => exactNavigationDiagnostics({ ...tab, url: credentialUrl }, { ...params, expectedUrl: credentialUrl }),
    { code: "navigation_diagnostics_target_changed" });
});
function fixture({ changeAt, frameChange, afterFrameChange, permissionError, stopError, unsettled = false, slowAcquire = false, lateCommit = false,
  releaseHangs = false, releaseThrows = false, releaseRejects = false, releaseRejectsLate = false, releaseResult,
  acquireError = false, cleanup } = {}) {
  let reads = 0, frames = 0, stops = 0, releases = 0, permissions = 0, acquisitions = 0;
  const commands = [], tab = { id: 42, windowId: 9, url, pendingUrl: url, status: "loading" };
  const params = { tabId: 42, expectedWindowId: 9, expectedUrl: url, expectedPendingUrl: url,
    allowedOrigins: ["https://editor.test"], targetOrigin: "https://editor.test", optIn: true, mutation: true,
    operationId: "new-stop", taskId: "task", sessionId: "session", generation: "generation" };
  const dependencies = {
    tabs: { get: async () => {
      reads++;
      if (changeAt?.at === reads) Object.assign(tab, changeAt.value);
      if (lateCommit && stops && reads >= 4) Object.assign(tab, { pendingUrl: undefined, status: "complete" });
      return { ...tab };
    } },
    pool: { acquire: async () => {
      acquisitions++;
      if (slowAcquire) await new Promise(resolve => setTimeout(resolve, 150));
      if (acquireError) throw Object.assign(Error("attach unavailable"), {code:"debugger_attach_failed"});
      return { target: { tabId: 42 }, release: () => {
        releases++;
        if (releaseThrows) throw Error("release synchronous failure");
        if (releaseRejects) return Promise.reject(Error("release rejected"));
        if (releaseRejectsLate) return new Promise((_, reject) => setTimeout(() => reject(Error("late release rejected")), 1100));
        if (releaseHangs) return new Promise(() => {});
        return Promise.resolve(releaseResult ?? { detached: true });
      } };
    } },
    requirePermission: async () => { permissions++; if (permissionError) throw Object.assign(Error("permission required"), { code: "debugger_permission_required" }); },
    sendCommand: async (target, method) => {
      assert.deepEqual(target, { tabId: 42 }); commands.push(method);
      if (method === "Page.getFrameTree") {
        frames++; return { frameTree: { frame: { id: "main", loaderId: "loader", url, ...(frames === 2 ? frameChange : {}), ...(frames === 3 ? afterFrameChange : {}) } } };
      }
      assert.equal(method, "Page.stopLoading"); stops++;
      if (stopError) throw Error("stop acknowledgement lost");
      if (!unsettled && !lateCommit) Object.assign(tab, { pendingUrl: undefined, status: "complete" });
      return {};
    },
  };
  return { params, tab, commands, counts: () => ({ reads, stops, releases, permissions, acquisitions }),
    run: overrides => stopExactNavigation({ ...dependencies, params: { ...params, ...overrides }, timeoutMs: 100, onCleanup:cleanup }) };
}

test("pending navigation diagnostics uses bounded tab metadata without renderer injection or mutation", () => {
  const result = navigationDiagnostics({ id: 42, windowId: 9, url, pendingUrl: url, status: "loading" });
  assert.equal(result.pendingNavigationPresent, true); assert.equal(result.pendingUrlMatchesCommitted, true);
  assert.equal(result.committedDocumentProbeAllowed, false); assert.equal(result.readOnly, true);
  const large = navigationDiagnostics({ url: "x".repeat(5000), pendingUrl: "y".repeat(5000) });
  assert.equal(large.url.length, 4096); assert.equal(large.pendingUrl.length, 4096); assert.equal(large.urlsTruncated, true);
});

test("one exact signed stop uses existing debugger primitive and preserves original unknown navigation", async () => {
  for (const options of [{}, { lateCommit: true }]) {
    const f = fixture(options), result = await f.run();
    assert.equal(result.stopped, true); assert.equal(result.mainFrameVerified, true);
    assert.equal(result.originalOperationUnchanged, true); assert.equal(result.reloadReplayed, false);
    assert.equal(result.operationEffectState, "applied"); assert.equal(result.pendingUrl, null);
    assert.equal(f.counts().stops, 1); assert.equal(f.counts().releases, 1);
    assert.deepEqual(f.commands, ["Page.getFrameTree", "Page.getFrameTree", "Page.stopLoading", "Page.getFrameTree"]);
  }
});

test("stop requires opt-in, signed exact tuple, owner context and both allowlisted navigation origins", async () => {
  for (const override of [{ optIn: false }, { mutation: false }, { taskId: "" }, { sessionId: "" },
    { expectedWindowId: undefined }, { expectedPendingUrl: undefined }, { expectedUrl: "https://other.test/body" },
    { expectedPendingUrl: "https://foreign.test/body" }, { allowedOrigins: [] }, { targetOrigin: "*" }]) {
    const f = fixture();
    await assert.rejects(f.run(override), error => error.details.mutationDispatchAttempted === false);
    assert.equal(f.counts().stops, 0); assert.equal(f.counts().acquisitions, 0);
  }
});

test("changed tab/window/URL/pending URL or loader rejects before stop; debugger ownership/permission is preserved", async () => {
  for (const value of [{ id: 43 }, { windowId: 10 }, { url: "https://foreign.test" }, { pendingUrl: "https://foreign.test" }]) {
    const f = fixture({ changeAt: { at: 2, value } });
    await assert.rejects(f.run(), { code: "navigation_stop_target_changed" });
    assert.equal(f.counts().stops, 0); assert.equal(f.counts().releases, 1);
  }
  for (const frameChange of [{ loaderId: "new" }, { id: "new" }, { url: "https://other.test" }, { parentId: "parent" }]) {
    const f = fixture({ frameChange }); await assert.rejects(f.run(), { code: "navigation_stop_document_changed" });
    assert.equal(f.counts().stops, 0); assert.equal(f.counts().releases, 1);
  }
  const permission = fixture({ permissionError: true });
  await assert.rejects(permission.run(), { code: "debugger_permission_required" });
  assert.equal(permission.counts().acquisitions, 0); assert.equal(permission.counts().stops, 0);
});

test("already settled exact tab returns no effect, without permission or debugger attach", async () => {
  const f = fixture(); Object.assign(f.tab, { pendingUrl: undefined, status: "complete" });
  const result = await f.run({ expectedPendingUrl: null });
  assert.equal(result.alreadySettled, true); assert.equal(result.mutationDispatchAttempted, false);
  assert.equal(f.counts().permissions, 0); assert.equal(f.counts().stops, 0);
});

test("lost ACK or unsettled stop has unknown effect and never retries; timed-out attachment releases when it arrives", async () => {
  for (const options of [{ stopError: true }, { unsettled: true }]) {
    const f = fixture(options);
    await assert.rejects(f.run(), error => error.details.operationEffectState === "unknown" && error.details.retryStop === false);
    assert.equal(f.counts().stops, 1); assert.equal(f.counts().releases, 1);
  }
  const late = fixture({ slowAcquire: true });
  await assert.rejects(late.run(), error => error.details.operationEffectState === "none");
  await new Promise(resolve => setTimeout(resolve, 80));
  assert.equal(late.counts().stops, 0); assert.equal(late.counts().acquisitions, 1); assert.equal(late.counts().releases, 1);
});

test("same-URL loader replacement after stop ACK stays unknown and does not pass identity verification", async () => {
  for (const afterFrameChange of [{ loaderId: "replacement-document" }, { id: "replacement-main" }]) {
    const f = fixture({ afterFrameChange });
    await assert.rejects(f.run(), error => error.code === "navigation_stop_document_changed" && error.details.operationEffectState === "unknown");
    assert.equal(f.counts().stops, 1); assert.equal(f.counts().releases, 1);
  }
});

test("debugger release timeout is bounded and reported without repeating the stop", async () => {
  const f = fixture({ releaseHangs: true }); const result = await f.run();
  assert.equal(result.stopped, true); assert.equal(result.debuggerRelease.reason, "release_timeout");
  assert.equal(result.debuggerRelease.reconciliationRequired, true); assert.equal(f.counts().stops, 1);
});

test("release sync throw/rejection preserves successful stop ACK and effect", async () => {
  for (const [options, reason] of [[{ releaseThrows: true }, "release_threw"], [{ releaseRejects: true }, "release_rejected"]]) {
    const f = fixture(options), result = await f.run();
    assert.equal(result.stopped, true); assert.equal(result.stopAcknowledged, true); assert.equal(result.operationEffectState, "applied");
    assert.equal(result.mutationDispatchAttempted, true); assert.equal(result.debuggerRelease.reason, reason);
    assert.equal(result.debuggerRelease.detached, false); assert.equal(result.debuggerRelease.reconciliationRequired, true);
    assert.equal(f.counts().stops, 1); assert.equal(f.counts().releases, 1);
  }
});

test("cleanup failures preserve pre-stop and post-ACK verification errors with their original no-retry effect", async () => {
  for (const cleanup of [{ releaseThrows: true }, { releaseRejects: true }, { releaseHangs: true }]) {
    for (const [change, code, attempted] of [[{ frameChange: { loaderId: "changed" } }, "navigation_stop_document_changed", false],
      [{ afterFrameChange: { loaderId: "changed" } }, "navigation_stop_document_changed", true],
      [{ stopError: true }, undefined, true]]) {
      const f = fixture({ ...cleanup, ...change });
      await assert.rejects(f.run(), error => {
        if (code) assert.equal(error.code, code); else assert.equal(error.message, "stop acknowledgement lost");
        assert.equal(error.details.operationEffectState, attempted ? "unknown" : "none");
        assert.equal(error.details.mutationDispatchAttempted, attempted); assert.equal(error.details.retryStop, false);
        assert.equal(error.details.originalOperationUnchanged, true);
        assert.equal(error.details.debuggerRelease.detached, false); assert.equal(error.details.debuggerRelease.reconciliationRequired, true);
        return true;
      });
      assert.equal(f.counts().stops, attempted ? 1 : 0); assert.equal(f.counts().releases, 1);
    }
  }
});

test("late acquisition release rejection is consumed without another stop or a late error mutation", async () => {
  const unhandled = [], listener = error => unhandled.push(error); process.on("unhandledRejection", listener);
  try {
    for (const cleanup of [{ releaseThrows: true }, { releaseRejects: true }]) {
      const f = fixture({ slowAcquire: true, ...cleanup }); let originalError;
      await assert.rejects(f.run(), error => { originalError = error; return error.code === "navigation_stop_timeout"; });
      const before = JSON.stringify(originalError.details);
      await new Promise(resolve => setTimeout(resolve, 100));
      assert.equal(JSON.stringify(originalError.details), before);
      assert.equal(f.counts().stops, 0); assert.equal(f.counts().acquisitions, 1); assert.equal(f.counts().releases, 1);
    }
    const lateReject = fixture({ releaseRejectsLate: true }), result = await lateReject.run();
    assert.equal(result.stopped, true); assert.equal(result.debuggerRelease.reason, "release_timeout");
    await new Promise(resolve => setTimeout(resolve, 150));
    assert.equal(lateReject.counts().stops, 1); assert.equal(lateReject.counts().releases, 1); assert.deepEqual(unhandled, []);
  } finally { process.off("unhandledRejection", listener); }
});

test("cleanup callback reports one bounded metadata outcome for detached/shared/unknown release states", async()=>{
  for(const [releaseResult,expected] of [[{detached:true},{status:"detached",reason:"detached"}],
    [{detached:true,reason:"browser_detached"},{status:"detached",reason:"browser_detached"}],
    [{detached:false,reason:"shared_operation_active",references:2,error:"secret raw content"},{status:"reconciliation_required",reason:"shared_operation_active"}],
    [{detached:false,reason:"detach_failed",error:"secret raw content"},{status:"reconciliation_required",reason:"detach_failed"}],
    [{detached:true,reason:"unregistered raw secret"},{status:"reconciliation_required",reason:"release_not_verified"}]]){
    const receipts=[],f=fixture({releaseResult,cleanup:value=>receipts.push(value)}),result=await f.run();
    assert.equal(result.stopped,true); assert.deepEqual(receipts,[expected]); assert.equal(f.counts().releases,1); assert.equal(f.counts().stops,1);
    if(releaseResult.reason==="shared_operation_active")assert.equal(result.debuggerRelease.reconciliationRequired,true);
  }
});

test("late pending acquisition remains without cleanup receipt until its exact lease or rejection settles",async()=>{
  for(const options of [{releaseRejects:true},{acquireError:true}]){
    const receipts=[],f=fixture({slowAcquire:true,...options,cleanup:value=>receipts.push(value)}); let originalError;
    await assert.rejects(f.run(),error=>{originalError=error;return error.code==="navigation_stop_timeout";});
    const before=JSON.stringify(originalError.details); assert.deepEqual(receipts,[]);
    await new Promise(resolve=>setTimeout(resolve,100));
    assert.deepEqual(receipts,[options.acquireError ? {status:"not_required",reason:"no_lease_acquired"}
      : {status:"reconciliation_required",reason:"release_rejected"}]);
    assert.equal(JSON.stringify(originalError.details),before); assert.equal(f.counts().stops,0);
    assert.equal(f.counts().acquisitions,1); assert.equal(f.counts().releases,options.acquireError?0:1);
  }
});

test("no acquisition issued and settled acquisition rejection report not_required without changing the original error",async()=>{
  for(const [options,overrides,code] of [[{permissionError:true},{},"debugger_permission_required"],
    [{},{optIn:false},"navigation_stop_authority_required"],[{acquireError:true},{},"debugger_attach_failed"]]){
    const receipts=[],f=fixture({...options,cleanup:value=>receipts.push(value)});
    await assert.rejects(f.run(overrides),error=>error.code===code && error.details.operationEffectState==="none" && error.details.retryStop===false);
    assert.deepEqual(receipts,[{status:"not_required",reason:"no_lease_acquired"}]); assert.equal(f.counts().stops,0); assert.equal(f.counts().releases,0);
  }
});

test("cleanup callback sync throw/reject/hang/failed send never replaces stop response or original verification failure",async()=>{
  for(const cleanup of [()=>{throw Error("record failed");},()=>Promise.reject(Error("record failed")),()=>new Promise(()=>{}),()=>false]){
    const succeeded=fixture({cleanup}),result=await succeeded.run();
    assert.equal(result.stopped,true); assert.equal(result.operationEffectState,"applied"); assert.equal(succeeded.counts().stops,1);
    const failed=fixture({cleanup,afterFrameChange:{loaderId:"replaced"}});
    await assert.rejects(failed.run(),error=>error.code==="navigation_stop_document_changed" && error.details.operationEffectState==="unknown" && error.details.retryStop===false);
    assert.equal(failed.counts().stops,1);
    const unattached=fixture({cleanup,acquireError:true});
    await assert.rejects(unattached.run(),error=>error.code==="debugger_attach_failed" && error.details.operationEffectState==="none" && error.details.retryStop===false);
    assert.equal(unattached.counts().stops,0); assert.equal(unattached.counts().releases,0);
  }
});

test("cleanup timeout reports one immutable terminal outcome even when detach ACK arrives later",async()=>{
  const receipts=[],f=fixture({releaseRejectsLate:true,cleanup:value=>receipts.push(value)}),result=await f.run();
  assert.equal(result.stopped,true); assert.deepEqual(receipts,[{status:"reconciliation_required",reason:"release_timeout"}]);
  await new Promise(resolve=>setTimeout(resolve,150));
  assert.deepEqual(receipts,[{status:"reconciliation_required",reason:"release_timeout"}]); assert.equal(f.counts().releases,1);
});
