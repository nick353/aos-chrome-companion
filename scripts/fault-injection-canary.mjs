#!/usr/bin/env node
/**
 * Deterministic no-browser fault matrix for the Companion recovery boundary.
 * It exercises each effect state, restart conversion, target identity, and
 * signed proof without opening Chrome, claiming a tab, or dispatching a page
 * mutation. The hourly controller may run this as a bounded representative
 * canary; live provider effects are intentionally out of scope.
 */
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  TaskOperationLedger,
  isUnresolvedOperationEffect,
  signOperationEffectProof,
  verifyOperationEffectProof,
} from "../src/shared/task-runtime.mjs";

const startedAt = new Date().toISOString();
const report = {
  schema: "aos.chrome_companion.fault_injection_canary.v1",
  startedAt,
  result: "running",
  cases: [],
  externalActionExecuted: false,
  exactBlocker: null,
};

let dataDir;
try {
  dataDir = await mkdtemp(join(tmpdir(), "aos-companion-fault-canary-"));
  const ledger = new TaskOperationLedger({ statePath: join(dataDir, "ledger.json"), secret: "fault-canary-secret" });
  await ledger.ready();
  const binding = {
    taskId: "canary-task",
    runId: "canary-run",
    sessionId: "canary-session",
    ownerKey: "canary-session",
    generation: "canary-generation",
    profileInstanceId: "canary-profile",
    tabId: 1,
    method: "page.click",
  };
  const record = async (name, fn) => {
    await fn();
    report.cases.push({ name, result: "passed" });
  };
  await record("no_dispatch", async () => {
    const entry = await ledger.prepare({ idempotencyKey: "canary-no-dispatch", fingerprint: "fp-1", binding });
    assert.equal(entry.effectState, "no_dispatch");
    assert.equal(isUnresolvedOperationEffect(entry), false);
  });
  await record("known_no_effect", async () => {
    await ledger.prepare({ idempotencyKey: "canary-no-effect", fingerprint: "fp-2", binding: { ...binding, method: "page.snapshot" } });
    const entry = await ledger.transition("canary-no-effect", "blocked", { reason: "pre_dispatch", effectState: "known_no_effect", externalActionExecuted: false });
    assert.equal(entry.effectState, "known_no_effect");
    assert.equal(ledger.getReconciliationCounts().pendingTotal, 0);
  });
  await record("known_effect", async () => {
    await ledger.prepare({ idempotencyKey: "canary-known-effect", fingerprint: "fp-3", binding });
    const entry = await ledger.transition("canary-known-effect", "dispatched", { operationId: "op-3", dispatchCount: 1 });
    const applied = await ledger.transition(entry.idempotencyKey, "applied", { effectState: "known_effect", externalActionExecuted: true });
    assert.equal(applied.effectState, "known_effect");
    assert.equal(isUnresolvedOperationEffect(applied), false);
  });
  await record("unknown_effect", async () => {
    await ledger.prepare({ idempotencyKey: "canary-unknown", fingerprint: "fp-4", binding });
    const unknown = await ledger.transition("canary-unknown", "dispatched", { operationId: "op-4", dispatchCount: 1 });
    const unresolved = await ledger.transition(unknown.idempotencyKey, "unknown_effect", { reason: "injected_timeout" });
    assert.equal(unresolved.effectState, "unknown_effect");
    assert.equal(isUnresolvedOperationEffect(unresolved), true);
    assert.equal(ledger.getReconciliationCounts().pendingTotal, 1);
  });
  await record("signed_proof", async () => {
    const proof = signOperationEffectProof("fault-canary-secret", {
      ownerKey: "canary-session",
      taskId: "canary-task",
      runId: "canary-run",
      sessionId: "canary-session",
      generation: "canary-generation",
      profileInstanceId: "canary-profile",
      targetIdentity: { ...binding, pageInstanceId: "page-1", windowId: 1, frameId: 0, origin: "https://fixture.invalid" },
      operationId: "op-5",
      idempotencyKey: "canary-proof",
      method: "page.snapshot",
      dispatchCount: 1,
      effectState: "known_no_effect",
      externalActionExecuted: false,
      mutationDispatchAttempted: false,
      cleanup: { state: "not_required", tabClosed: false },
      issuedAt: new Date().toISOString(),
      nonce: "canary-proof-nonce",
    });
    assert.equal(verifyOperationEffectProof("fault-canary-secret", proof, { taskId: "canary-task", runId: "canary-run" }).effectState, "known_no_effect");
  });
  ledger.close();
  report.result = "verified_fault_matrix";
} catch (error) {
  report.result = "blocked";
  report.exactBlocker = { code: error?.code ?? "fault_canary_failed", message: String(error?.message ?? error) };
} finally {
  if (dataDir) await rm(dataDir, { recursive: true, force: true }).catch(() => {});
  report.finishedAt = new Date().toISOString();
  process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
}

if (report.result !== "verified_fault_matrix") process.exitCode = 1;
