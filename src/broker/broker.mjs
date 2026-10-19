import { EventEmitter } from "node:events";
import { AsyncLocalStorage } from "node:async_hooks";
import { createHash } from "node:crypto";
import { createServer } from "node:net";
import { dirname, join } from "node:path";
import {
  DEFAULT_OPERATION_TIMEOUT_MS,
  DEFAULT_OPERATION_TIMEOUTS_MS,
  EXTENSION_METHODS,
  MUTATION_METHODS,
  PROFILE_GLOBAL_METHODS,
  PRODUCT_VERSION,
  PROTOCOL_VERSION,
  OPERATION_SCHEMA,
  OPERATION_SCHEMA_DIGEST,
  OPERATION_SCHEMA_VERSION,
  DEFAULT_CAPABILITIES,
  AUTHORIZED_TRANSACTION_METHODS,
  SESSION_TTL_MS,
  STALE_IDLE_SESSION_MS,
  TARGET_METHODS,
} from "../shared/constants.mjs";
import {
  BUNDLE_TREE_SHA256,
  EXTENSION_TREE_SHA256,
  INSTALL_BUILD_ID,
  NATIVE_RECORDER_SHA256,
} from "../shared/build-info.mjs";
import { ACTION_EVENT_CONTRACT, operationCapabilityDocument } from "../shared/operation-schema.mjs";
import { verifyDownloadedArtifact } from "./download-artifact.mjs";
import { CompanionError, normalizeError } from "../shared/errors.mjs";
import { JsonLineDecoder, writeJsonLine } from "../shared/framing.mjs";
import { createId } from "../shared/ids.mjs";
import { secureEqual } from "../shared/security.mjs";
import { operationHistory } from "../shared/operation-history.mjs";
import { assertCanvasVisualPatchUnchanged, readCanvasVisualPatch } from "../shared/visual-canvas.mjs";
import { readHandoffSourceGate, resolveHandoffReceiptsDir, validateHandoffReceipt } from "../shared/handoff-receipt.mjs";
import {
  deriveTaskTargetKey,
  blockerRecoveryContext,
  unresolvedLocalNavigationForTarget,
  archiveReconciliationPayload,
  canonicalPayload,
  capsuleNoEffectSettlement,
  VIEWPORT_CLEANUP_AMENDMENT,
  viewportCleanupCandidate,
  classifyInterruptedEffect,
  authorizedTransactionPayload,
  createHandoffAck,
  extensionReloadPayload,
  normalizeTaskExecutionCapsule,
  normalizeTargetIdentity,
  isUnresolvedOperationEffect,
  normalizeOperationEffectState,
  isUncertainLocalNavigationEffect,
  operationRequiresReconciliation,
  uncertaintyBlocksContinuation,
  operationEffectStateForEntry,
  operationEffectProofPayload,
  signOperationEffectProof,
  payloadDigest,
  uploadReconciliationPayload,
  localEditorReconciliationPayload,
  verifyOriginalEditorPayload,
  localSelectionReconciliationPayload,
  verifyOriginalSelectionPayload,
  localNavigationTargetDigest,
  localNavigationTargetDigestFromKey,
  repairPreDispatchReadonlyPayload,
  rebuildTaskTabIdentity,
  TaskOperationLedger,
  taskTabIdentityConsistent,
  targetIdentityDigest,
  targetRecoveryPayload,
  validateTargetRecoverySource,
  TERMINAL_LEDGER_RETENTION_MS,
} from "../shared/task-runtime.mjs";
import { bindTransactionStep, compileTransactionSteps } from "../shared/step-packet.mjs";
import { captureTransactionReadback, readSubmissionTransition, semanticReadback, transactionOutcome } from "../shared/transaction-readback.mjs";
import { createRecoveryHandle, deriveRecoveryIndex } from "../shared/recovery-state.mjs";
import { createRuntimeAttestation } from "../shared/runtime-attestation.mjs";
import { buildProvenanceMismatches } from "../shared/build-provenance.mjs";
import { historicalRefreshContractMatches, readRefreshContractHistory } from "../shared/refresh-contract-history.mjs";
import { operationAuditPage, taskStatusPayload } from "../shared/operation-audit.mjs";
import { resolveDynamicTaskTarget } from "../shared/dynamic-target-adapter.mjs";
import {
  normalizeTimeout,
  requireObject,
  requireString,
  requireTabId,
} from "../shared/validation.mjs";

function nowIso() {
  return new Date().toISOString();
}

// A target proof lives three minutes (was one): runs look at the screenshot and write before they
// click, and the click itself now checks that the element is still the same one (2026-10-19).
// A point proof keeps one minute; the viewport cleanup readback relies on that bound.
const VISUAL_PROOF_TTL_MS = 180_000;

function visualIdentity(element) {
  if (!element || typeof element !== "object" || Array.isArray(element)) return null;
  const identity = {
    tag: String(element.tag ?? "").slice(0, 40),
    role: String(element.role ?? "").slice(0, 60),
    name: String(element.name ?? "").slice(0, 300),
    testId: element.testId == null ? null : String(element.testId).slice(0, 200),
  };
  return identity.tag || identity.role ? identity : null;
}

function sameVisualIdentity(current, expected) {
  const left = visualIdentity(current), right = visualIdentity(expected);
  return Boolean(left && right) && ["tag", "role", "name", "testId"].every((key) => left[key] === right[key]);
}

// No-effect blockers scoped to one target that the same task may recover
// from by reading the target again, with the concrete next step.
const RECOVERABLE_NO_EFFECT_TARGET_BLOCKERS = new Map([
  ["semantic_locator_not_found", "wait_for_page_ready_or_query_current_page_then_refine_locator"],
  ["semantic_locator_ambiguous", "query_current_page_then_refine_locator"],
  ["semantic_locator_scan_limit", "query_current_page_then_refine_locator"],
  ["task_target_unavailable", "companion_reserve_tab_on_the_same_tab_then_retry_with_tabId"],
  ["task_target_tab_missing", "companion_list_tabs_then_reopen_with_startUrl"],
  ["task_target_not_provisioned", "retry_with_startUrl_to_open_a_task_tab"],
]);

// Broker-private provenance: a read's no-effect receipt cannot be interpreted
// as a no-effect claim about an earlier setup or applied mutation.
const READ_ONLY_COMMAND_FAILURE = Symbol("read_only_command_failure");

function validateExpectedActionEvent(method, value) {
  if (value === undefined) return;
  const contract = ACTION_EVENT_CONTRACT;
  const timeoutMs = value?.timeoutMs ?? contract.defaultTimeoutMs;
  if (!value || typeof value !== "object" || Array.isArray(value)
    || !contract.methods.includes(method) || !contract.types.includes(value.type)
    || Object.keys(value).some(key => !["type", "timeoutMs"].includes(key))
    || !Number.isSafeInteger(timeoutMs) || timeoutMs < contract.minTimeoutMs || timeoutMs > contract.maxTimeoutMs) {
    throw new CompanionError("action_event_invalid", "Unsupported pre-armed event request", { operationEffectState: "none", mutationDispatchAttempted: false });
  }
}

const EXTENSION_TIMING_FIELDS = ["total", "tab_create", "navigation_commit", "origin_check", "task_group", "tab_readback"];
function extensionTiming(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const entries = EXTENSION_TIMING_FIELDS.filter(key => Number.isFinite(value[key]) && value[key] >= 0 && value[key] <= 600_000)
    .map(key => [key, value[key]]);
  return entries.length ? Object.fromEntries(entries) : null;
}

const TAB_CLEANUP_PROTECTED_LIFECYCLES = new Set([
  "admitted",
  "target_bound",
  "pre_read",
  "executing",
  "post_read",
  "awaiting_user",
  "reconciliation_required",
  "operation_effect_unknown",
]);

const TAB_CLEANUP_PROTECTED_RETENTION = new Set([
  "explicit",
  "retain_until_resume",
]);

// `ledger_only` deliberately applies to task-tab records, not provider
// effect state.  It means the browser surface may be disposed after the
// owner/transport is lost while the operation ledger and task capsule remain
// immutable evidence.  A fresh task/tab is required; the old operation is
// never replayed.
const LEDGER_ONLY_RETENTION = "ledger_only";

const TASK_TAB_TERMINAL_LIFECYCLES = new Set([
  "discovered",
  "failed",
  "completed",
]);

// A retained task tab is not necessarily active work.  Keep the inventory
// complete for evidence/cleanup, but expose a scoped active count so the
// scheduler and refresh gate cannot treat completed retained tabs as blockers.
const ACTIVE_TASK_TAB_LIFECYCLES = new Set([
  "admitted",
  "target_bound",
  "pre_read",
  "executing",
  "post_read",
  "awaiting_user",
  "reconciliation_required",
  "operation_effect_unknown",
]);

// A missing-record purge is deliberately narrower than reconciliation.  It
// may remove only stale-generation records that are already unresolved and
// have no live tab, lease, or user-help handoff attached to them.
const MISSING_RECORD_PURGE_LIFECYCLES = new Set([
  "reconciliation_required",
  "operation_effect_unknown",
]);

// Retained reconciliation tabs are evidence, not disposable work.  They may
// still be folded into their task group when they are old, unleased, and not
// a user-help surface.  This keeps Chrome visually tidy without closing the
// tab or changing the provider-side effect state.
const VISUAL_COLLAPSE_LIFECYCLES = new Set([
  "reconciliation_required",
  "operation_effect_unknown",
]);

const VISUAL_COLLAPSE_BLOCKING_REASONS = new Set([
  "explicit_preserve",
  "pinned",
  "active_tab",
  "active_group_tab",
  "leased",
  "live_owner_session",
  "user_help_required",
  "resume_token",
  "unsupported_origin",
]);

function isVisualCollapseEligibleTaskTab(entry, reasons, origin) {
  if (!VISUAL_COLLAPSE_LIFECYCLES.has(entry?.lifecycleState)) return false;
  if (!origin || origin === "null") return false;
  return !reasons.some((reason) => VISUAL_COLLAPSE_BLOCKING_REASONS.has(reason));
}

function isLedgerOnlyTaskTab(entry) {
  return entry?.retentionPolicy === LEDGER_ONLY_RETENTION
    && entry.userHelpRequired !== true;
}

// Live canaries are deliberately isolated from user work.  Once their owner
// process has exited, the normal owner-scoped cleanup path cannot touch them
// (and must not be widened to do so).  A separate maintenance route may retire
// only this exact synthetic shape after a fresh inventory and signed approval.

function isSyntheticCanaryOrigin(value) {
  try {
    const origin = new URL(String(value ?? "")).origin;
    return /^http:\/\/(?:127\.0\.0\.1|localhost)(?::\d+)?$/iu.test(origin);
  } catch {
    return false;
  }
}

function isSyntheticCanaryTask(entry, live) {
  if (!entry || !live || entry.userHelpRequired === true || live.pinned === true || live.active === true) return false;
  if (!isSyntheticCanaryOrigin(live.url)) return false;
  return ["reconciliation_required", "operation_effect_unknown"].includes(entry.lifecycleState);
}

const SEMANTIC_TARGET_MUTATION_METHODS = new Set([
  "page.click",
  "page.doubleClick",
  "page.hover",
  "page.setChecked",
  "page.pressKey",
  "page.selectText",
  "page.richText",
  "page.selectOption",
  "page.type",
  "page.submit",
]);

const NAVIGATION_MUTATION_METHODS = new Set([
  "tabs.navigate",
  "tabs.back",
  "tabs.forward",
  "tabs.reload",
]);

const TASK_CONTRACT_SCHEMA = "aos.chrome_companion.task_contract.v1";
const TASK_CONTRACT_VERSION = 1;
const LATE_RESULT_TOMBSTONE_TTL_MS = 5 * 60_000;
const DIRECT_APPLICATION_INTENT = "direct_application";

const DEFAULT_TARGET_OPERATION_CONCURRENCY = 3;
const MAX_TARGET_OPERATION_CONCURRENCY = 8;
const DEFAULT_TARGET_OPERATION_QUEUE_DEPTH = 32;
const MAX_TARGET_OPERATION_QUEUE_DEPTH = 256;
const DEFAULT_ORPHANED_RECONCILIATION_TTL_MS = 10 * 60_000;
const ORPHANED_RECONCILIATION_TTL_MS = boundedEnvironmentInteger(
  "AOS_COMPANION_ORPHANED_RECONCILIATION_TTL_MS",
  DEFAULT_ORPHANED_RECONCILIATION_TTL_MS,
  60_000,
  24 * 60 * 60_000,
);

function timedOutEffectState(operation) {
  if (!operation || typeof operation !== "object") return "unknown_effect";
  return normalizeOperationEffectState(
    operation.effectState ?? operation.effect_state ?? operation.operationEffectState ?? operation.operation_effect_state,
    MUTATION_METHODS.has(operation.method) && operationRequiresReconciliation(operation)
      ? "unknown_effect"
      : "known_no_effect",
  );
}

function timedOutNeedsReconciliation(operation) {
  return timedOutEffectState(operation) === "unknown_effect"
    && (operationRequiresReconciliation(operation) || isUncertainLocalNavigationEffect(operation));
}

function observedNoEffectDetails(error) {
  const details = error?.details ?? {};
  const states = [details.operationEffectState, details.effectState, details.operation_effect_state, details.effect_state]
    .filter(value => value !== undefined && value !== null)
    .map(value => normalizeOperationEffectState(value, "unknown_effect"));
  return states.length > 0 && states.every(state => state === "known_no_effect");
}

export function transactionFailureNoEffectEvidence(error, { operation = null, operationKey = null, preDispatch = false } = {}) {
  const details = error?.details ?? {};
  const matched = operationKey && operation?.idempotencyKey === operationKey ? operation : null;
  const unresolved = ["operation_effect_unknown", "action_event_pending"].includes(error?.code)
    || Number.isSafeInteger(details.createdTabId)
    || (matched && (matched.state === "unknown_effect" || isUncertainLocalNavigationEffect(matched)));
  const claimed = [details.operationEffectState, details.effectState, details.operation_effect_state, details.effect_state]
    .some(value => value !== undefined && value !== null && normalizeOperationEffectState(value, "unknown_effect") === "known_no_effect");
  const effectFields = matched
    ? [matched.effectState, matched.effect_state, matched.operationEffectState, matched.operation_effect_state]
      .filter(value => value !== undefined && value !== null)
      .map(value => normalizeOperationEffectState(value, "unknown_effect"))
    : [];
  const contradictory = Boolean(unresolved || (claimed && (
    details.mutationDispatchAttempted === true || details.externalActionExecuted === true || details.external_action_executed === true
    || matched?.mutationDispatchAttempted === true || matched?.externalActionExecuted === true || matched?.state === "applied"
    || effectFields.some(state => ["unknown_effect", "known_effect"].includes(state))
    || [details.operationEffectState, details.effectState, details.operation_effect_state, details.effect_state]
      .filter(value => value !== undefined && value !== null)
      .some(value => normalizeOperationEffectState(value, "unknown_effect") !== "known_no_effect")
  )));
  const zeroDispatch = matched && ["prepared", "blocked"].includes(matched.state)
    && matched.dispatchCount === 0 && matched.dispatchState === "not_dispatched"
    && matched.mutationDispatchAttempted !== true && matched.externalActionExecuted === false
    && effectFields.length > 0 && effectFields.every(state => state === "no_dispatch")
    && !matched.dispatchedAt;
  const attestedNoMutation = matched && ["blocked", "reconciled"].includes(matched.state)
    && matched.brokerEvidence === true && matched.mutationDispatchAttempted === false
    && effectFields.length > 0 && effectFields.every(state => state === "known_no_effect");
  return {
    knownNoEffect: Boolean(claimed && !contradictory && (preDispatch || zeroDispatch || attestedNoMutation)),
    contradictory,
    unprovenNoEffect: Boolean(claimed && !contradictory && !(preDispatch || zeroDispatch || attestedNoMutation)),
  };
}

function isLocalNavigationReconciliationCapsule(capsule) {
  return Boolean(capsule
    && ["reconciliation_required", "failed"].includes(capsule.state)
    && (capsule.state !== "failed" || capsule.retention?.reason === "local_ui_effect_unknown")
    && capsule.effect?.effectClass === "local_ui"
    && operationEffectStateForEntry(capsule.effect) === "unknown_effect"
    && capsule.effect?.externalActionExecuted !== true);
}

function reconciliationScopeKey(entry = {}) {
  const binding = entry.binding ?? entry;
  const target = binding.targetIdentity ?? entry.targetIdentity ?? entry.target ?? {};
  return [
    binding.taskId ?? entry.taskId ?? target.taskId ?? "",
    binding.runId ?? entry.runId ?? "",
    binding.sessionId ?? entry.sessionId ?? target.sessionId ?? "",
    binding.generation ?? entry.generation ?? target.generation ?? "",
    binding.profileInstanceId ?? entry.profileInstanceId ?? target.profileInstanceId ?? "",
    binding.tabId ?? entry.tabId ?? target.tabId ?? "",
    target.pageInstanceId ?? entry.pageInstanceId ?? "",
    target.windowId ?? entry.windowId ?? "",
    target.frameId ?? entry.frameId ?? 0,
  ].map((value) => String(value ?? "")).join(":");
}

function taskTabReferencesOperation(entry, operation) {
  if (!entry || !operation) return false;
  if (entry.profileInstanceId && operation.profileInstanceId
    && entry.profileInstanceId !== operation.profileInstanceId) return false;
  if (operation.operationId && entry.operationId === operation.operationId) return true;
  const taskId = operation.binding?.taskId ?? operation.taskTabContext?.taskId;
  const runId = operation.binding?.runId ?? operation.taskTabContext?.runId;
  return Boolean(taskId && runId && entry.taskId === taskId && entry.runId === runId);
}

function timedOutOperationHasLiveTaskReference(operation, taskTabEntries) {
  const references = taskTabEntries.filter((entry) => taskTabReferencesOperation(entry, operation));
  // Operations without a task-tab record may be mutations against an
  // existing user tab; keep those in the active gate because there is no safe
  // way to infer that the provider effect is disposable.
  return references.length === 0 || references.some((entry) => !isLedgerOnlyTaskTab(entry));
}

/**
 * Collapse the three durable reconciliation records (task tab, capsule, and
 * operation) into one active task lineage.  The old implementation counted
 * only operations, so a retained capsule/tab could keep Recovery active while
 * status reported zero.  Lineage is deliberately task/run/session/profile/
 * tab-scoped; page/window/frame details remain in each record's signed target
 * identity and are used for exact action binding, not duplicate gate counts.
 */
export function deriveActiveReconciliationCounts({
  taskTabs = [],
  capsules = [],
  operations = [],
  pendingOperations = [],
  timedOutOperations = [],
  activeSessionIds = null,
  leasedTabKeys = null,
} = {}) {
  const list = (value) => Array.isArray(value) ? value.filter(Boolean) : [];
  const liveSessions = activeSessionIds instanceof Set ? activeSessionIds : null;
  const liveLeases = leasedTabKeys instanceof Set ? leasedTabKeys : null;
  const liveRefs = [...list(pendingOperations), ...list(timedOutOperations).filter(timedOutNeedsReconciliation)];
  const hasLiveReference = (entry) => {
    if (!liveSessions && !liveLeases) return true;
    const tabKey = `${entry?.profileInstanceId ?? entry?.targetIdentity?.profileInstanceId ?? ""}:${entry?.tabId ?? entry?.targetIdentity?.tabId ?? ""}`;
    if (liveLeases?.has(tabKey)) return true;
    if (liveSessions?.has(entry?.sessionId ?? entry?.targetIdentity?.sessionId)) return true;
    // A transient operation can outlive its session map entry for one event
    // loop. Keep that exact task/run/tab lineage live until it settles.
    return liveRefs.some((operation) => taskTabReferencesOperation(entry, operation));
  };
  const lineageKey = (entry = {}) => {
    const binding = entry.binding ?? entry;
    const target = binding.targetIdentity ?? entry.targetIdentity ?? entry.target ?? {};
    const values = [
      binding.taskId ?? entry.taskId ?? target.taskId ?? "",
      binding.runId ?? entry.runId ?? "",
      binding.sessionId ?? entry.sessionId ?? target.sessionId ?? "",
      binding.generation ?? entry.generation ?? target.generation ?? "",
      binding.profileInstanceId ?? entry.profileInstanceId ?? target.profileInstanceId ?? "",
      binding.tabId ?? entry.tabId ?? target.tabId ?? "",
    ];
    const rendered = values.map((value) => String(value ?? "")).join("\u0001");
    return rendered.replace(/\u0001+$/u, "") || null;
  };
  const activeTabs = list(taskTabs).filter((entry) => !isLedgerOnlyTaskTab(entry)
    && hasLiveReference(entry)
    && ["reconciliation_required", "operation_effect_unknown"].includes(entry.lifecycleState));
  const activeTabLineages = new Set(activeTabs.map(lineageKey).filter(Boolean));
  const activeTabTaskRuns = new Set(activeTabs.map((entry) => `${entry.taskId ?? ""}\u0000${entry.runId ?? ""}`));
  const refIds = new Set(liveRefs.flatMap((entry) => [entry.operationId, entry.idempotencyKey].filter(Boolean)));
  const refTaskRuns = new Set(liveRefs
    .map((entry) => `${entry.binding?.taskId ?? entry.taskTabContext?.taskId ?? ""}\u0000${entry.binding?.runId ?? entry.taskTabContext?.runId ?? ""}`)
    .filter((value) => value !== "\u0000"));
  const activeCapsules = list(capsules).filter((entry) => {
    if (!["reconciliation_required", "operation_effect_unknown"].includes(entry.state)) return false;
    const taskRun = `${entry.taskId ?? ""}\u0000${entry.runId ?? ""}`;
    return activeTabTaskRuns.has(taskRun)
      || refTaskRuns.has(taskRun)
      || [...activeTabLineages].some((key) => key.startsWith(`${lineageKey(entry) || ""}`));
  });
  const activeCapsuleLineages = new Set(activeCapsules.map(lineageKey).filter(Boolean));
  const activeOperations = list(operations).filter((entry) => isUnresolvedOperationEffect(entry)
    && (activeTabLineages.has(lineageKey(entry))
      || activeCapsuleLineages.has(lineageKey(entry))
      || refIds.has(entry.operationId)
      || refIds.has(entry.idempotencyKey)
      || refTaskRuns.has(`${entry.binding?.taskId ?? ""}\u0000${entry.binding?.runId ?? ""}`)));
  const activeLineages = new Set([
    ...activeTabs.map(lineageKey),
    ...activeCapsules.map(lineageKey),
    ...activeOperations.map(lineageKey),
  ].filter(Boolean));
  return {
    activeTabs,
    activeCapsules,
    activeOperations,
    activeLineages,
    activeCount: activeLineages.size,
    activeTabCount: activeTabs.length,
    activeCapsuleCount: activeCapsules.length,
    activeOperationCount: activeOperations.length,
  };
}

function boundedEnvironmentInteger(name, fallback, minimum, maximum) {
  const value = Number.parseInt(process.env[name] ?? "", 10);
  return Number.isSafeInteger(value) ? Math.min(maximum, Math.max(minimum, value)) : fallback;
}

// Target-scoped reads can run in parallel, but an unbounded number of tabs
// must not starve the foreground/profile-global lane or exhaust Chrome's
// renderer budget.  The defaults are deliberately conservative and can be
// staged per machine with environment variables.
const TARGET_OPERATION_CONCURRENCY = boundedEnvironmentInteger(
  "AOS_COMPANION_TARGET_CONCURRENCY",
  DEFAULT_TARGET_OPERATION_CONCURRENCY,
  1,
  MAX_TARGET_OPERATION_CONCURRENCY,
);
const TARGET_OPERATION_QUEUE_DEPTH = boundedEnvironmentInteger(
  "AOS_COMPANION_TARGET_QUEUE_DEPTH",
  DEFAULT_TARGET_OPERATION_QUEUE_DEPTH,
  1,
  MAX_TARGET_OPERATION_QUEUE_DEPTH,
);

/**
 * A local install stamps both the broker and unpacked Extension with one
 * install-scoped build id.  When the Extension is updated before the resident
 * broker, the old broker must yield so the native host's normal auto-start
 * path can launch the current app.  Development builds intentionally use the
 * shared `dev-local` value and never self-restart on a synthetic test id.
 */
export function shouldRequestBrokerRestartForBuildMismatch(expectedBuildId, receivedBuildId) {
  return /^install-[0-9a-f-]{36}$/u.test(String(expectedBuildId ?? ""))
    && /^install-[0-9a-f-]{36}$/u.test(String(receivedBuildId ?? ""))
    && expectedBuildId !== receivedBuildId;
}

function capabilityDigest(capabilities) {
  return createHash("sha256").update(JSON.stringify([...new Set(capabilities)].sort()), "utf8").digest("hex");
}

function validateCapabilityHandshake(value, { taskId, profile } = {}) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new CompanionError("companion_tool_schema_stale", "A task capability handshake is required before authorized work");
  }
  const required = Array.isArray(value.requiredCapabilities)
    ? [...new Set(value.requiredCapabilities.filter((capability) => typeof capability === "string" && capability.length > 0))].sort()
    : [];
  if (value.schema !== TASK_CONTRACT_SCHEMA || value.version !== TASK_CONTRACT_VERSION || value.taskId !== taskId
    || required.length === 0 || value.capabilityDigest !== capabilityDigest(required)) {
    throw new CompanionError("companion_tool_schema_stale", "Task capability handshake schema or digest is invalid", { taskId });
  }
  const available = [...new Set(Array.isArray(profile?.capabilities) ? profile.capabilities : [])].sort();
  const missing = required.filter((capability) => !available.includes(capability));
  if (missing.length > 0) {
    throw new CompanionError("companion_capability_handshake_failed", "Connected Companion profile does not provide every required task capability", {
      taskId,
      missing,
      available,
    });
  }
  return {
    schema: TASK_CONTRACT_SCHEMA,
    version: TASK_CONTRACT_VERSION,
    taskId,
    requiredCapabilities: required,
    availableCapabilities: available,
    capabilityDigest: capabilityDigest(available),
    profileInstanceId: profile.profileInstanceId,
    generation: profile.generation,
    buildId: profile.buildId ?? null,
    protocolVersion: PROTOCOL_VERSION,
  };
}

// What a reconciliation proof binds of a page.query match: the same element (its per-page
// identity), its role, name and text. Position, focus and other live state are left out: a caret
// moving into a field, a scroll or the tab coming to the front changed them between inspection and
// completion, and every Ashby upload reconciliation failed as reconciliation_readback_changed
// (owner, 2026-10-17: 48 failures in 10 runs in a week).
function stableQueryMatches(matches) {
  return (Array.isArray(matches) ? matches : []).map(match => ({
    tag: match?.tag ?? null, role: match?.role ?? null, name: match?.name ?? null, testId: match?.testId ?? null,
    controlType: match?.controlType ?? null, visible: match?.visible === true, nodeIdentity: match?.nodeIdentity ?? null,
    text: match?.text ?? null,
  }));
}

function semanticTargetStateDigest(secret, locator, inspection) {
  return payloadDigest(secret, {
    locator,
    frameId: inspection?.frameId ?? 0,
    pageInstanceId: inspection?.pageInstanceId ?? null,
    url: inspection?.url ?? null,
    element: inspection?.element ?? null,
    rect: inspection?.rect ?? null,
    clippedRect: inspection?.clippedRect ?? null,
    viewport: inspection?.viewport ?? null,
  });
}

// One near-miss control in a locator error, cut to what a run needs to name it.
function boundedControl(control) {
  const field = (value, max) => (typeof value === "string" ? value.slice(0, max) : null);
  const otherNames = Array.isArray(control?.otherNames)
    ? control.otherNames.filter((name) => typeof name === "string").slice(0, 2).map((name) => name.slice(0, 80)) : [];
  return { role: field(control?.role, 40), name: field(control?.name, 80), tag: field(control?.tag, 20), testId: field(control?.testId, 80),
    ...(otherNames.length ? { otherNames } : {}) };
}

function snapshotTargetDocument(snapshot, locator) {
  const frameId = Number.isSafeInteger(locator?.frameId) ? locator.frameId : 0;
  if (frameId === 0) {
    return {
      frameId: 0,
      url: snapshot?.url ?? null,
      topLevelUrl: snapshot?.topLevelUrl ?? snapshot?.url ?? null,
      pageInstanceId: snapshot?.pageInstanceId ?? null,
    };
  }
  const frame = Array.isArray(snapshot?.frames)
    ? snapshot.frames.find((candidate) => candidate?.frameId === frameId)
    : null;
  return frame
    ? {
      frameId,
      url: frame.url ?? null,
      topLevelUrl: frame.topLevelUrl ?? snapshot?.topLevelUrl ?? null,
      pageInstanceId: frame.pageInstanceId ?? null,
    }
    : null;
}

export function isAllowedTaskFrameOrigin(targetDocument, allowedOrigins = []) {
  if (!targetDocument || !Array.isArray(allowedOrigins)) return false;
  const frameId = Number.isSafeInteger(targetDocument.frameId) ? targetDocument.frameId : 0;
  const candidates = [targetDocument.url];
  // A top-level result may temporarily omit its frame URL while Chrome is
  // settling. It is safe to use topLevelUrl only for frame 0; a nested frame
  // must always prove its own origin.
  if (frameId === 0) candidates.push(targetDocument.topLevelUrl);
  return candidates.some((value) => {
    try {
      const parsed = new URL(String(value ?? ""));
      if (!["http:", "https:"].includes(parsed.protocol)) return false;
      return allowedOrigins.includes(parsed.origin);
    } catch {
      return false;
    }
  });
}

const READ_ONLY_RETRYABLE_ERRORS = new Set([
  "operation_timeout",
  "page_execution_timeout",
  "page_execution_empty",
  "target_frame_unavailable",
]);

// A mutation may already have been applied when its immediate readback or an
// optional upload-confirmation wait fails.  Only those post-dispatch read
// failures promote an `applied` ledger entry to reconciliation; target,
// precondition, and locator failures that happen before dispatch stay blocked.
const POST_DISPATCH_READBACK_ERRORS = new Set([
  "operation_timeout",
  "page_execution_timeout",
  "page_execution_empty",
  "target_frame_unavailable",
  "redirect_origin_escape",
  "upload_file_readback_failed",
  "upload_confirmation_not_observed",
  "upload_confirmation_required",
]);

function isReadOnlyRetryable(method, error) {
  return !MUTATION_METHODS.has(method) && READ_ONLY_RETRYABLE_ERRORS.has(error?.code);
}

function requireAwaitingUserTabRetention(capsule) {
  const retention = capsule?.retention || {};
  const reason = typeof retention.reason === "string" ? retention.reason.trim() : "";
  const whyTabWasKept = typeof retention.whyTabWasKept === "string" ? retention.whyTabWasKept.trim() : "";
  const requiredUserAction = typeof retention.requiredUserAction === "string" ? retention.requiredUserAction.trim() : "";
  const resumeAction = typeof retention.resumeAction === "string" ? retention.resumeAction.trim() : "";
  if (!reason || !whyTabWasKept || !requiredUserAction || !resumeAction) {
    throw new CompanionError(
      "awaiting_user_tab_retention_explanation_required",
      "A user-help tab may be retained only with retention.reason, whyTabWasKept, requiredUserAction, and resumeAction",
    );
  }
  return {
    policy: "retain_until_resume",
    resumeTokenRequired: true,
    userHelpRequired: true,
    reason,
    whyTabWasKept,
    requiredUserAction,
    resumeAction,
  };
}

function taskTabRetentionExplanation(entry, reasons = []) {
  const lifecycleState = entry?.lifecycleState ?? null;
  let retentionReason = entry?.retentionReason ?? null;
  let whyTabWasKept = entry?.whyTabWasKept ?? null;
  let resumeAction = entry?.resumeAction ?? null;

  if (entry?.userHelpRequired === true || lifecycleState === "awaiting_user") {
    retentionReason ||= "user_help_required";
    whyTabWasKept ||= "The task-owned tab contains the exact user-only action needed to resume safely.";
    resumeAction ||= "complete_required_user_action_then_resume_task";
  } else if (isLedgerOnlyTaskTab(entry)) {
    retentionReason ||= "unknown_effect_ledger_only";
    whyTabWasKept ||= "The browser tab is disposable after owner loss; the signed operation ledger and task capsule remain the restart record.";
    resumeAction ||= "start_fresh_task_with_ledger_warning";
  } else if (["reconciliation_required", "operation_effect_unknown"].includes(lifecycleState)) {
    retentionReason ||= "ai_reconciliation_pending";
    whyTabWasKept ||= "The task-owned tab is retained temporarily while Codex reconciles an unknown external effect without replaying it.";
    resumeAction ||= "signed_task_status_readback_then_cleanup_when_reconciled";
  } else if (entry?.quarantine === "stale_generation") {
    retentionReason ||= "stale_generation_quarantine";
    whyTabWasKept ||= "The tab is retained until the previous profile generation is safely reconciled.";
    resumeAction ||= "reconcile_profile_generation_then_cleanup_task_owned_tab";
  } else if (reasons.includes("pinned")) {
    retentionReason ||= "pinned";
    whyTabWasKept ||= "Pinned tabs are never closed by terminal task cleanup.";
  } else if (reasons.includes("active_tab")) {
    retentionReason ||= "active_tab";
    whyTabWasKept ||= "The tab is currently active, so cleanup leaves it visible for the user.";
  } else if (reasons.includes("leased") || reasons.includes("live_owner_session")) {
    retentionReason ||= "active_task_lease";
    whyTabWasKept ||= "The tab is still owned or leased by an active task session.";
    resumeAction ||= "release_task_lease_then_cleanup_task_owned_tab";
  } else if (reasons.includes("explicit_preserve")) {
    retentionReason ||= "explicit_preserve";
    whyTabWasKept ||= "The caller explicitly preserved this task-owned tab for the current workflow.";
  } else if (TASK_TAB_TERMINAL_LIFECYCLES.has(lifecycleState)
    && entry?.userHelpRequired !== true
    && !entry?.resumeToken) {
    retentionReason ||= "terminal_cleanup_pending";
    whyTabWasKept ||= "The task is terminal and this tab is pending the next owner-scoped cleanup pass.";
    resumeAction ||= "cleanup_task_owned_tab";
  } else if (lifecycleState && !TASK_TAB_TERMINAL_LIFECYCLES.has(lifecycleState)) {
    retentionReason ||= "task_still_active";
    whyTabWasKept ||= "The task capsule is not terminal yet, so the tab remains active work.";
    resumeAction ||= "continue_current_task_then_finalize";
  }

  if (!whyTabWasKept) {
    retentionReason ||= reasons[0] ?? "protected";
    whyTabWasKept = "The task-owned tab is retained because it is not yet eligible for safe cleanup.";
  }
  return { retentionReason, whyTabWasKept, resumeAction };
}

export function isSafePreEffectTaskTab(entry, {
  sessionId,
  liveSessionIds = new Set(),
  pendingTaskIds = new Set(),
} = {}) {
  if (!entry || entry.lifecycleState !== "discovered" || entry.retentionPolicy !== "retain") return false;
  if (entry.userHelpRequired === true || entry.resumeToken || entry.quarantine) return false;
  if (pendingTaskIds.has(entry.taskId)) return false;
  if (entry.sessionId && entry.sessionId !== sessionId && liveSessionIds.has(entry.sessionId)) return false;
  return !entry.sessionId || entry.sessionId === sessionId || !liveSessionIds.has(entry.sessionId);
}

export class CompanionBroker extends EventEmitter {
  constructor({ socketPath, secret, issuerSecrets = {}, statePath, sessionTtlMs = SESSION_TTL_MS, handoffReceiptsDir, instanceId = null }) {
    super();
    this.instanceId = instanceId;
    this.socketPath = socketPath;
    this.secret = secret;
    this.issuerSecrets = issuerSecrets;
    this.ledgerSecret = issuerSecrets.aos || issuerSecrets.codex_mcp || "aos-chrome-companion-ledger";
    this.strictAuthority = Object.keys(issuerSecrets).length > 0;
    this.operationTimingContext = new AsyncLocalStorage();
    this.requestContext = new AsyncLocalStorage();
    this.activeRequests = new Map();
    this.taskLedger = new TaskOperationLedger({ statePath: statePath ?? join(dirname(socketPath), "broker-state.json"), secret: this.ledgerSecret });
    this.handoffReceiptsDir = handoffReceiptsDir ?? resolveHandoffReceiptsDir();
    this.sessionTtlMs = sessionTtlMs;
    this.accepting = false;
    this.startupSockets = new Set();
    this.server = createServer(socket => {
      if (this.accepting) return this.#accept(socket);
      socket.pause();
      this.startupSockets.add(socket);
      socket.once("close", () => this.startupSockets.delete(socket));
    });
    this.peers = new Map();
    this.profiles = new Map();
    this.sessions = new Map();
    this.leases = new Map();
    this.tabLeaseIndex = new Map();
    this.pendingOperations = new Map();
    this.operationQueues = new Map();
    // A per-profile FIFO target lane provides bounded backpressure while
    // retaining parallelism across distinct task-owned tabs.  Profile-global
    // operations continue to use their existing serial queue.
    this.targetLanes = new Map();
    // Timed-out operations are removed from the active queue immediately so
    // status cannot report ghost pending work. Their bounded tombstones still
    // accept one late Extension result for signed reconciliation.
    this.timedOutOperations = new Map();
    this.taskTargetReservations = new Map();
    this.extensionReloadInFlight = new Map();
    this.taskTabs = new Map();
    this.expiringSessions = new Set();
    // Ownerless ledger-only tabs are disposable browser surface after a
    // transport/profile loss. Keep one bounded cleanup pass per profile so a
    // reconnect (or the periodic session sweep) cannot leave stale tabs
    // accumulating, while active/pinned/user-help/leased tabs stay protected.
    this.ownerlessCleanupInFlight = new Set();
    this.reconciliationExpiryInFlight = false;
    this.consumedVisualProofs = new Map();
    this.consumedReconciliationProofs = new Map();
    this.profileRegistrationFailures = new Map();
    this.closing = false;
    this.startedAt = nowIso();
    this.cleanupTimer = null;
  }

  async listen() {
    // The listening socket is the single-writer claim. Losing auto-start
    // contenders must exit before loading or normalizing the shared journal.
    await new Promise((resolve, reject) => {
      const onError = (error) => {
        this.server.off("listening", onListening);
        reject(error);
      };
      const onListening = () => {
        this.server.off("error", onError);
        resolve();
      };
      this.server.once("error", onError);
      this.server.once("listening", onListening);
      this.server.listen(this.socketPath);
    });
    try {
      await this.taskLedger.ready();
      // Rehydrate the last known Profile 2 identity as explicitly disconnected
      // state.  A cold broker restart must not erase the profile selector: the
      // next Extension hello can then reattach the same generation, while
      // offline maintenance can distinguish one idle profile from an ambiguous
      // or missing profile without inventing a new owner.
      for (const binding of this.taskLedger.listProfileBindings()) {
        if (!binding?.profileInstanceId || !binding.extensionRuntimeId || !binding.generation) continue;
        this.profiles.set(binding.profileInstanceId, {
          ...binding,
          connected: false,
          connectedAt: binding.updatedAt ?? null,
          disconnectedAt: nowIso(),
          capabilities: [],
          operationSchema: null,
          operationSchemaDigest: null,
          operationSchemaVersion: null,
          capabilitiesDigest: null,
          peerId: null,
        });
      }
      this.#restoreExtensionReloadReservations();
      // A broker restart means every former logical owner is gone.  Detach only
      // tabs backed by an unresolved operation; the effect ledger/capsules stay
      // unknown and immutable, while the browser tab becomes disposable for a
      // later owner-scoped cleanup pass.
      const detached = await this.taskLedger.detachUnknownTaskTabs({ reason: "broker_restart", detachOrphaned: true });
      const detachedByKey = new Map(detached.map((entry) => [this.#tabKey(entry.profileInstanceId, entry.tabId), entry]));
      for (const taskTab of this.taskLedger.listTaskTabs()) {
        const refreshed = detachedByKey.get(this.#tabKey(taskTab.profileInstanceId, taskTab.tabId)) ?? taskTab;
        this.taskTabs.set(this.#tabKey(refreshed.profileInstanceId, refreshed.tabId), refreshed);
      }
      this.accepting = true;
      for (const socket of this.startupSockets) {
        if (!socket.destroyed) { this.#accept(socket); socket.resume(); }
      }
      this.startupSockets.clear();
      this.cleanupTimer = setInterval(() => {
        this.#expireSessions();
        void this.#terminalizeOrphanedReconciliations();
        this.#cleanupOwnerlessLedgerOnlyTabs();
        void this.taskLedger.gcTerminal({ retentionMs: TERMINAL_LEDGER_RETENTION_MS }).catch(() => null);
      }, 15_000);
      this.cleanupTimer.unref();
      this.emit("listening", { socketPath: this.socketPath });
    } catch (error) {
      for (const socket of this.startupSockets) socket.destroy();
      this.startupSockets.clear();
      this.taskLedger.close();
      await new Promise(resolve => this.server.close(resolve));
      throw error;
    }
  }

  async close() {
    this.closing = true;
    clearInterval(this.cleanupTimer);
    for (const socket of this.startupSockets) socket.destroy();
    this.startupSockets.clear();
    if (!this.taskLedger.readyPromise || this.taskLedger.closed) {
      this.taskLedger.close();
      await new Promise(resolve => this.server.close(resolve));
      return;
    }
    for (const peer of this.peers.values()) {
      peer.socket.destroy();
    }
    const transitions = [];
    for (const operation of this.pendingOperations.values()) {
      clearTimeout(operation.timer);
      if (operation.idempotencyKey) transitions.push(this.taskLedger.transition(operation.idempotencyKey, "unknown_effect", { operationId: operation.operationId, reason: "broker_stopped" }));
      operation.reject(new CompanionError("broker_stopped", "Broker stopped before operation completed"));
    }
    this.timedOutOperations.clear();
    await Promise.allSettled(transitions);
    const detached = await this.taskLedger.detachUnknownTaskTabs({ reason: "broker_stopped", detachOrphaned: true });
    for (const taskTab of detached) {
      this.taskTabs.set(this.#tabKey(taskTab.profileInstanceId, taskTab.tabId), taskTab);
    }
    this.taskLedger.close();
    await new Promise((resolve) => this.server.close(() => resolve()));
  }

  snapshot({ taskId = null } = {}) {
    const scopedTaskId = typeof taskId === "string" && taskId.length > 0 ? taskId : null;
    const sessionEntries = [...this.sessions.values()].filter((session) => !scopedTaskId || session.taskId === scopedTaskId);
    const logicalSessions = sessionEntries
      .sort((left, right) => left.createdAt.localeCompare(right.createdAt))
      .slice(0, 100)
      .map((session) => ({
        ...this.#publicSession(session),
        ownerTaskId: session.taskId ?? null,
        ownerKind: session.taskId ? "codex_task" : "unbound_client",
        lastSeenAt: new Date(session.lastSeenAt).toISOString(),
        leaseIds: [...session.leaseIds].sort().slice(0, 100),
        leaseCount: session.leaseIds.size,
        leaseIdsTruncated: session.leaseIds.size > 100,
      }));
    const exactTabLeases = [...this.leases.values()]
      .filter((lease) => !scopedTaskId || this.sessions.get(lease.sessionId)?.taskId === scopedTaskId)
      .sort((left, right) => left.acquiredAt.localeCompare(right.acquiredAt))
      .slice(0, 100)
      .map((lease) => {
        const session = this.sessions.get(lease.sessionId);
        return {
          ...this.#publicLease(lease),
          taskId: session?.taskId ?? null,
          ownerTaskId: session?.taskId ?? null,
          ownerKind: session?.taskId ? "codex_task" : "unbound_client",
          sessionLabel: session?.label ?? null,
        };
      });
    const taskTabEntries = [...this.taskTabs.values()]
      .filter((entry) => !scopedTaskId || entry.taskId === scopedTaskId);
    const taskTabs = taskTabEntries
      .sort((left, right) => left.tabId - right.tabId)
      .slice(0, 500)
      .map((entry) => {
        const retention = taskTabRetentionExplanation(entry);
        return {
          profileInstanceId: entry.profileInstanceId,
          generation: entry.generation,
          tabId: entry.tabId,
          taskId: entry.taskId,
          runId: entry.runId ?? null,
          sessionId: entry.sessionId ?? null,
          lifecycleState: entry.lifecycleState ?? null,
          targetIdentity: entry.targetIdentity ?? null,
          targetFingerprint: entry.targetFingerprint ?? null,
          identityConsistent: taskTabIdentityConsistent(this.ledgerSecret, entry),
          identityRepairReason: entry.identityRepairReason ?? null,
          retentionPolicy: entry.retentionPolicy ?? null,
          tabDisposition: isLedgerOnlyTaskTab(entry) ? "ledger_only" : "retained",
          ledgerOnlyAt: entry.ledgerOnlyAt ?? null,
          ledgerOnlyReason: entry.ledgerOnlyReason ?? null,
          userHelpRequired: entry.userHelpRequired === true,
          retentionReason: retention.retentionReason,
          whyTabWasKept: retention.whyTabWasKept,
          requiredUserAction: entry.requiredUserAction ?? null,
          resumeAction: retention.resumeAction,
          quarantine: entry.quarantine ?? null,
        };
      });
    const liveSessionIds = new Set(sessionEntries.map((session) => session.sessionId));
    const liveTaskTab = (entry) => {
      if (liveSessionIds.has(entry.sessionId)) return true;
      if (this.tabLeaseIndex.has(this.#tabKey(entry.profileInstanceId, entry.tabId))) return true;
      // Keep a task tab live for the short window where a request is still
      // settling even if the session map has already been removed.
      return [...this.pendingOperations.values(), ...this.timedOutOperations.values()]
        .some((operation) => taskTabReferencesOperation(entry, operation));
    };
    const cleanupEligibleTaskTabs = taskTabEntries.filter((entry) =>
      (TASK_TAB_TERMINAL_LIFECYCLES.has(entry.lifecycleState)
        || isLedgerOnlyTaskTab(entry))
      && entry.userHelpRequired !== true
      && !entry.resumeToken
      && !this.tabLeaseIndex.has(this.#tabKey(entry.profileInstanceId, entry.tabId))
      && (entry.retentionPolicy === "cleanup"
        || entry.quarantine === "stale_generation"
        || isLedgerOnlyTaskTab(entry)));
    const ownerlessTerminalTaskTabs = taskTabEntries.filter((entry) =>
      TASK_TAB_TERMINAL_LIFECYCLES.has(entry.lifecycleState)
      && entry.userHelpRequired !== true
      && !entry.resumeToken
      && (!entry.sessionId || !liveSessionIds.has(entry.sessionId)));
    const activeTaskTabs = taskTabEntries.filter((entry) =>
      ACTIVE_TASK_TAB_LIFECYCLES.has(entry.lifecycleState)
      && !isLedgerOnlyTaskTab(entry)
      && liveTaskTab(entry));
    const terminalCleanupPendingTaskTabs = ownerlessTerminalTaskTabs.filter((entry) =>
      taskTabRetentionExplanation(entry).retentionReason === "terminal_cleanup_pending");
    const reconciliationCounts = this.taskLedger.getReconciliationCounts();
    const targetLaneMetrics = [...this.targetLanes.entries()]
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([profileInstanceId, lane]) => ({
        profileInstanceId,
        active: lane.active,
        queued: lane.pending.length,
        maxActive: lane.maxActive,
        admitted: lane.admitted,
        completed: lane.completed,
        rejected: lane.rejected,
        queueWaitMsTotal: lane.queueWaitMsTotal,
        queueWaitMsMax: lane.queueWaitMsMax,
      }));
    const operationBelongsToScope = (operation) => !scopedTaskId
      || (operation.binding?.taskId ?? operation.taskTabContext?.taskId) === scopedTaskId;
    const rawPendingOperations = [...this.pendingOperations.values()].filter(operationBelongsToScope);
    const rawTimedOutOperations = [...this.timedOutOperations.values()].filter(operationBelongsToScope);
    const unresolvedTimedOutOperations = rawTimedOutOperations.filter(timedOutNeedsReconciliation);
    const activeTimedOutOperations = unresolvedTimedOutOperations
      .filter((operation) => timedOutOperationHasLiveTaskReference(operation, taskTabEntries)
        && (liveSessionIds.has(operation.sessionId)
          || this.tabLeaseIndex.has(this.#tabKey(operation.profileInstanceId, operation.binding?.tabId))));
    const scopedOperations = this.taskLedger.listOperations()
      .filter((entry) => !scopedTaskId || entry.binding?.taskId === scopedTaskId);
    const rawReconciliationOperations = scopedOperations
      .filter((entry) => isUnresolvedOperationEffect(entry));
    const rawTaskCapsules = this.taskLedger.listTaskCapsules()
      .filter((capsule) => !scopedTaskId || capsule.taskId === scopedTaskId);
    const activeReconciliation = deriveActiveReconciliationCounts({
      taskTabs: taskTabEntries,
      capsules: rawTaskCapsules,
      operations: rawReconciliationOperations,
      pendingOperations: rawPendingOperations,
      timedOutOperations: activeTimedOutOperations,
      activeSessionIds: liveSessionIds,
      leasedTabKeys: new Set([...this.leases.values()].map((lease) => this.#tabKey(lease.profileInstanceId, lease.tabId))),
    });
    const activeReconciliationOperations = activeReconciliation.activeOperations;
    // Recovery state is a live-control signal, not a dump of the immutable
    // evidence ledger.  Once Chrome has been closed (or an owner transport
    // has disappeared), unresolved operations and user-help capsules can
    // remain as history without a browser target to act on.  Feed only the
    // currently referenced records into the canonical state so a fresh task
    // is not presented with a false global waiting/reconciliation gate; the
    // complete historical counts above remain available for audit/readback.
    const activeRecoveryTaskTabs = taskTabEntries.filter((entry) => !isLedgerOnlyTaskTab(entry) && liveTaskTab(entry));
    const activeRecoveryCapsules = rawTaskCapsules.filter((capsule) => {
      const capsuleTaskId = capsule?.taskId ?? null;
      const capsuleRunId = capsule?.runId ?? null;
      const matchingActiveTab = activeRecoveryTaskTabs.some((tab) =>
        tab.taskId === capsuleTaskId
        && (capsuleRunId === null || tab.runId === capsuleRunId));
      const matchingActiveReconciliation = activeReconciliationOperations.some((operation) =>
        operation.binding?.taskId === capsuleTaskId
        && (capsuleRunId === null || operation.binding?.runId === capsuleRunId));
      const userHelp = capsule?.state === "awaiting_user" || capsule?.retention?.userHelpRequired === true;
      const reconciliation = ["reconciliation_required", "operation_effect_unknown"].includes(capsule?.state);
      if (userHelp || reconciliation) return matchingActiveTab || matchingActiveReconciliation;
      return true;
    });
    const historicalReconciliationOperationCount = Math.max(0,
      rawReconciliationOperations.length - activeReconciliation.activeOperationCount
      + unresolvedTimedOutOperations.length - activeTimedOutOperations.length);
    const runtimeProfiles = [...this.profiles.values()].map((profile) => ({
      profileInstanceId: profile.profileInstanceId,
      generation: profile.generation,
      extensionRuntimeId: profile.extensionRuntimeId,
      buildId: profile.buildId ?? null,
      buildCompatibility: this.#profileBuildMismatches(profile).length === 0 ? "current" : "refresh_required",
      buildProvenanceMismatches: this.#profileBuildMismatches(profile),
      bundleTreeSha256: profile.bundleTreeSha256 ?? null,
      extensionTreeSha256: profile.extensionTreeSha256 ?? null,
      nativeRecorderSha256: profile.nativeRecorderSha256 ?? null,
      // Missing handshake fields are intentionally exposed as null.  Filling
      // them with the broker's values would make an older installed
      // Extension look current and would hide the exact refresh boundary.
      operationSchema: profile.operationSchema ?? null,
      operationSchemaDigest: profile.operationSchemaDigest ?? null,
      operationSchemaVersion: profile.operationSchemaVersion ?? null,
      capabilitiesDigest: profile.capabilitiesDigest ?? null,
      expectedBuildId: INSTALL_BUILD_ID,
      expectedBundleTreeSha256: BUNDLE_TREE_SHA256,
      expectedExtensionTreeSha256: EXTENSION_TREE_SHA256,
      expectedNativeRecorderSha256: NATIVE_RECORDER_SHA256,
      connected: profile.connected,
      connectedAt: profile.connectedAt,
      capabilities: profile.capabilities,
      extensionReloadReservation: this.#publicExtensionReloadReservation(
        this.extensionReloadInFlight.get(profile.profileInstanceId),
      ),
    }));
    const queuedByProfile = new Map(targetLaneMetrics.map((lane) => [lane.profileInstanceId, lane.queued]));
    const runtimeUpdatePendingByProfile = new Set(runtimeProfiles
      .filter((profile) => profile.buildId !== profile.expectedBuildId
        || (BUNDLE_TREE_SHA256 && profile.bundleTreeSha256 !== BUNDLE_TREE_SHA256)
        || (EXTENSION_TREE_SHA256 && profile.extensionTreeSha256 !== EXTENSION_TREE_SHA256)
        || (NATIVE_RECORDER_SHA256 && profile.nativeRecorderSha256 !== NATIVE_RECORDER_SHA256)
        || profile.operationSchema !== OPERATION_SCHEMA
        || profile.operationSchemaDigest !== OPERATION_SCHEMA_DIGEST
        || profile.operationSchemaVersion !== OPERATION_SCHEMA_VERSION
        || profile.capabilitiesDigest !== capabilityDigest(DEFAULT_CAPABILITIES))
      .map((profile) => profile.profileInstanceId));
    const recoveryIndex = deriveRecoveryIndex({
      profiles: runtimeProfiles,
      sessions: [...this.sessions.values()],
      leases: [...this.leases.values()].map((lease) => ({ ...lease, taskId: this.sessions.get(lease.sessionId)?.taskId ?? null })),
      pendingOperations: rawPendingOperations,
      // Historical unknown-effect records remain in the top-level evidence
      // counters, but cannot make the current Recovery state non-idle once
      // no live tab/operation references them.
      timedOutOperations: activeTimedOutOperations,
      reconciliationOperations: activeReconciliationOperations,
      taskTabs: taskTabEntries,
      capsules: activeRecoveryCapsules,
      queuedByProfile,
      runtimeUpdatePendingByProfile,
      now: nowIso(),
    });
    const recoveryByTaskId = new Map(recoveryIndex.tasks.map((entry) => [entry.taskId, entry]));
    const taskTabsWithRecovery = taskTabs.map((entry) => ({
      ...entry,
      recoveryState: recoveryByTaskId.get(entry.taskId) ?? null,
    }));
    const recoveryHandles = recoveryIndex.tasks.map((entry) => {
      const tab = taskTabEntries.find((candidate) => candidate.taskId === entry.taskId);
      const capsule = rawTaskCapsules.find((candidate) => candidate.taskId === entry.taskId);
      const profile = runtimeProfiles.find((candidate) => candidate.profileInstanceId === entry.profileInstanceId);
      return createRecoveryHandle(this.ledgerSecret, {
        taskId: entry.taskId,
        runId: tab?.runId ?? capsule?.runId ?? null,
        ownerKey: tab?.sessionId ?? null,
        profileInstanceId: entry.profileInstanceId,
        generation: profile?.generation ?? tab?.generation ?? capsule?.target?.generation ?? null,
        tabId: tab?.tabId ?? capsule?.target?.tabId ?? null,
        pageInstanceId: tab?.targetIdentity?.pageInstanceId ?? capsule?.target?.pageInstanceId ?? null,
        windowId: tab?.targetIdentity?.windowId ?? capsule?.target?.windowId ?? null,
        frameId: tab?.targetIdentity?.frameId ?? capsule?.target?.frameId ?? 0,
        origin: tab?.targetIdentity?.origin ?? capsule?.target?.origin ?? null,
      });
    });
    const runtimeAttestation = createRuntimeAttestation({
      buildId: INSTALL_BUILD_ID,
      productVersion: PRODUCT_VERSION,
      protocolVersion: PROTOCOL_VERSION,
      operationSchema: OPERATION_SCHEMA,
      operationSchemaDigest: OPERATION_SCHEMA_DIGEST,
      operationSchemaVersion: OPERATION_SCHEMA_VERSION,
      capabilities: DEFAULT_CAPABILITIES,
      componentHashes: {
        companion_bundle: BUNDLE_TREE_SHA256,
        companion_extension: EXTENSION_TREE_SHA256,
        native_recorder: NATIVE_RECORDER_SHA256,
      },
    });
    return {
      productVersion: PRODUCT_VERSION,
      brokerInstanceId: this.instanceId,
      expectedBuildId: INSTALL_BUILD_ID,
      runtimeAttestation,
      profileRegistrationFailures: [...this.profileRegistrationFailures.values()].slice(-20),
      extensionReloadReservations: [...this.extensionReloadInFlight.values()]
        .map((reservation) => this.#publicExtensionReloadReservation(reservation))
        .filter(Boolean),
      protocolVersion: PROTOCOL_VERSION,
      startedAt: this.startedAt,
      profiles: runtimeProfiles,
      // Counts are authoritative inventory totals; the arrays below are
      // bounded presentation views and may be truncated at 100 entries.
      logicalSessionCount: sessionEntries.length,
      logicalSessions,
      logicalSessionsTruncated: sessionEntries.length > logicalSessions.length,
      exactTabLeaseCount: [...this.leases.values()]
        .filter((lease) => !scopedTaskId || this.sessions.get(lease.sessionId)?.taskId === scopedTaskId)
        .length,
      exactTabLeases,
      exactTabLeasesTruncated: this.leases.size > exactTabLeases.length,
      pendingOperationCount: rawPendingOperations.length,
      timedOutOperationCount: rawTimedOutOperations.length,
      timedOutOperationUnresolvedCount: unresolvedTimedOutOperations.length,
      // A timed-out mutation remains in the evidence ledger, but once every
      // task-tab reference is ledger-only it is no longer live profile work.
      // Refresh/reload preflight consumes this scoped count instead of
      // mistaking historical unknown evidence for an active browser resource.
      timedOutOperationActiveCount: activeTimedOutOperations.length,
      reconciliationPendingCount: unresolvedTimedOutOperations.length
        + rawReconciliationOperations.length,
      // `reconciliationPendingCount` remains the complete evidence ledger for
      // audit/history compatibility. The scheduler must use the active count:
      // once no current task tab/operation references a record, it is
      // historical evidence and cannot deadlock a fresh profile refresh.
      reconciliationPendingActiveCount: activeReconciliation.activeCount,
      reconciliationPendingActiveTabCount: activeReconciliation.activeTabCount,
      reconciliationPendingActiveCapsuleCount: activeReconciliation.activeCapsuleCount,
      reconciliationPendingActiveOperationCount: activeReconciliation.activeOperationCount,
      reconciliationPendingHistoricalCount: historicalReconciliationOperationCount,
      reconciliationGate: {
        blocksOn: "active_profile_work_only",
        activeCount: activeReconciliation.activeCount,
        activeTabCount: activeReconciliation.activeTabCount,
        activeCapsuleCount: activeReconciliation.activeCapsuleCount,
        activeOperationCount: activeReconciliation.activeOperationCount,
        historicalCount: historicalReconciliationOperationCount,
        evidenceLedgerCount: rawTimedOutOperations.length + rawReconciliationOperations.length,
      },
      // The complete total intentionally remains stable when an owner archives
      // records for display. It is evidence-only; refresh/replay decisions use
      // the active gate above and still require their own signed boundary.
      reconciliationPendingVisibleCount: unresolvedTimedOutOperations.length + reconciliationCounts.pendingVisible,
      reconciliationPendingArchivedCount: reconciliationCounts.pendingArchived,
      queueCount: this.operationQueues.size,
      targetLanePolicy: {
        maxConcurrency: TARGET_OPERATION_CONCURRENCY,
        maxQueueDepth: TARGET_OPERATION_QUEUE_DEPTH,
        fairness: "fifo_per_profile",
        profileGlobalLane: "serial",
        staged: true,
      },
      targetLaneMetrics,
      pendingOperations: [...this.pendingOperations.values()]
        .sort((left, right) => String(left.operationId).localeCompare(String(right.operationId)))
        .slice(0, 100)
        .map((operation) => ({
          operationId: operation.operationId,
          method: operation.method,
          sessionId: operation.sessionId,
          taskId: operation.binding?.taskId ?? null,
          generation: operation.generation,
          profileInstanceId: operation.profileInstanceId,
          idempotencyKey: operation.idempotencyKey ?? null,
          startedAt: operation.startedAt ?? null,
          timedOut: operation.timedOut === true,
          effectState: timedOutEffectState(operation),
          mutationDispatchAttempted: operation.mutationDispatchAttempted === true,
          externalActionExecuted: operation.externalActionExecuted ?? null,
        })),
      pendingOperationsTruncated: rawPendingOperations.length > 100,
      operationLedgerCount: scopedOperations.length + taskTabEntries.length,
      operationLedgerScope: scopedTaskId ? { taskId: scopedTaskId, foreignExcluded: true } : { taskId: null, foreignExcluded: false },
      ledgerPersistence: { ...this.taskLedger.persistenceMetrics },
      // `taskTabCount` is the complete retained inventory.  These scoped
      // counts keep terminal evidence tabs from blocking unrelated work.
      taskTabCount: this.taskTabs.size,
      activeTaskTabCount: activeTaskTabs.length,
      terminalCleanupPendingTaskTabCount: terminalCleanupPendingTaskTabs.length,
      taskTabs: taskTabsWithRecovery,
      taskTabsTruncated: this.taskTabs.size > taskTabsWithRecovery.length,
      quarantinedTaskTabCount: [...this.taskTabs.values()].filter((entry) => entry.quarantine === "stale_generation").length,
      cleanupEligibleTaskTabCount: cleanupEligibleTaskTabs.length,
      ownerlessTerminalTaskTabCount: ownerlessTerminalTaskTabs.length,
      ledgerOnlyTaskTabCount: taskTabEntries.filter((entry) => isLedgerOnlyTaskTab(entry)).length,
      disposableTaskTabCount: taskTabEntries.filter((entry) => isLedgerOnlyTaskTab(entry)
        && !this.tabLeaseIndex.has(this.#tabKey(entry.profileInstanceId, entry.tabId))).length,
      recovery: recoveryIndex,
      recoveryHandles,
      handoffAcks: this.taskLedger.listHandoffAcks(),
    };
  }

  #accept(socket) {
    const peer = {
      id: createId("peer"),
      socket,
      role: null,
      authenticated: false,
      decoder: new JsonLineDecoder(),
      chain: Promise.resolve(),
      profileInstanceIds: new Set(),
      sessionIds: new Set(),
    };
    this.peers.set(peer.id, peer);
    socket.setNoDelay(true);
    const authTimer = setTimeout(() => {
      if (!peer.authenticated) {
        socket.destroy(new CompanionError("peer_auth_timeout", "Peer did not authenticate in time"));
      }
    }, 5_000);
    authTimer.unref();

    socket.on("data", (chunk) => {
      try {
        for (const message of peer.decoder.push(chunk)) {
          peer.chain = peer.chain
            .then(() => this.#handleMessage(peer, message))
            .catch((error) => {
              this.#send(peer, { kind: "peer.error", error: normalizeError(error) });
            });
        }
      } catch (error) {
        this.#send(peer, { kind: "peer.error", error: normalizeError(error, "invalid_json_line") });
        socket.destroy();
      }
    });
    socket.on("error", () => {});
    socket.on("close", () => {
      clearTimeout(authTimer);
      void this.#disconnectPeer(peer).catch(() => null);
    });
  }

  async #handleMessage(peer, message) {
    requireObject(message, "message");
    if (!peer.authenticated) {
      this.#authenticatePeer(peer, message);
      return;
    }
    if (peer.role === "extension-relay") {
      await this.#handleExtensionMessage(peer, message);
      return;
    }
    if (peer.role === "client") {
      void this.#handleClientRequest(peer, message).catch((error) => {
        this.#send(peer, { kind: "peer.error", error: normalizeError(error) });
      });
      return;
    }
    throw new CompanionError("peer_role_invalid", "Authenticated peer has an unsupported role");
  }

  #authenticatePeer(peer, message) {
    if (message.kind !== "peer.hello") {
      throw new CompanionError("peer_auth_required", "First message must be peer.hello");
    }
    if (message.protocolVersion !== PROTOCOL_VERSION) {
      throw new CompanionError(
        "protocol_version_mismatch",
        `Expected protocol ${PROTOCOL_VERSION}`,
        { received: message.protocolVersion },
      );
    }
    if (!secureEqual(message.auth, this.secret)) {
      throw new CompanionError("peer_auth_failed", "Broker authentication failed");
    }
    if (!new Set(["extension-relay", "client"]).has(message.role)) {
      throw new CompanionError("peer_role_invalid", "Peer role is not supported");
    }
    peer.authenticated = true;
    peer.role = message.role;
    this.#send(peer, {
      kind: "peer.ready",
      peerId: peer.id,
      protocolVersion: PROTOCOL_VERSION,
      brokerStartedAt: this.startedAt,
    });
  }

  async #handleExtensionMessage(peer, message) {
    switch (message.kind) {
      case "extension.hello":
        await this.#registerProfile(peer, message);
        return;
      case "command.result":
        await this.#completeOperation(peer, message, false);
        return;
      case "command.event":
        await this.#receiveActionEvent(peer, message);
        return;
      case "command.error":
        await this.#completeOperation(peer, message, true);
        return;
      case "extension.event":
        await this.#handleExtensionEvent(peer, message);
        return;
      default:
        throw new CompanionError("extension_message_unknown", `Unknown extension message: ${message.kind}`);
    }
  }

  async #registerProfile(peer, message) {
    try {
      return await this.#registerProfileChecked(peer, message);
    } catch (error) {
      const profileInstanceId = typeof message.profileInstanceId === "string" ? message.profileInstanceId : null;
      this.profileRegistrationFailures.set(profileInstanceId ?? peer.id, {
        profileInstanceId,
        extensionRuntimeId: typeof message.extensionRuntimeId === "string" ? message.extensionRuntimeId : null,
        receivedBuildId: typeof message.buildId === "string" ? message.buildId : null,
        receivedBundleTreeSha256: typeof message.bundleTreeSha256 === "string" ? message.bundleTreeSha256 : null,
        expectedBuildId: INSTALL_BUILD_ID,
        exactBlocker: normalizeError(error),
        failedAt: nowIso(),
      });
      if (error?.code === "extension_build_id_mismatch"
        && shouldRequestBrokerRestartForBuildMismatch(INSTALL_BUILD_ID, message.buildId)) {
        // The Extension is the first component to observe a new install. A
        // running old broker cannot accept it, so ask the process wrapper to
        // close this generation cleanly; the native host will reconnect and
        // autoStart the newly installed broker.
        this.emit("build.mismatch", {
          profileInstanceId,
          expectedBuildId: INSTALL_BUILD_ID,
          receivedBuildId: message.buildId,
        });
      }
      throw error;
    }
  }

  async #registerProfileChecked(peer, message) {
    if (message.protocolVersion !== PROTOCOL_VERSION) {
      throw new CompanionError(
        "protocol_version_mismatch",
        `Expected Extension protocol ${PROTOCOL_VERSION}`,
        { received: message.protocolVersion },
      );
    }
    const profileInstanceId = requireString(message.profileInstanceId, "profileInstanceId");
    const extensionRuntimeId = requireString(message.extensionRuntimeId, "extensionRuntimeId");
    if (typeof message.buildId !== "string" || message.buildId.length === 0) {
      throw new CompanionError("extension_build_id_missing", "Companion Extension did not provide its install build ID", {
        expectedBuildId: INSTALL_BUILD_ID,
      });
    }
    if (message.buildId !== INSTALL_BUILD_ID) {
      throw new CompanionError("extension_build_id_mismatch", "Companion Extension build ID does not match the installed broker", {
        expectedBuildId: INSTALL_BUILD_ID,
        receivedBuildId: message.buildId,
      });
    }
    const expectedArtifacts = {
      bundleTreeSha256: BUNDLE_TREE_SHA256,
      extensionTreeSha256: EXTENSION_TREE_SHA256,
      nativeRecorderSha256: NATIVE_RECORDER_SHA256,
    };
    // A same-protocol stale build may connect solely so the signed safe-boundary
    // Extension reload can run. Session-bound page actions are blocked until
    // all artifact hashes match; rejecting hello here would deadlock recovery.
    const provenanceMismatches = buildProvenanceMismatches(message, expectedArtifacts);
    const receivedCapabilities = Array.isArray(message.capabilities) ? message.capabilities : [];
    const contractMismatch = message.operationSchema !== undefined && message.operationSchema !== OPERATION_SCHEMA
      || message.operationSchemaVersion !== undefined && message.operationSchemaVersion !== OPERATION_SCHEMA_VERSION
      || message.operationSchemaDigest !== undefined && message.operationSchemaDigest !== OPERATION_SCHEMA_DIGEST
      || message.capabilitiesDigest !== undefined && (message.capabilitiesDigest !== capabilityDigest(receivedCapabilities)
        || message.capabilitiesDigest !== capabilityDigest(DEFAULT_CAPABILITIES));
    let historicalRefreshOnly = false;
    if (contractMismatch) {
      try {
        const history = await readRefreshContractHistory(join(dirname(this.socketPath), "refresh-contract-history.json"));
        historicalRefreshOnly = history.records.some(record => historicalRefreshContractMatches(record, message));
      } catch { /* Missing or invalid installer-owned history is not authority. */ }
    }
    // New Extension builds attest the generated operation contract during the
    // hello handshake.  Keep the fields optional for older local fixtures so
    // a reconnect can still be diagnosed, but reject an explicitly supplied
    // stale/mismatched contract before any session is opened.
    if (!historicalRefreshOnly && message.operationSchema !== undefined && message.operationSchema !== OPERATION_SCHEMA) {
      throw new CompanionError("companion_operation_schema_mismatch", "Companion Extension operation schema does not match the broker", {
        expectedOperationSchema: OPERATION_SCHEMA,
        receivedOperationSchema: message.operationSchema,
      });
    }
    if (!historicalRefreshOnly && message.operationSchemaVersion !== undefined && message.operationSchemaVersion !== OPERATION_SCHEMA_VERSION) {
      throw new CompanionError("companion_operation_schema_version_mismatch", "Companion Extension operation schema version does not match the broker", {
        expectedOperationSchemaVersion: OPERATION_SCHEMA_VERSION,
        receivedOperationSchemaVersion: message.operationSchemaVersion,
      });
    }
    if (!historicalRefreshOnly && message.operationSchemaDigest !== undefined && message.operationSchemaDigest !== OPERATION_SCHEMA_DIGEST) {
      throw new CompanionError("companion_operation_schema_digest_mismatch", "Companion Extension operation schema digest does not match the broker", {
        expectedOperationSchemaDigest: OPERATION_SCHEMA_DIGEST,
        receivedOperationSchemaDigest: message.operationSchemaDigest,
      });
    }
    if (!historicalRefreshOnly && message.capabilitiesDigest !== undefined) {
      const receivedCapabilities = Array.isArray(message.capabilities)
        ? message.capabilities.filter((value) => typeof value === "string")
        : [];
      const receivedDigest = capabilityDigest(receivedCapabilities);
      if (message.capabilitiesDigest !== receivedDigest || receivedDigest !== capabilityDigest(DEFAULT_CAPABILITIES)) {
        throw new CompanionError("companion_capabilities_attestation_mismatch", "Companion Extension capabilities do not match the generated broker contract", {
          expectedCapabilitiesDigest: capabilityDigest(DEFAULT_CAPABILITIES),
          receivedCapabilitiesDigest: message.capabilitiesDigest,
          calculatedCapabilitiesDigest: receivedDigest,
        });
      }
    }
    const previous = this.profiles.get(profileInstanceId);
    if (previous?.extensionRuntimeId === extensionRuntimeId) {
      if (previous.peerId && previous.peerId !== peer.id) {
        await this.#invalidateProfile(profileInstanceId, "extension_transport_replaced");
      }
      const profile = {
        ...previous,
        connected: true,
        connectedAt: nowIso(),
        disconnectedAt: null,
        capabilities: Array.isArray(message.capabilities)
          ? DEFAULT_CAPABILITIES.filter((value) => message.capabilities.includes(value))
          : [],
        operationSchema: message.operationSchema ?? null,
        operationSchemaDigest: message.operationSchemaDigest ?? null,
        operationSchemaVersion: message.operationSchemaVersion ?? null,
        capabilitiesDigest: message.capabilitiesDigest ?? null,
        bundleTreeSha256: message.bundleTreeSha256 ?? null,
        extensionTreeSha256: message.extensionTreeSha256 ?? null,
        nativeRecorderSha256: message.nativeRecorderSha256 ?? null,
        buildProvenanceMismatches: provenanceMismatches,
        buildId: message.buildId,
        peerId: peer.id,
      };
      this.profiles.set(profileInstanceId, profile);
      this.profileRegistrationFailures.delete(profileInstanceId);
      await this.taskLedger.recordProfileBinding(profile);
      this.#resolveExtensionReloadReservation(profileInstanceId, profile.generation);
      peer.profileInstanceIds.add(profileInstanceId);
      if (previous.peerId && previous.peerId !== peer.id) {
        this.peers.get(previous.peerId)?.socket.destroy();
      }
      this.#send(peer, {
        kind: "extension.hello_ack",
        profileInstanceId,
        generation: profile.generation,
        protocolVersion: PROTOCOL_VERSION,
        ...(profile.operationSchema ? {
          operationSchema: profile.operationSchema,
          operationSchemaDigest: profile.operationSchemaDigest,
          operationSchemaVersion: profile.operationSchemaVersion,
          capabilitiesDigest: profile.capabilitiesDigest,
        } : {}),
      });
      this.emit("profile.connected", profile);
      // A reconnect can leave ownerless terminal tabs from the previous
      // process. They are already detached as ledger_only by the boundary
      // above; close only the disposable browser surface asynchronously so
      // the hello handshake remains fast.
      void this.#cleanupOwnerlessLedgerOnlyTabsForProfile(peer, profile).catch(() => null);
      return;
    }
    const persisted = previous ? null : this.taskLedger.getProfileBinding(profileInstanceId);
    const recoverPersistedGeneration = persisted?.extensionRuntimeId === extensionRuntimeId
      && persisted?.buildId === message.buildId;
    let previousPeerToClose = null;
    if (previous || (persisted && !recoverPersistedGeneration)) {
      // Install the replacement binding before closing the old socket.  If
      // the socket closes first, #disconnectPeer can observe the still-old
      // profile.peerId and misclassify a legitimate generation replacement
      // as unexpected transport loss, detaching all task tabs to ledger_only
      // before the new generation can quarantine/retain its evidence.
      if (previous?.peerId && previous.peerId !== peer.id) {
        previousPeerToClose = this.peers.get(previous.peerId)?.socket ?? null;
      }
      await this.#invalidateProfile(profileInstanceId, "profile_generation_replaced");
      const quarantined = await this.taskLedger.quarantineTaskTabs(profileInstanceId, "profile_generation_replaced");
      for (const taskTab of quarantined) this.taskTabs.set(this.#tabKey(taskTab.profileInstanceId, taskTab.tabId), taskTab);
    } else if (!recoverPersistedGeneration && [...this.taskTabs.values()].some((entry) => entry.profileInstanceId === profileInstanceId)) {
      // Legacy ledgers did not persist the Extension runtime binding. On a
      // cold broker start the old generation cannot be proven current, so it
      // must be quarantined instead of silently becoming unreusable clutter.
      const quarantined = await this.taskLedger.quarantineTaskTabs(profileInstanceId, "profile_generation_unrecoverable");
      for (const taskTab of quarantined) this.taskTabs.set(this.#tabKey(taskTab.profileInstanceId, taskTab.tabId), taskTab);
    }
    const profile = {
      profileInstanceId,
      extensionRuntimeId,
      generation: recoverPersistedGeneration ? persisted.generation : createId("gen"),
      connected: true,
      connectedAt: nowIso(),
      capabilities: Array.isArray(message.capabilities)
        ? DEFAULT_CAPABILITIES.filter((value) => message.capabilities.includes(value))
        : [],
      operationSchema: message.operationSchema ?? null,
      operationSchemaDigest: message.operationSchemaDigest ?? null,
      operationSchemaVersion: message.operationSchemaVersion ?? null,
      capabilitiesDigest: message.capabilitiesDigest ?? null,
      bundleTreeSha256: message.bundleTreeSha256 ?? null,
      extensionTreeSha256: message.extensionTreeSha256 ?? null,
      nativeRecorderSha256: message.nativeRecorderSha256 ?? null,
      buildProvenanceMismatches: provenanceMismatches,
      buildId: message.buildId,
      peerId: peer.id,
    };
    this.profiles.set(profileInstanceId, profile);
    this.profileRegistrationFailures.delete(profileInstanceId);
    await this.taskLedger.recordProfileBinding(profile);
    this.#resolveExtensionReloadReservation(profileInstanceId, profile.generation);
    peer.profileInstanceIds.add(profileInstanceId);
    if (previousPeerToClose && !previousPeerToClose.destroyed) {
      // The profile now points at the replacement peer, so its close event
      // cannot trigger unexpected-loss invalidation for the new generation.
      previousPeerToClose.destroy();
    }
    this.#send(peer, {
      kind: "extension.hello_ack",
      profileInstanceId,
      generation: profile.generation,
      protocolVersion: PROTOCOL_VERSION,
      ...(profile.operationSchema ? {
        operationSchema: profile.operationSchema,
        operationSchemaDigest: profile.operationSchemaDigest,
        operationSchemaVersion: profile.operationSchemaVersion,
        capabilitiesDigest: profile.capabilitiesDigest,
      } : {}),
    });
    this.emit("profile.connected", profile);
    void this.#cleanupOwnerlessLedgerOnlyTabsForProfile(peer, profile).catch(() => null);
  }

  #cleanupOwnerlessLedgerOnlyTabs() {
    for (const profile of this.profiles.values()) {
      if (!profile.connected || this.extensionReloadInFlight.has(profile.profileInstanceId)) continue;
      const peer = this.peers.get(profile.peerId);
      if (!peer?.authenticated) continue;
      void this.#cleanupOwnerlessLedgerOnlyTabsForProfile(peer, profile).catch(() => null);
    }
  }

  async #cleanupOwnerlessLedgerOnlyTabsForProfile(peer, profile) {
    const profileInstanceId = profile?.profileInstanceId;
    if (!profileInstanceId
      || !profile.connected
      || this.extensionReloadInFlight.has(profileInstanceId)
      || this.ownerlessCleanupInFlight.has(profileInstanceId)) return;
    if (!peer?.authenticated || profile.peerId !== peer.id) return;
    const pendingTaskIds = new Set([
      ...this.pendingOperations.values(),
      ...this.timedOutOperations.values(),
    ].map((operation) => operation.binding?.taskId ?? operation.taskTabContext?.taskId).filter(Boolean));
    // Avoid issuing a maintenance read on every normal profile handshake.
    // Only a profile with an already-detached ledger-only record can need
    // cleanup; this also keeps status snapshots free of a transient pending
    // maintenance operation during ordinary startup.
    const hasOwnerlessCleanupCandidate = [...new Map([
      ...this.taskLedger.listTaskTabs(),
      ...this.taskTabs.values(),
    ].map((entry) => [this.#tabKey(entry.profileInstanceId, entry.tabId), entry])).values()]
      .some((entry) => entry.profileInstanceId === profileInstanceId
        && (isLedgerOnlyTaskTab(entry)
          || (entry.retentionPolicy === "cleanup" && TASK_TAB_TERMINAL_LIFECYCLES.has(entry.lifecycleState)))
        && entry.userHelpRequired !== true
        && !entry.resumeToken
        && !pendingTaskIds.has(entry.taskId)
        && !this.tabLeaseIndex.has(this.#tabKey(profileInstanceId, entry.tabId)));
    if (!hasOwnerlessCleanupCandidate) return;
    this.ownerlessCleanupInFlight.add(profileInstanceId);
    // This is an internal broker maintenance session. It is never exposed to
    // a client, never claims a user tab, and carries no provider authority.
    // The only mutation below is tabs.close for a task-tab already detached
    // into the explicit ledger_only disposition.
    const maintenanceSession = {
      sessionId: `ownerless-cleanup:${profileInstanceId}`,
      peerId: peer.id,
      profileInstanceId,
      generation: profile.generation,
      label: "ownerless-ledger-only-cleanup",
      taskId: null,
      runId: null,
      leaseIds: new Set(),
    };
    try {
      const inventory = await this.#enqueue(`profile:${profileInstanceId}`, () => this.#sendOperation({
        profile,
        session: maintenanceSession,
        method: "tabs.list",
        params: {},
        timeoutMs: DEFAULT_OPERATION_TIMEOUTS_MS["tabs.list"] ?? DEFAULT_OPERATION_TIMEOUT_MS,
        authority: null,
        idempotencyKey: null,
        binding: {
          runId: null,
          profileInstanceId,
          generation: profile.generation,
          sessionId: maintenanceSession.sessionId,
          ownerKey: maintenanceSession.sessionId,
          tabId: null,
          method: "tabs.list",
          taskId: maintenanceSession.sessionId,
        },
        fingerprint: null,
        allowedOrigins: null,
        targetOrigin: null,
        taskTabContext: null,
      }));
      if (!Array.isArray(inventory)) return;
      const liveById = new Map(inventory
        .filter((tab) => Number.isSafeInteger(tab?.id))
        .map((tab) => [tab.id, tab]));
      const liveSessionIds = new Set(this.sessions.values()
        .filter((session) => session.profileInstanceId === profileInstanceId && session.generation === profile.generation)
        .map((session) => session.sessionId));
      const candidates = [...new Map([
        ...this.taskLedger.listTaskTabs(),
        ...this.taskTabs.values(),
      ].map((entry) => [this.#tabKey(entry.profileInstanceId, entry.tabId), entry])).values()]
        .filter((entry) => entry.profileInstanceId === profileInstanceId
          && (isLedgerOnlyTaskTab(entry)
            || (entry.retentionPolicy === "cleanup" && TASK_TAB_TERMINAL_LIFECYCLES.has(entry.lifecycleState)))
          && entry.userHelpRequired !== true
          && !entry.resumeToken
          && !pendingTaskIds.has(entry.taskId)
          && !this.tabLeaseIndex.has(this.#tabKey(profileInstanceId, entry.tabId))
          && (!entry.sessionId || !liveSessionIds.has(entry.sessionId)))
        .sort((left, right) => left.tabId - right.tabId);
      for (const entry of candidates) {
        // Stop if the profile was replaced while the maintenance pass was in
        // flight; the new peer will perform its own fresh inventory.
        const currentProfile = this.profiles.get(profileInstanceId);
        if (currentProfile?.peerId !== peer.id || currentProfile.generation !== profile.generation) break;
        const live = liveById.get(entry.tabId);
        const tabKey = this.#tabKey(profileInstanceId, entry.tabId);
        if (!live) {
          this.taskTabs.delete(tabKey);
          await this.taskLedger.removeTaskTab(profileInstanceId, entry.tabId);
          continue;
        }
        let parsedLiveUrl;
        try { parsedLiveUrl = new URL(live.url); } catch { parsedLiveUrl = null; }
        if (live.active === true
          || live.pinned === true
          || !/^https?:$/iu.test(parsedLiveUrl?.protocol ?? "")) continue;
        const origin = parsedLiveUrl.origin;
        const runId = entry.runId ?? `ownerless-cleanup:${entry.taskId}:${entry.tabId}`;
        const idempotencyKey = `ownerless-ledger-only-close:${profileInstanceId}:${entry.tabId}:${entry.ledgerOnlyAt ?? entry.updatedAt ?? "unknown"}`;
        const binding = {
          runId,
          profileInstanceId,
          generation: profile.generation,
          sessionId: maintenanceSession.sessionId,
          ownerKey: maintenanceSession.sessionId,
          tabId: entry.tabId,
          method: "tabs.close",
          taskId: entry.taskId,
          targetIdentity: normalizeTargetIdentity({
            taskId: entry.taskId,
            sessionId: maintenanceSession.sessionId,
            generation: profile.generation,
            profileInstanceId,
            tabId: entry.tabId,
            windowId: live.windowId,
            frameId: 0,
            origin,
          }),
        };
        const fingerprint = payloadDigest(this.ledgerSecret, { binding, payload: { tabId: entry.tabId } });
        const prepared = await this.taskLedger.prepare({ idempotencyKey, fingerprint, binding });
        if (prepared.state !== "prepared") continue;
        try {
          await this.#enqueue(`tab:${profileInstanceId}:${entry.tabId}`, () => this.#sendOperation({
            profile,
            session: maintenanceSession,
            method: "tabs.close",
            params: { tabId: entry.tabId },
            timeoutMs: DEFAULT_OPERATION_TIMEOUTS_MS["tabs.close"] ?? DEFAULT_OPERATION_TIMEOUT_MS,
            authority: null,
            idempotencyKey,
            binding,
            fingerprint,
            allowedOrigins: [origin],
            targetOrigin: origin,
            taskTabContext: null,
          }));
        } catch (error) {
          if (error?.code === "operation_effect_unknown") {
            // The close command is independent of the provider-side unknown
            // effect. Keep the close evidence, but remove only the visible
            // tab record so it cannot block future fresh work or multiply.
            this.taskTabs.delete(tabKey);
            await this.taskLedger.removeTaskTab(profileInstanceId, entry.tabId);
          }
        }
      }
    } finally {
      this.ownerlessCleanupInFlight.delete(profileInstanceId);
    }
  }

  async #handleExtensionEvent(peer, message) {
    if (message.event === "debugger.cleanup") {
      const entry = this.taskLedger.getOperationById(message.operationId);
      const binding = entry?.binding;
      const profile = binding ? this.profiles.get(binding.profileInstanceId) : null;
      const identityFields = ["taskId", "sessionId", "profileInstanceId", "generation", "tabId"];
      if (!entry || binding?.method !== "tabs.stopLoading" || peer.authenticated !== true || peer.role !== "extension-relay"
        || !profile?.connected || profile.peerId !== peer.id || !peer.profileInstanceIds.has(binding.profileInstanceId)
        || profile.generation !== binding.generation || !identityFields.every(field => message[field] === binding[field])
        || !["detached", "reconciliation_required", "not_required"].includes(message.status)) {
        throw new CompanionError("debugger_cleanup_binding_mismatch", "Cleanup event does not match the current authenticated peer and original stop binding");
      }
      await this.taskLedger.annotateDebuggerCleanup({ operationId: message.operationId, binding,
        status: message.status, reason: message.reason });
      return;
    }
    if (message.event === "task.tab.created" && Number.isSafeInteger(message.tabId)) {
      const operation = this.pendingOperations.get(message.operationId)
        ?? this.timedOutOperations.get(message.operationId);
      const profileInstanceId = message.profileInstanceId
        ?? (peer.profileInstanceIds.size === 1 ? [...peer.profileInstanceIds][0] : null);
      const operationProfile = operation ? this.profiles.get(operation.profileInstanceId) : null;
      if (operation?.taskTabContext
        && profileInstanceId === operation.profileInstanceId
        && operationProfile?.peerId === peer.id && peer.profileInstanceIds.has(profileInstanceId)
        && operationProfile.generation === operation.generation
        && operation.method === "tabs.create") {
        operation.createdTabId = message.tabId;
        operation.mutationDispatchProvenance = "extension_observed";
        if (operation.idempotencyKey) await this.taskLedger.transition(operation.idempotencyKey,
          operation.timedOut ? "unknown_effect" : "dispatched", {
            createdTabId: message.tabId, mutationDispatchAttempted: true,
            mutationDispatchProvenance: "extension_observed",
          });
        await this.#recordTaskTab(operation, message.tabId);
      }
    }
    if (message.event === "tab.removed" && Number.isSafeInteger(message.tabId)) {
      const profileInstanceId = message.profileInstanceId
        ?? (peer.profileInstanceIds.size === 1 ? [...peer.profileInstanceIds][0] : null);
      const leaseId = profileInstanceId
        ? this.tabLeaseIndex.get(this.#tabKey(profileInstanceId, message.tabId))
        : null;
      if (leaseId) {
        this.#deleteLease(leaseId);
      }
      if (profileInstanceId) {
        this.taskTabs.delete(this.#tabKey(profileInstanceId, message.tabId));
        await this.taskLedger.removeTaskTab(profileInstanceId, message.tabId);
      }
    }
    this.emit("extension.event", message);
  }

  async #receiveActionEvent(peer, message) {
    const operation = this.pendingOperations.get(message.operationId);
    if (!operation || operation.expectEvent?.type !== "dialog") return;
    const profile = this.profiles.get(operation.profileInstanceId);
    if (profile?.peerId !== peer?.id || !peer.profileInstanceIds.has(operation.profileInstanceId)
      || profile.generation !== operation.generation) throw new CompanionError("extension_operation_peer_mismatch", "Event does not belong to the operation's current profile generation");
    const value = message.event;
    const armedAt = Date.parse(value?.armedAt), openedAt = Date.parse(value?.openedAt);
    let origin;
    try { origin = new URL(value?.dialogUrl).origin; } catch { /* Invalid below. */ }
    if (!value || value.kind !== "dialog" || value.present !== true || value.operationId !== operation.operationId
      || value.tabId !== operation.binding?.tabId || typeof value.dialogId !== "string" || value.dialogId.length < 1 || value.dialogId.length > 240
      || value.pageInstanceId !== `javascript-dialog:${value.dialogId}`
      || !["alert", "confirm", "prompt", "beforeunload"].includes(value.type)
      || typeof value.message !== "string" || value.message.length > 10_000
      || typeof value.dialogUrl !== "string" || value.dialogUrl.length > 4096
      || typeof value.messageExactAvailable !== "boolean" || typeof value.requiresUser !== "boolean"
      || !Number.isFinite(armedAt) || !Number.isFinite(openedAt) || openedAt < armedAt
      || armedAt < Date.parse(operation.startedAt) || openedAt > Date.now() + 1000
      || openedAt > armedAt + (operation.expectEvent.timeoutMs ?? ACTION_EVENT_CONTRACT.defaultTimeoutMs)
      || !origin || !operation.allowedOrigins?.includes(origin)) {
      throw new CompanionError("action_event_binding_mismatch", "Event does not match the signed trigger, exact tab, time interval, and allowed origins");
    }
    const event = Object.fromEntries(["kind", "tabId", "operationId", "armedAt", "openedAt", "dialogId", "pageInstanceId",
      "type", "message", "messageExactAvailable", "dialogUrl", "dialogFrameId", "requiresUser", "promptTextRequired"]
      .filter(key => Object.hasOwn(value, key)).map(key => [key, value[key]]));
    event.idempotencyKey = operation.idempotencyKey;
    // An opening proves neither the trigger's completion nor a provider effect.
    // Move the operation to the existing late-result path before releasing the
    // serial queue, allowing only a separately signed response to proceed.
    this.pendingOperations.delete(operation.operationId);
    clearTimeout(operation.timer);
    operation.timedOut = true;
    operation.effectState = "unknown_effect";
    operation.mutationDispatchAttempted = true;
    operation.mutationDispatchProvenance = "action_event";
    operation.awaitedEvent = event;
    operation.tombstoneExpiresAt = Date.now() + LATE_RESULT_TOMBSTONE_TTL_MS;
    this.timedOutOperations.set(operation.operationId, operation);
    if (operation.idempotencyKey) await this.taskLedger.transition(operation.idempotencyKey, "unknown_effect", {
      operationId: operation.operationId, reason: "action_event_pending", awaitedEvent: event,
      effectState: "unknown_effect", mutationDispatchAttempted: true, mutationDispatchProvenance: "action_event", dispatchState: "dispatched", dispatchCount: 1,
      effectClass: operation.effectClass, reconciliationRequired: operation.reconciliationRequired,
    });
    operation.reject(new CompanionError("action_event_pending", "The pre-armed dialog opened. Respond to this exact opening in the same tab, session and run; never repeat its trigger", {
      operationId: operation.operationId, operationEffectState: "unknown", mutationDispatchAttempted: true,
      reconciliationRequired: operation.reconciliationRequired, actionEvent: event,
    }));
  }

  async #completeOperation(peer, message, isError) {
    const operation = this.pendingOperations.get(message.operationId)
      ?? this.timedOutOperations.get(message.operationId);
    if (!operation) {
      return;
    }
    const timedOut = this.timedOutOperations.has(message.operationId);
    const profile = this.profiles.get(operation.profileInstanceId);
    const peerOwnsOperation = peer?.authenticated === true && peer.role === "extension-relay" && profile?.peerId === peer?.id
      && peer?.profileInstanceIds.has(operation.profileInstanceId)
      && profile.generation === operation.generation;
    if (!peerOwnsOperation) {
      // A stale Extension can deliver a late result after a reconnect. It is
      // never allowed to settle a current operation or mutate its ledger.
      // Keep a timed-out tombstone until expiry so a legitimate current peer
      // can still reconcile the operation; reject active mismatches loudly.
      if (timedOut) return;
      throw new CompanionError("extension_operation_peer_mismatch", "Extension result does not belong to the operation's current profile generation", {
        operationId: message.operationId,
        profileInstanceId: operation.profileInstanceId,
        generation: operation.generation,
      });
    }
    const ledgerEntry = operation.idempotencyKey ? this.taskLedger.get(operation.idempotencyKey) : null;
    const exactBinding = (!ledgerEntry || (ledgerEntry.operationId === operation.operationId
      && canonicalPayload(ledgerEntry.binding) === canonicalPayload(operation.binding)))
      && (message.generation === undefined || message.generation === operation.generation)
      && (message.profileInstanceId === undefined || message.profileInstanceId === operation.profileInstanceId)
      && (message.binding === undefined || canonicalPayload(message.binding) === canonicalPayload(operation.binding));
    if (!exactBinding) {
      if (timedOut) return;
      throw new CompanionError("extension_operation_binding_mismatch", "Extension completion does not match this exact operation binding");
    }
    // This maintenance branch requires the exact worker close ACK. A
    // successful transport without it is an unknown close, never retryable.
    if (!isError && operation.binding?.ownedCleanupDisposal === true
      && (message.result?.closed !== true || message.result?.closedExpected !== true
        || message.result?.tabId !== operation.binding.tabId)) {
      isError = true;
      message = { ...message, error: { code: "owned_cleanup_close_ack_unknown",
        message: "The exact maintenance close lacks a complete authenticated ACK",
        details: { operationEffectState: "unknown", mutationDispatchAttempted: true } } };
    }
    const completionStartedAt = performance.now();
    if (operation.timing) {
      operation.timing.record.timings_ms.transport_and_extension = completionStartedAt - operation.timing.sentAt;
      const measured = extensionTiming(message.executionTiming);
      if (measured) operation.timing.record.extension_timings_ms = measured;
    }
    const inferenceOnly = operation.mutationDispatchProvenance === "transport_inference"
      && (!ledgerEntry || ledgerEntry.mutationDispatchProvenance === "transport_inference")
      && !operation.awaitedEvent && !ledgerEntry?.awaitedEvent && ledgerEntry?.reason !== "action_event_pending"
      && operation.externalActionExecuted !== true && ledgerEntry?.externalActionExecuted !== true
      && !Number.isSafeInteger(operation.createdTabId)
      && !Number.isSafeInteger(ledgerEntry?.createdTabId)
      && !["applied", "reconciled"].includes(ledgerEntry?.state)
      && !["known_effect"].includes(operationEffectStateForEntry(ledgerEntry ?? operation));
    const explicitNoEffect = isError && observedNoEffectDetails(message.error)
      && (inferenceOnly || !MUTATION_METHODS.has(operation.method))
      && message.error?.details?.mutationDispatchAttempted === false
      && message.error?.details?.externalActionExecuted !== true
      && message.error?.details?.external_action_executed !== true
      && !["operation_effect_unknown", "action_event_pending"].includes(message.error?.code)
      && !Number.isSafeInteger(message.error?.details?.createdTabId);
    if (timedOut && MUTATION_METHODS.has(operation.method) && isError && observedNoEffectDetails(message.error) && !explicitNoEffect) return;
    if (timedOut) this.timedOutOperations.delete(message.operationId);
    else this.pendingOperations.delete(message.operationId);
    if (operation.timer) clearTimeout(operation.timer);
    // The command was sent, but the current Extension can prove that the
    // page mutation never started. Preserve this distinction in the receipt.
    if (explicitNoEffect || !MUTATION_METHODS.has(operation.method)) {
      operation.mutationDispatchAttempted = false;
      operation.mutationDispatchProvenance = "authenticated_no_effect";
    } else if (operation.awaitedEvent || message.error?.details?.mutationDispatchAttempted === true) {
      operation.mutationDispatchAttempted = true;
      operation.mutationDispatchProvenance = operation.awaitedEvent ? "action_event" : "extension_observed";
    }
    const mutation = MUTATION_METHODS.has(operation.method);
    const readOnlyOperation = !mutation;
    const reconciliationRequired = mutation && operationRequiresReconciliation(operation);
    operation.reconciliationRequired = reconciliationRequired;
    operation.effectClass = reconciliationRequired ? "external_commit" : "local_ui";
    const observedEffectState = explicitNoEffect || (isError && readOnlyOperation)
      ? "known_no_effect"
      : isError
        ? (timedOut ? timedOutEffectState(operation) : "unknown_effect")
        : (timedOut && readOnlyOperation ? "known_no_effect" : "known_effect");
    if (operation.idempotencyKey) {
      if (isError) {
        if (explicitNoEffect && operation.timedOut && timedOutEffectState(operation) === "unknown_effect") {
          await this.taskLedger.reconcile(operation.idempotencyKey, operation.binding, {
            blocked: true,
            errorCode: message.error?.code ?? "extension_operation_failed",
            operationEffectState: "none",
            effectState: "known_no_effect",
            mutationDispatchAttempted: false,
            externalActionExecuted: false,
          }, { brokerEvidence: true, noEffectOperationId: operation.operationId });
        } else {
          const nextState = observedEffectState === "unknown_effect" ? "unknown_effect" : "blocked";
          await this.taskLedger.transition(operation.idempotencyKey, nextState, {
            operationId: operation.operationId,
            errorCode: message.error?.code ?? "extension_operation_failed",
            effectState: observedEffectState,
            dispatchState: "dispatched",
            mutationDispatchAttempted: operation.mutationDispatchAttempted === true,
            mutationDispatchProvenance: operation.mutationDispatchProvenance,
            effectClass: operation.effectClass,
            reconciliationRequired,
            ...(readOnlyOperation ? { externalActionExecuted: false, brokerEvidence: true } : {}),
            ...(explicitNoEffect ? { brokerEvidence: true, operationEffectState: "none" } : {}),
          });
        }
      } else {
        if (operation.timedOut && mutation && timedOutEffectState(operation) === "unknown_effect") {
          await this.taskLedger.reconcile(operation.idempotencyKey, operation.binding, {
            ...message.result,
            effectState: "known_effect",
            effectClass: operation.effectClass,
            reconciliationRequired,
          }, { brokerEvidence: true });
        } else {
          await this.taskLedger.transition(operation.idempotencyKey, "applied", {
            operationId: operation.operationId,
            resultDigest: payloadDigest(this.ledgerSecret, message.result),
            ...(operation.method === "tabs.create" && operation.taskTabContext && Number.isSafeInteger(message.result?.id)
              ? { createdTabId: message.result.id } : {}),
            brokerEvidence: true,
            effectState: observedEffectState,
            mutationDispatchProvenance: "observed_mutation",
            dispatchState: "dispatched",
            effectClass: operation.effectClass,
            reconciliationRequired,
          });
        }
      }
    }
    if (!isError && operation.taskTabContext && Number.isSafeInteger(message.result?.id)) {
      await this.#recordTaskTab(operation, message.result.id, message.result);
    }
    if (isError && operation.taskTabContext && Number.isSafeInteger(message.error?.details?.createdTabId)) {
      await this.#recordTaskTab(operation, message.error.details.createdTabId);
    }
    if (!isError && operation.method === "tabs.configure" && message.result?.configured === true
      && message.result.tabId === operation.binding?.tabId && Number.isSafeInteger(message.result.windowId)) {
      const entry = this.taskLedger.getTaskTab(operation.profileInstanceId, message.result.tabId);
      if (entry?.taskId === operation.binding.taskId && entry.generation === operation.generation) {
        const updated = { ...entry, windowId: message.result.windowId,
          ...rebuildTaskTabIdentity(this.ledgerSecret, entry, { windowId: message.result.windowId }), updatedAt: nowIso() };
        await this.taskLedger.recordTaskTab(updated);
        this.taskTabs.set(this.#tabKey(operation.profileInstanceId, message.result.tabId), this.taskLedger.getTaskTab(operation.profileInstanceId, message.result.tabId));
      }
    }
    if (!isError && operation.method === "tabs.close" && operation.binding?.ownedCleanupDisposal !== true && Number.isSafeInteger(operation.binding?.tabId)) {
      this.taskTabs.delete(this.#tabKey(operation.profileInstanceId, operation.binding.tabId));
      await this.taskLedger.removeTaskTab(operation.profileInstanceId, operation.binding.tabId);
    }
    if (operation.timing) operation.timing.record.timings_ms.completion_persist_and_ownership = performance.now() - completionStartedAt;
    // Internal maintenance provenance is filled only after this exact
    // command's authenticated peer/generation completion checks above.
    if (operation.readEvidence && readOnlyOperation && !operation.timedOut) Object.assign(operation.readEvidence, {
      operationId: operation.operationId, method: operation.method,
      profileInstanceId: operation.profileInstanceId, generation: operation.generation,
      sessionId: operation.sessionId, startedAt: operation.startedAt, completedAt: nowIso(),
      brokerEvidence: true, resultDigest: payloadDigest(this.ledgerSecret, isError ? message.error : message.result),
      ...(isError ? { errorCode: message.error?.code, errorMessage: message.error?.message } : { returned: true }),
    });
    if (isError) {
      const failure = new CompanionError(
        message.error?.code ?? "extension_operation_failed",
        message.error?.message ?? "Extension operation failed",
        {
          ...(message.error?.details ?? {}),
          operationEffectState: observedEffectState,
          effectState: observedEffectState,
          mutationDispatchAttempted: operation.mutationDispatchAttempted === true,
          effectClass: operation.effectClass,
          reconciliationRequired,
        },
      );
      if (readOnlyOperation) failure[READ_ONLY_COMMAND_FAILURE] = true;
      operation.reject(failure);
    } else if (!operation.timedOut) {
      operation.resolve(message.result);
    }
  }

  async #recordTaskTab(operation, tabId, result = {}) {
    const lifecycleState = operation.taskTabContext?.lifecycleState ?? "executing";
    const retentionPolicy = operation.taskTabContext?.retentionPolicy ?? "cleanup";
    const targetIdentity = normalizeTargetIdentity({
      ...(operation.binding?.targetIdentity ?? {}),
      taskId: operation.taskTabContext?.taskId ?? operation.binding?.taskId,
      sessionId: operation.sessionId,
      generation: operation.generation,
      profileInstanceId: operation.profileInstanceId,
      tabId,
      windowId: Number.isSafeInteger(result?.windowId) ? result.windowId : operation.binding?.targetIdentity?.windowId,
      pageInstanceId: result?.pageInstanceId ?? operation.binding?.targetIdentity?.pageInstanceId,
      origin: operation.taskTabContext?.targetOrigin ?? operation.binding?.targetIdentity?.origin,
    });
    const baseEntry = {
      profileInstanceId: operation.profileInstanceId,
      generation: operation.generation,
      tabId,
      taskId: operation.taskTabContext.taskId,
      runId: operation.taskTabContext.runId,
      operationId: operation.operationId,
      sessionId: operation.sessionId,
      targetKey: operation.taskTabContext?.targetKey ?? null,
      canonicalLocator: operation.taskTabContext?.canonicalLocator ?? null,
      targetIdentity,
      targetFingerprint: targetIdentityDigest(this.ledgerSecret, targetIdentity),
      workflowType: operation.taskTabContext?.workflowType ?? "generic",
      capsuleId: operation.taskTabContext?.capsuleId ?? null,
      lifecycleState,
      retentionPolicy,
      resumeToken: operation.taskTabContext?.resumeToken ?? null,
      userHelpRequired: operation.taskTabContext?.userHelpRequired === true,
      retentionReason: operation.taskTabContext?.retentionReason ?? null,
      whyTabWasKept: operation.taskTabContext?.whyTabWasKept ?? null,
      requiredUserAction: operation.taskTabContext?.requiredUserAction ?? null,
      resumeAction: operation.taskTabContext?.resumeAction ?? null,
      createdAt: nowIso(),
    };
    const retention = taskTabRetentionExplanation(baseEntry);
    await this.taskLedger.recordTaskTab({
      ...baseEntry,
      retentionReason: retention.retentionReason,
      whyTabWasKept: retention.whyTabWasKept,
      resumeAction: retention.resumeAction,
    });
    this.taskTabs.set(this.#tabKey(operation.profileInstanceId, tabId), this.taskLedger.getTaskTab(operation.profileInstanceId, tabId));
  }

  async #handleClientRequest(peer, message) {
    const id = requireString(message.id, "id");
    const method = requireString(message.method, "method");
    const key = `${peer.id}:${id}`;
    let context;
    let timer;
    try {
      if (method === "request.cancel") {
        const requestId = requireString(message.params?.requestId, "requestId");
        const request = this.activeRequests.get(`${peer.id}:${requestId}`);
        if (request) request.controller.abort(new CompanionError("broker_request_cancelled", "The caller cancelled this request"));
        this.#send(peer, { id, ok: true, result: { cancelled: Boolean(request) } });
        return;
      }
      if (this.activeRequests.has(key)) throw new CompanionError("request_id_in_use", "Request ID is already active on this connection");
      const deadlineAt = message.deadlineAt ?? Date.now() + (method === "task.transaction" ? 120_000 : 60_000);
      if (!Number.isSafeInteger(deadlineAt) || deadlineAt > Date.now() + 600_000) {
        throw new CompanionError("invalid_request_deadline", "Request deadline must be an absolute time no more than ten minutes ahead");
      }
      context = { peerId: peer.id, deadlineAt, controller: new AbortController() };
      this.activeRequests.set(key, context);
      this.#assertRequestActive(context);
      timer = setTimeout(() => context.controller.abort(new CompanionError("broker_request_deadline_exceeded", "Request deadline expired")), Math.max(1, deadlineAt - Date.now()));
      timer.unref();
      const result = await this.requestContext.run(context, () => this.#dispatchClientMethod(peer, method, message.params ?? {}));
      this.#send(peer, { id, ok: true, result });
    } catch (error) {
      this.#send(peer, { id, ok: false, error: normalizeError(error) });
    } finally {
      clearTimeout(timer);
      if (context && this.activeRequests.get(key) === context) this.activeRequests.delete(key);
    }
  }

  #assertRequestActive(context = this.requestContext.getStore()) {
    if (!context) return;
    const reason = context.controller.signal.aborted ? context.controller.signal.reason
      : Date.now() >= context.deadlineAt ? new CompanionError("broker_request_deadline_exceeded", "Request deadline expired")
        : !this.peers.has(context.peerId) || this.closing ? new CompanionError("client_transport_disconnected", "Request owner connection is no longer active") : null;
    if (reason) throw new CompanionError(reason.code ?? "broker_request_cancelled", reason.message ?? "Request was cancelled", {
      operationEffectState: "none", effectState: "no_dispatch", dispatchState: "not_dispatched", mutationDispatchAttempted: false,
    });
  }

  async #recordNotDispatched(idempotencyKey, error, reservedOperationId = null) {
    const entry = idempotencyKey ? this.taskLedger.get(idempotencyKey) : null;
    if (!entry || (entry.state !== "prepared" && !(entry.state === "dispatched" && entry.operationId === reservedOperationId))) return;
    await this.taskLedger.transition(idempotencyKey, "blocked", {
      reason: error?.code ?? "operation_cancelled_before_dispatch", effectState: "no_dispatch", dispatchState: "not_dispatched",
      dispatchCount: 0, mutationDispatchAttempted: false, externalActionExecuted: false,
      ...(reservedOperationId ? { dispatchedAt: null, dispatchReservationAbandoned: true } : {}),
    });
  }

  async #dispatchClientMethod(peer, method, paramsValue) {
    const params = requireObject(paramsValue, "params");
    switch (method) {
      case "capabilities.get":
        return {
          ...operationCapabilityDocument({ methods: [...EXTENSION_METHODS] }),
          runtime: {
            connectedProfiles: this.snapshot().profiles.map(profile => ({
              profileInstanceId: profile.profileInstanceId ?? null,
              generation: profile.generation ?? null,
              buildId: profile.buildId ?? null,
              schemaDigest: profile.operationSchemaDigest ?? OPERATION_SCHEMA_DIGEST,
              capabilitiesDigest: profile.capabilitiesDigest ?? null,
              status: profile.status ?? "unknown",
            })),
          },
        };
      case "status.get":
        return this.snapshot({ taskId: params.taskId ?? null });
      case "profile.list":
        return this.snapshot().profiles;
      case "dropdown.inspect":
        return this.#inspectDropdownWithVisual(peer, params);
      case "visual.target.inspect":
        return this.#inspectVisualTarget(peer, params);
      case "visual.point.inspect":
        return this.#inspectVisualPoint(peer, params);
      case "session.open":
        return this.#openSession(peer, params);
      case "session.close":
        return this.#closeSession(peer, params);
      case "lease.acquire":
        return this.#acquireLease(peer, params);
      case "lease.release":
        return this.#releaseLease(peer, params.leaseId);
      case "tabs.claimExisting":
        return this.#claimExistingTab(peer, params);
      case "operation.execute":
        return this.#executeOperation(peer, params);
      case "extension.reload":
        return this.#reloadExtension(peer, params);
      case "task.transaction":
        return this.operationTimingContext.run({ operations: [], truncated: false }, () => this.#executeTaskTransaction(peer, params));
      case "task.tabs.group":
        return this.#groupTaskTabs(peer, params);
      case "task.tabs.transfer":
        return this.#transferHandoffTabs(peer, params);
      case "maintenance.tabs.cleanup":
        return this.#cleanupTaskTabs(peer, params);
      case "maintenance.tabs.purge_missing":
        return this.#purgeMissingTaskTabs(peer, params);
      case "maintenance.tabs.retire_local_canary":
        return this.#retireLocalCanary(peer, params);
      case "maintenance.operations.archive":
        return this.#archiveReconciliation(peer, params);
      case "maintenance.operations.purge":
        return this.#purgeOwnedOperations(peer, params);
      case "task.status":
        return this.#taskStatus(peer, params);
      case "task.history": {
        const session = this.#requireOwnedSession(peer, params.sessionId);
        await this.taskLedger.ready();
        return operationHistory(this.taskLedger.listOperations(), { ...params, taskId: session.taskId,
          profileInstanceId: session.profileInstanceId }, this.ledgerSecret);
      }
      case "task.prepare_resume":
        return this.#prepareResume(peer, params);
      case "task.recover_target":
        return this.#recoverTarget(peer, params);
      case "task.reconciliation.inspect":
        return this.#inspectTaskReconciliation(peer, params);
      case "task.reconciliation.rebind":
        return this.#rebindTaskReconciliation(peer, params);
      case "task.reconciliation.repair_pre_dispatch":
        return this.#repairPreDispatchReadonly(peer, params);
      case "task.reconciliation.complete":
        return this.#completeTaskReconciliation(peer, params);
      case "task.reconciliation.settle_from_evidence":
        return this.#settleTaskFromEvidence(peer, params);
      case "task.reconciliation.resolve_local_editor":
        return this.#resolveLocalEditor(peer, params);
      case "task.reconciliation.resolve_local_selection":
        return this.#resolveLocalSelection(peer, params);
      case "operation.reconcile":
        return this.#reconcileOperation(peer, params);
      default:
        throw new CompanionError("client_method_unknown", `Unknown broker method: ${method}`);
    }
  }

  async #reloadExtension(peer, paramsValue) {
    const params = requireObject(paramsValue, "params");
    const session = this.#requireOwnedSession(peer, params.sessionId, { allowBuildMismatch: true });
    const taskId = requireString(params.taskId ?? session.taskId ?? session.sessionId, "taskId");
    if (session.taskId && session.taskId !== taskId) {
      throw new CompanionError("task_id_mismatch", "Extension reload taskId does not match the logical session task");
    }
    const profile = this.profiles.get(session.profileInstanceId);
    if (!profile?.connected || profile.generation !== session.generation) {
      throw new CompanionError("session_generation_stale", "Session belongs to an inactive profile generation");
    }
    const profileKey = session.profileInstanceId;
    const existingReservation = this.extensionReloadInFlight.get(profileKey);
    if (existingReservation) {
      throw new CompanionError(
        "extension_reload_busy",
        "An Extension reload is already in progress for this profile",
        {
          ...this.#publicExtensionReloadReservation(existingReservation),
          restartPoint: existingReservation.restartPoint ?? "fresh_companion_status_then_wait_for_reconnect",
        },
      );
    }
    const pending = [...this.pendingOperations.values()]
      .filter((operation) => operation.profileInstanceId === profileKey);
    const leases = [...this.leases.values()]
      .filter((lease) => lease.profileInstanceId === profileKey);
    const timedOut = [...this.timedOutOperations.values()]
      .filter((operation) => operation.profileInstanceId === profileKey
        && timedOutNeedsReconciliation(operation)
        && timedOutOperationHasLiveTaskReference(operation, [...this.taskTabs.values()]));
    // A session idle for STALE_IDLE_SESSION_MS with no lease, pending operation or queued work holds
    // nothing in the browser; the installer already counts it as stale. Counting it here put every
    // Companion update off until the 30-minute expiry, which a busy day never reached (2026-10-18: a run
    // that ended without closing its session kept the new version waiting for over an hour). The reload
    // leaves such a session on the old generation, as the expiry would.
    const leasedSessionIds = new Set(leases.map((lease) => lease.sessionId));
    const pendingSessionIds = new Set(pending.map((operation) => operation.sessionId));
    const queueKeys = [...this.operationQueues.keys()];
    const activeSessions = [...this.sessions.values()]
      .filter((entry) => entry.profileInstanceId === profileKey && entry.sessionId !== session.sessionId)
      .filter((entry) => leasedSessionIds.has(entry.sessionId) || pendingSessionIds.has(entry.sessionId)
        || entry.leaseIds?.size > 0
        || queueKeys.some((key) => key === `session:${entry.sessionId}` || key.startsWith(`session:${entry.sessionId}:`))
        || !(Date.now() - entry.lastSeenAt >= STALE_IDLE_SESSION_MS));
    const profileTaskTabs = [...this.taskTabs.values()]
      .filter((entry) => entry.profileInstanceId === profileKey);
    const profileCapsules = this.taskLedger.listTaskCapsules()
      .filter((entry) => (entry.target?.profileInstanceId ?? entry.profileInstanceId) === profileKey);
    const profileOperations = this.taskLedger.listOperations()
      .filter((entry) => (entry.binding?.profileInstanceId ?? entry.profileInstanceId) === profileKey
        && isUnresolvedOperationEffect(entry));
    const reconciliation = deriveActiveReconciliationCounts({
      taskTabs: profileTaskTabs,
      capsules: profileCapsules,
      operations: profileOperations,
      pendingOperations: pending,
      timedOutOperations: timedOut,
    });
    const profileQueuePrefixes = new Set([
      `profile:${profileKey}`,
      `tab:${profileKey}:`,
      ...[...this.sessions.values()]
        .filter((entry) => entry.profileInstanceId === profileKey)
        .map((entry) => `session:${entry.sessionId}`),
    ]);
    const queued = [...this.operationQueues.keys()]
      .filter((key) => [...profileQueuePrefixes].some((prefix) => key === prefix || key.startsWith(prefix)));
    if (pending.length > 0 || leases.length > 0 || timedOut.length > 0 || reconciliation.activeCount > 0 || queued.length > 0 || activeSessions.length > 0) {
      throw new CompanionError(
        "extension_reload_busy",
        "The profile still has active work or unresolved reconciliation; reload is deferred to a safe boundary",
        {
          profileInstanceId: profileKey,
          pendingOperationCount: pending.length,
          leaseCount: leases.length,
          timedOutOperationCount: timedOut.length,
          activeSessionCount: activeSessions.length,
          reconciliationTabCount: reconciliation.activeTabCount,
          reconciliationCapsuleCount: reconciliation.activeCapsuleCount,
          reconciliationOperationCount: reconciliation.activeOperationCount,
          queueCount: queued.length,
          restartPoint: "finish_or_reconcile_all_profile_work_then_request_a_fresh_extension_reload",
        },
      );
    }
    const payload = extensionReloadPayload(params);
    if (payload.expectedBuildId && payload.expectedBuildId !== profile.buildId) {
      throw new CompanionError(
        "extension_build_id_mismatch",
        "The requested reload build does not match the connected Companion profile",
        {
          expectedBuildId: payload.expectedBuildId,
          connectedBuildId: profile.buildId ?? null,
          profileInstanceId: profileKey,
        },
      );
    }
    const reservation = {
      profileInstanceId: profileKey,
      sessionId: session.sessionId,
      ownerTaskId: taskId,
      taskId,
      generation: session.generation,
      idempotencyKey: params.authority?.idempotencyKey ?? null,
      phase: "dispatching",
      restartPoint: "wait_for_reload_result_or_new_extension_hello",
      requestedAt: nowIso(),
    };
    this.extensionReloadInFlight.set(profileKey, reservation);
    try {
      const result = await this.#executeOperation(peer, {
        sessionId: session.sessionId,
        method: "extension.reload",
        intent: params.authority?.intent ?? "extension_reload",
        targetOrigin: "*",
        authority: params.authority,
        params: payload,
      }, { allowBuildMismatch: true });
      if (this.extensionReloadInFlight.get(profileKey) === reservation) {
        reservation.phase = "awaiting_reconnect";
        reservation.restartPoint = "wait_for_new_extension_hello_then_read_status_again";
      }
      return {
        ...result,
        schema: "aos.chrome_companion.extension_refresh_boundary.v1",
        profileInstanceId: profileKey,
        generationBefore: session.generation,
        freshSessionRequired: true,
        reconnectReadback: "companion_status",
        postReloadProof: {
          required: true,
          method: "status.get",
          requireConnected: true,
          requireNewGeneration: true,
          restartPoint: "open_a_new_logical_session_and_reacquire_all_target_leases",
        },
      };
    } catch (error) {
      // A reservation is reusable only when the operation ledger and the
      // returned error both prove that transport dispatch never happened.
      // An ACK, timeout, disconnect, or any other uncertain result remains
      // guarded until a fresh profile generation is registered.
      if (this.extensionReloadInFlight.get(profileKey) === reservation
        && this.#reloadPreDispatchNoEffect(reservation, error)) {
        this.extensionReloadInFlight.delete(profileKey);
      }
      throw error;
    }
  }

  #publicExtensionReloadReservation(reservation) {
    if (!reservation) return null;
    return {
      profileInstanceId: reservation.profileInstanceId ?? null,
      ownerTaskId: reservation.ownerTaskId ?? reservation.taskId ?? null,
      generation: reservation.generation ?? null,
      phase: reservation.phase ?? "awaiting_reconnect",
      restartPoint: reservation.restartPoint ?? "wait_for_new_extension_hello_then_read_status_again",
      operationId: reservation.operationId ?? null,
      idempotencyKey: reservation.idempotencyKey ?? null,
      requestedAt: reservation.requestedAt ?? null,
      durable: reservation.durable === true,
    };
  }

  #reloadPreDispatchNoEffect(reservation, error) {
    const entry = reservation.idempotencyKey ? this.taskLedger.get(reservation.idempotencyKey) : null;
    // A retry with an idempotency key already normalized to a blocked,
    // no-dispatch ledger record fails before transport with a generic
    // idempotency error. The durable record still proves this attempt had no
    // effect, so do not leave the in-memory reload reservation stranded.
    if (entry
      && entry.state === "blocked"
      && entry.dispatchCount === 0
      && entry.dispatchState === "not_dispatched"
      && entry.mutationDispatchAttempted === false
      && entry.effectState === "no_dispatch") return true;
    const details = error?.details;
    if (details?.mutationDispatchAttempted === false
      && details?.effectState === "no_dispatch"
      && (details.dispatchState === undefined || details.dispatchState === "not_dispatched")) {
      return !entry;
    }
    // These guards run before taskLedger.prepare() in #executeOperation. With
    // no ledger entry, they prove that no command could have crossed the
    // dispatch boundary. Keep the list explicit; an unknown error must not
    // accidentally release a reservation after a possible send.
    const code = String(error?.code ?? "");
    const knownPreDispatch = code === "mutation_authority_required"
      || code === "source_handoff_implementation_forbidden"
      || code.startsWith("authority_");
    return knownPreDispatch && !entry;
  }

  #restoreExtensionReloadReservations() {
    const latestByProfile = new Map();
    for (const entry of this.taskLedger.listOperations()) {
      if (entry?.binding?.method !== "extension.reload") continue;
      const profileInstanceId = entry.binding.profileInstanceId ?? entry.profileInstanceId;
      const generation = entry.binding.generation ?? entry.generation;
      if (typeof profileInstanceId !== "string" || !profileInstanceId
        || typeof generation !== "string" || !generation) continue;
      if (!(["dispatched", "unknown_effect", "applied"].includes(entry.state)
        && (entry.dispatchCount ?? 0) > 0)) continue;
      const currentProfile = this.profiles.get(profileInstanceId);
      // A persisted profile binding with another generation proves that this
      // reload has already crossed its fresh hello boundary.
      if (currentProfile?.generation && currentProfile.generation !== generation) continue;
      const previous = latestByProfile.get(profileInstanceId);
      if (!previous || String(entry.updatedAt ?? entry.dispatchedAt ?? "") > String(previous.updatedAt ?? previous.dispatchedAt ?? "")) {
        latestByProfile.set(profileInstanceId, entry);
      }
    }
    for (const [profileInstanceId, entry] of latestByProfile) {
      this.extensionReloadInFlight.set(profileInstanceId, {
        profileInstanceId,
        sessionId: entry.binding?.sessionId ?? null,
        ownerTaskId: entry.binding?.taskId ?? null,
        taskId: entry.binding?.taskId ?? null,
        generation: entry.binding?.generation ?? null,
        idempotencyKey: entry.idempotencyKey ?? null,
        operationId: entry.operationId ?? null,
        phase: "awaiting_reconnect",
        restartPoint: "wait_for_new_extension_hello_then_read_status_again",
        requestedAt: entry.dispatchedAt ?? entry.updatedAt ?? null,
        durable: true,
      });
    }
  }

  #resolveExtensionReloadReservation(profileInstanceId, generation) {
    const reservation = this.extensionReloadInFlight.get(profileInstanceId);
    if (!reservation || typeof generation !== "string" || !generation
      || reservation.generation === generation) return false;
    this.extensionReloadInFlight.delete(profileInstanceId);
    return true;
  }

  #selectProfile(profileInstanceId) {
    if (profileInstanceId !== undefined) {
      const selected = this.profiles.get(requireString(profileInstanceId, "profileInstanceId"));
      if (!selected?.connected) {
        throw new CompanionError("profile_not_connected", "Requested Companion profile is not connected");
      }
      return selected;
    }
    const connected = [...this.profiles.values()].filter((profile) => profile.connected);
    if (connected.length === 0) {
      throw new CompanionError("profile_not_connected", "No Companion profile is connected");
    }
    if (connected.length > 1) {
      throw new CompanionError(
        "profile_selection_ambiguous",
        "Several Companion profiles are connected; choose profileInstanceId explicitly",
        { profileInstanceIds: connected.map((profile) => profile.profileInstanceId) },
      );
    }
    return connected[0];
  }

  #profileBuildMismatches(profile) {
    const mismatches = buildProvenanceMismatches(profile, {
      bundleTreeSha256: BUNDLE_TREE_SHA256,
      extensionTreeSha256: EXTENSION_TREE_SHA256,
      nativeRecorderSha256: NATIVE_RECORDER_SHA256,
    });
    for (const [field, expected] of [["operationSchema", OPERATION_SCHEMA], ["operationSchemaVersion", OPERATION_SCHEMA_VERSION],
      ["operationSchemaDigest", OPERATION_SCHEMA_DIGEST], ["capabilitiesDigest", capabilityDigest(DEFAULT_CAPABILITIES)]]) {
      if (profile?.[field] !== null && profile?.[field] !== undefined && profile[field] !== expected) mismatches.push(field);
    }
    return mismatches;
  }

  #openSession(peer, params) {
    const profile = this.#selectProfile(params.profileInstanceId);
    const taskId = typeof params.taskId === "string" ? params.taskId.slice(0, 240) : null;
    const label = typeof params.label === "string" ? params.label.slice(0, 128) : null;
    const handshake = params.capabilityHandshake
      ? validateCapabilityHandshake(params.capabilityHandshake, { taskId, profile })
      : null;
    if (taskId) {
      const matches = [...this.sessions.values()]
        .filter((entry) => entry.taskId === taskId
          && entry.profileInstanceId === profile.profileInstanceId
          && entry.generation === profile.generation)
        .sort((left, right) => right.lastSeenAt - left.lastSeenAt);
      const owned = matches.find((entry) => entry.peerId === peer.id);
      if (owned) {
        owned.lastSeenAt = Date.now();
        if (label) owned.label = label;
        if (handshake) owned.capabilityHandshake = handshake;
        return { ...this.#publicSession(owned), ...(handshake ? { capabilityHandshake: handshake } : {}), reused: true, ownerTransferred: false };
      }
      const transferable = matches.find((entry) => entry.leaseIds.size === 0
        && ![...this.pendingOperations.values()].some((operation) => operation.sessionId === entry.sessionId));
      if (transferable) {
        this.peers.get(transferable.peerId)?.sessionIds.delete(transferable.sessionId);
        transferable.peerId = peer.id;
        transferable.lastSeenAt = Date.now();
        if (label) transferable.label = label;
        if (handshake) transferable.capabilityHandshake = handshake;
        peer.sessionIds.add(transferable.sessionId);
        return { ...this.#publicSession(transferable), ...(handshake ? { capabilityHandshake: handshake } : {}), reused: true, ownerTransferred: true };
      }
      if (matches.length > 0) {
        throw new CompanionError(
          "task_session_owner_conflict",
          "The task already has a live logical session with active work",
          {
            taskId,
            ownerSessionId: matches[0].sessionId,
            leaseCount: matches[0].leaseIds.size,
          },
        );
      }
    }
    const session = {
      sessionId: createId("session"),
      peerId: peer.id,
      profileInstanceId: profile.profileInstanceId,
      generation: profile.generation,
      label,
      taskId,
      createdAt: nowIso(),
      lastSeenAt: Date.now(),
      leaseIds: new Set(),
      capabilityHandshake: handshake,
    };
    this.sessions.set(session.sessionId, session);
    peer.sessionIds.add(session.sessionId);
    return { ...this.#publicSession(session), ...(handshake ? { capabilityHandshake: handshake } : {}), reused: false, ownerTransferred: false };
  }

  async #closeSession(peer, paramsValue) {
    const params = typeof paramsValue === "string" ? { sessionId: paramsValue } : paramsValue;
    const session = this.#requireOwnedSession(peer, params.sessionId, { allowBuildMismatch: params.taskTerminal === false });
    const leaseCountBeforeClose = session.leaseIds.size;
    let terminalTabCleanup = { ok: true, status: "skipped", reason: "task_terminal_false" };
    if (params.taskTerminal !== false) {
      terminalTabCleanup = await this.#finalizeSessionTerminalTabs(peer, session, {
        allowPreEffectCleanup: params.taskTerminal !== false,
        explicitTaskTerminal: params.taskTerminal === true,
      }).then(async (result) => {
        // Startup may already have removed both task-tab records. Only the
        // pinned original capsule/operation can anchor this terminal fallback.
        const expected = VIEWPORT_CLEANUP_AMENDMENT;
        if (session.taskId !== expected.taskId || result.viewport_cleanup_receipt
          || this.taskTabs.has(this.#tabKey(expected.profileInstanceId, expected.tabId))
          || this.taskLedger.getTaskTab(expected.profileInstanceId, expected.tabId)) return result;
        try {
          result.viewport_cleanup_receipt = await this.#maintainAbsentOriginalViewport(peer, session, null);
          result.viewport_cleanup_disposition = "task_tab_already_absent";
          if (!result.missing.includes(expected.tabId)) result.missing.push(expected.tabId);
        } catch (error) {
          result.ok = false;
          result.status = "partial";
          result.exact_blocker = error?.code ?? "viewport_cleanup_target_missing";
          result.retained.push({ tabId: expected.tabId, retention_reason: "local_ui_effect_unknown",
            exact_blocker: result.exact_blocker });
        }
        return result;
      }).catch((error) => ({
        ok: false,
        status: "cleanup_failed",
        exact_blocker: error?.code ?? "session_terminal_tab_cleanup_failed",
        error: String(error?.message ?? error),
      }));
    }
    this.#deleteSession(session.sessionId);
    const cleanupReceipt = {
      schema: "aos.chrome_companion.owner_cleanup_receipt.v1",
      owner_task_id: session.taskId ?? null,
      owner_session_id: session.sessionId,
      profile_instance_id: session.profileInstanceId,
      generation: session.generation,
      attempted: params.taskTerminal !== false,
      session_closed: true,
      status: terminalTabCleanup.status ?? (terminalTabCleanup.ok === true ? "completed" : "partial"),
      ok: terminalTabCleanup.ok === true,
      closed: Array.isArray(terminalTabCleanup.closed) ? terminalTabCleanup.closed : [],
      missing: Array.isArray(terminalTabCleanup.missing) ? terminalTabCleanup.missing : [],
      retained: Array.isArray(terminalTabCleanup.retained) ? terminalTabCleanup.retained : [],
      skipped: Array.isArray(terminalTabCleanup.skipped) ? terminalTabCleanup.skipped : [],
      unknown_effect: Array.isArray(terminalTabCleanup.unknown_effect) ? terminalTabCleanup.unknown_effect : [],
      exact_blocker: terminalTabCleanup.exact_blocker ?? null,
      leases_released: leaseCountBeforeClose,
      lease_release_confirmed: true,
      owner_scope: "session_task_only",
      block_scope: "session_task",
      independent_work_allowed: true,
      foreign_tabs_mutated: false,
      external_action_executed: false,
      recorded_at: nowIso(),
    };
    return {
      closed: true,
      sessionId: session.sessionId,
      task_terminal: params.taskTerminal !== false,
      terminal_tab_cleanup: terminalTabCleanup,
      cleanup_receipt: cleanupReceipt,
    };
  }

  async #maintainAbsentOriginalViewport(peer, session, taskTab) {
    const expected = VIEWPORT_CLEANUP_AMENDMENT;
    const profile = this.profiles.get(session.profileInstanceId);
    const assertCurrent = () => {
      if (this.#requireOwnedSession(peer, session.sessionId) !== session
        || !["taskId", "profileInstanceId", "generation"].every(key => session[key] === expected[key])
        || this.profiles.get(session.profileInstanceId) !== profile || profile?.generation !== expected.generation
        || (taskTab ? (taskTab.capsuleId !== expected.capsuleId || taskTab.taskId !== expected.taskId
          || taskTab.runId !== expected.runId || taskTab.tabId !== expected.tabId
          || taskTab.quarantine || taskTab.userHelpRequired || !taskTabIdentityConsistent(this.ledgerSecret, taskTab))
          : (this.taskTabs.has(this.#tabKey(expected.profileInstanceId, expected.tabId))
            || this.taskLedger.getTaskTab(expected.profileInstanceId, expected.tabId)))) {
        throw new CompanionError("viewport_cleanup_target_mismatch", "Absence maintenance requires the original owner/profile/generation binding");
      }
    };
    const read = (method, params, evidence) => this.#enqueue(`session:${session.sessionId}`, () => this.#sendOperation({
      profile, session, method, params, timeoutMs: DEFAULT_OPERATION_TIMEOUTS_MS[method] ?? DEFAULT_OPERATION_TIMEOUT_MS,
      authority: null, idempotencyKey: null, binding: { taskId: session.taskId, profileInstanceId: session.profileInstanceId,
        generation: session.generation, sessionId: session.sessionId, tabId: params.tabId ?? null, method },
      fingerprint: null, allowedOrigins: null, targetOrigin: null, taskTabContext: null,
      dispatchGuard: assertCurrent, readEvidence: evidence,
    }));
    assertCurrent();
    // The ledger validates the immutable signature and original operation
    // anchors before returning an already-recorded cleanup receipt.
    if (this.taskLedger.get(expected.operationKey)?.viewportCleanupReceipts?.length) {
      return this.taskLedger.appendViewportCleanup({ capsuleId: expected.capsuleId, proof: null,
        currentBinding: { sessionId: session.sessionId } }, { brokerEvidence: true });
    }
    viewportCleanupCandidate(this.taskLedger.getTaskCapsule(expected.capsuleId),
      this.taskLedger.listOperations(), this.taskLedger.listTaskCapsules());
    const inventoryEvidence = {}, lookupEvidence = {};
    const inventory = await read("tabs.list", {}, inventoryEvidence);
    // Source-qualified extension tabs.list uses chrome.tabs.query({}), then
    // slice(0, MAX_TAB_LIST_ENTRIES=200). At the cap completeness is unknown.
    const cap = 200;
    if (!Array.isArray(inventory) || inventory.length >= cap
      || inventory.some(tab => !Number.isSafeInteger(tab?.id) || tab.id < 0
        || !Number.isSafeInteger(tab.windowId) || tab.windowId < 0)
      || new Set(inventory.map(tab => tab.id)).size !== inventory.length
      || inventory.some(tab => tab.id === expected.tabId)) {
      throw new CompanionError("viewport_cleanup_inventory_incomplete", "Fresh unfiltered sanitized inventory must be below the actual extension cap and exclude the exact original tab");
    }
    let missing = false;
    try { await read("tabs.get", { tabId: expected.tabId }, lookupEvidence); }
    catch (error) {
      missing = error.code === "extension_operation_failed" && lookupEvidence.brokerEvidence === true
        && lookupEvidence.errorCode === "extension_operation_failed"
        && new RegExp(`^No tab with id: ${expected.tabId}\\.?$`, "u").test(lookupEvidence.errorMessage ?? "");
      if (!missing) throw error;
    }
    if (!missing) throw new CompanionError("viewport_cleanup_target_present", "Exact-target lookup did not authenticate the original tab's absence");
    assertCurrent();
    const payload = { schema: "aos.chrome_companion.viewport_absence_proof.v1", taskId: session.taskId,
      profileInstanceId: session.profileInstanceId, generation: session.generation, sessionId: session.sessionId,
      tabId: expected.tabId, inventoryParams: {}, inventoryCap: cap, inventoryIds: inventory.map(tab => tab.id),
      inventoryEvidence, lookupParams: { tabId: expected.tabId }, lookupEvidence, capturedAt: nowIso() };
    const proof = { ...payload, signature: payloadDigest(this.ledgerSecret, payload) };
    const receipt = await this.taskLedger.appendViewportCleanup({ capsuleId: expected.capsuleId,
      proof, currentBinding: { sessionId: session.sessionId } }, { brokerEvidence: true });
    this.taskTabs.delete(this.#tabKey(expected.profileInstanceId, expected.tabId));
    return receipt;
  }

  async #maintainOriginalViewportCleanup(peer, session, taskTab, lease) {
    const expected = VIEWPORT_CLEANUP_AMENDMENT;
    if (taskTab.capsuleId !== expected.capsuleId) return null;
    const capsule = this.taskLedger.getTaskCapsule(expected.capsuleId);
    const original = this.taskLedger.get(expected.operationKey);
    if (original?.viewportCleanupReceipts?.length) return original.viewportCleanupReceipts[0];
    viewportCleanupCandidate(capsule, this.taskLedger.listOperations(), this.taskLedger.listTaskCapsules());
    const assertCurrent = () => {
      if (this.#requireOwnedSession(peer, session.sessionId) !== session
        || !["taskId", "profileInstanceId", "generation"].every(key => session[key] === expected[key])
        || !lease || this.leases.get(lease.leaseId) !== lease || lease.sessionId !== session.sessionId
        || lease.tabId !== expected.tabId || lease.generation !== expected.generation
        || taskTab.taskId !== expected.taskId || taskTab.runId !== expected.runId
        || taskTab.tabId !== expected.tabId || taskTab.generation !== expected.generation
        || taskTab.quarantine || taskTab.userHelpRequired || !taskTabIdentityConsistent(this.ledgerSecret, taskTab)
        || !["pageInstanceId", "windowId", "frameId"].every(key => taskTab.targetIdentity?.[key] === expected[key])) {
        throw new CompanionError("viewport_cleanup_target_mismatch", "Cleanup requires the current owner's exact lease and original document");
      }
    };
    assertCurrent();
    const read = await this.#inspectVisualPoint(peer, { sessionId: session.sessionId,
      leaseId: lease.leaseId, tabId: expected.tabId, point: { x: 1, y: 1 } });
    assertCurrent();
    if (read.target?.frameId !== expected.frameId || read.visual?.windowId !== expected.windowId
      || !Number.isFinite(Date.parse(read.visual?.capturedAt)) || read.visualProof?.capturedAt !== read.visual.capturedAt) {
      throw new CompanionError("viewport_cleanup_target_mismatch", "Fresh inspection/capture must identify the original frame/window");
    }
    const receipt = await this.taskLedger.appendViewportCleanup({ capsuleId: expected.capsuleId,
      proof: read.visualProof, currentBinding: { sessionId: session.sessionId, leaseId: lease.leaseId } }, { brokerEvidence: true });
    const updated = this.taskLedger.getTaskTab(expected.profileInstanceId, expected.tabId);
    if (updated) this.taskTabs.set(this.#tabKey(expected.profileInstanceId, expected.tabId), updated);
    return receipt;
  }

  async #finalizeSessionTerminalTabs(peer, session, { allowPreEffectCleanup = false, explicitTaskTerminal = false } = {}) {
    const result = {
      schema: "aos.chrome_companion.owner_cleanup_receipt.v1",
      ok: true,
      status: "completed",
      task_id: session.taskId ?? null,
      owner_session_id: session.sessionId,
      owner_scope: "session_task_only",
      attempted: true,
      closed: [],
      missing: [],
      retained: [],
      skipped: [],
      unknown_effect: [],
    };
    if (!session.taskId) return result;
    const entries = [...this.taskTabs.values()]
      .filter((entry) => entry.profileInstanceId === session.profileInstanceId
        && entry.generation === session.generation
        && entry.taskId === session.taskId)
      .sort((left, right) => left.tabId - right.tabId);
    if (entries.length === 0) return result;
    const profile = this.profiles.get(session.profileInstanceId);
    const liveSessionIds = new Set(
      [...this.sessions.values()]
        .filter((entry) => entry.profileInstanceId === session.profileInstanceId && entry.generation === session.generation)
        .map((entry) => entry.sessionId),
    );
    const pendingTaskIds = new Set([
      ...[...this.pendingOperations.values()].map((operation) => operation.binding?.taskId ?? operation.taskTabContext?.taskId),
      ...[...this.timedOutOperations.values()].map((operation) => operation.binding?.taskId ?? operation.taskTabContext?.taskId),
    ].filter(Boolean));
    const inventory = await this.#executeOperation(peer, { sessionId: session.sessionId, method: "tabs.list", params: {} });
    const liveById = new Map(inventory.map((tab) => [tab.id, tab]));
    for (let entry of entries) {
      const live = liveById.get(entry.tabId);
      if (!live && entry.capsuleId === VIEWPORT_CLEANUP_AMENDMENT.capsuleId
        && entry.retentionReason === "local_ui_effect_unknown") {
        try {
          const receipt = await this.#maintainAbsentOriginalViewport(peer, session, entry);
          result.viewport_cleanup_receipt = receipt;
          result.missing.push(entry.tabId);
        } catch (error) {
          result.retained.push({ tabId: entry.tabId, retention_reason: "local_ui_effect_unknown",
            exact_blocker: error?.code ?? "viewport_cleanup_target_missing" });
        }
        continue;
      }
      if (!live) {
        this.taskTabs.delete(this.#tabKey(entry.profileInstanceId, entry.tabId));
        await this.taskLedger.removeTaskTab(entry.profileInstanceId, entry.tabId);
        result.missing.push(entry.tabId);
        continue;
      }
      if (live.pinned === true) {
        result.retained.push({
          tabId: entry.tabId,
          user_help_required: entry.userHelpRequired === true,
          retention_reason: "pinned",
          why_tab_was_kept: "Pinned tabs are never closed by terminal task cleanup.",
          required_user_action: entry.requiredUserAction ?? null,
          resume_action: entry.resumeAction ?? null,
        });
        continue;
      }
      const leaseId = this.tabLeaseIndex.get(this.#tabKey(entry.profileInstanceId, entry.tabId));
      const lease = this.leases.get(leaseId);
      const busyLease = leaseId && (
        [...this.taskTargetReservations.values()].includes(session.sessionId)
        || [...this.pendingOperations.values(), ...this.timedOutOperations.values()].some((operation) =>
          operation.sessionId === session.sessionId
          && (operation.params?.tabId ?? operation.binding?.tabId) === entry.tabId)
      );
      // Keep the closing owner's idle lease until the close finishes so no
      // other session can acquire this tab in the middle of terminal cleanup.
      // Foreign leases and operations still awaiting results remain protected.
      if (leaseId && (lease?.sessionId !== session.sessionId || busyLease)) {
        // A terminal tab blocked only by this owner's transient lease must
        // converge after session.close releases that lease. Detach it into
        // the ownerless cleanup lane. Foreign leases and protected tabs stay
        // untouched.
        if (lease?.sessionId === session.sessionId
          && TASK_TAB_TERMINAL_LIFECYCLES.has(entry.lifecycleState)
          && entry.userHelpRequired !== true
          && !entry.resumeToken
          && !entry.quarantine) {
          const detached = {
            ...entry,
            sessionId: null,
            retentionPolicy: "cleanup",
            updatedAt: nowIso(),
            retentionReason: "terminal_cleanup_pending",
            whyTabWasKept: "The owner closed before its transient lease settled; the tab is queued for ownerless terminal cleanup.",
            resumeAction: "cleanup_task_owned_tab",
          };
          this.taskTabs.set(this.#tabKey(entry.profileInstanceId, entry.tabId), detached);
          await this.taskLedger.recordTaskTab(detached);
        }
        result.skipped.push({ tabId: entry.tabId, reason: "leased" });
        continue;
      }
      if (entry.lifecycleState === "awaiting_user") {
        result.retained.push({
          tabId: entry.tabId,
          user_help_required: true,
          retention_reason: entry.retentionReason ?? "user_help_required",
          why_tab_was_kept: entry.whyTabWasKept ?? "The task-owned tab contains the exact user-only action needed to resume safely.",
          required_user_action: entry.requiredUserAction ?? null,
          resume_action: entry.resumeAction ?? null,
        });
        continue;
      }
      if (entry.capsuleId === VIEWPORT_CLEANUP_AMENDMENT.capsuleId && entry.retentionReason === "local_ui_effect_unknown") {
        let maintenanceLease = lease;
        let acquired = false;
        try {
          if (!maintenanceLease) {
            const acquiredLease = await this.#acquireLease(peer, { sessionId: session.sessionId, tabId: entry.tabId });
            maintenanceLease = this.leases.get(acquiredLease.leaseId);
            acquired = true;
          }
          const receipt = await this.#maintainOriginalViewportCleanup(peer, session, entry, maintenanceLease);
          if (receipt) {
            entry = this.taskTabs.get(this.#tabKey(entry.profileInstanceId, entry.tabId)) ?? entry;
            result.viewport_cleanup_receipt = receipt;
          }
        } catch (error) {
          result.retained.push({ tabId: entry.tabId, retention_reason: "local_ui_effect_unknown",
            exact_blocker: error?.code ?? "viewport_cleanup_readback_unavailable" });
          continue;
        } finally {
          if (acquired) this.#deleteLease(maintenanceLease.leaseId);
        }
      }
      const ledgerOnly = isLedgerOnlyTaskTab(entry);
      if (entry.retentionReason === "attachment_confirmed_workflow_unsubmitted") {
        if (!explicitTaskTerminal) {
          result.retained.push({ tabId: entry.tabId, retention_reason: entry.retentionReason,
            resume_action: "continue_unsubmitted_workflow_or_explicitly_abandon" });
          continue;
        }
        entry = { ...entry, retentionPolicy: "cleanup", retentionReason: "explicit_owner_terminal_unsubmitted_workflow" };
      }
      // Kept for the task to resume; once the task says it is finished there is nothing to resume, and closing
      // a page sends nothing (known effects are already recorded, local edits were never sent).
      if (!explicitTaskTerminal && entry.retentionPolicy === "retain_until_resume" && ["partial_actions_applied", "local_ui_effect_unknown"].includes(entry.retentionReason)) {
        result.retained.push({ tabId: entry.tabId, user_help_required: false,
          retention_reason: entry.retentionReason, why_tab_was_kept: entry.whyTabWasKept,
          resume_action: "read_back_same_target_then_continue_remaining_actions" });
        continue;
      }
      if (!ledgerOnly && ["reconciliation_required", "operation_effect_unknown"].includes(entry.lifecycleState)) {
        result.retained.push({
          tabId: entry.tabId,
          user_help_required: false,
          retention_reason: "ai_reconciliation_pending",
          why_tab_was_kept: "Codex is still reconciling an unknown external effect; this is temporary active work, not a user handoff.",
          required_user_action: null,
          resume_action: "signed_task_status_readback_then_cleanup_when_reconciled",
        });
        continue;
      }
      const safePreEffectTab = allowPreEffectCleanup
        && isSafePreEffectTaskTab(entry, {
          sessionId: session.sessionId,
          liveSessionIds,
          pendingTaskIds,
        });
      if (ledgerOnly
        && entry.sessionId
        && entry.sessionId !== session.sessionId
        && liveSessionIds.has(entry.sessionId)) {
        result.skipped.push({ tabId: entry.tabId, reason: "live_owner_session" });
        continue;
      }
      if (!ledgerOnly && !safePreEffectTab && !["completed", "failed"].includes(entry.lifecycleState)) {
        result.retained.push({
          tabId: entry.tabId,
          user_help_required: false,
          retention_reason: "task_still_active",
          why_tab_was_kept: "The task capsule is not terminal yet, so the tab remains active work.",
          required_user_action: null,
          resume_action: "continue_current_task_then_finalize",
        });
        continue;
      }
      if (entry.quarantine && !ledgerOnly) {
        result.skipped.push({ tabId: entry.tabId, reason: `quarantine:${entry.quarantine}` });
        continue;
      }
      let origin = null;
      try { origin = new URL(live.url).origin; } catch { /* browser-internal URL */ }
      if (!origin || origin === "null") {
        result.skipped.push({ tabId: entry.tabId, reason: "unsupported_origin" });
        continue;
      }
      const idempotencyKey = `session-terminal:${session.sessionId}:${entry.tabId}`;
      const operationParams = { tabId: entry.tabId };
      const binding = {
        runId: entry.runId ?? null,
        profileInstanceId: session.profileInstanceId,
        generation: session.generation,
        sessionId: session.sessionId,
        ownerKey: session.sessionId,
        tabId: entry.tabId,
        method: "tabs.close",
        taskId: session.taskId,
      };
      const fingerprint = payloadDigest(this.ledgerSecret, { binding, payload: operationParams });
      const prepared = await this.taskLedger.prepare({ idempotencyKey, fingerprint, binding });
      if (prepared.state !== "prepared") {
        result.skipped.push({ tabId: entry.tabId, reason: `idempotency:${prepared.state}` });
        continue;
      }
      try {
        await this.#enqueue(`tab:${session.profileInstanceId}:${entry.tabId}`, () => this.#sendOperation({
          profile,
          session,
          method: "tabs.close",
          params: operationParams,
          timeoutMs: DEFAULT_OPERATION_TIMEOUTS_MS["tabs.close"],
          authority: null,
          idempotencyKey,
          binding,
          fingerprint,
          allowedOrigins: [origin],
          targetOrigin: origin,
          taskTabContext: null,
        }));
        result.closed.push(entry.tabId);
      } catch (error) {
        if (error?.code === "operation_effect_unknown") {
          result.unknown_effect.push({ tabId: entry.tabId, code: error.code });
          if (ledgerOnly) {
            // The tab is disposable independently of the provider effect.
            // Keep the close operation's unknown receipt, but do not let a
            // missing close acknowledgement pin the task to this tab.
            this.taskTabs.delete(this.#tabKey(entry.profileInstanceId, entry.tabId));
            await this.taskLedger.removeTaskTab(entry.profileInstanceId, entry.tabId);
          }
        } else {
          result.skipped.push({ tabId: entry.tabId, reason: error?.code ?? "terminal_tab_close_failed" });
        }
      }
    }
    result.ok = result.skipped.length === 0 && result.unknown_effect.length === 0;
    if (!result.ok) result.status = "partial";
    return result;
  }

  async #synchronizeOwnedTaskTabIdentity(session, lease, tabId) {
    // A task-tab record can outlive the MCP process that originally opened it.
    // Once the same task acquires a fresh exact-tab lease in the same profile
    // generation, repair only the owner lineage fields.  We deliberately do
    // not adopt foreign tasks, stale generations, or user-help/quarantined
    // records; those remain visible and fail closed for explicit recovery.
    if (!session?.taskId || !lease || !Number.isSafeInteger(tabId)) return null;
    const key = this.#tabKey(session.profileInstanceId, tabId);
    const entry = this.taskTabs.get(key) || this.taskLedger.getTaskTab(session.profileInstanceId, tabId);
    if (!entry
      || entry.taskId !== session.taskId
      || entry.generation !== session.generation
      || entry.quarantine
      || entry.userHelpRequired === true) return entry ?? null;
    const consistent = taskTabIdentityConsistent(this.ledgerSecret, entry)
      && entry.sessionId === session.sessionId;
    if (consistent) return entry;
    const identity = rebuildTaskTabIdentity(this.ledgerSecret, entry, {
      taskId: session.taskId,
      sessionId: session.sessionId,
      leaseId: null,
      generation: session.generation,
      profileInstanceId: session.profileInstanceId,
      tabId,
    });
    const repaired = {
      ...entry,
      sessionId: session.sessionId,
      targetIdentity: identity.targetIdentity,
      targetFingerprint: identity.targetFingerprint,
      identityRepairedAt: nowIso(),
      identityRepairReason: "same_task_fresh_lease",
      updatedAt: nowIso(),
    };
    await this.taskLedger.recordTaskTab(repaired);
    this.taskTabs.set(key, this.taskLedger.getTaskTab(session.profileInstanceId, tabId));
    return this.taskTabs.get(key);
  }

  async #acquireLease(peer, params) {
    const session = this.#requireOwnedSession(peer, params.sessionId);
    const tabId = requireTabId(params.tabId);
    const tabKey = this.#tabKey(session.profileInstanceId, tabId);
    const existingLeaseId = this.tabLeaseIndex.get(tabKey);
    if (existingLeaseId) {
      const existing = this.leases.get(existingLeaseId);
      if (existing?.sessionId === session.sessionId) {
        await this.#synchronizeOwnedTaskTabIdentity(session, existing, tabId);
        return this.#publicLease(existing);
      }
      throw new CompanionError(
        "tab_lease_conflict",
        "The exact tab is already reserved by another logical session",
        { tabId },
      );
    }
    const lease = {
      leaseId: createId("lease"),
      sessionId: session.sessionId,
      profileInstanceId: session.profileInstanceId,
      generation: session.generation,
      tabId,
      acquiredAt: nowIso(),
    };
    const trackedTaskTab = this.taskTabs.get(tabKey) || this.taskLedger.getTaskTab(session.profileInstanceId, tabId);
    lease.targetIdentity = normalizeTargetIdentity({
      taskId: session.taskId ?? session.sessionId,
      sessionId: session.sessionId,
      leaseId: lease.leaseId,
      generation: session.generation,
      profileInstanceId: session.profileInstanceId,
      tabId,
      pageInstanceId: trackedTaskTab?.targetIdentity?.pageInstanceId ?? null,
      windowId: trackedTaskTab?.targetIdentity?.windowId ?? trackedTaskTab?.windowId ?? null,
      frameId: 0,
      origin: trackedTaskTab?.targetIdentity?.origin ?? null,
    });
    lease.targetFingerprint = targetIdentityDigest(this.ledgerSecret, lease.targetIdentity);
    this.leases.set(lease.leaseId, lease);
    this.tabLeaseIndex.set(tabKey, lease.leaseId);
    session.leaseIds.add(lease.leaseId);
    await this.#synchronizeOwnedTaskTabIdentity(session, lease, tabId);
    return this.#publicLease(lease);
  }

  #releaseLease(peer, leaseIdValue) {
    const leaseId = requireString(leaseIdValue, "leaseId");
    const lease = this.leases.get(leaseId);
    if (!lease) {
      return { released: false, leaseId };
    }
    this.#requireOwnedSession(peer, lease.sessionId, { allowBuildMismatch: true });
    this.#deleteLease(leaseId);
    return { released: true, leaseId };
  }

  async #claimExistingTab(peer, params) {
    const session = this.#requireOwnedSession(peer, params.sessionId);
    const taskId = session.taskId ?? session.sessionId;
    const approval = params.approval;
    const targetIdentityInput = params.targetIdentity;
    if (!approval || typeof approval !== "object" || approval.approved !== true) {
      throw new CompanionError("existing_tab_claim_requires_signed_approval", "Claiming an existing tab requires an approved signed authority envelope");
    }
    const targetFingerprint = requireString(params.targetFingerprint, "targetFingerprint");
    const targetIdentity = normalizeTargetIdentity({
      ...(targetIdentityInput && typeof targetIdentityInput === "object" ? targetIdentityInput : {}),
      taskId,
      sessionId: session.sessionId,
      tabId: requireTabId(params.tabId),
      origin: params.origin ?? targetIdentityInput?.origin,
    });
    if (targetIdentity.profileInstanceId && targetIdentity.profileInstanceId !== session.profileInstanceId) {
      throw new CompanionError("existing_tab_claim_profile_mismatch", "Claim target belongs to another Companion profile");
    }
    if (targetIdentity.generation && targetIdentity.generation !== session.generation) {
      throw new CompanionError("existing_tab_claim_generation_mismatch", "Claim target belongs to another profile generation");
    }
    if (targetIdentityDigest(this.ledgerSecret, targetIdentity) !== targetFingerprint) {
      throw new CompanionError("existing_tab_claim_fingerprint_mismatch", "Claim target fingerprint does not match the complete target identity");
    }
    const payload = { tabId: targetIdentity.tabId, targetFingerprint, targetIdentity };
    if (this.strictAuthority) {
      await this.taskLedger.verifyAndConsumeAuthority(approval, {
        secrets: this.issuerSecrets,
        payload,
        expected: { taskId, ownerKey: session.sessionId, method: "tabs.claimExisting", intent: "claim_existing_tab" },
      });
    } else if (typeof approval.signature !== "string" || typeof approval.nonce !== "string") {
      throw new CompanionError("existing_tab_claim_signature_required", "A local claim still requires a one-time signature and nonce");
    }
    const inventory = await this.#executeOperation(peer, { sessionId: session.sessionId, method: "tabs.list", params: {} });
    const live = inventory.find((tab) => tab.id === targetIdentity.tabId);
    if (!live) throw new CompanionError("existing_tab_not_found", "The approved existing tab is no longer open");
    if (live.active === true || live.pinned === true) throw new CompanionError("existing_tab_claim_protected", "Active and pinned user tabs cannot be claimed");
    if (typeof live.url === "string" && (/^chrome-extension:/u.test(live.url) || /(?:login|signin|auth|verify|captcha|otp)/iu.test(live.url))) {
      throw new CompanionError("existing_tab_claim_protected", "Extension, authentication, and verification tabs cannot be claimed");
    }
    const tabKey = this.#tabKey(session.profileInstanceId, live.id);
    if (targetIdentity.windowId !== null && targetIdentity.windowId !== live.windowId) throw new CompanionError("existing_tab_claim_window_mismatch", "Claim target window does not match the live tab");
    if (targetIdentity.windowId === null) throw new CompanionError("existing_tab_claim_window_required", "Claim approval must bind the exact Chrome windowId");
    const existing = this.taskTabs.get(tabKey) || this.taskLedger.getTaskTab(session.profileInstanceId, live.id);
    if (existing && existing.taskId !== taskId) throw new CompanionError("existing_tab_claim_foreign_owner", "The tab is already tracked by another task");
    const lease = await this.#acquireLease(peer, { sessionId: session.sessionId, tabId: live.id });
    const claimedTargetIdentity = { ...targetIdentity, leaseId: lease.leaseId, windowId: live.windowId, origin: (() => { try { return new URL(live.url).origin; } catch { return targetIdentity.origin; } })() };
    const claimedTargetFingerprint = targetIdentityDigest(this.ledgerSecret, claimedTargetIdentity);
    const claimed = {
      profileInstanceId: session.profileInstanceId,
      generation: session.generation,
      tabId: live.id,
      windowId: live.windowId,
      taskId,
      runId: approval.runId ?? `claim:${approval.authorityId ?? approval.nonce}`,
      operationId: null,
      sessionId: session.sessionId,
      targetKey: `claimed:${targetFingerprint}`,
      canonicalLocator: null,
      targetIdentity: claimedTargetIdentity,
      targetFingerprint: claimedTargetFingerprint,
      workflowType: "explicit_tab_claim",
      lifecycleState: "executing",
      retentionPolicy: "explicit",
      resumeToken: null,
      userHelpRequired: false,
      retentionReason: "explicit_existing_tab_claim",
      whyTabWasKept: "The user explicitly approved this existing tab for the current task.",
      requiredUserAction: null,
      resumeAction: "release_claim_lease_then_cleanup_task_owned_tab",
      claimed: true,
      createdAt: nowIso(),
      updatedAt: nowIso(),
    };
    await this.taskLedger.recordTaskTab(claimed);
    this.taskTabs.set(tabKey, this.taskLedger.getTaskTab(session.profileInstanceId, live.id));
    return { claimed: true, explicitApproval: true, lease: this.#publicLease(lease), tab: live, approvalTargetIdentity: targetIdentity, approvalTargetFingerprint: targetFingerprint, targetIdentity: claimed.targetIdentity, targetFingerprint: claimedTargetFingerprint };
  }

  async #executeOperation(peer, params, { trustedTask = null, allowBuildMismatch = false } = {}) {
    const operationStartedAt = performance.now();
    const method = requireString(params.method, "operation method");
    const session = this.#requireOwnedSession(peer, params.sessionId, {
      allowBuildMismatch: allowBuildMismatch && method === "extension.reload",
    });
    if (!EXTENSION_METHODS.has(method)) {
      throw new CompanionError("capability_not_supported", `Unsupported extension operation: ${method}`);
    }
    const profile = this.profiles.get(session.profileInstanceId);
    if (!profile?.connected || profile.generation !== session.generation) {
      throw new CompanionError("session_generation_stale", "Session belongs to an inactive profile generation");
    }
    const operationParams = requireObject(params.params ?? {}, "operation params");
    const localNavigationRecovery = ["tabs.navigationDiagnostics", "tabs.stopLoading"].includes(method);
    const readSourceCleanup = () => {
      if (operationParams.sourceOperationId === undefined) return undefined;
      const source = typeof operationParams.sourceOperationId === "string"
        && operationParams.sourceOperationId.length > 0 && operationParams.sourceOperationId.length <= 256
        ? this.taskLedger.getOperationById(operationParams.sourceOperationId) : null;
      const sourceBinding = source?.binding;
      const target = sourceBinding?.targetIdentity;
      const deny = () => { throw new CompanionError("navigation_cleanup_source_not_found", "No readable cleanup source matches this exact task target"); };
      if (method !== "tabs.navigationDiagnostics" || !source?.cleanupReceipt || sourceBinding?.method !== "tabs.stopLoading"
        || sourceBinding.taskId !== session.taskId || sourceBinding.profileInstanceId !== session.profileInstanceId
        || sourceBinding.tabId !== operationParams.tabId
        || target?.profileInstanceId !== sourceBinding.profileInstanceId || target?.tabId !== sourceBinding.tabId
        || target.origin !== new URL(operationParams.expectedUrl).origin
        || Number.isSafeInteger(target.windowId) && target.windowId !== operationParams.expectedWindowId) deny();
      // The original session/generation remain untouched. A fresh exact live
      // tuple authorizes this metadata read, not a claim about the old path.
      const names = ["operationId", "taskId", "sessionId", "profileInstanceId", "generation", "tabId", "status", "startedAt", "reason", "observedAt"];
      return Object.fromEntries(names.filter(name => source.cleanupReceipt[name] !== undefined)
        .map(name => [name, source.cleanupReceipt[name]]));
    };
    if (localNavigationRecovery) {
      if (trustedTask || params.intent !== "local_navigation_recovery" || !params.authority) {
        throw new CompanionError("local_navigation_recovery_required", "Navigation recovery requires a fresh separately signed exact-target request");
      }
      if (method === "tabs.stopLoading" && operationParams.optIn !== true) {
        throw new CompanionError("navigation_stop_opt_in_required", "Stopping loading requires explicit optIn:true");
      }
      if (!Number.isSafeInteger(operationParams.expectedWindowId) || operationParams.expectedWindowId < 0
        || !Object.hasOwn(operationParams, "expectedPendingUrl")) {
        throw new CompanionError("navigation_recovery_binding_required", "Recovery requires the expected exact window and pending URL");
      }
      const allowedOrigins = operationParams.allowedOrigins;
      if (!Array.isArray(allowedOrigins) || allowedOrigins.length === 0 || allowedOrigins.length > 32
        || allowedOrigins.some(value => {
          try { const origin = new URL(value); return !["http:", "https:"].includes(origin.protocol)
            || origin.username !== "" || origin.password !== "" || origin.origin !== value; }
          catch { return true; }
        })) {
        throw new CompanionError("navigation_recovery_origin_not_allowed", "Recovery requires a canonical HTTP origin allowlist");
      }
      for (const value of [operationParams.expectedUrl, operationParams.expectedPendingUrl].filter(value => value !== null)) {
        let url;
        try { url = new URL(value); } catch { /* reject below */ }
        if (!url || !["http:", "https:"].includes(url.protocol) || url.username !== "" || url.password !== "" || url.href !== value
          || !Array.isArray(allowedOrigins) || !allowedOrigins.includes(url.origin)) {
          throw new CompanionError("navigation_recovery_origin_not_allowed", "Committed and pending canonical URLs must remain inside the signed origin allowlist");
        }
      }
      if (typeof operationParams.expectedUrl !== "string") {
        throw new CompanionError("navigation_recovery_binding_required", "Recovery requires the committed URL");
      }
      if (params.authority.targetOrigin !== new URL(operationParams.expectedUrl).origin
        || params.targetOrigin !== params.authority.targetOrigin
        || operationParams.targetOrigin !== undefined && operationParams.targetOrigin !== params.authority.targetOrigin) {
        throw new CompanionError("navigation_recovery_origin_not_allowed", "The signed target origin must match the committed URL");
      }
    }
    validateExpectedActionEvent(method, operationParams.expectEvent);
    const isMutation = MUTATION_METHODS.has(method);
    const authority = trustedTask?.authority ?? params.authority;
    if (isMutation) {
      await this.#assertTaskImplementationAllowed(
        trustedTask?.taskId ?? authority?.taskId ?? session.taskId,
        {
          allowDirectApplication: trustedTask?.allowDirectApplication === true,
          allowVisualMaintenance: trustedTask?.allowVisualMaintenance === true
            && method === "tabs.groupTask"
            && operationParams.collapsed === true
            && operationParams.visualOnlyCleanup === true,
        },
      );
    }
    if (isMutation && this.strictAuthority && !authority) {
      throw new CompanionError("mutation_authority_required", "Mutations require a signed task authority envelope");
    }
    if (method === "tabs.create" && this.strictAuthority && !trustedTask) {
      throw new CompanionError("task_transaction_required", "Create tabs through task.transaction so provenance is recorded");
    }
    if ((isMutation && this.strictAuthority || localNavigationRecovery) && authority && !trustedTask) {
      await this.taskLedger.verifyAndConsumeAuthority(authority, {
        secrets: this.issuerSecrets,
        payload: operationParams,
        expected: {
          taskId: session.taskId ?? session.sessionId,
          ownerKey: session.sessionId,
          method,
          intent: params.intent ?? method,
        },
      });
    }
    let tabId = operationParams.tabId;
    let targetLeaseId = null;
    let ownedTaskTab = null;
    const assertNavigationReady = () => {
      if (!isMutation || !operationRequiresReconciliation({ method })) return;
      const unresolvedNavigation = unresolvedLocalNavigationForTarget(this.taskLedger.listOperations(), {
        profileInstanceId: session.profileInstanceId, tabId,
      });
      if (unresolvedNavigation.length > 0) {
        throw new CompanionError("local_navigation_readback_required", "The original reload/navigation on this exact target requires broker-verified reconciliation before an external mutation", {
          ...blockerRecoveryContext({ code: "local_navigation_readback_required", taskId: session.taskId,
            runId: authority?.runId, profileInstanceId: session.profileInstanceId, tabId,
            nextAction: "reconcile_original_navigation_with_fresh_exact_target_evidence" }),
          operationIds: unresolvedNavigation.map(entry => entry.operationId ?? entry.idempotencyKey).slice(0, 50),
          mutationDispatchAttempted: false, operationEffectState: "no_dispatch",
        });
      }
    };
    let validateTarget = () => {};
    if (TARGET_METHODS.has(method)) {
      tabId = requireTabId(tabId);
      const leaseId = requireString(params.leaseId, "leaseId");
      validateTarget = () => {
        const lease = this.leases.get(leaseId);
        if (
          !lease
          || lease.sessionId !== session.sessionId
          || lease.profileInstanceId !== session.profileInstanceId
          || lease.tabId !== tabId
          || lease.generation !== session.generation
        ) {
          throw new CompanionError("exact_tab_lease_required", "Operation requires this session's exact-tab lease");
        }
        targetLeaseId = lease.leaseId;
        assertNavigationReady();
        const taskTab = this.taskTabs.get(this.#tabKey(session.profileInstanceId, tabId))
          || this.taskLedger.getTaskTab(session.profileInstanceId, tabId);
        ownedTaskTab = taskTab;
        if ((method === "page.observe" || localNavigationRecovery) && (!taskTab || taskTab.taskId !== session.taskId
          || localNavigationRecovery && taskTab.runId !== authority.runId)) {
          throw new CompanionError("task_tab_ownership_required", "Observation and local recovery require the exact task-owned target and signed run");
        }
        if (taskTab && !taskTabIdentityConsistent(this.ledgerSecret, taskTab)) {
          throw new CompanionError(
            "task_tab_identity_mismatch",
            "Persisted task-tab identity does not match its current owner fields",
            { tabId, taskId: taskTab.taskId ?? null, sessionId: taskTab.sessionId ?? null },
          );
        }
        const staleGenerationCleanupAllowed = method === "tabs.close"
          && (operationParams.staleGenerationCleanup === true || operationParams.detachedTerminalCleanup === true)
          && trustedTask
          && taskTab
          && taskTab.taskId === trustedTask.taskId
          && (taskTab.quarantine === "stale_generation" || operationParams.detachedTerminalCleanup === true)
          && taskTab.userHelpRequired !== true
          && !taskTab.resumeToken
          && !TAB_CLEANUP_PROTECTED_RETENTION.has(taskTab.retentionPolicy)
          && (TASK_TAB_TERMINAL_LIFECYCLES.has(taskTab.lifecycleState) || isLedgerOnlyTaskTab(taskTab))
          && (() => {
            const leaseId = this.tabLeaseIndex.get(this.#tabKey(session.profileInstanceId, tabId));
            const lease = leaseId ? this.leases.get(leaseId) : null;
            return !lease || lease.sessionId === session.sessionId;
          })();
        const visualOnlyTaskGroupCleanupAllowed = method === "tabs.groupTask"
          && operationParams.collapsed === true
          && operationParams.visualOnlyCleanup === true
          && trustedTask?.allowVisualMaintenance === true
          && taskTab
          && taskTab.taskId === trustedTask.taskId
          && VISUAL_COLLAPSE_LIFECYCLES.has(taskTab.lifecycleState)
          && taskTab.userHelpRequired !== true
          && !taskTab.resumeToken;
        if (isMutation && (params.taskOwnedRequired || trustedTask || this.strictAuthority)
          && (!taskTab
            || taskTab.taskId !== (trustedTask?.taskId ?? authority?.taskId)
            || taskTab.runId !== (trustedTask?.runId ?? authority?.runId))
          && !staleGenerationCleanupAllowed
          && !visualOnlyTaskGroupCleanupAllowed) {
          throw new CompanionError("task_tab_ownership_required", "Mutations are allowed only on tabs created by this task");
        }
      };
      validateTarget();
    }
    if (operationParams.sourceOperationId !== undefined) readSourceCleanup();
    session.lastSeenAt = Date.now();
    const timeoutMs = normalizeTimeout(
      params.timeoutMs,
      DEFAULT_OPERATION_TIMEOUTS_MS[method] ?? DEFAULT_OPERATION_TIMEOUT_MS,
    );
    const requiresProfileGlobalLane = PROFILE_GLOBAL_METHODS.has(method)
      || (method === "page.type" && operationParams.physicalFallback === "on_verified_no_effect");
    const queueKey = requiresProfileGlobalLane
      ? `profile:${session.profileInstanceId}`
      : TARGET_METHODS.has(method)
        ? `tab:${session.profileInstanceId}:${tabId}`
        : `session:${session.sessionId}`;
    const idempotencyKey = isMutation || localNavigationRecovery
      ? (trustedTask ? `${trustedTask.idempotencyKey}:${trustedTask.index}` : authority?.idempotencyKey ?? null)
      : null;
    const pendingEditor = ["page.type", "visual.typeText"].includes(method) && this.taskLedger.listOperations().find(entry =>
      entry.state === "unknown_effect" && entry.binding?.method === "page.type" && entry.binding?.taskId === session.taskId
      && entry.binding?.profileInstanceId === session.profileInstanceId && entry.binding?.tabId === tabId);
    // Replacing the whole field again (clear: true) cannot duplicate text, so it needs no repair binding;
    // only an insertion next to text of unknown state does.
    const replacesWholeField = operationParams.clear === true;
    if (pendingEditor && !replacesWholeField && (method !== "visual.typeText" || operationParams.clickBeforeType !== false
      || operationParams.editorGuard?.originalOperationKey !== pendingEditor.idempotencyKey
      || !operationParams.editorGuard?.resolutionId)) {
      throw new CompanionError("local_editor_resolution_required", "Uncertain whole-field editor input permits only a signed different-key surgical insertion");
    }
    if (method === "visual.typeText" && operationParams.clickBeforeType === false
      && operationParams.editorGuard?.resolutionId) {
      const guard = operationParams.editorGuard;
      if (operationParams.clear !== false) throw new CompanionError("local_editor_repair_binding_invalid", "Surgical editor repair requires clear:false");
      await this.taskLedger.consumeLocalEditorResolution({ originalOperationKey: guard.originalOperationKey,
        resolutionId: guard.resolutionId, repairOperationKey: idempotencyKey, guard, text: operationParams.text,
        currentBinding: { taskId: session.taskId, sessionId: session.sessionId, leaseId: targetLeaseId,
          generation: session.generation, profileInstanceId: session.profileInstanceId, tabId,
          pageInstanceId: operationParams.pageInstanceId, windowId: operationParams.windowId, frameId: operationParams.frameId ?? 0 } });
    }
    const targetIdentity = normalizeTargetIdentity({
      taskId: authority?.taskId ?? session.taskId ?? session.sessionId,
      sessionId: session.sessionId,
      leaseId: targetLeaseId,
      generation: profile.generation,
      profileInstanceId: profile.profileInstanceId,
      tabId: Number.isSafeInteger(tabId) ? tabId : null,
      pageInstanceId: operationParams.pageInstanceId
        ?? operationParams.locator?.pageInstanceId
        ?? ownedTaskTab?.targetIdentity?.pageInstanceId
        ?? ownedTaskTab?.pageInstanceId,
      windowId: operationParams.windowId ?? ownedTaskTab?.windowId ?? ownedTaskTab?.targetIdentity?.windowId,
      frameId: operationParams.frameId ?? operationParams.locator?.frameId ?? ownedTaskTab?.targetIdentity?.frameId,
      origin: operationParams.origin ?? operationParams.url ?? operationParams.targetOrigin
        ?? params.targetOrigin ?? authority?.targetOrigin,
    });
    const binding = {
      runId: authority?.runId ?? session.runId ?? null,
      profileInstanceId: profile.profileInstanceId,
      generation: profile.generation,
      sessionId: session.sessionId,
      ownerKey: session.sessionId,
      tabId: Number.isSafeInteger(tabId) ? tabId : null,
      method,
      taskId: authority?.taskId ?? session.taskId ?? session.sessionId,
      targetIdentity,
      targetFingerprint: targetIdentityDigest(this.ledgerSecret, targetIdentity),
    };
    const fingerprint = payloadDigest(this.ledgerSecret, { binding, payload: operationParams });
    const navigationTargetDigest = method === "tabs.navigate"
      ? localNavigationTargetDigest(this.ledgerSecret, operationParams.url)
      : null;
    const prepareStartedAt = performance.now();
    if (idempotencyKey) {
      const existing = await this.taskLedger.prepare({ idempotencyKey, fingerprint, binding, navigationTargetDigest });
      if (existing.state !== "prepared") {
        throw new CompanionError("idempotency_duplicate", "This idempotency key has already been dispatched; replay is forbidden", { state: existing.state, operationId: existing.operationId });
      }
    }
    const preparedAt = performance.now();
    const dispatchGuard = () => {
      const currentSession = this.#requireOwnedSession(peer, session.sessionId, {
        allowBuildMismatch: method === "extension.reload",
      });
      if (currentSession !== session || !this.peers.has(peer.id)) throw new CompanionError("session_not_owned", "Original operation session is no longer active");
      if (authority?.expiresAt && Date.parse(authority.expiresAt) <= Date.now()) throw new CompanionError("authority_expired", "Authority expired while the operation was queued");
      validateTarget();
    };
    let attempt = 0;
    const dispatch = async () => {
      const queuedAt = performance.now();
      attempt += 1;
      const trace = this.operationTimingContext.getStore();
      const record = { method, attempt, queue_scope: queueKey.split(":")[0], outcome: "pending", timings_ms: {
        validation: attempt === 1 ? prepareStartedAt - operationStartedAt : 0,
        prepare: attempt === 1 ? preparedAt - prepareStartedAt : 0,
      } };
      const timing = { record, queuedAt, sentAt: null };
      if (trace) {
        if (trace.operations.length < 256) trace.operations.push(record);
        else trace.truncated = true;
      }
      try {
        const result = await this.#enqueue(queueKey, () => this.#sendOperation({
          profile,
          session,
          method,
          params: operationParams,
          timeoutMs,
          authority,
          idempotencyKey,
          binding,
          fingerprint,
          allowedOrigins: params.allowedOrigins ?? operationParams.allowedOrigins ?? null,
          targetOrigin: params.targetOrigin ?? operationParams.targetOrigin ?? authority?.targetOrigin ?? null,
          timing,
          dispatchGuard,
          taskTabContext: method === "tabs.create" && trustedTask ? {
            capsuleId: trustedTask.capsule?.capsuleId ?? null,
            taskId: trustedTask.taskId,
            runId: trustedTask.runId,
            taskLabel: session.label,
            targetKey: trustedTask.capsule?.target?.targetKey ?? null,
            canonicalLocator: trustedTask.capsule?.target?.canonicalLocator ?? null,
            workflowType: trustedTask.capsule?.workflowType ?? "generic",
            lifecycleState: trustedTask.capsule?.state ?? "executing",
            retentionPolicy: trustedTask.capsule?.retention?.policy ?? "cleanup",
            resumeToken: trustedTask.capsule?.resumeToken ?? null,
            userHelpRequired: trustedTask.capsule?.retention?.userHelpRequired === true,
            retentionReason: trustedTask.capsule?.retention?.reason ?? null,
            whyTabWasKept: trustedTask.capsule?.retention?.whyTabWasKept ?? null,
            requiredUserAction: trustedTask.capsule?.retention?.requiredUserAction ?? null,
            resumeAction: trustedTask.capsule?.retention?.resumeAction ?? null,
          } : null,
        }));
        record.outcome = "returned";
        const sourceCleanup = operationParams.sourceOperationId === undefined ? undefined : readSourceCleanup();
        return sourceCleanup ? { ...result, cleanupReceipt: sourceCleanup } : result;
      } catch (error) {
        await this.#recordNotDispatched(idempotencyKey, error);
        record.outcome = "error";
        record.error_code = String(error?.code ?? "operation_failed").slice(0, 100);
        throw error;
      } finally {
        record.timings_ms.total = performance.now() - (attempt === 1 ? operationStartedAt : queuedAt);
      }
    };
    try {
      return await dispatch();
    } catch (error) {
      // Read-only page reads may time out while Chrome is waking a renderer.
      // Re-dispatch exactly once on the same queue/session/lease. Mutations
      // are deliberately excluded so an uncertain external effect is never
      // replayed automatically.
      if (!isReadOnlyRetryable(method, error)) throw error;
      await new Promise((resolve) => setTimeout(resolve, 120));
      return dispatch();
    }
  }

  async #cleanupStaleGenerationTaskTabs(peer, {
    session,
    taskId,
    allowedOrigins,
    authority,
    taskWithCapsule,
    nextMutationIndex,
  }) {
    const result = {
      schema: "aos.chrome_companion.stale_generation_cleanup.v1",
      task_id: taskId,
      profile_instance_id: session.profileInstanceId,
      current_generation: session.generation,
      examined: 0,
      closed: [],
      orphaned: [],
      ledger_only_closed: [],
      missing: [],
      retained: [],
      unknown_effect: [],
      collapse_candidates: [],
      collapsed: [],
      collapse_skipped: [],
      collapse_unknown_effect: [],
    };
    const inventory = await this.#executeOperation(peer, {
      sessionId: session.sessionId,
      method: "tabs.list",
      params: {},
    });
    const liveById = new Map(inventory.map((tab) => [tab.id, tab]));
    const activeGroupIds = new Set(
      inventory
        .filter((tab) => tab?.active === true && Number.isSafeInteger(tab.groupId) && tab.groupId >= 0)
        .map((tab) => tab.groupId),
    );
    const liveSessionIds = new Set(
      [...this.sessions.values()]
        .filter((entry) => entry.profileInstanceId === session.profileInstanceId && entry.generation === session.generation)
        .map((entry) => entry.sessionId),
    );
    const entries = new Map();
    for (const entry of [...this.taskLedger.listTaskTabs(), ...this.taskTabs.values()]) {
      const staleGeneration = entry?.quarantine === "stale_generation"
        && entry.generation !== session.generation;
      const ledgerOnly = isLedgerOnlyTaskTab(entry);
      const retainedReconciliation = !ledgerOnly && entry?.generation === session.generation
        && VISUAL_COLLAPSE_LIFECYCLES.has(entry.lifecycleState)
        && entry.userHelpRequired !== true
        && !entry.resumeToken;
      const detachedTerminal = entry?.generation === session.generation
        && (isLedgerOnlyTaskTab(entry)
          || (entry.retentionPolicy === "cleanup" && TASK_TAB_TERMINAL_LIFECYCLES.has(entry.lifecycleState)))
        && !liveSessionIds.has(entry.sessionId)
        && entry.sessionId !== session.sessionId;
      if (entry?.profileInstanceId !== session.profileInstanceId
        || entry.taskId !== taskId
        || (!staleGeneration && !detachedTerminal && !retainedReconciliation)) continue;
      entries.set(entry.tabId, entry);
    }
    for (const entry of [...entries.values()].sort((left, right) => left.tabId - right.tabId)) {
      result.examined += 1;
      const live = liveById.get(entry.tabId);
      if (!live) {
        result.missing.push(entry.tabId);
        this.taskTabs.delete(this.#tabKey(entry.profileInstanceId, entry.tabId));
        await this.taskLedger.removeTaskTab(entry.profileInstanceId, entry.tabId);
        continue;
      }
      const preserveReasons = [];
      const staleGeneration = entry.quarantine === "stale_generation";
      const ledgerOnly = isLedgerOnlyTaskTab(entry);
      const retainedReconciliation = !ledgerOnly && !staleGeneration && VISUAL_COLLAPSE_LIFECYCLES.has(entry.lifecycleState);
      const detachedTerminal = !staleGeneration && !retainedReconciliation;
      if (live.pinned === true) preserveReasons.push("pinned");
      if (live.active === true) preserveReasons.push("active_tab");
      if (Number.isSafeInteger(live.groupId) && activeGroupIds.has(live.groupId)) preserveReasons.push("active_group_tab");
      if (this.tabLeaseIndex.has(this.#tabKey(entry.profileInstanceId, entry.tabId))) preserveReasons.push("leased");
      if (entry.userHelpRequired === true) preserveReasons.push("user_help_required");
      if (entry.resumeToken) preserveReasons.push("resume_token");
      if (!ledgerOnly && TAB_CLEANUP_PROTECTED_RETENTION.has(entry.retentionPolicy)) preserveReasons.push(`retention:${entry.retentionPolicy}`);
      if (!ledgerOnly && !TASK_TAB_TERMINAL_LIFECYCLES.has(entry.lifecycleState)) preserveReasons.push(`lifecycle:${entry.lifecycleState ?? "unknown"}`);
      let origin = null;
      try { origin = new URL(live.url).origin; } catch { /* browser-internal URLs are never auto-closed */ }
      if (!origin || origin === "null") preserveReasons.push("unsupported_origin");
      if (preserveReasons.length > 0) {
        const retention = taskTabRetentionExplanation(entry, preserveReasons);
        const retained = {
          tab_id: entry.tabId,
          reasons: preserveReasons,
          retention_reason: retention.retentionReason,
          why_tab_was_kept: retention.whyTabWasKept,
          resume_action: retention.resumeAction ?? null,
        };
        if (isVisualCollapseEligibleTaskTab(entry, preserveReasons, origin)) {
          result.collapse_candidates.push(entry.tabId);
          retained.visual_cleanup = "collapse_task_group";
          let collapseLease = null;
          try {
            collapseLease = await this.#acquireLease(peer, { sessionId: session.sessionId, tabId: entry.tabId });
            const visualTask = {
              ...taskWithCapsule,
              index: nextMutationIndex(),
              allowVisualMaintenance: true,
            };
            const grouped = await this.#executeOperation(peer, {
              sessionId: session.sessionId,
              leaseId: collapseLease.leaseId,
              method: "tabs.groupTask",
              taskOwnedRequired: true,
              params: {
                tabId: entry.tabId,
                taskId,
                taskLabel: session.label,
                allowedOrigins: [origin],
                targetOrigin: origin,
                collapsed: true,
                visualOnlyCleanup: true,
              },
            }, { trustedTask: visualTask });
            result.collapsed.push({ tabId: entry.tabId, groupId: grouped.groupId });
          } catch (error) {
            if (error?.code === "operation_effect_unknown") {
              result.collapse_unknown_effect.push({ tabId: entry.tabId, code: error.code });
            } else {
              result.collapse_skipped.push({ tabId: entry.tabId, reason: error?.code ?? "task_group_collapse_failed" });
            }
          } finally {
            if (collapseLease) this.#deleteLease(collapseLease.leaseId);
          }
        }
        result.retained.push(retained);
        continue;
      }
      let lease = null;
      try {
        // The lease is current-generation scoped, while the persisted tab
        // record remains quarantined until the close operation is proven.
        lease = await this.#acquireLease(peer, { sessionId: session.sessionId, tabId: entry.tabId });
        taskWithCapsule.index = nextMutationIndex();
        await this.#executeOperation(peer, {
          sessionId: session.sessionId,
          leaseId: lease.leaseId,
          method: "tabs.close",
          taskOwnedRequired: true,
          params: {
            tabId: entry.tabId,
            allowedOrigins: [origin],
            targetOrigin: origin,
            ...(staleGeneration ? { staleGenerationCleanup: true } : { detachedTerminalCleanup: true }),
          },
        }, { trustedTask: taskWithCapsule });
        result.closed.push(entry.tabId);
        if (detachedTerminal) result.orphaned.push(entry.tabId);
        if (ledgerOnly) result.ledger_only_closed.push(entry.tabId);
      } catch (error) {
        if (error?.code === "operation_effect_unknown") {
          result.unknown_effect.push({ tab_id: entry.tabId, code: error.code, ledger_only: ledgerOnly });
          if (ledgerOnly) {
            // Closing a browser tab is independent from the provider-side
            // operation.  Do not let an uncertain close response keep the
            // task blocked forever; retain the close evidence in the ledger
            // and drop only this tab's resumability record.
            this.taskTabs.delete(this.#tabKey(entry.profileInstanceId, entry.tabId));
            await this.taskLedger.removeTaskTab(entry.profileInstanceId, entry.tabId);
          }
        } else {
          result.retained.push({
            tab_id: entry.tabId,
            reasons: [error?.code ?? "stale_generation_cleanup_failed"],
            retention_reason: "stale_generation_quarantine",
            why_tab_was_kept: "The previous profile generation could not be closed with a current owner; it remains quarantined for explicit reconciliation.",
            resume_action: "signed_task_status_readback_then_cleanup_task_owned_tab",
          });
        }
      } finally {
        if (lease) this.#deleteLease(lease.leaseId);
      }
    }
    return result;
  }

  async #inspectDropdownWithVisual(peer, params) {
    const session = this.#requireOwnedSession(peer, params.sessionId);
    const tabId = requireTabId(params.tabId);
    const leaseId = requireString(params.leaseId, "leaseId");
    const lease = this.leases.get(leaseId);
    if (!lease
      || lease.sessionId !== session.sessionId
      || lease.tabId !== tabId
      || lease.generation !== session.generation) {
      throw new CompanionError("exact_tab_lease_required", "Dropdown inspection requires this session's exact-tab lease");
    }
    const locator = requireObject(params.locator, "locator");
    const inspection = await this.#executeOperation(peer, {
      sessionId: session.sessionId,
      leaseId,
      method: "page.inspectDropdown",
      params: { tabId, locator },
    });
    const visual = await this.#executeOperation(peer, {
      sessionId: session.sessionId,
      leaseId,
      method: "page.screenshot",
      params: { tabId, restoreActive: true },
      timeoutMs: 30_000,
    });
    if (visual?.kind !== "screenshot"
      || !visual.dataBase64
      || visual.tabId !== tabId
      || ((inspection?.frameId ?? 0) === 0 && String(visual.url || "") !== String(inspection?.url || ""))) {
      throw new CompanionError(
        "dropdown_visual_semantic_mismatch",
        "Dropdown semantic inspection and screenshot did not identify the same exact tab and page",
      );
    }
    const capturedAtCandidate = String(visual.capturedAt || "");
    const capturedAt = Number.isFinite(Date.parse(capturedAtCandidate)) ? capturedAtCandidate : nowIso();
    const expiresAt = new Date(Date.parse(capturedAt) + 5 * 60_000).toISOString();
    const proofPayload = {
      schema: "aos.chrome_companion.dropdown_visual_proof.v1",
      sessionId: session.sessionId,
      leaseId,
      taskId: session.taskId ?? null,
      profileInstanceId: session.profileInstanceId,
      generation: session.generation,
      tabId,
      pageUrl: String(visual.url || ""),
      targetFrameId: inspection?.frameId ?? 0,
      targetFrameUrl: String(inspection?.url || ""),
      targetFramePageInstanceId: inspection?.pageInstanceId ?? null,
      locator,
      locatorDigest: payloadDigest(this.ledgerSecret, locator),
      pageInstanceId: inspection.pageInstanceId ?? null,
      screenshotDigest: payloadDigest(this.ledgerSecret, visual.dataBase64),
      supported: inspection?.supported === true,
      capturedAt,
      expiresAt,
    };
    return {
      ...inspection,
      dropdownKind: inspection?.kind ?? null,
      kind: "dropdown_visual_confirmation",
      visual,
      visualProof: {
        ...proofPayload,
        signature: payloadDigest(this.ledgerSecret, proofPayload),
      },
      visual_readback_verified: true,
      external_action_executed: false,
      mutation_dispatch_attempted: false,
      mutation_dispatch_count: 0,
      operation_effect_state: "none",
      reconciliation_required: false,
    };
  }

  #verifyDropdownVisualProof({ proof, session, lease, tabId, locator, currentUrl }) {
    if (!proof || typeof proof !== "object" || Array.isArray(proof)) {
      throw new CompanionError("dropdown_visual_proof_required", "page.selectOption requires a fresh Companion dropdown visual proof");
    }
    const { signature, ...payload } = proof;
    const validSignature = typeof signature === "string"
      && secureEqual(signature, payloadDigest(this.ledgerSecret, payload));
    const expiresAt = Date.parse(String(payload.expiresAt || ""));
    if (payload.schema !== "aos.chrome_companion.dropdown_visual_proof.v1"
      || !validSignature
      || payload.supported !== true
      || payload.sessionId !== session.sessionId
      || payload.leaseId !== lease.leaseId
      || payload.taskId !== (session.taskId ?? null)
      || payload.profileInstanceId !== session.profileInstanceId
      || payload.generation !== session.generation
      || payload.tabId !== tabId
      || payload.pageUrl !== String(currentUrl || "")
      || payload.targetFrameId !== (Number.isSafeInteger(locator?.frameId) ? locator.frameId : 0)
      || typeof payload.targetFrameUrl !== "string"
      || !payload.targetFrameUrl
      || payload.locatorDigest !== payloadDigest(this.ledgerSecret, requireObject(locator, "locator"))
      || !Number.isFinite(expiresAt)
      || expiresAt <= Date.now()) {
      throw new CompanionError("dropdown_visual_proof_invalid", "Dropdown visual proof is stale or does not match the exact session, lease, tab, generation, page, and locator");
    }
    return true;
  }

  async #inspectVisualPoint(peer, params) {
    const session = this.#requireOwnedSession(peer, params.sessionId);
    const tabId = requireTabId(params.tabId);
    const leaseId = requireString(params.leaseId, "leaseId");
    const lease = this.leases.get(leaseId);
    if (!lease
      || lease.sessionId !== session.sessionId
      || lease.tabId !== tabId
      || lease.generation !== session.generation) {
      throw new CompanionError("exact_tab_lease_required", "Visual point inspection requires this session's exact-tab lease");
    }
    const point = requireObject(params.point, "point");
    const inspection = await this.#executeOperation(peer, {
      sessionId: session.sessionId,
      leaseId,
      method: "visual.inspectPoint",
      params: { tabId, point },
    });
    if (inspection?.supported !== true) {
      throw new CompanionError(
        inspection?.exact_blocker ?? "visual_point_unsupported",
        inspection?.message ?? "The visual point is not a supported top-level page coordinate",
        { operationEffectState: "none", mutationDispatchAttempted: false },
      );
    }
    const visual = await this.#executeOperation(peer, {
      sessionId: session.sessionId,
      leaseId,
      method: "page.screenshot",
      params: { tabId, restoreActive: true },
      timeoutMs: 30_000,
    });
    if (visual?.kind !== "screenshot"
      || !visual.dataBase64
      || visual.tabId !== tabId
      || String(visual.url || "") !== String(inspection?.url || "")) {
      throw new CompanionError("visual_point_readback_mismatch", "Visual point inspection and screenshot did not identify the same exact tab and page");
    }
    const capturedAtCandidate = String(visual.capturedAt || "");
    const capturedAt = Number.isFinite(Date.parse(capturedAtCandidate)) ? capturedAtCandidate : nowIso();
    const expiresAt = new Date(Date.parse(capturedAt) + 60_000).toISOString();
    const proofPayload = {
      schema: "aos.chrome_companion.visual_point_proof.v1",
      // The control under the point, so a click can follow it when the feed moves a little.
      elementRef: typeof inspection.elementRef === "string" ? inspection.elementRef : null,
      hitElement: visualIdentity(inspection.hitElement),
      canvasPatch: await readCanvasVisualPatch({ inspection, secret: this.ledgerSecret,
        capture: options => this.#executeOperation(peer, { sessionId: session.sessionId, leaseId,
          method: "page.screenshot", params: { tabId, ...options } }) }),
      sessionId: session.sessionId,
      leaseId,
      taskId: session.taskId ?? null,
      profileInstanceId: session.profileInstanceId,
      generation: session.generation,
      tabId,
      pageUrl: String(inspection.url || ""),
      pageInstanceId: inspection.pageInstanceId ?? null,
      point: inspection.point,
      scroll: inspection.scroll ?? null,
      viewport: inspection.viewport,
      screenshotDigest: payloadDigest(this.ledgerSecret, visual.dataBase64),
      capturedAt,
      expiresAt,
    };
    return {
      kind: "visual_point_confirmation",
      target: inspection,
      visual,
      visualProof: { ...proofPayload, signature: payloadDigest(this.ledgerSecret, proofPayload) },
      visual_readback_verified: true,
      external_action_executed: false,
      mutation_dispatch_attempted: false,
      mutation_dispatch_count: 0,
      operation_effect_state: "none",
      reconciliation_required: false,
    };
  }

  async #inspectVisualTarget(peer, params) {
    const session = this.#requireOwnedSession(peer, params.sessionId);
    const tabId = requireTabId(params.tabId);
    const leaseId = requireString(params.leaseId, "leaseId");
    const lease = this.leases.get(leaseId);
    if (!lease
      || lease.sessionId !== session.sessionId
      || lease.tabId !== tabId
      || lease.generation !== session.generation) {
      throw new CompanionError("exact_tab_lease_required", "Visual target inspection requires this session's exact-tab lease");
    }
    const locator = requireObject(params.locator, "locator");
    let inspection = await this.#executeOperation(peer, {
      sessionId: session.sessionId,
      leaseId,
      method: "visual.inspectTarget",
      params: { tabId, locator },
    });
    const approvedPageUrl = String(inspection?.topLevelUrl || inspection?.url || "");
    const approvedPageInstanceId = inspection?.pageInstanceId ?? null;
    const approvedFrameId = inspection?.frameId ?? 0;
    const approvedFramePath = JSON.stringify(inspection?.framePath ?? []);
    let visual, settled = false;
    // Capture temporarily activates a hidden tab and can change its viewport
    // or clamp an inner scroll container. Never sign pre-capture coordinates
    // against the later image. Allow one bounded read-only recapture after
    // such a same-document layout change; navigation is never a retry.
    for (let attempt = 0; attempt < 2; attempt += 1) {
      visual = await this.#executeOperation(peer, {
        sessionId: session.sessionId, leaseId, method: "page.screenshot",
        params: { tabId, restoreActive: true }, timeoutMs: 30_000,
      });
      const current = await this.#executeOperation(peer, {
        sessionId: session.sessionId, leaseId, method: "visual.inspectTarget",
        params: { tabId, locator, scroll: false,
          ...(typeof inspection?.elementRef === "string" ? { elementRef: inspection.elementRef } : {}) },
      });
      if (visual?.kind !== "screenshot" || !visual.dataBase64 || visual.tabId !== tabId
        || String(visual.url || "") !== approvedPageUrl
        || String(current?.topLevelUrl || current?.url || "") !== approvedPageUrl
        || (current?.pageInstanceId ?? null) !== approvedPageInstanceId
        || (current?.frameId ?? 0) !== approvedFrameId
        || JSON.stringify(current?.framePath ?? []) !== approvedFramePath) {
        throw new CompanionError("visual_target_readback_mismatch", "The target document or frame changed during screenshot capture");
      }
      const samePoint = ["x", "y"].every(key => Number(current?.point?.[key]) === Number(inspection?.point?.[key]));
      const sameRect = ["x", "y", "width", "height"].every(key => Number(current?.clippedRect?.[key]) === Number(inspection?.clippedRect?.[key]));
      const sameViewport = ["width", "height", "devicePixelRatio"].every(key => Number(current?.viewport?.[key]) === Number(inspection?.viewport?.[key]))
        && Number(current?.viewport?.scale ?? 1) === Number(inspection?.viewport?.scale ?? 1);
      const sameScroll = ["x", "y"].every(key => Number(current?.scroll?.[key] ?? 0) === Number(inspection?.scroll?.[key] ?? 0));
      const sameSpace = String(current?.coordinateSpace ?? "viewport") === String(inspection?.coordinateSpace ?? "viewport");
      inspection = current;
      if (samePoint && sameRect && sameViewport && sameScroll && sameSpace) { settled = true; break; }
    }
    if (!settled) {
      throw new CompanionError("visual_target_readback_mismatch", "The target geometry did not settle across the bounded screenshot readback", {
        mutationDispatchAttempted: false, operationEffectState: "none",
      });
    }
    const visualPageUrl = approvedPageUrl;
    const capturedAtCandidate = String(visual.capturedAt || "");
    const capturedAt = Number.isFinite(Date.parse(capturedAtCandidate)) ? capturedAtCandidate : nowIso();
    const expiresAt = new Date(Date.parse(capturedAt) + VISUAL_PROOF_TTL_MS).toISOString();
    const proofPayload = {
      schema: "aos.chrome_companion.visual_target_proof.v1",
      // Which element this is, so a click can find the same one after the page moved.
      element: visualIdentity(inspection.element),
      elementRef: typeof inspection.elementRef === "string" ? inspection.elementRef : null,
      sessionId: session.sessionId,
      leaseId,
      taskId: session.taskId ?? null,
      profileInstanceId: session.profileInstanceId,
      generation: session.generation,
      tabId,
      frameId: Number.isSafeInteger(inspection?.frameId) ? inspection.frameId : (Number.isSafeInteger(locator?.frameId) ? locator.frameId : 0),
      pageUrl: visualPageUrl,
      pageInstanceId: inspection.pageInstanceId ?? null,
      locator,
      locatorDigest: payloadDigest(this.ledgerSecret, locator),
      screenshotDigest: payloadDigest(this.ledgerSecret, visual.dataBase64),
      point: inspection.point,
      scroll: inspection.scroll ?? null,
      rect: inspection.clippedRect,
      viewport: inspection.viewport,
      coordinateSpace: inspection.coordinateSpace ?? "viewport",
      framePath: Array.isArray(inspection.framePath) ? inspection.framePath : [],
      capturedAt,
      expiresAt,
    };
    return {
      kind: "visual_target_confirmation",
      target: inspection,
      visual,
      visualProof: { ...proofPayload, signature: payloadDigest(this.ledgerSecret, proofPayload) },
      visual_readback_verified: true,
      external_action_executed: false,
      mutation_dispatch_attempted: false,
      mutation_dispatch_count: 0,
      operation_effect_state: "none",
      reconciliation_required: false,
    };
  }

  #verifyVisualTargetProof({ proof, session, lease, tabId, currentUrl, currentPageInstanceId = null, consume = true }) {
    if (!proof || typeof proof !== "object" || Array.isArray(proof)) {
      throw new CompanionError("visual_target_proof_required", "Trusted visual input requires a fresh screenshot-bound target proof");
    }
    const { signature, ...payload } = proof;
    const validSignature = typeof signature === "string"
      && secureEqual(signature, payloadDigest(this.ledgerSecret, payload));
    const expiresAt = Date.parse(String(payload.expiresAt || ""));
    const point = payload.point;
    const viewport = payload.viewport;
    const scroll = payload.scroll;
    const locator = payload.locator;
    const pointProof = payload.schema === "aos.chrome_companion.visual_point_proof.v1";
    const targetProof = payload.schema === "aos.chrome_companion.visual_target_proof.v1";
    const locatorValid = locator && typeof locator === "object" && !Array.isArray(locator)
      && payload.locatorDigest === payloadDigest(this.ledgerSecret, locator);
    const pointValid = Number.isFinite(Number(point?.x))
      && Number.isFinite(Number(point?.y))
      && Number(point.x) >= 0
      && Number(point.y) >= 0
      && Number(point.x) <= Number(viewport?.width)
      && Number(point.y) <= Number(viewport?.height);
    const scrollValid = scroll === undefined || scroll === null
      || (Number.isFinite(Number(scroll.x)) && Number.isFinite(Number(scroll.y)));
    const pointScrollValid = !pointProof
      || (scroll && Number.isFinite(Number(scroll.x)) && Number.isFinite(Number(scroll.y)));
    const consumed = typeof signature === "string" && this.consumedVisualProofs.has(signature);
    if ((!pointProof && !targetProof)
      || !validSignature
      || consumed
      || payload.sessionId !== session.sessionId
      || payload.leaseId !== lease.leaseId
      || payload.taskId !== (session.taskId ?? null)
      || payload.profileInstanceId !== session.profileInstanceId
      || payload.generation !== session.generation
      || payload.tabId !== tabId
      || payload.pageUrl !== String(currentUrl || "")
      || (payload.pageInstanceId !== undefined && payload.pageInstanceId !== null
        && payload.pageInstanceId !== currentPageInstanceId)
      || (targetProof && !locatorValid)
      || (pointProof && (locator !== undefined || payload.locatorDigest !== undefined))
      || !pointValid
      || !scrollValid
      || !pointScrollValid
      || (targetProof && payload.coordinateSpace !== "top-level-viewport" && (payload.frameId ?? 0) !== 0)
      || (targetProof && !Array.isArray(payload.framePath))
      || !Number.isFinite(expiresAt)
      || expiresAt <= Date.now()) {
      throw new CompanionError("visual_target_proof_invalid", "Visual target proof is stale, consumed, or does not match the exact session, lease, tab, generation, page, and viewport");
    }
    if (consume) this.#consumeVisualTargetProof({ signature, expiresAt });
    return {
      signature,
      expiresAt,
      element: targetProof ? visualIdentity(payload.element) : null,
      hitElement: pointProof ? visualIdentity(payload.hitElement) : null,
      elementRef: typeof payload.elementRef === "string" ? payload.elementRef : null,
      kind: pointProof ? "point" : "target",
      point: { x: Number(point.x), y: Number(point.y) },
      rect: payload.rect,
      viewport,
      scroll: scroll ?? null,
      locator: pointProof ? null : locator,
      pageInstanceId: payload.pageInstanceId ?? null,
      frameId: Number.isSafeInteger(payload.frameId) ? payload.frameId : 0,
      coordinateSpace: payload.coordinateSpace ?? "viewport",
      framePath: Array.isArray(payload.framePath) ? payload.framePath : [],
      canvasPatch: pointProof ? payload.canvasPatch ?? null : null,
    };
  }

  // A proof is spent once its input passes the checks before dispatch, not when a check before
  // any input stops it: a run may retry the same proof after the page settles (2026-10-19).
  #consumeVisualTargetProof({ signature, expiresAt }) {
    if (typeof signature !== "string" || this.consumedVisualProofs.has(signature)) {
      throw new CompanionError("visual_target_proof_invalid", "Visual target proof is stale, consumed, or does not match the exact session, lease, tab, generation, page, and viewport");
    }
    this.consumedVisualProofs.set(signature, expiresAt);
    for (const [key, expiry] of this.consumedVisualProofs) if (expiry <= Date.now()) this.consumedVisualProofs.delete(key);
  }

  // allowMovedTarget (visual.click and visual.doubleClick only, never canvas): the target may have
  // moved or the viewport changed size, as long as the same element is still there on the same
  // page; the click then uses the element's current position. The Extension checks the same again
  // after bringing the tab to the front, right before the mouse input.
  async #revalidateVisualTargetProof(peer, { session, lease, tabId, verified, currentUrl, allowMovedTarget = false }) {
    if (verified?.kind === "point") {
      const snapshot = await this.#executeOperation(peer, {
        sessionId: session.sessionId,
        leaseId: lease.leaseId,
        method: "page.snapshot",
        params: { tabId, maxTextChars: 1_000 },
      });
      const followElement = allowMovedTarget && !verified.canvasPatch && Boolean(verified.elementRef || verified.hitElement);
      const inspection = await this.#executeOperation(peer, {
        sessionId: session.sessionId,
        leaseId: lease.leaseId,
        method: "visual.inspectPoint",
        params: { tabId, point: verified.point,
          ...(followElement ? { elementRef: verified.elementRef ?? null, allowShift: true } : {}) },
      });
      const samePageNow = String(snapshot?.url || "") === String(currentUrl || "")
        && String(inspection?.url || "") === String(currentUrl || "")
        && (verified.pageInstanceId === null || inspection?.pageInstanceId === verified.pageInstanceId);
      // An Extension that does not report the element yet keeps the exact-geometry check below.
      if (followElement && inspection?.surfaceKind !== "canvas"
        && (inspection?.elementRefMatched !== undefined || inspection?.hitElement)) {
        const sameElement = inspection?.elementRefMatched === true
          || (inspection?.elementRefMatched !== false && sameVisualIdentity(inspection?.hitElement, verified.hitElement));
        if (inspection?.supported === false || !samePageNow || !sameElement) {
          throw new CompanionError("visual_target_proof_stale_geometry", "The screenshot-bound visual point no longer lies on the same element of the approved page");
        }
        return { point: { x: Number(inspection.point.x), y: Number(inspection.point.y) },
          viewport: inspection.viewport ?? verified.viewport, scroll: inspection.scroll ?? verified.scroll,
          moved: Number(inspection.point.x) !== Number(verified.point.x) || Number(inspection.point.y) !== Number(verified.point.y) };
      }
      const samePoint = Number(inspection?.point?.x) === Number(verified.point?.x)
        && Number(inspection?.point?.y) === Number(verified.point?.y);
      const sameViewport = Number(inspection?.viewport?.width) === Number(verified.viewport?.width)
        && Number(inspection?.viewport?.height) === Number(verified.viewport?.height)
        && Number(inspection?.viewport?.devicePixelRatio) === Number(verified.viewport?.devicePixelRatio)
        && Number(inspection?.viewport?.scale ?? 1) === Number(verified.viewport?.scale ?? 1);
      const sameScroll = !verified.scroll
        || (Number(inspection?.scroll?.x) === Number(verified.scroll?.x)
          && Number(inspection?.scroll?.y) === Number(verified.scroll?.y));
      const samePage = String(snapshot?.url || "") === String(currentUrl || "")
        && String(inspection?.url || "") === String(currentUrl || "")
        && (verified.pageInstanceId === null || inspection?.pageInstanceId === verified.pageInstanceId);
      if (!samePage || !samePoint || !sameViewport || !sameScroll) {
        throw new CompanionError("visual_target_proof_stale_geometry", "The screenshot-bound visual point moved, resized, or left the approved page before trusted input dispatch");
      }
      const canvasPatch = await readCanvasVisualPatch({ inspection, secret: this.ledgerSecret,
        capture: options => this.#executeOperation(peer, { sessionId: session.sessionId, leaseId: lease.leaseId,
          method: "page.screenshot", params: { tabId, ...options } }) });
      assertCanvasVisualPatchUnchanged(verified.canvasPatch, canvasPatch);
      return true;
    }
    const followElement = allowMovedTarget && Boolean(verified.elementRef || verified.element);
    const inspection = await this.#executeOperation(peer, {
      sessionId: session.sessionId,
      leaseId: lease.leaseId,
      method: "visual.inspectTarget",
      params: { tabId, locator: verified.locator, scroll: false,
        ...(followElement ? { elementRef: verified.elementRef ?? null } : {}) },
    });
    if (followElement && (inspection?.elementRefMatched !== undefined || inspection?.elementRef)) {
      const inspectionUrl = String(inspection?.topLevelUrl || inspection?.url || "");
      const samePageNow = inspectionUrl === String(currentUrl || "")
        && (verified.pageInstanceId === null || inspection?.pageInstanceId === verified.pageInstanceId);
      const sameFrameNow = String(inspection?.coordinateSpace || "viewport") === String(verified?.coordinateSpace || "viewport")
        && JSON.stringify(inspection?.framePath || []) === JSON.stringify(verified?.framePath || []);
      // The remembered DOM object, or else one element found without choosing among several,
      // with the same tag, role, name and test id.
      const sameElement = inspection?.elementRefMatched === true
        || (inspection?.elementRefMatched !== false && sameVisualIdentity(inspection?.element, verified.element)
          && !inspection?.targetChoice?.disambiguatedBy);
      const pointNow = inspection?.point;
      const pointInViewport = Number.isFinite(Number(pointNow?.x)) && Number.isFinite(Number(pointNow?.y))
        && Number(pointNow.x) >= 0 && Number(pointNow.y) >= 0
        && Number(pointNow.x) <= Number(inspection?.viewport?.width) && Number(pointNow.y) <= Number(inspection?.viewport?.height);
      if (inspection?.supported === false || !samePageNow || !sameFrameNow || !sameElement || !pointInViewport) {
        throw new CompanionError("visual_target_proof_stale_geometry", "The screenshot-bound target is no longer the same visible element of the approved page", {
          mismatches: Object.entries({ supported: inspection?.supported !== false, samePage: samePageNow, sameFrame: sameFrameNow, sameElement, pointInViewport })
            .filter(([, matched]) => !matched).map(([key]) => key),
        });
      }
      return { point: { x: Number(pointNow.x), y: Number(pointNow.y) }, rect: inspection.clippedRect ?? verified.rect,
        viewport: inspection.viewport ?? verified.viewport, scroll: inspection.scroll ?? verified.scroll,
        moved: Number(pointNow.x) !== Number(verified.point?.x) || Number(pointNow.y) !== Number(verified.point?.y) };
    }
    const samePoint = Number(inspection?.point?.x) === Number(verified.point?.x)
      && Number(inspection?.point?.y) === Number(verified.point?.y);
    const sameViewport = Number(inspection?.viewport?.width) === Number(verified.viewport?.width)
      && Number(inspection?.viewport?.height) === Number(verified.viewport?.height)
      && Number(inspection?.viewport?.devicePixelRatio) === Number(verified.viewport?.devicePixelRatio)
      && Number(inspection?.viewport?.scale ?? 1) === Number(verified.viewport?.scale ?? 1);
    const sameRect = ["x", "y", "width", "height"].every((field) => Number(inspection?.clippedRect?.[field]) === Number(verified.rect?.[field]));
    const samePageInstance = verified.pageInstanceId === null || inspection?.pageInstanceId === verified.pageInstanceId;
    const sameScroll = !verified.scroll
      || (Number(inspection?.scroll?.x) === Number(verified.scroll?.x)
        && Number(inspection?.scroll?.y) === Number(verified.scroll?.y));
    const inspectionPageUrl = String(inspection?.topLevelUrl || inspection?.url || "");
    const sameCoordinateSpace = String(inspection?.coordinateSpace || "viewport") === String(verified?.coordinateSpace || "viewport");
    const sameFramePath = JSON.stringify(inspection?.framePath || []) === JSON.stringify(verified?.framePath || []);
    if (inspectionPageUrl !== String(currentUrl || "") || !samePageInstance || !samePoint || !sameViewport || !sameRect || !sameScroll || !sameCoordinateSpace || !sameFramePath) {
      throw new CompanionError("visual_target_proof_stale_geometry", "The screenshot-bound target moved, resized, or left the approved viewport before trusted input dispatch");
    }
    return true;
  }

  async #bindSemanticInspectionToDocument(peer, {
    sessionId,
    leaseId,
    tabId,
    locator,
    inspection,
    approvedDocument,
  }) {
    // Some installed Companion generations can return a valid visual target
    // without the renderer pageInstanceId. Do not weaken the page binding or
    // accept the missing value: recover it only from a same-lease snapshot and
    // require that the snapshot still identifies the approved frame, URL, and
    // page instance. A nested frame must prove its own page instance as well.
    if (inspection?.pageInstanceId != null || approvedDocument?.pageInstanceId == null) return inspection;
    const currentSnapshot = await this.#executeOperation(peer, {
      sessionId,
      leaseId,
      method: "page.snapshot",
      params: { tabId, maxTextChars: 30_000 },
    });
    const currentDocument = snapshotTargetDocument(currentSnapshot, locator);
    if (!currentDocument
      || currentDocument.frameId !== approvedDocument.frameId
      || String(currentDocument.url || "") !== String(approvedDocument.url || "")
      || currentDocument.pageInstanceId !== approvedDocument.pageInstanceId) {
      throw new CompanionError(
        "transaction_action_target_page_mismatch",
        "A semantic action target did not retain the approved document instance while its visual inspection identifier was missing",
        { frameId: locator?.frameId ?? 0 },
      );
    }
    return { ...inspection, pageInstanceId: currentDocument.pageInstanceId };
  }

  #findPendingDialogTrigger(session, runId, tabId, response, entries) {
    const entry = entries.find(value => value.tabId === tabId && value.profileInstanceId === session.profileInstanceId);
    const capsule = entry?.capsuleId ? this.taskLedger.getTaskCapsule(entry.capsuleId) : null;
    const event = capsule?.effect?.awaitedEvent;
    if (capsule?.blocker?.code !== "action_event_pending" || event?.kind !== "dialog") return null;
    const operation = this.taskLedger.get(event.idempotencyKey);
    const binding = operation?.binding;
    if (!operation || operation.awaitedEvent?.dialogId !== event.dialogId || operation.operationId !== event.operationId
      || binding?.taskId !== session.taskId || binding.runId !== runId || binding.sessionId !== session.sessionId
      || binding.profileInstanceId !== session.profileInstanceId || binding.generation !== session.generation
      || binding.tabId !== tabId || entry.generation !== session.generation
      || capsule.taskId !== session.taskId || capsule.runId !== runId) {
      throw new CompanionError("action_event_continuation_binding_mismatch", "Continue a pending dialog in its original exact tab, session and run", { operationEffectState: "none", mutationDispatchAttempted: false });
    }
    if (event.requiresUser === true || event.messageExactAvailable !== true) throw new CompanionError("sensitive_dialog_user_required", "This observed dialog requires user handling", { operationEffectState: "none", mutationDispatchAttempted: false });
    if (response?.expectedDialogId !== event.dialogId || response.expectedMessage !== event.message
      || (response.expectedType !== undefined && response.expectedType !== event.type)) {
      throw new CompanionError("javascript_dialog_identity_mismatch", "The response must name the exact pre-armed opening and message", { operationEffectState: "none", mutationDispatchAttempted: false });
    }
    return { entry, capsule, event };
  }

  async #readBackDialogTrigger(continuation, after, response, nextDialog) {
    const { capsule, event } = continuation;
    const base = { capsule_id: capsule.capsuleId, run_id: capsule.runId, operation_id: event.operationId,
      idempotency_key: event.idempotencyKey, trigger_replayed: false, provider_receipt_verified: false };
    if (response?.closedVerified !== true || nextDialog?.present === true) return { ...base, state: "awaiting_dialog", exact_blocker: "next_dialog_pending" };
    // Wait for the original command acknowledgement; no browser command is
    // repeated here. Its arrival can race the separately signed close result.
    const deadline = Date.now() + 5000;
    let operation;
    do {
      operation = this.taskLedger.get(event.idempotencyKey);
      if (["applied", "reconciled", "blocked"].includes(operation?.state)) break;
      await new Promise(resolve => setTimeout(resolve, 20));
    } while (Date.now() < deadline);
    if (!["applied", "reconciled"].includes(operation?.state) || operationEffectStateForEntry(operation) !== "known_effect") {
      return { ...base, state: "unknown_effect", exact_blocker: "trigger_result_not_confirmed", same_target_readback_required: true };
    }
    const current = this.taskLedger.getTaskCapsule(capsule.capsuleId);
    const previous = current.effect?.actionProgress;
    const index = previous?.failed_action_index;
    if (!Number.isSafeInteger(index) || current.effect?.awaitedEvent?.operationId !== operation.operationId) {
      return { ...base, state: "unknown_effect", exact_blocker: "trigger_progress_binding_mismatch" };
    }
    const progress = { ...previous,
      applied_action_indices: [...new Set([...(previous.applied_action_indices ?? []), index])].sort((a, b) => a - b),
      verified_action_indices: [...new Set([...(previous.verified_action_indices ?? []), index])].sort((a, b) => a - b),
      uncertain_action_indices: (previous.uncertain_action_indices ?? []).filter(value => value !== index),
      failed_action_index: null, failed_action_effect_state: "known_effect", fresh_target_readback_required: true, replay_allowed: false,
    };
    const hasRemaining = progress.remaining_action_indices.length > 0;
    const readback = { kind: "dialog_trigger_browser_readback", operationId: operation.operationId,
      dialogId: event.dialogId, closedVerified: true, url: after.url, pageInstanceId: after.pageInstanceId,
      textSha256: createHash("sha256").update(String(after.text ?? ""), "utf8").digest("hex"),
      capturedAt: nowIso(), providerReceiptVerified: false };
    const updated = await this.taskLedger.transitionTaskCapsule(current.capsuleId, hasRemaining ? "failed" : "completed", {
      blocker: hasRemaining ? { code: "partial_actions_applied_readback_required", message: "The dialog trigger is confirmed; continue only the unattempted actions" } : null,
      restartPoint: hasRemaining ? "read_back_same_target_then_continue_remaining_actions" : null,
      completion: { ...current.completion, reconciliation: readback },
      effect: { ...current.effect, effectState: "known_effect", externalActionExecuted: true, reconciliationRequired: false, actionProgress: progress,
        awaitedEvent: { ...event, closedVerified: true, triggerResultVerified: true } },
    });
    return { ...base, state: "readback_verified", capsule_state: updated.state, action_progress: progress, readback };
  }

  async #executeProfileGlobalTransaction(peer, {
    session,
    taskId,
    runId,
    rawAllowedOrigins,
    allowedOrigins,
    actions,
    steps,
    authority,
    initialUrl,
    params,
  }) {
    // Profile-global task actions such as native recording must not create a
    // disposable target tab just to satisfy the generic page transaction
    // path.  In particular, stop must remain callable after that tab has
    // disappeared.  The signed authority and per-step operation ledger still
    // provide the same ownership, idempotency, queue, and no-replay boundary.
    const capsuleInput = params.capsule ?? params.taskExecutionCapsule ?? null;
    const capsule = normalizeTaskExecutionCapsule(capsuleInput ?? {}, {
      taskId,
      runId,
      startUrl: initialUrl,
      targetOrigin: authority?.targetOrigin ?? params.targetOrigin,
      allowedOrigins: rawAllowedOrigins,
      profileInstanceId: session.profileInstanceId,
      generation: session.generation,
      sessionId: session.sessionId,
      idempotencyKey: authority?.idempotencyKey,
      workflowType: "profile_global",
      retentionPolicy: "cleanup",
      resourceClass: "profile_global",
    });
    const taskWithCapsule = {
      authority,
      runId,
      taskId,
      idempotencyKey: authority?.idempotencyKey ?? "authority-unavailable",
      index: 0,
      capsule,
      allowDirectApplication: false,
    };
    const snapshot = {
      schema: "aos_chrome_companion.transaction.v1",
      result: "running",
      execution_surface: "aos_chrome_companion_profile_instance",
      run_id: runId,
      task_id: taskId,
      profile: { profileInstanceId: session.profileInstanceId, generation: session.generation },
      tab: null,
      actions: [],
      step_packets: steps.map(step => ({
        schema: step.schema,
        index: step.index,
        method: step.method,
        authorized: step.authorized,
        mutation: step.mutation,
        target_scoped: false,
        profile_global: step.profileGlobal,
        effect_class: step.effectClass,
        reconciliation_required: step.reconciliationRequired,
      })),
      external_action_executed: false,
      effect_state: "no_dispatch",
      dispatch_count: 0,
      cleanup: { closed: true, retained: false, tabless: true },
      exact_blocker: null,
    };
    const capsuleId = capsule.capsuleId;
    try {
      await this.taskLedger.putTaskCapsule(capsule);
      await this.taskLedger.transitionTaskCapsule(capsuleId, "admitted", { effect: { ...capsule.effect, idempotencyKey: authority?.idempotencyKey ?? null } });
      await this.taskLedger.verifyAndConsumeAuthority(authority, {
        secrets: this.issuerSecrets,
        payload: authorizedTransactionPayload({
          ...(params.tabId === undefined ? {} : { tabId: params.tabId }),
          startUrl: initialUrl,
          allowedOrigins: rawAllowedOrigins,
          actions,
          // Verify the exact caller projection.  Profile-global operations do
          // not create or retain a tab, but those lifecycle flags are still
          // part of the signed transaction payload and must not be rewritten
          // on the broker side.
          reuseTaskTab: params.reuseTaskTab !== false,
          keepTaskTab: params.keepTaskTab === undefined ? null : params.keepTaskTab === true,
          readbackMaxTextChars: params.readbackMaxTextChars,
          retainOnUnknown: params.retainOnUnknown === true,
          precondition: params.precondition ?? null,
          capsule: capsuleInput ?? null,
        }),
        expected: { runId, taskId, ownerKey: session.sessionId, method: "task.transaction", intent: params.intent ?? "authorized_transaction" },
      });
      await this.taskLedger.transitionTaskCapsule(capsuleId, "target_bound", {
        target: { ...capsule.target, profileInstanceId: session.profileInstanceId, generation: session.generation },
        resources: { ...capsule.resources, exactTabLeaseId: null, tabId: null, resourceClass: "profile_global" },
      });
      await this.taskLedger.transitionTaskCapsule(capsuleId, "pre_read", { target: { ...capsule.target, tabId: null, leaseId: null }, visual: { required: false, proof: null } });
      await this.taskLedger.transitionTaskCapsule(capsuleId, "executing");
      for (const step of steps) {
        const index = step.index;
        taskWithCapsule.index = index;
        const actionStartedAt = performance.now();
        const result = await this.#executeOperation(peer, {
          sessionId: session.sessionId,
          method: step.method,
          params: { ...step.params },
          allowedOrigins,
          targetOrigin: authority?.targetOrigin ?? params.targetOrigin ?? null,
        }, { trustedTask: taskWithCapsule });
        snapshot.actions.push({
          timings_ms: { total_before_receipt: performance.now() - actionStartedAt },
          index,
          method: step.method,
          step_packet: bindTransactionStep(step, {
            secret: this.ledgerSecret,
            taskId,
            sessionId: session.sessionId,
            generation: session.generation,
            profileInstanceId: session.profileInstanceId,
            origin: authority?.targetOrigin ?? params.targetOrigin ?? null,
          }),
          result: { ok: true, ...result },
          before: null,
          after: null,
        });
      }
      snapshot.result = "verified";
      snapshot.effect_state = snapshot.actions.some(action => action.step_packet.reconciliation_required) ? "known_effect" : "known_no_effect";
      snapshot.external_action_executed = snapshot.actions.some(action => action.step_packet.mutation);
      snapshot.dispatch_count = snapshot.actions.length;
      await this.taskLedger.transitionTaskCapsule(capsuleId, "post_read", {
        effect: { ...capsule.effect, effectState: snapshot.effect_state, effectClass: "external_commit", reconciliationRequired: false, externalActionExecuted: snapshot.external_action_executed, dispatchCount: snapshot.dispatch_count },
      });
      const finalCapsule = await this.taskLedger.transitionTaskCapsule(capsuleId, "completed", {
        target: { ...capsule.target, tabId: null, leaseId: null },
        resources: { ...capsule.resources, exactTabLeaseId: null, tabId: null, resourceClass: "profile_global" },
        effect: { ...capsule.effect, effectState: snapshot.effect_state, effectClass: "external_commit", reconciliationRequired: false, externalActionExecuted: snapshot.external_action_executed, dispatchCount: snapshot.dispatch_count },
      });
      snapshot.capsule = this.#publicTaskCapsule(finalCapsule);
      return snapshot;
    } catch (error) {
      snapshot.result = error?.code === "operation_effect_unknown" ? "unknown_effect" : "blocked";
      snapshot.effect_state = snapshot.result === "unknown_effect" ? "unknown_effect" : "no_dispatch";
      snapshot.external_action_executed = snapshot.result === "unknown_effect" ? null : false;
      snapshot.exact_blocker = { code: error?.code ?? "transaction_failed", message: String(error?.message ?? error).slice(0, 400) };
      try {
        await this.taskLedger.transitionTaskCapsule(capsuleId, snapshot.result === "unknown_effect" ? "reconciliation_required" : "failed", { blocker: snapshot.exact_blocker, effect: { ...capsule.effect, effectState: snapshot.effect_state, reconciliationRequired: snapshot.result === "unknown_effect", externalActionExecuted: snapshot.external_action_executed } });
      } catch { /* preserve the original operation error */ }
      throw error;
    }
  }

  async #executeTaskTransaction(peer, params) {
    const transactionStartedAt = performance.now();
    const phaseTimings = {};
    let currentPhase = "admission";
    let phaseStartedAt = transactionStartedAt;
    const finishPhase = (nextPhase) => {
      const now = performance.now();
      phaseTimings[currentPhase] = now - phaseStartedAt;
      phaseStartedAt = now;
      currentPhase = nextPhase;
    };
    const session = this.#requireOwnedSession(peer, params.sessionId);
    const taskId = requireString(params.taskId ?? session.taskId ?? session.sessionId, "taskId");
    if (session.taskId && session.taskId !== taskId) {
      throw new CompanionError("task_id_mismatch", "Transaction taskId does not match the logical session task");
    }
    const allowDirectApplication = params.intent === DIRECT_APPLICATION_INTENT;
    await this.#assertTaskImplementationAllowed(taskId, { allowDirectApplication });
    const runId = requireString(params.runId, "runId");
    const rawAllowedOrigins = Array.isArray(params.allowedOrigins) ? params.allowedOrigins.map((value) => String(value)) : [];
    const allowedOrigins = rawAllowedOrigins.map((value) => new URL(value).origin);
    if (allowedOrigins.length === 0) throw new CompanionError("allowed_origins_missing", "Authorized transactions require allowedOrigins");
    const actions = Array.isArray(params.actions) ? params.actions.slice(0, 32) : [];
    if (actions.length === 0) throw new CompanionError("transaction_actions_missing", "Authorized transaction requires at least one action");
    // Compile the signed action list once.  The packet is metadata only; the
    // live page/document target is bound later, immediately before each
    // dispatch, so a slow multi-step workflow does not carry stale geometry.
    const steps = compileTransactionSteps(actions);
    for (const step of steps) validateExpectedActionEvent(step.method, step.params?.expectEvent);
    const authority = params.authority;
    const initialUrl = params.startUrl ?? "about:blank";
    const exactTabId = params.tabId;
    if (exactTabId !== undefined && (!Number.isSafeInteger(exactTabId) || exactTabId < 0 || params.reuseTaskTab === false)) {
      throw new CompanionError("transaction_tab_id_invalid", "tabId must be a nonnegative integer and cannot be combined with reuseTaskTab:false");
    }
    const dialogOnly = steps.length === 1 && steps[0].method === "page.handleDialog";
    if (steps.some(step => step.method === "page.handleDialog") && (!dialogOnly || !Number.isSafeInteger(exactTabId))) {
      throw new CompanionError("transaction_dialog_exact_action_required", "Handle an observed dialog in a single-action transaction with the exact owned tabId");
    }
    if (dialogOnly && params.precondition) throw new CompanionError("transaction_dialog_precondition_unavailable", "A modal prevents a DOM precondition read; bind the observed dialog message and opening identity instead");
    if (steps.every(step => !step.targetScoped)) {
      return this.#executeProfileGlobalTransaction(peer, {
        session,
        taskId,
        runId,
        rawAllowedOrigins,
        allowedOrigins,
        actions,
        steps,
        authority,
        initialUrl,
        params,
      });
    }
    const capsuleInput = params.capsule ?? params.taskExecutionCapsule ?? null;
    // Terminal work closes its task tab by default. Callers must opt into
    // retention for a concrete resume, reconciliation, or user-action need.
    const capsuleMode = capsuleInput !== null;
    const keepTaskTab = params.keepTaskTab === true || dialogOnly;
    if (params.readbackMaxTextChars !== undefined && (!Number.isSafeInteger(params.readbackMaxTextChars)
      || params.readbackMaxTextChars < 100 || params.readbackMaxTextChars > 30000)) {
      throw new CompanionError("transaction_readback_text_limit_invalid", "readbackMaxTextChars must be 100 to 30000");
    }
    const reuseTaskTab = params.reuseTaskTab !== false;
    const capsule = normalizeTaskExecutionCapsule(capsuleInput ?? {}, {
      taskId,
      runId,
      startUrl: initialUrl,
      targetOrigin: authority?.targetOrigin ?? params.targetOrigin,
      allowedOrigins: rawAllowedOrigins,
      profileInstanceId: session.profileInstanceId,
      generation: session.generation,
      sessionId: session.sessionId,
      idempotencyKey: authority?.idempotencyKey,
      workflowType: "generic",
      retentionPolicy: params.keepTaskTab === true ? "retain" : "cleanup",
    });
    const awaitingUserRetention = capsuleInput?.state === "awaiting_user"
      ? requireAwaitingUserTabRetention(capsule)
      : null;
    const capsuleRetention = capsule.retention.policy;
    const taskWithCapsule = {
      authority,
      runId,
      taskId,
      idempotencyKey: authority?.idempotencyKey ?? "authority-unavailable",
      index: 0,
      capsule,
      // This flag is created only inside the broker after the signed
      // task.transaction intent is selected.  It keeps normal job
      // applications in the current owner thread independent from the
      // source-return gate while preserving that gate for every other
      // transaction and maintenance path.
      allowDirectApplication,
    };
    const targetReservationKey = `${session.profileInstanceId}:${session.generation}:${taskId}:${capsule.target.targetKey}`;
    if (this.taskTargetReservations.has(targetReservationKey)) {
      throw new CompanionError("target_resource_busy", "This task target is currently executing in another logical session", { targetKey: capsule.target.targetKey });
    }
    this.taskTargetReservations.set(targetReservationKey, session.sessionId);
    const snapshot = {
      schema: "aos.chrome_companion.transaction.v1",
      result: "running",
      execution_surface: "aos_chrome_companion_profile_instance",
      run_id: runId,
      task_id: taskId,
      profile: { profileInstanceId: session.profileInstanceId, generation: session.generation },
      tab: null,
      actions: [],
      step_packets: steps.map((step) => ({
        schema: step.schema,
        index: step.index,
        method: step.method,
        authorized: step.authorized,
        mutation: step.mutation,
        target_scoped: step.targetScoped,
        profile_global: step.profileGlobal,
        effect_class: step.effectClass,
        reconciliation_required: step.reconciliationRequired,
      })),
      external_action_executed: false,
      effect_state: "no_dispatch",
      dispatch_count: 0,
      cleanup: { closed: false, retained: false },
      exact_blocker: null,
    };
    let taskTab;
    let lease;
    let cleanupAttempted = false;
    let createdForTransaction = false;
    let mutationIndex = 0;
    // A read-only preflight can fail after setup mutations (for example
    // tabs.groupTask) have already completed.  Track whether the current
    // action's mutation is still awaiting its own post-dispatch readback so a
    // later visual.inspectTarget timeout cannot be misclassified as an
    // unknown external effect from the setup operation.
    let mutationInFlight = false;
    let actionOperationKey = null;
    let activeActionIndex = null;
    let latestSemanticReadback = null;
    let dialogContinuation = null;
    const appliedActions = [];

    const executeTaskMutation = (operation, trustedTask = taskWithCapsule) => {
      mutationInFlight = true;
      return this.#executeOperation(peer, operation, { trustedTask });
    };
    try {
      await this.taskLedger.putTaskCapsule(capsule);
      await this.taskLedger.transitionTaskCapsule(capsule.capsuleId, "admitted", { effect: { ...capsule.effect, idempotencyKey: authority?.idempotencyKey ?? null } });
      await this.taskLedger.verifyAndConsumeAuthority(authority, {
        secrets: this.issuerSecrets,
        payload: authorizedTransactionPayload({
          tabId: exactTabId,
          startUrl: initialUrl,
          allowedOrigins: rawAllowedOrigins,
          actions,
          reuseTaskTab,
          keepTaskTab: params.keepTaskTab === undefined ? undefined : keepTaskTab,
          readbackMaxTextChars: params.readbackMaxTextChars,
          retainOnUnknown: params.retainOnUnknown === true,
          precondition: params.precondition ?? null,
          capsule: capsuleInput ?? null,
        }),
        expected: { runId, taskId, ownerKey: session.sessionId, method: "task.transaction", intent: params.intent ?? "authorized_transaction" },
      });
      finishPhase("tab_setup");
      // A reconnect quarantines the previous generation instead of silently
      // reusing its tabs.  On the next same-task transaction, close only
      // terminal, non-user-help, non-leased stale tabs through this current
      // signed owner.  Protected tabs stay visible with an explicit reason.
      snapshot.stale_generation_cleanup = exactTabId !== undefined ? { skipped: "exact_tab_continuation", unknown_effect: [] } : await this.#cleanupStaleGenerationTaskTabs(peer, {
        session,
        taskId,
        allowedOrigins,
        authority,
        taskWithCapsule,
        nextMutationIndex: () => mutationIndex++,
      });
      if (snapshot.stale_generation_cleanup.unknown_effect.some((entry) => entry.ledger_only !== true)) {
        throw new CompanionError(
          "operation_effect_unknown",
          "A stale-generation cleanup close has an unknown effect; reconcile it before starting another task action",
          {
            mutationDispatchAttempted: true,
            operationEffectState: "unknown",
            restartPoint: "signed_task_status_and_exact_tab_readback",
            tabIds: snapshot.stale_generation_cleanup.unknown_effect
              .filter((entry) => entry.ledger_only !== true)
              .map((entry) => entry.tab_id),
          },
        );
      }
      if (reuseTaskTab) {
        const inventory = await this.#executeOperation(peer, { sessionId: session.sessionId, method: "tabs.list", params: {} });
        const inventoryById = new Map(inventory.map((tab) => [tab.id, tab]));
          const candidateEntries = [...this.taskTabs.values()]
          .filter((entry) => entry.profileInstanceId === session.profileInstanceId
            && entry.taskId === taskId
            && entry.retentionPolicy !== "cleanup"
            && !isLedgerOnlyTaskTab(entry))
          .sort((left, right) => String(right.updatedAt ?? right.createdAt ?? "").localeCompare(String(left.updatedAt ?? left.createdAt ?? "")));
        // An explicit exact-tab continuation may begin with a freshly leased
        // user tab that has not yet crossed a task transaction boundary.  The
        // lease is the ownership proof in this narrow path; do not broaden it
        // to URL/origin reuse.  Bind only the exact current-generation tab
        // owned by this session, with a live non-active/non-pinned target in
        // the signed origin allowlist.  The normal pre-read below replaces
        // the provisional identity with the live pageInstanceId before any
        // mutating action can dispatch.
        if (exactTabId !== undefined && !candidateEntries.some((entry) => entry.tabId === exactTabId)) {
          const exactLease = [...this.leases.values()].find((entry) => entry.tabId === exactTabId
            && entry.sessionId === session.sessionId
            && entry.profileInstanceId === session.profileInstanceId
            && entry.generation === session.generation);
          const exactLive = inventoryById.get(exactTabId);
          let exactOrigin = null;
          try { exactOrigin = new URL(exactLive?.url ?? "").origin; } catch { exactOrigin = null; }
          // A popup opened by an already-retained task tab is a narrow,
          // explicit continuation target. It may be active because Chrome
          // focuses auth popups by design; allow it only when the exact tab is
          // leased by this session, is not pinned, and Chrome reports an
          // opener that is itself one of this task's current retained tabs.
          // Ordinary active tabs and unassociated auth tabs remain blocked.
          const ownedOpenerContinuation = Number.isSafeInteger(exactLive?.openerTabId)
            && exactLive.openerTabId !== exactTabId
            && candidateEntries.some((entry) => entry.tabId === exactLive.openerTabId
              && entry.generation === session.generation
              && entry.retentionPolicy !== "cleanup"
              && !isLedgerOnlyTaskTab(entry));
          // Chrome may omit openerTabId for an already-open OAuth popup that
          // was reused by a provider.  Keep that case narrow as well: the
          // exact leased tab must be Google's account chooser and its signed
          // URL must explicitly identify Printify as both origin and app
          // domain.  This does not authorize arbitrary active auth tabs.
          const printifyOAuthContinuation = exactOrigin === "https://accounts.google.com"
            && /^https:\/\/accounts\.google\.com\/v3\/signin\/accountchooser(?:[/?]|$)/u.test(String(exactLive?.url ?? ""))
            && /(?:^|[?&])origin=https%3A%2F%2Fprintify\.com(?:&|$)/iu.test(String(exactLive?.url ?? ""))
            && /(?:^|[?&])app_domain=https%3A%2F%2Fprintify\.com(?:&|$)/iu.test(String(exactLive?.url ?? ""));
          // A tab this same session already used as this task's tab (for
          // example one whose uncertain upload was just reconciled) is not a
          // user tab, even when Chrome reports it active: the task may
          // re-reserve it and continue there.
          const previouslyOwnedTaskTab = [...this.taskTabs.values()].some((entry) => entry.tabId === exactTabId
            && entry.profileInstanceId === session.profileInstanceId
            && entry.generation === session.generation
            && entry.taskId === taskId
            && entry.sessionId === session.sessionId
            && entry.userHelpRequired !== true
            && !entry.quarantine
            && !entry.resumeToken
            && !isLedgerOnlyTaskTab(entry));
          if (exactLease && exactLive && exactLive.pinned !== true
            && exactOrigin && allowedOrigins.includes(exactOrigin)
            && (exactLive.active !== true || ownedOpenerContinuation || printifyOAuthContinuation || previouslyOwnedTaskTab)) {
            const provisionalIdentity = normalizeTargetIdentity({
              taskId,
              sessionId: session.sessionId,
              leaseId: null,
              generation: session.generation,
              profileInstanceId: session.profileInstanceId,
              tabId: exactTabId,
              pageInstanceId: null,
              windowId: exactLive.windowId,
              frameId: capsule.target.frameId,
              origin: exactOrigin,
            });
            candidateEntries.push({
              profileInstanceId: session.profileInstanceId,
              generation: session.generation,
              tabId: exactTabId,
              taskId,
              runId,
              sessionId: session.sessionId,
              targetKey: capsule.target.targetKey,
              canonicalLocator: capsule.target.canonicalLocator,
              targetIdentity: provisionalIdentity,
              targetFingerprint: targetIdentityDigest(this.ledgerSecret, provisionalIdentity),
              workflowType: capsule.workflowType,
              lifecycleState: "completed",
              retentionPolicy: "retain",
              resumeToken: null,
              userHelpRequired: false,
              quarantine: null,
              createdAt: nowIso(),
              updatedAt: nowIso(),
            });
          }
        }
        // Missing current-generation records are bookkeeping, not targets.
        // Remove them only after the fresh inventory proves the tab is gone;
        // stale-generation and reconciliation records remain for signed
        // recovery and are never silently adopted.
        for (const candidate of candidateEntries) {
          if (candidate.generation === session.generation && !inventoryById.has(candidate.tabId)) {
            this.taskTabs.delete(this.#tabKey(candidate.profileInstanceId, candidate.tabId));
            await this.taskLedger.removeTaskTab(candidate.profileInstanceId, candidate.tabId);
          }
        }
        dialogContinuation = dialogOnly ? this.#findPendingDialogTrigger(session, runId, exactTabId, actions[0].params, candidateEntries) : null;
        const resolution = resolveDynamicTaskTarget({
          session,
          descriptor: {
            tabId: exactTabId,
            taskId,
            targetKey: capsule.target.targetKey,
            canonicalLocator: capsule.target.canonicalLocator,
            targetOrigin: authority.targetOrigin,
            startUrl: initialUrl,
            allowedOrigins: rawAllowedOrigins,
            frameId: capsule.target.frameId,
          },
          // Only an exact response to the recorded opening can enter this
          // retained target. The ordinary resolver still checks generation,
          // origins, quarantine, foreign leases, and task ownership.
          taskTabs: dialogContinuation ? candidateEntries.map(entry => entry === dialogContinuation.entry
            ? { ...entry, lifecycleState: "failed" } : entry) : candidateEntries,
          inventory,
          leases: [...this.leases.values()],
          allowSameOriginReuse: true,
          sameOriginSelection: "latest",
        });
        snapshot.target_resolution = {
          schema: resolution.schema,
          status: resolution.status,
          resolution: resolution.resolution ?? null,
          exact_blocker: resolution.exactBlocker ?? null,
          candidates: resolution.candidates ?? [],
          diagnostics: resolution.diagnostics ?? null,
        };
        if (resolution.status === "ambiguous"
          && resolution.exactBlocker !== "dynamic_target_multiple_same_origin_candidates") {
          throw new CompanionError("dynamic_target_ambiguous", "The task target matched more than one live owned tab", {
            targetKey: capsule.target.targetKey,
            candidates: resolution.candidates,
          });
        }
        if (resolution.status === "busy") {
          throw new CompanionError("target_resource_busy", "This task target is currently leased by another logical session", {
            targetKey: capsule.target.targetKey,
            candidates: resolution.candidates,
          });
        }
        if (resolution.status === "protected") {
          throw new CompanionError(resolution.exactBlocker ?? "task_target_protected", "The exact task target is retained for reconciliation or user action", {
            targetKey: capsule.target.targetKey,
            candidates: resolution.candidates,
          });
        }
        if (exactTabId !== undefined && resolution.status !== "resolved") {
          throw new CompanionError(resolution.exactBlocker ?? "task_target_unavailable", "The requested exact task tab is unavailable; no replacement was opened", { tabId: exactTabId });
        }
        if (resolution.status === "resolved") {
          const available = { candidate: resolution.entry, live: resolution.live };
          taskTab = available.live;
          lease = await this.#acquireLease(peer, { sessionId: session.sessionId, tabId: taskTab.id });
          const rebound = {
            ...available.candidate,
            runId,
            sessionId: session.sessionId,
            capsuleId: capsule.capsuleId,
            targetKey: capsule.target.targetKey,
            canonicalLocator: capsule.target.canonicalLocator,
            workflowType: capsule.workflowType,
            lifecycleState: "executing",
            retentionPolicy: capsule.retention.policy,
            resumeToken: null,
            userHelpRequired: false,
            retentionReason: null,
            whyTabWasKept: null,
            requiredUserAction: null,
            resumeAction: null,
            ...rebuildTaskTabIdentity(this.ledgerSecret, available.candidate, {
              taskId: session.taskId,
              sessionId: session.sessionId,
              // A task-tab record is not itself a lease.  Keep the current
              // lease in the operation binding, but clear any old lease from
              // the persisted tab identity so it remains valid after release.
              leaseId: null,
              generation: session.generation,
              profileInstanceId: session.profileInstanceId,
              tabId: taskTab.id,
            }),
            updatedAt: nowIso(),
          };
          await this.taskLedger.recordTaskTab(rebound);
          this.taskTabs.set(this.#tabKey(session.profileInstanceId, taskTab.id), this.taskLedger.getTaskTab(session.profileInstanceId, taskTab.id));
          taskWithCapsule.index = mutationIndex++;
          const grouped = await executeTaskMutation({
            sessionId: session.sessionId,
            leaseId: lease.leaseId,
            method: "tabs.groupTask",
            taskOwnedRequired: true,
            params: { tabId: taskTab.id, allowedOrigins, targetOrigin: authority.targetOrigin },
          });
          mutationInFlight = false;
          taskTab = grouped;
          // Chrome canonicalizes a bare origin to a trailing slash. Comparing
          // raw strings here reloaded an unchanged page and discarded edits.
          if (exactTabId === undefined && new URL(taskTab.url).href !== new URL(initialUrl).href) {
            taskWithCapsule.index = mutationIndex++;
            taskTab = await executeTaskMutation({
              sessionId: session.sessionId,
              leaseId: lease.leaseId,
              method: "tabs.navigate",
              taskOwnedRequired: true,
              params: { tabId: taskTab.id, url: initialUrl, allowedOrigins, targetOrigin: authority.targetOrigin },
            });
            mutationInFlight = false;
          }
        }
      }
      if (!taskTab) {
        createdForTransaction = true;
        taskWithCapsule.index = mutationIndex++;
        taskTab = await executeTaskMutation({ sessionId: session.sessionId, method: "tabs.create", params: { url: initialUrl, active: false, allowedOrigins }, taskOwnedRequired: true });
        mutationInFlight = false;
        lease = await this.#acquireLease(peer, { sessionId: session.sessionId, tabId: taskTab.id });
      }
      await this.taskLedger.transitionTaskCapsule(capsule.capsuleId, "target_bound", { target: { ...capsule.target, profileInstanceId: session.profileInstanceId, generation: session.generation }, resources: { ...capsule.resources, exactTabLeaseId: lease.leaseId, tabId: taskTab.id } });
      snapshot.tab = { id: taskTab.id, groupId: taskTab.groupId ?? null, reused: !createdForTransaction };
      finishPhase("pre_read_and_binding");
      const readTransactionBefore = async () => {
        const result = await this.#executeOperation(peer, { sessionId: session.sessionId, leaseId: lease.leaseId,
          method: dialogOnly ? "page.inspectDialog" : "page.snapshot", params: { tabId: taskTab.id, maxTextChars: 30_000 } });
        if (dialogOnly && (result?.present !== true || !result.dialogId || result.pageInstanceId !== `javascript-dialog:${result.dialogId}`)) {
          throw new CompanionError("javascript_dialog_not_observed", "The exact tab has no observed current dialog; do not replay its triggering action", { mutationDispatchAttempted: false, operationEffectState: "none" });
        }
        if (dialogOnly && !isAllowedTaskFrameOrigin({ frameId: 1, url: result.dialogUrl }, allowedOrigins)) {
          throw new CompanionError("javascript_dialog_origin_not_allowed", "The observed dialog frame is outside the signed origins", { mutationDispatchAttempted: false, operationEffectState: "none" });
        }
        return result;
      };
      // Single-page apps (Printify's editor, LinkedIn's composer) render
      // their controls well after the document commits. Before the signed
      // pre-read, wait (read-only, bounded) for the first semantic target to
      // be visible, longer for a tab this transaction just opened. A timeout
      // is not an error here: the normal locator checks below report it.
      const firstSemanticStep = dialogOnly ? null
        : steps.find((step) => SEMANTIC_TARGET_MUTATION_METHODS.has(step.method) && step.params?.locator && typeof step.params.locator === "object");
      if (firstSemanticStep) {
        try {
          await this.#executeOperation(peer, { sessionId: session.sessionId, leaseId: lease.leaseId, method: "page.waitFor",
            params: { tabId: taskTab.id, locator: firstSemanticStep.params.locator, condition: "visible",
              timeoutMs: createdForTransaction ? 15_000 : 5_000, allowedOrigins, targetOrigin: authority.targetOrigin } });
          snapshot.target_ready_wait = "observed";
        } catch (error) {
          // Best effort only: anything but a lost connection falls through to
          // the ordinary pre-read, which reports the real state.
          if (["broker_connection_closed", "profile_not_connected", "session_generation_stale"].includes(error?.code)) throw error;
          snapshot.target_ready_wait = error?.code === "page_wait_timeout" ? "timed_out" : "unavailable";
        }
      }
      const pre = await readTransactionBefore();
      if (!allowedOrigins.includes(new URL(pre.url).origin)) throw new CompanionError("target_origin_not_allowed", "Created task tab did not commit to an allowed origin");
      const transactionHasMutation = steps.some((step) => step.mutation);
      const pageInstanceId = typeof pre.pageInstanceId === "string" && pre.pageInstanceId.trim()
        ? pre.pageInstanceId.trim()
        : null;
      if (transactionHasMutation && !pageInstanceId) {
        throw new CompanionError(
          "target_page_instance_required",
          "A mutating transaction requires the live pageInstanceId from the same-tab pre-read",
          { tabId: taskTab.id, mutationDispatchAttempted: false, operationEffectState: "none", reconciliationRequired: false },
        );
      }
      const preOrigin = new URL(pre.url).origin;
      const boundTarget = {
        ...capsule.target,
        profileInstanceId: session.profileInstanceId,
        generation: session.generation,
        sessionId: session.sessionId,
        tabId: taskTab.id,
        pageInstanceId,
        windowId: Number.isSafeInteger(pre.windowId) ? pre.windowId : (Number.isSafeInteger(taskTab.windowId) ? taskTab.windowId : capsule.target.windowId),
        frameId: Number.isSafeInteger(capsule.target.frameId) ? capsule.target.frameId : 0,
        origin: preOrigin,
      };
      await this.taskLedger.transitionTaskCapsule(capsule.capsuleId, "target_bound", {
        target: boundTarget,
        resources: { ...capsule.resources, exactTabLeaseId: lease.leaseId, tabId: taskTab.id },
      });
      const persistedTaskTab = this.taskLedger.getTaskTab(session.profileInstanceId, taskTab.id);
      if (persistedTaskTab) {
        const identity = rebuildTaskTabIdentity(this.ledgerSecret, persistedTaskTab, {
          taskId,
          sessionId: session.sessionId,
          leaseId: null,
          generation: session.generation,
          profileInstanceId: session.profileInstanceId,
          tabId: taskTab.id,
          pageInstanceId,
          windowId: boundTarget.windowId,
          frameId: boundTarget.frameId,
          origin: preOrigin,
        });
        const boundTaskTab = {
          ...persistedTaskTab,
          lifecycleState: "target_bound",
          generation: session.generation,
          sessionId: session.sessionId,
          windowId: boundTarget.windowId,
          targetIdentity: identity.targetIdentity,
          targetFingerprint: identity.targetFingerprint,
          identityRepairReason: null,
          updatedAt: nowIso(),
        };
        await this.taskLedger.recordTaskTab(boundTaskTab);
        this.taskTabs.set(this.#tabKey(session.profileInstanceId, taskTab.id), this.taskLedger.getTaskTab(session.profileInstanceId, taskTab.id));
        taskTab = { ...taskTab, windowId: boundTarget.windowId };
      }
      await this.taskLedger.transitionTaskCapsule(capsule.capsuleId, "pre_read", {
        target: boundTarget,
        visual: { ...(capsule.visual ?? {}), semanticPreRead: { url: pre.url, title: pre.title ?? null, pageInstanceId } },
      });
      await this.taskLedger.transitionTaskCapsule(capsule.capsuleId, "executing");
      snapshot.pre = { url: pre.url, title: pre.title, page_instance_id: pageInstanceId, window_id: boundTarget.windowId,
        read_kind: dialogOnly ? "javascript_dialog" : "semantic_snapshot",
        text_sha256: dialogOnly ? null : createHash("sha256").update(String(pre.text ?? ""), "utf8").digest("hex"),
        ...(dialogOnly ? { dialog_id: pre.dialogId, dialog_type: pre.type, document_text_read: false } : {}) };
      snapshot.frame_origins = [...new Set((Array.isArray(pre.frames) ? pre.frames : []).map((frame) => {
        try { return new URL(frame?.url).origin; } catch { return null; }
      }).filter(Boolean))].sort();
      snapshot.frames = (Array.isArray(pre.frames) ? pre.frames : []).slice(0, 100).map((frame) => ({
        frameId: Number.isSafeInteger(frame?.frameId) ? frame.frameId : null,
        url: frame?.url ?? null,
        pageInstanceId: frame?.pageInstanceId ?? null,
        allowed: (() => { try { return allowedOrigins.includes(new URL(frame?.url).origin); } catch { return false; } })(),
      }));
      let preconditionTargetSnapshotDigest = null;
      let preconditionRevalidatedBeforeMutation = false;
      if (params.precondition) {
        const precondition = requireObject(params.precondition, "precondition");
        const semanticQuery = requireString(precondition.semanticQuery, "precondition.semanticQuery");
        const targetDigest = requireString(precondition.targetDigest, "precondition.targetDigest");
        const sourceStateDigest = requireString(precondition.sourceStateDigest, "precondition.sourceStateDigest");
        if (!/^[a-f0-9]{64}$/u.test(targetDigest) || !/^[a-f0-9]{64}$/u.test(sourceStateDigest)) {
          throw new CompanionError("transaction_precondition_invalid", "Transaction precondition digests must be SHA-256 values");
        }
        if (snapshot.pre.text_sha256 !== sourceStateDigest) {
          throw new CompanionError("web_operation_source_state_binding_mismatch", "Live semantic page state changed after approval");
        }
        const query = await this.#executeOperation(peer, {
          sessionId: session.sessionId,
          leaseId: lease.leaseId,
          method: "page.query",
          params: { tabId: taskTab.id, query: semanticQuery, limit: 2 },
        });
        if (query?.count !== 1) {
          throw new CompanionError(query?.count > 1 ? "web_operation_target_ambiguous" : "web_operation_target_not_found", "Approved semantic target did not resolve to exactly one live element");
        }
        preconditionTargetSnapshotDigest = createHash("sha256").update(JSON.stringify(query.matches[0]), "utf8").digest("hex");
        const liveTargetDigest = createHash("sha256").update(semanticQuery, "utf8").digest("hex");
        if (liveTargetDigest !== targetDigest) {
          throw new CompanionError("web_operation_target_binding_mismatch", "Live semantic target digest does not match approved target binding");
        }
        snapshot.precondition = { verified: true, semantic_query_sha256: liveTargetDigest, source_state_digest: snapshot.pre.text_sha256, live_target_snapshot_sha256: preconditionTargetSnapshotDigest };
      }
      // Target preconditions are deliberately collected per step below.  The
      // old implementation inspected every future locator before dispatching
      // the first action, so a later stale/hidden element could prevent an
      // otherwise valid first action from running.  A packet is now prepared,
      // inspected, dispatched, and read back as one bounded unit.
      const actionTargetPreconditions = new Map();
      finishPhase("actions");
      for (let index = 0; index < steps.length; index += 1) {
        actionOperationKey = null;
        activeActionIndex = index;
        const stepStartedAt = performance.now();
        const action = steps[index];
        const method = requireString(action?.method, `actions[${index}].method`);
        if (!AUTHORIZED_TRANSACTION_METHODS.includes(method)) {
          throw new CompanionError("transaction_method_not_allowed", `Transaction method is not allowed: ${method}`);
        }
        if (NAVIGATION_MUTATION_METHODS.has(method)
          && steps.slice(index + 1).some((candidate) => candidate.mutation)) {
          throw new CompanionError("transaction_navigation_checkpoint_required", "A navigation mutation must end the signed mutation sequence; continue only in a fresh transaction after readback");
        }
        const before = await readTransactionBefore();
        const preReadMs = performance.now() - stepStartedAt;
        if (!allowedOrigins.includes(new URL(before.url).origin)) throw new CompanionError("redirect_origin_escape", "Task tab left the allowed origin set");
        if (action.mutation
          && (String(before.url || "") !== String(pre.url || "") || before.pageInstanceId !== pre.pageInstanceId)) {
          throw new CompanionError("transaction_navigation_checkpoint_required", "The document or URL changed before a later mutation; fresh signed readback and a new transaction are required");
        }
        if (!preconditionRevalidatedBeforeMutation && params.precondition && action.mutation) {
          const semanticQuery = requireString(params.precondition.semanticQuery, "precondition.semanticQuery");
          const sourceStateDigest = createHash("sha256").update(String(before.text ?? ""), "utf8").digest("hex");
          if (sourceStateDigest !== snapshot.pre.text_sha256) {
            throw new CompanionError("web_operation_source_state_binding_mismatch", "Live semantic page state changed immediately before the first mutation");
          }
          const liveTarget = await this.#executeOperation(peer, {
            sessionId: session.sessionId,
            leaseId: lease.leaseId,
            method: "page.query",
            params: { tabId: taskTab.id, query: semanticQuery, limit: 2 },
          });
          const liveTargetSnapshotDigest = liveTarget?.count === 1
            ? createHash("sha256").update(JSON.stringify(liveTarget.matches[0]), "utf8").digest("hex")
            : null;
          if (!liveTargetSnapshotDigest || liveTargetSnapshotDigest !== preconditionTargetSnapshotDigest) {
            throw new CompanionError("web_operation_target_binding_mismatch", "The approved semantic target identity, state, or rectangle changed immediately before mutation dispatch");
          }
          preconditionRevalidatedBeforeMutation = true;
        }
        // Inspect this step's semantic target only after its fresh snapshot.
        // A later action can no longer fail before an earlier action has had a
        // chance to execute, and the resulting proof is tied to this packet's
        // exact document/frame.
        if (SEMANTIC_TARGET_MUTATION_METHODS.has(method)) {
          const locator = requireObject(action.params?.locator, `actions[${index}].params.locator`);
          const inspectTarget = (scroll) => this.#executeOperation(peer, {
            sessionId: session.sessionId,
            leaseId: lease.leaseId,
            method: "visual.inspectTarget",
            params: { tabId: taskTab.id, locator, scroll, allowedOrigins },
          });
          let inspection;
          try {
            inspection = await inspectTarget(false);
          } catch (error) {
            // A target below the fold was refused here, before the action itself could scroll to
            // it, so every click on a button further down needed its own page.scroll first
            // (2026-10-18: 32 stops in three days). Bring it into view once (a scroll inside the
            // page; nothing leaves it) and inspect again without moving.
            if (error?.code !== "visual_target_outside_viewport") throw error;
            await inspectTarget(true);
            inspection = await inspectTarget(false);
          }
          const targetDocument = snapshotTargetDocument(before, locator);
          inspection = await this.#bindSemanticInspectionToDocument(peer, {
            sessionId: session.sessionId,
            leaseId: lease.leaseId,
            tabId: taskTab.id,
            locator,
            inspection,
            approvedDocument: targetDocument,
          });
          if (!targetDocument
            || (inspection?.frameId ?? 0) !== targetDocument.frameId
            || inspection?.pageInstanceId !== targetDocument.pageInstanceId
            || String(inspection?.url || "") !== String(targetDocument.url || "")) {
            throw new CompanionError("transaction_action_target_page_mismatch", "A semantic action target does not belong to the current document instance");
          }
          if (targetDocument.url) {
            let frameOrigin = null;
            try { frameOrigin = new URL(targetDocument.url).origin; } catch { /* handled by the extension origin guard */ }
            if (!isAllowedTaskFrameOrigin(targetDocument, allowedOrigins)) {
              throw new CompanionError(
                "target_frame_origin_not_allowed",
                "The semantic action target is inside a frame outside the signed origin allowlist",
                { frameId: targetDocument.frameId, frameOrigin, allowedOrigins },
              );
            }
          }
          actionTargetPreconditions.set(index, {
            locator,
            targetDocument,
            digest: semanticTargetStateDigest(this.ledgerSecret, locator, inspection),
            semanticGuardId: ["page.click", "page.submit"].includes(method)
              && typeof inspection.semanticGuard?.id === "string"
              && inspection.semanticGuard.id.length <= 128
              && inspection.semanticGuard.methods?.includes(method)
              ? inspection.semanticGuard.id : null,
          });
          snapshot.action_preconditions = [...actionTargetPreconditions.entries()].map(([stepIndex, value]) => ({ index: stepIndex, target_state_digest: value.digest }));
        }
        const actionTargetPrecondition = actionTargetPreconditions.get(index);
        if (actionTargetPrecondition && !actionTargetPrecondition.semanticGuardId) {
          let liveTarget = await this.#executeOperation(peer, {
            sessionId: session.sessionId,
            leaseId: lease.leaseId,
            method: "visual.inspectTarget",
            params: { tabId: taskTab.id, locator: actionTargetPrecondition.locator, scroll: false, allowedOrigins },
          });
          liveTarget = await this.#bindSemanticInspectionToDocument(peer, {
            sessionId: session.sessionId,
            leaseId: lease.leaseId,
            tabId: taskTab.id,
            locator: actionTargetPrecondition.locator,
            inspection: liveTarget,
            approvedDocument: actionTargetPrecondition.targetDocument,
          });
          const liveDigest = semanticTargetStateDigest(this.ledgerSecret, actionTargetPrecondition.locator, liveTarget);
          if ((liveTarget?.frameId ?? 0) !== actionTargetPrecondition.targetDocument.frameId
            || liveTarget?.pageInstanceId !== actionTargetPrecondition.targetDocument.pageInstanceId
            || String(liveTarget?.url || "") !== String(actionTargetPrecondition.targetDocument.url || "")
            || liveDigest !== actionTargetPrecondition.digest) {
            throw new CompanionError("transaction_action_target_changed", "The signed semantic action target identity, state, or rectangle changed before mutation dispatch");
          }
        }
        const actionParams = { ...(action.params ?? {}) };
        // The token must come from this step's fresh inspection, never from
        // caller-supplied action fields. The extension checks it atomically
        // with target resolution before the first click/submit side effect.
        delete actionParams.semanticGuardId;
        if (actionTargetPrecondition?.semanticGuardId) actionParams.semanticGuardId = actionTargetPrecondition.semanticGuardId;
        if (dialogOnly) {
          if ((actionParams.expectedDialogId !== undefined && actionParams.expectedDialogId !== before.dialogId)
            || (actionParams.expectedType !== undefined && actionParams.expectedType !== before.type)) {
            throw new CompanionError("javascript_dialog_identity_mismatch", "The expected dialog opening or type is no longer current", { mutationDispatchAttempted: false, operationEffectState: "none" });
          }
          actionParams.expectedDialogId = before.dialogId;
          actionParams.expectedType = before.type;
        }
        const uploadConfirmationLocator = (method === "page.upload" || method === "page.uploadMultiple")
          && actionParams.confirmationLocator
          && typeof actionParams.confirmationLocator === "object"
          && !Array.isArray(actionParams.confirmationLocator)
          ? actionParams.confirmationLocator
          : null;
        const uploadConfirmationTimeoutMs = Number.isSafeInteger(actionParams.confirmationTimeoutMs)
          ? Math.min(Math.max(actionParams.confirmationTimeoutMs, 100), 15_000)
          : 5_000;
        const assignedUploadFiles = method === "page.upload" ? [actionParams.file]
          : method === "page.uploadMultiple" ? actionParams.files : [];
        if (Array.isArray(assignedUploadFiles) && new Set(assignedUploadFiles.map(file => file?.name)).size !== assignedUploadFiles.length)
          throw new CompanionError("upload_filename_ambiguous", "Each file in one upload must have a distinct filename for exact attachment readiness proof", { operationEffectState: "none", mutationDispatchAttempted: false });
        for (const file of assignedUploadFiles ?? []) if (file?.sha256 !== undefined
          && file.sha256 !== createHash("sha256").update(Buffer.from(file.dataBase64 ?? "", "base64")).digest("hex"))
          throw new CompanionError("upload_file_digest_mismatch", "The assigned file SHA-256 must match its exact materialized bytes", { operationEffectState: "none", mutationDispatchAttempted: false });
        // Sites that only render a thumbnail (X, Instagram, Threads, Facebook)
        // never show the filename. For one file, a caller may bind a preview
        // locator that must be absent before and appear after this upload.
        const uploadPreviewOnly = actionParams.confirmationPreviewOnly === true;
        if (uploadPreviewOnly && (method !== "page.upload" || !uploadConfirmationLocator || actionParams.confirmationFiles !== undefined))
          throw new CompanionError("upload_confirmation_preview_invalid", "confirmationPreviewOnly requires one page.upload file and a confirmationLocator, without confirmationFiles", { operationEffectState: "none", mutationDispatchAttempted: false });
        const uploadConfirmationFiles = uploadPreviewOnly
          ? (assignedUploadFiles ?? []).map(file => {
            const locator = uploadConfirmationLocator;
            if ([locator.nth, locator.ordinal, locator.last].some(value => value !== undefined))
              throw new CompanionError("upload_confirmation_locator_invalid", "Attachment-ready proof requires one unique row; omit nth, ordinal and last", { operationEffectState: "none", mutationDispatchAttempted: false });
            return { filename_sha256: createHash("sha256").update(String(file.name).replace(/\s+/gu, " ").trim()).digest("hex"),
              file_sha256: createHash("sha256").update(Buffer.from(file.dataBase64 ?? "", "base64")).digest("hex"),
              preview_only: true, filename_locator: null, locator };
          })
          : (method === "page.upload" || method === "page.uploadMultiple")
          ? (assignedUploadFiles ?? []).map(file => {
            const explicit = Array.isArray(actionParams.confirmationFiles) ? actionParams.confirmationFiles.filter(item => item?.filename === file?.name) : undefined;
            if (actionParams.confirmationFiles !== undefined && (!Array.isArray(actionParams.confirmationFiles)
              || explicit?.length !== 1 || actionParams.confirmationFiles.length !== assignedUploadFiles.length))
              throw new CompanionError("upload_confirmation_files_invalid", "Provide one attachment-ready locator for every assigned filename", { operationEffectState: "none", mutationDispatchAttempted: false });
            const locator = explicit?.[0]?.locator ?? uploadConfirmationLocator;
            if (locator && [locator.nth, locator.ordinal, locator.last].some(value => value !== undefined))
              throw new CompanionError("upload_confirmation_locator_invalid", "Attachment-ready proof requires one unique row; omit nth, ordinal and last", { operationEffectState: "none", mutationDispatchAttempted: false });
            if (locator?.allOf?.length >= 8) throw new CompanionError("upload_confirmation_locator_invalid", "Attachment-ready locators allow at most 7 allOf filters before the bound filename constraint", { operationEffectState: "none", mutationDispatchAttempted: false });
            return locator ? { filename_sha256: createHash("sha256").update(String(file.name).replace(/\s+/gu, " ").trim()).digest("hex"),
              file_sha256: createHash("sha256").update(Buffer.from(file.dataBase64 ?? "", "base64")).digest("hex"),
              filename_locator: { text: file.name, exact: true, anyOf: [locator, { within: locator }] },
              locator: { ...locator, allOf: [...(locator.allOf ?? []), { hasText: file.name }] } } : null;
          }).filter(Boolean) : [];
        delete actionParams.confirmationLocator;
        // Sites that rename uploads (Printify) or show neither filename nor a
        // unique preview may instead bind a locator matching every uploaded
        // item in a list: attachment is proven when its exact visible count
        // grows by the number of assigned files.
        const uploadCountLocator = (method === "page.upload" || method === "page.uploadMultiple")
          && actionParams.confirmationCountLocator && typeof actionParams.confirmationCountLocator === "object"
          && !Array.isArray(actionParams.confirmationCountLocator) ? actionParams.confirmationCountLocator : null;
        delete actionParams.confirmationTimeoutMs;
        delete actionParams.confirmationFiles;
        delete actionParams.confirmationPreviewOnly;
        delete actionParams.confirmationCountLocator;
        let uploadCountBefore = null;
        let uploadCountConfirmed = false;
        if (uploadCountLocator) {
          if ([uploadCountLocator.nth, uploadCountLocator.ordinal, uploadCountLocator.last].some(value => value !== undefined))
            throw new CompanionError("upload_confirmation_locator_invalid", "confirmationCountLocator must match every uploaded item; omit nth, ordinal and last", { operationEffectState: "none", mutationDispatchAttempted: false });
          const countBefore = await this.#executeOperation(peer, {
            sessionId: session.sessionId, leaseId: lease.leaseId, method: "page.query",
            params: { tabId: taskTab.id, locator: uploadCountLocator, limit: 1, allowedOrigins },
          });
          if (!Number.isSafeInteger(countBefore?.totalCount) || countBefore.totalCountExact !== true || countBefore.scanLimitReached === true)
            throw new CompanionError("upload_confirmation_pre_read_failed", "Could not count the upload list before the upload", { operationEffectState: "none", mutationDispatchAttempted: false });
          uploadCountBefore = countBefore.totalCount;
        }
        if (method === "page.upload" || method === "page.uploadMultiple") {
          // A caller cannot independently relax FileList readback. A reset
          // control is admissible only when this transaction will verify a
          // newly appearing, explicit site attachment state after delivery.
          actionParams.allowInputReset = (uploadConfirmationFiles.length === assignedUploadFiles.length && uploadConfirmationFiles.length > 0)
            || uploadCountBefore !== null;
          for (const confirmationFile of uploadConfirmationFiles) {
            const confirmationBefore = await this.#executeOperation(peer, {
              sessionId: session.sessionId, leaseId: lease.leaseId, method: "page.query",
              params: { tabId: taskTab.id, locator: confirmationFile.locator, limit: 2, allowedOrigins },
            });
            if (!Number.isSafeInteger(confirmationBefore?.count)) {
              throw new CompanionError("upload_confirmation_pre_read_failed", "Could not establish the pre-upload confirmation state", {
                operationEffectState: "none", mutationDispatchAttempted: false,
              });
            }
            if (confirmationBefore.count > 0) {
              throw new CompanionError("upload_confirmation_already_present", "The requested attachment confirmation is already visible; inspect the existing attachment or use a confirmation specific to this operation", {
                operationEffectState: "none", mutationDispatchAttempted: false,
                nextAction: "inspect_existing_attachment_before_upload",
              });
            }
            // Validate the exact scoped filename locator on the original page
            // before the sole upload dispatch, even when no row exists yet.
            if (!confirmationFile.preview_only) await this.#executeOperation(peer, {
              sessionId: session.sessionId, leaseId: lease.leaseId, method: "page.query",
              params: { tabId: taskTab.id, locator: confirmationFile.filename_locator, limit: 2, allowedOrigins },
            });
          }
        }
        let dropdownVisualProofVerified = false;
        if (method === "page.selectOption") {
          if (!actionParams.visualProof && actionParams.autoVisualProof === true) {
            const inspection = await this.#inspectDropdownWithVisual(peer, {
              sessionId: session.sessionId,
              leaseId: lease.leaseId,
              tabId: taskTab.id,
              locator: actionParams.locator,
            });
            if (inspection?.visualProof) actionParams.visualProof = inspection.visualProof;
          }
          this.#verifyDropdownVisualProof({
            proof: actionParams.visualProof,
            session,
            lease,
            tabId: taskTab.id,
            locator: actionParams.locator,
            currentUrl: before.url,
          });
          delete actionParams.visualProof;
          dropdownVisualProofVerified = true;
        }
        let visualTargetProofVerified = false;
        if (method.startsWith("visual.")) {
          const verified = this.#verifyVisualTargetProof({
            proof: actionParams.visualProof,
            session,
            lease,
          tabId: taskTab.id,
          currentUrl: before.url,
          currentPageInstanceId: before.pageInstanceId,
          consume: false,
          });
          // Only a click follows a moved element; typing, keys, scrolls and drags keep exact geometry.
          const followsElement = method === "visual.click" || method === "visual.doubleClick";
          const fresh = await this.#revalidateVisualTargetProof(peer, { session, lease, tabId: taskTab.id, verified,
            currentUrl: before.url, allowMovedTarget: followsElement && !verified.canvasPatch });
          const geometry = fresh && typeof fresh === "object" ? fresh : null;
          delete actionParams.visualProof;
          actionParams.point = geometry?.point ?? verified.point;
          if (method === "visual.click" || method === "visual.doubleClick") {
            // The Extension promotes the tab and renders its cursor after this
            // broker check. Carry only verified geometry for a final check
            // after those layout-changing steps, before any mouse input.
            actionParams.visualTargetGuard = {
              kind: verified.kind, locator: verified.locator,
              point: actionParams.point, rect: geometry?.rect ?? verified.rect,
              viewport: geometry?.viewport ?? verified.viewport, scroll: geometry?.scroll ?? verified.scroll,
              pageUrl: before.url, pageInstanceId: verified.pageInstanceId,
              frameId: verified.frameId, framePath: verified.framePath,
              coordinateSpace: verified.coordinateSpace,
              ...(geometry ? { allowMovedTarget: true, elementRef: verified.elementRef,
                element: verified.element, hitElement: verified.hitElement } : {}),
              ...(verified.canvasPatch ? { canvas: true } : {}),
            };
          }
          let verifiedTo = null;
          if (method === "visual.drag") {
            verifiedTo = this.#verifyVisualTargetProof({
              proof: actionParams.toVisualProof,
              session,
              lease,
              tabId: taskTab.id,
              currentUrl: before.url,
              currentPageInstanceId: before.pageInstanceId,
              consume: false,
            });
            await this.#revalidateVisualTargetProof(peer, { session, lease, tabId: taskTab.id, verified: verifiedTo, currentUrl: before.url });
            delete actionParams.toVisualProof;
            actionParams.to = verifiedTo.point;
          }
          this.#consumeVisualTargetProof(verified);
          if (verifiedTo) this.#consumeVisualTargetProof(verifiedTo);
          visualTargetProofVerified = true;
        }
        const boundStep = bindTransactionStep(action, {
          secret: this.ledgerSecret,
          taskId,
          sessionId: session.sessionId,
          leaseId: lease.leaseId,
          generation: session.generation,
          profileInstanceId: session.profileInstanceId,
          tabId: taskTab.id,
          pageInstanceId: before.pageInstanceId ?? pageInstanceId,
          windowId: Number.isSafeInteger(before.windowId) ? before.windowId : boundTarget.windowId,
          frameId: Number.isSafeInteger(before.frameId) ? before.frameId : boundTarget.frameId,
          origin: new URL(before.url).origin,
        });
        const operation = {
          sessionId: session.sessionId,
          leaseId: lease.leaseId,
          method,
          taskOwnedRequired: true,
          params: {
            ...actionParams,
            tabId: taskTab.id,
            // Carry the exact pre-dispatch document identity through every
            // target operation. The Extension rejects a stale renderer even
            // when the tab id was reused for a new page.
            pageInstanceId: before.pageInstanceId ?? pageInstanceId,
            windowId: Number.isSafeInteger(before.windowId) ? before.windowId : boundTarget.windowId,
            frameId: Number.isSafeInteger(before.frameId) ? before.frameId : boundTarget.frameId,
            allowedOrigins,
            targetOrigin: authority.targetOrigin,
          },
        };
        taskWithCapsule.index = mutationIndex++;
        actionOperationKey = `${taskWithCapsule.idempotencyKey}:${taskWithCapsule.index}`;
        const executionStartedAt = performance.now();
        let result = MUTATION_METHODS.has(method)
          ? await executeTaskMutation(operation)
          : await this.#executeOperation(peer, operation, { trustedTask: taskWithCapsule });
        const executionMs = performance.now() - executionStartedAt;
        // Record the successful dispatch before any later readback can fail.
        appliedActions.push({
          index, method, operationKey: actionOperationKey,
          mutation: action.mutation && !(method === "visual.pointerMove" && actionParams.virtualOnly === true),
          reconciliationRequired: boundStep.reconciliationRequired,
        });
        if (method === "page.upload" || method === "page.uploadMultiple") {
          snapshot.upload_delivery = { action_index: index, applied: true,
            file_input_assignment_verified: result?.fileInputAssignmentVerified === true,
            control_readback_verified: result?.uploadReadbackVerified === true,
            confirmation_observed: false, provider_submission_confirmed: false, retry_upload: false,
            filename_sha256: (result?.expectedFiles ?? []).filter(file => typeof file.name === "string")
              .map(file => createHash("sha256").update(file.name.replace(/\s+/gu, " ").trim()).digest("hex")),
            // Kept so a confirmation method can still be registered later,
            // during reconciliation, without the original bytes.
            assigned_files: (assignedUploadFiles ?? []).filter(file => typeof file?.name === "string").map(file => ({
              filename_sha256: createHash("sha256").update(String(file.name).replace(/\s+/gu, " ").trim()).digest("hex"),
              file_sha256: createHash("sha256").update(Buffer.from(file.dataBase64 ?? "", "base64")).digest("hex"),
            })),
            ...(uploadCountLocator ? { count_witness: { locator: uploadCountLocator, before: uploadCountBefore,
              required_increase: (assignedUploadFiles ?? []).length, observed: null } } : {}),
            confirmation_files: uploadConfirmationFiles };
          if (uploadCountLocator) {
            const deadline = Date.now() + uploadConfirmationTimeoutMs;
            while (true) {
              const countAfter = await this.#executeOperation(peer, {
                sessionId: session.sessionId, leaseId: lease.leaseId, method: "page.query",
                params: { tabId: taskTab.id, locator: uploadCountLocator, limit: 1, allowedOrigins },
              }).catch(() => null);
              if (Number.isSafeInteger(countAfter?.totalCount) && countAfter.totalCountExact === true) {
                snapshot.upload_delivery.count_witness.observed = countAfter.totalCount;
                if (countAfter.totalCount >= uploadCountBefore + snapshot.upload_delivery.count_witness.required_increase) break;
              }
              if (Date.now() >= deadline) break;
              await new Promise(resolve => setTimeout(resolve, 300));
            }
            const witness = snapshot.upload_delivery.count_witness;
            if (Number.isSafeInteger(witness.observed) && witness.observed >= witness.before + witness.required_increase) {
              uploadCountConfirmed = true;
              snapshot.upload_delivery.confirmation_observed = true;
            }
          }
        }
        if (method === "tabs.configure" && Number.isSafeInteger(result?.windowId)) {
          taskTab.windowId = result.windowId;
          boundTarget.windowId = result.windowId;
          const current = this.taskLedger.getTaskCapsule(capsule.capsuleId);
          await this.taskLedger.transitionTaskCapsule(capsule.capsuleId, "executing", { target: { ...current.target, windowId: result.windowId } });
        }
        if (result?.eventWait?.observed === false) {
          snapshot.event_wait = result.eventWait;
          throw new CompanionError("action_event_timeout", "The trigger completed but its pre-armed event was not observed; keep the applied action and do not repeat it", {
            operationEffectState: "known_effect", mutationDispatchAttempted: true,
          });
        }
        if (method === "page.download") {
          // The browser dispatch is already applied. Failed file verification
          // cannot put this download back into the remaining action set.
          snapshot.artifacts ??= [];
          try {
            const artifact = await verifyDownloadedArtifact(result, { expectedTabId: taskTab.id });
            result = { ...result, artifact };
            snapshot.artifacts.push(artifact);
          } catch (error) {
            snapshot.artifacts.push({ kind: "local_download", verified: false, downloadId: result?.downloadId ?? null,
              path: typeof result?.filePath === "string" ? result.filePath : null, downloadComplete: result?.state === "complete",
              exact_blocker: error?.code ?? "download_file_unreadable", retryDownload: false });
            throw error;
          }
        }
        let uploadConfirmation = null;
        if ((method === "page.upload" || method === "page.uploadMultiple") && result?.requiresSiteConfirmation === true && !uploadConfirmationFiles.length && !uploadCountConfirmed) {
          throw new CompanionError("upload_confirmation_required", "The input was consumed after file delivery; inspect the site's attachment state without re-uploading", {
            operationEffectState: "unknown", mutationDispatchAttempted: true,
            nextAction: "inspect_existing_attachment_state_without_reupload",
          });
        }
        if (uploadConfirmationFiles.length) {
          // Uploading a FileList proves only the control state.  A workflow
          // may additionally bind one visible post-upload/confirmation
          // locator so the same transaction can prove the site's own state.
          try {
            const confirmationDeadline = Date.now() + uploadConfirmationTimeoutMs;
            for (const confirmationFile of uploadConfirmationFiles) {
            const remainingMs = confirmationDeadline - Date.now();
            if (remainingMs < 100) throw new CompanionError("page_wait_timeout", "The bounded all-files confirmation interval expired");
            uploadConfirmation = await this.#executeOperation(peer, {
            sessionId: session.sessionId,
            leaseId: lease.leaseId,
            method: "page.waitFor",
            params: {
              tabId: taskTab.id,
              locator: confirmationFile.locator,
              timeoutMs: remainingMs,
              allowedOrigins,
              targetOrigin: authority.targetOrigin,
            },
            });
            if (uploadConfirmation?.found !== true) throw new CompanionError("page_wait_timeout", "The site attachment confirmation was not observed");
            }
            await this.#readUploadConfirmationFiles(peer, { session, lease, tabId: taskTab.id,
              delivery: snapshot.upload_delivery, pageInstanceId: before.pageInstanceId, pageUrl: before.url });
          } catch (error) {
            throw new CompanionError("upload_confirmation_not_observed", "Files were delivered but the site's attachment confirmation was not observed; reconcile without re-uploading", {
              operationEffectState: "unknown", mutationDispatchAttempted: true,
              cause: error?.code ?? "unknown", fileInputAssignmentVerified: result?.fileInputAssignmentVerified === true,
              nextAction: "inspect_existing_attachment_state_without_reupload",
            });
          }
          result.uploaded = true;
          result.uploadControlReadbackVerified = result.uploadReadbackVerified === true;
          result.uploadReadbackVerified = true;
          result.uploadReadbackMethod = "site_confirmation";
          result.siteConfirmationVerified = true;
          result.requiresSiteConfirmation = false;
          snapshot.upload_delivery.confirmation_observed = true;
        }
        if (dialogOnly && result?.closedVerified !== true) throw new CompanionError("javascript_dialog_close_unknown", "The dialog response has no verified close event; reconcile without replay", { operationEffectState: "unknown", mutationDispatchAttempted: true });
        const nextDialog = dialogOnly ? await this.#executeOperation(peer, { sessionId: session.sessionId, leaseId: lease.leaseId, method: "page.inspectDialog", params: { tabId: taskTab.id } }) : null;
        const formSubmissionDispatched = method === "page.submit" || result?.formSubmitControl === true;
        const readActionSnapshot = () => this.#executeOperation(peer, { sessionId: session.sessionId, leaseId: lease.leaseId, method: "page.snapshot", params: { tabId: taskTab.id, maxTextChars: 30_000 } });
        const submissionReadback = formSubmissionDispatched
          ? await readSubmissionTransition({ before, readSnapshot: readActionSnapshot, allowedOrigins })
          : null;
        const after = nextDialog?.present === true ? nextDialog
          : submissionReadback?.after ?? await readActionSnapshot();
        latestSemanticReadback = nextDialog?.present === true ? null : after;
        if (!allowedOrigins.includes(new URL(after.url).origin)) throw new CompanionError("redirect_origin_escape", "Task tab left the allowed origin set after mutation");
        if (dialogContinuation) snapshot.trigger_continuation = await this.#readBackDialogTrigger(dialogContinuation, after, result, nextDialog);
        const beforeTextSha256 = createHash("sha256").update(String(before.text ?? ""), "utf8").digest("hex");
        const afterTextSha256 = createHash("sha256").update(String(after.text ?? ""), "utf8").digest("hex");
        snapshot.actions.push({
          timings_ms: { total_before_receipt: performance.now() - stepStartedAt, pre_read: preReadMs, operation: executionMs },
          index,
          method,
          step_packet: {
            schema: boundStep.schema,
            index: boundStep.index,
            target_identity: boundStep.targetIdentity,
            target_fingerprint: boundStep.targetFingerprint,
            effect_class: boundStep.effectClass,
            reconciliation_required: boundStep.reconciliationRequired,
          },
          result: { ok: true, ...result },
          ...(submissionReadback ? { submission_readback: { transition_observed: submissionReadback.transitionObserved, read_attempts: submissionReadback.attempts, provider_receipt_verified: false } } : {}),
          before: { url: before.url, title: before.title, text_sha256: dialogOnly ? null : beforeTextSha256, ...(dialogOnly ? { read_kind: "javascript_dialog", dialog_id: before.dialogId } : {}) },
          after: { url: after.url, title: after.title, text_sha256: nextDialog?.present === true ? null : afterTextSha256,
            ...(nextDialog?.present === true ? { read_kind: "javascript_dialog", dialog_id: nextDialog.dialogId, dialog_type: nextDialog.type, continuation_required: true } : {}) },
          ...(method === "page.upload" || method === "page.uploadMultiple"
            ? {
                upload_readback_verified: result?.uploadReadbackVerified === true,
                upload_readback: result?.readback ?? null,
                ...(uploadConfirmation ? { upload_confirmation_readback: uploadConfirmation } : {}),
              }
            : {}),
          ...(dropdownVisualProofVerified ? { dropdown_visual_proof_verified: true } : {}),
          ...(visualTargetProofVerified ? { visual_target_proof_verified: true } : {}),
        });
        if (MUTATION_METHODS.has(method)
          && !(method === "visual.pointerMove" && actionParams.virtualOnly === true)) {
          snapshot.external_action_executed = true;
        }
        if (formSubmissionDispatched && !submissionReadback.transitionObserved) {
          throw new CompanionError(
            "operation_effect_unknown",
            "A form submission was dispatched but bounded exact-tab readback showed no observable transition; reconcile this attempt and do not retry with another submit method",
            {
              method,
              operationEffectState: "unknown",
              mutationDispatchAttempted: true,
              restartPoint: "signed_task_status_and_exact_tab_readback",
            },
          );
        }
        mutationInFlight = false;
      }
      finishPhase("visual_readback");
      snapshot.result = "verified";
      snapshot.effect_state = snapshot.external_action_executed ? "known_effect" : "known_no_effect";
      snapshot.dispatch_count = snapshot.actions.length;
      snapshot.post = snapshot.actions.at(-1)?.after ?? snapshot.pre;
      // Keep the durable capsule's effect evidence in lockstep with the
      // transaction receipt.  The capsule starts as `no_dispatch`, and the
      // old success path carried that initial value through post_read and
      // completed even after the signed action sequence had finished.  That
      // made one successful run produce contradictory receipt/capsule
      // evidence and unnecessarily forced reconciliation on the next
      // readback.  This is projection-only: it does not broaden the action
      // allow-list or change dispatch behavior.
      const transactionEffect = {
        effectState: snapshot.effect_state,
        effectClass: snapshot.actions.some((action) => action.step_packet?.effect_class === "external_commit")
          ? "external_commit"
          : "local_ui",
        reconciliationRequired: snapshot.actions.some((action) => action.step_packet?.reconciliation_required === true),
        externalActionExecuted: snapshot.external_action_executed === true,
        dispatchCount: snapshot.dispatch_count,
      };
      if (snapshot.post?.read_kind === "javascript_dialog") {
        snapshot.visual_readback = { kind: "javascript_dialog_state", dialogId: snapshot.post.dialog_id,
          screenshotAvailable: false, documentTextRead: false, continuationRequired: true };
      } else {
        const capturedReadback = await captureTransactionReadback({
          initialSnapshot: latestSemanticReadback,
          allowedOrigins,
          readSnapshot: () => this.#executeOperation(peer, { sessionId: session.sessionId, leaseId: lease.leaseId, method: "page.snapshot", params: { tabId: taskTab.id, maxTextChars: 30_000 } }),
          takeScreenshot: () => this.#executeOperation(peer, {
            sessionId: session.sessionId, leaseId: lease.leaseId, method: "page.screenshot",
            params: { tabId: taskTab.id, restoreActive: true }, timeoutMs: 30_000,
          }),
        });
        snapshot.visual_readback = capturedReadback.visual;
        snapshot.visual_readback_attempts = capturedReadback.attempts;
        snapshot.post = semanticReadback(capturedReadback.after);
        if (params.readbackMaxTextChars !== undefined) {
          const text = String(capturedReadback.after.text ?? "");
          snapshot.post.text = text.slice(0, params.readbackMaxTextChars);
          snapshot.post.text_truncated = text.length > params.readbackMaxTextChars || capturedReadback.after.truncated === true;
        }
      }
      finishPhase("finalization");
      await this.taskLedger.transitionTaskCapsule(capsule.capsuleId, "post_read", {
        completion: { ...capsule.completion, contract: capsule.completion.contract, providerReceipt: null, sourceSync: null, reconciliation: null, cleanup: null },
        visual: { ...(capsule.visual ?? {}), semanticPostRead: snapshot.post },
        effect: { ...(capsule.effect ?? {}), ...transactionEffect },
      });
      const requestedLifecycleState = capsuleInput?.state === "awaiting_user" ? "awaiting_user" : "completed";
      const subsequentDialog = snapshot.post?.read_kind === "javascript_dialog";
      if (subsequentDialog) snapshot.continuation_required = true;
      const finalCapsule = await this.taskLedger.transitionTaskCapsule(capsule.capsuleId, requestedLifecycleState, {
        resumeToken: requestedLifecycleState === "awaiting_user" ? (capsule.resumeToken ?? createId("resume")) : null,
        restartPoint: requestedLifecycleState === "awaiting_user" ? "user_resume_token" : null,
        retention: requestedLifecycleState === "awaiting_user"
          ? awaitingUserRetention
          : { ...capsule.retention, policy: subsequentDialog ? "retain" : capsuleRetention,
              resumeTokenRequired: !subsequentDialog && capsuleRetention !== "cleanup", userHelpRequired: false,
              ...(subsequentDialog ? { reason: "next_dialog_pending", whyTabWasKept: "The requested dialog closed and the page opened another dialog.", resumeAction: "inspect_dialog_then_signed_response" } : {}) },
        effect: { ...(capsule.effect ?? {}), ...transactionEffect },
      });
      const retainCompleted = subsequentDialog || requestedLifecycleState === "awaiting_user" || capsuleRetention !== "cleanup" || params.keepTaskTab === true;
      if (retainCompleted && taskTab) {
        const retainedTab = this.taskLedger.getTaskTab(session.profileInstanceId, taskTab.id);
        if (retainedTab) {
          const retainedEntry = {
            ...retainedTab,
            lifecycleState: requestedLifecycleState,
            retentionPolicy: finalCapsule.retention.policy,
            resumeToken: finalCapsule.resumeToken,
            userHelpRequired: finalCapsule.retention.userHelpRequired === true,
            retentionReason: finalCapsule.retention.reason ?? null,
            whyTabWasKept: finalCapsule.retention.whyTabWasKept ?? null,
            requiredUserAction: finalCapsule.retention.requiredUserAction ?? null,
            resumeAction: finalCapsule.retention.resumeAction ?? null,
            updatedAt: nowIso(),
          };
          const retention = taskTabRetentionExplanation(retainedEntry);
          await this.taskLedger.recordTaskTab({
            ...retainedEntry,
            retentionReason: retention.retentionReason,
            whyTabWasKept: retention.whyTabWasKept,
            resumeAction: retention.resumeAction,
          });
          this.taskTabs.set(this.#tabKey(session.profileInstanceId, taskTab.id), this.taskLedger.getTaskTab(session.profileInstanceId, taskTab.id));
        }
      }
      if (!retainCompleted) {
        cleanupAttempted = true;
        taskWithCapsule.index = mutationIndex++;
        await executeTaskMutation({
          sessionId: session.sessionId,
          leaseId: lease.leaseId,
          method: "tabs.close",
          taskOwnedRequired: true,
          params: { tabId: taskTab.id, allowedOrigins, targetOrigin: authority.targetOrigin },
        });
        mutationInFlight = false;
        snapshot.cleanup.closed = true;
      } else {
        snapshot.cleanup.retained = true;
      }
      if (finalCapsule) snapshot.capsule = this.#publicTaskCapsule(finalCapsule);
      return snapshot;
    } catch (error) {
      if (!taskTab && Number.isSafeInteger(error?.details?.createdTabId)) {
        taskTab = { id: error.details.createdTabId };
        createdForTransaction = true;
        try {
          lease = await this.#acquireLease(peer, { sessionId: session.sessionId, tabId: taskTab.id });
        } catch (leaseError) {
          snapshot.cleanup.exact_blocker = {
            code: leaseError?.code ?? "task_tab_cleanup_lease_failed",
            message: String(leaseError?.message ?? leaseError).slice(0, 400),
          };
        }
      }
      const currentOperation = this.taskLedger.get(`${taskWithCapsule.idempotencyKey}:${taskWithCapsule.index}`);
      const operationState = currentOperation?.state;
      const currentOperationMayMutate = MUTATION_METHODS.has(currentOperation?.binding?.method);
      const currentOperationRequiresReconciliation = currentOperationMayMutate
        && operationRequiresReconciliation(currentOperation);
      const errorRequiresReconciliation = error?.details?.reconciliationRequired !== false
        && error?.details?.reconciliation_required !== false;
      const pendingActionEvent = error?.code === "action_event_pending" && error?.details?.actionEvent?.kind === "dialog"
        ? error.details.actionEvent : null;
      const failedStepMayMutate = mutationInFlight || (activeActionIndex !== null && steps[activeActionIndex]?.mutation === true);
      const failedReadOnlyCommand = error?.[READ_ONLY_COMMAND_FAILURE] === true;
      const noEffectEvidence = failedReadOnlyCommand
        ? { knownNoEffect: false, contradictory: false, unprovenNoEffect: false }
        : transactionFailureNoEffectEvidence(error, {
        operation: currentOperation,
        operationKey: actionOperationKey ?? (mutationInFlight ? `${taskWithCapsule.idempotencyKey}:${taskWithCapsule.index}` : null),
        // This broker-owned path has not invoked the current action. A prior
        // setup/applied entry is deliberately excluded from its evidence.
        preDispatch: activeActionIndex !== null && !actionOperationKey && !mutationInFlight,
      });
      const effectMayHaveDispatched = failedStepMayMutate && !noEffectEvidence.knownNoEffect && ((["operation_effect_unknown", "action_event_pending"].includes(error?.code) && errorRequiresReconciliation)
        || (mutationInFlight && currentOperationRequiresReconciliation
          && (["dispatched", "unknown_effect"].includes(operationState)
            || (operationState === "applied" && !failedReadOnlyCommand && POST_DISPATCH_READBACK_ERRORS.has(error?.code)))));
      const localNavigationEffectUnknown = !effectMayHaveDispatched
        && isUncertainLocalNavigationEffect(currentOperation);
      // Keep the raw operation result honest for a local browser mutation
      // that did dispatch but returned late. Provider reconciliation and
      // local input uncertainty are distinct: preserve the original page for
      // an uncertain edit, while disposable tab setup follows its cleanup policy.
      const localUiEffectUnknown = failedStepMayMutate && !effectMayHaveDispatched
        && !noEffectEvidence.knownNoEffect
        && (noEffectEvidence.contradictory || noEffectEvidence.unprovenNoEffect
        || (currentOperationMayMutate && !currentOperationRequiresReconciliation
        && (operationState === "unknown_effect"
          || (mutationInFlight && currentOperation?.dispatchCount > 0 && operationState !== "applied")
          || ["operation_effect_unknown", "action_event_pending"].includes(error?.code)
          // tabs.create can emit a task.tab.created event before its
          // navigation acknowledgement.  The browser effect is local and
          // disposable, but the caller still needs the honest "unknown"
          // result so cleanup/readback can handle the created tab.
          || Number.isSafeInteger(error?.details?.createdTabId))));
      const appliedMutations = appliedActions.filter((action) => action.mutation);
      const retainUncertainLocalEdit = localUiEffectUnknown && activeActionIndex !== null;
      const failedStepEffectState = effectMayHaveDispatched || localUiEffectUnknown
        ? "unknown_effect"
        : noEffectEvidence.knownNoEffect
          ? "known_no_effect"
          : actionOperationKey && operationState === "applied" ? "known_effect" : "no_dispatch";
      const effectState = failedStepEffectState === "unknown_effect" ? "unknown_effect"
        : appliedMutations.length > 0 ? "known_effect" : failedStepEffectState;
      snapshot.failed_step = { index: activeActionIndex, effect_state: failedStepEffectState };
      snapshot.applied_actions = appliedActions.map(({ operationKey: _key, ...action }) => action);
      snapshot.completed_mutation_count = appliedMutations.length;
      snapshot.external_action_executed = effectState === "unknown_effect"
        ? (localNavigationEffectUnknown ? false : null)
        : appliedMutations.length > 0;
      snapshot.result = effectMayHaveDispatched || localUiEffectUnknown ? "unknown_effect" : "blocked";
      snapshot.effect_state = effectState;
      const failedDispatchCount = actionOperationKey && !appliedActions.some((action) => action.operationKey === actionOperationKey)
        ? currentOperation?.dispatchCount ?? (effectMayHaveDispatched || localUiEffectUnknown ? 1 : 0)
        : 0;
      snapshot.dispatch_count = appliedActions.length + failedDispatchCount;
      const appliedIndices = new Set(appliedActions.map(action => action.index));
      const unattemptedIndices = steps.map(step => step.index).filter(index => activeActionIndex === null || index > activeActionIndex);
      const retryFailedStep = activeActionIndex !== null && !appliedIndices.has(activeActionIndex)
        && (failedDispatchCount === 0 || (failedStepEffectState === "known_no_effect"
          && error?.details?.mutationDispatchAttempted === false))
        && failedStepEffectState !== "unknown_effect";
      // Persist compact progress, not action payloads or a replayable command.
      // A failed readback after a successful dispatch must never put that action
      // back into the remaining set.
      snapshot.action_progress = {
        total_actions: steps.length,
        applied_action_indices: [...appliedIndices],
        verified_action_indices: snapshot.actions.map(action => action.index),
        failed_action_index: activeActionIndex,
        failed_action_effect_state: failedStepEffectState,
        unattempted_action_indices: unattemptedIndices,
        remaining_action_indices: [...(retryFailedStep ? [activeActionIndex] : []), ...unattemptedIndices],
        uncertain_action_indices: failedStepEffectState === "unknown_effect" && activeActionIndex !== null ? [activeActionIndex] : [],
        fresh_target_readback_required: true,
        replay_allowed: false,
      };
      const blockerDetails = error?.details && typeof error.details === "object"
        ? {
          ...(typeof error.details.method === "string" ? { method: error.details.method } : {}),
          ...(Number.isSafeInteger(error.details.timeoutMs) ? { timeoutMs: error.details.timeoutMs } : {}),
          ...(typeof error.details.cause === "string" ? { cause: error.details.cause.slice(0, 100) } : {}),
          ...(typeof error.details.nextAction === "string" ? { nextAction: error.details.nextAction.slice(0, 180) } : {}),
          ...(typeof error.details.mutationDispatchAttempted === "boolean" ? { mutationDispatchAttempted: error.details.mutationDispatchAttempted } : {}),
          ...(typeof error.details.operationEffectState === "string" ? { operationEffectState: error.details.operationEffectState.slice(0, 40) } : {}),
          // A locator miss or an ambiguous one carries the controls it nearly matched, so the run can
          // pick the right name instead of reading the whole page again (2026-10-18).
          ...(Array.isArray(error.details.suggestions) ? { suggestions: error.details.suggestions.slice(0, 6).map(boundedControl) } : {}),
          ...(Array.isArray(error.details.candidates) ? { candidates: error.details.candidates.slice(0, 6).map(boundedControl) } : {}),
          ...(Number.isSafeInteger(error.details.hiddenMatches) ? { hiddenMatches: error.details.hiddenMatches } : {}),
          // When nothing is named alike, the controls on screen with the names they answer to (2026-10-19).
          ...(Array.isArray(error.details.controlsOnScreen) ? { controlsOnScreen: error.details.controlsOnScreen.slice(0, 12).map(boundedControl) } : {}),
          ...(Array.isArray(error.details.mismatches) ? { mismatches: error.details.mismatches.filter((key) => typeof key === "string").slice(0, 8).map((key) => key.slice(0, 40)) } : {}),
        }
        : {};
      if (error?.code === "screenshot_target_changed" && error.details && typeof error.details === "object") {
        // Project only the bounded capture diagnostic contract, never raw URLs or extra fields.
        const details = error.details;
        if (details.reasons && typeof details.reasons === "object" && !Array.isArray(details.reasons)) {
          const reasons = {};
          for (const key of ["activationInterruption", "activeTabMismatch", "windowMismatch", "urlMismatch", "loading"]) {
            if (typeof details.reasons[key] === "boolean") reasons[key] = details.reasons[key];
          }
          if (Object.keys(reasons).length > 0) blockerDetails.reasons = reasons;
        }
        if (["before_capture", "after_slot", "after_capture", "retry_guard"].includes(details.phase)) blockerDetails.phase = details.phase;
        if (Number.isSafeInteger(details.attempt) && details.attempt >= 0 && details.attempt <= 4) blockerDetails.attempt = details.attempt;
        for (const key of ["targetTabId", "targetWindowId", "currentTabId", "currentWindowId", "activeTabId", "activeWindowId"]) {
          if (details[key] === null || (Number.isSafeInteger(details[key]) && details[key] > 0)) blockerDetails[key] = details[key];
        }
      }
      if (error?.details?.documentProbeTarget && typeof error.details.documentProbeTarget === "object") {
        const conditions = error.details.documentProbeTarget;
        blockerDetails.documentProbeTarget = Object.fromEntries([
          "tabIdMatches", "windowMatches", "tabUrlMatches", "pendingNavigationPresent", "pendingUrlMatchesCommitted", "documentUrlMatches", "normalizedUrlMatches",
        ].filter(key => typeof conditions[key] === "boolean").map(key => [key, conditions[key]]));
        if (["before_injection", "after_injection", "document_url"].includes(conditions.stage)) blockerDetails.documentProbeTarget.stage = conditions.stage;
      }
      snapshot.exact_blocker = {
        code: error?.code ?? "transaction_failed",
        message: String(error?.message ?? error).slice(0, 400),
        ...(Object.keys(blockerDetails).length > 0 ? { details: blockerDetails } : {}),
        ...blockerRecoveryContext({ code: error?.code, taskId, runId, profileInstanceId: session.profileInstanceId,
          tabId: taskTab?.id, targetKey: capsule.target?.targetKey,
          nextAction: pendingActionEvent ? pendingActionEvent.requiresUser ? "user_dialog_response" : "page.handleDialog"
            : effectMayHaveDispatched || localNavigationEffectUnknown ? "perform_one_owner_signed_reconciliation_readback"
              : "fresh_status_and_exact_owner_readback" }),
      };
      if (pendingActionEvent) snapshot.action_event = pendingActionEvent;
      // A terminal blocker is a checkpoint, not a prompt to keep the same
      // thread spinning.  Surface an explicit continuation gate so callers
      // can pause automatic continuation and resume only from the recorded
      // restart point after the blocker changes.
      // A blocker that provably dispatched nothing and only concerns this
      // target (a locator that did not match yet, a tab that must be
      // re-reserved) is recoverable inside the same task: read the target
      // again and continue. Calling it terminal made callers abandon
      // half-finished workflows.
      const recoverableNoEffect = !effectMayHaveDispatched && !localNavigationEffectUnknown && !localUiEffectUnknown
        && appliedMutations.length === 0 && !pendingActionEvent
        && RECOVERABLE_NO_EFFECT_TARGET_BLOCKERS.has(snapshot.exact_blocker.code);
      snapshot.continuation = {
        ...blockerRecoveryContext({ code: error?.code, taskId, runId, profileInstanceId: session.profileInstanceId,
          tabId: taskTab?.id, targetKey: capsule.target?.targetKey, nextAction: snapshot.exact_blocker.next_action }),
        blocked_tab_id: taskTab?.id ?? null,
        blocked_run_id: runId,
        allowed: recoverableNoEffect,
        reason: effectMayHaveDispatched || localNavigationEffectUnknown ? "reconciliation_required" : localUiEffectUnknown ? "local_ui_readback_required" : appliedMutations.length > 0 ? "partial_actions_applied_readback_required" : recoverableNoEffect ? "no_effect_target_readback_then_continue" : "terminal_blocker",
        restart_point: effectMayHaveDispatched || localNavigationEffectUnknown ? "signed_task_status_readback" : recoverableNoEffect ? "fresh_target_readback" : "task_failure_recovery",
        ...(recoverableNoEffect ? { next_action: RECOVERABLE_NO_EFFECT_TARGET_BLOCKERS.get(snapshot.exact_blocker.code), task_may_continue: true } : {}),
        exact_blocker: snapshot.exact_blocker.code,
        ...(pendingActionEvent ? { reason: "action_event_pending", restart_point: "inspect_dialog_then_signed_response",
          next_action: pendingActionEvent.requiresUser ? "user_dialog_response" : "page.handleDialog",
          same_tab_id: taskTab?.id, same_run_id: runId, same_session_id: session.sessionId, trigger_replay_allowed: false } : {}),
      };
      const capsuleState = effectMayHaveDispatched || localNavigationEffectUnknown ? "reconciliation_required" : "failed";
      let finalCapsule = null;
      try {
        finalCapsule = await this.taskLedger.transitionTaskCapsule(capsule.capsuleId, capsuleState, {
          blocker: snapshot.exact_blocker,
          restartPoint: effectMayHaveDispatched || localNavigationEffectUnknown ? "signed_task_status_readback" : "task_failure_recovery",
          resumeToken: effectMayHaveDispatched || localNavigationEffectUnknown ? (capsule.resumeToken ?? createId("resume")) : capsule.resumeToken,
          resources: { ...capsule.resources, exactTabLeaseId: lease?.leaseId ?? null, tabId: taskTab?.id ?? null },
          ...((appliedMutations.length > 0 || retainUncertainLocalEdit || localNavigationEffectUnknown || dialogOnly) && !effectMayHaveDispatched ? {
            retention: { ...capsule.retention, policy: dialogOnly ? "retain" : "retain_until_resume", reason: dialogOnly ? "dialog_response_not_completed" : localNavigationEffectUnknown ? "local_ui_navigation_arrival_pending" : retainUncertainLocalEdit ? "local_ui_effect_unknown" : "partial_actions_applied",
              resumeAction: dialogOnly ? "inspect_dialog_then_signed_response" : localNavigationEffectUnknown ? "signed_local_navigation_arrival_readback_then_cleanup" : "read_back_same_target_then_continue_remaining_actions", userHelpRequired: false },
          } : {}),
          effect: {
            ...(capsule.effect ?? {}),
            effectState,
            effectClass: effectMayHaveDispatched || appliedMutations.some((action) => action.reconciliationRequired) ? "external_commit" : "local_ui",
            reconciliationRequired: effectMayHaveDispatched || localNavigationEffectUnknown,
            externalActionExecuted: effectState === "known_effect" ? true : effectState === "unknown_effect" ? (localNavigationEffectUnknown ? false : null) : false,
            dispatchCount: snapshot.dispatch_count,
            actionProgress: snapshot.action_progress,
            ...(snapshot.upload_delivery ? { uploadDelivery: snapshot.upload_delivery } : {}),
            ...(actionOperationKey && currentOperation?.operationId ? {
              failedOperationKey: actionOperationKey, failedOperationId: currentOperation.operationId,
            } : {}),
            ...(localNavigationEffectUnknown && currentOperation?.navigationTargetDigest
              ? { localNavigationTargetDigest: currentOperation.navigationTargetDigest }
              : {}),
            ...(pendingActionEvent ? { awaitedEvent: pendingActionEvent } : {}),
          },
        });
      } catch {
        // Preserve the original transaction blocker if durable status itself
        // is unavailable; the operation ledger still carries no-replay proof.
      }
      if (effectMayHaveDispatched || localNavigationEffectUnknown) {
        snapshot.reconciliation = {
          run_id: runId,
          task_id: taskId,
          idempotency_key: currentOperation?.idempotencyKey ?? taskWithCapsule.idempotencyKey,
          operation_id: currentOperation?.operationId ?? null,
          state: operationState ?? "unknown_effect",
          restart_point: "signed_task_status_readback",
          ...(localNavigationEffectUnknown ? {
            proof_kind: "local_navigation_arrival",
            operation_index: Number(String(currentOperation?.idempotencyKey ?? "").slice(`${taskWithCapsule.idempotencyKey}:`.length)),
            external_action_executed: false,
          } : {}),
        };
      }
      // Preserve the page containing successful edits when a later step fails.
      const retainPartialMutation = appliedMutations.length > 0 || retainUncertainLocalEdit;
      // The default transaction also needs its exact page to reconcile an
      // uncertain submission. Omitting an optional capsule or retention flag
      // must not close the only provider evidence after dispatch.
      const retainUnknown = Boolean(pendingActionEvent) || effectMayHaveDispatched || localNavigationEffectUnknown;
      const retainForLifecycle = capsuleMode && (capsuleState === "reconciliation_required" || capsuleState === "awaiting_user");
      const retainForPolicy = capsuleMode && capsuleRetention !== "cleanup";
      if (taskTab && lease && !cleanupAttempted && !keepTaskTab && !retainPartialMutation && !retainUnknown && !retainForLifecycle && !retainForPolicy) {
        cleanupAttempted = true;
        taskWithCapsule.index = mutationIndex++;
        try {
          await this.#executeOperation(peer, {
            sessionId: session.sessionId,
            leaseId: lease.leaseId,
            method: "tabs.close",
            taskOwnedRequired: true,
            params: { tabId: taskTab.id, allowedOrigins, targetOrigin: authority.targetOrigin },
          }, { trustedTask: taskWithCapsule });
          snapshot.cleanup.closed = true;
        } catch (cleanupError) {
          snapshot.cleanup.exact_blocker = {
            code: cleanupError?.code ?? "task_tab_cleanup_failed",
            message: String(cleanupError?.message ?? cleanupError).slice(0, 400),
          };
        }
      } else if (taskTab && !snapshot.cleanup.closed) {
        snapshot.cleanup.retained = true;
      }
      if (snapshot.cleanup.retained && taskTab && finalCapsule) {
        const retainedTab = this.taskLedger.getTaskTab(session.profileInstanceId, taskTab.id);
        if (retainedTab) {
          const retainedEntry = {
            ...retainedTab,
            lifecycleState: capsuleState,
            retentionPolicy: capsuleState === "reconciliation_required" || retainPartialMutation ? "retain_until_resume" : dialogOnly ? "retain" : retainedTab.retentionPolicy,
            resumeToken: finalCapsule.resumeToken,
            userHelpRequired: false,
            retentionReason: capsuleState === "reconciliation_required" ? (localNavigationEffectUnknown ? "local_ui_navigation_arrival_pending" : "ai_reconciliation_pending") : retainUncertainLocalEdit ? "local_ui_effect_unknown" : retainPartialMutation ? "partial_actions_applied" : dialogOnly ? "dialog_response_not_completed" : null,
            whyTabWasKept: capsuleState === "reconciliation_required"
              ? localNavigationEffectUnknown
                ? "A local tabs.navigate acknowledgement is unknown; verify arrival at its recorded target without replay."
                : "The task-owned tab is retained temporarily while Codex reconciles an unknown external effect without replaying it."
              : retainUncertainLocalEdit ? "A local edit was dispatched but its result is unknown; preserve the page and read it back without replaying the edit."
                : retainPartialMutation ? "The page contains successful actions from an interrupted transaction; read it back before continuing only the remaining actions." : dialogOnly ? "The dialog response was not completed; retain its page for exact dialog inspection." : null,
            requiredUserAction: null,
            resumeAction: capsuleState === "reconciliation_required" ? (localNavigationEffectUnknown ? "signed_local_navigation_arrival_readback_then_cleanup" : "signed_task_status_readback_then_cleanup_when_reconciled") : retainPartialMutation ? "read_back_same_target_then_continue_remaining_actions" : dialogOnly ? "inspect_dialog_then_signed_response" : null,
            updatedAt: nowIso(),
          };
          const retention = taskTabRetentionExplanation(retainedEntry);
          await this.taskLedger.recordTaskTab({
            ...retainedEntry,
            retentionReason: retention.retentionReason,
            whyTabWasKept: retention.whyTabWasKept,
            resumeAction: retention.resumeAction,
          });
          this.taskTabs.set(this.#tabKey(session.profileInstanceId, taskTab.id), this.taskLedger.getTaskTab(session.profileInstanceId, taskTab.id));
        }
      }
      if (finalCapsule) snapshot.capsule = this.#publicTaskCapsule(finalCapsule);
      return snapshot;
    } finally {
      if (lease) this.#deleteLease(lease.leaseId);
      if (this.taskTargetReservations.get(targetReservationKey) === session.sessionId) this.taskTargetReservations.delete(targetReservationKey);
      snapshot.cleanup.lease_released = true;
      snapshot.completed_at = nowIso();
      const finishedAt = performance.now();
      phaseTimings[currentPhase] = finishedAt - phaseStartedAt;
      snapshot.timings_ms = { total: finishedAt - transactionStartedAt, ...phaseTimings };
      snapshot.outcome = transactionOutcome(snapshot);
      const operationTrace = this.operationTimingContext.getStore();
      if (operationTrace) snapshot.operation_timing = {
        schema: "aos.chrome_companion.operation_timing.v1",
        scope: "this_transaction; durations use separate broker and extension monotonic clocks",
        truncated: operationTrace.truncated,
        operations: structuredClone(operationTrace.operations),
      };
    }
  }

  async #groupTaskTabs(peer, params) {
    const session = this.#requireOwnedSession(peer, params.sessionId);
    const taskId = requireString(params.taskId ?? session.taskId, "taskId");
    const runId = requireString(params.runId, "runId");
    const collapsed = params.collapsed === true;
    if (!session.taskId || session.taskId !== taskId) {
      throw new CompanionError("task_id_mismatch", "Tab-group maintenance taskId does not match the logical session task");
    }
    await this.#assertTaskImplementationAllowed(taskId);
    const payload = { runId, taskId, collapsed };
    await this.taskLedger.verifyAndConsumeAuthority(params.authority, {
      secrets: this.issuerSecrets,
      payload,
      expected: {
        runId,
        taskId,
        ownerKey: session.sessionId,
        method: "task.tabs.group",
        intent: "group_task_tabs",
      },
    });
    const inventory = await this.#executeOperation(peer, { sessionId: session.sessionId, method: "tabs.list", params: {} });
    const inventoryById = new Map(inventory.map((tab) => [tab.id, tab]));
    const candidateEntries = new Map();
    for (const entry of [...this.taskLedger.listTaskTabs(), ...this.taskTabs.values()]) {
      if (entry?.profileInstanceId !== session.profileInstanceId
        || entry.generation !== session.generation
        || entry.taskId !== taskId
        || entry.retentionPolicy === "cleanup"
        || isLedgerOnlyTaskTab(entry)) continue;
      candidateEntries.set(this.#tabKey(entry.profileInstanceId, entry.tabId), entry);
    }
    const candidates = [...candidateEntries.values()]
      .sort((left, right) => left.tabId - right.tabId);
    const result = {
      schema: "aos.chrome_companion.task_tab_group.v1",
      run_id: runId,
      task_id: taskId,
      collapsed,
      grouped: [],
      missing: [],
      busy: [],
      skipped: [],
    };
    let index = 0;
    for (const candidate of candidates) {
      const live = inventoryById.get(candidate.tabId);
      if (!live) {
        this.taskTabs.delete(this.#tabKey(candidate.profileInstanceId, candidate.tabId));
        await this.taskLedger.removeTaskTab(candidate.profileInstanceId, candidate.tabId);
        result.missing.push(candidate.tabId);
        continue;
      }
      const tabKey = this.#tabKey(candidate.profileInstanceId, candidate.tabId);
      if (this.tabLeaseIndex.has(tabKey)) {
        result.busy.push(candidate.tabId);
        continue;
      }
      let origin;
      try { origin = new URL(live.url).origin; } catch { origin = null; }
      if (!origin || origin === "null") {
        result.skipped.push({ tabId: candidate.tabId, reason: "unsupported_origin" });
        continue;
      }
      const lease = await this.#acquireLease(peer, { sessionId: session.sessionId, tabId: candidate.tabId });
      try {
        const rebound = {
          ...candidate,
          runId,
          sessionId: session.sessionId,
          ...rebuildTaskTabIdentity(this.ledgerSecret, candidate, {
            taskId,
            sessionId: session.sessionId,
            // The persisted task-tab is not lease-owned; the lease is bound
            // to this operation and is released in the finally block below.
            leaseId: null,
            generation: session.generation,
            profileInstanceId: session.profileInstanceId,
            tabId: candidate.tabId,
          }),
          updatedAt: nowIso(),
        };
        await this.taskLedger.recordTaskTab(rebound);
        this.taskTabs.set(tabKey, this.taskLedger.getTaskTab(session.profileInstanceId, candidate.tabId));
        const task = { authority: params.authority, runId, taskId, idempotencyKey: params.authority.idempotencyKey, index: index++ };
        const grouped = await this.#executeOperation(peer, {
          sessionId: session.sessionId,
          leaseId: lease.leaseId,
          method: "tabs.groupTask",
          taskOwnedRequired: true,
          params: {
            tabId: candidate.tabId,
            allowedOrigins: [origin],
            targetOrigin: origin,
            collapsed,
          },
        }, { trustedTask: task });
        result.grouped.push({ tabId: candidate.tabId, groupId: grouped.groupId });
      } finally {
        this.#deleteLease(lease.leaseId);
      }
    }
    return result;
  }

  async #cleanupOriginalRestoreDisposal(peer, { session, taskId, runId, preserveTabIds, dryRun, authority }) {
    const expected = {
      operationId: "op_56cf952d-9447-4b16-875a-ca4476d26eda", operationKey: "light-parity-1280-restore-once:1",
      capsuleId: "capsule_41a03eae-b3a8-42ee-9882-0a6e6e171104", taskId: "01a106b1-2e41-7093-b639-dfce60fdf22b",
      runId: "heavy-model-desktop-parity-new-20261005", profileInstanceId: "profile_37fd31b6-ed53-4a35-8604-ab92ffbab05a",
      generation: "gen_62542f46-232b-4ad4-94f2-38f1456e1bf9", sessionId: "session_3553c4d5-3ba1-4ae1-bccf-8a511e6d4ae8",
      tabId: 1980936256, pageInstanceId: "chrome-document:276C41EB36EEF86C4FD3FC33E6419E3D",
      windowId: 1980934932, frameId: 0, origin: "https://jp.linkaigc.com",
      url: "https://jp.linkaigc.com/model-library/model-custom-form",
    };
    const repairedTabSessionId = "session_d95519d6-31cf-431c-8669-a5da43cd306f";
    const previewKey = "heavy-owned-cleanup-disposal-preview-rev3-once";
    const executeKey = "heavy-owned-cleanup-disposal-execute-rev3-once";
    if (authority.idempotencyKey !== (dryRun ? previewKey : executeKey)) {
      throw new CompanionError("owned_cleanup_disposal_key_invalid", "Use the distinct exact preview/execute key with its matching dryRun value");
    }
    const tabKey = this.#tabKey(expected.profileInstanceId, expected.tabId);
    const original = this.taskLedger.get(expected.operationKey);
    const capsule = this.taskLedger.getTaskCapsule(expected.capsuleId);
    const entry = this.taskLedger.getTaskTab(expected.profileInstanceId, expected.tabId);
    const originalSnapshot = canonicalPayload(original), capsuleSnapshot = canonicalPayload(capsule), entrySnapshot = canonicalPayload(entry);
    const result = { schema: "aos.chrome_companion.task_tab_cleanup.v1", run_id: runId, task_id: taskId, dry_run: dryRun,
      profile: { profileInstanceId: session.profileInstanceId, generation: session.generation },
      preserved: [], candidates: [], closed: [], missing: [], busy: [], skipped: [], unknown_effect: [],
      collapse_candidates: [], collapsed: [], collapse_skipped: [], collapse_unknown_effect: [],
      disposal_scope: "exact_original_restore_only", original_unknown_preserved: true };
    const tupleReasons = () => {
      const reasons = [];
      const binding = original?.binding, target = binding?.targetIdentity;
      if (taskId !== expected.taskId || runId !== expected.runId
        || session.profileInstanceId !== expected.profileInstanceId || session.generation !== expected.generation
        || !entry || !taskTabIdentityConsistent(this.ledgerSecret, entry)
        || entry.taskId !== expected.taskId || entry.runId !== expected.runId || entry.capsuleId !== expected.capsuleId
        || entry.profileInstanceId !== expected.profileInstanceId || entry.generation !== expected.generation
        || entry.sessionId !== repairedTabSessionId || entry.targetIdentity?.sessionId !== repairedTabSessionId
        || entry.identityRepairReason !== "same_task_fresh_lease"
        || original?.operationId !== expected.operationId || original.idempotencyKey !== expected.operationKey
        || original.state !== "unknown_effect" || binding?.method !== "page.configureViewport"
        || binding.ownerKey !== expected.sessionId
        || !["taskId", "runId", "sessionId", "profileInstanceId", "generation", "tabId"].every(key => binding?.[key] === expected[key])
        // The original operation/capsule keep their immutable original
        // session. The signed task-tab record has one exact accepted repair
        // lineage, with every non-session target field unchanged.
        || !["taskId", "sessionId", "profileInstanceId", "generation", "tabId", "pageInstanceId", "windowId", "frameId", "origin"].every(key =>
          target?.[key] === expected[key])
        // Capsule ownership is top-level; its normalized target has no taskId.
        || !["sessionId", "profileInstanceId", "generation", "tabId", "pageInstanceId", "windowId", "frameId", "origin"].every(key =>
          capsule?.target?.[key] === expected[key])
        || !["taskId", "profileInstanceId", "generation", "tabId", "pageInstanceId", "windowId", "frameId", "origin"].every(key =>
          entry.targetIdentity?.[key] === expected[key])
        || capsule?.capsuleId !== expected.capsuleId || capsule.taskId !== expected.taskId || capsule.runId !== expected.runId
        || capsule.state !== "failed" || capsule.resources?.tabId !== expected.tabId || capsule.target?.intendedUrl !== expected.url
        || capsule.effect?.failedOperationId !== expected.operationId || capsule.effect?.failedOperationKey !== expected.operationKey
        || capsule.effect?.idempotencyKey !== "light-parity-1280-restore-once" || capsule.effect?.effectState !== "unknown_effect"
        || capsule.effect?.effectClass !== "local_ui" || capsule.retention?.policy !== "retain_until_resume"
        || capsule.retention?.reason !== "local_ui_effect_unknown"
        || entry.retentionPolicy !== "retain_until_resume" || entry.retentionReason !== "local_ui_effect_unknown") reasons.push("original_restore_tuple_mismatch");
      if (preserveTabIds.includes(expected.tabId)) reasons.push("explicit_preserve");
      if (entry?.userHelpRequired === true || capsule?.retention?.userHelpRequired === true) reasons.push("user_help_required");
      if (entry?.resumeToken || capsule?.resumeToken) reasons.push("resume_token");
      if (entry?.quarantine) reasons.push("quarantine");
      if (this.tabLeaseIndex.has(tabKey)) reasons.push("leased");
      if (entry?.sessionId && this.sessions.get(entry.sessionId)?.generation === expected.generation) reasons.push("live_owner_session");
      if ([...this.pendingOperations.values()].some(operation => operation.operationId === expected.operationId
        || operation.profileInstanceId === expected.profileInstanceId && operation.binding?.tabId === expected.tabId)
        || this.operationQueues.has(`tab:${expected.profileInstanceId}:${expected.tabId}`)
        || this.operationQueues.has(`profile:${expected.profileInstanceId}`)) reasons.push("active_broker_operation");
      if (this.taskLedger.listOperations().some(operation => operation.binding?.ownedCleanupDisposal === true
        && operation.binding?.profileInstanceId === expected.profileInstanceId && operation.binding?.tabId === expected.tabId
        && operation.dispatchCount > 0 && !operation.disposalReceipt)) reasons.push("disposal_reconciliation_required");
      return reasons;
    };
    const preserve = reasons => { result.preserved = [{ tabId: expected.tabId, reasons }]; return result; };
    const initialReasons = tupleReasons();
    if (initialReasons.length) return preserve(initialReasons);
    const profile = this.profiles.get(session.profileInstanceId);
    const assertCurrent = ({ queuedClose = false } = {}) => {
      if (this.#requireOwnedSession(peer, session.sessionId) !== session
        || canonicalPayload(this.taskLedger.get(expected.operationKey)) !== originalSnapshot
        || canonicalPayload(this.taskLedger.getTaskCapsule(expected.capsuleId)) !== capsuleSnapshot
        || canonicalPayload(this.taskLedger.getTaskTab(expected.profileInstanceId, expected.tabId)) !== entrySnapshot
        || this.tabLeaseIndex.has(tabKey) || preserveTabIds.includes(expected.tabId)
        || this.sessions.get(expected.sessionId)?.generation === expected.generation
        || this.sessions.get(entry.sessionId)?.generation === expected.generation
        || this.operationQueues.has(`profile:${expected.profileInstanceId}`)
        || !queuedClose && this.operationQueues.has(`tab:${expected.profileInstanceId}:${expected.tabId}`)
        || [...this.pendingOperations.values()].some(operation => operation.operationId === expected.operationId
          || operation.profileInstanceId === expected.profileInstanceId && operation.binding?.tabId === expected.tabId)) {
        throw new CompanionError("owned_cleanup_disposal_binding_changed", "Original owner/profile/generation/tuple and protected-resource guards must remain unchanged");
      }
    };
    const read = (method, params, evidence, queuedClose = false) => this.#enqueue(`session:${session.sessionId}`, () => this.#sendOperation({
      profile, session, method, params, timeoutMs: DEFAULT_OPERATION_TIMEOUTS_MS[method] ?? DEFAULT_OPERATION_TIMEOUT_MS,
      authority: null, idempotencyKey: null, binding: { taskId, runId, sessionId: session.sessionId,
        profileInstanceId: session.profileInstanceId, generation: session.generation, tabId: params.tabId ?? null, method },
      fingerprint: null, allowedOrigins: [expected.origin], targetOrigin: expected.origin, taskTabContext: null,
      dispatchGuard: () => assertCurrent({ queuedClose }), readEvidence: evidence,
    }));
    const inventoryEvidence = {};
    const inventory = await read("tabs.list", {}, inventoryEvidence);
    const validInventory = list => Array.isArray(list) && list.length < 200
      && list.every(tab => Number.isSafeInteger(tab?.id) && tab.id >= 0 && Number.isSafeInteger(tab.windowId) && tab.windowId >= 0)
      && new Set(list.map(tab => tab.id)).size === list.length;
    if (!validInventory(inventory) || inventoryEvidence.brokerEvidence !== true) return preserve(["inventory_incomplete"]);
    const liveReasons = list => {
      const live = list.find(tab => tab.id === expected.tabId);
      if (!live) return ["exact_target_missing"];
      const reasons = [];
      if (live.pinned === true) reasons.push("pinned");
      if (live.active === true) reasons.push("active_tab");
      if (Number.isSafeInteger(live.groupId) && live.groupId >= 0 && list.some(tab => tab.active === true && tab.groupId === live.groupId)) reasons.push("active_group_tab");
      if (live.windowId !== expected.windowId || live.url !== expected.url) reasons.push("live_target_tuple_mismatch");
      return reasons;
    };
    const reasons = liveReasons(inventory);
    if (reasons.length) return preserve(reasons);
    result.candidates = [expected.tabId];
    if (dryRun) return result;
    const snapshotEvidence = {};
    const before = await read("page.snapshot", { tabId: expected.tabId, maxTextChars: 100 }, snapshotEvidence);
    // Real semantic snapshots carry document/URL identity, not windowId.
    // Window identity remains strict in both authenticated inventories.
    if (before.pageInstanceId !== expected.pageInstanceId || before.url !== expected.url
      || new URL(before.url).origin !== expected.origin
      || snapshotEvidence.brokerEvidence !== true || snapshotEvidence.returned !== true
      || snapshotEvidence.method !== "page.snapshot" || snapshotEvidence.sessionId !== session.sessionId
      || snapshotEvidence.profileInstanceId !== expected.profileInstanceId || snapshotEvidence.generation !== expected.generation) {
      return preserve(["live_document_mismatch"]);
    }
    const preCloseBinding = { ...original.binding.targetIdentity, sessionId: session.sessionId, leaseId: null };
    const binding = { taskId, runId, profileInstanceId: session.profileInstanceId, generation: session.generation,
      sessionId: session.sessionId, ownerKey: session.sessionId, tabId: expected.tabId, method: "tabs.close",
      ownedCleanupDisposal: true, targetIdentity: preCloseBinding, targetFingerprint: targetIdentityDigest(this.ledgerSecret, preCloseBinding) };
    const operationParams = { tabId: expected.tabId, pageInstanceId: expected.pageInstanceId, windowId: expected.windowId,
      frameId: expected.frameId, allowedOrigins: [expected.origin], targetOrigin: expected.origin };
    const closeKey = `${executeKey}:${expected.tabId}`;
    const fingerprint = payloadDigest(this.ledgerSecret, { binding, payload: operationParams });
    const prepared = await this.taskLedger.prepare({ idempotencyKey: closeKey, binding, fingerprint });
    if (prepared.state !== "prepared") return preserve([`idempotency:${prepared.state}`]);
    try {
      const ack = await this.#enqueue(`tab:${expected.profileInstanceId}:${expected.tabId}`, async () => {
        // The worker checks origins, but does not check pinned/active/group
        // state. Re-read those protections after the document snapshot and
        // inside the exact-tab queue, immediately before this single close.
        const evidence = {};
        const latest = await read("tabs.list", {}, evidence, true);
        const reasons = validInventory(latest) && evidence.brokerEvidence === true
          ? liveReasons(latest) : ["inventory_incomplete"];
        if (reasons.length) throw new CompanionError("owned_cleanup_disposal_protected", reasons.join(","));
        return this.#sendOperation({
          profile, session, method: "tabs.close", params: operationParams, timeoutMs: DEFAULT_OPERATION_TIMEOUTS_MS["tabs.close"],
          authority, idempotencyKey: closeKey, binding, fingerprint, allowedOrigins: [expected.origin], targetOrigin: expected.origin,
          taskTabContext: null, dispatchGuard: () => assertCurrent({ queuedClose: true }),
        });
      });
      const close = this.taskLedger.get(closeKey);
      const absenceEvidence = {};
      const after = await read("tabs.list", {}, absenceEvidence);
      if (ack?.closed !== true || ack.closedExpected !== true || ack.tabId !== expected.tabId
        || close?.state !== "applied" || close.brokerEvidence !== true
        || !validInventory(after) || absenceEvidence.brokerEvidence !== true || absenceEvidence.returned !== true
        || after.some(tab => tab.id === expected.tabId)) {
        throw new CompanionError("owned_cleanup_disposal_absence_unverified", "Authenticated complete unfiltered inventory must prove exact-target absence below the 200-tab cap");
      }
      assertCurrent();
      const payload = { schema: "aos.chrome_companion.owned_tab_disposal_receipt.v1", taskId, runId,
        profileInstanceId: session.profileInstanceId, generation: session.generation, sessionId: session.sessionId,
        tabId: expected.tabId, closeOperationKey: closeKey, closeOperationId: close.operationId,
        closeResultDigest: close.resultDigest, preCloseBinding,
        originalSource: { operationId: expected.operationId, operationKey: expected.operationKey, capsuleId: expected.capsuleId },
        absence: { exactTargetAbsent: true, inventoryParams: {}, inventoryCap: 200, inventoryIds: after.map(tab => tab.id), inventoryEvidence: absenceEvidence },
        originalUnknownPreserved: true, originalAcknowledgementClaimed: false, viewportRestoreClaimed: false,
        cancellationClaimed: false, replayAllowed: false, capturedAt: nowIso() };
      result.disposal_receipt = { ...payload, signature: payloadDigest(this.ledgerSecret, payload) };
      await this.taskLedger.transition(closeKey, "applied", { disposalReceipt: result.disposal_receipt });
      this.taskTabs.delete(tabKey);
      await this.taskLedger.removeTaskTab(expected.profileInstanceId, expected.tabId);
      result.closed = [expected.tabId];
    } catch (error) {
      if (this.taskLedger.get(closeKey)?.dispatchCount > 0) result.unknown_effect.push({ tabId: expected.tabId,
        code: error.code ?? "owned_cleanup_disposal_unknown", replay_allowed: false });
      else result.skipped.push({ tabId: expected.tabId, reason: error.code ?? "owned_cleanup_disposal_failed" });
    }
    return result;
  }

  async #cleanupTaskTabs(peer, params) {
    const session = this.#requireOwnedSession(peer, params.sessionId);
    const taskId = requireString(params.taskId ?? session.taskId, "taskId");
    const runId = requireString(params.runId, "runId");
    if (!session.taskId || session.taskId !== taskId) {
      throw new CompanionError("task_id_mismatch", "Tab cleanup taskId does not match the logical session task");
    }
    await this.#assertTaskImplementationAllowed(taskId);
    if (!Array.isArray(params.preserveTabIds)) {
      throw new CompanionError("preserve_tab_ids_required", "Tab cleanup requires an explicit preserveTabIds array");
    }
    if (params.preserveTabIds.length > 500) {
      throw new CompanionError("preserve_tab_ids_too_large", "Tab cleanup preserveTabIds exceeds the supported limit");
    }
    const preserveTabIds = [...new Set(params.preserveTabIds.map((value) => requireTabId(value)))].sort((left, right) => left - right);
    const dryRun = params.dryRun === true;
    const payload = { runId, taskId, preserveTabIds, dryRun };
    const authority = params.authority;
    await this.taskLedger.verifyAndConsumeAuthority(authority, {
      secrets: this.issuerSecrets,
      payload,
      expected: {
        runId,
        taskId,
        ownerKey: session.sessionId,
        method: "maintenance.tabs.cleanup",
        intent: "cleanup_task_tabs",
      },
    });

    // A disposal-key request (including an invalid member) or this exact
    // accepted historical run never falls into ordinary broad cleanup.
    if (String(authority.idempotencyKey).startsWith("heavy-owned-cleanup-disposal-")
      || taskId === "01a106b1-2e41-7093-b639-dfce60fdf22b" && runId === "heavy-model-desktop-parity-new-20261005") {
      return this.#cleanupOriginalRestoreDisposal(peer, { session, taskId, runId, preserveTabIds, dryRun, authority });
    }

    const inventory = await this.#executeOperation(peer, {
      sessionId: session.sessionId,
      method: "tabs.list",
      params: {},
    });
    const liveById = new Map(inventory.map((tab) => [tab.id, tab]));
    const activeGroupIds = new Set(
      inventory
        .filter((tab) => tab?.active === true && Number.isSafeInteger(tab.groupId) && tab.groupId >= 0)
        .map((tab) => tab.groupId),
    );
    const preserveSet = new Set(preserveTabIds);
    const liveSessionIds = new Set(
      [...this.sessions.values()]
        .filter((entry) => entry.profileInstanceId === session.profileInstanceId && entry.generation === session.generation)
        .map((entry) => entry.sessionId),
    );
    // A discovered task tab is safe to remove only when no operation for the
    // same task is still pending or in timeout reconciliation.  Keep this
    // derived set local to the cleanup request so a broker restart cannot
    // leave the decision dependent on a stale module/global variable.
    const pendingTaskIds = new Set([
      ...[...this.pendingOperations.values()].map((operation) => operation.binding?.taskId ?? operation.taskTabContext?.taskId),
      ...[...this.timedOutOperations.values()].map((operation) => operation.binding?.taskId ?? operation.taskTabContext?.taskId),
    ].filter(Boolean));
    const result = {
      schema: "aos.chrome_companion.task_tab_cleanup.v1",
      run_id: runId,
      task_id: taskId,
      dry_run: dryRun,
      profile: {
        profileInstanceId: session.profileInstanceId,
        generation: session.generation,
      },
      preserved: [],
      candidates: [],
      closed: [],
      missing: [],
      busy: [],
      skipped: [],
      unknown_effect: [],
      // Reconciliation/unknown-effect tabs are retained for evidence, but
      // old unleased ones are folded into their task group so the browser
      // surface does not grow without bound.
      collapse_candidates: [],
      collapsed: [],
      collapse_skipped: [],
      collapse_unknown_effect: [],
    };

    const candidates = [];
    const collapseCandidates = [];
    const missing = [];
    // Include persisted ledger records as well as the in-memory index.  A
    // broker restart can leave old task tabs only in the durable ledger; if
    // cleanup scanned the map alone those tabs would multiply forever.
    const taskEntries = new Map();
    for (const entry of [...this.taskLedger.listTaskTabs(), ...this.taskTabs.values()]) {
      if (entry?.profileInstanceId !== session.profileInstanceId || entry.taskId !== taskId) continue;
      taskEntries.set(this.#tabKey(entry.profileInstanceId, entry.tabId), entry);
    }
    for (const entry of [...taskEntries.values()]
      .sort((left, right) => left.tabId - right.tabId)) {
      const live = liveById.get(entry.tabId);
      if (!live) {
        missing.push(entry);
        result.missing.push(entry.tabId);
        continue;
      }
      const reasons = [];
      if (preserveSet.has(entry.tabId)) reasons.push("explicit_preserve");
      if (live.pinned === true) reasons.push("pinned");
      if (live.active === true) reasons.push("active_tab");
      if (Number.isSafeInteger(live.groupId) && activeGroupIds.has(live.groupId)) reasons.push("active_group_tab");
      if (this.tabLeaseIndex.has(this.#tabKey(entry.profileInstanceId, entry.tabId))) reasons.push("leased");
      if (entry.sessionId && liveSessionIds.has(entry.sessionId) && entry.lifecycleState !== "completed") reasons.push("live_owner_session");
      if (entry.userHelpRequired === true) reasons.push("user_help_required");
      const ledgerOnly = isLedgerOnlyTaskTab(entry);
      if (!ledgerOnly && TAB_CLEANUP_PROTECTED_RETENTION.has(entry.retentionPolicy)) reasons.push(`retention:${entry.retentionPolicy}`);
      if (entry.resumeToken) reasons.push("resume_token");
      if (!ledgerOnly && TAB_CLEANUP_PROTECTED_LIFECYCLES.has(entry.lifecycleState)) reasons.push(`lifecycle:${entry.lifecycleState}`);
      let origin = null;
      try { origin = new URL(live.url).origin; } catch { /* unsupported browser-internal URL */ }
      if (!origin || origin === "null") reasons.push("unsupported_origin");
      const terminalRetainedTab = TASK_TAB_TERMINAL_LIFECYCLES.has(entry.lifecycleState)
        && entry.retentionPolicy === "retain"
        && !entry.resumeToken
        && entry.userHelpRequired !== true;
      const orphanedDiscoveredTab = isSafePreEffectTaskTab(entry, {
        sessionId: session.sessionId,
        liveSessionIds,
        pendingTaskIds,
      });
      if (entry.lifecycleState === "discovered" && pendingTaskIds.has(entry.taskId)) reasons.push("operation_pending");
      const cleanupEligible = entry.retentionPolicy === "cleanup"
        || entry.quarantine === "stale_generation"
        || terminalRetainedTab
        || orphanedDiscoveredTab
        || ledgerOnly;
      if (!cleanupEligible) reasons.push("not_cleanup_eligible");
      if (reasons.length > 0) {
        const retention = taskTabRetentionExplanation(entry, reasons);
        const preserved = {
          tabId: entry.tabId,
          reasons,
          user_help_required: entry.userHelpRequired === true,
          retention_reason: retention.retentionReason,
          why_tab_was_kept: retention.whyTabWasKept,
          required_user_action: entry.requiredUserAction ?? null,
          resume_action: retention.resumeAction,
        };
        if (isVisualCollapseEligibleTaskTab(entry, reasons, origin)) {
          result.collapse_candidates.push(entry.tabId);
          collapseCandidates.push({ entry, live, origin });
          preserved.visual_cleanup = "collapse_task_group";
        }
        result.preserved.push(preserved);
        continue;
      }
      candidates.push({ entry, live, origin });
      result.candidates.push(entry.tabId);
    }

    if (dryRun) return result;
    for (const entry of missing) {
      this.taskTabs.delete(this.#tabKey(entry.profileInstanceId, entry.tabId));
      await this.taskLedger.removeTaskTab(entry.profileInstanceId, entry.tabId);
    }
    let collapseIndex = 0;
    for (const candidate of collapseCandidates) {
      const { entry, origin } = candidate;
      const tabKey = this.#tabKey(entry.profileInstanceId, entry.tabId);
      if (this.tabLeaseIndex.has(tabKey)) {
        result.collapse_skipped.push({ tabId: entry.tabId, reason: "leased" });
        continue;
      }
      let lease;
      try {
        lease = await this.#acquireLease(peer, { sessionId: session.sessionId, tabId: entry.tabId });
        const task = {
          authority,
          runId,
          taskId,
          idempotencyKey: authority.idempotencyKey,
          // Keep visual-maintenance idempotency keys separate from any close
          // operation that the same cleanup authority may dispatch below.
          index: 100_000 + collapseIndex++,
          allowVisualMaintenance: true,
        };
        const grouped = await this.#executeOperation(peer, {
          sessionId: session.sessionId,
          leaseId: lease.leaseId,
          method: "tabs.groupTask",
          taskOwnedRequired: true,
          params: {
            tabId: entry.tabId,
            taskId,
            taskLabel: session.label,
            allowedOrigins: [origin],
            targetOrigin: origin,
            collapsed: true,
            // This marker is consumed only by the broker's narrow ownership
            // exception below; it never authorizes page/provider mutation.
            visualOnlyCleanup: true,
          },
        }, { trustedTask: task });
        result.collapsed.push({ tabId: entry.tabId, groupId: grouped.groupId });
      } catch (error) {
        if (error?.code === "operation_effect_unknown") {
          // Do not retry an uncertain group update.  It is visual-only, but
          // the normal no-replay ledger rule still applies.
          result.collapse_unknown_effect.push({ tabId: entry.tabId, code: error.code });
        } else {
          result.collapse_skipped.push({ tabId: entry.tabId, reason: error?.code ?? "task_group_collapse_failed" });
        }
      } finally {
        if (lease) this.#deleteLease(lease.leaseId);
      }
    }
    for (const candidate of candidates) {
      const { entry, origin } = candidate;
      const tabKey = this.#tabKey(entry.profileInstanceId, entry.tabId);
      if (this.tabLeaseIndex.has(tabKey)) {
        result.busy.push(entry.tabId);
        continue;
      }
      const idempotencyKey = `${authority.idempotencyKey}:${entry.tabId}`;
      const operationParams = { tabId: entry.tabId };
      const binding = {
        runId,
        profileInstanceId: session.profileInstanceId,
        generation: session.generation,
        sessionId: session.sessionId,
        ownerKey: session.sessionId,
        tabId: entry.tabId,
        method: "tabs.close",
        taskId,
      };
      const fingerprint = payloadDigest(this.ledgerSecret, { binding, payload: operationParams });
      const prepared = await this.taskLedger.prepare({ idempotencyKey, fingerprint, binding });
      if (prepared.state !== "prepared") {
        result.skipped.push({ tabId: entry.tabId, reason: `idempotency:${prepared.state}` });
        continue;
      }
      try {
        await this.#enqueue(`tab:${session.profileInstanceId}:${entry.tabId}`, () => this.#sendOperation({
          profile: this.profiles.get(session.profileInstanceId),
          session,
          method: "tabs.close",
          params: operationParams,
          timeoutMs: DEFAULT_OPERATION_TIMEOUTS_MS["tabs.close"],
          authority,
          idempotencyKey,
          binding,
          fingerprint,
          allowedOrigins: [origin],
          targetOrigin: origin,
          taskTabContext: null,
        }));
        result.closed.push(entry.tabId);
      } catch (error) {
        if (error?.code === "operation_effect_unknown") {
          result.unknown_effect.push({ tabId: entry.tabId, code: error.code });
          if (isLedgerOnlyTaskTab(entry)) {
            // The close acknowledgement is independent from the original
            // provider effect.  Remove only the browser-tab record so this
            // task can continue from a fresh target on the next run.
            this.taskTabs.delete(tabKey);
            await this.taskLedger.removeTaskTab(entry.profileInstanceId, entry.tabId);
          }
        } else {
          result.skipped.push({ tabId: entry.tabId, reason: error?.code ?? "cleanup_close_failed" });
        }
      }
    }
    return result;
  }

  async #purgeMissingTaskTabs(peer, params) {
    const session = this.#requireOwnedSession(peer, params.sessionId);
    if (!session.taskId) {
      throw new CompanionError("task_id_required", "Missing task-tab purge requires a task-bound logical session");
    }
    const runId = requireString(params.runId, "runId");
    const profileInstanceId = requireString(params.profileInstanceId ?? session.profileInstanceId, "profileInstanceId");
    if (profileInstanceId !== session.profileInstanceId) {
      throw new CompanionError("profile_id_mismatch", "Missing task-tab purge profile does not match the logical session");
    }
    if (params.confirmMissingOnly !== true) {
      throw new CompanionError(
        "missing_record_purge_confirmation_required",
        "Missing task-tab purge requires explicit confirmation that only absent tabs may be removed",
      );
    }
    if (!Array.isArray(params.tabIds) || params.tabIds.length === 0) {
      throw new CompanionError("tab_ids_required", "Missing task-tab purge requires at least one exact tab ID");
    }
    if (params.tabIds.length > 500) {
      throw new CompanionError("tab_ids_too_large", "Missing task-tab purge tabIds exceeds the supported limit");
    }
    const tabIds = [...new Set(params.tabIds.map((value) => requireTabId(value)))].sort((left, right) => left - right);
    const payload = {
      runId,
      tabIds,
      confirmMissingOnly: true,
      profileInstanceId,
    };
    await this.taskLedger.verifyAndConsumeAuthority(params.authority, {
      secrets: this.issuerSecrets,
      payload,
      expected: {
        runId,
        taskId: session.taskId,
        ownerKey: session.sessionId,
        method: "maintenance.tabs.purge_missing",
        intent: "purge_missing_task_tabs",
      },
    });

    // The destructive boundary is record removal only. We require a fresh
    // live inventory and refuse to remove any record whose tab is still
    // present, so this path cannot accidentally close or adopt a live tab.
    const inventory = await this.#executeOperation(peer, {
      sessionId: session.sessionId,
      method: "tabs.list",
      params: {},
    });
    if (!Array.isArray(inventory)) {
      throw new CompanionError("live_tab_inventory_unavailable", "Could not prove that requested tabs are absent");
    }
    const liveById = new Map(inventory.map((tab) => [tab.id, tab]));
    const liveSessionIds = new Set(
      [...this.sessions.values()]
        .filter((entry) => entry.profileInstanceId === profileInstanceId)
        .map((entry) => entry.sessionId),
    );
    const result = {
      schema: "aos.chrome_companion.missing_task_tab_purge.v1",
      run_id: runId,
      requester_task_id: session.taskId,
      requester_session_id: session.sessionId,
      profile_instance_id: profileInstanceId,
      generation: session.generation,
      requested_tab_ids: tabIds,
      live_tab_ids: [],
      purged_tab_ids: [],
      already_missing_untracked_tab_ids: [],
      retained: [],
      external_action_executed: false,
      tabs_close_dispatched: false,
      owner_scope: "explicit_user_approved_missing_record_only",
      recorded_at: nowIso(),
    };

    for (const tabId of tabIds) {
      if (liveById.has(tabId)) {
        result.live_tab_ids.push(tabId);
        result.retained.push({ tabId, reason: "live_tab_present" });
        continue;
      }
      const key = this.#tabKey(profileInstanceId, tabId);
      const entry = this.taskTabs.get(key) || this.taskLedger.getTaskTab(profileInstanceId, tabId);
      if (!entry) {
        result.already_missing_untracked_tab_ids.push(tabId);
        continue;
      }
      const reasons = [];
      if (entry.quarantine !== "stale_generation") reasons.push("not_stale_generation");
      if (!MISSING_RECORD_PURGE_LIFECYCLES.has(entry.lifecycleState)) reasons.push(`lifecycle:${entry.lifecycleState ?? "unknown"}`);
      if (entry.userHelpRequired === true) reasons.push("user_help_required");
      if (this.tabLeaseIndex.has(key)) reasons.push("leased");
      if (entry.sessionId && liveSessionIds.has(entry.sessionId)) reasons.push("live_owner_session");
      if (!taskTabIdentityConsistent(this.ledgerSecret, entry)) reasons.push("identity_inconsistent");
      if (reasons.length > 0) {
        result.retained.push({ tabId, reason: reasons.join(",") });
        continue;
      }
      this.taskTabs.delete(key);
      await this.taskLedger.removeTaskTab(profileInstanceId, tabId);
      result.purged_tab_ids.push(tabId);
    }
    result.ok = result.live_tab_ids.length === 0 && result.retained.length === 0;
    result.status = result.ok ? "completed" : "partial";
    return result;
  }

  /**
   * Retire one abandoned local canary after its owner process has gone away.
   * This is intentionally not part of normal task cleanup: foreign user tabs
   * and provider pages can never reach this path. The route requires a fresh
   * inventory, an exact synthetic task/run shape, no live owner/lease, and a
   * one-time signed maintenance authority. It closes only the local canary
   * tab and removes its task-tab record; the unknown operation ledger entry is
   * retained as evidence and is never replayed or rewritten.
   */
  async #retireLocalCanary(peer, params) {
    const session = this.#requireOwnedSession(peer, params.sessionId);
    if (!session.taskId) throw new CompanionError("task_id_required", "Local canary retirement requires a task-bound logical session");
    const runId = requireString(params.runId, "runId");
    const tabId = requireTabId(params.tabId);
    const profileInstanceId = requireString(params.profileInstanceId ?? session.profileInstanceId, "profileInstanceId");
    if (profileInstanceId !== session.profileInstanceId) {
      throw new CompanionError("profile_id_mismatch", "Local canary retirement profile does not match the logical session");
    }
    if (params.confirmSyntheticCanary !== true) {
      throw new CompanionError(
        "synthetic_canary_retirement_confirmation_required",
        "Local canary retirement requires explicit confirmation of the synthetic-only scope",
      );
    }
    const payload = {
      runId,
      tabId,
      profileInstanceId,
      confirmSyntheticCanary: true,
    };
    await this.taskLedger.verifyAndConsumeAuthority(params.authority, {
      secrets: this.issuerSecrets,
      payload,
      expected: {
        runId,
        taskId: session.taskId,
        ownerKey: session.sessionId,
        method: "maintenance.tabs.retire_local_canary",
        intent: "retire_local_canary",
      },
    });

    const inventory = await this.#executeOperation(peer, {
      sessionId: session.sessionId,
      method: "tabs.list",
      params: {},
    });
    if (!Array.isArray(inventory)) throw new CompanionError("live_tab_inventory_unavailable", "Could not prove the local canary tab state");
    const live = inventory.find((entry) => entry.id === tabId);
    const key = this.#tabKey(profileInstanceId, tabId);
    const taskTab = this.taskTabs.get(key) || this.taskLedger.getTaskTab(profileInstanceId, tabId);
    if (!taskTab) {
      return {
        schema: "aos.chrome_companion.local_canary_retirement.v1",
        status: "already_missing",
        retired: false,
        tab_id: tabId,
        record_removed: false,
        external_action_executed: false,
        unknown_effect_retained: false,
      };
    }
    if (taskTab.taskId !== session.taskId) {
      throw new CompanionError("task_id_mismatch", "Local canary retirement cannot close another task's tab");
    }
    if (taskTab.runId !== runId || !isSyntheticCanaryTask(taskTab, live ?? { url: taskTab.targetIdentity?.origin })) {
      throw new CompanionError(
        "synthetic_canary_target_invalid",
        "The exact tab is not an abandoned local synthetic canary",
        { tabId, taskId: taskTab.taskId ?? null, runId: taskTab.runId ?? null, url: live?.url ?? null },
      );
    }
    const liveSessionIds = new Set(
      [...this.sessions.values()]
        .filter((entry) => entry.profileInstanceId === profileInstanceId)
        .map((entry) => entry.sessionId),
    );
    if (taskTab.sessionId && liveSessionIds.has(taskTab.sessionId)) {
      throw new CompanionError("synthetic_canary_owner_active", "The canary still has a live owner session");
    }
    if (this.tabLeaseIndex.has(key)) throw new CompanionError("synthetic_canary_lease_active", "The canary still has an active tab lease");
    const busy = [...this.pendingOperations.values(), ...this.timedOutOperations.values()].filter((operation) =>
      operation.profileInstanceId === profileInstanceId
      && (operation.binding?.tabId === tabId || operation.binding?.taskId === taskTab.taskId || operation.taskTabContext?.taskId === taskTab.taskId));
    if (busy.length > 0) {
      throw new CompanionError("synthetic_canary_operation_active", "The canary still has an active or timed-out operation", {
        operationIds: busy.map((operation) => operation.operationId),
      });
    }
    if (!live) {
      this.taskTabs.delete(key);
      await this.taskLedger.removeTaskTab(profileInstanceId, tabId);
      return {
        schema: "aos.chrome_companion.local_canary_retirement.v1",
        status: "record_removed",
        retired: true,
        tab_id: tabId,
        task_id: taskTab.taskId,
        run_id: runId,
        record_removed: true,
        external_action_executed: false,
        unknown_effect_retained: true,
      };
    }
    if (live.pinned === true || live.active === true) {
      throw new CompanionError("synthetic_canary_tab_protected", "The local canary is active or pinned and cannot be retired automatically", {
        tabId,
        active: live.active === true,
        pinned: live.pinned === true,
      });
    }
    const origin = new URL(live.url).origin;
    const idempotencyKey = requireString(params.idempotencyKey, "idempotencyKey");
    const operationParams = { tabId };
    const binding = {
      runId,
      profileInstanceId,
      generation: session.generation,
      sessionId: session.sessionId,
      ownerKey: session.sessionId,
      tabId,
      method: "tabs.close",
      taskId: taskTab.taskId,
      targetIdentity: normalizeTargetIdentity({
        taskId: taskTab.taskId,
        sessionId: session.sessionId,
        generation: session.generation,
        profileInstanceId,
        tabId,
        windowId: live.windowId,
        origin,
      }),
    };
    const fingerprint = payloadDigest(this.ledgerSecret, { binding, payload: operationParams });
    const prepared = await this.taskLedger.prepare({ idempotencyKey, fingerprint, binding });
    if (prepared.state !== "prepared") {
      throw new CompanionError("idempotency_duplicate", "This local canary retirement has already been dispatched", {
        state: prepared.state,
        operationId: prepared.operationId,
      });
    }
    const closed = await this.#enqueue(`tab:${profileInstanceId}:${tabId}`, () => this.#sendOperation({
      profile: this.profiles.get(profileInstanceId),
      session,
      method: "tabs.close",
      params: operationParams,
      timeoutMs: DEFAULT_OPERATION_TIMEOUTS_MS["tabs.close"],
      authority: params.authority,
      idempotencyKey,
      binding,
      fingerprint,
      allowedOrigins: [origin],
      targetOrigin: origin,
      taskTabContext: null,
    }));
    return {
      schema: "aos.chrome_companion.local_canary_retirement.v1",
      status: "retired",
      retired: true,
      tab_id: tabId,
      task_id: taskTab.taskId,
      run_id: runId,
      closed,
      record_removed: !this.taskTabs.has(key),
      external_action_executed: false,
      tab_close_executed: true,
      unknown_effect_retained: true,
      evidence_preserved: true,
      replayed: false,
    };
  }

  async #repairPreDispatchReadonly(peer, params) {
    const session = this.#requireOwnedSession(peer, params.sessionId);
    const taskId = requireString(params.taskId ?? session.taskId, "taskId");
    if (session.taskId !== taskId) {
      throw new CompanionError("task_id_mismatch", "Pre-dispatch repair taskId does not match the logical session task");
    }
    if (params.confirmNoEffect !== true) {
      throw new CompanionError("pre_dispatch_repair_confirmation_required", "Pre-dispatch repair requires explicit no-effect confirmation");
    }
    const runId = requireString(params.runId, "runId");
    const idempotencyKey = requireString(params.idempotencyKey, "idempotencyKey");
    const capsuleId = requireString(params.capsuleId, "capsuleId");
    const profileInstanceId = requireString(params.profileInstanceId, "profileInstanceId");
    const tabId = requireTabId(params.tabId);
    if (profileInstanceId !== session.profileInstanceId) {
      throw new CompanionError("profile_instance_mismatch", "Pre-dispatch repair profile does not match the logical session profile");
    }
    const capsule = this.taskLedger.getTaskCapsule(capsuleId);
    const taskTab = this.taskLedger.getTaskTab(profileInstanceId, tabId);
    if (!capsule || !taskTab || capsule.taskId !== taskId || capsule.runId !== runId
      || capsule.effect?.idempotencyKey !== idempotencyKey
      || taskTab.taskId !== taskId || taskTab.runId !== runId) {
      throw new CompanionError("pre_dispatch_repair_target_mismatch", "Pre-dispatch repair does not match the exact task-owned capsule and tab");
    }
    if (capsule.target?.generation !== session.generation || taskTab.generation !== session.generation) {
      throw new CompanionError("pre_dispatch_repair_generation_mismatch", "Pre-dispatch repair requires the current connected profile generation");
    }
    const inventory = await this.#executeOperation(peer, {
      sessionId: session.sessionId,
      method: "tabs.list",
      params: {},
    });
    const live = inventory.find((tab) => tab.id === tabId);
    if (!live) {
      throw new CompanionError("pre_dispatch_repair_tab_missing", "The exact protected task tab is no longer open");
    }
    if (live.pinned === true) {
      throw new CompanionError("pre_dispatch_repair_tab_protected", "Pinned tabs cannot be repaired automatically");
    }
    const expectedUrl = typeof capsule.target?.targetKey === "string" && capsule.target.targetKey.startsWith("url:")
      ? capsule.target.targetKey.slice(4)
      : null;
    if (expectedUrl && live.url !== expectedUrl) {
      throw new CompanionError("pre_dispatch_repair_target_mismatch", "The live task tab URL does not match the protected capsule target");
    }
    let liveOrigin = null;
    try { liveOrigin = new URL(live.url).origin; } catch { /* rejected below */ }
    if (!liveOrigin || !capsule.target.allowedOrigins?.includes(liveOrigin)) {
      throw new CompanionError("pre_dispatch_repair_origin_mismatch", "The live task tab is outside the protected capsule origin");
    }
    const payload = repairPreDispatchReadonlyPayload({
      runId,
      taskId,
      idempotencyKey,
      capsuleId,
      profileInstanceId,
      tabId,
      confirmNoEffect: true,
    });
    await this.taskLedger.verifyAndConsumeAuthority(params.authority, {
      secrets: this.issuerSecrets,
      payload,
      expected: {
        runId,
        taskId,
        ownerKey: session.sessionId,
        method: "task.reconciliation.repair_pre_dispatch",
        intent: "repair_pre_dispatch_readonly_failure",
      },
    });
    const repaired = await this.taskLedger.repairPreDispatchReadonlyFailure({
      capsuleId,
      taskId,
      runId,
      idempotencyKey,
      profileInstanceId,
      tabId,
      readback: { url: live.url, title: live.title ?? null },
    });
    this.taskTabs.set(this.#tabKey(profileInstanceId, tabId), this.taskLedger.getTaskTab(profileInstanceId, tabId));
    return {
      schema: "aos.chrome_companion.pre_dispatch_readonly_repair.v1",
      status: "reclassified_pre_dispatch_failure",
      capsule: this.#publicTaskCapsule(repaired.capsule),
      taskTab: repaired.taskTab,
      mutationDispatchAttempted: false,
      externalActionExecuted: false,
      replayAllowed: false,
      terminalCleanupReady: true,
    };
  }

  async #archiveReconciliation(peer, params) {
    const session = this.#requireOwnedSession(peer, params.sessionId);
    if (!session.taskId) {
      throw new CompanionError("task_id_required", "Reconciliation archive requires a task-bound logical session");
    }
    const runId = requireString(params.runId, "runId");
    const taskId = requireString(params.taskId ?? session.taskId, "taskId");
    if (taskId !== session.taskId) {
      throw new CompanionError("task_id_mismatch", "Reconciliation archive taskId does not match the logical session task");
    }
    if (params.confirmArchiveOnly !== true) {
      throw new CompanionError(
        "archive_only_confirmation_required",
        "Reconciliation archive requires explicit confirmation that no state, evidence, replay, or deletion is requested",
      );
    }
    if (!Array.isArray(params.operationIds) || params.operationIds.length === 0) {
      throw new CompanionError("operation_ids_required", "Reconciliation archive requires at least one exact operation id");
    }
    if (params.operationIds.length > 500) {
      throw new CompanionError("operation_ids_too_large", "Reconciliation archive operationIds exceeds the supported limit");
    }
    const idempotencyKey = requireString(params.idempotencyKey, "idempotencyKey");
    const payload = archiveReconciliationPayload({
      runId,
      taskId,
      operationIds: params.operationIds,
      reason: params.reason,
      confirmArchiveOnly: true,
    });
    await this.taskLedger.verifyAndConsumeAuthority(params.authority, {
      secrets: this.issuerSecrets,
      payload,
      expected: {
        runId,
        taskId,
        ownerKey: session.sessionId,
        method: "maintenance.operations.archive",
        intent: "archive_reconciliation_records",
        idempotencyKey,
      },
    });
    const archived = await this.taskLedger.archiveOperations({
      taskId,
      runId,
      operationIds: payload.operationIds,
      archiveId: idempotencyKey,
      reason: payload.reason,
      archiveAuthorityId: params.authority.authorityId,
    });
    const counts = this.taskLedger.getReconciliationCounts();
    return {
      schema: "aos.chrome_companion.reconciliation_archive.v1",
      status: "archived",
      run_id: runId,
      task_id: taskId,
      archive_id: archived.archiveId,
      archived_at: archived.archivedAt,
      archived: archived.archived,
      already_archived: archived.alreadyArchived,
      archived_count: archived.archived.length,
      already_archived_count: archived.alreadyArchived.length,
      state_unchanged: true,
      evidence_preserved: true,
      external_action_executed: false,
      mutation_dispatch_attempted: false,
      scheduler_gate: {
        reconciliation_pending_count: this.timedOutOperations.size + counts.pendingTotal,
        reconciliation_pending_visible_count: this.timedOutOperations.size + counts.pendingVisible,
        reconciliation_pending_archived_count: counts.pendingArchived,
        unchanged: true,
      },
      next_action: "owner_signed_readback_before_reconciliation_completion",
    };
  }

  async #purgeOwnedOperations(peer, params) {
    const session = this.#requireOwnedSession(peer, params.sessionId);
    if (!session.taskId) throw new CompanionError("task_id_required", "Operation purge requires a task-bound logical session");
    const runId = requireString(params.runId, "runId");
    const taskId = requireString(params.taskId ?? session.taskId, "taskId");
    if (taskId !== session.taskId) throw new CompanionError("task_id_mismatch", "Operation purge taskId does not match the logical session task");
    if (params.confirmPurge !== true) throw new CompanionError("purge_confirmation_required", "Operation purge requires explicit confirmation");
    if (!Array.isArray(params.operationIds) || params.operationIds.length < 1 || params.operationIds.length > 500) {
      throw new CompanionError("operation_ids_invalid", "Operation purge requires 1 to 500 exact operation ids");
    }
    const idempotencyKey = requireString(params.idempotencyKey, "idempotencyKey");
    const payload = {
      runId,
      taskId,
      operationIds: params.operationIds,
      confirmPurge: true,
    };
    await this.taskLedger.verifyAndConsumeAuthority(params.authority, {
      secrets: this.issuerSecrets,
      payload,
      expected: {
        runId,
        taskId,
        ownerKey: session.sessionId,
        method: "maintenance.operations.purge",
        intent: "purge_terminal_owned_operations",
        idempotencyKey,
      },
    });
    const purged = await this.taskLedger.purgeOwnedOperations({
      taskId,
      runId,
      operationIds: payload.operationIds,
      purgeId: idempotencyKey,
      purgeAuthorityId: params.authority.authorityId,
    });
    return {
      schema: "aos.chrome_companion.operation_purge.v1",
      status: "purged",
      task_id: taskId,
      run_id: runId,
      purge_id: purged.purgeId,
      purged_count: purged.purgedCount,
      operation_ids: purged.operationIds,
      foreign_operations_mutated: false,
      unresolved_operations_mutated: false,
      next_action: "close_task_session_and_verify_owner_scoped_status",
    };
  }

  async #transferHandoffTabs(peer, params) {
    const session = this.#requireOwnedSession(peer, params.sessionId);
    const sourceTaskId = requireString(params.sourceTaskId, "sourceTaskId");
    const destinationTaskId = requireString(params.destinationTaskId ?? session.taskId, "destinationTaskId");
    const runId = requireString(params.runId, "runId");
    const receiptPath = requireString(params.receiptPath, "receiptPath");
    if (!session.taskId || session.taskId !== destinationTaskId) {
      throw new CompanionError("task_id_mismatch", "Handoff destination must match the current logical session task");
    }
    if (sourceTaskId === destinationTaskId) {
      throw new CompanionError("handoff_task_identity_invalid", "Handoff source and destination tasks must differ");
    }
    await this.#assertTaskImplementationAllowed(destinationTaskId);
    const payload = { runId, sourceTaskId, destinationTaskId, receiptPath };
    await this.taskLedger.verifyAndConsumeAuthority(params.authority, {
      secrets: this.issuerSecrets,
      payload,
      expected: {
        runId,
        taskId: destinationTaskId,
        ownerKey: session.sessionId,
        method: "task.tabs.transfer",
        intent: "transfer_handoff_tabs",
      },
    });
    const validated = await validateHandoffReceipt({
      receiptPath,
      receiptsDir: this.handoffReceiptsDir,
      sourceTaskId,
      destinationTaskId,
    });
    const profile = this.profiles.get(session.profileInstanceId);
    const inventory = await this.#executeOperation(peer, { sessionId: session.sessionId, method: "tabs.list", params: {} });
    const liveTabIds = new Set(inventory.map((tab) => tab.id));
    const allTaskTabs = [...this.taskTabs.values()];
    const receiptConflicts = allTaskTabs.filter((entry) => entry.profileInstanceId === session.profileInstanceId
      && entry.generation === session.generation
      && entry.taskId === destinationTaskId
      && entry.handoffSourceTaskId === sourceTaskId
      && entry.handoffReceiptSha256
      && entry.handoffReceiptSha256 !== validated.receiptSha256);
    if (receiptConflicts.length > 0) {
      throw new CompanionError("handoff_receipt_conflict", "Source tabs were already transferred with a different handoff receipt", {
        tabIds: receiptConflicts.map((entry) => entry.tabId),
      });
    }
    const alreadyTransferred = allTaskTabs.filter((entry) => entry.profileInstanceId === session.profileInstanceId
      && entry.generation === session.generation
      && entry.taskId === destinationTaskId
      && entry.handoffSourceTaskId === sourceTaskId
      && entry.handoffReceiptSha256 === validated.receiptSha256
      && liveTabIds.has(entry.tabId));
    const candidates = allTaskTabs.filter((entry) => entry.profileInstanceId === session.profileInstanceId
      && entry.generation === session.generation
      && entry.taskId === sourceTaskId
      && entry.retentionPolicy !== "cleanup"
      && !isLedgerOnlyTaskTab(entry)
      && !entry.quarantine);
    const busy = candidates.filter((entry) => this.tabLeaseIndex.has(this.#tabKey(entry.profileInstanceId, entry.tabId)));
    if (busy.length > 0) {
      throw new CompanionError("handoff_tabs_busy", "Source task tabs are still leased; transfer is deferred without changing ownership", {
        tabIds: busy.map((entry) => entry.tabId),
      });
    }
    const liveCandidates = candidates.filter((entry) => liveTabIds.has(entry.tabId));
    const missing = candidates.filter((entry) => !liveTabIds.has(entry.tabId)).map((entry) => entry.tabId);
    const transferredAt = nowIso();
    const transferred = await this.taskLedger.transferTaskTabs({
      profileInstanceId: session.profileInstanceId,
      generation: session.generation,
      sourceTaskId,
      destinationTaskId,
      runId,
      sessionId: session.sessionId,
      tabIds: liveCandidates.map((entry) => entry.tabId),
      receiptSha256: validated.receiptSha256,
      transferredAt,
    });
    for (const entry of transferred) {
      this.taskTabs.set(this.#tabKey(entry.profileInstanceId, entry.tabId), entry);
    }
    const handoffAck = createHandoffAck(this.ledgerSecret, {
      sourceTaskId,
      destinationTaskId,
      runId,
      receiptSha256: validated.receiptSha256,
      transferred: transferred.map((entry) => entry.tabId),
      alreadyTransferred: alreadyTransferred.map((entry) => entry.tabId),
      missing,
      status: transferred.length > 0
        ? "accepted"
        : alreadyTransferred.length > 0
          ? "already_transferred"
          : "no_tabs",
      acknowledgedAt: transferredAt,
    });
    await this.taskLedger.recordHandoffAck(handoffAck);
    return {
      schema: "aos.chrome_companion.handoff_tab_transfer.v1",
      run_id: runId,
      source_task_id: sourceTaskId,
      destination_task_id: destinationTaskId,
      profile: {
        profileInstanceId: session.profileInstanceId,
        generation: session.generation,
        connected: profile?.connected === true,
      },
      receipt_sha256: validated.receiptSha256,
      transferred: transferred.map((entry) => entry.tabId),
      already_transferred: alreadyTransferred.map((entry) => entry.tabId),
      missing,
      handoff_ack: handoffAck,
      external_action_executed: false,
    };
  }

  async #reconcileOperation(peer, params) {
    const session = this.#requireOwnedSession(peer, params.sessionId);
    const entry = this.taskLedger.get(requireString(params.idempotencyKey, "idempotencyKey"));
    if (!entry || entry.binding.sessionId !== session.sessionId) throw new CompanionError("operation_not_owned", "Operation is not owned by this session");
    if (entry.state !== "reconciled" || entry.brokerEvidence !== true) {
      throw new CompanionError("reconciliation_evidence_required", "Caller-supplied results cannot clear an unknown effect; broker late result or independent workflow evidence is required");
    }
    return { reconciled: true, idempotencyKey: entry.idempotencyKey, state: "reconciled", brokerEvidence: true };
  }

  async #rebindTaskReconciliation(peer, params) {
    const session = this.#requireOwnedSession(peer, params.sessionId);
    const runId = requireString(params.runId, "runId");
    const taskId = requireString(params.taskId ?? session.taskId, "taskId");
    const idempotencyKey = requireString(params.idempotencyKey, "idempotencyKey");
    const capsuleId = requireString(params.capsuleId, "capsuleId");
    const tabId = requireTabId(params.tabId);
    const fromGeneration = requireString(params.fromGeneration, "fromGeneration");
    if (!session.taskId || session.taskId !== taskId) {
      throw new CompanionError("task_id_mismatch", "Reconciliation rebind taskId does not match the logical session task");
    }
    await this.#assertTaskImplementationAllowed(taskId);
    const capsule = this.taskLedger.getTaskCapsule(capsuleId);
    if (!capsule
      || capsule.taskId !== taskId
      || capsule.runId !== runId
      || capsule.effect?.idempotencyKey !== idempotencyKey) {
      throw new CompanionError("task_reconciliation_not_found", "No matching task reconciliation capsule exists for this run and idempotency key");
    }
    if (capsule.state !== "reconciliation_required") {
      throw new CompanionError("task_reconciliation_state_invalid", `Generation rebind requires reconciliation_required state, not ${capsule.state}`);
    }
    const oldGeneration = capsule.target?.generation;
    if (!oldGeneration || oldGeneration !== fromGeneration) {
      throw new CompanionError("reconciliation_generation_source_mismatch", "Reconciliation rebind source generation does not match the durable capsule");
    }
    if (oldGeneration === session.generation) {
      throw new CompanionError("reconciliation_generation_already_current", "Reconciliation target is already bound to the current profile generation");
    }
    if (capsule.resources?.tabId !== tabId
      || capsule.target?.profileInstanceId !== session.profileInstanceId) {
      throw new CompanionError("task_reconciliation_target_mismatch", "Reconciliation rebind does not match the exact task-owned profile/tab");
    }
    const taskTab = this.taskTabs.get(this.#tabKey(session.profileInstanceId, tabId))
      || this.taskLedger.getTaskTab(session.profileInstanceId, tabId);
    if (!taskTab
      || taskTab.taskId !== taskId
      || taskTab.runId !== runId
      || taskTab.generation !== oldGeneration
      || taskTab.quarantine !== "stale_generation"
      || taskTab.userHelpRequired === true) {
      throw new CompanionError("task_reconciliation_stale_tab_required", "Generation rebind requires the same task-owned stale-generation tab without a user-help gate");
    }
    if (!taskTabIdentityConsistent(this.ledgerSecret, taskTab)) {
      throw new CompanionError("task_tab_identity_mismatch", "Persisted task-tab identity does not match its durable owner lineage");
    }
    const inventory = await this.#executeOperation(peer, {
      sessionId: session.sessionId,
      method: "tabs.list",
      params: {},
    });
    const live = inventory.find((entry) => entry.id === tabId);
    if (!live) throw new CompanionError("task_reconciliation_tab_missing", "The stale task-owned reconciliation tab is no longer open");
    if (live.pinned === true) throw new CompanionError("task_reconciliation_tab_protected", "Pinned tabs cannot be rebound for automatic reconciliation");
    let liveOrigin = null;
    try { liveOrigin = new URL(live.url).origin; } catch { /* unsupported browser-internal URL */ }
    const allowedOrigins = Array.isArray(capsule.target?.allowedOrigins)
      ? capsule.target.allowedOrigins.map((value) => {
        try { return new URL(String(value)).origin; } catch { return null; }
      }).filter(Boolean)
      : [];
    const targetOrigin = capsule.target?.origin
      ? (() => { try { return new URL(capsule.target.origin).origin; } catch { return null; } })()
      : null;
    const approvedOrigins = allowedOrigins.length > 0 ? allowedOrigins : (targetOrigin ? [targetOrigin] : []);
    if (!liveOrigin || liveOrigin === "null" || approvedOrigins.length === 0 || !approvedOrigins.includes(liveOrigin)
      || (targetOrigin && targetOrigin !== liveOrigin)) {
      throw new CompanionError("task_reconciliation_origin_mismatch", "The live stale tab is outside the capsule's approved origin set");
    }
    const payload = { runId, taskId, idempotencyKey, capsuleId, tabId, fromGeneration };
    await this.taskLedger.verifyAndConsumeAuthority(params.authority, {
      secrets: this.issuerSecrets,
      payload,
      expected: {
        runId,
        taskId,
        ownerKey: session.sessionId,
        method: "task.reconciliation.rebind",
        intent: "rebind_stale_generation_reconciliation",
      },
    });
    const lease = await this.#acquireLease(peer, { sessionId: session.sessionId, tabId });
    const reboundAt = nowIso();
    try {
      const identity = rebuildTaskTabIdentity(this.ledgerSecret, taskTab, {
        taskId,
        sessionId: session.sessionId,
        leaseId: null,
        generation: session.generation,
        profileInstanceId: session.profileInstanceId,
        tabId,
        pageInstanceId: live.pageInstanceId ?? null,
        windowId: Number.isSafeInteger(live.windowId) ? live.windowId : taskTab.windowId,
        origin: liveOrigin,
      });
      const reboundTaskTab = {
        ...taskTab,
        generation: session.generation,
        sessionId: session.sessionId,
        quarantine: null,
        targetIdentity: identity.targetIdentity,
        targetFingerprint: identity.targetFingerprint,
        identityRepairedAt: reboundAt,
        identityRepairReason: "owner_reconciliation_generation_rebind",
        generationReboundAt: reboundAt,
        generationReboundFrom: oldGeneration,
        lifecycleState: "reconciliation_required",
        retentionReason: "ai_reconciliation_pending",
        whyTabWasKept: "The same task-owned tab was rebound to the current Companion generation for signed readback; no provider mutation was replayed.",
        resumeAction: "inspect_reconciliation_then_complete",
        updatedAt: reboundAt,
      };
      await this.taskLedger.recordTaskTab(reboundTaskTab);
      this.taskTabs.set(this.#tabKey(session.profileInstanceId, tabId), this.taskLedger.getTaskTab(session.profileInstanceId, tabId));
      const reboundCapsule = await this.taskLedger.transitionTaskCapsule(capsuleId, "reconciliation_required", {
        target: {
          ...capsule.target,
          profileInstanceId: session.profileInstanceId,
          generation: session.generation,
          sessionId: session.sessionId,
          leaseId: null,
          tabId,
          origin: liveOrigin,
          pageInstanceId: live.pageInstanceId ?? null,
        },
        resources: {
          ...capsule.resources,
          exactTabLeaseId: lease.leaseId,
          tabId,
        },
        restartPoint: "same_generation_signed_reconciliation_readback",
        reconciliationGenerationRebind: {
          schema: "aos.chrome_companion.reconciliation_generation_rebind.v1",
          fromGeneration: oldGeneration,
          toGeneration: session.generation,
          tabId,
          reboundAt,
          externalActionExecuted: false,
        },
      });
      return {
        schema: "aos.chrome_companion.reconciliation_generation_rebind.v1",
        status: "rebound",
        run_id: runId,
        task_id: taskId,
        idempotency_key: idempotencyKey,
        capsule_id: capsuleId,
        tab_id: tabId,
        profile_instance_id: session.profileInstanceId,
        from_generation: oldGeneration,
        generation: session.generation,
        lease: this.#publicLease(lease),
        capsule: this.#publicTaskCapsule(reboundCapsule),
        tab: live,
        external_action_executed: false,
        next_action: "companion_inspect_reconciliation_then_companion_complete_reconciliation",
      };
    } catch (error) {
      this.#deleteLease(lease.leaseId);
      throw error;
    }
  }

  #localNavigationReconciliationOperation(capsule, idempotencyKey, tabId) {
    if (!isLocalNavigationReconciliationCapsule(capsule)) return null;
    const prefix = `${idempotencyKey}:`;
    const candidates = this.taskLedger.listOperations().filter((entry) =>
      entry.idempotencyKey.startsWith(prefix)
      && /^\d+$/u.test(entry.idempotencyKey.slice(prefix.length))
      && entry.binding?.taskId === capsule.taskId
      && entry.binding?.runId === capsule.runId
      && entry.binding?.tabId === tabId
      && entry.binding?.profileInstanceId === capsule.target?.profileInstanceId
      && isUnresolvedOperationEffect(entry));
    if (candidates.length !== 1 || !isUncertainLocalNavigationEffect(candidates[0])) return null;
    const operation = candidates[0];
    const suffix = operation.idempotencyKey.slice(prefix.length);
    const operationIndex = Number(suffix);
    if (!Number.isSafeInteger(operationIndex)
      || (Number.isSafeInteger(operation.operationIndex) && operation.operationIndex !== operationIndex)) return null;
    const recordedTargetDigest = operation.navigationTargetDigest
      ?? capsule.effect.localNavigationTargetDigest
      ?? localNavigationTargetDigestFromKey(this.ledgerSecret, capsule.target?.targetKey);
    if (!recordedTargetDigest
      || (capsule.effect.localNavigationTargetDigest
        && capsule.effect.localNavigationTargetDigest !== recordedTargetDigest)) return null;
    return { operation, operationIndex, recordedTargetDigest };
  }

  #requireTaskReconciliationBinding(session, params) {
    const runId = requireString(params.runId, "runId");
    const taskId = requireString(params.taskId ?? session.taskId, "taskId");
    const idempotencyKey = requireString(params.idempotencyKey, "idempotencyKey");
    const capsuleId = params.capsuleId === undefined || params.capsuleId === null
      ? null
      : requireString(params.capsuleId, "capsuleId");
    const tabId = requireTabId(params.tabId);
    if (!session.taskId || session.taskId !== taskId) {
      throw new CompanionError("task_id_mismatch", "Reconciliation taskId does not match the logical session task");
    }
    const capsule = capsuleId
      ? this.taskLedger.getTaskCapsule(capsuleId)
      : this.taskLedger.findTaskCapsule({ taskId, runId, idempotencyKey });
    if (!capsule || capsule.taskId !== taskId || capsule.runId !== runId || capsule.effect?.idempotencyKey !== idempotencyKey) {
      // Name the pending reconciliations of this exact task/run so the caller
      // can retry with the right key instead of guessing variations.
      const pending = this.taskLedger.listTaskCapsules()
        .filter(entry => entry.taskId === taskId && entry.runId === runId && entry.state === "reconciliation_required")
        .map(entry => ({ idempotencyKey: entry.effect?.idempotencyKey ?? null, capsuleId: entry.capsuleId, tabId: entry.resources?.tabId ?? null }))
        .slice(0, 10);
      throw new CompanionError("task_reconciliation_not_found", pending.length
        ? `No matching task reconciliation capsule exists for this run and idempotency key; pending for this run: ${pending.map(entry => `${entry.idempotencyKey} (capsuleId ${entry.capsuleId}, tab ${entry.tabId})`).join(", ")}`
        : "No matching task reconciliation capsule exists for this run and idempotency key; this run has no pending reconciliation (it may already be completed — check companion_transaction_status)",
      { pendingReconciliations: pending });
    }
    const localNavigation = isLocalNavigationReconciliationCapsule(capsule)
      ? this.#localNavigationReconciliationOperation(capsule, idempotencyKey, tabId)
      : null;
    if (capsule.state !== "reconciliation_required" && !localNavigation) {
      throw new CompanionError("task_reconciliation_state_invalid", `Task reconciliation requires reconciliation_required state, not ${capsule.state}`);
    }
    if (isLocalNavigationReconciliationCapsule(capsule) && !localNavigation) {
      throw new CompanionError("local_navigation_reconciliation_not_applicable", "Local arrival maintenance requires the exact unresolved tabs.navigate operation and recorded target");
    }
    if (capsule.resources?.tabId !== tabId
      || capsule.target?.profileInstanceId !== session.profileInstanceId
      || capsule.target?.generation !== session.generation) {
      throw new CompanionError("task_reconciliation_target_mismatch", "Reconciliation does not match the exact current-generation task tab");
    }
    const leaseId = requireString(params.leaseId, "leaseId");
    const lease = this.leases.get(leaseId);
    if (!lease
      || lease.sessionId !== session.sessionId
      || lease.tabId !== tabId
      || lease.generation !== session.generation) {
      throw new CompanionError("exact_tab_lease_required", "Reconciliation requires this session's exact-tab lease");
    }
    const taskTab = this.taskTabs.get(this.#tabKey(session.profileInstanceId, tabId))
      || this.taskLedger.getTaskTab(session.profileInstanceId, tabId);
    if (!taskTab || taskTab.taskId !== taskId || taskTab.runId !== runId) {
      throw new CompanionError("task_tab_ownership_required", "Reconciliation requires the exact task-owned tab from the same run");
    }
    return { runId, taskId, idempotencyKey, capsule, capsuleId: capsule.capsuleId, tabId, lease, taskTab, localNavigation };
  }

  async #resolveLocalEditor(peer, params) {
    const session = this.#requireOwnedSession(peer, params.sessionId);
    const payload = localEditorReconciliationPayload(params);
    const capsule = this.taskLedger.getTaskCapsule(params.capsuleId);
    const entry = this.taskLedger.get(params.originalOperationKey);
    if (!capsule || capsule.taskId !== session.taskId || capsule.taskId !== params.taskId || capsule.runId !== params.runId
      || capsule.effect?.idempotencyKey !== params.idempotencyKey || entry?.operationId !== params.originalOperationId
      || capsule.resources?.tabId !== params.tabId || entry.binding?.tabId !== params.tabId) {
      throw new CompanionError("local_editor_reconciliation_target_mismatch", "Local editor resolution requires the original failed capsule and operation from this task");
    }
    verifyOriginalEditorPayload(this.ledgerSecret, entry, capsule, params.originalPayload);
    const lease = this.leases.get(params.leaseId);
    const taskTab = this.taskTabs.get(this.#tabKey(session.profileInstanceId, params.tabId));
    if (!lease || lease.sessionId !== session.sessionId || lease.tabId !== params.tabId || lease.generation !== session.generation
      || !taskTab || taskTab.taskId !== session.taskId || taskTab.generation !== session.generation
      || session.profileInstanceId !== entry.binding.profileInstanceId || session.generation !== entry.binding.generation
      || params.pageInstanceId !== entry.binding.targetIdentity.pageInstanceId
      || params.url !== capsule.target?.intendedUrl && new URL(params.url).origin !== entry.binding.targetIdentity.origin
      || params.expectedFullBody !== params.originalPayload.text) {
      throw new CompanionError("local_editor_reconciliation_target_mismatch", "Current owner/lease/page and expected original full body must match separately");
    }
    await this.taskLedger.verifyAndConsumeAuthority(params.authority, { secrets: this.issuerSecrets, payload,
      expected: { runId: params.runId, taskId: session.taskId, ownerKey: session.sessionId,
        method: "task.reconciliation.resolve_local_editor", intent: "resolve_local_editor_from_exact_readback" } });
    const read = await this.#executeOperation(peer, { sessionId: session.sessionId, leaseId: lease.leaseId, method: "page.query",
      params: { tabId: params.tabId, frameId: entry.binding.targetIdentity.frameId, locator: { css: "div.ProseMirror" },
        exactEditor: true, maxEditorChars: 100_000, allowedOrigins: params.originalPayload.allowedOrigins } });
    if (!read?.exactEditor || read.truncated !== false || read.body !== params.expectedBody || read.url !== params.url
      || read.pageInstanceId !== params.pageInstanceId || read.frameId !== entry.binding.targetIdentity.frameId) {
      throw new CompanionError("local_editor_readback_changed", "Fresh untruncated editor body/page did not match; no local resolution appended");
    }
    const resolution = await this.taskLedger.appendLocalEditorResolution({ originalOperationKey: entry.idempotencyKey,
      originalPayload: params.originalPayload, capsuleId: capsule.capsuleId, resolution: {
        schema: "aos.chrome_companion.local_editor_resolution.v1", resolutionId: createId("editor_resolution"),
        originalOperationId: entry.operationId, originalFingerprint: entry.fingerprint,
        currentBinding: { taskId: session.taskId, sessionId: session.sessionId, leaseId: lease.leaseId,
          generation: session.generation, profileInstanceId: session.profileInstanceId, tabId: params.tabId,
          pageInstanceId: read.pageInstanceId, windowId: entry.binding.targetIdentity.windowId, frameId: read.frameId },
        expectedBody: read.body, expectedFullBody: params.expectedFullBody, insertText: params.insertText, offset: params.offset,
        repairOperationKey: params.repairOperationKey, url: read.url, bodySha256: read.bodySha256,
        issuedAt: nowIso(), expiresAt: new Date(Date.now() + 120_000).toISOString(),
        disposition: "local_body_observed_original_effect_history_preserved", providerCompletion: false,
      } }, { brokerEvidence: true });
    return { resolved: true, resolutionId: resolution.resolutionId, originalOperationKey: entry.idempotencyKey,
      originalOperationState: entry.state, originalCapsuleState: capsule.state, replayAllowed: false, cleanupReady: false,
      repairOperationKey: resolution.repairOperationKey, expiresAt: resolution.expiresAt, bodySha256: read.bodySha256,
      editorGuard: { originalOperationKey: entry.idempotencyKey, resolutionId: resolution.resolutionId,
        expectedBody: read.body, expectedFullBody: params.expectedFullBody, offset: params.offset, url: read.url } };
  }

  async #resolveLocalSelection(peer, params) {
    const session = this.#requireOwnedSession(peer, params.sessionId);
    const payload = localSelectionReconciliationPayload(params);
    if (Object.keys(params).some(key => !["sessionId", "authority"].includes(key) && !Object.hasOwn(payload, key))) {
      throw new CompanionError("local_selection_payload_invalid", "Selection resolution accepts original evidence only, not caller proof assertions");
    }
    const capsule = this.taskLedger.getTaskCapsule(params.capsuleId), entry = this.taskLedger.get(params.originalOperationKey);
    const expectedLabel = verifyOriginalSelectionPayload(this.ledgerSecret, entry, capsule, params.originalPayload);
    const original = entry.binding.targetIdentity;
    const lease = this.leases.get(params.leaseId);
    const taskTab = this.taskTabs.get(this.#tabKey(session.profileInstanceId, params.tabId));
    const assertBinding = () => {
      if (this.#requireOwnedSession(peer, params.sessionId) !== session
        || capsule.taskId !== session.taskId || params.taskId !== session.taskId || params.runId !== capsule.runId
        || params.idempotencyKey !== capsule.effect.idempotencyKey || params.originalOperationId !== entry.operationId
        || params.tabId !== entry.binding.tabId || params.pageInstanceId !== original.pageInstanceId
        || session.generation !== original.generation || session.profileInstanceId !== original.profileInstanceId
        || !lease || this.leases.get(params.leaseId) !== lease || lease.sessionId !== session.sessionId
        || lease.tabId !== params.tabId || lease.generation !== session.generation
        || !taskTab || this.taskTabs.get(this.#tabKey(session.profileInstanceId, params.tabId)) !== taskTab
        || taskTab.taskId !== session.taskId || taskTab.runId !== params.runId || taskTab.generation !== session.generation
        || taskTab.quarantine || !taskTabIdentityConsistent(this.ledgerSecret, taskTab)
        || taskTab.targetIdentity?.pageInstanceId !== original.pageInstanceId
        || taskTab.targetIdentity?.windowId !== original.windowId || taskTab.targetIdentity?.frameId !== original.frameId
        || params.url !== capsule.target?.intendedUrl || new URL(params.url).origin !== original.origin) {
        throw new CompanionError("local_selection_target_mismatch", "Selection resolution requires the current exact owner lease and original document/control");
      }
    };
    assertBinding();
    await this.taskLedger.verifyAndConsumeAuthority(params.authority, { secrets: this.issuerSecrets, payload,
      expected: { runId: params.runId, taskId: session.taskId, ownerKey: session.sessionId,
        method: "task.reconciliation.resolve_local_selection", intent: "resolve_local_selection_from_exact_readback",
        targetOrigin: new URL(params.url).origin } });
    const options = await this.#executeOperation(peer, { sessionId: session.sessionId, leaseId: lease.leaseId, method: "page.query",
      params: { tabId: params.tabId, frameId: original.frameId,
        locator: { css: "option", within: params.originalPayload.locator }, includeHidden: true, limit: 100,
        attributes: ["aria-label", "aria-labelledby", "title", "label", "value", "aria-selected", "aria-checked", "aria-pressed"],
        allowedOrigins: params.originalPayload.allowedOrigins } });
    assertBinding();
    const completeOptions = options?.url === params.url && options.pageInstanceId === original.pageInstanceId
      && options.totalCountExact === true && options.scanLimitReached === false && options.truncated === false
      && options.count === options.totalCount && options.count === options.matches?.length && options.count > 0
      && options.matches.every(option => option.tag === "option" && typeof option.text === "string"
        && option.text.length < 500 && !option.truncatedAttributes?.length && !option.redactedAttributes?.length
        && option.attributes && !option.attributes["aria-labelledby"] && !option.attributes.title
        && ["aria-selected", "aria-checked", "aria-pressed"].every(name => option.attributes[name] === null));
    const selectedOptions = options?.matches?.filter(option => option.selected === true) ?? [];
    const matchingOptions = options?.matches?.filter(option => option.text?.toLowerCase() === expectedLabel.toLowerCase()) ?? [];
    if (!completeOptions || matchingOptions.length !== 1 || selectedOptions.length !== 1
      || matchingOptions[0] !== selectedOptions[0] || selectedOptions[0].text !== expectedLabel) {
      throw new CompanionError("local_selection_option_evidence_mismatch", "Require a complete original-control option inventory with one unique selected label");
    }
    const read = await this.#executeOperation(peer, { sessionId: session.sessionId, leaseId: lease.leaseId, method: "page.query",
      params: { tabId: params.tabId, frameId: original.frameId, locator: params.originalPayload.locator,
        limit: 2, allowedOrigins: params.originalPayload.allowedOrigins } });
    assertBinding();
    const control = read?.matches?.[0];
    if (read?.url !== params.url || read.pageInstanceId !== original.pageInstanceId
      || read.count !== 1 || read.totalCount !== 1 || read.totalCountExact !== true
      || read.truncated !== false || read.scanLimitReached !== false || read.matches?.length !== 1
      || control?.tag !== "select" || control.multiple !== false || control.visible !== true
      || control.selectedText !== expectedLabel) {
      throw new CompanionError("local_selection_readback_mismatch", "Fresh exact native single-select label did not match the original signed selection");
    }
    const resolution = await this.taskLedger.appendLocalSelectionResolution({ originalOperationKey: entry.idempotencyKey,
      originalPayload: params.originalPayload, capsuleId: capsule.capsuleId, resolution: {
        schema: "aos.chrome_companion.local_selection_resolution.v1", resolutionId: createId("selection_resolution"),
        originalOperationId: entry.operationId, originalFingerprint: entry.fingerprint,
        currentBinding: { taskId: session.taskId, sessionId: session.sessionId, leaseId: lease.leaseId,
          generation: session.generation, profileInstanceId: session.profileInstanceId, tabId: params.tabId,
          pageInstanceId: read.pageInstanceId, windowId: original.windowId, frameId: original.frameId },
        selectedLabel: control.selectedText, controlTag: control.tag, multiple: control.multiple, url: read.url,
        optionLabelUnique: true, optionInventoryDigest: payloadDigest(this.ledgerSecret, options),
        selectedOptionValue: selectedOptions[0].attributes.value ?? null,
        issuedAt: nowIso(), providerCompletion: false, replayAllowed: false,
        disposition: "local_selection_observed_original_effect_history_preserved",
      } }, { brokerEvidence: true });
    return { resolved: true, resolutionId: resolution.resolutionId, originalOperationKey: entry.idempotencyKey,
      originalOperationState: entry.state, originalCapsuleState: capsule.state, selectedLabel: resolution.selectedLabel,
      observedScope: "local_selection_only", providerCompletion: false, replayAllowed: false, actionsReplayed: 0,
      effectiveSettlement: this.taskLedger.localSelectionSettlement(capsule) };
  }

  async #readUploadConfirmationFiles(peer, { session, lease, tabId, delivery, pageInstanceId, pageUrl }) {
    if (!delivery?.confirmation_files?.length && delivery?.count_witness) {
      const witness = delivery.count_witness;
      const count = await this.#executeOperation(peer, { sessionId: session.sessionId, leaseId: lease.leaseId,
        method: "page.query", params: { tabId, locator: witness.locator, limit: 1 } });
      if (!Number.isSafeInteger(count?.totalCount) || count.totalCountExact !== true || count.scanLimitReached === true
        || !Number.isSafeInteger(witness.before) || !Number.isSafeInteger(witness.required_increase)
        || count.totalCount < witness.before + witness.required_increase
        || count.pageInstanceId !== pageInstanceId || count.url !== pageUrl)
        throw new CompanionError("upload_site_state_evidence_required", `The upload list count did not grow by ${witness.required_increase} (before ${witness.before}, now ${count?.totalCount ?? "unknown"}); inspect without re-uploading`);
      return [{ count_witness: true, before: witness.before, observed: count.totalCount, required_increase: witness.required_increase,
        query_digest: payloadDigest(this.ledgerSecret, { locator: witness.locator, totalCount: count.totalCount }) }];
    }
    const files = delivery?.confirmation_files;
    if (!Array.isArray(files) || !files.length || files.length !== delivery.filename_sha256?.length
      || new Set(files.map(file => file.filename_sha256)).size !== files.length
      || files.some(file => !delivery.filename_sha256.includes(file.filename_sha256) || !/^[0-9a-f]{64}$/u.test(file.file_sha256)))
      throw new CompanionError("upload_site_state_evidence_required", "Every assigned file requires its original bound attachment-ready locator and content digest; inspect without re-uploading");
    const evidence = [];
    const seenWitnesses = new Set();
    for (const file of files) {
      // A one-file preview (LinkedIn's image editor shows the same image as a
      // large preview and a thumbnail) may match a few nodes; any visible one
      // proves the attachment. Filename rows must stay unique.
      const previewSingle = file.preview_only === true && files.length === 1;
      const query = await this.#executeOperation(peer, { sessionId: session.sessionId, leaseId: lease.leaseId,
        method: "page.query", params: { tabId, locator: file.locator, limit: previewSingle ? 10 : 2 } });
      const countOk = previewSingle
        ? Number.isSafeInteger(query?.count) && query.count >= 1 && query.count <= 10 && Array.isArray(query.matches) && query.matches.length >= 1
        : Number.isSafeInteger(query?.count) && query.count === 1 && Array.isArray(query.matches) && query.matches.length === 1
          && query.totalCount === 1 && query.totalCountExact === true && query.truncated === false;
      if (!countOk || query.scanLimitReached !== false
        || query.matches[0].visible !== true || typeof query.matches[0].nodeIdentity !== "string" || !query.matches[0].nodeIdentity
        || seenWitnesses.has(query.matches[0].nodeIdentity)
        || query.pageInstanceId !== pageInstanceId || query.url !== pageUrl)
        throw new CompanionError("upload_site_state_evidence_required", "An assigned file has no fresh attachment-ready evidence in the exact original page; inspect without re-uploading");
      seenWitnesses.add(query.matches[0].nodeIdentity);
      if (file.preview_only === true && files.length === 1) {
        evidence.push({ filename_sha256: file.filename_sha256, file_sha256: file.file_sha256, preview_only: true,
          query_digest: payloadDigest(this.ledgerSecret, { locator: file.locator, matches: stableQueryMatches(query.matches) }) });
        continue;
      }
      if (!file.filename_locator || file.filename_locator.exact !== true
        || createHash("sha256").update(String(file.filename_locator.text).replace(/\s+/gu, " ").trim()).digest("hex") !== file.filename_sha256)
        throw new CompanionError("upload_original_payload_required", "Exact original filename proof is missing; provide owner-signed originalUploadPayload and explicit confirmationFiles, never re-upload");
      const filenameQuery = await this.#executeOperation(peer, { sessionId: session.sessionId, leaseId: lease.leaseId,
        method: "page.query", params: { tabId, locator: file.filename_locator, limit: 2 } });
      if (filenameQuery?.count !== 1 || filenameQuery.matches?.length !== 1 || filenameQuery.totalCount !== 1
        || filenameQuery.totalCountExact !== true || filenameQuery.truncated !== false || filenameQuery.scanLimitReached !== false
        || filenameQuery.matches[0].visible !== true
        || String(filenameQuery.matches[0].text).replace(/\s+/gu, " ").trim() !== String(file.filename_locator.text).replace(/\s+/gu, " ").trim()
        || filenameQuery.pageInstanceId !== pageInstanceId || filenameQuery.url !== pageUrl)
        throw new CompanionError("upload_site_state_evidence_required", "The exact original filename must have one visible full-count witness within its attachment-ready row; renamed files require explicit mapping, never re-upload");
      evidence.push({ filename_sha256: file.filename_sha256, file_sha256: file.file_sha256,
        query_digest: payloadDigest(this.ledgerSecret, { locator: file.locator, matches: stableQueryMatches(query.matches),
          filenameLocator: file.filename_locator, filenameMatches: stableQueryMatches(filenameQuery.matches) }) });
    }
    return evidence;
  }

  async #inspectTaskReconciliation(peer, params) {
    const session = this.#requireOwnedSession(peer, params.sessionId);
    const binding = this.#requireTaskReconciliationBinding(session, params);
    const successQuery = requireString(params.successQuery, "successQuery").replace(/\s+/gu, " ").trim();
    if (successQuery.length < 2 || successQuery.length > 500) {
      throw new CompanionError("reconciliation_success_query_invalid", "Reconciliation successQuery must contain 2 to 500 characters");
    }
    let uploadDelivery = binding.capsule.effect?.uploadDelivery;
    const uploadConfirmation = ["upload_confirmation_required", "upload_confirmation_not_observed"].includes(binding.capsule.blocker?.code)
      && uploadDelivery?.applied === true;
    if (uploadConfirmation && params.originalUploadPayload !== undefined) {
      const original = this.taskLedger.get(params.originalOperationKey);
      const payload = params.originalUploadPayload, owner = original?.binding;
      if (!original || !["page.upload", "page.uploadMultiple"].includes(owner?.method) || original.dispatchCount !== 1
        || original.idempotencyKey !== binding.capsule.effect?.failedOperationKey
        || original.operationId !== binding.capsule.effect?.failedOperationId
        || original.operationId !== params.originalOperationId || original.fingerprint !== params.originalFingerprint
        || original.fingerprint !== payloadDigest(this.ledgerSecret, { binding: owner, payload })
        || owner.taskId !== binding.taskId || owner.runId !== binding.runId || owner.tabId !== binding.tabId
        || owner.profileInstanceId !== binding.capsule.target?.profileInstanceId
        || owner.generation !== binding.capsule.target?.generation
        || owner.sessionId !== binding.capsule.target?.sessionId
        || owner.targetIdentity?.pageInstanceId !== binding.capsule.target?.pageInstanceId
        || !original.idempotencyKey.startsWith(`${binding.idempotencyKey}:`))
        throw new CompanionError("upload_original_payload_invalid", "Exact original upload operation, owner and saved HMAC must match before confirmation readback");
      await this.taskLedger.verifyAndConsumeAuthority(params.authority, { secrets: this.issuerSecrets,
        payload: uploadReconciliationPayload(params), expected: { runId: binding.runId, taskId: binding.taskId,
          ownerKey: session.sessionId, method: "task.reconciliation.inspect", intent: "inspect_original_upload_confirmation_only" } });
      const files = owner.method === "page.upload" ? [payload.file] : payload.files;
      if (!Array.isArray(files) || !files.length || !Array.isArray(params.confirmationFiles) || params.confirmationFiles.length !== files.length)
        throw new CompanionError("upload_confirmation_files_invalid", "Provide one explicit attachment-ready locator for every original assigned file");
      const confirmations = files.map(file => {
        const matches = params.confirmationFiles.filter(item => item.filename === file.name);
        const sha256 = createHash("sha256").update(Buffer.from(file.dataBase64 ?? "", "base64")).digest("hex");
        const nameDigest = createHash("sha256").update(file.name.replace(/\s+/gu, " ").trim()).digest("hex");
        if (matches.length !== 1 || !matches[0].locator || file.sha256 !== undefined && file.sha256 !== sha256
          || !uploadDelivery.filename_sha256?.includes(nameDigest))
          throw new CompanionError("upload_original_payload_invalid", "Original file bytes, filename digest and readiness locator must agree");
        if ([matches[0].locator.nth, matches[0].locator.ordinal, matches[0].locator.last].some(value => value !== undefined))
          throw new CompanionError("upload_confirmation_locator_invalid", "Attachment-ready proof requires one unique row; omit nth, ordinal and last");
        if (matches[0].previewOnly === true) {
          if (files.length !== 1) throw new CompanionError("upload_confirmation_preview_invalid", "previewOnly confirmation is limited to one uploaded file");
          return { filename_sha256: nameDigest, file_sha256: sha256, preview_only: true, filename_locator: null, locator: matches[0].locator };
        }
        return { filename_sha256: nameDigest, file_sha256: sha256,
          filename_locator: { text: file.name, exact: true, anyOf: [matches[0].locator, { within: matches[0].locator }] },
          locator: { ...matches[0].locator, allOf: [...(matches[0].locator.allOf ?? []), { hasText: file.name }] } };
      });
      uploadDelivery = { ...uploadDelivery, confirmation_files: confirmations,
        original_operation_key: original.idempotencyKey, original_operation_id: original.operationId, original_fingerprint: original.fingerprint };
    }
    if (uploadConfirmation && params.originalUploadPayload === undefined && Array.isArray(params.confirmationFiles) && params.confirmationFiles.length) {
      // Late registration: the upload was dispatched without a usable
      // confirmation method (or the declared one cannot match on this site).
      // Bind the caller's confirmation-only locators to the files recorded at
      // dispatch. This never re-uploads and never claims provider success.
      const recorded = Array.isArray(uploadDelivery.assigned_files) && uploadDelivery.assigned_files.length
        ? uploadDelivery.assigned_files
        : (uploadDelivery.filename_sha256 ?? []).map(nameDigest => ({ filename_sha256: nameDigest,
          file_sha256: createHash("sha256").update(`late_registration:${nameDigest}`).digest("hex") }));
      if (params.confirmationFiles.length !== recorded.length)
        throw new CompanionError("upload_confirmation_files_invalid", `Provide exactly one confirmationFiles item per uploaded file (${recorded.length}), e.g. [{ filename: "<original file name>", locator: { role: "img" }, previewOnly: true }]`);
      const previewItems = params.confirmationFiles.filter(item => item?.previewOnly === true);
      if (previewItems.length && recorded.length !== 1)
        throw new CompanionError("upload_confirmation_preview_invalid", "previewOnly confirmation is limited to one uploaded file");
      const confirmations = params.confirmationFiles.map(item => {
        const nameDigest = createHash("sha256").update(String(item?.filename ?? "").replace(/\s+/gu, " ").trim()).digest("hex");
        const file = recorded.find(entry => entry.filename_sha256 === nameDigest);
        if (!file || !item.locator || typeof item.locator !== "object")
          throw new CompanionError("upload_confirmation_files_invalid", "Each confirmationFiles item needs the original uploaded file name (as passed to page.upload) and a locator object");
        if ([item.locator.nth, item.locator.ordinal, item.locator.last].some(value => value !== undefined))
          throw new CompanionError("upload_confirmation_locator_invalid", "Attachment-ready proof requires one unique row; omit nth, ordinal and last");
        if (item.previewOnly === true)
          return { filename_sha256: nameDigest, file_sha256: file.file_sha256, preview_only: true, filename_locator: null, locator: item.locator };
        return { filename_sha256: nameDigest, file_sha256: file.file_sha256,
          filename_locator: { text: item.filename, exact: true, anyOf: [item.locator, { within: item.locator }] },
          locator: { ...item.locator, allOf: [...(item.locator.allOf ?? []), { hasText: item.filename }] } };
      });
      uploadDelivery = { ...uploadDelivery, confirmation_files: confirmations, late_registered: true };
    }
    if (uploadConfirmation && !uploadDelivery.confirmation_files?.length && !uploadDelivery.count_witness)
      throw new CompanionError("upload_original_payload_required", "This retained upload predates per-file proof: provide exact originalUploadPayload, operation key/id/fingerprint and confirmationFiles for owner-signed readback; never re-upload");
    if (uploadConfirmation && uploadDelivery.filename_sha256?.includes(createHash("sha256").update(successQuery).digest("hex"))) {
      throw new CompanionError("upload_site_state_evidence_required", "A filename alone does not prove site attachment readiness or provider completion");
    }
    const semantic = await this.#executeOperation(peer, {
      sessionId: session.sessionId,
      leaseId: binding.lease.leaseId,
      method: "page.snapshot",
      params: { tabId: binding.tabId, maxTextChars: 30_000 },
    });
    if (binding.localNavigation && !this.#navigationArrived(binding, semantic?.url)) {
      throw new CompanionError("local_navigation_arrival_target_mismatch", "The exact leased tab has not arrived at the recorded navigation target or another page of the task's sites");
    }
    const query = await this.#executeOperation(peer, {
      sessionId: session.sessionId,
      leaseId: binding.lease.leaseId,
      method: "page.query",
      params: { tabId: binding.tabId, query: successQuery, limit: 10 },
    });
    if (!Number.isSafeInteger(query?.count) || query.count < 1 || !Array.isArray(query.matches)) {
      throw new CompanionError("reconciliation_success_evidence_not_found", "No visible semantic success evidence matched the exact reconciliation tab");
    }
    const uploadFilesEvidence = uploadConfirmation ? await this.#readUploadConfirmationFiles(peer, {
      session, lease: binding.lease, tabId: binding.tabId, delivery: uploadDelivery,
      pageInstanceId: semantic.pageInstanceId, pageUrl: semantic.url }) : null;
    const visual = await this.#executeOperation(peer, {
      sessionId: session.sessionId,
      leaseId: binding.lease.leaseId,
      method: "page.screenshot",
      params: { tabId: binding.tabId, restoreActive: true, quality: 60, maxBytes: 700_000 },
      timeoutMs: 30_000,
    });
    if (visual?.kind !== "screenshot"
      || !visual.dataBase64
      || visual.tabId !== binding.tabId
      || String(visual.url || "") !== String(semantic?.url || "")
      || String(query?.url || "") !== String(semantic?.url || "")
      || query?.pageInstanceId !== semantic?.pageInstanceId) {
      throw new CompanionError("reconciliation_visual_semantic_mismatch", "Reconciliation semantic evidence and screenshot did not identify the same exact page instance");
    }
    const capturedAtCandidate = String(visual.capturedAt || "");
    const capturedAt = Number.isFinite(Date.parse(capturedAtCandidate)) ? capturedAtCandidate : nowIso();
    const expiresAt = new Date(Date.parse(capturedAt) + 5 * 60_000).toISOString();
    const proofPayload = {
      schema: "aos.chrome_companion.reconciliation_visual_proof.v1",
      sessionId: session.sessionId,
      leaseId: binding.lease.leaseId,
      taskId: binding.taskId,
      runId: binding.runId,
      idempotencyKey: binding.idempotencyKey,
      capsuleId: binding.capsuleId,
      profileInstanceId: session.profileInstanceId,
      generation: session.generation,
      tabId: binding.tabId,
      pageUrl: String(semantic.url || ""),
      pageInstanceId: semantic.pageInstanceId ?? null,
      successQuery,
      queryDigest: payloadDigest(this.ledgerSecret, { successQuery, matches: stableQueryMatches(query.matches) }),
      screenshotDigest: payloadDigest(this.ledgerSecret, visual.dataBase64),
      capturedAt,
      expiresAt,
      ...(uploadConfirmation ? { proofKind: "upload_site_confirmation", uploadActionIndex: uploadDelivery.action_index, providerSuccessConfirmed: false, uploadFilesEvidence, uploadDeliveryEvidence: uploadDelivery } : {}),
      ...(binding.localNavigation ? {
        proofKind: "local_navigation_arrival",
        operationId: binding.localNavigation.operation.operationId,
        operationIndex: binding.localNavigation.operationIndex,
        recordedTargetDigest: binding.localNavigation.recordedTargetDigest,
      } : {}),
    };
    // The proof comes first and the page text is cut short: on a big page (Gmail) the whole snapshot
    // pushed the proof past the MCP client's output limit and it could not be passed on (2026-10-17).
    // Completion reads the page again, so nothing here is relied on for the decision.
    const brief = (value, max) => { const text = String(value ?? ""); return text.length > max ? `${text.slice(0, max)}…` : text; };
    return {
      kind: "reconciliation_visual_confirmation",
      reconciliationProof: { ...proofPayload, signature: payloadDigest(this.ledgerSecret, proofPayload) },
      ...(uploadConfirmation ? { proof_kind: "upload_site_confirmation", upload_confirmation_observed: true, provider_success_confirmed: false } : {}),
      ...(binding.localNavigation ? {
        proof_kind: "local_navigation_arrival",
        local_navigation_arrival_verified: true,
        provider_success_confirmed: false,
      } : {}),
      semantic: { url: semantic?.url, title: semantic?.title, readyState: semantic?.readyState, pageInstanceId: semantic?.pageInstanceId,
        text: brief(semantic?.text, 2_000), textTruncated: String(semantic?.text ?? "").length > 2_000 },
      successEvidence: { ...query, matches: (query?.matches ?? []).slice(0, 3).map(match => ({ ...match, name: brief(match?.name, 300), text: brief(match?.text, 300) })) },
      visual,
      visual_readback_verified: true,
      external_action_executed: false,
      mutation_dispatch_attempted: false,
      mutation_dispatch_count: 0,
      operation_effect_state: "none",
    };
  }

  // An uncertain send settled from where the provider lists sent items (owner, 2026-10-16: sends whose
  // result was unknown stopped whole runs; the success text was on the sent list or the timeline, never on
  // the page that sent). The MCP layer reads evidenceUrl in a temporary task tab of its own and reports
  // whether successQuery was there; nothing is replayed here. Present: the send is settled as sent.
  // Absent: only after a second read at least 30 s after the first and 90 s after the dispatch is it
  // settled as not sent, and the task may then send once more under a new key.
  // A page move sends nothing, so landing on the recorded URL or on any page of the task's own sites (a
  // redirect to a canonical URL, a login or consent page of the same site) settles its arrival (owner,
  // 2026-10-16: 24 runs a week stopped as local_navigation_arrival_target_mismatch after a redirect).
  #navigationArrived(binding, url) {
    const href = String(url ?? "");
    if (localNavigationTargetDigest(this.ledgerSecret, href) === binding.localNavigation.recordedTargetDigest) return true;
    let origin;
    try { origin = new URL(href).origin; } catch { return false; }
    if (!/^https?:/u.test(origin)) return false;
    const allowed = binding.capsule?.target?.allowedOrigins ?? binding.capsule?.allowedOrigins ?? [];
    return allowed.includes(origin);
  }

  async #settleTaskFromEvidence(peer, params) {
    const session = this.#requireOwnedSession(peer, params.sessionId);
    const runId = requireString(params.runId, "runId");
    const taskId = requireString(params.taskId ?? session.taskId, "taskId");
    const idempotencyKey = requireString(params.idempotencyKey, "idempotencyKey");
    if (session.taskId !== taskId) throw new CompanionError("task_id_mismatch", "Settlement taskId does not match the logical session task");
    const evidenceUrl = requireString(params.evidenceUrl, "evidenceUrl");
    const successQuery = requireString(params.successQuery, "successQuery").replace(/\s+/gu, " ").trim();
    if (successQuery.length < 2 || successQuery.length > 500) throw new CompanionError("reconciliation_success_query_invalid", "successQuery must contain 2 to 500 characters");
    const evidenceDigest = requireString(params.evidenceDigest, "evidenceDigest");
    if (typeof params.found !== "boolean") throw new CompanionError("invalid_request", "found must be a boolean");
    const capsule = params.capsuleId ? this.taskLedger.getTaskCapsule(requireString(params.capsuleId, "capsuleId"))
      : this.taskLedger.findTaskCapsule({ taskId, runId, idempotencyKey });
    if (!capsule || capsule.taskId !== taskId || capsule.runId !== runId || capsule.effect?.idempotencyKey !== idempotencyKey) {
      throw new CompanionError("task_reconciliation_not_found", "No matching uncertain send exists for this run and idempotency key (companion_transaction_status lists them)");
    }
    if (capsule.state !== "reconciliation_required") {
      throw new CompanionError("task_reconciliation_state_invalid", `Only an uncertain send can be settled from evidence, not a ${capsule.state} one`);
    }
    let origin;
    try { origin = new URL(evidenceUrl).origin; } catch { throw new CompanionError("invalid_request", "evidenceUrl must be an absolute URL"); }
    const allowed = capsule.target?.allowedOrigins ?? capsule.allowedOrigins ?? [];
    if (!allowed.includes(origin)) {
      throw new CompanionError("evidence_origin_not_allowed", `Evidence must come from the site of the send (${allowed.join(", ") || "unknown"})`);
    }
    // Signed exactly as the client sent it (capsuleId may be absent).
    const payload = { runId, taskId, idempotencyKey, capsuleId: params.capsuleId, evidenceUrl, successQuery: params.successQuery, found: params.found, evidenceDigest };
    await this.taskLedger.verifyAndConsumeAuthority(params.authority, {
      secrets: this.issuerSecrets,
      payload,
      expected: { runId, taskId, ownerKey: session.sessionId, method: "task.reconciliation.settle_from_evidence", intent: "settle_send_from_provider_evidence" },
    });
    const proofDigest = payloadDigest(this.ledgerSecret, payload);
    const at = nowIso();
    const evidenceUrlSha256 = createHash("sha256").update(evidenceUrl, "utf8").digest("hex");
    const reconciliation = { schema: "aos.chrome_companion.provider_evidence_reconciliation.v1",
      evidenceUrlSha256, successQuerySha256: createHash("sha256").update(successQuery, "utf8").digest("hex"), completedAt: at };
    const tabId = capsule.resources?.tabId, profileInstanceId = capsule.target?.profileInstanceId;
    const recordTab = async (fields) => {
      const tab = Number.isSafeInteger(tabId) && profileInstanceId ? this.taskLedger.getTaskTab(profileInstanceId, tabId) : null;
      if (!tab) return;
      await this.taskLedger.recordTaskTab({ ...tab, resumeToken: null, userHelpRequired: false, whyTabWasKept: null,
        requiredUserAction: null, resumeAction: null, updatedAt: at, ...fields });
      this.taskTabs.set(this.#tabKey(profileInstanceId, tabId), this.taskLedger.getTaskTab(profileInstanceId, tabId));
    };
    if (params.found) {
      const completed = await this.taskLedger.completeTaskReconciliation(capsule.capsuleId, {
        blocker: null, restartPoint: null, resumeToken: null,
        completion: { ...capsule.completion, reconciliation: { ...reconciliation, status: "completed", providerSuccessConfirmed: true },
          cleanup: { status: "pending_terminal_session_close" } },
        retention: { policy: "retain", resumeTokenRequired: false, userHelpRequired: false, reason: null,
          whyTabWasKept: null, requiredUserAction: null, resumeAction: null },
      }, { brokerEvidence: true, proofDigest });
      await recordTab({ lifecycleState: completed.state, retentionPolicy: "retain", retentionReason: null });
      return { schema: "aos.chrome_companion.provider_evidence_settlement.v1", outcome: "sent", run_id: runId,
        idempotency_key: idempotencyKey, capsule_id: capsule.capsuleId, effect_state: "known_effect",
        provider_success_confirmed: true, resend_allowed: false, next_action: "continue_after_the_send" };
    }
    const reads = await this.taskLedger.recordProviderAbsence(capsule.capsuleId, { at, evidenceDigest, evidenceUrlSha256 });
    const dispatchedAt = this.taskLedger.providerEvidenceDispatchedAt(capsule.capsuleId) ?? Date.parse(capsule.updatedAt ?? at);
    const now = Date.parse(at), firstAt = Date.parse(reads[0].at);
    const waitForDispatch = Math.max(0, dispatchedAt + 90_000 - now), waitForSecondRead = reads.length < 2 ? 30_000 : Math.max(0, firstAt + 30_000 - now);
    if (reads.length < 2 || waitForDispatch > 0 || waitForSecondRead > 0) {
      return { schema: "aos.chrome_companion.provider_evidence_settlement.v1", outcome: "not_seen_yet", run_id: runId,
        idempotency_key: idempotencyKey, capsule_id: capsule.capsuleId, absence_reads: reads.length,
        retry_after_seconds: Math.ceil(Math.max(waitForDispatch, waitForSecondRead, reads.length < 2 ? 30_000 : 0) / 1000),
        resend_allowed: false, next_action: "read_the_same_evidence_again_after_retry_after_seconds" };
    }
    await this.taskLedger.settleNotSentFromEvidence(capsule.capsuleId, {
      completion: { ...capsule.completion, reconciliation: { ...reconciliation, status: "not_sent", providerSuccessConfirmed: false,
        absenceReads: reads.length }, cleanup: { status: "pending_terminal_session_close" } },
    }, { brokerEvidence: true, proofDigest });
    await recordTab({ lifecycleState: "failed", retentionPolicy: "cleanup", retentionReason: null });
    return { schema: "aos.chrome_companion.provider_evidence_settlement.v1", outcome: "not_sent", run_id: runId,
      idempotency_key: idempotencyKey, capsule_id: capsule.capsuleId, effect_state: "known_no_effect", absence_reads: reads.length,
      resend_allowed: true, next_action: "send_once_more_under_a_new_idempotency_key_then_stop_if_still_unknown" };
  }

  async #completeTaskReconciliation(peer, params) {
    const session = this.#requireOwnedSession(peer, params.sessionId);
    const binding = this.#requireTaskReconciliationBinding(session, params);
    const proof = params.reconciliationProof;
    if (!proof || typeof proof !== "object" || Array.isArray(proof)) {
      throw new CompanionError("reconciliation_visual_proof_required", "Completing reconciliation requires the fresh signed semantic plus screenshot proof");
    }
    const payload = {
      runId: binding.runId,
      taskId: binding.taskId,
      idempotencyKey: binding.idempotencyKey,
      capsuleId: binding.capsuleId,
      tabId: binding.tabId,
      reconciliationProof: proof,
    };
    await this.taskLedger.verifyAndConsumeAuthority(params.authority, {
      secrets: this.issuerSecrets,
      payload,
      expected: {
        runId: binding.runId,
        taskId: binding.taskId,
        ownerKey: session.sessionId,
        method: "task.reconciliation.complete",
        intent: "complete_reconciliation_from_readback",
      },
    });
    const { signature, ...proofPayload } = proof;
    const expiresAt = Date.parse(String(proofPayload.expiresAt || ""));
    const validSignature = typeof signature === "string"
      && secureEqual(signature, payloadDigest(this.ledgerSecret, proofPayload));
    const consumed = typeof signature === "string" && this.consumedReconciliationProofs.has(signature);
    const localNavigationProof = proofPayload.proofKind === "local_navigation_arrival";
    const uploadConfirmation = ["upload_confirmation_required", "upload_confirmation_not_observed"].includes(binding.capsule.blocker?.code)
      && binding.capsule.effect?.uploadDelivery?.applied === true;
    if (Boolean(binding.localNavigation) !== localNavigationProof
      || (!localNavigationProof && (uploadConfirmation ? proofPayload.proofKind !== "upload_site_confirmation"
        || proofPayload.uploadActionIndex !== binding.capsule.effect.uploadDelivery.action_index
        || proofPayload.providerSuccessConfirmed !== false : proofPayload.proofKind !== undefined))) {
      throw new CompanionError("reconciliation_visual_proof_kind_invalid", "The signed proof kind does not match the exact unresolved operation");
    }
    if (proofPayload.schema !== "aos.chrome_companion.reconciliation_visual_proof.v1"
      || !validSignature
      || consumed
      || proofPayload.sessionId !== session.sessionId
      || proofPayload.leaseId !== binding.lease.leaseId
      || proofPayload.taskId !== binding.taskId
      || proofPayload.runId !== binding.runId
      || proofPayload.idempotencyKey !== binding.idempotencyKey
      || proofPayload.capsuleId !== binding.capsuleId
      || proofPayload.profileInstanceId !== session.profileInstanceId
      || proofPayload.generation !== session.generation
      || proofPayload.tabId !== binding.tabId
      || (localNavigationProof && proofPayload.operationId !== binding.localNavigation.operation.operationId)
      || (localNavigationProof && proofPayload.operationIndex !== binding.localNavigation.operationIndex)
      || (localNavigationProof && proofPayload.recordedTargetDigest !== binding.localNavigation.recordedTargetDigest)
      || !Number.isFinite(expiresAt)
      || expiresAt <= Date.now()) {
      throw new CompanionError("reconciliation_visual_proof_invalid", "Reconciliation proof is stale, consumed, or does not match the exact task/session/lease/tab/generation binding. Call companion_inspect_reconciliation again with the same lease and pass its reconciliationProof unchanged (proofs last 5 minutes and work once)");
    }
    const semantic = await this.#executeOperation(peer, {
      sessionId: session.sessionId,
      leaseId: binding.lease.leaseId,
      method: "page.snapshot",
      params: { tabId: binding.tabId, maxTextChars: 30_000 },
    });
    if (binding.localNavigation && !this.#navigationArrived(binding, semantic?.url)) {
      throw new CompanionError("local_navigation_arrival_target_mismatch", "The exact leased tab has moved away from the recorded navigation target and the task's sites");
    }
    const query = await this.#executeOperation(peer, {
      sessionId: session.sessionId,
      leaseId: binding.lease.leaseId,
      method: "page.query",
      params: { tabId: binding.tabId, query: proofPayload.successQuery, limit: 10 },
    });
    const visual = await this.#executeOperation(peer, {
      sessionId: session.sessionId,
      leaseId: binding.lease.leaseId,
      method: "page.screenshot",
      params: { tabId: binding.tabId, restoreActive: true, quality: 60, maxBytes: 700_000 },
      timeoutMs: 30_000,
    });
    const queryDigest = payloadDigest(this.ledgerSecret, { successQuery: proofPayload.successQuery, matches: stableQueryMatches(query?.matches) });
    if (uploadConfirmation) {
      // Evidence rebuilt from the exact original payload (e.g. previewOnly) supersedes the
      // locators recorded at dispatch; its original operation is re-checked just below.
      const delivery = proofPayload.uploadDeliveryEvidence?.original_operation_key || proofPayload.uploadDeliveryEvidence?.late_registered === true
        || !binding.capsule.effect.uploadDelivery.confirmation_files?.length
        ? proofPayload.uploadDeliveryEvidence : binding.capsule.effect.uploadDelivery;
      if (delivery?.original_operation_key) {
        const original = this.taskLedger.get(delivery.original_operation_key);
        if (!original || original.operationId !== delivery.original_operation_id || original.fingerprint !== delivery.original_fingerprint)
          throw new CompanionError("upload_original_payload_invalid", "Original upload receipt changed after inspection; do not re-upload");
      }
      const fresh = await this.#readUploadConfirmationFiles(peer, { session, lease: binding.lease, tabId: binding.tabId,
        delivery, pageInstanceId: semantic.pageInstanceId, pageUrl: semantic.url });
      if (payloadDigest(this.ledgerSecret, fresh) !== payloadDigest(this.ledgerSecret, proofPayload.uploadFilesEvidence))
        throw new CompanionError("reconciliation_readback_changed", "The assigned-file attachment evidence changed after inspection; do not re-upload");
    }
    const screenshotDigest = visual?.dataBase64
      ? payloadDigest(this.ledgerSecret, visual.dataBase64)
      : null;
    // The page, its instance and the success elements must be exactly those inspected. The fresh
    // screenshot must show the same tab and page, but its pixels need not be byte-identical: a
    // blinking caret or a loading animation re-encodes differently every time (2026-10-17). Whether
    // it changed is recorded with the completion.
    const changed = [
      (String(semantic?.url || "") !== String(proofPayload.pageUrl || "") || String(query?.url || "") !== String(proofPayload.pageUrl || "")) && "page URL",
      (semantic?.pageInstanceId !== proofPayload.pageInstanceId || query?.pageInstanceId !== proofPayload.pageInstanceId) && "page instance (the page was reloaded or replaced)",
      (!Number.isSafeInteger(query?.count) || query.count < 1) && "success text is no longer visible",
      queryDigest !== proofPayload.queryDigest && "success elements or their text",
      (visual?.kind !== "screenshot" || !screenshotDigest || visual?.tabId !== binding.tabId || String(visual?.url || "") !== String(proofPayload.pageUrl || "")) && "screenshot of the same tab and page",
    ].filter(Boolean);
    if (changed.length) {
      throw new CompanionError("reconciliation_readback_changed", `The exact success page or its semantic evidence changed after visual inspection (${changed.join("; ")}). Call companion_inspect_reconciliation again and complete promptly`, { changed });
    }
    const screenshotChangedAfterInspection = screenshotDigest !== proofPayload.screenshotDigest;
    this.consumedReconciliationProofs.set(signature, expiresAt);
    for (const [key, expiry] of this.consumedReconciliationProofs) if (expiry <= Date.now()) this.consumedReconciliationProofs.delete(key);
    const completedAt = nowIso();
    const completedCapsule = await this.taskLedger.completeTaskReconciliation(binding.capsuleId, {
      blocker: null,
      restartPoint: null,
      resumeToken: null,
      completion: {
        ...binding.capsule.completion,
        reconciliation: {
          schema: binding.localNavigation
            ? "aos.chrome_companion.local_navigation_arrival_confirmation.v1"
            : "aos.chrome_companion.reconciliation_completion.v1",
          status: binding.localNavigation ? "local_navigation_arrival_confirmed" : "completed",
          ...(binding.localNavigation ? {
            operationIndex: binding.localNavigation.operationIndex,
            recordedTargetDigest: binding.localNavigation.recordedTargetDigest,
            providerSuccessConfirmed: false,
          } : {}),
          ...(uploadConfirmation ? { uploadConfirmationObserved: true, providerSuccessConfirmed: false,
            uploadActionIndex: binding.capsule.effect.uploadDelivery.action_index } : {}),
          successQuerySha256: createHash("sha256").update(proofPayload.successQuery, "utf8").digest("hex"),
          pageUrl: proofPayload.pageUrl,
          screenshotChangedAfterInspection,
          completedAt,
        },
        cleanup: { status: uploadConfirmation ? "pending_unsubmitted_workflow" : "pending_terminal_session_close" },
      },
      // Reconciling one uncertain operation settles that operation, not the
      // task: keep the tab as an ordinary retained task tab so the same task
      // can continue its remaining steps on it. Terminal session close still
      // cleans completed retained tabs.
      retention: {
        policy: uploadConfirmation ? "retain_until_resume" : "retain",
        resumeTokenRequired: false,
        userHelpRequired: false,
        reason: uploadConfirmation ? "attachment_confirmed_workflow_unsubmitted" : null,
        whyTabWasKept: null,
        requiredUserAction: null,
        resumeAction: null,
      },
      }, {
        brokerEvidence: true,
        proofDigest: payloadDigest(this.ledgerSecret, proofPayload),
        ...(uploadConfirmation ? { proofKind: "upload_site_confirmation" } : {}),
        ...(binding.localNavigation ? {
          proofKind: "local_navigation_arrival",
          operationIndex: binding.localNavigation.operationIndex,
          recordedTargetDigest: binding.localNavigation.recordedTargetDigest,
        } : {}),
      });
    if (binding.localNavigation) {
      const otherUnresolved = completedCapsule.effect?.localNavigationOtherUnresolvedEffects ?? 1;
      const terminalCleanupReady = otherUnresolved === 0;
      await this.taskLedger.recordTaskTab({
        ...binding.taskTab,
        lifecycleState: "failed",
        retentionPolicy: terminalCleanupReady ? "cleanup" : "retain_until_resume",
        resumeToken: null,
        userHelpRequired: false,
        retentionReason: terminalCleanupReady ? null : "ai_reconciliation_pending",
        whyTabWasKept: terminalCleanupReady ? null : "Another unresolved operation in this exact run still requires signed reconciliation.",
        requiredUserAction: null,
        resumeAction: terminalCleanupReady ? null : "reconcile_other_unresolved_operation_without_replay",
        updatedAt: completedAt,
      });
      this.taskTabs.set(
        this.#tabKey(session.profileInstanceId, binding.tabId),
        this.taskLedger.getTaskTab(session.profileInstanceId, binding.tabId),
      );
      return {
        schema: "aos.chrome_companion.local_navigation_arrival_maintenance.v1",
        status: "local_navigation_arrival_confirmed",
        run_id: binding.runId,
        task_id: binding.taskId,
        idempotency_key: binding.idempotencyKey,
        capsule_id: binding.capsuleId,
        tab_id: binding.tabId,
        state: "failed",
        effect_state: "known_effect",
        reconciliation_required: false,
        action_progress: completedCapsule.effect?.actionProgress ?? null,
        operation_index: binding.localNavigation.operationIndex,
        provider_success_confirmed: false,
        remaining_action_dispatch_allowed: false,
        terminal_cleanup_ready: terminalCleanupReady,
        other_unresolved_effect_count: otherUnresolved,
        next_action: terminalCleanupReady
          ? "companion_close_session_task_terminal_true"
          : "reconcile_other_unresolved_operation_without_replay",
        external_action_executed: false,
        original_failure: completedCapsule.blocker,
        completed_at: completedAt,
      };
    }
    const remainingActions = completedCapsule.effect?.actionProgress?.remaining_action_indices ?? [];
    const resumeRemaining = remainingActions.length > 0;
    const retainWorkflow = resumeRemaining || uploadConfirmation;
    await this.taskLedger.recordTaskTab({
      ...binding.taskTab,
      lifecycleState: completedCapsule.state,
      retentionPolicy: retainWorkflow ? "retain_until_resume" : "retain",
      resumeToken: null,
      userHelpRequired: false,
      retentionReason: uploadConfirmation ? "attachment_confirmed_workflow_unsubmitted" : resumeRemaining ? "partial_actions_applied" : null,
      whyTabWasKept: null,
      requiredUserAction: null,
      resumeAction: resumeRemaining ? "read_back_same_target_then_continue_remaining_actions" : uploadConfirmation ? "continue_unsubmitted_workflow_or_explicitly_abandon" : null,
      updatedAt: completedAt,
    });
    this.taskTabs.set(
      this.#tabKey(session.profileInstanceId, binding.tabId),
      this.taskLedger.getTaskTab(session.profileInstanceId, binding.tabId),
    );
    return {
      schema: "aos.chrome_companion.reconciliation_completion.v1",
      status: resumeRemaining ? "ready_to_resume" : uploadConfirmation ? "upload_confirmation_observed" : "completed",
      ...(uploadConfirmation ? { upload_confirmation_observed: true, provider_success_confirmed: false, retry_upload: false } : {}),
      run_id: binding.runId,
      task_id: binding.taskId,
      idempotency_key: binding.idempotencyKey,
      capsule_id: binding.capsuleId,
      tab_id: binding.tabId,
      state: completedCapsule.state,
      effect_state: "known_effect",
      reconciliation_required: false,
      action_progress: completedCapsule.effect?.actionProgress ?? null,
      terminal_cleanup_ready: !retainWorkflow,
      task_may_continue: true,
      continue_on_tab_id: binding.tabId,
      next_action: resumeRemaining ? "companion_prepare_resume" : uploadConfirmation ? "continue_unsubmitted_workflow_or_explicitly_abandon" : "continue_remaining_task_steps_on_same_tab_or_close_session_task_terminal_true_when_task_done",
      external_action_executed: false,
      completed_at: completedAt,
    };
  }

  async #taskStatus(peer, params) {
    const session = this.#requireOwnedSession(peer, params.sessionId);
    const runId = requireString(params.runId, "runId");
    const taskId = requireString(params.taskId, "taskId");
    if (params.authority?.issuer === "codex_mcp" && session.taskId !== taskId) {
      throw new CompanionError("task_id_mismatch", "Codex status taskId does not match the logical session task");
    }
    const idempotencyKey = params.idempotencyKey === undefined || params.idempotencyKey === null ? null : requireString(params.idempotencyKey, "idempotencyKey");
    const capsuleId = params.capsuleId === undefined || params.capsuleId === null ? null : requireString(params.capsuleId, "capsuleId");
    const payload = taskStatusPayload({ ...params, runId, taskId, idempotencyKey, capsuleId });
    await this.taskLedger.verifyAndConsumeAuthority(params.authority, {
      secrets: this.issuerSecrets,
      payload,
      expected: {
        runId,
        taskId,
        ownerKey: session.sessionId,
        method: "task.status",
        intent: "reconcile_status",
      },
    });
    const entry = idempotencyKey ? this.taskLedger.get(idempotencyKey) : null;
    const capsule = capsuleId ? this.taskLedger.getTaskCapsule(capsuleId) : this.taskLedger.findTaskCapsule({ taskId, runId, idempotencyKey });
    // Validate both records independently. One matching capsule must never
    // authorize a foreign operation, and one matching operation must never
    // authorize a foreign capsule or its retained page.
    const capsuleKey = capsule?.effect?.idempotencyKey;
    const stepSuffix = typeof capsuleKey === "string" && idempotencyKey?.startsWith(capsuleKey + ":")
      ? idempotencyKey.slice(capsuleKey.length + 1) : null;
    if ((entry && (entry.state === "task_tab" || entry.binding?.runId !== runId || entry.binding?.taskId !== taskId))
      || (capsule && (capsule.taskId !== taskId || capsule.runId !== runId))
      || (capsuleId && !capsule)
      || (capsule && idempotencyKey && capsuleKey && idempotencyKey !== capsuleKey && !/^\d+$/u.test(stepSuffix ?? ""))) {
      throw new CompanionError("task_status_not_found", "No matching task operation exists for the signed run/task binding");
    }
    const audit = payload.audit ? operationAuditPage({ operations: this.taskLedger.listOperations(), taskId, runId, audit: payload.audit, secret: this.ledgerSecret }) : null;
    if (!entry && !capsule) {
      if (audit && !idempotencyKey && !capsuleId) return {
        schema: "aos.chrome_companion.task_status.v1", result: "audit_readback", run_id: runId, task_id: taskId,
        state: null, effect_state: null, continuation_allowed: false, browser_commands_dispatched: 0, audit,
      };
      throw new CompanionError("task_status_not_found", "No matching task operation exists for the signed run/task binding");
    }
    const operationState = entry?.state ?? null;
    const selectionSettlement = this.taskLedger.localSelectionSettlement(capsule);
    const settlement = capsuleNoEffectSettlement(capsule, this.taskLedger.listOperations()) ?? selectionSettlement;
    const unresolvedEffects = this.taskLedger.listOperations().filter(operation => operation.binding?.taskId === taskId
      && operation.binding?.runId === runId && operationEffectStateForEntry(operation) === "unknown_effect"
      && uncertaintyBlocksContinuation(operation)
      && !this.taskLedger.localSelectionResolution(operation));
    const lateResultReconciled = operationState === "reconciled"
      && entry?.brokerEvidence === true
      && entry?.localNavigationArrivalReconciled !== true;
    const state = capsule?.state ?? operationState;
    const localNavigation = capsule?.effect?.idempotencyKey
      ? this.#localNavigationReconciliationOperation(capsule, capsule.effect.idempotencyKey, capsule.resources?.tabId)
      : null;
    const localNavigationPending = Boolean(localNavigation);
    const localNavigationArrivalSettled = capsule?.effect?.localNavigationArrivalSettled === true;
    const effectState = normalizeOperationEffectState(
      settlement?.effectState ?? capsule?.effect?.effectState
        ?? entry?.effectState
        ?? entry?.operationEffectState,
      operationEffectStateForEntry(entry ?? capsule ?? {}),
    );
    const effectRequiresReconciliation = unresolvedEffects.length > 0 || effectState === "unknown_effect"
      && (operationRequiresReconciliation(entry ?? capsule ?? {}) || localNavigationPending);
    const currentProfile = this.profiles.get(session.profileInstanceId);
    const trackedTabId = capsule?.resources?.tabId ?? entry?.binding?.tabId ?? null;
    const trackedGeneration = capsule?.target?.generation ?? entry?.binding?.generation ?? null;
    const trackedProfileInstanceId = capsule?.target?.profileInstanceId ?? entry?.binding?.profileInstanceId ?? null;
    const unresolvedNavigation = unresolvedLocalNavigationForTarget(this.taskLedger.listOperations(), {
      profileInstanceId: session.profileInstanceId, tabId: trackedTabId,
    });
    const ledgerTab = Number.isSafeInteger(trackedTabId)
      ? (this.taskTabs.get(this.#tabKey(session.profileInstanceId, trackedTabId))
        || this.taskLedger.getTaskTab(session.profileInstanceId, trackedTabId))
      : null;
    const currentProfileConnected = currentProfile?.connected === true;
    const currentGeneration = currentProfile?.generation ?? null;
    const profileMatches = !trackedProfileInstanceId || trackedProfileInstanceId === session.profileInstanceId;
    const generationMatches = Boolean(profileMatches && trackedGeneration && currentGeneration && trackedGeneration === currentGeneration);
    const ledgerTabPresent = Boolean(profileMatches && ledgerTab && ledgerTab.taskId === taskId && ledgerTab.runId === runId);
    const ledgerOnlyTab = ledgerTabPresent && isLedgerOnlyTaskTab(ledgerTab);
    const tabQuarantined = Boolean(ledgerTabPresent && ledgerTab?.quarantine);
    const resumeDisposition = localNavigationArrivalSettled
      ? "failure_preserved_cleanup_only"
      : state === "completed"
      ? "completed"
      : lateResultReconciled
        ? (currentProfileConnected && generationMatches && ledgerTabPresent && !tabQuarantined
          ? "readback_same_tab_then_cleanup"
          : "open_fresh_target_then_reconcile")
      : effectRequiresReconciliation || ["reconciliation_required", "awaiting_user"].includes(state)
        ? (ledgerOnlyTab
          ? "open_fresh_target_with_ledger_warning"
          : (currentProfileConnected && generationMatches && ledgerTabPresent && !tabQuarantined
            ? "resume_same_generation"
            : "open_fresh_target_then_reconcile"))
        : "signed_status_required";
    const tabRetention = ledgerTabPresent
      ? state === "awaiting_user"
        ? {
            retained: true,
            user_help_required: true,
            retention_reason: capsule?.retention?.reason ?? null,
            why_tab_was_kept: capsule?.retention?.whyTabWasKept ?? null,
            required_user_action: capsule?.retention?.requiredUserAction ?? null,
            resume_action: capsule?.retention?.resumeAction ?? capsule?.restartPoint ?? null,
          }
        : ledgerOnlyTab
          ? {
              retained: false,
              disposable: true,
              tab_disposition: "ledger_only",
              user_help_required: false,
              retention_reason: "unknown_effect_ledger_only",
              why_tab_was_kept: "The browser tab is disposable after owner loss; the signed operation ledger and task capsule remain the restart record.",
              required_user_action: null,
              resume_action: "start_fresh_task_with_ledger_warning",
            }
        : effectRequiresReconciliation || state === "reconciliation_required" || state === "reconciled"
          ? {
              retained: true,
              user_help_required: false,
              retention_reason: localNavigationPending ? "local_ui_navigation_arrival_pending" : lateResultReconciled ? "ai_terminal_readback_pending" : "ai_reconciliation_pending",
              why_tab_was_kept: lateResultReconciled
                ? "The broker received a late successful result; Codex must perform one same-target readback before terminal cleanup."
                : localNavigationPending
                  ? "A local tabs.navigate acknowledgement is unknown; verify arrival at its recorded target without replay."
                : "The task-owned tab is retained temporarily while Codex reconciles an unknown external effect without replaying it.",
              required_user_action: null,
              resume_action: localNavigationPending
                ? "signed_local_navigation_arrival_readback_then_cleanup"
                : lateResultReconciled
                ? "same_target_readback_then_terminal_cleanup"
                : "signed_task_status_readback_then_cleanup_when_reconciled",
            }
          : capsule?.effect?.actionProgress?.remaining_action_indices?.length > 0
            ? { retained: true, user_help_required: false, retention_reason: "partial_actions_applied",
                why_tab_was_kept: "The reconciled page has remaining actions; continue only those actions after same-target readback.",
                required_user_action: null, resume_action: "read_back_same_target_then_continue_remaining_actions" }
          : {
              retained: false,
              user_help_required: false,
              retention_reason: null,
              why_tab_was_kept: null,
              required_user_action: null,
              resume_action: null,
            }
      : null;
    const handoffAck = this.taskLedger.listHandoffAcks()
      .slice()
      .reverse()
      .find((ack) => ack.destinationTaskId === taskId && ack.runId === runId) ?? null;
    return {
      schema: "aos.chrome_companion.task_status.v1",
      result: effectRequiresReconciliation || (state === "reconciliation_required" && !settlement) ? "reconciliation_required" : "readback",
      run_id: runId,
      task_id: taskId,
      idempotency_key: idempotencyKey ?? capsule?.effect?.idempotencyKey ?? null,
      capsule_id: capsule?.capsuleId ?? null,
      operation_id: entry?.operationId ?? null,
      state,
      operation_state: operationState,
      effect_state: effectState,
      effectState,
      effective_settlement: settlement,
      local_selection_settlement: selectionSettlement,
      unresolved_operation_count: unresolvedEffects.length,
      reconciliation_required: effectRequiresReconciliation,
      // This is a historical target record read through a currently valid
      // owner session. A past profile failure is not a fresh shared blocker.
      ...blockerRecoveryContext({ code: "reconciliation_required", taskId, runId,
        profileInstanceId: session.profileInstanceId, tabId: capsule?.resources?.tabId,
        targetKey: capsule?.target?.targetKey, nextAction: unresolvedNavigation.length > 0
          ? "reconcile_original_navigation_with_fresh_exact_target_evidence" : effectRequiresReconciliation
          ? "perform_one_owner_signed_reconciliation_readback"
          : "fresh_status_and_exact_owner_readback" }),
      local_navigation_arrival_pending: localNavigationPending,
      local_navigation_arrival_settled: localNavigationArrivalSettled,
      local_navigation_operation_index: localNavigation?.operationIndex ?? capsule?.effect?.localNavigationOperationIndex ?? null,
      remaining_action_dispatch_allowed: unresolvedEffects.length === 0 && unresolvedNavigation.length === 0 && !localNavigationPending && !localNavigationArrivalSettled
        && (!selectionSettlement || currentProfileConnected && generationMatches && ledgerTabPresent && !tabQuarantined
          && taskTabIdentityConsistent(this.ledgerSecret, ledgerTab))
        && (state !== "reconciliation_required" || Boolean(settlement)),
      unresolved_local_navigation_count: unresolvedNavigation.length,
      broker_evidence: entry?.brokerEvidence === true,
      late_result_reconciled: lateResultReconciled,
      target: capsule?.target ?? null,
      tab: capsule?.resources?.tabId === null || capsule?.resources?.tabId === undefined ? null : { id: capsule.resources.tabId, leaseId: capsule.resources.exactTabLeaseId ?? null },
      generation: capsule?.target?.generation ?? entry?.binding?.generation ?? null,
      blocker: capsule?.blocker ?? null,
      resume_token: capsule?.resumeToken ?? null,
      visual: capsule?.visual ?? null,
      completion: capsule?.completion ?? null,
      restart_point: lateResultReconciled
        ? (currentProfileConnected && generationMatches && ledgerTabPresent && !tabQuarantined
          ? "same_tab_readback_then_terminal_cleanup"
          : "fresh_target_readback_then_terminal_cleanup")
        : capsule?.restartPoint ?? (effectRequiresReconciliation ? "signed_task_status_readback" : state === "reconciled" ? "reconciled_readback" : null),
      dispatch_count: Number.isSafeInteger(entry?.dispatchCount)
        ? entry.dispatchCount
        : (entry && (entry.dispatchedAt || entry.operationId) ? 1 : 0),
      interrupted_classification: entry?.interruptedClassification ?? null,
      restart_recovery_disposition: entry?.restartRecoveryDisposition ?? null,
      safe_fresh_retry_allowed: entry?.restartRecoveryDisposition === "fresh_retry_allowed",
      current_profile_connected: currentProfileConnected,
      current_generation: currentGeneration,
      generation_matches: generationMatches,
      ledger_tab_present: ledgerTabPresent,
      tab_disposition: ledgerOnlyTab ? "ledger_only" : (ledgerTabPresent ? "retained" : null),
      tab_quarantined: tabQuarantined,
      target_identity_consistent: ledgerTabPresent ? taskTabIdentityConsistent(this.ledgerSecret, ledgerTab) : null,
      target_identity_repair: ledgerTabPresent ? ledgerTab?.identityRepairReason ?? null : null,
      reconciliation_generation_rebind: capsule?.reconciliationGenerationRebind ?? null,
      resume_disposition: resumeDisposition,
      continuation_allowed: state !== "completed"
        && (!selectionSettlement || currentProfileConnected && generationMatches && ledgerTabPresent && !tabQuarantined
          && taskTabIdentityConsistent(this.ledgerSecret, ledgerTab))
        && unresolvedNavigation.length === 0
        && state !== "awaiting_user"
        && (state !== "reconciliation_required" || Boolean(settlement))
        && !localNavigationPending
        && !localNavigationArrivalSettled
        && !effectRequiresReconciliation
        && !["visible_captcha_widget_user_required", "user_authentication", "owner_sso_required", "company_connection_ref_missing"].includes(capsule?.blocker?.code),
      tab_retention: tabRetention,
      handoff_ack: handoffAck,
      ...(audit ? { audit } : {}),
    };
  }

  /**
   * Prepare a bounded, read-only resume decision from the current owner
   * session.  This deliberately does not create a new session, claim a tab,
   * replay an operation, or change the handoff gate.  It gives the AOS
   * controller one deterministic next action and a signed effect proof when
   * an operation/capsule already exists.
   */
  async #recoverTarget(peer, params) {
    const session = this.#requireOwnedSession(peer, params.sessionId);
    const payload = targetRecoveryPayload(params);
    if (Object.keys(params).some(key => key !== "authority" && !Object.hasOwn(payload, key))) {
      throw new CompanionError("target_recovery_payload_invalid", "Recovery accepts only its exact target replacement payload");
    }
    for (const [key, value] of Object.entries(payload)) {
      if (key !== "oldTabId") requireString(value, key);
    }
    await this.taskLedger.verifyAndConsumeAuthority(params.authority, {
      secrets: this.issuerSecrets, payload,
      expected: { taskId: payload.taskId, runId: payload.runId, ownerKey: session.sessionId,
        method: "task.recover_target", intent: "recover_missing_target", idempotencyKey: payload.idempotencyKey,
        targetOrigin: new URL(payload.intendedUrl).origin },
    });
    await this.#assertTaskImplementationAllowed(payload.taskId);
    const source = this.taskLedger.getTaskCapsule(payload.sourceCapsuleId);
    const { intendedUrl } = validateTargetRecoverySource(source, this.taskLedger.listOperations(), payload, session);
    const oldRecord = this.taskLedger.getTaskTab(session.profileInstanceId, payload.oldTabId);
    if (oldRecord && (!taskTabIdentityConsistent(this.ledgerSecret, oldRecord)
      || oldRecord.taskId !== payload.taskId || oldRecord.runId !== payload.runId
      || oldRecord.sessionId !== source.target.sessionId || oldRecord.generation !== source.target.generation
      || oldRecord.capsuleId !== source.capsuleId || oldRecord.targetKey !== source.target.targetKey
      || oldRecord.userHelpRequired || oldRecord.handoffSourceTaskId || oldRecord.transferredAt)) {
      throw new CompanionError("target_recovery_ownership_mismatch", "The old target record does not belong to the exact failed capsule");
    }
    if (this.taskLedger.listTaskCapsules().some(capsule => capsule.capsuleId !== source.capsuleId
      && capsule.taskId === payload.taskId && capsule.runId === payload.runId
      && (capsule.retention?.userHelpRequired || capsule.effect?.awaitedEvent
        || ["awaiting_user", "reconciliation_required", "executing", "admitted", "target_bound", "pre_read", "post_read"].includes(capsule.state)
        || ["unknown_effect", "known_effect"].includes(capsule.effect?.effectState)))) {
      throw new CompanionError("target_recovery_prior_effects", "Other run progress prevents target replacement");
    }
    const reservationKey = `${session.profileInstanceId}:${session.generation}:${payload.taskId}:${source.target.targetKey}`;
    if (this.taskTargetReservations.has(reservationKey) || this.tabLeaseIndex.has(this.#tabKey(session.profileInstanceId, payload.oldTabId))) {
      throw new CompanionError("target_resource_busy", "The source target is reserved or leased");
    }
    this.taskTargetReservations.set(reservationKey, session.sessionId);
    let lease;
    let reservation;
    let capsule;
    const receipt = { schema: "aos.chrome_companion.target_recovery.v1", task_id: payload.taskId, run_id: payload.runId,
      source_capsule_id: source.capsuleId, original_operation_id: payload.originalOperationId,
      original_operation_key: payload.originalOperationKey, old_tab_id: payload.oldTabId,
      idempotency_key: payload.idempotencyKey, actions_replayed: 0, original_action_dispatched: false,
      replay_allowed: false, continuation_allowed: false, external_action_executed: false };
    try {
      // Only a fresh successful inventory lookup proves absence. A timeout,
      // malformed inventory, or an existing exact tab never authorizes create.
      const inventory = await this.#executeOperation(peer, { sessionId: session.sessionId, method: "tabs.list", params: {} });
      if (!Array.isArray(inventory) || inventory.some(tab => !Number.isSafeInteger(tab?.id) || tab.id < 0)
        || new Set(inventory.map(tab => tab.id)).size !== inventory.length) {
        throw new CompanionError("target_recovery_lookup_unproven", "Fresh inventory did not authoritatively establish target absence");
      }
      if (inventory.some(tab => tab.id === payload.oldTabId)) {
        throw new CompanionError("target_recovery_target_exists", "The recorded exact tab still exists; reserve and inspect it");
      }
      // Re-read history after the lookup; in-flight settlement cannot become
      // an unobserved permission to recreate a target.
      validateTargetRecoverySource(source, this.taskLedger.listOperations(), payload, session);
      capsule = normalizeTaskExecutionCapsule({ taskId: payload.taskId, runId: payload.runId,
        state: "executing", workflowType: source.workflowType, targetKey: source.target.targetKey,
        canonicalLocator: source.target.canonicalLocator, startUrl: intendedUrl,
        allowedOrigins: source.target.allowedOrigins, profileInstanceId: session.profileInstanceId,
        generation: session.generation, sessionId: session.sessionId, retentionPolicy: "retain",
        effect: { idempotencyKey: payload.idempotencyKey, effectState: "no_dispatch", effectClass: "local_ui",
          externalActionExecuted: false, reconciliationRequired: false },
        execution: { ...source.execution, targetRecovery: { sourceCapsuleId: source.capsuleId,
          originalOperationId: payload.originalOperationId, originalOperationKey: payload.originalOperationKey,
          oldTabId: payload.oldTabId, originalActionsDispatched: false } },
      });
      reservation = await this.taskLedger.reserveTargetRecovery({ sourceCapsuleId: source.capsuleId,
        originalOperationId: payload.originalOperationId, recoveryIdempotencyKey: payload.idempotencyKey,
        capsuleId: capsule.capsuleId, binding: { taskId: payload.taskId, runId: payload.runId,
          ownerKey: session.sessionId, sessionId: session.sessionId, profileInstanceId: session.profileInstanceId,
          generation: session.generation, tabId: payload.oldTabId, method: "task.recover_target" } });
      receipt.capsule_id = capsule.capsuleId;
      receipt.recovery_operation_id = reservation.operationId;
      await this.taskLedger.putTaskCapsule(capsule);
      await this.taskLedger.transition(reservation.idempotencyKey, "dispatched");
      const created = await this.#executeOperation(peer, { sessionId: session.sessionId,
        method: "tabs.create", taskOwnedRequired: true,
        params: { url: intendedUrl, active: false, allowedOrigins: source.target.allowedOrigins } },
      { trustedTask: { authority: params.authority, taskId: payload.taskId, runId: payload.runId,
        idempotencyKey: payload.idempotencyKey, index: 0, capsule } });
      if (!Number.isSafeInteger(created?.id) || created.id === payload.oldTabId) {
        throw new CompanionError("target_recovery_creation_identity_invalid", "Creation returned no distinct new target identity");
      }
      receipt.tab_id = created.id;
      lease = await this.#acquireLease(peer, { sessionId: session.sessionId, tabId: created.id });
      const fresh = await this.#executeOperation(peer, { sessionId: session.sessionId, leaseId: lease.leaseId,
        method: "page.snapshot", params: { tabId: created.id, maxTextChars: 30_000 } });
      if (typeof fresh?.pageInstanceId !== "string" || !fresh.pageInstanceId.trim()
        || new URL(fresh.url).href !== intendedUrl || (fresh.tabId !== undefined && fresh.tabId !== created.id)) {
        throw new CompanionError("target_recovery_readback_mismatch", "Fresh snapshot does not prove the exact intended replacement target");
      }
      const target = { ...capsule.target, taskId: payload.taskId, tabId: created.id, pageInstanceId: fresh.pageInstanceId,
        windowId: Number.isSafeInteger(fresh.windowId) ? fresh.windowId : created.windowId,
        origin: new URL(fresh.url).origin, leaseId: null };
      const tabRecord = this.taskLedger.getTaskTab(session.profileInstanceId, created.id);
      if (!tabRecord || tabRecord.capsuleId !== capsule.capsuleId || tabRecord.taskId !== payload.taskId
        || tabRecord.runId !== payload.runId || tabRecord.sessionId !== session.sessionId) {
        throw new CompanionError("target_recovery_creation_identity_invalid", "The new target lacks matching broker creation provenance");
      }
      await this.taskLedger.recordTaskTab({ ...tabRecord, lifecycleState: "completed", windowId: target.windowId,
        ...rebuildTaskTabIdentity(this.ledgerSecret, tabRecord, target), updatedAt: nowIso() });
      this.taskTabs.set(this.#tabKey(session.profileInstanceId, created.id), this.taskLedger.getTaskTab(session.profileInstanceId, created.id));
      const effect = { ...capsule.effect, effectState: "known_effect", dispatchCount: 1, externalActionExecuted: false };
      await this.taskLedger.transitionTaskCapsule(capsule.capsuleId, "post_read", {
        target, resources: { ...capsule.resources, tabId: created.id, exactTabLeaseId: null }, effect,
        visual: { ...capsule.visual, semanticPostRead: semanticReadback(fresh) } });
      const finalCapsule = await this.taskLedger.transitionTaskCapsule(capsule.capsuleId, "completed");
      const creation = this.taskLedger.get(`${payload.idempotencyKey}:0`);
      await this.taskLedger.transition(reservation.idempotencyKey, "applied", { brokerEvidence: true,
        createdTabId: created.id, creationOperationId: creation?.operationId, targetIdentity: target,
        resultDigest: payloadDigest(this.ledgerSecret, { capsuleId: capsule.capsuleId, target }) });
      return { ...receipt, result: "verified", effect_state: "known_effect", target,
        target_fingerprint: targetIdentityDigest(this.ledgerSecret, target), capsule: this.#publicTaskCapsule(finalCapsule),
        creation_operation_id: creation?.operationId, fresh_snapshot: fresh, target_readback_verified: true,
        next_action: "reserve_new_exact_target_then_use_separate_signed_transaction" };
    } catch (error) {
      if (!reservation) throw error;
      const creation = this.taskLedger.get(`${payload.idempotencyKey}:0`);
      const uncertain = creation && (creation.state === "unknown_effect"
        || creation.state !== "applied" && (creation.dispatchCount > 0 || Number.isSafeInteger(creation.createdTabId))
          && !(creation.effectState === "known_no_effect" && creation.brokerEvidence === true
            && creation.mutationDispatchProvenance === "authenticated_no_effect" && creation.mutationDispatchAttempted === false));
      const effectState = uncertain ? "unknown_effect" : creation?.state === "applied" ? "known_effect"
        : creation?.effectState === "known_no_effect" ? "known_no_effect" : "no_dispatch";
      const blocker = { code: error?.code ?? "target_recovery_failed", message: String(error?.message ?? error).slice(0, 400) };
      await this.taskLedger.transition(reservation.idempotencyKey, uncertain ? "unknown_effect" : effectState === "known_effect" ? "applied" : "blocked", {
        effectState, createdTabId: creation?.createdTabId ?? receipt.tab_id ?? null,
        creationOperationId: creation?.operationId ?? null, reason: blocker.code,
        externalActionExecuted: uncertain ? null : false,
      });
      const failed = await this.taskLedger.transitionTaskCapsule(capsule.capsuleId, uncertain ? "reconciliation_required" : "failed", {
        blocker, restartPoint: "read_existing_recovery_receipt_and_exact_target_without_recreating",
        resources: { ...capsule.resources, tabId: creation?.createdTabId ?? receipt.tab_id ?? null },
        effect: { ...capsule.effect, effectState, reconciliationRequired: Boolean(uncertain), externalActionExecuted: uncertain ? null : false },
      });
      return { ...receipt, result: uncertain ? "unknown_effect" : "blocked", effect_state: effectState,
        exact_blocker: blocker, creation_operation_id: creation?.operationId ?? null,
        capsule: this.#publicTaskCapsule(failed), next_action: "read_existing_recovery_receipt_and_exact_target_without_recreating" };
    } finally {
      if (lease) this.#deleteLease(lease.leaseId);
      if (this.taskTargetReservations.get(reservationKey) === session.sessionId) this.taskTargetReservations.delete(reservationKey);
    }
  }

  async #prepareResume(peer, params) {
    const session = this.#requireOwnedSession(peer, params.sessionId);
    const runId = requireString(params.runId, "runId");
    const taskId = requireString(params.taskId ?? session.taskId, "taskId");
    // `direct_application` is the one current-owner execution intent that
    // must not inherit a source-return handoff gate.  The value is narrowed
    // here as well as in the MCP schema/signed payload so an arbitrary intent
    // cannot turn the exception into a general bypass.
    const intent = params.intent === "direct_application" ? "direct_application" : "prepare_resume";
    const allowDirectApplication = intent === DIRECT_APPLICATION_INTENT;
    if (session.taskId && session.taskId !== taskId) {
      throw new CompanionError("task_id_mismatch", "Resume preparation taskId does not match the logical session task");
    }
    const idempotencyKey = params.idempotencyKey === undefined || params.idempotencyKey === null
      ? null
      : requireString(params.idempotencyKey, "idempotencyKey");
    const capsuleId = params.capsuleId === undefined || params.capsuleId === null
      ? null
      : requireString(params.capsuleId, "capsuleId");
    const payload = {
      runId,
      taskId,
      intent,
      idempotencyKey,
      capsuleId,
    };
    await this.taskLedger.verifyAndConsumeAuthority(params.authority, {
      secrets: this.issuerSecrets,
      payload,
      expected: {
        runId,
        taskId,
        ownerKey: session.sessionId,
        method: "task.prepare_resume",
        intent,
      },
    });
    const entry = idempotencyKey ? this.taskLedger.get(idempotencyKey) : null;
    const capsule = capsuleId
      ? this.taskLedger.getTaskCapsule(capsuleId)
      : this.taskLedger.findTaskCapsule({ taskId, runId, idempotencyKey });
    const matchingEntry = entry && entry.state !== "task_tab"
      && entry.binding?.taskId === taskId
      && entry.binding?.runId === runId
      ? entry
      : null;
    const matchingCapsule = capsule && capsule.taskId === taskId && capsule.runId === runId ? capsule : null;
    const taskTabs = [...this.taskTabs.values()]
      .filter((tab) => tab.taskId === taskId && tab.runId === runId && tab.profileInstanceId === session.profileInstanceId)
      .sort((left, right) => String(right.updatedAt ?? right.createdAt ?? "").localeCompare(String(left.updatedAt ?? left.createdAt ?? "")));
    const currentProfile = this.profiles.get(session.profileInstanceId);
    const currentGeneration = currentProfile?.generation ?? session.generation;
    const recordedTabId = matchingCapsule?.resources?.tabId ?? matchingCapsule?.target?.tabId
      ?? matchingEntry?.binding?.targetIdentity?.tabId;
    const candidateTabs = Number.isSafeInteger(recordedTabId)
      ? taskTabs.filter(tab => tab.tabId === recordedTabId)
      : matchingCapsule?.target?.targetKey
        ? taskTabs.filter(tab => tab.targetKey === matchingCapsule.target.targetKey)
        : taskTabs;
    const targetTab = candidateTabs.length === 1 ? candidateTabs[0] : null;
    const targetIdentity = targetTab?.targetIdentity
      ?? matchingCapsule?.target
      ?? matchingEntry?.binding?.targetIdentity
      ?? null;
    const targetIdentityConsistent = targetTab ? taskTabIdentityConsistent(this.ledgerSecret, targetTab) : null;
    const unresolved = this.taskLedger.listOperations()
      .filter((operation) => operation.binding?.taskId === taskId
        && operation.binding?.runId === runId
        && operationEffectStateForEntry(operation) === "unknown_effect"
        && !this.taskLedger.localSelectionResolution(operation));
    const unresolvedNavigation = unresolvedLocalNavigationForTarget(this.taskLedger.listOperations(), {
      profileInstanceId: session.profileInstanceId, tabId: targetTab?.tabId ?? recordedTabId,
    });
    const exactFootprint = targetTab && candidateTabs.length === 1 && targetIdentityConsistent === true
      ? { profileInstanceId: targetTab.profileInstanceId, tabId: targetTab.tabId } : null;
    const navigationGateIds = new Set(unresolvedNavigation.filter(operation => operationRequiresReconciliation(operation) === false
      && operation.externalActionExecuted !== true).map(operation => operation.operationId));
    // Keep the historical run/task count intact, but gate execution by the
    // trusted physical target. A foreign task's uncertainty on this tab still
    // blocks it; absent/ambiguous footprints remain conservative.
    const targetUnresolved = this.taskLedger.listOperations().filter(operation => {
      if (operationEffectStateForEntry(operation) !== "unknown_effect" || !uncertaintyBlocksContinuation(operation)
        || this.taskLedger.localSelectionResolution(operation)) return false;
      if (!exactFootprint) return operation.binding?.taskId === taskId && operation.binding?.runId === runId;
      const owner = operation.binding ?? {};
      return (!owner.profileInstanceId || owner.profileInstanceId === exactFootprint.profileInstanceId)
        && (!Number.isSafeInteger(owner.tabId) || owner.tabId === exactFootprint.tabId);
    }).filter(operation => !navigationGateIds.has(operation.operationId));
    let handoff = null;
    let handoffReadError = null;
    try {
      const gate = await readHandoffSourceGate({ taskId, receiptsDir: this.handoffReceiptsDir });
      handoff = {
        sourceStatus: gate.sourceStatus ?? null,
        implementationAllowed: gate.implementationAllowed === true,
        destinationTaskId: gate.destinationTaskId ?? null,
        receiptSha256: gate.receiptSha256 ?? null,
        handoffSuppressed: gate.handoffSuppressed === true,
      };
    } catch (error) {
      handoffReadError = { code: error?.code ?? "handoff_gate_read_failed", message: String(error?.message ?? error).slice(0, 400) };
    }
    const selectionSettlement = this.taskLedger.localSelectionSettlement(matchingCapsule);
    const settlement = capsuleNoEffectSettlement(matchingCapsule, this.taskLedger.listOperations()) ?? selectionSettlement;
    const effectState = normalizeOperationEffectState(
      settlement?.effectState ?? matchingCapsule?.effect?.effectState
        ?? matchingEntry?.effectState
        ?? matchingEntry?.operationEffectState,
      operationEffectStateForEntry(matchingEntry ?? matchingCapsule ?? {}),
    );
    const localNavigation = matchingCapsule?.effect?.idempotencyKey
      ? this.#localNavigationReconciliationOperation(
        matchingCapsule,
        matchingCapsule.effect.idempotencyKey,
        matchingCapsule.resources?.tabId,
      )
      : null;
    const effectRequiresReconciliation = effectState === "unknown_effect"
      && (operationRequiresReconciliation(matchingEntry ?? matchingCapsule ?? {}) || Boolean(localNavigation));
    const profileReady = currentProfile?.connected === true && currentProfile.generation === session.generation;
    const blockers = [];
    if (!profileReady) blockers.push({ code: "session_generation_stale", message: "Current owner session is not bound to a connected profile generation" });
    if (candidateTabs.length > 1) blockers.push({ code: "resume_target_ambiguous", message: "Several task targets match; supply the exact capsuleId or idempotencyKey" });
    if (targetTab && (targetTab.generation !== currentGeneration || targetTab.quarantine)) {
      blockers.push({ code: "resume_target_generation_stale", message: "The recorded tab needs fresh owner-scoped inspection in the current generation" });
    }
    if (Number.isSafeInteger(recordedTabId) && !targetTab) blockers.push({ code: "resume_target_missing", message: "The recorded task tab is absent from this profile's owned inventory" });
    if (handoffReadError) blockers.push(handoffReadError);
    if (handoff && handoff.implementationAllowed === false && !allowDirectApplication) {
      blockers.push({
        code: "source_handoff_implementation_forbidden",
        message: "The source task is reconciliation-only until its destination no-output proof is accepted",
        destinationTaskId: handoff.destinationTaskId,
        receiptSha256: handoff.receiptSha256,
      });
    }
    if (targetUnresolved.length > 0 || effectRequiresReconciliation) {
      blockers.push({
        code: "reconciliation_required",
        message: "An unknown effect must be reconciled before a retry or cleanup",
        operationIds: targetUnresolved.map((operation) => operation.operationId ?? operation.idempotencyKey).slice(0, 50),
      });
    }
    if (matchingCapsule?.state === "awaiting_user" || matchingCapsule?.retention?.userHelpRequired === true) {
      blockers.push({
        code: "user_help_required",
        message: "The capsule records an explicit user-only action before resume",
        requiredUserAction: matchingCapsule.retention?.requiredUserAction ?? null,
      });
    }
    if (matchingCapsule?.effect?.localNavigationArrivalSettled === true) {
      blockers.push({
        code: "local_navigation_arrival_maintenance_only",
        message: "The local navigation arrival was verified, but the original task remains failed; remaining actions are not dispatched by this maintenance proof",
      });
    }
    if (targetTab && targetIdentityConsistent === false) {
      blockers.push({ code: "task_tab_identity_mismatch", message: "The persisted target identity does not match the current owner fields" });
    }
    if (unresolvedNavigation.length > 0) blockers.push({ code: "local_navigation_readback_required",
      message: "The original reload/navigation on this exact target must be reconciled before external mutations",
      operationIds: unresolvedNavigation.map(entry => entry.operationId ?? entry.idempotencyKey).slice(0, 50) });
    for (const blocker of blockers) {
      Object.assign(blocker, blockerRecoveryContext({ code: blocker.code, taskId, runId,
        profileInstanceId: session.profileInstanceId, tabId: targetTab?.tabId ?? recordedTabId,
        targetKey: targetIdentity?.targetKey,
        nextAction: blocker.code === "source_handoff_implementation_forbidden"
          ? "complete_destination_no_output_proof_then_return_to_source"
          : blocker.code === "reconciliation_required" ? "perform_one_owner_signed_reconciliation_readback"
            : blocker.code === "local_navigation_readback_required" ? "reconcile_original_navigation_with_fresh_exact_target_evidence"
            : blocker.code === "user_help_required" ? "complete_recorded_user_action_then_prepare_resume_again"
              : "fresh_status_and_exact_owner_readback" }));
    }
    const exactBlocker = blockers[0] ?? null;
    const sharedBlocker = blockers.find(blocker => blocker.block_scope === "broker_connection")
      ?? blockers.find(blocker => blocker.block_scope === "profile")
      ?? blockers.find(blocker => blocker.block_scope === "task") ?? exactBlocker;
    const resumeReady = !exactBlocker;
    const readbackReady = profileReady && candidateTabs.length <= 1
      && (!Number.isSafeInteger(recordedTabId) || Boolean(targetTab))
      && (!targetTab || targetTab.generation === currentGeneration && !targetTab.quarantine && targetIdentityConsistent !== false);
    const proofEntry = settlement ? this.taskLedger.get(settlement.idempotencyKey) : matchingEntry;
    const proofIdempotencyKey = settlement?.idempotencyKey ?? idempotencyKey
      ?? matchingCapsule?.effect?.idempotencyKey
      ?? matchingEntry?.idempotencyKey
      ?? `resume:${taskId}:${runId}`;
    let effectProof = null;
    try {
      effectProof = signOperationEffectProof(this.ledgerSecret, {
        ownerKey: session.sessionId,
        taskId,
        runId,
        sessionId: session.sessionId,
        leaseId: targetTab?.targetIdentity?.leaseId ?? matchingCapsule?.target?.leaseId ?? matchingEntry?.binding?.targetIdentity?.leaseId ?? null,
        generation: currentGeneration,
        profileInstanceId: session.profileInstanceId,
        targetIdentity: targetIdentity ?? { taskId, sessionId: session.sessionId, generation: currentGeneration, profileInstanceId: session.profileInstanceId },
        operationId: proofEntry?.operationId ?? matchingCapsule?.effect?.operationId ?? null,
        idempotencyKey: proofIdempotencyKey,
        method: proofEntry?.binding?.method ?? "task.prepare_resume",
        effectClass: proofEntry?.effectClass ?? matchingCapsule?.effect?.effectClass ?? "external_commit",
        reconciliationRequired: settlement ? false : matchingEntry?.reconciliationRequired !== false
          && matchingCapsule?.effect?.reconciliationRequired !== false,
        dispatchCount: proofEntry?.dispatchCount ?? matchingCapsule?.effect?.dispatchCount ?? 0,
        effectState,
        externalActionExecuted: proofEntry?.externalActionExecuted ?? matchingCapsule?.effect?.externalActionExecuted ?? false,
        mutationDispatchAttempted: proofEntry?.mutationDispatchAttempted === true,
        cleanup: { state: targetTab ? "pending" : "not_required", tabClosed: false },
        capabilityDigest: currentProfile?.capabilitiesDigest ?? null,
        resultDigest: proofEntry?.resultDigest ?? null,
      });
    } catch {
      // A resume preparation without an existing operation is still useful;
      // only the optional proof is omitted when there is no stable operation
      // binding to sign.
      effectProof = null;
    }
    return {
      schema: "aos.chrome_companion.prepare_resume.v1",
      status: resumeReady ? "ready" : "blocked",
      task_id: taskId,
      run_id: runId,
      intent,
      session_id: session.sessionId,
      owner_key: session.sessionId,
      profile_instance_id: session.profileInstanceId,
      generation: currentGeneration,
      session_generation: session.generation,
      profile_connected: currentProfile?.connected === true,
      effect_state: effectState,
      effective_settlement: settlement,
      local_selection_settlement: selectionSettlement,
      // Expose the exact durable capsule selected by (taskId, runId,
      // idempotencyKey/capsuleId).  A resume caller must be able to carry
      // this identifier into the owner-signed reconciliation tools; omitting
      // it forced callers to guess from the task-tab inventory and caused a
      // false `status_capsule_id_missing` stop even when the broker had a
      // matching capsule.
      capsule_id: matchingCapsule?.capsuleId ?? null,
      capsule_state: matchingCapsule?.state ?? null,
      capsule_target: matchingCapsule?.target ?? null,
      capsule_resources: matchingCapsule?.resources ?? null,
      capsule_effect: matchingCapsule?.effect ?? null,
      action_progress: matchingCapsule?.effect?.actionProgress ?? null,
      dispatch_count: matchingEntry?.dispatchCount ?? matchingCapsule?.effect?.dispatchCount ?? 0,
      interrupted_classification: matchingEntry?.interruptedClassification ?? null,
      restart_recovery_disposition: matchingEntry?.restartRecoveryDisposition ?? null,
      safe_fresh_retry_allowed: matchingEntry?.restartRecoveryDisposition === "fresh_retry_allowed",
      target: targetIdentity,
      target_identity_consistent: targetIdentityConsistent,
      task_tab_count: taskTabs.length,
      unresolved_operation_count: unresolved.length,
      unresolved_operation_count_scope: "task_run",
      target_unresolved_external_operation_count: targetUnresolved.length,
      target_unresolved_external_operation_count_scope: exactFootprint ? "profile_tab" : "ambiguous_task_run",
      target_unresolved_navigation_operation_count: unresolvedNavigation.length,
      handoff,
      exact_blocker: exactBlocker,
      blockers,
      ...blockerRecoveryContext({ code: sharedBlocker?.code, taskId, runId,
        profileInstanceId: session.profileInstanceId, tabId: targetTab?.tabId ?? recordedTabId,
        targetKey: targetIdentity?.targetKey, nextAction: sharedBlocker?.next_action
          ?? "fresh_status_and_exact_owner_readback" }),
      resume_ready: resumeReady,
      readback_ready: readbackReady,
      mutation_resume_allowed: resumeReady,
      unresolved_local_navigation_count: unresolvedNavigation.length,
      fresh_session_required: false,
      replay_allowed: false,
      target_readback_required: !!targetTab,
      target_reservation: readbackReady && targetTab ? {
        tool: "companion_reserve_tab", arguments: { sessionId: session.sessionId, tabId: targetTab.tabId },
        next_tool: "companion_read_page",
      } : null,
      external_action_executed: false,
      operation_effect_proof: effectProof,
      next_action: exactBlocker?.code === "source_handoff_implementation_forbidden"
        ? "complete_destination_no_output_proof_then_return_to_source"
        : exactBlocker?.code === "reconciliation_required"
          ? "perform_one_owner_signed_reconciliation_readback"
          : exactBlocker?.code === "local_navigation_readback_required"
            ? "reconcile_original_navigation_with_fresh_exact_target_evidence"
          : exactBlocker?.code === "user_help_required"
            ? "complete_recorded_user_action_then_prepare_resume_again"
            : resumeReady
              ? targetTab ? "reserve_exact_target_and_read_back_before_remaining_actions" : "open_fresh_task_transaction_or_continue_same_owner_session"
              : "fresh_status_and_exact_owner_readback",
    };
  }

  async #assertTaskImplementationAllowed(taskId, { allowDirectApplication = false, allowVisualMaintenance = false } = {}) {
    if (!taskId) return;
    if (allowDirectApplication === true || allowVisualMaintenance === true) return;
    const gate = await readHandoffSourceGate({ taskId, receiptsDir: this.handoffReceiptsDir });
    if (!gate.implementationAllowed) {
      throw new CompanionError(
        "source_handoff_implementation_forbidden",
        "This source task is reconciliation-only after hookless handoff; continue in the recorded destination task",
        {
          sourceTaskId: taskId,
          sourceStatus: gate.sourceStatus,
          destinationTaskId: gate.destinationTaskId,
          receiptSha256: gate.receiptSha256,
        },
      );
    }
  }

  #publicTaskCapsule(capsule) {
    if (!capsule) return null;
    return {
      schema: capsule.schema,
      capsuleId: capsule.capsuleId,
      taskId: capsule.taskId,
      threadId: capsule.threadId,
      runId: capsule.runId,
      workflowType: capsule.workflowType,
      state: capsule.state,
      target: capsule.target,
      resources: capsule.resources,
      blocker: capsule.blocker,
      restartPoint: capsule.restartPoint,
      resumeToken: capsule.resumeToken,
      effect: capsule.effect ?? null,
      visual: capsule.visual,
      completion: capsule.completion,
      retention: capsule.retention,
      reconciliationGenerationRebind: capsule.reconciliationGenerationRebind ?? null,
      updatedAt: capsule.updatedAt,
    };
  }

  #targetLane(profileInstanceId) {
    let lane = this.targetLanes.get(profileInstanceId);
    if (!lane) {
      lane = {
        active: 0,
        maxActive: 0,
        admitted: 0,
        completed: 0,
        rejected: 0,
        queueWaitMsTotal: 0,
        queueWaitMsMax: 0,
        pending: [],
      };
      this.targetLanes.set(profileInstanceId, lane);
    }
    return lane;
  }

  #drainTargetLane(profileInstanceId) {
    const lane = this.targetLanes.get(profileInstanceId);
    if (!lane) return;
    while (lane.active < TARGET_OPERATION_CONCURRENCY && lane.pending.length > 0) {
      const item = lane.pending.shift();
      lane.active += 1;
      lane.maxActive = Math.max(lane.maxActive, lane.active);
      lane.admitted += 1;
      const queueWaitMs = Math.max(0, Date.now() - item.enqueuedAt);
      lane.queueWaitMsTotal += queueWaitMs;
      lane.queueWaitMsMax = Math.max(lane.queueWaitMsMax, queueWaitMs);
      Promise.resolve()
        .then(item.work)
        .then(item.resolve, item.reject)
        .finally(() => {
          lane.active = Math.max(0, lane.active - 1);
          lane.completed += 1;
          this.#drainTargetLane(profileInstanceId);
        });
    }
  }

  #withTargetSlot(profileInstanceId, work) {
    const lane = this.#targetLane(profileInstanceId);
    if (lane.pending.length >= TARGET_OPERATION_QUEUE_DEPTH) {
      lane.rejected += 1;
      return Promise.reject(new CompanionError(
        "target_operation_backpressure",
        "Target-scoped operation queue is full; retry after the current target work drains",
        {
          profileInstanceId,
          maxConcurrency: TARGET_OPERATION_CONCURRENCY,
          maxQueueDepth: TARGET_OPERATION_QUEUE_DEPTH,
        },
      ));
    }
    return new Promise((resolve, reject) => {
      lane.pending.push({ work, resolve, reject, enqueuedAt: Date.now() });
      this.#drainTargetLane(profileInstanceId);
    });
  }

  #enqueue(key, work) {
    const context = this.requestContext.getStore();
    const previous = this.operationQueues.get(key) ?? Promise.resolve();
    const targetPrefix = String(key).startsWith("tab:");
    const profileInstanceId = targetPrefix ? String(key).split(":")[1] : null;
    let admitted = false;
    const guardedWork = () => { this.#assertRequestActive(context); admitted = true; return work(); };
    const scheduledWork = () => {
      this.#assertRequestActive(context);
      return targetPrefix && profileInstanceId ? this.#withTargetSlot(profileInstanceId, guardedWork) : guardedWork();
    };
    const current = previous.catch(() => {}).then(scheduledWork);
    const cleanup = () => {
      if (this.operationQueues.get(key) === marker) {
        this.operationQueues.delete(key);
      }
    };
    const marker = current.then(cleanup, cleanup);
    this.operationQueues.set(key, marker);
    if (!context) return current;
    // Keep the ordering marker until the predecessor drains, even if this
    // caller stops waiting. New work must never overtake earlier work.
    return new Promise((resolve, reject) => {
      const signal = context.controller.signal;
      const abort = () => {
        // An admitted operation keeps receiving its original result. Its
        // dispatch guard still catches cancellation during durable prepare.
        if (admitted) return;
        try { this.#assertRequestActive(context); } catch (error) { reject(error); }
      };
      signal.addEventListener("abort", abort, { once: true });
      if (signal.aborted) abort();
      current.then(resolve, reject).finally(() => signal.removeEventListener("abort", abort));
    });
  }

  async #sendOperation({ profile, session, method, params, timeoutMs, authority, idempotencyKey, binding, fingerprint, allowedOrigins, targetOrigin, taskTabContext, timing = null, dispatchGuard = null, readEvidence = null }) {
    if (timing) timing.record.timings_ms.queue = performance.now() - timing.queuedAt;
    const assertDispatch = () => {
      this.#assertRequestActive();
      const current = this.profiles.get(profile.profileInstanceId);
      if (!current?.connected || current.generation !== profile.generation || current.peerId !== profile.peerId) throw new CompanionError("session_generation_stale", "Profile generation changed while operation was queued");
      if (!this.peers.get(profile.peerId)?.authenticated) throw new CompanionError("extension_transport_unavailable", "Profile Extension transport is unavailable");
      dispatchGuard?.();
    };
    try { assertDispatch(); } catch (error) { await this.#recordNotDispatched(idempotencyKey, error); throw error; }
    const peer = this.peers.get(profile.peerId);
    const operationId = createId("op");
    const mutation = MUTATION_METHODS.has(method);
    const reconciliationRequired = mutation && operationRequiresReconciliation({ method });
    const effectClass = reconciliationRequired ? "external_commit" : "local_ui";
    const dispatchPersistStartedAt = performance.now();
    if (idempotencyKey) {
      if (this.taskLedger.get(idempotencyKey)?.state !== "prepared") throw new CompanionError("idempotency_duplicate", "Operation was already dispatched or blocked; replay is forbidden");
      await this.taskLedger.transition(idempotencyKey, "dispatched", {
        operationId,
        dispatchedAt: nowIso(),
        binding,
        fingerprint,
        effectState: "no_dispatch",
        dispatchState: "dispatched",
        dispatchCount: 1,
        mutationDispatchAttempted: mutation,
        mutationDispatchProvenance: mutation ? "transport_inference" : "not_applicable",
        externalActionExecuted: mutation && reconciliationRequired ? null : false,
        effectClass,
        reconciliationRequired,
      });
      if (method === "tabs.stopLoading") {
        // A worker can disappear before returning or reporting detach. The
        // durable pending record must exist before the sole browser send.
        try {
          await this.taskLedger.annotateDebuggerCleanup({ operationId, binding, status: "pending" });
        } catch (error) {
          await this.#recordNotDispatched(idempotencyKey, error, operationId);
          throw error;
        }
      }
    }
    if (timing) timing.record.timings_ms.dispatch_persist = performance.now() - dispatchPersistStartedAt;
    // Durability may yield long enough for cancellation, lease release, or a
    // generation change. There is no browser effect until the send below.
    try { assertDispatch(); } catch (error) { await this.#recordNotDispatched(idempotencyKey, error, operationId); throw error; }
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        const pending = this.pendingOperations.get(operationId);
        if (pending) {
          // Do not leave a timed-out request in the active map forever when
          // Chrome never sends a late result. Keep only a bounded tombstone so
          // status reflects real pending work while reconciliation remains
          // possible without replaying the command.
          this.pendingOperations.delete(operationId);
          pending.timedOut = true;
          pending.state = "unknown_effect";
          pending.effectState = mutation ? "unknown_effect" : "known_no_effect";
          pending.dispatchState = "dispatched";
          pending.dispatchCount = 1;
          pending.mutationDispatchAttempted = mutation;
          pending.externalActionExecuted = mutation && reconciliationRequired ? null : false;
          pending.effectClass = effectClass;
          pending.reconciliationRequired = reconciliationRequired;
          pending.tombstoneExpiresAt = Date.now() + LATE_RESULT_TOMBSTONE_TTL_MS;
          this.timedOutOperations.set(operationId, pending);
        }
        if (idempotencyKey) void this.taskLedger.transition(
          idempotencyKey,
          mutation ? "unknown_effect" : "blocked",
          {
            operationId,
            reason: "dispatch_timeout",
            effectState: mutation ? "unknown_effect" : "known_no_effect",
            dispatchState: "dispatched",
            dispatchCount: 1,
            mutationDispatchAttempted: mutation,
            mutationDispatchProvenance: pending?.mutationDispatchProvenance ?? (mutation ? "transport_inference" : "not_applicable"),
            externalActionExecuted: mutation && reconciliationRequired ? null : false,
            effectClass,
            reconciliationRequired,
          },
        );
        const failure = new CompanionError(
            mutation ? "operation_effect_unknown" : "operation_timeout",
            mutation && reconciliationRequired
              ? "External-effect mutation timed out after dispatch; effect is unknown and must not be replayed automatically"
            : mutation
              ? "Local UI operation timed out after dispatch; use the same-target readback path and continue without replay"
            : "Read-only operation timed out",
          {
            operationId,
            method,
            timeoutMs,
            operationEffectState: mutation ? "unknown" : "known_no_effect",
            effectState: mutation ? "unknown_effect" : "known_no_effect",
            mutationDispatchAttempted: mutation,
            effectClass,
            reconciliationRequired,
          },
        );
        if (!mutation) failure[READ_ONLY_COMMAND_FAILURE] = true;
        reject(failure);
      }, timeoutMs);
      timer.unref();
      this.pendingOperations.set(operationId, {
        operationId,
        profileInstanceId: profile.profileInstanceId,
        generation: profile.generation,
        sessionId: session.sessionId,
        idempotencyKey,
        binding,
        state: "dispatched",
        effectState: "no_dispatch",
        dispatchState: "dispatched",
        dispatchCount: 1,
        mutationDispatchAttempted: mutation,
        mutationDispatchProvenance: mutation ? "transport_inference" : "not_applicable",
        externalActionExecuted: mutation && reconciliationRequired ? null : false,
        effectClass,
        reconciliationRequired,
        timedOut: false,
        taskTabContext,
        expectEvent: params.expectEvent ?? null,
        allowedOrigins,
        method,
        timing,
        readEvidence,
        startedAt: nowIso(),
        timer,
        resolve,
        reject,
      });
      if (timing) timing.sentAt = performance.now();
      this.#send(peer, {
        kind: "command.request",
        operationId,
        protocolVersion: PROTOCOL_VERSION,
        profileInstanceId: profile.profileInstanceId,
        generation: profile.generation,
        sessionId: session.sessionId,
        taskId: authority?.taskId ?? session.taskId ?? session.sessionId,
        taskLabel: session.label,
        authority,
        allowedOrigins,
        targetOrigin,
        method,
        params,
      });
    });
  }

  #requireOwnedSession(peer, sessionIdValue, { allowBuildMismatch = false } = {}) {
    const sessionId = requireString(sessionIdValue, "sessionId");
    const session = this.sessions.get(sessionId);
    if (!session || session.peerId !== peer.id) {
      throw new CompanionError("session_not_owned", "Logical session is missing or owned by another client");
    }
    const profile = this.profiles.get(session.profileInstanceId);
    if (!profile?.connected || profile.generation !== session.generation) {
      this.#deleteSession(sessionId);
      throw new CompanionError("session_generation_stale", "Logical session is stale after profile reconnect");
    }
    const provenanceMismatches = this.#profileBuildMismatches(profile);
    if (provenanceMismatches.length > 0 && !allowBuildMismatch) {
      throw new CompanionError("companion_build_refresh_required", "The connected Extension is stale; only a signed safe-boundary refresh is permitted", {
        profileInstanceId: profile.profileInstanceId,
        buildProvenanceMismatches: provenanceMismatches,
        allowedRecovery: ["extension.reload", "lease.release", "session.close(taskTerminal=false)"],
      });
    }
    session.lastSeenAt = Date.now();
    return session;
  }

  #publicSession(session) {
    return {
      sessionId: session.sessionId,
      profileInstanceId: session.profileInstanceId,
      generation: session.generation,
      label: session.label,
      taskId: session.taskId,
      createdAt: session.createdAt,
      capabilityHandshake: session.capabilityHandshake ?? null,
      buildProvenanceMismatches: this.#profileBuildMismatches(this.profiles.get(session.profileInstanceId)),
      requiresExtensionRefresh: this.#profileBuildMismatches(this.profiles.get(session.profileInstanceId)).length > 0,
    };
  }

  #publicLease(lease) {
    return {
      leaseId: lease.leaseId,
      sessionId: lease.sessionId,
      profileInstanceId: lease.profileInstanceId,
      generation: lease.generation,
      tabId: lease.tabId,
      targetIdentity: lease.targetIdentity ?? null,
      targetFingerprint: lease.targetFingerprint ?? null,
      acquiredAt: lease.acquiredAt,
    };
  }

  #deleteLease(leaseId) {
    const lease = this.leases.get(leaseId);
    if (!lease) {
      return;
    }
    this.leases.delete(leaseId);
    const tabKey = this.#tabKey(lease.profileInstanceId, lease.tabId);
    if (this.tabLeaseIndex.get(tabKey) === leaseId) {
      this.tabLeaseIndex.delete(tabKey);
    }
    this.sessions.get(lease.sessionId)?.leaseIds.delete(leaseId);
  }

  #deleteSession(sessionId) {
    const session = this.sessions.get(sessionId);
    if (!session) {
      return;
    }
    const profile = this.profiles.get(session.profileInstanceId);
    const extensionPeer = profile && this.peers.get(profile.peerId);
    if (extensionPeer?.authenticated && profile.generation === session.generation) {
      this.#send(extensionPeer, { kind: "session.closed", profileInstanceId: session.profileInstanceId,
        generation: session.generation, sessionId: session.sessionId });
    }
    for (const leaseId of [...session.leaseIds]) {
      this.#deleteLease(leaseId);
    }
    this.sessions.delete(sessionId);
    this.peers.get(session.peerId)?.sessionIds.delete(sessionId);
  }

  #tabKey(profileInstanceId, tabId) {
    return `${profileInstanceId}:${tabId}`;
  }

  async #invalidateProfile(profileInstanceId, code) {
    for (const session of [...this.sessions.values()]) {
      if (session.profileInstanceId === profileInstanceId) {
        this.#deleteSession(session.sessionId);
      }
    }
    const transitions = [];
    for (const operation of [...this.pendingOperations.values()]) {
      if (operation.profileInstanceId === profileInstanceId) {
        this.pendingOperations.delete(operation.operationId);
        clearTimeout(operation.timer);
        const mutation = MUTATION_METHODS.has(operation.method);
        const reconciliationRequired = mutation && operationRequiresReconciliation(operation);
        operation.effectState = mutation ? "unknown_effect" : "known_no_effect";
        operation.effectClass = reconciliationRequired ? "external_commit" : "local_ui";
        operation.reconciliationRequired = reconciliationRequired;
        if (operation.idempotencyKey) transitions.push(this.taskLedger.transition(
          operation.idempotencyKey,
          mutation ? "unknown_effect" : "blocked",
          {
            operationId: operation.operationId,
            reason: code,
            effectState: operation.effectState,
            effectClass: operation.effectClass,
            reconciliationRequired,
          },
        ));
        operation.reject(new CompanionError(mutation ? "operation_effect_unknown" : code, "Profile generation changed during operation", {
          causeCode: code, effectState: operation.effectState, mutationDispatchAttempted: mutation, reconciliationRequired,
        }));
      }
    }
    for (const [operationId, operation] of this.timedOutOperations) {
      if (operation.profileInstanceId === profileInstanceId) this.timedOutOperations.delete(operationId);
    }
    await Promise.allSettled(transitions);
    // A transport reconnect can be a normal Extension refresh while Chrome
    // and the exact tab are still alive; the disconnect handler skips
    // invalidation while extensionReloadInFlight is present.  An unexpected
    // Extension loss is different: no owner can safely resume the tab, so
    // detach it and let the next fresh task clean it up.  Broker restart is
    // handled by listen() before any profile reconnect.
    if (!["broker_stopped", "client_transport_disconnected", "extension_transport_disconnected"].includes(code)) return [];
    const detached = await this.taskLedger.detachUnknownTaskTabs({ profileInstanceId, reason: code, detachOrphaned: true });
    for (const taskTab of detached) {
      this.taskTabs.set(this.#tabKey(taskTab.profileInstanceId, taskTab.tabId), taskTab);
    }
    return detached;
  }

  #expireSessions() {
    const now = Date.now();
    for (const [operationId, operation] of this.timedOutOperations) {
      if (!operation.tombstoneExpiresAt || operation.tombstoneExpiresAt <= now) {
        this.timedOutOperations.delete(operationId);
      }
    }
    const cutoff = now - this.sessionTtlMs;
    for (const session of [...this.sessions.values()]) {
      if (session.lastSeenAt >= cutoff || this.expiringSessions.has(session.sessionId)) continue;
      this.expiringSessions.add(session.sessionId);
      const peer = this.peers.get(session.peerId);
      // An idle task session may have completed without issuing session.close.
      // Give the same owner-scoped terminal cleanup one last chance before
      // expiring the logical session. User-help/reconciliation/leased tabs
      // remain protected by #finalizeSessionTerminalTabs.
      if (peer && !peer.socket.destroyed && session.taskId) {
        void this.#finalizeSessionTerminalTabs(peer, session, { allowPreEffectCleanup: true })
          .catch(() => null)
          .finally(async () => {
            try {
              const detached = await this.taskLedger.detachUnknownTaskTabs({
                sessionIds: new Set([session.sessionId]),
                reason: "session_expired",
                detachOrphaned: true,
              });
              for (const taskTab of detached) {
                this.taskTabs.set(this.#tabKey(taskTab.profileInstanceId, taskTab.tabId), taskTab);
              }
            } finally {
              this.expiringSessions.delete(session.sessionId);
              if (this.sessions.has(session.sessionId)) this.#deleteSession(session.sessionId);
            }
          });
      } else {
        void this.taskLedger.detachUnknownTaskTabs({
          sessionIds: new Set([session.sessionId]),
          reason: "session_expired",
          detachOrphaned: true,
        }).then((detached) => {
          for (const taskTab of detached) {
            this.taskTabs.set(this.#tabKey(taskTab.profileInstanceId, taskTab.tabId), taskTab);
          }
        }).catch(() => null);
        this.expiringSessions.delete(session.sessionId);
        this.#deleteSession(session.sessionId);
      }
    }
  }

  async #terminalizeOrphanedReconciliations() {
    if (this.reconciliationExpiryInFlight || this.closing) return;
    this.reconciliationExpiryInFlight = true;
    try {
      const leasedTabKeys = new Set([...this.leases.values()]
        .map((lease) => this.#tabKey(lease.profileInstanceId, lease.tabId)));
      const result = await this.taskLedger.terminalizeOrphanedReconciliations({
        activeSessionIds: new Set(this.sessions.keys()),
        leasedTabKeys,
        ttlMs: ORPHANED_RECONCILIATION_TTL_MS,
      });
      for (const taskTab of result.taskTabs ?? []) {
        this.taskTabs.set(this.#tabKey(taskTab.profileInstanceId, taskTab.tabId), taskTab);
      }
    } catch {
      // Maintenance is best effort. The immutable ledger remains available
      // for the next status/readback pass after a transient persistence error.
    } finally {
      this.reconciliationExpiryInFlight = false;
    }
  }

  async #disconnectPeer(peer) {
    if (!this.peers.has(peer.id)) {
      return;
    }
    this.peers.delete(peer.id);
    for (const context of this.activeRequests.values()) {
      if (context.peerId === peer.id) context.controller.abort(new CompanionError("client_transport_disconnected", "Request owner disconnected"));
    }
    if (this.closing) return;
    const sessionIds = new Set(peer.sessionIds);
    if (peer.role === "client" && sessionIds.size > 0) {
      const transitions = [];
      for (const operation of [...this.pendingOperations.values()]) {
        if (!sessionIds.has(operation.sessionId)) continue;
        this.pendingOperations.delete(operation.operationId);
        clearTimeout(operation.timer);
        const mutation = MUTATION_METHODS.has(operation.method);
        const reconciliationRequired = mutation && operationRequiresReconciliation(operation);
        operation.timedOut = true;
        operation.effectState = mutation ? "unknown_effect" : "known_no_effect";
        operation.mutationDispatchAttempted = mutation;
        operation.externalActionExecuted = mutation && reconciliationRequired ? null : false;
        operation.effectClass = reconciliationRequired ? "external_commit" : "local_ui";
        operation.reconciliationRequired = reconciliationRequired;
        operation.tombstoneExpiresAt = Date.now() + LATE_RESULT_TOMBSTONE_TTL_MS;
        this.timedOutOperations.set(operation.operationId, operation);
        if (operation.idempotencyKey) {
          transitions.push(this.taskLedger.transition(operation.idempotencyKey, mutation ? "unknown_effect" : "blocked", {
            operationId: operation.operationId,
            reason: "client_transport_disconnected",
            effectState: mutation ? "unknown_effect" : "known_no_effect",
            dispatchState: "dispatched",
            dispatchCount: 1,
            mutationDispatchAttempted: mutation,
            mutationDispatchProvenance: operation.mutationDispatchProvenance,
            externalActionExecuted: mutation && reconciliationRequired ? null : false,
            effectClass: operation.effectClass,
            reconciliationRequired,
          }));
        }
        operation.reject(new CompanionError(mutation ? "operation_effect_unknown" : "client_transport_disconnected", "Client transport disconnected before operation completed", {
          causeCode: "client_transport_disconnected", effectState: operation.effectState, mutationDispatchAttempted: mutation, reconciliationRequired,
        }));
      }
      await Promise.allSettled(transitions);
      const detached = await this.taskLedger.detachUnknownTaskTabs({
        sessionIds,
        reason: "client_transport_disconnected",
        detachOrphaned: true,
      });
      for (const taskTab of detached) {
        this.taskTabs.set(this.#tabKey(taskTab.profileInstanceId, taskTab.tabId), taskTab);
      }
    }
    for (const sessionId of [...peer.sessionIds]) {
      this.#deleteSession(sessionId);
    }
    for (const profileInstanceId of peer.profileInstanceIds) {
      const profile = this.profiles.get(profileInstanceId);
      if (profile?.peerId === peer.id) {
        profile.connected = false;
        profile.disconnectedAt = nowIso();
        // A requested profile-global reload intentionally disconnects the
        // worker.  Preserve live task-tab provenance until the new generation
        // hello arrives; all other transport loss is owner loss and detaches
        // tabs into the ledger-only disposition.
        const replacementPeerPresent = [...this.peers.values()].some((candidate) =>
          candidate.id !== peer.id
          && candidate.role === "extension-relay"
          && candidate.profileInstanceIds.has(profileInstanceId));
        if (!this.extensionReloadInFlight.has(profileInstanceId) && !replacementPeerPresent) {
          await this.#invalidateProfile(profileInstanceId, "extension_transport_disconnected");
        }
      }
    }
  }

  #send(peer, message) {
    if (!peer.socket.destroyed) {
      writeJsonLine(peer.socket, message);
    }
  }
}
