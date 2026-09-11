import {
  DEFAULT_CAPABILITIES,
  AUTHORIZED_TRANSACTION_METHODS,
  EXTENSION_METHODS,
  MUTATION_METHODS,
  OPERATION_DEFINITIONS,
  OPERATION_SCHEMA,
  OPERATION_SCHEMA_DIGEST,
  OPERATION_SCHEMA_VERSION,
  PROFILE_GLOBAL_METHODS,
  TARGET_METHODS,
} from "./operation-schema.mjs";

export {
  DEFAULT_CAPABILITIES,
  AUTHORIZED_TRANSACTION_METHODS,
  EXTENSION_METHODS,
  MUTATION_METHODS,
  OPERATION_DEFINITIONS,
  OPERATION_SCHEMA,
  OPERATION_SCHEMA_DIGEST,
  OPERATION_SCHEMA_VERSION,
  PROFILE_GLOBAL_METHODS,
  TARGET_METHODS,
};

export const PRODUCT_NAME = "AOS Chrome Companion";
export const PRODUCT_VERSION = "0.3.2";
export const PROTOCOL_VERSION = "0.1.0";
export const NATIVE_HOST_NAME = "com.aos.chrome_companion";
export const MAX_NATIVE_MESSAGE_BYTES = 1024 * 1024;
// Chrome -> host has a different protocol limit from host -> Chrome.
export const MAX_EXTENSION_MESSAGE_BYTES = 64 * 1024 * 1024;
export const DEFAULT_OPERATION_TIMEOUT_MS = 15_000;
export const MAX_OPERATION_TIMEOUT_MS = 60_000;
export const SESSION_TTL_MS = 30 * 60_000;

// Chrome's profile-global tab lifecycle can take longer than a normal
// target-scoped read, especially while several logical sessions are opening
// tabs at once. Keep these defaults below the protocol maximum while giving
// the Extension enough time to observe navigation and grouping completion.
export const DEFAULT_OPERATION_TIMEOUTS_MS = Object.freeze({
  "extension.reload": 30_000,
  "tabs.create": 30_000,
  "tabs.close": 20_000,
  "tabs.activate": 20_000,
  "tabs.navigate": 30_000,
  "tabs.groupTask": 20_000,
  "page.snapshot": 30_000,
  "page.screenshot": 30_000,
  "visual.inspectTarget": 30_000,
  // UI mutations include the visible Companion cursor/readback path and can
  // wait on Chrome's renderer under load. Keep them bounded, but do not
  // classify a merely late visual receipt as an unknown external effect at
  // the generic 15s limit.
  "page.click": 30_000,
  "page.doubleClick": 30_000,
  "page.hover": 30_000,
  "page.setChecked": 30_000,
  "page.pressKey": 30_000,
  "page.selectText": 30_000,
  "page.scroll": 30_000,
  "page.selectOption": 60_000,
  "page.type": 30_000,
  // Includes fragmented native transport and page injection for up to 25 MiB.
  // A timeout still means unknown effect; it never authorizes a file replay.
  "page.upload": 60_000,
  "page.uploadMultiple": 60_000,
  "page.submit": 30_000,
  "visual.pointerMove": 60_000,
  "visual.inspectPoint": 30_000,
  "visual.click": 60_000,
  "visual.doubleClick": 60_000,
  "visual.drag": 60_000,
  "visual.scroll": 60_000,
  "visual.pressKey": 60_000,
  "page.download": 60_000,
  "clipboard.read": 20_000,
  "clipboard.write": 30_000,
  "page.handleDialog": 30_000,
});
