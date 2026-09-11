import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { CompanionBroker } from '../src/broker/broker.mjs';
import { BrokerClient } from '../src/client/broker-client.mjs';
import { ensureBrokerSecret } from '../src/shared/security.mjs';

test('simultaneous broker startups claim the socket before touching the shared journal', async t => {
  const root = await mkdtemp(join(tmpdir(), 'aos-startup-race-'));
  const socketPath = join(root, 'broker.sock');
  const statePath = join(root, 'ledger.json');
  await writeFile(statePath, JSON.stringify({ schema: 'aos.chrome_companion.operation_ledger.v1', operations: [
    { idempotencyKey: 'interrupted', fingerprint: 'old', state: 'prepared', dispatchCount: 0, binding: {} },
  ] }), { mode: 0o600 });
  const brokers = [new CompanionBroker({ socketPath, statePath, secret: 'secret' }), new CompanionBroker({ socketPath, statePath, secret: 'secret' })];
  for (const broker of brokers) broker.taskLedger.readyPromise?.catch(() => {});
  t.after(async () => { for (const broker of brokers) await broker.close().catch(() => {}); await rm(root, { recursive: true, force: true }); });
  const outcomes = await Promise.allSettled(brokers.map(broker => broker.listen()));
  assert.equal(outcomes.filter(outcome => outcome.status === 'fulfilled').length, 1);
  const winner = brokers[outcomes.findIndex(outcome => outcome.status === 'fulfilled')];
  const loser = brokers[outcomes.findIndex(outcome => outcome.status === 'rejected')];
  assert.equal(loser.taskLedger.readyPromise, null, 'the losing process must not read or normalize the ledger');
  assert.equal(loser.taskLedger.persistenceMetrics.writes, 0);
  await loser.close();
  await winner.taskLedger.prepare({ idempotencyKey: 'after-race', fingerprint: 'new', binding: {} });
  assert.equal(winner.taskLedger.persistenceError, null);
  const frames = (await readFile(`${statePath}.journal`, 'utf8')).trim().split('\n').map(JSON.parse);
  assert.deepEqual(frames.map(frame => frame.sequence), frames.map((_, index) => index + 1));
  assert.ok(frames.some(frame => frame.changes.operations?.some(([key]) => key === 'after-race')));
});

test('clients wait for ledger initialization after the broker socket is claimed', async t => {
  const root = await mkdtemp(join(tmpdir(), 'aos-startup-ready-'));
  const env = { ...process.env, AOS_CHROME_COMPANION_DATA_DIR: root, AOS_CHROME_COMPANION_SOCKET: join(root, 'broker.sock'), AOS_CHROME_COMPANION_SECRET_FILE: join(root, 'secret') };
  const secret = await ensureBrokerSecret(env);
  const broker = new CompanionBroker({ socketPath: env.AOS_CHROME_COMPANION_SOCKET, statePath: join(root, 'ledger.json'), secret });
  const originalReady = broker.taskLedger.ready.bind(broker.taskLedger);
  let release;
  const gate = new Promise(resolve => { release = resolve; });
  let entered;
  const initializing = new Promise(resolve => { entered = resolve; });
  broker.taskLedger.ready = async () => { entered(); await gate; return originalReady(); };
  let client;
  t.after(async () => { release(); client?.close(); await broker.close(); await rm(root, { recursive: true, force: true }); });
  const listening = broker.listen();
  await initializing;
  const connected = BrokerClient.connect({ autoStart: false, env });
  release();
  await listening;
  client = await connected;
  const status = await client.request('status.get');
  assert.equal(status.logicalSessionCount, 0);
  assert.equal(broker.accepting, true);
});
