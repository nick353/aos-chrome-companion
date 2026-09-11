import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import { chmod, mkdir, readFile, rename, writeFile, lstat, open } from "node:fs/promises";
import { constants as fsConstants } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { createId } from "./ids.mjs";
import { resolveDataDir } from "./paths.mjs";
import { CompanionError } from "./errors.mjs";

/**
 * The broker socket secret authenticates a peer.  These issuer secrets are
 * intentionally separate: an authenticated socket peer is not automatically
 * allowed to perform a task-owned mutation.
 */
export const AUTHORITY_ISSUERS = Object.freeze(["aos", "codex_mcp"]);
export const AUTHORITY_SCHEMA = "aos.chrome_companion.authority.v1";
export const TASK_EXECUTION_CAPSULE_SCHEMA = "aos.chrome_companion.task_execution_capsule.v1";
export const HANDOFF_ACK_SCHEMA = "aos.chrome_companion.handoff_ack.v1";
export const OPERATION_EFFECT_PROOF_SCHEMA = "aos.chrome_companion.operation_effect_proof.v1";
export const OPERATION_EFFECT_STATES = Object.freeze([
  "no_dispatch",
  "known_no_effect",
  "known_effect",
  "unknown_effect",
]);

// A timeout is not automatically a provider-side effect.  These operations
// only manipulate the currently leased browser surface (typing, selection,
// scrolling, grouping, and navigation); a late receipt can therefore be
// treated as a local UI readback problem instead of holding the whole task in
// reconciliation.  Submit/external-provider operations intentionally remain
// outside this list and keep the no-replay boundary.
export const LOCAL_UI_OPERATION_METHODS = Object.freeze([
  "tabs.create",
  "tabs.close",
  "tabs.activate",
  "tabs.navigate",
  "tabs.back",
  "tabs.forward",
  "tabs.reload",
  "tabs.groupTask",
  "tabs.configure",
  "page.configureViewport",
  "page.hover",
  "page.setChecked",
  "page.pressKey",
  "page.selectText",
  "page.richText",
  "page.scroll",
  "page.selectOption",
  "page.type",
  "visual.pointerMove",
  "visual.scroll",
  "visual.pressKey",
  "visual.keyDown",
  "visual.keyUp",
  "visual.typeText",
]);
const LOCAL_UI_OPERATION_METHOD_SET = new Set(LOCAL_UI_OPERATION_METHODS);

/**
 * Return whether an operation's unknown result requires provider-side
 * reconciliation.  Explicit metadata wins so callers can classify a
 * context-sensitive operation (for example a click that submitted a form)
 * without adding another public effect-state enum.
 */
export function operationRequiresReconciliation(entry = {}) {
  const source = typeof entry === "string" ? { method: entry } : (entry && typeof entry === "object" ? entry : {});
  if (source.reconciliationRequired === false || source.reconciliation_required === false) return false;
  if (source.effectClass === "local_ui" || source.effect_class === "local_ui") return false;
  const method = source.method
    ?? source.binding?.method
    ?? source.operation?.method
    ?? null;
  if (typeof method !== "string" || !method.trim()) return true;
  return !LOCAL_UI_OPERATION_METHOD_SET.has(method.trim());
}

// Restart recovery deliberately has fewer choices than a normal operation
// result.  A record can be retried only when dispatch never started or when a
// broker-verified no-effect proof is attached.  Anything that may have crossed
// the transport remains unknown and is quarantined until a signed readback
// resolves it; this prevents a Chrome/worker restart from becoming an
// accidental duplicate submission.
export const INTERRUPTED_EFFECT_CLASSIFICATIONS = Object.freeze([
  "NO_DISPATCH",
  "PROVEN_NO_EFFECT",
  "UNKNOWN_EFFECT",
]);
export const TASK_EXECUTION_STATES = Object.freeze([
  "discovered",
  "admitted",
  "target_bound",
  "pre_read",
  "executing",
  "post_read",
  "awaiting_user",
  "reconciliation_required",
  "completed",
  "failed",
]);

/**
 * Normalize the effect classification used by the broker, MCP clients, and
 * the AOS resume controller.  `none` is retained as a compatibility alias
 * for older pre-dispatch receipts, but is never exposed as a fifth state.
 */
export function normalizeOperationEffectState(value, fallback = "no_dispatch") {
  const aliases = new Map([
    ["none", "known_no_effect"],
    ["no_effect", "known_no_effect"],
    ["known_no_effect", "known_no_effect"],
    ["known_effect", "known_effect"],
    ["effect", "known_effect"],
    ["applied", "known_effect"],
    ["unknown", "unknown_effect"],
    ["unknown_effect", "unknown_effect"],
    ["no_dispatch", "no_dispatch"],
  ]);
  const normalized = typeof value === "string" ? value.trim().toLowerCase() : "";
  return aliases.get(normalized) ?? (OPERATION_EFFECT_STATES.includes(fallback) ? fallback : "no_dispatch");
}

/** Derive a semantic effect state from a legacy operation ledger entry. */
export function operationEffectStateForEntry(entry = {}) {
  if (!entry || typeof entry !== "object") return "no_dispatch";
  const explicit = entry.effectState ?? entry.effect_state ?? entry.operationEffectState ?? entry.operation_effect_state;
  if (explicit !== undefined && explicit !== null) return normalizeOperationEffectState(explicit);
  if (entry.state === "unknown_effect") return "unknown_effect";
  // A reconciled entry is intentionally conservative when it predates the
  // four-state field: it still needs one fresh signed readback before reuse.
  if (entry.state === "reconciled") return "unknown_effect";
  if (entry.state === "applied") return "known_effect";
  if (entry.state === "blocked") return "known_no_effect";
  return "no_dispatch";
}

export function isUnresolvedOperationEffect(entry = {}) {
  return operationEffectStateForEntry(entry) === "unknown_effect"
    && operationRequiresReconciliation(entry);
}

export function isKnownNoEffect(entry = {}) {
  return operationEffectStateForEntry(entry) === "known_no_effect";
}

export function isKnownEffect(entry = {}) {
  return operationEffectStateForEntry(entry) === "known_effect";
}

function normalizedDispatchCount(entry = {}) {
  const value = entry.dispatchCount ?? entry.dispatch_count;
  return Number.isSafeInteger(value) ? Math.max(0, Math.min(32, value)) : 0;
}

function dispatchWasStarted(entry = {}, dispatchCount = normalizedDispatchCount(entry)) {
  const state = String(entry.dispatchState ?? entry.dispatch_state ?? "").trim().toLowerCase();
  if (dispatchCount > 0) return true;
  if (["dispatch_started", "dispatched", "sent", "in_flight"].includes(state)) return true;
  // Legacy ledgers had no dispatchState/dispatchCount and used only the
  // operation state.  Treat that shape conservatively as started.
  return entry.state === "dispatched" && !["prepared", "not_dispatched"].includes(state);
}

function verifiedNoEffectProof(entry = {}) {
  const proof = entry.noEffectProof ?? entry.no_effect_proof;
  const proofObject = proof && typeof proof === "object" && !Array.isArray(proof) ? proof : null;
  const proofValid = entry.noEffectProofValid === true
    || entry.no_effect_proof_valid === true
    || proofObject?.valid === true
    || proofObject?.verified === true;
  const brokerEvidence = entry.brokerEvidence === true
    || entry.broker_evidence === true
    || proofObject?.brokerEvidence === true
    || proofObject?.broker_evidence === true;
  const effectState = normalizeOperationEffectState(
    entry.effectState
      ?? entry.effect_state
      ?? entry.operationEffectState
      ?? entry.operation_effect_state
      ?? proofObject?.effectState
      ?? proofObject?.effect_state,
    "no_dispatch",
  );
  const externalActionExecuted = entry.externalActionExecuted ?? entry.external_action_executed
    ?? proofObject?.externalActionExecuted ?? proofObject?.external_action_executed;
  const mutationDispatchAttempted = entry.mutationDispatchAttempted === true
    || entry.mutation_dispatch_attempted === true
    || proofObject?.mutationDispatchAttempted === true
    || proofObject?.mutation_dispatch_attempted === true;
  return proofValid
    && brokerEvidence
    && effectState === "known_no_effect"
    && externalActionExecuted === false
    && !mutationDispatchAttempted;
}

/**
 * Classify a ledger entry interrupted by a process/Chrome restart.
 *
 * This is intentionally pure and conservative so the broker and restart
 * loader cannot diverge.  `NO_DISPATCH` and `PROVEN_NO_EFFECT` are the only
 * retryable classes; `UNKNOWN_EFFECT` keeps its evidence and must not be
 * re-dispatched merely because the original tab disappeared.
 */
export function classifyInterruptedEffect(entry = {}) {
  const dispatchCount = normalizedDispatchCount(entry);
  const proof = verifiedNoEffectProof(entry);
  if (proof) {
    return {
      classification: "PROVEN_NO_EFFECT",
      retryAllowed: true,
      requiresReconciliation: false,
      dispatchCount,
      reason: "verified_broker_no_effect_proof",
    };
  }
  const dispatchStarted = dispatchWasStarted(entry, dispatchCount);
  if (!dispatchStarted && dispatchCount === 0) {
    return {
      classification: "NO_DISPATCH",
      retryAllowed: true,
      requiresReconciliation: false,
      dispatchCount,
      reason: "dispatch_not_started",
    };
  }
  return {
    classification: "UNKNOWN_EFFECT",
    retryAllowed: false,
    requiresReconciliation: true,
    dispatchCount,
    reason: "dispatch_started_without_terminal_receipt",
  };
}

/**
 * Every browser target is identified by the full task lineage, not by a
 * tabId alone.  Values may be null while a target is being discovered, but
 * the keys are always present so signatures and status readback have one
 * deterministic shape.
 */
export const TARGET_IDENTITY_SCHEMA = "aos.chrome_companion.target_identity.v1";
export const TARGET_IDENTITY_FIELDS = Object.freeze([
  "taskId",
  "sessionId",
  "leaseId",
  "generation",
  "profileInstanceId",
  "tabId",
  "pageInstanceId",
  "windowId",
  "frameId",
  "origin",
]);

function optionalIdentifier(value, max = 512) {
  return typeof value === "string" && value.trim() ? value.trim().slice(0, max) : null;
}

function optionalSafeInteger(value) {
  return Number.isSafeInteger(value) ? value : null;
}

function normalizedOrigin(value) {
  if (typeof value !== "string" || !value.trim() || value === "*") return null;
  try { return new URL(value).origin; } catch { return null; }
}

export function normalizeTargetIdentity(input = {}) {
  const source = input && typeof input === "object" && !Array.isArray(input) ? input : {};
  const locator = source.locator && typeof source.locator === "object" && !Array.isArray(source.locator)
    ? source.locator
    : {};
  const target = source.target && typeof source.target === "object" && !Array.isArray(source.target)
    ? source.target
    : {};
  return {
    schema: TARGET_IDENTITY_SCHEMA,
    taskId: optionalIdentifier(source.taskId ?? target.taskId),
    sessionId: optionalIdentifier(source.sessionId ?? target.sessionId),
    leaseId: optionalIdentifier(source.leaseId ?? target.leaseId),
    generation: optionalIdentifier(source.generation ?? target.generation),
    profileInstanceId: optionalIdentifier(source.profileInstanceId ?? target.profileInstanceId),
    tabId: optionalSafeInteger(source.tabId ?? target.tabId),
    pageInstanceId: optionalIdentifier(source.pageInstanceId ?? target.pageInstanceId),
    windowId: optionalSafeInteger(source.windowId ?? target.windowId),
    frameId: optionalSafeInteger(source.frameId ?? locator.frameId ?? target.frameId) ?? 0,
    origin: normalizedOrigin(source.origin ?? source.url ?? target.origin ?? target.url),
  };
}

/** Canonical (sorted-key) representation used inside signed fingerprints. */
export function canonicalTargetIdentity(input = {}) {
  return canonical(normalizeTargetIdentity(input));
}

/** Secret-bound target fingerprint suitable for operation/receipt bindings. */
export function targetIdentityDigest(secret, input = {}) {
  return payloadDigest(secret, normalizeTargetIdentity(input));
}

/**
 * Rebuild the signed target identity whenever task ownership changes.
 *
 * Task-tab records keep both denormalized ownership fields (taskId/sessionId,
 * etc.) and the signed targetIdentity/targetFingerprint pair.  Rebinding only
 * the denormalized fields leaves a stale identity that can make a fresh owner
 * look like a foreign or old-generation target.  Keep this helper small and
 * side-effect free so every rebind/transfer path uses the same canonical
 * identity construction.
 */
export function rebuildTaskTabIdentity(secret, entry = {}, overrides = {}) {
  const source = entry && typeof entry === "object" && !Array.isArray(entry) ? entry : {};
  const override = (key, fallback) => Object.prototype.hasOwnProperty.call(overrides, key) ? overrides[key] : fallback;
  const targetIdentity = normalizeTargetIdentity({
    ...(source.targetIdentity && typeof source.targetIdentity === "object" ? source.targetIdentity : {}),
    taskId: override("taskId", source.taskId),
    sessionId: override("sessionId", source.sessionId),
    leaseId: override("leaseId", source.targetIdentity?.leaseId),
    generation: override("generation", source.generation),
    profileInstanceId: override("profileInstanceId", source.profileInstanceId),
    tabId: override("tabId", source.tabId),
    pageInstanceId: override("pageInstanceId", source.targetIdentity?.pageInstanceId),
    windowId: override("windowId", source.windowId ?? source.targetIdentity?.windowId),
    frameId: override("frameId", source.targetIdentity?.frameId),
    origin: override("origin", source.targetIdentity?.origin),
  });
  return {
    targetIdentity,
    targetFingerprint: targetIdentityDigest(secret, targetIdentity),
  };
}

/**
 * Verify that a persisted task-tab record's denormalized owner fields match
 * the signed identity and fingerprint stored with it.
 */
export function taskTabIdentityConsistent(secret, entry = {}) {
  const source = entry && typeof entry === "object" && !Array.isArray(entry) ? entry : {};
  if (!source.targetIdentity || typeof source.targetIdentity !== "object" || Array.isArray(source.targetIdentity)) return false;
  const rebuilt = rebuildTaskTabIdentity(secret, source);
  return targetIdentityMatches(source.targetIdentity, rebuilt.targetIdentity)
    && typeof source.targetFingerprint === "string"
    && source.targetFingerprint === rebuilt.targetFingerprint;
}

export function targetIdentityMatches(left, right) {
  return canonicalTargetIdentity(left) === canonicalTargetIdentity(right);
}

const TASK_STATE_TRANSITIONS = Object.freeze({
  discovered: new Set(["discovered", "admitted", "failed"]),
  admitted: new Set(["admitted", "target_bound", "failed"]),
  target_bound: new Set(["target_bound", "pre_read", "failed"]),
  pre_read: new Set(["pre_read", "executing", "awaiting_user", "failed"]),
  executing: new Set(["executing", "post_read", "awaiting_user", "reconciliation_required", "failed"]),
  post_read: new Set(["post_read", "completed", "awaiting_user", "reconciliation_required", "failed"]),
  awaiting_user: new Set(["awaiting_user", "admitted", "target_bound", "pre_read", "executing", "failed"]),
  reconciliation_required: new Set(["reconciliation_required", "admitted", "target_bound", "pre_read", "failed", "completed"]),
  completed: new Set(["completed"]),
  failed: new Set(["failed", "admitted", "target_bound"]),
});

function boundedString(value, fallback = null, max = 2_000) {
  return typeof value === "string" && value.length > 0 ? value.slice(0, max) : fallback;
}

function normalizeLocator(value) {
  if (typeof value === "string") return value.slice(0, 2_000);
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  return canonical(value).slice(0, 2_000);
}

export function deriveTaskTargetKey({ targetKey, canonicalLocator, startUrl, targetOrigin, workflowType = "generic" } = {}) {
  if (typeof targetKey === "string" && targetKey.trim()) return targetKey.trim().slice(0, 512);
  const locator = normalizeLocator(canonicalLocator);
  if (locator) return `locator:${locator}`;
  if (typeof startUrl === "string" && startUrl.length > 0) {
    try {
      const url = new URL(startUrl);
      return `url:${url.origin}${url.pathname}${url.search}`.slice(0, 512);
    } catch {
      return `url:${startUrl}`.slice(0, 512);
    }
  }
  return `workflow:${boundedString(workflowType, "generic", 128)}:${boundedString(targetOrigin, "about:blank", 512)}`;
}

export function normalizeTaskExecutionCapsule(input = {}, defaults = {}) {
  if (input !== undefined && (input === null || typeof input !== "object" || Array.isArray(input))) {
    throw authorityError("task_capsule_invalid", "task execution capsule must be an object");
  }
  const source = input ?? {};
  const taskId = boundedString(source.taskId, defaults.taskId, 240);
  const runId = boundedString(source.runId, defaults.runId, 240);
  if (!taskId || !runId) throw authorityError("task_capsule_binding_required", "taskId and runId are required for a task execution capsule");
  const workflowType = boundedString(source.workflowType, defaults.workflowType ?? "generic", 128);
  const canonicalLocator = normalizeLocator(source.canonicalLocator ?? source.target?.canonicalLocator ?? defaults.canonicalLocator);
  const targetKey = deriveTaskTargetKey({
    targetKey: source.targetKey ?? source.target?.targetKey ?? defaults.targetKey,
    canonicalLocator,
    startUrl: source.startUrl ?? defaults.startUrl,
    targetOrigin: source.targetOrigin ?? defaults.targetOrigin,
    workflowType,
  });
  const requestedState = source.state ?? "discovered";
  if (!TASK_EXECUTION_STATES.includes(requestedState)) throw authorityError("task_capsule_state_invalid", "Unknown task execution capsule state");
  const retentionPolicy = source.retention?.policy
    ?? source.retentionPolicy
    ?? defaults.retentionPolicy
    ?? "cleanup";
  if (!["cleanup", "retain", "retain_until_resume", "explicit"].includes(retentionPolicy)) {
    throw authorityError("task_capsule_retention_invalid", "Unknown task execution capsule retention policy");
  }
  const now = defaults.now ?? new Date().toISOString();
  const sourceEffect = source.effect && typeof source.effect === "object" && !Array.isArray(source.effect)
    ? source.effect
    : {};
  const capsule = {
    schema: TASK_EXECUTION_CAPSULE_SCHEMA,
    capsuleId: boundedString(source.capsuleId, defaults.capsuleId ?? createId("capsule"), 240),
    taskId,
    threadId: boundedString(source.threadId, defaults.threadId, 240),
    runId,
    workflowType,
    state: requestedState,
    resumeToken: boundedString(source.resumeToken, null, 512),
    blocker: source.blocker && typeof source.blocker === "object" ? source.blocker : null,
    restartPoint: boundedString(source.restartPoint, null, 512),
    target: {
      targetKey,
      canonicalLocator,
      allowedOrigins: Array.isArray(source.allowedOrigins ?? source.target?.allowedOrigins ?? defaults.allowedOrigins)
        ? [...(source.allowedOrigins ?? source.target?.allowedOrigins ?? defaults.allowedOrigins)].map((value) => String(value)).slice(0, 32)
        : [],
      profileInstanceId: boundedString(source.profileInstanceId ?? source.target?.profileInstanceId ?? defaults.profileInstanceId, null, 240),
      generation: boundedString(source.generation ?? source.target?.generation ?? defaults.generation, null, 240),
      sessionId: boundedString(source.sessionId ?? source.target?.sessionId ?? defaults.sessionId, null, 240),
      leaseId: boundedString(source.leaseId ?? source.target?.leaseId ?? defaults.leaseId, null, 240),
      tabId: Number.isSafeInteger(source.tabId ?? source.target?.tabId ?? defaults.tabId)
        ? (source.tabId ?? source.target?.tabId ?? defaults.tabId)
        : null,
      pageInstanceId: boundedString(source.pageInstanceId ?? source.target?.pageInstanceId ?? defaults.pageInstanceId, null, 240),
      windowId: Number.isSafeInteger(source.windowId ?? source.target?.windowId ?? defaults.windowId)
        ? (source.windowId ?? source.target?.windowId ?? defaults.windowId)
        : null,
      frameId: Number.isSafeInteger(source.frameId ?? source.target?.frameId ?? defaults.frameId)
        ? (source.frameId ?? source.target?.frameId ?? defaults.frameId)
        : 0,
      origin: normalizedOrigin(source.origin ?? source.target?.origin ?? source.targetOrigin ?? defaults.targetOrigin ?? source.startUrl ?? defaults.startUrl),
      surface: boundedString(source.surface ?? source.target?.surface ?? defaults.surface, "aos_chrome_companion_profile_instance", 240),
    },
    resources: {
      resourceClass: boundedString(source.resourceClass ?? source.resources?.resourceClass, "target", 128),
      exactTabLeaseId: boundedString(source.exactTabLeaseId ?? source.resources?.exactTabLeaseId ?? defaults.exactTabLeaseId, null, 240),
      tabId: Number.isSafeInteger(source.tabId ?? source.resources?.tabId ?? defaults.tabId) ? (source.tabId ?? source.resources?.tabId ?? defaults.tabId) : null,
      profileGlobalQueueKey: boundedString(source.profileGlobalQueueKey ?? source.resources?.profileGlobalQueueKey, null, 512),
    },
    visual: source.visual && typeof source.visual === "object" ? source.visual : { required: false, proof: null },
    completion: source.completion && typeof source.completion === "object" ? source.completion : { contract: `${workflowType}.completion.v1`, providerReceipt: null, sourceSync: null, reconciliation: null, cleanup: null },
    effect: {
      ...sourceEffect,
      effectClass: boundedString(sourceEffect.effectClass, "read_only_or_authorized", 128),
      authoritySource: boundedString(sourceEffect.authoritySource, "signed_authority", 128),
      idempotencyKey: boundedString(sourceEffect.idempotencyKey, boundedString(defaults.idempotencyKey, null, 512), 512),
      unknownEffectPolicy: boundedString(sourceEffect.unknownEffectPolicy, "reconcile_before_retry", 128),
      effectState: normalizeOperationEffectState(
        sourceEffect.effectState ?? sourceEffect.effect_state ?? sourceEffect.operationEffectState ?? sourceEffect.operation_effect_state,
        defaults.effectState ?? "no_dispatch",
      ),
      externalActionExecuted: sourceEffect.externalActionExecuted === null || sourceEffect.external_action_executed === null
        ? null
        : sourceEffect.externalActionExecuted === true || sourceEffect.external_action_executed === true,
      dispatchCount: Number.isSafeInteger(sourceEffect.dispatchCount ?? sourceEffect.dispatch_count)
        ? Math.max(0, Math.min(32, Number(sourceEffect.dispatchCount ?? sourceEffect.dispatch_count)))
        : 0,
    },
    retention: {
      policy: retentionPolicy,
      resumeTokenRequired: retentionPolicy !== "cleanup",
      userHelpRequired: source.retention?.userHelpRequired === true,
      reason: boundedString(source.retention?.reason ?? source.retentionReason, null, 512),
      whyTabWasKept: boundedString(source.retention?.whyTabWasKept ?? source.whyTabWasKept, null, 2_000),
      requiredUserAction: boundedString(source.retention?.requiredUserAction ?? source.requiredUserAction, null, 2_000),
      resumeAction: boundedString(source.retention?.resumeAction ?? source.resumeAction, null, 2_000),
    },
    execution: source.execution && typeof source.execution === "object" ? source.execution : { provider: "aos_chrome_companion", runtime: "task_execution_capsule_v1", adapter: workflowType },
    createdAt: boundedString(source.createdAt, now, 64),
    updatedAt: now,
  };
  return capsule;
}

export function transitionTaskExecutionCapsule(capsule, nextState, details = {}, now = new Date().toISOString()) {
  if (!capsule || capsule.schema !== TASK_EXECUTION_CAPSULE_SCHEMA) throw authorityError("task_capsule_invalid", "Invalid task execution capsule");
  if (!TASK_EXECUTION_STATES.includes(nextState) || !TASK_STATE_TRANSITIONS[capsule.state]?.has(nextState)) {
    throw authorityError("task_capsule_transition_invalid", `Invalid task capsule transition: ${capsule.state}->${nextState}`);
  }
  const next = { ...capsule, ...details, state: nextState, updatedAt: now };
  const detailEffect = details.effect && typeof details.effect === "object" && !Array.isArray(details.effect)
    ? details.effect
    : {};
  const requestedEffectState = detailEffect.effectState
    ?? detailEffect.effect_state
    ?? details.effectState
    ?? details.effect_state
    ?? capsule.effect?.effectState;
  const fallbackEffectState = nextState === "completed"
    ? "known_effect"
    : nextState === "failed"
      ? "known_no_effect"
      : nextState === "reconciliation_required"
        ? "unknown_effect"
        : "no_dispatch";
  next.effect = {
    ...(capsule.effect && typeof capsule.effect === "object" ? capsule.effect : {}),
    ...detailEffect,
    effectState: normalizeOperationEffectState(requestedEffectState, fallbackEffectState),
  };
  if (details.externalActionExecuted !== undefined && next.effect.externalActionExecuted === undefined) {
    next.effect.externalActionExecuted = details.externalActionExecuted;
  }
  if (["awaiting_user", "reconciliation_required"].includes(nextState) && !next.resumeToken) next.resumeToken = createId("resume");
  if (nextState === "reconciliation_required" && !next.restartPoint) next.restartPoint = "signed_task_status_readback";
  return next;
}

/** Create a durable destination acknowledgement after an exact tab transfer. */
export function createHandoffAck(secret, {
  sourceTaskId,
  destinationTaskId,
  runId,
  receiptSha256,
  transferred = [],
  alreadyTransferred = [],
  missing = [],
  status = "accepted",
  acknowledgedAt = new Date().toISOString(),
} = {}) {
  const payload = {
    schema: HANDOFF_ACK_SCHEMA,
    sourceTaskId: String(sourceTaskId ?? ""),
    destinationTaskId: String(destinationTaskId ?? ""),
    runId: String(runId ?? ""),
    receiptSha256: String(receiptSha256 ?? ""),
    transferred: [...new Set((Array.isArray(transferred) ? transferred : []).filter(Number.isSafeInteger))].sort((a, b) => a - b),
    alreadyTransferred: [...new Set((Array.isArray(alreadyTransferred) ? alreadyTransferred : []).filter(Number.isSafeInteger))].sort((a, b) => a - b),
    missing: [...new Set((Array.isArray(missing) ? missing : []).filter(Number.isSafeInteger))].sort((a, b) => a - b),
    status: ["accepted", "already_transferred", "no_tabs"].includes(status) ? status : "accepted",
    acknowledgedAt: String(acknowledgedAt),
  };
  return { ...payload, ackDigest: payloadDigest(secret, payload) };
}

export function verifyHandoffAck(secret, ack, expected = {}) {
  if (!ack || typeof ack !== "object" || ack.schema !== HANDOFF_ACK_SCHEMA) throw new Error("handoff_ack_invalid");
  const { ackDigest, ...payload } = ack;
  if (typeof ackDigest !== "string" || payloadDigest(secret, payload) !== ackDigest) throw new Error("handoff_ack_signature_invalid");
  for (const key of ["sourceTaskId", "destinationTaskId", "runId", "receiptSha256"]) {
    if (expected[key] !== undefined && String(expected[key]) !== String(ack[key])) throw new Error(`handoff_ack_${key}_mismatch`);
  }
  return ack;
}

function canonical(value, context = "root") {
  // Authorities cross a JSON-lines socket.  Match JSON.stringify's wire
  // semantics so an optional `undefined` object field dropped in transit does
  // not change the signed payload (array holes/undefined become null).
  if (value === undefined) return context === "object_value" ? undefined : "null";
  if (value === null || typeof value !== "object") {
    const rendered = JSON.stringify(value);
    return rendered === undefined
      ? (context === "object_value" ? undefined : "null")
      : rendered;
  }
  if (Array.isArray(value)) return `[${value.map((item) => canonical(item, "array_item")).join(",")}]`;
  const fields = [];
  for (const key of Object.keys(value).sort()) {
    const rendered = canonical(value[key], "object_value");
    if (rendered !== undefined) fields.push(`${JSON.stringify(key)}:${rendered}`);
  }
  return `{${fields.join(",")}}`;
}

export function canonicalPayload(value) {
  return canonical(value);
}

function hmac(secret, domain, value) {
  return createHmac("sha256", secret).update(`${domain}\0${canonical(value)}`, "utf8").digest("base64url");
}

export function payloadDigest(secret, payload) {
  if (typeof secret !== "string" || !secret) throw new Error("payload_digest_secret_required");
  if (arguments.length < 2) throw new Error("payload_digest_payload_required");
  return hmac(secret, "aos.chrome_companion.payload.v1", payload);
}

function boundedProofString(value, fallback = null, max = 512) {
  return typeof value === "string" && value.trim() ? value.trim().slice(0, max) : fallback;
}

function proofInteger(value, fallback = null) {
  return Number.isSafeInteger(value) ? value : fallback;
}

/**
 * Canonical body for a broker-produced effect proof.  A proof records what
 * the broker actually dispatched and observed; it is not an authority and
 * cannot by itself authorize a provider mutation.
 */
export function operationEffectProofPayload(input = {}) {
  const targetIdentity = normalizeTargetIdentity(input.targetIdentity ?? input.target ?? input);
  const effectState = normalizeOperationEffectState(
    input.effectState ?? input.effect_state ?? input.operationEffectState ?? input.operation_effect_state,
    "no_dispatch",
  );
  const dispatchCount = Math.max(0, Math.min(32, proofInteger(input.dispatchCount ?? input.dispatch_count, 0)));
  const issuedAt = boundedProofString(input.issuedAt ?? input.issued_at, new Date().toISOString(), 64);
  return {
    schema: OPERATION_EFFECT_PROOF_SCHEMA,
    ownerKey: boundedProofString(input.ownerKey ?? input.owner_key ?? targetIdentity.sessionId),
    taskId: boundedProofString(input.taskId ?? input.task_id ?? targetIdentity.taskId),
    runId: boundedProofString(input.runId ?? input.run_id),
    sessionId: boundedProofString(input.sessionId ?? input.session_id ?? targetIdentity.sessionId),
    leaseId: boundedProofString(input.leaseId ?? input.lease_id ?? targetIdentity.leaseId),
    generation: boundedProofString(input.generation ?? targetIdentity.generation),
    profileInstanceId: boundedProofString(input.profileInstanceId ?? input.profile_instance_id ?? targetIdentity.profileInstanceId),
    targetIdentity,
    operationId: boundedProofString(input.operationId ?? input.operation_id),
    idempotencyKey: boundedProofString(input.idempotencyKey ?? input.idempotency_key),
    method: boundedProofString(input.method),
    effectClass: boundedProofString(input.effectClass ?? input.effect_class, "external_commit", 128),
    reconciliationRequired: input.reconciliationRequired === false || input.reconciliation_required === false ? false : true,
    dispatchCount,
    effectState,
    // `null` is intentional for unknown effects; callers must not turn it
    // into false merely because a receipt field is absent.
    externalActionExecuted: input.externalActionExecuted === null || input.external_action_executed === null
      ? null
      : input.externalActionExecuted === true || input.external_action_executed === true,
    mutationDispatchAttempted: input.mutationDispatchAttempted === true || input.mutation_dispatch_attempted === true,
    cleanup: input.cleanup && typeof input.cleanup === "object" && !Array.isArray(input.cleanup)
      ? { state: boundedProofString(input.cleanup.state ?? input.cleanup.cleanupState ?? input.cleanup.cleanup_state, "unknown", 80), tabClosed: input.cleanup.tabClosed === true }
      : { state: "unknown", tabClosed: false },
    capabilityDigest: boundedProofString(input.capabilityDigest ?? input.capability_digest, null, 128),
    resultDigest: boundedProofString(input.resultDigest ?? input.result_digest, null, 128),
    issuedAt,
    nonce: boundedProofString(input.nonce, randomBytes(16).toString("base64url"), 128),
  };
}

export function signOperationEffectProof(secret, input = {}) {
  if (typeof secret !== "string" || !secret) throw new Error("operation_effect_proof_secret_required");
  const payload = operationEffectProofPayload(input);
  if (!payload.taskId || !payload.runId || !payload.ownerKey || !payload.method || !payload.idempotencyKey) {
    throw new Error("operation_effect_proof_binding_required");
  }
  if (payload.effectState === "unknown_effect" && payload.externalActionExecuted === false) {
    throw new Error("operation_effect_proof_unknown_effect_external_state_invalid");
  }
  return { ...payload, signature: payloadDigest(secret, payload) };
}

export function verifyOperationEffectProof(secret, proof, expected = {}) {
  if (typeof secret !== "string" || !secret) throw new Error("operation_effect_proof_secret_required");
  if (!proof || typeof proof !== "object" || proof.schema !== OPERATION_EFFECT_PROOF_SCHEMA) {
    throw new Error("operation_effect_proof_schema_invalid");
  }
  const { signature, ...payload } = proof;
  const normalized = operationEffectProofPayload(payload);
  for (const field of ["schema", "taskId", "runId", "ownerKey", "sessionId", "leaseId", "generation", "profileInstanceId", "operationId", "idempotencyKey", "method", "effectClass", "reconciliationRequired", "dispatchCount", "effectState", "externalActionExecuted", "mutationDispatchAttempted", "capabilityDigest", "resultDigest", "issuedAt", "nonce"]) {
    if (expected[field] !== undefined && expected[field] !== null && normalized[field] !== expected[field]) {
      throw new Error(`operation_effect_proof_${field}_mismatch`);
    }
  }
  if (expected.targetIdentity && canonicalTargetIdentity(normalized.targetIdentity) !== canonicalTargetIdentity(expected.targetIdentity)) {
    throw new Error("operation_effect_proof_target_identity_mismatch");
  }
  if (normalized.effectState === "unknown_effect" && normalized.externalActionExecuted === false) {
    throw new Error("operation_effect_proof_unknown_effect_external_state_invalid");
  }
  const provided = typeof signature === "string" ? signature : "";
  const expectedSignature = payloadDigest(secret, normalized);
  if (!provided || provided.length !== expectedSignature.length || !timingSafeEqual(Buffer.from(provided), Buffer.from(expectedSignature))) {
    throw new Error("operation_effect_proof_signature_invalid");
  }
  const issuedAt = Date.parse(normalized.issuedAt);
  if (!Number.isFinite(issuedAt) || issuedAt > Date.now() + 60_000) throw new Error("operation_effect_proof_time_invalid");
  return normalized;
}

// Keep the client-side authority payload and the broker-side verification
// payload byte-for-byte equivalent.  This is deliberately a small shared
// projection: it must not include the signed envelope or any runtime-only
// fields that can be normalized differently across the socket boundary.
export function authorizedTransactionPayload(params = {}) {
  return {
    ...(params.tabId === undefined ? {} : { tabId: params.tabId }),
    startUrl: params.startUrl ?? "about:blank",
    allowedOrigins: params.allowedOrigins ?? [],
    actions: params.actions ?? [],
    reuseTaskTab: params.reuseTaskTab !== false,
    keepTaskTab: params.keepTaskTab === undefined ? null : params.keepTaskTab === true,
    ...(params.readbackMaxTextChars === undefined ? {} : { readbackMaxTextChars: params.readbackMaxTextChars }),
    retainOnUnknown: params.retainOnUnknown === true,
    precondition: params.precondition ?? null,
    capsule: params.capsule ?? params.taskExecutionCapsule ?? null,
  };
}

// Signed profile-lifecycle controls deliberately use a tiny canonical payload.
// Keeping this projection shared prevents the MCP client and broker from
// disagreeing about what was approved when an Extension reload is requested.
export function extensionReloadPayload(params = {}) {
  const reason = typeof params.reason === "string" && params.reason.trim().length > 0
    ? params.reason.trim().slice(0, 240)
    : "companion_authorized_reload";
  const expectedBuildId = typeof params.expectedBuildId === "string" && params.expectedBuildId.trim().length > 0
    ? params.expectedBuildId.trim().slice(0, 128)
    : null;
  return {
    runId: String(params.runId ?? ""),
    taskId: String(params.taskId ?? ""),
    reason,
    expectedBuildId,
  };
}

// Archiving is deliberately a metadata-only maintenance action.  The
// operation state, broker evidence, result digest, and original binding stay
// untouched so the scheduler can continue to gate on the full unresolved
// count.  Keep this projection shared by the MCP client and broker so the
// signed authority cannot be broadened or narrowed at the socket boundary.
export function archiveReconciliationPayload(params = {}) {
  const operationIds = Array.isArray(params.operationIds)
    ? [...new Set(params.operationIds
      .filter((value) => typeof value === "string" && value.trim().length > 0)
      .map((value) => value.trim().slice(0, 512)))].sort()
    : [];
  const reason = typeof params.reason === "string" && params.reason.trim().length > 0
    ? params.reason.trim().slice(0, 240)
    : "operator_reviewed_reconciliation_backlog";
  return {
    runId: String(params.runId ?? ""),
    taskId: String(params.taskId ?? ""),
    operationIds,
    reason,
    confirmArchiveOnly: params.confirmArchiveOnly === true,
  };
}

// This maintenance payload is intentionally narrower than reconciliation: it
// may clear only a false-positive capsule created by a pre-dispatch,
// read-only target inspection failure. It never asserts that a provider
// effect succeeded and never authorizes replay.
export function repairPreDispatchReadonlyPayload(params = {}) {
  return {
    runId: String(params.runId ?? ""),
    taskId: String(params.taskId ?? ""),
    idempotencyKey: String(params.idempotencyKey ?? ""),
    capsuleId: String(params.capsuleId ?? ""),
    profileInstanceId: String(params.profileInstanceId ?? ""),
    tabId: Number.isSafeInteger(params.tabId) ? params.tabId : null,
    confirmNoEffect: params.confirmNoEffect === true,
  };
}

/** Shared signed read-only payload for a task resume preparation/readback. */
export function prepareResumePayload(params = {}) {
  return {
    runId: String(params.runId ?? ""),
    taskId: String(params.taskId ?? ""),
    // A normal job application is a current-owner execution, not a
    // hookless source-return.  Keep the intent inside the signed payload so
    // the broker can apply the narrow direct-application exception without
    // weakening the default handoff gate.
    intent: params.intent === "direct_application" ? "direct_application" : "prepare_resume",
    idempotencyKey: params.idempotencyKey === undefined || params.idempotencyKey === null
      ? null
      : String(params.idempotencyKey),
    capsuleId: params.capsuleId === undefined || params.capsuleId === null
      ? null
      : String(params.capsuleId),
  };
}

export function authoritySigningInput(envelope) {
  return {
    schema: envelope.schema,
    issuer: envelope.issuer,
    authorityId: envelope.authorityId,
    runId: envelope.runId,
    taskId: envelope.taskId,
    ownerKey: envelope.ownerKey,
    method: envelope.method,
    intent: envelope.intent,
    approved: envelope.approved,
    targetOrigin: envelope.targetOrigin,
    idempotencyKey: envelope.idempotencyKey,
    payloadHmac: envelope.payloadHmac,
    issuedAt: envelope.issuedAt,
    expiresAt: envelope.expiresAt,
    nonce: envelope.nonce,
  };
}

export function createAuthorityEnvelope({
  issuer,
  secret,
  authorityId = createId("authority"),
  runId,
  taskId,
  ownerKey,
  method,
  intent,
  targetOrigin = "*",
  idempotencyKey = createId("idem"),
  payload = {},
  approved = true,
  ttlMs = 60_000,
  now = Date.now(),
  nonce = randomBytes(16).toString("base64url"),
}) {
  if (!AUTHORITY_ISSUERS.includes(issuer)) throw new Error("authority_issuer_invalid");
  const issuedAt = new Date(now).toISOString();
  const expiresAt = new Date(now + ttlMs).toISOString();
  const envelope = {
    schema: AUTHORITY_SCHEMA,
    issuer,
    authorityId: String(authorityId),
    runId: String(runId),
    taskId: String(taskId),
    ownerKey: String(ownerKey),
    method: String(method),
    intent: String(intent),
    targetOrigin: String(targetOrigin),
    idempotencyKey: String(idempotencyKey),
    approved: approved === true,
    payloadHmac: payloadDigest(secret, payload),
    issuedAt,
    expiresAt,
    nonce,
  };
  return { ...envelope, signature: hmac(secret, "aos.chrome_companion.authority.v1", authoritySigningInput(envelope)) };
}

export function verifyAuthorityEnvelope(envelope, {
  secrets,
  payload = {},
  now = Date.now(),
  expected = {},
  replayedNonces,
}) {
  if (!envelope || typeof envelope !== "object") throw authorityError("authority_missing", "Signed authority envelope is required");
  if (envelope.schema !== AUTHORITY_SCHEMA) throw authorityError("authority_schema_invalid", "Authority schema is invalid");
  if (!AUTHORITY_ISSUERS.includes(envelope.issuer)) throw authorityError("authority_issuer_invalid", "Authority issuer is not allowed");
  const secret = secrets?.[envelope.issuer];
  if (typeof secret !== "string" || !secret) throw authorityError("authority_issuer_secret_missing", "Authority issuer secret is unavailable");
  const expectedKeys = ["approved", "authorityId", "expiresAt", "idempotencyKey", "intent", "issuer", "method", "nonce", "ownerKey", "payloadHmac", "runId", "schema", "signature", "targetOrigin", "taskId", "issuedAt"];
  const actualKeys = Object.keys(envelope).sort();
  if (actualKeys.length !== expectedKeys.length || actualKeys.some((key, index) => key !== expectedKeys.slice().sort()[index])) {
    throw authorityError("authority_key_set_invalid", "Authority envelope contains unexpected or missing fields");
  }
  for (const key of ["authorityId", "runId", "taskId", "ownerKey", "method", "intent", "targetOrigin", "idempotencyKey", "payloadHmac", "issuedAt", "expiresAt", "nonce", "signature"]) {
    if (typeof envelope[key] !== "string" || envelope[key].length === 0 || envelope[key].length > 512) {
      throw authorityError("authority_field_invalid", `Authority field is invalid: ${key}`);
    }
  }
  if (envelope.approved !== true) throw authorityError("authority_not_approved", "Authority envelope is not approved");
  const issuedAt = Date.parse(envelope.issuedAt);
  const expiresAt = Date.parse(envelope.expiresAt);
  if (!Number.isFinite(issuedAt) || !Number.isFinite(expiresAt) || issuedAt > now || expiresAt <= now || expiresAt - issuedAt > 10 * 60_000) {
    throw authorityError("authority_expired", "Authority envelope is expired or has an invalid time window");
  }
  if (expected.issuer && expected.issuer !== envelope.issuer) throw authorityError("authority_issuer_mismatch", "Authority issuer does not match caller");
  for (const key of ["authorityId", "runId", "taskId", "ownerKey", "method", "intent", "targetOrigin", "idempotencyKey"]) {
    if (expected[key] !== undefined && String(expected[key]) !== envelope[key]) throw authorityError("authority_binding_mismatch", `Authority binding mismatch: ${key}`);
  }
  if (String(payloadDigest(secret, payload)) !== envelope.payloadHmac) throw authorityError("authority_payload_tampered", "Authority payload digest does not match");
  const expectedSignature = hmac(secret, "aos.chrome_companion.authority.v1", authoritySigningInput(envelope));
  const left = Buffer.from(expectedSignature);
  const right = Buffer.from(envelope.signature);
  if (left.length !== right.length || !timingSafeEqual(left, right)) throw authorityError("authority_signature_invalid", "Authority signature is invalid");
  if (replayedNonces?.has(envelope.nonce)) throw authorityError("authority_replayed", "Authority nonce was already used");
  replayedNonces?.add(envelope.nonce);
  return envelope;
}

function authorityError(code, message, details) {
  return new CompanionError(code, message, details);
}

export function resolveIssuerSecretPath(issuer, env = process.env) {
  if (!AUTHORITY_ISSUERS.includes(issuer)) throw new Error("authority_issuer_invalid");
  return env[`AOS_CHROME_COMPANION_${issuer.toUpperCase()}_ISSUER_SECRET_FILE`]
    ?? join(resolveDataDir(env), `${issuer}-issuer-secret`);
}

export async function ensureIssuerSecret(issuer, env = process.env) {
  const path = resolveIssuerSecretPath(issuer, env);
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  try {
    const handle = await import("node:fs/promises").then(({ open }) => open(path, "wx", 0o600));
    try { await handle.writeFile(`${randomBytes(32).toString("base64url")}\n`, "utf8"); } finally { await handle.close(); }
  } catch (error) {
    if (error?.code !== "EEXIST") throw error;
  }
  await chmod(path, 0o600);
  return (await readFile(path, "utf8")).trim();
}

// Track only changed records; retained history is never serialized on the hot path.
class LedgerMap extends Map {
  pending = new Set();
  set(key, value) { super.set(key, value); this.pending.add(key); return this; }
  delete(key) { const removed = super.delete(key); if (removed) this.pending.add(key); return removed; }
}

export class TaskOperationLedger {
  constructor({ statePath, secret = "aos-chrome-companion-ledger", now = () => Date.now() }) {
    this.statePath = statePath;
    this.secret = secret;
    this.now = now;
    this.closed = false;
    this.operations = new LedgerMap();
    this.capsules = new LedgerMap();
    this.authorities = new LedgerMap();
    this.profileBindings = new LedgerMap();
    this.handoffAcks = new LedgerMap();
    this.journalPath = `${statePath}.journal`;
    this.journalSequence = 0;
    this.journalBytes = 0;
    this.journalWrites = 0;
    this.checkpointExists = false;
    this.persistenceError = null;
    this.persistenceMetrics = { checkpoints: 0, writes: 0, totalMs: 0, lastMs: 0, lastBytes: 0, serializeMs: 0,
      byMode: Object.fromEntries(["journal", "checkpoint"].map(mode => [mode,
        { writes: 0, totalMs: 0, maxMs: 0, totalBytes: 0, serializeMsTotal: 0, serializeMsMax: 0 }])) };
    this.mutex = Promise.resolve();
    this.securePathPromise = null;
    this.readyPromise = null;
  }

  async ready() {
    if (this.closed) throw new Error("ledger_closed");
    this.securePathPromise ??= assertSecureStatePath(this.statePath);
    this.readyPromise ??= this.#load();
    await this.readyPromise;
  }

  close() { this.closed = true; }

  async #load() {
    // Validate the canonical, non-symlink state path before touching the
    // ledger.  This keeps restart recovery from reading attacker-selected
    // state through a replaced parent component.
    await this.securePathPromise;
    const converted = new Set();
    try {
      let saved;
      try {
        saved = JSON.parse(await readFile(this.statePath, "utf8"));
        this.checkpointExists = true;
      } catch (error) {
        if (error?.code !== "ENOENT") throw error;
        saved = {};
      }
      saved = await this.#replayJournal(saved);
      for (const operation of Array.isArray(saved.operations) ? saved.operations : []) {
        operation.dispatchCount = Number.isSafeInteger(operation.dispatchCount)
          ? Math.max(0, Math.min(32, operation.dispatchCount))
          : (operation.operationId ? 1 : 0);
        operation.dispatchState = operation.dispatchState
          ?? (operation.state === "prepared" ? "not_dispatched" : "dispatched");
        const interrupted = ["dispatched", "unknown_effect"].includes(operation.state);
        if (interrupted) {
          const classification = classifyInterruptedEffect(operation);
          operation.interruptedClassification = classification.classification;
          operation.restartRecoveryReason = classification.reason;
          if (classification.classification === "NO_DISPATCH") {
            // A crash before transport dispatch is not an external effect.
            // Normalize it back to a prepared record so the caller can bind a
            // fresh-generation target and retry once.
            operation.state = "prepared";
            operation.effectState = "no_dispatch";
            operation.dispatchState = "not_dispatched";
            operation.dispatchCount = 0;
            operation.externalActionExecuted = false;
            operation.restartRecoveryDisposition = "fresh_retry_allowed";
            operation.restartRecoveredAt = new Date(this.now()).toISOString();
            converted.add(operation.idempotencyKey);
          } else if (classification.classification === "PROVEN_NO_EFFECT") {
            // Keep the proof and make the operation terminally no-effect. A
            // later retry must still create a new operation/target; this entry
            // is never silently replayed in place.
            operation.state = "blocked";
            operation.effectState = "known_no_effect";
            operation.dispatchState = "not_dispatched";
            operation.dispatchCount = 0;
            operation.externalActionExecuted = false;
            operation.restartRecoveryDisposition = "fresh_retry_allowed";
            operation.restartRecoveredAt = new Date(this.now()).toISOString();
            converted.add(operation.idempotencyKey);
          } else {
            operation.state = "unknown_effect";
            operation.effectState = "unknown_effect";
            operation.restartRecoveryDisposition = "quarantine_until_signed_readback";
            operation.restartRecoveredAt = new Date(this.now()).toISOString();
            converted.add(operation.idempotencyKey);
          }
        } else {
          operation.effectState = operation.state === "unknown_effect"
            ? "unknown_effect"
            : operationEffectStateForEntry(operation);
        }
        if (operation.effectState === undefined) operation.effectState = operationEffectStateForEntry(operation);
        this.operations.set(operation.idempotencyKey, operation);
      }
      for (const authority of Array.isArray(saved.authorities) ? saved.authorities : []) {
        if (authority?.authorityId && authority?.nonce) this.authorities.set(`${authority.authorityId}:${authority.nonce}`, authority);
      }
      for (const tab of Array.isArray(saved.taskTabs) ? saved.taskTabs : []) {
        if (tab?.profileInstanceId !== undefined && Number.isSafeInteger(tab.tabId)) this.operations.set(`task-tab:${tab.profileInstanceId}:${tab.tabId}`, { ...tab, state: "task_tab" });
      }
      for (const capsule of Array.isArray(saved.taskCapsules) ? saved.taskCapsules : []) {
        if (capsule?.capsuleId && capsule.schema === TASK_EXECUTION_CAPSULE_SCHEMA) this.capsules.set(capsule.capsuleId, capsule);
      }
      for (const profile of Array.isArray(saved.profileBindings) ? saved.profileBindings : []) {
        if (profile?.profileInstanceId && profile?.extensionRuntimeId && profile?.generation) {
          this.profileBindings.set(profile.profileInstanceId, profile);
        }
      }
      for (const ack of Array.isArray(saved.handoffAcks) ? saved.handoffAcks : []) {
        if (ack?.schema === HANDOFF_ACK_SCHEMA && typeof ack.ackDigest === "string") {
          this.handoffAcks.set(ack.ackDigest, ack);
        }
      }
      for (const map of Object.values(this.#collections())) map.pending.clear();
      for (const key of converted) this.operations.pending.add(key);
      if (converted.size) await this.#persist();
    } catch (error) {
      if (error?.code !== "ENOENT") throw error;
    }
  }

  get(idempotencyKey) { return this.operations.get(idempotencyKey); }
  listOperations() { return [...this.operations.values()].filter((entry) => entry.state !== "task_tab"); }

  consumeAuthority(authority) {
    return this.#queue(async () => {
      await this.ready();
      const key = `${authority.authorityId}:${authority.nonce}`;
      if (this.authorities.has(key)) throw authorityError("authority_replayed", "Authority id/nonce was already consumed");
      this.authorities.set(key, { authorityId: authority.authorityId, nonce: authority.nonce, consumedAt: new Date(this.now()).toISOString() });
      await this.#persist();
      return true;
    });
  }

  /**
   * Verify and durably consume an authority in one serialized critical
   * section.  Callers must use this immediately before the first dispatch;
   * a separate verify() followed by consume() leaves a restart/replay window.
   */
  verifyAndConsumeAuthority(envelope, options) {
    return this.#queue(async () => {
      await this.ready();
      verifyAuthorityEnvelope(envelope, options);
      const key = `${envelope.authorityId}:${envelope.nonce}`;
      if (this.authorities.has(key)) throw authorityError("authority_replayed", "Authority id/nonce was already consumed");
      this.authorities.set(key, {
        authorityId: envelope.authorityId,
        nonce: envelope.nonce,
        consumedAt: new Date(this.now()).toISOString(),
      });
      await this.#persist();
      return envelope;
    });
  }

  async prepare({ idempotencyKey, fingerprint, binding }) {
    return this.#queue(async () => {
      await this.ready();
      const existing = this.operations.get(idempotencyKey);
      if (existing) {
        if (existing.state === "prepared" && existing.restartRecoveryDisposition === "fresh_retry_allowed" && existing.dispatchCount === 0) {
          // A process restart proved that the previous attempt never reached
          // transport. Rebind the same logical action to the current
          // generation/target and issue a new operation id; this is safe
          // because the old record has an explicit no-dispatch classification.
          const rebound = {
            ...existing,
            operationId: createId("op"),
            fingerprint,
            binding,
            preparedAt: new Date(this.now()).toISOString(),
            restartRecoveryDisposition: null,
            reboundAfterRestartAt: new Date(this.now()).toISOString(),
          };
          this.operations.set(idempotencyKey, rebound);
          await this.#persist();
          return rebound;
        }
        if (existing.fingerprint !== fingerprint) throw authorityError("idempotency_fingerprint_conflict", "Idempotency key was used with a different operation");
        return existing;
      }
      const entry = {
        operationId: createId("op"),
        idempotencyKey,
        fingerprint,
        binding,
        state: "prepared",
        effectState: "no_dispatch",
        dispatchState: "not_dispatched",
        dispatchCount: 0,
        externalActionExecuted: false,
        preparedAt: new Date(this.now()).toISOString(),
      };
      this.operations.set(idempotencyKey, entry);
      await this.#persist();
      return entry;
    });
  }

  async transition(idempotencyKey, state, details = {}) {
    return this.#queue(async () => {
      await this.ready();
      const entry = this.operations.get(idempotencyKey);
      if (!entry) throw authorityError("operation_not_found", "Operation is not in the ledger");
      const allowed = {
        prepared: new Set(["prepared", "dispatched", "blocked"]),
        dispatched: new Set(["dispatched", "applied", "unknown_effect", "blocked"]),
        applied: new Set(["applied"]),
        unknown_effect: new Set(["unknown_effect", "reconciled"]),
        reconciled: new Set(["reconciled"]),
        blocked: new Set(["blocked"]),
      }[entry.state];
      if (!allowed?.has(state)) throw authorityError("operation_transition_invalid", `Invalid operation transition: ${entry.state}->${state}`);
      entry.state = state;
      const explicitEffectState = details.effectState ?? details.effect_state ?? details.operationEffectState ?? details.operation_effect_state;
      const inferredEffectState = state === "unknown_effect"
        ? "unknown_effect"
        : state === "applied"
          ? "known_effect"
          : state === "blocked"
            ? "known_no_effect"
            : operationEffectStateForEntry(entry);
      Object.assign(entry, details, {
        effectState: state === "unknown_effect"
          ? "unknown_effect"
          : normalizeOperationEffectState(explicitEffectState, inferredEffectState),
        dispatchCount: Number.isSafeInteger(details.dispatchCount)
          ? Math.max(0, Math.min(32, details.dispatchCount))
          : state === "dispatched" && (details.operationId || entry.operationId)
            ? Math.max(1, Number.isSafeInteger(entry.dispatchCount) ? entry.dispatchCount : 0)
            : (Number.isSafeInteger(entry.dispatchCount) ? entry.dispatchCount : 0),
        dispatchState: details.dispatchState
          ?? (state === "prepared" ? "not_dispatched" : entry.dispatchState ?? (state === "dispatched" ? "dispatched" : null)),
        updatedAt: new Date(this.now()).toISOString(),
      });
      this.operations.set(idempotencyKey, entry);
      await this.#persist();
      return entry;
    });
  }

  async reconcile(idempotencyKey, binding, result, { brokerEvidence = false } = {}) {
    if (!brokerEvidence) throw authorityError("reconciliation_evidence_required", "Caller-supplied results cannot reconcile an unknown effect");
    return this.#queue(async () => {
      await this.ready();
      const entry = this.operations.get(idempotencyKey);
      if (!entry) throw authorityError("operation_not_found", "Operation is not in the ledger");
      if (canonical(entry.binding) !== canonical(binding)) throw authorityError("reconciliation_binding_mismatch", "Late result does not match operation binding");
      const resultEffectState = normalizeOperationEffectState(
        result?.effectState ?? result?.effect_state ?? result?.operationEffectState ?? result?.operation_effect_state,
        "known_effect",
      );
      if (resultEffectState === "unknown_effect") {
        throw authorityError("reconciliation_effect_still_unknown", "Broker evidence must classify the reconciled result as an observed effect or a known no-effect");
      }
      return this.#transitionUnlocked(entry, "reconciled", {
        resultDigest: payloadDigest(this.secret, result),
        reconciledAt: new Date(this.now()).toISOString(),
        brokerEvidence: true,
        effectState: resultEffectState,
      });
    });
  }

  /**
   * Hide unresolved records from an operator-facing list without changing
   * their state or deleting their evidence.  Every requested record must be
   * owned by the same task/run and be in a reconciliation-pending state; the
   * operation is all-or-nothing and idempotent for a repeated archiveId.
   */
  async archiveOperations({ taskId, runId, operationIds, archiveId, reason, archiveAuthorityId }) {
    return this.#queue(async () => {
      await this.ready();
      if (typeof taskId !== "string" || !taskId.trim()) throw authorityError("task_id_required", "Archive requires a task id");
      if (typeof runId !== "string" || !runId.trim()) throw authorityError("run_id_required", "Archive requires a run id");
      if (!Array.isArray(operationIds) || operationIds.length === 0) throw authorityError("operation_ids_required", "Archive requires at least one operation id");
      if (operationIds.length > 500) throw authorityError("operation_ids_too_large", "Archive operationIds exceeds the supported limit");
      if (typeof archiveId !== "string" || !archiveId.trim()) throw authorityError("archive_id_required", "Archive requires an idempotent archive id");
      if (typeof reason !== "string" || !reason.trim()) throw authorityError("archive_reason_required", "Archive requires a reason");
      const requested = [...new Set(operationIds.map((value) => {
        if (typeof value !== "string" || !value.trim()) throw authorityError("operation_id_invalid", "Archive operation ids must be non-empty strings");
        return value.trim().slice(0, 512);
      }))].sort();
      if (requested.length !== operationIds.length) throw authorityError("operation_ids_duplicate", "Archive operation ids must be unique");
      const entries = requested.map((requestedId) => {
        const byKey = this.operations.get(requestedId);
        if (byKey) return { requestedId, key: requestedId, entry: byKey };
        const match = [...this.operations.entries()].find(([, value]) => value?.operationId === requestedId);
        return match ? { requestedId, key: match[0], entry: match[1] } : null;
      });
      if (entries.some((value) => !value)) {
        throw authorityError("operation_not_found", "Every archive target must exist in the operation ledger", {
          missingOperationIds: entries.filter((value) => !value).map((_, index) => requested[index]),
        });
      }
      const invalid = entries.filter(({ entry }) => entry.state === "task_tab"
        || entry.binding?.taskId !== taskId
        || entry.binding?.runId !== runId
        || !isUnresolvedOperationEffect(entry));
      if (invalid.length > 0) {
        throw authorityError("operation_archive_target_invalid", "Archive targets must be unresolved records owned by the exact task and run", {
          operationIds: invalid.map(({ requestedId }) => requestedId),
        });
      }
      const conflicts = entries.filter(({ entry }) => entry.archiveId && entry.archiveId !== archiveId);
      if (conflicts.length > 0) {
        throw authorityError("operation_archive_conflict", "An operation was already archived with a different archive id", {
          operationIds: conflicts.map(({ requestedId }) => requestedId),
        });
      }
      const alreadyArchived = entries.filter(({ entry }) => entry.archiveId === archiveId);
      const toArchive = entries.filter(({ entry }) => entry.archiveId !== archiveId);
      const archivedAt = new Date(this.now()).toISOString();
      for (const { key, entry } of toArchive) {
        this.operations.set(key, {
          ...entry,
          archiveId,
          archivedAt,
          archiveReason: reason.trim().slice(0, 240),
          archiveAuthorityId: typeof archiveAuthorityId === "string" && archiveAuthorityId.trim() ? archiveAuthorityId.trim().slice(0, 512) : null,
          updatedAt: archivedAt,
        });
      }
      if (toArchive.length > 0) await this.#persist();
      return {
        archiveId,
        archivedAt: toArchive.length > 0 ? archivedAt : (alreadyArchived[0]?.entry.archivedAt ?? null),
        archived: toArchive.map(({ requestedId, entry }) => ({ operationId: entry.operationId ?? null, requestedId, state: entry.state })),
        alreadyArchived: alreadyArchived.map(({ requestedId, entry }) => ({ operationId: entry.operationId ?? null, requestedId, state: entry.state })),
      };
    });
  }

  getReconciliationCounts() {
    const pending = [...this.operations.values()].filter((entry) => isUnresolvedOperationEffect(entry));
    const archived = pending.filter((entry) => typeof entry.archiveId === "string" && entry.archiveId.length > 0);
    return {
      pendingTotal: pending.length,
      pendingArchived: archived.length,
      pendingVisible: pending.length - archived.length,
    };
  }

  recordTaskTab(tab) {
    return this.#queue(async () => {
      await this.ready();
      const source = tab && typeof tab === "object" && !Array.isArray(tab) ? tab : {};
      // New records are always identity-bound.  This also upgrades older
      // callers/tests that only supplied denormalized task-tab fields, while
      // deliberately preserving a supplied identity so stale records can be
      // detected and failed closed instead of silently rewritten.
      const identity = source.targetIdentity && typeof source.targetIdentity === "object" && !Array.isArray(source.targetIdentity)
        && typeof source.targetFingerprint === "string"
        ? { targetIdentity: source.targetIdentity, targetFingerprint: source.targetFingerprint }
        : rebuildTaskTabIdentity(this.secret, source);
      const normalized = {
        ...source,
        targetIdentity: identity.targetIdentity,
        targetFingerprint: identity.targetFingerprint,
        state: "task_tab",
      };
      this.operations.set(`task-tab:${normalized.profileInstanceId}:${normalized.tabId}`, normalized);
      await this.#persist();
      return normalized;
    });
  }
  getTaskTab(profileInstanceId, tabId) { const entry = this.operations.get(`task-tab:${profileInstanceId}:${tabId}`); return entry?.state === "task_tab" ? entry : null; }
  listTaskTabs() { return [...this.operations.values()].filter((entry) => entry.state === "task_tab"); }
  removeTaskTab(profileInstanceId, tabId) { return this.#queue(async () => { await this.ready(); const removed = this.operations.delete(`task-tab:${profileInstanceId}:${tabId}`); if (removed) await this.#persist(); return removed; }); }

  /**
   * Detach browser-tab retention from an unresolved operation (or an orphaned
   * task tab when `detachOrphaned` is requested) after its owner transport is
   * gone. The operation/capsule evidence is intentionally left untouched as
   * `unknown_effect` when applicable; only the visible tab becomes
   * disposable. This is the crash-safe boundary: a later run may start with
   * a fresh tab, but it may not replay the original idempotency key.
   */
  async detachUnknownTaskTabs({ profileInstanceId = null, sessionIds = null, reason = "owner_lost", detachOrphaned = false } = {}) {
    return this.#queue(async () => {
      await this.ready();
      const scopedSessions = sessionIds instanceof Set
        ? sessionIds
        : Array.isArray(sessionIds)
          ? new Set(sessionIds.filter((value) => typeof value === "string" && value.length > 0))
          : null;
      const unresolvedOperations = [...this.operations.values()]
        .filter((entry) => entry.state !== "task_tab" && isUnresolvedOperationEffect(entry));
      const unresolvedOperationIds = new Set(unresolvedOperations
        .map((entry) => entry.operationId)
        .filter((value) => typeof value === "string" && value.length > 0));
      const unresolvedTaskRuns = new Set(unresolvedOperations
        .map((entry) => `${entry.binding?.taskId ?? ""}\u0000${entry.binding?.runId ?? ""}`)
        .filter((value) => value !== "\u0000"));
      const detachedAt = new Date(this.now()).toISOString();
      const changed = [];
      for (const [key, entry] of this.operations.entries()) {
        if (entry.state !== "task_tab"
          || (profileInstanceId !== null && entry.profileInstanceId !== profileInstanceId)
          || (scopedSessions && !scopedSessions.has(entry.sessionId))) continue;
      // Explicit retention is a deliberate task-level request to keep the
      // browser surface.  Owner/transport loss may detach ordinary tabs, but
      // it must not silently override that explicit choice.
      if (entry.userHelpRequired === true
        || entry.retentionPolicy === "ledger_only"
        || entry.retentionPolicy === "explicit") continue;
        const unresolvedLifecycle = ["reconciliation_required", "operation_effect_unknown"].includes(entry.lifecycleState);
        const unresolvedOperation = unresolvedOperationIds.has(entry.operationId)
          || unresolvedTaskRuns.has(`${entry.taskId ?? ""}\u0000${entry.runId ?? ""}`);
        // Completed and uncertain local edits need their original page after
        // an MCP socket disconnect. Preserve this continuation checkpoint;
        // external effects retain their own reconciliation path.
        if (!unresolvedLifecycle && !unresolvedOperation
          && entry.retentionPolicy === "retain_until_resume"
          && ["partial_actions_applied", "local_ui_effect_unknown"].includes(entry.retentionReason)) continue;
      const orphanedLifecycle = detachOrphaned
        && entry.retentionPolicy !== "explicit"
        && entry.lifecycleState !== "awaiting_user"
          && (entry.lifecycleState === "completed"
            || entry.lifecycleState === "failed"
            || entry.lifecycleState === "discovered"
            || entry.lifecycleState === "admitted"
            || entry.lifecycleState === "target_bound"
            || entry.lifecycleState === "pre_read"
            || entry.lifecycleState === "executing"
            || entry.lifecycleState === "post_read");
        if (!unresolvedLifecycle && !unresolvedOperation && !orphanedLifecycle) continue;
        const next = {
          ...entry,
          retentionPolicy: "ledger_only",
          resumeToken: null,
          userHelpRequired: false,
          retentionReason: "unknown_effect_ledger_only",
          whyTabWasKept: "The browser tab is disposable after owner loss; the signed operation ledger and task capsule remain the restart record.",
          requiredUserAction: null,
          resumeAction: "start_fresh_task_with_ledger_warning",
          ledgerOnlyAt: detachedAt,
          ledgerOnlyReason: String(reason || "owner_lost").slice(0, 240),
          updatedAt: detachedAt,
          state: "task_tab",
        };
        this.operations.set(key, next);
        changed.push(next);
      }
      if (changed.length > 0) await this.#persist();
      return changed;
    });
  }

  getProfileBinding(profileInstanceId) { return this.profileBindings.get(profileInstanceId) ?? null; }
  listProfileBindings() { return [...this.profileBindings.values()]; }
  getHandoffAck(ackDigest) { return this.handoffAcks.get(String(ackDigest ?? "")) ?? null; }
  listHandoffAcks() { return [...this.handoffAcks.values()].slice(-100); }
  recordHandoffAck(ack) {
    return this.#queue(async () => {
      await this.ready();
      if (!ack || ack.schema !== HANDOFF_ACK_SCHEMA || typeof ack.ackDigest !== "string") {
        throw authorityError("handoff_ack_invalid", "Invalid handoff acknowledgement");
      }
      this.handoffAcks.set(ack.ackDigest, { ...ack });
      await this.#persist();
      return ack;
    });
  }
  recordProfileBinding(profile) {
    return this.#queue(async () => {
      await this.ready();
      const entry = {
        profileInstanceId: profile.profileInstanceId,
        extensionRuntimeId: profile.extensionRuntimeId,
        buildId: profile.buildId ?? null,
        generation: profile.generation,
        updatedAt: new Date(this.now()).toISOString(),
      };
      this.profileBindings.set(entry.profileInstanceId, entry);
      await this.#persist();
      return entry;
    });
  }

  transferTaskTabs({ profileInstanceId, generation, sourceTaskId, destinationTaskId, runId, sessionId, tabIds, receiptSha256, transferredAt }) {
    return this.#queue(async () => {
      await this.ready();
      const current = tabIds.map((tabId) => this.getTaskTab(profileInstanceId, tabId));
      if (current.some((entry) => !entry
        || entry.generation !== generation
        || entry.taskId !== sourceTaskId
        || entry.retentionPolicy === "cleanup"
        || entry.quarantine)) {
        throw authorityError("handoff_tab_ownership_changed", "Task-tab provenance changed before the handoff transfer committed");
      }
      const transferred = current.map((entry) => {
        const identity = rebuildTaskTabIdentity(this.secret, entry, {
          taskId: destinationTaskId,
          sessionId,
          leaseId: null,
          generation,
          profileInstanceId,
          tabId: entry.tabId,
        });
        return {
          ...entry,
          taskId: destinationTaskId,
          runId,
          sessionId,
          generation,
          profileInstanceId,
          targetIdentity: identity.targetIdentity,
          targetFingerprint: identity.targetFingerprint,
          handoffSourceTaskId: sourceTaskId,
          handoffReceiptSha256: receiptSha256,
          transferredAt,
          updatedAt: transferredAt,
          state: "task_tab",
        };
      });
      for (const entry of transferred) {
        this.operations.set(`task-tab:${entry.profileInstanceId}:${entry.tabId}`, entry);
      }
      if (transferred.length > 0) await this.#persist();
      return transferred;
    });
  }

  async quarantineTaskTabs(profileInstanceId, reason = "stale_generation") {
    return this.#queue(async () => {
      await this.ready();
      const quarantinedAt = new Date(this.now()).toISOString();
      const changed = [];
      for (const [key, entry] of this.operations.entries()) {
        if (entry.state !== "task_tab" || entry.profileInstanceId !== profileInstanceId || entry.quarantine === "stale_generation") continue;
        const next = { ...entry, quarantine: "stale_generation", quarantineReason: reason, quarantinedAt, updatedAt: quarantinedAt };
        this.operations.set(key, next);
        changed.push(next);
      }
      if (changed.length > 0) await this.#persist();
      return changed;
    });
  }

  async putTaskCapsule(capsule) {
    return this.#queue(async () => {
      await this.ready();
      if (!capsule || capsule.schema !== TASK_EXECUTION_CAPSULE_SCHEMA) throw authorityError("task_capsule_invalid", "Invalid task execution capsule");
      this.capsules.set(capsule.capsuleId, capsule);
      await this.#persist();
      return capsule;
    });
  }

  async transitionTaskCapsule(capsuleId, state, details = {}) {
    return this.#queue(async () => {
      await this.ready();
      const current = this.capsules.get(capsuleId);
      if (!current) throw authorityError("task_capsule_not_found", "Task execution capsule was not found");
      const next = transitionTaskExecutionCapsule(current, state, details, new Date(this.now()).toISOString());
      this.capsules.set(capsuleId, next);
      await this.#persist();
      return next;
    });
  }

  // Commit the operation effect and its capsule together. Updating only the
  // lifecycle left completed reconciliations permanently UNKNOWN to status,
  // resume, and the scheduler, even after signed same-target success proof.
  async completeTaskReconciliation(capsuleId, details, { brokerEvidence = false, proofDigest } = {}) {
    if (!brokerEvidence || typeof proofDigest !== "string" || !proofDigest) {
      throw authorityError("reconciliation_evidence_required", "Task reconciliation requires broker-verified readback evidence");
    }
    return this.#queue(async () => {
      await this.ready();
      const capsule = this.capsules.get(capsuleId);
      if (!capsule || capsule.state !== "reconciliation_required" || !capsule.effect?.idempotencyKey) {
        throw authorityError("task_reconciliation_state_invalid", "Only an unresolved task capsule may be reconciled");
      }
      const keyPrefix = `${capsule.effect.idempotencyKey}:`;
      const operations = this.listOperations().filter(entry =>
        entry.idempotencyKey.startsWith(keyPrefix)
        && /^\d+$/u.test(entry.idempotencyKey.slice(keyPrefix.length))
        && entry.binding?.taskId === capsule.taskId
        && entry.binding?.runId === capsule.runId
        && entry.binding?.tabId === capsule.resources?.tabId
        && entry.binding?.profileInstanceId === capsule.target?.profileInstanceId
        && isUnresolvedOperationEffect(entry));
      if (operations.length > 1) throw authorityError("task_reconciliation_operation_ambiguous", "Several unresolved operations require separate evidence");
      const now = new Date(this.now()).toISOString();
      const oldProgress = capsule.effect.actionProgress;
      const reconciledIndices = oldProgress?.uncertain_action_indices ?? [];
      const actionProgress = oldProgress ? {
        ...oldProgress,
        applied_action_indices: [...new Set([...(oldProgress.applied_action_indices ?? []), ...reconciledIndices])].sort((a, b) => a - b),
        verified_action_indices: [...new Set([...(oldProgress.verified_action_indices ?? []), ...reconciledIndices])].sort((a, b) => a - b),
        uncertain_action_indices: [],
        failed_action_index: null,
        failed_action_effect_state: "known_effect",
        reconciled_action_indices: reconciledIndices,
        replay_allowed: false,
      } : undefined;
      const remaining = actionProgress?.remaining_action_indices ?? [];
      const next = transitionTaskExecutionCapsule(capsule, remaining.length ? "failed" : "completed", {
        ...details,
        blocker: null,
        restartPoint: remaining.length ? "read_back_same_target_then_continue_remaining_actions" : null,
        resumeToken: null,
        ...(remaining.length ? { retention: { ...capsule.retention, policy: "retain_until_resume", reason: "partial_actions_applied", userHelpRequired: false, resumeTokenRequired: false } } : {}),
        effect: {
          ...capsule.effect, effectState: "known_effect", externalActionExecuted: true,
          reconciliationRequired: false, reconciledAt: now, reconciliationProofDigest: proofDigest,
          ...(actionProgress ? { actionProgress } : {}),
        },
      }, now);
      for (const entry of operations) {
        this.operations.set(entry.idempotencyKey, {
          ...entry, state: "reconciled", effectState: "known_effect", externalActionExecuted: true,
          reconciliationRequired: false, brokerEvidence: true, reconciledAt: now, updatedAt: now,
          resultDigest: proofDigest,
        });
      }
      this.capsules.set(capsuleId, next);
      await this.#persist();
      return next;
    });
  }

  /**
   * End an ownerless reconciliation after one bounded retention window.  This
   * does not assert that the provider effect did or did not happen: the
   * operation ledger stays `unknown_effect`, while the task capsule becomes a
   * terminal restart record and its browser tab becomes `ledger_only`.  A
   * future run must start from a fresh target and may not replay this key.
   */
  async terminalizeOrphanedReconciliations({
    activeSessionIds = new Set(),
    leasedTabKeys = new Set(),
    ttlMs = 10 * 60_000,
    reason = "orphaned_reconciliation_ttl",
  } = {}) {
    return this.#queue(async () => {
      await this.ready();
      const nowMs = this.now();
      const ttl = Math.max(60_000, Number(ttlMs) || 10 * 60_000);
      const activeSessions = activeSessionIds instanceof Set ? activeSessionIds : new Set(activeSessionIds ?? []);
      const leasedKeys = leasedTabKeys instanceof Set ? leasedTabKeys : new Set(leasedTabKeys ?? []);
      const changedCapsules = [];
      const changedTabs = [];
      const taskTabs = [...this.operations.values()].filter((entry) => entry.state === "task_tab");
      const candidates = [...this.capsules.values()].filter((capsule) =>
        ["reconciliation_required", "operation_effect_unknown"].includes(capsule.state)
        && capsule.retention?.userHelpRequired !== true
        && !activeSessions.has(capsule.target?.sessionId ?? capsule.sessionId));
      for (const current of candidates) {
        const updatedAt = Date.parse(String(current.updatedAt ?? current.createdAt ?? ""));
        if (!Number.isFinite(updatedAt) || nowMs - updatedAt < ttl) continue;
        const matchingTabs = taskTabs.filter((tab) => tab.taskId === current.taskId
          && tab.runId === current.runId
          && tab.profileInstanceId === (current.target?.profileInstanceId ?? current.profileInstanceId)
          && Number.isSafeInteger(current.target?.tabId) && tab.tabId === current.target.tabId);
        if (matchingTabs.some((tab) => tab.userHelpRequired === true
          || tab.retentionPolicy === "explicit"
          || activeSessions.has(tab.sessionId)
          || leasedKeys.has(`${tab.profileInstanceId}:${tab.tabId}`))) continue;
        const terminalAt = new Date(nowMs).toISOString();
        const nextCapsule = transitionTaskExecutionCapsule(current, "failed", {
          blocker: {
            ...(current.blocker ?? {}),
            code: "unresolved_external_effect",
            message: "The owner/session disappeared and the bounded reconciliation window elapsed; effect remains unknown and was not replayed.",
            details: {
              ...(current.blocker?.details ?? {}),
              terminalReason: reason,
              reconciliationTtlMs: ttl,
              effectState: "unknown_effect",
              reconciliationRequired: true,
            },
          },
          restartPoint: "fresh_task_with_ledger_warning",
          resumeToken: null,
          retention: {
            ...(current.retention ?? {}),
            policy: "cleanup",
            resumeTokenRequired: false,
            userHelpRequired: false,
            reason: null,
            whyTabWasKept: null,
            requiredUserAction: null,
            resumeAction: "start_fresh_task_with_ledger_warning",
          },
          effect: {
            ...(current.effect ?? {}),
            effectState: "unknown_effect",
            effectClass: current.effect?.effectClass ?? "external_commit",
            reconciliationRequired: true,
            unresolvedTerminal: true,
            terminalReason: reason,
            terminalizedAt: terminalAt,
          },
        }, terminalAt);
        this.capsules.set(current.capsuleId, nextCapsule);
        changedCapsules.push(nextCapsule);
        for (const tab of matchingTabs) {
          const nextTab = {
            ...tab,
            retentionPolicy: "ledger_only",
            resumeToken: null,
            userHelpRequired: false,
            retentionReason: "unknown_effect_ledger_only",
            whyTabWasKept: "The bounded reconciliation window elapsed; the browser surface is disposable while the unknown-effect ledger remains the restart record.",
            requiredUserAction: null,
            resumeAction: "start_fresh_task_with_ledger_warning",
            ledgerOnlyAt: terminalAt,
            ledgerOnlyReason: reason,
            updatedAt: terminalAt,
            state: "task_tab",
          };
          this.operations.set(`task-tab:${tab.profileInstanceId}:${tab.tabId}`, nextTab);
          changedTabs.push(nextTab);
        }
      }
      if (changedCapsules.length > 0 || changedTabs.length > 0) await this.#persist();
      return { capsules: changedCapsules, taskTabs: changedTabs, ttlMs: ttl, reason };
    });
  }

  /**
   * Reclassify one known false-positive reconciliation capsule that failed
   * before any user/page mutation was dispatched.  This is deliberately
   * stricter than normal reconciliation: the capsule must be a visual target
   * inspection timeout, the exact run may contain only tab setup operations,
   * and the matching live task tab must still be protected for this task.
   */
  async repairPreDispatchReadonlyFailure({ capsuleId, taskId, runId, idempotencyKey, profileInstanceId, tabId, readback = null }) {
    return this.#queue(async () => {
      await this.ready();
      const current = this.capsules.get(capsuleId);
      if (!current) throw authorityError("task_reconciliation_not_found", "No matching task reconciliation capsule exists");
      if (current.state !== "reconciliation_required") {
        throw authorityError("task_reconciliation_state_invalid", `Pre-dispatch repair requires reconciliation_required state, not ${current.state}`);
      }
      if (current.taskId !== taskId || current.runId !== runId || current.effect?.idempotencyKey !== idempotencyKey) {
        throw authorityError("task_reconciliation_target_mismatch", "Pre-dispatch repair does not match the exact task/run/idempotency binding");
      }
      if (current.effect?.effectClass !== "read_only_or_authorized"
        || current.blocker?.code !== "operation_timeout"
        || current.blocker?.details?.method !== "visual.inspectTarget") {
        throw authorityError("pre_dispatch_repair_not_applicable", "The capsule is not the known pre-dispatch visual inspection false positive");
      }
      const taskTab = this.operations.get(`task-tab:${profileInstanceId}:${tabId}`);
      if (!taskTab || taskTab.taskId !== taskId || taskTab.runId !== runId
        || taskTab.profileInstanceId !== profileInstanceId
        || taskTab.tabId !== tabId
        || taskTab.lifecycleState !== "reconciliation_required"
        || taskTab.retentionPolicy !== "retain_until_resume"
        || taskTab.userHelpRequired === true
        || taskTab.quarantine) {
        throw authorityError("pre_dispatch_repair_tab_mismatch", "The exact protected task tab is not eligible for pre-dispatch repair");
      }
      const setupMethods = new Set(["tabs.create", "tabs.groupTask", "tabs.navigate"]);
      const runOperations = this.listOperations().filter((entry) => entry.binding?.taskId === taskId && entry.binding?.runId === runId);
      const unsafeOperations = runOperations.filter((entry) => !setupMethods.has(entry.binding?.method)
        || ["dispatched", "unknown_effect", "reconciled"].includes(entry.state));
      if (unsafeOperations.length > 0) {
        throw authorityError("pre_dispatch_repair_effect_evidence_present", "The exact run contains a mutation or unresolved operation and cannot be reclassified as pre-dispatch", {
          operationIds: unsafeOperations.map((entry) => entry.operationId ?? entry.idempotencyKey),
        });
      }
      const now = new Date(this.now()).toISOString();
      const repair = {
        schema: "aos.chrome_companion.pre_dispatch_readonly_repair.v1",
        kind: "pre_dispatch_readonly_failure",
        brokerEvidence: false,
        mutationDispatchAttempted: false,
        operationEffectState: "none",
        externalActionExecuted: false,
        replayAllowed: false,
        setupOperationIds: runOperations.map((entry) => entry.operationId ?? null).filter(Boolean),
        readback: readback && typeof readback === "object" && !Array.isArray(readback)
          ? {
              url: typeof readback.url === "string" ? readback.url.slice(0, 2_000) : null,
              title: typeof readback.title === "string" ? readback.title.slice(0, 500) : null,
            }
          : null,
        repairedAt: now,
      };
      const nextCapsule = transitionTaskExecutionCapsule(current, "failed", {
        blocker: {
          ...current.blocker,
          details: {
            ...(current.blocker.details ?? {}),
            operationEffectState: "none",
            mutationDispatchAttempted: false,
            repairCode: "pre_dispatch_readonly_failure",
          },
        },
        restartPoint: "task_failure_recovery",
        resumeToken: null,
        repair,
        retention: {
          ...(current.retention ?? {}),
          policy: "cleanup",
          resumeTokenRequired: false,
          userHelpRequired: false,
          reason: null,
          whyTabWasKept: null,
          requiredUserAction: null,
          resumeAction: null,
        },
        updatedAt: now,
      }, now);
      const nextTab = {
        ...taskTab,
        lifecycleState: "failed",
        retentionPolicy: "cleanup",
        resumeToken: null,
        userHelpRequired: false,
        retentionReason: null,
        whyTabWasKept: null,
        requiredUserAction: null,
        resumeAction: null,
        updatedAt: now,
        state: "task_tab",
      };
      this.capsules.set(capsuleId, nextCapsule);
      this.operations.set(`task-tab:${profileInstanceId}:${tabId}`, nextTab);
      await this.#persist();
      return { capsule: nextCapsule, taskTab: nextTab, repair };
    });
  }

  getTaskCapsule(capsuleId) { return this.capsules.get(capsuleId) ?? null; }
  // Return a bounded immutable-shaped snapshot for status/readback consumers.
  // Callers must not mutate the ledger's live capsule objects in place.
  listTaskCapsules() { return [...this.capsules.values()].map((capsule) => ({ ...capsule, target: capsule.target ? { ...capsule.target } : capsule.target })); }
  findTaskCapsule({ taskId, runId, idempotencyKey } = {}) {
    return [...this.capsules.values()].reverse().find((capsule) => capsule.taskId === taskId && capsule.runId === runId
      && (!idempotencyKey || capsule.effect?.idempotencyKey === idempotencyKey)) ?? null;
  }

  #queue(work) {
    const guarded = () => { if (this.persistenceError) throw this.persistenceError; return work(); };
    const next = this.mutex.then(guarded, guarded);
    this.mutex = next.catch(() => {});
    return next;
  }
  async #transitionUnlocked(entry, state, details = {}) { entry.state = state; Object.assign(entry, details, { updatedAt: new Date(this.now()).toISOString() }); this.operations.set(entry.idempotencyKey, entry); await this.#persist(); return entry; }

  #collections() {
    return { operations: this.operations, authorities: this.authorities, taskCapsules: this.capsules,
      profileBindings: this.profileBindings, handoffAcks: this.handoffAcks };
  }

  async #replayJournal(saved) {
    await assertSecureStatePath(this.journalPath);
    this.journalSequence = saved.journalSequence ?? 0;
    if (!Number.isSafeInteger(this.journalSequence) || this.journalSequence < 0) throw new Error("ledger_checkpoint_sequence_invalid");
    let bytes;
    try { bytes = await readFile(this.journalPath); }
    catch (error) { if (error?.code === "ENOENT") return saved; throw error; }
    if (!this.checkpointExists && bytes.length) throw new Error("ledger_checkpoint_missing");
    const maps = {
      operations: new Map((saved.operations ?? []).map((entry) => [entry.idempotencyKey, entry])),
      authorities: new Map((saved.authorities ?? []).map((entry) => [`${entry.authorityId}:${entry.nonce}`, entry])),
      taskCapsules: new Map((saved.taskCapsules ?? []).map((entry) => [entry.capsuleId, entry])),
      profileBindings: new Map((saved.profileBindings ?? []).map((entry) => [entry.profileInstanceId, entry])),
      handoffAcks: new Map((saved.handoffAcks ?? []).map((entry) => [entry.ackDigest, entry])),
    };
    for (const tab of saved.taskTabs ?? []) maps.operations.set(`task-tab:${tab.profileInstanceId}:${tab.tabId}`, { ...tab, state: "task_tab" });
    // A newline commits a complete frame. An interrupted append can leave only
    // the final frame incomplete; committed corruption is never skipped.
    const completeBytes = bytes.lastIndexOf(10) + 1;
    for (const line of bytes.subarray(0, completeBytes).toString("utf8").split("\n").filter(Boolean)) {
      const frame = JSON.parse(line);
      if (frame.schema !== "aos.chrome_companion.ledger_delta.v1" || !Number.isSafeInteger(frame.sequence)
        || frame.sequence < 1 || !frame.changes || typeof frame.changes !== "object") throw new Error("ledger_journal_frame_invalid");
      if (frame.sequence <= (saved.journalSequence ?? 0)) continue; // checkpoint committed before journal truncation
      if (frame.sequence !== this.journalSequence + 1) throw new Error("ledger_journal_sequence_gap");
      for (const [name, entries] of Object.entries(frame.changes)) {
        const map = maps[name];
        if (!map || !Array.isArray(entries)) throw new Error("ledger_journal_collection_invalid");
        for (const pair of entries) {
          if (!Array.isArray(pair) || pair.length !== 2 || typeof pair[0] !== "string"
            || (pair[1] !== null && (typeof pair[1] !== "object" || Array.isArray(pair[1])))) throw new Error("ledger_journal_entry_invalid");
          if (pair[1] === null) map.delete(pair[0]); else map.set(pair[0], pair[1]);
        }
      }
      this.journalSequence = frame.sequence;
      this.journalWrites++;
    }
    if (completeBytes !== bytes.length) {
      const handle = await open(this.journalPath, fsConstants.O_WRONLY | fsConstants.O_NOFOLLOW);
      try { await handle.truncate(completeBytes); await handle.sync(); } finally { await handle.close(); }
    }
    this.journalBytes = completeBytes;
    return { ...saved, operations: [...maps.operations.values()].filter((entry) => entry.state !== "task_tab"),
      taskTabs: [...maps.operations.values()].filter((entry) => entry.state === "task_tab"),
      authorities: [...maps.authorities.values()], taskCapsules: [...maps.taskCapsules.values()],
      profileBindings: [...maps.profileBindings.values()], handoffAcks: [...maps.handoffAcks.values()] };
  }

  async #checkpoint() {
    const serializeStartedAt = performance.now();
    const temporary = `${this.statePath}.tmp-${process.pid}-${randomBytes(6).toString("hex")}`;
    const payload = `${JSON.stringify({ schema: "aos.chrome_companion.operation_ledger.v1", journalSequence: this.journalSequence,
      operations: this.listOperations(), authorities: [...this.authorities.values()], taskTabs: this.listTaskTabs(),
      taskCapsules: [...this.capsules.values()], profileBindings: [...this.profileBindings.values()], handoffAcks: [...this.handoffAcks.values()] })}\n`;
    this.persistenceMetrics.serializeMs = performance.now() - serializeStartedAt;
    const handle = await open(temporary, "wx", 0o600);
    try { await handle.writeFile(payload, "utf8"); await handle.sync(); } finally { await handle.close(); }
    await rename(temporary, this.statePath);
    const directory = await open(dirname(this.statePath), "r");
    try { await directory.sync(); } finally { await directory.close(); }
    // Only after the checkpoint is durable may its covered journal be cleared.
    const journal = await open(this.journalPath, fsConstants.O_WRONLY | fsConstants.O_CREAT | fsConstants.O_NOFOLLOW, 0o600);
    try { await journal.truncate(0); await journal.sync(); } finally { await journal.close(); }
    this.checkpointExists = true;
    this.journalBytes = 0;
    this.journalWrites = 0;
    this.persistenceMetrics.checkpoints++;
    return Buffer.byteLength(payload);
  }

  async #persist() {
    if (this.closed) return;
    const persistStartedAt = performance.now();
    await this.securePathPromise;
    try {
      const serializeStartedAt = performance.now();
      const collections = this.#collections();
      const changes = {};
      for (const [name, map] of Object.entries(collections)) {
        if (map.pending.size) changes[name] = [...map.pending].map((key) => [key, map.get(key) ?? null]);
      }
      if (!Object.keys(changes).length) return;
      let lastBytes;
      let mode;
      if (!this.checkpointExists || this.journalWrites >= 128 || this.journalBytes >= 4 * 1024 * 1024) {
        lastBytes = await this.#checkpoint();
        mode = "checkpoint";
      } else {
        const sequence = this.journalSequence + 1;
        const payload = `${JSON.stringify({ schema: "aos.chrome_companion.ledger_delta.v1", sequence, changes })}\n`;
        this.persistenceMetrics.serializeMs = performance.now() - serializeStartedAt;
        const journal = await open(this.journalPath, fsConstants.O_WRONLY | fsConstants.O_APPEND | fsConstants.O_CREAT | fsConstants.O_NOFOLLOW, 0o600);
        try {
          const info = await journal.stat();
          if (!info.isFile() || info.size !== this.journalBytes) throw new Error("ledger_journal_writer_conflict");
          await journal.writeFile(payload, "utf8");
          await journal.sync();
        } finally { await journal.close(); }
        if (this.journalBytes === 0) {
          const directory = await open(dirname(this.statePath), "r");
          try { await directory.sync(); } finally { await directory.close(); }
        }
        this.journalSequence = sequence;
        lastBytes = Buffer.byteLength(payload);
        this.journalBytes += lastBytes;
        this.journalWrites++;
        mode = "journal";
      }
      for (const map of Object.values(collections)) map.pending.clear();
      const elapsed = performance.now() - persistStartedAt;
      Object.assign(this.persistenceMetrics, { mode, writes: this.persistenceMetrics.writes + 1,
        totalMs: this.persistenceMetrics.totalMs + elapsed, lastMs: elapsed, lastBytes, journalBytes: this.journalBytes });
      const modeMetrics = this.persistenceMetrics.byMode[mode];
      Object.assign(modeMetrics, { writes: modeMetrics.writes + 1, totalMs: modeMetrics.totalMs + elapsed,
        maxMs: Math.max(modeMetrics.maxMs, elapsed), totalBytes: modeMetrics.totalBytes + lastBytes,
        serializeMsTotal: modeMetrics.serializeMsTotal + this.persistenceMetrics.serializeMs,
        serializeMsMax: Math.max(modeMetrics.serializeMsMax, this.persistenceMetrics.serializeMs) });
    } catch (error) {
      // Do not admit another operation after an unconfirmed persistence write.
      // Restart recovery must read durable state before any subsequent dispatch.
      this.persistenceError = error;
      throw error;
    }
  }
}

async function assertSecureStatePath(path) {
  const absolute = resolve(path);
  const parts = absolute.split("/").filter(Boolean);
  let current = "/";
  for (const part of parts) {
    current = join(current, part);
    try {
      const stat = await lstat(current);
      // macOS exposes /var as a system compatibility symlink to /private/var;
      // the user-controlled suffix is still checked strictly.
      if (stat.isSymbolicLink() && current !== "/var" && current !== "/tmp") throw new Error("ledger_state_symlink_path");
    } catch (error) {
      if (error?.code === "ENOENT") break;
      throw error;
    }
  }
  await mkdir(dirname(absolute), { recursive: true, mode: 0o700 });
  await chmod(dirname(absolute), 0o700);
}
