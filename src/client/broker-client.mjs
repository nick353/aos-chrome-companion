import { AsyncLocalStorage } from "node:async_hooks";
import { connectPeer } from "./connect.mjs";
import { CompanionError } from "../shared/errors.mjs";
import { DEFAULT_OPERATION_TIMEOUT_MS, DEFAULT_OPERATION_TIMEOUTS_MS, EXTENSION_METHODS, MUTATION_METHODS } from "../shared/constants.mjs";
import { normalizeTimeout } from "../shared/validation.mjs";
import { createId } from "../shared/ids.mjs";
import { archiveReconciliationPayload, authorizedTransactionPayload, createAuthorityEnvelope, ensureIssuerSecret, extensionReloadPayload, prepareResumePayload, repairPreDispatchReadonlyPayload } from "../shared/task-runtime.mjs";
import { planExtensionRefreshBoundary, verifyFreshExtensionGeneration, EXTENSION_REFRESH_BOUNDARY_SCHEMA } from "../shared/extension-refresh.mjs";
import { taskStatusPayload } from "../shared/operation-audit.mjs";

const RECONNECTABLE_READ_METHODS = new Set(["status.get", "profile.list"]);
const RECONNECTABLE_ERROR_CODES = new Set(["broker_connection_closed", "broker_request_timeout"]);
const requestSignals = new AsyncLocalStorage();
const RELEASE_METHODS = new Set(["session.close", "lease.release"]);

// The MCP SDK supplies one signal per tool call. Keep concurrent calls scoped
// independently, including requests made after asynchronous authority signing.
export function withBrokerRequestSignal(signal, work) {
  return requestSignals.run(signal, work);
}

export class BrokerClient {
  constructor(peer, {
    env = process.env,
    issuer = "codex_mcp",
    autoStart = true,
    connectPeerFactory = connectPeer,
  } = {}) {
    this.peer = null;
    this.pending = new Map();
    this.openedSessions = new Map();
    this.env = env;
    this.issuer = issuer;
    this.autoStart = autoStart;
    this.connectPeerFactory = connectPeerFactory;
    this.closed = false;
    this.connected = false;
    this.connectionGeneration = 0;
    this.reconnectCount = 0;
    this.reconnectPromise = null;
    this.issuerSecretPromise = null;
    this.removeMessageListener = () => {};
    this.removeCloseListener = () => {};
    this.#attachPeer(peer);
  }

  static async connect(options = {}) {
    const env = options.env ?? process.env;
    const autoStart = options.autoStart ?? true;
    const connectPeerFactory = options.connectPeerFactory ?? connectPeer;
    const peer = await connectPeerFactory({ role: "client", autoStart, env });
    return new BrokerClient(peer, {
      env,
      issuer: options.issuer ?? "codex_mcp",
      autoStart,
      connectPeerFactory,
    });
  }

  async request(method, params = {}, { timeoutMs, signal = RELEASE_METHODS.has(method) ? null : requestSignals.getStore() } = {}) {
    // A read must be allowed to receive the broker's operation result. The
    // former 20s RPC deadline expired before a normal 30s screenshot deadline.
    // Include a bounded queue/transport allowance; never retry the read or
    // change mutation deadlines implicitly.
    timeoutMs ??= method === "operation.execute" && EXTENSION_METHODS.has(params.method) && !MUTATION_METHODS.has(params.method)
      ? Math.max(20_000, normalizeTimeout(params.timeoutMs, DEFAULT_OPERATION_TIMEOUTS_MS[params.method] ?? DEFAULT_OPERATION_TIMEOUT_MS) + 15_000)
      : 20_000;
    if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 600_000) {
      throw new CompanionError("invalid_timeout", "Broker request timeout must be between 1 and 600000 milliseconds");
    }
    const deadlineAt = Date.now() + timeoutMs;
    const reconnectable = RECONNECTABLE_READ_METHODS.has(method);
    if (signal?.aborted) throw new CompanionError("broker_request_cancelled", `Broker request cancelled before ${method}`);
    if (!this.connected) {
      if (!reconnectable) {
        throw new CompanionError(
          "broker_reconnect_required",
          `Broker connection changed before ${method}; obtain fresh status and create a new logical session`,
        );
      }
      await this.#reconnect();
    }
    try {
      // A status/profile probe may reconnect once. Reserve part of the same
      // caller budget for that recovery instead of extending the deadline.
      const firstDeadlineAt = reconnectable ? Date.now() + Math.max(1, Math.floor((deadlineAt - Date.now()) / 2)) : deadlineAt;
      const result = await this.#requestOnce(method, params, { deadlineAt: Math.min(deadlineAt, firstDeadlineAt), signal });
      if (method === "session.open" && result?.taskId === params.taskId && result?.profileInstanceId) {
        this.openedSessions.set(result.sessionId, { ...result });
      }
      if (method === "session.close" && result?.closed) this.openedSessions.delete(params.sessionId);
      return result;
    } catch (error) {
      if (!reconnectable || !RECONNECTABLE_ERROR_CODES.has(error?.code) || signal?.aborted || Date.now() >= deadlineAt) throw error;
      await this.#reconnect();
      return this.#requestOnce(method, params, { deadlineAt, signal });
    }
  }

  connectionInfo() {
    return {
      connected: this.connected,
      connectionGeneration: this.connectionGeneration,
      reconnectCount: this.reconnectCount,
    };
  }

  /** Recover only a session opened by this client, on its original profile.
   * No lease or browser action is recovered or replayed here. */
  async recoverOwnedSession({ sessionId, taskId }, { timeoutMs = 5_000 } = {}) {
    const previous = this.openedSessions.get(sessionId);
    if (!previous || !taskId || previous.taskId !== taskId) {
      throw new CompanionError("session_recovery_binding_missing", "Recovery requires a session previously opened by this client for this task");
    }
    const status = await this.request("status.get", {}, { timeoutMs });
    const profile = status.profiles?.find(entry => entry.profileInstanceId === previous.profileInstanceId && entry.connected);
    if (!profile) {
      throw new CompanionError("profile_not_connected", "The original Companion profile has not reconnected", { profileInstanceId: previous.profileInstanceId });
    }
    const session = await this.request("session.open", {
      taskId, profileInstanceId: previous.profileInstanceId, label: previous.label,
    }, { timeoutMs });
    if (session.sessionId !== sessionId) this.openedSessions.delete(sessionId);
    return session;
  }

  #requestOnce(method, params, { deadlineAt, signal }) {
    const id = createId("request");
    const peer = this.peer;
    return new Promise((resolve, reject) => {
      if (signal?.aborted || deadlineAt <= Date.now()) {
        reject(new CompanionError(signal?.aborted ? "broker_request_cancelled" : "broker_request_timeout", `Broker request ended before ${method}`));
        return;
      }
      const cancel = (code) => {
        const pending = this.pending.get(id);
        if (!pending) return;
        this.pending.delete(id);
        pending.cleanup();
        // Cancellation names only a request on the original authenticated
        // connection. Never replay it on a replacement peer.
        try { peer?.send({ id: createId("cancel"), method: "request.cancel", params: { requestId: id } }); } catch { /* deadline is also on the original envelope */ }
        reject(new CompanionError(code, `Broker request ended: ${method}`));
      };
      const timer = setTimeout(() => cancel("broker_request_timeout"), Math.max(1, deadlineAt - Date.now()));
      timer.unref();
      const abort = () => cancel("broker_request_cancelled");
      const cleanup = () => { clearTimeout(timer); signal?.removeEventListener("abort", abort); };
      this.pending.set(id, { resolve, reject, timer, cleanup });
      signal?.addEventListener("abort", abort, { once: true });
      try {
        peer.send({ id, method, params, deadlineAt });
      } catch (error) {
        cleanup();
        this.pending.delete(id);
        reject(new CompanionError("broker_connection_closed", `Broker connection closed before ${method}`, {
          cause: error?.message,
        }));
      }
    });
  }

  async requestAuthorizedTransaction(params, { timeoutMs = 120_000, signal } = {}) {
    let targetOrigin = params.targetOrigin;
    if (targetOrigin === undefined && params.startUrl) {
      try {
        const url = new URL(params.startUrl);
        if (["http:", "https:"].includes(url.protocol)) targetOrigin = url.origin;
      } catch { /* The broker returns the existing invalid URL error. */ }
    }
    targetOrigin ??= "*";
    const secret = await this.#issuerSecret();
    const authority = createAuthorityEnvelope({
      issuer: this.issuer,
      secret,
      runId: params.runId,
      taskId: params.taskId,
      ownerKey: params.sessionId,
      method: "task.transaction",
      intent: params.intent ?? "authorized_transaction",
      targetOrigin,
      idempotencyKey: params.idempotencyKey ?? null,
      payload: authorizedTransactionPayload(params),
      approved: true,
    });
    const requestParams = { ...params, targetOrigin, authority };
    if (params.keepTaskTab === undefined) delete requestParams.keepTaskTab;
    if (params.capsule === undefined && params.taskExecutionCapsule === undefined) delete requestParams.capsule;
    return this.request("task.transaction", requestParams, { timeoutMs, signal });
  }

  async requestExtensionReload(params, { timeoutMs = 30_000 } = {}) {
    const secret = await this.#issuerSecret();
    const payload = extensionReloadPayload(params);
    const authority = createAuthorityEnvelope({
      issuer: this.issuer,
      secret,
      runId: params.runId,
      taskId: params.taskId,
      ownerKey: params.sessionId,
      method: "extension.reload",
      intent: params.intent ?? "extension_reload",
      targetOrigin: "*",
      idempotencyKey: params.idempotencyKey,
      payload,
      approved: true,
      ttlMs: Math.min(10 * 60_000, Math.max(30_000, Number(params.authorityTtlMs) || 60_000)),
    });
    return this.request("extension.reload", {
      ...payload,
      sessionId: params.sessionId,
      authority,
    }, { timeoutMs });
  }

  /**
   * Request one supported reload and wait for a fresh generation.  The
   * current session is used only to authorize the profile-global request;
   * callers must open a new logical session after this method returns
   * `reflected`.
   */
  async requestExtensionReloadAndReadback(params, {
    timeoutMs = 30_000,
    statusTimeoutMs = 5_000,
    pollIntervalMs = 250,
  } = {}) {
    // Always obtain the preflight from the live broker.  A caller-supplied
    // status snapshot could belong to an older generation and would make a
    // reload look safe when work has started since that snapshot.
    const beforeStatus = await this.request("status.get", {}, { timeoutMs: statusTimeoutMs });
    const beforeProfile = Array.isArray(beforeStatus?.profiles)
      ? (params.profileInstanceId
        ? beforeStatus.profiles.find((profile) => profile.profileInstanceId === params.profileInstanceId)
        : beforeStatus.profiles.length === 1 ? beforeStatus.profiles[0] : null)
      : null;
    const profileInstanceId = params.profileInstanceId ?? beforeProfile?.profileInstanceId;
    const preflight = planExtensionRefreshBoundary(beforeStatus, {
      profileInstanceId,
      expectedBuildId: params.expectedBuildId ?? beforeProfile?.buildId ?? null,
      ignoreSessionId: params.sessionId,
    });
    if (preflight.disposition !== "allowed") {
      return {
        schema: EXTENSION_REFRESH_BOUNDARY_SCHEMA,
        result: "deferred",
        ...preflight,
        reloadRequested: false,
        externalActionExecuted: false,
        freshSessionRequired: false,
      };
    }
    let reload;
    try {
      reload = await this.requestExtensionReload({
        ...params,
        profileInstanceId,
        expectedBuildId: params.expectedBuildId ?? preflight.expectedBuildId,
      }, { timeoutMs });
    } catch (error) {
      if (error?.code === "extension_reload_busy") {
        return {
          schema: EXTENSION_REFRESH_BOUNDARY_SCHEMA,
          result: "deferred",
          disposition: "deferred",
          exactBlocker: error.code,
          blockers: [error.details ?? { code: error.code }],
          restartPoint: error.details?.restartPoint ?? "fresh_status_then_retry_at_idle_boundary",
          profileInstanceId,
          generationBefore: beforeProfile?.generation ?? null,
          reloadRequested: false,
          externalActionExecuted: false,
          freshSessionRequired: false,
        };
      }
      if (["broker_request_timeout", "broker_connection_closed"].includes(error?.code)) {
        return {
          schema: EXTENSION_REFRESH_BOUNDARY_SCHEMA,
          result: "unknown",
          disposition: "deferred",
          exactBlocker: "extension_reload_effect_unknown",
          restartPoint: "fresh_status_only; do_not_repeat_extension_reload",
          profileInstanceId,
          generationBefore: beforeProfile?.generation ?? null,
          reloadRequested: true,
          externalActionExecuted: false,
          noReplay: true,
        };
      }
      throw error;
    }
    const deadline = Date.now() + Math.max(1_000, Number(timeoutMs) || 30_000);
    let lastStatus = null;
    let lastVerification = null;
    let lastReadbackError = null;
    while (Date.now() <= deadline) {
      try {
        lastStatus = await this.request("status.get", {}, { timeoutMs: statusTimeoutMs });
        lastReadbackError = null;
        lastVerification = verifyFreshExtensionGeneration(beforeStatus, lastStatus, {
          profileInstanceId,
          expectedBuildId: params.expectedBuildId ?? preflight.expectedBuildId,
        });
        if (lastVerification.disposition === "reflected") {
          return {
            schema: EXTENSION_REFRESH_BOUNDARY_SCHEMA,
            result: "reflected",
            disposition: "reflected",
            exactBlocker: null,
            preflight,
            reload,
            freshStatus: lastStatus,
            verification: lastVerification,
            profileInstanceId,
            generationBefore: beforeProfile?.generation ?? null,
            generationAfter: lastVerification.generationAfter,
            reloadRequested: true,
            externalActionExecuted: false,
            freshSessionRequired: true,
            noReplay: true,
          };
        }
      } catch (error) {
        if (!["broker_request_timeout", "broker_connection_closed", "broker_reconnect_required"].includes(error?.code)) throw error;
        lastReadbackError = { code: error.code, message: error.message };
      }
      if (Date.now() >= deadline) break;
      await new Promise((resolve) => setTimeout(resolve, Math.min(2_000, Math.max(50, Number(pollIntervalMs) || 250))));
    }
    return {
      schema: EXTENSION_REFRESH_BOUNDARY_SCHEMA,
      result: "deferred",
      disposition: "deferred",
      exactBlocker: lastReadbackError ? "extension_reload_reconnect_unavailable" : "extension_reload_generation_not_reflected",
      restartPoint: lastReadbackError ? "fresh_companion_status_only; do_not_repeat_extension_reload" : "wait_for_new_extension_hello_then_read_status_again",
      preflight,
      reload,
      freshStatus: lastStatus,
      verification: lastVerification,
      ...(lastReadbackError ? { readbackError: lastReadbackError } : {}),
      profileInstanceId,
      generationBefore: beforeProfile?.generation ?? null,
      reloadRequested: true,
      externalActionExecuted: false,
      freshSessionRequired: true,
      noReplay: true,
    };
  }

  async requestTaskStatus(params, { timeoutMs = 20_000 } = {}) {
    const secret = await this.#issuerSecret();
    const payload = taskStatusPayload(params);
    const authority = createAuthorityEnvelope({
      issuer: this.issuer,
      secret,
      runId: params.runId,
      taskId: params.taskId,
      ownerKey: params.sessionId,
      method: "task.status",
      intent: "reconcile_status",
      targetOrigin: "*",
      idempotencyKey: `status:${params.idempotencyKey}:${createId("read")}`,
      payload,
      approved: true,
    });
    return this.request("task.status", { ...params, ...payload, sessionId: params.sessionId, authority }, { timeoutMs });
  }

  /** Read-only owner-scoped resume preparation; never opens a tab or replays work. */
  async requestPrepareResume(params, { timeoutMs = 20_000 } = {}) {
    const secret = await this.#issuerSecret();
    const payload = prepareResumePayload(params);
    const intent = payload.intent === "direct_application" ? "direct_application" : "prepare_resume";
    const authority = createAuthorityEnvelope({
      issuer: this.issuer,
      secret,
      runId: params.runId,
      taskId: params.taskId,
      ownerKey: params.sessionId,
      method: "task.prepare_resume",
      intent,
      targetOrigin: "*",
      idempotencyKey: `prepare-resume:${params.taskId}:${params.runId}:${createId("read")}`,
      payload,
      approved: true,
    });
    return this.request("task.prepare_resume", { ...payload, sessionId: params.sessionId, authority }, { timeoutMs });
  }

  async requestInspectReconciliation(params, { timeoutMs = 30_000 } = {}) {
    return this.request("task.reconciliation.inspect", params, { timeoutMs });
  }

  async requestRebindReconciliation(params, { timeoutMs = 30_000 } = {}) {
    const secret = await this.#issuerSecret();
    const payload = {
      runId: params.runId,
      taskId: params.taskId,
      idempotencyKey: params.idempotencyKey,
      capsuleId: params.capsuleId,
      tabId: params.tabId,
      fromGeneration: params.fromGeneration,
    };
    const authority = createAuthorityEnvelope({
      issuer: this.issuer,
      secret,
      runId: params.runId,
      taskId: params.taskId,
      ownerKey: params.sessionId,
      method: "task.reconciliation.rebind",
      intent: "rebind_stale_generation_reconciliation",
      targetOrigin: "*",
      idempotencyKey: `reconciliation-rebind:${params.idempotencyKey}:${createId("rebind")}`,
      payload,
      approved: true,
    });
    return this.request("task.reconciliation.rebind", { ...payload, sessionId: params.sessionId, authority }, { timeoutMs });
  }

  async requestCompleteReconciliation(params, { timeoutMs = 30_000 } = {}) {
    const secret = await this.#issuerSecret();
    const payload = {
      runId: params.runId,
      taskId: params.taskId,
      idempotencyKey: params.idempotencyKey,
      capsuleId: params.capsuleId,
      tabId: params.tabId,
      reconciliationProof: params.reconciliationProof,
    };
    const authority = createAuthorityEnvelope({
      issuer: this.issuer,
      secret,
      runId: params.runId,
      taskId: params.taskId,
      ownerKey: params.sessionId,
      method: "task.reconciliation.complete",
      intent: "complete_reconciliation_from_readback",
      targetOrigin: "*",
      idempotencyKey: `reconciliation-complete:${params.idempotencyKey}:${createId("completion")}`,
      payload,
      approved: true,
    });
    return this.request("task.reconciliation.complete", { ...params, ...payload, authority }, { timeoutMs });
  }

  async requestRepairPreDispatchReadonly(params, { timeoutMs = 30_000 } = {}) {
    const secret = await this.#issuerSecret();
    const payload = repairPreDispatchReadonlyPayload({
      runId: params.runId,
      taskId: params.taskId,
      idempotencyKey: params.idempotencyKey,
      capsuleId: params.capsuleId,
      profileInstanceId: params.profileInstanceId,
      tabId: params.tabId,
      confirmNoEffect: params.confirmNoEffect === true,
    });
    const authority = createAuthorityEnvelope({
      issuer: this.issuer,
      secret,
      runId: params.runId,
      taskId: params.taskId,
      ownerKey: params.sessionId,
      method: "task.reconciliation.repair_pre_dispatch",
      intent: "repair_pre_dispatch_readonly_failure",
      targetOrigin: "*",
      idempotencyKey: `reconciliation-pre-dispatch-repair:${params.idempotencyKey}:${createId("repair")}`,
      payload,
      approved: true,
    });
    return this.request("task.reconciliation.repair_pre_dispatch", {
      ...payload,
      sessionId: params.sessionId,
      authority,
    }, { timeoutMs });
  }

  async requestGroupTaskTabs(params, { timeoutMs = 60_000 } = {}) {
    const secret = await this.#issuerSecret();
    const payload = {
      runId: params.runId,
      taskId: params.taskId,
      // Collapsing a task group is a visual-only maintenance request.  Keep
      // the flag in the signed payload so a caller cannot silently change the
      // requested layout after authorization.
      collapsed: params.collapsed === true,
    };
    const authority = createAuthorityEnvelope({
      issuer: this.issuer,
      secret,
      runId: params.runId,
      taskId: params.taskId,
      ownerKey: params.sessionId,
      method: "task.tabs.group",
      intent: "group_task_tabs",
      targetOrigin: "*",
      idempotencyKey: params.idempotencyKey,
      payload,
      approved: true,
    });
    return this.request("task.tabs.group", { ...payload, sessionId: params.sessionId, authority }, { timeoutMs });
  }

  async requestTransferHandoffTabs(params, { timeoutMs = 60_000 } = {}) {
    const secret = await this.#issuerSecret();
    const payload = {
      runId: params.runId,
      sourceTaskId: params.sourceTaskId,
      destinationTaskId: params.destinationTaskId,
      receiptPath: params.receiptPath,
    };
    const authority = createAuthorityEnvelope({
      issuer: this.issuer,
      secret,
      runId: params.runId,
      taskId: params.destinationTaskId,
      ownerKey: params.sessionId,
      method: "task.tabs.transfer",
      intent: "transfer_handoff_tabs",
      targetOrigin: "*",
      idempotencyKey: params.idempotencyKey,
      payload,
      approved: true,
    });
    return this.request("task.tabs.transfer", { ...payload, sessionId: params.sessionId, authority }, { timeoutMs });
  }

  async requestCleanupTaskTabs(params, { timeoutMs = 120_000 } = {}) {
    const secret = await this.#issuerSecret();
    const preserveTabIds = [...new Set((params.preserveTabIds ?? []).map((value) => Number(value)))].sort((left, right) => left - right);
    const payload = {
      runId: params.runId,
      taskId: params.taskId,
      preserveTabIds,
      dryRun: params.dryRun === true,
    };
    const authority = createAuthorityEnvelope({
      issuer: this.issuer,
      secret,
      runId: params.runId,
      taskId: params.taskId,
      ownerKey: params.sessionId,
      method: "maintenance.tabs.cleanup",
      intent: "cleanup_task_tabs",
      targetOrigin: "*",
      idempotencyKey: params.idempotencyKey,
      payload,
      approved: true,
    });
    return this.request("maintenance.tabs.cleanup", { ...payload, sessionId: params.sessionId, authority }, { timeoutMs });
  }

  /**
   * Purge only persisted task-tab records whose exact Chrome tab is already
   * missing. This is a signed, explicit-maintenance operation: it never
   * closes a live tab and never adopts or reconciles a foreign task.
   */
  async requestPurgeMissingTaskTabs(params, { timeoutMs = 120_000 } = {}) {
    const secret = await this.#issuerSecret();
    const tabIds = [...new Set((params.tabIds ?? []).map((value) => Number(value)))].sort((left, right) => left - right);
    const payload = {
      runId: params.runId,
      tabIds,
      confirmMissingOnly: params.confirmMissingOnly === true,
      profileInstanceId: params.profileInstanceId ?? null,
    };
    const authority = createAuthorityEnvelope({
      issuer: this.issuer,
      secret,
      runId: params.runId,
      taskId: params.taskId,
      ownerKey: params.sessionId,
      method: "maintenance.tabs.purge_missing",
      intent: params.intent ?? "purge_missing_task_tabs",
      targetOrigin: "*",
      idempotencyKey: params.idempotencyKey,
      payload,
      approved: true,
    });
    return this.request("maintenance.tabs.purge_missing", {
      ...payload,
      sessionId: params.sessionId,
      authority,
    }, { timeoutMs });
  }

  /**
   * Retire one abandoned localhost canary through the narrowly scoped broker
   * maintenance route. The broker performs a fresh inventory and refuses any
   * user/foreign/provider tab; the unknown canary operation remains evidence.
   */
  async requestRetireLocalCanary(params, { timeoutMs = 120_000 } = {}) {
    const secret = await this.#issuerSecret();
    const payload = {
      runId: params.runId,
      tabId: Number(params.tabId),
      profileInstanceId: params.profileInstanceId ?? null,
      confirmSyntheticCanary: params.confirmSyntheticCanary === true,
    };
    const authority = createAuthorityEnvelope({
      issuer: this.issuer,
      secret,
      runId: params.runId,
      taskId: params.taskId,
      ownerKey: params.sessionId,
      method: "maintenance.tabs.retire_local_canary",
      intent: params.intent ?? "retire_local_canary",
      targetOrigin: "*",
      idempotencyKey: params.idempotencyKey,
      payload,
      approved: true,
    });
    return this.request("maintenance.tabs.retire_local_canary", {
      ...payload,
      idempotencyKey: params.idempotencyKey,
      sessionId: params.sessionId,
      authority,
    }, { timeoutMs });
  }

  /**
   * Archive unresolved records for display only. This never reconciles,
   * deletes, replays, or changes the scheduler's unresolved-count gate.
   */
  async requestArchiveReconciliation(params, { timeoutMs = 30_000 } = {}) {
    const secret = await this.#issuerSecret();
    const payload = archiveReconciliationPayload({
      runId: params.runId,
      taskId: params.taskId,
      operationIds: params.operationIds,
      reason: params.reason,
      confirmArchiveOnly: params.confirmArchiveOnly === true,
    });
    const authority = createAuthorityEnvelope({
      issuer: this.issuer,
      secret,
      runId: params.runId,
      taskId: params.taskId,
      ownerKey: params.sessionId,
      method: "maintenance.operations.archive",
      intent: "archive_reconciliation_records",
      targetOrigin: "*",
      idempotencyKey: params.idempotencyKey,
      payload,
      approved: true,
    });
    return this.request("maintenance.operations.archive", {
      ...payload,
      sessionId: params.sessionId,
      idempotencyKey: params.idempotencyKey,
      authority,
    }, { timeoutMs });
  }

  close() {
    this.closed = true;
    this.connected = false;
    this.removeMessageListener();
    this.removeCloseListener();
    this.peer?.close();
    this.#rejectPending(new CompanionError("broker_client_closed", "Broker client closed"));
  }

  #attachPeer(peer) {
    this.peer = peer;
    this.connected = true;
    this.connectionGeneration += 1;
    this.removeMessageListener = peer.onMessage((message) => this.#handleMessage(message));
    this.removeCloseListener = peer.onClose(() => this.#handleClose(peer));
  }

  #issuerSecret() {
    if (!this.issuerSecretPromise) {
      this.issuerSecretPromise = ensureIssuerSecret(this.issuer, this.env);
    }
    return this.issuerSecretPromise;
  }

  #detachPeer() {
    this.removeMessageListener();
    this.removeCloseListener();
    this.removeMessageListener = () => {};
    this.removeCloseListener = () => {};
    const previous = this.peer;
    this.peer = null;
    this.connected = false;
    try { previous?.close(); } catch { /* best-effort stale socket cleanup */ }
  }

  async #reconnect() {
    if (this.closed) throw new CompanionError("broker_client_closed", "Broker client closed");
    if (this.reconnectPromise) return this.reconnectPromise;
    this.reconnectPromise = (async () => {
      this.#detachPeer();
      const peer = await this.connectPeerFactory({
        role: "client",
        autoStart: this.autoStart,
        env: this.env,
      });
      if (this.closed) {
        peer.close();
        throw new CompanionError("broker_client_closed", "Broker client closed during reconnect");
      }
      this.#attachPeer(peer);
      this.reconnectCount += 1;
      return this.connectionInfo();
    })();
    try {
      return await this.reconnectPromise;
    } finally {
      this.reconnectPromise = null;
    }
  }

  #handleMessage(message) {
    if (!message.id) {
      return;
    }
    const pending = this.pending.get(message.id);
    if (!pending) {
      return;
    }
    this.pending.delete(message.id);
    pending.cleanup();
    if (message.ok) {
      pending.resolve(message.result);
    } else {
      pending.reject(new CompanionError(
        message.error?.code ?? "broker_request_failed",
        message.error?.message ?? "Broker request failed",
        message.error?.details,
      ));
    }
  }

  #handleClose(peer) {
    if (peer !== this.peer || this.closed) return;
    this.connected = false;
    this.#rejectPending(new CompanionError("broker_connection_closed", "Broker connection closed"));
  }

  #rejectPending(error) {
    for (const pending of this.pending.values()) {
      pending.cleanup();
      pending.reject(error);
    }
    this.pending.clear();
  }
}
