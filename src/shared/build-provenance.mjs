const SHA256 = /^[a-f0-9]{64}$/u;

export const BUILD_PROVENANCE_FIELDS = Object.freeze([
  "bundleTreeSha256",
  "extensionTreeSha256",
  "nativeRecorderSha256",
]);

/** Return required artifact fields that do not match the installed manifest. */
export function buildProvenanceMismatches(actual = {}, expected = {}) {
  return BUILD_PROVENANCE_FIELDS.filter((field) => {
    const expectedHash = expected?.[field];
    if (expectedHash === null || expectedHash === undefined) return false;
    return typeof expectedHash !== "string" || !SHA256.test(expectedHash) || actual?.[field] !== expectedHash;
  });
}
