import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import test from "node:test";

test("MV3 Companion reconnects on browser activity and keeps a watchdog alive", async () => {
  const source = await readFile(resolve("extension/service-worker.js"), "utf8");

  assert.match(source, /WATCHDOG_PERIOD_MINUTES/);
  assert.match(source, /function ensureWatchdogAlarm\(\)/);
  assert.match(source, /function requestReconnect\(\{ force = false \} = \{\}\)/);
  assert.match(source, /function detachNativePort\(\)/);
  assert.match(source, /chrome\.tabs\.onActivated\.addListener\(\(\) => requestReconnect\(\)\)/);
  assert.match(source, /chrome\.runtime\.onConnect\.addListener\(\(\) => requestReconnect\(\)\)/);
  assert.match(source, /requestReconnect\(\{ force: true \}\)/);
  assert.match(source, /message\.kind === "setup\.status"/);
  assert.match(source, /setupState/);
  assert.match(source, /chrome\.storage\.session\.get\(\["extensionRuntimeId"\]\)/);
  assert.match(source, /chrome\.storage\.session\.set\(\{ extensionRuntimeId \}\)/);
  assert.match(source, /runtimeState\.extensionRuntimeId \?\?= await getExtensionRuntimeId\(\)/);
  assert.match(source, /case "extension\.reload"/);
  assert.match(source, /chrome\.runtime\.reload\(\)/);
  assert.match(source, /async function rotateExtensionRuntimeId\(\)/);
  assert.match(source, /await rotateExtensionRuntimeId\(\)/);
  assert.match(source, /extension_build_id_mismatch/);
  assert.match(source, /reloadScheduled/);
});

test("MV3 Companion never posts through an unguarded native port", async () => {
  const source = await readFile(resolve("extension/service-worker.js"), "utf8");

  assert.match(source, /function markNativePortDisconnected\(port, message\)/);
  assert.match(source, /function postNativeMessage\(message, \{ port = runtimeState\.port \} = \{\}\)/);
  assert.match(source, /catch \(error\) \{\n    const detail = error instanceof Error \? error\.message : String\(error\);\n    markNativePortDisconnected\(port, detail(?:, \{ phase: "postMessage" \})?\);/);
  assert.doesNotMatch(source, /runtimeState\.port\?\.postMessage\(/);
  assert.equal((source.match(/\bport\.postMessage\(/g) ?? []).length, 1, "only the guarded helper may call port.postMessage");
  assert.match(source, /const commandPort = runtimeState\.port;/);
  assert.match(source, /kind: "command\.result",[\s\S]*?\}, \{ port: commandPort \}\);/);
  assert.match(source, /function sendCommandError\(operationId, code, message, details, \{ port = runtimeState\.port, executionTiming \} = \{\}\)/);
  assert.match(source, /replyPort: commandPort/);
  assert.match(source, /native_port_send_failed/);
});

// Model Chrome's documented Port behavior: local disconnect does NOT emit
// onDisconnect locally. Execute the real connection functions, not a regex.
const workerSource = await readFile(resolve("extension/service-worker.js"), "utf8");
const { default: vm } = await import("node:vm");
test("new-tab and tab-update listeners preserve reconnection and notify the existing observer", () => {
  const listeners = {}, seen = []; let reconnects = 0;
  const context = { chrome: { tabs: { onCreated: { addListener: fn => { listeners.created = fn; } }, onUpdated: { addListener: fn => { listeners.updated = fn; } } } },
    pageObservations: { tabCreated: tab => seen.push(['created', tab]), tabUpdated: (tabId, tab) => seen.push(['updated', tabId, tab]) },
    requestReconnect: () => reconnects++ };
  vm.runInNewContext(workerSource.split('\n').filter(line => line.startsWith('chrome.tabs.onCreated.addListener') || line.startsWith('chrome.tabs.onUpdated.addListener((tabId, _change, tab)')).join('\n'), context);
  const tab = { id: 8, openerTabId: 7 }; listeners.created(tab); listeners.updated(8, {}, tab);
  assert.equal(reconnects, 1); assert.deepEqual(seen, [['created', tab], ['updated', 8, tab]]);
});
function connectionHarness() {
  const timers = new Map(), timerDelays = new Map(), ports = [], dialogStops = [], persisted = []; let nextTimer = 0, retries = 0;
  const ctx = { Date, runtimeState: { port: null, connected: false, connecting: false, profileInstanceId: "p", extensionRuntimeId: "r", generation: "g", disconnectHistory: [], reloadScheduled: false },
    commandAssembler: { clear() {} }, accessibilityHistory:{clear(){}}, pageObservations:{stopAll:async()=>{}}, viewportControls:{stopAll:async()=>{}}, javaScriptDialogs:{stopAll:async reason=>dialogStops.push(reason)}, scheduleReconnect: () => { retries++; },
    setTimeout: (fn, delay) => { const id = ++nextTimer; timers.set(id, fn); timerDelays.set(id, delay); return id; }, clearTimeout: id => { timers.delete(id); timerDelays.delete(id); },
    NATIVE_HOST_NAME: "test", PROTOCOL_VERSION: "1", INSTALL_BUILD_ID: "b", OPERATION_SCHEMA: "schema", OPERATION_SCHEMA_DIGEST: "digest", OPERATION_SCHEMA_VERSION: 1, CAPABILITIES_DIGEST: "caps", CAPABILITIES: [], MAX_DISCONNECT_HISTORY: 20, DISCONNECT_HISTORY_KEY: "disconnectHistory",
    chrome: { storage: { local: { set(value) { persisted.push(value); return Promise.resolve(); } } }, runtime: { connectNative() {
      const port = { disconnected: false, onMessage: { addListener(fn) { port.message = fn; } }, onDisconnect: { addListener(fn) { port.remoteDisconnect = fn; } }, postMessage() {}, disconnect() { this.disconnected = true; } };
      ports.push(port); return port;
    } } }, companionError: (code,message) => Object.assign(new Error(message), { code }) };
  vm.createContext(ctx);
  const functions = workerSource.slice(workerSource.indexOf('function detachNativePort('), workerSource.indexOf('async function handleNativeMessage('));
  const handler = workerSource.slice(workerSource.indexOf('async function handleNativeMessage('), workerSource.indexOf('  if (message.kind !== "command.request") return;')) + '\n}';
  vm.runInContext(workerSource.match(/^const NATIVE_HELLO_TIMEOUT_MS = .*;$/m)[0] + '\n' + functions + handler, ctx);
  return { ctx, ports, timers, timerDelays, dialogStops, persisted, retries: () => retries };
}

test("disconnect diagnostics survive reconnect and retain bounded context", async () => {
  const f = connectionHarness();
  await f.ctx.connectNative();
  f.ctx.markNativePortDisconnected(f.ports[0], "", { phase: "port.onDisconnect", plannedReload: true });
  await new Promise(resolve => setImmediate(resolve));
  const record = f.ctx.runtimeState.disconnectHistory.at(-1);
  assert.equal(record.reason, "Native Messaging port disconnected");
  assert.equal(record.phase, "port.onDisconnect");
  assert.equal(record.profileInstanceId, "p");
  assert.equal(record.generation, "g");
  assert.equal(record.plannedReload, true);
  assert.equal(f.persisted.at(-1).disconnectHistory.at(-1).reason, record.reason);
  await f.ctx.connectNative();
  assert.equal(f.ctx.runtimeState.disconnectHistory.at(-1).generation, "g");
});

test("a cold native host can acknowledge after the former five-second cutoff within the broker startup window", async () => {
  const f = connectionHarness(); await f.ctx.connectNative();
  const timeout = f.timerDelays.get(f.ctx.runtimeState.helloTimer);
  assert.ok(timeout >= 15000 && timeout <= 30000, 'hello must accommodate bounded broker startup and auth, while remaining finite');
  for (const [id, delay] of f.timerDelays) if (delay <= 6000) f.timers.get(id)();
  assert.equal(f.ports[0].disconnected, false); assert.equal(f.retries(), 0);
  await f.ctx.handleNativeMessage({ kind: "extension.hello_ack", generation: "cold-start-gen", operationSchema: "schema", operationSchemaDigest: "digest", operationSchemaVersion: 1, capabilitiesDigest: "caps" });
  assert.equal(f.ctx.runtimeState.connected, true); assert.equal(f.ctx.runtimeState.generation, "cold-start-gen"); assert.equal(f.timers.size, 0);
});

test("hello timeout clears connecting and permits another attempt without a local disconnect event", async () => {
  const f = connectionHarness(); await f.ctx.connectNative();
  assert.equal(f.ctx.runtimeState.connecting, true);
  f.timers.get(f.ctx.runtimeState.helloTimer)();
  assert.equal(f.ctx.runtimeState.connecting, false);
  assert.equal(f.ctx.runtimeState.port, null);
  assert.equal(f.ports[0].disconnected, true);
  assert.equal(f.retries(), 1);
  assert.deepEqual(f.dialogStops, ["native_port_disconnected"]);
  await f.ctx.connectNative();
  assert.equal(f.ports.length, 2);
  assert.equal(f.ctx.runtimeState.port, f.ports[1]);
});

test("a schema rejection tears down the failed handshake and a subsequent hello can connect", async () => {
  const f = connectionHarness(); await f.ctx.connectNative();
  await f.ctx.handleNativeMessage({ kind: "peer.error", error: { code: "companion_operation_schema_digest_mismatch", message: "schema differs" } });
  assert.equal(f.ctx.runtimeState.connecting, false); assert.equal(f.ports[0].disconnected, true); assert.equal(f.retries(), 1);
  assert.deepEqual(f.dialogStops, ["native_port_disconnected"]);
  await f.ctx.connectNative();
  await f.ctx.handleNativeMessage({ kind: "extension.hello_ack", generation: "new-gen", operationSchema: "schema", operationSchemaDigest: "digest", operationSchemaVersion: 1, capabilitiesDigest: "caps" });
  assert.equal(f.ctx.runtimeState.connected, true); assert.equal(f.ctx.runtimeState.connecting, false); assert.equal(f.ctx.runtimeState.generation, "new-gen");
  assert.equal(f.timers.size, 0);
});
