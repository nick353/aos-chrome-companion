import test from 'node:test';
import assert from 'node:assert/strict';
import { readSubmissionTransition, captureTransactionReadback, transactionOutcome } from '../src/shared/transaction-readback.mjs';

const initial = { url: 'https://example.test/apply', pageInstanceId: 'document-1', text: 'Application form' };
const allowedOrigins = ['https://example.test'];
const image = page => ({ kind: 'screenshot', url: page.url, pageInstanceId: page.pageInstanceId, dataBase64: 'fixture' });

test('a delayed submission transition is read without dispatching another action', async () => {
  let reads = 0;
  const result = await readSubmissionTransition({ before: initial, allowedOrigins, timeoutMs: 100, intervalMs: 1,
    readSnapshot: async () => ++reads < 3 ? initial : { ...initial, text: 'Application received' } });
  assert.equal(result.transitionObserved, true);
  assert.equal(reads, 3);
});

test('an unchanged form stays uncertain after the bounded read window', async () => {
  const result = await readSubmissionTransition({ before: initial, allowedOrigins, timeoutMs: 5, intervalMs: 1, readSnapshot: async () => initial });
  assert.equal(result.transitionObserved, false);
  assert.ok(result.attempts >= 1);
});

test('a transient renderer replacement is tolerated only for readback', async () => {
  let reads = 0;
  const result = await readSubmissionTransition({ before: initial, allowedOrigins, timeoutMs: 100, intervalMs: 1,
    readSnapshot: async () => { if (++reads === 1) throw Object.assign(new Error('replaced'), { code: 'page_execution_empty' }); return { ...initial, pageInstanceId: 'document-2' }; } });
  assert.equal(result.transitionObserved, true);
  assert.equal(reads, 2);
});

test('capture recovers from a same-tab navigation by taking fresh readback', async () => {
  let captures = 0;
  let reads = 0;
  const done = { ...initial, url: 'https://example.test/received', pageInstanceId: 'document-2' };
  const result = await captureTransactionReadback({ initialSnapshot: initial, allowedOrigins, intervalMs: 1,
    readSnapshot: async () => { reads++; return done; },
    takeScreenshot: async () => { if (++captures === 1) throw Object.assign(new Error('navigation'), { code: 'screenshot_target_changed' }); return image(done); } });
  assert.equal(result.after.url, done.url);
  assert.equal(captures, 2);
  assert.equal(reads, 1);
});

test('a capture of a different document at the same URL is not accepted', async () => {
  await assert.rejects(captureTransactionReadback({ initialSnapshot: initial, allowedOrigins, intervalMs: 0,
    readSnapshot: async () => initial, takeScreenshot: async () => image({ ...initial, pageInstanceId: 'wrong-document' }) }), { code: 'screenshot_target_changed' });
});

test('readback never follows an unapproved origin', async () => {
  await assert.rejects(readSubmissionTransition({ before: initial, allowedOrigins,
    readSnapshot: async () => ({ ...initial, url: 'https://unapproved.test/' }) }), { code: 'redirect_origin_escape' });
});

test('verified UI actions do not become provider completion or source sync', () => {
  const result = transactionOutcome({ result: 'verified', effect_state: 'known_effect', actions: [{ index: 0 }], visual_readback: image(initial) });
  assert.equal(result.browser_effect, 'known_effect');
  assert.equal(result.provider_completion, 'unverified');
  assert.equal(result.source_sync, 'unverified');
  assert.equal(result.replay_allowed, false);
});

test('partial success carries remaining actions and readback recovery to every caller', () => {
  const result = transactionOutcome({ result: 'blocked', effect_state: 'known_effect', action_progress: { applied_action_indices: [0], remaining_action_indices: [1], uncertain_action_indices: [] } });
  assert.deepEqual(result.remaining_action_indices, [1]);
  assert.equal(result.next_action, 'read_same_target_then_continue_remaining_actions');
  assert.equal(result.visual_readback, 'unavailable');
});
