import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

const helperPath = fileURLToPath(new URL("./lock-transaction.pl", import.meta.url));

// Node never reads or mutates a protected work/guard marker. A one-shot helper
// owns both flock and the complete FS transaction. Helper loss is not a lease.
export async function companionLockTransaction(action, lockPath, options = {}) {
  if (action === "acquire" && options.signal?.aborted === true) return {acquired:false,aborted:true,exactBlocker:"companion_lock_acquisition_aborted",retryAllowed:false};
  const request = { action, lockPath: resolve(lockPath), pid: process.pid, token: options.token ?? randomUUID(),
    acquireId: options.acquireId ?? (action === "acquire" ? randomUUID() : undefined),
    releaseId:options.releaseId ?? (action === "release" ? randomUUID() : undefined),
    workIdentity:options.workIdentity,workBytes:options.workBytes,reconcileRelease:options.reconcileRelease === true,
    verifyReleaseAbsence:options.verifyReleaseAbsence === true,
    readOnlyReconciliation:options.readOnlyReconciliation === true,
    maintenance: options.maintenance,
    expectedHelperPid: options.expectedHelperPid, reconcileAcquire: options.reconcileAcquire === true,
    coordinator: options.coordinator, waitMs: Math.min(2000, Math.max(0, Number(options.guardWaitMs ?? 250))),
    testPauseAt: options.testPauseAt, testFaultAt: options.testFaultAt };
  const result = await new Promise(resolveResult => {
    let output = "", response, transactionBinding, settled = false, timeout;
    const child = spawn("/usr/bin/perl", [helperPath], { stdio: ["pipe", "pipe", "pipe"] });
    const finish = value => { if (!settled) { settled = true; clearTimeout(timeout); child.stdin.destroy();
      resolveResult({...value,helperPid:child.pid,transactionBinding}); } };
    timeout = setTimeout(() => { child.kill("SIGKILL"); finish({ acquired: false, released: false,
      exactBlocker: "companion_lock_transaction_result_unknown", helperPid: child.pid }); }, options.transactionTimeoutMs ?? 5000);
    child.stdin.on("error", () => {});
    child.stderr.on("data", () => {});
    child.stdout.on("data", bytes => {
      output += bytes.toString("utf8");
      if (output.length > 32768) { child.kill("SIGKILL"); return finish({ acquired: false, exactBlocker: "companion_lock_transaction_result_unknown", helperPid:child.pid }); }
      while (output.includes("\n")) {
        const end = output.indexOf("\n"), line = output.slice(0, end); output = output.slice(end + 1);
        let message; try { message = JSON.parse(line); } catch { continue; }
        if (message.transactionBinding) transactionBinding=message.transactionBinding;
        else if (message.phase) {
          Promise.resolve(options.onPhase?.({ ...message, child })).then(() => { if (!settled && !child.stdin.destroyed) child.stdin.write("C"); })
            .catch(() => { child.kill("SIGKILL"); });
        } else if (message.result) response = message.result;
      }
    });
    child.once("error", () => finish({ acquired: false, released: false, exactBlocker: "companion_lock_coordinator_unavailable" }));
    child.once("close", () => finish(response ?? { acquired: false, released: false,
      exactBlocker: "companion_lock_transaction_result_unknown", helperPid: child.pid }));
    child.stdin.write(JSON.stringify(request) + "\n");
  });
  if (action === "acquire" && result.acquired !== true || action === "release" && result.released !== true) {
    result.reconciliation = await companionLockTransaction("inspect", lockPath, { token: request.token, acquireId:request.acquireId,
      coordinator:action === "release" ? request.coordinator : result.transactionBinding?.coordinator, expectedHelperPid:result.helperPid,
      reconcileAcquire:action === "acquire", guardWaitMs: 100,
      reconcileRelease:action === "release",releaseId:request.releaseId,workIdentity:request.workIdentity,workBytes:request.workBytes,
      testPauseAt:options.testReconcilePauseAt,onPhase:options.onReconcilePhase });
    result.retryAllowed = false;
    let acquisitionProof=result.reconciliation;
    if(action === "acquire" && result.reconciliation.exactBlocker === "companion_lock_transaction_result_unknown") {
      result.freshReadback=await companionLockTransaction("inspect",lockPath,{token:request.token,acquireId:request.acquireId,
        coordinator:result.transactionBinding?.coordinator,expectedHelperPid:result.helperPid,reconcileAcquire:true,readOnlyReconciliation:true});
      acquisitionProof=result.freshReadback;
    }
    if (action === "acquire" && acquisitionProof.originalCommitRecovered === true) {
      const lease = { ...acquisitionProof, reconciliation: acquisitionProof, retryAllowed:false,
        originalFailure:result.exactBlocker,originalHelperPid:result.helperPid };
      if (options.signal?.aborted === true) {
        const originalRelease = await companionLockTransaction("release",lockPath,{token:lease.token,acquireId:lease.acquireId,
          coordinator:lease.coordinator,workIdentity:lease.workIdentity,workBytes:lease.workBytes});
        return {...result,acquired:false,aborted:true,originalCommitRecovered:true,originalRelease};
      }
      return lease;
    }
    if(action === "release" && result.reconciliation.originalReleaseRecovered === true) return {...result.reconciliation,retryAllowed:false,originalFailure:result.exactBlocker};
    if(action === "release") {
      result.retainedLease={acquired:true,lockPath:request.lockPath,pid:process.pid,token:request.token,acquireId:request.acquireId,
        coordinator:request.coordinator,workIdentity:request.workIdentity,workBytes:request.workBytes};
      if(result.reconciliation.exactBlocker === "companion_lock_transaction_result_unknown") {
        result.freshReadback=await companionLockTransaction("inspect",lockPath,{token:request.token,acquireId:request.acquireId,
          coordinator:request.coordinator,workIdentity:request.workIdentity,workBytes:request.workBytes,
          expectedHelperPid:result.reconciliation.helperPid,verifyReleaseAbsence:true});
        if(result.freshReadback.finalizerAckRecovered === true) return {...result.freshReadback,retryAllowed:false,originalFailure:result.exactBlocker};
      }
    }
  }
  if (action === "acquire" && result.acquired === true && options.signal?.aborted === true) {
    const originalRelease=await companionLockTransaction("release",lockPath,{token:result.token,acquireId:result.acquireId,
      coordinator:result.coordinator,workIdentity:result.workIdentity,workBytes:result.workBytes});
    return {acquired:false,aborted:true,retryAllowed:false,originalRelease};
  }
  return result;
}
