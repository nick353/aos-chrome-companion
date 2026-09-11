import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  authorizedTransactionPayload,
  createAuthorityEnvelope,
  payloadDigest,
  TaskOperationLedger,
  verifyAuthorityEnvelope,
} from "../src/shared/task-runtime.mjs";

test("authority envelope binds payload, expiry, and nonce", () => {
  const secret = "issuer-secret";
  const envelope = createAuthorityEnvelope({
    issuer: "aos", secret, runId: "run-1", taskId: "task-1", ownerKey: "session-1",
    method: "page.click", intent: "click", targetOrigin: "http://localhost:8787",
    payload: { tabId: 7, locator: { role: "button", name: "Save" } }, now: Date.now(), ttlMs: 30_000,
  });
  assert.equal(verifyAuthorityEnvelope(envelope, {
    secrets: { aos: secret },
    payload: { tabId: 7, locator: { role: "button", name: "Save" } },
    expected: { taskId: "task-1", ownerKey: "session-1", method: "page.click" },
    replayedNonces: new Set(),
  }).taskId, "task-1");
  assert.throws(() => verifyAuthorityEnvelope({ ...envelope, payloadHmac: "tampered" }, {
    secrets: { aos: secret }, payload: { tabId: 7 }, replayedNonces: new Set(),
  }), /payload digest/);
  assert.notEqual(payloadDigest("issuer-a", { value: 1 }), payloadDigest("issuer-b", { value: 1 }));
  assert.throws(() => payloadDigest(secret), /payload_digest_payload_required/);
  assert.throws(() => verifyAuthorityEnvelope({ ...envelope, approved: false }, {
    secrets: { aos: secret }, payload: { tabId: 7, locator: { role: "button", name: "Save" } }, replayedNonces: new Set(),
  }), /not approved/);
  assert.throws(() => verifyAuthorityEnvelope({ ...envelope, extra: true }, {
    secrets: { aos: secret }, payload: { tabId: 7, locator: { role: "button", name: "Save" } }, replayedNonces: new Set(),
  }), /unexpected or missing fields/);
  assert.throws(() => verifyAuthorityEnvelope(envelope, {
    secrets: { aos: secret }, payload: { tabId: 7, locator: { role: "button", name: "Save" } }, expected: { intent: "navigate" }, replayedNonces: new Set(),
  }), /binding mismatch/);
});

test("authority payload survives the JSON socket boundary", () => {
  const secret = "wire-semantics-secret";
  const payload = authorizedTransactionPayload({
    startUrl: "https://example.test/apply",
    allowedOrigins: ["https://example.test"],
    actions: [{ method: "page.upload", params: { locator: undefined, file: { name: "resume.pdf" } } }],
    reuseTaskTab: true,
    keepTaskTab: undefined,
    retainOnUnknown: false,
    capsule: { workflowType: "Jobs", optional: undefined },
  });
  const envelope = createAuthorityEnvelope({
    issuer: "codex_mcp",
    secret,
    runId: "run-wire",
    taskId: "task-wire",
    ownerKey: "session-wire",
    method: "task.transaction",
    intent: "authorized_transaction",
    targetOrigin: "https://example.test",
    idempotencyKey: "idem-wire",
    payload,
  });
  const wirePayload = JSON.parse(JSON.stringify(payload));
  assert.doesNotThrow(() => verifyAuthorityEnvelope(envelope, {
    secrets: { codex_mcp: secret },
    payload: wirePayload,
    expected: {
      runId: "run-wire",
      taskId: "task-wire",
      ownerKey: "session-wire",
      method: "task.transaction",
      intent: "authorized_transaction",
    },
    replayedNonces: new Set(),
  }));
});

test("operation ledger rejects duplicate fingerprints and converts dispatched on restart", async () => {
  const root = await mkdtemp(join(tmpdir(), "aos-companion-ledger-"));
  const statePath = join(root, "ledger.json");
  const first = new TaskOperationLedger({ statePath });
  const entry = await first.prepare({ idempotencyKey: "idem-1", fingerprint: "fp-1", binding: { tabId: 1 } });
  await first.transition(entry.idempotencyKey, "dispatched");
  const authority = { authorityId: "authority-1", nonce: "nonce-1" };
  await first.consumeAuthority(authority);
  await assert.rejects(first.consumeAuthority(authority), /already consumed/);
  const concurrent = await Promise.all([
    first.prepare({ idempotencyKey: "idem-concurrent", fingerprint: "fp-c", binding: { tabId: 3 } }),
    first.prepare({ idempotencyKey: "idem-concurrent", fingerprint: "fp-c", binding: { tabId: 3 } }),
  ]);
  assert.equal(concurrent[0].operationId, concurrent[1].operationId);
  await assert.rejects(first.prepare({ idempotencyKey: "idem-1", fingerprint: "fp-2", binding: { tabId: 2 } }), /different operation/);
  const restarted = new TaskOperationLedger({ statePath });
  await restarted.ready();
  assert.equal(restarted.get("idem-1").state, "unknown_effect");
  await assert.rejects(restarted.consumeAuthority(authority), /already consumed/);

  const transactionAuthority = createAuthorityEnvelope({
    issuer: "aos", secret: "issuer-secret", runId: "run-replay", taskId: "task-replay",
    ownerKey: "session-replay", method: "task.transaction", intent: "authorized_transaction",
    payload: { startUrl: "http://127.0.0.1:8787/", allowedOrigins: ["http://127.0.0.1:8787"], actions: [{ method: "page.waitFor", params: {} }] },
  });
  const transactionPayload = { startUrl: "http://127.0.0.1:8787/", allowedOrigins: ["http://127.0.0.1:8787"], actions: [{ method: "page.waitFor", params: {} }] };
  const authorityOptions = {
    secrets: { aos: "issuer-secret" }, payload: transactionPayload,
    expected: { runId: "run-replay", taskId: "task-replay", ownerKey: "session-replay", method: "task.transaction", intent: "authorized_transaction" },
  };
  await restarted.verifyAndConsumeAuthority(transactionAuthority, authorityOptions);
  const restartedAgain = new TaskOperationLedger({ statePath });
  await restartedAgain.ready();
  await assert.rejects(restartedAgain.verifyAndConsumeAuthority(transactionAuthority, authorityOptions), /already consumed/);
  await rm(root, { recursive: true, force: true });
});

test("operation ledger rewinds only explicit no-dispatch and verified no-effect interruptions", async () => {
  const root = await mkdtemp(join(tmpdir(), "aos-companion-ledger-restart-classifier-"));
  const statePath = join(root, "ledger.json");
  const first = new TaskOperationLedger({ statePath });
  const noDispatch = await first.prepare({ idempotencyKey: "idem-no-dispatch", fingerprint: "fp-no-dispatch", binding: { tabId: 10 } });
  await first.transition(noDispatch.idempotencyKey, "dispatched", {
    dispatchState: "not_dispatched",
    dispatchCount: 0,
    effectState: "no_dispatch",
  });
  const provenNoEffect = await first.prepare({ idempotencyKey: "idem-proven-no-effect", fingerprint: "fp-proven-no-effect", binding: { tabId: 11 } });
  await first.transition(provenNoEffect.idempotencyKey, "dispatched", {
    dispatchState: "dispatched",
    dispatchCount: 1,
    effectState: "known_no_effect",
    externalActionExecuted: false,
    mutationDispatchAttempted: false,
    brokerEvidence: true,
    noEffectProof: { valid: true, brokerEvidence: true, effectState: "known_no_effect" },
  });
  const restarted = new TaskOperationLedger({ statePath });
  await restarted.ready();
  assert.equal(restarted.get(noDispatch.idempotencyKey).state, "prepared");
  assert.equal(restarted.get(noDispatch.idempotencyKey).restartRecoveryDisposition, "fresh_retry_allowed");
  const rebound = await restarted.prepare({ idempotencyKey: noDispatch.idempotencyKey, fingerprint: "fp-no-dispatch-fresh", binding: { tabId: 12, generation: "fresh-generation" } });
  assert.equal(rebound.state, "prepared");
  assert.equal(rebound.fingerprint, "fp-no-dispatch-fresh");
  assert.equal(rebound.restartRecoveryDisposition, null);
  assert.equal(restarted.get(provenNoEffect.idempotencyKey).state, "blocked");
  assert.equal(restarted.get(provenNoEffect.idempotencyKey).effectState, "known_no_effect");
  await rm(root, { recursive: true, force: true });
});

test("owner loss detaches unresolved task tabs without changing unknown-effect evidence", async () => {
  const root = await mkdtemp(join(tmpdir(), "aos-companion-ledger-only-"));
  const statePath = join(root, "ledger.json");
  const ledger = new TaskOperationLedger({ statePath });
  const operation = await ledger.prepare({
    idempotencyKey: "idem-ledger-only",
    fingerprint: "fp-ledger-only",
    binding: { runId: "run-ledger-only", taskId: "task-ledger-only", sessionId: "session-ledger-only", method: "page.click" },
  });
  await ledger.transition(operation.idempotencyKey, "dispatched", {
    effectState: "unknown_effect",
    dispatchState: "dispatched",
    dispatchCount: 1,
  });
  await ledger.transition(operation.idempotencyKey, "unknown_effect", { reason: "transport_lost" });
  await ledger.recordTaskTab({
    profileInstanceId: "profile-ledger-only",
    generation: "generation-ledger-only",
    tabId: 42,
    taskId: "task-ledger-only",
    runId: "run-ledger-only",
    sessionId: "session-ledger-only",
    operationId: operation.operationId,
    lifecycleState: "executing",
    retentionPolicy: "retain_until_resume",
    userHelpRequired: false,
    resumeToken: "resume-ledger-only",
  });

  const detached = await ledger.detachUnknownTaskTabs({
    sessionIds: new Set(["session-ledger-only"]),
    reason: "client_transport_disconnected",
  });
  assert.equal(detached.length, 1);
  assert.equal(detached[0].retentionPolicy, "ledger_only");
  assert.equal(detached[0].resumeToken, null);
  assert.equal(detached[0].retentionReason, "unknown_effect_ledger_only");
  assert.equal(detached[0].resumeAction, "start_fresh_task_with_ledger_warning");
  assert.equal(ledger.get("idem-ledger-only").state, "unknown_effect");
  assert.equal(ledger.get("idem-ledger-only").effectState, "unknown_effect");
  assert.deepEqual(await ledger.detachUnknownTaskTabs({ sessionIds: new Set(["session-ledger-only"]) }), []);
  await rm(root, { recursive: true, force: true });
});

test("operation ledger archives unresolved records without resolving or deleting evidence", async () => {
  const root = await mkdtemp(join(tmpdir(), "aos-companion-archive-"));
  const statePath = join(root, "ledger.json");
  const ledger = new TaskOperationLedger({ statePath });
  const unknown = await ledger.prepare({
    idempotencyKey: "idem-archive-unknown",
    fingerprint: "fp-archive-unknown",
    binding: { runId: "run-archive", taskId: "task-archive", sessionId: "session-archive" },
  });
  await ledger.transition(unknown.idempotencyKey, "dispatched");
  await ledger.transition(unknown.idempotencyKey, "unknown_effect", { brokerEvidence: false, resultDigest: "kept-result" });
  const reconciled = await ledger.prepare({
    idempotencyKey: "idem-archive-reconciled",
    fingerprint: "fp-archive-reconciled",
    binding: { runId: "run-archive", taskId: "task-archive", sessionId: "session-archive" },
  });
  await ledger.transition(reconciled.idempotencyKey, "dispatched");
  await ledger.transition(reconciled.idempotencyKey, "unknown_effect");
  await ledger.transition(reconciled.idempotencyKey, "reconciled", { brokerEvidence: true, resultDigest: "broker-result" });

  const archived = await ledger.archiveOperations({
    taskId: "task-archive",
    runId: "run-archive",
    operationIds: [unknown.operationId, reconciled.idempotencyKey],
    archiveId: "archive-1",
    reason: "reviewed without changing effect state",
    archiveAuthorityId: "authority-archive-1",
  });
  assert.equal(archived.archived.length, 2);
  assert.equal(archived.alreadyArchived.length, 0);
  assert.equal(ledger.get("idem-archive-unknown").state, "unknown_effect");
  assert.equal(ledger.get("idem-archive-unknown").brokerEvidence, false);
  assert.equal(ledger.get("idem-archive-unknown").resultDigest, "kept-result");
  assert.equal(ledger.get("idem-archive-unknown").archiveId, "archive-1");
  assert.equal(ledger.get("idem-archive-reconciled").state, "reconciled");
  assert.deepEqual(ledger.getReconciliationCounts(), { pendingTotal: 2, pendingArchived: 2, pendingVisible: 0 });

  const repeated = await ledger.archiveOperations({
    taskId: "task-archive",
    runId: "run-archive",
    operationIds: [unknown.operationId, reconciled.idempotencyKey],
    archiveId: "archive-1",
    reason: "same idempotent archive",
  });
  assert.equal(repeated.archived.length, 0);
  assert.equal(repeated.alreadyArchived.length, 2);
  await assert.rejects(ledger.archiveOperations({
    taskId: "other-task",
    runId: "run-archive",
    operationIds: [unknown.operationId],
    archiveId: "archive-foreign",
    reason: "must reject foreign owner",
  }), /unresolved records/);
  await assert.rejects(ledger.archiveOperations({
    taskId: "task-archive",
    runId: "run-archive",
    operationIds: [unknown.operationId],
    archiveId: "archive-conflict",
    reason: "must reject archive id conflict",
  }), /different archive id/);

  const restarted = new TaskOperationLedger({ statePath });
  await restarted.ready();
  assert.equal(restarted.get("idem-archive-unknown").state, "unknown_effect");
  assert.equal(restarted.get("idem-archive-unknown").archiveId, "archive-1");
  assert.deepEqual(restarted.getReconciliationCounts(), { pendingTotal: 2, pendingArchived: 2, pendingVisible: 0 });
  await rm(root, { recursive: true, force: true });
});
