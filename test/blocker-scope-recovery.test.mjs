import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import test from 'node:test';
import { BrokerClient } from '../src/client/broker-client.mjs';
import { blockerRecoveryContext, unresolvedLocalNavigationForTarget } from '../src/shared/task-runtime.mjs';
import { transactionTextSummary } from '../src/mcp/result.mjs';

function peer(handler) {
  const messages = new Set(), closes = new Set();
  let closed = false;
  return {
    send(request) {
      if (closed) throw new Error('closed');
      handler(request, result => queueMicrotask(() => messages.forEach(fn => fn({ id: request.id, ok: true, result }))));
    },
    onMessage(fn) { messages.add(fn); return () => messages.delete(fn); },
    onClose(fn) { closes.add(fn); return () => closes.delete(fn); },
    close() { if (!closed) { closed = true; closes.forEach(fn => fn()); } },
  };
}

function harness(t, profiles = [{ profileInstanceId: 'p', connected: true }], openHandler) {
  const calls = [];
  let connects = 0;
  const handler = (request, reply) => {
    calls.push(request);
    if (request.method === 'status.get') reply({ profiles });
    else if (request.method === 'session.open') {
      if (openHandler) openHandler(request, reply);
      else reply({ sessionId: 's', taskId: request.params.taskId, profileInstanceId: request.params.profileInstanceId });
    }
  };
  const client = new BrokerClient(peer(handler), { autoStart: false, connectPeerFactory: async () => { connects++; return peer(handler); } });
  t.after(() => client.close());
  client.peer.close();
  return { client, calls, connects: () => connects };
}

test('disconnected session creation obtains fresh unique profile and dispatches once', async t => {
  const { client, calls, connects } = harness(t);
  const session = await client.request('session.open', { taskId: 'mine' });
  assert.equal(session.profileInstanceId, 'p');
  assert.deepEqual(calls.map(call => call.method), ['status.get', 'session.open']);
  assert.equal(calls[1].params.taskId, 'mine');
  assert.equal(calls[1].params.profileInstanceId, 'p');
  assert.equal(connects(), 1);
});

test('disconnected session binds requested profile and never selects a foreign profile', async t => {
  const { client, calls } = harness(t, [{ profileInstanceId: 'foreign', connected: true }]);
  await assert.rejects(client.request('session.open', { taskId: 'mine', profileInstanceId: 'original' }), { code: 'profile_not_connected' });
  assert.deepEqual(calls.map(call => call.method), ['status.get']);
});

test('session creation validates returned task/profile and never repeats mismatched readback', async t => {
  const { client, calls, connects } = harness(t, undefined, (_request, reply) =>
    reply({ sessionId: 'foreign-session', taskId: 'foreign', profileInstanceId: 'p' }));
  await assert.rejects(client.request('session.open', { taskId: 'mine' }), { code: 'session_recovery_owner_readback_mismatch' });
  assert.equal(client.openedSessions.size, 0);
  assert.equal(calls.filter(call => call.method === 'session.open').length, 1);
  assert.equal(connects(), 1);
});

test('disconnected session rejects ambiguous profiles and absent task before dispatch', async t => {
  const { client, calls } = harness(t, [{ profileInstanceId: 'p', connected: true }, { profileInstanceId: 'other', connected: true }]);
  await assert.rejects(client.request('session.open', {}), { code: 'session_recovery_binding_missing' });
  assert.equal(calls.length, 0);
  await assert.rejects(client.request('session.open', { taskId: 'mine' }), { code: 'session_recovery_profile_ambiguous' });
  assert.deepEqual(calls.map(call => call.method), ['status.get']);
});

test('session timeout after dispatch neither reconnects nor repeats creation', async t => {
  const { client, calls, connects } = harness(t, undefined, () => {});
  // Keep this tiny request alive while the production deadline timer is unref'd.
  const keepAlive = setTimeout(() => {}, 1000);
  t.after(() => clearTimeout(keepAlive));
  await assert.rejects(client.request('session.open', { taskId: 'mine' }, { timeoutMs: 25 }), { code: 'broker_request_timeout' });
  assert.equal(calls.filter(call => call.method === 'session.open').length, 1);
  assert.equal(connects(), 1);
});

test('connection loss after session dispatch never reopens the session', async t => {
  const { client, calls, connects } = harness(t, undefined, () => client.peer.close());
  await assert.rejects(client.request('session.open', { taskId: 'mine' }), { code: 'broker_connection_closed' });
  assert.equal(calls.filter(call => call.method === 'session.open').length, 1);
  assert.equal(connects(), 1);
});

test('disconnected page read and mutation require recovery without sending', async t => {
  const { client, calls, connects } = harness(t);
  for (const [method, params] of [
    ['operation.execute', { method: 'page.snapshot', sessionId: 's', params: { tabId: 7 } }],
    ['task.transaction', { sessionId: 's', runId: 'run' }],
  ]) await assert.rejects(client.request(method, params), { code: 'broker_reconnect_required' });
  assert.equal(calls.length, 0);
  assert.equal(connects(), 0);
});

test('session recovery does not extend the original caller deadline', async t => {
  const { client, calls } = harness(t);
  t.mock.timers.enable({ apis: ['Date'] });
  const started = Date.now();
  await client.request('session.open', { taskId: 'mine' }, { timeoutMs: 1000 });
  assert.ok(calls[0].deadlineAt <= started + 1000);
  assert.equal(calls[1].deadlineAt, started + 1000);
});

test('target reconciliation identifies only its task/run/tab and allows independent work', () => {
  const context = blockerRecoveryContext({ code: 'reconciliation_required', taskId: 'mine', runId: 'run',
    profileInstanceId: 'p', tabId: 7, targetKey: 'target', nextAction: 'signed_same_target_readback' });
  assert.equal(context.block_scope, 'target');
  assert.equal(context.independent_work_allowed, true);
  assert.deepEqual(context.affected_target, { task_id: 'mine', run_id: 'run', profile_instance_id: 'p', tab_id: 7,
    target_key: `target_sha256:${createHash('sha256').update('target', 'utf8').digest('hex')}` });
  assert.equal(context.next_action, 'signed_same_target_readback');
  assert.equal(transactionTextSummary({ schema: 'aos.chrome_companion.transaction.v1', ...context }).block_scope, 'target');
});

test('shared profile and task blockers disclose exact scope without global reconciliation stop', () => {
  const base = { taskId: 'mine', runId: 'run', profileInstanceId: 'p', tabId: 7, nextAction: 'fresh_status' };
  const profile = blockerRecoveryContext({ ...base, code: 'session_generation_stale' });
  assert.equal(profile.block_scope, 'profile');
  assert.equal(profile.affected_target.profile_instance_id, 'p');
  assert.equal(profile.affected_target.tab_id, null);
  assert.equal(profile.independent_work_allowed, true);
  const task = blockerRecoveryContext({ ...base, code: 'source_handoff_implementation_forbidden' });
  assert.equal(task.block_scope, 'task');
  assert.equal(task.affected_target.task_id, 'mine');
  assert.equal(task.affected_target.run_id, null);
  const transport = blockerRecoveryContext({ ...base, code: 'broker_connection_closed' });
  assert.equal(transport.block_scope, 'broker_connection');
  assert.equal(transport.independent_work_allowed, false);
});

test('public affected target hashes complete URL, query, locator and arbitrary keys without exposing fragments', () => {
  const base = { code: 'reconciliation_required', taskId: 'mine', runId: 'run', profileInstanceId: 'p', tabId: 7,
    nextAction: 'signed_same_target_readback' };
  const keys = [
    'url:https://private.test/path?secret=hidden#arbitrary',
    'query:input[name="hidden"] arbitrary text',
    'locator:{"css":"#hidden","text":"arbitrary"}',
    'explicit arbitrary key with hidden provider data 😀',
    'arbitrary'.repeat(2_000) + ':hidden-first',
    'arbitrary'.repeat(2_000) + ':hidden-second',
  ];
  const projectedKeys = keys.map(targetKey => {
    const context = blockerRecoveryContext({ ...base, targetKey });
    const projected = context.affected_target.target_key;
    assert.equal(projected, `target_sha256:${createHash('sha256').update(targetKey, 'utf8').digest('hex')}`);
    assert.equal(projected, blockerRecoveryContext({ ...base, targetKey }).affected_target.target_key);
    assert.match(projected, /^target_sha256:[a-f0-9]{64}$/u);
    const json = JSON.stringify(context);
    for (const fragment of ['https://', 'hidden', 'arbitrary', 'private.test', 'locator:', 'query:']) assert.ok(!json.includes(fragment));
    assert.equal(context.block_scope, 'target');
    assert.equal(context.affected_target.task_id, 'mine');
    assert.equal(context.affected_target.tab_id, 7);
    assert.equal(context.independent_work_allowed, true);
    assert.equal(context.next_action, base.nextAction);
    return projected;
  });
  assert.equal(new Set(projectedKeys).size, keys.length);
  for (const targetKey of [null, undefined]) assert.equal(blockerRecoveryContext({ ...base, targetKey }).affected_target.target_key, null);
  for (const code of ['session_generation_stale', 'source_handoff_implementation_forbidden', 'broker_connection_closed']) {
    assert.equal(blockerRecoveryContext({ ...base, code, targetKey: keys[0] }).affected_target.target_key, null);
  }
});

test('navigation guard is physical-target scoped and only existing verified reconciliation releases it', () => {
  const navigation = { state: 'unknown_effect', effectState: 'unknown_effect',
    binding: { method: 'tabs.reload', profileInstanceId: 'p', tabId: 7, taskId: 'original', runId: 'original-run' } };
  const target = { profileInstanceId: 'p', tabId: 7, taskId: 'different', runId: 'different' };
  assert.equal(unresolvedLocalNavigationForTarget([navigation], target).length, 1);
  assert.equal(unresolvedLocalNavigationForTarget([{ ...navigation, binding: { ...navigation.binding, method: 'tabs.navigate' } }], target).length, 1);
  assert.equal(unresolvedLocalNavigationForTarget([navigation], { ...target, tabId: 8 }).length, 0);
  assert.equal(unresolvedLocalNavigationForTarget([navigation], { ...target, profileInstanceId: 'other' }).length, 0);
  assert.equal(unresolvedLocalNavigationForTarget([{ ...navigation, binding: { ...navigation.binding, method: 'page.type' } }], target).length, 0);
  assert.equal(unresolvedLocalNavigationForTarget([{ ...navigation, state: 'reconciled', effectState: 'known_effect' }], target).length, 1);
  assert.equal(unresolvedLocalNavigationForTarget([{ ...navigation, state: 'reconciled', effectState: 'known_effect', brokerEvidence: true, resultDigest: 'original-bound-proof' }], target).length, 0);
});
