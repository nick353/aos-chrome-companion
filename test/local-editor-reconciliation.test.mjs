import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { TaskOperationLedger, payloadDigest, verifyOriginalEditorPayload,
  localEditorReconciliationPayload, createAuthorityEnvelope, normalizeTaskExecutionCapsule } from "../src/shared/task-runtime.mjs";
import { CompanionBroker } from "../src/broker/broker.mjs";
import { BrokerClient } from "../src/client/broker-client.mjs";
import { connectPeer } from "../src/client/connect.mjs";
import { ensureBrokerSecret } from "../src/shared/security.mjs";
import { DEFAULT_CAPABILITIES, PROTOCOL_VERSION } from "../src/shared/constants.mjs";
import { INSTALL_BUILD_ID } from "../src/shared/build-info.mjs";

const secret = "local-editor-test-secret";
async function fixture() {
  const dir = await mkdtemp(join(tmpdir(), "aos-local-editor-"));
  const statePath = join(dir, "state.json");
  const ledger = new TaskOperationLedger({ statePath, secret }); await ledger.ready();
  const binding = { taskId: "task", runId: "original-run", profileInstanceId: "profile", generation: "generation",
    sessionId: "ORIGINAL-session", ownerKey: "ORIGINAL-session", tabId: 42, method: "page.type",
    targetIdentity: { taskId: "task", sessionId: "ORIGINAL-session", leaseId: "ORIGINAL-lease", profileInstanceId: "profile",
      generation: "generation", tabId: 42, pageInstanceId: "doc", windowId: 9, frameId: 0, origin: "https://editor.note.com" } };
  const originalPayload = { locator: { css: "div.ProseMirror" }, text: "alpha NEWbeta", clear: true,
    physicalFallback: "on_verified_no_effect", tabId: 42, pageInstanceId: "doc", windowId: 9, frameId: 0,
    allowedOrigins: ["https://editor.note.com"], targetOrigin: "https://editor.note.com" };
  const key = "original:1";
  const entry = await ledger.prepare({ idempotencyKey: key, fingerprint: payloadDigest(secret, { binding, payload: originalPayload }), binding });
  await ledger.transition(key, "dispatched", { externalActionExecuted: false, mutationDispatchAttempted: true });
  await ledger.transition(key, "unknown_effect");
  const capsule = normalizeTaskExecutionCapsule({ capsuleId: "capsule", taskId: "task", runId: "original-run", state: "failed",
    resources: { tabId: 42 }, target: { ...binding, pageInstanceId: "doc" },
    effect: { effectClass: "local_ui", idempotencyKey: "original", failedOperationId: entry.operationId, failedOperationKey: key, effectState: "unknown_effect" } });
  await ledger.putTaskCapsule(capsule);
  const currentBinding = { taskId: "task", sessionId: "CURRENT-session", leaseId: "CURRENT-lease", profileInstanceId: "profile",
    generation: "generation", tabId: 42, pageInstanceId: "doc", windowId: 9, frameId: 0 };
  const resolution = { schema: "aos.chrome_companion.local_editor_resolution.v1", resolutionId: "resolution", originalOperationId: entry.operationId,
    originalFingerprint: entry.fingerprint, currentBinding, repairOperationKey: "different:1", expectedBody: "alpha beta",
    expectedFullBody: originalPayload.text, offset: 6, insertText: "NEW", url: "https://editor.note.com/notes/article/edit/",
    issuedAt: new Date().toISOString(), expiresAt: new Date(Date.now() + 120000).toISOString(), providerCompletion: false };
  return { ledger, statePath, dir, binding, originalPayload, capsule, key, entry, resolution,
    append: value => ledger.appendLocalEditorResolution({ originalOperationKey: key, originalPayload, capsuleId: "capsule", resolution: value ?? resolution }, { brokerEvidence: true }),
    consume: overrides => ledger.consumeLocalEditorResolution({ originalOperationKey: key, resolutionId: "resolution", repairOperationKey: "different:1", currentBinding,
      guard: { expectedBody: "alpha beta", expectedFullBody: "alpha NEWbeta", offset: 6, url: resolution.url }, text: "NEW", ...overrides }),
    cleanup: async () => { ledger.close(); await rm(dir, { recursive: true, force: true }); } };
}

test("original payload uses ORIGINAL binding HMAC and rejects fabricated guard/trailing newline", async () => {
  const f = await fixture();
  try {
    assert.equal(verifyOriginalEditorPayload(secret, f.entry, f.capsule, f.originalPayload), f.entry.fingerprint);
    for (const change of [{ text: f.originalPayload.text + "\n" }, { semanticGuardId: "fabricated" }, { clear: false }, { tabId: 43 }]) {
      assert.throws(() => verifyOriginalEditorPayload(secret, f.entry, f.capsule, { ...f.originalPayload, ...change }), { code: "local_editor_original_payload_invalid" });
    }
    assert.throws(() => verifyOriginalEditorPayload(secret, { ...f.entry, binding: { ...f.binding, sessionId: "CURRENT-session" } }, f.capsule, f.originalPayload), { code: "local_editor_original_payload_invalid" });
  } finally { await f.cleanup(); }
});

test("signed local resolution preserves failed receipt and old-key replay refusal", async () => {
  const f = await fixture();
  try {
    const original = structuredClone(f.entry), capsule = structuredClone(f.ledger.getTaskCapsule("capsule"));
    const signed = await f.append(); const { signature, ...payload } = signed;
    assert.equal(signature, payloadDigest(secret, payload));
    const { localEditorResolutions, ...after } = f.ledger.get(f.key);
    assert.deepEqual(after, original); assert.deepEqual(f.ledger.getTaskCapsule("capsule"), capsule);
    assert.equal(f.ledger.get(f.key).state, "unknown_effect");
    const replay = await f.ledger.prepare({ idempotencyKey: f.key, binding: f.binding, fingerprint: f.entry.fingerprint });
    assert.equal(replay.state, "unknown_effect", "broker must reject any nonprepared old key");
    await assert.rejects(f.ledger.prepare({ idempotencyKey: f.key, binding: f.binding, fingerprint: "changed" }), { code: "idempotency_fingerprint_conflict" });
    await assert.rejects(f.append(), { code: "local_editor_resolution_exists" });
    assert.equal(localEditorResolutions.length, 1);
  } finally { await f.cleanup(); }
});

test("only broker-owned fresh different-key bound insertion is authorized", async () => {
  const f = await fixture();
  try {
    await assert.rejects(f.ledger.appendLocalEditorResolution({ originalOperationKey: f.key, originalPayload: f.originalPayload,
      capsuleId: "capsule", resolution: f.resolution }), { code: "reconciliation_evidence_required" });
    for (const change of [{ repairOperationKey: f.key }, { expectedFullBody: "different" }, { offset: -1 },
      { currentBinding: { ...f.resolution.currentBinding, tabId: 43 } }, { currentBinding: { ...f.resolution.currentBinding, pageInstanceId: "foreign" } },
      { expiresAt: new Date(0).toISOString() }]) {
      await assert.rejects(f.append({ ...f.resolution, ...change }), { code: "local_editor_resolution_invalid" });
    }
    await f.append();
    for (const change of [{ repairOperationKey: f.key }, { text: "different" }, { currentBinding: { ...f.resolution.currentBinding, leaseId: "foreign" } },
      { guard: { expectedBody: "changed", expectedFullBody: "alpha NEWbeta", offset: 6, url: f.resolution.url } }]) {
      await assert.rejects(f.consume(change), { code: "local_editor_repair_binding_invalid" });
    }
    await f.consume();
    await assert.rejects(f.consume(), { code: "local_editor_repair_binding_invalid" });
    assert.equal(f.ledger.get(f.key).state, "unknown_effect");
  } finally { await f.cleanup(); }
});

test("resolution and consumed marker survive journal/checkpoint without rewriting original fields", async () => {
  const f = await fixture();
  try {
    await f.append(); await f.consume(); f.ledger.close();
    const journal = await readFile(`${f.statePath}.journal`, "utf8");
    assert.ok(journal.includes("localEditorResolutions"));
    const restored = new TaskOperationLedger({ statePath: f.statePath, secret });
    await restored.ready();
    assert.equal(restored.get(f.key).binding.sessionId, "ORIGINAL-session");
    assert.equal(restored.get(f.key).state, "unknown_effect");
    assert.ok(restored.get(f.key).localEditorResolutions[0].consumedAt);
    restored.close();
  } finally { await f.cleanup(); }
});

test("owner-signed local payload binds original command and current lease/body", () => {
  const input = { runId: "run", taskId: "task", idempotencyKey: "original", capsuleId: "capsule", tabId: 42, leaseId: "current-lease",
    originalOperationKey: "original:1", originalOperationId: "op", originalPayload: { text: "full" }, expectedBody: "body", expectedFullBody: "full",
    insertText: "text", offset: 1, repairOperationKey: "new:1", url: "https://editor.note.com/notes/article/edit/", pageInstanceId: "doc" };
  const payload = localEditorReconciliationPayload(input);
  const envelope = createAuthorityEnvelope({ issuer: "codex_mcp", secret, runId: "run", taskId: "task", ownerKey: "current-session",
    method: "task.reconciliation.resolve_local_editor", intent: "resolve_local_editor_from_exact_readback", targetOrigin: "https://editor.note.com",
    idempotencyKey: "resolve", payload, approved: true });
  assert.equal(envelope.payloadHmac, payloadDigest(secret, payload));
  assert.notEqual(envelope.payloadHmac, payloadDigest(secret, { ...payload, leaseId: "original-lease" }));
});

test("supported owner-signed resolve -> authorized transaction holds same lease and sends one guarded helper insertion", async () => {
  const dataDir = await mkdtemp(join(tmpdir(), "aos-editor-integrated-"));
  const env = { ...process.env, AOS_CHROME_COMPANION_DATA_DIR: dataDir,
    AOS_CHROME_COMPANION_SOCKET: join(dataDir, "broker.sock"), AOS_CHROME_COMPANION_SECRET_FILE: join(dataDir, "secret"),
    AOS_CHROME_COMPANION_CODEX_MCP_ISSUER_SECRET_FILE: join(dataDir, "codex-issuer") };
  await writeFile(env.AOS_CHROME_COMPANION_CODEX_MCP_ISSUER_SECRET_FILE, secret);
  const broker = new CompanionBroker({ socketPath: env.AOS_CHROME_COMPANION_SOCKET,
    secret: await ensureBrokerSecret(env), issuerSecrets: { codex_mcp: secret }, statePath: join(dataDir, "ledger.json") });
  await broker.listen();
  const extension = await connectPeer({ role: "extension-relay", autoStart: false, env });
  const hello = new Promise(resolve => { const remove = extension.onMessage(message => { if (message.kind === "extension.hello_ack") { remove(); resolve(); } }); });
  extension.send({ kind: "extension.hello", protocolVersion: PROTOCOL_VERSION, profileInstanceId: "profile", extensionRuntimeId: "test-runtime", buildId: INSTALL_BUILD_ID, capabilities: DEFAULT_CAPABILITIES });
  await hello;
  const url = "https://editor.note.com/notes/article/edit/", pageInstanceId = "doc";
  let tab, body = "alpha beta", originalCommand;
  const commands = [];
  extension.onMessage(message => {
    if (message.kind !== "command.request") return;
    commands.push(message);
    let result;
    if (message.method === "tabs.list") result = tab ? [tab] : [];
    else if (message.method === "tabs.create") result = tab = { id: 42, windowId: 9, url, title: "Article", active: false, pinned: false, groupId: 77 };
    else if (message.method === "tabs.groupTask") result = tab;
    else if (message.method === "page.snapshot") result = { url, pageInstanceId, title: "Article", text: body, frameId: 0, windowId: 9 };
    else if (message.method === "page.query") result = message.params.exactEditor
      ? { exactEditor: true, body, truncated: false, chars: body.length, bodySha256: "hash", pageInstanceId, frameId: 0, url }
      : { count: 1, matches: [{ text: body }], pageInstanceId, url };
    else if (message.method === "visual.inspectTarget") result = { url, pageInstanceId, frameId: 0,
      element: { tag: "span", name: "target" }, rect: { x: 10, y: 10, width: 100, height: 30 }, clippedRect: { x: 10, y: 10, width: 100, height: 30 },
      point: { x: 60, y: 25 }, viewport: { width: 1200, height: 800, devicePixelRatio: 1 }, scroll: { x: 0, y: 0 } };
    else if (message.method === "page.screenshot") result = { kind: "screenshot", tabId: 42, url, mimeType: "image/png", dataBase64: "dGVzdA==", capturedAt: new Date().toISOString() };
    else if (message.method === "page.waitFor") result = { found: true, url, pageInstanceId };
    else if (message.method === "page.type") {
      originalCommand = message;
      extension.send({ kind: "command.error", operationId: message.operationId, error: { code: "semantic_input_effect_ambiguous", message: "Test unknown partial input",
        details: { operationEffectState: "unknown_effect", mutationDispatchAttempted: true } } }); return;
    } else if (message.method === "visual.typeText") {
      assert.equal(message.params.editorGuard.establishSelection, true);
      assert.equal(message.params.clickBeforeType, false); assert.equal(message.params.clear, false);
      assert.equal(body, message.params.editorGuard.expectedBody);
      body = message.params.editorGuard.expectedFullBody;
      result = { typed: true, fullBodyVerified: true, pageInstanceId, url, bodySha256: "after-hash" };
    } else throw new Error(`Unexpected test method ${message.method}`);
    extension.send({ kind: "command.result", operationId: message.operationId, result });
  });
  const client = await BrokerClient.connect({ autoStart: false, env, issuer: "codex_mcp" });
  try {
    const session = await client.request("session.open", { taskId: "task" });
    const base = { sessionId: session.sessionId, taskId: "task", startUrl: url, allowedOrigins: ["https://editor.note.com"], targetOrigin: "https://editor.note.com", keepTaskTab: true };
    const failed = await client.requestAuthorizedTransaction({ ...base, runId: "original-run", idempotencyKey: "original",
      actions: [{ method: "page.type", params: { locator: { css: "div.ProseMirror" }, text: "alpha NEWbeta", clear: true, physicalFallback: "on_verified_no_effect" } }] });
    assert.equal(failed.capsule.state, "failed");
    const originalEntry = broker.taskLedger.get("original:1"), originalState = structuredClone(originalEntry);
    const lease = await client.request("lease.acquire", { sessionId: session.sessionId, tabId: 42 });
    const visual = await client.request("visual.target.inspect", { sessionId: session.sessionId, leaseId: lease.leaseId, tabId: 42, locator: { css: "span.highlight" } });
    const args = { sessionId: session.sessionId, leaseId: lease.leaseId, tabId: 42, runId: "original-run", taskId: "task", idempotencyKey: "original",
      capsuleId: failed.capsule.capsuleId, originalOperationKey: "original:1", originalOperationId: originalEntry.operationId,
      originalPayload: originalCommand.params, expectedBody: body, expectedFullBody: "alpha NEWbeta", insertText: "NEW", offset: 6, repairOperationKey: "repair:1", url, pageInstanceId };
    // command envelope includes companionContext only at transport. The
    // original fingerprint is the operation payload before that decoration.
    delete args.originalPayload.companionContext;
    const resolution = await client.requestResolveLocalEditor(args);
    const repair = await client.requestAuthorizedTransaction({ ...base, tabId: 42, runId: "repair-run", idempotencyKey: "repair",
      actions: [{ method: "visual.typeText", params: { visualProof: visual.visualProof, text: "NEW", clear: false,
        clickBeforeType: false, editorGuard: { ...resolution.editorGuard, establishSelection: true } } }] });
    assert.equal(repair.result, "verified", JSON.stringify(repair.exact_blocker));
    const repairEntry = broker.taskLedger.get("repair:1");
    assert.equal(repairEntry.binding.targetIdentity.leaseId, lease.leaseId);
    assert.equal(commands.filter(item => item.method === "visual.typeText").length, 1);
    assert.equal(commands.filter(item => item.method === "page.type").length, 1);
    assert.equal(commands.some(item => item.method === "page.selectText" || item.method === "clipboard.write" || item.method === "visual.click"), false);
    const { localEditorResolutions, ...oldReceipt } = broker.taskLedger.get("original:1");
    assert.deepEqual(oldReceipt, originalState); assert.equal(localEditorResolutions.length, 1);
    assert.equal(broker.taskLedger.getTaskCapsule(failed.capsule.capsuleId).state, "failed");
    assert.equal(body, "alpha NEWbeta");
  } finally { client.close(); extension.close(); await broker.close(); await rm(dataDir, { recursive: true, force: true }); }
});
