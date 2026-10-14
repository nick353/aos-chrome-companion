import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { CompanionBroker } from "../src/broker/broker.mjs";
import { BrokerClient } from "../src/client/broker-client.mjs";
import { connectPeer } from "../src/client/connect.mjs";
import { DEFAULT_CAPABILITIES, PROTOCOL_VERSION } from "../src/shared/constants.mjs";
import { INSTALL_BUILD_ID } from "../src/shared/build-info.mjs";
import { ensureBrokerSecret } from "../src/shared/security.mjs";
import { createAuthorityEnvelope, normalizeTaskExecutionCapsule, targetRecoveryPayload,
  TaskOperationLedger, taskTabIdentityConsistent } from "../src/shared/task-runtime.mjs";

const issuerSecret = "isolated-target-recovery-test";

async function fixture({ creationFailure = false, creationNoEffect = false, snapshotFailure = false, inventoryFailure = false, lateSettlement = false, noDispatch = false } = {}) {
  const directory = await mkdtemp(join(tmpdir(), "companion-target-recovery-"));
  const env = { ...process.env, AOS_CHROME_COMPANION_DATA_DIR: directory,
    AOS_CHROME_COMPANION_SOCKET: join(directory, "broker.sock"),
    AOS_CHROME_COMPANION_SECRET_FILE: join(directory, "secret"),
    AOS_CHROME_COMPANION_AOS_ISSUER_SECRET_FILE: join(directory, "aos-issuer") };
  const handoffDir = join(directory, "handoff");
  await mkdir(handoffDir);
  await writeFile(env.AOS_CHROME_COMPANION_AOS_ISSUER_SECRET_FILE, issuerSecret, { mode: 0o600 });
  const statePath = join(directory, "broker-state.json");
  const broker = new CompanionBroker({ socketPath: env.AOS_CHROME_COMPANION_SOCKET,
    secret: await ensureBrokerSecret(env), issuerSecrets: { aos: issuerSecret }, statePath, handoffReceiptsDir: handoffDir });
  await broker.listen();
  const extension = await connectPeer({ role: "extension-relay", autoStart: false, env });
  const hello = new Promise(resolve => {
    const remove = extension.onMessage(message => { if (message.kind === "extension.hello_ack") { remove(); resolve(); } });
  });
  extension.send({ kind: "extension.hello", protocolVersion: PROTOCOL_VERSION,
    profileInstanceId: "recovery-profile", extensionRuntimeId: "recovery-runtime",
    buildId: INSTALL_BUILD_ID, capabilities: DEFAULT_CAPABILITIES });
  await hello;
  const calls = [];
  const inventory = [{ id: 9, url: "https://example.test/form", active: false, pinned: false, windowId: 1 }];
  extension.onMessage(message => {
    if (message.kind !== "command.request") return;
    calls.push(message);
    if (message.method === "tabs.list") {
      extension.send(inventoryFailure
        ? { kind: "command.error", operationId: message.operationId, error: { code: "operation_timeout", message: "Inventory unavailable" } }
        : { kind: "command.result", operationId: message.operationId, result: inventory });
    } else if (message.method === "tabs.create") {
      if (creationNoEffect) {
        extension.send({ kind: "command.error", operationId: message.operationId,
          error: { code: "target_origin_not_allowed", message: "No tab created",
            details: { operationEffectState: "none", mutationDispatchAttempted: false, externalActionExecuted: false } } });
      } else if (creationFailure) {
        extension.send({ kind: "extension.event", event: "task.tab.created", operationId: message.operationId,
          profileInstanceId: "recovery-profile", tabId: 88 });
        extension.send({ kind: "command.error", operationId: message.operationId,
          error: { code: "navigation_commit_timeout", message: "Created but commit unconfirmed",
            details: { createdTabId: 88, mutationDispatchAttempted: true } } });
      } else {
        const tab = { id: 88, url: message.params.url, windowId: 1, active: false, pinned: false };
        inventory.push(tab);
        extension.send({ kind: "command.result", operationId: message.operationId, result: tab });
      }
    } else if (message.method === "page.snapshot") {
      extension.send(snapshotFailure
        ? { kind: "command.error", operationId: message.operationId, error: { code: "snapshot_unavailable", message: "Snapshot unavailable" } }
        : { kind: "command.result", operationId: message.operationId, result: {
          tabId: message.params.tabId, url: "https://example.test/form", pageInstanceId: "replacement-document",
          windowId: 1, title: "Replacement", text: "Form" } });
    } else {
      extension.send({ kind: "command.error", operationId: message.operationId,
        error: { code: "unexpected_test_dispatch", message: message.method } });
    }
  });
  const client = await BrokerClient.connect({ autoStart: false, env, issuer: "aos" });
  const session = await client.request("session.open", { taskId: "recovery-task" });
  const binding = { taskId: session.taskId, runId: "recovery-run", ownerKey: session.sessionId,
    sessionId: session.sessionId, generation: session.generation, profileInstanceId: session.profileInstanceId,
    tabId: 42, method: "page.type" };
  await broker.taskLedger.prepare({ idempotencyKey: "original:0", fingerprint: "original-create",
    binding: { ...binding, tabId: null, method: "tabs.create" } });
  await broker.taskLedger.transition("original:0", "dispatched", { mutationDispatchAttempted: true });
  await broker.taskLedger.transition("original:0", "applied", { brokerEvidence: true, createdTabId: 42,
    resultDigest: "old-create-receipt", dispatchState: "dispatched" });
  const failed = await broker.taskLedger.prepare({ idempotencyKey: "original:1", fingerprint: "failed-business-action", binding });
  if (noDispatch) {
    await broker.taskLedger.transition("original:1", "blocked", { effectState: "no_dispatch",
      dispatchState: "not_dispatched", mutationDispatchAttempted: false, externalActionExecuted: false });
  } else {
    await broker.taskLedger.transition("original:1", "dispatched", { mutationDispatchAttempted: true, mutationDispatchProvenance: "transport_inference" });
    if (lateSettlement) {
      await broker.taskLedger.transition("original:1", "unknown_effect");
      await broker.taskLedger.reconcile("original:1", binding, { effectState: "known_no_effect",
        mutationDispatchAttempted: false, externalActionExecuted: false }, { brokerEvidence: true, noEffectOperationId: failed.operationId });
    } else {
      await broker.taskLedger.transition("original:1", "blocked", { effectState: "known_no_effect",
        mutationDispatchAttempted: false, externalActionExecuted: false,
        mutationDispatchProvenance: "authenticated_no_effect", brokerEvidence: true });
    }
  }
  const source = normalizeTaskExecutionCapsule({ capsuleId: "failed-source", taskId: session.taskId,
    runId: binding.runId, state: lateSettlement ? "reconciliation_required" : "failed", startUrl: "https://example.test/form", allowedOrigins: ["https://example.test"],
    target: { ...binding, intendedUrl: "https://example.test/form", targetKey: "stable-form" }, tabId: 42,
    effect: { idempotencyKey: "original", failedOperationId: failed.operationId, failedOperationKey: "original:1",
      effectState: lateSettlement ? "unknown_effect" : noDispatch ? "no_dispatch" : "known_no_effect",
      externalActionExecuted: lateSettlement ? null : false,
      actionProgress: { total_actions: 2, failed_action_index: 0,
        failed_action_effect_state: lateSettlement ? "unknown_effect" : noDispatch ? "no_dispatch" : "known_no_effect",
        applied_action_indices: [], verified_action_indices: [], unattempted_action_indices: [1],
        remaining_action_indices: lateSettlement ? [1] : [0, 1], uncertain_action_indices: lateSettlement ? [0] : [], replay_allowed: false } } });
  await broker.taskLedger.putTaskCapsule(source);
  await broker.taskLedger.recordTaskTab({ profileInstanceId: session.profileInstanceId, generation: session.generation,
    sessionId: session.sessionId, taskId: session.taskId, runId: binding.runId, tabId: 42,
    capsuleId: source.capsuleId, targetKey: source.target.targetKey, lifecycleState: "failed", retentionPolicy: "retain" });
  const request = { sessionId: session.sessionId, taskId: session.taskId, runId: binding.runId,
    idempotencyKey: "replacement", sourceCapsuleId: source.capsuleId, originalOperationId: failed.operationId,
    originalOperationKey: "original:1", oldTabId: 42, targetKey: source.target.targetKey, intendedUrl: "https://example.test/form" };
  const sign = params => createAuthorityEnvelope({ issuer: "aos", secret: issuerSecret, runId: params.runId,
    taskId: params.taskId, ownerKey: params.sessionId, method: "task.recover_target", intent: "recover_missing_target",
    idempotencyKey: params.idempotencyKey, targetOrigin: new URL(params.intendedUrl).origin, payload: targetRecoveryPayload(params) });
  let stopped = false;
  const stop = async () => {
    if (stopped) return;
    stopped = true;
    await broker.close();
    client.close(); extension.close();
  };
  return { broker, client, session, calls, inventory, request, source, statePath, directory, handoffDir, sign, stop,
    async close() { await stop(); await rm(directory, { recursive: true, force: true }); } };
}

for (const mode of ["known no effect", "no dispatch", "late settled no effect"]) {
  test(`signed exact missing target recovery accepts ${mode} and preserves history`, async () => {
    const f = await fixture({ noDispatch: mode === "no dispatch", lateSettlement: mode === "late settled no effect" });
    try {
      const original = structuredClone(f.broker.taskLedger.getTaskCapsule(f.source.capsuleId));
      const oldOperation = structuredClone(f.broker.taskLedger.get("original:1"));
      const result = await f.client.requestRecoverTarget(f.request);
      assert.equal(result.result, "verified");
      assert.equal(result.tab_id, 88);
      assert.equal(result.target.pageInstanceId, "replacement-document");
      assert.equal(result.target.taskId, f.request.taskId);
      assert.equal(result.target_readback_verified, true);
      assert.equal(result.actions_replayed, 0);
      assert.equal(result.original_action_dispatched, false);
      assert.notEqual(result.capsule_id, f.source.capsuleId);
      assert.deepEqual(f.calls.map(call => call.method), ["tabs.list", "tabs.create", "page.snapshot"]);
      assert.deepEqual(f.broker.taskLedger.getTaskCapsule(f.source.capsuleId), original);
      assert.deepEqual(f.broker.taskLedger.get("original:1"), oldOperation);
      const newCapsule = f.broker.taskLedger.getTaskCapsule(result.capsule_id);
      assert.equal(newCapsule.execution.targetRecovery.sourceCapsuleId, f.source.capsuleId);
      assert.equal(newCapsule.execution.targetRecovery.originalOperationId, f.request.originalOperationId);
      assert.equal(taskTabIdentityConsistent(issuerSecret, f.broker.taskLedger.getTaskTab(f.session.profileInstanceId, 88)), true);
      assert.equal(f.broker.leases.size, 0);
      await assert.rejects(f.client.requestRecoverTarget({ ...f.request, idempotencyKey: "different-key" }),
        error => ["target_recovery_prior_effects", "target_recovery_already_reserved"].includes(error.code));
      assert.equal(f.calls.filter(call => call.method === "tabs.create").length, 1);
      const resumed = await f.client.requestPrepareResume({ sessionId: f.session.sessionId,
        taskId: f.request.taskId, runId: f.request.runId, capsuleId: result.capsule_id });
      assert.equal(resumed.resume_ready, true);
      assert.equal(resumed.target.tabId, 88);
      await f.stop();
      const reloaded = new TaskOperationLedger({ statePath: f.statePath, secret: issuerSecret });
      try {
        await reloaded.ready();
        await assert.rejects(reloaded.reserveTargetRecovery({ sourceCapsuleId: f.source.capsuleId,
          originalOperationId: f.request.originalOperationId, recoveryIdempotencyKey: "after-restart",
          capsuleId: "another-capsule", binding: {} }), { code: "target_recovery_already_reserved" });
      } finally { reloaded.close(); }
    } finally { await f.close(); }
  });
}

const denied = [
  ["wrong owner", f => { f.request.taskId = "foreign-task"; }],
  ["wrong session", f => { f.request.sessionId = "foreign-session"; }],
  ["wrong run", f => { f.request.runId = "foreign-run"; }],
  ["capsule substitution", f => { f.request.sourceCapsuleId = "other-capsule"; }],
  ["wrong original operation", f => { f.request.originalOperationId = "other-operation"; }],
  ["wrong original key", f => { f.request.originalOperationKey = "other:1"; }],
  ["wrong exact tab", f => { f.request.oldTabId = 9; }],
  ["wrong stable target", f => { f.request.targetKey = "other-form"; }],
  ["new URL on same origin", f => { f.request.intendedUrl = "https://example.test/other"; }],
  ["old idempotency", f => { f.request.idempotencyKey = "original"; }],
  ["known partial", f => { f.source.effect.actionProgress.applied_action_indices = [0]; }],
  ["unknown source", f => { f.source.effect.effectState = "unknown_effect"; }],
  ["user help", f => { f.source.retention.userHelpRequired = true; }],
  ["pending event", f => { f.source.effect.awaitedEvent = { kind: "dialog" }; }],
  ["legacy missing progress", f => { delete f.source.effect.actionProgress; }],
  ["legacy missing dispatch", f => { delete f.broker.taskLedger.get("original:1").dispatchCount; }],
  ["unproved no effect", f => { f.broker.taskLedger.get("original:1").brokerEvidence = false; }],
  ["contradictory effect alias", f => { f.broker.taskLedger.get("original:1").operationEffectState = "unknown_effect"; }],
  ["foreign setup binding", f => { f.broker.taskLedger.get("original:0").binding.ownerKey = "foreign-session"; }],
  ["known earlier navigation", f => { f.broker.taskLedger.get("original:0").binding.method = "tabs.navigate"; }],
  ["created different old tab", f => { f.broker.taskLedger.get("original:0").createdTabId = 41; }],
  ["missing history", f => { f.broker.taskLedger.operations.delete("original:0"); }],
  ["existing exact target", f => { f.inventory.push({ id: 42, url: "https://example.test/form" }); }],
  ["foreign old record", async f => { await f.broker.taskLedger.recordTaskTab({ ...f.broker.taskLedger.getTaskTab(f.session.profileInstanceId, 42), taskId: "foreign-task" }); }],
  ["handoff", async f => { await writeFile(join(f.handoffDir, `${f.request.taskId}.json`), JSON.stringify({
    schema: "codex_hookless_handoff_receipt.v1", status: "reconciliation_required", source_status: "reconciliation_only",
    implementation_allowed: false, source_thread_id: f.request.taskId, destination_thread_id: "destination-task",
    packet_content_sha256: "a".repeat(64), source_task_archived: false, source_task_visible: true }), { mode: 0o600 }); }],
];

for (const [name, change] of denied) {
  test(`target recovery denies ${name} before creation`, async () => {
    const f = await fixture();
    try {
      await change(f);
      await f.broker.taskLedger.putTaskCapsule(f.source);
      await assert.rejects(f.client.requestRecoverTarget(f.request), error =>
        error.code.startsWith("target_recovery_") || ["session_not_owned", "source_handoff_implementation_forbidden"].includes(error.code));
      assert.equal(f.calls.filter(call => call.method === "tabs.create").length, 0);
      assert.equal(f.broker.taskLedger.listTaskCapsules().length, 1);
    } finally { await f.close(); }
  });
}

test("recovery authority signs the full exact payload and rejects caller proof assertions", async () => {
  const f = await fixture();
  try {
    for (const key of Object.keys(targetRecoveryPayload(f.request))) {
      const signed = { ...f.request };
      const changed = { ...signed, [key]: key === "oldTabId" ? 41 : `${signed[key]}-tampered` };
      await assert.rejects(f.client.request("task.recover_target", { ...changed, authority: f.sign(signed) }));
    }
    await assert.rejects(f.client.request("task.recover_target", { ...f.request, confirmNoEffect: true,
      authority: f.sign(f.request) }), { code: "target_recovery_payload_invalid" });
    const foreignOrigin = createAuthorityEnvelope({ issuer: "aos", secret: issuerSecret,
      runId: f.request.runId, taskId: f.request.taskId, ownerKey: f.request.sessionId,
      method: "task.recover_target", intent: "recover_missing_target", idempotencyKey: f.request.idempotencyKey,
      targetOrigin: "https://foreign.test", payload: targetRecoveryPayload(f.request) });
    await assert.rejects(f.client.request("task.recover_target", { ...f.request, authority: foreignOrigin }),
      { code: "authority_binding_mismatch" });
    assert.equal(f.calls.filter(call => call.method === "tabs.create").length, 0);
  } finally { await f.close(); }
});

test("failed authoritative inventory is not missing-target evidence", async () => {
  const f = await fixture({ inventoryFailure: true });
  try {
    await assert.rejects(f.client.requestRecoverTarget(f.request), { code: "operation_timeout" });
    assert.equal(f.calls.filter(call => call.method === "tabs.create").length, 0);
    assert.equal(f.broker.taskLedger.listTaskCapsules().length, 1);
  } finally { await f.close(); }
});

test("a dispatched creation with authenticated no effect retains its honest classification", async () => {
  const f = await fixture({ creationNoEffect: true });
  try {
    const result = await f.client.requestRecoverTarget(f.request);
    assert.equal(result.result, "blocked");
    assert.equal(result.effect_state, "known_no_effect");
    assert.equal(f.broker.taskLedger.getTaskCapsule(result.capsule_id).effect.effectState, "known_no_effect");
    assert.equal(f.broker.taskLedger.get(`${f.request.idempotencyKey}:0`).dispatchCount, 1);
    assert.equal(result.original_action_dispatched, false);
  } finally { await f.close(); }
});

for (const [name, mode, expected] of [
  ["possible creation effect", { creationFailure: true }, "unknown_effect"],
  ["created target without snapshot", { snapshotFailure: true }, "known_effect"],
]) {
  test(`recovery retains ${name} and never creates again`, async () => {
    const f = await fixture(mode);
    try {
      const original = structuredClone(f.broker.taskLedger.getTaskCapsule(f.source.capsuleId));
      const result = await f.client.requestRecoverTarget(f.request);
      assert.equal(result.effect_state, expected);
      assert.equal(result.result, expected === "unknown_effect" ? "unknown_effect" : "blocked");
      assert.equal(result.continuation_allowed, false);
      assert.equal(result.replay_allowed, false);
      assert.equal(result.original_action_dispatched, false);
      assert.equal(f.broker.taskLedger.getTaskCapsule(result.capsule_id).resources.tabId, 88);
      assert.deepEqual(f.broker.taskLedger.getTaskCapsule(f.source.capsuleId), original);
      for (const idempotencyKey of [f.request.idempotencyKey, "new-recovery-key"]) {
        await assert.rejects(f.client.requestRecoverTarget({ ...f.request, idempotencyKey }));
      }
      assert.equal(f.calls.filter(call => call.method === "tabs.create").length, 1);
      assert.equal(f.calls.filter(call => !["tabs.list", "tabs.create", "page.snapshot"].includes(call.method)).length, 0);
      await f.stop();
      const reloaded = new TaskOperationLedger({ statePath: f.statePath, secret: issuerSecret });
      try {
        await reloaded.ready();
        await assert.rejects(reloaded.reserveTargetRecovery({ sourceCapsuleId: f.source.capsuleId,
          originalOperationId: f.request.originalOperationId, recoveryIdempotencyKey: "after-uncertain-restart",
          capsuleId: "another-capsule", binding: {} }), { code: "target_recovery_already_reserved" });
      } finally { reloaded.close(); }
    } finally { await f.close(); }
  });
}
