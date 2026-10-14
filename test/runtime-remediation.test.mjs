import assert from "node:assert/strict";
import { createHash, webcrypto } from "node:crypto";
import { readFile } from "node:fs/promises";
import test from "node:test";
import vm from "node:vm";
import { stopExactNavigation } from "../extension/navigation-recovery.js";
import { DebuggerSessionPool } from "../extension/page-observation.js";

const worker = await readFile(new URL("../extension/service-worker.js", import.meta.url), "utf8");
const offscreen = await readFile(new URL("../extension/offscreen.js", import.meta.url), "utf8");
const error = (code, message, details = {}) => Object.assign(new Error(message), { code, details });
const payloadHash = value => createHash("sha256").update(JSON.stringify(value)).digest("hex");
const textMessage = (overrides = {}) => {
  const message = { text: "秘密の日本語😀", operationId: "op-source", taskId: "task-a", generation: "generation-a", targetOrigin: "https://editor.test", ...overrides };
  return { ...message, payloadSha256: payloadHash(message.formats ? { formats: message.formats } : { text: message.text }) };
};

function navigationWorkerFixture({ recordingFails = false, detachRejects = false, slowAcquire = false } = {}) {
  const messages = [], cleanupReceipt = { status: "pending" }, profile = "broker-profile", generation = "broker-generation";
  let stopped = false, attaches = 0, detaches = 0;
  const tab = { id:42,windowId:9,url:"https://editor.test/body?secret=never-record",pendingUrl:"https://editor.test/body?secret=never-record",status:"loading" };
  const pool = new DebuggerSessionPool({ attach:async()=>{attaches++;if(slowAcquire)await new Promise(resolve=>setTimeout(resolve,150));},detach:async()=>{detaches++;if(detachRejects)throw Error("RAW_SECRET_DETACH_ERROR");} });
  const context = vm.createContext({ URL,performance,stopExactNavigation:options=>stopExactNavigation({...options,timeoutMs:100}),debuggerSessions:pool,javaScriptDialogs:{},
    runtimeState:{profileInstanceId:profile,generation,port:{id:"original-port"}},
    MUTATION_OPERATION_METHODS:new Set(["tabs.stopLoading"]),
    chrome:{tabs:{get:async()=>({...tab,...(stopped?{pendingUrl:undefined,status:"complete"}:{})})}},
    requireTrustedDebuggerAccess:async()=>{},
    sendDebuggerCommand:async(_,method)=>{if(method==="Page.stopLoading"){stopped=true;return{};}return{frameTree:{frame:{id:"main",loaderId:"loader",url:tab.url}}};},
    userControls:{beforeCommand:async()=>{},observe:()=>{}},
    executeWithExpectedDialog:async({execute})=>execute(),
    postNativeMessage:(message,options)=>{
      messages.push({message:JSON.parse(JSON.stringify(message)),port:options.port});
      if(message.event==="debugger.cleanup"){
        if(recordingFails)return false;
        Object.assign(cleanupReceipt,{status:message.status,reason:message.reason});
      }
      return true;
    },
  });
  vm.runInContext(worker.slice(worker.indexOf("async function handleNativeMessage("),worker.indexOf("function companionError(")),context);
  const start=worker.indexOf('    case "tabs.stopLoading":'),end=worker.indexOf('    case "tabs.waitForCommit":',start);
  vm.runInContext(`async function executeCommand(method,params){switch(method){${worker.slice(start,end)}default:throw Error("unexpected fixture method");}}`,context);
  const message = {kind:"command.request",method:"tabs.stopLoading",operationId:"broker-operation",taskId:"broker-task",sessionId:"broker-session",
    profileInstanceId:profile,generation,allowedOrigins:["https://editor.test"],targetOrigin:"https://editor.test",
    params:{tabId:42,expectedWindowId:9,expectedUrl:tab.url,expectedPendingUrl:tab.url,optIn:true,
      operationId:"caller-operation",taskId:"caller-task",sessionId:"caller-session",profileInstanceId:"caller-profile",generation:"caller-generation",
      onCleanup:"caller-override",secret:"CALLER_SECRET_BODY"}};
  return {run:()=>context.handleNativeMessage(message),messages,cleanupReceipt,counts:()=>({attaches,detaches,stopped})};
}

test("real worker stop callback uses broker identity and original port with metadata-only cleanup payload",async()=>{
  for(const detachRejects of [false,true]){
    const f=navigationWorkerFixture({detachRejects}); await f.run();
    assert.equal(f.messages.some(entry=>entry.message.kind==="command.error"),false,JSON.stringify(f.messages));
    const delivered=f.messages.find(entry=>entry.message.event==="debugger.cleanup");
    assert.deepEqual(delivered.message,{kind:"extension.event",event:"debugger.cleanup",operationId:"broker-operation",taskId:"broker-task",
      sessionId:"broker-session",profileInstanceId:"broker-profile",generation:"broker-generation",tabId:42,
      status:detachRejects?"reconciliation_required":"detached",reason:detachRejects?"detach_failed":"detached"});
    assert.equal(delivered.port.id,"original-port"); assert.doesNotMatch(JSON.stringify(delivered.message),/secret|caller-|RAW_SECRET|https:/iu);
    const result=f.messages.find(entry=>entry.message.kind==="command.result").message.result;
    assert.equal(result.stopped,true); assert.equal(result.operationEffectState,"applied"); assert.deepEqual(f.counts(),{attaches:1,detaches:1,stopped:true});
  }
});

test("failed cleanup delivery leaves the existing receipt pending without replacing a successful stop result",async()=>{
  const f=navigationWorkerFixture({recordingFails:true}); await f.run();
  assert.equal(f.messages.some(entry=>entry.message.kind==="command.error"),false,JSON.stringify(f.messages));
  assert.equal(f.cleanupReceipt.status,"pending");
  assert.equal(f.messages.filter(entry=>entry.message.event==="debugger.cleanup").length,1);
  assert.equal(f.messages.find(entry=>entry.message.kind==="command.result").message.result.stopped,true);
  assert.equal(f.messages.some(entry=>entry.message.kind==="command.error"),false);
  assert.deepEqual(f.counts(),{attaches:1,detaches:1,stopped:true});
});

test("real worker late attach cleanup records the original owner after timeout error without another stop",async()=>{
  const f=navigationWorkerFixture({slowAcquire:true,detachRejects:true}); await f.run();
  const failure=f.messages.find(entry=>entry.message.kind==="command.error").message;
  assert.equal(failure.error.code,"navigation_stop_timeout"); assert.equal(failure.error.details.operationEffectState,"none");
  assert.equal(failure.error.details.retryStop,false); assert.equal(f.cleanupReceipt.status,"pending");
  assert.equal(f.messages.some(entry=>entry.message.event==="debugger.cleanup"),false);
  const preserved=JSON.stringify(failure);
  await new Promise(resolve=>setTimeout(resolve,100));
  const cleanup=f.messages.find(entry=>entry.message.event==="debugger.cleanup").message;
  assert.deepEqual(cleanup,{kind:"extension.event",event:"debugger.cleanup",operationId:"broker-operation",taskId:"broker-task",
    sessionId:"broker-session",profileInstanceId:"broker-profile",generation:"broker-generation",tabId:42,status:"reconciliation_required",reason:"detach_failed"});
  assert.equal(JSON.stringify(failure),preserved); assert.deepEqual(f.counts(),{attaches:1,detaches:1,stopped:false});
  assert.equal(f.cleanupReceipt.status,"reconciliation_required");
});

function clipboardFixture({ storage = new Map(), fault, writeFault } = {}) {
  const calls = [];
  let listener, sets = 0;
  const context = vm.createContext({ crypto: webcrypto, TextEncoder, URL, Blob, atob, btoa,
    companionError: error,
    BINARY_CLIPBOARD_MIME_ALLOWLIST: new Set(["text/plain", "text/html", "image/png"]), MAX_CLIPBOARD_BINARY_BYTES: 2097152,
    ClipboardItem: class { constructor(value) { this.value = value; } static supports() { return true; } },
    navigator: { clipboard: { writeText: async text => { calls.push({ type: "text", text }); if (writeFault) throw Error("ACK missing"); },
      write: async items => { calls.push({ type: "mime", items }); if (writeFault) throw Error("ACK missing"); } } },
    chrome: { runtime: { id: "extension", getURL: path => `chrome-extension://extension/${path}`, onMessage: { addListener: value => { listener = value; } } }, storage: { local: {
      get: async key => key === null ? Object.fromEntries(storage) : ({ [key]: storage.get(key) }), set: async values => {
        sets++;
        if (fault === sets) throw Error("durable storage interrupted");
        for (const [key, value] of Object.entries(values)) storage.set(key, JSON.parse(JSON.stringify(value)));
      },
    } } },
  });
  vm.runInContext(worker.slice(worker.indexOf("async function handleClipboardSourceStorage("), worker.indexOf("async function runClipboardOperation(")), context);
  context.chrome.runtime.sendMessage = async message => {
    try { return { ok: true, value: await context.handleClipboardSourceStorage(message, { id: "extension", url: "chrome-extension://extension/offscreen.html" }) }; }
    catch (error) { return { ok: false, code: error.code ?? "clipboard_source_storage_unavailable" }; }
  };
  vm.runInContext(offscreen.replace(/^import\s*\{[\s\S]*?\}\s*from\s*"[^"]+";\s*/u, ""), context);
  return { context, calls, storage, write: message => context.writeClipboardWithReceipt(message),
    lookup: message => context.readClipboardSourceReceipt({ sourceOperationId: message.operationId, ...message }),
    deliver: message => new Promise(resolve => listener(message, { id: "extension" }, resolve)),
  };
}

for (const formats of [undefined, [{ mimeType: "text/plain", dataBase64: "aGVsbG8=" }, { mimeType: "text/html", dataBase64: "PGI+aGVsbG88L2I+" }]]) {
  test(`clipboard ${formats ? "MIME" : "text"} persists terminal ACK before delivery and deduplicates across restart`, async () => {
    const fixture = clipboardFixture();
    const message = textMessage(formats ? { formats, optIn: true } : {});
    const results = await Promise.all([fixture.write(message), fixture.write(message)]);
    assert.equal(fixture.calls.length, 1);
    assert.equal(results[0].sourceReceipt.state, "completed");
    assert.equal(results[1].duplicateDelivery, true);
    assert.equal([...fixture.storage.values()][0].state, "completed");
    assert.ok(!JSON.stringify([...fixture.storage.values()]).includes(message.text));
    if (formats) for (const format of formats) assert.ok(!JSON.stringify([...fixture.storage.values()]).includes(format.dataBase64));
    const restarted = clipboardFixture({ storage: fixture.storage });
    const receipt = await restarted.lookup(message);
    assert.equal(receipt.found, true); assert.equal(receipt.state, "completed");
    assert.equal(receipt.pasteVerified, false); assert.equal(receipt.contentReturned, false);
    assert.equal((await restarted.write(message)).duplicateDelivery, true);
    assert.equal(restarted.calls.length, 0);
  });
}

test("clipboard crash after write but before terminal persist remains unknown and cannot write again", async () => {
  const fixture = clipboardFixture({ fault: 2 }); const message = textMessage();
  await assert.rejects(fixture.write(message), value => value.details.operationEffectState === "unknown" && value.details.mutationDispatchAttempted === true);
  assert.equal(fixture.calls.length, 1);
  const restarted = clipboardFixture({ storage: fixture.storage });
  assert.equal((await restarted.lookup(message)).state, "intent");
  await assert.rejects(restarted.write(message), { code: "clipboard_write_result_unknown" });
  assert.equal(restarted.calls.length, 0);
});

test("clipboard missing terminal ACK never invokes blind text copy fallback", async () => {
  const fixture = clipboardFixture({ writeFault: true }); const message = textMessage();
  await assert.rejects(fixture.write(message), { code: "clipboard_write_result_unknown" });
  await assert.rejects(fixture.write(message), { code: "clipboard_write_result_unknown" });
  assert.equal(fixture.calls.length, 1);
  assert.equal((await fixture.lookup(message)).state, "intent");
});

test("clipboard source hash/task/origin/generation mismatch cannot read or reuse another receipt", async () => {
  const fixture = clipboardFixture(); const message = textMessage(); await fixture.write(message);
  for (const changed of [{ taskId: "foreign" }, { generation: "other" }, { targetOrigin: "https://foreign.test" }, { payloadSha256: "0".repeat(64) }]) {
    await assert.rejects(fixture.lookup({ ...message, ...changed }), { code: "clipboard_source_binding_mismatch" });
  }
  await assert.rejects(fixture.write(textMessage({ text: "other" })), { code: "clipboard_source_binding_mismatch" });
  assert.equal(fixture.calls.length, 1);
  assert.equal((await fixture.lookup(textMessage({ operationId: "historical-unknown" }))).found, false);
});

test("clipboard intent storage failure prevents write and source payload mismatch prevents intent", async () => {
  const fixture = clipboardFixture({ fault: 1 });
  await assert.rejects(fixture.write(textMessage()), value => value.details.operationEffectState === "none");
  assert.equal(fixture.calls.length, 0);
  const invalid = clipboardFixture();
  await assert.rejects(invalid.write({ ...textMessage(), payloadSha256: "0".repeat(64) }), { code: "clipboard_payload_binding_mismatch" });
  assert.equal(invalid.storage.size, 0); assert.equal(invalid.calls.length, 0);
});

test("clipboard unresolved-intent capacity is finite without deleting intent or duplicate evidence", async () => {
  const fixture = clipboardFixture(); const original = textMessage(); await fixture.write(original);
  for (let index = 0; index < 512; index++) fixture.storage.set(`companion.clipboard.source.v1:op-${index}`, { state: "intent" });
  await assert.rejects(fixture.write(textMessage({ operationId: "op-new" })), value => value.code === "clipboard_source_capacity_reached" && value.details.operationEffectState === "none");
  assert.equal(fixture.calls.length, 1); assert.equal(fixture.storage.size, 513);
  const restarted = clipboardFixture({ storage: fixture.storage });
  assert.equal((await restarted.write(original)).duplicateDelivery, true);
  await assert.rejects(restarted.write(textMessage({ operationId: "op-new" })), { code: "clipboard_source_capacity_reached" });
  assert.equal(restarted.calls.length, 0); assert.equal(restarted.storage.size, 513);
});

test("clipboard completion compaction passes 512 writes while retaining every exact identity across restart", async () => {
  const fixture = clipboardFixture(), original = textMessage();
  await fixture.write(original);
  for (let index = 1; index <= 514; index++) await fixture.write(textMessage({ operationId: `done-${index}` }));
  assert.equal(fixture.calls.length, 515); assert.equal(fixture.storage.size, 515);
  const stored = fixture.storage.get("companion.clipboard.source.v1:op-source");
  assert.equal(stored.compacted, true); assert.equal(stored.ack, undefined);
  const restarted = clipboardFixture({ storage: fixture.storage });
  const receipt = await restarted.lookup(original), duplicate = await restarted.write(original);
  assert.equal(receipt.state, "completed"); assert.equal(receipt.compacted, true);
  assert.equal(receipt.writeAcknowledged, true); assert.equal(receipt.pasteVerified, false);
  assert.equal(duplicate.acknowledgedHistorical, true); assert.equal(duplicate.mutationDispatchAttempted, false);
  assert.equal(restarted.calls.length, 0);
  for (const change of [{ taskId: "other" }, { generation: "other" }, { targetOrigin: "https://other.test" }, { text: "changed" }])
    await assert.rejects(restarted.write(textMessage(change)), { code: "clipboard_source_binding_mismatch" });
  assert.equal(restarted.calls.length, 0);
});

test("clipboard compaction preserves unresolved intents byte for byte; compaction/quota errors precede a new write", async () => {
  const fixture = clipboardFixture(); await fixture.write(textMessage());
  const completed = fixture.storage.get("companion.clipboard.source.v1:op-source");
  const unknown = { schema: completed.schema, sourceBinding: { ...completed.sourceBinding, operationId: "unknown" }, state: "intent", intendedAt: "saved" };
  fixture.storage.set("companion.clipboard.source.v1:unknown", unknown);
  for (let index = 1; index < 511; index++) fixture.storage.set(`companion.clipboard.source.v1:done-${index}`,
    { ...completed, sourceBinding: { ...completed.sourceBinding, operationId: `done-${index}` } });
  const before = JSON.stringify(unknown);
  const failing = clipboardFixture({ storage: fixture.storage, fault: 1 });
  await assert.rejects(failing.write(textMessage({ operationId: "new" })), error => error.details.operationEffectState === "none");
  assert.equal(failing.calls.length, 0); assert.equal(fixture.storage.get("companion.clipboard.source.v1:op-source").ack.ok, true);
  await fixture.write(textMessage({ operationId: "new" }));
  assert.equal(JSON.stringify(fixture.storage.get("companion.clipboard.source.v1:unknown")), before);
  assert.equal((await fixture.lookup(textMessage({ operationId: "unknown" }))).state, "intent");
  await assert.rejects(fixture.write(textMessage({ operationId: "unknown" })), { code: "clipboard_write_result_unknown" });
  const quota = clipboardFixture(); quota.context.chrome.storage.local.QUOTA_BYTES = 100;
  await assert.rejects(quota.write(textMessage()), error => error.code === "clipboard_source_capacity_reached" && error.details.operationEffectState === "none");
  assert.equal(quota.calls.length, 0); assert.equal(quota.storage.size, 0);
  const readFailure = clipboardFixture(); readFailure.context.chrome.storage.local.getBytesInUse = async () => { throw Error("quota read failed"); };
  await assert.rejects(readFailure.write(textMessage()), error => error.details.operationEffectState === "none");
  assert.equal(readFailure.calls.length, 0);
});

test("worker metadata relay denies forged senders, arbitrary keys, payload contents and terminal overwrite", async () => {
  const fixture = clipboardFixture(); const message = textMessage(); const result = await fixture.write(message);
  const sourceBinding = result.sourceReceipt.sourceBinding;
  const request = { kind: "clipboard.source.storage", action: "get", key: `companion.clipboard.source.v1:${message.operationId}`, sourceBinding };
  const validSender = { id: "extension", url: "chrome-extension://extension/offscreen.html" };
  for (const sender of [{ ...validSender, id: "foreign" }, { ...validSender, tab: { id: 42 } },
    { ...validSender, url: "chrome-extension://extension/popup.html" }, { ...validSender, url: "https://editor.test" }]) {
    await assert.rejects(fixture.context.handleClipboardSourceStorage(request, sender), { code: "clipboard_source_storage_sender_invalid" });
  }
  await assert.rejects(fixture.context.handleClipboardSourceStorage({ ...request, key: "secret-setting" }, validSender), { code: "clipboard_source_storage_key_invalid" });
  await assert.rejects(fixture.context.handleClipboardSourceStorage({ ...request, sourceBinding: { ...sourceBinding, taskId: "foreign" } }, validSender), { code: "clipboard_source_binding_mismatch" });
  const newBinding = { ...sourceBinding, operationId: "new-source" };
  await assert.rejects(fixture.context.handleClipboardSourceStorage({ ...request, action: "set", key: "companion.clipboard.source.v1:new-source", sourceBinding: newBinding,
    value: { schema: "aos.chrome_companion.clipboard_source.v1", sourceBinding: newBinding, state: "intent", intendedAt: new Date().toISOString(), text: "secret" } }, validSender), { code: "clipboard_source_storage_value_invalid" });
  await assert.rejects(fixture.context.handleClipboardSourceStorage({ ...request, action: "set", value: result.sourceReceipt }, validSender), { code: "clipboard_source_storage_immutable" });
  const before = JSON.stringify([...fixture.storage.values()]);
  await assert.rejects(fixture.context.handleClipboardSourceStorage({ ...request, action: "set", value: {
    schema: "aos.chrome_companion.clipboard_source.v1", sourceBinding, state: "intent", intendedAt: new Date().toISOString(),
  } }, validSender), { code: "clipboard_source_storage_immutable" });
  await assert.rejects(fixture.context.handleClipboardSourceStorage({ ...request, action: "set", value: {
    ...result.sourceReceipt, ack: { ...result.sourceReceipt.ack, chars: result.sourceReceipt.ack.chars + 1 },
  } }, validSender), { code: "clipboard_source_storage_immutable" });
  assert.equal(JSON.stringify([...fixture.storage.values()]), before);
  assert.equal(fixture.calls.length, 1);
  assert.doesNotMatch(offscreen, /chrome\.storage/);
});

test("text clipboard service ACK is source-bound and lost ACK is inspectable without another write", async () => {
  const fixture = clipboardFixture();
  let loseAck = true;
  const context = vm.createContext({ crypto: webcrypto, TextEncoder, URL, MAX_CLIPBOARD_BINARY_BYTES: 2097152,
    companionError: error, requireOptionalPermission: async () => {}, ensureOffscreenClipboard: async () => {}, requireTabId: value => value,
    chrome: { tabs: { get: async () => ({ url: "https://editor.test/body" }) }, runtime: { sendMessage: async message => {
      if (message.kind === "offscreen.clipboard.receipt") return fixture.context.readClipboardSourceReceipt(message);
      const result = await fixture.write(message);
      if (loseAck) { loseAck = false; throw Error("transport ACK lost"); }
      return result;
    } } },
  });
  vm.runInContext(worker.slice(worker.indexOf("async function runClipboardOperation("), worker.indexOf("async function runBinaryClipboardOperation(")), context);
  const message = textMessage();
  await assert.rejects(context.runClipboardOperation("clipboard.write", message), { code: "clipboard_write_result_unknown" });
  const receipt = await context.runClipboardOperation("clipboard.receipt", { ...message, tabId: 42, sourceOperationId: message.operationId });
  assert.equal(receipt.state, "completed"); assert.equal(receipt.sourceBinding.payloadSha256, message.payloadSha256);
  assert.equal(fixture.calls.length, 1);
  const ack = await context.runClipboardOperation("clipboard.write", message);
  assert.equal(ack.duplicateDelivery, true); assert.equal(fixture.calls.length, 1);
});

function navigationFixture(tabs) {
  let calls = 0, injected = 0;
  const context = vm.createContext({ URL, Date, setTimeout, companionError: error,
    READ_API_TIMEOUT_MS: 1000, DEFAULT_NAVIGATION_TIMEOUT_MS: 1000,
    requireSafeUrl: value => value, withTimeout: promise => promise,
    chrome: { tabs: { get: async () => ({ ...tabs[Math.min(calls++, tabs.length - 1)] }) } },
    bindInjectionDocumentIdentity: value => value,
    executePageScriptWithReadRetry: async () => { injected++; return [{ frameId: 0, documentId: "doc", result: { pageInstanceId: "chrome-document:doc", url: tabs.at(-1).url, readyState: "complete" } }]; },
  });
  vm.runInContext(worker.slice(worker.indexOf("function originOf("), worker.indexOf("async function waitForTabSettled(")), context);
  return { context, calls: () => calls, injected: () => injected };
}

test("same-URL pending navigation blocks injection and read-only bounded commit wait observes later commit", async () => {
  const tab = { id: 42, windowId: 9, url: "https://editor.test/body" };
  const fixture = navigationFixture([{ ...tab, pendingUrl: tab.url }, { ...tab, pendingUrl: tab.url }, tab]);
  await assert.rejects(fixture.context.probeCommittedDocument(42), value => value.code === "document_target_changed"
    && value.details.documentProbeTarget.pendingUrlMatchesCommitted === true);
  assert.equal(fixture.injected(), 0);
  const committed = await fixture.context.waitForCommittedTab(42, { allowedOrigins: [tab.url], expectedWindowId: 9, timeoutMs: 500 });
  assert.equal(committed.id, 42); assert.equal(fixture.injected(), 1);
});

test("persistent pending URL has finite read-only timeout without stop/reload/mutation", async () => {
  const tab = { id: 42, windowId: 9, url: "https://editor.test/body", pendingUrl: "https://editor.test/body" };
  const fixture = navigationFixture([tab]);
  await assert.rejects(fixture.context.waitForCommittedTab(42, { allowedOrigins: [tab.url], timeoutMs: 100 }), { code: "navigation_commit_timeout" });
  assert.equal(fixture.injected(), 0); assert.ok(fixture.calls() <= 4);
});

function splitFixture({ body = "繰り返し😀文章。".repeat(1000), offset = 8, changed, unsupported = false } = {}) {
  let editor, caret;
  const paragraph = value => {
    const node = { nodeType: 1, tagName: "P", children: [], textContent: value, parentElement: null, isContentEditable: true, attributes: [] };
    node.text = { nodeType: 3, nodeValue: value, parentElement: node, parentNode: node };
    node.childNodes = [node.text]; node.contains = child => child === node || child === node.text;
    node.closest = () => node;
    Object.defineProperty(node, "outerHTML", { get: () => `<p>${node.textContent}</p>` });
    return node;
  };
  const initial = paragraph(body); if (unsupported) { const span = { nodeType: 1, tagName: "SPAN", attributes: [], childNodes: [] }; initial.children.push(span); initial.childNodes.push(span); }
  const tail = paragraph("unchanged outside");
  editor = { isContentEditable: true, isConnected: true, children: [initial, tail], contains: node => node === initial.text || node === initial,
    focus() {} };
  Object.defineProperty(editor, "childNodes", { get: () => editor.children });
  for (const node of editor.children) { node.parentElement = editor; node.parentNode = editor; }
  Object.defineProperty(editor, "textContent", { get: () => editor.children.map(node => node.textContent).join("") });
  Object.defineProperty(editor, "innerHTML", { get: () => editor.children.map(node => node.outerHTML).join("") });
  caret = { collapsed: true, startContainer: initial.text, startOffset: offset, cloneRange() { return { ...this }; } };
  let calls = 0;
  const context = vm.createContext({ getSelection: () => ({ rangeCount: 1, getRangeAt: () => caret }), operationError: error,
    find: () => editor, visualize: async () => { if (changed) caret.startOffset++; }, wait: async () => {}, location: { href: "https://editor.test" },
    richTextStructure: () => ({}), document: {
      createRange: () => ({ root: editor, end: null, start: null,
        selectNodeContents(node) { this.root = node; }, setEnd(node, offset) { this.end = [node, offset]; }, setStart(node, offset) { this.start = [node, offset]; },
        toString() { return this.end ? String(this.end[0].nodeValue ?? "").slice(0, this.end[1]) : this.root.textContent; },
        cloneContents() { const part = this.start ? body.slice(this.start[1]) : this.end ? body.slice(0, this.end[1]) : body; return { childNodes: part ? [{ nodeType: 3, nodeValue: part }] : [] }; },
      }),
      execCommand: command => {
        assert.equal(command, "insertParagraph"); calls++;
        const left = paragraph(body.slice(0, offset)), right = paragraph(body.slice(offset));
        editor.children = [left, right, tail]; for (const node of editor.children) node.parentElement = editor;
        caret = { ...caret, startContainer: right.text, startOffset: 0 }; return true;
      },
    },
  });
  const start = worker.indexOf('    if (payload.operation === "splitParagraph") {');
  const end = worker.indexOf("    const before = richTextStructure(element);", start);
  vm.runInContext(`async function run(payload) { let element = find(), richTextMutationAttempted = false; ${worker.slice(start, end)} }`, context);
  const expectedBody = editor.textContent;
  return { run: (overrides = {}) => context.run({ operation: "splitParagraph", expectedBody, expectedFullBody: expectedBody, expectedSelection: { start: offset, end: offset }, expectedCaret: { path: [0, 0], offset }, expectedEditorHtml: editor.innerHTML, ...overrides }), calls: () => calls, editor };
}

test("native paragraph split preserves long Japanese body and repeated text at an exact UTF-16 caret", async () => {
  const fixture = splitFixture(); const result = await fixture.run();
  assert.equal(result.paragraphSplitVerified, true); assert.equal(result.clipboardUsed, false);
  assert.equal(fixture.calls(), 1); assert.equal(fixture.editor.children.length, 3);
});

test("paragraph split rejects changed body/selection, surrogate interior and inline decorations before dispatch", async () => {
  for (const options of [{ changed: true }, { body: "a😀b", offset: 2 }, { unsupported: true }]) {
    const fixture = splitFixture(options); await assert.rejects(fixture.run()); assert.equal(fixture.calls(), 0);
  }
  const fixture = splitFixture(); await assert.rejects(fixture.run({ expectedBody: "other" }), { code: "rich_text_split_guard_required" });
  assert.equal(fixture.calls(), 0);
});
