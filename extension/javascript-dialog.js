const error = (code, message, details = {}) => Object.assign(new Error(message), { code, details });
const noEffect = { operationEffectState: "none", mutationDispatchAttempted: false };
const unknownEffect = { operationEffectState: "unknown", mutationDispatchAttempted: true };
const ownerKey = context => JSON.stringify([context.taskId, context.sessionId, context.generation]);
const sensitive = message => /\b(captcha|hcaptcha|recaptcha|one[- ]?time|otp|2fa|verification code|identity|payment|credit card|camera|microphone|location permission)\b|認証コード|ワンタイム|二要素認証|本人確認|支払い|クレジットカード|カメラ.*許可|マイク.*許可|位置情報.*許可/iu.test(message);

// Page.enable does not replay old dialogs and can wait for a paused renderer.
// Keep a task-owned observation across inspect -> trigger -> signed handle,
// and use its opening identity without executing any DOM while the modal is up.
export class JavaScriptDialogs {
  constructor({ debuggerApi, pool, sendCommand, redactText, uuid = () => crypto.randomUUID(),
    now = () => Date.now(), durationMs = 300000, eventTimeoutMs = 5000, enableTimeoutMs = 1500,
    schedule = (...args) => globalThis.setTimeout(...args), cancel = timer => globalThis.clearTimeout(timer) }) {
    Object.assign(this, { api: debuggerApi, pool, sendCommand, redactText, uuid, now, durationMs, eventTimeoutMs, enableTimeoutMs, schedule, cancel });
    this.records = new Map();
    this.api.onEvent.addListener((source, method, params) => this.event(source, method, params ?? {}));
    this.api.onDetach.addListener(source => {
      if (source.sessionId || !Number.isSafeInteger(source.tabId)) return;
      this.pool.detached(source.tabId);
      const record = this.records.get(source.tabId);
      if (record) void this.finish(record, "debugger_detached");
    });
  }
  event(source, method, params) {
    if (source.sessionId) return;
    const record = this.records.get(source.tabId);
    if (!record || record.stopped) return;
    if (method === "Page.javascriptDialogOpening") {
      const current = { id: `dialog-${this.uuid()}`, type: params.type, message: String(params.message ?? ""), url: params.url,
        frameId: params.frameId ?? null, hasBrowserHandler: params.hasBrowserHandler === true, openedAt: this.now() };
      if (record.current && record.current.id !== record.handlingId) record.unpairedOpening = true;
      record.current = current;
      record.openedDuringEnable?.();
      if (record.actionWaiter) {
        const waiter = record.actionWaiter;
        waiter.finish({ ...this.snapshot(record), kind: "dialog", tabId: record.tabId,
          operationId: waiter.operationId, armedAt: waiter.armedAt });
      }
    } else if (method === "Page.javascriptDialogClosed") {
      const current = record.current;
      if (!current) return;
      if (params.frameId && current.frameId && params.frameId !== current.frameId) return;
      record.current = null;
      if (record.waiting?.id === current.id) record.waiting.resolve({ ...params, dialogId: current.id });
    }
  }
  async bounded(promise, timeoutMs, code, message, details = noEffect) {
    let timer;
    try { return await Promise.race([promise, new Promise((_, reject) => { timer = this.schedule(() => reject(error(code, message, details)), timeoutMs); })]); }
    finally { if (timer !== undefined) this.cancel(timer); }
  }
  async observe(tabId, context) {
    if (![context.taskId, context.sessionId, context.generation].every(value => typeof value === "string" && value)) throw error("dialog_owner_required", "Dialog observation requires the broker task, session and generation", noEffect);
    const existing = this.records.get(tabId);
    if (existing) {
      if (existing.owner !== ownerKey(context)) throw error("dialog_observation_not_owned", "The dialog observation belongs to another task, session or generation", noEffect);
      await existing.ready;
      return existing;
    }
    if (this.records.size >= 8) throw error("dialog_observation_capacity", "Eight dialog observations are active; stop an owned observation before starting another", noEffect);
    const record = { tabId, owner: ownerKey(context), sessionId: context.sessionId, generation: context.generation,
      current: null, stopped: false, lease: null, ready: null, timer: null, waiting: null, expiresAt: this.now() + this.durationMs };
    this.records.set(tabId, record);
    record.ready = (async () => {
      try {
        record.lease = await this.pool.acquire(tabId);
        if (record.stopped) { await record.lease.release(); record.lease = null; throw error("dialog_observation_interrupted", "The observation ended during debugger attachment", noEffect); }
        const opened = new Promise(resolve => { record.openedDuringEnable = resolve; });
        await this.bounded(Promise.race([this.sendCommand(record.lease.target, "Page.enable", {}), opened]), this.enableTimeoutMs,
          "dialog_observation_start_timeout", "Page observation did not start; a dialog that predates observation cannot be recovered by replay", noEffect);
        record.openedDuringEnable = null;
        if (record.stopped) throw error("dialog_observation_interrupted", "The observation ended while Page was enabling", noEffect);
        record.timer = this.schedule(() => { void this.finish(record, "duration_elapsed"); }, this.durationMs);
        return record;
      } catch (cause) {
        await this.finish(record, "start_failed");
        if (cause?.code) throw cause;
        throw error("dialog_observation_unavailable", "A task-owned debugger observation could not be started", noEffect);
      }
    })();
    await record.ready;
    return record;
  }
  snapshot(record) {
    const dialog = record.current;
    const base = { observing: !record.stopped, expiresAt: new Date(record.expiresAt).toISOString(), historicalReplay: false,
      evidenceKind: "javascript_dialog_observation", documentTextRead: false };
    if (!dialog) return { ...base, present: false, exact_blocker: "javascript_dialog_not_observed" };
    const requiresUser = sensitive(dialog.message);
    const redacted = requiresUser ? "[user handling required]" : this.redactText(dialog.message, 10000).text;
    return { ...base, present: true, dialogId: dialog.id, pageInstanceId: `javascript-dialog:${dialog.id}`,
      type: dialog.type, message: redacted, messageExactAvailable: redacted === dialog.message, dialogUrl: dialog.url,
      dialogFrameId: dialog.frameId, hasBrowserHandler: dialog.hasBrowserHandler, requiresUser,
      promptTextRequired: dialog.type === "prompt", openedAt: new Date(dialog.openedAt).toISOString() };
  }
  async inspect(tabId, context) { return this.snapshot(await this.observe(tabId, context)); }
  async expectOpening(tabId, context, timeoutMs) {
    if (typeof context.operationId !== "string" || !context.operationId) throw error("action_event_operation_required", "An event wait must be bound to the broker operation", noEffect);
    const record = await this.observe(tabId, context);
    if (record.current) throw error("javascript_dialog_already_open", "A dialog is already open; inspect and respond to it without dispatching another trigger", noEffect);
    if (record.actionWaiter) throw error("action_event_wait_busy", "This target already has a pre-armed event wait", noEffect);
    let timer, resolve;
    const promise = new Promise(done => { resolve = done; });
    const waiter = { operationId: context.operationId, armedAt: new Date(this.now()).toISOString(),
      finish: value => {
        if (record.actionWaiter !== waiter) return;
        record.actionWaiter = null;
        if (timer !== undefined) this.cancel(timer);
        resolve(value);
      } };
    record.actionWaiter = waiter;
    timer = this.schedule(() => waiter.finish(null), timeoutMs);
    return { promise, cancel: () => waiter.finish(null) };
  }
  async stop(tabId, context) {
    const record = this.records.get(tabId);
    if (!record) return { observing: false, stopped: true };
    if (record.owner !== ownerKey(context)) throw error("dialog_observation_not_owned", "The observation belongs to another task, session or generation", noEffect);
    if (record.current || record.handlingId) throw error("javascript_dialog_pending", "Keep observing until the pending dialog is handled or the user closes it", noEffect);
    await this.finish(record, "explicit_stop");
    return { observing: false, stopped: true };
  }
  async handle(tabId, context, params) {
    const record = await this.observe(tabId, context), dialog = record.current;
    if (!dialog) throw error("javascript_dialog_not_observed", "No current dialog was observed; observe before the triggering action and never replay the action to recover a dialog", noEffect);
    if (record.unpairedOpening || typeof params.expectedDialogId !== "string" || params.expectedDialogId !== dialog.id
      || params.pageInstanceId !== `javascript-dialog:${dialog.id}`) throw error("javascript_dialog_identity_mismatch", "The signed dialog opening is no longer current", noEffect);
    if (sensitive(dialog.message)) throw error("sensitive_dialog_user_required", "Rendered dialog content requires user handling", noEffect);
    if (typeof params.expectedMessage !== "string" || params.expectedMessage !== dialog.message
      || (params.expectedType !== undefined && params.expectedType !== dialog.type)) throw error("javascript_dialog_mismatch", "The observed message and type must match the signed expectation exactly", noEffect);
    if (typeof params.accept !== "boolean") throw error("javascript_dialog_response_invalid", "accept must be a boolean", noEffect);
    let origin;
    try { origin = new URL(dialog.url).origin; } catch { /* rejected below */ }
    if (!origin || origin === "null" || !params.allowedOrigins?.includes(origin)) throw error("javascript_dialog_origin_not_allowed", "The observed dialog frame is outside the signed origins", noEffect);
    const hasPromptText = Object.hasOwn(params, "promptText");
    if (dialog.type === "prompt" && params.accept && (!hasPromptText || typeof params.promptText !== "string" || params.promptText.length > 10000)) throw error("dialog_prompt_text_required", "Accepting a prompt requires an explicit string promptText of at most 10000 characters; an explicit empty string is allowed", noEffect);
    if (hasPromptText && (dialog.type !== "prompt" || !params.accept)) throw error("dialog_prompt_text_not_applicable", "promptText is only used when accepting a prompt", noEffect);
    if (record.handlingId) throw error("javascript_dialog_busy", "The observed dialog is already being handled", noEffect);
    record.handlingId = dialog.id;
    let dispatched = false;
    const closed = new Promise(resolve => { record.waiting = { id: dialog.id, resolve }; });
    try {
      // The close listener above is installed before dispatch, including a
      // close event that arrives before the command acknowledgement.
      const command = { accept: params.accept, ...(hasPromptText ? { promptText: params.promptText } : {}) };
      dispatched = true;
      const [, receipt] = await this.bounded(Promise.all([this.sendCommand(record.lease.target, "Page.handleJavaScriptDialog", command), closed]),
        this.eventTimeoutMs, "javascript_dialog_close_unknown", "Dialog response was dispatched without a confirmed close; read the target and reconcile this attempt without replay", unknownEffect);
      if (receipt.result !== params.accept || (hasPromptText && receipt.userInput !== params.promptText)) throw error("javascript_dialog_close_mismatch", "The close event did not confirm the requested response", unknownEffect);
      return { handled: true, accepted: params.accept, type: dialog.type, dialogId: dialog.id, closedVerified: true,
        messageDigestOnly: true, promptTextReturned: false, nextDialogPresent: record.current !== null };
    } catch (cause) {
      if (!dispatched) throw cause;
      throw error(cause?.code ?? "javascript_dialog_close_unknown", cause?.code ? cause.message : "The dialog response result is unknown; reconcile without replay", unknownEffect);
    } finally { record.waiting = null; record.handlingId = null; }
  }
  async finish(record, reason) {
    if (record.stopped) return;
    record.stopped = true; record.stopReason = reason;
    if (record.timer !== null) this.cancel(record.timer);
    // Wakes an in-flight handler as an explicit unknown result, never a close.
    record.waiting?.resolve({ result: null, interrupted: true });
    record.actionWaiter?.finish(null);
    if (this.records.get(record.tabId) === record) this.records.delete(record.tabId);
    if (record.lease) await record.lease.release();
  }
  async stopForSession(sessionId, generation) { for (const record of [...this.records.values()]) if (record.sessionId === sessionId && record.generation === generation) await this.finish(record, "session_closed"); }
  async tabRemoved(tabId) { const record = this.records.get(tabId); if (record) await this.finish(record, "tab_closed"); }
  async stopAll(reason) { await Promise.all([...this.records.values()].map(record => this.finish(record, reason))); }
}
