import {
  AUTHORIZED_TRANSACTION_METHODS,
  MUTATION_METHODS,
  PROFILE_GLOBAL_METHODS,
  TARGET_METHODS,
} from "./operation-schema.mjs";
import { operationRequiresReconciliation, targetIdentityDigest } from "./task-runtime.mjs";

/**
 * A small, immutable execution packet for one signed transaction step.
 *
 * The broker still verifies the signed `actions` payload as a whole, but it
 * compiles each step once and binds its live target immediately before
 * dispatch.  This prevents later actions from being preflighted against a
 * document that has already changed while keeping the public transaction
 * contract backwards compatible.
 */
export const STEP_PACKET_SCHEMA = "aos.chrome_companion.step_packet.v1";
export const MAX_TRANSACTION_STEPS = 32;

function normalizedMethod(value) {
  return typeof value === "string" ? value.trim() : "";
}

export function compileTransactionSteps(actions, { maxSteps = MAX_TRANSACTION_STEPS } = {}) {
  if (!Array.isArray(actions)) return [];
  const limit = Math.min(MAX_TRANSACTION_STEPS, Math.max(0, Number.isSafeInteger(maxSteps) ? maxSteps : MAX_TRANSACTION_STEPS));
  return actions.slice(0, limit).map((action, index) => {
    const method = normalizedMethod(action?.method);
    const params = action?.params && typeof action.params === "object" && !Array.isArray(action.params)
      ? Object.freeze({ ...action.params })
      : Object.freeze({});
    const mutation = MUTATION_METHODS.has(method);
    return Object.freeze({
      schema: STEP_PACKET_SCHEMA,
      index,
      method,
      params,
      authorized: AUTHORIZED_TRANSACTION_METHODS.includes(method),
      mutation,
      targetScoped: TARGET_METHODS.has(method),
      profileGlobal: PROFILE_GLOBAL_METHODS.has(method),
      effectClass: mutation && operationRequiresReconciliation({ method }) ? "external_commit" : "local_ui",
      reconciliationRequired: mutation && operationRequiresReconciliation({ method }),
    });
  });
}

export function bindTransactionStep(step, {
  secret,
  taskId,
  sessionId,
  leaseId,
  generation,
  profileInstanceId,
  tabId,
  pageInstanceId,
  windowId,
  frameId = 0,
  origin,
} = {}) {
  if (!step || typeof step !== "object") throw new TypeError("step_packet_required");
  const targetIdentity = {
    taskId: taskId ?? null,
    sessionId: sessionId ?? null,
    leaseId: leaseId ?? null,
    generation: generation ?? null,
    profileInstanceId: profileInstanceId ?? null,
    tabId: Number.isSafeInteger(tabId) ? tabId : null,
    pageInstanceId: pageInstanceId ?? null,
    windowId: Number.isSafeInteger(windowId) ? windowId : null,
    frameId: Number.isSafeInteger(frameId) ? frameId : 0,
    origin: origin ?? null,
  };
  return Object.freeze({
    ...step,
    targetIdentity: Object.freeze(targetIdentity),
    targetFingerprint: typeof secret === "string" && secret
      ? targetIdentityDigest(secret, targetIdentity)
      : null,
  });
}

