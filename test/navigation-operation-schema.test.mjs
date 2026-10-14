import assert from "node:assert/strict";
import test from "node:test";
import { AUTHORIZED_TRANSACTION_METHODS, MUTATION_METHODS, TARGET_METHODS, PROFILE_GLOBAL_METHODS, EXTENSION_METHODS } from "../src/shared/operation-schema.mjs";

test("navigation recovery has exact-target classification, not implicit transaction retry", () => {
  for (const method of ["tabs.navigationDiagnostics", "tabs.stopLoading"]) {
    assert.equal(EXTENSION_METHODS.has(method), true);
    assert.equal(TARGET_METHODS.has(method), true);
    assert.equal(PROFILE_GLOBAL_METHODS.has(method), false);
    assert.equal(AUTHORIZED_TRANSACTION_METHODS.includes(method), false);
  }
  assert.equal(MUTATION_METHODS.has("tabs.navigationDiagnostics"), false);
  assert.equal(MUTATION_METHODS.has("tabs.stopLoading"), true);
});
