import assert from "node:assert/strict";
import test from "node:test";
import {
  BINARY_CLIPBOARD_MIME_ALLOWLIST,
  MAX_CLIPBOARD_BINARY_BYTES,
  MAX_UPLOAD_FILES,
  normalizeBinaryClipboardRequest,
  normalizeUploadFiles,
} from "../src/shared/peripheral-policy.mjs";
import {
  BINARY_CLIPBOARD_MIME_ALLOWLIST as GENERATED_MIME_ALLOWLIST,
  MAX_CLIPBOARD_BINARY_BYTES as GENERATED_MAX_BYTES,
} from "../extension/peripheral-policy.generated.js";
import { readFile } from "node:fs/promises";

test("binary clipboard policy is opt-in, allowlisted and bounded", () => {
  assert.throws(() => normalizeBinaryClipboardRequest({ mimeTypes: ["image/png"] }), /approval_required/);
  assert.throws(() => normalizeBinaryClipboardRequest({ approved: true, mimeTypes: ["application/x-secret"] }), /mime_not_allowed/);
  assert.throws(() => normalizeBinaryClipboardRequest({ approved: true, mimeTypes: ["image/png"], maxBytes: MAX_CLIPBOARD_BINARY_BYTES + 1 }), /size_invalid/);
  const valid = normalizeBinaryClipboardRequest({ approved: true, mimeTypes: ["image/png", "image/png"], maxBytes: 1000 });
  assert.deepEqual(valid.mimeTypes, ["image/png"]);
  assert.ok(BINARY_CLIPBOARD_MIME_ALLOWLIST.has(valid.mimeTypes[0]));
});

test("generated offscreen clipboard policy is the shared policy", async () => {
  assert.equal(GENERATED_MAX_BYTES, MAX_CLIPBOARD_BINARY_BYTES);
  assert.deepEqual([...GENERATED_MIME_ALLOWLIST].sort(), [...BINARY_CLIPBOARD_MIME_ALLOWLIST].sort());
  const offscreen = await readFile(new URL("../extension/offscreen.js", import.meta.url), "utf8");
  assert.match(offscreen, /peripheral-policy\.generated\.js/);
  assert.doesNotMatch(offscreen, /application\/octet-stream/);
  assert.match(offscreen, /requestedBinaryMaxBytes/);
  assert.match(offscreen, /blob\.size > maxBytes/);
});

test("multiple upload policy bounds explicit file descriptors", () => {
  assert.throws(() => normalizeUploadFiles({ files: [] }), /count_invalid/);
  assert.throws(() => normalizeUploadFiles({ files: Array.from({ length: MAX_UPLOAD_FILES + 1 }, () => ({ filePath: "/tmp/a" })) }), /count_invalid/);
  assert.throws(() => normalizeUploadFiles({ files: [{ filePath: "relative.txt" }] }), /path_invalid/);
  assert.deepEqual(normalizeUploadFiles({ files: [{ filePath: "/tmp/a", mimeType: "text/plain", size: 4 }] }), [{ filePath: "/tmp/a", mimeType: "text/plain", size: 4 }]);
});
