import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import vm from "node:vm";
import test from "node:test";

const source = await readFile(new URL("../scripts/real-site-readonly-canary.mjs", import.meta.url), "utf8");
const selectorSource = source.slice(source.indexOf("function selectOwnedCanaryTarget("), source.indexOf("\nconst report ="));
const context = { URL }; vm.createContext(context); vm.runInContext(selectorSource, context);
const expected = new URL("https://example.com/expected");
const select = context.selectOwnedCanaryTarget;

test("real-site canary cannot fall back to a different or unknown origin", () => {
  for (const owned of [[{ tabId: 1, targetIdentity: { origin: "https://other.example" } }], [{ tabId: 1 }]]) {
    assert.throws(() => select(owned, expected), /matching_owned_tab_required/);
  }
});

test("real-site canary requires an exact tab when multiple owned pages match", () => {
  const owned = [1, 2].map(tabId => ({ tabId, targetIdentity: { origin: expected.origin } }));
  assert.throws(() => select(owned, expected), /exact_tab_id_required/);
  assert.equal(select(owned, expected, "2").tabId, 2);
  assert.throws(() => select(owned, expected, "3"), /matching_owned_tab_required/);
});
