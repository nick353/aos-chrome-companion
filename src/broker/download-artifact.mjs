import {createHash} from 'node:crypto';
import {constants} from 'node:fs';
import {lstat,open,realpath} from 'node:fs/promises';
import {isAbsolute,basename} from 'node:path';
import {CompanionError} from '../shared/errors.mjs';

// Verify only the fresh, trusted chrome.downloads completion result. This
// never searches the user's folders or downloads a missing file again.
export async function verifyDownloadedArtifact(receipt, {expectedTabId, deadlineMs = 15000} = {}) {
  const started = Date.now();
  const fail = (code, message) => new CompanionError(code, message, {
    operationEffectState:'known_effect',mutationDispatchAttempted:true,downloadComplete:receipt?.state === 'complete',
    downloadId:receipt?.downloadId ?? null,restartPoint:'read_completed_download_file',retryDownload:false,
  });
  if (receipt?.source !== 'chrome.downloads' || receipt.state !== 'complete'
    || !Number.isSafeInteger(receipt.downloadId) || receipt.downloadId < 0 || receipt.tabId !== expectedTabId) {
    throw fail('download_completion_receipt_invalid', 'The exact download has no trusted completion receipt');
  }
  if (typeof receipt.filePath !== 'string' || !isAbsolute(receipt.filePath) || receipt.filePath.includes('\0')) {
    throw fail('download_file_path_missing', 'Chrome completed the download without an absolute local file path');
  }
  let descriptor;
  try {
    const beforePath = await lstat(receipt.filePath);
    if (beforePath.isSymbolicLink() || !beforePath.isFile()) throw fail('download_file_not_regular', 'The completed download path is not a regular non-symlink file');
    descriptor = await open(receipt.filePath, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0) | (constants.O_NONBLOCK ?? 0));
    const before = await descriptor.stat();
    if (!before.isFile() || before.dev !== beforePath.dev || before.ino !== beforePath.ino) throw fail('download_file_changed', 'The completed file changed before it could be read');
    // fileSize is decompressed file length. bytesReceived and totalBytes are
    // transfer sizes and cannot validate a gzip download.
    if (Number.isSafeInteger(receipt.fileSize) && receipt.fileSize >= 0 && before.size !== receipt.fileSize) {
      throw fail('download_file_size_mismatch', 'The local file size does not match the completed file size from Chrome');
    }
    const hash = createHash('sha256'), buffer = Buffer.alloc(65536);
    let bytes = 0;
    while (true) {
      if (Date.now() - started > deadlineMs) throw fail('download_file_readback_timeout', 'The download completed but local content verification exceeded its deadline; read the existing file without downloading again');
      const read = await descriptor.read(buffer, 0, buffer.length, bytes);
      if (read.bytesRead === 0) break;
      bytes += read.bytesRead;hash.update(buffer.subarray(0, read.bytesRead));
    }
    const after = await descriptor.stat(), afterPath = await lstat(receipt.filePath);
    if (bytes !== before.size || after.size !== before.size || after.mtimeMs !== before.mtimeMs || after.ctimeMs !== before.ctimeMs
      || afterPath.isSymbolicLink() || !afterPath.isFile() || afterPath.dev !== before.dev || afterPath.ino !== before.ino
      || afterPath.size !== before.size || afterPath.mtimeMs !== before.mtimeMs || afterPath.ctimeMs !== before.ctimeMs) {
      throw fail('download_file_changed', 'The completed file or its path changed during content verification');
    }
    const path = await realpath(receipt.filePath);
    return {kind:'local_download',verified:true,path,filename:basename(path),bytes,sha256:hash.digest('hex'),
      mimeType:typeof receipt.mimeType === 'string' ? receipt.mimeType : null,downloadId:receipt.downloadId,
      fileSizeMatched:Number.isSafeInteger(receipt.fileSize) && receipt.fileSize >= 0 ? true : null,
      contentReturned:false,verifiedAt:new Date().toISOString()};
  } catch (error) {
    if (error instanceof CompanionError) throw error;
    throw fail(error?.code === 'ENOENT' ? 'download_file_missing' : 'download_file_unreadable',
      'The download completed but its local file could not be verified; inspect the existing download without replay');
  } finally { await descriptor?.close(); }
}
