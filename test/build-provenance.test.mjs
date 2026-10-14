import assert from "node:assert/strict";
import test from "node:test";
import { buildProvenanceMismatches } from "../src/shared/build-provenance.mjs";

const hashes = {
  bundleTreeSha256: "a".repeat(64),
  extensionTreeSha256: "b".repeat(64),
  nativeRecorderSha256: "c".repeat(64),
};

test("build provenance accepts exact artifact fingerprints", () => {
  assert.deepEqual(buildProvenanceMismatches(hashes, hashes), []);
});

test("build provenance fails closed on missing, stale, or malformed installed hashes", () => {
  assert.deepEqual(buildProvenanceMismatches({}, hashes), Object.keys(hashes));
  assert.deepEqual(buildProvenanceMismatches({ ...hashes, extensionTreeSha256: "d".repeat(64) }, hashes), ["extensionTreeSha256"]);
  assert.deepEqual(buildProvenanceMismatches(hashes, { ...hashes, nativeRecorderSha256: "bad" }), ["nativeRecorderSha256"]);
});

test("development builds without an installed manifest do not claim artifact verification", () => {
  assert.deepEqual(buildProvenanceMismatches({}, {
    bundleTreeSha256: null,
    extensionTreeSha256: null,
    nativeRecorderSha256: null,
  }), []);
});
