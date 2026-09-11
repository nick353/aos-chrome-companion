import { createHash } from "node:crypto";

export const RUNTIME_ATTESTATION_SCHEMA = "aos.chrome_companion.runtime_attestation.v1";

function digest(value) {
  return createHash("sha256").update(JSON.stringify(value), "utf8").digest("hex");
}

function bounded(value, fallback = null, max = 256) {
  if (typeof value !== "string") return fallback;
  const normalized = value.trim();
  return normalized ? normalized.slice(0, max) : fallback;
}

function normalizedCapabilities(capabilities) {
  return [...new Set((Array.isArray(capabilities) ? capabilities : [])
    .filter((value) => typeof value === "string" && value.trim())
    .map((value) => value.trim()))].sort();
}

/**
 * Produce the single runtime identity shown by broker status and build
 * handshakes.  The attestation is descriptive; the signed authority and
 * generation checks remain the actual mutation gates.
 */
export function createRuntimeAttestation({
  buildId = null,
  productVersion = null,
  protocolVersion = null,
  operationSchema = null,
  operationSchemaDigest = null,
  operationSchemaVersion = null,
  capabilities = [],
  componentHashes = {},
} = {}) {
  const normalized = normalizedCapabilities(capabilities);
  const safeHashes = Object.fromEntries(Object.entries(componentHashes && typeof componentHashes === "object" ? componentHashes : {})
    .filter(([key, value]) => typeof key === "string" && typeof value === "string" && /^[a-f0-9]{64}$/u.test(value))
    .sort(([left], [right]) => left.localeCompare(right)));
  const payload = {
    schema: RUNTIME_ATTESTATION_SCHEMA,
    buildId: bounded(buildId),
    productVersion: bounded(productVersion),
    protocolVersion: bounded(protocolVersion),
    operationSchema: bounded(operationSchema),
    operationSchemaDigest: bounded(operationSchemaDigest, null, 128),
    operationSchemaVersion: Number.isSafeInteger(operationSchemaVersion) ? operationSchemaVersion : null,
    capabilities: normalized,
    capabilityDigest: digest(normalized),
    componentHashes: safeHashes,
  };
  return { ...payload, attestationDigest: digest(payload) };
}

export function verifyRuntimeAttestation(attestation, expected = {}) {
  if (!attestation || typeof attestation !== "object" || attestation.schema !== RUNTIME_ATTESTATION_SCHEMA) return false;
  const { attestationDigest, ...payload } = attestation;
  if (typeof attestationDigest !== "string" || digest(payload) !== attestationDigest) return false;
  for (const key of ["buildId", "productVersion", "protocolVersion", "operationSchema", "operationSchemaDigest", "operationSchemaVersion"]) {
    if (expected[key] !== undefined && String(expected[key]) !== String(attestation[key])) return false;
  }
  if (expected.capabilities && digest(normalizedCapabilities(expected.capabilities)) !== attestation.capabilityDigest) return false;
  return true;
}
