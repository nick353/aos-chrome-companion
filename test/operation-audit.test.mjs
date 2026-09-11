import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { CompanionBroker } from '../src/broker/broker.mjs';
import { BrokerClient } from '../src/client/broker-client.mjs';
import { connectPeer } from '../src/client/connect.mjs';
import { ensureBrokerSecret } from '../src/shared/security.mjs';
import { createAuthorityEnvelope, ensureIssuerSecret, normalizeTaskExecutionCapsule } from '../src/shared/task-runtime.mjs';
import { DEFAULT_CAPABILITIES, PROTOCOL_VERSION } from '../src/shared/constants.mjs';
import { INSTALL_BUILD_ID } from '../src/shared/build-info.mjs';
import { normalizeOperationAudit, operationAuditPage, taskStatusPayload } from '../src/shared/operation-audit.mjs';

const taskId = 'owned-audit-task', runId = 'audit-run';
async function fixture(t) {
  const root = await mkdtemp(join(tmpdir(), 'aos-audit-'));
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
  const ack = new Promise(resolve => { const off = extension.onMessage(message => { if (message.kind === 'extension.hello_ack') { off(); resolve(); } }); });
  extension.send({ kind: 'extension.hello', protocolVersion: PROTOCOL_VERSION, profileInstanceId: 'audit-profile',
    extensionRuntimeId: 'audit-runtime', buildId: INSTALL_BUILD_ID, capabilities: DEFAULT_CAPABILITIES });
  await ack;
  const commands = [];
  extension.onMessage(message => { if (message.kind === 'command.request') commands.push(message); });
  client = await BrokerClient.connect({ autoStart: false, env, issuer: 'codex_mcp' });
  const session = await client.request('session.open', { taskId });
  async function seed(owner, prefix, count = 1, boundRunId = runId) {
    const capsule = normalizeTaskExecutionCapsule({ taskId: owner, runId: boundRunId, capsuleId: `${prefix}-capsule`,
      startUrl: 'https://audit.example.test/', state: 'completed', profileInstanceId: session.profileInstanceId, generation: session.generation,
      effect: { idempotencyKey: prefix }, blocker: { code: 'synthetic_fixture', message: `${owner}-private-capsule-canary` } });
    await broker.taskLedger.putTaskCapsule(capsule);
    for (let index = 0; index < count; index += 1) {
      const key = `${prefix}:${index}`;
      await broker.taskLedger.prepare({ idempotencyKey: key, fingerprint: `${owner}-fingerprint`,
        binding: { taskId: owner, runId: boundRunId, method: index % 2 ? 'page.type' : 'page.click', profileInstanceId: session.profileInstanceId,
          generation: session.generation, tabId: 44, targetIdentity: { origin: 'https://audit.example.test', pageInstanceId: 'document-a', frameId: 0 } } });
      await broker.taskLedger.transition(key, 'dispatched');
      await broker.taskLedger.transition(key, 'applied', { brokerEvidence: true, resultDigest: `${owner}-digest`,
        result: { text: `${owner}-private-operation-canary`, dataBase64: 'private-bytes' }, authority: { secret: 'private-authority-canary' } });
    }
    return capsule;
  }
  const status = extra => client.requestTaskStatus({ sessionId: session.sessionId, taskId, runId, ...extra });
  return { broker, client, session, seed, status, commands, env, issuerSecret };
}

for (const mismatch of ['operation', 'capsule']) test(`status rejects an individually foreign ${mismatch} even when the other record belongs to the signed task`, async t => {
  const f = await fixture(t);
  await f.seed(taskId, 'own'); await f.seed('foreign-task', 'foreign');
  await assert.rejects(f.status({ idempotencyKey: mismatch === 'operation' ? 'foreign:0' : 'own:0',
    capsuleId: mismatch === 'capsule' ? 'foreign-capsule' : 'own-capsule' }), { code: 'task_status_not_found' });
  assert.equal(f.commands.length, 0);
});

test('audit pagination is owner/run scoped, excludes new preparations, filters metadata and never dispatches browser work', { timeout: 15_000 }, async t => {
  const f = await fixture(t);
  await f.seed(taskId, 'history', 23);
  await f.seed('foreign-task', 'foreign', 2);
  await f.seed(taskId, 'different-run', 2, 'another-run');
  const first = await f.status({ audit: { limit: 5 } });
  assert.equal(first.audit.matchedCount, 23); assert.equal(first.audit.returnedCount, 5); assert.ok(first.audit.nextCursor);
  const initialCursor = first.audit.nextCursor;
  await f.seed(taskId, 'newer', 1);
  const entries = [...first.audit.entries];
  let cursor = initialCursor;
  while (cursor) {
    const page = await f.status({ audit: { limit: 7, cursor } });
    assert.equal(page.audit.matchedCount, 23);
    entries.push(...page.audit.entries); cursor = page.audit.nextCursor;
  }
  assert.equal(entries.length, 23); assert.equal(new Set(entries.map(entry => entry.idempotencyKey)).size, 23);
  assert.ok(entries.every(entry => entry.idempotencyKey.startsWith('history:')));
  assert.ok(entries.every(entry => entry.target.tabId === 44 && entry.target.origin === 'https://audit.example.test'));
  const text = JSON.stringify(entries);
  for (const marker of ['private-operation-canary', 'private-authority-canary', 'private-bytes', 'foreign-task', 'different-run']) assert.ok(!text.includes(marker), marker);
  const filtered = await f.status({ audit: { method: 'page.type', state: 'applied', tabId: 44 } });
  assert.equal(filtered.audit.returnedCount, 11);
  assert.ok(filtered.audit.entries.every(entry => entry.method === 'page.type' && entry.state === 'applied'));
  for (const audit of [{ cursor: initialCursor, method: 'page.type' },
    { cursor: initialCursor.slice(0, -1) + (initialCursor.endsWith('0') ? '1' : '0') }]) {
    await assert.rejects(f.status({ audit }), { code: 'operation_audit_cursor_invalid' });
  }
  await assert.rejects(f.status({ runId: 'another-run', audit: { cursor: initialCursor } }), { code: 'operation_audit_cursor_invalid' });
  assert.equal((await f.status({ audit: {} })).audit.matchedCount, 24);
  assert.equal(f.commands.length, 0);
});

test('status rejects a Codex session owned by a different task and mismatched same-run transaction records', async t => {
  const f = await fixture(t);
  await f.seed(taskId, 'first'); await f.seed(taskId, 'second');
  await assert.rejects(f.status({ idempotencyKey: 'first:0', capsuleId: 'second-capsule' }), { code: 'task_status_not_found' });
  await assert.rejects(f.status({ idempotencyKey: 'first:0', capsuleId: 'missing-capsule' }), { code: 'task_status_not_found' });
  const foreignSession = await f.client.request('session.open', { taskId: 'another-owner' });
  await assert.rejects(f.status({ sessionId: foreignSession.sessionId, audit: {} }), { code: 'task_id_mismatch' });
  assert.equal((await f.status({ idempotencyKey: 'first:0', capsuleId: 'first-capsule' })).operation_state, 'applied');
  assert.equal(f.commands.length, 0);
});

test('an audit can read operation-only or empty history without claiming continuation or a known effect', async t => {
  const f = await fixture(t);
  const result = await f.status({ runId: 'empty-run', audit: {} });
  assert.equal(result.result, 'audit_readback'); assert.equal(result.continuation_allowed, false); assert.equal(result.effect_state, null);
  assert.equal(result.audit.returnedCount, 0); assert.equal(result.audit.nextCursor, null);
  await assert.rejects(f.status({ runId: 'empty-run' }), { code: 'task_status_not_found' });
  await f.broker.taskLedger.prepare({ idempotencyKey: 'only-operation', fingerprint: 'only-operation', binding: { taskId, runId: 'empty-run', method: 'tabs.create' } });
  const populated = await f.status({ runId: 'empty-run', audit: {} });
  assert.equal(populated.audit.returnedCount, 1); assert.equal(populated.audit.entries[0].target.tabId, null);
  assert.equal(populated.continuation_allowed, false); assert.equal(f.commands.length, 0);
});

test('audit filters cannot be changed after signing and a same-task tab from another run is not a retained target', async t => {
  const f = await fixture(t), capsule = await f.seed(taskId, 'bound');
  const payload = taskStatusPayload({ taskId, runId, audit: { method: 'page.type' } });
  const authority = createAuthorityEnvelope({ issuer: 'codex_mcp', secret: f.issuerSecret, runId, taskId,
    ownerKey: f.session.sessionId, method: 'task.status', intent: 'reconcile_status', targetOrigin: '*',
    idempotencyKey: 'tamper-test', payload, approved: true });
  await assert.rejects(f.client.request('task.status', { ...payload, sessionId: f.session.sessionId,
    audit: { method: 'page.click' }, authority }), { code: 'authority_payload_tampered' });
  await f.broker.taskLedger.putTaskCapsule({ ...capsule, resources: { ...capsule.resources, tabId: 44 }, target: { ...capsule.target, tabId: 44 } });
  await f.broker.taskLedger.recordTaskTab({ profileInstanceId: f.session.profileInstanceId, generation: f.session.generation,
    tabId: 44, taskId, runId: 'a-different-run', lifecycleState: 'completed' });
  const status = await f.status({ capsuleId: capsule.capsuleId });
  assert.equal(status.ledger_tab_present, false); assert.equal(status.target_identity_consistent, null); assert.equal(status.tab_retention, null);
  assert.equal(f.commands.length, 0);
});

test('audit payload signs filters and bounds; default status preserves its old signature shape', () => {
  assert.deepEqual(taskStatusPayload({ taskId, runId }), { taskId, runId, idempotencyKey: null, capsuleId: null });
  const first = taskStatusPayload({ taskId, runId, audit: { method: 'page.type' } });
  assert.deepEqual(first.audit, { limit: 20, method: 'page.type' });
  for (const invalid of [{ limit: 0 }, { limit: 101 }, { limit: 1.5 }, { secret: true }, { tabId: -1 }, { cursor: 'x'.repeat(2049) }, { method: 'bad method' }, { state: 'invented' }]) {
    assert.throws(() => normalizeOperationAudit(invalid), { code: 'operation_audit_invalid' });
  }
});

test('large metadata stops at its byte bound and oversize opaque identifiers are omitted with an explicit digest', () => {
  const operations = Array.from({ length: 100 }, (_, index) => ({ idempotencyKey: `key-${index}-` + 'x'.repeat(4000),
    operationId: `operation-${index}-` + 'x'.repeat(4000), preparedAt: '2026-01-01T00:00:00.000Z', state: 'applied',
    binding: { taskId, runId, method: 'page.click' } }));
  const first = operationAuditPage({ operations, taskId, runId, secret: 'test', audit: { limit: 100 } });
  assert.ok(first.metadataBytes <= 256 * 1024); assert.ok(first.returnedCount > 0 && first.returnedCount < 100); assert.ok(first.nextCursor);
  const all = [...first.entries]; let cursor = first.nextCursor;
  while (cursor) { const page = operationAuditPage({ operations, taskId, runId, secret: 'test', audit: { cursor, limit: 100 } }); all.push(...page.entries); cursor = page.nextCursor; }
  assert.equal(all.length, 100); assert.equal(new Set(all.map(entry => entry.idempotencyKey)).size, 100);
  const oversized = operationAuditPage({ operations: [{ ...operations[0], idempotencyKey: 'x'.repeat(5000) }], taskId, runId, secret: 'test', audit: {} });
  assert.equal(oversized.entries[0].idempotencyKey, null);
  assert.equal(oversized.entries[0].omittedIdentifiers.idempotencyKey.reason, 'identifier_exceeds_metadata_limit');
  assert.match(oversized.entries[0].omittedIdentifiers.idempotencyKey.sha256, /^[a-f0-9]{64}$/u);
});
