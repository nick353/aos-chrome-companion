import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import test from "node:test";
import { DEFAULT_CAPABILITIES, MUTATION_METHODS, PROFILE_GLOBAL_METHODS, TARGET_METHODS } from "../src/shared/constants.mjs";

test("P3 peripheral capabilities are bounded and correctly classified", async () => {
  assert.ok(DEFAULT_CAPABILITIES.includes("extension.reload"));
  assert.ok(MUTATION_METHODS.has("extension.reload"));
  assert.ok(PROFILE_GLOBAL_METHODS.has("extension.reload"));
  for (const method of [
    "page.query", "page.exportContent", "page.webMcpDiscover", "page.download", "clipboard.read", "clipboard.write",
    "page.inspectDialog", "page.handleDialog", "page.readConsole", "page.webMcpCall", "page.exportArtifact",
    "page.inspectCaptcha", "page.domDiff", "page.readNetwork", "page.elementScreenshot", "clipboard.readBinary",
    "page.uploadMultiple", "page.nativeChooser", "tabs.claimExisting",
  ]) {
    assert.ok(DEFAULT_CAPABILITIES.includes(method), method);
    assert.ok(TARGET_METHODS.has(method), method);
  }
  for (const method of ["page.download", "clipboard.write", "page.handleDialog", "page.webMcpCall", "page.uploadMultiple", "page.nativeChooser", "tabs.claimExisting"]) assert.ok(MUTATION_METHODS.has(method), method);
  for (const method of ["page.download", "clipboard.read", "clipboard.write", "page.inspectDialog", "page.handleDialog", "page.readConsole"]) {
    assert.ok(PROFILE_GLOBAL_METHODS.has(method), method);
  }

  const manifest = JSON.parse(await readFile(resolve("extension/manifest.json"), "utf8"));
  assert.ok(manifest.permissions.includes("offscreen"));
  assert.deepEqual(manifest.optional_permissions, ["downloads", "clipboardRead", "clipboardWrite", "history", "bookmarks"]);
  assert.ok(!manifest.permissions.includes("history") && !manifest.permissions.includes("bookmarks"));
});

test("P3 implementation strips active content, redacts logs, and never exposes arbitrary evaluation", async () => {
  const source = await readFile(resolve("extension/service-worker.js"), "utf8");
  const offscreen = await readFile(resolve("extension/offscreen.js"), "utf8");
  const popup = await readFile(resolve("extension/popup.js"), "utf8");
  const dialogs = await readFile(resolve("extension/javascript-dialog.js"), "utf8");

  assert.match(source, /action === "query"/);
  assert.match(source, /action === "exportContent"/);
  assert.match(source, /const redactExportText =/);
  assert.match(source, /const redacted = redactExportText\(content, maxChars\)/);
  assert.match(source, /script,style,noscript,template/);
  assert.match(source, /removeAttribute\("value"\)/);
  assert.match(source, /HTMLTextAreaElement\) element\.textContent = ""/);
  assert.match(source, /action === "webMcpDiscover"/);
  assert.match(source, /action === "webMcpCall"/);
  assert.match(source, /action === "inspectCaptcha"/);
  assert.match(source, /action === "domDiff"/);
  assert.match(source, /action === "readNetwork"/);
  assert.match(source, /action === "exportArtifact"/);
  assert.match(source, /action === "uploadMultiple"/);
  assert.match(source, /native_file_chooser_user_required/);
  assert.match(source, /existing_tab_claim_requires_user_approval/);
  assert.match(source, /webmcp_tool_not_allowlisted/);
  assert.match(source, /visible_captcha_widget_user_required/);
  assert.match(source, /bare sitekey attribute/);
  assert.match(source, /data-sitekey[\s\S]*?interactive descendant|interactive descendant[\s\S]*?data-sitekey/u);
  assert.match(source, /\[tabindex\]:not\(\[tabindex='-1'\]\)/u);
  assert.match(source, /invocation_supported: false/);
  assert.match(source, /downloads_permission_required/);
  assert.match(source, /clipboard_permission_required/);
  assert.match(source, /offscreen\.clipboard/);
  assert.match(source, /redacted-jwt/);
  assert.match(source, /redacted-private-key/);
  assert.match(source, /download_redirect_origin_not_allowed/);
  assert.match(source, /download_dangerous_blocked/);
  assert.match(source, /chrome\.downloads\.onChanged\.addListener\(onChanged\)/);
  assert.match(source, /chrome\.downloads\.cancel\(downloadId\)/);
  assert.match(source, /chrome\.downloads\.removeFile\(downloadId\)/);
  assert.match(source, /chrome\.downloads\.erase\(\{ id: downloadId \}\)/);
  assert.match(source, /history.*false|historicalReplay: false/);
  assert.match(dialogs, /dialog_prompt_text_required/);
  assert.match(dialogs, /sensitive_dialog_user_required/);
  assert.match(dialogs, /const noEffect = \{ operationEffectState: "none", mutationDispatchAttempted: false \}/);
  assert.doesNotMatch(source, /Runtime\.evaluate/);
  assert.match(offscreen, /sender\?\.id !== chrome\.runtime\.id \|\| sender\?\.tab/);
  assert.match(offscreen, /document\.execCommand\("paste"\)/);
  assert.match(offscreen, /document\.execCommand\("copy"\)/);
  assert.match(offscreen, /clipboard_binary_opt_in_required/);
  assert.match(offscreen, /clipboard_mime_not_allowed/);
  assert.match(offscreen, /clipboard_payload_too_large/);
  assert.match(popup, /chrome\.permissions\.request\(\{ permissions: \["downloads", "clipboardRead", "clipboardWrite"\] \}\)/);
  assert.doesNotMatch(source, /permission\.peripheral\.request/);
});
