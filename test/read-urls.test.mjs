import assert from 'node:assert/strict';
import test from 'node:test';
import { readUrls } from '../src/mcp/read-urls.mjs';

const args = { sessionId: 'session', taskId: 'task', runId: 'run', idempotencyKey: 'batch', urls: ['https://one.example/', 'https://two.example/'] };
const complete = url => ({ result: 'verified', post: { url, title: 'Page', text: 'Page contents' }, cleanup: { closed: true } });

test('batch reads bound concurrency, deduplicate URLs, preserve order and use only temporary owned read transactions', async () => {
  const calls = [];
  let active = 0, peak = 0;
  const result = await readUrls({ requestAuthorizedTransaction: async (params) => {
    calls.push(params); peak = Math.max(peak, ++active);
    await new Promise(resolve => setTimeout(resolve, params.startUrl.includes('one') ? 15 : 1));
    active--; return complete(params.startUrl);
  } }, { ...args, urls: [...args.urls, args.urls[0], 'https://three.example/'] });
  assert.equal(peak, 2); assert.equal(calls.length, 3);
  assert.deepEqual(result.rows.map(row => row.finalUrl), [...args.urls, args.urls[0], 'https://three.example/']);
  assert.equal(result.rows[2].duplicateOf, 0); assert.equal(result.cleanupComplete, true);
  for (const params of calls) {
    assert.deepEqual(params.actions.map(action => action.method), ['page.query']);
    assert.equal(params.reuseTaskTab, false); assert.equal(params.keepTaskTab, false);
    assert.equal(params.taskId, 'task'); assert.equal(params.tabId, undefined);
  }
});

test('partial failures preserve the successful page and do not retry or hide uncertain cleanup', async () => {
  const calls = [];
  const result = await readUrls({ requestAuthorizedTransaction: async (params) => {
    calls.push(params.startUrl);
    if (params.startUrl.includes('two')) throw new Error('transport_disconnected');
    return complete(params.startUrl);
  } }, args);
  assert.deepEqual(result.rows.map(row => row.status), ['read', 'failed']);
  assert.equal(result.cleanupComplete, false); assert.equal(calls.length, 2);
  assert.equal(result.rows[0].text, 'Page contents');
  assert.match(result.rows[1].cleanup.nextAction, /exact transaction status/);
});

test('cancellation waits for an in-flight read cleanup and prevents the next page from opening', async () => {
  const controller = new AbortController(); let calls = 0, cleaned = false;
  const result = await readUrls({ requestAuthorizedTransaction: async (params) => {
    calls++; controller.abort();
    await new Promise(resolve => setTimeout(resolve, 5)); cleaned = true;
    return complete(params.startUrl);
  } }, { ...args, concurrency: 1 }, { signal: controller.signal });
  assert.equal(cleaned, true); assert.equal(calls, 1);
  assert.deepEqual(result.rows.map(row => row.status), ['read', 'cancelled']);
  assert.equal(result.cleanupComplete, true);
});

test('invalid or credential-bearing URLs reject the entire batch before a tab is opened', async () => {
  let calls = 0; const client = { requestAuthorizedTransaction: async () => { calls++; } };
  for (const url of ['file:///secret', 'https://user:secret@example.com/', 'not a URL']) {
    await assert.rejects(readUrls(client, { ...args, urls: [args.urls[0], url] }), /HTTP|absolute/);
  }
  assert.equal(calls, 0);
});
