import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import vm from 'node:vm';
import { CompanionBroker } from '../src/broker/broker.mjs';
import { BrokerClient } from '../src/client/broker-client.mjs';
import { connectPeer } from '../src/client/connect.mjs';
import { ensureBrokerSecret } from '../src/shared/security.mjs';
import { ensureIssuerSecret } from '../src/shared/task-runtime.mjs';
import { DEFAULT_CAPABILITIES, PROTOCOL_VERSION } from '../src/shared/constants.mjs';
import { INSTALL_BUILD_ID } from '../src/shared/build-info.mjs';
import { createUserControls } from '../extension/user-controls.js';
import { executeWithExpectedDialog } from '../extension/action-event-wait.js';

const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
const origin = 'https://timing.example.test';
const profileInstanceId = 'timing-profile';
const deferred = () => { let resolve; const promise = new Promise(done => { resolve = done; }); return { promise, resolve }; };

async function fixture(t, { failQuery = false } = {}) {
  const root = await mkdtemp(join(tmpdir(), 'aos-timing-'));
  const env = { ...process.env, AOS_CHROME_COMPANION_DATA_DIR: root,
    AOS_CHROME_COMPANION_SOCKET: join(root, 'broker.sock'), AOS_CHROME_COMPANION_SECRET_FILE: join(root, 'secret'),
    AOS_CHROME_COMPANION_CODEX_MCP_ISSUER_SECRET_FILE: join(root, 'issuer'),
    AOS_CHROME_COMPANION_HANDOFF_RECEIPTS_DIR: join(root, 'handoffs') };
  const secret = await ensureBrokerSecret(env), issuerSecret = await ensureIssuerSecret('codex_mcp', env);
  const broker = new CompanionBroker({ socketPath: env.AOS_CHROME_COMPANION_SOCKET, secret,
    issuerSecrets: { codex_mcp: issuerSecret }, statePath: join(root, 'ledger.json'), handoffReceiptsDir: env.AOS_CHROME_COMPANION_HANDOFF_RECEIPTS_DIR });
  let extension, client;
  t.after(async () => { client?.close(); extension?.close(); await broker.close(); await rm(root, { recursive: true, force: true }); });
  await broker.listen();
  extension = await connectPeer({ role: 'extension-relay', autoStart: false, env });
  const ack = deferred();
  const off = extension.onMessage(message => { if (message.kind === 'extension.hello_ack') { off(); ack.resolve(); } });
  extension.send({ kind: 'extension.hello', protocolVersion: PROTOCOL_VERSION, profileInstanceId,
    extensionRuntimeId: 'timing-runtime', buildId: INSTALL_BUILD_ID, capabilities: DEFAULT_CAPABILITIES });
  await ack.promise;
  const tabs = new Map(), commands = [];
  let nextTab = 800;
  extension.onMessage(async message => {
    if (message.kind !== 'command.request') return;
    commands.push(message);
    const { method, params, operationId } = message;
    const reply = (result, executionTiming) => extension.send({ kind: 'command.result', operationId, result, executionTiming });
    if (method === 'tabs.list') return reply([...tabs.values()]);
    if (method === 'tabs.create') {
      await delay(45);
      const tab = { id: ++nextTab, url: params.url, title: message.taskId, windowId: 1, active: false, pinned: false };
      tabs.set(tab.id, tab);
      return reply(tab, { total: 30, tab_create: 12, task_group: 18, secret: 'never-export-native-extras' });
    }
    const tab = tabs.get(params.tabId);
    if (method === 'tabs.close') { tabs.delete(params.tabId); return reply({ closed: true, tabId: params.tabId }); }
    if (method === 'page.snapshot') return reply({ url: tab.url, title: tab.title, text: 'fixture text', pageInstanceId: `document-${tab.id}` });
    if (method === 'page.screenshot') return reply({ kind: 'screenshot', url: tab.url, pageInstanceId: `document-${tab.id}`, tabId: tab.id, mimeType: 'image/png', dataBase64: Buffer.from('fixture visual').toString('base64') });
    if (method === 'page.query' && failQuery) {
      extension.send({ kind: 'command.error', operationId, executionTiming: { total: -3, tab_create: 'private-value', task_group: 700000, unexpected: 'never-export-error-extras' },
        error: { code: 'semantic_locator_not_found', message: 'controlled failure', details: { operationEffectState: 'none', mutationDispatchAttempted: false } } });
      return;
    }
    return reply({ found: true, text: tab?.title ?? 'read result' });
  });
  client = await BrokerClient.connect({ autoStart: false, env, issuer: 'codex_mcp' });
  const run = async (taskId, method = 'page.query') => {
    const session = await client.request('session.open', { taskId });
    return client.requestAuthorizedTransaction({ sessionId: session.sessionId, taskId, runId: `run-${taskId}`, idempotencyKey: `idem-${taskId}`,
      startUrl: `${origin}/${taskId}`, targetOrigin: origin, allowedOrigins: [origin], actions: [{ method, params: {} }] });
  };
  return { broker, run, commands };
}

test('transaction timing separates controlled ledger, queue and relay delays and keeps concurrent tasks separate', { timeout: 15_000 }, async t => {
  const f = await fixture(t), prepared = deferred(), releaseQueue = deferred();
  f.broker.operationQueues.set(`profile:${profileInstanceId}`, releaseQueue.promise);
  const originalPrepare = f.broker.taskLedger.prepare.bind(f.broker.taskLedger);
  f.broker.taskLedger.prepare = async args => {
    if (args.binding.method === 'tabs.create' && args.binding.taskId === 'timing-a') {
      await delay(60);
      const result = await originalPrepare(args);
      prepared.resolve();
      return result;
    }
    return originalPrepare(args);
  };
  const originalTransition = f.broker.taskLedger.transition.bind(f.broker.taskLedger);
  f.broker.taskLedger.transition = async (key, state, details) => {
    const entry = f.broker.taskLedger.get(key);
    if (entry?.binding?.method === 'tabs.create' && entry.binding.taskId === 'timing-a') {
      if (state === 'dispatched') await delay(50);
      if (state === 'applied') await delay(70);
    }
    return originalTransition(key, state, details);
  };
  const first = f.run('timing-a');
  await prepared.promise;
  const second = f.run('timing-b', 'page.waitFor');
  await delay(100);
  releaseQueue.resolve();
  const [a, b] = await Promise.all([first, second]);
  assert.equal(a.result, 'verified', JSON.stringify(a.exact_blocker)); assert.equal(b.result, 'verified', JSON.stringify(b.exact_blocker));
  const create = a.operation_timing.operations.find(row => row.method === 'tabs.create');
  for (const [key, minimum] of Object.entries({ prepare: 55, queue: 90, dispatch_persist: 45, transport_and_extension: 40, completion_persist_and_ownership: 65 })) {
    assert.ok(create.timings_ms[key] >= minimum, `${key}: ${create.timings_ms[key]}`);
  }
  assert.deepEqual(create.extension_timings_ms, { total: 30, tab_create: 12, task_group: 18 });
  assert.equal(create.queue_scope, 'profile');
  assert.equal(create.outcome, 'returned');
  assert.equal(a.operation_timing.truncated, false);
  assert.ok(a.operation_timing.operations.some(row => row.method === 'page.query'));
  assert.ok(!a.operation_timing.operations.some(row => row.method === 'page.waitFor'));
  assert.ok(b.operation_timing.operations.some(row => row.method === 'page.waitFor'));
  assert.ok(!b.operation_timing.operations.some(row => row.method === 'page.query'));
  const text = JSON.stringify([a.operation_timing, b.operation_timing]);
  for (const forbidden of ['never-export', origin, 'timing-a', 'timing-b', 'params', 'idempotencyKey']) assert.ok(!text.includes(forbidden), forbidden);
  assert.equal(f.commands.filter(command => command.method === 'tabs.create').length, 2, 'measurement never adds a browser call');
});

test('an operation error keeps its timing and ignores invalid or unrecognized extension timing data', { timeout: 10_000 }, async t => {
  const f = await fixture(t, { failQuery: true });
  const result = await f.run('timing-error');
  assert.equal(result.result, 'blocked');
  const failed = result.operation_timing.operations.find(row => row.method === 'page.query');
  assert.equal(failed.outcome, 'error');
  assert.equal(failed.error_code, 'semantic_locator_not_found');
  assert.ok(failed.timings_ms.transport_and_extension >= 0);
  assert.equal(failed.extension_timings_ms, undefined);
  assert.equal(f.commands.filter(command => command.method === 'page.query').length, 1);
});

const source = await readFile(new URL('../extension/service-worker.js', import.meta.url), 'utf8');
for (const failed of [false, true]) test(`native dispatcher reports tab phases on ${failed ? 'failure' : 'success'} without changing the result`, async () => {
  const replies = [], stages = [];
  const tab = { id: 71, url: `${origin}/`, windowId: 1, groupId: 3 };
  const mark = async name => { stages.push(name); await delay(5); };
  const context = { performance, executeWithExpectedDialog, javaScriptDialogs: null, runtimeState: { port: {}, profileInstanceId: 'p', generation: 'g' }, MUTATION_OPERATION_METHODS: new Set(['tabs.create']),
    userControls: createUserControls({ storage: { local: { get: async () => ({}) } } }),
    postNativeMessage: message => replies.push(message), requireSafeUrl: value => value,
    waitForCommittedTab: async () => { await mark('navigation_commit'); return tab; },
    assertLiveOrigin: async () => { await mark('origin_check'); },
    ensureTaskGroup: async () => { await mark('task_group'); if (failed) throw Object.assign(Error('controlled grouping failure'), { code: 'test_group_failure' }); return 3; },
    sanitizeTab: value => value,
    chrome: { tabs: { create: async () => { await mark('tab_create'); return tab; }, get: async () => { await mark('tab_readback'); return tab; } } } };
  vm.createContext(context);
  vm.runInContext(source.slice(source.indexOf('async function handleNativeMessage('), source.indexOf('\nfunction companionError('))
    + source.slice(source.indexOf('async function executeCommand('), source.indexOf('\nasync function runAndCheckMutation(')), context);
  await context.handleNativeMessage({ kind: 'command.request', profileInstanceId: 'p', generation: 'g', operationId: 'one', taskId: 'owner',
    method: 'tabs.create', params: { url: `${origin}/`, executionTiming: { forged: 'never-trust-caller-timing' } } });
  const response = replies.find(message => message.kind === (failed ? 'command.error' : 'command.result'));
  assert.ok(response, JSON.stringify(replies));
  assert.ok(response.executionTiming.total >= 15);
  for (const key of ['tab_create', 'navigation_commit', 'origin_check']) assert.ok(response.executionTiming[key] >= 3, key);
  assert.equal(response.executionTiming.forged, undefined);
  if (failed) {
    assert.equal(response.error.code, 'test_group_failure');
    assert.equal(response.error.details.createdTabId, 71);
    assert.ok(!stages.includes('tab_readback'));
  } else {
    assert.deepEqual(JSON.parse(JSON.stringify(response.result)), tab);
    assert.ok(response.executionTiming.task_group >= 3);
    assert.ok(response.executionTiming.tab_readback >= 3);
  }
});
