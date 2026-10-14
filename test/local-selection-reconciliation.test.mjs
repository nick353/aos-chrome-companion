import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { CompanionBroker } from "../src/broker/broker.mjs";
import { BrokerClient } from "../src/client/broker-client.mjs";
import { connectPeer } from "../src/client/connect.mjs";
import { DEFAULT_CAPABILITIES, PROTOCOL_VERSION } from "../src/shared/constants.mjs";
import { INSTALL_BUILD_ID } from "../src/shared/build-info.mjs";
import { ensureBrokerSecret } from "../src/shared/security.mjs";
import { createAuthorityEnvelope, localSelectionReconciliationPayload, normalizeTaskExecutionCapsule,
  payloadDigest, TaskOperationLedger, VIEWPORT_CLEANUP_AMENDMENT, viewportCleanupCandidate } from "../src/shared/task-runtime.mjs";

const issuerSecret = "isolated-selection-issuer";
async function fixture() {
  const directory = await mkdtemp(join(tmpdir(), "aos-local-selection-"));
  const statePath = join(directory, "ledger.json");
  const env = { ...process.env, AOS_CHROME_COMPANION_DATA_DIR: directory,
    AOS_CHROME_COMPANION_SOCKET: join(directory, "broker.sock"),
    AOS_CHROME_COMPANION_SECRET_FILE: join(directory, "secret"),
    AOS_CHROME_COMPANION_CODEX_MCP_ISSUER_SECRET_FILE: join(directory, "issuer") };
  await writeFile(env.AOS_CHROME_COMPANION_CODEX_MCP_ISSUER_SECRET_FILE, issuerSecret);
  const broker = new CompanionBroker({ socketPath: env.AOS_CHROME_COMPANION_SOCKET,
    secret: await ensureBrokerSecret(env), issuerSecrets: { codex_mcp: issuerSecret }, statePath });
  await broker.listen();
  const extension = await connectPeer({ role: "extension-relay", autoStart: false, env });
  const hello = new Promise(resolve => { const remove = extension.onMessage(message => {
    if (message.kind === "extension.hello_ack") { remove(); resolve(); }
  }); });
  extension.send({ kind: "extension.hello", protocolVersion: PROTOCOL_VERSION, profileInstanceId: "selection-profile",
    extensionRuntimeId: "selection-runtime", buildId: INSTALL_BUILD_ID, capabilities: DEFAULT_CAPABILITIES });
  await hello;
  const url = "https://example.test/form", pageInstanceId = "original-document", calls = [];
  const read = { count: 1, totalCount: 1, totalCountExact: true, scanLimitReached: false, truncated: false,
    url, pageInstanceId, matches: [{ tag: "select", role: "combobox", visible: true, multiple: false, selectedText: "年収" }] };
  const optionRead = { count: 2, totalCount: 2, totalCountExact: true, scanLimitReached: false, truncated: false,
    url, pageInstanceId, matches: [
      { tag: "option", text: "年収", selected: true, attributes: { "aria-label": null, "aria-labelledby": null, title: null, label: null, value: "annual", "aria-selected": null, "aria-checked": null, "aria-pressed": null } },
      { tag: "option", text: "月収", selected: false, attributes: { "aria-label": null, "aria-labelledby": null, title: null, label: null, value: "monthly", "aria-selected": null, "aria-checked": null, "aria-pressed": null } },
    ] };
  let onRead;
  extension.onMessage(message => {
    if (message.kind !== "command.request") return;
    calls.push(message);
    if (message.method === "tabs.list") {
      extension.send({ kind: "command.result", operationId: message.operationId,
        result: [{ id: 42, windowId: 9, url, active: false, pinned: false }] });
    } else if (message.method === "page.query") {
      onRead?.();
      extension.send({ kind: "command.result", operationId: message.operationId,
        result: message.params.locator.css === "option" ? optionRead : read });
    } else {
      extension.send({ kind: "command.error", operationId: message.operationId,
        error: { code: "unexpected_test_mutation", message: message.method } });
    }
  });
  const client = await BrokerClient.connect({ autoStart: false, env, issuer: "codex_mcp" });
  const session = await client.request("session.open", { taskId: "selection-task" });
  const lease = await client.request("lease.acquire", { sessionId: session.sessionId, tabId: 42 });
  const target = { taskId: session.taskId, sessionId: session.sessionId, leaseId: lease.leaseId,
    generation: session.generation, profileInstanceId: session.profileInstanceId, tabId: 42,
    pageInstanceId, windowId: 9, frameId: 0, origin: "https://example.test", intendedUrl: url,
    allowedOrigins: ["https://example.test"] };
  const binding = { taskId: session.taskId, runId: "original-run", ownerKey: session.sessionId,
    sessionId: session.sessionId, generation: session.generation, profileInstanceId: session.profileInstanceId,
    tabId: 42, method: "page.selectOption", targetIdentity: target };
  const originalPayload = { locator: { role: "combobox", question: "現給与" }, option: { label: "年収" },
    tabId: 42, pageInstanceId, windowId: 9, frameId: 0, allowedOrigins: ["https://example.test"], targetOrigin: "https://example.test" };
  const entry = await broker.taskLedger.prepare({ idempotencyKey: "original:1", binding,
    fingerprint: payloadDigest(broker.ledgerSecret, { binding, payload: originalPayload }) });
  await broker.taskLedger.transition(entry.idempotencyKey, "dispatched", { effectClass: "local_ui",
    reconciliationRequired: false, mutationDispatchAttempted: true, externalActionExecuted: false, dispatchState: "dispatched" });
  await broker.taskLedger.transition(entry.idempotencyKey, "unknown_effect", { effectState: "unknown_effect" });
  const capsule = normalizeTaskExecutionCapsule({ capsuleId: "original-capsule", taskId: session.taskId, runId: binding.runId,
    state: "failed", target, resources: { tabId: 42 }, effect: { idempotencyKey: "original", effectClass: "local_ui",
      effectState: "unknown_effect", externalActionExecuted: false, failedOperationId: entry.operationId,
      failedOperationKey: entry.idempotencyKey, actionProgress: { remaining_action_indices: [1], uncertain_action_indices: [0] } } });
  await broker.taskLedger.putTaskCapsule(capsule);
  const taskTab = await broker.taskLedger.recordTaskTab({ ...target, runId: binding.runId, windowId: 9,
    targetIdentity: target, capsuleId: capsule.capsuleId, lifecycleState: "failed" });
  broker.taskTabs.set(`${session.profileInstanceId}:42`, taskTab);
  const args = { sessionId: session.sessionId, leaseId: lease.leaseId, tabId: 42, runId: binding.runId,
    taskId: session.taskId, idempotencyKey: "original", capsuleId: capsule.capsuleId,
    originalOperationId: entry.operationId, originalOperationKey: entry.idempotencyKey, originalPayload, url, pageInstanceId };
  const sign = (payload = args) => createAuthorityEnvelope({ issuer: "codex_mcp", secret: issuerSecret,
    runId: payload.runId, taskId: payload.taskId, ownerKey: payload.sessionId,
    method: "task.reconciliation.resolve_local_selection", intent: "resolve_local_selection_from_exact_readback",
    targetOrigin: new URL(payload.url).origin, idempotencyKey: "selection-proof", payload: localSelectionReconciliationPayload(payload) });
  const status = () => client.requestTaskStatus({ sessionId: session.sessionId, taskId: session.taskId,
    runId: binding.runId, capsuleId: capsule.capsuleId, idempotencyKey: "original" });
  const resume = () => client.requestPrepareResume({ sessionId: session.sessionId, taskId: session.taskId,
    runId: binding.runId, capsuleId: capsule.capsuleId });
  return { broker, client, session, lease, binding, target, entry, capsule, args, read, optionRead, calls, statePath, sign, status, resume,
    setOnRead(fn) { onRead = fn; },
    reseal() { entry.fingerprint = payloadDigest(broker.ledgerSecret, { binding: entry.binding, payload: originalPayload }); },
    async stop() { client.close(); extension.close(); await broker.close(); },
    async close() { await this.stop(); await rm(directory, { recursive: true, force: true }); } };
}

test("signed exact selection resolution appends proof, agrees with resume/status and never replays", async () => {
  const f = await fixture();
  try {
    const original = structuredClone(f.entry), capsule = structuredClone(f.broker.taskLedger.getTaskCapsule(f.capsule.capsuleId));
    assert.equal((await f.status()).continuation_allowed, false);
    assert.equal((await f.resume()).resume_ready, false);
    f.calls.length = 0;
    const result = await f.client.requestResolveLocalSelection(f.args);
    assert.equal(result.resolved, true); assert.equal(result.providerCompletion, false);
    assert.equal(result.actionsReplayed, 0); assert.equal(result.replayAllowed, false);
    assert.deepEqual(f.calls.map(call => call.method), ["page.query", "page.query"]);
    assert.deepEqual(f.calls[0].params.locator.within, f.args.originalPayload.locator);
    assert.equal(f.calls[0].params.includeHidden, true);
    assert.deepEqual(f.calls[1].params.locator, f.args.originalPayload.locator);
    const { localSelectionResolutions, ...receipt } = f.broker.taskLedger.get(f.entry.idempotencyKey);
    assert.deepEqual(receipt, original); assert.equal(localSelectionResolutions.length, 1);
    assert.deepEqual(f.broker.taskLedger.getTaskCapsule(f.capsule.capsuleId), capsule);
    const { signature, ...signed } = localSelectionResolutions[0];
    assert.equal(signature, payloadDigest(f.broker.ledgerSecret, signed));
    const status = await f.status(), resume = await f.resume();
    assert.equal(status.continuation_allowed, true); assert.equal(resume.resume_ready, true);
    assert.equal(status.reconciliation_required, false); assert.equal(resume.unresolved_operation_count, 0);
    assert.equal(status.effect_state, "known_effect"); assert.equal(status.local_selection_settlement.providerCompletion, false);
    assert.equal(status.state, "failed"); assert.equal(resume.capsule_state, "failed");
    assert.deepEqual(status.effective_settlement, resume.effective_settlement);
    const again = await f.client.requestResolveLocalSelection(f.args);
    assert.equal(again.resolutionId, result.resolutionId);
    assert.equal(f.broker.taskLedger.get(f.entry.idempotencyKey).localSelectionResolutions.length, 1);
    assert.equal(f.calls.filter(call => call.method === "page.selectOption").length, 0);
    const replay = await f.broker.taskLedger.prepare({ idempotencyKey: f.entry.idempotencyKey,
      fingerprint: f.entry.fingerprint, binding: f.entry.binding });
    assert.equal(replay.state, "unknown_effect");
    await assert.rejects(f.broker.taskLedger.prepare({ idempotencyKey: f.entry.idempotencyKey,
      fingerprint: "changed", binding: f.entry.binding }), { code: "idempotency_fingerprint_conflict" });
  } finally { await f.close(); }
});

const denied = [
  ["changed original label", f => { f.args.originalPayload.option.label = "月収"; }],
  ["changed original control", f => { f.args.originalPayload.locator.question = "希望給与"; }],
  ["wrong operation", f => { f.args.originalOperationId = "other-operation"; }],
  ["wrong capsule", f => { f.args.capsuleId = "other-capsule"; }],
  ["wrong run", f => { f.args.runId = "other-run"; }],
  ["wrong task", f => { f.args.taskId = "other-task"; }],
  ["wrong lease", f => { f.args.leaseId = "other-lease"; }],
  ["wrong current owner", f => { f.args.sessionId = "other-session"; }],
  ["wrong document", f => { f.args.pageInstanceId = "other-document"; }],
  ["wrong original frame", f => { f.args.originalPayload.frameId = 1; f.reseal(); }],
  ["wrong tab", f => { f.args.tabId = 43; }],
  ["wrong URL", f => { f.args.url = "https://example.test/another"; }],
  ["missing original payload", f => { delete f.args.originalPayload; }],
  ["unsigned fingerprint", f => { f.entry.fingerprint = "invented"; }],
  ["nonselect original", f => { f.entry.binding.method = "page.type"; f.reseal(); }],
  ["external commit", f => { f.entry.effectClass = "external_commit"; }],
  ["external executed", f => { f.entry.externalActionExecuted = true; }],
  ["unproven external false", f => { f.entry.externalActionExecuted = null; }],
  ["upload original", f => { f.entry.binding.method = "page.uploadFiles"; f.reseal(); }],
  ["submit original", f => { f.entry.binding.method = "page.submit"; f.reseal(); }],
  ["wrong dispatch count", f => { f.entry.dispatchCount = 2; }],
  ["value option unsupported", f => { f.args.originalPayload.option = { value: "annual" }; f.reseal(); }],
  ["index option unsupported", f => { f.args.originalPayload.option = { index: 1 }; f.reseal(); }],
  ["array option unsupported", f => { f.args.originalPayload.option = [{ label: "年収" }]; f.reseal(); }],
  ["inexact selection", f => { f.args.originalPayload.exact = false; f.reseal(); }],
  ["truncated label unsupported", f => { f.args.originalPayload.option = { label: "a".repeat(300) }; f.reseal(); }],
  ["changed readback label", f => { f.read.matches[0].selectedText = "月収"; }],
  ["changed readback document", f => { f.read.pageInstanceId = "other-document"; }],
  ["changed readback URL", f => { f.read.url = "https://example.test/another"; }],
  ["custom combobox", f => { f.read.matches[0].tag = "div"; }],
  ["multiple select", f => { f.read.matches[0].multiple = true; }],
  ["hidden control", f => { f.read.matches[0].visible = false; }],
  ["ambiguous control", f => { f.read.totalCount = 2; }],
  ["truncated readback", f => { f.read.truncated = true; }],
  ["inexact count", f => { f.read.totalCountExact = false; }],
  ["duplicate option labels with different values", f => { f.optionRead.matches[1].text = "年収"; }],
  ["different selected option", f => { f.optionRead.matches[0].selected = false; f.optionRead.matches[1].selected = true; }],
  ["truncated options", f => { f.optionRead.truncated = true; }],
  ["options from different document", f => { f.optionRead.pageInstanceId = "other-document"; }],
  ["incomplete option attributes", f => { delete f.optionRead.matches[0].attributes; }],
  ["ARIA selected alias", f => { f.optionRead.matches[0].attributes["aria-selected"] = "true"; }],
  ["ARIA checked alias", f => { f.optionRead.matches[0].attributes["aria-checked"] = "true"; }],
  ["ARIA pressed alias", f => { f.optionRead.matches[0].attributes["aria-pressed"] = "true"; }],
  ["lost lease during read", f => { f.setOnRead(() => f.broker.leases.delete(f.lease.leaseId)); }],
];
for (const [name, change] of denied) {
  test(`local selection rejects ${name} without selection dispatch or resolution`, async () => {
    const f = await fixture();
    try {
      await change(f);
      await assert.rejects(f.client.requestResolveLocalSelection(f.args));
      assert.equal(f.entry.localSelectionResolutions, undefined);
      assert.equal(f.calls.some(call => call.method === "page.selectOption"), false);
      assert.equal(f.entry.state, "unknown_effect");
    } finally { await f.close(); }
  });
}

test("authority signature and every exact payload field reject tampering before query", async () => {
  const f = await fixture();
  try {
    const authority = f.sign();
    for (const field of Object.keys(localSelectionReconciliationPayload(f.args))) {
      const changed = { ...f.args, [field]: field === "originalPayload" ? { ...f.args.originalPayload, extra: true }
        : field === "tabId" ? 43 : `${f.args[field]}-changed` };
      await assert.rejects(f.client.request("task.reconciliation.resolve_local_selection", { ...changed, authority }));
    }
    await assert.rejects(f.client.request("task.reconciliation.resolve_local_selection", {
      ...f.args, authority: { ...authority, signature: "invalid" } }));
    await assert.rejects(f.client.request("task.reconciliation.resolve_local_selection", {
      ...f.args, confirmNoEffect: true, authority: f.sign() }), { code: "local_selection_payload_invalid" });
    assert.equal(f.calls.some(call => call.method === "page.query"), false);
    assert.equal(f.entry.localSelectionResolutions, undefined);
  } finally { await f.close(); }
});

for (const [method, profileInstanceId] of [["page.click", "selection-profile"], ["page.type", "selection-profile"], ["page.type", "other-profile"]]) {
  test(`resolved selection leaves unrelated ${method} on ${profileInstanceId} unknown blocked in both gates`, async () => {
    const f = await fixture();
    try {
      await f.client.requestResolveLocalSelection(f.args);
      await f.broker.taskLedger.prepare({ idempotencyKey: "unrelated:1", fingerprint: "unrelated",
        binding: { ...f.binding, method, tabId: 77, profileInstanceId } });
      await f.broker.taskLedger.transition("unrelated:1", "dispatched", { mutationDispatchAttempted: true });
      await f.broker.taskLedger.transition("unrelated:1", "unknown_effect", { effectState: "unknown_effect" });
      const status = await f.status(), resume = await f.resume();
      assert.equal(status.continuation_allowed, false); assert.equal(status.reconciliation_required, true);
      assert.equal(status.remaining_action_dispatch_allowed, false);
      assert.equal(resume.resume_ready, false); assert.equal(resume.exact_blocker.code, "reconciliation_required");
      assert.equal(status.unresolved_operation_count, 1); assert.equal(resume.unresolved_operation_count, 1);
      assert.equal(f.broker.taskLedger.get("unrelated:1").state, "unknown_effect");
    } finally { await f.close(); }
  });
}

test("signed selection proof survives checkpoint/journal and tampering never opens gates", async () => {
  const f = await fixture();
  try {
    await f.client.requestResolveLocalSelection(f.args);
    const ledgerSecret = f.broker.ledgerSecret;
    await f.stop();
    assert.match(await readFile(`${f.statePath}.journal`, "utf8"), /localSelectionResolutions/u);
    const restored = new TaskOperationLedger({ statePath: f.statePath, secret: ledgerSecret });
    try {
      await restored.ready();
      const capsule = restored.getTaskCapsule(f.capsule.capsuleId), entry = restored.get(f.entry.idempotencyKey);
      assert.equal(entry.state, "unknown_effect"); assert.equal(entry.dispatchCount, 1);
      assert.equal(restored.localSelectionSettlement(capsule).observedScope, "local_selection_only");
      entry.localSelectionResolutions[0].selectedLabel = "月収";
      assert.equal(restored.localSelectionSettlement(capsule), null);
      assert.equal(restored.localSelectionResolution(entry), null);
      await assert.rejects(restored.appendLocalSelectionResolution({ originalOperationKey: entry.idempotencyKey,
        originalPayload: f.args.originalPayload, capsuleId: capsule.capsuleId,
        resolution: entry.localSelectionResolutions[0] }), { code: "reconciliation_evidence_required" });
    } finally { restored.close(); }
  } finally { await f.close(); }
});

test("a tampered resolution signature keeps status and resume blocked", async () => {
  const f = await fixture();
  try {
    await f.client.requestResolveLocalSelection(f.args);
    f.entry.localSelectionResolutions[0].signature = "invalid";
    assert.equal((await f.status()).continuation_allowed, false);
    assert.equal((await f.resume()).resume_ready, false);
    assert.equal(f.entry.state, "unknown_effect");
  } finally { await f.close(); }
});

test("MCP exposes the owner/session/lease guarded label-only resolver", async () => {
  const source = await readFile(new URL("../src/mcp/server.mjs", import.meta.url), "utf8");
  const block = source.slice(source.indexOf('server.registerTool("companion_resolve_local_selection"'),
    source.indexOf('server.registerTool("companion_inspect_reconciliation"'));
  assert.match(block, /assertSessionAndLease\(args, extra\)/u);
  assert.match(block, /requestResolveLocalSelection\(/u);
  assert.match(block, /native single-select/u);
});

// Uses isolated authenticated Extension relay and seeded historical ACK. No
// live browser, provider or original installed ledger is touched by these tests.
// Root can supply its non-sensitive original-anchor diagnostic to seed the
// actual historical fields. The portable fixture keeps the observed NULL/FALSE.
const viewportOriginalAnchor = process.env.AOS_VIEWPORT_ORIGINAL_ANCHOR_FIXTURE
  ? JSON.parse(await readFile(process.env.AOS_VIEWPORT_ORIGINAL_ANCHOR_FIXTURE, "utf8")) : null;
async function viewportMaintenanceFixture(options = {}) {
  const e = VIEWPORT_CLEANUP_AMENDMENT;
  if (viewportOriginalAnchor) {
    assert.equal(viewportOriginalAnchor.capsule.effect.externalActionExecuted, null);
    assert.equal(viewportOriginalAnchor.operation.externalActionExecuted, false);
    assert.equal(viewportOriginalAnchor.operation.resultDigest, e.resultDigest);
    assert.equal(viewportOriginalAnchor.operation.operationId, e.operationId);
  }
  const directory = await mkdtemp(join(tmpdir(), "aos-viewport-maintenance-"));
  const env = { ...process.env, AOS_CHROME_COMPANION_DATA_DIR: directory,
    AOS_CHROME_COMPANION_SOCKET: join(directory, "broker.sock"), AOS_CHROME_COMPANION_SECRET_FILE: join(directory, "secret") };
  const broker = new CompanionBroker({ socketPath: env.AOS_CHROME_COMPANION_SOCKET,
    secret: await ensureBrokerSecret(env), statePath: join(directory, "ledger.json") });
  await broker.listen();
  const extension = await connectPeer({ role: "extension-relay", autoStart: false, env });
  const ready = new Promise(resolve => { const remove = extension.onMessage(message => {
    if (message.kind === "extension.hello_ack") { remove(); resolve(); }
  }); });
  extension.send({ kind: "extension.hello", protocolVersion: PROTOCOL_VERSION, profileInstanceId: e.profileInstanceId,
    extensionRuntimeId: "viewport-test-runtime", buildId: INSTALL_BUILD_ID, capabilities: DEFAULT_CAPABILITIES });
  await ready;
  const calls = [];
  const tab = { id: e.tabId, windowId: e.windowId, url: e.url, active: false, pinned: false };
  let inventoryCalls = 0;
  extension.onMessage(message => {
    if (message.kind !== "command.request") return;
    calls.push(message);
    let result;
    if (message.method === "tabs.list") {
      inventoryCalls++;
      if (options.failedInventory && inventoryCalls > 1) {
        extension.send({ kind: "command.error", operationId: message.operationId, error: { code: "tabs_query_timeout", message: "inventory failed" } }); return;
      }
      result = options.absent ? [] : [tab];
      if (options.capped && inventoryCalls > 1) result = Array.from({ length: 200 }, (_, i) => ({ id: i+1, windowId: 9 }));
      if (options.malformed && inventoryCalls > 1) result = [{ id: "unsigned-id", windowId: 9 }];
      if (options.filtered && inventoryCalls > 1) result = { tabs: [], filtered: true };
      if (options.presentLookup && inventoryCalls > 1) result = [tab];
    } else if (message.method === "tabs.get") {
      extension.send({ kind: "command.error", operationId: message.operationId,
        error: { code: options.lookupError ?? "extension_operation_failed", message: options.lookupMessage ?? `No tab with id: ${e.tabId}.` } }); return;
    } else if (message.method === "visual.inspectPoint") {
      result = { supported: true, url: e.url, pageInstanceId: options.wrongDocument ? "other" : e.pageInstanceId,
        frameId: e.frameId, point: message.params.point, scroll: { x: 0, y: 0 }, surfaceKind: "dom",
        viewport: options.requested ? { width: 1280, height: 900, devicePixelRatio: 1, scale: 1 }
          : { width: 713, height: 636, devicePixelRatio: 2, scale: 1 } };
    } else if (message.method === "page.screenshot") {
      result = { kind: "screenshot", dataBase64: Buffer.from("fixture-capture").toString("base64"), tabId: e.tabId,
        windowId: e.windowId, url: e.url, capturedAt: options.missingCaptureTime ? undefined : options.stale ? "2026-10-04T18:20:28.931Z" : new Date().toISOString() };
    } else if (message.method === "tabs.close") result = { closed: true, tabId: e.tabId };
    else { extension.send({ kind: "command.error", operationId: message.operationId, error: { code: "unexpected", message: message.method } }); return; }
    extension.send({ kind: "command.result", operationId: message.operationId, result });
  });
  const client = await BrokerClient.connect({ autoStart: false, env });
  const session = await client.request("session.open", { taskId: e.taskId });
  broker.profiles.get(e.profileInstanceId).generation = e.generation;
  broker.sessions.get(session.sessionId).generation = options.wrongGeneration ? "other-generation" : e.generation;
  const leaseReservations = [], setLease = broker.leases.set.bind(broker.leases);
  broker.leases.set = (key, value) => { leaseReservations.push({ key, value }); return setLease(key, value); };
  const target = { taskId: e.taskId, sessionId: e.sessionId, profileInstanceId: e.profileInstanceId,
    generation: e.generation, tabId: e.tabId, windowId: e.windowId, frameId: e.frameId,
    pageInstanceId: e.pageInstanceId, origin: e.origin, intendedUrl: e.url,
    ...viewportOriginalAnchor?.capsule.target };
  const binding = viewportOriginalAnchor?.operation.binding
    ? structuredClone(viewportOriginalAnchor.operation.binding)
    : { ...target, runId: e.runId, ownerKey: e.sessionId, method: "page.configureViewport", targetIdentity: target };
  await broker.taskLedger.prepare({ idempotencyKey: e.operationKey, binding, fingerprint: "original-accepted-fixture" });
  await broker.taskLedger.transition(e.operationKey, "dispatched", { operationId: e.operationId });
  await broker.taskLedger.transition(e.operationKey, "unknown_effect");
  await broker.taskLedger.reconcile(e.operationKey, binding, { effectState: "known_effect" }, { brokerEvidence: true });
  Object.assign(broker.taskLedger.get(e.operationKey), { resultDigest: e.resultDigest, dispatchCount: 1,
    preparedAt: "2026-10-04T18:10:34.151Z", reconciledAt: "2026-10-04T18:10:50.403Z", externalActionExecuted: false,
    ...structuredClone(viewportOriginalAnchor?.operation ?? {}) });
  const capsule = normalizeTaskExecutionCapsule({ capsuleId: e.capsuleId, taskId: e.taskId, runId: e.runId, state: "failed",
    target, resources: { tabId: e.tabId, ...viewportOriginalAnchor?.capsule.resources },
    retention: { policy: "retain_until_resume", reason: "local_ui_effect_unknown", ...viewportOriginalAnchor?.capsule.retention },
    effect: { effectClass: "local_ui", effectState: "unknown_effect", externalActionExecuted: null,
      ...viewportOriginalAnchor?.capsule.effect,
      idempotencyKey: "light-model-1280-set-once", failedOperationKey: e.operationKey, failedOperationId: e.operationId },
    blocker: { code: "operation_effect_unknown" } });
  await broker.taskLedger.putTaskCapsule(capsule);
  const taskTab = await broker.taskLedger.recordTaskTab({ ...target, sessionId: session.sessionId, runId: e.runId,
    capsuleId: e.capsuleId, targetIdentity: target, lifecycleState: "failed", retentionPolicy: "retain_until_resume", retentionReason: "local_ui_effect_unknown" });
  broker.taskTabs.set(`${e.profileInstanceId}:${e.tabId}`, taskTab);
  return { broker, client, session, capsule, calls, directory, leaseReservations,
    async helloRemovesAbsentEntry() {
      const entry = await broker.taskLedger.recordTaskTab({ ...broker.taskLedger.getTaskTab(e.profileInstanceId, e.tabId),
        sessionId: null, retentionPolicy: "ledger_only", retentionReason: "unknown_effect_ledger_only" });
      broker.taskTabs.set(`${e.profileInstanceId}:${e.tabId}`, entry);
      const ack = new Promise(resolve => { const remove = extension.onMessage(message => {
        if (message.kind === "extension.hello_ack") { remove(); resolve(); }
      }); });
      extension.send({ kind: "extension.hello", protocolVersion: PROTOCOL_VERSION, profileInstanceId: e.profileInstanceId,
        extensionRuntimeId: "viewport-test-runtime", buildId: INSTALL_BUILD_ID, capabilities: DEFAULT_CAPABILITIES });
      await ack;
      const deadline = Date.now() + 2_000;
      while (broker.taskLedger.getTaskTab(e.profileInstanceId, e.tabId) && Date.now() < deadline)
        await new Promise(resolve => setTimeout(resolve, 5));
      assert.equal(broker.taskLedger.getTaskTab(e.profileInstanceId, e.tabId), null);
      assert.equal(broker.taskTabs.has(`${e.profileInstanceId}:${e.tabId}`), false);
    },
    async removeBothRecords() {
      broker.taskTabs.delete(`${e.profileInstanceId}:${e.tabId}`);
      await broker.taskLedger.removeTaskTab(e.profileInstanceId, e.tabId);
    },
    async close() { client.close(); extension.close(); await broker.close(); await rm(directory, { recursive: true, force: true }); } };
}

for (const absent of [false, true]) test(`viewport maintenance ${absent ? "authenticated absence" : "fresh signed metrics"} settles cleanup only without replay`, async () => {
  const f = await viewportMaintenanceFixture({ absent }), e = VIEWPORT_CLEANUP_AMENDMENT;
  try {
    const original = structuredClone(f.broker.taskLedger.get(e.operationKey));
    const result = await f.client.request("session.close", { sessionId: f.session.sessionId, taskTerminal: true });
    const receipt = result.terminal_tab_cleanup.viewport_cleanup_receipt;
    assert.ok(receipt, JSON.stringify(result.terminal_tab_cleanup)); assert.equal(receipt.originalResultDigest, e.resultDigest);
    assert.equal(f.broker.taskLedger.getTaskCapsule(e.capsuleId).state, "failed");
    assert.equal(f.broker.taskLedger.getTaskCapsule(e.capsuleId).effect.effectState, "known_effect");
    assert.equal(receipt.desktopAcceptance, false); assert.equal(receipt.providerCompletion, false);
    assert.equal(receipt.exactBaselineRestoration, false); assert.equal(receipt.timerExecutionProven, false);
    assert.equal(receipt.viewportMutationDispatchCount, 0);
    if (absent) assert.deepEqual(f.leaseReservations, []);
    assert.equal(receipt.historicalCapsuleExternalActionExecuted, null);
    assert.equal(receipt.authenticatedOperationExternalActionExecuted, false);
    assert.equal(f.broker.taskLedger.getTaskCapsule(e.capsuleId).effect.externalActionExecuted, null);
    const { signature, ...signedPayload } = receipt;
    assert.equal(signature, payloadDigest(f.broker.ledgerSecret, signedPayload));
    assert.notEqual(signature, payloadDigest(f.broker.ledgerSecret,
      { ...signedPayload, historicalCapsuleExternalActionExecuted: false }));
    const { viewportCleanupReceipts, ...after } = f.broker.taskLedger.get(e.operationKey);
    assert.deepEqual(after, original); assert.equal(viewportCleanupReceipts.length, 1);
    const again = await f.broker.taskLedger.appendViewportCleanup({ capsuleId: e.capsuleId, proof: null }, { brokerEvidence: true });
    assert.deepEqual(again, receipt); assert.equal(f.broker.taskLedger.get(e.operationKey).viewportCleanupReceipts.length, 1);
    assert.equal(f.calls.some(call => ["page.configureViewport", "page.clearViewport", "tabs.create", "tabs.navigate"].includes(call.method)), false);
    if (absent) { assert.deepEqual(f.calls.map(call => call.method), ["tabs.list", "tabs.list", "tabs.get"]);
      assert.equal(f.broker.taskLedger.getTaskTab(e.profileInstanceId, e.tabId), null);
      assert.equal(receipt.readbackProof.inventoryEvidence.brokerEvidence, true);
      assert.equal(receipt.readbackProof.lookupEvidence.brokerEvidence, true);
    } else { assert.equal(receipt.readbackProof.viewport.width, 713); assert.equal(result.terminal_tab_cleanup.closed.includes(e.tabId), true); }
  } finally { await f.close(); }
});

test("viewport historical FALSE remains accepted and recorded separately from authenticated FALSE", async () => {
  const f = await viewportMaintenanceFixture({ absent: true }), e = VIEWPORT_CLEANUP_AMENDMENT;
  try {
    await f.removeBothRecords();
    f.broker.taskLedger.getTaskCapsule(e.capsuleId).effect.externalActionExecuted = false;
    const original = structuredClone(f.broker.taskLedger.get(e.operationKey));
    const result = await f.client.request("session.close", { sessionId: f.session.sessionId });
    const receipt = result.terminal_tab_cleanup.viewport_cleanup_receipt;
    assert.ok(receipt, JSON.stringify(result));
    assert.equal(receipt.historicalCapsuleExternalActionExecuted, false);
    assert.equal(receipt.authenticatedOperationExternalActionExecuted, false);
    assert.equal(f.broker.taskLedger.getTaskCapsule(e.capsuleId).effect.externalActionExecuted, false);
    const { viewportCleanupReceipts, ...after } = f.broker.taskLedger.get(e.operationKey);
    assert.deepEqual(after, original);
    assert.equal(viewportCleanupReceipts.length, 1);
    assert.deepEqual(f.calls.map(call => call.method), ["tabs.list", "tabs.get"]);
    assert.deepEqual(f.leaseReservations, []);
  } finally { await f.close(); }
});

for (const [scope, value, missing] of [
  ["capsule", true], ["capsule", undefined], ["capsule", undefined, true],
  ["capsule", 0], ["capsule", "false"], ["capsule", {}],
  ["operation", true], ["operation", null], ["operation", undefined], ["operation", undefined, true],
  ["operation", 0], ["operation", "false"],
]) test(`viewport historical flag rejects ${scope} ${missing ? "missing" : String(value)} without dispatch`, async () => {
  const f = await viewportMaintenanceFixture({ absent: true }), e = VIEWPORT_CLEANUP_AMENDMENT;
  try {
    await f.removeBothRecords();
    const changed = scope === "capsule" ? f.broker.taskLedger.getTaskCapsule(e.capsuleId).effect
      : f.broker.taskLedger.get(e.operationKey);
    if (missing) delete changed.externalActionExecuted;
    else changed.externalActionExecuted = value;
    const original = structuredClone(f.broker.taskLedger.get(e.operationKey));
    const capsule = structuredClone(f.broker.taskLedger.getTaskCapsule(e.capsuleId));
    const result = await f.client.request("session.close", { sessionId: f.session.sessionId });
    assert.equal(result.cleanup_receipt.ok, false);
    assert.equal(result.cleanup_receipt.exact_blocker, "viewport_cleanup_not_applicable");
    assert.equal(result.terminal_tab_cleanup.viewport_cleanup_receipt, undefined);
    assert.deepEqual(f.broker.taskLedger.get(e.operationKey), original);
    assert.deepEqual(f.broker.taskLedger.getTaskCapsule(e.capsuleId), capsule);
    assert.equal(f.calls.length, 0);
    assert.deepEqual(f.leaseReservations, []);
  } finally { await f.close(); }
});

test("viewport historical NULL keeps every pinned original candidate guard", async t => {
  const f = await viewportMaintenanceFixture({ absent: true }), e = VIEWPORT_CLEANUP_AMENDMENT;
  try {
    const original = structuredClone(f.broker.taskLedger.get(e.operationKey));
    const capsule = structuredClone(f.broker.taskLedger.getTaskCapsule(e.capsuleId));
    const now = Date.parse(original.reconciledAt) + e.maximumScheduledRestorationMs + 1;
    assert.equal(viewportCleanupCandidate(capsule, [original], [capsule], now).entry, original);
    const cases = [
      ...["capsuleId", "state", "taskId", "runId"].map(key => ["capsule." + key, c => c[key] = "other"]),
      ...["failedOperationId", "failedOperationKey", "idempotencyKey", "effectClass", "effectState"]
        .map(key => ["capsule.effect." + key, c => c.effect[key] = "other"]),
      ...["awaitedEvent", "uploadDelivery"].map(key => ["capsule.effect." + key, c => c.effect[key] = {}]),
      ...["reason", "policy"].map(key => ["capsule.retention." + key, c => c.retention[key] = "other"]),
      ...["idempotencyKey", "operationId", "state", "resultDigest", "effectState"]
        .map(key => ["operation." + key, (_c, o) => o[key] = "other"]),
      ["operation.brokerEvidence", (_c, o) => o.brokerEvidence = false],
      ["operation.dispatchCount", (_c, o) => o.dispatchCount = 2],
      ["operation.awaitedEvent", (_c, o) => o.awaitedEvent = {}],
      ["operation.reconciledAt missing", (_c, o) => delete o.reconciledAt],
      ["operation.preparedAt missing", (_c, o) => delete o.preparedAt],
      ["operation.reconciledAt before prepare", (_c, o) => o.reconciledAt = "2026-10-04T18:00:00Z"],
      ["scheduled deadline not elapsed", (_c, o) => o.reconciledAt = new Date(now).toISOString()],
      ...["method", "taskId", "runId", "sessionId", "profileInstanceId", "generation", "tabId", "ownerKey"]
        .map(key => ["operation.binding." + key, (_c, o) => o.binding[key] = "other"]),
      ...["profileInstanceId", "generation", "tabId", "pageInstanceId", "windowId", "frameId", "origin"]
        .flatMap(key => [
          ["operation.identity." + key, (_c, o) => o.binding.targetIdentity[key] = "other"],
          ["capsule.target." + key, c => c.target[key] = "other"],
        ]),
      ...["sessionId", "intendedUrl"].map(key => ["capsule.target." + key, c => c.target[key] = "other"]),
      ["capsule.resources.tabId", c => c.resources.tabId = 7],
    ];
    for (const [name, change] of cases) await t.test(name, () => {
      const c = structuredClone(capsule), o = structuredClone(original);
      change(c, o);
      assert.throws(() => viewportCleanupCandidate(c, [o], [c], now), { code: "viewport_cleanup_not_applicable" });
    });
    for (const state of ["dispatched", "unknown_effect"]) await t.test("other operation " + state, () => {
      const other = { ...structuredClone(original), operationId: "other", state };
      assert.throws(() => viewportCleanupCandidate(capsule, [original, other], [capsule], now),
        { code: "viewport_cleanup_not_applicable" });
    });
    for (const preparedAt of [undefined, original.preparedAt]) await t.test("later or undated viewport obligation " + preparedAt, () => {
      const other = { ...structuredClone(original), operationId: "other", preparedAt,
        binding: { ...original.binding, taskId: "other-task" } };
      assert.throws(() => viewportCleanupCandidate(capsule, [original, other], [capsule], now),
        { code: "viewport_cleanup_not_applicable" });
    });
    for (const state of ["failed", "reconciliation_required"]) await t.test("other capsule " + state, () => {
      const other = { ...structuredClone(capsule), capsuleId: "other", state };
      if (state === "reconciliation_required") other.effect.effectState = "known_effect";
      assert.throws(() => viewportCleanupCandidate(capsule, [original], [capsule, other], now),
        { code: "viewport_cleanup_not_applicable" });
    });
    assert.equal(f.calls.length, 0);
  } finally { await f.close(); }
});

for (const [name, options] of [
  ["still requested metrics", { requested: true }], ["missing capture timestamp", { missingCaptureTime: true }], ["stale visual proof", { stale: true }], ["wrong document", { wrongDocument: true }],
  ["cap equals limit", { absent: true, capped: true }], ["malformed inventory", { absent: true, malformed: true }],
  ["filtered inventory object", { absent: true, filtered: true }], ["failed inventory", { absent: true, failedInventory: true }],
  ["target present in second inventory", { absent: true, presentLookup: true }],
  ["unrelated lookup failure", { absent: true, lookupMessage: "Permission denied" }],
  ["wrong tab lookup error", { absent: true, lookupMessage: "No tab with id: 77." }],
  ["lookup timeout", { absent: true, lookupError: "operation_timeout" }],
  ["wrong generation", { absent: true, wrongGeneration: true }],
]) test(`viewport maintenance rejects ${name} and retains original failure`, async () => {
  const f = await viewportMaintenanceFixture(options), e = VIEWPORT_CLEANUP_AMENDMENT;
  try {
    if (options.wrongGeneration) await assert.rejects(f.client.request("session.close", { sessionId: f.session.sessionId, taskTerminal: true }), { code: "session_generation_stale" });
    else await f.client.request("session.close", { sessionId: f.session.sessionId, taskTerminal: true });
    assert.equal(f.broker.taskLedger.get(e.operationKey).viewportCleanupReceipts, undefined);
    assert.equal(f.broker.taskLedger.getTaskCapsule(e.capsuleId).effect.effectState, "unknown_effect");
    assert.equal(f.calls.some(call => ["page.configureViewport", "page.clearViewport", "tabs.create", "tabs.close"].includes(call.method)), false);
  } finally { await f.close(); }
});


for (const method of ["page.submit", "tabs.navigate", "page.uploadFiles", "page.type", "page.configureViewport"]) {
  test(`viewport absence maintenance preserves another ${method} obligation`, async () => {
    const f = await viewportMaintenanceFixture({ absent: true }), e = VIEWPORT_CLEANUP_AMENDMENT;
    try {
      const binding = { ...f.broker.taskLedger.get(e.operationKey).binding, method };
      await f.broker.taskLedger.prepare({ idempotencyKey: "other-obligation", binding, fingerprint: "other" });
      await f.broker.taskLedger.transition("other-obligation", "dispatched");
      await f.broker.taskLedger.transition("other-obligation", "unknown_effect");
      await f.client.request("session.close", { sessionId: f.session.sessionId, taskTerminal: true });
      assert.equal(f.broker.taskLedger.get(e.operationKey).viewportCleanupReceipts, undefined);
      assert.equal(f.broker.taskLedger.get("other-obligation").state, "unknown_effect");
      assert.equal(f.broker.taskLedger.getTaskCapsule(e.capsuleId).effect.effectState, "unknown_effect");
      assert.equal(f.calls.some(call => ["tabs.get", "tabs.close", "page.configureViewport", "page.clearViewport", "tabs.create"].includes(call.method)), false);
    } finally { await f.close(); }
  });
}


test("viewport fallback follows actual hello removal, preserves original anchors and is idempotent across closes", async () => {
  const f = await viewportMaintenanceFixture({ absent: true }), e = VIEWPORT_CLEANUP_AMENDMENT;
  try {
    const original = structuredClone(f.broker.taskLedger.get(e.operationKey));
    const capsule = structuredClone(f.broker.taskLedger.getTaskCapsule(e.capsuleId));
    await f.helloRemovesAbsentEntry();
    assert.deepEqual(f.calls.map(call => call.method), ["tabs.list"]);
    const removed = new TaskOperationLedger({ statePath: join(f.directory, "ledger.json"), secret: f.broker.ledgerSecret });
    await removed.ready();
    assert.equal(removed.getTaskTab(e.profileInstanceId, e.tabId), null);
    removed.close();
    const closed = await f.client.request("session.close", { sessionId: f.session.sessionId });
    const result = closed.terminal_tab_cleanup, receipt = result.viewport_cleanup_receipt;
    assert.equal(result.viewport_cleanup_disposition, "task_tab_already_absent");
    assert.equal(closed.cleanup_receipt.ok, true);
    assert.deepEqual(result.missing, [e.tabId]);
    assert.equal(receipt.viewportMutationDispatchCount, 0);
    assert.equal(receipt.replayAllowed, false);
    assert.deepEqual(f.leaseReservations, []);
    assert.equal(receipt.originalOutcome, "failed");
    assert.equal(receipt.historicalCapsuleExternalActionExecuted, null);
    assert.equal(receipt.authenticatedOperationExternalActionExecuted, false);
    assert.equal(receipt.originalBinding.sessionId, e.sessionId);
    assert.equal(receipt.originalBinding.targetIdentity.pageInstanceId, e.pageInstanceId);
    assert.equal(receipt.currentBinding.sessionId, f.session.sessionId);
    assert.notEqual(receipt.currentBinding.sessionId, e.sessionId);
    const { viewportCleanupReceipts, ...after } = f.broker.taskLedger.get(e.operationKey);
    assert.deepEqual(after, original);
    assert.equal(viewportCleanupReceipts.length, 1);
    const updated = f.broker.taskLedger.getTaskCapsule(e.capsuleId);
    assert.equal(updated.state, capsule.state);
    assert.deepEqual(updated.target, capsule.target);
    assert.deepEqual(updated.resources, capsule.resources);
    assert.deepEqual(updated.blocker, capsule.blocker);
    assert.equal(updated.effect.externalActionExecuted, null);
    assert.deepEqual(f.calls.map(call => call.method), ["tabs.list", "tabs.list", "tabs.get"]);
    await assert.rejects(f.client.request("session.close", { sessionId: f.session.sessionId }), { code: "session_not_owned" });
    const next = await f.client.request("session.open", { taskId: e.taskId });
    const again = await f.client.request("session.close", { sessionId: next.sessionId });
    assert.deepEqual(again.terminal_tab_cleanup.viewport_cleanup_receipt, receipt);
    assert.equal(f.broker.taskLedger.get(e.operationKey).viewportCleanupReceipts.length, 1);
    assert.equal(f.calls.length, 3);
    const persisted = new TaskOperationLedger({ statePath: join(f.directory, "ledger.json"), secret: f.broker.ledgerSecret });
    await persisted.ready();
    assert.deepEqual(persisted.get(e.operationKey).viewportCleanupReceipts, [receipt]);
    assert.equal(persisted.getTaskCapsule(e.capsuleId).effect.externalActionExecuted, null);
    assert.equal(persisted.getTaskTab(e.profileInstanceId, e.tabId), null);
    persisted.close();
  } finally { await f.close(); }
});

for (const [name, options] of [
  ["cap equals limit", { capped: true }], ["malformed inventory", { malformed: true }],
  ["filtered inventory", { filtered: true }], ["failed inventory", { failedInventory: true }],
  ["target present", { presentLookup: true }], ["unrelated lookup", { lookupMessage: "Permission denied" }],
  ["wrong target lookup", { lookupMessage: "No tab with id: 77." }], ["lookup timeout", { lookupError: "operation_timeout" }],
]) test(`missing-task-tab fallback rejects ${name}`, async () => {
  const f = await viewportMaintenanceFixture({ absent: true, ...options }), e = VIEWPORT_CLEANUP_AMENDMENT;
  try {
    await f.helloRemovesAbsentEntry();
    const original = structuredClone(f.broker.taskLedger.get(e.operationKey));
    const result = await f.client.request("session.close", { sessionId: f.session.sessionId });
    assert.equal(result.cleanup_receipt.ok, false);
    assert.ok(result.cleanup_receipt.exact_blocker);
    assert.equal(result.terminal_tab_cleanup.viewport_cleanup_receipt, undefined);
    assert.deepEqual(f.broker.taskLedger.get(e.operationKey), original);
    assert.equal(f.broker.taskLedger.getTaskCapsule(e.capsuleId).effect.effectState, "unknown_effect");
    assert.equal(f.calls.some(call => ["tabs.close", "tabs.create", "tabs.navigate", "page.configureViewport"].includes(call.method)), false);
  } finally { await f.close(); }
});

for (const [name, change] of [
  ["missing capsule", f => f.broker.taskLedger.capsules.delete(VIEWPORT_CLEANUP_AMENDMENT.capsuleId)],
  ["missing operation", f => f.broker.taskLedger.operations.delete(VIEWPORT_CLEANUP_AMENDMENT.operationKey)],
  ["capsule original session", f => f.broker.taskLedger.getTaskCapsule(VIEWPORT_CLEANUP_AMENDMENT.capsuleId).target.sessionId = "foreign"],
  ["capsule document", f => f.broker.taskLedger.getTaskCapsule(VIEWPORT_CLEANUP_AMENDMENT.capsuleId).target.pageInstanceId = "foreign"],
  ["operation original session", f => f.broker.taskLedger.get(VIEWPORT_CLEANUP_AMENDMENT.operationKey).binding.sessionId = "foreign"],
  ["operation digest", f => f.broker.taskLedger.get(VIEWPORT_CLEANUP_AMENDMENT.operationKey).resultDigest = "foreign"],
  ["operation dispatch count", f => f.broker.taskLedger.get(VIEWPORT_CLEANUP_AMENDMENT.operationKey).dispatchCount = 2],
  ["current foreign owner", f => f.broker.sessions.get(f.session.sessionId).taskId = "foreign-task"],
  ["current foreign profile", f => {
    const profile = { ...f.broker.profiles.get(VIEWPORT_CLEANUP_AMENDMENT.profileInstanceId), profileInstanceId: "foreign-profile" };
    f.broker.profiles.set(profile.profileInstanceId, profile);
    f.broker.sessions.get(f.session.sessionId).profileInstanceId = profile.profileInstanceId;
  }],
  ["other obligation", async f => {
    const binding = { ...f.broker.taskLedger.get(VIEWPORT_CLEANUP_AMENDMENT.operationKey).binding, method: "page.submit" };
    await f.broker.taskLedger.prepare({ idempotencyKey: "fallback-other", binding, fingerprint: "other" });
    await f.broker.taskLedger.transition("fallback-other", "dispatched");
    await f.broker.taskLedger.transition("fallback-other", "unknown_effect");
  }],
  ["other capsule", async f => {
    await f.broker.taskLedger.putTaskCapsule({ ...f.capsule, capsuleId: "other-capsule" });
  }],
]) test(`missing-task-tab fallback rejects ${name} before any read dispatch`, async () => {
  const f = await viewportMaintenanceFixture({ absent: true }), e = VIEWPORT_CLEANUP_AMENDMENT;
  try {
    await f.removeBothRecords();
    await change(f);
    await f.client.request("session.close", { sessionId: f.session.sessionId });
    assert.equal(f.broker.taskLedger.get(e.operationKey)?.viewportCleanupReceipts, undefined);
    assert.equal(f.calls.length, 0);
  } finally { await f.close(); }
});

for (const keep of ["memory", "durable"]) test(`missing-task-tab fallback requires absence from ${keep} bookkeeping`, async () => {
  const f = await viewportMaintenanceFixture({ absent: true }), e = VIEWPORT_CLEANUP_AMENDMENT;
  try {
    const tab = f.broker.taskLedger.getTaskTab(e.profileInstanceId, e.tabId);
    if (keep === "durable") f.broker.taskTabs.delete(`${e.profileInstanceId}:${e.tabId}`);
    else {
      await f.broker.taskLedger.removeTaskTab(e.profileInstanceId, e.tabId);
      // Foreign-generation memory record is excluded from normal cleanup.
      f.broker.taskTabs.set(`${e.profileInstanceId}:${e.tabId}`, { ...tab, generation: "foreign" });
    }
    const result = await f.client.request("session.close", { sessionId: f.session.sessionId });
    assert.equal(result.terminal_tab_cleanup.viewport_cleanup_receipt, undefined);
    assert.equal(f.broker.taskLedger.get(e.operationKey).viewportCleanupReceipts, undefined);
    assert.equal(f.calls.length, 0);
  } finally { await f.close(); }
});


for (const anchor of ["signature", "originalResultDigest"]) test(`missing-task-tab fallback rejects changed existing receipt ${anchor}`, async () => {
  const f = await viewportMaintenanceFixture({ absent: true }), e = VIEWPORT_CLEANUP_AMENDMENT;
  try {
    await f.removeBothRecords();
    const first = await f.client.request("session.close", { sessionId: f.session.sessionId });
    assert.ok(first.terminal_tab_cleanup.viewport_cleanup_receipt);
    const original = f.broker.taskLedger.get(e.operationKey);
    if (anchor === "signature") original.viewportCleanupReceipts[0].signature = "invalid";
    else original.resultDigest = "changed";
    const before = structuredClone(original), count = f.calls.length;
    const next = await f.client.request("session.open", { taskId: e.taskId });
    const closed = await f.client.request("session.close", { sessionId: next.sessionId });
    assert.equal(closed.cleanup_receipt.ok, false);
    assert.equal(closed.cleanup_receipt.exact_blocker, "viewport_cleanup_receipt_invalid");
    assert.equal(closed.terminal_tab_cleanup.viewport_cleanup_receipt, undefined);
    assert.deepEqual(f.broker.taskLedger.get(e.operationKey), before);
    assert.equal(f.calls.length, count);
  } finally { await f.close(); }
});
