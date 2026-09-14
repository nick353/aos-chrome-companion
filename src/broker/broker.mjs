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
  TARGET_METHODS,
} from "../shared/constants.mjs";
import { INSTALL_BUILD_ID } from "../shared/build-info.mjs";
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
  archiveReconciliationPayload,
  authorizedTransactionPayload,
  createHandoffAck,
  extensionReloadPayload,
  normalizeTaskExecutionCapsule,
  normalizeTargetIdentity,
  isUnresolvedOperationEffect,
  normalizeOperationEffectState,
  operationRequiresReconciliation,
  operationEffectStateForEntry,
  operationEffectProofPayload,
  signOperationEffectProof,
  payloadDigest,
  repairPreDispatchReadonlyPayload,
  rebuildTaskTabIdentity,
  TaskOperationLedger,
  taskTabIdentityConsistent,
  targetIdentityDigest,
  TERMINAL_LEDGER_RETENTION_MS,
} from "../shared/task-runtime.mjs";
import { bindTransactionStep, compileTransactionSteps } from "../shared/step-packet.mjs";
import { captureTransactionReadback, readSubmissionTransition, semanticReadback, transactionOutcome } from "../shared/transaction-readback.mjs";
import { createRecoveryHandle, deriveRecoveryIndex } from "../shared/recovery-state.mjs";
import { createRuntimeAttestation } from "../shared/runtime-attestation.mjs";
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
    && operationRequiresReconciliation(operation);
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
      // Missing handshake fields are intentionally exposed as null.  Filling
      // them with the broker's values would make an older installed
      // Extension look current and would hide the exact refresh boundary.
      operationSchema: profile.operationSchema ?? null,
      operationSchemaDigest: profile.operationSchemaDigest ?? null,
      operationSchemaVersion: profile.operationSchemaVersion ?? null,
      capabilitiesDigest: profile.capabilitiesDigest ?? null,
      expectedBuildId: INSTALL_BUILD_ID,
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
    // New Extension builds attest the generated operation contract during the
    // hello handshake.  Keep the fields optional for older local fixtures so
    // a reconnect can still be diagnosed, but reject an explicitly supplied
    // stale/mismatched contract before any session is opened.
    if (message.operationSchema !== undefined && message.operationSchema !== OPERATION_SCHEMA) {
      throw new CompanionError("companion_operation_schema_mismatch", "Companion Extension operation schema does not match the broker", {
        expectedOperationSchema: OPERATION_SCHEMA,
        receivedOperationSchema: message.operationSchema,
      });
    }
    if (message.operationSchemaVersion !== undefined && message.operationSchemaVersion !== OPERATION_SCHEMA_VERSION) {
      throw new CompanionError("companion_operation_schema_version_mismatch", "Companion Extension operation schema version does not match the broker", {
        expectedOperationSchemaVersion: OPERATION_SCHEMA_VERSION,
        receivedOperationSchemaVersion: message.operationSchemaVersion,
      });
    }
    if (message.operationSchemaDigest !== undefined && message.operationSchemaDigest !== OPERATION_SCHEMA_DIGEST) {
      throw new CompanionError("companion_operation_schema_digest_mismatch", "Companion Extension operation schema digest does not match the broker", {
        expectedOperationSchemaDigest: OPERATION_SCHEMA_DIGEST,
        receivedOperationSchemaDigest: message.operationSchemaDigest,
      });
    }
    if (message.capabilitiesDigest !== undefined) {
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
    if (message.event === "task.tab.created" && Number.isSafeInteger(message.tabId)) {
      const operation = this.pendingOperations.get(message.operationId)
        ?? this.timedOutOperations.get(message.operationId);
      const profileInstanceId = message.profileInstanceId
        ?? (peer.profileInstanceIds.size === 1 ? [...peer.profileInstanceIds][0] : null);
      if (operation?.taskTabContext
        && profileInstanceId === operation.profileInstanceId
        && operation.method === "tabs.create") {
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
    operation.awaitedEvent = event;
    operation.tombstoneExpiresAt = Date.now() + LATE_RESULT_TOMBSTONE_TTL_MS;
    this.timedOutOperations.set(operation.operationId, operation);
    if (operation.idempotencyKey) await this.taskLedger.transition(operation.idempotencyKey, "unknown_effect", {
      operationId: operation.operationId, reason: "action_event_pending", awaitedEvent: event,
      effectState: "unknown_effect", mutationDispatchAttempted: true, dispatchState: "dispatched", dispatchCount: 1,
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
    const peerOwnsOperation = profile?.peerId === peer?.id
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
    const completionStartedAt = performance.now();
    if (operation.timing) {
      operation.timing.record.timings_ms.transport_and_extension = completionStartedAt - operation.timing.sentAt;
      const measured = extensionTiming(message.executionTiming);
      if (measured) operation.timing.record.extension_timings_ms = measured;
    }
    if (timedOut) this.timedOutOperations.delete(message.operationId);
    else this.pendingOperations.delete(message.operationId);
    if (operation.timer) clearTimeout(operation.timer);
    const explicitNoEffect = isError
      && message.error?.details?.operationEffectState === "none"
        && message.error?.details?.mutationDispatchAttempted === false;
    // The command was sent, but the current Extension can prove that the
    // page mutation never started. Preserve this distinction in the receipt.
    if (explicitNoEffect) operation.mutationDispatchAttempted = false;
    const mutation = MUTATION_METHODS.has(operation.method);
    const readOnlyOperation = !mutation;
    const reconciliationRequired = mutation && operationRequiresReconciliation(operation);
    operation.reconciliationRequired = reconciliationRequired;
    operation.effectClass = reconciliationRequired ? "external_commit" : "local_ui";
    const localMutationError = isError && mutation && !reconciliationRequired;
    const explicitlyUnknown = mutation && (message.error?.code === "operation_effect_unknown"
      || ["unknown", "unknown_effect"].includes(message.error?.details?.operationEffectState));
    const observedEffectState = explicitNoEffect
      ? "known_no_effect"
      : isError
        ? (timedOut ? timedOutEffectState(operation) : (explicitlyUnknown ? "unknown_effect" : localMutationError ? "known_no_effect" : "unknown_effect"))
        : (timedOut && readOnlyOperation ? "known_no_effect" : "known_effect");
    if (operation.idempotencyKey) {
      if (isError) {
        if (explicitNoEffect && operation.timedOut && timedOutEffectState(operation) === "unknown_effect") {
          await this.taskLedger.reconcile(operation.idempotencyKey, operation.binding, {
            blocked: true,
            errorCode: message.error?.code ?? "extension_operation_failed",
            operationEffectState: "none",
            effectState: "known_no_effect",
          }, { brokerEvidence: true });
        } else {
          const nextState = observedEffectState === "unknown_effect" ? "unknown_effect" : "blocked";
          await this.taskLedger.transition(operation.idempotencyKey, nextState, {
            operationId: operation.operationId,
            errorCode: message.error?.code ?? "extension_operation_failed",
            effectState: observedEffectState,
            dispatchState: "dispatched",
            mutationDispatchAttempted: operation.mutationDispatchAttempted === true,
            effectClass: operation.effectClass,
            reconciliationRequired,
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
            brokerEvidence: true,
            effectState: observedEffectState,
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
    if (!isError && operation.method === "tabs.close" && Number.isSafeInteger(operation.binding?.tabId)) {
      this.taskTabs.delete(this.#tabKey(operation.profileInstanceId, operation.binding.tabId));
      await this.taskLedger.removeTaskTab(operation.profileInstanceId, operation.binding.tabId);
    }
    if (operation.timing) operation.timing.record.timings_ms.completion_persist_and_ownership = performance.now() - completionStartedAt;
    if (isError) {
      operation.reject(new CompanionError(
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
      ));
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
      case "task.reconciliation.inspect":
        return this.#inspectTaskReconciliation(peer, params);
      case "task.reconciliation.rebind":
        return this.#rebindTaskReconciliation(peer, params);
      case "task.reconciliation.repair_pre_dispatch":
        return this.#repairPreDispatchReadonly(peer, params);
      case "task.reconciliation.complete":
        return this.#completeTaskReconciliation(peer, params);
      case "operation.reconcile":
        return this.#reconcileOperation(peer, params);
      default:
        throw new CompanionError("client_method_unknown", `Unknown broker method: ${method}`);
    }
  }

  async #reloadExtension(peer, paramsValue) {
    const params = requireObject(paramsValue, "params");
    const session = this.#requireOwnedSession(peer, params.sessionId);
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
    const activeSessions = [...this.sessions.values()]
      .filter((entry) => entry.profileInstanceId === profileKey && entry.sessionId !== session.sessionId);
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
      });
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
    const session = this.#requireOwnedSession(peer, params.sessionId);
    const leaseCountBeforeClose = session.leaseIds.size;
    let terminalTabCleanup = { ok: true, status: "skipped", reason: "task_terminal_false" };
    if (params.taskTerminal !== false) {
      terminalTabCleanup = await this.#finalizeSessionTerminalTabs(peer, session, {
        allowPreEffectCleanup: params.taskTerminal !== false,
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

  async #finalizeSessionTerminalTabs(peer, session, { allowPreEffectCleanup = false } = {}) {
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
    for (const entry of entries) {
      const live = liveById.get(entry.tabId);
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
      const ledgerOnly = isLedgerOnlyTaskTab(entry);
      if (entry.retentionPolicy === "retain_until_resume" && ["partial_actions_applied", "local_ui_effect_unknown"].includes(entry.retentionReason)) {
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
    this.#requireOwnedSession(peer, lease.sessionId);
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

  async #executeOperation(peer, params, { trustedTask = null } = {}) {
    const operationStartedAt = performance.now();
    const session = this.#requireOwnedSession(peer, params.sessionId);
    const method = requireString(params.method, "operation method");
    if (!EXTENSION_METHODS.has(method)) {
      throw new CompanionError("capability_not_supported", `Unsupported extension operation: ${method}`);
    }
    const profile = this.profiles.get(session.profileInstanceId);
    if (!profile?.connected || profile.generation !== session.generation) {
      throw new CompanionError("session_generation_stale", "Session belongs to an inactive profile generation");
    }
    const operationParams = requireObject(params.params ?? {}, "operation params");
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
    if (isMutation && authority && !trustedTask && this.strictAuthority) {
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
        const taskTab = this.taskTabs.get(this.#tabKey(session.profileInstanceId, tabId))
          || this.taskLedger.getTaskTab(session.profileInstanceId, tabId);
        ownedTaskTab = taskTab;
        if (method === "page.observe" && (!taskTab || taskTab.taskId !== session.taskId)) {
          throw new CompanionError("task_tab_ownership_required", "Continuous observation is limited to this task's own tab");
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
    const idempotencyKey = isMutation
      ? (trustedTask ? `${trustedTask.idempotencyKey}:${trustedTask.index}` : authority?.idempotencyKey ?? null)
      : null;
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
    const prepareStartedAt = performance.now();
    if (idempotencyKey) {
      const existing = await this.taskLedger.prepare({ idempotencyKey, fingerprint, binding });
      if (existing.state !== "prepared") {
        throw new CompanionError("idempotency_duplicate", "This idempotency key has already been dispatched; replay is forbidden", { state: existing.state, operationId: existing.operationId });
      }
    }
    const preparedAt = performance.now();
    const dispatchGuard = () => {
      const currentSession = this.#requireOwnedSession(peer, session.sessionId);
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
        return result;
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
    const inspection = await this.#executeOperation(peer, {
      sessionId: session.sessionId,
      leaseId,
      method: "visual.inspectTarget",
      params: { tabId, locator },
    });
    const visual = await this.#executeOperation(peer, {
      sessionId: session.sessionId,
      leaseId,
      method: "page.screenshot",
      params: { tabId, restoreActive: true },
      timeoutMs: 30_000,
    });
    const visualPageUrl = String(inspection?.topLevelUrl || inspection?.url || "");
    if (visual?.kind !== "screenshot"
      || !visual.dataBase64
      || visual.tabId !== tabId
      || String(visual.url || "") !== visualPageUrl) {
      throw new CompanionError("visual_target_readback_mismatch", "Visual target geometry and screenshot did not identify the same exact tab and page");
    }
    const capturedAtCandidate = String(visual.capturedAt || "");
    const capturedAt = Number.isFinite(Date.parse(capturedAtCandidate)) ? capturedAtCandidate : nowIso();
    const expiresAt = new Date(Date.parse(capturedAt) + 60_000).toISOString();
    const proofPayload = {
      schema: "aos.chrome_companion.visual_target_proof.v1",
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
    if (consume) {
      this.consumedVisualProofs.set(signature, expiresAt);
      for (const [key, expiry] of this.consumedVisualProofs) if (expiry <= Date.now()) this.consumedVisualProofs.delete(key);
    }
    return {
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

  async #revalidateVisualTargetProof(peer, { session, lease, tabId, verified, currentUrl }) {
    if (verified?.kind === "point") {
      const snapshot = await this.#executeOperation(peer, {
        sessionId: session.sessionId,
        leaseId: lease.leaseId,
        method: "page.snapshot",
        params: { tabId, maxTextChars: 1_000 },
      });
      const inspection = await this.#executeOperation(peer, {
        sessionId: session.sessionId,
        leaseId: lease.leaseId,
        method: "visual.inspectPoint",
        params: { tabId, point: verified.point },
      });
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
    const inspection = await this.#executeOperation(peer, {
      sessionId: session.sessionId,
      leaseId: lease.leaseId,
      method: "visual.inspectTarget",
      params: { tabId, locator: verified.locator, scroll: false },
    });
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
          let inspection = await this.#executeOperation(peer, {
            sessionId: session.sessionId,
            leaseId: lease.leaseId,
            method: "visual.inspectTarget",
            params: { tabId: taskTab.id, locator, scroll: false, allowedOrigins },
          });
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
        delete actionParams.confirmationLocator;
        delete actionParams.confirmationTimeoutMs;
        if (method === "page.upload" || method === "page.uploadMultiple") {
          // A caller cannot independently relax FileList readback. A reset
          // control is admissible only when this transaction will verify a
          // newly appearing, explicit site attachment state after delivery.
          actionParams.allowInputReset = uploadConfirmationLocator !== null;
          if (uploadConfirmationLocator) {
            const confirmationBefore = await this.#executeOperation(peer, {
              sessionId: session.sessionId, leaseId: lease.leaseId, method: "page.query",
              params: { tabId: taskTab.id, locator: uploadConfirmationLocator, limit: 2, allowedOrigins },
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
          });
          await this.#revalidateVisualTargetProof(peer, { session, lease, tabId: taskTab.id, verified, currentUrl: before.url });
          delete actionParams.visualProof;
          actionParams.point = verified.point;
          if (method === "visual.drag") {
            const verifiedTo = this.#verifyVisualTargetProof({
              proof: actionParams.toVisualProof,
              session,
              lease,
              tabId: taskTab.id,
              currentUrl: before.url,
              currentPageInstanceId: before.pageInstanceId,
            });
            await this.#revalidateVisualTargetProof(peer, { session, lease, tabId: taskTab.id, verified: verifiedTo, currentUrl: before.url });
            delete actionParams.toVisualProof;
            actionParams.to = verifiedTo.point;
          }
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
        if ((method === "page.upload" || method === "page.uploadMultiple") && result?.requiresSiteConfirmation === true && !uploadConfirmationLocator) {
          throw new CompanionError("upload_confirmation_required", "The input was consumed after file delivery; inspect the site's attachment state without re-uploading", {
            operationEffectState: "unknown", mutationDispatchAttempted: true,
            nextAction: "inspect_existing_attachment_state_without_reupload",
          });
        }
        if (uploadConfirmationLocator) {
          // Uploading a FileList proves only the control state.  A workflow
          // may additionally bind one visible post-upload/confirmation
          // locator so the same transaction can prove the site's own state.
          try {
            uploadConfirmation = await this.#executeOperation(peer, {
            sessionId: session.sessionId,
            leaseId: lease.leaseId,
            method: "page.waitFor",
            params: {
              tabId: taskTab.id,
              locator: uploadConfirmationLocator,
              timeoutMs: uploadConfirmationTimeoutMs,
              allowedOrigins,
              targetOrigin: authority.targetOrigin,
            },
            });
            if (uploadConfirmation?.found !== true) throw new CompanionError("page_wait_timeout", "The site attachment confirmation was not observed");
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
      const effectMayHaveDispatched = (["operation_effect_unknown", "action_event_pending"].includes(error?.code) && errorRequiresReconciliation)
        || (mutationInFlight && currentOperationRequiresReconciliation
          && (["dispatched", "unknown_effect"].includes(operationState)
            || (operationState === "applied" && POST_DISPATCH_READBACK_ERRORS.has(error?.code))));
      // Keep the raw operation result honest for a local browser mutation
      // that did dispatch but returned late. Provider reconciliation and
      // local input uncertainty are distinct: preserve the original page for
      // an uncertain edit, while disposable tab setup follows its cleanup policy.
      const localUiEffectUnknown = !effectMayHaveDispatched
        && currentOperationMayMutate
        && !currentOperationRequiresReconciliation
        && (operationState === "unknown_effect"
          || ["operation_effect_unknown", "action_event_pending"].includes(error?.code)
          // tabs.create can emit a task.tab.created event before its
          // navigation acknowledgement.  The browser effect is local and
          // disposable, but the caller still needs the honest "unknown"
          // result so cleanup/readback can handle the created tab.
          || Number.isSafeInteger(error?.details?.createdTabId));
      const appliedMutations = appliedActions.filter((action) => action.mutation);
      const retainUncertainLocalEdit = localUiEffectUnknown && activeActionIndex !== null;
      const failedStepEffectState = effectMayHaveDispatched || localUiEffectUnknown
        ? "unknown_effect"
        : error?.details?.operationEffectState === "none" || error?.details?.effectState === "known_no_effect"
          ? "known_no_effect"
          : actionOperationKey && operationState === "applied" ? "known_effect" : "no_dispatch";
      const effectState = failedStepEffectState === "unknown_effect" ? "unknown_effect"
        : appliedMutations.length > 0 ? "known_effect" : failedStepEffectState;
      snapshot.failed_step = { index: activeActionIndex, effect_state: failedStepEffectState };
      snapshot.applied_actions = appliedActions.map(({ operationKey: _key, ...action }) => action);
      snapshot.completed_mutation_count = appliedMutations.length;
      snapshot.external_action_executed = effectState === "unknown_effect" ? null : appliedMutations.length > 0;
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
        }
        : {};
      snapshot.exact_blocker = {
        code: error?.code ?? "transaction_failed",
        message: String(error?.message ?? error).slice(0, 400),
        ...(Object.keys(blockerDetails).length > 0 ? { details: blockerDetails } : {}),
      };
      if (pendingActionEvent) snapshot.action_event = pendingActionEvent;
      // A terminal blocker is a checkpoint, not a prompt to keep the same
      // thread spinning.  Surface an explicit continuation gate so callers
      // can pause automatic continuation and resume only from the recorded
      // restart point after the blocker changes.
      snapshot.continuation = {
        allowed: false,
        reason: effectMayHaveDispatched ? "reconciliation_required" : localUiEffectUnknown ? "local_ui_readback_required" : appliedMutations.length > 0 ? "partial_actions_applied_readback_required" : "terminal_blocker",
        restart_point: effectMayHaveDispatched ? "signed_task_status_readback" : "task_failure_recovery",
        exact_blocker: snapshot.exact_blocker.code,
        ...(pendingActionEvent ? { reason: "action_event_pending", restart_point: "inspect_dialog_then_signed_response",
          next_action: pendingActionEvent.requiresUser ? "user_dialog_response" : "page.handleDialog",
          same_tab_id: taskTab?.id, same_run_id: runId, same_session_id: session.sessionId, trigger_replay_allowed: false } : {}),
      };
      const capsuleState = effectMayHaveDispatched ? "reconciliation_required" : "failed";
      let finalCapsule = null;
      try {
        finalCapsule = await this.taskLedger.transitionTaskCapsule(capsule.capsuleId, capsuleState, {
          blocker: snapshot.exact_blocker,
          restartPoint: effectMayHaveDispatched ? "signed_task_status_readback" : "task_failure_recovery",
          resumeToken: effectMayHaveDispatched ? (capsule.resumeToken ?? createId("resume")) : capsule.resumeToken,
          resources: { ...capsule.resources, exactTabLeaseId: lease?.leaseId ?? null, tabId: taskTab?.id ?? null },
          ...((appliedMutations.length > 0 || retainUncertainLocalEdit || dialogOnly) && !effectMayHaveDispatched ? {
            retention: { ...capsule.retention, policy: dialogOnly ? "retain" : "retain_until_resume", reason: dialogOnly ? "dialog_response_not_completed" : retainUncertainLocalEdit ? "local_ui_effect_unknown" : "partial_actions_applied",
              resumeAction: dialogOnly ? "inspect_dialog_then_signed_response" : "read_back_same_target_then_continue_remaining_actions", userHelpRequired: false },
          } : {}),
          effect: {
            ...(capsule.effect ?? {}),
            effectState,
            effectClass: effectMayHaveDispatched || appliedMutations.some((action) => action.reconciliationRequired) ? "external_commit" : "local_ui",
            reconciliationRequired: effectMayHaveDispatched,
            externalActionExecuted: effectState === "known_effect" ? true : effectState === "unknown_effect" ? null : false,
            dispatchCount: snapshot.dispatch_count,
            actionProgress: snapshot.action_progress,
            ...(pendingActionEvent ? { awaitedEvent: pendingActionEvent } : {}),
          },
        });
      } catch {
        // Preserve the original transaction blocker if durable status itself
        // is unavailable; the operation ledger still carries no-replay proof.
      }
      if (effectMayHaveDispatched) {
        snapshot.reconciliation = {
          run_id: runId,
          task_id: taskId,
          idempotency_key: currentOperation?.idempotencyKey ?? taskWithCapsule.idempotencyKey,
          operation_id: currentOperation?.operationId ?? null,
          state: operationState ?? "unknown_effect",
          restart_point: "signed_task_status_readback",
        };
      }
      // Preserve the page containing successful edits when a later step fails.
      const retainPartialMutation = appliedMutations.length > 0 || retainUncertainLocalEdit;
      // The default transaction also needs its exact page to reconcile an
      // uncertain submission. Omitting an optional capsule or retention flag
      // must not close the only provider evidence after dispatch.
      const retainUnknown = Boolean(pendingActionEvent) || effectMayHaveDispatched;
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
            retentionReason: capsuleState === "reconciliation_required" ? "ai_reconciliation_pending" : retainUncertainLocalEdit ? "local_ui_effect_unknown" : retainPartialMutation ? "partial_actions_applied" : dialogOnly ? "dialog_response_not_completed" : null,
            whyTabWasKept: capsuleState === "reconciliation_required"
              ? "The task-owned tab is retained temporarily while Codex reconciles an unknown external effect without replaying it."
              : retainUncertainLocalEdit ? "A local edit was dispatched but its result is unknown; preserve the page and read it back without replaying the edit."
                : retainPartialMutation ? "The page contains successful actions from an interrupted transaction; read it back before continuing only the remaining actions." : dialogOnly ? "The dialog response was not completed; retain its page for exact dialog inspection." : null,
            requiredUserAction: null,
            resumeAction: capsuleState === "reconciliation_required" ? "signed_task_status_readback_then_cleanup_when_reconciled" : retainPartialMutation ? "read_back_same_target_then_continue_remaining_actions" : dialogOnly ? "inspect_dialog_then_signed_response" : null,
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
      throw new CompanionError("task_reconciliation_not_found", "No matching task reconciliation capsule exists for this run and idempotency key");
    }
    if (capsule.state !== "reconciliation_required") {
      throw new CompanionError("task_reconciliation_state_invalid", `Task reconciliation requires reconciliation_required state, not ${capsule.state}`);
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
    return { runId, taskId, idempotencyKey, capsule, capsuleId: capsule.capsuleId, tabId, lease, taskTab };
  }

  async #inspectTaskReconciliation(peer, params) {
    const session = this.#requireOwnedSession(peer, params.sessionId);
    const binding = this.#requireTaskReconciliationBinding(session, params);
    const successQuery = requireString(params.successQuery, "successQuery").replace(/\s+/gu, " ").trim();
    if (successQuery.length < 8 || successQuery.length > 500) {
      throw new CompanionError("reconciliation_success_query_invalid", "Reconciliation successQuery must contain 8 to 500 characters");
    }
    const semantic = await this.#executeOperation(peer, {
      sessionId: session.sessionId,
      leaseId: binding.lease.leaseId,
      method: "page.snapshot",
      params: { tabId: binding.tabId, maxTextChars: 30_000 },
    });
    const query = await this.#executeOperation(peer, {
      sessionId: session.sessionId,
      leaseId: binding.lease.leaseId,
      method: "page.query",
      params: { tabId: binding.tabId, query: successQuery, limit: 10 },
    });
    if (!Number.isSafeInteger(query?.count) || query.count < 1 || !Array.isArray(query.matches)) {
      throw new CompanionError("reconciliation_success_evidence_not_found", "No visible semantic success evidence matched the exact reconciliation tab");
    }
    const visual = await this.#executeOperation(peer, {
      sessionId: session.sessionId,
      leaseId: binding.lease.leaseId,
      method: "page.screenshot",
      params: { tabId: binding.tabId, restoreActive: true },
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
      queryDigest: payloadDigest(this.ledgerSecret, { successQuery, matches: query.matches }),
      screenshotDigest: payloadDigest(this.ledgerSecret, visual.dataBase64),
      capturedAt,
      expiresAt,
    };
    return {
      kind: "reconciliation_visual_confirmation",
      semantic,
      successEvidence: query,
      visual,
      reconciliationProof: { ...proofPayload, signature: payloadDigest(this.ledgerSecret, proofPayload) },
      visual_readback_verified: true,
      external_action_executed: false,
      mutation_dispatch_attempted: false,
      mutation_dispatch_count: 0,
      operation_effect_state: "none",
    };
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
      || !Number.isFinite(expiresAt)
      || expiresAt <= Date.now()) {
      throw new CompanionError("reconciliation_visual_proof_invalid", "Reconciliation proof is stale, consumed, or does not match the exact task/session/lease/tab/generation binding");
    }
    const semantic = await this.#executeOperation(peer, {
      sessionId: session.sessionId,
      leaseId: binding.lease.leaseId,
      method: "page.snapshot",
      params: { tabId: binding.tabId, maxTextChars: 30_000 },
    });
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
      params: { tabId: binding.tabId, restoreActive: true },
      timeoutMs: 30_000,
    });
    const queryDigest = payloadDigest(this.ledgerSecret, { successQuery: proofPayload.successQuery, matches: query?.matches ?? [] });
    const screenshotDigest = visual?.dataBase64
      ? payloadDigest(this.ledgerSecret, visual.dataBase64)
      : null;
    if (String(semantic?.url || "") !== String(proofPayload.pageUrl || "")
      || semantic?.pageInstanceId !== proofPayload.pageInstanceId
      || String(query?.url || "") !== String(proofPayload.pageUrl || "")
      || query?.pageInstanceId !== proofPayload.pageInstanceId
      || !Number.isSafeInteger(query?.count)
      || query.count < 1
      || queryDigest !== proofPayload.queryDigest
      || visual?.kind !== "screenshot"
      || visual?.tabId !== binding.tabId
      || String(visual?.url || "") !== String(proofPayload.pageUrl || "")
      || screenshotDigest !== proofPayload.screenshotDigest) {
      throw new CompanionError("reconciliation_readback_changed", "The exact success page, semantic evidence, or screenshot changed after visual inspection");
    }
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
          schema: "aos.chrome_companion.reconciliation_completion.v1",
          status: "completed",
          successQuerySha256: createHash("sha256").update(proofPayload.successQuery, "utf8").digest("hex"),
          pageUrl: proofPayload.pageUrl,
          completedAt,
        },
        cleanup: { status: "pending_terminal_session_close" },
      },
      retention: {
        policy: "cleanup",
        resumeTokenRequired: false,
        userHelpRequired: false,
        reason: null,
        whyTabWasKept: null,
        requiredUserAction: null,
        resumeAction: null,
      },
    }, { brokerEvidence: true, proofDigest: payloadDigest(this.ledgerSecret, proofPayload) });
    const remainingActions = completedCapsule.effect?.actionProgress?.remaining_action_indices ?? [];
    const resumeRemaining = remainingActions.length > 0;
    await this.taskLedger.recordTaskTab({
      ...binding.taskTab,
      lifecycleState: completedCapsule.state,
      retentionPolicy: resumeRemaining ? "retain_until_resume" : "cleanup",
      resumeToken: null,
      userHelpRequired: false,
      retentionReason: resumeRemaining ? "partial_actions_applied" : null,
      whyTabWasKept: null,
      requiredUserAction: null,
      resumeAction: resumeRemaining ? "read_back_same_target_then_continue_remaining_actions" : null,
      updatedAt: completedAt,
    });
    this.taskTabs.set(
      this.#tabKey(session.profileInstanceId, binding.tabId),
      this.taskLedger.getTaskTab(session.profileInstanceId, binding.tabId),
    );
    return {
      schema: "aos.chrome_companion.reconciliation_completion.v1",
      status: resumeRemaining ? "ready_to_resume" : "completed",
      run_id: binding.runId,
      task_id: binding.taskId,
      idempotency_key: binding.idempotencyKey,
      capsule_id: binding.capsuleId,
      tab_id: binding.tabId,
      state: completedCapsule.state,
      effect_state: "known_effect",
      reconciliation_required: false,
      action_progress: completedCapsule.effect?.actionProgress ?? null,
      terminal_cleanup_ready: !resumeRemaining,
      next_action: resumeRemaining ? "companion_prepare_resume" : "companion_close_session_task_terminal_true",
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
    const lateResultReconciled = operationState === "reconciled" && entry?.brokerEvidence === true;
    const state = capsule?.state ?? operationState;
    const effectState = normalizeOperationEffectState(
      capsule?.effect?.effectState
        ?? entry?.effectState
        ?? entry?.operationEffectState,
      operationEffectStateForEntry(entry ?? capsule ?? {}),
    );
    const effectRequiresReconciliation = effectState === "unknown_effect"
      && operationRequiresReconciliation(entry ?? capsule ?? {});
    const currentProfile = this.profiles.get(session.profileInstanceId);
    const trackedTabId = capsule?.resources?.tabId ?? entry?.binding?.tabId ?? null;
    const trackedGeneration = capsule?.target?.generation ?? entry?.binding?.generation ?? null;
    const trackedProfileInstanceId = capsule?.target?.profileInstanceId ?? entry?.binding?.profileInstanceId ?? null;
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
    const resumeDisposition = state === "completed"
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
              retention_reason: lateResultReconciled ? "ai_terminal_readback_pending" : "ai_reconciliation_pending",
              why_tab_was_kept: lateResultReconciled
                ? "The broker received a late successful result; Codex must perform one same-target readback before terminal cleanup."
                : "The task-owned tab is retained temporarily while Codex reconciles an unknown external effect without replaying it.",
              required_user_action: null,
              resume_action: lateResultReconciled
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
      result: effectRequiresReconciliation || state === "reconciliation_required" ? "reconciliation_required" : "readback",
      run_id: runId,
      task_id: taskId,
      idempotency_key: idempotencyKey ?? capsule?.effect?.idempotencyKey ?? null,
      capsule_id: capsule?.capsuleId ?? null,
      operation_id: entry?.operationId ?? null,
      state,
      operation_state: operationState,
      effect_state: effectState,
      effectState,
      reconciliation_required: effectRequiresReconciliation,
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
        && state !== "awaiting_user"
        && state !== "reconciliation_required"
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
        && operation.binding?.profileInstanceId === session.profileInstanceId
        && (!Number.isSafeInteger(recordedTabId) || operation.binding?.tabId === recordedTabId)
        && isUnresolvedOperationEffect(operation));
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
    const effectState = normalizeOperationEffectState(
      matchingCapsule?.effect?.effectState
        ?? matchingEntry?.effectState
        ?? matchingEntry?.operationEffectState,
      operationEffectStateForEntry(matchingEntry ?? matchingCapsule ?? {}),
    );
    const effectRequiresReconciliation = effectState === "unknown_effect"
      && operationRequiresReconciliation(matchingEntry ?? matchingCapsule ?? {});
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
    if (unresolved.length > 0 || effectRequiresReconciliation) {
      blockers.push({
        code: "reconciliation_required",
        message: "An unknown effect must be reconciled before a retry or cleanup",
        operationIds: unresolved.map((operation) => operation.operationId ?? operation.idempotencyKey).slice(0, 50),
      });
    }
    if (matchingCapsule?.state === "awaiting_user" || matchingCapsule?.retention?.userHelpRequired === true) {
      blockers.push({
        code: "user_help_required",
        message: "The capsule records an explicit user-only action before resume",
        requiredUserAction: matchingCapsule.retention?.requiredUserAction ?? null,
      });
    }
    if (targetTab && targetIdentityConsistent === false) {
      blockers.push({ code: "task_tab_identity_mismatch", message: "The persisted target identity does not match the current owner fields" });
    }
    const exactBlocker = blockers[0] ?? null;
    const resumeReady = !exactBlocker;
    const proofIdempotencyKey = idempotencyKey
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
        operationId: matchingEntry?.operationId ?? matchingCapsule?.effect?.operationId ?? null,
        idempotencyKey: proofIdempotencyKey,
        method: matchingEntry?.binding?.method ?? "task.prepare_resume",
        effectClass: matchingEntry?.effectClass ?? matchingCapsule?.effect?.effectClass ?? "external_commit",
        reconciliationRequired: matchingEntry?.reconciliationRequired !== false
          && matchingCapsule?.effect?.reconciliationRequired !== false,
        dispatchCount: matchingEntry?.dispatchCount ?? matchingCapsule?.effect?.dispatchCount ?? 0,
        effectState,
        externalActionExecuted: matchingEntry?.externalActionExecuted ?? matchingCapsule?.effect?.externalActionExecuted ?? false,
        mutationDispatchAttempted: matchingEntry?.mutationDispatchAttempted === true,
        cleanup: { state: targetTab ? "pending" : "not_required", tabClosed: false },
        capabilityDigest: currentProfile?.capabilitiesDigest ?? null,
        resultDigest: matchingEntry?.resultDigest ?? null,
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
      handoff,
      exact_blocker: exactBlocker,
      blockers,
      resume_ready: resumeReady,
      fresh_session_required: false,
      replay_allowed: false,
      target_readback_required: !!targetTab,
      target_reservation: resumeReady && targetTab ? {
        tool: "companion_reserve_tab", arguments: { sessionId: session.sessionId, tabId: targetTab.tabId },
        next_tool: "companion_read_page",
      } : null,
      external_action_executed: false,
      operation_effect_proof: effectProof,
      next_action: exactBlocker?.code === "source_handoff_implementation_forbidden"
        ? "complete_destination_no_output_proof_then_return_to_source"
        : exactBlocker?.code === "reconciliation_required"
          ? "perform_one_owner_signed_reconciliation_readback"
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

  async #sendOperation({ profile, session, method, params, timeoutMs, authority, idempotencyKey, binding, fingerprint, allowedOrigins, targetOrigin, taskTabContext, timing = null, dispatchGuard = null }) {
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
        externalActionExecuted: mutation && reconciliationRequired ? null : false,
        effectClass,
        reconciliationRequired,
      });
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
          pending.effectState = mutation ? "unknown_effect" : "known_no_effect";
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
            externalActionExecuted: mutation && reconciliationRequired ? null : false,
            effectClass,
            reconciliationRequired,
          },
        );
        reject(new CompanionError(
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
        ));
      }, timeoutMs);
      timer.unref();
      this.pendingOperations.set(operationId, {
        operationId,
        profileInstanceId: profile.profileInstanceId,
        generation: profile.generation,
        sessionId: session.sessionId,
        idempotencyKey,
        binding,
        effectState: "no_dispatch",
        mutationDispatchAttempted: mutation,
        externalActionExecuted: mutation && reconciliationRequired ? null : false,
        effectClass,
        reconciliationRequired,
        timedOut: false,
        taskTabContext,
        expectEvent: params.expectEvent ?? null,
        allowedOrigins,
        method,
        timing,
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

  #requireOwnedSession(peer, sessionIdValue) {
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
