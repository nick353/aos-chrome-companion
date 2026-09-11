// Synthetic history only. Never load a running broker's ledger through its
// recovery loader: recovery may rewrite interrupted state and journal tails.
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { TaskOperationLedger } from '../src/shared/task-runtime.mjs';

const output = resolve(process.argv[2] ?? 'ledger-persistence-measurement.json');
const root = await mkdtemp(join(tmpdir(), 'aos-ledger-measure-'));
const receipt = { schema: 'aos.chrome_companion.ledger_measurement.v1', startedAt: new Date().toISOString(),
  environment: { platform: process.platform, architecture: process.arch, node: process.version },
  scope: 'Synthetic acknowledged writes including one checkpoint per trial; shared host load is uncontrolled. No browser or business completion is measured.',
  limits: ['Trials share a process; RSS can include earlier trials and garbage collection. RSS samples are not an isolated memory comparison or a peak allocation measurement.',
    'CPU timing includes load, writes and restart verification, but excludes construction of the synthetic seed.'], trials: [] };
function stats(values) {
  const ordered = [...values].sort((a, b) => a - b);
  return { count: ordered.length, median: ordered[Math.ceil(ordered.length * 0.5) - 1] ?? null,
    p95: ordered[Math.ceil(ordered.length * 0.95) - 1] ?? null, max: ordered.at(-1) ?? null };
}
try {
  for (let round = 0; round < 3; round += 1) for (const historyCount of (round % 2 ? [10834, 0] : [0, 10834])) {
    const statePath = join(root, `ledger-${round}-${historyCount}.json`);
    const operations = Array.from({ length: historyCount }, (_, index) => ({ operationId: `old-operation-${index}`,
      idempotencyKey: `old-${index}`, fingerprint: `old-${index}`, binding: { taskId: 'synthetic-history', runId: 'synthetic-run', method: 'page.type', tabId: 1 },
      state: 'applied', effectState: 'known_effect', dispatchState: 'dispatched', dispatchCount: 1,
      result: { text: 'x'.repeat(1970), index } }));
    await writeFile(statePath, JSON.stringify({ schema: 'aos.chrome_companion.operation_ledger.v1', operations }));
    const initialBytes = (await stat(statePath)).size;
    const cpuStarted = process.cpuUsage(), rssBefore = process.memoryUsage().rss, startedAt = performance.now();
    const ledger = new TaskOperationLedger({ statePath });
    await ledger.ready();
    const loadMs = performance.now() - startedAt, writes = [];
    let rssMaxObserved = Math.max(rssBefore, process.memoryUsage().rss);
    for (let index = 0; index < 129; index += 1) {
      const callStartedAt = performance.now();
      await ledger.prepare({ idempotencyKey: `new-${index}`, fingerprint: `new-${index}`,
        binding: { taskId: 'synthetic-current', runId: 'synthetic-new-run', method: 'tabs.create' } });
      writes.push({ mode: ledger.persistenceMetrics.mode, wallMs: performance.now() - callStartedAt,
        persistMs: ledger.persistenceMetrics.lastMs, serializeMs: ledger.persistenceMetrics.serializeMs,
        bytes: ledger.persistenceMetrics.lastBytes });
      rssMaxObserved = Math.max(rssMaxObserved, process.memoryUsage().rss);
    }
    assert.equal(ledger.persistenceMetrics.byMode.journal.writes, 128);
    assert.equal(ledger.persistenceMetrics.byMode.checkpoint.writes, 1);
    assert.equal(ledger.listOperations().length, historyCount + 129);
    ledger.close();
    const restored = new TaskOperationLedger({ statePath });
    await restored.ready();
    assert.equal(restored.listOperations().length, historyCount + 129);
    assert.equal(restored.get('new-128').state, 'prepared');
    if (historyCount) assert.equal(restored.get('old-0').result.text.length, 1970);
    restored.close();
    const cpu = process.cpuUsage(cpuStarted);
    receipt.trials.push({ round, historyCount, initialBytes, loadMs, writes,
      metrics: structuredClone(ledger.persistenceMetrics), finalBytes: (await stat(statePath)).size,
      retainedHistoryVerified: true, rssBefore, rssMaxObserved, cpuMs: { user: cpu.user / 1000, system: cpu.system / 1000 } });
    await rm(statePath); await rm(`${statePath}.journal`);
  }
  receipt.byHistory = Object.fromEntries([0, 10834].map(count => [count, Object.fromEntries(['journal', 'checkpoint'].map(mode => {
    const entries = receipt.trials.filter(trial => trial.historyCount === count).flatMap(trial => trial.writes.filter(write => write.mode === mode));
    return [mode, { wallMs: stats(entries.map(entry => entry.wallMs)), persistMs: stats(entries.map(entry => entry.persistMs)),
      serializeMs: stats(entries.map(entry => entry.serializeMs)), bytes: stats(entries.map(entry => entry.bytes)) }];
  }))]));
  receipt.result = 'verified';
} catch (error) {
  receipt.result = 'failed'; receipt.error = { name: error.name, message: error.message }; process.exitCode = 1;
} finally {
  await rm(root, { recursive: true, force: true });
  receipt.finishedAt = new Date().toISOString(); receipt.scratchRemoved = true;
  await writeFile(output, JSON.stringify(receipt, null, 2) + '\n');
  const readback = JSON.parse(await readFile(output, 'utf8'));
  console.log(JSON.stringify({ result: readback.result, output, byHistory: readback.byHistory, error: readback.error }, null, 2));
}
