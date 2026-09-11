/**
 * Shared bounds for file, clipboard, WebMCP and user-help operations.
 * These values are intentionally conservative: the Companion must fail
 * closed instead of turning a browser permission into an unbounded oracle.
 */
export const MAX_CLIPBOARD_BINARY_BYTES = 2 * 1024 * 1024;
export const MAX_UPLOAD_FILES = 10;
export const MAX_UPLOAD_FILE_BYTES = 25 * 1024 * 1024;
export const MAX_WEBMCP_RESULT_BYTES = 256 * 1024;

export const BINARY_CLIPBOARD_MIME_ALLOWLIST = Object.freeze(new Set([
  "image/png",
  "image/jpeg",
  "image/gif",
  "image/webp",
  "application/pdf",
  "application/json",
  "text/plain",
  "text/html",
]));

export function normalizeBinaryClipboardRequest(input = {}) {
  if (!input || typeof input !== "object" || Array.isArray(input)) {
    throw new Error("binary_clipboard_request_invalid");
  }
  if (input.approved !== true) throw new Error("binary_clipboard_approval_required");
  const mimeTypes = Array.isArray(input.mimeTypes) ? [...new Set(input.mimeTypes.map(String))] : [];
  if (mimeTypes.length === 0 || mimeTypes.length > 8 || mimeTypes.some((mime) => !BINARY_CLIPBOARD_MIME_ALLOWLIST.has(mime))) {
    throw new Error("binary_clipboard_mime_not_allowed");
  }
  const maxBytes = Number.isSafeInteger(input.maxBytes) ? input.maxBytes : MAX_CLIPBOARD_BINARY_BYTES;
  if (maxBytes < 1 || maxBytes > MAX_CLIPBOARD_BINARY_BYTES) throw new Error("binary_clipboard_size_invalid");
  return { approved: true, mimeTypes, maxBytes };
}

export function normalizeUploadFiles(input = {}) {
  const files = Array.isArray(input.files) ? input.files : [];
  if (files.length < 1 || files.length > MAX_UPLOAD_FILES) throw new Error("upload_file_count_invalid");
  return files.map((file) => {
    const path = typeof file?.filePath === "string" ? file.filePath.trim() : "";
    if (!path || path.length > 1_024 || path.includes("\0") || !/^(?:\/|[A-Za-z]:[\\/])/u.test(path)) throw new Error("upload_file_path_invalid");
    const mimeType = typeof file?.mimeType === "string" && file.mimeType.length <= 128 ? file.mimeType : null;
    const size = file?.size === undefined ? null : Number(file.size);
    if (size !== null && (!Number.isSafeInteger(size) || size < 0 || size > MAX_UPLOAD_FILE_BYTES)) throw new Error("upload_file_size_invalid");
    return { filePath: path, ...(mimeType ? { mimeType } : {}), ...(size === null ? {} : { size }) };
  });
}

export function assertBoundedWebMcpResult(value, maxBytes = MAX_WEBMCP_RESULT_BYTES) {
  const rendered = JSON.stringify(value);
  if (typeof rendered !== "string" || Buffer.byteLength(rendered, "utf8") > maxBytes) throw new Error("webmcp_result_too_large");
  return value;
}
