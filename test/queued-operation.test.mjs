import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import test from 'node:test';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { CompanionBroker } from '../src/broker/broker.mjs';
import { BrokerClient, withBrokerRequestSignal } from '../src/client/broker-client.mjs';
import { connectPeer } from '../src/client/connect.mjs';
import { ensureBrokerSecret } from '../src/shared/security.mjs';
import { createAuthorityEnvelope, ensureIssuerSecret } from '../src/shared/task-runtime.mjs';
import { DEFAULT_CAPABILITIES, PROTOCOL_VERSION } from '../src/shared/constants.mjs';
import { INSTALL_BUILD_ID } from '../src/shared/build-info.mjs';

const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
const deferred = () => { let resolve; const promise = new Promise(done => { resolve = done; }); return { promise, resolve }; };
async function until(predicate, message) {
  for (let index = 0; index < 400; index += 1) { if (predicate()) return; await delay(10); }
  assert.fail(message);
}

async function fixture(t, { holdResponse = false, authorityTtlMs = 60_000, operationTimeoutMs = 5000 } = {}) {
  const root = await mkdtemp(join(tmpdir(), 'aos-queued-'));
  const env = { ...process.env, AOS_CHROME_COMPANION_DATA_DIR: root,
    AOS_CHROME_COMPANION_SOCKET: join(root, 'broker.sock'), AOS_CHROME_COMPANION_SECRET_FILE: join(root, 'secret'),
    AOS_CHROME_COMPANION_CODEX_MCP_ISSUER_SECRET_FILE: join(root, 'issuer'),
    AOS_CHROME_COMPANION_HANDOFF_RECEIPTS_DIR: join(root, 'handoffs') };
  const secret = await ensureBrokerSecret(env), issuerSecret = await ensureIssuerSecret('codex_mcp', env);
  const broker = new CompanionBroker({ socketPath: env.AOS_CHROME_COMPANION_SOCKET, secret,
    issuerSecrets: { codex_mcp: issuerSecret }, statePath: join(root, 'ledger.json'), handoffReceiptsDir: env.AOS_CHROME_COMPANION_HANDOFF_RECEIPTS_DIR });
  let extension, client;
  const gate = deferred();
  const responseGate = deferred();
  if (!holdResponse) responseGate.resolve();
  t.after(async () => { gate.resolve(); responseGate.resolve(); client?.close(); extension?.close(); await broker.close(); await rm(root, { recursive: true, force: true }); });
  await broker.listen();
  extension = await connectPeer({ role: 'extension-relay', autoStart: false, env });
  const ack = deferred();
  const off = extension.onMessage(message => { if (message.kind === 'extension.hello_ack') { off(); ack.resolve(); } });
  extension.send({ kind: 'extension.hello', protocolVersion: PROTOCOL_VERSION, profileInstanceId: 'queued-profile',
    extensionRuntimeId: 'queued-runtime', buildId: INSTALL_BUILD_ID, capabilities: DEFAULT_CAPABILITIES });
  await ack.promise;
  const commands = [];
  let text = 'unchanged Japanese 本文';
  extension.onMessage(async message => {
    if (message.kind !== 'command.request') return;
    commands.push(message);
    if (message.method === 'page.type') text = message.params.text;
    await responseGate.promise;
    if (message.method === 'tabs.list') { extension.send({ kind: 'command.result', operationId: message.operationId, result: [] }); return; }
    extension.send({ kind: 'command.result', operationId: message.operationId, result: { typed: true, value: text } });
  });
  client = await BrokerClient.connect({ autoStart: false, env, issuer: 'codex_mcp' });
  const requests = [], send = client.peer.send.bind(client.peer);
  client.peer.send = message => { requests.push(message); return send(message); };
  const taskId = 'queued-owner', runId = 'queued-run', tabId = 44, origin = 'https://queued.example.test';
  const session = await client.request('session.open', { taskId });
  const tracked = await broker.taskLedger.recordTaskTab({ profileInstanceId: session.profileInstanceId, generation: session.generation,
    taskId, runId, tabId, sessionId: session.sessionId, retentionPolicy: 'retain', lifecycleState: 'executing' });
  broker.taskTabs.set(`${session.profileInstanceId}:${tabId}`, tracked);
  const lease = await client.request('lease.acquire', { sessionId: session.sessionId, tabId });
  broker.operationQueues.set(`tab:${session.profileInstanceId}:${tabId}`, gate.promise);
  const prepared = deferred(), originalPrepare = broker.taskLedger.prepare.bind(broker.taskLedger);
  broker.taskLedger.prepare = async args => { const value = await originalPrepare(args); if (args.idempotencyKey === 'queued-action') prepared.resolve(); return value; };
  const params = { tabId, locator: { testId: 'editor' }, text: 'must not arrive after cancellation', allowedOrigins: [origin], targetOrigin: origin };
  const authority = createAuthorityEnvelope({ issuer: 'codex_mcp', secret: issuerSecret, runId, taskId, ownerKey: session.sessionId,
    method: 'page.type', intent: 'page.type', targetOrigin: origin, idempotencyKey: 'queued-action', payload: params, approved: true, ttlMs: authorityTtlMs });
  const start = options => client.request('operation.execute', { sessionId: session.sessionId, leaseId: lease.leaseId,
    method: 'page.type', params, authority, taskOwnedRequired: true, timeoutMs: operationTimeoutMs }, options)
    .then(value => ({ value }), error => ({ error }));
  return { broker, client, env, session, lease, gate, responseGate, prepared, commands, requests, authority, start, text: () => text };
}

for (const boundary of ['caller_timeout', 'caller_cancel', 'session_closed', 'lease_released', 'peer_disconnected', 'generation_changed', 'task_tab_transferred']) test(`queued mutation never dispatches after ${boundary}`, { timeout: 10_000 }, async t => {
  const f = await fixture(t);
  const controller = new AbortController();
  const pending = f.start({ timeoutMs: boundary === 'caller_timeout' ? 300 : 5000, signal: controller.signal });
  await f.prepared.promise;
  if (boundary === 'caller_timeout') {
    const result = await pending;
    assert.match(result.error?.code ?? '', /timeout|deadline/u);
  } else if (boundary === 'caller_cancel') {
    controller.abort();
    assert.equal((await pending).error?.code, 'broker_request_cancelled');
  } else if (boundary === 'session_closed') {
    await f.client.request('session.close', { sessionId: f.session.sessionId, taskTerminal: false });
  } else if (boundary === 'lease_released') {
    await f.client.request('lease.release', { leaseId: f.lease.leaseId });
  } else if (boundary === 'peer_disconnected') {
    f.client.close();
    await until(() => !f.broker.sessions.has(f.session.sessionId), 'disconnected session must be removed');
  } else if (boundary === 'generation_changed') {
    f.broker.profiles.get(f.session.profileInstanceId).generation += 1;
  } else {
    const key = `${f.session.profileInstanceId}:44`;
    const transferred = { ...f.broker.taskTabs.get(key), taskId: 'different-owner', runId: 'different-run' };
    f.broker.taskTabs.set(key, transferred);
    await f.broker.taskLedger.recordTaskTab(transferred);
  }
  f.gate.resolve();
  await pending;
  await until(() => f.broker.operationQueues.size === 0 && f.broker.pendingOperations.size === 0, 'the queue must drain');
  assert.equal(f.commands.filter(command => command.method === 'page.type').length, 0, `${boundary} must prevent later browser input`);
  assert.equal(f.text(), 'unchanged Japanese 本文');
  const operation = f.broker.taskLedger.get('queued-action');
  assert.equal(operation.dispatchCount, 0); assert.equal(operation.mutationDispatchAttempted, false);
  assert.equal(operation.dispatchState, 'not_dispatched'); assert.equal(operation.effectState, 'no_dispatch');
});

test('the envelope deadline prevents late dispatch even if the cancellation packet is lost', { timeout: 10_000 }, async t => {
  const f = await fixture(t);
  const send = f.client.peer.send.bind(f.client.peer);
  f.client.peer.send = message => message.method === 'request.cancel' ? undefined : send(message);
  const pending = f.start({ timeoutMs: 300 });
  await f.prepared.promise;
  await pending;
  await until(() => f.broker.taskLedger.get('queued-action').state === 'blocked', 'deadline must retire the queued operation before its predecessor finishes');
  f.gate.resolve();
  await until(() => f.broker.operationQueues.size === 0, 'expired marker must drain');
  assert.equal(f.commands.length, 0);
});

for (const boundary of ['caller_cancel', 'lease_released']) test(`dispatch persistence does not reopen the ${boundary} race`, { timeout: 10_000 }, async t => {
  const f = await fixture(t);
  const persisted = deferred(), continueDispatch = deferred();
  t.after(() => continueDispatch.resolve());
  const transition = f.broker.taskLedger.transition.bind(f.broker.taskLedger);
  f.broker.taskLedger.transition = async (...args) => {
    const result = await transition(...args);
    if (args[0] === 'queued-action' && args[1] === 'dispatched') { persisted.resolve(); await continueDispatch.promise; }
    return result;
  };
  const controller = new AbortController();
  f.gate.resolve();
  const pending = f.start({ signal: controller.signal });
  await persisted.promise;
  if (boundary === 'caller_cancel') {
    controller.abort();
    await until(() => [...f.broker.activeRequests.values()].some(context => context.controller.signal.aborted), 'broker must receive cancellation');
  } else await f.client.request('lease.release', { leaseId: f.lease.leaseId });
  continueDispatch.resolve();
  await pending;
  await until(() => f.broker.taskLedger.get('queued-action').state === 'blocked', 'reservation must become no-dispatch');
  assert.equal(f.commands.length, 0);
  const entry = f.broker.taskLedger.get('queued-action');
  assert.equal(entry.dispatchCount, 0); assert.equal(entry.mutationDispatchAttempted, false);
  assert.equal(entry.dispatchState, 'not_dispatched'); assert.equal(entry.dispatchedAt, null);
});

test('expired signed authority cannot acquire a late queue slot', { timeout: 10_000 }, async t => {
  const f = await fixture(t, { authorityTtlMs: 500 });
  const pending = f.start();
  await f.prepared.promise;
  await delay(Math.max(1, Date.parse(f.authority.expiresAt) - Date.now() + 20));
  f.gate.resolve();
  assert.equal((await pending).error?.code, 'authority_expired');
  assert.equal(f.commands.length, 0);
  assert.equal(f.broker.taskLedger.get('queued-action').dispatchCount, 0);
});

test('another authenticated client cannot cancel an owned request', { timeout: 10_000 }, async t => {
  const f = await fixture(t), other = await BrokerClient.connect({ autoStart: false, env: f.env });
  t.after(() => other.close());
  const pending = f.start(); await f.prepared.promise;
  const requestId = f.requests.find(message => message.method === 'operation.execute').id;
  assert.deepEqual(await other.request('request.cancel', { requestId }), { cancelled: false });
  f.gate.resolve();
  assert.equal((await pending).value?.typed, true);
  assert.equal(f.commands.length, 1);
});

test('cancelled queue markers preserve order while later same-tab reads remain usable', { timeout: 10_000 }, async t => {
  const f = await fixture(t), controller = new AbortController();
  const pending = f.start({ signal: controller.signal }); await f.prepared.promise;
  controller.abort(); await pending;
  const read = f.client.request('operation.execute', { sessionId: f.session.sessionId, leaseId: f.lease.leaseId,
    method: 'page.snapshot', params: { tabId: 44 } });
  await delay(50);
  assert.equal(f.commands.length, 0, 'later read must wait for the original ordering barrier');
  f.gate.resolve(); await read;
  assert.deepEqual(f.commands.map(command => command.method), ['page.snapshot']);
  assert.equal(f.text(), 'unchanged Japanese 本文');
});

test('cancelling after browser dispatch preserves the original result without replay', { timeout: 10_000 }, async t => {
  const f = await fixture(t, { holdResponse: true }), controller = new AbortController();
  f.gate.resolve();
  const pending = f.start({ signal: controller.signal });
  await until(() => f.commands.length === 1, 'browser command must dispatch');
  controller.abort(); assert.equal((await pending).error?.code, 'broker_request_cancelled');
  assert.equal(f.broker.taskLedger.get('queued-action').state, 'dispatched');
  f.responseGate.resolve();
  await until(() => f.broker.taskLedger.get('queued-action').state === 'applied' && f.broker.activeRequests.size === 0, 'original result must be recorded after caller cancellation');
  assert.equal(f.commands.length, 1); assert.equal(f.broker.taskLedger.get('queued-action').dispatchCount, 1);
  assert.equal(f.broker.taskLedger.get('queued-action').effectState, 'known_effect');
});

test('a pre-cancelled MCP request scope sends no work but permits its own release', { timeout: 10_000 }, async t => {
  const f = await fixture(t), controller = new AbortController();
  controller.abort();
  const before = f.requests.length;
  await withBrokerRequestSignal(controller.signal, async () => {
    assert.equal((await f.start()).error?.code, 'broker_request_cancelled');
    assert.equal(f.requests.length, before);
    await f.client.request('lease.release', { leaseId: f.lease.leaseId });
  });
  assert.equal(f.broker.leases.has(f.lease.leaseId), false);
  assert.equal(f.broker.taskLedger.get('queued-action'), undefined);
});

test('real MCP cancellation reaches the broker queue and does not create a tab later', { timeout: 15_000 }, async t => {
  const f = await fixture(t);
  f.broker.operationQueues.delete(`tab:${f.session.profileInstanceId}:44`);
  f.broker.operationQueues.set(`profile:${f.session.profileInstanceId}`, f.gate.promise);
  const transport = new StdioClientTransport({ command: process.execPath, args: [resolve('src/mcp/server.mjs')],
    cwd: resolve('.'), env: { ...f.env, CODEX_THREAD_ID: 'mcp-cancel-owner' }, stderr: 'pipe' });
  const client = new Client({ name: 'queue-cancellation-test', version: '1' });
  t.after(async () => { await client.close(); await transport.close(); });
  await client.connect(transport);
  const opened = await client.callTool({ name: 'companion_open_session', arguments: { profileInstanceId: f.session.profileInstanceId } });
  assert.notEqual(opened.isError, true, JSON.stringify(opened));
  const sessionId = opened.structuredContent.result.sessionId;
  const controller = new AbortController();
  const pending = client.callTool({ name: 'companion_authorized_transaction', arguments: {
    sessionId, runId: 'mcp-cancel-run', idempotencyKey: 'mcp-cancel-action',
    startUrl: 'https://queued.example.test/form', allowedOrigins: ['https://queued.example.test'],
    actions: [{ method: 'page.type', params: { locator: { testId: 'editor' }, text: 'cancelled MCP text' } }],
  } }, undefined, { signal: controller.signal }).then(value => ({ value }), error => ({ error }));
  await until(() => f.broker.taskLedger.listOperations().some(entry => entry.binding?.taskId === 'mcp-cancel-owner' && entry.binding.method === 'tabs.create'), 'MCP transaction must reach the broker profile queue');
  const beforeCancellation = f.commands.length;
  controller.abort(); assert.ok((await pending).error);
  await until(() => f.broker.taskLedger.listOperations().some(entry => entry.binding?.taskId === 'mcp-cancel-owner' && entry.state === 'blocked'), 'SDK cancellation must reach the broker');
  f.gate.resolve();
  await until(() => f.broker.operationQueues.size === 0 && f.broker.activeRequests.size === 0, 'cancelled MCP queue must drain');
  assert.equal(f.commands.length, beforeCancellation);
  assert.equal(f.commands.filter(command => command.method === 'tabs.create').length, 0);
  const operation = f.broker.taskLedger.listOperations().find(entry => entry.binding?.taskId === 'mcp-cancel-owner');
  assert.equal(operation.dispatchCount, 0); assert.equal(operation.mutationDispatchAttempted, false);
  assert.equal(operation.effectState, 'no_dispatch');
});

for (const boundary of ['operation_timeout', 'peer_disconnected']) test(`dispatched local input stays unknown after ${boundary} until its authentic late result`, { timeout: 10_000 }, async t => {
  const f = await fixture(t, { holdResponse: true, operationTimeoutMs: 100 });
  f.gate.resolve();
  const pending = f.start();
  await until(() => f.commands.length === 1, 'input must reach the browser');
  assert.equal(f.text(), 'must not arrive after cancellation');
  if (boundary === 'peer_disconnected') f.client.close();
  await pending;
  await until(() => f.broker.taskLedger.get('queued-action').state !== 'dispatched', 'missing result must settle as unknown');
  const operation = f.broker.taskLedger.get('queued-action');
  assert.equal(operation.state, 'unknown_effect'); assert.equal(operation.effectState, 'unknown_effect');
  assert.equal(operation.reconciliationRequired, false, 'local uncertainty is not an external provider gate');
  assert.equal(f.broker.snapshot().reconciliationPendingCount, 0);
  f.responseGate.resolve();
  await until(() => f.broker.taskLedger.get('queued-action').state === 'reconciled', 'authentic late result must reconcile without replay');
  assert.equal(f.broker.taskLedger.get('queued-action').effectState, 'known_effect');
  assert.equal(f.commands.length, 1);
});
