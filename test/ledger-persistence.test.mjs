import assert from 'node:assert/strict';
import { mkdtemp, readFile, writeFile, appendFile, rm, stat, symlink } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import test from 'node:test';
import { spawn } from 'node:child_process';
import { TaskOperationLedger } from '../src/shared/task-runtime.mjs';
async function fixture(t, saved = {}) {
  const root = await mkdtemp(join(tmpdir(), 'aos-ledger-delta-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const statePath = join(root, 'ledger.json');
  await writeFile(statePath, JSON.stringify({ schema: 'aos.chrome_companion.operation_ledger.v1', ...saved }));
  const ledger = new TaskOperationLedger({ statePath });
  await ledger.ready();
  return { root, statePath, ledger, journal: `${statePath}.journal` };
}
const operation = (key) => ({ idempotencyKey: key, fingerprint: key, binding: { tabId: 1 } });
const CRASH_FIXTURE_OPERATION_COUNT = 1_000;
const CRASH_KILL_AFTER_ACKNOWLEDGED = 50;
const CRASH_CHECKPOINTS_REQUIRED = 1;
test('legacy history stays intact while transitions and nonces append small durable deltas', async (t) => {
  const operations = Array.from({ length: 9400 }, (_, n) => ({ ...operation(`old-${n}`), state: 'applied', result: 'x'.repeat(2000) }));
  const { ledger, statePath, journal } = await fixture(t, { operations });
  const before = await readFile(statePath);
  const added = await ledger.prepare(operation('new'));
  await ledger.transition('new', 'dispatched');
  await ledger.transition('new', 'applied', { result: { saved: true } });
  await ledger.consumeAuthority({ authorityId: 'auth', nonce: 'nonce' });
  assert.ok(ledger.persistenceMetrics.lastBytes < 1000);
  assert.equal(ledger.persistenceMetrics.mode, 'journal');
  assert.ok((await stat(journal)).size < 5000);
  assert.deepEqual(await readFile(statePath), before);
  const restored = new TaskOperationLedger({ statePath });
  await restored.ready();
  assert.equal(restored.listOperations().length, 9401);
  assert.equal(restored.get('new').operationId, added.operationId);
  assert.equal(restored.get('new').state, 'applied');
  assert.deepEqual(restored.get('new').result, { saved: true });
  await assert.rejects(restored.consumeAuthority({ authorityId: 'auth', nonce: 'nonce' }), /already consumed/);
  assert.equal((await stat(journal)).mode & 0o777, 0o600);
});
test('task-tab deletions and profile updates survive restart', async (t) => {
  const { ledger, statePath } = await fixture(t, { taskTabs: [{ profileInstanceId: 'p', tabId: 42, state: 'task_tab' }] });
  assert.equal(await ledger.removeTaskTab('p', 42), true);
  await ledger.recordProfileBinding({ profileInstanceId: 'p', extensionRuntimeId: 'ext', generation: 'gen' });
  const restored = new TaskOperationLedger({ statePath });
  await restored.ready();
  assert.equal(restored.getTaskTab('p', 42), null);
  assert.equal(restored.getProfileBinding('p').generation, 'gen');
});
test('terminal garbage collection removes only old safe records and preserves unknown effects', async (t) => {
  const old = new Date(Date.now() - 2 * 24 * 60 * 60_000).toISOString();
  const { ledger } = await fixture(t, { operations: [
    { idempotencyKey: 'safe-old', operationId: 'op-safe-old', state: 'applied', updatedAt: old, binding: { taskId: 'task-a', runId: 'run-a' } },
    { idempotencyKey: 'unknown-old', operationId: 'op-unknown-old', state: 'unknown_effect', updatedAt: old, binding: { taskId: 'task-a', runId: 'run-a' } },
    { idempotencyKey: 'safe-new', operationId: 'op-safe-new', state: 'applied', updatedAt: new Date().toISOString(), binding: { taskId: 'task-a', runId: 'run-a' } },
  ] });
  const result = await ledger.gcTerminal({ now: Date.now(), retentionMs: 24 * 60 * 60_000 });
  assert.equal(result.operations, 1);
  assert.deepEqual(result.operationKeys, ['safe-old']);
  assert.deepEqual(result.taskTabKeys, []);
  assert.deepEqual(result.capsuleKeys, []);
  assert.equal(ledger.get('safe-old'), undefined);
  assert.equal(ledger.get('unknown-old').state, 'unknown_effect');
  assert.equal(ledger.get('safe-new').state, 'applied');
});

test('terminal GC retains unresolved capsules, referenced operations, and reports exact deletion keys', async (t) => {
  const old = new Date(Date.now() - 2 * 24 * 60 * 60_000).toISOString();
  const { ledger } = await fixture(t, {
    operations: [
      { idempotencyKey: 'delete-me', operationId: 'op-delete-me', state: 'applied', updatedAt: old },
      { idempotencyKey: 'unknown', operationId: 'op-unknown', state: 'applied', effectState: 'unknown_effect', updatedAt: old },
      { idempotencyKey: 'reconcile', operationId: 'op-reconcile', state: 'reconciled', reconciliationRequired: true, updatedAt: old },
      { idempotencyKey: 'referenced', operationId: 'op-referenced', state: 'blocked', binding: { taskId: 'task-open', runId: 'run-open' }, updatedAt: old },
      { idempotencyKey: 'task-tab:profile:7', state: 'task_tab', profileInstanceId: 'profile', tabId: 7, taskId: 'task-done', runId: 'run-done', lifecycleState: 'completed', updatedAt: old },
    ],
    taskCapsules: [
      { schema: 'aos.chrome_companion.task_execution_capsule.v1', capsuleId: 'failed-unknown', taskId: 'task-failed', runId: 'run-failed', state: 'failed', updatedAt: old, effect: { effectState: 'unknown_effect' } },
      { schema: 'aos.chrome_companion.task_execution_capsule.v1', capsuleId: 'failed-reconcile', taskId: 'task-failed', runId: 'run-reconcile', state: 'failed', updatedAt: old, reconciliationRequired: true },
      { schema: 'aos.chrome_companion.task_execution_capsule.v1', capsuleId: 'failed-retain', taskId: 'task-failed', runId: 'run-retain', state: 'failed', updatedAt: old, retention: { policy: 'retain_until_resume' } },
      { schema: 'aos.chrome_companion.task_execution_capsule.v1', capsuleId: 'failed-cleanup', taskId: 'task-failed', runId: 'run-cleanup', state: 'failed', updatedAt: old, completion: { cleanup: { state: 'pending' } } },
      { schema: 'aos.chrome_companion.task_execution_capsule.v1', capsuleId: 'open', taskId: 'task-open', runId: 'run-open', state: 'executing', updatedAt: old },
      { schema: 'aos.chrome_companion.task_execution_capsule.v1', capsuleId: 'completed', taskId: 'task-done', runId: 'run-done', state: 'completed', updatedAt: old },
    ],
  });
  const result = await ledger.gcTerminal({ now: Date.now(), retentionMs: 24 * 60 * 60_000 });
  assert.deepEqual(result.operationKeys, ['delete-me']);
  assert.deepEqual(result.taskTabKeys, ['task-tab:profile:7']);
  assert.deepEqual(result.capsuleKeys, ['completed']);
  for (const key of ['unknown', 'reconcile', 'referenced']) assert.ok(ledger.get(key));
  for (const key of ['failed-unknown', 'failed-reconcile', 'failed-retain', 'failed-cleanup', 'open']) assert.ok(ledger.getTaskCapsule(key));
});

test('explicit purge is exact-owner and terminal-only', async (t) => {
  const { ledger } = await fixture(t, { operations: [
    { idempotencyKey: 'owned', operationId: 'op-owned', state: 'blocked', binding: { taskId: 'task-a', runId: 'run-a' } },
    { idempotencyKey: 'foreign', operationId: 'op-foreign', state: 'blocked', binding: { taskId: 'task-b', runId: 'run-b' } },
    { idempotencyKey: 'uncertain', operationId: 'op-uncertain', state: 'unknown_effect', binding: { taskId: 'task-a', runId: 'run-a' } },
  ] });
  const result = await ledger.purgeOwnedOperations({ taskId: 'task-a', runId: 'run-a', operationIds: ['op-owned'], purgeId: 'purge-1' });
  assert.equal(result.purgedCount, 1);
  assert.equal(ledger.get('owned'), undefined);
  await assert.rejects(ledger.purgeOwnedOperations({ taskId: 'task-a', runId: 'run-a', operationIds: ['op-foreign'], purgeId: 'purge-2' }), /terminal records owned/);
  await assert.rejects(ledger.purgeOwnedOperations({ taskId: 'task-a', runId: 'run-a', operationIds: ['op-uncertain'], purgeId: 'purge-3' }), /terminal records owned/);
});
test('checkpoint compaction survives a crash before old journal truncation', async (t) => {
  const { ledger, statePath, journal } = await fixture(t);
  for (let n = 0; n < 128; n++) await ledger.prepare(operation(`op-${n}`));
  const oldJournal = await readFile(journal);
  await ledger.prepare(operation('checkpoint-op'));
  assert.equal(ledger.persistenceMetrics.mode, 'checkpoint');
  assert.equal((await stat(journal)).size, 0);
  await writeFile(journal, oldJournal);
  const restored = new TaskOperationLedger({ statePath });
  await restored.ready();
  assert.equal(restored.listOperations().length, 129);
  await restored.prepare(operation('after-checkpoint'));
  const again = new TaskOperationLedger({ statePath });
  await again.ready();
  assert.equal(again.listOperations().length, 130);
});
test('incomplete final frames are discarded without losing committed frames', async (t) => {
  const { ledger, statePath, journal } = await fixture(t);
  await ledger.prepare(operation('committed'));
  const size = (await stat(journal)).size;
  await appendFile(journal, '{"schema":"aos.chrome_companion.ledger_delta.v1","sequence":2');
  const restored = new TaskOperationLedger({ statePath });
  await restored.ready();
  assert.equal(restored.get('committed').state, 'prepared');
  assert.equal((await stat(journal)).size, size);
  await restored.prepare(operation('next'));
  const again = new TaskOperationLedger({ statePath });
  await again.ready();
  assert.equal(again.listOperations().length, 2);
});
test('committed corruption and sequence gaps fail closed', async (t) => {
  for (const frame of ['{invalid}\n', JSON.stringify({ schema: 'aos.chrome_companion.ledger_delta.v1', sequence: 9, changes: {} }) + '\n']) {
    const { ledger, statePath, journal } = await fixture(t);
    await ledger.prepare(operation('first'));
    await appendFile(journal, frame);
    const restored = new TaskOperationLedger({ statePath });
    await assert.rejects(restored.ready());
    await assert.rejects(restored.prepare(operation('must-not-dispatch')));
  }
});
test('journal symlinks and subsequent operations after an unconfirmed write are rejected', async (t) => {
  const { ledger, statePath, journal, root } = await fixture(t);
  const outside = join(root, 'unrelated');
  await writeFile(outside, 'untouched');
  await symlink(outside, journal);
  await assert.rejects(ledger.prepare(operation('first')));
  await assert.rejects(ledger.prepare(operation('second')));
  assert.equal(await readFile(outside, 'utf8'), 'untouched');
  const restored = new TaskOperationLedger({ statePath });
  await assert.rejects(restored.ready(), /symlink/);
});

// This exercises hundreds of durable fsyncs plus a real child-process SIGKILL.
// Keep the safety assertion while allowing slower CI/dev disks to complete.
test('acknowledged operations and consumed nonces survive a real writer SIGKILL across a checkpoint', { timeout: 60_000 }, async (t) => {
  const { statePath } = await fixture(t);
  const script = `
    import { TaskOperationLedger } from ${JSON.stringify(new URL('../src/shared/task-runtime.mjs', import.meta.url).href)};
    const ledger = new TaskOperationLedger({ statePath: process.env.LEDGER_CRASH_TEST_PATH });
    for (let index = 0; index < ${CRASH_FIXTURE_OPERATION_COUNT}; index += 1) {
      const key = 'crash-' + index;
      await ledger.prepare({ idempotencyKey: key, fingerprint: key, binding: { tabId: 1 } });
      await ledger.transition(key, 'dispatched');
      await ledger.transition(key, 'applied', { result: { text: '日本語の保存済み本文 👩🏽‍💻', index } });
      await ledger.consumeAuthority({ authorityId: 'authority-' + index, nonce: 'nonce-' + index });
      process.stdout.write(JSON.stringify({ acknowledged: index,
        checkpoints: ledger.persistenceMetrics.checkpoints, journalWrites: ledger.journalWrites,
        journalBytes: ledger.persistenceMetrics.journalBytes, lastBytes: ledger.persistenceMetrics.lastBytes }) + '\\n');
    }
  `;
  const child = spawn(process.execPath, ['--input-type=module', '-e', script], {
    env: { ...process.env, LEDGER_CRASH_TEST_PATH: statePath }, stdio: ['ignore', 'pipe', 'pipe'],
  });
  t.after(() => { if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL'); });
  const acknowledged = [], observations = [];
  let pending = '', stderr = '', killed = false;
  child.stderr.on('data', chunk => { stderr += chunk; });
  child.stdout.on('data', chunk => {
    pending += chunk;
    while (pending.includes('\n')) {
      const end = pending.indexOf('\n'); const line = pending.slice(0, end); pending = pending.slice(end + 1);
      const observation = JSON.parse(line);
      acknowledged.push(observation.acknowledged);
      observations.push(observation);
      if (!killed && acknowledged.length >= CRASH_KILL_AFTER_ACKNOWLEDGED) { killed = true; child.kill('SIGKILL'); }
    }
  });
  const exit = await new Promise(resolvePromise => child.once('exit', (code, signal) => resolvePromise({ code, signal })));
  assert.equal(stderr, '');
  assert.equal(exit.signal, 'SIGKILL');
  assert.ok(acknowledged.length >= CRASH_KILL_AFTER_ACKNOWLEDGED);
  const checkpointObservation = observations.find(observation => observation.checkpoints >= CRASH_CHECKPOINTS_REQUIRED);
  assert.ok(checkpointObservation,
    `SIGKILL fixture did not reach its checkpoint boundary: ${JSON.stringify(observations.at(-1))}`);
  assert.ok(checkpointObservation.lastBytes > 0,
    `SIGKILL fixture did not report durable bytes: ${JSON.stringify(checkpointObservation)}`);
  const restored = new TaskOperationLedger({ statePath });
  await restored.ready();
  for (const index of acknowledged) {
    assert.equal(restored.get('crash-' + index).state, 'applied');
    assert.equal(restored.get('crash-' + index).result.text, '日本語の保存済み本文 👩🏽‍💻');
    await assert.rejects(restored.consumeAuthority({ authorityId: 'authority-' + index, nonce: 'nonce-' + index }), /already consumed/);
  }
  await restored.prepare(operation('after-real-crash'));
  const again = new TaskOperationLedger({ statePath });
  await again.ready();
  assert.equal(again.get('after-real-crash').state, 'prepared');
});
