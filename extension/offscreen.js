import {
  BINARY_CLIPBOARD_MIME_ALLOWLIST,
  MAX_CLIPBOARD_BINARY_BYTES,
} from "./peripheral-policy.generated.js";

const MAX_CLIPBOARD_CHARS = 100_000;
// Binary clipboard is intentionally bounded and opt-in.  The offscreen page
// must never become an unbounded clipboard oracle or a general file transport.
const MAX_CLIPBOARD_BYTES = MAX_CLIPBOARD_BINARY_BYTES;
const BINARY_CLIPBOARD_MIME_TYPES = BINARY_CLIPBOARD_MIME_ALLOWLIST;
let tabRecorder = null;
let lastRecordingResult = null;

function recordingError(code, message, details = {}) {
  const error = new Error(message);
  error.code = code;
  error.details = details;
  return error;
}

function recorderMimeType() {
  return ["video/webm;codecs=vp9,opus", "video/webm;codecs=vp8,opus", "video/webm"]
    .find(value => MediaRecorder.isTypeSupported(value)) ?? "";
}

async function startTabRecorder(message) {
  if (tabRecorder) throw recordingError("recording_already_active", "A Companion tab recording is already active");
  const streamId = String(message?.streamId ?? "");
  if (!streamId) throw recordingError("recording_stream_id_missing", "Chrome did not provide a tab capture stream id");
  const media = await navigator.mediaDevices.getUserMedia({
    audio: { mandatory: { chromeMediaSource: "tab", chromeMediaSourceId: streamId } },
    video: { mandatory: { chromeMediaSource: "tab", chromeMediaSourceId: streamId } },
  });
  const chunks = [];
  const audioContext = new AudioContext();
  const audioSource = audioContext.createMediaStreamSource(media);
  audioSource.connect(audioContext.destination);
  await audioContext.resume().catch(() => {});
  const mimeType = recorderMimeType();
  const recorder = mimeType ? new MediaRecorder(media, { mimeType }) : new MediaRecorder(media);
  const startedAt = new Date().toISOString();
  const stopped = new Promise((resolve, reject) => {
    recorder.ondataavailable = event => { if (event.data?.size) chunks.push(event.data); };
    recorder.onerror = event => reject(recordingError("recording_media_error", event.error?.message ?? "MediaRecorder failed"));
    recorder.onstop = () => resolve();
  });
  recorder.start(1000);
  tabRecorder = { recorder, media, audioContext, chunks, stopped, startedAt, tabId: message.tabId, taskId: message.taskId ?? null };
  return { active: true, tabId: message.tabId, taskId: message.taskId ?? null, startedAt, mimeType: recorder.mimeType || mimeType || null, audioCaptured: true };
}

async function stopTabRecorder(message) {
  if (!tabRecorder) throw recordingError("recording_not_active", "No Companion tab recording is active");
  const current = tabRecorder;
  tabRecorder = null;
  current.recorder.stop();
  await current.stopped;
  current.media.getTracks().forEach(track => track.stop());
  await current.audioContext.close().catch(() => {});
  const blob = new Blob(current.chunks, { type: current.recorder.mimeType || "video/webm" });
  if (!blob.size) throw recordingError("recording_empty", "The tab recorder produced no media bytes");
  if (!chrome.downloads) throw recordingError("recording_downloads_api_missing", "Chrome downloads permission is required to save the recording");
  const safeName = String(message?.filename ?? `companion-tab-${Date.now()}.webm`).replace(/[^A-Za-z0-9._-]/g, "_").slice(0, 160);
  const url = URL.createObjectURL(blob);
  let downloadId;
  try {
    downloadId = await chrome.downloads.download({ url, filename: `AOS Chrome Companion Recordings/${safeName}`, saveAs: false, conflictAction: "uniquify" });
  } finally {
    setTimeout(() => URL.revokeObjectURL(url), 30_000);
  }
  lastRecordingResult = { active: false, tabId: current.tabId, taskId: current.taskId, startedAt: current.startedAt, completedAt: new Date().toISOString(), bytes: blob.size, chunks: current.chunks.length, mimeType: blob.type, audioCaptured: true, downloadId, filename: safeName };
  return lastRecordingResult;
}

function clipboardError(code, message, details = {}) {
  const error = new Error(message);
  error.code = code;
  error.details = details;
  return error;
}

// Source intent is persisted before touching the clipboard. A terminal receipt
// is persisted before ACK. Neither record contains clipboard contents. A crash
// between these two records is unknown and the same operation never writes again.
let clipboardWriteLane = Promise.resolve();
const CLIPBOARD_RECEIPT_PREFIX = "companion.clipboard.source.v1:";
const MAX_CLIPBOARD_SOURCE_RECEIPTS = 512;
async function clipboardSourceStorage(action, key, value, sourceBinding) {
  // Offscreen supports only chrome.runtime among extension APIs. The worker
  // exposes only this metadata namespace to this exact offscreen document.
  const result = await chrome.runtime.sendMessage({ kind: "clipboard.source.storage", action, key, value, sourceBinding });
  if (!result?.ok) throw clipboardError(result?.code ?? "clipboard_source_storage_unavailable", "Durable clipboard source metadata was not acknowledged");
  return result.value;
}
async function clipboardSourceBinding(message, { lookup = false } = {}) {
  const binding = requireBinaryBinding(message);
  const operationId = lookup ? message.sourceOperationId : message.operationId;
  if (typeof operationId !== "string" || !/^[A-Za-z0-9_.:-]{1,200}$/u.test(operationId)
    || typeof message.generation !== "string" || !message.generation) {
    throw clipboardError("clipboard_source_binding_required", "Clipboard source requires exact operation and generation binding");
  }
  let payloadSha256 = message.payloadSha256;
  if (!lookup) {
    const payload = message.formats
      ? { formats: message.formats.map(({ mimeType, dataBase64 }) => ({ mimeType, dataBase64 })) }
      : { text: message.text };
    const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(JSON.stringify(payload)));
    const actual = [...new Uint8Array(digest)].map(byte => byte.toString(16).padStart(2, "0")).join("");
    if (payloadSha256 !== actual) throw clipboardError("clipboard_payload_binding_mismatch", "Clipboard payload hash does not match the source request");
  }
  if (typeof payloadSha256 !== "string" || !/^[a-f0-9]{64}$/u.test(payloadSha256)) {
    throw clipboardError("clipboard_payload_binding_required", "Clipboard source requires its payload SHA-256");
  }
  return { operationId, ...binding, generation: message.generation, payloadSha256 };
}

async function readClipboardSourceReceipt(message) {
  const binding = await clipboardSourceBinding(message, { lookup: true });
  const key = CLIPBOARD_RECEIPT_PREFIX + binding.operationId;
  const receipt = await clipboardSourceStorage("get", key, undefined, binding);
  if (!receipt) return { ok: true, found: false, sourceBinding: binding, historicalUnknownUnchanged: true };
  if (JSON.stringify(receipt.sourceBinding) !== JSON.stringify(binding)) {
    throw clipboardError("clipboard_source_binding_mismatch", "Stored clipboard source belongs to another exact request");
  }
  return { ok: true, found: true, ...receipt, pasteVerified: false, contentReturned: false };
}

function writeClipboardWithReceipt(message) {
  const work = async () => {
    let intentPersisted = false;
    try {
      const sourceBinding = await clipboardSourceBinding(message);
      const key = CLIPBOARD_RECEIPT_PREFIX + sourceBinding.operationId;
      const existing = await clipboardSourceStorage("get", key, undefined, sourceBinding);
      if (existing) {
        if (JSON.stringify(existing.sourceBinding) !== JSON.stringify(sourceBinding)) {
          throw clipboardError("clipboard_source_binding_mismatch", "Operation ID was already used for another clipboard request");
        }
        if (existing.state === "completed" && existing.compacted === true && existing.writeAcknowledged === true)
          return { ok: true, sourceReceipt: existing, duplicateDelivery: true, compacted: true,
            acknowledgedHistorical: true, writeAcknowledged: true, pasteVerified: false, contentReturned: false,
            operationEffectState: "none", mutationDispatchAttempted: false };
        if (existing.state === "completed") return { ...existing.ack, sourceReceipt: existing, duplicateDelivery: true };
        throw clipboardError("clipboard_write_result_unknown", "This source intent has no terminal ACK; do not repeat its clipboard write", {
          operationEffectState: "unknown", mutationDispatchAttempted: true, retryWrite: false, sourceBinding,
        });
      }
      const count = await clipboardSourceStorage("count", undefined, undefined, sourceBinding);
      if (count >= MAX_CLIPBOARD_SOURCE_RECEIPTS) {
        throw clipboardError("clipboard_source_capacity_reached", "Clipboard source metadata is at finite capacity; retain dedupe evidence and resolve storage ownership before a new write", {
          maxSourceReceipts: MAX_CLIPBOARD_SOURCE_RECEIPTS, operationEffectState: "none", mutationDispatchAttempted: false,
        });
      }
      // Preparation has no clipboard effect. Complete MIME/API/size validation
      // before persisting an intent so unsupported input remains known no-effect.
      const prepared = message.formats || message.binary === true ? prepareClipboardBinary(message) : null;
      if (!prepared && (typeof message.text !== "string" || message.text.length > MAX_CLIPBOARD_CHARS)) {
        throw clipboardError("clipboard_payload_invalid", "Explicit bounded text is required");
      }
      await clipboardSourceStorage("set", key, { schema: "aos.chrome_companion.clipboard_source.v1", sourceBinding, state: "intent", intendedAt: new Date().toISOString() }, sourceBinding);
      intentPersisted = true;
      const ack = message.formats || message.binary === true
        ? await writeClipboardBinary(message, prepared)
        : await writeClipboardText(message.text).then(() => ({ ok: true, chars: message.text.length, writeAcknowledged: true }));
      const receipt = { schema: "aos.chrome_companion.clipboard_source.v1", sourceBinding, state: "completed", completedAt: new Date().toISOString(), ack };
      await clipboardSourceStorage("set", key, receipt, sourceBinding);
      return { ...ack, sourceReceipt: receipt, pasteVerified: false, contentReturned: false };
    } catch (error) {
      error.details = { operationEffectState: intentPersisted ? "unknown" : "none", mutationDispatchAttempted: intentPersisted, retryWrite: false, ...(error?.details ?? {}) };
      throw error;
    }
  };
  const result = clipboardWriteLane.then(work, work);
  clipboardWriteLane = result.catch(() => {});
  return result;
}

function requireBinaryBinding(message) {
  const taskId = typeof message?.taskId === "string" ? message.taskId.trim() : "";
  const targetOrigin = typeof message?.targetOrigin === "string" ? message.targetOrigin : "";
  if (!taskId) throw clipboardError("clipboard_task_binding_required", "Binary clipboard requires a task binding");
  let parsed;
  try {
    parsed = new URL(targetOrigin);
  } catch {
    throw clipboardError("clipboard_origin_binding_required", "Binary clipboard requires a valid target origin");
  }
  if (!["http:", "https:"].includes(parsed.protocol)) {
    throw clipboardError("clipboard_origin_binding_required", "Binary clipboard origin must be HTTP or HTTPS");
  }
  return { taskId, targetOrigin: parsed.origin };
}

function requireBinaryMimeType(value) {
  const mimeType = typeof value === "string" ? value.trim().toLowerCase() : "";
  if (!BINARY_CLIPBOARD_MIME_TYPES.has(mimeType)) {
    throw clipboardError("clipboard_mime_not_allowed", "Binary clipboard MIME type is not allowed", {
      mimeType: mimeType || null,
      allowedMimeTypes: [...BINARY_CLIPBOARD_MIME_TYPES],
    });
  }
  return mimeType;
}

function requestedBinaryMaxBytes(message) {
  const value = message?.maxBytes === undefined ? MAX_CLIPBOARD_BYTES : Number(message.maxBytes);
  if (!Number.isSafeInteger(value) || value < 1 || value > MAX_CLIPBOARD_BYTES) {
    throw clipboardError("clipboard_size_invalid", "Binary clipboard maxBytes is outside the allowed bounds", {
      maxBytes: value,
      allowedMaxBytes: MAX_CLIPBOARD_BYTES,
    });
  }
  return Math.min(value, MAX_CLIPBOARD_BYTES);
}

function bytesToBase64(bytes) {
  let value = "";
  const chunkSize = 0x8000;
  for (let offset = 0; offset < bytes.length; offset += chunkSize) {
    value += String.fromCharCode(...bytes.subarray(offset, Math.min(offset + chunkSize, bytes.length)));
  }
  return btoa(value);
}

function base64ToBytes(value, maxBytes = MAX_CLIPBOARD_BYTES) {
  if (typeof value !== "string" || value.length === 0 || value.length > Math.ceil(maxBytes * 4 / 3) + 4) {
    throw clipboardError("clipboard_payload_too_large", "Binary clipboard payload is empty or too large");
  }
  let decoded;
  try {
    decoded = atob(value);
  } catch {
    throw clipboardError("clipboard_base64_invalid", "Binary clipboard payload is not valid base64");
  }
  if (decoded.length > maxBytes) {
    throw clipboardError("clipboard_payload_too_large", "Binary clipboard payload exceeds the approved limit", {
      size: decoded.length,
      maxBytes,
    });
  }
  const bytes = new Uint8Array(decoded.length);
  for (let index = 0; index < decoded.length; index += 1) bytes[index] = decoded.charCodeAt(index);
  return bytes;
}

async function readClipboardBinary(message) {
  const binding = requireBinaryBinding(message);
  if (message?.optIn !== true) throw clipboardError("clipboard_binary_opt_in_required", "Binary clipboard requires explicit opt-in");
  const maxBytes = requestedBinaryMaxBytes(message);
  if (!navigator.clipboard || typeof navigator.clipboard.read !== "function") {
    throw clipboardError("clipboard_binary_unsupported", "This Chrome runtime does not expose Clipboard.read");
  }
  const requested = Array.isArray(message.mimeTypes) && message.mimeTypes.length > 0
    ? message.mimeTypes.map(requireBinaryMimeType)
    : [...BINARY_CLIPBOARD_MIME_TYPES];
  const items = await navigator.clipboard.read();
  for (const item of items) {
    const mimeType = requested.find((candidate) => item.types.includes(candidate));
    if (!mimeType) continue;
    const blob = await item.getType(mimeType);
    if (blob.size > maxBytes) {
      throw clipboardError("clipboard_payload_too_large", "Binary clipboard payload exceeds the approved limit", {
        size: blob.size,
        maxBytes,
      });
    }
    const bytes = new Uint8Array(await blob.arrayBuffer());
    return {
      ok: true,
      binary: true,
      mimeType,
      dataBase64: bytesToBase64(bytes),
      size: bytes.byteLength,
      taskId: binding.taskId,
      targetOrigin: binding.targetOrigin,
    };
  }
  throw clipboardError("clipboard_mime_not_found", "The requested safe MIME type is not present in the clipboard", { requested });
}

function prepareClipboardBinary(message) {
  const binding = requireBinaryBinding(message);
  if (message?.optIn !== true) throw clipboardError("clipboard_binary_opt_in_required", "Binary clipboard requires explicit opt-in");
  const maxBytes = requestedBinaryMaxBytes(message);
  const formats = message.formats ?? [{ mimeType: message.mimeType, dataBase64: message.dataBase64 }];
  if (!Array.isArray(formats) || formats.length < 1 || formats.length > 3) {
    throw clipboardError("clipboard_formats_invalid", "Provide one clipboard item with 1 to 3 MIME representations");
  }
  if (!globalThis.ClipboardItem || !navigator.clipboard || typeof navigator.clipboard.write !== "function") {
    throw clipboardError("clipboard_binary_unsupported", "This Chrome runtime does not expose Clipboard.write");
  }
  const data = {}, metadata = [];
  let totalBytes = 0;
  for (const format of formats) {
    const mimeType = requireBinaryMimeType(format?.mimeType);
    if (!new Set(["text/plain", "text/html", "image/png"]).has(mimeType)
      || (typeof ClipboardItem.supports === "function" && !ClipboardItem.supports(mimeType))) {
      throw clipboardError("clipboard_write_mime_unsupported", "Write text/plain, text/html, or image/png; convert other image types to PNG first", { mimeType });
    }
    if (data[mimeType]) throw clipboardError("clipboard_formats_invalid", "A clipboard item cannot repeat a MIME type");
    const bytes = base64ToBytes(format.dataBase64, maxBytes);
    if (!bytes.byteLength) throw clipboardError("clipboard_base64_invalid", "A MIME representation must contain nonempty decoded bytes");
    totalBytes += bytes.byteLength;
    if (totalBytes > maxBytes) throw clipboardError("clipboard_payload_too_large", "Combined clipboard representations exceed the approved byte limit", { maxBytes });
    data[mimeType] = new Blob([bytes], { type: mimeType });
    metadata.push({ mimeType, inputBytes: bytes.byteLength });
  }
  const item = new ClipboardItem(data);
  return { binding, item, metadata, totalBytes };
}

async function writeClipboardBinary(message, prepared = prepareClipboardBinary(message)) {
  const { binding, item, metadata, totalBytes } = prepared;
  try { await navigator.clipboard.write([item]); }
  catch (error) {
    // A rejected or lost asynchronous write acknowledgement is never a reason
    // to repeat a clipboard mutation. Read the current state before retrying.
    throw clipboardError("clipboard_write_result_unknown", "Chrome did not acknowledge the clipboard write", {
      operationEffectState: "unknown", mutationDispatchAttempted: true, retryWrite: false,
    });
  }
  return {
    ok: true,
    binary: true,
    mimeType: metadata.length === 1 ? metadata[0].mimeType : null,
    size: totalBytes,
    formats: metadata,
    writeAcknowledged: true,
    pasteVerified: false,
    contentReturned: false,
    taskId: binding.taskId,
    targetOrigin: binding.targetOrigin,
  };
}

function clipboardTextArea(value = "") {
  const element = document.createElement("textarea");
  element.value = value;
  element.setAttribute("aria-hidden", "true");
  element.style.position = "fixed";
  element.style.opacity = "0";
  document.body.append(element);
  element.focus();
  element.select();
  return element;
}

async function readClipboardText() {
  try {
    return await navigator.clipboard.readText();
  } catch (primaryError) {
    // Offscreen documents are intentionally never focused. Chrome can reject
    // the modern API for that reason even when clipboardRead is granted. The
    // extension-page paste command is still permission-gated and scoped to
    // this privileged offscreen document.
    const element = clipboardTextArea();
    try {
      if (!document.execCommand("paste")) throw new Error("offscreen paste command was rejected");
      return element.value;
    } catch (fallbackError) {
      throw new Error(`${primaryError instanceof Error ? primaryError.message : String(primaryError)}; ${fallbackError instanceof Error ? fallbackError.message : String(fallbackError)}`);
    } finally {
      element.remove();
    }
  }
}

async function writeClipboardText(text) {
  if (typeof text !== "string" || text.length > MAX_CLIPBOARD_CHARS) throw clipboardError("clipboard_payload_invalid", "Explicit bounded text is required");
  try {
    await navigator.clipboard.writeText(text);
  } catch (primaryError) {
    throw clipboardError("clipboard_write_result_unknown", "Chrome did not acknowledge the text clipboard write; do not repeat it", {
      operationEffectState: "unknown", mutationDispatchAttempted: true, retryWrite: false,
    });
  }
}


chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  // Clipboard messages are accepted only from this Extension's privileged
  // service-worker context. A content script always carries sender.tab and is
  // therefore unable to turn the offscreen document into a clipboard oracle.
  if (sender?.id !== chrome.runtime.id || sender?.tab) return false;
  if (message?.kind === "offscreen.recording.start") {
    startTabRecorder(message).then(result => sendResponse({ ok: true, ...result }))
      .catch(error => sendResponse({ ok: false, code: error.code ?? "recording_start_failed", error: error.message }));
    return true;
  }
  if (message?.kind === "offscreen.recording.stop") {
    stopTabRecorder(message).then(result => sendResponse({ ok: true, ...result }))
      .catch(error => sendResponse({ ok: false, code: error.code ?? "recording_stop_failed", error: error.message }));
    return true;
  }
  if (message?.kind === "offscreen.recording.status") {
    sendResponse({ ok: true, active: Boolean(tabRecorder), tabId: tabRecorder?.tabId ?? lastRecordingResult?.tabId ?? null, taskId: tabRecorder?.taskId ?? lastRecordingResult?.taskId ?? null, startedAt: tabRecorder?.startedAt ?? lastRecordingResult?.startedAt ?? null, lastResult: lastRecordingResult });
    return false;
  }
  if (message?.kind === "offscreen.clipboard.read") {
    if (message.binary === true) {
      readClipboardBinary(message)
        .then((result) => sendResponse({ ok: true, binary: true, ...result }))
        .catch((error) => sendResponse({ ok: false, error: error instanceof Error ? error.message : String(error) }));
      return true;
    }
    readClipboardText()
      .then((text) => sendResponse({ ok: true, text: String(text).slice(0, MAX_CLIPBOARD_CHARS), truncated: String(text).length > MAX_CLIPBOARD_CHARS }))
      .catch((error) => sendResponse({ ok: false, error: error instanceof Error ? error.message : String(error) }));
    return true;
  }
  if (message?.kind === "offscreen.clipboard.write") {
    writeClipboardWithReceipt(message)
      .then(sendResponse)
      .catch(error => sendResponse({ ok: false, code: error.code ?? "clipboard_write_result_unknown", error: error.message, details: error.details }));
    return true;
  }
  if (message?.kind === "offscreen.clipboard.receipt") {
    readClipboardSourceReceipt(message).then(sendResponse)
      .catch(error => sendResponse({ ok: false, code: error.code ?? "clipboard_receipt_failed", error: error.message, details: error.details }));
    return true;
  }
  if (message?.kind === "offscreen.clipboard.binary.read") {
    readClipboardBinary(message)
      .then((result) => sendResponse(result))
      .catch((error) => sendResponse({
        ok: false,
        error: error?.message ?? String(error),
        code: error?.code ?? "clipboard_binary_read_failed",
        details: error?.details ?? {},
      }));
    return true;
  }
  if (message?.kind === "offscreen.clipboard.binary.write") {
    writeClipboardWithReceipt(message)
      .then((result) => sendResponse(result))
      .catch((error) => sendResponse({
        ok: false,
        error: error?.message ?? String(error),
        code: error?.code ?? "clipboard_binary_write_failed",
        details: { operationEffectState: "none", mutationDispatchAttempted: false, ...(error?.details ?? {}) },
      }));
    return true;
  }
  if (message?.kind === "offscreen.native-file-chooser") {
    sendResponse({
      ok: false,
      code: "user_action_required",
      error: "Native file chooser requires the user to choose files",
      userActionRequired: true,
      // No OS automation is attempted from the offscreen document.
    });
    return false;
  }
  return false;
});
