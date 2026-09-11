import { createHash } from "node:crypto";

/**
 * Runtime operation contract.
 *
 * This table is deliberately the only source for operation classification.
 * Broker, MCP and generated Extension metadata can all derive their method
 * sets from it, which prevents a method from being advertised on one side of
 * the socket while being rejected on the other side.
 */
export const OPERATION_SCHEMA = "aos.chrome_companion.operation_schema.v1";
export const OPERATION_SCHEMA_VERSION = 1;

const definitions = [
  // Extension lifecycle controls are profile-global and intentionally do not
  // target a page/tab.  They are still mutations because a reload invalidates
  // the current Extension generation and all leases must be reacquired.
  ["extension.reload", false, true, true],
  ["tabs.list", false, false, false],
  ["tabs.get", true, false, false],
  ["tabs.create", false, true, true],
  ["tabs.close", true, true, false],
  ["tabs.activate", true, true, true],
  ["tabs.navigate", true, true, false],
  ["tabs.back", true, true, true],
  ["tabs.forward", true, true, true],
  ["tabs.reload", true, true, true],
  ["tabs.groupTask", true, true, true],
  ["tabs.configure", true, true, true],
  ["page.configureViewport", true, true, true],
  ["page.bookmark", true, true, true],
  ["browser.searchLibrary", false, false, false],
  ["browser.listWindows", false, false, false],
  ["page.snapshot", true, false, false],
  ["page.accessibilitySnapshot", true, false, true],
  ["page.screenshot", true, false, true],
  ["page.inspectDropdown", true, false, false],
  ["visual.inspectTarget", true, false, false],
  ["visual.inspectPoint", true, false, false],
  ["visual.pointerMove", true, true, true],
  ["visual.click", true, true, true],
  ["visual.doubleClick", true, true, true],
  ["visual.drag", true, true, true],
  ["visual.scroll", true, true, true],
  ["visual.pressKey", true, true, true],
  ["visual.keyDown", true, true, true],
  ["visual.keyUp", true, true, true],
  ["visual.typeText", true, true, true],
  ["page.query", true, false, false],
  ["page.assets", true, false, false],
  ["page.exportContent", true, false, false],
  ["page.webMcpDiscover", true, false, false],
  ["page.webMcpCall", true, true, false],
  ["page.exportArtifact", true, false, false],
  ["page.inspectCaptcha", true, false, false],
  ["page.domDiff", true, false, false],
  ["page.readNetwork", true, false, false],
  ["page.observe", true, false, true],
  ["page.elementScreenshot", true, false, true],
  ["page.download", true, true, true],
  ["clipboard.read", true, false, true],
  ["clipboard.readBinary", true, false, true],
  ["clipboard.write", true, true, true],
  ["page.inspectDialog", true, false, true],
  ["page.handleDialog", true, true, true],
  ["page.readConsole", true, false, true],
  ["page.click", true, true, false],
  ["page.doubleClick", true, true, false],
  ["page.hover", true, true, false],
  ["page.setChecked", true, true, false],
  ["page.pressKey", true, true, false],
  ["page.selectText", true, true, false],
  ["page.richText", true, true, false],
  ["page.scroll", true, true, false],
  ["page.selectOption", true, true, true],
  ["page.type", true, true, false],
  ["page.upload", true, true, false],
  ["page.uploadMultiple", true, true, false],
  ["page.nativeChooser", true, true, false],
  ["page.submit", true, true, false],
  ["tabs.claimExisting", true, true, true],
  ["page.waitFor", true, false, false],
  ["page.delay", true, false, false],
].map(([method, targetScoped, mutation, profileGlobal]) => Object.freeze({ method, targetScoped, mutation, profileGlobal }));

export const OPERATION_DEFINITIONS = Object.freeze(definitions);

const PURPOSES = Object.freeze({
  "page.query": ["inspect", "Read structured page data before choosing a target", "page readback"],
  "page.richText": ["edit", "Apply verified formatting to a selected rich-text range", "post-edit DOM readback; this does not prove document persistence"],
  "page.upload": ["upload", "Deliver one prepared local file to an exact file input", "file-input or site confirmation readback; this does not prove submission"],
  "page.uploadMultiple": ["upload", "Deliver prepared local files to an exact file input", "file-input or site confirmation readback; this does not prove submission"],
  "page.submit": ["submit", "Submit an exact form after its fields are verified", "same-target page transition or provider confirmation"],
  "page.screenshot": ["inspect", "Capture visual evidence for the exact leased tab", "image metadata and unchanged target verification"],
  "visual.inspectTarget": ["inspect", "Create a single-use screenshot-bound target proof", "proof freshness and exact target binding"],
});

function methodSet(predicate) {
  return new Set(OPERATION_DEFINITIONS.filter(predicate).map(({ method }) => method));
}

export const EXTENSION_METHODS = methodSet(() => true);
export const TARGET_METHODS = methodSet(({ targetScoped }) => targetScoped);
export const MUTATION_METHODS = methodSet(({ mutation }) => mutation);
export const PROFILE_GLOBAL_METHODS = methodSet(({ profileGlobal }) => profileGlobal);
export const DEFAULT_CAPABILITIES = Object.freeze([...EXTENSION_METHODS]);

// Methods that may appear inside one signed `task.transaction` envelope.
// Keep this list next to the operation definitions so the MCP input schema,
// broker admission, and Extension capability artifact cannot drift apart.
// Internal setup/readback methods (tabs.list, page.snapshot, screenshots, and
// extension.reload) are intentionally excluded; the broker owns those steps.
export const AUTHORIZED_TRANSACTION_METHODS = Object.freeze([
  "tabs.navigate", "tabs.back", "tabs.forward", "tabs.reload", "tabs.configure", "page.configureViewport", "page.bookmark",
  "page.click", "page.doubleClick", "page.hover", "page.setChecked", "page.pressKey", "page.selectText", "page.scroll",
  "visual.pointerMove", "visual.click", "visual.doubleClick", "visual.drag", "visual.scroll", "visual.pressKey", "visual.keyDown", "visual.keyUp",
  "visual.typeText",
  "page.download", "clipboard.write", "page.handleDialog",
  "page.webMcpCall", "page.nativeChooser", "tabs.claimExisting",
  "page.query",
  "page.selectOption", "page.type", "page.upload", "page.uploadMultiple", "page.submit", "page.richText", "page.waitFor", "page.delay",
]);

// Included in the handshake digest: an older worker must not silently ignore
// a signed pre-armed event request while still dispatching its trigger.
export const ACTION_EVENT_CONTRACT = Object.freeze({
  types: ["dialog"],
  methods: ["page.click", "page.doubleClick", "page.pressKey", "page.submit", "visual.click", "visual.doubleClick", "visual.pressKey", "tabs.navigate", "tabs.back", "tabs.forward", "tabs.reload"],
  defaultTimeoutMs: 5_000, minTimeoutMs: 100, maxTimeoutMs: 15_000,
});

// The capability list alone is not enough to detect a stale runtime: two
// builds can advertise the same methods while disagreeing about target scope,
// mutation class, or the signed transaction allow-list.  Keep one digest over
// the complete canonical operation contract and expose it to the generated
// Extension artifact and the broker handshake.
export const OPERATION_SCHEMA_DIGEST = createHash("sha256")
  .update(JSON.stringify({
    schema: OPERATION_SCHEMA,
    version: OPERATION_SCHEMA_VERSION,
    methods: OPERATION_DEFINITIONS,
    authorizedTransactionMethods: AUTHORIZED_TRANSACTION_METHODS,
    actionEvents: ACTION_EVENT_CONTRACT,
  }), "utf8")
  .digest("hex");

export function operationSchemaDocument() {
  return {
    schema: OPERATION_SCHEMA,
    version: OPERATION_SCHEMA_VERSION,
    schemaDigest: OPERATION_SCHEMA_DIGEST,
    methods: OPERATION_DEFINITIONS,
    capabilities: [...DEFAULT_CAPABILITIES],
    authorizedTransactionMethods: [...AUTHORIZED_TRANSACTION_METHODS],
    actionEvents: ACTION_EVENT_CONTRACT,
  };
}

export function operationCapabilityDocument({ methods = [...EXTENSION_METHODS] } = {}) {
  const allowed = new Set(methods);
  return {
    schema: "aos.chrome_companion.capabilities.v1",
    observedAt: new Date().toISOString(),
    operationSchema: OPERATION_SCHEMA,
    operationSchemaVersion: OPERATION_SCHEMA_VERSION,
    operationSchemaDigest: OPERATION_SCHEMA_DIGEST,
    capabilities: OPERATION_DEFINITIONS.filter(({ method }) => allowed.has(method)).map(definition => {
      const purpose = PURPOSES[definition.method];
      return {
        ...definition,
        category: purpose?.[0] ?? (definition.mutation ? "act" : "inspect"),
        purpose: purpose?.[1] ?? `Use ${definition.method} on an authorized target`,
        readback: purpose?.[2] ?? (definition.mutation ? "same-target post-operation readback" : "structured operation result"),
        prerequisites: definition.targetScoped ? ["logical_session", "exact_tab_lease", "fresh_target_read"] : [],
        permissions: definition.profileGlobal ? ["profile_global_queue"] : [],
        effect: definition.mutation ? (definition.profileGlobal ? "profile_global_mutation" : "browser_mutation") : "read_only",
        recovery: definition.mutation ? "unknown_effect_requires_reconciliation; never_replay_automatically" : "safe_to_retry_within_deadline",
        availability: "static_contract",
      };
    }),
  };
}
