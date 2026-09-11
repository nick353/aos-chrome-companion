import { createHash } from "node:crypto";
import { constants } from "node:fs";
import { lstat, open } from "node:fs/promises";
import { basename, extname, isAbsolute } from "node:path";
import { CompanionError } from "../shared/errors.mjs";
import { MAX_CLIPBOARD_BINARY_BYTES, MAX_UPLOAD_FILE_BYTES, MAX_UPLOAD_FILES } from "../shared/peripheral-policy.mjs";

export const MAX_UPLOAD_BYTES = MAX_UPLOAD_FILE_BYTES;
export const MAX_UPLOAD_TOTAL_BYTES = MAX_UPLOAD_FILE_BYTES;

const MIME_BY_EXTENSION = Object.freeze({
  ".doc": "application/msword",
  ".docx": "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  ".jpeg": "image/jpeg",
  ".jpg": "image/jpeg",
  ".pdf": "application/pdf",
  ".png": "image/png",
  ".txt": "text/plain",
  ".webp": "image/webp",
});

function uploadError(code, message, details) {
  return new CompanionError(code, message, { ...details, operationEffectState: "none", mutationDispatchAttempted: false });
}

function uploadConfirmationOptions(params) {
  const options = {};
  if (params.confirmationLocator !== undefined) {
    if (!params.confirmationLocator || typeof params.confirmationLocator !== "object" || Array.isArray(params.confirmationLocator)) {
      throw uploadError("upload_confirmation_locator_invalid", "Upload confirmation requires one explicit visible locator");
    }
    options.confirmationLocator = params.confirmationLocator;
  }
  if (params.confirmationTimeoutMs !== undefined) {
    if (!Number.isSafeInteger(params.confirmationTimeoutMs) || params.confirmationTimeoutMs < 100 || params.confirmationTimeoutMs > 15_000) {
      throw uploadError("upload_confirmation_timeout_invalid", "Upload confirmation timeout must be 100-15000 ms");
    }
    options.confirmationTimeoutMs = params.confirmationTimeoutMs;
  }
  return options;
}

export async function materializeUploadParams(params = {}) {
  const confirmation = uploadConfirmationOptions(params);
  const filePath = params.filePath;
  if (typeof filePath !== "string" || !isAbsolute(filePath) || filePath.includes("\0")) {
    throw uploadError("upload_absolute_path_required", "page.upload requires an absolute filePath");
  }
  const stat = await lstat(filePath).catch((error) => {
    throw uploadError("upload_file_unavailable", "Upload file is unavailable", { cause: error?.code ?? "unknown" });
  });
  if (stat.isSymbolicLink() || !stat.isFile()) {
    throw uploadError("upload_regular_file_required", "Upload source must be a regular non-symlink file");
  }
  if (stat.size > MAX_UPLOAD_BYTES) {
    throw uploadError("upload_file_too_large", `Upload file exceeds ${MAX_UPLOAD_BYTES} bytes`, { size: stat.size, maxBytes: MAX_UPLOAD_BYTES });
  }
  const extension = extname(filePath).toLowerCase();
  const mimeType = MIME_BY_EXTENSION[extension];
  if (!mimeType) {
    throw uploadError("upload_file_type_not_allowed", "Upload file type is not allowed", { extension: extension || null });
  }
  let descriptor, data;
  try {
    descriptor = await open(filePath, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0) | (constants.O_NONBLOCK ?? 0));
    const before = await descriptor.stat();
    const stable = (left, right) => ["dev", "ino", "size", "mtimeMs", "ctimeMs"].every(key => left[key] === right[key]);
    if (!before.isFile() || !stable(before, stat)) throw uploadError("upload_file_changed", "Upload source changed before it could be read");
    data = Buffer.alloc(before.size);
    let offset = 0;
    while (offset < data.length) {
      const read = await descriptor.read(data, offset, data.length - offset, offset);
      if (!read.bytesRead) break;
      offset += read.bytesRead;
    }
    const after = await descriptor.stat(), afterPath = await lstat(filePath);
    if (offset !== data.length || afterPath.isSymbolicLink() || !afterPath.isFile() || !stable(before, after) || !stable(before, afterPath)) {
      throw uploadError("upload_file_changed", "Upload source or path changed during reading");
    }
  } catch (error) {
    if (error instanceof CompanionError) throw error;
    throw uploadError("upload_file_unavailable", "The exact upload source file could not be read", { cause: error?.code ?? "unknown" });
  } finally {
    await descriptor?.close();
  }
  return {
    locator: params.locator,
    ...confirmation,
    file: {
      name: basename(filePath),
      mimeType,
      size: data.byteLength,
      sha256: createHash("sha256").update(data).digest("hex"),
      dataBase64: data.toString("base64"),
    },
  };
}

export async function materializeUploadMultipleParams(params = {}) {
  const confirmation = uploadConfirmationOptions(params);
  const paths = Array.isArray(params.filePaths) ? params.filePaths : [];
  if (paths.length < 1 || paths.length > MAX_UPLOAD_FILES) throw uploadError("upload_file_count_invalid", "page.uploadMultiple requires 1-10 absolute filePaths");
  const files = [];
  let totalBytes = 0;
  for (const filePath of paths) {
    const materialized = await materializeUploadParams({ ...params, filePath });
    totalBytes += materialized.file.size;
    if (totalBytes > MAX_UPLOAD_TOTAL_BYTES) throw uploadError("upload_total_too_large", "Files in one upload must total at most 25 MiB", { totalBytes, maxBytes: MAX_UPLOAD_TOTAL_BYTES });
    files.push(materialized.file);
  }
  return { locator: params.locator, files, ...confirmation };
}

export async function materializeClipboardParams(params = {}) {
  if (params.formats === undefined) return params;
  const fail = (code,message) => new CompanionError(code,message,{operationEffectState:"none",mutationDispatchAttempted:false});
  if (params.text !== undefined || params.approved !== true || !Array.isArray(params.formats) || params.formats.length < 1 || params.formats.length > 3) throw fail("clipboard_write_payload_invalid","Provide 1 to 3 MIME representations with approved:true, or explicit text");
  const formats=[], seen=new Set();let totalBytes=0;
  for (const format of params.formats) {
    if (!new Set(["text/plain","text/html","image/png"]).has(format?.mimeType) || seen.has(format.mimeType)) throw fail("clipboard_write_mime_unsupported","Use unique text/plain, text/html, or image/png representations");
    seen.add(format.mimeType);
    if ((format.dataBase64 !== undefined) === (format.filePath !== undefined)) throw fail("clipboard_write_payload_invalid","Each MIME representation needs exactly one dataBase64 or absolute filePath");
    let data;
    if (format.filePath !== undefined) {
      if (typeof format.filePath !== "string" || !isAbsolute(format.filePath) || format.filePath.includes("\0")) throw fail("clipboard_file_path_invalid","Clipboard filePath must be an absolute local path");
      let descriptor;
      try {
        const beforePath=await lstat(format.filePath);
        if (beforePath.isSymbolicLink() || !beforePath.isFile()) throw fail("clipboard_regular_file_required","Clipboard source must be a regular non-symlink file");
        if (beforePath.size < 1 || beforePath.size + totalBytes > MAX_CLIPBOARD_BINARY_BYTES) throw fail("clipboard_payload_too_large","Clipboard representations must be nonempty and total at most 2 MiB");
        descriptor=await open(format.filePath,constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0) | (constants.O_NONBLOCK ?? 0));
        const before=await descriptor.stat();
        const stable=(left,right)=>["dev","ino","size","mtimeMs","ctimeMs"].every(key=>left[key]===right[key]);
        if (!before.isFile() || !stable(before,beforePath)) throw fail("clipboard_file_changed","Clipboard source changed before it could be read");
        data=Buffer.alloc(before.size);let offset=0;
        while (offset < data.length) {const read=await descriptor.read(data,offset,data.length-offset,offset);if (!read.bytesRead) break;offset+=read.bytesRead;}
        const after=await descriptor.stat(),afterPath=await lstat(format.filePath);
        if (offset!==data.length || afterPath.isSymbolicLink() || !afterPath.isFile() || !stable(before,after) || !stable(before,afterPath)) throw fail("clipboard_file_changed","Clipboard source or path changed during reading");
      } catch (error) {
        if (error instanceof CompanionError) throw error;
        throw fail("clipboard_file_unavailable","The exact clipboard source file could not be read");
      } finally {await descriptor?.close();}
    } else {
      if (typeof format.dataBase64 !== "string" || !format.dataBase64.length || format.dataBase64.length > 2796208) throw fail("clipboard_payload_too_large","Clipboard representation exceeds the 2 MiB limit");
      try {const decoded=atob(format.dataBase64);if (!decoded.length) throw Error();data=Buffer.from(decoded,"binary");} catch {throw fail("clipboard_base64_invalid","Clipboard representation must contain nonempty base64 bytes");}
    }
    totalBytes+=data.length;if (totalBytes > MAX_CLIPBOARD_BINARY_BYTES) throw fail("clipboard_payload_too_large","Clipboard representations exceed the 2 MiB combined limit");
    // Keep local paths on the host. Only bounded MIME bytes enter the signed
    // transaction and the native command transport.
    formats.push({mimeType:format.mimeType,dataBase64:data.toString("base64")});
  }
  return {...params,formats};
}

export async function materializeTransactionActions(actions = []) {
  return Promise.all(actions.map(async (action) => ({
    ...action,
    params: action?.method === "page.upload"
      ? await materializeUploadParams(action.params)
      : action?.method === "page.uploadMultiple"
        ? await materializeUploadMultipleParams(action.params)
      : action?.method === "clipboard.write"
        ? await materializeClipboardParams(action.params)
      : (action?.params ?? {}),
  })));
}
