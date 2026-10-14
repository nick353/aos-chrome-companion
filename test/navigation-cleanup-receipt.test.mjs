import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { TaskOperationLedger } from '../src/shared/task-runtime.mjs';

async function fixture(t) {
  const dir = await mkdtemp(join(tmpdir(), 'companion-cleanup-metadata-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  let now = Date.now();
  const options = { statePath: join(dir, 'ledger.json'), secret: 'fixture', now: () => now };
  const ledger = new TaskOperationLedger(options);
  await ledger.ready();
  const binding = { method: 'tabs.stopLoading', taskId: 'task', runId: 'run', sessionId: 'old-session',
    profileInstanceId: 'profile', generation: 'old-generation', tabId: 42,
    ownerKey: 'old-session', leaseId: 'lease', targetIdentity: { profileInstanceId: 'profile', tabId: 42, windowId: 1, origin: 'https://example.test' } };
  await ledger.prepare({ idempotencyKey: 'stop', fingerprint: 'fingerprint', binding });
  await ledger.transition('stop', 'dispatched', { operationId: 'original-stop', dispatchCount: 1, mutationDispatchAttempted: true });
  await ledger.transition('stop', 'unknown_effect', { result: { unchanged: true }, effectState: 'unknown_effect' });
  const annotate = (status, reason, changed = {}) => ledger.annotateDebuggerCleanup({ operationId: 'original-stop', binding, status, reason, ...changed });
  return { ledger, binding, annotate, options, advance: () => { now += 1000; } };
}

function nonMetadata(entry) {
  const { cleanupReceipt, updatedAt, ...rest } = structuredClone(entry);
  return rest;
}

test('cleanup annotation is serialized metadata only with exact original binding and bounded reasons', async t => {
  const { ledger, binding, annotate, advance } = await fixture(t);
  const before = nonMetadata(ledger.get('stop'));
  await assert.rejects(annotate('detached', 'detached'), { code: 'debugger_cleanup_pending_missing' });
  await annotate('pending');
  for (const field of ['taskId', 'sessionId', 'profileInstanceId', 'generation', 'tabId', 'runId', 'leaseId']) {
    await assert.rejects(annotate('detached', 'detached', { binding: { ...binding, [field]: 'foreign' } }), { code: 'debugger_cleanup_binding_mismatch' });
  }
  await assert.rejects(annotate('detached', 'release_threw'), { code: 'debugger_cleanup_status_invalid' });
  await assert.rejects(annotate('not_required', 'shared_operation_active'), { code: 'debugger_cleanup_status_invalid' });
  advance();
  const receipt = await annotate('reconciliation_required', 'https://secret.test/raw-error');
  assert.equal(receipt.reason, 'release_not_verified');
  assert.equal(JSON.stringify(receipt).includes('https://'), false);
  assert.deepEqual(nonMetadata(ledger.get('stop')), before);
  assert.equal(ledger.get('stop').state, 'unknown_effect');
});

test('cleanup exact terminal duplicates are idempotent and timeout cannot be silently replaced', async t => {
  const { ledger, annotate, advance } = await fixture(t);
  await annotate('pending');
  const receipt = await annotate('reconciliation_required', 'release_timeout');
  advance();
  assert.deepEqual(await annotate('reconciliation_required', 'release_timeout'), receipt);
  await assert.rejects(annotate('detached', 'detached'), { code: 'debugger_cleanup_terminal_conflict' });
  assert.deepEqual(ledger.get('stop').cleanupReceipt, receipt);
});

test('worker-loss pending and reconciliation cleanup survive restart and terminal GC', async t => {
  const { ledger, annotate, options } = await fixture(t);
  await annotate('pending');
  const pending = ledger.get('stop').cleanupReceipt;
  ledger.close();
  const restarted = new TaskOperationLedger(options);
  await restarted.ready();
  assert.deepEqual(restarted.get('stop').cleanupReceipt, pending);
  // Known stop effect does not prove debugger detach.
  await restarted.prepare({ idempotencyKey: 'known', fingerprint: 'known', binding: restarted.get('stop').binding });
  await restarted.transition('known', 'dispatched', { operationId: 'known-stop' });
  await restarted.annotateDebuggerCleanup({ operationId: 'known-stop', binding: restarted.get('known').binding, status: 'pending' });
  await restarted.transition('known', 'applied');
  await restarted.gcTerminal({ now: Date.now() + 100_000, retentionMs: 1 });
  assert.ok(restarted.get('known'));
  await restarted.annotateDebuggerCleanup({ operationId: 'known-stop', binding: restarted.get('known').binding,
    status: 'reconciliation_required', reason: 'shared_operation_active' });
  await restarted.gcTerminal({ now: Date.now() + 100_000, retentionMs: 1 });
  assert.ok(restarted.get('known'));
});
