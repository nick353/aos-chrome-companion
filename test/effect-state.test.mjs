import assert from "node:assert/strict";
import test from "node:test";
import {
  OPERATION_EFFECT_PROOF_SCHEMA,
  classifyInterruptedEffect,
  isUnresolvedOperationEffect,
  normalizeOperationEffectState,
  operationRequiresReconciliation,
  operationEffectStateForEntry,
  signOperationEffectProof,
  TaskOperationLedger,
  normalizeTaskExecutionCapsule,
  targetIdentityDigest,
  verifyOperationEffectProof,
} from "../src/shared/task-runtime.mjs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

test("operation effect state has four explicit, backward-compatible classes", () => {
  assert.equal(normalizeOperationEffectState("none"), "known_no_effect");
  assert.equal(normalizeOperationEffectState("applied"), "known_effect");
  assert.equal(normalizeOperationEffectState("unknown"), "unknown_effect");
  assert.equal(operationEffectStateForEntry({ state: "prepared" }), "no_dispatch");
  assert.equal(operationEffectStateForEntry({ state: "blocked" }), "known_no_effect");
  assert.equal(operationEffectStateForEntry({ state: "applied" }), "known_effect");
  assert.equal(operationEffectStateForEntry({ state: "unknown_effect" }), "unknown_effect");
  assert.equal(isUnresolvedOperationEffect({ state: "blocked", effectState: "known_no_effect" }), false);
  assert.equal(isUnresolvedOperationEffect({ state: "unknown_effect" }), true);
  assert.equal(operationRequiresReconciliation({ binding: { method: "page.type" }, effectState: "unknown_effect" }), false);
  assert.equal(isUnresolvedOperationEffect({ binding: { method: "page.type" }, state: "unknown_effect", effectState: "unknown_effect" }), false);
  assert.equal(operationRequiresReconciliation({ binding: { method: "page.submit" }, effectState: "unknown_effect" }), true);
});

test("restart classifier permits only proven no-dispatch paths to fresh retry", () => {
  assert.deepEqual(
    classifyInterruptedEffect({ state: "dispatched", dispatchState: "not_dispatched", dispatchCount: 0 }),
    {
      classification: "NO_DISPATCH",
      retryAllowed: true,
      requiresReconciliation: false,
      dispatchCount: 0,
      reason: "dispatch_not_started",
    },
  );
  assert.equal(classifyInterruptedEffect({
    state: "dispatched",
    dispatchState: "dispatched",
    dispatchCount: 1,
    effectState: "known_no_effect",
    externalActionExecuted: false,
    mutationDispatchAttempted: false,
    brokerEvidence: true,
    noEffectProof: { valid: true, brokerEvidence: true, effectState: "known_no_effect" },
  }).classification, "PROVEN_NO_EFFECT");
  assert.equal(classifyInterruptedEffect({ state: "dispatched", dispatchState: "dispatched", dispatchCount: 1 }).classification, "UNKNOWN_EFFECT");
  assert.equal(classifyInterruptedEffect({ state: "unknown_effect", dispatchState: "dispatched", dispatchCount: 1 }).retryAllowed, false);
});

test("signed effect proof binds the complete task target and rejects tampering", () => {
  const secret = "effect-proof-test-secret";
  const proof = signOperationEffectProof(secret, {
    ownerKey: "session-1",
    taskId: "task-1",
    runId: "run-1",
    sessionId: "session-1",
    leaseId: "lease-1",
    generation: "generation-1",
    profileInstanceId: "profile-1",
    targetIdentity: {
      taskId: "task-1",
      sessionId: "session-1",
      leaseId: "lease-1",
      generation: "generation-1",
      profileInstanceId: "profile-1",
      tabId: 42,
      pageInstanceId: "page-1",
      windowId: 3,
      frameId: 0,
      origin: "https://example.test/form",
    },
    operationId: "op-1",
    idempotencyKey: "idem-1",
    method: "page.click",
    dispatchCount: 1,
    effectState: "known_effect",
    externalActionExecuted: true,
    mutationDispatchAttempted: true,
    cleanup: { state: "pending", tabClosed: false },
    capabilityDigest: "capabilities",
    resultDigest: "result",
    nonce: "nonce-1",
  });
  assert.equal(proof.schema, OPERATION_EFFECT_PROOF_SCHEMA);
  assert.equal(verifyOperationEffectProof(secret, proof, {
    taskId: "task-1",
    runId: "run-1",
    ownerKey: "session-1",
    idempotencyKey: "idem-1",
    method: "page.click",
    effectState: "known_effect",
    targetIdentity: proof.targetIdentity,
  }).taskId, "task-1");
  assert.throws(() => verifyOperationEffectProof(secret, { ...proof, effectState: "unknown_effect" }, {
    taskId: "task-1",
  }), /signature_invalid/u);
});

test("ownerless reconciliation is terminalized after one bounded window without changing effect evidence", async () => {
  const root = await mkdtemp(join(tmpdir(), "aos-companion-reconciliation-ttl-"));
  const now = Date.parse("2026-08-31T00:00:00.000Z");
  const ledger = new TaskOperationLedger({
    statePath: join(root, "state.json"),
    secret: "reconciliation-ttl-secret",
    now: () => now,
  });
  await ledger.ready();
  const capsule = normalizeTaskExecutionCapsule({
    taskId: "task-ttl",
    runId: "run-ttl",
    state: "reconciliation_required",
    target: {
      taskId: "task-ttl",
      runId: "run-ttl",
      sessionId: "session-gone",
      profileInstanceId: "profile-ttl",
      generation: "generation-ttl",
      tabId: 7,
      pageInstanceId: "page-ttl",
      origin: "https://example.test",
    },
    effect: { effectState: "unknown_effect", reconciliationRequired: true },
    updatedAt: "2026-08-30T23:00:00.000Z",
  }, { now: "2026-08-30T23:00:00.000Z" });
  await ledger.putTaskCapsule(capsule);
  await ledger.recordTaskTab({
    taskId: "task-ttl",
    runId: "run-ttl",
    sessionId: "session-gone",
    profileInstanceId: "profile-ttl",
    generation: "generation-ttl",
    tabId: 7,
    lifecycleState: "reconciliation_required",
    retentionPolicy: "retain_until_resume",
    targetIdentity: {
      taskId: "task-ttl",
      sessionId: "session-gone",
      generation: "generation-ttl",
      profileInstanceId: "profile-ttl",
      tabId: 7,
      pageInstanceId: "page-ttl",
      windowId: 1,
      frameId: 0,
      origin: "https://example.test",
    },
    targetFingerprint: targetIdentityDigest("reconciliation-ttl-secret", {
      taskId: "task-ttl",
      sessionId: "session-gone",
      generation: "generation-ttl",
      profileInstanceId: "profile-ttl",
      tabId: 7,
      pageInstanceId: "page-ttl",
      windowId: 1,
      frameId: 0,
      origin: "https://example.test",
    }),
  });
  const result = await ledger.terminalizeOrphanedReconciliations({ ttlMs: 60_000 });
  assert.equal(result.capsules.length, 1);
  assert.equal(result.capsules[0].state, "failed");
  assert.equal(result.capsules[0].effect.effectState, "unknown_effect");
  assert.equal(result.capsules[0].effect.unresolvedTerminal, true);
  assert.equal(result.taskTabs[0].retentionPolicy, "ledger_only");
  assert.equal(ledger.getReconciliationCounts().pendingTotal, 0);
  await rm(root, { recursive: true, force: true });
});
