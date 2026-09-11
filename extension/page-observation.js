// Chrome-owned debugger sessions are shared by observation and ordinary
// Companion reads/input. No external debugger attachment is adopted.
export class DebuggerSessionPool {
  constructor(debuggerApi) { this.api = debuggerApi; this.targets = new Map(); }
  async acquire(tabId) {
    let state = this.targets.get(tabId);
    if (state?.closing) { await state.closing; return this.acquire(tabId); }
    if (state?.detachFailed) throw observationError("page_observation_debugger_release_unknown", "The previous debugger detach failed; its target state must be reconciled before another attachment");
    if (!state) {
      state = { target: { tabId }, references: 0, lost: false, ready: null, closing: null };
      this.targets.set(tabId, state);
      state.ready = Promise.resolve().then(() => this.api.attach(state.target, "1.3")).catch(error => {
        state.lost = true;
        if (this.targets.get(tabId) === state) this.targets.delete(tabId);
        throw error;
      });
    }
    state.references += 1;
    await state.ready;
    if (state.lost) throw observationError("page_observation_debugger_detached", "The debugger detached while the target was being acquired");
    let released = false;
    return { target: state.target, release: async () => {
      if (released) return { alreadyReleased: true };
      released = true; state.references -= 1;
      if (state.lost) return { detached: true, reason: "browser_detached" };
      if (state.references > 0) return { detached: false, reason: "shared_operation_active", references: state.references };
      state.closing = Promise.resolve().then(() => this.api.detach(state.target))
        .then(() => ({ detached: true }), error => ({ detached: false, reason: "detach_failed", error: String(error?.message ?? error).slice(0, 300) }))
        .then(result => { state.detachFailed = result.detached !== true; return result; })
        .finally(() => {
          if ((!state.detachFailed || state.lost) && this.targets.get(tabId) === state) this.targets.delete(tabId);
          state.closing = null;
        });
      return state.closing;
    } };
  }
  detached(tabId) {
    const state = this.targets.get(tabId);
    if (state) { state.lost = true; this.targets.delete(tabId); }
  }
}

const observationError = (code, message, details) => Object.assign(new Error(message), { code, details });
const byteLength = value => new TextEncoder().encode(JSON.stringify(value)).length;
const ownerKey = context => JSON.stringify([context.taskId, context.sessionId, context.generation]);
const bounded = (value, fallback, min, max) => {
  const number = value ?? fallback;
  if (!Number.isSafeInteger(number) || number < min || number > max) throw observationError("page_observation_options_invalid", `Choose an integer between ${min} and ${max}`);
  return number;
};
function safeUrl(value) {
  try {
    const url = new URL(String(value));
    if (!["http:", "https:"].includes(url.protocol)) return `<${url.protocol || "unavailable"}>`;
    url.username = ""; url.password = "";
    for (const name of [...url.searchParams.keys()]) if (/(?:token|secret|password|signature|credential|auth|api[_-]?key|^key$|x-amz-|x-goog-)/iu.test(name)) url.searchParams.set(name, "<redacted>");
    return url.href.slice(0, 2000);
  } catch { return null; }
}

export class PageObservations {
  constructor({ debuggerApi, pool, sendCommand, redactText, now = () => Date.now(), uuid = () => crypto.randomUUID(),
    // Window/Worker timers require their global receiver, whereas invoking a
    // stored native timer as this.schedule() binds this to the observer.
    schedule = (...args) => globalThis.setTimeout(...args), cancel = id => globalThis.clearTimeout(id) }) {
    Object.assign(this, { api: debuggerApi, pool, sendCommand, redactText, now, uuid, schedule, cancel });
    this.records = new Map(); this.activeTabs = new Map();
    this.onEvent = (source, method, params) => this.event(source, method, params ?? {});
    this.onDetach = (source, reason) => {
      if (source.sessionId || !Number.isSafeInteger(source.tabId)) return;
      this.pool.detached(source.tabId);
      const record = this.activeTabs.get(source.tabId);
      if (record) void this.finish(record, `debugger_detached:${reason}`).catch(() => {});
    };
    this.api.onEvent.addListener(this.onEvent); this.api.onDetach.addListener(this.onDetach);
  }
  text(value, max = 2000) { return this.redactText(String(value ?? ""), max).text; }
  assertOwner(record, context) {
    if (!record || record.owner !== ownerKey(context)) throw observationError("page_observation_not_owned", "The observation does not belong to this exact task/session/generation");
    return record;
  }
  async start(tabId, context, options = {}) {
    if (![context.taskId, context.sessionId, context.generation].every(value => typeof value === "string" && value)) throw observationError("page_observation_owner_required", "Observation requires broker-supplied task, session and generation identity");
    const existing = this.activeTabs.get(tabId);
    if (existing) { this.assertOwner(existing, context); return { ...this.read(existing, options), reused: true }; }
    if (this.activeTabs.size >= 8) throw observationError("page_observation_capacity", "Eight tabs are already being observed; stop an owned observation before starting another");
    const durationMs = bounded(options.durationMs, 300000, 1000, 1800000);
    const maxEntries = bounded(options.maxEntries, 1000, 10, 5000);
    const maxBufferBytes = bounded(options.maxBufferBytes, 1000000, 10000, 2000000);
    const consoleEnabled = options.console !== false, networkEnabled = options.network !== false;
    const eventKinds = options.events ?? [];
    if (!Array.isArray(eventKinds) || eventKinds.some(kind => !["navigation", "popup", "fileChooser", "dialog", "download"].includes(kind))) throw observationError("page_observation_options_invalid", "Choose navigation, popup, fileChooser, dialog or download events");
    if (!consoleEnabled && !networkEnabled && eventKinds.length === 0) throw observationError("page_observation_options_invalid", "Enable console, network or page event observation");
    const lease = await this.pool.acquire(tabId);
    let record;
    try {
      const tree = await this.sendCommand(lease.target, "Page.getFrameTree", {});
      const frame = tree?.frameTree?.frame;
      const pageOrigin = new URL(frame?.url).origin;
      if (!/^https?:\/\//u.test(frame?.url ?? "")) throw observationError("page_observation_document_unavailable", "Observation requires a committed HTTP document");
      record = { id: `observation-${this.uuid()}`, owner: ownerKey(context), taskId: context.taskId, sessionId: context.sessionId, generation: context.generation,
        tabId, target: lease.target, lease, startedAt: this.now(), expiresAt: this.now() + durationMs, timer: null, status: "starting", stopReason: null,
        pageUrl: safeUrl(frame.url), frameId: frame.id, contexts: new Map(),
        consoleEnabled, networkEnabled, eventKinds: new Set(eventKinds), popupRequests: [], popupCandidates: new Map(), allowResponseBodies: options.allowResponseBodies === true, bodyOrigin: pageOrigin,
        maxEntries, maxBufferBytes, buffer: [], bufferBytes: 0, sequence: 0, dropped: 0, requests: new Map() };
      this.records.set(record.id, record); this.activeTabs.set(tabId, record);
      // Install the listener above and register this record before enabling
      // domains, since enable can immediately deliver buffered console events.
      await this.sendCommand(lease.target, "Page.enable", eventKinds.includes("fileChooser") ? { enableFileChooserOpenedEvent: true } : {});
      if (eventKinds.includes("navigation")) await this.sendCommand(lease.target, "Page.setLifecycleEventsEnabled", { enabled: true });
      if (networkEnabled) await this.sendCommand(lease.target, "Network.enable", { maxTotalBufferSize: 2000000, maxResourceBufferSize: 500000, maxPostDataSize: 0 });
      if (consoleEnabled) {
        await this.sendCommand(lease.target, "Runtime.enable", {});
        await this.sendCommand(lease.target, "Log.enable", {});
      }
      const currentFrame = (await this.sendCommand(lease.target, "Page.getFrameTree", {}))?.frameTree?.frame;
      if (!currentFrame?.url || new URL(currentFrame.url).origin !== pageOrigin) throw observationError("page_observation_target_changed", "The page origin changed while observation was starting; read the exact tab before starting again");
      record.pageUrl = safeUrl(currentFrame.url); record.frameId = currentFrame.id;
      if (record.status !== "starting") throw observationError("page_observation_interrupted", "The debugger detached while observation was starting");
      record.status = "recording";
      record.timer = this.schedule(() => { void this.finish(record, "duration_elapsed").catch(() => {}); }, durationMs);
      for (const [id, candidate] of this.records) if (this.records.size > 20 && candidate.status === "stopped") this.records.delete(id);
      return { ...this.read(record, {}), reused: false };
    } catch (error) {
      if (record) { await this.finish(record, "start_failed"); this.records.delete(record.id); }
      else await lease.release();
      throw error;
    }
  }
  append(record, entry) {
    const item = { sequence: ++record.sequence, observedAt: this.now(), ...entry };
    const size = byteLength(item);
    record.buffer.push({ item, size }); record.bufferBytes += size;
    while (record.buffer.length > record.maxEntries || record.bufferBytes > record.maxBufferBytes) {
      record.bufferBytes -= record.buffer.shift().size; record.dropped += 1;
    }
  }
  event(source, method, params) {
    // Flattened child debugger sessions are not implicitly attached or read.
    if (source.sessionId) return;
    const record = this.activeTabs.get(source.tabId);
    if (!record || !["starting", "recording"].includes(record.status)) return;
    if (method === "Page.frameNavigated") {
      const frame = params.frame ?? {};
      if (!frame.parentId && frame.id) {
        if (record.eventKinds.has("navigation")) this.append(record, { kind: "navigation", event: method, frameId: frame.id,
          loaderId: frame.loaderId ?? null, previousUrl: record.pageUrl, url: safeUrl(frame.url), sameDocument: false });
        record.frameId = frame.id;
        let origin; try { origin = new URL(frame.url).origin; } catch { origin = null; }
        if (origin !== record.bodyOrigin) { void this.finish(record, "page_origin_changed").catch(() => {}); return; }
        record.pageUrl = safeUrl(frame.url);
      }
      return;
    }
    if (method === "Page.navigatedWithinDocument" && params.frameId === record.frameId) {
      let origin; try { origin = new URL(params.url).origin; } catch { origin = null; }
      if (origin !== record.bodyOrigin) { void this.finish(record, "page_origin_changed").catch(() => {}); return; }
      if (record.eventKinds.has("navigation")) this.append(record, { kind: "navigation", event: method, frameId: params.frameId,
        previousUrl: record.pageUrl, url: safeUrl(params.url), sameDocument: true, navigationType: this.text(params.navigationType, 40) });
      record.pageUrl = safeUrl(params.url); return;
    }
    if (record.eventKinds.has("navigation") && ["Page.domContentEventFired", "Page.loadEventFired", "Page.lifecycleEvent"].includes(method)) {
      if (params.frameId && params.frameId !== record.frameId) return;
      this.append(record, { kind: "navigation", event: method, frameId: record.frameId, loaderId: params.loaderId ?? null,
        loadState: method === "Page.domContentEventFired" ? "domcontentloaded" : method === "Page.loadEventFired" ? "load" : this.text(params.name, 50),
        protocolTimestamp: params.timestamp ?? null, mayPrecedeObservation: record.status === "starting" }); return;
    }
    if (record.eventKinds.has("popup") && method === "Page.windowOpen") {
      const requestId = `popup-${this.uuid()}`;
      record.popupRequests.push({ requestId, url: String(params.url ?? ""), observedAt: this.now(), associated: false });
      record.popupRequests = record.popupRequests.filter(request => this.now() - request.observedAt < 30000).slice(-20);
      this.append(record, { kind: "popup", event: method, popupRequestId: requestId, openerTabId: record.tabId,
        url: safeUrl(params.url), userGesture: params.userGesture === true, tabCreationVerified: false });
      for (const candidate of record.popupCandidates.values()) this.tabUpdated(candidate.id, candidate);
      return;
    }
    if (record.eventKinds.has("fileChooser") && method === "Page.fileChooserOpened") {
      this.append(record, { kind: "fileChooser", event: method, frameId: params.frameId ?? null,
        backendNodeId: params.backendNodeId ?? null, mode: this.text(params.mode, 50), userActionRequired: true,
        fileSelectionIntercepted: false, selectedFilesIncluded: false }); return;
    }
    if (record.eventKinds.has("dialog") && ["Page.javascriptDialogOpening", "Page.javascriptDialogClosed"].includes(method)) {
      this.append(record, { kind: "dialog", event: method, type: this.text(params.type, 40), url: safeUrl(params.url),
        ...(method.endsWith("Opening") ? { message: this.text(params.message), hasBrowserHandler: params.hasBrowserHandler === true }
          : { accepted: params.result === true }), promptValueIncluded: false }); return;
    }
    if (record.eventKinds.has("download") && ["Page.downloadWillBegin", "Page.downloadProgress"].includes(method)) {
      this.append(record, { kind: "download", event: method, guid: this.text(params.guid, 100),
        ...(method.endsWith("WillBegin") ? { frameId: params.frameId ?? null, url: safeUrl(params.url), suggestedFilename: this.text(params.suggestedFilename, 300) }
          : { state: this.text(params.state, 50), receivedBytes: params.receivedBytes ?? null, totalBytes: params.totalBytes ?? null }),
        delivery: "legacy_page_event_best_effort", fileVerified: false }); return;
    }
    if (method === "Runtime.executionContextCreated") {
      const context = params.context;
      if (context?.id) record.contexts.set(context.id, { frameId: context.auxData?.frameId ?? null, origin: context.origin ?? null });
      if (record.contexts.size > 1000) record.contexts.delete(record.contexts.keys().next().value);
      return;
    }
    if (method === "Runtime.executionContextDestroyed") { record.contexts.delete(params.executionContextId); return; }
    if (method === "Runtime.executionContextsCleared") { record.contexts.clear(); return; }
    if (record.consoleEnabled && method === "Runtime.consoleAPICalled") {
      const context = record.contexts.get(params.executionContextId);
      // Runtime may replay existing messages on enable. Keep their protocol
      // timestamp and mark that this is not proof they occurred after start.
      const raw = (params.args ?? []).slice(0, 20).map(arg => ["string", "number", "boolean"].includes(typeof arg.value) ? arg.value : arg.description ?? arg.type).join(" ");
      this.append(record, { kind: "console", event: method, level: this.text(params.type, 40), text: this.text(raw),
        frameId: context?.frameId ?? null, executionContextId: params.executionContextId ?? null,
        protocolTimestamp: params.timestamp ?? null, mayPrecedeObservation: Number(params.timestamp) < record.startedAt });
      return;
    }
    if (record.consoleEnabled && method === "Log.entryAdded") {
      const entry = params.entry ?? {};
      this.append(record, { kind: "console", event: method, level: this.text(entry.level, 40), text: this.text(entry.text), url: safeUrl(entry.url),
        frameId: null, protocolTimestamp: entry.timestamp ?? null, mayPrecedeObservation: Number(entry.timestamp) < record.startedAt });
      return;
    }
    if (!record.networkEnabled || !method.startsWith("Network.")) return;
    const requestId = String(params.requestId ?? "").slice(0, 160);
    if (!requestId) return;
    if (method === "Network.requestWillBeSent") {
      const request = params.request ?? {};
      let origin; try { origin = new URL(request.url).origin; } catch { origin = null; }
      const metadata = { requestId, url: safeUrl(request.url), origin, frameId: params.frameId ?? null, loaderId: params.loaderId ?? null,
        resourceType: this.text(params.type, 60), finished: false, response: null };
      record.requests.delete(requestId); record.requests.set(requestId, metadata);
      while (record.requests.size > 1000) record.requests.delete(record.requests.keys().next().value);
      this.append(record, { kind: "network", event: method, requestId, url: metadata.url, method: this.text(request.method, 20), frameId: metadata.frameId,
        loaderId: metadata.loaderId, resourceType: metadata.resourceType, protocolTimestamp: params.timestamp ?? null,
        redirectStatus: params.redirectResponse?.status ?? null, redirectUrl: safeUrl(params.redirectResponse?.url), requestBodyIncluded: false, headersIncluded: false });
    } else if (method === "Network.responseReceived") {
      const metadata = record.requests.get(requestId), response = params.response ?? {};
      if (!metadata) return;
      metadata.response = { status: response.status ?? null, mimeType: this.text(response.mimeType, 100), protocol: this.text(response.protocol, 50) };
      this.append(record, { kind: "network", event: method, requestId, url: safeUrl(response.url), frameId: params.frameId ?? metadata.frameId,
        resourceType: this.text(params.type, 60), ...metadata.response, fromDiskCache: response.fromDiskCache === true, fromServiceWorker: response.fromServiceWorker === true,
        protocolTimestamp: params.timestamp ?? null, headersIncluded: false });
    } else if (method === "Network.loadingFinished" || method === "Network.loadingFailed") {
      const metadata = record.requests.get(requestId); if (!metadata) return;
      metadata.finished = method === "Network.loadingFinished";
      this.append(record, { kind: "network", event: method, requestId, frameId: metadata.frameId, url: metadata.url,
        encodedDataLength: params.encodedDataLength ?? null, error: params.errorText ? this.text(params.errorText, 300) : null,
        canceled: params.canceled === true, protocolTimestamp: params.timestamp ?? null });
    }
  }
  read(record, options = {}) {
    const limit = bounded(options.limit, 100, 1, 500), maxBytes = bounded(options.maxBytes, 100000, 10000, 500000);
    let after = 0;
    if (options.cursor != null) {
      const prefix = `${record.id}:`;
      if (typeof options.cursor !== "string" || !options.cursor.startsWith(prefix) || !/^\d+$/u.test(options.cursor.slice(prefix.length))) throw observationError("page_observation_cursor_invalid", "Use a cursor returned by this exact observation");
      after = Number(options.cursor.slice(prefix.length));
      if (!Number.isSafeInteger(after) || after > record.sequence) throw observationError("page_observation_cursor_invalid", "The cursor is ahead of this observation");
    }
    const first = record.buffer[0]?.item.sequence ?? record.sequence + 1;
    const result = { schema: "aos.chrome_companion.page_observation.v1", observationId: record.id, tabId: record.tabId, pageUrl: record.pageUrl,
      status: record.status, stopReason: record.stopReason, startedAt: record.startedAt, expiresAt: record.expiresAt,
      entries: [], cursor: `${record.id}:${Math.max(after, first - 1)}`, latestCursor: `${record.id}:${record.sequence}`,
      cursorExpired: after < first - 1, droppedEntries: record.dropped, truncated: false,
      capture: { console: record.consoleEnabled, network: record.networkEnabled, events: [...record.eventKinds], responseBodies: record.allowResponseBodies,
        downloadEvents: record.eventKinds.has("download") ? "legacy_page_events_best_effort" : false,
        popupAssociationGrantsOwnership: false, fileChooserIntercepted: false,
        requestBodies: false, headers: false, childDebuggerSessions: false, durableAcrossExtensionRestart: false }, redactionApplied: true };
    let size = byteLength(result) + 200;
    for (const { item, size: itemBytes } of record.buffer) {
      if (item.sequence <= after) continue;
      if (result.entries.length >= limit || size + itemBytes + 1 > maxBytes) { result.truncated = true; break; }
      result.entries.push(item); size += itemBytes + 1; result.cursor = `${record.id}:${item.sequence}`;
    }
    return result;
  }
  async responseBody(record, options) {
    if (!record.allowResponseBodies) throw observationError("page_observation_body_not_enabled", "Start an observation with allowResponseBodies before requesting a response body");
    if (record.status !== "recording") throw observationError("page_observation_stopped", "The debugger is no longer retaining response bodies for this observation");
    const request = record.requests.get(options.requestId);
    if (!request || !request.finished) throw observationError("page_observation_request_unavailable", "The exact observed request has not finished or its metadata was evicted");
    if (request.origin !== record.bodyOrigin) throw observationError("page_observation_body_origin_not_allowed", "Response bodies are limited to the observation's starting page origin");
    if (!/^(?:text\/[^;\s]+|application\/(?:[^;\s]*\+)?(?:json|xml|javascript|x-javascript))(?:[;\s]|$)/iu.test(request.response?.mimeType ?? "")) throw observationError("page_observation_body_not_text", "Only observed text, JSON, XML or JavaScript response bodies are returned");
    const maxChars = bounded(options.maxChars, 20000, 100, 100000);
    let result;
    try { result = await this.sendCommand(record.target, "Network.getResponseBody", { requestId: request.requestId }); }
    catch (error) { throw observationError("page_observation_body_unavailable", "Chrome no longer has this response body; the request was not replayed", { cause: String(error?.message ?? error).slice(0, 300) }); }
    if (record.status !== "recording") throw observationError("page_observation_interrupted", "Observation stopped while the response body was being read");
    const raw = result.base64Encoded ? new TextDecoder().decode(Uint8Array.from(atob(result.body), char => char.charCodeAt(0))) : String(result.body ?? "");
    const redacted = this.redactText(raw, maxChars);
    return { observationId: record.id, requestId: request.requestId, tabId: record.tabId, url: request.url, mimeType: request.response.mimeType,
      body: redacted.text, truncated: redacted.truncated, redactionApplied: true, requestReplayed: false };
  }
  tabCreated(tab) {
    const record = this.activeTabs.get(tab?.openerTabId);
    if (!record?.eventKinds.has("popup") || !Number.isSafeInteger(tab.id)) return;
    record.popupCandidates.set(tab.id, { id: tab.id, windowId: tab.windowId, url: tab.pendingUrl || tab.url, observedAt: this.now() });
    while (record.popupCandidates.size > 20) record.popupCandidates.delete(record.popupCandidates.keys().next().value);
    this.tabUpdated(tab.id, tab);
  }
  tabUpdated(tabId, tab) {
    for (const record of this.activeTabs.values()) {
      const candidate = record.popupCandidates.get(tabId);
      if (!candidate) continue;
      if (this.now() - candidate.observedAt > 30000) { record.popupCandidates.delete(tabId); continue; }
      const url = tab?.pendingUrl || tab?.url;
      if (!/^https?:\/\//u.test(url ?? "")) continue;
      candidate.url = url;
      const matching = record.popupRequests.filter(request => !request.associated && request.url === url && this.now() - request.observedAt < 30000);
      if (matching.length !== 1) continue;
      matching[0].associated = true; record.popupCandidates.delete(tabId);
      this.append(record, { kind: "popup", event: "tabs.createdFromObservedOpener", popupRequestId: matching[0].requestId,
        openerTabId: record.tabId, tabId, windowId: tab.windowId ?? candidate.windowId, url: safeUrl(url),
        tabCreationVerified: true, association: "exact_opener_and_single_matching_window_open", taskOwnershipGranted: false,
        nextAction: "Use the normal explicit target authorization before operating this new tab" });
    }
  }
  async finish(record, reason) {
    if (record.finishing) return record.finishing;
    record.status = "stopped"; record.stopReason = reason;
    if (record.timer != null) this.cancel(record.timer);
    if (this.activeTabs.get(record.tabId) === record) this.activeTabs.delete(record.tabId);
    record.finishing = record.lease.release().then(result => { record.debuggerRelease = result; return result; });
    return record.finishing;
  }
  async control(tabId, context, options) {
    if (options.action === "start") return this.start(tabId, context, options);
    const record = this.assertOwner(this.records.get(options.observationId), context);
    if (record.tabId !== tabId) throw observationError("page_observation_target_mismatch", "The observation belongs to a different exact tab");
    if (options.action === "body") return this.responseBody(record, options);
    if (options.action === "stop") await this.finish(record, "requested");
    else if (options.action !== "read") throw observationError("page_observation_action_invalid", "Choose start, read, body or stop");
    return { ...this.read(record, options), ...(record.debuggerRelease ? { debuggerRelease: record.debuggerRelease } : {}) };
  }
  async stopForSession(sessionId, generation) {
    const records = [...this.records.values()].filter(record => record.sessionId === sessionId && record.generation === generation);
    const result = await Promise.allSettled(records.map(record => this.finish(record, "session_closed")));
    for (const record of records) this.records.delete(record.id);
    return result;
  }
  async stopAll(reason) {
    const records = [...this.records.values()];
    const result = await Promise.allSettled(records.map(record => this.finish(record, reason)));
    for (const record of records) this.records.delete(record.id);
    return result;
  }
  async tabRemoved(tabId) {
    this.pool.detached(tabId);
    const record = this.activeTabs.get(tabId); if (record) await this.finish(record, "tab_closed");
  }
}
