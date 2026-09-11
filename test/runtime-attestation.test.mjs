import assert from "node:assert/strict";
import test from "node:test";
import { DEFAULT_CAPABILITIES, OPERATION_SCHEMA, OPERATION_SCHEMA_DIGEST, OPERATION_SCHEMA_VERSION, PRODUCT_VERSION, PROTOCOL_VERSION } from "../src/shared/constants.mjs";
import { INSTALL_BUILD_ID } from "../src/shared/build-info.mjs";
import { createRuntimeAttestation, verifyRuntimeAttestation } from "../src/shared/runtime-attestation.mjs";

test("runtime attestation is self-consistent and detects stale component metadata", () => {
  const attestation = createRuntimeAttestation({
    buildId: INSTALL_BUILD_ID,
    productVersion: PRODUCT_VERSION,
    protocolVersion: PROTOCOL_VERSION,
    operationSchema: OPERATION_SCHEMA,
    operationSchemaDigest: OPERATION_SCHEMA_DIGEST,
    operationSchemaVersion: OPERATION_SCHEMA_VERSION,
    capabilities: DEFAULT_CAPABILITIES,
  });
  assert.equal(verifyRuntimeAttestation(attestation, {
    buildId: INSTALL_BUILD_ID,
    productVersion: PRODUCT_VERSION,
    protocolVersion: PROTOCOL_VERSION,
    operationSchema: OPERATION_SCHEMA,
    operationSchemaDigest: OPERATION_SCHEMA_DIGEST,
    operationSchemaVersion: OPERATION_SCHEMA_VERSION,
    capabilities: DEFAULT_CAPABILITIES,
  }), true);
  assert.equal(verifyRuntimeAttestation({ ...attestation, buildId: "install-stale" }), false);
  assert.equal(verifyRuntimeAttestation({ ...attestation, operationSchemaDigest: "stale" }, { operationSchemaDigest: OPERATION_SCHEMA_DIGEST }), false);
  assert.equal(verifyRuntimeAttestation(attestation, { capabilities: ["page.snapshot"] }), false);
});
