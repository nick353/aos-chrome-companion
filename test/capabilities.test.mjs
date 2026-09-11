import test from "node:test";
import assert from "node:assert/strict";
import { EXTENSION_METHODS, operationCapabilityDocument } from "../src/shared/operation-schema.mjs";

test("capability contract is derived from the admitted operation set and can be filtered", () => {
  const all = operationCapabilityDocument();
  assert.equal(all.schema, "aos.chrome_companion.capabilities.v1");
  assert.equal(all.capabilities.length, EXTENSION_METHODS.size);
  assert.equal(new Set(all.capabilities.map(item => item.method)).size, all.capabilities.length);
  const richText = all.capabilities.find(item => item.method === "page.richText");
  assert.equal(richText.effect, "browser_mutation");
  assert.match(richText.readback, /persistence/);
  assert.match(richText.recovery, /reconciliation/);

  const filtered = operationCapabilityDocument({ methods: ["page.query", "unknown"] });
  assert.deepEqual(filtered.capabilities.map(item => item.method), ["page.query"]);
});
