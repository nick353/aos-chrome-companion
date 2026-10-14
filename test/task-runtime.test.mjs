import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  isUncertainLocalNavigationEffect,
  isUnresolvedOperationEffect,
  localNavigationTargetDigest,
  localNavigationTargetDigestFromKey,
  normalizeTaskExecutionCapsule,
  TASK_EXECUTION_CAPSULE_SCHEMA,
  TaskOperationLedger,
  capsuleNoEffectSettlement,
  VIEWPORT_CLEANUP_AMENDMENT, viewportCleanupCandidate, verifyViewportCleanupReadback, verifyViewportAbsenceReadback, payloadDigest,
} from "../src/shared/task-runtime.mjs";

const secret = "local-navigation-proof-test-secret";

test("late no-effect settlement clears only exact transport inference and projects without rewriting history", async () => {
  const directory = await mkdtemp(join(tmpdir(), "aos-late-no-effect-"));
  const ledger = new TaskOperationLedger({ statePath: join(directory, "ledger.json"), secret });
  const binding = { taskId: "late-task", runId: "late-run", profileInstanceId: "late-profile",
    generation: "late-generation", sessionId: "late-session", tabId: 42, method: "page.type" };
  const result = { effectState: "known_no_effect", mutationDispatchAttempted: false, externalActionExecuted: false };
  try {
    await ledger.ready();
    const prepared = await ledger.prepare({ idempotencyKey: "late-idem:2", fingerprint: "late-fingerprint", binding });
    await ledger.transition(prepared.idempotencyKey, "dispatched", { mutationDispatchAttempted: true,
      mutationDispatchProvenance: "transport_inference", externalActionExecuted: null });
    await ledger.transition(prepared.idempotencyKey, "unknown_effect");
    await assert.rejects(ledger.reconcile(prepared.idempotencyKey, binding, result,
      { noEffectOperationId: prepared.operationId }), { code: "reconciliation_evidence_required" });
    await assert.rejects(ledger.reconcile(prepared.idempotencyKey, { ...binding, runId: "foreign" }, result,
      { brokerEvidence: true, noEffectOperationId: prepared.operationId }), { code: "reconciliation_binding_mismatch" });
    await assert.rejects(ledger.reconcile(prepared.idempotencyKey, binding, result,
      { brokerEvidence: true, noEffectOperationId: "different-operation" }), { code: "reconciliation_no_effect_proof_mismatch" });
    const settled = await ledger.reconcile(prepared.idempotencyKey, binding, result,
      { brokerEvidence: true, noEffectOperationId: prepared.operationId });
    assert.equal(settled.mutationDispatchAttempted, false);
    assert.equal(settled.mutationDispatchProvenance, "authenticated_no_effect");
    const capsule = normalizeTaskExecutionCapsule({ capsuleId: "late-capsule", taskId: binding.taskId, runId: binding.runId,
      state: "failed", target: binding, resources: { tabId: 42 }, effect: { idempotencyKey: "late-idem",
        effectState: "unknown_effect", externalActionExecuted: null, failedOperationId: prepared.operationId,
        failedOperationKey: prepared.idempotencyKey, actionProgress: { failed_action_index: 0, applied_action_indices: [] } } });
    await ledger.putTaskCapsule(capsule);
    const original = structuredClone(ledger.getTaskCapsule(capsule.capsuleId));
    const projection = capsuleNoEffectSettlement(original, ledger.listOperations());
    assert.equal(projection.effectState, "known_no_effect");
    assert.equal(projection.operationId, prepared.operationId);
    assert.deepEqual(ledger.getTaskCapsule(capsule.capsuleId), original);
    for (const field of ["taskId", "runId", "profileInstanceId", "generation", "sessionId", "tabId"]) {
      const foreign = structuredClone(settled); foreign.binding[field] = "foreign";
      assert.equal(capsuleNoEffectSettlement(original, [foreign]), null, field);
    }
    for (const override of [
      { mutationDispatchProvenance: undefined }, { mutationDispatchAttempted: true }, { state: "applied" },
      { createdTabId: 123 }, { awaitedEvent: {} }, { brokerEvidence: false },
      { effectState: "known_effect", noEffectProofValid: true },
      { noEffectProof: { ...settled.noEffectProof, operationId: "other" } },
    ]) assert.equal(capsuleNoEffectSettlement(original, [{ ...settled, ...override }]), null);
    assert.equal(capsuleNoEffectSettlement(original, [settled, { ...settled, idempotencyKey: "other:0",
      state: "unknown_effect", effectState: "unknown_effect" }]), null);
    const priorApplied = structuredClone(original); priorApplied.effect.actionProgress.applied_action_indices = [0];
    assert.equal(capsuleNoEffectSettlement(priorApplied, [settled]).effectState, "known_effect");
  } finally { ledger.close(); await rm(directory, { recursive: true, force: true }); }
});

test("terminal authenticated no-effect reconciliation cannot be overwritten or lose its proof flag", async () => {
  const directory = await mkdtemp(join(tmpdir(), "aos-terminal-no-effect-"));
  const ledger = new TaskOperationLedger({ statePath: join(directory, "ledger.json"), secret });
  const binding = { taskId: "terminal-task", runId: "terminal-run", method: "page.click" };
  const result = { effectState: "known_no_effect", mutationDispatchAttempted: false, externalActionExecuted: false };
  try {
    await ledger.ready();
    const entry = await ledger.prepare({ idempotencyKey: "terminal:0", binding, fingerprint: "terminal" });
    await ledger.transition(entry.idempotencyKey, "dispatched", { mutationDispatchAttempted: true,
      mutationDispatchProvenance: "transport_inference", externalActionExecuted: null });
    await ledger.transition(entry.idempotencyKey, "unknown_effect");
    await ledger.reconcile(entry.idempotencyKey, binding, result,
      { brokerEvidence: true, noEffectOperationId: entry.operationId });
    const original = structuredClone(ledger.get(entry.idempotencyKey));
    const same = await ledger.reconcile(entry.idempotencyKey, binding, result,
      { brokerEvidence: true, noEffectOperationId: entry.operationId });
    assert.deepEqual(same, original);
    for (const [changed, noEffectOperationId] of [
      [{ effectState: "known_effect", externalActionExecuted: true }, null],
      [result, null], [result, "different-operation"],
      [{ ...result, mutationDispatchAttempted: true }, entry.operationId],
      [{ ...result, extraReceipt: "different-proof" }, entry.operationId],
    ]) {
      await assert.rejects(ledger.reconcile(entry.idempotencyKey, binding, changed,
        { brokerEvidence: true, noEffectOperationId }), { code: "reconciliation_terminal_immutable" });
      assert.deepEqual(ledger.get(entry.idempotencyKey), original);
    }
    const applied = await ledger.prepare({ idempotencyKey: "terminal:1", binding, fingerprint: "known-effect" });
    await ledger.transition(applied.idempotencyKey, "dispatched");
    await ledger.transition(applied.idempotencyKey, "unknown_effect");
    await ledger.reconcile(applied.idempotencyKey, binding, { effectState: "known_effect", externalActionExecuted: true }, { brokerEvidence: true });
    const knownEffect = structuredClone(ledger.get(applied.idempotencyKey));
    await assert.rejects(ledger.reconcile(applied.idempotencyKey, binding, result, { brokerEvidence: true }),
      { code: "reconciliation_terminal_immutable" });
    assert.deepEqual(ledger.get(applied.idempotencyKey), knownEffect);
  } finally { ledger.close(); await rm(directory, { recursive: true, force: true }); }
});

test("late no-effect proof cannot clear genuine legacy pending or created-tab evidence", async () => {
  const directory = await mkdtemp(join(tmpdir(), "aos-late-no-effect-guards-"));
  const ledger = new TaskOperationLedger({ statePath: join(directory, "ledger.json"), secret });
  const binding = { taskId: "task", runId: "run", method: "page.click" };
  try {
    await ledger.ready();
    for (const [index, details] of [
      { mutationDispatchProvenance: "observed_mutation" }, { mutationDispatchProvenance: "action_event", awaitedEvent: {} },
      { mutationDispatchProvenance: undefined }, { createdTabId: 123 }, { externalActionExecuted: true },
      { reason: "action_event_pending" },
    ].entries()) {
      const key = `guard:${index}`;
      const entry = await ledger.prepare({ idempotencyKey: key, binding, fingerprint: key });
      await ledger.transition(key, "dispatched", { mutationDispatchAttempted: true,
        mutationDispatchProvenance: "transport_inference", externalActionExecuted: false, ...details });
      if (index === 2) delete entry.mutationDispatchProvenance; // Undistinguished historical entry.
      await ledger.transition(key, "unknown_effect");
      await assert.rejects(ledger.reconcile(key, binding, { effectState: "none", mutationDispatchAttempted: false,
        externalActionExecuted: false }, { brokerEvidence: true, noEffectOperationId: entry.operationId }),
      { code: "reconciliation_no_effect_proof_mismatch" });
      assert.equal(ledger.get(key).mutationDispatchAttempted, true);
    }
  } finally { ledger.close(); await rm(directory, { recursive: true, force: true }); }
});

function uncertainOperation(overrides = {}) {
  return {
    idempotencyKey: "run-local-navigation:0",
    state: "unknown_effect",
    effectState: "unknown_effect",
    dispatchState: "dispatched",
    dispatchCount: 1,
    mutationDispatchAttempted: true,
    externalActionExecuted: false,
    effectClass: "local_ui",
    binding: {
      taskId: "task-local-navigation",
      runId: "run-local-navigation",
      method: "tabs.navigate",
      tabId: 42,
      profileInstanceId: "profile-local-navigation",
    },
    navigationTargetDigest: localNavigationTargetDigest(secret, "https://example.test/target"),
    ...overrides,
  };
}

test("only an exact dispatched task tabs.navigate can be a local navigation arrival effect", () => {
  const operation = uncertainOperation();
  assert.equal(isUncertainLocalNavigationEffect(operation), true);
  assert.equal(isUnresolvedOperationEffect(operation), true);

  for (const method of ["page.type", "page.click", "tabs.create", "page.submit"]) {
    const effectClass = method === "page.submit" ? "external_commit" : "local_ui";
    const otherMutation = uncertainOperation({
      idempotencyKey: `run-local-navigation:${method === "page.type" ? 1 : method === "page.click" ? 2 : method === "tabs.create" ? 3 : 4}`,
      effectClass,
      binding: { ...operation.binding, method },
    });
    assert.equal(isUncertainLocalNavigationEffect(otherMutation), false, method);
    if (method !== "page.submit") assert.equal(isUnresolvedOperationEffect(otherMutation), false, method);
  }

  for (const invalid of [
    { ...operation, idempotencyKey: "run-local-navigation:0:child" },
    { ...operation, binding: { ...operation.binding, taskId: "" } },
    { ...operation, binding: { ...operation.binding, runId: null } },
    { ...operation, dispatchState: "not_dispatched" },
    { ...operation, dispatchCount: 2 },
    { ...operation, mutationDispatchAttempted: false },
    { ...operation, externalActionExecuted: true },
    { ...operation, externalActionExecuted: null },
    { ...operation, effectClass: "external_commit" },
    { ...operation, state: "applied" },
    { ...operation, effectState: "known_effect" },
  ]) {
    assert.equal(isUncertainLocalNavigationEffect(invalid), false);
  }
});

test("local navigation target digests bind normalized HTTP(S) destinations and strict legacy keys", () => {
  const digest = localNavigationTargetDigest(secret, "https://example.test/a/../target?mode=1");
  assert.equal(digest, localNavigationTargetDigest(secret, "https://example.test/target?mode=1"));
  assert.notEqual(digest, localNavigationTargetDigest(secret, "https://example.test/target?mode=2"));
  assert.equal(localNavigationTargetDigest(secret, "chrome://settings"), null);
  assert.equal(localNavigationTargetDigestFromKey(secret, "url:https://example.test/target?mode=1"),
    localNavigationTargetDigest(secret, "https://example.test/target?mode=1"));
  assert.equal(localNavigationTargetDigestFromKey(secret, `url:${"https://example.test/"}${"x".repeat(500)}`), null);
  assert.equal(localNavigationTargetDigestFromKey(secret, "url:https://example.test/target#fragment"), null);
  assert.equal(localNavigationTargetDigestFromKey(secret, "target:https://example.test/target"), null);
});

async function createLocalNavigationLedgerFixture({ legacy = false, otherUnresolved = false } = {}) {
  const directory = await mkdtemp(join(tmpdir(), "aos-local-navigation-ledger-"));
  const ledgerSecret = "local-navigation-ledger-secret";
  const ledger = new TaskOperationLedger({ statePath: join(directory, "ledger.json"), secret: ledgerSecret });
  await ledger.ready();

  const taskId = "task-local-navigation-ledger";
  const runId = "run-local-navigation-ledger";
  const idempotencyKey = "idem-local-navigation-ledger";
  const tabId = 42;
  const profileInstanceId = "profile-local-navigation-ledger";
  const targetUrl = "https://example.test/arrived";
  const targetDigest = localNavigationTargetDigest(ledgerSecret, targetUrl);
  const blocker = { code: "local_navigation_ack_unknown", message: "The navigation acknowledgement was lost." };
  const operationBinding = { taskId, runId, tabId, profileInstanceId, method: "tabs.navigate" };

  await ledger.prepare({
    idempotencyKey: `${idempotencyKey}:0`,
    fingerprint: "tabs.navigate:https://example.test/arrived",
    binding: operationBinding,
    navigationTargetDigest: targetDigest,
  });
  await ledger.transition(`${idempotencyKey}:0`, "dispatched", {
    dispatchState: "dispatched",
    effectClass: "local_ui",
    mutationDispatchAttempted: true,
    externalActionExecuted: false,
    operationIndex: 0,
  });
  await ledger.transition(`${idempotencyKey}:0`, "unknown_effect", {
    effectClass: "local_ui",
    mutationDispatchAttempted: true,
    externalActionExecuted: false,
    operationIndex: 0,
  });

  const capsule = normalizeTaskExecutionCapsule({
    capsuleId: "capsule-local-navigation-ledger",
    taskId,
    runId,
    workflowType: "AOS",
    state: legacy ? "failed" : "reconciliation_required",
    target: {
      targetKey: `url:${targetUrl}`,
      profileInstanceId,
      generation: "generation-local-navigation-ledger",
      sessionId: "session-local-navigation-ledger",
      tabId,
    },
    resources: { tabId },
    blocker,
    retention: {
      policy: "retain_until_resume",
      reason: legacy ? "local_ui_effect_unknown" : "local_ui_navigation_arrival_pending",
    },
    effect: {
      effectClass: "local_ui",
      effectState: "unknown_effect",
      externalActionExecuted: false,
      reconciliationRequired: true,
      idempotencyKey,
      dispatchCount: 1,
      localNavigationTargetDigest: targetDigest,
      actionProgress: {
        total_actions: 2,
        applied_action_indices: [],
        verified_action_indices: [],
        failed_action_index: 0,
        failed_action_effect_state: "unknown_effect",
        unattempted_action_indices: [1],
        remaining_action_indices: [],
        uncertain_action_indices: [0],
        replay_allowed: false,
      },
    },
  });
  assert.equal(capsule.schema, TASK_EXECUTION_CAPSULE_SCHEMA);
  await ledger.putTaskCapsule(capsule);

  let otherKey = null;
  if (otherUnresolved) {
    otherKey = "idem-other-local-navigation-effect:0";
    await ledger.prepare({
      idempotencyKey: otherKey,
      fingerprint: "page.click:other-target",
      binding: { taskId, runId, tabId: tabId + 1, profileInstanceId, method: "page.click" },
    });
    await ledger.transition(otherKey, "dispatched", {
      dispatchState: "dispatched",
      effectClass: "external_commit",
      mutationDispatchAttempted: true,
      externalActionExecuted: null,
    });
    await ledger.transition(otherKey, "unknown_effect", {
      effectClass: "external_commit",
      mutationDispatchAttempted: true,
      externalActionExecuted: null,
    });
  }

  return { directory, ledger, capsule, blocker, idempotencyKey, otherKey, targetDigest };
}

function completeLocalNavigation(ledger, capsule, idempotencyKey, operationIndex, recordedTargetDigest) {
  return ledger.completeTaskReconciliation(capsule.capsuleId, {
    completion: { reconciliation: { providerSuccessConfirmed: false } },
    retention: { policy: "cleanup", reason: null },
  }, {
    brokerEvidence: true,
    proofDigest: "broker-signed-local-navigation-proof",
    proofKind: "local_navigation_arrival",
    operationIndex,
    recordedTargetDigest,
  });
}

for (const legacy of [false, true]) {
  test(`local navigation ledger settles only the exact signed arrival binding (${legacy ? "legacy failed" : "current reconciliation"} capsule)`, async () => {
    const fixture = await createLocalNavigationLedgerFixture({ legacy });
    const { ledger, capsule, blocker, idempotencyKey, targetDigest, directory } = fixture;
    try {
      await assert.rejects(
        completeLocalNavigation(ledger, capsule, idempotencyKey, 1, targetDigest),
        (error) => error.code === "local_navigation_operation_index_mismatch",
      );
      await assert.rejects(
        completeLocalNavigation(ledger, capsule, idempotencyKey, 0, localNavigationTargetDigest(secret, "https://example.test/elsewhere")),
        (error) => error.code === "local_navigation_target_mismatch",
      );

      const unchanged = ledger.getTaskCapsule(capsule.capsuleId);
      assert.equal(unchanged.state, legacy ? "failed" : "reconciliation_required");
      assert.equal(unchanged.effect.effectState, "unknown_effect");
      assert.equal(ledger.get(`${idempotencyKey}:0`).state, "unknown_effect");

      const settled = await completeLocalNavigation(ledger, capsule, idempotencyKey, 0, targetDigest);
      assert.equal(settled.schema, TASK_EXECUTION_CAPSULE_SCHEMA);
      assert.equal(settled.state, "failed");
      assert.deepEqual(settled.blocker, blocker);
      assert.equal(settled.effect.effectClass, "local_ui");
      assert.equal(settled.effect.effectState, "known_effect");
      assert.equal(settled.effect.externalActionExecuted, false);
      assert.equal(settled.effect.reconciliationRequired, false);
      assert.equal(settled.effect.localNavigationArrivalSettled, true);
      assert.equal(settled.effect.localNavigationOperationIndex, 0);
      assert.equal(settled.effect.localNavigationOtherUnresolvedEffects, 0);
      assert.deepEqual(settled.effect.actionProgress.applied_action_indices, [0]);
      assert.deepEqual(settled.effect.actionProgress.verified_action_indices, [0]);
      assert.deepEqual(settled.effect.actionProgress.uncertain_action_indices, []);
      assert.deepEqual(settled.effect.actionProgress.remaining_action_indices, []);
      assert.deepEqual(settled.effect.actionProgress.reconciled_action_indices, [0]);
      assert.equal(settled.effect.actionProgress.replay_allowed, false);
      assert.equal(settled.completion.reconciliation.providerSuccessConfirmed, false);
      assert.equal(settled.retention.policy, "cleanup");
      assert.equal(settled.retention.reason, null);

      const operation = ledger.get(`${idempotencyKey}:0`);
      assert.equal(operation.state, "reconciled");
      assert.equal(operation.effectState, "known_effect");
      assert.equal(operation.effectClass, "local_ui");
      assert.equal(operation.externalActionExecuted, false);
      assert.equal(operation.localNavigationArrivalReconciled, true);
    } finally {
      ledger.close();
      await rm(directory, { recursive: true, force: true });
    }
  });
}

for (const legacy of [false, true]) {
  test(`local navigation arrival keeps terminal cleanup gated by another unresolved operation (${legacy ? "legacy failed" : "current reconciliation"} capsule)`, async () => {
    const fixture = await createLocalNavigationLedgerFixture({ legacy, otherUnresolved: true });
    const { ledger, capsule, idempotencyKey, otherKey, targetDigest, directory } = fixture;
    try {
      const settled = await completeLocalNavigation(ledger, capsule, idempotencyKey, 0, targetDigest);
      assert.equal(settled.state, "failed");
      assert.equal(settled.effect.localNavigationArrivalSettled, true);
      assert.equal(settled.effect.externalActionExecuted, false);
      assert.equal(settled.effect.localNavigationOtherUnresolvedEffects, 1);
      assert.equal(settled.effect.actionProgress.replay_allowed, false);
      assert.deepEqual(settled.effect.actionProgress.remaining_action_indices, []);
      assert.equal(settled.retention.policy, "retain_until_resume");
      assert.equal(settled.retention.reason, "ai_reconciliation_pending");
      assert.equal(settled.retention.resumeAction, "reconcile_other_unresolved_operation_without_replay");
      assert.equal(ledger.get(`${idempotencyKey}:0`).state, "reconciled");
      assert.equal(ledger.get(otherKey).state, "unknown_effect");
      assert.equal(ledger.get(otherKey).effectState, "unknown_effect");
    } finally {
      ledger.close();
      await rm(directory, { recursive: true, force: true });
    }
  });
}

// Historical identity/digest are a seeded isolated fixture, not live evidence.
const viewportExpected = VIEWPORT_CLEANUP_AMENDMENT;
function viewportLedgerFixture() {
  const e = viewportExpected, now = Date.parse("2026-10-05T00:00:00Z");
  const target = { ...e, intendedUrl: e.url };
  const entry = { operationId: e.operationId, idempotencyKey: e.operationKey, state: "reconciled", effectState: "known_effect",
    brokerEvidence: true, resultDigest: e.resultDigest, externalActionExecuted: false, dispatchCount: 1,
    preparedAt: "2026-10-04T18:10:34.151Z", reconciledAt: "2026-10-04T18:10:50.403Z",
    binding: { ...e, ownerKey: e.sessionId, method: "page.configureViewport", targetIdentity: target } };
  const capsule = normalizeTaskExecutionCapsule({ capsuleId: e.capsuleId, taskId: e.taskId, runId: e.runId,
    state: "failed", target, resources: { tabId: e.tabId }, retention: { policy: "retain_until_resume", reason: "local_ui_effect_unknown" },
    effect: { effectClass: "local_ui", effectState: "unknown_effect", externalActionExecuted: false,
      idempotencyKey: "light-model-1280-set-once", failedOperationKey: e.operationKey, failedOperationId: e.operationId },
    blocker: { code: "operation_effect_unknown" }, completion: { providerReceipt: null } });
  const current = { sessionId: "current-maintenance-session", leaseId: "current-maintenance-lease" };
  const payload = { schema: "aos.chrome_companion.visual_point_proof.v1", ...current,
    taskId: e.taskId, profileInstanceId: e.profileInstanceId, generation: e.generation, tabId: e.tabId,
    pageInstanceId: e.pageInstanceId, pageUrl: e.url, screenshotDigest: "capture-digest",
    viewport: { width: 713, height: 636, devicePixelRatio: 2, scale: 1 },
    capturedAt: new Date(now - 1000).toISOString(), expiresAt: new Date(now + 59000).toISOString() };
  return { now, entry, capsule, current, payload, sign: data => ({ ...data, signature: payloadDigest(secret, data) }) };
}

test("viewport cleanup exact accepted ACK rejects incomplete identities, deadline and other obligations", () => {
  const valid = viewportLedgerFixture();
  assert.equal(viewportCleanupCandidate(valid.capsule, [valid.entry], [], valid.now).entry, valid.entry);
  const changes = [
    f => { f.entry.brokerEvidence = false; }, f => { f.entry.resultDigest = ""; }, f => { f.entry.resultDigest = "other"; },
    f => { f.entry.operationId = "other"; }, f => { f.entry.binding.method = "page.type"; },
    f => { f.entry.effectState = "unknown_effect"; }, f => { f.entry.state = "applied"; },
    f => { f.entry.reconciledAt = "invalid"; }, f => { f.entry.reconciledAt = undefined; },
    f => { f.entry.reconciledAt = new Date(f.now - 1_800_000).toISOString(); },
    f => { f.entry.externalActionExecuted = true; }, f => { f.capsule.effect.uploadDelivery = {}; },
    f => { f.capsule.effect.awaitedEvent = {}; }, f => { f.capsule.taskId = "other"; },
    ...["ownerKey", "taskId", "runId", "sessionId", "generation", "profileInstanceId", "tabId"].map(key => f => { f.entry.binding[key] = "other"; }),
    ...["pageInstanceId", "windowId", "frameId", "origin"].map(key => f => { f.entry.binding.targetIdentity[key] = "other"; }),
  ];
  for (const change of changes) { const f = viewportLedgerFixture(); change(f);
    assert.throws(() => viewportCleanupCandidate(f.capsule, [f.entry], [], f.now), { code: "viewport_cleanup_not_applicable" }); }
  for (const method of ["page.submit", "tabs.navigate", "page.uploadFiles", "page.type"]) {
    const other = { ...valid.entry, operationId: "other", state: "unknown_effect", effectState: "unknown_effect",
      binding: { ...valid.entry.binding, method, tabId: 77 } };
    assert.throws(() => viewportCleanupCandidate(valid.capsule, [valid.entry, other], [], valid.now));
  }
  const renewal = { ...valid.entry, operationId: "renewal", preparedAt: "2026-10-04T18:11:00Z" };
  assert.throws(() => viewportCleanupCandidate(valid.capsule, [valid.entry, renewal], [], valid.now));
  assert.throws(() => viewportCleanupCandidate(valid.capsule, [valid.entry], [{ ...valid.capsule, capsuleId: "other" }], valid.now));
});

test("viewport signed readback rejects unsigned, stale, premature, requested and unrelated metrics", () => {
  const f = viewportLedgerFixture();
  assert.equal(verifyViewportCleanupReadback(secret, f.sign(f.payload), f.current, f.entry, f.now).viewport.width, 713);
  const changes = [p => { p.capturedAt = "2026-10-04T18:40:50.403Z"; }, p => { p.capturedAt = new Date(f.now-61000).toISOString(); },
    p => { p.expiresAt = new Date(f.now).toISOString(); }, p => { p.capturedAt = new Date(f.now+1).toISOString(); },
    p => { p.generation = "other"; }, p => { p.pageInstanceId = "other"; }, p => { p.tabId = 1; },
    p => { p.viewport = { width: 1280, height: 900, devicePixelRatio: 1, scale: 1 }; },
    p => { p.viewport = { width: 1281, height: 901, devicePixelRatio: 1.01, scale: 1 }; },
    p => { p.viewport.width = "713"; }, p => { p.viewport.width = 0; }, p => { p.screenshotDigest = ""; }];
  for (const change of changes) { const p = structuredClone(f.payload); change(p);
    assert.throws(() => verifyViewportCleanupReadback(secret, f.sign(p), f.current, f.entry, f.now)); }
  assert.throws(() => verifyViewportCleanupReadback(secret, f.payload, f.current, f.entry, f.now));
  assert.throws(() => verifyViewportCleanupReadback(secret, { ...f.sign(f.payload), viewport: { width: 713 } }, f.current, f.entry, f.now));
});

test("viewport append is one signed receipt; original failure/digest/provider progress remain immutable", async () => {
  const f = viewportLedgerFixture(), directory = await mkdtemp(join(tmpdir(), "aos-viewport-amendment-"));
  const statePath = join(directory, "ledger.json");
  const ledger = new TaskOperationLedger({ statePath, secret, now: () => f.now });
  try {
    await ledger.ready();
    await ledger.prepare({ idempotencyKey: f.entry.idempotencyKey, fingerprint: "historical-fingerprint", binding: f.entry.binding });
    await ledger.transition(f.entry.idempotencyKey, "dispatched", { operationId: f.entry.operationId });
    // Fixture seeding uses a broker-owned late result first; accepted digest is
    // supplied historical evidence, not a digest reconstructed from raw ACK.
    await ledger.transition(f.entry.idempotencyKey, "unknown_effect");
    await ledger.reconcile(f.entry.idempotencyKey, f.entry.binding, { acknowledged: true, effectState: "known_effect" }, { brokerEvidence: true });
    Object.assign(ledger.get(f.entry.idempotencyKey), f.entry);
    await ledger.putTaskCapsule(f.capsule);
    const original = structuredClone(ledger.get(f.entry.idempotencyKey));
    await assert.rejects(ledger.appendViewportCleanup({ capsuleId: f.capsule.capsuleId, proof: f.sign(f.payload), currentBinding: f.current }), { code: "reconciliation_evidence_required" });
    const receipt = await ledger.appendViewportCleanup({ capsuleId: f.capsule.capsuleId, proof: f.sign(f.payload), currentBinding: f.current }, { brokerEvidence: true });
    const again = await ledger.appendViewportCleanup({ capsuleId: f.capsule.capsuleId, proof: null }, { brokerEvidence: true });
    assert.deepEqual(again, receipt);
    const { viewportCleanupReceipts, ...after } = ledger.get(f.entry.idempotencyKey);
    assert.deepEqual(after, original); assert.equal(viewportCleanupReceipts.length, 1);
    const capsule = ledger.getTaskCapsule(f.capsule.capsuleId);
    assert.equal(capsule.state, "failed"); assert.deepEqual(capsule.blocker, f.capsule.blocker);
    assert.deepEqual(capsule.completion, f.capsule.completion); assert.equal(capsule.effect.effectState, "known_effect");
    assert.equal(capsule.retention.policy, "cleanup"); assert.equal(receipt.desktopAcceptance, false);
    assert.equal(receipt.timerExecutionProven, false); assert.equal(receipt.viewportMutationDispatchCount, 0);
    ledger.close();
    const restored = new TaskOperationLedger({ statePath, secret, now: () => f.now });
    try { await restored.ready(); assert.deepEqual(restored.get(f.entry.idempotencyKey).viewportCleanupReceipts, [receipt]); }
    finally { restored.close(); }
  } finally { ledger.close(); await rm(directory, { recursive: true, force: true }); }
});


test("viewport absence proof rejects unsigned, stale, filtered, capped and wrong-provenance evidence", () => {
  const f = viewportLedgerFixture(), e = VIEWPORT_CLEANUP_AMENDMENT;
  const make = () => ({ schema: "aos.chrome_companion.viewport_absence_proof.v1", taskId: e.taskId,
    profileInstanceId: e.profileInstanceId, generation: e.generation, sessionId: f.current.sessionId, tabId: e.tabId,
    inventoryParams: {}, inventoryCap: 200, inventoryIds: [7, 8], lookupParams: { tabId: e.tabId },
    capturedAt: new Date(f.now - 1).toISOString(),
    inventoryEvidence: { method: "tabs.list", operationId: "inventory-op", returned: true, brokerEvidence: true,
      sessionId: f.current.sessionId, profileInstanceId: e.profileInstanceId, generation: e.generation,
      resultDigest: "inventory-digest", startedAt: new Date(f.now-100).toISOString(), completedAt: new Date(f.now-50).toISOString() },
    lookupEvidence: { method: "tabs.get", operationId: "lookup-op", brokerEvidence: true,
      sessionId: f.current.sessionId, profileInstanceId: e.profileInstanceId, generation: e.generation,
      resultDigest: "lookup-error-digest", startedAt: new Date(f.now-49).toISOString(), completedAt: new Date(f.now-2).toISOString(),
      errorCode: "extension_operation_failed", errorMessage: `No tab with id: ${e.tabId}.` } });
  assert.equal(verifyViewportAbsenceReadback(secret, f.sign(make()), f.current, f.now).inventoryIds.length, 2);
  const changes = [p => { p.inventoryParams = { currentWindow: true }; }, p => { p.inventoryCap = 201; },
    p => { p.inventoryIds = Array.from({length:200}, (_,i)=>i); }, p => { p.inventoryIds.push(e.tabId); },
    p => { p.inventoryIds.push(7); }, p => { p.inventoryIds = ["7"]; },
    p => { p.lookupParams.tabId = 7; }, p => { p.lookupEvidence.errorCode = "operation_timeout"; },
    p => { p.lookupEvidence.errorMessage = "Permission denied"; }, p => { p.lookupEvidence.brokerEvidence = false; },
    p => { p.lookupEvidence.generation = "other"; }, p => { p.lookupEvidence.operationId = "inventory-op"; },
    p => { p.inventoryEvidence.startedAt = new Date(f.now-61000).toISOString(); },
    p => { p.capturedAt = new Date(f.now+1).toISOString(); }, p => { p.inventoryEvidence.completedAt = "invalid"; }];
  for (const change of changes) { const p = make(); change(p);
    assert.throws(() => verifyViewportAbsenceReadback(secret, f.sign(p), f.current, f.now), { code: "viewport_cleanup_absence_invalid" }); }
  assert.throws(() => verifyViewportAbsenceReadback(secret, make(), f.current, f.now));
});
