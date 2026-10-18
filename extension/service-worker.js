import { mergeSemanticSnapshotResults } from "./semantic-snapshot.js";
import { NativeCommandAssembler } from "./native-command-transfer.js";
import { checkFrameOrigin } from "./frame-origin.js";
import { DebuggerSessionPool, PageObservations } from "./page-observation.js";
import { JavaScriptDialogs } from "./javascript-dialog.js";
import { ViewportControls } from "./viewport-control.js";
import { AccessibilityHistory } from "./accessibility-history.js";
import { executeWithExpectedDialog } from "./action-event-wait.js";
import { exactNavigationDiagnostics, stopExactNavigation } from "./navigation-recovery.js";
import {
  BUNDLE_TREE_SHA256,
  EXTENSION_TREE_SHA256,
  INSTALL_BUILD_ID,
  NATIVE_RECORDER_SHA256,
} from "./build-info.js";
import { createUserControls } from "./user-controls.js";
import { searchBrowserLibrary, configureTaskTab, bookmarkTaskPage } from "./browser-library.js";
import {
  CAPABILITIES,
  CAPABILITIES_DIGEST,
  MUTATION_METHODS,
  OPERATION_SCHEMA,
  OPERATION_SCHEMA_DIGEST,
  OPERATION_SCHEMA_VERSION,
} from "./operation-schema.generated.js";
import {
  BINARY_CLIPBOARD_MIME_ALLOWLIST,
  MAX_CLIPBOARD_BINARY_BYTES,
} from "./peripheral-policy.generated.js";

const NATIVE_HOST_NAME = "com.aos.chrome_companion";
const userControls = createUserControls(chrome);
const PROTOCOL_VERSION = "0.1.0";
const runtimeState = {
  profileInstanceId: null,
  extensionRuntimeId: null,
  generation: null,
  connected: false,
  connecting: false,
  reconnectAttempt: 0,
  lastConnectedAt: null,
  lastDisconnectedAt: null,
  lastError: null,
  disconnectHistory: [],
  setup: null,
  debuggerPermissionGranted: false,
  physicalInputEnabled: false,
  peripheralPermissionsGranted: false,
  reloadScheduled: false,
  reloadRequestedAt: null,
  reloadReason: null,
  port: null,
  helloTimer: null,
};
const commandAssembler = new NativeCommandAssembler({
  onExpire: (operationId) => sendCommandError(operationId, "native_command_transfer_timeout", "Incomplete command transfer expired before execution",
    { operationEffectState: "none", mutationDispatchAttempted: false }),
});
const debuggerSessions = new DebuggerSessionPool(chrome.debugger);
const pageObservations = new PageObservations({ debuggerApi: chrome.debugger, pool: debuggerSessions,
  sendCommand: sendDebuggerCommand, redactText: redactPeripheralText });
const javaScriptDialogs = new JavaScriptDialogs({ debuggerApi: chrome.debugger, pool: debuggerSessions,
  sendCommand: sendDebuggerCommand, redactText: redactPeripheralText });
const viewportControls = new ViewportControls({ pool: debuggerSessions, sendCommand: sendDebuggerCommand,
  readViewport: tabId => runPageOperation(tabId, "inspectViewport", {}),
  onError: error => { runtimeState.lastError = error.message; } });

const RECONNECT_ALARM = "aos-companion-reconnect";
const WATCHDOG_ALARM = "aos-companion-watchdog";
const WATCHDOG_PERIOD_MINUTES = 0.5;
const MIN_RECONNECT_TRIGGER_INTERVAL_MS = 2_000;
// A cold native host may spend time in the OS loader before the broker's
// bounded 12-second startup and 3-second authentication windows. Closing the
// port after five seconds races a valid cold-start acknowledgement.
const NATIVE_HELLO_TIMEOUT_MS = 20_000;
const DEFAULT_SCREENSHOT_QUALITY = 60;
const MIN_SCREENSHOT_QUALITY = 35;
const MAX_SCREENSHOT_BYTES = 700_000;
const PHYSICAL_INPUT_ENABLED_KEY = "physicalInputEnabled";
const DISCONNECT_HISTORY_KEY = "disconnectHistory";
const MAX_DISCONNECT_HISTORY = 20;
const accessibilityHistory = new AccessibilityHistory();
const DEFAULT_NAVIGATION_TIMEOUT_MS = 30_000;
const READ_API_TIMEOUT_MS = 10_000;
const MAX_TAB_LIST_ENTRIES = 200;
const MAX_TAB_URL_CHARS = 4_096;
const MAX_TAB_TITLE_CHARS = 1_024;
const SCREENSHOT_MIN_INTERVAL_MS = 650;
// Return the command receipt before reloading the MV3 service worker.  The
// broker uses that receipt to finish the signed operation, then observes the
// new Extension generation through the normal hello handshake.
const EXTENSION_RELOAD_DELAY_MS = 150;
// Semantic mutations run in the renderer and must not leave the MV3 command
// handler awaiting an unbounded executeScript promise. Keep this deadline at
// least as long as the broker's page-mutation operation window so a valid
// semantic result is not converted into an avoidable unknown-effect timeout.
const PAGE_MUTATION_EXECUTION_TIMEOUT_MS = 30_000;
let lastScreenshotStartedAt = 0;
let lastReconnectTriggerAt = 0;
let pendingAutoRecordingTabId = null;

function boundedTabText(value, maxChars) {
  const text = String(value ?? "");
  return text.length <= maxChars ? text : `${text.slice(0, maxChars - 1)}…`;
}

function timeoutError(code, message) {
  const error = new Error(message);
  error.code = code;
  return error;
}

function withTimeout(promise, timeoutMs, code, message) {
  let timer;
  const timeout = new Promise((_resolve, reject) => {
    timer = setTimeout(() => reject(timeoutError(code, message)), timeoutMs);
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

const READ_ONLY_PAGE_ACTIONS = new Set([
  "snapshot",
  "query",
  "resolveDownloadTarget",
  "assets",
  "inspectDropdown",
  "inspectVisualTarget",
  "inspectVisualPoint",
  "inspectViewport",
  "inspectCaptcha",
  "domDiff",
  "readNetwork",
  "exportContent",
  "exportArtifact",
  "webMcpDiscover",
  "verifyTypeValue",
  "verifyTypeSelection",
  "verifyExactEditor",
  "verifyUpload",
  "waitFor",
]);
// Keep command-side effect classification derived from the generated
// operation contract.  The broker and Extension must never disagree about
// whether a command can mutate the leased surface.
const MUTATION_OPERATION_METHODS = new Set(MUTATION_METHODS);

async function executePageScriptWithReadRetry(target, action, payload, timeoutMs = READ_API_TIMEOUT_MS) {
  return await withTimeout(chrome.scripting.executeScript({
    target,
    world: "ISOLATED",
    func: injectedPageOperation,
    args: [action, payload],
  }), Math.min(READ_API_TIMEOUT_MS, timeoutMs), "page_execution_timeout",
  "Chrome did not return a semantic page result within the bounded read window");
}

// `chrome.scripting.executeScript` returns a browser-owned documentId for
// each injection result. Prefer it over the page-side isolated-world marker:
// the latter is not guaranteed to survive as the same global between
// separate executeScript calls, while the Broker needs a stable same-document
// identity across snapshot, visual preflight, and semantic action calls.
function bindInjectionDocumentIdentity(results) {
  return (Array.isArray(results) ? results : []).map((entry) => {
    const documentId = typeof entry?.documentId === "string" && entry.documentId.length > 0
      ? entry.documentId
      : null;
    if (!documentId || !entry?.result || typeof entry.result !== "object" || Array.isArray(entry.result)) return entry;
    return {
      ...entry,
      result: {
        ...entry.result,
        pageInstanceId: `chrome-document:${documentId}`,
      },
    };
  });
}

async function waitForScreenshotSlot() {
  const waitMs = Math.max(0, lastScreenshotStartedAt + SCREENSHOT_MIN_INTERVAL_MS - Date.now());
  if (waitMs > 0) await new Promise((resolve) => setTimeout(resolve, waitMs));
  lastScreenshotStartedAt = Date.now();
}

function screenshotBytes(dataUrl) {
  const comma = String(dataUrl).indexOf(",");
  if (comma < 0) return 0;
  return Math.floor((String(dataUrl).length - comma - 1) * 3 / 4);
}

async function captureExactTabScreenshot(tabId, { quality = DEFAULT_SCREENSHOT_QUALITY, maxBytes = MAX_SCREENSHOT_BYTES, restoreActive = true, allowedOrigins } = {}) {
  const target = await chrome.tabs.get(tabId);
  if (!Number.isSafeInteger(target.windowId)) throw companionError("screenshot_window_unavailable", "Target tab has no capturable window");
  const activeTabs = await chrome.tabs.query({ windowId: target.windowId, active: true });
  const previousActiveId = activeTabs[0]?.id ?? null;
  const switched = previousActiveId !== tabId;
  let interrupted = false;
  let activationInterruption = false;
  let urlInterruption = false;
  let loadingInterruption = false;
  let captureDocumentId = null;
  let restored = !switched;
  let result;
  const activated = (info) => {
    if (info.windowId === target.windowId && info.tabId !== tabId) interrupted = activationInterruption = true;
  };
  const updated = (id, info) => {
    if (id !== tabId) return;
    if (info.status === "loading") interrupted = loadingInterruption = true;
    if (info.url && info.url !== target.url) interrupted = urlInterruption = true;
  };
  const assertTarget = async (phase, attempt) => {
    const [active, current] = await Promise.all([
      chrome.tabs.query({ windowId: target.windowId, active: true }), chrome.tabs.get(tabId),
    ]);
    let documentChanged = false;
    let readinessError = null;
    const loadingChanged = current.status === "loading" && target.status !== "loading";
    if (!interrupted && active[0]?.id === tabId && current.windowId === target.windowId && current.url === target.url && !loadingChanged) {
      try {
        const document = await probeCommittedDocument(tabId, { expectedWindowId: target.windowId, expectedUrl: target.url, allowedOrigins });
        documentChanged = captureDocumentId !== null && document.documentId !== captureDocumentId;
        if (captureDocumentId === null) captureDocumentId = document.documentId;
      } catch (error) { readinessError = error; }
    }
    if (interrupted || active[0]?.id !== tabId || current.windowId !== target.windowId || current.url !== target.url || loadingChanged || readinessError || documentChanged) {
      // Retain observed interruption causes even if the tab returns to its original state.
      // IDs and booleans are sufficient for diagnosis; never expose either document URL.
      const numericId = (id) => Number.isSafeInteger(id) ? id : null;
      throw companionError("screenshot_target_changed", "The target tab or document changed during capture; discard this image and read the exact target again", {
        reasons: {
          activationInterruption,
          activeTabMismatch: active[0]?.id !== tabId,
          windowMismatch: current.windowId !== target.windowId,
          urlMismatch: urlInterruption || current.url !== target.url,
          loading: loadingInterruption || loadingChanged || readinessError?.code === "document_not_ready",
        },
        // Bounded diagnostic only: preserve every rejection and never expose
        // Chrome error messages, URLs, or arbitrary caller-controlled codes.
        ...(readinessError ? { documentProbeFailure: [
          "document_not_ready", "document_identity_unavailable", "document_probe_invalid",
          "document_target_changed", "target_origin_not_allowed", "document_readiness_timeout",
          "permission_denied",
        ].includes(readinessError.code) ? readinessError.code : "document_probe_failed" } : {}),
        ...(readinessError?.details?.documentProbeTarget ? { documentProbeTarget: (() => {
          const raw = readinessError.details.documentProbeTarget;
          const safe = {};
          if (["before_injection", "after_injection", "document_url"].includes(raw.stage)) safe.stage = raw.stage;
          for (const key of ["tabIdMatches", "windowMatches", "tabUrlMatches", "pendingNavigationPresent", "pendingUrlMatchesCommitted", "documentUrlMatches", "normalizedUrlMatches"]) {
            if (typeof raw[key] === "boolean") safe[key] = raw[key];
          }
          return safe;
        })() } : {}),
        ...(documentChanged ? { documentChanged: true } : {}),
        phase, attempt,
        targetTabId: numericId(tabId), targetWindowId: numericId(target.windowId),
        currentTabId: numericId(current.id), currentWindowId: numericId(current.windowId),
        activeTabId: numericId(active[0]?.id), activeWindowId: numericId(active[0]?.windowId),
      });
    }
  };
  try {
    if (switched) await chrome.tabs.update(tabId, { active: true });
    chrome.tabs.onActivated?.addListener(activated);
    chrome.tabs.onUpdated?.addListener(updated);
    await assertTarget("before_capture", 0);
    const requestedQuality = Math.min(Math.max(Number.isFinite(quality) ? Math.round(quality) : DEFAULT_SCREENSHOT_QUALITY, MIN_SCREENSHOT_QUALITY), 90);
    const requestedMaxBytes = Math.min(Math.max(Number.isSafeInteger(maxBytes) ? maxBytes : MAX_SCREENSHOT_BYTES, 100_000), MAX_SCREENSHOT_BYTES);
    let dataUrl = null;
    let usedQuality = requestedQuality;
    let captureAttempt = 0;
    for (const candidateQuality of [requestedQuality, Math.max(MIN_SCREENSHOT_QUALITY, requestedQuality - 20)]) {
      for (let attempt = 0; attempt < 2; attempt += 1) {
        captureAttempt += 1;
        await waitForScreenshotSlot();
        await assertTarget("after_slot", captureAttempt);
        try {
          dataUrl = await chrome.tabs.captureVisibleTab(target.windowId, { format: "jpeg", quality: candidateQuality });
          await assertTarget("after_capture", captureAttempt);
          break;
        } catch (error) {
          // A bounded retry is safe only for the capture read itself, on the same target.
          if (attempt !== 0 || !/image readback failed/i.test(String(error?.message))) throw error;
          await assertTarget("retry_guard", captureAttempt);
        }
      }
      usedQuality = candidateQuality;
      if (screenshotBytes(dataUrl) <= requestedMaxBytes || candidateQuality === MIN_SCREENSHOT_QUALITY) break;
    }
    const bytes = screenshotBytes(dataUrl);
    if (bytes > requestedMaxBytes) throw companionError("screenshot_too_large", "Captured screenshot exceeds the bounded visual-readback size", { bytes, maxBytes: requestedMaxBytes, quality: usedQuality });
    result = { kind: "screenshot", mimeType: "image/jpeg", dataBase64: String(dataUrl).replace(/^data:image\/jpeg;base64,/, ""), bytes, quality: usedQuality,
      tabId, windowId: target.windowId, url: target.url ?? null, title: target.title ?? null, capturedAt: new Date().toISOString() };
  } finally {
    chrome.tabs.onActivated?.removeListener(activated);
    chrome.tabs.onUpdated?.removeListener(updated);
    // Do not undo a user's tab selection while capture was in progress.
    if (switched && restoreActive && !interrupted && Number.isSafeInteger(previousActiveId)) {
      try {
        const active = await chrome.tabs.query({ windowId: target.windowId, active: true });
        if (active[0]?.id === tabId) {
          await chrome.tabs.update(previousActiveId, { active: true });
          restored = (await chrome.tabs.query({ windowId: target.windowId, active: true }))[0]?.id === previousActiveId;
        } else restored = false;
      } catch { restored = false; }
    }
  }
  return { ...result, restored };
}

async function getProfileInstanceId() {
  const stored = await chrome.storage.local.get(["profileInstanceId", "setupState", DISCONNECT_HISTORY_KEY]);
  if (stored.setupState && typeof stored.setupState === "object") runtimeState.setup = stored.setupState;
  if (Array.isArray(stored[DISCONNECT_HISTORY_KEY])) runtimeState.disconnectHistory = stored[DISCONNECT_HISTORY_KEY].slice(-MAX_DISCONNECT_HISTORY);
  if (typeof stored.profileInstanceId === "string" && stored.profileInstanceId.length > 0) {
    return stored.profileInstanceId;
  }
  const profileInstanceId = `profile_${crypto.randomUUID()}`;
  await chrome.storage.local.set({ profileInstanceId });
  return profileInstanceId;
}

async function getExtensionRuntimeId() {
  try {
    const stored = await chrome.storage.session.get(["extensionRuntimeId"]);
    if (typeof stored.extensionRuntimeId === "string" && stored.extensionRuntimeId.length > 0) {
      return stored.extensionRuntimeId;
    }
    const extensionRuntimeId = crypto.randomUUID();
    await chrome.storage.session.set({ extensionRuntimeId });
    return extensionRuntimeId;
  } catch {
    // A fresh ID is the safe fallback: the broker will generation-fence tabs
    // if session storage is unavailable instead of adopting stale ownership.
    return crypto.randomUUID();
  }
}

async function rotateExtensionRuntimeId() {
  // A normal Native Messaging reconnect keeps the same runtime identity so a
  // transient port loss does not quarantine every task tab.  An explicit
  // profile-global reload is different: it is a deliberate code/lifecycle
  // boundary, so publish a new identity before chrome.runtime.reload().  The
  // broker will then assign a new generation and invalidate old sessions,
  // leases, and pending operations instead of silently carrying them over.
  const extensionRuntimeId = crypto.randomUUID();
  runtimeState.extensionRuntimeId = extensionRuntimeId;
  try {
    await chrome.storage.session.set({ extensionRuntimeId });
  } catch {
    // The in-memory value is still enough for the immediate reload.  If the
    // session store is unavailable, the next worker starts with a fresh random
    // identity through getExtensionRuntimeId(), which is the safe direction.
  }
  return extensionRuntimeId;
}

function publicState() {
  return {
    profileInstanceId: runtimeState.profileInstanceId,
    extensionRuntimeId: runtimeState.extensionRuntimeId,
    buildId: INSTALL_BUILD_ID,
    bundleTreeSha256: BUNDLE_TREE_SHA256,
    extensionTreeSha256: EXTENSION_TREE_SHA256,
    nativeRecorderSha256: NATIVE_RECORDER_SHA256,
    generation: runtimeState.generation,
    connected: runtimeState.connected,
    connecting: runtimeState.connecting,
    reconnectAttempt: runtimeState.reconnectAttempt,
    lastConnectedAt: runtimeState.lastConnectedAt,
    lastDisconnectedAt: runtimeState.lastDisconnectedAt,
    lastError: runtimeState.lastError,
    disconnectHistory: runtimeState.disconnectHistory,
    setup: runtimeState.setup,
    debuggerPermissionGranted: runtimeState.debuggerPermissionGranted,
    physicalInputEnabled: runtimeState.physicalInputEnabled,
    peripheralPermissionsGranted: runtimeState.peripheralPermissionsGranted,
    reloadScheduled: runtimeState.reloadScheduled,
    reloadRequestedAt: runtimeState.reloadRequestedAt,
    reloadReason: runtimeState.reloadReason,
    protocolVersion: PROTOCOL_VERSION,
    operationSchema: OPERATION_SCHEMA,
    operationSchemaDigest: OPERATION_SCHEMA_DIGEST,
    operationSchemaVersion: OPERATION_SCHEMA_VERSION,
    capabilitiesDigest: CAPABILITIES_DIGEST,
    capabilities: CAPABILITIES,
    userControls: userControls.state(),
  };
}

function scheduleReconnect() {
  if (runtimeState.connecting || runtimeState.connected) return;
  const delay = Math.min(30_000, 500 * (2 ** Math.min(runtimeState.reconnectAttempt, 6)));
  runtimeState.reconnectAttempt += 1;
  ensureWatchdogAlarm();
  try {
    chrome.alarms.create(RECONNECT_ALARM, { when: Date.now() + delay });
  } catch (error) {
    runtimeState.lastError = error instanceof Error ? error.message : String(error);
  }
  setTimeout(() => connectNative(), delay);
}

function ensureWatchdogAlarm() {
  try {
    chrome.alarms.create(WATCHDOG_ALARM, { periodInMinutes: WATCHDOG_PERIOD_MINUTES });
  } catch (error) {
    runtimeState.lastError = error instanceof Error ? error.message : String(error);
  }
}

function requestReconnect({ force = false } = {}) {
  ensureWatchdogAlarm();
  if (runtimeState.connecting || runtimeState.connected) return;
  const now = Date.now();
  if (!force && now - lastReconnectTriggerAt < MIN_RECONNECT_TRIGGER_INTERVAL_MS) return;
  lastReconnectTriggerAt = now;
  void connectNative();
}

function detachNativePort() {
  commandAssembler.clear();
  void pageObservations.stopAll("native_port_detached");
  void javaScriptDialogs.stopAll("native_port_detached");
  void viewportControls.stopAll("native_port_detached");
  accessibilityHistory.clear();
  const port = runtimeState.port;
  runtimeState.port = null;
  clearTimeout(runtimeState.helloTimer);
  runtimeState.helloTimer = null;
  if (port) {
    try {
      port.disconnect();
    } catch {
      // The port may already be gone; the next lifecycle trigger will retry.
    }
  }
}

let disconnectPersistChain = Promise.resolve();

function rememberDisconnect(message, phase = "unknown", plannedReload = false) {
  const record = {
    at: new Date().toISOString(),
    reason: String(message || "Native Messaging port disconnected").slice(0, 500) || "unknown",
    phase: String(phase || "unknown").slice(0, 80),
    profileInstanceId: runtimeState.profileInstanceId ?? null,
    generation: runtimeState.generation ?? null,
    plannedReload: plannedReload === true,
  };
  runtimeState.disconnectHistory = [...runtimeState.disconnectHistory, record].slice(-MAX_DISCONNECT_HISTORY);
  const snapshot = runtimeState.disconnectHistory;
  try {
    const storage = chrome?.storage?.local;
    if (storage?.set) {
      disconnectPersistChain = disconnectPersistChain
        .catch(() => {})
        .then(() => storage.set({ [DISCONNECT_HISTORY_KEY]: snapshot }))
        .catch(() => {});
    }
  } catch {
    // Storage failure must not block the bounded reconnect path.
  }
  return record;
}

function markNativePortDisconnected(port, message) {
  if (runtimeState.port !== port) return false;
  const options = arguments[2] && typeof arguments[2] === "object" ? arguments[2] : {};
  const phase = options.phase ?? "unknown";
  const plannedReload = options.plannedReload ?? (runtimeState.reloadScheduled === true);
  rememberDisconnect(message, phase, plannedReload);
  commandAssembler.clear();
  void pageObservations.stopAll("native_port_disconnected");
  void javaScriptDialogs.stopAll("native_port_disconnected");
  void viewportControls.stopAll("native_port_disconnected");
  accessibilityHistory.clear();
  clearTimeout(runtimeState.helloTimer);
  runtimeState.helloTimer = null;
  runtimeState.connected = false;
  runtimeState.connecting = false;
  runtimeState.generation = null;
  runtimeState.lastDisconnectedAt = new Date().toISOString();
  runtimeState.lastError = message || "Native Messaging port disconnected";
  runtimeState.port = null;
  scheduleReconnect();
  return true;
}

// chrome.runtime.Port can remain a non-null object for a short window after
// onDisconnect. Every send must therefore be guarded; optional chaining alone
// does not prevent "Attempting to use a disconnected port object".
function postNativeMessage(message, { port = runtimeState.port } = {}) {
  if (!port || runtimeState.port !== port || (!runtimeState.connected && !runtimeState.connecting)) return false;
  try {
    port.postMessage(message);
    return true;
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    markNativePortDisconnected(port, detail, { phase: "postMessage" });
    try {
      port.disconnect();
    } catch {
      // The port is already disconnected; the scheduled reconnect is enough.
    }
    return false;
  }
}

async function connectNative() {
  if (runtimeState.connecting || runtimeState.connected) return;
  if (runtimeState.port) detachNativePort();
  runtimeState.connecting = true;
  try {
    runtimeState.profileInstanceId ??= await getProfileInstanceId();
    runtimeState.extensionRuntimeId ??= await getExtensionRuntimeId();
    const port = chrome.runtime.connectNative(NATIVE_HOST_NAME);
    runtimeState.port = port;
    port.onMessage.addListener((message) => {
      if (runtimeState.port === port) void handleNativeMessage(message);
    });
    port.onDisconnect.addListener(() => {
      if (runtimeState.port !== port) return;
      const message = chrome.runtime.lastError?.message ?? "Native Messaging port disconnected";
      markNativePortDisconnected(port, message, { phase: "port.onDisconnect" });
    });
    if (!postNativeMessage({
      kind: "extension.hello",
      protocolVersion: PROTOCOL_VERSION,
      profileInstanceId: runtimeState.profileInstanceId,
      extensionRuntimeId: runtimeState.extensionRuntimeId,
      buildId: INSTALL_BUILD_ID,
      bundleTreeSha256: BUNDLE_TREE_SHA256,
      extensionTreeSha256: EXTENSION_TREE_SHA256,
      nativeRecorderSha256: NATIVE_RECORDER_SHA256,
      operationSchema: OPERATION_SCHEMA,
      operationSchemaDigest: OPERATION_SCHEMA_DIGEST,
      operationSchemaVersion: OPERATION_SCHEMA_VERSION,
      capabilitiesDigest: CAPABILITIES_DIGEST,
      capabilities: CAPABILITIES,
    }, { port })) {
      throw companionError("native_port_send_failed", runtimeState.lastError || "Native Messaging hello could not be sent");
    }
    runtimeState.helloTimer = setTimeout(() => {
      if (runtimeState.port !== port || runtimeState.connected) return;
      // Port.disconnect does not fire onDisconnect on the calling end.
      // Clear connecting before closing, otherwise watchdog retries remain
      // suppressed forever after an unacknowledged/schema-rejected hello.
      markNativePortDisconnected(port, "Native Messaging hello acknowledgement timed out", { phase: "hello_timeout" });
      try { port.disconnect(); } catch { /* State and retry were already repaired. */ }
    }, NATIVE_HELLO_TIMEOUT_MS);
  } catch (error) {
    runtimeState.lastError = error instanceof Error ? error.message : String(error);
    runtimeState.connecting = false;
    scheduleReconnect();
  }
}

async function handleNativeMessage(message) {
  if (message.kind === "session.closed") {
    if (message.profileInstanceId === runtimeState.profileInstanceId && message.generation === runtimeState.generation) {
      await pageObservations.stopForSession(message.sessionId, message.generation);
      await javaScriptDialogs.stopForSession(message.sessionId, message.generation);
      await viewportControls.stopForSession(message.sessionId, message.generation);
      accessibilityHistory.closeSession(message.sessionId, message.generation);
    }
    return;
  }
  if (message.kind === "command.chunk") {
    const port = runtimeState.port;
    if (!runtimeState.generation || message.generation !== runtimeState.generation || message.profileInstanceId !== runtimeState.profileInstanceId) {
      sendCommandError(message.operationId, "extension_generation_stale", "Command fragment does not belong to this active profile and generation", undefined, { port });
      return;
    }
    try {
      const command = await commandAssembler.accept(message);
      if (command && runtimeState.port === port && runtimeState.generation === command.generation) await handleNativeMessage(command);
    } catch (error) {
      sendCommandError(message.operationId, error.code ?? "native_command_transfer_invalid", error.message, error.details, { port });
    }
    return;
  }
  if (message.kind === "setup.status") {
    runtimeState.setup = message.setup && typeof message.setup === "object" ? message.setup : null;
    await chrome.storage.local.set({ setupState: runtimeState.setup });
    return;
  }
  if (message.kind === "extension.hello_ack") {
    if (message.operationSchema !== undefined && message.operationSchema !== OPERATION_SCHEMA) {
      const port = runtimeState.port;
      markNativePortDisconnected(port, "Companion broker operation schema mismatch", { phase: "handshake.schema" });
      return;
    }
    if (message.operationSchemaVersion !== undefined && message.operationSchemaVersion !== OPERATION_SCHEMA_VERSION) {
      const port = runtimeState.port;
      markNativePortDisconnected(port, "Companion broker operation schema version mismatch", { phase: "handshake.schema_version" });
      return;
    }
    if (message.operationSchemaDigest !== undefined && message.operationSchemaDigest !== OPERATION_SCHEMA_DIGEST) {
      const port = runtimeState.port;
      markNativePortDisconnected(port, "Companion broker operation schema digest mismatch", { phase: "handshake.schema_digest" });
      return;
    }
    if (message.capabilitiesDigest !== undefined && message.capabilitiesDigest !== CAPABILITIES_DIGEST) {
      const port = runtimeState.port;
      markNativePortDisconnected(port, "Companion broker capability contract mismatch", { phase: "handshake.capabilities" });
      return;
    }
    clearTimeout(runtimeState.helloTimer);
    runtimeState.helloTimer = null;
    runtimeState.connected = true;
    runtimeState.connecting = false;
    runtimeState.reconnectAttempt = 0;
    if (runtimeState.generation !== message.generation) {
      commandAssembler.clear();
      void pageObservations.stopAll("generation_changed");
      void javaScriptDialogs.stopAll("generation_changed");
      void viewportControls.stopAll("generation_changed");
      accessibilityHistory.clear();
    }
    runtimeState.generation = message.generation;
    runtimeState.lastConnectedAt = new Date().toISOString();
    runtimeState.lastError = null;
    return;
  }
  if (message.kind === "relay.error" || message.kind === "peer.error") {
    const errorCode = message.error?.code ?? null;
    runtimeState.lastError = message.error?.message ?? "Companion relay error";
    // Handshake/build errors leave the Native Messaging port technically
    // open but unusable (notably while an old resident broker is yielding to
    // a newly installed build). Tear it down immediately so the bounded
    // reconnect watchdog can establish a fresh generation.
    if (["extension_build_id_mismatch", "extension_build_id_missing", "broker_connection_closed", "broker_unavailable",
      "companion_operation_schema_mismatch", "companion_operation_schema_version_mismatch",
      "companion_operation_schema_digest_mismatch", "companion_capabilities_attestation_mismatch"].includes(errorCode)) {
      const port = runtimeState.port;
      if (port) {
        markNativePortDisconnected(port, runtimeState.lastError, { phase: "peer.error" });
        try { port.disconnect(); } catch { /* onDisconnect will be handled by the guard */ }
      } else {
        runtimeState.connected = false;
        runtimeState.connecting = false;
        scheduleReconnect();
      }
    }
    return;
  }
  if (message.kind !== "command.request") return;
  const commandPort = runtimeState.port;
  if (message.profileInstanceId !== runtimeState.profileInstanceId) {
    sendCommandError(message.operationId, "profile_instance_mismatch", "Command targets another profile instance", undefined, { port: commandPort });
    return;
  }
  if (!runtimeState.generation || message.generation !== runtimeState.generation) {
    sendCommandError(message.operationId, "extension_generation_stale", "Command belongs to an inactive Extension generation", undefined, { port: commandPort });
    return;
  }
  const commandStartedAt = performance.now();
  const executionTiming = {};
  try {
    const mutation = MUTATION_OPERATION_METHODS.has(message.method);
    await userControls.beforeCommand(message.method, { ...(message.params ?? {}), targetOrigin: message.targetOrigin, mutation });
    userControls.observe(message.method, { ...message.params, operationId: message.operationId, taskId: message.taskId, taskLabel: message.taskLabel }, "running");
    const commandParams = {
      ...(message.params ?? {}),
      allowedOrigins: message.allowedOrigins,
      targetOrigin: message.targetOrigin,
      mutation,
      operationId: message.operationId,
      taskId: message.taskId,
      taskLabel: message.taskLabel,
      sessionId: message.sessionId,
      profileInstanceId: message.profileInstanceId,
      generation: message.generation,
      replyPort: commandPort,
      executionTiming,
    };
    const result = await executeWithExpectedDialog({ method: message.method, params: commandParams, dialogs: javaScriptDialogs,
      prepare: async () => { await requireTrustedDebuggerAccess(); await assertLiveOrigin(requireTabId(commandParams.tabId), commandParams); },
      execute: () => executeCommand(message.method, commandParams),
      emit: event => postNativeMessage({ kind: "command.event", operationId: message.operationId, event }, { port: commandPort }),
    });
    userControls.observe(message.method, { operationId: message.operationId }, "finished");
    postNativeMessage({
      kind: "command.result",
      operationId: message.operationId,
      result,
      executionTiming: { ...executionTiming, total: performance.now() - commandStartedAt },
    }, { port: commandPort });
  } catch (error) {
    userControls.observe(message.method, { ...message.params, operationId: message.operationId, taskId: message.taskId, taskLabel: message.taskLabel }, "failed", error);
    sendCommandError(
      message.operationId,
      error?.code ?? "extension_operation_failed",
      error instanceof Error ? error.message : String(error),
      error?.details,
      { port: commandPort, executionTiming: { ...executionTiming, total: performance.now() - commandStartedAt } },
    );
  }
}

function sendCommandError(operationId, code, message, details, { port = runtimeState.port, executionTiming } = {}) {
  postNativeMessage({
    kind: "command.error",
    operationId,
    error: { code, message, ...(details && typeof details === "object" ? { details } : {}) },
    ...(executionTiming ? { executionTiming } : {}),
  }, { port });
}

function companionError(code, message, details) {
  const error = new Error(message);
  error.code = code;
  if (details !== undefined) error.details = details;
  return error;
}

function requireTabId(value) {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw companionError("invalid_tab_id", "tabId must be a non-negative integer");
  }
  return value;
}

function requireSafeUrl(value) {
  if (value === "about:blank") return value;
  let parsed;
  try {
    parsed = new URL(value);
  } catch {
    throw companionError("invalid_url", "URL is invalid");
  }
  if (!new Set(["http:", "https:"]).has(parsed.protocol) || parsed.username || parsed.password) {
    throw companionError("url_not_allowed", "Only credential-free http(s) URLs and about:blank are allowed");
  }
  return parsed.href;
}

function originOf(value) {
  try { return new URL(value).origin; } catch { return null; }
}

function allowedOriginsOf(value) {
  if (!Array.isArray(value) || value.length === 0) return null;
  return new Set(value.map((entry) => originOf(entry)).filter(Boolean));
}

async function assertLiveOrigin(tabId, params, { allowBlank = false } = {}) {
  if (!params.mutation) return await chrome.tabs.get(tabId);
  const tab = await chrome.tabs.get(tabId);
  const origin = originOf(tab.url);
  const allowed = allowedOriginsOf(params.allowedOrigins);
  if (!allowed || !origin || (!allowBlank && !allowed.has(origin))) {
    throw companionError("target_origin_not_allowed", "Live tab origin is outside the signed allowlist");
  }
  if (params.targetOrigin && params.targetOrigin !== "*" && params.targetOrigin !== origin) {
    throw companionError("target_origin_mismatch", "Live tab origin does not match authority targetOrigin");
  }
  return tab;
}

async function probeCommittedDocument(tabId, { expectedWindowId, expectedUrl, allowedOrigins, deadline = Date.now() + READ_API_TIMEOUT_MS } = {}) {
  const remaining = deadline - Date.now();
  if (remaining <= 0) throw companionError("document_readiness_timeout", "Committed document probe exceeded its deadline");
  return await withTimeout((async () => {
    const before = await chrome.tabs.get(tabId);
    const windowId = expectedWindowId ?? before.windowId;
    const url = expectedUrl ?? before.url;
    const allowed = allowedOriginsOf(allowedOrigins ?? [url]);
    const targetConditions = (tab) => ({
      tabIdMatches: tab.id === tabId,
      windowMatches: Number.isSafeInteger(windowId) && tab.windowId === windowId,
      tabUrlMatches: tab.url === url,
      pendingNavigationPresent: Boolean(tab.pendingUrl),
      pendingUrlMatchesCommitted: Boolean(tab.pendingUrl) && tab.pendingUrl === url,
    });
    const assertTab = (tab, stage) => {
      if (tab.id !== tabId || !Number.isSafeInteger(windowId) || tab.windowId !== windowId || tab.url !== url || tab.pendingUrl) {
        throw companionError("document_target_changed", "The exact committed tab changed during its readiness probe", {
          documentProbeTarget: { stage, ...targetConditions(tab) },
          nextAction: tab.pendingUrl ? "read_exact_tab_pending_navigation_then_bounded_commit_wait" : "read_exact_tab_identity_before_retrying_read",
        });
      }
      if (!allowed || !allowed.has(originOf(tab.url))) throw companionError("target_origin_not_allowed", "Committed document origin is outside the allowlist");
    };
    assertTab(before, "before_injection");
    if (Date.now() >= deadline) throw companionError("document_readiness_timeout", "Committed document probe exceeded its deadline");
    const results = bindInjectionDocumentIdentity(await executePageScriptWithReadRetry(
      { tabId, frameIds: [0] }, "snapshot", { maxTextChars: 0 }, deadline - Date.now(),
    ));
    const entry = results[0];
    if (results.length !== 1 || entry?.frameId !== 0 || !entry.result || typeof entry.result !== "object" || Array.isArray(entry.result)) {
      throw companionError("document_probe_invalid", "Chrome returned a malformed committed document probe");
    }
    if (typeof entry.documentId !== "string" || entry.documentId.length === 0 || entry.result.pageInstanceId !== `chrome-document:${entry.documentId}`) {
      throw companionError("document_identity_unavailable", "Chrome did not provide the committed document identity");
    }
    if (entry.result.url !== url) {
      let normalizedUrlMatches = false;
      try { normalizedUrlMatches = new URL(entry.result.url).href === new URL(url).href; } catch {}
      throw companionError("document_target_changed", "Document URL does not match the committed tab", {
        documentProbeTarget: { stage: "document_url", documentUrlMatches: false, normalizedUrlMatches },
      });
    }
    if (!["interactive", "complete", "loading"].includes(entry.result.readyState)) throw companionError("document_probe_invalid", "Chrome returned an invalid document readiness state");
    if (entry.result.readyState === "loading") throw companionError("document_not_ready", "The committed document DOM is still loading");
    const after = await chrome.tabs.get(tabId);
    assertTab(after, "after_injection");
    if (Date.now() >= deadline) throw companionError("document_readiness_timeout", "Committed document probe exceeded its deadline");
    return { documentId: entry.documentId, readyState: entry.result.readyState, url: entry.result.url, tab: after };
  })(), Math.min(READ_API_TIMEOUT_MS, remaining), "document_readiness_timeout", "Committed document probe exceeded its deadline").catch((error) => {
    // The nested script timer and the whole-probe timer share the same bound.
    // Whichever fires first must expose the same readiness timeout classification.
    if (error?.code === "page_execution_timeout") throw companionError("document_readiness_timeout", "Committed document probe exceeded its deadline");
    throw error;
  });
}

async function waitForCommittedTab(tabId, { requestedUrl, previousUrl = null, previousDocumentId = null, fragmentRequestedUrl = null, expectedWindowId, allowedOrigins, timeoutMs = DEFAULT_NAVIGATION_TIMEOUT_MS, deadline = Date.now() + timeoutMs } = {}) {
  const requested = requestedUrl ? requireSafeUrl(requestedUrl) : null;
  if (previousUrl !== null && (typeof previousDocumentId !== "string" || !previousDocumentId)) {
    throw companionError("previous_document_identity_required", "Navigation requires the browser document identity observed before dispatch");
  }
  while (Date.now() < deadline) {
    try {
      const document = await probeCommittedDocument(tabId, { expectedWindowId, allowedOrigins: allowedOrigins ?? [requested], deadline });
      if (previousDocumentId === null || document.documentId !== previousDocumentId) return document.tab;
      if (fragmentRequestedUrl !== null && fragmentRequestedUrl === requested && requested !== previousUrl
        && document.documentId === previousDocumentId && document.url === fragmentRequestedUrl && document.tab.url === fragmentRequestedUrl) return document.tab;
    } catch (error) {
      if (["document_readiness_timeout", "page_execution_timeout"].includes(error?.code)) break;
      if (!["document_target_changed", "document_not_ready"].includes(error?.code)) throw error;
    }
    await new Promise((resolve) => setTimeout(resolve, Math.min(50, Math.max(0, deadline - Date.now()))));
  }
  throw companionError("navigation_commit_timeout", "Timed out waiting for navigation commit");
}

async function waitForTabSettled(tabId, { previousUrl = null, timeoutMs = DEFAULT_NAVIGATION_TIMEOUT_MS, requireTransition = false } = {}) {
  const deadline = Date.now() + timeoutMs;
  let sawLoading = false;
  while (Date.now() <= deadline) {
    const tab = await chrome.tabs.get(tabId);
    if (tab.status === "loading" || (previousUrl && tab.url && tab.url !== previousUrl)) sawLoading = true;
    if (tab.status === "complete" && (sawLoading || (!requireTransition && tab.url))) return tab;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw companionError("tab_settle_timeout", "Timed out waiting for the exact tab to settle");
}

async function closeTabAndVerify(tabId) {
  await chrome.tabs.remove(tabId);
  const deadline = Date.now() + 3_000;
  while (Date.now() < deadline) {
    try { await chrome.tabs.get(tabId); } catch { return { closed: true, tabId, closedExpected: true }; }
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw companionError("tab_close_unverified", "Chrome did not confirm task tab removal");
}

function sanitizeTab(tab) {
  return {
    id: tab.id,
    windowId: tab.windowId,
    // Preserve the browser-provided opener lineage so the broker can bind an
    // authentication popup to the exact task-owned tab that opened it. This
    // is metadata only; it never grants ownership by itself.
    ...(Number.isSafeInteger(tab.openerTabId) ? { openerTabId: tab.openerTabId } : {}),
    index: tab.index,
    active: tab.active,
    pinned: tab.pinned,
    groupId: tab.groupId,
    url: boundedTabText(tab.url, MAX_TAB_URL_CHARS),
    pendingNavigationPresent: Boolean(tab.pendingUrl),
    pendingUrlMatchesCommitted: Boolean(tab.pendingUrl) && tab.pendingUrl === tab.url,
    title: boundedTabText(tab.title, MAX_TAB_TITLE_CHARS),
    status: tab.status,
    discarded: tab.discarded,
    audible: tab.audible,
  };
}

function taskGroupTitle(taskId, taskLabel) {
  const label = typeof taskLabel === "string" && taskLabel.trim()
    ? taskLabel.trim().slice(0, 42)
    : `Task ${String(taskId).slice(-8)}`;
  return `AOS • ${label}`;
}

function taskGroupColor(taskId) {
  const colors = ["blue", "red", "yellow", "green", "pink", "purple", "cyan", "orange"];
  let hash = 0;
  for (const char of String(taskId)) hash = ((hash * 31) + char.charCodeAt(0)) >>> 0;
  return colors[hash % colors.length];
}

async function ensureTaskGroup(tab, { taskId, taskLabel, collapsed = false } = {}) {
  if (!Number.isSafeInteger(tab?.id) || typeof taskId !== "string" || !taskId) {
    throw companionError("task_group_context_missing", "Companion task tabs require an exact task identity");
  }
  const key = `taskGroup:${taskId}`;
  const saved = await chrome.storage.local.get(key);
  let groupId = saved[key]?.groupId;
  if (Number.isSafeInteger(groupId) && groupId >= 0) {
    try {
      const group = await chrome.tabGroups.get(groupId);
      if (group.windowId !== tab.windowId) groupId = null;
    } catch {
      groupId = null;
    }
  }
  if (!Number.isSafeInteger(groupId)) {
    groupId = await chrome.tabs.group({ tabIds: [tab.id] });
  } else if (tab.groupId !== groupId) {
    await chrome.tabs.group({ groupId, tabIds: [tab.id] });
  }
  await chrome.tabGroups.update(groupId, {
    title: taskGroupTitle(taskId, taskLabel),
    color: taskGroupColor(taskId),
    collapsed: collapsed === true,
  });
  await chrome.storage.local.set({ [key]: { groupId, windowId: tab.windowId, updatedAt: new Date().toISOString() } });
  return groupId;
}

function requireVisualPoint(value, field = "point") {
  const x = Number(value?.x);
  const y = Number(value?.y);
  if (!Number.isFinite(x) || !Number.isFinite(y) || x < 0 || y < 0 || x > 20_000 || y > 20_000) {
    throw companionError("visual_point_invalid", `${field} must contain bounded non-negative x/y coordinates`);
  }
  return { x: Math.round(x), y: Math.round(y) };
}

function debuggerError(error) {
  const message = error instanceof Error ? error.message : String(error);
  const code = /another debugger|already attached|target closed/i.test(message)
    ? "visual_input_debugger_busy"
    : /permission|not allowed|not permitted/i.test(message)
      ? "visual_input_permission_required"
      : "visual_input_debugger_failed";
  return companionError(code, message);
}

async function hasDebuggerPermission() {
  const granted = await chrome.permissions.contains({ permissions: ["debugger"] });
  runtimeState.debuggerPermissionGranted = granted;
  return granted;
}

async function hasPhysicalInputOptIn() {
  const stored = await chrome.storage.local.get(PHYSICAL_INPUT_ENABLED_KEY);
  const enabled = stored?.[PHYSICAL_INPUT_ENABLED_KEY] === true;
  runtimeState.physicalInputEnabled = enabled;
  return enabled;
}

async function requireTrustedDebuggerAccess() {
  if (!await hasDebuggerPermission()) {
    throw companionError("visual_input_permission_required", "Reload Companion and approve its required Chrome debugger access");
  }
  if (!await hasPhysicalInputOptIn()) {
    throw companionError("visual_input_permission_required", "Open the Companion popup and choose Enable physical input before this bounded operation");
  }
}

async function hasPeripheralPermissions() {
  const granted = await chrome.permissions.contains({ permissions: ["downloads", "clipboardRead", "clipboardWrite"] });
  runtimeState.peripheralPermissionsGranted = granted;
  return granted;
}

async function requireOptionalPermission(permission, blocker) {
  if (!await chrome.permissions.contains({ permissions: [permission] })) {
    throw companionError(blocker, `Open the Companion popup and allow ${permission} before this bounded operation`);
  }
}

async function ensureOffscreenClipboard() {
  if (await chrome.offscreen.hasDocument()) return;
  await chrome.offscreen.createDocument({
    url: "offscreen.html",
    reasons: ["CLIPBOARD", "USER_MEDIA", "AUDIO_PLAYBACK"],
    justification: "Read or write bounded clipboard data and record an explicitly selected tab with its audio",
  });
}

async function startCompanionTabRecording(params) {
  await requireOptionalPermission("downloads", "recording_download_permission_required");
  const tabId = requireTabId(params.tabId);
  const tab = await chrome.tabs.get(tabId);
  let protocol;
  try { protocol = new URL(tab.url ?? "").protocol; } catch { protocol = null; }
  if (!tab?.id || !/^https?:$/u.test(protocol ?? "")) {
    throw companionError("recording_target_invalid", "Recording requires an exact HTTP(S) tab");
  }
  if (params.userGesture !== true && params.nativeHostTrigger !== true) {
    throw companionError("recording_user_gesture_required", "Start tab recording from the Companion popup after selecting the exact target tab", { tabId, audioRequired: true });
  }
  await ensureOffscreenClipboard();
  const streamId = String(params.streamId ?? await chrome.tabCapture.getMediaStreamId({ targetTabId: tabId }));
  if (!streamId) throw companionError("recording_stream_id_missing", "Chrome did not provide a tab capture stream id");
  const result = await chrome.runtime.sendMessage({ kind: "offscreen.recording.start", streamId, tabId, taskId: params.taskId ?? null });
  if (!result?.ok) throw companionError(result?.code ?? "recording_start_failed", result?.error ?? "Tab recording could not start");
  return { ...result, url: tab.url, title: tab.title ?? null, surface: "chrome-extension-tab", captureEngine: "chrome.tabCapture+offscreen+MediaRecorder", audioCaptured: true };
}

async function stopCompanionTabRecording(params) {
  await ensureOffscreenClipboard();
  const result = await chrome.runtime.sendMessage({ kind: "offscreen.recording.stop", filename: params.filename });
  if (!result?.ok) throw companionError(result?.code ?? "recording_stop_failed", result?.error ?? "Tab recording could not stop");
  return { ...result, surface: "chrome-extension-tab", captureEngine: "chrome.tabCapture+offscreen+MediaRecorder", audioCaptured: true, mediaVerified: result.bytes > 0 && result.chunks > 0 };
}

async function companionTabRecordingStatus(params) {
  await ensureOffscreenClipboard();
  if (params.armOnly === true) {
    const tabId = requireTabId(params.tabId);
    pendingAutoRecordingTabId = tabId;
    return { armed: true, active: false, tabId, audioRequired: true, captureEngine: "chrome.tabCapture+offscreen+MediaRecorder" };
  }
  const result = await chrome.runtime.sendMessage({ kind: "offscreen.recording.status" });
  if (!result?.ok) throw companionError(result?.code ?? "recording_status_failed", result?.error ?? "Recording status is unavailable");
  if (result.active && Number.isSafeInteger(params.tabId) && result.tabId !== params.tabId) {
    throw companionError("recording_target_mismatch", "The active recording belongs to another tab", { requestedTabId: params.tabId, activeTabId: result.tabId });
  }
  const last = result.lastResult && typeof result.lastResult === "object" ? result.lastResult : {};
  return { ...result, ...last, surface: "chrome-extension-tab", captureEngine: "chrome.tabCapture+offscreen+MediaRecorder", audioCaptured: result.active || last.audioCaptured === true };
}

function redactPeripheralText(value, maxChars = 30_000) {
  const text = String(value ?? "")
    .replace(/\bBearer\s+[A-Za-z0-9._~+\/-]{12,}\b/giu, "Bearer <redacted>")
    .replace(/\bBasic\s+[A-Za-z0-9+/=]{12,}\b/giu, "Basic <redacted>")
    .replace(/\b(?:api[_-]?key|access[_-]?token|refresh[_-]?token|client[_-]?secret|authorization|proxy[_-]?authorization|cookie|set-cookie|session(?:id|token)?|secret|password|private[_-]?key)\s*[:=]\s*[^\s,;]{4,}/giu, "$1=<redacted>")
    .replace(/\b(?:sk|gh[opusr]|xox[baprs])[-_][A-Za-z0-9_-]{12,}\b/gu, "<redacted-token>")
    .replace(/-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/gu, "<redacted-private-key>")
    .replace(/\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\b/gu, "<redacted-jwt>");
  return { text: text.slice(0, maxChars), truncated: text.length > maxChars };
}

async function handleClipboardSourceStorage(message, sender) {
  if (sender?.id !== chrome.runtime.id || sender?.tab || sender?.url !== chrome.runtime.getURL("offscreen.html")) {
    throw companionError("clipboard_source_storage_sender_invalid", "Only the exact Companion offscreen document can access source metadata");
  }
  const prefix = "companion.clipboard.source.v1:";
  const requestBinding = message.sourceBinding;
  if (!requestBinding || typeof requestBinding.operationId !== "string"
    || !/^[A-Za-z0-9_.:-]{1,200}$/u.test(requestBinding.operationId)) throw companionError("clipboard_source_storage_key_invalid", "Exact source operation binding is required");
  if (message.action === "count") {
    const values = await chrome.storage.local.get(null);
    const records = Object.entries(values).filter(([key]) => key.startsWith(prefix));
    // Reclaim full terminal ACK metadata, never the operation identity. One
    // storage replacement leaves every unresolved intent untouched, including
    // if compaction fails or the worker restarts before acknowledging it.
    const active = records.filter(([, value]) => value?.compacted !== true);
    if (active.length >= 512) {
      const replacements = Object.fromEntries(active.filter(([, value]) => value?.state === "completed" && value.ack?.writeAcknowledged === true)
        .map(([key, value]) => [key, { schema: value.schema, sourceBinding: value.sourceBinding,
          state: "completed", completedAt: value.completedAt, compacted: true, writeAcknowledged: true }]));
      if (Object.keys(replacements).length) await chrome.storage.local.set(replacements);
      return active.length - Object.keys(replacements).length;
    }
    return active.length;
  }
  if (message.key !== prefix + requestBinding.operationId || typeof message.key !== "string" || !message.key.startsWith(prefix)
    || !/^[A-Za-z0-9_.:-]{1,200}$/u.test(message.key.slice(prefix.length))) {
    throw companionError("clipboard_source_storage_key_invalid", "Clipboard metadata is restricted to the source operation namespace");
  }
  const existing = (await chrome.storage.local.get(message.key))[message.key];
  if (existing && JSON.stringify(existing.sourceBinding) !== JSON.stringify(requestBinding)) {
    throw companionError("clipboard_source_binding_mismatch", "Source metadata does not belong to this exact request binding");
  }
  if (message.action === "get") return existing ?? null;
  const value = message.value, binding = value?.sourceBinding;
  const allowedKeys = value?.state === "intent" ? ["schema", "sourceBinding", "state", "intendedAt"]
    : ["schema", "sourceBinding", "state", "completedAt", "ack"];
  const ackKeys = new Set(["ok", "binary", "mimeType", "size", "formats", "writeAcknowledged", "pasteVerified", "contentReturned", "taskId", "targetOrigin", "chars"]);
  let origin;
  try { origin = new URL(binding?.targetOrigin).origin; } catch {}
  if (message.action !== "set" || value?.schema !== "aos.chrome_companion.clipboard_source.v1"
    || !["intent", "completed"].includes(value.state) || !binding || JSON.stringify(binding) !== JSON.stringify(requestBinding) || binding.operationId !== message.key.slice(prefix.length)
    || typeof binding.taskId !== "string" || !binding.taskId || binding.taskId.length > 512
    || typeof binding.generation !== "string" || !binding.generation || binding.generation.length > 200
    || !/^https?:\/\//u.test(binding.targetOrigin ?? "") || origin !== binding.targetOrigin
    || !/^[a-f0-9]{64}$/u.test(binding.payloadSha256 ?? "")
    || Object.keys(binding).some(key => !["operationId", "taskId", "targetOrigin", "generation", "payloadSha256"].includes(key))
    || Object.keys(value).some(key => !allowedKeys.includes(key)) || JSON.stringify(value).length > 3000
    || (value.state === "completed" && (value.ack?.writeAcknowledged !== true
      || value.ack.ok !== true
      || (value.ack.chars !== undefined && (!Number.isSafeInteger(value.ack.chars) || value.ack.chars < 0 || value.ack.chars > 100_000))
      || (value.ack.size !== undefined && (!Number.isSafeInteger(value.ack.size) || value.ack.size < 1 || value.ack.size > MAX_CLIPBOARD_BINARY_BYTES))
      || (value.ack.mimeType !== undefined && value.ack.mimeType !== null && !["text/plain", "text/html", "image/png"].includes(value.ack.mimeType))
      || (value.ack.taskId !== undefined && value.ack.taskId !== binding.taskId)
      || (value.ack.targetOrigin !== undefined && value.ack.targetOrigin !== binding.targetOrigin)
      || (value.ack.binary !== undefined && value.ack.binary !== true)
      || (value.ack.pasteVerified !== undefined && value.ack.pasteVerified !== false)
      || (value.ack.contentReturned !== undefined && value.ack.contentReturned !== false)
      || Object.keys(value.ack).some(key => !ackKeys.has(key))
      || (value.ack.formats && (!Array.isArray(value.ack.formats) || value.ack.formats.length > 3
        || value.ack.formats.some(format => !["text/plain", "text/html", "image/png"].includes(format.mimeType)
          || !Number.isSafeInteger(format.inputBytes) || format.inputBytes < 1 || format.inputBytes > MAX_CLIPBOARD_BINARY_BYTES
          || Object.keys(format).some(key => !["mimeType", "inputBytes"].includes(key)))))))) {
    throw companionError("clipboard_source_storage_value_invalid", "Only bounded request-bound intent and terminal ACK metadata may be persisted");
  }
  if (existing && (JSON.stringify(existing.sourceBinding) !== JSON.stringify(binding)
    || existing.state === "completed" || value.state === "intent")) {
    throw companionError("clipboard_source_storage_immutable", "Stored clipboard intent binding and completed receipts cannot be replaced");
  }
  if (!existing && value.state !== "intent") throw companionError("clipboard_source_intent_required", "Terminal ACK requires a previously durable source intent");
  if (!existing) {
    const values = await chrome.storage.local.get(null);
    if (Object.entries(values).filter(([key, record]) => key.startsWith(prefix) && record?.compacted !== true).length >= 512)
      throw companionError("clipboard_source_capacity_reached", "Unresolved/full source metadata is at finite capacity");
    // Keep permanent tombstones until the real storage byte limit is reached.
    // Reserve terminal metadata before starting a new clipboard effect.
    const usedBytes = typeof chrome.storage.local.getBytesInUse === "function"
      ? await chrome.storage.local.getBytesInUse(null)
      : Object.entries(values).reduce((total, [key, record]) => total + new TextEncoder().encode(key + JSON.stringify(record)).length, 0);
    const quotaBytes = chrome.storage.local.QUOTA_BYTES ?? 10 * 1024 * 1024;
    // The validated terminal JSON is at most 3000 UTF-16 units; reserving
    // four bytes per unit also covers non-ASCII task bindings conservatively.
    if (usedBytes + new TextEncoder().encode(message.key + JSON.stringify(value)).length + 12_000 > quotaBytes)
      throw companionError("clipboard_source_capacity_reached", "Durable source identities reached the storage byte limit; a new clipboard write was not started");
  }
  await chrome.storage.local.set({ [message.key]: value });
  return true;
}

async function runClipboardOperation(method, params) {
  const sourceMessage = async payload => {
    const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(JSON.stringify(payload)));
    return { operationId: params.operationId, taskId: params.taskId, generation: params.generation,
      targetOrigin: params.targetOrigin ?? params.origin,
      payloadSha256: [...new Uint8Array(digest)].map(byte => byte.toString(16).padStart(2, "0")).join("") };
  };
  const compactedDuplicate = (result, message) => {
    if (result.compacted !== true) return null;
    const receipt = result.sourceReceipt, binding = receipt?.sourceBinding;
    if (result.ok !== true || result.duplicateDelivery !== true || result.acknowledgedHistorical !== true
      || receipt?.state !== "completed" || receipt.compacted !== true || receipt.writeAcknowledged !== true
      || binding?.operationId !== message.operationId || binding?.taskId !== message.taskId
      || binding?.generation !== message.generation || binding?.targetOrigin !== new URL(message.targetOrigin).origin
      || binding?.payloadSha256 !== message.payloadSha256)
      throw companionError("clipboard_write_result_unknown", "Compacted receipt did not match the exact historical source request", { operationEffectState: "unknown", mutationDispatchAttempted: false, retryWrite: false });
    return { written: false, writeAcknowledged: true, acknowledgedHistorical: true, compacted: true,
      duplicateDelivery: true, sourceReceipt: receipt, pasteVerified: false, contentReturned: false,
      operationEffectState: "none", mutationDispatchAttempted: false };
  };
  if (method === "clipboard.receipt") {
    await ensureOffscreenClipboard();
    const live = await chrome.tabs.get(requireTabId(params.tabId));
    const result = await chrome.runtime.sendMessage({ kind: "offscreen.clipboard.receipt", sourceOperationId: params.sourceOperationId,
      payloadSha256: params.payloadSha256, taskId: params.taskId, generation: params.generation, targetOrigin: new URL(live.url).origin });
    if (!result?.ok) throw companionError(result?.code ?? "clipboard_receipt_failed", result?.error ?? "Source receipt lookup failed", result?.details);
    return result;
  }
  if (method === "clipboard.write" && params.formats !== undefined) {
    let message, expectedBytes = 0; const expectedFormats = [];
    try {
      if (params.text !== undefined) throw companionError("clipboard_write_payload_invalid", "Provide text or MIME formats, not both");
      if (params.approved !== true) throw companionError("binary_clipboard_approval_required", "MIME clipboard writes require explicit per-operation opt-in");
      if (!Array.isArray(params.formats) || params.formats.length < 1 || params.formats.length > 3) throw companionError("clipboard_formats_invalid", "Provide 1 to 3 MIME representations of one clipboard item");
      const seen = new Set(); let totalBytes = 0;
      for (const format of params.formats) {
        if (!new Set(["text/plain", "text/html", "image/png"]).has(format?.mimeType) || seen.has(format.mimeType)) throw companionError("clipboard_write_mime_unsupported", "Use unique text/plain, text/html, or image/png representations");
        seen.add(format.mimeType);
        if (typeof format.dataBase64 !== "string" || !format.dataBase64.length || format.dataBase64.length > Math.ceil(MAX_CLIPBOARD_BINARY_BYTES * 4 / 3) + 4) throw companionError("clipboard_payload_too_large", "Clipboard formats exceed the 2 MiB combined limit");
        let decoded;
        try { decoded = atob(format.dataBase64); } catch { throw companionError("clipboard_base64_invalid", "Clipboard format must contain base64 data"); }
        if (!decoded.length) throw companionError("clipboard_base64_invalid", "A MIME representation must contain nonempty decoded bytes");
        totalBytes += decoded.length;
        expectedFormats.push({ mimeType: format.mimeType, inputBytes: decoded.length });
        if (totalBytes > MAX_CLIPBOARD_BINARY_BYTES) throw companionError("clipboard_payload_too_large", "Clipboard formats exceed the 2 MiB combined limit");
      }
      await requireOptionalPermission("clipboardWrite", "clipboard_permission_required");
      await ensureOffscreenClipboard();
      message = { kind: "offscreen.clipboard.binary.write", formats: params.formats, maxBytes: MAX_CLIPBOARD_BINARY_BYTES, optIn: true,
        ...await sourceMessage({ formats: params.formats.map(({ mimeType, dataBase64 }) => ({ mimeType, dataBase64 })) }) };
      expectedBytes = totalBytes;
    } catch (error) {
      error.details = { ...(error?.details ?? {}), operationEffectState: "none", mutationDispatchAttempted: false };
      throw error;
    }
    let result;
    try { result = await chrome.runtime.sendMessage(message); }
    catch { throw companionError("clipboard_write_result_unknown", "The clipboard write acknowledgement was lost; read back before continuing", { operationEffectState: "unknown", mutationDispatchAttempted: true, retryWrite: false }); }
    if (!result?.ok) throw companionError(result?.code ?? "clipboard_write_result_unknown", result?.error ?? "Clipboard write was not acknowledged", result?.details ?? { operationEffectState: "unknown", mutationDispatchAttempted: true, retryWrite: false });
    const historical = compactedDuplicate(result, message);
    if (historical) return historical;
    if (result.ok !== true || result.binary !== true || result.writeAcknowledged !== true || result.taskId !== message.taskId || result.targetOrigin !== new URL(message.targetOrigin).origin
      || result.size !== expectedBytes || JSON.stringify(result.formats) !== JSON.stringify(expectedFormats)
      || result.sourceReceipt?.sourceBinding?.operationId !== message.operationId
      || result.sourceReceipt?.sourceBinding?.taskId !== message.taskId
      || result.sourceReceipt?.sourceBinding?.targetOrigin !== new URL(message.targetOrigin).origin
      || result.sourceReceipt?.sourceBinding?.generation !== message.generation
      || result.sourceReceipt?.sourceBinding?.payloadSha256 !== message.payloadSha256
      || result.sourceReceipt?.ack?.ok !== true || result.sourceReceipt?.ack?.binary !== true
      || result.sourceReceipt?.ack?.writeAcknowledged !== true || result.sourceReceipt?.ack?.size !== expectedBytes
      || JSON.stringify(result.sourceReceipt?.ack?.formats) !== JSON.stringify(expectedFormats)
      || result.sourceReceipt?.state !== "completed") {
      throw companionError("clipboard_write_result_unknown", "The clipboard write acknowledgement did not match this request", { operationEffectState: "unknown", mutationDispatchAttempted: true, retryWrite: false });
    }
    return { written: true, binary: true, mimeType: result.mimeType, size: result.size, formats: result.formats, writeAcknowledged: true,
      sourceReceipt: result.sourceReceipt, duplicateDelivery: result.duplicateDelivery === true, pasteVerified: false, contentReturned: false };
  }
  if (method === "clipboard.write" && typeof params.text !== "string") throw companionError("clipboard_write_payload_invalid", "Provide explicit text or MIME formats", { operationEffectState: "none", mutationDispatchAttempted: false });
  const permission = method === "clipboard.read" ? "clipboardRead" : "clipboardWrite";
  await requireOptionalPermission(permission, "clipboard_permission_required");
  await ensureOffscreenClipboard();
  if (method === "clipboard.read") {
    const result = await chrome.runtime.sendMessage({ kind: "offscreen.clipboard.read" });
    if (!result?.ok) throw companionError("clipboard_read_failed", result?.error ?? "Clipboard read failed");
    const redacted = redactPeripheralText(result.text, 100_000);
    return { read: true, ...redacted, originalTruncated: result.truncated === true, redactionApplied: redacted.text !== result.text };
  }
  const text = String(params.text ?? "");
  if (text.length > 100_000) throw companionError("clipboard_payload_too_large", "Clipboard write is limited to 100000 characters", { operationEffectState: "none", mutationDispatchAttempted: false });
  const message = { kind: "offscreen.clipboard.write", text, ...await sourceMessage({ text }) };
  let result;
  try { result = await chrome.runtime.sendMessage(message); }
  catch { throw companionError("clipboard_write_result_unknown", "Text clipboard acknowledgement was lost; inspect the source receipt without repeating the write", { operationEffectState: "unknown", mutationDispatchAttempted: true, retryWrite: false, sourceBinding: { operationId: message.operationId, payloadSha256: message.payloadSha256 } }); }
  if (!result?.ok) throw companionError(result?.code ?? "clipboard_write_result_unknown", result?.error ?? "Clipboard write failed", result?.details ?? { operationEffectState: "unknown", mutationDispatchAttempted: true, retryWrite: false });
  const historical = compactedDuplicate(result, message);
  if (historical) return historical;
  const binding = result.sourceReceipt?.sourceBinding;
  if (result.writeAcknowledged !== true || result.chars !== text.length || result.sourceReceipt?.state !== "completed"
    || binding?.operationId !== message.operationId || binding?.taskId !== message.taskId
    || binding?.generation !== message.generation || binding?.targetOrigin !== new URL(message.targetOrigin).origin
    || binding?.payloadSha256 !== message.payloadSha256) throw companionError("clipboard_write_result_unknown", "Text clipboard ACK did not match this source request", { operationEffectState: "unknown", mutationDispatchAttempted: true, retryWrite: false });
  return { written: true, chars: result.chars, writeAcknowledged: true, sourceReceipt: result.sourceReceipt,
    duplicateDelivery: result.duplicateDelivery === true, pasteVerified: false, contentReturned: false };
}

async function runBinaryClipboardOperation(params) {
  await requireOptionalPermission("clipboardRead", "clipboard_permission_required");
  if (params.approved !== true) throw companionError("binary_clipboard_approval_required", "Binary clipboard reads require explicit per-operation approval");
  const mimeTypes = Array.isArray(params.mimeTypes) ? [...new Set(params.mimeTypes.map(String))] : [];
  const maxBytes = Number.isSafeInteger(params.maxBytes) ? params.maxBytes : MAX_CLIPBOARD_BINARY_BYTES;
  if (!mimeTypes.length || mimeTypes.length > 8) throw companionError("binary_clipboard_mime_not_allowed", "Binary clipboard MIME types must be explicitly allowlisted");
  if (mimeTypes.some((mime) => !BINARY_CLIPBOARD_MIME_ALLOWLIST.has(mime.trim().toLowerCase()))) {
    throw companionError("binary_clipboard_mime_not_allowed", "Binary clipboard MIME types must be explicitly allowlisted");
  }
  if (maxBytes < 1 || maxBytes > MAX_CLIPBOARD_BINARY_BYTES) throw companionError("binary_clipboard_size_invalid", "Binary clipboard size must be between 1 and 2097152 bytes");
  await ensureOffscreenClipboard();
  const result = await chrome.runtime.sendMessage({ kind: "offscreen.clipboard.binary.read", mimeTypes, maxBytes, optIn: true, taskId: params.taskId, targetOrigin: params.targetOrigin ?? params.origin });
  if (!result?.ok) throw companionError(result?.code ?? "clipboard_binary_read_failed", result?.error ?? "Binary clipboard read failed", result?.details);
  // Do not copy raw clipboard bytes into logs or status.  The result contains
  // only bounded metadata and an opaque payload for the caller that approved it.
  return { read: true, approved: true, binary: true, mimeType: result.mimeType ?? null, size: result.size ?? null, dataBase64: result.dataBase64 ?? null, itemCount: result.dataBase64 ? 1 : 0, redactionApplied: false };
}

async function runDownload(tabId, params) {
  let requestedUrl, allowed, filename, sourceTarget = null;
  try {
    await requireOptionalPermission("downloads", "downloads_permission_required");
    if ((params.url !== undefined) === (params.locator !== undefined)) throw companionError("download_target_invalid", "Provide exactly one URL or an exact media/link locator");
    if (params.locator !== undefined) {
      if (Number.isSafeInteger(params.locator?.frameId) && params.locator.frameId !== 0) throw companionError("download_target_iframe_unsupported", "Resolve a main-frame media target; child-frame download binding is not implemented");
      sourceTarget = await runPageOperation(tabId, "resolveDownloadTarget", { locator: params.locator });
      if (!params.pageInstanceId || sourceTarget.pageInstanceId !== params.pageInstanceId) throw companionError("download_target_document_changed", "The media target is not in the signed current document");
    }
    requestedUrl = requireSafeUrl(sourceTarget?.downloadUrl ?? params.url);
    const requestedOrigin = originOf(requestedUrl);
    allowed = allowedOriginsOf(params.allowedOrigins);
    if (!allowed || !requestedOrigin || !allowed.has(requestedOrigin)) throw companionError("download_origin_not_allowed", "Download URL origin is outside the signed allowlist");
    if (params.filename !== undefined) {
      filename = String(params.filename);
      if (!filename || filename.length > 240 || filename.startsWith("/") || filename.includes("..") || /[\\\0]/u.test(filename)) {
        throw companionError("download_filename_invalid", "Download filename must be a bounded relative path without traversal");
      }
    }
  } catch (error) {
    error.details = { ...(error?.details ?? {}), operationEffectState: "none", mutationDispatchAttempted: false };
    throw error;
  }
  let downloadId = null;
  const earlyChanges = [];
  const unsafeUrl = (value) => {
    if (!value) return false;
    try { return !allowed.has(originOf(requireSafeUrl(value))); } catch { return true; }
  };
  const unsafeDanger = (value) => value !== undefined && value !== null && !new Set(["safe", "accepted"]).has(String(value));
  const cleanupRejectedDownload = async () => {
    try { await chrome.downloads.cancel(downloadId); } catch { /* It may already be terminal. */ }
    for (let index = 0; index < 10; index += 1) {
      const [current] = await chrome.downloads.search({ id: downloadId });
      if (!current || current.state !== "in_progress") break;
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    let removed = false;
    try {
      await chrome.downloads.removeFile(downloadId);
      removed = true;
    } catch { /* A cancelled item may not have materialized a file. */ }
    try { await chrome.downloads.erase({ id: downloadId }); } catch { /* History cleanup is best effort. */ }
    return removed;
  };
  let asynchronousBlocker = null;
  const onChanged = (delta) => {
    if (downloadId === null) { if (earlyChanges.length < 1024) earlyChanges.push(delta); return; }
    if (delta?.id !== downloadId || asynchronousBlocker) return;
    const changedUrl = delta.url?.current ?? delta.finalUrl?.current;
    if (unsafeUrl(changedUrl)) asynchronousBlocker = "download_redirect_origin_not_allowed";
    else if (unsafeDanger(delta.danger?.current)) asynchronousBlocker = "download_dangerous_blocked";
    if (asynchronousBlocker) chrome.downloads.cancel(downloadId).catch(() => {});
  };
  chrome.downloads.onChanged.addListener(onChanged);
  try {
    try {
      downloadId = await chrome.downloads.download({ url: requestedUrl, ...(filename ? { filename } : {}), saveAs: false, conflictAction: "uniquify" });
      if (!Number.isSafeInteger(downloadId) || downloadId < 0) throw new Error("invalid download id");
    } catch {
      throw companionError("download_dispatch_unknown", "Chrome did not return a download id after dispatch; inspect download state and do not replay", { operationEffectState: "unknown", mutationDispatchAttempted: true });
    }
    for (const delta of earlyChanges) onChanged(delta);
    earlyChanges.length = 0;
    const deadline = Date.now() + 30_000;
    while (Date.now() <= deadline) {
      const [item] = await chrome.downloads.search({ id: downloadId });
      const blocker = asynchronousBlocker
        || (unsafeUrl(item?.url) || unsafeUrl(item?.finalUrl) ? "download_redirect_origin_not_allowed" : null)
        || (unsafeDanger(item?.danger) ? "download_dangerous_blocked" : null);
      if (blocker) {
        const removed = await cleanupRejectedDownload();
        throw companionError(
          blocker,
          blocker === "download_dangerous_blocked" ? "Chrome classified the download as unsafe" : "The download redirected outside the signed origin allowlist before completion",
          { downloadId, removed },
        );
      }
      if (item?.state === "complete") {
        return {
          source: "chrome.downloads",
          downloadId,
          state: item.state,
          filename: String(item.filename ?? "").split(/[\\/]/u).at(-1) ?? null,
          filePath: typeof item.filename === "string" ? item.filename : null,
          fileSize: Number.isSafeInteger(item.fileSize) ? item.fileSize : null,
          mimeType: typeof item.mime === "string" ? item.mime : null,
          existsReportedByChrome: typeof item.exists === "boolean" ? item.exists : null,
          bytesReceived: item.bytesReceived ?? null,
          totalBytes: item.totalBytes ?? null,
          danger: item.danger ?? null,
          finalUrl: item.finalUrl ?? requestedUrl,
          ...(sourceTarget ? { sourceTarget: { pageUrl: sourceTarget.url, pageInstanceId: sourceTarget.pageInstanceId, element: sourceTarget.element, resolvedUrl: requestedUrl } } : {}),
          tabId,
        };
      }
      if (item?.state === "interrupted") throw companionError("download_interrupted", "Chrome reported an interrupted download", { downloadId, error: item.error ?? null });
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    throw companionError("download_completion_timeout", "Download did not reach a terminal state in the bounded window", { downloadId });
  } finally {
    earlyChanges.length = 0;
    chrome.downloads.onChanged.removeListener(onChanged);
  }
}

async function withReadOnlyDebugger(tabId, operation) {
  await requireTrustedDebuggerAccess();
  let debuggerLease = null;
  try {
    debuggerLease = await debuggerSessions.acquire(tabId);
    return await operation(debuggerLease.target);
  } catch (error) {
    if (error?.code) throw error;
    throw debuggerError(error);
  } finally {
    if (debuggerLease) await debuggerLease.release();
  }
}

async function debuggerDocumentIdentity(target, framePath = []) {
  if (!Array.isArray(framePath) || framePath.length > 8 || framePath.some(index => !Number.isSafeInteger(index) || index < 0 || index > 99)) {
    throw companionError("page_read_frame_path_invalid", "Use at most eight nonnegative child-frame indices below 100");
  }
  const result = await sendDebuggerCommand(target, "Page.getFrameTree", {});
  let tree = result?.frameTree;
  const root = tree?.frame;
  for (const index of framePath) {
    tree = tree?.childFrames?.[index];
    if (!tree) throw companionError("page_read_frame_unavailable", "The requested child frame is no longer present; read the frame structure again");
  }
  const frame = tree?.frame;
  if (!frame?.id || !frame.loaderId || !/^https?:\/\//u.test(frame.url ?? "")) {
    throw companionError("page_read_document_unavailable", "The exact tab has no committed HTTP document to read");
  }
  return { frameId: frame.id, loaderId: frame.loaderId, url: frame.url, framePath: [...framePath],
    rootFrameId: root.id, rootLoaderId: root.loaderId, topLevelUrl: root.url };
}

async function assertDebuggerDocument(target, before) {
  const after = await debuggerDocumentIdentity(target, before.framePath);
  if (after.frameId !== before.frameId || after.loaderId !== before.loaderId || after.url !== before.url
    || after.rootFrameId !== before.rootFrameId || after.rootLoaderId !== before.rootLoaderId) {
    throw companionError("page_read_target_changed", "The document changed during the read; discard this result and read the exact tab again");
  }
}

async function readNativeAccessibility(tabId, params) {
  const maxNodes = Math.min(Math.max(Number.isInteger(params.maxNodes) ? params.maxNodes : 500, 1), 2_000);
  const depth = Math.min(Math.max(Number.isInteger(params.depth) ? params.depth : 12, 1), 50);
  return withReadOnlyDebugger(tabId, async (target) => {
    const document = await debuggerDocumentIdentity(target, params.framePath);
    const allowedOrigins = new Set(params.allowedOrigins ?? [new URL(document.topLevelUrl).origin]);
    if (!allowedOrigins.has(new URL(document.url).origin)) {
      throw companionError("target_frame_origin_not_allowed", "The selected accessibility frame is outside this operation's allowed origins");
    }
    const result = await sendDebuggerCommand(target, "Accessibility.getFullAXTree", { frameId: document.frameId, depth });
    await assertDebuggerDocument(target, document);
    // Keep the selected document only. Child frames require their own authorized
    // read, and raw value/source objects can contain form values or credentials.
    const allNodes = result?.nodes ?? [];
    const allById = new Map(allNodes.map(node => [String(node.nodeId), node]));
    const editable = node => ["textbox", "searchbox", "spinbutton"].includes(node.role?.value)
      || (node.properties ?? []).some(property => property.name === "editable"
        && [true, "plaintext", "richtext"].includes(property.value?.value));
    const observed = allNodes.filter(node => {
      const visited = new Set();
      for (let current = node; current && !visited.has(current.nodeId); current = allById.get(String(current.parentId))) {
        if (current.frameId && current.frameId !== document.frameId) return false;
        // Chrome may represent an input's current value as a StaticText child
        // of its internal editor. Omitting AXValue alone does not remove it.
        if (current !== node && editable(current)) return false;
        visited.add(current.nodeId);
      }
      return true;
    });
    const rawById = new Map(observed.map(node => [String(node.nodeId), node]));
    const candidates = observed.filter(node => params.includeIgnored === true || !node.ignored);
    const selected = candidates.slice(0, maxNodes);
    const selectedIds = new Set(selected.map(node => String(node.nodeId)));
    let remainingChars = 100_000, textTruncated = false;
    const text = value => {
      const raw = typeof value === "string" || typeof value === "number" ? String(value) : "";
      const output = redactPeripheralText(raw, Math.min(2_000, remainingChars));
      remainingChars -= output.text.length;
      textTruncated ||= output.truncated;
      return output.text;
    };
    const propertyNames = new Set(["busy", "disabled", "editable", "focusable", "focused", "invalid", "level", "multiline", "readonly", "required", "checked", "expanded", "modal", "pressed", "selected", "orientation", "hasPopup"]);
    const nodes = selected.map(node => {
      let parentId = node.parentId == null ? null : String(node.parentId);
      const visited = new Set();
      while (parentId && !selectedIds.has(parentId) && !visited.has(parentId)) {
        visited.add(parentId);
        const parent = rawById.get(parentId);
        parentId = parent?.parentId == null ? null : String(parent.parentId);
      }
      if (!selectedIds.has(parentId)) parentId = null;
      const properties = {};
      for (const property of node.properties ?? []) {
        const value = property.value?.value;
        if (!propertyNames.has(property.name)) continue;
        if (typeof value === "boolean" || typeof value === "number") properties[property.name] = value;
        else if (typeof value === "string") properties[property.name] = text(value);
      }
      return { nodeId: String(node.nodeId), parentId, childIds: [], ignored: node.ignored === true,
        role: text(node.role?.value), name: text(node.name?.value), description: text(node.description?.value), properties,
        ...(Number.isInteger(node.backendDOMNodeId) ? { backendDOMNodeId: node.backendDOMNodeId } : {}) };
    });
    const byId = new Map(nodes.map(node => [node.nodeId, node]));
    for (const node of nodes) if (node.parentId) byId.get(node.parentId)?.childIds.push(node.nodeId);
    const depthTruncated = observed.some(node => (node.childIds ?? []).some(id => !allById.has(String(id))));
    const snapshot = { kind: "native_accessibility_snapshot", source: "chrome_accessibility", scope: document.framePath.length ? "selected_child_frame" : "main_frame", tabId,
      url: document.url, documentLoaderId: document.loaderId, cdpFrameId: document.frameId, framePath: document.framePath,
      depth, maxNodes, includeIgnored: params.includeIgnored === true, nodes, count: nodes.length,
      observedCount: observed.length, ignoredCount: observed.filter(node => node.ignored).length,
      truncated: candidates.length > nodes.length || depthTruncated || textTruncated,
      limits: { nodeLimitReached: candidates.length > nodes.length, depthBoundaryObserved: depthTruncated, textTruncated },
      formValuesIncluded: false, editableDescendantsIncluded: false, redactionApplied: true, capturedAt: new Date().toISOString() };
    return accessibilityHistory.capture(snapshot, { taskId: params.taskId, sessionId: params.sessionId,
      generation: params.generation, tabId }, params.sinceSnapshotId);
  });
}

async function captureDocumentScreenshot(tabId, params = {}) {
  if (params.fullPage === true && params.clip) throw companionError("screenshot_options_invalid", "Choose fullPage or clip, not both");
  return withReadOnlyDebugger(tabId, async (target) => {
    const document = await debuggerDocumentIdentity(target);
    const metrics = await sendDebuggerCommand(target, "Page.getLayoutMetrics", {});
    const content = metrics.cssContentSize;
    if (!content || !Number.isFinite(content.width) || !Number.isFinite(content.height)) {
      throw companionError("screenshot_layout_unavailable", "Chrome did not return CSS document dimensions");
    }
    const layoutSignature = value => JSON.stringify({ content: value.cssContentSize,
      layout: value.cssLayoutViewport, visual: value.cssVisualViewport });
    let measured = null;
    const measure = () => runPageOperation(tabId, "measureScreenshotTarget", { locator: params.elementLocator }, { allowedOrigins: params.allowedOrigins });
    if (params.elementLocator) measured = await measure();
    const requested = measured?.documentRect ?? params.clip ?? { x: Math.max(0, content.x || 0), y: Math.max(0, content.y || 0), width: content.width, height: content.height };
    const clip = Object.fromEntries(["x", "y", "width", "height"].map(key => [key, Number(requested[key])]));
    if (Object.values(clip).some(value => !Number.isFinite(value)) || clip.x < 0 || clip.y < 0 || clip.width <= 0 || clip.height <= 0
      || clip.width > 32_768 || clip.height > 32_768 || clip.width * clip.height > 32_000_000
      || clip.x + clip.width > Math.max(0, content.x || 0) + content.width + 1 || clip.y + clip.height > Math.max(0, content.y || 0) + content.height + 1) {
      throw companionError("screenshot_clip_invalid", "Use a document CSS-pixel region inside the page, at most 32768 pixels per side and 32 million pixels total", { contentSize: content });
    }
    const quality = Math.min(Math.max(Number.isInteger(params.quality) ? params.quality : DEFAULT_SCREENSHOT_QUALITY, MIN_SCREENSHOT_QUALITY), 90);
    const maxBytes = Math.min(Math.max(Number.isInteger(params.maxBytes) ? params.maxBytes : MAX_SCREENSHOT_BYTES, 100_000), 2_000_000);
    const format = params.format === "png" ? "png" : "jpeg";
    let dataBase64 = "", bytes = 0, usedQuality = format === "png" ? null : quality;
    for (const candidate of format === "png" ? [null] : [...new Set([quality, Math.max(MIN_SCREENSHOT_QUALITY, quality - 20), MIN_SCREENSHOT_QUALITY])]) {
      await assertDebuggerDocument(target, document);
      const image = await sendDebuggerCommand(target, "Page.captureScreenshot", { format, ...(format === "jpeg" ? { quality: candidate } : {}),
        clip: { ...clip, scale: 1 }, fromSurface: true, captureBeyondViewport: true });
      dataBase64 = image?.data ?? "";
      if (!dataBase64) throw companionError("screenshot_empty", "Chrome returned an empty document screenshot");
      bytes = Math.floor(dataBase64.length * 3 / 4) - (dataBase64.endsWith("==") ? 2 : dataBase64.endsWith("=") ? 1 : 0);
      usedQuality = candidate;
      if (bytes <= maxBytes) break;
    }
    if (bytes > maxBytes) throw companionError("screenshot_too_large", "The captured region exceeds maxBytes; request a smaller region or a larger byte limit", { bytes, maxBytes });
    if (measured) {
      const after = await measure();
      if (measured.pageInstanceId !== after.pageInstanceId || JSON.stringify(measured.documentRect) !== JSON.stringify(after.documentRect)) {
        throw companionError("screenshot_target_changed", "The element moved or its document changed during capture; read the target again");
      }
    }
    const afterMetrics = await sendDebuggerCommand(target, "Page.getLayoutMetrics", {});
    if (layoutSignature(metrics) !== layoutSignature(afterMetrics)) {
      throw companionError("screenshot_target_changed", "The document or viewport dimensions changed during capture; read the target again");
    }
    await assertDebuggerDocument(target, document);
    return { kind: "screenshot", mimeType: `image/${format}`, dataBase64, bytes, quality: usedQuality, tabId, url: document.url,
      documentLoaderId: document.loaderId, captureMode: measured ? "element_crop" : params.clip ? "document_clip" : "full_page",
      clip: { ...clip, coordinateSpace: "document-css-pixels" }, ...(measured ? { target: measured } : {}),
      foregroundActivated: false, viewportChanged: metrics.cssLayoutViewport && metrics.cssVisualViewport ? false : null,
      restored: true, capturedAt: new Date().toISOString() };
  });
}

async function observeDebuggerEvents(target, domains, waitMs = 500) {
  const entries = [];
  const listener = (source, method, params) => {
    if (source.tabId !== target.tabId || !domains.has(method)) return;
    entries.push({ method, params });
  };
  chrome.debugger.onEvent.addListener(listener);
  try {
    if ([...domains].some((name) => name.startsWith("Page."))) await sendDebuggerCommand(target, "Page.enable", {});
    if ([...domains].some((name) => name.startsWith("Log."))) await sendDebuggerCommand(target, "Log.enable", {});
    if ([...domains].some((name) => name.startsWith("Runtime."))) await sendDebuggerCommand(target, "Runtime.enable", {});
    await new Promise((resolve) => setTimeout(resolve, Math.min(Math.max(waitMs, 50), 1_000)));
    return entries;
  } finally {
    chrome.debugger.onEvent.removeListener(listener);
  }
}

async function inspectJavaScriptDialog(tabId, params) {
  await requireTrustedDebuggerAccess();
  const context = { taskId: params.taskId, sessionId: params.sessionId, generation: params.generation };
  if (params.action === "stop") return javaScriptDialogs.stop(tabId, context);
  const dialog = await javaScriptDialogs.inspect(tabId, context);
  const tab = await chrome.tabs.get(tabId);
  return { ...dialog, tabId, url: tab.url, title: tab.title ?? null, windowId: tab.windowId, frameId: 0 };
}

async function handleJavaScriptDialog(tabId, params) {
  await requireTrustedDebuggerAccess();
  return javaScriptDialogs.handle(tabId, { taskId: params.taskId, sessionId: params.sessionId, generation: params.generation }, params);
}

async function readConsole(tabId) {
  return withReadOnlyDebugger(tabId, async (target) => {
    const events = await observeDebuggerEvents(target, new Set(["Log.entryAdded", "Runtime.consoleAPICalled"]), 750);
    const entries = events.slice(0, 100).map(({ method, params }) => {
      const raw = method === "Log.entryAdded"
        ? params?.entry?.text
        : (params?.args ?? []).map((arg) => arg.value ?? arg.description ?? arg.type).join(" ");
      const redacted = redactPeripheralText(raw, 2_000);
      return { source: method, level: params?.entry?.level ?? params?.type ?? null, text: redacted.text, truncated: redacted.truncated };
    });
    return { entries, count: entries.length, captureWindowMs: 750, historicalReplay: false, redactionApplied: true };
  });
}

async function sendDebuggerCommand(target, method, params) {
  return withTimeout(
    chrome.debugger.sendCommand(target, method, params),
    15_000,
    "visual_input_command_timeout",
    `Timed out while sending bounded ${method}`,
  );
}

async function moveMouse(target, from, to, steps = 8, { buttons = 0 } = {}) {
  const boundedSteps = Math.min(Math.max(Number.isSafeInteger(steps) ? steps : 8, 1), 40);
  for (let index = 1; index <= boundedSteps; index += 1) {
    const ratio = index / boundedSteps;
    await sendDebuggerCommand(target, "Input.dispatchMouseEvent", {
      type: "mouseMoved",
      x: Math.round(from.x + ((to.x - from.x) * ratio)),
      y: Math.round(from.y + ((to.y - from.y) * ratio)),
      button: buttons === 1 ? "left" : "none",
      buttons,
    });
  }
}

function visualButton(value) {
  const button = String(value ?? "left").toLowerCase();
  if (!["left", "right", "middle"].includes(button)) {
    throw companionError("visual_button_not_allowed", "Only left, right, or middle visual buttons are allowed", { button });
  }
  return button;
}

function visualClickCount(value, fallback = 1) {
  const count = Number.isSafeInteger(value) ? value : fallback;
  if (count < 1 || count > 2) throw companionError("visual_click_count_invalid", "Visual click count must be 1 or 2", { count });
  return count;
}

function visualHoldMs(value) {
  const holdMs = Number.isFinite(Number(value)) ? Math.round(Number(value)) : 0;
  if (holdMs < 0 || holdMs > 2_000) throw companionError("visual_hold_invalid", "Visual button hold is limited to 0-2000ms", { holdMs });
  return holdMs;
}

function visualModifiers(value) {
  const values = Array.isArray(value)
    ? value
    : (typeof value === "string" ? value.split(/[+,\s]+/u).filter(Boolean) : []);
  const bits = { alt: 1, ctrl: 2, control: 2, meta: 4, command: 4, cmd: 4, shift: 8 };
  let modifiers = 0;
  const normalized = [];
  for (const entry of values) {
    const key = String(entry).trim().toLowerCase();
    if (!(key in bits)) throw companionError("visual_modifier_not_allowed", "Unsupported visual key modifier", { modifier: entry });
    modifiers |= bits[key];
    normalized.push(key);
  }
  return { bits: modifiers, values: [...new Set(normalized)] };
}

async function trustedVisualKeyMetadata(key, modifiers) {
  const named = {
    Enter: 13, Escape: 27, Tab: 9, Backspace: 8, Delete: 46, Space: 32,
    Home: 36, End: 35, PageUp: 33, PageDown: 34,
    ArrowLeft: 37, ArrowUp: 38, ArrowRight: 39, ArrowDown: 40,
  };
  const letter = /^[a-z]$/iu.test(key);
  const digit = /^[0-9]$/u.test(key);
  const functionKey = /^F(?:[1-9]|1[0-2])$/u.test(key);
  const metadata = {
    key: key === "Space" ? " " : key,
    code: letter ? `Key${key.toUpperCase()}` : digit ? `Digit${key}` : key,
    windowsVirtualKeyCode: letter || digit ? key.toUpperCase().charCodeAt(0) : functionKey ? 111 + Number(key.slice(1)) : named[key],
    modifiers,
  };
  const command = { a: "selectAll", c: "copy", x: "cut", v: "paste" }[key.toLowerCase()];
  if (command && (modifiers === 2 || modifiers === 4)) {
    let platform = "";
    try { platform = String((await chrome.runtime.getPlatformInfo())?.os || ""); }
    catch { platform = String(globalThis.navigator?.userAgentData?.platform || globalThis.navigator?.platform || ""); }
    const shortcut = /mac/iu.test(platform) ? 4 : /win|linux|cros/iu.test(platform) ? 2 : null;
    if (modifiers === shortcut) metadata.commands = [command];
  }
  return metadata;
}

async function dispatchMouseClick(target, point, clickCount, { button = "left", holdMs = 0 } = {}) {
  const normalizedButton = visualButton(button);
  const normalizedCount = visualClickCount(clickCount);
  const normalizedHold = visualHoldMs(holdMs);
  await sendDebuggerCommand(target, "Input.dispatchMouseEvent", { type: "mouseMoved", ...point, button: "none" });
  await sendDebuggerCommand(target, "Input.dispatchMouseEvent", { type: "mousePressed", ...point, button: normalizedButton, buttons: normalizedButton === "left" ? 1 : normalizedButton === "right" ? 2 : 4, clickCount: normalizedCount });
  if (normalizedHold > 0) await new Promise((resolve) => setTimeout(resolve, normalizedHold));
  await sendDebuggerCommand(target, "Input.dispatchMouseEvent", { type: "mouseReleased", ...point, button: normalizedButton, buttons: 0, clickCount: normalizedCount });
  return { button: normalizedButton, clickCount: normalizedCount, holdMs: normalizedHold };
}

const TRUSTED_VISUAL_KEYS = new Set([
  "Enter", "Escape", "Tab", "Backspace", "Delete", "Space", "Home", "End", "PageUp", "PageDown",
  "ArrowUp", "ArrowDown", "ArrowLeft", "ArrowRight",
]);

async function runTrustedVisualInput(tabId, method, params) {
  // A virtual-only move is an in-page preview and intentionally does not
  // require the physical-input opt-in or foreground activation. It is still
  // exact-tab scoped by the broker's signed visual proof.
  if (method === "visual.pointerMove" && params.virtualOnly === true) {
    const point = requireVisualPoint(params.point);
    const visual = await runPageOperation(tabId, "showVisualPoint", {
      point,
      actionLabel: params.actionLabel || "pointer preview",
      companionContext: params.companionContext,
    }, { allowedOrigins: params.allowedOrigins });
    return { ...visual, moved: true, trustedInput: false, virtualOnly: true, osCursorMoved: false, foregroundActivated: false };
  }
  await requireTrustedDebuggerAccess();
  const target = { tabId };
  let debuggerLease = null;
  let previousActiveTabId = null;
  let previousFocusedWindowId = null;
  let targetWindowId = null;
  try {
    // CDP Input is reliable only when Chrome has promoted the exact task tab
    // to the visible foreground. This is also the user-visible contract of
    // the explicitly enabled physical-input lane.
    const taskTab = await chrome.tabs.get(tabId);
    targetWindowId = taskTab.windowId;
    try {
      const [activeTab] = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
      previousActiveTabId = Number.isInteger(activeTab?.id) ? activeTab.id : null;
      previousFocusedWindowId = Number.isInteger(activeTab?.windowId) ? activeTab.windowId : null;
    } catch {
      // Foreground restoration is best effort; exact-tab proof still gates input.
    }
    await withTimeout(
      Promise.all([
        chrome.tabs.update(tabId, { active: true }),
        chrome.windows.update(taskTab.windowId, { focused: true }),
      ]),
      15_000,
      "visual_input_activation_timeout",
      "Timed out while activating the exact task tab for bounded physical input",
    );
    const acquisition = debuggerSessions.acquire(tabId);
    try {
      debuggerLease = await withTimeout(acquisition, 15_000, "visual_input_attach_timeout", "Timed out while attaching bounded visual input to the exact tab");
    } catch (error) {
      // A late successful attach after timeout still belongs to this attempt.
      // Release it without dispatching input or leaking an attachment.
      void acquisition.then(lease => lease.release()).catch(() => {});
      throw error;
    }
    if (method === "visual.typeText" && params.clickBeforeType === false) {
      const guard = params.editorGuard;
      const text = params.text;
      if (params.clear !== false || !guard || typeof text !== "string" || text.length < 1 || text.length > 1_000
        || typeof guard.expectedBody !== "string" || typeof guard.expectedFullBody !== "string"
        || guard.expectedBody.length > 100_000 || guard.expectedFullBody.length > 100_000
        || !Number.isSafeInteger(guard.offset) || guard.offset < 0 || guard.offset > guard.expectedBody.length
        || guard.expectedFullBody !== guard.expectedBody.slice(0, guard.offset) + text + guard.expectedBody.slice(guard.offset)) {
        throw companionError("exact_editor_guard_required", "No-click insertion requires a bounded exact full-body projection and clear:false", { operationEffectState: "none", mutationDispatchAttempted: false });
      }
      const payload = { locator: { css: "div.ProseMirror", frameId: params.frameId ?? 0 },
        expectedBody: guard.expectedBody, offset: guard.offset, requireSelection: true, establishSelection: guard.establishSelection === true };
      if (guard.establishSelection === true) {
        await runPageOperation(tabId, "prepareExactEditor", payload, { allowedOrigins: params.allowedOrigins });
      }
      const before = await runPageOperation(tabId, "verifyExactEditor", payload, { allowedOrigins: params.allowedOrigins });
      if (before.pageInstanceId !== params.pageInstanceId || before.url !== guard.url) {
        throw companionError("exact_editor_target_changed", "Exact editor page identity changed", { operationEffectState: "none", mutationDispatchAttempted: false });
      }
      // One trusted insertion only: no mouse, clipboard, whole-field replace,
      // semantic input fallback or automatic retry after an ambiguous result.
      await sendDebuggerCommand(target, "Input.insertText", { text });
      let after;
      try {
        after = await runPageOperation(tabId, "verifyExactEditor", { ...payload, requireSelection: false,
          expectedBody: guard.expectedFullBody }, { allowedOrigins: params.allowedOrigins });
      } catch (error) {
        throw companionError("exact_editor_input_not_committed", "Trusted insertion full-body readback failed; reconcile this attempt", { operationEffectState: "unknown", mutationDispatchAttempted: true, causeCode: error?.code });
      }
      if (after.pageInstanceId !== before.pageInstanceId || after.url !== before.url) {
        throw companionError("exact_editor_input_target_changed", "Document changed after trusted insertion", { operationEffectState: "unknown", mutationDispatchAttempted: true });
      }
      return { typed: true, valueVerified: true, chars: text.length, trustedInput: true, clickBeforeType: false,
        clipboardUsed: false, fullBodyVerified: true, bodySha256: after.bodySha256, selection: after.selection,
        pageInstanceId: after.pageInstanceId, url: after.url, osCursorMoved: false, foregroundActivated: true };
    }
    const point = requireVisualPoint(params.point);
    // This is deliberately an in-page overlay only. Chrome debugger input
    // events do not move the user's macOS cursor, and the overlay has
    // pointer-events:none so it cannot intercept the page or the user's own
    // mouse. It is visual ownership evidence, not success evidence.
    let virtualCursorShown = false;
    let clickGuardReadback = null;
    try {
      await runPageOperation(tabId, "showVisualPoint", {
        point,
        actionLabel: method.replace(/^visual\./u, ""),
        companionContext: params.companionContext,
      }, { allowedOrigins: params.allowedOrigins });
      virtualCursorShown = true;
    } catch {
      // The input itself remains bounded by the signed proof. A page that
      // cannot render the overlay must not turn a visual action into a blind
      // operation or an OS-level fallback.
    }
    if (method === "visual.click" || method === "visual.doubleClick") {
      const guard = params.visualTargetGuard;
      if (!guard || !["target", "point"].includes(guard.kind)) {
        throw companionError("visual_click_guard_required", "Trusted clicks require broker-verified geometry", {
          operationEffectState: "none", mutationDispatchAttempted: false,
        });
      }
      let current;
      try {
        current = await runPageOperation(tabId, guard.kind === "target" ? "inspectVisualTarget" : "inspectVisualPoint", {
          locator: guard.locator, point, frameId: guard.frameId,
          scroll: false, requireHitOwner: guard.kind === "target",
        }, { allowedOrigins: params.allowedOrigins });
      } catch (error) {
        throw companionError(error?.code ?? "visual_target_proof_stale_geometry", error?.message ?? "The click target cannot be verified after activation", {
          operationEffectState: "none", mutationDispatchAttempted: false,
        });
      }
      const samePoint = Number(current?.point?.x) === Number(guard.point?.x)
        && Number(current?.point?.y) === Number(guard.point?.y);
      // Native debugger attachment can change the content height. For an
      // exact target, identical clipped geometry and hit ownership prove the
      // same click despite a height-only extent change. Explicit point proofs
      // have no target identity, so they retain the full viewport boundary.
      const sameViewport = ["width", "devicePixelRatio"].every(key => Number(current?.viewport?.[key]) === Number(guard.viewport?.[key]))
        && Number(current?.viewport?.scale ?? 1) === Number(guard.viewport?.scale ?? 1)
        && (guard.kind === "target" || Number(current?.viewport?.height) === Number(guard.viewport?.height));
      const sameScroll = !guard.scroll || ["x", "y"].every(key => Number(current?.scroll?.[key]) === Number(guard.scroll?.[key]));
      const sameRect = guard.kind === "point" || ["x", "y", "width", "height"].every(key => Number(current?.clippedRect?.[key]) === Number(guard.rect?.[key]));
      const sameFrame = guard.kind === "point" || (JSON.stringify(current?.framePath ?? []) === JSON.stringify(guard.framePath ?? [])
        && String(current?.coordinateSpace ?? "viewport") === String(guard.coordinateSpace ?? "viewport"));
      const samePage = String(current?.topLevelUrl || current?.url || "") === String(guard.pageUrl || "")
        && (guard.pageInstanceId === null || current?.pageInstanceId === guard.pageInstanceId);
      const targetWithinViewport = guard.kind === "point" || (Number(current?.clippedRect?.x) >= 0 && Number(current?.clippedRect?.y) >= 0
        && Number(current?.clippedRect?.x) + Number(current?.clippedRect?.width) <= Number(current?.viewport?.width)
        && Number(current?.clippedRect?.y) + Number(current?.clippedRect?.height) <= Number(current?.viewport?.height));
      const checks = { supported: current?.supported !== false, samePage, samePoint, sameViewport, sameScroll, sameRect, sameFrame, targetWithinViewport };
      if (Object.values(checks).some(matched => !matched)) {
        throw companionError("visual_target_proof_stale_geometry", "The inspected click target moved or changed after foreground activation", {
          operationEffectState: "none", mutationDispatchAttempted: false,
          mismatches: Object.keys(checks).filter(key => !checks[key]),
          expectedViewport: guard.viewport, observedViewport: current?.viewport,
        });
      }
      clickGuardReadback = { verified: true, kind: guard.kind, expectedViewport: guard.viewport, observedViewport: current.viewport,
        viewportHeightChanged: Number(current.viewport.height) !== Number(guard.viewport.height),
        sameTargetGeometry: guard.kind === "target" && sameRect && samePoint,
        hitOwnerVerified: guard.kind === "target" };
    }
    if (method === "visual.pointerMove") {
      const from = params.from ? requireVisualPoint(params.from, "from") : point;
      await moveMouse(target, from, point, params.steps);
      return { moved: true, point, trustedInput: true, virtualCursorShown, osCursorMoved: false, foregroundActivated: true };
    }
    if (method === "visual.click") {
      const button = visualButton(params.button);
      if (button !== "left" && params.allowSecondaryButton !== true) {
        throw companionError("visual_secondary_button_requires_explicit_opt_in", "Right or middle visual clicks require explicit per-action opt-in");
      }
      const click = await dispatchMouseClick(target, point, params.clickCount ?? 1, { button, holdMs: params.holdMs ?? 0 });
      return { clicked: true, point, ...click, trustedInput: true, virtualCursorShown, clickGuardReadback, osCursorMoved: false, foregroundActivated: true };
    }
    if (method === "visual.doubleClick") {
      const button = visualButton(params.button);
      if (button !== "left" && params.allowSecondaryButton !== true) {
        throw companionError("visual_secondary_button_requires_explicit_opt_in", "Right or middle visual clicks require explicit per-action opt-in");
      }
      const first = await dispatchMouseClick(target, point, 1, { button, holdMs: params.holdMs ?? 0 });
      await dispatchMouseClick(target, point, 2, { button, holdMs: params.holdMs ?? 0 });
      return { doubleClicked: true, point, ...first, trustedInput: true, virtualCursorShown, clickGuardReadback, osCursorMoved: false, foregroundActivated: true };
    }
    if (method === "visual.drag") {
      const to = requireVisualPoint(params.to, "to");
      await sendDebuggerCommand(target, "Input.dispatchMouseEvent", { type: "mouseMoved", ...point, button: "none" });
      await sendDebuggerCommand(target, "Input.dispatchMouseEvent", { type: "mousePressed", ...point, button: "left", buttons: 1, clickCount: 1 });
      await moveMouse(target, point, to, params.steps ?? 12, { buttons: 1 });
      await sendDebuggerCommand(target, "Input.dispatchMouseEvent", { type: "mouseReleased", ...to, button: "left", buttons: 0, clickCount: 1 });
      return { dragged: true, from: point, to, trustedInput: true, virtualCursorShown, osCursorMoved: false, foregroundActivated: true };
    }
    if (method === "visual.scroll") {
      const deltaX = Math.min(Math.max(Math.round(Number(params.deltaX ?? 0)), -3_000), 3_000);
      const deltaY = Math.min(Math.max(Math.round(Number(params.deltaY ?? 0)), -3_000), 3_000);
      if (deltaX === 0 && deltaY === 0) throw companionError("visual_scroll_delta_required", "visual.scroll requires a non-zero bounded delta");
      await sendDebuggerCommand(target, "Input.dispatchMouseEvent", { type: "mouseWheel", ...point, deltaX, deltaY, button: "none" });
      return { scrolled: true, point, deltaX, deltaY, trustedInput: true, virtualCursorShown, osCursorMoved: false, foregroundActivated: true };
    }
    if (method === "visual.pressKey" || method === "visual.keyDown" || method === "visual.keyUp") {
      const key = String(params.key ?? "");
      if (!TRUSTED_VISUAL_KEYS.has(key) && !/^[a-z0-9]$/iu.test(key) && !/^F(?:[1-9]|1[0-2])$/u.test(key)) {
        throw companionError("visual_key_not_allowed", "The requested key is outside the bounded trusted-input key set", { key });
      }
      const modifierState = visualModifiers(params.modifiers);
      const shortcutModifiers = modifierState.values.filter((modifier) => ["alt", "ctrl", "control", "meta", "command", "cmd"].includes(modifier));
      if (shortcutModifiers.length > 0 && params.allowShortcut !== true) {
        throw companionError("visual_modifier_requires_explicit_opt_in", "Alt, Ctrl, or Meta visual key combinations require explicit per-action opt-in", { modifiers: shortcutModifiers });
      }
      if (method === "visual.pressKey" && params.clickBeforeKey !== false) await dispatchMouseClick(target, point, 1);
      const keyMetadata = await trustedVisualKeyMetadata(key, modifierState.bits);
      const keyEventType = method === "visual.keyDown" ? "keyDown" : method === "visual.keyUp" ? "keyUp" : null;
      if (keyEventType) {
        const { commands, ...releaseMetadata } = keyMetadata;
        await sendDebuggerCommand(target, "Input.dispatchKeyEvent", { type: keyEventType, ...(keyEventType === "keyUp" ? releaseMetadata : keyMetadata) });
      } else {
        await sendDebuggerCommand(target, "Input.dispatchKeyEvent", { type: "keyDown", ...keyMetadata });
        const { commands, ...releaseMetadata } = keyMetadata;
        await sendDebuggerCommand(target, "Input.dispatchKeyEvent", { type: "keyUp", ...releaseMetadata });
      }
      return { keyPressed: key, keyEventType: keyEventType ?? "keyDown+keyUp", modifiers: modifierState.values, point, trustedInput: true, virtualCursorShown, osCursorMoved: false, foregroundActivated: true };
    }
    if (method === "visual.typeText") {
      const text = String(params.text ?? "");
      if (!text || text.length > 20_000) {
        throw companionError("visual_type_text_invalid", "Trusted visual text input requires 1 to 20000 characters");
      }
      await dispatchMouseClick(target, point, 1);
      if (params.clear !== false) {
        // The service worker's navigator can report the host platform rather
        // than the Chrome UI platform (notably when the broker is remote).
        // Use the extension-owned platform probe first so Meta+A reliably
        // selects the complete field on macOS; falling back to Ctrl+A on a
        // Mac leaves the old suffix in place and makes the physical readback
        // look like a target/input failure.
        let platform = "";
        try {
          platform = String((await chrome.runtime.getPlatformInfo())?.os || "");
        } catch {
          platform = String(globalThis.navigator?.userAgentData?.platform || globalThis.navigator?.platform || "");
        }
        const isMac = /mac/iu.test(platform);
        const modifiers = isMac ? 4 : 2;
        await sendDebuggerCommand(target, "Input.dispatchKeyEvent", { type: "keyDown", key: "a", code: "KeyA", windowsVirtualKeyCode: 65, modifiers, commands: ["selectAll"] });
        await sendDebuggerCommand(target, "Input.dispatchKeyEvent", { type: "keyUp", key: "a", code: "KeyA", windowsVirtualKeyCode: 65, modifiers });
        const selection = await runPageOperation(tabId, "verifyTypeSelection", { point }, { allowedOrigins: params.allowedOrigins });
        if (selection?.selectedAll !== true) {
          throw companionError("physical_input_selection_failed", "The exact focused field was not fully selected; replacement text was not dispatched", { textDispatchAttempted: false });
        }
      }
      await sendDebuggerCommand(target, "Input.insertText", { text });
      let valueVerified = false;
      if (params.clear !== false) {
        const verification = await runPageOperation(tabId, "verifyTypeValue", { point, expectedText: text }, { allowedOrigins: params.allowedOrigins });
        if (verification?.committed !== true) {
          throw companionError("physical_input_not_committed", "The exact focused field did not retain the requested replacement text", { operationEffectState: "unknown", mutationDispatchAttempted: true });
        }
        valueVerified = true;
      }
      return { typed: true, valueVerified, chars: text.length, point, trustedInput: true, virtualCursorShown, osCursorMoved: false, foregroundActivated: true };
    }
    throw companionError("capability_not_supported", `Unsupported trusted visual input: ${method}`);
  } catch (error) {
    if (error?.code) throw error;
    throw debuggerError(error);
  } finally {
    if (debuggerLease) await debuggerLease.release();
    // Restore the user's previous foreground only when they did not change
    // focus while the bounded action was running. This never moves the OS
    // pointer and avoids stealing a user-selected tab after completion.
    if (previousActiveTabId !== null && previousActiveTabId !== tabId) {
      try {
        const [currentActive] = targetWindowId === null
          ? []
          : await chrome.tabs.query({ active: true, windowId: targetWindowId });
        const lastFocused = await chrome.windows.getLastFocused();
        if (currentActive?.id === tabId && lastFocused?.id === targetWindowId) {
          if (previousFocusedWindowId !== null && previousFocusedWindowId !== targetWindowId) {
            await chrome.windows.update(previousFocusedWindowId, { focused: true });
          }
          await chrome.tabs.update(previousActiveTabId, { active: true });
        }
      } catch {
        // The target or the previous tab may have closed; cleanup is best effort.
      }
    }
  }
}

function sameVisualTargetState(before, after) {
  const samePoint = Number(before?.point?.x) === Number(after?.point?.x)
    && Number(before?.point?.y) === Number(after?.point?.y);
  const sameViewport = Number(before?.viewport?.width) === Number(after?.viewport?.width)
    && Number(before?.viewport?.height) === Number(after?.viewport?.height)
    && Number(before?.viewport?.devicePixelRatio) === Number(after?.viewport?.devicePixelRatio)
    && Number(before?.viewport?.scale ?? 1) === Number(after?.viewport?.scale ?? 1);
  const sameScroll = Number(before?.scroll?.x) === Number(after?.scroll?.x)
    && Number(before?.scroll?.y) === Number(after?.scroll?.y);
  const beforeRect = before?.clippedRect;
  const afterRect = after?.clippedRect;
  const sameRect = ["x", "y", "width", "height"].every((field) => Number(beforeRect?.[field]) === Number(afterRect?.[field]));
  return String(before?.url || "") === String(after?.url || "")
    && before?.pageInstanceId === after?.pageInstanceId
    && samePoint
    && sameViewport
    && sameScroll
    && sameRect;
}

function visualTargetStateDifferences(before, after) {
  const differences = [];
  if (String(before?.url || "") !== String(after?.url || "")) differences.push("url");
  if (before?.pageInstanceId !== after?.pageInstanceId) differences.push("pageInstanceId");
  if (Number(before?.point?.x) !== Number(after?.point?.x) || Number(before?.point?.y) !== Number(after?.point?.y)) differences.push("point");
  if (Number(before?.viewport?.width) !== Number(after?.viewport?.width)
    || Number(before?.viewport?.height) !== Number(after?.viewport?.height)
    || Number(before?.viewport?.devicePixelRatio) !== Number(after?.viewport?.devicePixelRatio)
    || Number(before?.viewport?.scale ?? 1) !== Number(after?.viewport?.scale ?? 1)) differences.push("viewport");
  if (Number(before?.scroll?.x) !== Number(after?.scroll?.x) || Number(before?.scroll?.y) !== Number(after?.scroll?.y)) differences.push("scroll");
  const beforeRect = before?.clippedRect;
  const afterRect = after?.clippedRect;
  if (!["x", "y", "width", "height"].every((field) => Number(beforeRect?.[field]) === Number(afterRect?.[field]))) differences.push("clippedRect");
  return differences;
}

async function runTypeWithVerifiedPhysicalFallback(tabId, payload, params) {
  if (!payload.locator || typeof payload.locator !== "object" || Array.isArray(payload.locator)) {
    throw companionError("physical_fallback_semantic_locator_required", "Automatic physical input fallback requires one exact semantic locator");
  }
  if (payload.clear === false) {
    throw companionError("physical_fallback_requires_replace_mode", "Automatic physical input fallback is limited to clear-and-replace field input");
  }
  let beforeTarget;
  let visualPreflight;
  let topTab;
  try {
    topTab = await assertLiveOrigin(tabId, params);
    beforeTarget = await runPageOperation(
      tabId,
      "inspectVisualTarget",
      { locator: payload.locator, scroll: true },
      { allowedOrigins: params.allowedOrigins },
    );
    visualPreflight = await captureExactTabScreenshot(tabId, { restoreActive: true });
  } catch (error) {
    throw companionError(
      error?.code ?? "physical_fallback_preflight_failed",
      error?.message ?? "Physical input visual preflight failed before semantic input dispatch",
      {
        ...(error?.details && typeof error.details === "object" ? error.details : {}),
        operationEffectState: "none",
        mutationDispatchAttempted: false,
      },
    );
  }
  if (visualPreflight.tabId !== tabId || String(visualPreflight.url || "") !== String(topTab?.url || "")) {
    throw companionError(
      "physical_fallback_visual_semantic_mismatch",
      "The semantic input target and screenshot did not identify the same exact page",
      { operationEffectState: "none", mutationDispatchAttempted: false },
    );
  }
  const semantic = await runPageOperation(
    tabId,
    "type",
    { ...payload, verifyCommit: true },
    { allowedOrigins: params.allowedOrigins },
  );
  await assertLiveOrigin(tabId, params);
  if (semantic?.semanticCommitted === true) {
    return {
      ...semantic,
      inputStrategy: "semantic",
      physicalFallbackAttempted: false,
      visualPreflight: {
        captured: true,
        tabId,
        url: visualPreflight.url ?? null,
        bytes: visualPreflight.bytes,
        capturedAt: visualPreflight.capturedAt,
      },
    };
  }
  if (semantic?.semanticNoEffectVerified !== true) {
    throw companionError(
      "semantic_input_effect_ambiguous",
      "Semantic input did not commit the requested value, but the field no longer matches its original state",
      { operationEffectState: "unknown", mutationDispatchAttempted: true },
    );
  }
  if (Number.isSafeInteger(payload.locator.frameId) && payload.locator.frameId !== 0) {
    throw companionError(
      "physical_fallback_iframe_coordinate_space_unsupported",
      "Semantic input had verified no effect inside an iframe, but whole-tab physical coordinates cannot be inferred safely from frame-local geometry",
      { operationEffectState: "none", mutationDispatchAttempted: true, semanticNoEffectVerified: true },
    );
  }
  // Chrome may recompute a background tab's visual viewport/layout after the
  // semantic no-effect readback.  The next step is an explicitly authorized
  // trusted physical-input action, so promote this exact tab before taking
  // the final geometry proof. The strict identity/geometry comparison below
  // remains unchanged; this only prevents background-layout churn from being
  // mistaken for a user/page target replacement.
  const physicalTab = await chrome.tabs.get(tabId);
  if (Number.isSafeInteger(physicalTab.windowId)) {
    await Promise.all([
      chrome.tabs.update(tabId, { active: true }),
      chrome.windows.update(physicalTab.windowId, { focused: true }),
    ]);
  }
  const afterSemanticTarget = await runPageOperation(
    tabId,
    "inspectVisualTarget",
    { locator: payload.locator, scroll: false },
    { allowedOrigins: params.allowedOrigins },
  );
  if (!sameVisualTargetState(beforeTarget, afterSemanticTarget)) {
    throw companionError(
      "physical_fallback_target_changed",
      "The exact semantic and visual input target changed before physical fallback",
      {
        operationEffectState: "unknown",
        mutationDispatchAttempted: true,
        nextAction: `fresh_visual_target_readback_required:${visualTargetStateDifferences(beforeTarget, afterSemanticTarget).join(",") || "unclassified"}`,
      },
    );
  }
  const physical = await runTrustedVisualInput(tabId, "visual.typeText", {
    point: afterSemanticTarget.point,
    text: payload.text,
    clear: true,
    allowedOrigins: params.allowedOrigins,
    companionContext: payload.companionContext,
  });
  await assertLiveOrigin(tabId, params);
  const verification = await runPageOperation(
    tabId,
    "verifyTypeValue",
    { locator: payload.locator, expectedText: payload.text },
    { allowedOrigins: params.allowedOrigins },
  );
  if (verification?.committed !== true) {
    throw companionError(
      "physical_input_not_committed",
      "The screenshot-bound physical input did not retain the requested field value",
      { operationEffectState: "unknown", mutationDispatchAttempted: true },
    );
  }
  return {
    typed: true,
    visualized: true,
    trustedInput: true,
    inputStrategy: "physical_fallback",
    fallbackReason: "semantic_input_no_effect_verified",
    semanticCommitted: false,
    semanticNoEffectVerified: true,
    physicalFallbackAttempted: true,
    valueLength: verification.valueLength,
    element: verification.element,
    visualPreflight: {
      captured: true,
      tabId,
      url: visualPreflight.url ?? null,
      bytes: visualPreflight.bytes,
      capturedAt: visualPreflight.capturedAt,
    },
    physical: { trustedInput: physical.trustedInput === true, chars: physical.chars },
  };
}

async function executeCommand(method, params) {
  const companionContext = { taskId: params.taskId, taskLabel: params.taskLabel };
  switch (method) {
    case "extension.reload": {
      if (runtimeState.reloadScheduled) {
        throw companionError("extension_reload_already_scheduled", "An Extension reload is already scheduled for this profile");
      }
      const reason = typeof params.reason === "string" && params.reason.trim().length > 0
        ? params.reason.trim().slice(0, 240)
        : "companion_authorized_reload";
      const expectedBuildId = typeof params.expectedBuildId === "string" && params.expectedBuildId.trim().length > 0
        ? params.expectedBuildId.trim().slice(0, 128)
        : null;
      if (expectedBuildId && expectedBuildId !== INSTALL_BUILD_ID) {
        throw companionError(
          "extension_build_id_mismatch",
          "The requested reload build does not match this loaded Companion Extension",
          { expectedBuildId, loadedBuildId: INSTALL_BUILD_ID },
        );
      }
      runtimeState.reloadScheduled = true;
      runtimeState.reloadRequestedAt = new Date().toISOString();
      runtimeState.reloadReason = reason;
      const accepted = {
        accepted: true,
        scheduled: true,
        delayMs: EXTENSION_RELOAD_DELAY_MS,
        requestedAt: runtimeState.reloadRequestedAt,
        reason,
        expectedBuildId,
        buildId: INSTALL_BUILD_ID,
        generation: runtimeState.generation,
      };
      setTimeout(() => {
        void (async () => {
          try {
            await rotateExtensionRuntimeId();
            // chrome.runtime.reload() is the privileged equivalent of pressing
            // the Developer Mode "Reload" button for this unpacked Extension.
            // It does not move the user's OS cursor or touch any page tab.
            chrome.runtime.reload();
          } catch (error) {
            runtimeState.reloadScheduled = false;
            runtimeState.lastError = error instanceof Error ? error.message : String(error);
            requestReconnect({ force: true });
          }
        })();
      }, EXTENSION_RELOAD_DELAY_MS);
      return accepted;
    }
    case "tabs.list":
      return (await withTimeout(
        chrome.tabs.query({}),
        READ_API_TIMEOUT_MS,
        "tabs_query_timeout",
        "Chrome did not return the tab inventory within the bounded read window",
      )).slice(0, MAX_TAB_LIST_ENTRIES).map(sanitizeTab);
    case "recording.status":
      return companionTabRecordingStatus(params);
    case "recording.startAuto":
      return startCompanionTabRecording({ ...params, userGesture: true });
    case "recording.stopAuto":
      return stopCompanionTabRecording(params);
    case "tabs.get":
      return sanitizeTab(await chrome.tabs.get(requireTabId(params.tabId)));
    case "tabs.navigationDiagnostics":
      return exactNavigationDiagnostics(await withTimeout(chrome.tabs.get(requireTabId(params.tabId)), READ_API_TIMEOUT_MS,
        "tabs_query_timeout", "Exact tab navigation diagnostics exceeded its read deadline"), params);
    case "tabs.stopLoading":
      return stopExactNavigation({ tabs: chrome.tabs, pool: debuggerSessions, sendCommand: sendDebuggerCommand,
        requirePermission: requireTrustedDebuggerAccess, params,
        onCleanup: outcome => postNativeMessage({ kind: "extension.event", event: "debugger.cleanup",
          operationId: params.operationId, taskId: params.taskId, sessionId: params.sessionId,
          profileInstanceId: params.profileInstanceId, generation: params.generation, tabId: params.tabId,
          status: outcome.status, reason: outcome.reason }, { port: params.replyPort }) });
    case "tabs.waitForCommit": {
      const tab = await chrome.tabs.get(requireTabId(params.tabId));
      if (tab.url !== params.expectedUrl) throw companionError("document_target_changed", "Commit wait requires the exact previously observed URL");
      const timeoutMs = Math.min(15_000, Math.max(100, Number(params.timeoutMs) || 5_000));
      const committed = await waitForCommittedTab(tab.id, { expectedWindowId: tab.windowId, allowedOrigins: [tab.url], timeoutMs });
      if (committed.url !== params.expectedUrl) throw companionError("document_target_changed", "Commit wait observed another exact URL");
      return { ...sanitizeTab(committed), committed: true, readOnly: true, timeoutMs };
    }
    case "browser.searchLibrary":
      return searchBrowserLibrary(chrome, params, userControls.state().blockedOrigins);
    case "browser.listWindows":
      return (await chrome.windows.getAll({ populate: true, windowTypes: ["normal"] })).map(window => ({
        id: window.id, focused: window.focused, state: window.state, type: window.type,
        left: window.left, top: window.top, width: window.width, height: window.height,
        // Keep window choice deterministic for multi-window workflows without
        // exposing page contents.  Callers can use the exact tab IDs in the
        // bounded inventory for a subsequent owner-scoped lease.
        activeTabId: window.tabs?.find(tab => tab.active)?.id ?? null,
        tabCount: Array.isArray(window.tabs) ? window.tabs.length : 0,
        tabs: (window.tabs ?? []).slice(0, MAX_TAB_LIST_ENTRIES).map(sanitizeTab),
      }));
    case "tabs.configure":
      await assertLiveOrigin(requireTabId(params.tabId), params);
      return configureTaskTab(chrome, params);
    case "page.configureViewport":
      await assertLiveOrigin(requireTabId(params.tabId), params);
      if (params.action !== "restore") await requireTrustedDebuggerAccess();
      return viewportControls.configure(params.tabId, { taskId: params.taskId, sessionId: params.sessionId,
        generation: params.generation, pageInstanceId: params.pageInstanceId }, params);
    case "page.bookmark":
      await assertLiveOrigin(requireTabId(params.tabId), params);
      return bookmarkTaskPage(chrome, params);
    case "tabs.create": {
      const requestedUrl = requireSafeUrl(params.url ?? "about:blank");
      let phaseStartedAt = performance.now();
      const finishPhase = name => {
        const finishedAt = performance.now();
        if (params.executionTiming) params.executionTiming[name] = finishedAt - phaseStartedAt;
        phaseStartedAt = finishedAt;
      };
      const tab = await chrome.tabs.create({
        url: requestedUrl,
        active: params.active === true,
      });
      finishPhase("tab_create");
      if (params.mutation && Number.isSafeInteger(tab.id)) {
        postNativeMessage({
          kind: "extension.event",
          event: "task.tab.created",
          operationId: params.operationId,
          profileInstanceId: runtimeState.profileInstanceId,
          tabId: tab.id,
        }, { port: params.replyPort });
      }
      try {
        const committed = requestedUrl === "about:blank"
          ? tab
          : await waitForCommittedTab(tab.id, { requestedUrl, expectedWindowId: tab.windowId, allowedOrigins: params.allowedOrigins });
        finishPhase("navigation_commit");
        if (params.mutation && requestedUrl !== "about:blank") await assertLiveOrigin(committed.id, params);
        finishPhase("origin_check");
        const groupId = params.mutation
          ? await ensureTaskGroup(committed, { taskId: params.taskId, taskLabel: params.taskLabel })
          : committed.groupId;
        finishPhase("task_group");
        const result = { ...sanitizeTab(await chrome.tabs.get(committed.id)), groupId };
        finishPhase("tab_readback");
        return result;
      } catch (error) {
        error.details = { ...(error?.details ?? {}), createdTabId: tab.id, requestedUrl };
        throw error;
      }
    }
    case "tabs.close":
      await assertLiveOrigin(requireTabId(params.tabId), params);
      return closeTabAndVerify(requireTabId(params.tabId));
    case "tabs.activate": {
      await assertLiveOrigin(requireTabId(params.tabId), params);
      const tab = await chrome.tabs.update(requireTabId(params.tabId), { active: true });
      await chrome.windows.update(tab.windowId, { focused: true });
      const activated = await chrome.tabs.get(tab.id);
      await assertLiveOrigin(activated.id, params);
      return sanitizeTab(activated);
    }
    case "tabs.navigate": {
      await assertLiveOrigin(requireTabId(params.tabId), params);
      const requestedUrl = requireSafeUrl(params.url);
      const requestedOrigin = originOf(requestedUrl);
      const allowed = allowedOriginsOf(params.allowedOrigins);
      if (params.mutation && (!allowed || !allowed.has(requestedOrigin))) throw companionError("target_origin_not_allowed", "Navigation target origin is not allowlisted");
      const before = await chrome.tabs.get(requireTabId(params.tabId));
      const previousUrl = requireSafeUrl(before.url);
      const previousBase = new URL(previousUrl), requestedBase = new URL(requestedUrl);
      previousBase.hash = requestedBase.hash = "";
      // Bind fragment intent before dispatch; an observed URL change cannot grant this exception.
      const fragmentRequestedUrl = previousUrl !== requestedUrl && previousBase.href === requestedBase.href ? requestedUrl : null;
      const deadline = Date.now() + DEFAULT_NAVIGATION_TIMEOUT_MS;
      const previousDocument = await probeCommittedDocument(before.id, { expectedWindowId: before.windowId, expectedUrl: before.url, allowedOrigins: params.allowedOrigins, deadline });
      const tab = await withTimeout(chrome.tabs.update(requireTabId(params.tabId), {
        url: requestedUrl,
      }), Math.max(1, deadline - Date.now()), "navigation_commit_timeout", "Timed out waiting for navigation commit");
      const committed = await waitForCommittedTab(tab.id, { requestedUrl, previousUrl, previousDocumentId: previousDocument.documentId, fragmentRequestedUrl,
        expectedWindowId: before.windowId, allowedOrigins: params.allowedOrigins, deadline });
      if (params.mutation) await assertLiveOrigin(committed.id, params);
      return sanitizeTab(committed);
    }
    case "tabs.back": {
      const tabId = requireTabId(params.tabId);
      const before = await assertLiveOrigin(tabId, params);
      try {
        await chrome.tabs.goBack(tabId);
      } catch (error) {
        if (/Cannot find a (?:previous|next) page in history/iu.test(String(error?.message ?? error))) {
          await runPageOperation(tabId, "historyNavigate", { direction: "back" });
        } else {
          throw error;
        }
      }
      const settled = await waitForTabSettled(tabId, { previousUrl: before.url, requireTransition: true });
      await assertLiveOrigin(tabId, params);
      return { ...sanitizeTab(settled), historyAction: "back" };
    }
    case "tabs.forward": {
      const tabId = requireTabId(params.tabId);
      const before = await assertLiveOrigin(tabId, params);
      try {
        await chrome.tabs.goForward(tabId);
      } catch (error) {
        if (/Cannot find a (?:previous|next) page in history/iu.test(String(error?.message ?? error))) {
          await runPageOperation(tabId, "historyNavigate", { direction: "forward" });
        } else {
          throw error;
        }
      }
      const settled = await waitForTabSettled(tabId, { previousUrl: before.url, requireTransition: true });
      await assertLiveOrigin(tabId, params);
      return { ...sanitizeTab(settled), historyAction: "forward" };
    }
    case "tabs.reload": {
      const tabId = requireTabId(params.tabId);
      const before = await assertLiveOrigin(tabId, params);
      await chrome.tabs.reload(tabId, { bypassCache: params.bypassCache === true });
      const settled = await waitForTabSettled(tabId, { previousUrl: before.url });
      await assertLiveOrigin(tabId, params);
      return { ...sanitizeTab(settled), historyAction: "reload", bypassCache: params.bypassCache === true };
    }
    case "tabs.groupTask": {
      const tabId = requireTabId(params.tabId);
      const tab = await assertLiveOrigin(tabId, params);
      const collapsed = params.collapsed === true;
      const groupId = await ensureTaskGroup(tab, {
        taskId: params.taskId,
        taskLabel: params.taskLabel,
        collapsed,
      });
      return { ...sanitizeTab(await chrome.tabs.get(tabId)), groupId, grouped: true, collapsed };
    }
    case "page.snapshot": {
      const tabId = requireTabId(params.tabId);
      return readRenderedInForeground(tabId, () => runPageOperation(tabId, "snapshot", {
        maxTextChars: Math.min(Math.max(params.maxTextChars ?? 30_000, 1_000), 100_000),
      }));
    }
    case "page.screenshot":
      return params.fullPage === true || params.clip
        ? captureDocumentScreenshot(requireTabId(params.tabId), params)
        : captureExactTabScreenshot(requireTabId(params.tabId), params);
    case "page.accessibilitySnapshot":
      return readNativeAccessibility(requireTabId(params.tabId), params);
    case "page.inspectDropdown":
      return runPageOperation(requireTabId(params.tabId), "inspectDropdown", {
        locator: params.locator,
      }, { allowedOrigins: params.allowedOrigins });
    case "visual.inspectTarget":
      return runPageOperation(requireTabId(params.tabId), "inspectVisualTarget", {
        locator: params.locator,
        scroll: params.scroll !== false,
      }, { allowedOrigins: params.allowedOrigins });
    case "visual.inspectPoint":
      return runPageOperation(requireTabId(params.tabId), "inspectVisualPoint", {
        point: params.point,
      }, { allowedOrigins: params.allowedOrigins });
    case "visual.pointerMove":
    case "visual.click":
    case "visual.doubleClick":
    case "visual.drag":
    case "visual.scroll":
    case "visual.pressKey":
    case "visual.keyDown":
    case "visual.keyUp":
    case "visual.typeText":
      await assertLiveOrigin(requireTabId(params.tabId), params);
      return runTrustedVisualInput(requireTabId(params.tabId), method, { ...params, companionContext });
    case "page.query":
      return runPageOperation(requireTabId(params.tabId), "query", {
        frameId: params.frameId,
        query: String(params.query ?? ""),
        locator: params.locator,
        attributes: params.attributes,
        exactEditor: params.exactEditor === true,
        splitBinding: params.splitBinding === true,
        maxEditorChars: params.maxEditorChars,
        offset: params.offset,
        includeHidden: params.includeHidden === true,
        limit: Math.min(Math.max(Number(params.limit ?? 25), 1), 100),
      }, { allowedOrigins: params.allowedOrigins });
    case "page.assets":
      return runPageOperation(requireTabId(params.tabId), "assets", params, { allowedOrigins: params.allowedOrigins });
    case "page.exportContent": {
      const tabId = requireTabId(params.tabId);
      const exportContent = () => runPageOperation(tabId, "exportContent", {
        format: params.format === "html" ? "html" : "text",
        maxChars: Math.min(Math.max(Number(params.maxChars ?? 50_000), 1_000), 100_000),
      });
      return params.format === "html" ? exportContent() : readRenderedInForeground(tabId, exportContent);
    }
    case "page.exportArtifact":
      return runPageOperation(requireTabId(params.tabId), "exportArtifact", {
        format: params.format === "html" ? "html" : "text",
        maxChars: Math.min(Math.max(Number(params.maxChars ?? 50_000), 1_000), 100_000),
        artifactName: params.artifactName,
      });
    case "page.webMcpDiscover":
      return runPageOperation(requireTabId(params.tabId), "webMcpDiscover", {});
    case "page.webMcpCall":
      await assertLiveOrigin(requireTabId(params.tabId), params);
      return runPageOperation(requireTabId(params.tabId), "webMcpCall", {
        toolName: params.toolName,
        arguments: params.arguments ?? {},
        approved: params.approved === true,
        allowedToolNames: params.allowedToolNames,
        maxResultBytes: params.maxResultBytes,
      }, { allowedOrigins: params.allowedOrigins });
    case "page.inspectCaptcha":
      return runPageOperation(requireTabId(params.tabId), "inspectCaptcha", {});
    case "page.domDiff":
      return runPageOperation(requireTabId(params.tabId), "domDiff", { previous: params.previous ?? null, maxItems: params.maxItems });
    case "page.readNetwork":
      return runPageOperation(requireTabId(params.tabId), "readNetwork", { maxEntries: params.maxEntries, includeInitiator: params.includeInitiator === true });
    case "page.observe":
      await assertLiveOrigin(requireTabId(params.tabId), params);
      await requireTrustedDebuggerAccess();
      return pageObservations.control(params.tabId, { taskId: params.taskId, sessionId: params.sessionId, generation: params.generation }, params);
    case "page.elementScreenshot": {
      if (params.mode !== "viewport") return captureDocumentScreenshot(requireTabId(params.tabId), { ...params, elementLocator: params.locator });
      await assertLiveOrigin(requireTabId(params.tabId), params);
      const target = await runPageOperation(requireTabId(params.tabId), "inspectVisualTarget", { locator: params.locator, scroll: params.scroll !== false }, { allowedOrigins: params.allowedOrigins });
      const screenshot = await captureExactTabScreenshot(requireTabId(params.tabId), { quality: params.quality, maxBytes: params.maxBytes, restoreActive: true });
      return { kind: "element_screenshot", target, screenshot, elementScreenshotMode: "full_viewport_with_target_geometry", exact_blocker: null };
    }
    case "page.download":
      await assertLiveOrigin(requireTabId(params.tabId), params);
      return runDownload(requireTabId(params.tabId), params);
    case "clipboard.readBinary":
      await assertLiveOrigin(requireTabId(params.tabId), params);
      return runBinaryClipboardOperation(params);
    case "clipboard.read":
    case "clipboard.receipt":
    case "clipboard.write":
      await assertLiveOrigin(requireTabId(params.tabId), params);
      return runClipboardOperation(method, params);
    case "page.inspectDialog":
      await assertLiveOrigin(requireTabId(params.tabId), params);
      return inspectJavaScriptDialog(requireTabId(params.tabId), params);
    case "page.handleDialog":
      await assertLiveOrigin(requireTabId(params.tabId), params);
      return handleJavaScriptDialog(requireTabId(params.tabId), params);
    case "page.readConsole":
      await assertLiveOrigin(requireTabId(params.tabId), params);
      return readConsole(requireTabId(params.tabId));
    case "page.click":
      await assertLiveOrigin(requireTabId(params.tabId), params);
      return runAndCheckMutation(requireTabId(params.tabId), "click", { locator: params.locator, companionContext }, params);
    case "page.doubleClick":
      await assertLiveOrigin(requireTabId(params.tabId), params);
      return runAndCheckMutation(requireTabId(params.tabId), "doubleClick", { locator: params.locator, companionContext }, params);
    case "page.hover":
      await assertLiveOrigin(requireTabId(params.tabId), params);
      return runAndCheckMutation(requireTabId(params.tabId), "hover", { locator: params.locator, companionContext }, params);
    case "page.setChecked":
      await assertLiveOrigin(requireTabId(params.tabId), params);
      return runAndCheckMutation(requireTabId(params.tabId), "setChecked", {
        locator: params.locator,
        checked: params.checked !== false,
        companionContext,
      }, params);
    case "page.pressKey":
      await assertLiveOrigin(requireTabId(params.tabId), params);
      return runAndCheckMutation(requireTabId(params.tabId), "pressKey", {
        locator: params.locator,
        key: String(params.key ?? ""),
        companionContext,
      }, params);
    case "page.selectText":
      await assertLiveOrigin(requireTabId(params.tabId), params);
      return runAndCheckMutation(requireTabId(params.tabId), "selectText", {
        locator: params.locator,
        text: String(params.text ?? ""),
        occurrence: params.occurrence,
        prefix: params.prefix,
        suffix: params.suffix,
        companionContext,
      }, params);
    case "page.richText":
      await assertLiveOrigin(requireTabId(params.tabId), params);
      return runAndCheckMutation(requireTabId(params.tabId), "richText", {
        locator: params.locator,
        operation: params.operation,
        blockTag: params.blockTag,
        text: params.text,
        occurrence: params.occurrence,
        expectedBody: params.expectedBody,
        expectedFullBody: params.expectedFullBody,
        expectedSelection: params.expectedSelection,
        expectedCaret: params.expectedCaret,
        expectedEditorHtml: params.expectedEditorHtml,
        companionContext,
      }, params);
    case "page.scroll":
      await assertLiveOrigin(requireTabId(params.tabId), params);
      return runAndCheckMutation(requireTabId(params.tabId), "scroll", {
        locator: params.locator,
        direction: String(params.direction ?? "down"),
        amount: params.amount,
        companionContext,
      }, params);
    case "page.selectOption": {
      const tabId = requireTabId(params.tabId);
      await assertLiveOrigin(tabId, params);
      const inspection = await runPageOperation(tabId, "inspectDropdown", { locator: params.locator }, { allowedOrigins: params.allowedOrigins });
      const payload = {
        locator: params.locator,
        option: params.option,
        exact: params.exact !== false,
        timeoutMs: Math.min(Math.max(params.timeoutMs ?? 5_000, 250), 15_000),
        companionContext,
      };
      if (!inspection.supported || inspection.controlKind === "native_select") {
        return runAndCheckMutation(tabId, "selectOption", payload, params);
      }
      return runVisibleDropdownSelection(tabId, payload, params);
    }
    case "page.type":
      await assertLiveOrigin(requireTabId(params.tabId), params);
      if (params.physicalFallback === "on_verified_no_effect") {
        return runTypeWithVerifiedPhysicalFallback(requireTabId(params.tabId), {
          locator: params.locator,
          text: String(params.text ?? ""),
          clear: params.clear !== false,
          clearExplicit: params.clear === true,
          companionContext,
        }, params);
      }
      if (params.physicalFallback !== undefined && params.physicalFallback !== "disabled") {
        throw companionError("physical_fallback_policy_invalid", "page.type physicalFallback must be disabled or on_verified_no_effect");
      }
      return runAndCheckMutation(requireTabId(params.tabId), "type", {
        locator: params.locator,
        text: String(params.text ?? ""),
        clear: params.clear !== false,
        clearExplicit: params.clear === true,
        companionContext,
      }, params);
    case "page.upload":
      await assertLiveOrigin(requireTabId(params.tabId), params);
      // Sites such as Etsy reject videos rebuilt from bytes inside the page;
      // hand Chrome the validated file path like its own file chooser does.
      if (String(params.file?.mimeType ?? "").startsWith("video/") && typeof params.file?.filePath === "string") {
        return runNativeFileUpload(requireTabId(params.tabId), { locator: params.locator, file: params.file, companionContext }, params);
      }
      return runAndCheckMutation(requireTabId(params.tabId), "upload", {
        locator: params.locator,
        file: params.file,
        companionContext,
      }, params);
    case "page.uploadMultiple":
      await assertLiveOrigin(requireTabId(params.tabId), params);
      return runAndCheckMutation(requireTabId(params.tabId), "uploadMultiple", {
        locator: params.locator,
        files: params.files,
        companionContext,
      }, params);
    case "page.nativeChooser":
      throw companionError("native_file_chooser_user_required", "This page exposes only a native file chooser; the user must choose the file in Chrome", {
        operationEffectState: "none",
        mutationDispatchAttempted: false,
        user_action_required: true,
      });
    case "tabs.claimExisting":
      throw companionError("existing_tab_claim_requires_user_approval", "Existing user or foreign tabs can only be claimed through the broker's one-time signed approval", {
        operationEffectState: "none",
        mutationDispatchAttempted: false,
        user_action_required: true,
      });
    case "page.submit":
      await assertLiveOrigin(requireTabId(params.tabId), params);
      return runAndCheckMutation(requireTabId(params.tabId), "submit", { locator: params.locator, companionContext }, params);
    case "page.waitFor":
      return waitForPageLocator(requireTabId(params.tabId), params);
    case "page.delay":
      return runPageOperation(requireTabId(params.tabId), "delay", {
        milliseconds: Math.min(Math.max(Number(params.milliseconds ?? 250), 0), 10_000),
      });
    default:
      throw companionError("capability_not_supported", `Unsupported command: ${method}`);
  }
}

async function waitForPageLocator(tabId, params) {
  const timeoutMs = Math.min(Math.max(Number(params.timeoutMs ?? 5_000), 100), 15_000);
  const condition = ["attached", "detached", "visible", "hidden"].includes(params.condition) ? params.condition : "visible";
  const deadline = Date.now() + timeoutMs;
  // Poll in the extension worker. Background page timers can be throttled
  // after the target already appeared. Always perform the final fresh probe.
  while (true) {
    const result = await runPageOperation(tabId, "waitFor", { locator: params.locator, condition }, { allowedOrigins: params.allowedOrigins });
    if (result?.found === true) return { ...result, condition };
    const remaining = deadline - Date.now();
    if (remaining <= 0) throw companionError("page_wait_timeout", "Timed out waiting for the semantic locator", { timeoutMs, lastRead: result });
    await new Promise(resolve => setTimeout(resolve, Math.min(100, remaining)));
  }
}

// Sites that draw their content from animation frames (X, Etsy, TikTok) stay blank in a
// background tab: Chrome pauses rendering there, and runs gave up on "a white page" (owner,
// 2026-10-17). When a read of a background tab finds almost no text, bring that tab to the front
// of its window, wait up to 5 seconds for it to draw, read again, and give the window back the tab
// that was in front, unless the user switched tabs meanwhile.
const BLANK_PAGE_TEXT_CHARS = 200;
const readText = result => String(result?.text ?? result?.content ?? "").trim();
async function readRenderedInForeground(tabId, read) {
  const first = await read();
  if (readText(first).length >= BLANK_PAGE_TEXT_CHARS) return first;
  let target;
  try { target = await chrome.tabs.get(tabId); } catch { return first; }
  if (target.active || target.discarded) return first;
  const previous = (await chrome.tabs.query({ windowId: target.windowId, active: true }))[0]?.id;
  let interrupted = false;
  const activated = info => { if (info.windowId === target.windowId && info.tabId !== tabId) interrupted = true; };
  chrome.tabs.onActivated.addListener(activated);
  let result = first;
  try {
    await chrome.tabs.update(tabId, { active: true });
    for (let waited = 0; waited < 5_000; waited += 500) {
      await new Promise(resolve => setTimeout(resolve, 500));
      result = await read();
      if (readText(result).length >= BLANK_PAGE_TEXT_CHARS) break;
    }
    return { ...result, renderedInForeground: true };
  } finally {
    chrome.tabs.onActivated.removeListener(activated);
    if (!interrupted && Number.isSafeInteger(previous) && previous !== tabId) {
      try {
        const active = await chrome.tabs.query({ windowId: target.windowId, active: true });
        if (active[0]?.id === tabId) await chrome.tabs.update(previous, { active: true });
      } catch { /* The previous tab may have closed. */ }
    }
  }
}

// Custom virtual lists render from real scroll events, which Chrome defers
// in hidden tabs. Keep this exact tab visible for one selection attempt.
async function runVisibleDropdownSelection(tabId, payload, params) {
  const target = await chrome.tabs.get(tabId);
  const previous = (await chrome.tabs.query({ windowId: target.windowId, active: true }))[0]?.id;
  let interrupted = false;
  const activated = info => { if (info.windowId === target.windowId && info.tabId !== tabId) interrupted = true; };
  const updated = (id, info) => { if (id === tabId && (info.status === "loading" || (info.url && info.url !== target.url))) interrupted = true; };
  chrome.tabs.onActivated.addListener(activated);
  chrome.tabs.onUpdated.addListener(updated);
  try {
    if (previous !== tabId) await chrome.tabs.update(tabId, { active: true });
    const [current, active] = await Promise.all([
      chrome.tabs.get(tabId), chrome.tabs.query({ windowId: target.windowId, active: true }),
    ]);
    if (interrupted || active[0]?.id !== tabId || current.windowId !== target.windowId || current.url !== target.url || current.status === "loading") {
      throw companionError("dropdown_selection_target_changed", "The exact dropdown tab changed before selection", {
        operationEffectState: "none", mutationDispatchAttempted: false,
      });
    }
    await assertLiveOrigin(tabId, params);
    return await runAndCheckMutation(tabId, "selectOption", { ...payload, requireVisible: true }, params);
  } finally {
    chrome.tabs.onActivated.removeListener(activated);
    chrome.tabs.onUpdated.removeListener(updated);
    // Preserve a user's intervening choice, including switch-away-and-back.
    if (!interrupted && previous !== tabId && Number.isSafeInteger(previous)) {
      try {
        const active = await chrome.tabs.query({ windowId: target.windowId, active: true });
        if (active[0]?.id === tabId) await chrome.tabs.update(previous, { active: true });
      } catch { /* The previous tab may have closed. */ }
    }
  }
}

async function runAndCheckMutation(tabId, action, payload, params) {
  const startedAt = Date.now();
  if (["click", "submit"].includes(action) && params.semanticGuardId) payload = { ...payload, semanticGuardId: params.semanticGuardId };
  const result = await runPageOperation(tabId, action, payload, { allowedOrigins: params.allowedOrigins });
  const pageReturnedAt = Date.now();
  await assertLiveOrigin(tabId, params);
  const originReturnedAt = Date.now();
  if (action === "upload" || action === "uploadMultiple") {
    // Controlled upload widgets may clear or replace their file input after
    // consuming change. Wait in the worker (page timers can be throttled),
    // then inspect the same locator without assigning or dispatching again.
    await new Promise(resolve => setTimeout(resolve, 250));
    let readback;
    try {
      readback = await runPageOperation(tabId, "verifyUpload", {
        locator: payload.locator,
        expectedFiles: result.expectedFiles,
      }, { allowedOrigins: params.allowedOrigins });
      await assertLiveOrigin(tabId, params);
      if (result.pageInstanceId && readback.pageInstanceId && result.pageInstanceId !== readback.pageInstanceId) {
        throw companionError("upload_document_changed", "The document changed after file delivery; reconcile the existing attempt");
      }
    } catch (error) {
      error.details = { ...(error.details ?? {}), operationEffectState: "unknown", mutationDispatchAttempted: true,
        fileInputAssignmentVerified: result.fileInputAssignmentVerified === true,
        nextAction: "inspect_existing_attachment_state_without_reupload" };
      throw error;
    }
    const retained = readback.retained === true;
    const canConfirmReset = params.allowInputReset === true && result.fileInputAssignmentVerified === true
      && ["cleared", "replaced"].includes(readback.state);
    if (!retained && !canConfirmReset) {
      throw companionError("upload_file_readback_failed", "The file input changed after delivery; inspect the site's attachment state without uploading again", {
        operationEffectState: "unknown", mutationDispatchAttempted: true,
        fileInputAssignmentVerified: result.fileInputAssignmentVerified === true,
        expected: result.expectedFiles, actual: readback.files ?? [], controlState: readback.state,
        nextAction: "inspect_existing_attachment_state_without_reupload",
      });
    }
    result.uploaded = retained;
    result.uploadReadbackVerified = retained;
    result.uploadReadbackMethod = retained ? "file_input" : "site_confirmation_pending";
    result.requiresSiteConfirmation = !retained;
    result.readback = { ...result.readback, ...readback };
    if (readback.element) result.element = readback.element;
    if (retained && readback.files?.length === 1) {
      const file = readback.files[0];
      result.readback.file = { name: file.name, mimeType: file.type, size: file.size };
    }
    result.uploadTiming = {
      ...result.uploadTiming,
      pageInjectionMs: pageReturnedAt - startedAt,
      originReadbackMs: originReturnedAt - pageReturnedAt,
      settledReadbackMs: Date.now() - originReturnedAt,
    };
  }
  if (action === "type" && result?.semanticCommitted === false) {
    throw companionError("semantic_input_not_committed", "The field did not retain the requested text", { operationEffectState: "unknown", mutationDispatchAttempted: true, valueLength: result.valueLength, expectedValueLength: result.expectedValueLength });
  }
  return result;
}

async function runNativeFileUpload(tabId, payload, params) {
  const startedAt = Date.now();
  const file = payload.file;
  if (Number.isSafeInteger(payload.locator?.frameId) && payload.locator.frameId !== 0) {
    throw companionError("native_upload_frame_unsupported", "Native video upload supports only the top frame", { operationEffectState: "none", mutationDispatchAttempted: false });
  }
  if (!file?.filePath?.startsWith("/") || typeof file.name !== "string" || !Number.isSafeInteger(file.size)) {
    throw companionError("upload_payload_invalid", "Validated native upload payload is missing", { operationEffectState: "none", mutationDispatchAttempted: false });
  }
  const nonce = crypto.randomUUID();
  const options = { allowedOrigins: params.allowedOrigins };
  const marked = await runPageOperation(tabId, "markUploadTarget", { locator: payload.locator, nonce, companionContext: payload.companionContext }, options);
  await assertLiveOrigin(tabId, params);
  const expectedFiles = [{ name: file.name, size: file.size, type: file.mimeType }];
  let dispatched = false;
  try {
    await withReadOnlyDebugger(tabId, async (target) => {
      const documentNode = await sendDebuggerCommand(target, "DOM.getDocument", { depth: 0 });
      const match = await sendDebuggerCommand(target, "DOM.querySelector", {
        nodeId: documentNode.root.nodeId,
        selector: `input[type=file][data-aos-upload-target="${nonce}"]`,
      });
      if (!match?.nodeId) throw companionError("native_upload_target_missing", "The marked file input was not found", { operationEffectState: "none", mutationDispatchAttempted: false });
      dispatched = true;
      await sendDebuggerCommand(target, "DOM.setFileInputFiles", { files: [file.filePath], nodeId: match.nodeId });
    });
  } catch (error) {
    if (dispatched) error.details = { ...(error.details ?? {}), operationEffectState: "unknown", mutationDispatchAttempted: true,
      nextAction: "inspect_existing_attachment_state_without_reupload" };
    throw error;
  } finally {
    await runPageOperation(tabId, "unmarkUploadTarget", { nonce }, options).catch(() => {});
  }
  const dispatchedAt = Date.now();
  await new Promise(resolve => setTimeout(resolve, 250));
  let readback = null;
  try {
    readback = await runPageOperation(tabId, "verifyUpload", { locator: payload.locator, expectedFiles }, options);
  } catch {
    readback = null;
  }
  const retained = readback?.retained === true;
  return {
    uploaded: retained,
    count: 1,
    visualized: true,
    nativeFileInput: true,
    fileInputAssignmentVerified: true,
    expectedFiles,
    uploadReadbackVerified: retained,
    uploadReadbackMethod: retained ? "file_input" : "site_confirmation_pending",
    requiresSiteConfirmation: !retained,
    uploadTiming: { pageInjectionMs: dispatchedAt - startedAt, settledReadbackMs: Date.now() - dispatchedAt },
    element: readback?.element ?? marked.element,
    file: { name: file.name, mimeType: file.mimeType, size: file.size, sha256: file.sha256 },
    files: expectedFiles,
    readback: readback ?? { files: [], inputFileCount: 0 },
    url: marked.url,
    pageInstanceId: marked.pageInstanceId,
  };
}

async function runPageOperation(tabId, action, payload, { allowedOrigins } = {}) {
  const mutationTimeoutMs = action === "upload" || action === "uploadMultiple"
    ? 45_000 : PAGE_MUTATION_EXECUTION_TIMEOUT_MS;
  const requestedFrameId = Number.isSafeInteger(payload?.locator?.frameId)
    ? payload.locator.frameId
    : Number.isSafeInteger(payload?.frameId)
      ? payload.frameId
      : null;
  const target = action === "snapshot"
    ? { tabId, allFrames: true }
    : requestedFrameId == null
      ? { tabId }
      : { tabId, frameIds: [requestedFrameId] };
  const executionResults = READ_ONLY_PAGE_ACTIONS.has(action)
    ? await executePageScriptWithReadRetry(target, action, payload)
    : await withTimeout(
      chrome.scripting.executeScript({
        target,
        world: "ISOLATED",
        func: injectedPageOperation,
        args: [action, payload],
      }),
      mutationTimeoutMs,
      "page_mutation_execution_timeout",
      "Chrome did not return the semantic mutation result within the bounded window",
    ).catch((error) => {
      if (error?.code === "page_mutation_execution_timeout") {
        error.details = {
          operationEffectState: "unknown",
          mutationDispatchAttempted: true,
          timeoutMs: mutationTimeoutMs,
        };
      }
      throw error;
    });
  const results = bindInjectionDocumentIdentity(executionResults);
  if (!results.length) {
    throw companionError(
      requestedFrameId == null ? "page_execution_empty" : "target_frame_unavailable",
      requestedFrameId == null ? "Chrome returned no page execution result" : `Chrome returned no result for frame ${requestedFrameId}`,
    );
  }
  if (action === "snapshot") {
    const merged = mergeSemanticSnapshotResults(results, payload.maxTextChars);
    if (!merged) throw companionError("page_execution_empty", "Chrome returned no semantic frame result");
    return merged;
  }
  const frameResult = results[0];
  if (requestedFrameId != null && frameResult.frameId !== requestedFrameId) {
    throw companionError("target_frame_mismatch", "Chrome executed the operation in a different frame than requested", {
      requestedFrameId,
      actualFrameId: frameResult.frameId,
    });
  }
  const result = frameResult.result;
  if (result?.__aosCompanionError) {
    throw companionError(
      result.__aosCompanionError.code || "extension_operation_failed",
      result.__aosCompanionError.message || "Page operation failed",
      result.__aosCompanionError.details,
    );
  }
  if (requestedFrameId != null && Array.isArray(allowedOrigins) && allowedOrigins.length > 0) {
    let frameCheck = checkFrameOrigin({ frameId: requestedFrameId, result, allowedOrigins });
    // Chrome can briefly omit the top-level result URL while the renderer is
    // settling. Only frame 0 may use the live tab URL as a fallback, and the
    // fallback remains constrained by the signed allowlist.
    if (frameCheck.needsTabUrl && requestedFrameId === 0) {
      const liveTab = await chrome.tabs.get(tabId);
      frameCheck = checkFrameOrigin({ frameId: requestedFrameId, result, tabUrl: liveTab?.url, allowedOrigins });
    }
    if (!frameCheck.allowed) {
      throw companionError("target_frame_origin_not_allowed", "The requested frame origin is outside the authorized origin set", {
        frameId: requestedFrameId,
        frameOrigin: frameCheck.origin,
        originSource: frameCheck.source,
        allowedOrigins: frameCheck.allowedOrigins,
      });
    }
  }
  return result && typeof result === "object"
    ? { ...result, frameId: frameResult.frameId }
    : result;
}

async function injectedPageOperation(action, payload) {
  let uploadMutationAttempted = false;
  let richTextMutationAttempted = false;
  let richTextObservedChange = false;
  let selectionMutationAttempted = false;
  let selectionObservedChange = false;
  // Return errors explicitly across chrome.scripting serialization. A thrown
  // page error must not become an empty result and a misleading page mismatch.
  try {
  const pageInstanceId = globalThis.__aosCompanionPageInstanceIdV1
    || (globalThis.__aosCompanionPageInstanceIdV1 = `${Date.now()}-${crypto.randomUUID()}`);
  const normalize = (value) => String(value ?? "").replace(/\s+/g, " ").trim();
  const lower = (value) => normalize(value).toLocaleLowerCase();
  if (action === "historyNavigate") {
    const direction = payload.direction === "forward" ? "forward" : "back";
    const entries = typeof globalThis.navigation?.entries === "function"
      ? globalThis.navigation.entries()
      : [];
    const currentKey = globalThis.navigation?.currentEntry?.key;
    const currentIndex = entries.findIndex((entry) => entry.key === currentKey);
    const historyLength = Number(globalThis.history?.length ?? 0);
    const canNavigate = currentIndex >= 0
      ? (direction === "back" ? currentIndex > 0 : currentIndex < entries.length - 1)
      : (direction === "back" && historyLength > 1);
    if (!canNavigate) {
      return {
        __aosCompanionError: {
          code: "history_entry_unavailable",
          message: `The exact tab has no ${direction === "back" ? "previous" : "next"} history entry`,
          details: {
            operationEffectState: "none",
            mutationDispatchAttempted: false,
            direction,
          },
        },
      };
    }
    setTimeout(() => globalThis.history[direction](), 0);
    return { historyRequested: true, direction, entryCount: entries.length || historyLength, currentIndex };
  }
  // chrome.scripting serializes only this function into the isolated page
  // world. Keep export redaction self-contained instead of referencing a
  // service-worker helper that does not exist in that execution context.
  const redactExportText = (value, maxChars) => {
    const text = String(value ?? "")
      .replace(/\bBearer\s+[A-Za-z0-9._~+\/-]{12,}\b/giu, "Bearer <redacted>")
      .replace(/\bBasic\s+[A-Za-z0-9+/=]{12,}\b/giu, "Basic <redacted>")
      .replace(/\b(?:api[_-]?key|access[_-]?token|refresh[_-]?token|client[_-]?secret|authorization|proxy[_-]?authorization|cookie|set-cookie|session(?:id|token)?|secret|password|private[_-]?key)\s*[:=]\s*[^\s,;]{4,}/giu, "$1=<redacted>")
      .replace(/\b(?:sk|gh[opusr]|xox[baprs])[-_][A-Za-z0-9_-]{12,}\b/gu, "<redacted-token>")
      .replace(/-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/gu, "<redacted-private-key>")
      .replace(/\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\b/gu, "<redacted-jwt>");
    return { text: text.slice(0, maxChars), truncated: text.length > maxChars };
  };
  const semanticRootHosts = new WeakMap();
  const semanticRoots = (() => {
    const roots = [document];
    const seen = new Set(roots);
    let scanned = 0;
    for (let index = 0; index < roots.length && roots.length < 100 && scanned < 10_000; index += 1) {
      const root = roots[index];
      for (const element of root.querySelectorAll("*")) {
        scanned += 1;
        if (element.shadowRoot && !seen.has(element.shadowRoot)) {
          seen.add(element.shadowRoot);
          semanticRootHosts.set(element.shadowRoot, element);
          roots.push(element.shadowRoot);
        }
        if (scanned >= 10_000) break;
      }
    }
    return roots;
  })();
  const refreshSemanticRoots = () => {
    const seen = new Set(semanticRoots);
    let scanned = 0;
    for (let index = 0; index < semanticRoots.length && semanticRoots.length < 100 && scanned < 10_000; index += 1) {
      for (const element of semanticRoots[index].querySelectorAll("*")) {
        scanned += 1;
        if (element.shadowRoot && !seen.has(element.shadowRoot)) {
          seen.add(element.shadowRoot);
          semanticRootHosts.set(element.shadowRoot, element);
          semanticRoots.push(element.shadowRoot);
        }
        if (scanned >= 10_000) break;
      }
    }
  };
  const querySemantic = (selector, limit = 5_000) => {
    refreshSemanticRoots();
    const output = [];
    const seen = new Set();
    for (const root of semanticRoots) {
      for (const element of root.querySelectorAll(selector)) {
        if (seen.has(element)) continue;
        seen.add(element);
        output.push(element);
        if (output.length >= limit) return output;
      }
    }
    return output;
  };
  const visible = (element) => {
    const style = getComputedStyle(element);
    const rect = element.getBoundingClientRect();
    return style.display !== "none" && style.visibility !== "hidden" && rect.width > 0 && rect.height > 0;
  };
  const implicitRole = (element) => {
    const tag = element.tagName.toLowerCase();
    if (tag === "button") return "button";
    if (tag === "a" && element.hasAttribute("href")) return "link";
    if (tag === "textarea") return "textbox";
    if (/^h[1-6]$/u.test(tag)) return "heading";
    if (tag === "img") return "img";
    if (tag === "ul" || tag === "ol") return "list";
    if (tag === "li") return "listitem";
    if (tag === "table") return "table";
    if (tag === "tr") return "row";
    if (tag === "td") return "cell";
    if (tag === "th") return element.getAttribute("scope") === "row" ? "rowheader" : "columnheader";
    if (tag === "select") return "combobox";
    if (tag === "input") {
      const type = (element.getAttribute("type") ?? "text").toLowerCase();
      if (new Set(["button", "submit", "reset"]).has(type)) return "button";
      if (type === "checkbox") return "checkbox";
      if (type === "radio") return "radio";
      return "textbox";
    }
    return "";
  };
  const labelText = (element) => {
    if (element.labels?.length) {
      return normalize([...element.labels].map((label) => label.innerText).join(" "));
    }
    const id = element.getAttribute("id");
    if (id) {
      const escaped = globalThis.CSS?.escape ? CSS.escape(id) : id.replace(/["\\]/g, "\\$&");
      const label = element.getRootNode()?.querySelector?.(`label[for="${escaped}"]`) ?? document.querySelector(`label[for="${escaped}"]`);
      if (label) return normalize(label.innerText);
    }
    return "";
  };
  const referencedText = (element, attribute) => normalize(
    String(element.getAttribute(attribute) ?? "")
      .split(/\s+/u)
      .filter(Boolean)
      .map((id) => {
        const escaped = globalThis.CSS?.escape ? CSS.escape(id) : id.replace(/["\\]/g, "\\$&");
        return element.getRootNode()?.querySelector?.(`#${escaped}`)?.textContent
          ?? document.getElementById(id)?.textContent
          ?? "";
      })
      .join(" "),
  );
  const accessibleName = (element) => normalize(
    element.getAttribute("aria-label")
      || referencedText(element, "aria-labelledby")
      || (element.tagName?.toLowerCase() === "img" ? element.getAttribute("alt") : "")
      || element.getAttribute("title")
      || labelText(element)
      || element.innerText
      || (element instanceof HTMLInputElement && !["button", "submit", "reset"].includes(element.type) ? "" : element.getAttribute("value"))
      || element.getAttribute("placeholder"),
  );
  const parentSemanticNode = (node) => {
    if (!node) return null;
    if (node.parentElement) return node.parentElement;
    const root = node.getRootNode?.();
    return root && root !== document ? root.host ?? null : null;
  };
  const ancestorNodes = (element, limit = 20) => {
    const nodes = [];
    let current = parentSemanticNode(element);
    while (current && nodes.length < limit) {
      nodes.push(current);
      current = parentSemanticNode(current);
    }
    return nodes;
  };
  const semanticContext = (element, expected) => {
    const needle = lower(expected);
    if (!needle) return null;
    let current = element;
    let best = null;
    for (let depth = 0; current && depth < 7; depth += 1, current = current.parentElement) {
      const text = normalize(current.innerText || current.textContent);
      if (!text || !lower(text).includes(needle)) continue;
      if (!best || text.length < best.text.length) best = { element: current, text, depth };
    }
    return best;
  };
  const controlState = (element) => {
    if (element instanceof HTMLInputElement) {
      const type = (element.type || "text").toLowerCase();
      if (type === "checkbox" || type === "radio") return { checked: element.checked };
      if (type === "file") return { fileCount: element.files?.length ?? 0, fileNames: [...(element.files ?? [])].slice(0, 5).map((file) => file.name) };
      return { valuePresent: element.value.length > 0, valueLength: element.value.length };
    }
    if (element instanceof HTMLTextAreaElement) return { valuePresent: element.value.length > 0, valueLength: element.value.length };
    if (element instanceof HTMLSelectElement) return {
      valuePresent: element.value.length > 0,
      selectedText: normalize(element.selectedOptions?.[0]?.textContent).slice(0, 300),
      multiple: element.multiple,
    };
    if (lower(element.getAttribute("role")) === "combobox") {
      const current = normalize(element.value || element.innerText || element.textContent);
      return {
        valuePresent: current.length > 0 && lower(current) !== "select...",
        selectedText: current.slice(0, 300),
        expanded: element.getAttribute("aria-expanded") === "true",
        controlsId: element.getAttribute("aria-controls") || element.getAttribute("aria-owns") || null,
      };
    }
    if (element.isContentEditable) {
      const content = normalize(element.textContent);
      return { valuePresent: content.length > 0, valueLength: content.length };
    }
    return {};
  };
  const elementState = (element) => ({
    disabled: Boolean(element.disabled || element.getAttribute("aria-disabled") === "true"),
    expanded: element.getAttribute("aria-expanded") === "true"
      ? true
      : element.getAttribute("aria-expanded") === "false" ? false : null,
    selected: element.getAttribute("aria-selected") === "true"
      || element.getAttribute("aria-checked") === "true"
      || element.getAttribute("aria-pressed") === "true"
      || element.matches?.(":checked") === true,
    current: element.getAttribute("aria-current") || null,
    focused: document.activeElement === element,
  });
  const describe = (element) => {
    const rect = element.getBoundingClientRect?.();
    const state = { ...elementState(element), ...controlState(element) };
    return {
    tag: element.tagName.toLowerCase(),
    role: element.getAttribute("role") || implicitRole(element),
    name: accessibleName(element).slice(0, 300),
    testId: element.getAttribute("data-testid") || null,
    controlType: element instanceof HTMLInputElement || element instanceof HTMLButtonElement
      ? String(element.type || "").toLowerCase() || null
      : null,
    visible: visible(element),
    focused: state.focused,
    rect: rect ? { x: rect.x, y: rect.y, width: rect.width, height: rect.height } : null,
    state,
    ...state,
    };
  };
  const matchesState = (element, requested) => {
    if (!requested || typeof requested !== "object" || Array.isArray(requested)) return true;
    const actual = { ...elementState(element), ...controlState(element) };
    return Object.entries(requested).every(([key, expected]) => {
      if (key === "value") {
        const value = String(element.value ?? element.textContent ?? "");
        return String(value) === String(expected);
      }
      if (!(key in actual)) return false;
      return actual[key] === expected;
    });
  };
  const matchesSimpleLocator = (element, locator) => {
    if (!locator || typeof locator !== "object" || Array.isArray(locator)) return false;
    const textMatches = (actual, expected) => locator.exact === true
      ? normalize(actual) === normalize(expected) : lower(actual).includes(lower(expected));
    if (locator.css) {
      try { if (!element.matches(locator.css)) return false; }
      catch { throw operationError("semantic_selector_invalid", "The CSS selector is invalid"); }
    }
    if (locator.role && lower(element.getAttribute("role") || implicitRole(element)) !== lower(locator.role)) return false;
    if (locator.testId && element.getAttribute("data-testid") !== String(locator.testId)) return false;
    const expectedName = locator.name ?? locator.text;
    if (expectedName && !textMatches(accessibleName(element), expectedName)) return false;
    if (locator.nameRegex && !matchesRegex(accessibleName(element), locator.nameRegex)) return false;
    if (locator.textRegex && !matchesRegex(element.innerText || element.textContent, locator.textRegex)) return false;
    const content = lower(element.innerText || element.textContent);
    if (locator.hasText !== undefined && !content.includes(lower(locator.hasText))) return false;
    if (locator.hasNotText !== undefined && content.includes(lower(locator.hasNotText))) return false;
    for (const [field, attribute] of [["placeholder", "placeholder"], ["title", "title"]]) {
      if (locator[field] && !textMatches(element.getAttribute(attribute), locator[field])) return false;
    }
    if (locator.value !== undefined && locator.value !== null) {
      const actual = String(element.value ?? element.getAttribute("value") ?? "");
      if (lower(actual) !== lower(locator.value)) return false;
    }
    // A label names this control. Broad question/container context belongs
    // to locator.question; applying it here matches unrelated sibling fields.
    if (locator.label && !textMatches(accessibleName(element), locator.label)) return false;
    if (locator.question && !semanticContext(element, locator.question)) return false;
    return matchesState(element, locator.state);
  };
  const matchesLocator = (element, locator, isNested = false) => {
    if (isNested && [locator?.nth, locator?.last, locator?.ordinal].some(value => value !== undefined)) {
      throw operationError("semantic_locator_index_invalid", "Put nth, last, or ordinal on the outer locator after filtering");
    }
    if (!matchesSimpleLocator(element, locator)) return false;
    if (Array.isArray(locator.allOf) && !locator.allOf.every((part) => matchesLocator(element, part, true))) return false;
    if (Array.isArray(locator.anyOf) && locator.anyOf.length > 0 && !locator.anyOf.some((part) => matchesLocator(element, part, true))) return false;
    if (locator.ancestor && !ancestorNodes(element).some((ancestor) => matchesLocator(ancestor, locator.ancestor, true))) return false;
    if (locator.within && !ancestorNodes(element).some((ancestor) => matchesLocator(ancestor, locator.within, true))) return false;
    for (const field of ["has", "hasNot"]) {
      if (!locator[field]) continue;
      const selector = locator[field].css || "*";
      if (!relationPool.has(selector)) {
        try { relationPool.set(selector, querySemantic(selector)); }
        catch { throw operationError("semantic_selector_invalid", "The descendant CSS selector is invalid"); }
      }
      const found = relationPool.get(selector).some(candidate => ancestorNodes(candidate).includes(element) && matchesLocator(candidate, locator[field], true));
      if (field === "has" ? !found : found) return false;
    }
    return true;
  };
  const regexCache = new Map();
  const relationPool = new Map();
  const matchesRegex = (value, specification) => {
    if (typeof specification?.pattern !== "string" || !specification.pattern || specification.pattern.length > 250
      || typeof (specification.flags ?? "iu") !== "string" || !/^[imu]*$/u.test(specification.flags ?? "iu")) {
      throw operationError("semantic_regex_invalid", "Use a regular expression of 1-250 characters with i, m, or u flags");
    }
    const key = JSON.stringify(specification);
    if (!regexCache.has(key)) {
      try { regexCache.set(key, new RegExp(specification.pattern, specification.flags ?? "iu")); }
      catch { throw operationError("semantic_regex_invalid", "The regular expression is invalid"); }
    }
    return regexCache.get(key).test(String(value ?? ""));
  };
  const validateLocatorTree = (locator, nested = false, depth = 0) => {
    if (!locator || typeof locator !== "object" || Array.isArray(locator) || depth > 8)
      throw operationError("semantic_locator_index_invalid", "Provide one locator object with at most 8 nested filter levels");
    const positions = ["nth", "ordinal", "last"].filter(key => locator[key] !== undefined);
    if (positions.length > 1 || nested && positions.length)
      throw operationError("semantic_locator_index_invalid", "Use only one of nth, ordinal, or last on the outer locator after filtering");
    for (const [key, max] of [["nth", 4999], ["ordinal", 99]]) if (locator[key] !== undefined
      && (!Number.isSafeInteger(locator[key]) || locator[key] < 0 || locator[key] > max))
      throw operationError("semantic_locator_index_invalid", `${key} must be an integer from 0 to ${max}`);
    if (locator.last !== undefined && locator.last !== true) throw operationError("semantic_locator_index_invalid", "last must be true or omitted");
    for (const key of ["has", "hasNot", "ancestor", "within"]) if (locator[key] !== undefined) validateLocatorTree(locator[key], true, depth + 1);
    for (const key of ["allOf", "anyOf"]) if (locator[key] !== undefined) {
      if (!Array.isArray(locator[key]) || !locator[key].length || locator[key].length > 8) throw operationError("semantic_locator_index_invalid", `${key} requires 1 to 8 locator filters`);
      for (const part of locator[key]) validateLocatorTree(part, true, depth + 1);
    }
  };
  const locateAll = (locator, { allowHiddenFile = false, fileInputOnly = false, includeHidden = false, scanLimit = 5_000 } = {}) => {
    validateLocatorTree(locator);
    if (!locator || typeof locator !== "object") {
      throw new Error("locator must be an object");
    }
    let candidates;
    if (typeof locator.css === "string" && locator.css.length > 0) {
      if (locator.css.length > 1_000) throw operationError("semantic_selector_invalid", "CSS selector exceeds 1000 characters");
      try { candidates = querySemantic(locator.css, scanLimit); }
      catch { throw operationError("semantic_selector_invalid", "The CSS selector is invalid"); }
    } else if (typeof locator.testId === "string" && locator.testId.length > 0) {
      const escaped = globalThis.CSS?.escape
        ? CSS.escape(locator.testId)
        : locator.testId.replace(/["\\]/g, "\\$&");
      candidates = querySemantic(`[data-testid="${escaped}"]`, scanLimit);
    } else if (locator.allOf?.length || locator.anyOf?.length) {
      // Compound CSS locators can target non-interactive elements such as
      // article/div; restricting their pool to controls loses valid matches.
      candidates = querySemantic("*", scanLimit);
    } else {
      candidates = querySemantic("button,a[href],input,textarea,select,label,h1,h2,h3,h4,h5,h6,p,li,img,ul,ol,table,tr,td,th,[role],[contenteditable='true']", scanLimit);
    }
    const scanLimitReached = candidates.length >= scanLimit;
    if (fileInputOnly) candidates = candidates.filter(element => element instanceof HTMLInputElement && element.type === "file");
    candidates = candidates.filter((element) => includeHidden || visible(element)
      || (allowHiddenFile && element instanceof HTMLInputElement && element.type === "file"));
    candidates = candidates.filter((element) => matchesLocator(element, locator));
    const expectedName = locator.name ?? locator.text;
    if (expectedName && locator.exact === undefined) {
      const exact = candidates.filter((element) => lower(accessibleName(element)) === lower(expectedName));
      if (exact.length > 0) candidates = exact;
    }
    if (locator.question) {
      const contextual = candidates
        .map((element) => ({ element, context: semanticContext(element, locator.question) }))
        .filter((entry) => entry.context)
        .sort((left, right) => left.context.text.length - right.context.text.length || left.context.depth - right.context.depth);
      if (contextual.length > 0) candidates = contextual.filter((entry) => entry.context.text.length === contextual[0].context.text.length).map((entry) => entry.element);
    }
    const positions = [locator.ordinal, locator.nth, locator.last].filter(value => value !== undefined);
    if (positions.length > 1) throw operationError("semantic_locator_index_invalid", "Use only one of ordinal, nth, or last");
    const index = locator.last === true ? candidates.length - 1 : (locator.nth ?? locator.ordinal);
    if (index !== undefined) {
      if (!Number.isInteger(index) || index < 0 || index >= candidates.length) {
        throw operationError("semantic_locator_index_invalid", `Locator index ${index} is outside ${candidates.length} matches`);
      }
      candidates = [candidates[index]];
    }
    return { candidates, scanLimitReached };
  };
  const find = (locator, options = {}) => {
    const { candidates, scanLimitReached } = locateAll(locator, options);
    if (scanLimitReached) throw operationError("semantic_locator_scan_limit", "The candidate scan reached its limit; narrow the outer CSS selector or testId before targeting one element", { nextAction: "refine_outer_css_or_test_id_then_read_again" });
    if (candidates.length === 0) throw operationError("semantic_locator_not_found", "No visible element matched the semantic locator", { nextAction: "query_current_page_then_refine_locator" });
    if (candidates.length > 1) throw operationError("semantic_locator_ambiguous", `Semantic locator matched ${candidates.length} visible elements`, { candidates: candidates.slice(0, 10).map(describe), nextAction: "refine_locator_role_name_label_then_read_again" });
    return candidates[0];
  };
  const visualize = (element, actionLabel) => {
    const hostId = "__aos_companion_cursor__";
    document.getElementById(hostId)?.remove();
    const host = document.createElement("div");
    host.id = hostId;
    host.style.cssText = "all:initial;position:fixed;inset:0;z-index:2147483647;pointer-events:none";
    const root = host.attachShadow({ mode: "closed" });
    const rect = element.getBoundingClientRect();
    const x = Math.max(12, Math.min(innerWidth - 12, rect.left + rect.width / 2));
    const y = Math.max(12, Math.min(innerHeight - 12, rect.top + rect.height / 2));
    const prior = window.__aosCompanionVisualCursorPosition
      && Number.isFinite(window.__aosCompanionVisualCursorPosition.x)
      && Number.isFinite(window.__aosCompanionVisualCursorPosition.y)
      ? window.__aosCompanionVisualCursorPosition
      : { x: Math.max(18, Math.min(innerWidth - 18, x - 140)), y: Math.max(18, Math.min(innerHeight - 18, y - 90)) };
    window.__aosCompanionVisualCursorPosition = { x, y };
    const task = payload.companionContext?.taskLabel
      || `Task ${String(payload.companionContext?.taskId ?? "unknown").slice(-8)}`;
    const safeTask = normalize(task).slice(0, 48).replace(/[&<>"']/g, (character) => ({
      "&": "&amp;", "<": "&lt;", ">": "&gt;", "\"": "&quot;", "'": "&#39;",
    })[character]);
    const safeActionLabel = normalize(actionLabel).slice(0, 40).replace(/[&<>"']/g, (character) => ({
      "&": "&amp;", "<": "&lt;", ">": "&gt;", "\"": "&quot;", "'": "&#39;",
    })[character]);
    const wrapper = document.createElement("div");
    wrapper.innerHTML = `<style>
      .cursor{position:fixed;left:${prior.x}px;top:${prior.y}px;width:20px;height:20px;transform:translate(-5px,-5px);filter:drop-shadow(0 2px 3px #0008);animation:move .34s cubic-bezier(.22,.8,.3,1) forwards}
      .cursor:before{content:"";display:block;width:0;height:0;border-top:20px solid #16a3ff;border-right:12px solid transparent;transform:rotate(-18deg)}
      .pulse{position:fixed;left:${x}px;top:${y}px;width:34px;height:34px;border:3px solid #16a3ff;border-radius:50%;transform:translate(-50%,-50%);opacity:0;animation:p .65s .32s ease-out infinite}
      .label{position:fixed;left:${Math.min(x + 18, innerWidth - 250)}px;top:${Math.min(y + 18, innerHeight - 44)}px;background:#09233b;color:white;border:1px solid #55bdff;border-radius:999px;padding:7px 11px;font:600 12px/1.2 -apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;box-shadow:0 4px 18px #0005;white-space:nowrap;opacity:0;animation:label .16s .32s ease-out forwards}
      @keyframes move{to{left:${x}px;top:${y}px}}
      @keyframes p{from{opacity:.9;transform:translate(-50%,-50%) scale(.35)}to{opacity:0;transform:translate(-50%,-50%) scale(1.15)}}
      @keyframes label{to{opacity:1}}
    </style><div class="pulse"></div><div class="cursor"></div><div class="label">AOS Companion · ${safeTask} · ${safeActionLabel}</div>`;
    root.append(wrapper);
    document.documentElement.append(host);
    setTimeout(() => host.remove(), 1_100);
  };
  const visualizePoint = async (point, actionLabel = "visual input") => {
    const x = Number(point?.x);
    const y = Number(point?.y);
    if (!Number.isFinite(x) || !Number.isFinite(y)) throw operationError("visual_point_invalid", "visual point requires finite x/y");
    const hostId = "__aos_companion_virtual_cursor__";
    document.getElementById(hostId)?.remove();
    const host = document.createElement("div");
    host.id = hostId;
    host.style.cssText = "all:initial;position:fixed;inset:0;z-index:2147483647;pointer-events:none";
    const root = host.attachShadow({ mode: "closed" });
    const prior = window.__aosCompanionVisualCursorPosition
      && Number.isFinite(window.__aosCompanionVisualCursorPosition.x)
      && Number.isFinite(window.__aosCompanionVisualCursorPosition.y)
      ? window.__aosCompanionVisualCursorPosition
      : { x: Math.max(18, x - 140), y: Math.max(18, y - 90) };
    window.__aosCompanionVisualCursorPosition = { x, y };
    const task = normalize(payload.companionContext?.taskLabel || `Task ${String(payload.companionContext?.taskId ?? "unknown").slice(-8)}`)
      .slice(0, 48).replace(/[&<>"']/g, (character) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", "\"": "&quot;", "'": "&#39;" })[character]);
    const label = normalize(actionLabel).slice(0, 40).replace(/[&<>"']/g, (character) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", "\"": "&quot;", "'": "&#39;" })[character]);
    const wrapper = document.createElement("div");
    wrapper.innerHTML = `<style>
      .cursor{position:fixed;left:${prior.x}px;top:${prior.y}px;width:20px;height:20px;transform:translate(-5px,-5px);filter:drop-shadow(0 2px 3px #0008);animation:move .34s cubic-bezier(.22,.8,.3,1) forwards}
      .cursor:before{content:"";display:block;width:0;height:0;border-top:20px solid #16a3ff;border-right:12px solid transparent;transform:rotate(-18deg)}
      .pulse{position:fixed;left:${x}px;top:${y}px;width:34px;height:34px;border:3px solid #16a3ff;border-radius:50%;transform:translate(-50%,-50%);opacity:0;animation:p .65s .32s ease-out infinite}
      .label{position:fixed;left:${Math.min(x + 18, innerWidth - 250)}px;top:${Math.min(y + 18, innerHeight - 44)}px;background:#09233b;color:white;border:1px solid #55bdff;border-radius:999px;padding:7px 11px;font:600 12px/1.2 -apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;box-shadow:0 4px 18px #0005;white-space:nowrap;opacity:0;animation:label .16s .32s ease-out forwards}
      @keyframes move{to{left:${x}px;top:${y}px}}
      @keyframes p{from{opacity:.9;transform:translate(-50%,-50%) scale(.35)}to{opacity:0;transform:translate(-50%,-50%) scale(1.15)}}
      @keyframes label{to{opacity:1}}
    </style><div class="pulse"></div><div class="cursor"></div><div class="label">AOS Companion · ${task} · ${label}</div>`;
    root.append(wrapper);
    document.documentElement.append(host);
    if (document.visibilityState === "hidden") {
      // Hidden tabs throttle page timers and animations. A display-only
      // preview must return without waiting for the tab to become foreground.
      const still = document.createElement("style");
      still.textContent = `.cursor{animation:none;left:${x}px;top:${y}px}.label,.pulse{animation:none;opacity:1}`;
      root.append(still);
    } else {
      await wait(380);
    }
    setTimeout(() => host.remove(), 1_100);
    return { shown: true, point: { x, y }, virtualCursor: true, osCursorMoved: false };
  };
  const wait = (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds));
  const operationError = (code, message, details = {}) => {
    const error = new Error(message);
    error.code = code;
    error.details = details;
    return error;
  };
  const errorResult = (error, fallbackCode) => ({
    __aosCompanionError: {
      code: error?.code || fallbackCode,
      message: error instanceof Error ? error.message : String(error),
      details: error?.details && typeof error.details === "object" ? error.details : undefined,
    },
  });
  if (action === "showVisualPoint") {
    return visualizePoint(payload.point, payload.actionLabel || "visual input");
  }
  const frameCoordinateMap = (localPoint) => {
    let currentWindow = globalThis;
    let point = { x: Number(localPoint?.x), y: Number(localPoint?.y) };
    const framePath = [];
    try {
      while (currentWindow.parent && currentWindow.parent !== currentWindow) {
        const frameElement = currentWindow.frameElement;
        if (!frameElement || typeof frameElement.getBoundingClientRect !== "function") {
          return { supported: false, exact_blocker: "frame_coordinate_transform_unavailable" };
        }
        const frameRect = frameElement.getBoundingClientRect();
        if (!Number.isFinite(frameRect.left) || !Number.isFinite(frameRect.top)
          || !(frameElement.offsetWidth > 0) || !(frameElement.offsetHeight > 0)) {
          return { supported: false, exact_blocker: "frame_coordinate_transform_unavailable" };
        }
        // A bounding rectangle cannot recover rotation, skew, perspective or
        // reflection. Refuse these instead of turning its box into a point.
        for (let node = frameElement; node; node = node.parentElement) {
          const style = getComputedStyle(node);
          if ((style.perspective && style.perspective !== "none")
            || (style.rotate && !["none", "0deg", "0rad", "0turn"].includes(style.rotate))
            || (style.scale && style.scale !== "none" && style.scale.split(/\s+/u).some(value => !(Number(value) > 0)))) {
            return { supported: false, exact_blocker: "frame_coordinate_transform_unavailable" };
          }
          if (style.transform && style.transform !== "none") {
            const matrix = new DOMMatrixReadOnly(style.transform);
            if (!matrix.is2D || matrix.a <= 0 || matrix.d <= 0 || Math.abs(matrix.b) > 1e-8 || Math.abs(matrix.c) > 1e-8) {
              return { supported: false, exact_blocker: "frame_coordinate_transform_unavailable" };
            }
          }
        }
        const frameStyle = getComputedStyle(frameElement);
        const scaleX = frameRect.width / frameElement.offsetWidth, scaleY = frameRect.height / frameElement.offsetHeight;
        const insetX = frameElement.clientLeft + (parseFloat(frameStyle.paddingLeft) || 0);
        const insetY = frameElement.clientTop + (parseFloat(frameStyle.paddingTop) || 0);
        if (!(scaleX > 0) || !(scaleY > 0)) return { supported: false, exact_blocker: "frame_coordinate_transform_unavailable" };
        point = { x: frameRect.left + (insetX + point.x) * scaleX, y: frameRect.top + (insetY + point.y) * scaleY };
        framePath.push({
          tag: frameElement.tagName?.toLowerCase?.() || "iframe",
          id: frameElement.id || null,
          name: frameElement.getAttribute?.("name") || null,
          rect: { x: frameRect.x, y: frameRect.y, width: frameRect.width, height: frameRect.height },
          contentInset: { x: insetX, y: insetY },
          scale: { x: scaleX, y: scaleY },
        });
        currentWindow = currentWindow.parent;
      }
      const topViewport = {
        width: Number(currentWindow.innerWidth),
        height: Number(currentWindow.innerHeight),
        devicePixelRatio: Number(currentWindow.devicePixelRatio || 1),
        scale: Number(currentWindow.visualViewport?.scale ?? 1),
      };
      const topScroll = {
        x: Math.round(Number(currentWindow.scrollX || 0)),
        y: Math.round(Number(currentWindow.scrollY || 0)),
      };
      if (!Number.isFinite(topViewport.width) || !Number.isFinite(topViewport.height)) {
        return { supported: false, exact_blocker: "frame_coordinate_transform_unavailable" };
      }
      return {
        supported: true,
        point: { x: Math.round(point.x), y: Math.round(point.y) },
        framePath,
        topLevelUrl: String(currentWindow.location?.href || location.href),
        viewport: topViewport,
        scroll: topScroll,
        coordinateSpace: "top-level-viewport",
      };
    } catch {
      return { supported: false, exact_blocker: "frame_coordinate_transform_unavailable" };
    }
  };
  const consumeSemanticGuard = element => {
    if (payload.semanticGuardId === undefined) return null;
    const guards = globalThis.__aosCompanionSemanticGuardsV1;
    const record = guards?.get(payload.semanticGuardId);
    guards?.delete(payload.semanticGuardId);
    const reject = (afterFocus = false) => { throw operationError("transaction_action_target_changed",
      "The exact inspected element, document, state or geometry changed before input; read the target again",
      { operationEffectState: afterFocus ? "unknown" : "none", mutationDispatchAttempted: afterFocus }); };
    if (!record || record.expiresAt <= Date.now() || record.element !== element
      || record.pageInstanceId !== pageInstanceId || record.url !== location.href || !element.isConnected) reject();
    const rect = element.getBoundingClientRect();
    const point = { x: Math.round((Math.max(0, rect.left) + Math.min(innerWidth, rect.right)) / 2),
      y: Math.round((Math.max(0, rect.top) + Math.min(innerHeight, rect.bottom)) / 2) };
    const state = JSON.stringify({ element: describe(element), mapping: frameCoordinateMap(point),
      viewport: { width: innerWidth, height: innerHeight, devicePixelRatio, scale: Number(globalThis.visualViewport?.scale ?? 1) } });
    if (state !== record.state) reject();
    // focus() may synchronously replace a control. Never click the detached
    // old node after such a handler; no page timer runs between these checks.
    return () => { if (!element.isConnected || record.url !== location.href) reject(true); };
  };
  const activateControl = (element, guardAfterFocus = null) => {
    element.focus();
    if (guardAfterFocus) guardAfterFocus();
    element.dispatchEvent(new MouseEvent("mousedown", { bubbles: true, composed: true, cancelable: true, view: window }));
    element.dispatchEvent(new MouseEvent("mouseup", { bubbles: true, composed: true, cancelable: true, view: window }));
    element.click();
  };
  const targetOrActive = (locator, { allowBody = true } = {}) => {
    if (locator && typeof locator === "object" && Object.keys(locator).length > 0) return find(locator);
    const active = document.activeElement;
    if (active && active !== document.documentElement && active !== document.body) return active;
    if (allowBody && document.body) return document.body;
    throw operationError("focused_element_required", "No semantic locator or focused element was available");
  };
  const focusedTextInputAtPoint = (point) => {
    let active = document.activeElement;
    while (active?.shadowRoot?.activeElement) active = active.shadowRoot.activeElement;
    let hit = document.elementFromPoint(Number(point?.x), Number(point?.y));
    while (hit?.shadowRoot) {
      const child = hit.shadowRoot.elementFromPoint?.(Number(point.x), Number(point.y));
      if (!child || child === hit) break;
      hit = child;
    }
    if (!active || !(active === hit || active.contains(hit))
      || !(active instanceof HTMLInputElement || active instanceof HTMLTextAreaElement || active.isContentEditable)) {
      throw operationError("physical_input_target_changed", "The inspected point is not inside the exact focused text field");
    }
    return active;
  };
  const allowedKeys = new Set([
    "Enter", "Escape", "Tab", "Backspace", "Delete", " ", "Space", "Home", "End", "PageUp", "PageDown",
    "ArrowUp", "ArrowDown", "ArrowLeft", "ArrowRight",
  ]);
  const allowedKey = (key) => allowedKeys.has(key) || /^[a-z0-9]$/iu.test(key) || /^F(?:[1-9]|1[0-2])$/u.test(key);
  const optionLabel = (element) => normalize(
    element.getAttribute("aria-label")
      || element.innerText
      || element.textContent
      || element.getAttribute("label")
      || element.getAttribute("data-label"),
  );
  const optionValue = (element) => normalize(
    element instanceof HTMLOptionElement
      ? element.value
      : (element.getAttribute("data-value") || element.getAttribute("value")),
  );
  const requestedOption = (specification) => {
    if (typeof specification === "string") specification = { label: specification };
    if (!specification || typeof specification !== "object") {
      throw operationError("dropdown_option_required", "page.selectOption requires option {label|value|index}");
    }
    const normalized = {
      label: specification.label == null ? null : normalize(specification.label),
      value: specification.value == null ? null : normalize(specification.value),
      index: Number.isInteger(specification.index) ? specification.index : null,
    };
    if (["label", "value", "index"].filter(field => specification[field] != null).length !== 1) {
      throw operationError("dropdown_option_required", "page.selectOption requires exactly one option label, value, or index");
    }
    if (specification.index != null && (normalized.index == null || normalized.index < 0)) {
      throw operationError("dropdown_option_index_invalid", "Dropdown option index must be non-negative");
    }
    return normalized;
  };
  const controlledDropdownRoots = (control) => {
    const roots = [];
    const ids = `${control.getAttribute("aria-controls") || ""} ${control.getAttribute("aria-owns") || ""}`
      .split(/\s+/u)
      .filter(Boolean);
    for (const id of ids) {
      const escaped = globalThis.CSS?.escape ? CSS.escape(id) : id.replace(/["\\]/g, "\\$&");
      const found = querySemantic(`#${escaped}`, 20).find((element) => element.id === id);
      if (found) roots.push(found);
    }
    return roots;
  };
  const dropdownOptions = (control) => {
    const roots = controlledDropdownRoots(control);
    const selectors = "[role='option'],option,[role='listbox'] [data-value],[role='listbox'] li";
    const found = [];
    const seen = new Set();
    const add = (element) => {
      if (!element || seen.has(element) || !visible(element)) return;
      seen.add(element);
      found.push(element);
    };
    for (const root of roots) {
      if (root.matches?.("[role='option'],option,[data-value]")) add(root);
      for (const element of root.querySelectorAll(selectors)) add(element);
    }
    const hasControlReference = Boolean(`${control.getAttribute("aria-controls") || ""} ${control.getAttribute("aria-owns") || ""}`.trim());
    if (roots.length === 0 && !hasControlReference) {
      for (const element of querySemantic(selectors)) add(element);
    }
    return { options: found, controlled: roots.length > 0 };
  };
  const dropdownScrollContainer = (control, options) => {
    // Only the control's explicit associated popup may be searched by scrolling.
    // Never scroll the page or an unrelated visible list to find a match.
    const roots = controlledDropdownRoots(control);
    const candidates = new Set();
    for (const root of roots) {
      candidates.add(root);
      for (const list of root.querySelectorAll("[role='listbox']")) candidates.add(list);
      for (const option of options) {
        if (!root.contains(option)) continue;
        for (let parent = option.parentElement; parent && root.contains(parent); parent = parent.parentElement) {
          candidates.add(parent);
          if (parent === root) break;
        }
      }
    }
    const scrollable = [...candidates].filter(element => element.isConnected && visible(element)
      && element !== document.scrollingElement && element !== document.body
      && element.clientHeight > 0 && element.scrollHeight > element.clientHeight + 1
      && /^(auto|scroll|overlay)$/u.test(getComputedStyle(element).overflowY));
    return scrollable.length === 1 ? scrollable[0] : null;
  };
  const waitForDropdownChange = (milliseconds, roots = semanticRoots) => new Promise((resolve) => {
    // Hidden Chrome tabs can throttle a 100 ms timer for many seconds. Wake
    // on actual option/selection changes instead of overlooking a response
    // that already arrived within the requested deadline.
    let timer;
    const finish = () => {
      observer.disconnect();
      if (timer !== undefined) clearTimeout(timer);
      resolve();
    };
    const observer = new MutationObserver(finish);
    for (const root of roots) {
      observer.observe(root, { childList: true, subtree: true, attributes: true, characterData: true });
    }
    timer = setTimeout(finish, milliseconds);
  });
  const chooseOption = (options, specification, exact) => {
    if (specification.index != null) {
      if (specification.index >= options.length) {
        throw operationError("dropdown_option_index_invalid", `Dropdown option index ${specification.index} is outside ${options.length} visible options`);
      }
      return options[specification.index];
    }
    const matches = options.filter((candidate) => {
      const label = lower(optionLabel(candidate));
      const value = lower(optionValue(candidate));
      const labelMatch = specification.label != null
        ? (exact || specification.label === "" ? label === lower(specification.label) : label.includes(lower(specification.label)))
        : true;
      const valueMatch = specification.value != null
        ? (exact || specification.value === "" ? value === lower(specification.value) : value.includes(lower(specification.value)))
        : true;
      return labelMatch && valueMatch;
    });
    if (matches.length === 0) {
      throw operationError("dropdown_option_not_found", "No visible dropdown option matched the requested label/value", {
        requested: specification,
        visibleOptions: options.slice(0, 30).map((option) => ({ label: optionLabel(option), value: optionValue(option) })),
      });
    }
    if (matches.length > 1) {
      throw operationError("dropdown_option_ambiguous", `Dropdown option matched ${matches.length} visible elements`, {
        requested: specification,
        matches: matches.slice(0, 20).map((option) => ({ label: optionLabel(option), value: optionValue(option) })),
      });
    }
    return matches[0];
  };
  const nativeOptionReport = (option) => ({
    label: optionLabel(option),
    value: optionValue(option),
    index: option.index,
  });
  const nativeOptionDisabled = (option, control) => {
    if (Boolean(option?.disabled) || option?.matches?.(":disabled") === true) return true;
    for (let parent = option?.parentElement; parent && parent !== control; parent = parent.parentElement) {
      const tag = parent.tagName?.toLowerCase();
      if (tag === "optgroup" && Boolean(parent.disabled)) return true;
    }
    return false;
  };
  const nativeControlDisabled = (control) => {
    return Boolean(control?.disabled) || control?.matches?.(":disabled") === true;
  };
  const nativeSelectionError = (code, message, details = {}) => operationError(code, message, {
    operationEffectState: "none",
    mutationDispatchAttempted: false,
    ...details,
  });
  const nativeSelectionPostError = (message, details = {}) => operationError("dropdown_selection_not_committed", message, {
    operationEffectState: "unknown",
    mutationDispatchAttempted: true,
    ...details,
  });

  const dropdownControlKind = (control) => {
    if (control instanceof HTMLSelectElement) return "native_select";
    const role = lower(control.getAttribute("role") || implicitRole(control));
    const popup = lower(control.getAttribute("aria-haspopup"));
    if (role === "combobox") return "aria_combobox";
    if (popup === "listbox") return "aria_popup_listbox";
    if (control.matches("button,input,[data-value],[class*='select']")) return "identifiable_custom_dropdown";
    return null;
  };

  if (action === "snapshot") {
    const maxTextChars = payload.maxTextChars;
    const controls = querySemantic("button,a[href],input,textarea,select,[role],[contenteditable='true']")
      .filter(visible)
      .slice(0, 200)
      .map(describe);
    const textSegments = [];
    const seenText = new Set();
    for (const value of [document.body?.innerText, document.documentElement?.innerText, ...semanticRoots.slice(1).map((root) => root.textContent)]) {
      const text = normalize(value);
      if (!text || seenText.has(text)) continue;
      seenText.add(text);
      textSegments.push(text);
    }
    const frameMapping = frameCoordinateMap({ x: 0, y: 0 });
    return {
      url: location.href,
      topLevelUrl: frameMapping.supported ? frameMapping.topLevelUrl : null,
      title: document.title,
      readyState: document.readyState,
      pageInstanceId,
      framePath: frameMapping.supported ? frameMapping.framePath : [],
      coordinateSpace: frameMapping.supported ? frameMapping.coordinateSpace : "frame-local-viewport",
      text: textSegments.join(" ").slice(0, maxTextChars),
      controls,
    };
  }
  // Explicit full-body reads use deterministic UTF-16 offsets, without the
  // whitespace normalization and preview truncation of ordinary queries.
  const exactEditorState = async () => {
    if (payload.locator?.css !== "div.ProseMirror") throw operationError("exact_editor_locator_required", "Exact editor reads require div.ProseMirror");
    const editors = document.querySelectorAll("div.ProseMirror");
    if (editors.length !== 1 || !editors[0].isContentEditable || !visible(editors[0])) throw operationError("exact_editor_not_unique", "Require one visible contenteditable ProseMirror editor");
    const editor = editors[0];
    const maximum = payload.maxEditorChars ?? 100_000;
    if (!Number.isSafeInteger(maximum) || maximum < 1 || maximum > 100_000) throw operationError("exact_editor_bound_invalid", "Editor bound must be 1 to 100000 UTF-16 units");
    const boundaries = new Map(), points = [];
    let body = "", nodes = 0;
    const append = text => {
      body += text;
      if (body.length > maximum) throw operationError("exact_editor_oversize", "Exact editor body exceeds the requested bound");
    };
    const visit = node => {
      if (++nodes > 20_000) throw operationError("exact_editor_structure_oversize", "Editor structure exceeds the bounded scan");
      if (node.nodeType === 3) {
        const text = node.nodeValue ?? "", start = body.length;
        boundaries.set(node, { start, length: text.length });
        points.push({ node, start, end: start + text.length });
        append(text); return;
      }
      if (node.nodeType !== 1) throw operationError("exact_editor_structure_unsupported", "Unsupported editor node");
      const tag = node.tagName.toLowerCase();
      if (tag === "br") { boundaries.set(node, [body.length]); append("\n"); return; }
      if (node !== editor && !/^(p|h[1-6]|span|strong|b|em|i|u|s|a|code)$/u.test(tag)) throw operationError("exact_editor_structure_unsupported", "Unsupported editor structure");
      const offsets = [body.length];
      [...node.childNodes].forEach((child, index) => {
        if (node === editor && index > 0) append("\n");
        visit(child); offsets.push(body.length);
      });
      boundaries.set(node, offsets);
    };
    visit(editor);
    const offset = (node, position) => {
      const bound = boundaries.get(node);
      if (!bound || !Number.isSafeInteger(position) || position < 0) return null;
      return Array.isArray(bound) ? bound[position] ?? null : position <= bound.length ? bound.start + position : null;
    };
    const selection = getSelection();
    const range = selection?.rangeCount === 1 ? selection.getRangeAt(0) : null;
    const start = range ? offset(range.startContainer, range.startOffset) : null;
    const end = range ? offset(range.endContainer, range.endOffset) : null;
    let splitBinding;
    if (payload.splitBinding === true) {
      if (!range?.collapsed || start === null || end === null)
        throw operationError("rich_text_caret_required", "Split binding requires a current collapsed caret inside the exact editor");
      const path = []; let node = range.startContainer;
      while (node !== editor) {
        const parent = node.parentNode;
        if (!parent || path.length >= 32) throw operationError("rich_text_split_structure_unsupported", "Caret path exceeds the exact editor scope");
        path.unshift([...parent.childNodes].indexOf(node)); node = parent;
      }
      const prefix = document.createRange(); prefix.selectNodeContents(editor); prefix.setEnd(range.startContainer, range.startOffset);
      const expectedBody = String(editor.textContent ?? ""), expectedEditorHtml = editor.innerHTML;
      if (expectedBody.length > maximum || expectedEditorHtml.length > maximum)
        throw operationError("exact_editor_oversize", "Split binding body or HTML exceeds the requested bound");
      splitBinding = { expectedBody, expectedFullBody: expectedBody, expectedEditorHtml,
        expectedCaret: { path, offset: range.startOffset }, expectedSelection: { start: prefix.toString().length, end: prefix.toString().length } };
    }
    const hash = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(body));
    return { editor, points, body, ...(splitBinding ? { splitBinding } : {}), bodySha256: [...new Uint8Array(hash)].map(byte => byte.toString(16).padStart(2, "0")).join(""),
      selection: { withinEditor: start !== null && end !== null, collapsed: Boolean(range?.collapsed), start, end, offsetUnit: "utf16" },
      articleIdentity: { url: location.href, title: document.title, editorId: editor.id || null },
      url: location.href, pageInstanceId, chars: body.length, truncated: false, serialization: "prosemirror-text-br-block-v1" };
  };
  if (action === "verifyExactEditor" || action === "prepareExactEditor") {
    let state = await exactEditorState();
    if (state.body !== payload.expectedBody) throw operationError("exact_editor_body_changed", "Exact editor body changed", { operationEffectState: "none", mutationDispatchAttempted: false });
    if (action === "prepareExactEditor" && payload.establishSelection === true) {
      if (!Number.isSafeInteger(payload.offset) || payload.offset < 0 || payload.offset > state.body.length) throw operationError("exact_editor_offset_invalid", "Invalid collapsed UTF-16 offset");
      // Focus can decorate the editor. Rebuild positions from a fresh body.
      state.editor.focus({ preventScroll: true });
      state = await exactEditorState();
      if (state.body !== payload.expectedBody) throw operationError("exact_editor_body_changed", "Editor changed on focus", { operationEffectState: "none", mutationDispatchAttempted: false });
      const point = state.points.find(item => payload.offset >= item.start && payload.offset <= item.end);
      if (!point) throw operationError("exact_editor_offset_unavailable", "Offset does not identify an exact text-node boundary");
      const range = document.createRange(); range.setStart(point.node, payload.offset - point.start); range.collapse(true);
      const selection = getSelection(); selection.removeAllRanges(); selection.addRange(range);
      state = await exactEditorState();
    }
    if (state.body !== payload.expectedBody || (payload.requireSelection === true && (!state.selection.withinEditor || !state.selection.collapsed
      || state.selection.start !== payload.offset || state.selection.end !== payload.offset || document.activeElement !== state.editor))) {
      throw operationError("exact_editor_selection_changed", "Exact focused collapsed selection changed", { operationEffectState: "none", mutationDispatchAttempted: false });
    }
    const { editor, points, ...result } = state; return result;
  }
  if (action === "query" && payload.exactEditor === true) {
    const { editor, points, ...result } = await exactEditorState(); return { exactEditor: true, ...result };
  }
  if (action === "query") {
    const needle = lower(payload.query);
    if ((!needle && !payload.locator) || needle.length > 500) throw operationError("page_query_invalid", "page.query requires a locator or a query between 1 and 500 characters");
    const limit = Math.min(Math.max(Number.isInteger(payload.limit) ? payload.limit : 25, 1), 100);
    const offset = Math.min(Math.max(Number.isInteger(payload.offset) ? payload.offset : 0, 0), 4_999);
    const attributes = [...new Set(Array.isArray(payload.attributes) ? payload.attributes : [])];
    if (attributes.length > 16 || attributes.some(name => typeof name !== "string" || name.length > 100 || !/^[A-Za-z_:][A-Za-z0-9_.:-]*$/u.test(name))) {
      throw operationError("page_query_attributes_invalid", "Request at most 16 explicit attribute names");
    }
    let attributeCharsRemaining = 32_000;
    const readAttributes = (element) => {
      const values = {}, redacted = [], truncated = [];
      for (const name of attributes) {
        const raw = element.getAttribute(name);
        if (raw === null) { values[name] = null; continue; }
        if (/(?:token|secret|password|credential|cookie|authorization|private[-_]?key)/iu.test(name)
          || (name.toLowerCase() === "value" && element.matches("input,textarea,select"))) {
          values[name] = "<redacted>"; redacted.push(name); continue;
        }
        const sanitized = redactExportText(raw, Math.min(2_000, attributeCharsRemaining));
        values[name] = sanitized.text;
        attributeCharsRemaining -= sanitized.text.length;
        if (sanitized.truncated) truncated.push(name);
        if (sanitized.text !== raw && !sanitized.truncated) redacted.push(name);
      }
      return { attributes: values, ...(redacted.length ? { redactedAttributes: redacted } : {}), ...(truncated.length ? { truncatedAttributes: truncated } : {}) };
    };
    const selection = payload.locator
      ? locateAll(payload.locator, { includeHidden: payload.includeHidden === true })
      : { candidates: querySemantic("button,a[href],input,textarea,select,label,h1,h2,h3,p,li,[role],[contenteditable='true']", 5_000), scanLimitReached: false };
    if (!payload.locator) selection.scanLimitReached = selection.candidates.length >= 5_000;
    const matching = selection.candidates
      .filter(element => payload.includeHidden === true || visible(element))
      .map((element) => ({ element, text: normalize(accessibleName(element) || element.innerText || element.textContent) }))
      .filter((entry) => !needle || lower(entry.text).includes(needle));
    const candidates = matching.slice(offset, offset + limit)
      .map(({ element, text }) => {
        const rect = element.getBoundingClientRect();
        const identities = globalThis.__aosCompanionQueryNodeIdentitiesV1 ??= new WeakMap();
        if (!identities.has(element)) identities.set(element, crypto.randomUUID());
        return {
          ...describe(element),
          nodeIdentity: identities.get(element),
          text: text.slice(0, 500),
          rect: { x: rect.x, y: rect.y, width: rect.width, height: rect.height },
          ...(attributes.length ? readAttributes(element) : {}),
        };
      });
    return { query: payload.query || null, matches: candidates, count: candidates.length, totalCount: matching.length,
      totalCountExact: !selection.scanLimitReached, scanLimitReached: selection.scanLimitReached,
      offset, limit, nextOffset: offset + candidates.length < matching.length ? offset + candidates.length : null,
      truncated: offset + candidates.length < matching.length || selection.scanLimitReached, url: location.href, pageInstanceId };
  }
  if (action === "resolveDownloadTarget") {
    const element = find(payload.locator);
    const tag = element.tagName.toLowerCase();
    const raw = tag === "a" ? element.href
      : new Set(["img", "video", "audio"]).has(tag) ? element.currentSrc || element.src
        : tag === "source" ? element.src : null;
    if (typeof raw !== "string" || !raw) throw Object.assign(new Error("The exact target has no supported link or media URL"), { code: "download_target_media_unavailable" });
    const url = new URL(raw, location.href);
    if (!new Set(["http:", "https:"]).has(url.protocol) || url.username || url.password) throw Object.assign(new Error("This media URL is not a credential-free HTTP download; blob/data targets need a page-triggered download workflow"), { code: "download_target_protocol_unsupported" });
    return { downloadUrl: url.href, element: describe(element), url: location.href, pageInstanceId };
  }
  if (action === "exportContent") {
    const format = payload.format === "html" ? "html" : "text";
    const maxChars = Math.min(Math.max(Number(payload.maxChars ?? 50_000), 1_000), 100_000);
    let content;
    if (format === "html") {
      const clone = document.documentElement.cloneNode(true);
      clone.querySelectorAll("script,style,noscript,template").forEach((element) => element.remove());
      clone.querySelectorAll("input,textarea,select").forEach((element) => {
        element.removeAttribute("value");
        if ("value" in element) element.value = "";
        if (element instanceof HTMLTextAreaElement) element.textContent = "";
      });
      clone.querySelectorAll("*").forEach((element) => {
        for (const attribute of [...element.attributes]) {
          if (/^on/iu.test(attribute.name)
            || /(?:token|secret|password|credential|cookie|authorization|private[_-]?key)/iu.test(attribute.name)
            || new Set(["srcdoc", "nonce", "integrity", "value", "checked", "selected"]).has(attribute.name.toLowerCase())) element.removeAttribute(attribute.name);
        }
      });
      content = clone.outerHTML;
    } else {
      const segments = [document.body?.innerText, ...semanticRoots.slice(1).map((root) => root.textContent)]
        .map(normalize)
        .filter(Boolean);
      content = [...new Set(segments)].join("\n");
    }
    const redacted = redactExportText(content, maxChars);
    return { format, content: redacted.text, chars: redacted.text.length, truncated: redacted.truncated, formValuesRemoved: true, activeCodeRemoved: format === "html", redactionApplied: redacted.text !== content, url: location.href, pageInstanceId };
  }
  if (action === "webMcpDiscover") {
    const context = navigator.modelContext;
    if (!context || typeof context !== "object") {
      return { supported: false, exact_blocker: "webmcp_not_available_on_page", api: null, tools: [], invocation_supported: false, url: location.href };
    }
    const api = ["registerTool", "unregisterTool", "provideContext", "clearContext"]
      .filter((name) => typeof context[name] === "function");
    return { supported: true, exact_blocker: null, api, tools: [], invocation_supported: false, discovery_only: true, url: location.href };
  }
  if (action === "webMcpCall") {
    if (payload.approved !== true) throw operationError("webmcp_approval_required", "WebMCP calls require explicit per-call approval");
    const toolName = String(payload.toolName ?? "").trim();
    const allowedToolNames = Array.isArray(payload.allowedToolNames) ? payload.allowedToolNames.map(String) : [];
    if (!toolName || toolName.length > 120 || !allowedToolNames.includes(toolName)) {
      throw operationError("webmcp_tool_not_allowlisted", "WebMCP toolName must be present in the signed allowlist");
    }
    const context = navigator.modelContext;
    if (!context || typeof context.callTool !== "function") {
      throw operationError("webmcp_invocation_not_available", "The page does not expose an allowlisted modelContext.callTool API");
    }
    const args = payload.arguments && typeof payload.arguments === "object" && !Array.isArray(payload.arguments) ? payload.arguments : {};
    const result = await context.callTool(toolName, args);
    const rendered = JSON.stringify(result);
    const maxBytes = Math.min(Math.max(Number(payload.maxResultBytes ?? 256 * 1024), 1), 256 * 1024);
    if (typeof rendered !== "string" || new TextEncoder().encode(rendered).byteLength > maxBytes) throw operationError("webmcp_result_too_large", "WebMCP result exceeds the bounded response size");
    return { supported: true, invoked: true, toolName, result, resultBytes: new TextEncoder().encode(rendered).byteLength, url: location.href, pageInstanceId };
  }
  if (action === "inspectCaptcha") {
    const selectors = [
      "iframe[src*='recaptcha' i]", "iframe[src*='hcaptcha' i]", "iframe[src*='turnstile' i]",
      ".g-recaptcha", ".h-captcha", ".cf-turnstile", "[data-sitekey]",
    ];
    const visibleCandidate = (element) => {
      if (!element || !(element instanceof Element)) return false;
      const rect = element.getBoundingClientRect?.();
      if (!rect || rect.width < 8 || rect.height < 8) return false;
      const style = getComputedStyle(element);
      if (style.display === "none" || style.visibility === "hidden" || Number(style.opacity || 1) <= 0) return false;
      // Class names, screenshot text, and a bare sitekey attribute are not
      // proof of an actionable challenge.  Require a real widget surface
      // (visible challenge iframe or interactive control) before classifying
      // it as user work.
      if (element.matches("iframe")) return true;
      // A copied badge/class/data-sitekey marker is often left in a hidden or
      // decorative container.  Only an actual interactive descendant (or the
      // container itself being an interactive control) counts as a widget.
      return element.matches("[role='checkbox'],button,input,[tabindex]:not([tabindex='-1'])")
        || Boolean(element.querySelector("[role='checkbox'],button,input,[tabindex]:not([tabindex='-1'])"));
    };
    const widgets = [...new Set(selectors.flatMap((selector) => [...document.querySelectorAll(selector)]))]
      .filter(visibleCandidate)
      .slice(0, 20)
      .map((element) => {
        const rect = element.getBoundingClientRect();
        return {
          kind: element.matches("iframe") ? "challenge_iframe" : "widget_container",
          tag: element.tagName.toLowerCase(),
          id: element.id || null,
          rect: { x: rect.x, y: rect.y, width: rect.width, height: rect.height },
          visible: true,
        };
      });
    const pageText = normalize(document.body?.innerText || "");
    const passiveTextOnly = widgets.length === 0 && /(?:captcha|hcaptcha|reCAPTCHA|turnstile)/iu.test(pageText);
    return {
      visibleWidget: widgets.length > 0,
      widgets,
      passiveTextOnly,
      user_action_required: widgets.length > 0,
      exact_blocker: widgets.length > 0 ? "visible_captcha_widget_user_required" : null,
      url: location.href,
      pageInstanceId,
    };
  }
  if (action === "domDiff") {
    const previous = payload.previous && typeof payload.previous === "object" ? payload.previous : {};
    const current = {
      url: location.href,
      title: document.title,
      text: normalize(document.body?.innerText || "").slice(0, 100_000),
      controls: querySemantic("button,a[href],input,textarea,select,[role],[contenteditable='true']", 2_000)
        .filter(visible)
        .map((element) => describe(element))
        .slice(0, 300),
    };
    const key = (item) => String(item?.testId || item?.name || item?.text || `${item?.tag || ""}:${item?.rect?.x || 0}:${item?.rect?.y || 0}`).slice(0, 300);
    const before = new Map((Array.isArray(previous.controls) ? previous.controls : []).map((item) => [key(item), item]));
    const after = new Map(current.controls.map((item) => [key(item), item]));
    const added = [...after.keys()].filter((item) => !before.has(item)).slice(0, 100);
    const removed = [...before.keys()].filter((item) => !after.has(item)).slice(0, 100);
    const changed = [...after.keys()].filter((item) => before.has(item) && JSON.stringify(before.get(item)) !== JSON.stringify(after.get(item))).slice(0, 100);
    return { url: current.url, title: current.title, pageInstanceId, textChanged: current.text !== String(previous.text || ""), added, removed, changed, current, previousProvided: Object.keys(previous).length > 0 };
  }
  if (action === "assets") {
    const limit = Math.min(Math.max(Number(payload.limit ?? 100), 1), 500);
    const maxElements = Math.min(Math.max(Number(payload.maxElements ?? 1000), 1), 5000);
    const maxBytes = Math.min(Math.max(Number(payload.maxBytes ?? 150000), 10000), 500000);
    if (![limit, maxElements, maxBytes].every(Number.isInteger)) throw operationError("page_assets_options_invalid", "Asset limits must be integers");
    const kinds = new Set(payload.kinds ?? ["image", "video", "font", "stylesheet", "script", "other"]);
    if (!kinds.size || [...kinds].some(kind => !["image", "video", "font", "stylesheet", "script", "other"].includes(kind))) throw operationError("page_assets_options_invalid", "Choose supported asset kinds");
    const id = `assets:${pageInstanceId}:${crypto.randomUUID()}`;
    const assets = [], inlineSvgs = [], byUrl = new Map();
    const limits = { assetLimitReached: false, elementLimitReached: false, cssRuleLimitReached: false, resourceLimitReached: false, outputLimitReached: false, svgMarkupTruncated: false };
    const unreadableStylesheets = [], sourceBase = document.baseURI || location.href;
    let outputBytes = 3000, ruleCount = 0;
    const bytes = value => new TextEncoder().encode(JSON.stringify(value)).length;
    const urlInfo = (value, base = sourceBase) => {
      if (!value || String(value).trim().startsWith("#")) return null;
      try {
        const url = new URL(String(value).trim(), base);
        if (!["http:", "https:", "blob:", "data:"].includes(url.protocol)) return null;
        if (url.protocol === "data:") return { key: url.href, url: `data:${url.href.slice(5).split(/[;,]/u)[0].slice(0, 100)};<omitted>`, redacted: true, inline: true };
        const key = url.href;
        url.username = ""; url.password = "";
        for (const name of [...url.searchParams.keys()]) if (/(?:token|secret|password|signature|credential|auth|api[_-]?key|^key$|x-amz-|x-goog-)/iu.test(name)) url.searchParams.set(name, "<redacted>");
        return { key, url: url.href.slice(0, 2000), redacted: url.href !== key || url.href.length > 2000, inline: url.protocol === "blob:" };
      } catch { return null; }
    };
    const add = (kind, rawUrl, source, base = sourceBase) => {
      if (!kinds.has(kind)) return;
      const info = urlInfo(rawUrl, base); if (!info) return;
      const key = info.key, previous = byUrl.get(key);
      if (previous) {
        if (previous.kind === "other" && kind !== "other") previous.kind = kind;
        if (previous.sources.length < 8 && !previous.sources.some(item => JSON.stringify(item) === JSON.stringify(source))) {
          const size = bytes(source) + 1;
          if (outputBytes + size <= maxBytes) { previous.sources.push(source); outputBytes += size; }
          else limits.outputLimitReached = true;
        }
        return;
      }
      if (assets.length >= limit) { limits.assetLimitReached = true; return; }
      let name = info.inline ? "inline asset" : new URL(info.url).pathname.split("/").at(-1) || kind;
      try { name = decodeURIComponent(name); } catch { /* Keep the observed encoded name. */ }
      const asset = { id: `${id}:${assets.length + 1}`, kind, name: name.slice(0, 200), url: info.url,
        urlRedacted: info.redacted, inline: info.inline, sources: [source] };
      const size = bytes(asset) + 1;
      if (outputBytes + size > maxBytes) { limits.outputLimitReached = true; return; }
      assets.push(asset); byUrl.set(key, asset); outputBytes += size;
    };
    const cssUrls = value => {
      const found = [];
      const regex = /url\(\s*(?:"((?:\\.|[^"\\])*)"|'((?:\\.|[^'\\])*)'|([^)]*))\s*\)/giu;
      for (const match of String(value ?? "").slice(0, 100000).matchAll(regex)) {
        found.push((match[1] ?? match[2] ?? match[3] ?? "").trim().replace(/\\([0-9a-f]{1,6})\s?|\\([^\r\n])/giu, (_all, hex, escaped) => hex ? String.fromCodePoint(Math.min(parseInt(hex, 16), 0x10ffff) || 0xfffd) : escaped));
      }
      return found;
    };
    const elements = querySemantic("*", maxElements + 1);
    limits.elementLimitReached = elements.length > maxElements;
    const roots = new Set([document]);
    for (const element of elements.slice(0, maxElements)) {
      if (element.shadowRoot) roots.add(element.shadowRoot);
      const tag = element.localName;
      const node = { tag, ...(element.id ? { id: element.id.slice(0, 160) } : {}) };
      const attribute = (kind, property, value) => add(kind, value ?? element.getAttribute(property), { kind: "attribute", node, property });
      if (tag === "img") { attribute("image", "currentSrc", element.currentSrc); attribute("image", "src", element.src); }
      if (tag === "video" || tag === "audio") { attribute(tag === "video" ? "video" : "other", "currentSrc", element.currentSrc || element.src); if (tag === "video") attribute("image", "poster", element.poster); }
      if (tag === "source" && ["video", "audio"].includes(element.parentElement?.localName)) attribute(element.parentElement.localName === "video" ? "video" : "other", "src", element.src);
      if (tag === "script") attribute("script", "src", element.src);
      if (tag === "link") {
        const kind = element.relList?.contains("stylesheet") ? "stylesheet" : element.as === "font" ? "font" : element.as === "image" || element.relList?.contains("icon") ? "image" : element.as === "script" ? "script" : null;
        if (kind) attribute(kind, "href", element.href);
      }
      if (tag === "image" || tag === "use") attribute("image", "href", element.getAttribute("href") || element.getAttribute("xlink:href"));
      if (payload.includeComputedStyles !== false) {
        for (const pseudo of [null, "::before", "::after"]) {
          const style = getComputedStyle(element, pseudo);
          for (const property of ["background-image", "mask-image", "border-image-source", "list-style-image", "cursor", "content"]) {
            for (const url of cssUrls(style.getPropertyValue(property))) add("image", url, { kind: "computedStyle", node, property, ...(pseudo ? { pseudo } : {}) });
          }
        }
      }
      if (tag === "svg" && payload.includeInlineSvgs !== false && !element.parentElement?.closest("svg")) {
        if (inlineSvgs.length >= 100) { limits.assetLimitReached = true; continue; }
        const markup = redactExportText(new XMLSerializer().serializeToString(element), 20000);
        const item = { id: `${id}:svg:${inlineSvgs.length + 1}`, name: normalize(element.getAttribute("aria-label") || element.querySelector("title")?.textContent || element.id || "inline SVG").slice(0, 200),
          markup: markup.text, node, markupTruncated: markup.truncated };
        limits.svgMarkupTruncated ||= item.markupTruncated;
        const size = bytes(item) + 1;
        if (outputBytes + size <= maxBytes) { inlineSvgs.push(item); outputBytes += size; } else limits.outputLimitReached = true;
      }
    }
    const seenSheets = new Set();
    const scanRules = (rules, base) => {
      for (const rule of rules) {
        if (++ruleCount > 5000) { limits.cssRuleLimitReached = true; return; }
        if (rule.href) { add("stylesheet", rule.href, { kind: "cssRule", property: "@import" }, base); if (rule.styleSheet) scanSheet(rule.styleSheet, base); }
        if (rule.style) {
          const font = rule.type === 5;
          for (const url of cssUrls(font ? rule.style.getPropertyValue("src") : rule.style.cssText)) add(font ? "font" : "image", url, { kind: "cssRule", property: font ? "@font-face src" : "style", stylesheet: urlInfo(base)?.url ?? null }, base);
        }
        if (rule.cssRules) scanRules(rule.cssRules, base);
      }
    };
    const scanSheet = (sheet, fallback = sourceBase) => {
      if (seenSheets.has(sheet)) return; seenSheets.add(sheet);
      const base = sheet.href || fallback;
      if (sheet.href) add("stylesheet", sheet.href, { kind: "cssRule", property: "stylesheet" });
      try { scanRules(sheet.cssRules, base); }
      catch {
        const url = urlInfo(base)?.url ?? null, size = bytes(url) + 1;
        if (unreadableStylesheets.length < 30 && outputBytes + size <= maxBytes) { unreadableStylesheets.push(url); outputBytes += size; }
        else limits.outputLimitReached = true;
      }
    };
    for (const root of roots) for (const sheet of [...(root.styleSheets ?? []), ...(root.adoptedStyleSheets ?? [])]) scanSheet(sheet);
    const resources = performance.getEntriesByType("resource");
    limits.resourceLimitReached = resources.length > 5000;
    for (const entry of resources.slice(-5000)) {
      let path; try { path = new URL(entry.name).pathname.toLowerCase(); } catch { continue; }
      const kind = /\.(?:woff2?|ttf|otf)$/u.test(path) ? "font" : entry.initiatorType === "img" || /\.(?:png|jpe?g|gif|webp|svg|avif|ico)$/u.test(path) ? "image"
        : entry.initiatorType === "video" || /\.(?:mp4|webm|mov|m3u8)$/u.test(path) ? "video" : /\.css$/u.test(path) ? "stylesheet"
          : entry.initiatorType === "script" ? "script" : "other";
      add(kind, entry.name, { kind: "resource", initiatorType: String(entry.initiatorType).slice(0, 40) });
    }
    const page = urlInfo(location.href);
    const result = { schema: "aos.chrome_companion.page_assets.v1", id, pageUrl: page?.url ?? null, url: page?.url ?? null, pageUrlRedacted: page?.redacted ?? false, pageInstanceId,
      assets, inlineSvgs, summary: {},
      coverage: "current document declarations, computed styles, open shadow roots and observed resource timing; call again after loading more UI",
      limits, truncated: Object.values(limits).some(Boolean), unreadableStylesheets,
      explicitFetchesRequested: 0, resourceTimingMayBeIncomplete: true, shadowRootDiscoveryMayBeIncomplete: true, childFramesExpanded: false };
    const summarize = () => {
      const byKind = {}; for (const asset of assets) byKind[asset.kind] = (byKind[asset.kind] || 0) + 1;
      result.summary = { byKind, totalCount: assets.length, inlineSvgCount: inlineSvgs.length };
    };
    summarize();
    // Include metadata and multibyte URLs in the final serialized byte bound.
    // The incremental counter avoids retaining large entries; this handles
    // the remaining metadata overhead without returning a malformed payload.
    while (bytes(result) > maxBytes) {
      limits.outputLimitReached = true; result.truncated = true;
      if (inlineSvgs.length) inlineSvgs.pop();
      else if (unreadableStylesheets.length) unreadableStylesheets.pop();
      else if (assets.length) assets.pop();
      else throw operationError("page_assets_metadata_too_large", "Page identity exceeds the asset response byte limit");
      summarize();
    }
    return result;
  }
  if (action === "readNetwork") {
    const maxEntries = Math.min(Math.max(Number(payload.maxEntries ?? 100), 1), 200);
    const entries = performance.getEntriesByType("resource").slice(-maxEntries).map((entry) => ({
      name: String(entry.name).slice(0, 2_000),
      initiatorType: String(entry.initiatorType || "").slice(0, 80),
      duration: Number.isFinite(entry.duration) ? Math.round(entry.duration) : null,
      transferSize: Number.isFinite(entry.transferSize) ? entry.transferSize : null,
      encodedBodySize: Number.isFinite(entry.encodedBodySize) ? entry.encodedBodySize : null,
    }));
    return { entries, count: entries.length, source: "performance_resource_timing", historicalReplay: false, url: location.href, pageInstanceId };
  }
  if (action === "exportArtifact") {
    const format = payload.format === "html" ? "html" : "text";
    const base = await injectedPageOperation("exportContent", { format, maxChars: payload.maxChars });
    return { ...base, kind: "artifact_export", artifactName: String(payload.artifactName || "page-export").slice(0, 120), exportSchema: "aos.chrome_companion.artifact_export.v1" };
  }
  if (action === "measureScreenshotTarget") {
    if (globalThis.parent && globalThis.parent !== globalThis) {
      throw operationError("element_crop_frame_unsupported", "Element crops currently use the main frame; use a verified whole-tab region for a child frame");
    }
    const element = find(payload.locator);
    const rect = element.getBoundingClientRect();
    return { element: describe(element), documentRect: { x: rect.x + scrollX, y: rect.y + scrollY, width: rect.width, height: rect.height },
      url: location.href, pageInstanceId, frameId: 0 };
  }
  if (action === "inspectViewport") return { width: innerWidth, height: innerHeight, devicePixelRatio,
    scale: Number(globalThis.visualViewport?.scale ?? 1), url: location.href, pageInstanceId };
  if (action === "inspectVisualTarget") {
    const element = find(payload.locator);
    if (payload.scroll !== false) {
      // Use a synchronous scroll/layout read instead of a page timer, which
      // may be throttled for a background task tab. The broker still verifies
      // this geometry against the screenshot and again before input.
      element.scrollIntoView({ behavior: "instant", block: "center", inline: "center" });
    }
    const rect = element.getBoundingClientRect();
    const clipped = {
      left: Math.max(0, rect.left),
      top: Math.max(0, rect.top),
      right: Math.min(innerWidth, rect.right),
      bottom: Math.min(innerHeight, rect.bottom),
    };
    if (clipped.right <= clipped.left || clipped.bottom <= clipped.top) {
      throw operationError("visual_target_outside_viewport", "The semantic target is not visibly intersecting the current viewport");
    }
    const point = {
      x: Math.round((clipped.left + clipped.right) / 2),
      y: Math.round((clipped.top + clipped.bottom) / 2),
    };
    const mapping = frameCoordinateMap(point);
    if (!mapping.supported) {
      return {
        supported: false,
        exact_blocker: mapping.exact_blocker,
        message: "The frame is not safely accessible for coordinate conversion; use a frame-scoped semantic action instead of guessing a whole-tab point",
        url: location.href,
        topLevelUrl: null,
        pageInstanceId,
        frameLocalPoint: point,
        framePath: [],
        frameId: Number(payload.frameId ?? payload.locator?.frameId ?? 0),
        external_action_executed: false,
        operation_effect_state: "none",
        mutation_dispatch_attempted: false,
      };
    }
    if (payload.requireHitOwner === true) {
      let hit = document.elementFromPoint(point.x, point.y);
      while (hit?.shadowRoot) {
        const child = hit.shadowRoot.elementFromPoint?.(point.x, point.y);
        if (!child || child === hit) break;
        hit = child;
      }
      let owner = hit;
      while (owner && owner !== element) owner = owner.parentNode || owner.getRootNode?.().host;
      if (owner !== element) {
        throw operationError("visual_target_not_at_point", "The inspected point is covered by another element");
      }
    }
    // This token remains in the isolated world and identifies this exact DOM
    // object, not a selector that could silently resolve to a replacement.
    const semanticGuards = globalThis.__aosCompanionSemanticGuardsV1
      || (globalThis.__aosCompanionSemanticGuardsV1 = new Map());
    const guardId = crypto.randomUUID(), expiresAt = Date.now() + 30_000;
    for (const [key, record] of semanticGuards) if (record.expiresAt <= Date.now() || semanticGuards.size >= 128) semanticGuards.delete(key);
    semanticGuards.set(guardId, { element, expiresAt, pageInstanceId, url: location.href,
      state: JSON.stringify({ element: describe(element), mapping,
        viewport: { width: innerWidth, height: innerHeight, devicePixelRatio, scale: Number(globalThis.visualViewport?.scale ?? 1) } }) });
    return {
      supported: true,
      url: location.href,
      topLevelUrl: mapping.topLevelUrl,
      pageInstanceId,
      element: describe(element),
      rect: { x: rect.x, y: rect.y, width: rect.width, height: rect.height },
      clippedRect: { x: clipped.left, y: clipped.top, width: clipped.right - clipped.left, height: clipped.bottom - clipped.top },
      point: mapping.point,
      frameLocalPoint: point,
      framePath: mapping.framePath,
      coordinateSpace: mapping.coordinateSpace,
      viewport: mapping.viewport,
      scroll: mapping.scroll,
      frameViewport: { width: innerWidth, height: innerHeight, devicePixelRatio, scale: Number(globalThis.visualViewport?.scale ?? 1) },
      frameScroll: { x: Math.round(scrollX), y: Math.round(scrollY) },
      semanticGuard: { id: guardId, expiresAt, methods: ["page.click", "page.submit"] },
      external_action_executed: false,
      operation_effect_state: "none",
    };
  }
  if (action === "inspectVisualPoint") {
    const point = { x: Math.round(Number(payload.point?.x)), y: Math.round(Number(payload.point?.y)) };
    if (!Number.isFinite(point.x) || !Number.isFinite(point.y) || point.x < 0 || point.y < 0) {
      throw operationError("visual_point_invalid", "visual point requires bounded non-negative x/y");
    }
    const viewport = { width: innerWidth, height: innerHeight, devicePixelRatio, scale: Number(globalThis.visualViewport?.scale ?? 1) };
    if (point.x > viewport.width || point.y > viewport.height) {
      throw operationError("visual_point_outside_viewport", "The screenshot point is outside the current content viewport", {
        point,
        viewport,
      });
    }
    const hit = document.elementFromPoint(point.x, point.y);
    const canvas = hit?.tagName?.toLowerCase() === "canvas" ? hit : null;
    const canvasRect = canvas?.getBoundingClientRect();
    const frameElement = hit?.closest?.("iframe,frame");
    if (frameElement) {
      return {
        supported: false,
        exact_blocker: "visual_input_iframe_coordinate_space_unsupported",
        message: "The visual point falls on an iframe; use an exact frame-scoped semantic locator instead of guessing whole-tab coordinates",
        url: location.href,
        pageInstanceId,
        point,
        viewport,
        scroll: { x: Math.round(scrollX), y: Math.round(scrollY) },
        frameId: 0,
        external_action_executed: false,
        operation_effect_state: "none",
        mutation_dispatch_attempted: false,
      };
    }
    return {
      supported: true,
      url: location.href,
      pageInstanceId,
      point,
      viewport,
      scroll: { x: Math.round(scrollX), y: Math.round(scrollY) },
      rect: null,
      surfaceKind: canvas ? "canvas" : "dom",
      ...(canvasRect ? { surfaceRect: { x: canvasRect.x, y: canvasRect.y, width: canvasRect.width, height: canvasRect.height } } : {}),
      frameId: 0,
      external_action_executed: false,
      operation_effect_state: "none",
      mutation_dispatch_attempted: false,
    };
  }
  if (action === "inspectDropdown") {
    let control = null;
    try {
      control = find(payload.locator);
    } catch (error) {
      return {
        supported: null,
        controlKind: null,
        exact_blocker: error?.code ?? "semantic_locator_unresolved",
        cause: error instanceof Error ? error.message : String(error),
        candidates: error?.details?.candidates ?? [],
        next_action: "query_current_page_then_refine_locator_role_name_label",
        external_action_executed: false,
        operation_effect_state: "none",
        mutation_dispatch_attempted: false,
        mutation_dispatch_count: 0,
        effects_mode: "read_only",
        read_only_stage_bound: true,
        reconciliation_required: false,
        surface_handoff_candidate: false,
        url: location.href,
      };
    }
    const controlKind = dropdownControlKind(control);
    const optionState = controlKind ? dropdownOptions(control) : { options: [], controlled: false };
    return {
      supported: Boolean(controlKind),
      controlKind,
      exact_blocker: controlKind ? null : "companion_dropdown_control_unsupported",
      element: describe(control),
      frameId: Number.isSafeInteger(payload.locator?.frameId) ? payload.locator.frameId : 0,
      pageInstanceId,
      multiple: control instanceof HTMLSelectElement ? control.multiple : null,
      expanded: control.getAttribute("aria-expanded") === "true",
      loading: control.getAttribute("aria-busy") === "true"
        || control.matches?.("[data-loading='true'],[data-loading='loading'],[aria-busy='true']") === true,
      visibleOptionCount: optionState.options.length,
      visibleOptions: optionState.options.slice(0, 30).map((option) => ({ label: optionLabel(option), value: optionValue(option) })),
      ready: controlKind === "native_select" || optionState.options.length > 0,
      external_action_executed: false,
      operation_effect_state: "none",
      mutation_dispatch_attempted: false,
      mutation_dispatch_count: 0,
      effects_mode: "read_only",
      read_only_stage_bound: true,
      reconciliation_required: false,
      surface_handoff_candidate: !controlKind,
      url: location.href,
    };
  }
  if (action === "click") {
    const element = find(payload.locator);
    const guard = consumeSemanticGuard(element);
    const formSubmitControl = (
      element instanceof HTMLButtonElement
      && element.type === "submit"
      && Boolean(element.form)
    ) || (
      element instanceof HTMLInputElement
      && new Set(["submit", "image"]).has(element.type)
      && Boolean(element.form)
    );
    element.scrollIntoView({ block: "center", inline: "center" });
    visualize(element, "click");
    activateControl(element, guard);
    return {
      clicked: true,
      visualized: true,
      pointerAnimated: true,
      formSubmitControl,
      mutationDispatchAttempted: true,
      element: describe(element),
      url: location.href,
    };
  }
  if (action === "doubleClick") {
    const element = find(payload.locator);
    element.scrollIntoView({ block: "center", inline: "center" });
    element.focus();
    await visualize(element, "double click");
    const options = { bubbles: true, composed: true, cancelable: true, view: window, detail: 2 };
    element.dispatchEvent(new MouseEvent("mousedown", options));
    element.dispatchEvent(new MouseEvent("mouseup", options));
    element.dispatchEvent(new MouseEvent("click", options));
    element.dispatchEvent(new MouseEvent("mousedown", options));
    element.dispatchEvent(new MouseEvent("mouseup", options));
    element.dispatchEvent(new MouseEvent("click", options));
    element.dispatchEvent(new MouseEvent("dblclick", options));
    return { doubleClicked: true, visualized: true, trustedInput: false, element: describe(element), url: location.href };
  }
  if (action === "hover") {
    const element = find(payload.locator);
    element.scrollIntoView({ block: "center", inline: "center" });
    await visualize(element, "hover");
    const rect = element.getBoundingClientRect();
    const mouse = { bubbles: true, composed: true, cancelable: true, view: window, clientX: rect.left + rect.width / 2, clientY: rect.top + rect.height / 2 };
    element.dispatchEvent(new PointerEvent("pointerover", { ...mouse, pointerId: 1, pointerType: "mouse", isPrimary: true }));
    element.dispatchEvent(new MouseEvent("mouseover", mouse));
    element.dispatchEvent(new MouseEvent("mouseenter", { ...mouse, bubbles: false }));
    element.dispatchEvent(new MouseEvent("mousemove", mouse));
    return { hovered: true, visualized: true, trustedInput: false, element: describe(element), url: location.href };
  }
  if (action === "setChecked") {
    const element = find(payload.locator);
    const role = lower(element.getAttribute("role") || implicitRole(element));
    if (!(element instanceof HTMLInputElement && new Set(["checkbox", "radio"]).has(lower(element.type)))
      && !new Set(["checkbox", "radio", "switch"]).has(role)) {
      throw operationError("checked_control_required", "Matched element is not a checkbox, radio, or switch");
    }
    const requested = payload.checked !== false;
    element.scrollIntoView({ block: "center", inline: "center" });
    await visualize(element, requested ? "check" : "uncheck");
    const before = element instanceof HTMLInputElement ? element.checked : element.getAttribute("aria-checked") === "true";
    if (before !== requested) activateControl(element);
    const after = element instanceof HTMLInputElement ? element.checked : element.getAttribute("aria-checked") === "true";
    if (after !== requested) {
      throw operationError("checked_state_not_committed", "The control did not retain the requested checked state", { before, requested, after });
    }
    return { checked: after, changed: before !== after, visualized: true, trustedInput: false, element: describe(element), url: location.href };
  }
  if (action === "pressKey") {
    const key = String(payload.key ?? "");
    if (!allowedKey(key)) throw operationError("key_not_allowed", "The requested key is outside the bounded Companion key set", { key });
    const element = targetOrActive(payload.locator);
    if (element instanceof HTMLElement) element.focus();
    await visualize(element, `key ${key === " " ? "Space" : key}`);
    const options = { key, code: key.length === 1 ? `Key${key.toUpperCase()}` : key, bubbles: true, composed: true, cancelable: true };
    const keyDownAllowed = element.dispatchEvent(new KeyboardEvent("keydown", options));
    if (keyDownAllowed && new Set(["Enter", " ", "Space"]).has(key)
      && element.matches?.("button,a[href],input[type='button'],input[type='submit'],[role='button']")) {
      activateControl(element);
    }
    element.dispatchEvent(new KeyboardEvent("keyup", options));
    return { keyPressed: key, visualized: true, trustedInput: false, defaultPrevented: !keyDownAllowed, element: describe(element), url: location.href };
  }
  if (action === "selectText") {
    const element = find(payload.locator);
    if (!element.isContentEditable) {
      throw operationError("contenteditable_required", "page.selectText requires one visible contenteditable target");
    }
    const requested = String(payload.text ?? "");
    if (!requested || requested.length > 10_000) {
      throw operationError("selection_text_invalid", "page.selectText requires 1 to 10000 exact characters");
    }
    const occurrence = payload.occurrence == null ? null : Number(payload.occurrence);
    if (occurrence != null && (!Number.isSafeInteger(occurrence) || occurrence < 0 || occurrence > 99)) {
      throw operationError("selection_occurrence_invalid", "page.selectText occurrence must be an integer from 0 to 99");
    }
    const prefix = payload.prefix === undefined ? null : String(payload.prefix);
    const suffix = payload.suffix === undefined ? null : String(payload.suffix);
    if ([prefix, suffix].some(value => value !== null && (!value || value.length > 1_000))) {
      throw operationError("selection_context_invalid", "Selection prefix and suffix must contain 1 to 1000 exact characters");
    }
    // Compare only text-only highlight decoration as transparent. Every
    // semantic element retains its identity, attributes and child order.
    const semanticIds = new WeakMap();
    let nextSemanticId = 0;
    const isHighlight = (node) => node.nodeType === 1 && node.tagName === "SPAN"
      && node.attributes.length === 1 && node.getAttribute("class") === "highlight"
      && [...node.childNodes].every(child => child.nodeType === 3 || isHighlight(child));
    const structure = (node) => {
      const children = [];
      const append = (child) => {
        if (isHighlight(child)) { for (const nested of child.childNodes) append(nested); }
        else if (child.nodeType === 3) {
          const value = String(child.nodeValue ?? "");
          if (typeof children.at(-1) === "string") children[children.length - 1] += value;
          else if (value) children.push(value);
        } else children.push(structure(child));
      };
      for (const child of node.childNodes) append(child);
      if (!semanticIds.has(node)) semanticIds.set(node, ++nextSemanticId);
      return [semanticIds.get(node), node.nodeName, [...(node.attributes ?? [])].map(attribute => [attribute.name, attribute.value]), node.nodeType === 1 ? null : node.nodeValue, children];
    };
    const originalStructure = JSON.stringify(structure(element));
    const originalText = String(element.textContent ?? "");
    // innerText is Chromium's rendered text, including BR and paragraph
    // separators. Map its characters to actual editor nodes before touching
    // focus or selection. Never invent a newline-to-node correspondence.
    const fullText = String(element.innerText ?? "");
    const readTextNodes = () => {
      const walker = document.createTreeWalker(element, NodeFilter.SHOW_TEXT);
      const nodes = [];
      let rawText = "";
      while (walker.nextNode()) {
        const node = walker.currentNode;
        const style = getComputedStyle(node.parentElement);
        const probe = document.createRange();
        probe.selectNodeContents(node);
        if (style.display === "none" || ["hidden", "collapse"].includes(style.visibility) || probe.getClientRects().length === 0) continue;
        const start = rawText.length;
        rawText += String(node.nodeValue ?? "");
        nodes.push({ node, start, end: rawText.length });
      }
      return { nodes, rawText };
    };
    const { nodes, rawText } = readTextNodes();
    const starts = [];
    for (let index = fullText.indexOf(requested); index >= 0; index = fullText.indexOf(requested, index + 1)) {
      if (prefix !== null && !fullText.slice(0, index).endsWith(prefix)) continue;
      if (suffix !== null && !fullText.slice(index + requested.length).startsWith(suffix)) continue;
      starts.push(index);
      if (starts.length > 100) break;
    }
    if (starts.length === 0) {
      throw operationError("selection_text_not_found", "The requested exact text was not found in the contenteditable target");
    }
    if (occurrence == null && starts.length !== 1) {
      throw operationError("selection_text_ambiguous", `The requested exact text matched ${starts.length} ranges`, { matches: starts.length });
    }
    if (occurrence != null && occurrence >= starts.length) {
      throw operationError("selection_occurrence_invalid", `Selection occurrence ${occurrence} is outside ${starts.length} matches`, { matches: starts.length });
    }
    const startOffset = starts[occurrence ?? 0];
    const endOffset = startOffset + requested.length;
    const rawCharacters = [], renderedCharacters = [];
    for (let i = 0; i < rawText.length; i++) if (!/\s/u.test(rawText[i])) rawCharacters.push(i);
    for (let i = 0; i < fullText.length; i++) if (!/\s/u.test(fullText[i])) renderedCharacters.push(i);
    if (rawCharacters.length !== renderedCharacters.length
      || rawCharacters.some((at, index) => rawText[at] !== fullText[renderedCharacters[index]])) {
      throw operationError("selection_rendered_mapping_unavailable", "The rendered text cannot be mapped exactly to editor text nodes");
    }
    const point = (offset, end = false) => {
      const entry = nodes.find(item => end ? offset > item.start && offset <= item.end : offset >= item.start && offset < item.end);
      return entry ? { node: entry.node, offset: offset - entry.start } : null;
    };
    const startPoints = new Map(), endPoints = new Map();
    for (let i = 0; i < rawCharacters.length; i++) {
      startPoints.set(renderedCharacters[i], point(rawCharacters[i]));
      endPoints.set(renderedCharacters[i] + 1, point(rawCharacters[i] + 1, true));
    }
    for (let i = 0; i <= rawCharacters.length; i++) {
      const rawStart = i === 0 ? 0 : rawCharacters[i - 1] + 1;
      const rawEnd = i === rawCharacters.length ? rawText.length : rawCharacters[i];
      const renderedStart = i === 0 ? 0 : renderedCharacters[i - 1] + 1;
      const renderedEnd = i === renderedCharacters.length ? fullText.length : renderedCharacters[i];
      if (rawText.slice(rawStart, rawEnd) === fullText.slice(renderedStart, renderedEnd)) {
        for (let at = renderedStart; at <= renderedEnd; at++) {
          if (!startPoints.has(at)) startPoints.set(at, point(rawStart + at - renderedStart));
          if (!endPoints.has(at)) endPoints.set(at, point(rawStart + at - renderedStart, true));
        }
      } else if (/^\n+$/u.test(fullText.slice(renderedStart, renderedEnd)) && rawStart === rawEnd) {
        // A complete structural separator spans the previous text end and
        // next text start. A partial separator has no unambiguous DOM point.
        startPoints.set(renderedStart, point(rawStart, true));
        endPoints.set(renderedEnd, point(rawEnd));
      }
    }
    const startPoint = startPoints.get(startOffset), endPoint = endPoints.get(endOffset);
    if (!startPoint || !endPoint) throw operationError("selection_range_unavailable", "The exact selection boundary could not be bound to rendered editor text");
    const rawStartOffset = nodes.find(entry => entry.node === startPoint.node).start + startPoint.offset;
    const rawEndOffset = nodes.find(entry => entry.node === endPoint.node).start + endPoint.offset;
    const selection = globalThis.getSelection();
    if (!selection) throw operationError("selection_api_unavailable", "The page did not expose a document selection");
    element.scrollIntoView({ block: "center", inline: "center" });
    element.focus();
    await visualize(element, "select text");
    if (!element.isConnected || JSON.stringify(structure(element)) !== originalStructure
      || element.textContent !== originalText || element.innerText !== fullText) {
      selectionObservedChange = true;
      throw operationError("selection_editor_changed_before_dispatch", "The editor changed while preparing the selection; read the current editor before another operation");
    }
    // Focus handlers can split text into highlight spans. Rebind against the
    // current text nodes while keeping the original logical UTF-16 offsets.
    const prepared = readTextNodes();
    const reboundStart = prepared.nodes.find(entry => rawStartOffset >= entry.start && rawStartOffset < entry.end);
    const reboundEnd = prepared.nodes.find(entry => rawEndOffset > entry.start && rawEndOffset <= entry.end);
    if (prepared.rawText !== rawText || !reboundStart || !reboundEnd) throw operationError("selection_range_unavailable", "The exact selection could not be rebound after focus");
    const range = document.createRange();
    range.setStart(reboundStart.node, rawStartOffset - reboundStart.start);
    range.setEnd(reboundEnd.node, rawEndOffset - reboundEnd.start);
    selectionMutationAttempted = true;
    selection.removeAllRanges();
    selection.addRange(range);
    await wait(50);
    if (!element.isConnected || JSON.stringify(structure(element)) !== originalStructure
      || element.textContent !== originalText || element.innerText !== fullText) {
      selectionObservedChange = true;
      throw operationError("selection_editor_content_changed", "The editor changed after selection; do not format or retry without fresh readback");
    }
    const selected = String(selection.toString());
    const committedRange = selection.rangeCount === 1 ? selection.getRangeAt(0) : null;
    const current = readTextNodes();
    const logicalOffset = (container, offset) => {
      let total = 0, found = null;
      const visibleNodes = new Set(current.nodes.map(entry => entry.node));
      const visit = (node) => {
        if (node.nodeType === 3) {
          if (!visibleNodes.has(node)) return;
          if (node === container && offset >= 0 && offset <= node.nodeValue.length) found = total + offset;
          total += node.nodeValue.length;
        } else {
          for (let index = 0; index <= node.childNodes.length; index++) {
            if (node === container && index === offset) found = total;
            if (index < node.childNodes.length) visit(node.childNodes[index]);
          }
        }
      };
      visit(element);
      return found;
    };
    if (selected !== requested || !committedRange
      || current.rawText !== rawText
      || logicalOffset(committedRange.startContainer, committedRange.startOffset) !== rawStartOffset
      || logicalOffset(committedRange.endContainer, committedRange.endOffset) !== rawEndOffset) {
      throw operationError("selection_not_committed", "The editor did not retain the requested exact text selection");
    }
    return {
      selected: true,
      selectionCommitted: true,
      selectedTextLength: selected.length,
      occurrence: occurrence ?? 0,
      textSource: "rendered_inner_text",
      contextMatched: prefix !== null || suffix !== null,
      contentPreserved: true,
      visualized: true,
      trustedInput: false,
      mutationDispatchAttempted: true,
      element: describe(element),
      url: location.href,
    };
  }
  const richTextStructure = (element) => {
    const nodes = [...element.querySelectorAll("h1,h2,h3,h4,h5,h6,p,blockquote,pre,ul,ol,table,thead,tbody,tr,th,td")];
    const count = (selector) => nodes.filter((node) => node.matches(selector)).length;
    return {
      textLength: String(element.textContent ?? "").length,
      headingCount: count("h1,h2,h3,h4,h5,h6"),
      paragraphCount: count("p"),
      unorderedListCount: count("ul"),
      orderedListCount: count("ol"),
      tableCount: count("table"),
      tableRowCount: count("tr"),
      tableCellCount: count("th,td"),
      blockquoteCount: count("blockquote"),
      preformattedCount: count("pre"),
    };
  };
  const richTextCommand = (operation, blockTag) => {
    const normalized = String(operation ?? "").trim().toLowerCase();
    if (normalized === "heading" || normalized === "formatblock") {
      const tag = String(blockTag ?? "p").trim().toLowerCase();
      if (!new Set(["p", "h1", "h2", "h3", "h4", "h5", "h6", "blockquote", "pre"]).has(tag)) {
        throw operationError("rich_text_block_tag_invalid", "Rich-text formatBlock requires p, h1-h6, blockquote, or pre");
      }
      return { command: "formatBlock", value: tag };
    }
    const commands = {
      bold: ["bold", ""],
      italic: ["italic", ""],
      underline: ["underline", ""],
      unorderedlist: ["insertUnorderedList", ""],
      "unordered-list": ["insertUnorderedList", ""],
      orderedlist: ["insertOrderedList", ""],
      "ordered-list": ["insertOrderedList", ""],
      indent: ["indent", ""],
      outdent: ["outdent", ""],
      horizontalrule: ["insertHorizontalRule", ""],
      "horizontal-rule": ["insertHorizontalRule", ""],
    };
    const command = commands[normalized];
    if (!command) throw operationError("rich_text_operation_unsupported", "Unsupported generic rich-text operation", {
      operation,
      supported: ["bold", "italic", "underline", "heading", "unorderedList", "orderedList", "indent", "outdent", "horizontalRule"],
    });
    return { command: command[0], value: command[1] };
  };
  if (action === "richText") {
    let element = find(payload.locator);
    if (!element.isContentEditable) throw operationError("contenteditable_required", "page.richText requires one visible contenteditable editor");
    if (payload.operation === "splitParagraph") {
      // Small native editor operation, independent of clipboard and framework
      // DOM replacement. The exact current caret and whole body are preconditions.
      const body = String(element.textContent ?? "");
      const originalEditor = element;
      const selection = globalThis.getSelection?.();
      const expected = payload.expectedSelection;
      if (typeof payload.expectedBody !== "string" || payload.expectedBody !== body
        || payload.expectedFullBody !== body || !expected || expected.start !== expected.end
        || !Number.isSafeInteger(expected.start) || expected.start < 0 || expected.start > body.length
        || selection?.rangeCount !== 1) throw operationError("rich_text_split_guard_required", "Paragraph split requires the exact full textContent body and collapsed UTF-16 selection");
      const range = selection.getRangeAt(0).cloneRange();
      if (!range.collapsed || !element.contains(range.startContainer)) throw operationError("rich_text_caret_required", "Paragraph split requires a caret inside the exact editor");
      const prefix = document.createRange(); prefix.selectNodeContents(element); prefix.setEnd(range.startContainer, range.startOffset);
      if (prefix.toString().length !== expected.start) throw operationError("rich_text_selection_changed", "Paragraph split caret no longer matches its expected UTF-16 offset");
      const caretBinding = payload.expectedCaret;
      let boundNode = element;
      if (!caretBinding || !Array.isArray(caretBinding.path) || caretBinding.path.length > 32
        || !Number.isSafeInteger(caretBinding.offset) || caretBinding.offset < 0)
        throw operationError("rich_text_split_caret_guard_required", "Split requires a signed editor-relative childNodes path and DOM offset");
      for (const index of caretBinding.path) {
        if (!Number.isSafeInteger(index) || index < 0 || !boundNode?.childNodes?.[index])
          throw operationError("rich_text_split_caret_changed", "Signed caret path does not resolve in the current editor");
        boundNode = boundNode.childNodes[index];
      }
      if (boundNode !== range.startContainer || caretBinding.offset !== range.startOffset)
        throw operationError("rich_text_split_caret_changed", "Current DOM caret differs from its signed exact path and offset");
      if ([...element.childNodes].some(node => node.nodeType !== 1))
        throw operationError("rich_text_split_structure_unsupported", "Direct text nodes outside paragraphs are not supported");
      const parent = range.startContainer.nodeType === 3 ? range.startContainer.parentElement : range.startContainer;
      const paragraph = parent.closest?.("p");
      let inspectedNodes = 0;
      const supportedInline = (node, depth = 0) => {
        if (++inspectedNodes > 5000 || depth > 8) return false;
        if (node.nodeType === 3) return true;
        if (node.nodeType !== 1) return false;
        if (node.tagName === "BR") return node.childNodes.length === 0 && (node.attributes.length === 0
          // ProseMirror's empty terminal decoration is allowed only in this
          // direct paragraph. Its exact node/attribute signature is preserved.
          || node.parentElement === paragraph && node === paragraph.lastChild
            && node.attributes.length === 1 && node.attributes[0].name === "class"
            && node.attributes[0].value === "ProseMirror-trailingBreak");
        if (node.attributes.length !== 0) return false;
        return ["B", "STRONG", "I", "EM", "U"].includes(node.tagName)
          && node.childNodes.length > 0 && [...node.childNodes].every(child => supportedInline(child, depth + 1));
      };
      if (!paragraph || !paragraph.isContentEditable || paragraph.parentElement !== element || ![...paragraph.childNodes].every(node => supportedInline(node))) {
        throw operationError("rich_text_split_structure_unsupported", "Split supports one direct paragraph with text, BR, and attribute-free B/STRONG/I/EM/U marks only");
      }
      // Native Chrome insertParagraph at a P/BR boundary can insert a BR
      // instead of splitting or add a trailing placeholder. Only the tested
      // text-node boundary is eligible; no caret establishment or DOM writes.
      if (range.startContainer.nodeType !== 3 || range.startOffset === 0)
        throw operationError("rich_text_split_dom_boundary_unsupported", "Split requires an exact text-node caret after at least one UTF-16 unit");
      const paragraphs = [...element.children];
      const index = paragraphs.indexOf(paragraph);
      const outside = paragraphs.filter(node => node !== paragraph).map(node => node.outerHTML);
      const localPrefix = document.createRange(); localPrefix.selectNodeContents(paragraph); localPrefix.setEnd(range.startContainer, range.startOffset);
      const leftText = localPrefix.toString(), rightText = String(paragraph.textContent).slice(leftText.length);
      if (!leftText || !rightText || /[\uD800-\uDBFF]$/u.test(leftText)) throw operationError("rich_text_split_boundary_unsupported", "Split requires an interior caret at a complete Unicode code point");
      // A textContent offset alone cannot distinguish positions between BRs.
      // Bind the complete current HTML as well as the exact live DOM caret.
      if (paragraph.children.length && payload.expectedEditorHtml !== element.innerHTML)
        throw operationError("rich_text_split_html_guard_required", "Line-break or inline-mark paragraphs require exact current editor HTML");
      const nodeSignature = node => node.nodeType === 3 ? ["text", node.nodeValue] :
        [({ B: "STRONG", I: "EM" })[node.tagName] ?? node.tagName, [...node.attributes].map(a => [a.name, a.value]).sort(), [...node.childNodes].map(nodeSignature)];
      const fragmentSignature = fragment => {
        const runs = [];
        for (const node of fragment.childNodes) {
          const signature = nodeSignature(node);
          if (signature[0] === "text") {
            if (!signature[1]) continue;
            if (runs.at(-1)?.[0] === "text") { runs.at(-1)[1] += signature[1]; continue; }
          }
          runs.push(signature);
        }
        return JSON.stringify(runs);
      };
      const leftRange = document.createRange(); leftRange.selectNodeContents(paragraph); leftRange.setEnd(range.startContainer, range.startOffset);
      const rightRange = document.createRange(); rightRange.selectNodeContents(paragraph); rightRange.setStart(range.startContainer, range.startOffset);
      const leftContent = fragmentSignature(leftRange.cloneContents()), rightContent = fragmentSignature(rightRange.cloneContents());
      const paragraphAttributes = JSON.stringify([...paragraph.attributes].map(a => [a.name, a.value]).sort());
      const html = element.innerHTML;
      element.focus(); await visualize(element, "split paragraph");
      if (!element.isConnected || element.innerHTML !== html || selection.rangeCount !== 1
        || !selection.getRangeAt(0).collapsed || selection.getRangeAt(0).startContainer !== range.startContainer
        || selection.getRangeAt(0).startOffset !== range.startOffset) throw operationError("rich_text_editor_changed_before_dispatch", "Body or selection changed before paragraph split");
      if (typeof document.execCommand !== "function") throw operationError("rich_text_command_unavailable", "This editor does not expose native paragraph insertion");
      richTextMutationAttempted = true;
      const executed = document.execCommand("insertParagraph", false, null);
      // Frameworks may commit after the browser event. Observe the one dispatch
      // for a bounded interval; never send insertParagraph again.
      for (let read = 0; read < 10; read++) {
        await wait(read === 0 ? 75 : 50);
        element = find(payload.locator);
        if (element !== originalEditor || String(element.textContent ?? "") !== body)
          throw operationError("rich_text_split_not_committed", "Paragraph split changed the exact editor or full body; do not repeat it");
        if (element.children.length === paragraphs.length + 1) break;
        if (element.innerHTML !== html)
          throw operationError("rich_text_split_not_committed", "Paragraph split produced an unexpected intermediate structure; do not repeat it");
      }
      const after = [...element.children];
      if (element !== originalEditor || [...element.childNodes].some(node => node.nodeType !== 1) || String(element.textContent ?? "") !== body || after.length !== paragraphs.length + 1
        || after[index]?.tagName !== "P" || after[index + 1]?.tagName !== "P"
        || after[index].textContent !== leftText || after[index + 1].textContent !== rightText
        || fragmentSignature(after[index]) !== leftContent || fragmentSignature(after[index + 1]) !== rightContent
        || JSON.stringify([...after[index].attributes].map(a => [a.name, a.value]).sort()) !== paragraphAttributes
        || JSON.stringify([...after[index + 1].attributes].map(a => [a.name, a.value]).sort()) !== paragraphAttributes
        || JSON.stringify(after.filter((_, at) => at !== index && at !== index + 1).map(node => node.outerHTML)) !== JSON.stringify(outside)) {
        throw operationError("rich_text_split_not_committed", "Paragraph split readback did not preserve the full body and outside blocks; do not repeat it", { commandReturned: Boolean(executed) });
      }
      const committedSelection = globalThis.getSelection?.();
      const committedRange = committedSelection?.rangeCount === 1 ? committedSelection.getRangeAt(0) : null;
      if (!committedRange?.collapsed || !after[index + 1].contains(committedRange.startContainer))
        throw operationError("rich_text_split_selection_not_committed", "Paragraph split caret did not move into the right paragraph; do not repeat");
      const committedPrefix = document.createRange(); committedPrefix.selectNodeContents(after[index + 1]);
      committedPrefix.setEnd(committedRange.startContainer, committedRange.startOffset);
      const emptyCaretPrefix = node => node.nodeType === 3 ? node.nodeValue.length === 0 :
        node.nodeType === 1 && ["B", "STRONG", "I", "EM", "U"].includes(node.tagName) && node.attributes.length === 0
          && [...node.childNodes].every(emptyCaretPrefix);
      if (committedPrefix.toString().length !== 0 || ![...committedPrefix.cloneContents().childNodes].every(emptyCaretPrefix))
        throw operationError("rich_text_split_selection_not_committed", "Paragraph split caret is not at the exact right paragraph start; do not repeat");
      return { edited: true, command: "insertParagraph", paragraphSplitVerified: true, fullBodyVerified: true,
        contentPreserved: true, outsideSelectionPreserved: true, clipboardUsed: false, offsetUnit: "utf16",
        mutationDispatchAttempted: true, structure: richTextStructure(element), url: location.href };
    }
    const before = richTextStructure(element);
    if (payload.operation === "inspect") return { inspected: true, structure: before, selectedText: String(globalThis.getSelection?.()?.toString?.() ?? ""), element: describe(element), url: location.href };
    const { command, value } = richTextCommand(payload.operation, payload.blockTag);
    const blockSelector = "p,div,h1,h2,h3,h4,h5,h6,blockquote,pre,li,td,th";
    const snapshot = (editor) => {
      const blocks = [...editor.querySelectorAll(blockSelector)].filter(node => !node.querySelector(blockSelector));
      if (!blocks.length) blocks.push(editor);
      const text = String(editor.textContent ?? "");
      const offset = (node, at = 0) => { const prefix = document.createRange(); prefix.selectNodeContents(editor); prefix.setEnd(node, at); return prefix.toString().length; };
      const attributes = node => [...node.attributes].map(a => [a.name, a.value]).sort(([a], [b]) => a.localeCompare(b));
      const records = blocks.map(node => ({ node, start: offset(node), end: offset(node, node.childNodes.length), text: String(node.textContent ?? ""), tag: node.tagName.toLowerCase(), content: node.innerHTML, lists: { ol: Boolean(node.closest("ol")), ul: Boolean(node.closest("ul")) }, quoteDepth: (() => { let depth = 0; for (let p = node.parentElement; p && p !== editor; p = p.parentElement) if (p.tagName === "BLOCKQUOTE") depth += 1; return depth; })() }));
      const runs = [];
      const walk = (node, path = []) => {
        if (node.nodeType === Node.TEXT_NODE) {
          const parent = node.parentElement;
          const style = getComputedStyle(parent);
          const decorations = [parent, ...path.map(p => p.node)].some(n => getComputedStyle(n).textDecorationLine.includes("underline"));
          runs.push({ start: offset(node), end: offset(node, node.length), text: node.nodeValue, path,
            marks: { bold: Number.parseInt(style.fontWeight, 10) >= 600 || style.fontWeight === "bold", italic: style.fontStyle === "italic" || style.fontStyle === "oblique", underline: decorations } });
          return;
        }
        if (node.nodeType !== Node.ELEMENT_NODE) return;
        const nextPath = node === editor ? path : [...path, { node, tag: node.tagName.toLowerCase(), attributes: attributes(node) }];
        if (!node.childNodes.length && node !== editor) runs.push({ start: offset(node), end: offset(node), text: "", path: nextPath, empty: true });
        for (const child of node.childNodes) walk(child, nextPath);
      };
      walk(editor);
      for (const record of records) {
        const tokens = [];
        for (const run of runs.filter(run => run.path.some(part => part.node === record.node) || record.node === editor)) {
          const boundary = run.path.findIndex(part => part.node === record.node);
          const path = run.path.slice(boundary + 1);
          // Chromium may move a BR into an adjacent anchor while preserving
          // every linked character and the same break position.
          const semanticPath = run.empty && path.at(-1)?.tag === "br" ? [path.at(-1)] : path;
          const signature = JSON.stringify(semanticPath.map(({ tag, attributes }) => [({ b: "strong", i: "em" })[tag] ?? tag, attributes]));
          const previous = tokens.at(-1);
          if (!run.empty && previous && !previous.empty && previous.signature === signature) previous.text += run.text;
          else tokens.push({ text: run.text, signature, empty: Boolean(run.empty) });
        }
        record.content = JSON.stringify(tokens);
      }
      return { element: editor, text, records, runs, html: editor.innerHTML, offset };
    };
    const original = snapshot(element);
    const selection = globalThis.getSelection?.();
    if (!selection) throw operationError("selection_api_unavailable", "The editor did not expose a document selection");
    let range;
    if (payload.text !== undefined) {
      const requested = String(payload.text ?? "");
      if (!requested || requested.length > 10_000) throw operationError("selection_text_invalid", "page.richText text must contain 1 to 10000 exact characters");
      const occurrence = payload.occurrence == null ? null : Number(payload.occurrence);
      if (occurrence != null && (!Number.isSafeInteger(occurrence) || occurrence < 0 || occurrence > 99)) throw operationError("selection_occurrence_invalid", "page.richText occurrence must be an integer from 0 to 99");
      const starts = [];
      for (let index = original.text.indexOf(requested); index >= 0; index = original.text.indexOf(requested, index + 1)) {
        starts.push(index);
        if (starts.length > 100) break;
      }
      if (!starts.length) throw operationError("selection_text_not_found", "The requested exact text was not found in the rich-text editor");
      if (occurrence == null && starts.length !== 1) throw operationError("selection_text_ambiguous", `The requested exact text matched ${starts.length} ranges`, { matches: starts.length });
      if (occurrence != null && occurrence >= starts.length) throw operationError("selection_occurrence_invalid", "The requested occurrence is outside the matching ranges", { matches: starts.length });
      const start = starts[occurrence ?? 0], end = start + requested.length;
      const walker = document.createTreeWalker(element, NodeFilter.SHOW_TEXT);
      let position = 0;
      range = document.createRange();
      while (walker.nextNode()) {
        const node = walker.currentNode, next = position + node.length;
        if (start >= position && start < next) range.setStart(node, start - position);
        if (end > position && end <= next) range.setEnd(node, end - position);
        position = next;
      }
    } else {
      if (selection.rangeCount !== 1) throw operationError("rich_text_selection_required", "Select one range inside the exact editor before formatting");
      range = selection.getRangeAt(0).cloneRange();
    }
    if (![range.startContainer, range.endContainer].every(node => node === element || element.contains(node))) {
      throw operationError("rich_text_selection_outside_editor", "The selected range must belong entirely to the exact editor");
    }
    const start = original.offset(range.startContainer, range.startOffset), end = original.offset(range.endContainer, range.endOffset);
    const selectedText = range.toString();
    const selectedBlocks = original.records.filter(record => range.collapsed
      ? record.node === range.startContainer || record.node.contains(range.startContainer)
      : record.end > start && record.start < end || record.start === record.end && range.intersectsNode(record.node));
    const wholeBlock = command === "formatBlock" || command.includes("List") || command === "indent" || command === "outdent";
    if (wholeBlock && (!selectedBlocks.length || (!range.collapsed && selectedBlocks.some(record => start > record.start || end < record.end))
      || original.records.map(record => record.text).join("") !== original.text)) {
      throw operationError("rich_text_block_boundary_required", "This operation formats complete existing blocks; select whole blocks or split the block explicitly first");
    }
    if (command === "formatBlock" && selectedBlocks.length > 1) {
      throw operationError("rich_text_multiple_block_format_unsupported", "Select one existing block at a time; this browser command can merge multiple blocks into one heading");
    }
    if (command === "insertHorizontalRule" && !range.collapsed) throw operationError("rich_text_caret_required", "Place a caret before inserting a horizontal rule so existing text is not replaced");
    if (range.collapsed && !wholeBlock && command !== "insertHorizontalRule") {
      throw operationError("rich_text_selection_required", "Select actual text to verify this formatting operation");
    }
    const affectedStart = wholeBlock ? selectedBlocks[0].start : start;
    const affectedEnd = wholeBlock ? selectedBlocks.at(-1).end : end;
    const selectedIndices = selectedBlocks.map(block => original.records.indexOf(block));
    // Preserve outside text and its semantic ancestry, including empty blocks,
    // links, breaks and embedded elements. Merge harmless text-node splits.
    const outside = (state) => {
      const tokens = [];
      const append = (text, path, empty) => {
        const signature = JSON.stringify(path.map(({ tag, attributes }) => [tag, attributes]));
        const previous = tokens.at(-1);
        if (!empty && previous && !previous.empty && previous.signature === signature) previous.text += text;
        else tokens.push({ text, signature, empty: Boolean(empty) });
      };
      for (const run of state.runs) {
        if (run.empty) {
          if (command === "insertHorizontalRule" && run.path.at(-1)?.tag === "hr" && run.start === start) continue;
          if (command.includes("List") && run.path.at(-1)?.tag === "br" && run.start === affectedEnd) continue;
          const index = state.records.findIndex(record => record.node === run.path.at(-1)?.node || record.node.contains(run.path.at(-1)?.node));
          if (!(wholeBlock && selectedIndices.includes(index)) && !(run.start > affectedStart && run.start < affectedEnd)) append("", run.path, true);
        } else {
          if (run.start < affectedStart) append(run.text.slice(0, Math.min(run.end, affectedStart) - run.start), run.path);
          if (run.end > affectedEnd) append(run.text.slice(Math.max(run.start, affectedEnd) - run.start), run.path);
        }
      }
      return JSON.stringify(tokens);
    };
    const beforeOutside = outside(original);
    const activeRuns = original.runs.filter(run => !run.empty && run.end > affectedStart && run.start < affectedEnd);
    const toggleBefore = ["bold", "italic", "underline"].includes(command) && activeRuns.length > 0 && activeRuns.every(run => run.marks[command]);
    const requestedTagPresent = state => selectedIndices.every(index => state.records[index]?.tag === value)
      && state.records.length === original.records.length;
    if (command === "formatBlock" && requestedTagPresent(original)) return { edited: false, alreadySatisfied: true, command, selectedText, structureCommitted: true, structure: before, before, trustedInput: false, mutationDispatchAttempted: false, operationEffectState: "none", element: describe(element), url: location.href };
    element.focus();
    await visualize(element, `rich text ${String(payload.operation ?? command)}`);
    if (!element.isConnected || element.innerHTML !== original.html) {
      richTextObservedChange = true;
      throw operationError("rich_text_editor_changed_before_dispatch", "The editor changed while preparing the selection; read the current editor before another operation");
    }
    selection.removeAllRanges();
    selection.addRange(range);
    if (selection.rangeCount !== 1 || selection.getRangeAt(0).toString() !== selectedText
      || original.offset(selection.getRangeAt(0).startContainer, selection.getRangeAt(0).startOffset) !== start
      || original.offset(selection.getRangeAt(0).endContainer, selection.getRangeAt(0).endOffset) !== end) {
      throw operationError("selection_not_committed", "The editor did not retain the exact range before formatting");
    }
    let inputObserved = false;
    const onInput = event => { if (event.target === element || element.contains(event.target)) inputObserved = true; };
    document.addEventListener("input", onInput, true);
    let executed;
    try {
      if (typeof document.execCommand !== "function") throw operationError("rich_text_command_unavailable", "This document does not expose a rich-text formatting command");
      richTextMutationAttempted = true;
      executed = document.execCommand(command, false, value);
      if (!inputObserved) element.dispatchEvent(new InputEvent("input", { bubbles: true, composed: true, inputType: command === "formatBlock" ? "formatBlock" : `format${command[0].toUpperCase()}${command.slice(1)}` }));
      element.dispatchEvent(new Event("change", { bubbles: true, composed: true }));
      // Read after native/synthetic events and framework handlers, not before.
      await wait(75);
    } finally { document.removeEventListener("input", onInput, true); }
    let final, after, committed = false;
    for (let read = 0; read < 10; read++) {
    if (read > 0) await wait(50);
    element = find(payload.locator);
    if (element !== original.element) throw operationError("rich_text_editor_changed_after_dispatch", "The exact editor was replaced; do not repeat the formatting");
    final = snapshot(element); after = richTextStructure(element);
    if (final.text !== original.text) throw operationError("rich_text_content_changed", "The editor text changed during formatting; do not retry this operation", { command, before, after });
    if (outside(final) !== beforeOutside) throw operationError("rich_text_outside_selection_changed", "Content or structure outside the selected blocks changed; do not retry this operation", { command, before, after });
    if (command === "formatBlock") committed = requestedTagPresent(final)
      && selectedIndices.every(index => final.records[index]?.start === original.records[index].start && final.records[index]?.end === original.records[index].end && final.records[index]?.content === original.records[index].content);
    else if (["bold", "italic", "underline"].includes(command)) {
      const runs = final.runs.filter(run => !run.empty && run.end > start && run.start < end);
      committed = runs.length > 0 && runs.every(run => run.marks[command] === !toggleBefore);
    } else if (command.includes("List")) {
      const tag = command === "insertOrderedList" ? "ol" : "ul";
      const hadList = selectedBlocks.every(record => record.lists[tag]);
      const runs = final.runs.filter(run => !run.empty && run.end > affectedStart && run.start < affectedEnd);
      committed = runs.length > 0 && runs.every(run => run.path.some(part => part.tag === tag) === !hadList);
    } else if (command === "insertHorizontalRule") committed = element.querySelectorAll("hr").length === original.runs.filter(run => run.empty && run.path.at(-1)?.tag === "hr").length + 1;
    else committed = final.html !== original.html && selectedIndices.some(index => {
      const old = original.records[index], current = final.records[index];
      return old && current && (command === "indent" ? current.quoteDepth > old.quoteDepth : current.quoteDepth < old.quoteDepth);
    });
    if (committed) break;
    }
    if (!committed) throw operationError("rich_text_command_not_committed", "The final editor DOM does not contain the requested formatting", { command, before, after, commandReturned: Boolean(executed) });
    return { edited: true, command, selectedText, structureCommitted: true, fullBodyVerified: true, contentPreserved: true, outsideSelectionPreserved: true, verification: "post_event_dom", structure: after, before, visualized: true, trustedInput: false, mutationDispatchAttempted: true, element: describe(element), url: location.href };
  }
  if (action === "scroll") {
    const direction = String(payload.direction ?? "down").toLowerCase();
    if (!new Set(["up", "down", "left", "right"]).has(direction)) {
      throw operationError("scroll_direction_invalid", "Scroll direction must be up, down, left, or right");
    }
    const amount = Math.min(Math.max(Number.isFinite(Number(payload.amount)) ? Math.round(Math.abs(Number(payload.amount))) : 600, 1), 10_000);
    const element = targetOrActive(payload.locator);
    if (payload.locator) {
      element.scrollIntoView({ block: "center", inline: "center" });
      await visualize(element, `scroll ${direction}`);
    }
    const horizontal = direction === "left" || direction === "right";
    const signed = new Set(["up", "left"]).has(direction) ? -amount : amount;
    const scrollingElement = element === document.body ? document.scrollingElement : element;
    const before = { x: scrollingElement?.scrollLeft ?? scrollX, y: scrollingElement?.scrollTop ?? scrollY };
    if (scrollingElement && scrollingElement !== document.scrollingElement) {
      scrollingElement.scrollBy({ left: horizontal ? signed : 0, top: horizontal ? 0 : signed, behavior: "instant" });
    } else {
      window.scrollBy({ left: horizontal ? signed : 0, top: horizontal ? 0 : signed, behavior: "instant" });
    }
    await wait(50);
    const after = { x: scrollingElement?.scrollLeft ?? scrollX, y: scrollingElement?.scrollTop ?? scrollY };
    return { scrolled: true, direction, amount, before, after, visualized: Boolean(payload.locator), trustedInput: false, url: location.href };
  }
  if (action === "selectOption") {
    let visibilityInterrupted = payload.requireVisible === true && document.visibilityState !== "visible";
    const onSelectionVisibility = () => { if (document.visibilityState !== "visible") visibilityInterrupted = true; };
    const assertSelectionVisible = () => {
      if (payload.requireVisible === true && (visibilityInterrupted || document.visibilityState !== "visible")) {
        throw operationError("dropdown_selection_visibility_changed", "The dropdown tab became hidden before selection dispatch");
      }
    };
    if (payload.requireVisible === true) document.addEventListener("visibilitychange", onSelectionVisibility);
    try {
      assertSelectionVisible();
      const control = find(payload.locator);
      const selectionSetRequested = Array.isArray(payload.option);
      if (selectionSetRequested && (!(control instanceof HTMLSelectElement) || control.multiple !== true)) {
        throw nativeSelectionError("dropdown_option_array_unsupported", "An option array is supported only for a native select with multiple=true", {
          controlKind: dropdownControlKind(control),
          multiple: control instanceof HTMLSelectElement ? control.multiple : null,
        });
      }
      const specification = selectionSetRequested ? null : requestedOption(payload.option);
      const exact = payload.exact !== false;
      const timeoutMs = Math.min(Math.max(payload.timeoutMs ?? 5_000, 250), 15_000);
      if (!(control instanceof HTMLSelectElement)) {
        control.scrollIntoView({ block: "center", inline: "center" });
        await visualize(control, "select");
      }

      if (control instanceof HTMLSelectElement) {
        const allOptions = [...control.options];
        if (nativeControlDisabled(control)) {
          throw nativeSelectionError("dropdown_control_disabled", "The native select is disabled and cannot be changed", {
            controlKind: "native_select",
            multiple: control.multiple,
          });
        }
        const requestedOptions = selectionSetRequested
          ? []
          : [chooseOption(allOptions, specification, exact)];
        if (selectionSetRequested) {
          for (let requestedIndex = 0; requestedIndex < payload.option.length; requestedIndex += 1) {
            const requestedSpec = requestedOption(payload.option[requestedIndex]);
            const option = chooseOption(allOptions, requestedSpec, exact);
            if (nativeOptionDisabled(option, control)) {
              throw nativeSelectionError("dropdown_option_disabled", "The requested native select option is disabled", {
                requested: requestedSpec,
                option: nativeOptionReport(option),
                requestedIndex,
              });
            }
            if (!requestedOptions.includes(option)) requestedOptions.push(option);
          }
        } else if (nativeOptionDisabled(requestedOptions[0], control)) {
          throw nativeSelectionError("dropdown_option_disabled", "The requested native select option is disabled", {
            requested: specification,
            option: nativeOptionReport(requestedOptions[0]),
          });
        }
        const optionRecords = allOptions.map((option) => ({
          option,
          index: option.index,
          value: option.value,
          label: optionLabel(option),
          disabled: nativeOptionDisabled(option, control),
        }));
        const requestedSet = new Set(requestedOptions);
        if (selectionSetRequested) {
          const disabledToToggle = allOptions.find((option) => option.selected !== requestedSet.has(option)
            && nativeOptionDisabled(option, control));
          if (disabledToToggle) {
            throw nativeSelectionError("dropdown_option_disabled", "Exact native select replacement would toggle a disabled option", {
              requestedSelection: requestedOptions.map(nativeOptionReport),
              option: nativeOptionReport(disabledToToggle),
              reason: "disabled_option_would_change",
            });
          }
        }
        const selectedOptions = () => [...control.options].filter((option) => option.selected);
        const reports = (options) => options.map(nativeOptionReport);
        const optionRecordsStable = (currentOptions) => currentOptions.length === optionRecords.length
          && optionRecords.every((record, index) => {
            const current = currentOptions[index];
            return current === record.option
              && current.index === record.index
              && current.value === record.value
              && optionLabel(current) === record.label;
          });
        const optionDisabledStateStable = (currentOptions) => optionRecordsStable(currentOptions)
          && optionRecords.every((record, index) => nativeOptionDisabled(currentOptions[index], control) === record.disabled);
        const assertNativeTargetStable = () => {
          if (!control.isConnected || control.ownerDocument !== document) {
            throw nativeSelectionError("dropdown_selection_target_changed", "The native select changed before selection dispatch", {
              controlReplaced: true,
              requestedSelection: reports(requestedOptions),
              actualSelection: [],
            });
          }
          const currentOptions = [...control.options];
          const stable = optionRecordsStable(currentOptions);
          const disabledStateStable = optionDisabledStateStable(currentOptions);
          if (!stable || !disabledStateStable || (selectionSetRequested && control.multiple !== true)) {
            throw nativeSelectionError("dropdown_selection_target_changed", "The native select or its options changed before selection dispatch", {
              optionsStable: stable,
              disabledStateStable,
              multiple: control.multiple,
              requestedSelection: reports(requestedOptions),
              actualSelection: reports(currentOptions.filter((option) => option.selected)),
            });
          }
          if (nativeControlDisabled(control)) {
            throw nativeSelectionError("dropdown_control_disabled", "The native select became disabled before selection dispatch", {
              controlKind: "native_select",
              multiple: control.multiple,
            });
          }
          return currentOptions;
        };
        control.scrollIntoView({ block: "center", inline: "center" });
        await visualize(control, "select");
        assertNativeTargetStable();
        const readback = (phase, { requireMultiple = selectionSetRequested } = {}) => {
          if (!control.isConnected || control.ownerDocument !== document) {
            throw nativeSelectionPostError("Native select was detached during selection", {
              phase,
              controlReplaced: true,
              requestedSelection: reports(requestedOptions),
              actualSelection: [],
            });
          }
          // Re-read the original node by identity. Re-running a locator that
          // contains a pre-effect state predicate could reject the same
          // connected control after its selection legitimately changed.
          const currentOptions = [...control.options];
          const optionsStable = optionRecordsStable(currentOptions);
          const actual = currentOptions.filter((option) => option.selected);
          const selectionMatches = (!requireMultiple || control.multiple === true)
            && actual.length === requestedSet.size
            && actual.every((option) => requestedSet.has(option));
          if (!optionsStable || !selectionMatches) {
            throw nativeSelectionPostError("Native select did not retain the complete requested selection set", {
              phase,
              optionsStable,
              selectionMatches,
              requestedSelection: reports(requestedOptions),
              actualSelection: reports(actual),
              multiple: control.multiple,
            });
          }
          return actual;
        };
        if (selectionSetRequested) {
          const before = selectedOptions();
          const alreadySatisfied = before.length === requestedSet.size && before.every((option) => requestedSet.has(option));
          if (alreadySatisfied) {
            const actualSelection = reports(before);
            return {
              selected: true,
              selectionCommitted: true,
              selectionSet: true,
              alreadySatisfied: true,
              controlKind: "native_select",
              visualized: true,
              element: describe(control),
              requestedSelection: reports(requestedOptions),
              actualSelection,
              readback: { selectedOptions: actualSelection, values: actualSelection.map((option) => option.value), selectedText: actualSelection[0]?.label ?? "", value: control.value },
              url: location.href,
            };
          }
          selectionMutationAttempted = true;
          for (const option of allOptions) {
            const shouldBeSelected = requestedSet.has(option);
            if (option.selected !== shouldBeSelected) option.selected = shouldBeSelected;
          }
          readback("before_input");
          control.dispatchEvent(new Event("input", { bubbles: true, composed: true }));
          await wait(50);
          readback("after_input");
          control.dispatchEvent(new Event("change", { bubbles: true, composed: true }));
          await wait(50);
          const actual = readback("after_change");
          const actualSelection = reports(actual);
          return {
            selected: true,
            selectionCommitted: true,
            selectionSet: true,
            controlKind: "native_select",
            visualized: true,
            element: describe(control),
            requestedSelection: reports(requestedOptions),
            actualSelection,
            readback: { selectedOptions: actualSelection, values: actualSelection.map((option) => option.value), selectedText: actualSelection[0]?.label ?? "", value: control.value },
            url: location.href,
          };
        }
        const option = requestedOptions[0];
        const setter = Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, "value")?.set;
        selectionMutationAttempted = true;
        if (setter) setter.call(control, option.value);
        else control.value = option.value;
        option.selected = true;
        const readbackSingle = (phase) => {
          const actual = readback(phase, { requireMultiple: false });
          if (actual.length !== 1 || actual[0] !== option || actual[0].value !== option.value) {
            throw nativeSelectionPostError("Native select did not retain the requested option", {
              phase,
              requested: specification,
              option: nativeOptionReport(option),
              actualSelection: reports(actual),
            });
          }
          return actual[0];
        };
        // The legacy object path retains its single-option result shape while
        // using the same identity-bound post-event readback as selection sets.
        control.dispatchEvent(new Event("input", { bubbles: true, composed: true }));
        await wait(50);
        readbackSingle("after_input");
        control.dispatchEvent(new Event("change", { bubbles: true, composed: true }));
        await wait(50);
        const selected = readbackSingle("after_change");
        return {
          selected: true,
          selectionCommitted: true,
          controlKind: "native_select",
          visualized: true,
          element: describe(control),
          option: { label: optionLabel(option), value: optionValue(option), index: option.index },
          readback: { selectedText: optionLabel(selected), value: selected.value },
          url: location.href,
        };
      }

      const detectedControlKind = dropdownControlKind(control);
      if (!detectedControlKind) {
        throw operationError("dropdown_control_unsupported", "Matched control is not a native select or an identifiable custom dropdown", {
          element: describe(control),
        });
      }

      let selectionHost = control;
      for (let depth = 0; selectionHost.parentElement && depth < 3; depth += 1) {
        selectionHost = selectionHost.parentElement;
      }
      const beforeText = normalize(selectionHost.innerText || selectionHost.textContent);
      const beforeValue = normalize(control.value || control.innerText || control.textContent);
      assertSelectionVisible();
      if (control.getAttribute("aria-expanded") !== "true") activateControl(control);

      const deadline = Date.now() + timeoutMs;
      let available = { options: [], controlled: false };
      let option = null, matchingError = null;
      const scrollSearch = { attempted: false, steps: 0, maxSteps: 64, scope: "associated_popup_rendered_options" };
      const scrollStates = new WeakMap();
      const advanceDropdown = async () => {
        // An index still addresses the currently rendered options. Scrolling
        // must not silently reinterpret it as a global virtual-list index.
        if (specification.index != null || scrollSearch.steps >= scrollSearch.maxSteps) return false;
        const container = dropdownScrollContainer(control, available.options);
        if (!container || container.getAttribute("aria-busy") === "true" || control.getAttribute("aria-busy") === "true") return false;
        let state = scrollStates.get(container);
        if (!state) {
          state = { initialTop: container.scrollTop, wrapped: false, done: false };
          scrollStates.set(container, state);
        }
        if (state.done) return false;
        const current = container.scrollTop;
        const maximum = Math.max(0, container.scrollHeight - container.clientHeight);
        let next;
        if (state.wrapped && current >= state.initialTop - 1) state.done = true;
        else if (current >= maximum - 1) {
          if (!state.wrapped && state.initialTop > 1) { state.wrapped = true; next = 0; }
          else state.done = true;
        } else next = Math.min(maximum, current + Math.max(32, Math.floor(container.clientHeight * 0.8)), state.wrapped ? state.initialTop : maximum);
        if (state.done || next === undefined || Math.abs(next - current) < 1) return false;
        const beforeOptions = available.options.map(element => `${optionValue(element)}\n${optionLabel(element)}`).join("\u0000");
        // A global DOM mutation is not a scroll acknowledgement. Wait for this
        // container's actual scroll event so rapid unrelated updates cannot
        // coalesce several offsets and skip an unrendered virtual window.
        const observed = await new Promise(resolve => {
          let timer;
          const finish = value => { clearTimeout(timer); container.removeEventListener("scroll", onScroll); resolve(value); };
          const onScroll = () => finish(true);
          container.addEventListener("scroll", onScroll, { once: true });
          timer = setTimeout(() => finish(false), Math.max(1, deadline - Date.now()));
          container.scrollTo({ top: next, behavior: "instant" });
          scrollSearch.attempted = true;
          scrollSearch.steps += 1;
          scrollSearch.lastTop = container.scrollTop;
        });
        if (!observed) { state.done = true; return false; }
        scrollSearch.observedSteps = (scrollSearch.observedSteps ?? 0) + 1;
        const afterOptions = dropdownOptions(control).options.map(element => `${optionValue(element)}\n${optionLabel(element)}`).join("\u0000");
        if (afterOptions === beforeOptions) await waitForDropdownChange(Math.min(50, Math.max(1, deadline - Date.now())), [container]);
        return true;
      };
      while (Date.now() <= deadline) {
        assertSelectionVisible();
        if (!control.isConnected || control.ownerDocument !== document) {
          throw operationError("dropdown_selection_target_changed", "The associated dropdown control was replaced before option dispatch", { scrollSearch });
        }
        available = dropdownOptions(control);
        if (available.options.length > 0) {
          try { option = chooseOption(available.options, specification, exact); break; }
          catch (error) {
            if (!["dropdown_option_not_found", "dropdown_option_index_invalid"].includes(error?.code)) throw error;
            matchingError = error;
          }
          await advanceDropdown();
        }
        await waitForDropdownChange(100);
      }
      if (available.options.length === 0) {
        throw operationError("dropdown_options_not_visible", "Dropdown opened without any visible selectable options", {
          element: describe(control),
          ariaControls: control.getAttribute("aria-controls") || control.getAttribute("aria-owns") || null,
        });
      }
      if (!option) {
        const error = matchingError || operationError("dropdown_option_not_found", "The requested dropdown option did not appear before the deadline");
        error.details = { ...(error.details ?? {}), scrollSearch };
        throw error;
      }
      const selectedLabel = optionLabel(option);
      const selectedValue = optionValue(option);
      option.scrollIntoView({ block: "nearest", inline: "nearest" });
      await visualize(option, "choose");
      // A virtual list can recycle the same node or replace it while bringing
      // it into view. Resolve the requested option again before one click.
      const currentOptions = dropdownOptions(control).options;
      let currentOption;
      try { currentOption = chooseOption(currentOptions, specification, exact); }
      catch (error) { throw operationError("dropdown_selection_target_changed", "The requested option changed before dispatch", { cause: error.code, scrollSearch }); }
      if (!control.isConnected || !option.isConnected || currentOption !== option
        || optionLabel(option) !== selectedLabel || optionValue(option) !== selectedValue) {
        throw operationError("dropdown_selection_target_changed", "The dropdown option was replaced or recycled before dispatch", { scrollSearch });
      }
      const beforeSelectionValue = normalize(control.value || control.innerText || control.textContent);
      const beforeSelectionText = normalize(selectionHost.innerText || selectionHost.textContent);
      assertSelectionVisible();
      selectionMutationAttempted = true;
      activateControl(option);

      let readback = null;
      while (Date.now() <= deadline) {
        const afterValue = normalize(control.value || control.innerText || control.textContent);
        const afterText = normalize(selectionHost.innerText || selectionHost.textContent);
        const selectedState = option.getAttribute("aria-selected") === "true"
          || option.getAttribute("data-selected") === "true"
          || option.matches(":checked");
        const valueCommitted = selectedValue && afterValue !== beforeSelectionValue && lower(afterValue) === lower(selectedValue);
        const labelCommitted = selectedLabel && (
          (afterValue !== beforeSelectionValue && lower(afterValue) === lower(selectedLabel))
          || (lower(afterText).includes(lower(selectedLabel)) && afterText !== beforeSelectionText)
        );
        if (selectedState || valueCommitted || labelCommitted) {
          readback = {
            selectedState,
            controlValue: afterValue.slice(0, 300),
            contextText: afterText.slice(0, 500),
            expanded: control.getAttribute("aria-expanded") === "true",
          };
          break;
        }
        await waitForDropdownChange(100);
      }
      if (!readback) {
        throw operationError("dropdown_selection_not_committed", "Dropdown option click did not produce an observable selected value", {
          requested: specification,
          option: { label: selectedLabel, value: selectedValue },
          beforeValue,
          beforeText: beforeText.slice(0, 500),
          afterValue: normalize(control.value || control.innerText || control.textContent).slice(0, 300),
          afterText: normalize(selectionHost.innerText || selectionHost.textContent).slice(0, 500),
        });
      }
      return {
        selected: true,
        selectionCommitted: true,
        controlKind: available.controlled ? "aria_controlled_listbox" : "visible_custom_listbox",
        visualized: true,
        element: describe(control),
        option: { label: selectedLabel, value: selectedValue },
        readback,
        scrollSearch,
        url: location.href,
      };
    } catch (error) {
      const details = error?.details && typeof error.details === "object" ? error.details : {};
      error.details = {
        ...details,
        operationEffectState: details.operationEffectState
          ?? (selectionMutationAttempted ? "unknown" : "none"),
        mutationDispatchAttempted: details.mutationDispatchAttempted
          ?? selectionMutationAttempted,
      };
      return errorResult(error, "dropdown_selection_failed");
    } finally {
      document.removeEventListener("visibilitychange", onSelectionVisibility);
    }
  }
  if (action === "type") {
    const element = payload.locator ? find(payload.locator) : targetOrActive(null, { allowBody: false });
    if (!(element instanceof HTMLInputElement || element instanceof HTMLTextAreaElement || element instanceof HTMLSelectElement || element.isContentEditable)) {
      throw new Error("Matched element does not accept text input");
    }
    // page.type replaces a field; it does not replace a page.selectText range.
    // Never turn an omitted clear flag into deletion of an existing document.
    if (element.isContentEditable && String(element.textContent ?? "").length > 0
      && payload.clear !== false && payload.clearExplicit !== true) {
      throw operationError("contenteditable_replace_requires_explicit_clear",
        "page.type replaces the entire editor, not the selected text. Use the formatting toolbar for partial edits; only pass clear:true for an authorized whole-editor replacement.",
        { operationEffectState: "none", mutationDispatchAttempted: false });
    }
    element.scrollIntoView({ block: "center", inline: "center" });
    element.focus();
    await visualize(element, "type");
    if (element instanceof HTMLSelectElement) {
      const requested = normalize(payload.text);
      const option = [...element.options].find((candidate) => (
        normalize(candidate.value) === requested
        || normalize(candidate.textContent) === requested
      ));
      if (!option) throw new Error(`Select option was not found: ${requested}`);
      const setter = Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, "value")?.set;
      if (setter) setter.call(element, option.value);
      else element.value = option.value;
      element.dispatchEvent(new Event("input", { bubbles: true, composed: true }));
      element.dispatchEvent(new Event("change", { bubbles: true, composed: true }));
      return {
        selected: true,
        semanticCommitted: true,
        semanticNoEffectVerified: false,
        visualized: true,
        element: describe(element),
        value: option.value,
        text: normalize(option.textContent),
      };
    }
    const readValue = () => element.isContentEditable ? String(element.innerText ?? "") : String(element.value ?? "");
    const beforeValue = readValue();
    const inputText = String(payload.text).replace(/\r\n?/gu, "\n");
    const expectedValue = payload.clear ? inputText : `${beforeValue}${inputText}`;
    if (element.isContentEditable) {
      const selection = globalThis.getSelection?.();
      if (selection) {
        const range = document.createRange();
        range.selectNodeContents(element);
        if (!payload.clear) range.collapse(false);
        range.deleteContents();
        // innerText creates explicit line-break nodes. A raw newline in a
        // Text node collapses to a space in a normal rich editor, even though
        // textContent misleadingly reports the requested newline.
        const container = document.createElement("div");
        container.innerText = inputText;
        const inserted = document.createDocumentFragment();
        while (container.firstChild) inserted.appendChild(container.firstChild);
        const lastInserted = inserted.lastChild;
        range.insertNode(inserted);
        if (lastInserted) range.setStartAfter(lastInserted);
        range.collapse(true);
        selection.removeAllRanges();
        selection.addRange(range);
      } else {
        throw operationError("contenteditable_selection_unavailable", "The editor did not expose a selection range for safe text input");
      }
    } else {
      const prototype = element instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
      const setter = Object.getOwnPropertyDescriptor(prototype, "value")?.set;
      if (setter) setter.call(element, expectedValue);
      else element.value = expectedValue;
    }
    element.dispatchEvent(new InputEvent("input", { bubbles: true, composed: true, inputType: "insertText", data: payload.text }));
    element.dispatchEvent(new Event("change", { bubbles: true, composed: true }));
    if (payload.verifyCommit === true) await wait(180);
    let afterValue = readValue();
    // Same rule as verifyTypeValue: a rich editor keeps each line as its own block, so text added
    // after Enter shows extra blank lines in innerText (LinkedIn, AOS run 619 on 2026-10-15). There
    // the same non-empty lines in the same order count as committed; plain inputs match exactly.
    const editorLines = (value) => value.replace(/\r\n?/gu, "\n").replace(/[​-‍﻿]/gu, "").replace(/ /gu, " ")
      .split("\n").map((line) => line.replace(/[ \t]+$/u, "")).filter((line) => line.trim() !== "").join("\n");
    const holdsExpected = (value) => value === expectedValue
      || (element.isContentEditable === true && editorLines(value) === editorLines(expectedValue));
    let semanticCommitted = holdsExpected(afterValue);
    // A framework editor (Lexical on Threads) takes the inserted nodes out and renders the same text
    // from its own state a moment later, so a read right after the input event sees a half-rebuilt
    // field. Every Threads caption since 2026-10-06 stopped here although the text was in the box
    // exactly once (checked 2026-10-18). Read again until the editor settles (at most 15 reads,
    // 1.5 s); the same exact rule applies, so a doubled or changed text still never counts.
    const settleBy = Date.now() + 1500;
    for (let reads = 0; !semanticCommitted && element.isContentEditable === true && reads < 15 && Date.now() < settleBy; reads++) {
      await wait(100);
      afterValue = readValue();
      semanticCommitted = holdsExpected(afterValue);
    }
    const semanticNoEffectVerified = payload.verifyCommit === true && afterValue === beforeValue;
    return {
      typed: semanticCommitted,
      visualized: true,
      trustedInput: false,
      semanticCommitted,
      semanticNoEffectVerified,
      element: describe(element),
      beforeValueLength: beforeValue.length,
      expectedValueLength: expectedValue.length,
      valueLength: afterValue.length,
      // The frame-origin check after a frame-scoped operation reads this URL (frame 0 can fall back
      // to the tab URL, a nested frame cannot). Without it typing into a same-site iframe was always
      // refused as target_frame_origin_not_allowed (doda's certificate picker, 2026-10-18).
      url: typeof location === "undefined" ? null : location.href,
    };
  }
  if (action === "verifyTypeValue") {
    const element = payload.point ? focusedTextInputAtPoint(payload.point) : find(payload.locator);
    if (!(element instanceof HTMLInputElement || element instanceof HTMLTextAreaElement || element.isContentEditable)) {
      throw operationError("text_input_control_required", "Matched element does not expose a verifiable text value");
    }
    const currentValue = element.isContentEditable ? String(element.innerText ?? "") : String(element.value ?? "");
    const expectedText = String(payload.expectedText ?? "").replace(/\r\n?/gu, "\n");
    // Rich editors (ProseMirror, Draft.js, Lexical) keep each line as its own block, so their
    // innerText shows extra blank lines, non-breaking spaces or zero-width characters around text
    // that was retained exactly (LinkedIn turned each paragraph break into three newlines and the
    // post was stopped, AOS 2026-10-11 and 10-14). In an editor the same non-empty lines in the same
    // order count as committed; a plain input or textarea must still match exactly.
    const editorLines = (value) => value.replace(/\r\n?/gu, "\n").replace(/[\u200b-\u200d\ufeff]/gu, "").replace(/\u00a0/gu, " ")
      .split("\n").map((line) => line.replace(/[ \t]+$/u, "")).filter((line) => line.trim() !== "").join("\n");
    const exact = currentValue === expectedText;
    const sameLines = !exact && element.isContentEditable === true && editorLines(currentValue) === editorLines(expectedText);
    return {
      committed: exact || sameLines,
      commitMatch: exact ? "exact" : sameLines ? "editor_lines" : "mismatch",
      valueLength: currentValue.length,
      expectedValueLength: expectedText.length,
      element: describe(element),
      url: location.href,
      pageInstanceId,
    };
  }
  if (action === "verifyTypeSelection") {
    const element = focusedTextInputAtPoint(payload.point);
    let selectedAll;
    if (element.isContentEditable) {
      const selection = globalThis.getSelection?.();
      const whole = document.createRange();
      whole.selectNodeContents(element);
      const selected = selection?.rangeCount === 1 ? selection.getRangeAt(0) : null;
      selectedAll = !!selected && selected.compareBoundaryPoints(Range.START_TO_START, whole) <= 0
        && selected.compareBoundaryPoints(Range.END_TO_END, whole) >= 0;
      // Chrome can represent selectAll using the first/last Text-node
      // endpoints rather than the editor's outer child offsets.
      if (!selectedAll && selected && element.contains(selected.startContainer) && element.contains(selected.endContainer)) {
        const prefix = whole.cloneRange();
        prefix.setEnd(selected.startContainer, selected.startOffset);
        const suffix = whole.cloneRange();
        suffix.setStart(selected.endContainer, selected.endOffset);
        selectedAll = prefix.toString() === "" && suffix.toString() === "";
      }
    } else {
      const length = String(element.value ?? "").length;
      selectedAll = length === 0 || (element.selectionStart === 0 && element.selectionEnd === length);
    }
    return { selectedAll, url: location.href, pageInstanceId };
  }
  if (action === "verifyUpload") {
    let element;
    try { element = find(payload.locator, { allowHiddenFile: true, fileInputOnly: true }); }
    catch (error) {
      if (error?.code !== "semantic_locator_not_found") throw error;
      return { retained: false, state: "replaced", files: [], inputFileCount: 0, url: location.href, pageInstanceId };
    }
    const files = [...(element.files ?? [])].map(file => ({ name: file.name, size: file.size, type: file.type }));
    const expectedFiles = Array.isArray(payload.expectedFiles) ? payload.expectedFiles : [];
    const retained = expectedFiles.length > 0 && files.length === expectedFiles.length
      && files.every((file, index) => file.name === expectedFiles[index].name && file.size === expectedFiles[index].size && file.type === expectedFiles[index].type);
    return { retained, state: retained ? "retained" : files.length === 0 ? "cleared" : "different",
      files, inputFileCount: files.length, element: describe(element), url: location.href, pageInstanceId };
  }
  if (action === "markUploadTarget") {
    // Native (CDP) uploads: tag the exact file input so the worker can resolve
    // the same node through DOM.querySelector. Never assigns files itself.
    const element = find(payload.locator, { allowHiddenFile: true, fileInputOnly: true });
    if (!(element instanceof HTMLInputElement) || element.type !== "file") {
      throw operationError("file_input_required", "Matched element is not a file input");
    }
    if (typeof payload.nonce !== "string" || !/^[0-9a-f-]{36}$/u.test(payload.nonce)) {
      throw operationError("upload_payload_invalid", "Native upload target nonce is invalid");
    }
    element.setAttribute("data-aos-upload-target", payload.nonce);
    const visualTarget = [...(element.labels ?? [])].find(visible) ?? element;
    visualTarget.scrollIntoView({ block: "center", inline: "center" });
    await visualize(visualTarget, "upload");
    return { marked: true, element: describe(element), url: location.href, pageInstanceId };
  }
  if (action === "unmarkUploadTarget") {
    for (const element of document.querySelectorAll("input[type=file][data-aos-upload-target]")) {
      if (element.getAttribute("data-aos-upload-target") === payload.nonce) element.removeAttribute("data-aos-upload-target");
    }
    return { unmarked: true, url: location.href, pageInstanceId };
  }
  if (action === "upload" || action === "uploadMultiple") {
    const uploadStartedAt = Date.now();
    const element = find(payload.locator, { allowHiddenFile: true, fileInputOnly: true });
    if (!(element instanceof HTMLInputElement) || element.type !== "file") {
      throw operationError("file_input_required", "Matched element is not a file input");
    }
    const files = action === "upload" ? [payload.file] : (Array.isArray(payload.files) ? payload.files : []);
    if (files.length < 1 || files.length > 10) throw operationError("upload_file_count_invalid", "Upload is limited to 1-10 explicit files");
    const transfer = new DataTransfer();
    let totalBytes = 0;
    for (const file of files) {
      if (!file || typeof file.dataBase64 !== "string" || typeof file.name !== "string" || typeof file.mimeType !== "string") {
        throw operationError("upload_payload_invalid", "Validated upload payload is missing");
      }
      const binary = atob(file.dataBase64);
      totalBytes += binary.length;
      if (totalBytes > 25 * 1024 * 1024) throw operationError("upload_file_too_large", "One upload is limited to 25 MiB combined");
      const bytes = new Uint8Array(binary.length);
      for (let index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index);
      transfer.items.add(new File([bytes], file.name, { type: file.mimeType, lastModified: Date.now() }));
    }
    const expectedFiles = [...transfer.files].map(file => ({ name: file.name, size: file.size, type: file.type }));
    const visualTarget = [...(element.labels ?? [])].find(visible) ?? element;
    visualTarget.scrollIntoView({ block: "center", inline: "center" });
    await visualize(visualTarget, files.length === 1 ? "upload" : "upload multiple");
    const uploadPreparedAt = Date.now();
    const filesSetter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "files")?.set;
    uploadMutationAttempted = true;
    if (filesSetter) filesSetter.call(element, transfer.files);
    else element.files = transfer.files;
    const assignedFiles = [...(element.files ?? [])];
    const assignmentVerified = assignedFiles.length === expectedFiles.length
      && assignedFiles.every((file, index) => file.name === expectedFiles[index].name && file.size === expectedFiles[index].size && file.type === expectedFiles[index].type);
    if (!assignmentVerified) throw operationError("upload_file_assignment_failed", "The file input did not accept the requested files", {
      operationEffectState: "unknown", mutationDispatchAttempted: true, expected: expectedFiles,
    });
    // Native bubbling events reach the site's listeners across the isolated
    // world boundary. Never call a framework's private handler a second time.
    element.dispatchEvent(new Event("input", { bubbles: true, composed: true }));
    element.dispatchEvent(new Event("change", { bubbles: true, composed: true }));
    const reflectedFiles = [...(element.files ?? [])].map(file => ({ name: file.name, size: file.size, type: file.type }));
    const retained = element.isConnected !== false && reflectedFiles.length === expectedFiles.length
      && reflectedFiles.every((file, index) => file.name === expectedFiles[index].name && file.size === expectedFiles[index].size && file.type === expectedFiles[index].type);
    const visualContainer = [...(element.labels ?? [])].find(visible)
      ?? element.closest?.("label,[role='group'],fieldset,form") ?? element.parentElement;
    const reflectedText = normalize(visualContainer?.innerText || visualContainer?.textContent).slice(0, 500);
    return {
      uploaded: retained,
      count: files.length,
      visualized: true,
      fileInputAssignmentVerified: true,
      expectedFiles,
      uploadReadbackVerified: retained,
      uploadReadbackMethod: retained ? "file_input" : "site_confirmation_pending",
      uploadTiming: { prepareMs: uploadPreparedAt - uploadStartedAt, assignmentReadbackMs: Date.now() - uploadPreparedAt,
        pageVisibility: document.visibilityState },
      element: describe(element),
      ...(action === "upload" ? { file: { name: files[0].name, mimeType: files[0].mimeType, size: expectedFiles[0].size, sha256: files[0].sha256 } } : {}),
      files: expectedFiles,
      readback: {
        inputFileCount: reflectedFiles.length,
        file: retained && reflectedFiles.length === 1 ? { name: reflectedFiles[0].name, mimeType: reflectedFiles[0].type, size: reflectedFiles[0].size } : null,
        files: reflectedFiles,
        visualText: reflectedText || null,
      },
      url: location.href,
      pageInstanceId,
    };
  }
  if (action === "waitFor") {
    const condition = ["attached", "detached", "visible", "hidden"].includes(payload.condition) ? payload.condition : "visible";
    try {
      const element = find(payload.locator, { includeHidden: condition === "hidden" || condition === "attached" });
      const isVisible = visible(element);
      if (condition === "detached") return { found: false, url: location.href, pageInstanceId };
      if (condition === "hidden") return { found: !isVisible, element: describe(element), visible: isVisible, url: location.href, pageInstanceId };
      if (condition === "attached") return { found: true, element: describe(element), visible: isVisible, url: location.href, pageInstanceId };
      return { found: true, element: describe(element), url: location.href, pageInstanceId };
    } catch (error) {
      if (error?.code !== "semantic_locator_not_found") throw error;
      return { found: condition === "detached" || condition === "hidden", url: location.href, pageInstanceId };
    }
  }
  if (action === "delay") {
    const milliseconds = Math.min(Math.max(Number(payload.milliseconds ?? 250), 0), 10_000);
    await new Promise((resolve) => setTimeout(resolve, milliseconds));
    return { waited: true, milliseconds, url: location.href };
  }
  if (action === "submit") {
    const element = find(payload.locator);
    consumeSemanticGuard(element);
    element.scrollIntoView({ block: "center", inline: "center" });
    visualize(element, "submit");
    if (!(element instanceof HTMLFormElement)) {
      const form = element.closest("form");
      if (!form) throw new Error("Matched element is not inside a form");
      form.requestSubmit();
      return { submitted: true, formSubmitControl: true, mutationDispatchAttempted: true, visualized: true, element: describe(element), url: location.href };
    }
    element.requestSubmit();
    return { submitted: true, formSubmitControl: true, mutationDispatchAttempted: true, visualized: true, element: describe(element), url: location.href };
  }
  throw new Error(`Unknown page operation: ${action}`);
  } catch (error) {
    return {
      __aosCompanionError: {
        code: error?.code || "page_operation_failed",
        message: error instanceof Error ? error.message : String(error),
        // For upload, target/payload preparation happens before the FileList
        // setter or any input/change handler can run. Preserve that boundary.
        details: ["upload", "uploadMultiple"].includes(action) && !uploadMutationAttempted
          ? { ...(error?.details ?? {}), operationEffectState: "none", mutationDispatchAttempted: false }
          : action === "richText"
            ? { ...(error?.details ?? {}), operationEffectState: richTextMutationAttempted || richTextObservedChange ? "unknown" : "none", mutationDispatchAttempted: richTextMutationAttempted }
            : action === "selectText"
              ? { ...(error?.details ?? {}), operationEffectState: selectionMutationAttempted || selectionObservedChange ? "unknown" : "none", mutationDispatchAttempted: selectionMutationAttempted }
              : action === "selectOption"
                ? {
                  ...(error?.details ?? {}),
                  operationEffectState: error?.details?.operationEffectState
                    ?? (selectionMutationAttempted ? "unknown" : "none"),
                  mutationDispatchAttempted: error?.details?.mutationDispatchAttempted
                    ?? selectionMutationAttempted,
                }
              : error?.details && typeof error.details === "object" ? error.details : undefined,
      },
    };
  }
}

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (message?.kind === "clipboard.source.storage") {
    handleClipboardSourceStorage(message, _sender).then(value => sendResponse({ ok: true, value }))
      .catch(error => sendResponse({ ok: false, code: error.code ?? "clipboard_source_storage_unavailable" }));
    return true;
  }
  if (message?.kind?.startsWith("controls.")) {
    userControls.handle(message, _sender).then(sendResponse).catch(error => sendResponse({ error: error.message, code: error.code }));
    return true;
  }
  if (message?.kind === "status.get") {
    requestReconnect();
    Promise.all([hasDebuggerPermission(), hasPhysicalInputOptIn(), hasPeripheralPermissions()])
      .then(() => sendResponse(publicState()))
      .catch(() => sendResponse(publicState()));
  } else if (message?.kind === "recording.start") {
    startCompanionTabRecording({ tabId: message.tabId, streamId: message.streamId, taskId: message.taskId ?? "companion-popup-recording", userGesture: true })
      .then(result => sendResponse({ ok: true, ...result }))
      .catch(error => sendResponse({ ok: false, code: error?.code ?? "recording_start_failed", error: error?.message ?? String(error), details: error?.details }));
    return true;
  } else if (message?.kind === "recording.stop") {
    stopCompanionTabRecording({ filename: message.filename })
      .then(result => sendResponse({ ok: true, ...result }))
      .catch(error => sendResponse({ ok: false, code: error?.code ?? "recording_stop_failed", error: error?.message ?? String(error), details: error?.details }));
    return true;
  } else if (message?.kind === "recording.status") {
    ensureOffscreenClipboard()
      .then(() => chrome.runtime.sendMessage({ kind: "offscreen.recording.status" }))
      .then(result => sendResponse(result ?? { ok: true, active: false }))
      .catch(error => sendResponse({ ok: false, code: error?.code ?? "recording_status_failed", error: error?.message ?? String(error) }));
    return true;
  } else if (message?.kind === "connection.retry") {
    detachNativePort();
    runtimeState.connected = false;
    runtimeState.connecting = false;
    runtimeState.generation = null;
    requestReconnect({ force: true });
    sendResponse({ accepted: true });
  } else if (message?.kind === "physicalInput.set") {
    const enabled = message.enabled === true;
    chrome.storage.local.set({ [PHYSICAL_INPUT_ENABLED_KEY]: enabled })
      .then(() => {
        runtimeState.physicalInputEnabled = enabled;
        sendResponse({ enabled });
      })
      .catch((storageError) => sendResponse({ enabled: false, error: storageError instanceof Error ? storageError.message : String(storageError) }));
  } else return false;
  return true;
});

chrome.tabs.onRemoved.addListener((tabId) => {
  void pageObservations.tabRemoved(tabId);
  void javaScriptDialogs.tabRemoved(tabId);
  void viewportControls.tabRemoved(tabId).catch(error => { runtimeState.lastError = error.message; });
  postNativeMessage({
    kind: "extension.event",
    event: "tab.removed",
    profileInstanceId: runtimeState.profileInstanceId,
    tabId,
  });
});

// Chrome can keep the browser process alive while a Profile 2 window is closed
// and reopened. In that lifecycle the MV3 `runtime.onStartup` event does not
// fire again, so reconnect on the first tab/window activity as well. The
// request is throttled and remains a no-op while a native port is healthy.
chrome.tabs.onCreated.addListener(tab => { pageObservations.tabCreated(tab); requestReconnect(); });
chrome.tabs.onUpdated.addListener((tabId, _change, tab) => pageObservations.tabUpdated(tabId, tab));
chrome.tabs.onActivated.addListener(() => requestReconnect());
chrome.runtime.onConnect.addListener(() => requestReconnect());

chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name === RECONNECT_ALARM || alarm.name === WATCHDOG_ALARM) {
    requestReconnect();
  }
});

chrome.runtime.onInstalled.addListener(() => {
  ensureWatchdogAlarm();
  requestReconnect({ force: true });
});
chrome.commands.onCommand.addListener((command) => {
  if (command === "recording-start") {
    const armedTabId = pendingAutoRecordingTabId;
    pendingAutoRecordingTabId = null;
    void (armedTabId ? Promise.resolve([{ id: armedTabId }]) : chrome.tabs.query({ active: true, currentWindow: true })).then(([tab]) =>
      startCompanionTabRecording({ tabId: tab?.id, taskId: "companion-command-recording", userGesture: true }))
      .catch(error => { runtimeState.lastError = error instanceof Error ? error.message : String(error); });
  } else if (command === "recording-stop") {
    void stopCompanionTabRecording({ filename: `companion-${Date.now()}.webm` })
      .catch(error => { runtimeState.lastError = error instanceof Error ? error.message : String(error); });
  }
});
chrome.runtime.onStartup.addListener(() => {
  ensureWatchdogAlarm();
  requestReconnect({ force: true });
});
ensureWatchdogAlarm();
requestReconnect({ force: true });

chrome.debugger.onDetach.addListener(source => {
  if (!source.sessionId && Number.isSafeInteger(source.tabId)) void viewportControls.tabRemoved(source.tabId, "debugger_detached").catch(error => { runtimeState.lastError = error.message; });
});
