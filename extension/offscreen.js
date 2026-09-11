import {
  BINARY_CLIPBOARD_MIME_ALLOWLIST,
  MAX_CLIPBOARD_BINARY_BYTES,
} from "./peripheral-policy.generated.js";

const MAX_CLIPBOARD_CHARS = 100_000;
// Binary clipboard is intentionally bounded and opt-in.  The offscreen page
// must never become an unbounded clipboard oracle or a general file transport.
const MAX_CLIPBOARD_BYTES = MAX_CLIPBOARD_BINARY_BYTES;
const BINARY_CLIPBOARD_MIME_TYPES = BINARY_CLIPBOARD_MIME_ALLOWLIST;

function clipboardError(code, message, details = {}) {
  const error = new Error(message);
  error.code = code;
  error.details = details;
  return error;
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

async function writeClipboardBinary(message) {
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
  try {
    await navigator.clipboard.writeText(text);
  } catch (primaryError) {
    const element = clipboardTextArea(text);
    try {
      if (!document.execCommand("copy")) throw new Error("offscreen copy command was rejected");
    } catch (fallbackError) {
      throw new Error(`${primaryError instanceof Error ? primaryError.message : String(primaryError)}; ${fallbackError instanceof Error ? fallbackError.message : String(fallbackError)}`);
    } finally {
      element.remove();
    }
  }
}


chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  // Clipboard messages are accepted only from this Extension's privileged
  // service-worker context. A content script always carries sender.tab and is
  // therefore unable to turn the offscreen document into a clipboard oracle.
  if (sender?.id !== chrome.runtime.id || sender?.tab) return false;
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
    if (message.binary === true) {
      writeClipboardBinary(message)
        .then((result) => sendResponse({ ok: true, binary: true, ...result }))
        .catch((error) => sendResponse({ ok: false, error: error instanceof Error ? error.message : String(error) }));
      return true;
    }
    const text = String(message.text ?? "");
    if (text.length > MAX_CLIPBOARD_CHARS) {
      sendResponse({ ok: false, error: "clipboard payload exceeds 100000 characters" });
      return false;
    }
    writeClipboardText(text)
      .then(() => sendResponse({ ok: true, chars: text.length }))
      .catch((error) => sendResponse({ ok: false, error: error instanceof Error ? error.message : String(error) }));
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
    writeClipboardBinary(message)
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
