import assert from "node:assert/strict";
import test from "node:test";
import { runSplitTransaction } from "../src/mcp/split-transaction.mjs";

const actions = (count) => Array.from({ length: count }, (_, index) => ({ method: "page.click", params: { locator: { text: `item ${index}` } } }));

test("short action lists run as one transaction unchanged", async () => {
  const calls = [];
  const result = await runSplitTransaction(async (params) => { calls.push(params); return { result: "verified", tab: { id: 7 } }; },
    { idempotencyKey: "k", startUrl: "https://example.com/" }, actions(32));
  assert.equal(calls.length, 1);
  assert.equal(calls[0].idempotencyKey, "k");
  assert.equal(calls[0].actions.length, 32);
  assert.equal(result.split_transaction, undefined);
});

test("long action lists run as consecutive parts on the same tab", async () => {
  const calls = [];
  const result = await runSplitTransaction(async (params) => { calls.push(params); return { result: "verified", tab: { id: 42 } }; },
    { idempotencyKey: "fill", startUrl: "https://example.com/", keepTaskTab: false, precondition: { semanticQuery: "x" } }, actions(70));
  assert.deepEqual(calls.map((call) => call.actions.length), [32, 32, 6]);
  assert.deepEqual(calls.map((call) => call.idempotencyKey), ["fill:part-1-of-3", "fill:part-2-of-3", "fill:part-3-of-3"]);
  assert.equal(calls[0].tabId, undefined);
  assert.equal(calls[0].keepTaskTab, true);
  assert.deepEqual(calls[0].precondition, { semanticQuery: "x" });
  assert.equal(calls[1].tabId, 42);
  assert.equal(calls[1].reuseTaskTab, true);
  assert.equal(calls[1].precondition, null);
  assert.equal(calls[2].keepTaskTab, false);
  assert.equal(result.split_transaction.completed_parts, 3);
  assert.deepEqual(result.split_transaction.remaining_action_indices, []);
});

test("a split stops at the first part that is not verified and reports original indices", async () => {
  const calls = [];
  const result = await runSplitTransaction(async (params) => {
    calls.push(params);
    return calls.length === 2
      ? { result: "unknown_effect", tab: { id: 5 }, action_progress: { remaining_action_indices: [4, 5], uncertain_action_indices: [3] } }
      : { result: "verified", tab: { id: 5 } };
  }, { idempotencyKey: "k", startUrl: "https://example.com/" }, actions(100));
  assert.equal(calls.length, 2, "nothing after an uncertain part is dispatched");
  assert.equal(result.result, "unknown_effect");
  assert.equal(result.split_transaction.completed_parts, 1);
  assert.deepEqual(result.split_transaction.uncertain_action_indices, [35]);
  assert.deepEqual(result.split_transaction.remaining_action_indices.slice(0, 3), [36, 37, 64]);
  assert.equal(result.split_transaction.remaining_action_indices.at(-1), 99);
});
