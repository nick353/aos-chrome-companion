import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import test from "node:test";

test("Companion form controls support native and custom dropdowns plus observable file uploads", async () => {
  const source = await readFile(resolve("extension/service-worker.js"), "utf8");

  assert.match(source, /element instanceof HTMLSelectElement/);
  assert.match(source, /Select option was not found/);
  assert.match(source, /HTMLSelectElement\.prototype, "value"/);
  assert.match(source, /new Event\("change", \{ bubbles: true, composed: true \}\)/);
  assert.match(source, /case "page\.selectOption"/);
  assert.match(source, /case "page\.inspectDropdown"/);
  assert.match(source, /action === "inspectDropdown"/);
  assert.match(source, /companion_dropdown_control_unsupported/);
  assert.match(source, /surface_handoff_candidate/);
  assert.match(source, /action === "selectOption"/);
  assert.match(source, /locator\.question/);
  assert.match(source, /locator\.ordinal/);
  assert.match(source, /aria-controls/);
  assert.match(source, /aria-owns/);
  assert.match(source, /dropdown_option_ambiguous/);
  assert.match(source, /dropdown_selection_not_committed/);
  assert.match(source, /selectionCommitted: true/);
  assert.match(source, /frameIds: \[requestedFrameId\]/);
  assert.match(source, /physical_fallback_iframe_coordinate_space_unsupported/);
  assert.match(source, /visual_input_iframe_coordinate_space_unsupported/);
  assert.match(source, /"aria_controlled_listbox"/);
  assert.match(source, /formSubmitControl/);
  assert.match(source, /mutationDispatchAttempted: true/);
  assert.match(source, /HTMLInputElement\.prototype, "files"/);
  assert.match(source, /upload_file_readback_failed/);
  assert.match(source, /inputFileCount/);
  assert.match(source, /expectedFiles/);
  assert.match(source, /pageInstanceId/);
  assert.match(source, /function bindInjectionDocumentIdentity\(results\)/);
  assert.match(source, /entry\.documentId/);
  assert.match(source, /chrome-document:/);
  assert.match(source, /action === "inspectCaptcha"/);
  assert.match(source, /passiveTextOnly/);
  assert.match(source, /real widget surface/);
  assert.match(source, /extension_build_id_mismatch/);
  assert.match(source, /markNativePortDisconnected\(port, runtimeState\.lastError(?:, \{ phase: "peer\.error" \})?\)/);
  assert.match(source, /async function ensureTaskGroup\(tab, \{ taskId, taskLabel, collapsed = false \} = \{\}\)/);
  assert.match(source, /collapsed: collapsed === true/);
  assert.match(source, /const collapsed = params\.collapsed === true/);
});

test("Companion exposes bounded semantic parity actions without claiming trusted physical input", async () => {
  const source = await readFile(resolve("extension/service-worker.js"), "utf8");
  const constants = await readFile(resolve("src/shared/constants.mjs"), "utf8");

  for (const method of [
    "tabs.back", "tabs.forward", "tabs.reload",
    "page.doubleClick", "page.hover", "page.setChecked", "page.pressKey", "page.scroll",
  ]) {
    assert.match(source, new RegExp(`case "${method.replace(".", "\\.")}"`));
  }
  assert.match(source, /checked_state_not_committed/);
  assert.match(source, /key_not_allowed/);
  assert.match(source, /scroll_direction_invalid/);
  assert.match(source, /history_entry_unavailable/);
  assert.match(source, /action === "historyNavigate"/);
  assert.match(source, /globalThis\.navigation\?\.entries/);
  assert.match(source, /globalThis\.history\?\.length/);
  assert.match(source, /globalThis\.history\[direction\]\(\)/);
  assert.match(source, /requireTransition: true/);
  assert.match(source, /mutationDispatchAttempted: false/);
  assert.match(source, /trustedInput: false/);
  assert.match(constants, /"page\.snapshot": 30_000/);
  assert.match(constants, /"page\.click": 30_000/);
  assert.match(constants, /"page\.scroll": 30_000/);
  assert.match(constants, /"page\.selectOption": 60_000/);
  assert.match(constants, /"visual\.click": 60_000/);
  assert.match(constants, /"page\.download": 60_000/);
  assert.doesNotMatch(source, /Runtime\.evaluate/);
});

test("Companion exposes screenshot-bound trusted input only behind required debugger access and explicit opt-in", async () => {
  const source = await readFile(resolve("extension/service-worker.js"), "utf8");
  const debuggerPool = await readFile(resolve("extension/page-observation.js"), "utf8");
  const broker = await readFile(resolve("src/broker/broker.mjs"), "utf8");
  const popup = await readFile(resolve("extension/popup.js"), "utf8");
  const manifest = JSON.parse(await readFile(resolve("extension/manifest.json"), "utf8"));

  assert.ok(manifest.permissions.includes("debugger"));
  assert.ok(!manifest.optional_permissions.includes("debugger"));
  assert.match(source, /action === "inspectVisualTarget"/);
  assert.match(source, /action === "inspectVisualPoint"/);
  assert.match(source, /action === "showVisualPoint"/);
  assert.match(source, /pointer-events:none/);
  assert.match(source, /osCursorMoved: false/);
  assert.match(source, /previousActiveTabId/);
  assert.match(source, /visual_secondary_button_requires_explicit_opt_in/);
  assert.match(source, /visual_modifier_requires_explicit_opt_in/);
  assert.match(source, /virtualOnly === true/);
  assert.match(source, /foregroundActivated: false/);
  assert.doesNotMatch(source, /AppleScript|osascript|CGEvent|RobotJS|robotjs|Accessibility API|native HID/iu);
  assert.match(source, /visual_target_outside_viewport/);
  assert.match(source, /visual_input_permission_required/);
  assert.match(source, /debuggerSessions\.acquire\(tabId\)/);
  assert.match(debuggerPool, /this\.api\.attach\(state\.target, "1\.3"\)/);
  assert.match(source, /chrome\.tabs\.update\(tabId, \{ active: true \}\)/);
  assert.match(source, /chrome\.windows\.update\(taskTab\.windowId, \{ focused: true \}\)/);
  assert.match(source, /foregroundActivated: true/);
  assert.match(source, /Input\.dispatchMouseEvent/);
  assert.match(source, /Input\.dispatchKeyEvent/);
  assert.match(source, /debuggerLease\.release\(\)/);
  assert.match(debuggerPool, /this\.api\.detach\(state\.target\)/);
  assert.doesNotMatch(source, /Runtime\.evaluate/);
  assert.match(popup, /kind: "physicalInput\.set"/);
  assert.match(source, /PHYSICAL_INPUT_ENABLED_KEY/);
  assert.match(source, /hasPhysicalInputOptIn/);
  assert.doesNotMatch(source, /permission\.debugger\.request/);
  assert.doesNotMatch(popup, /chrome\.permissions\.request\(\{ permissions: \["debugger"\] \}\)/);
  assert.match(broker, /visual_target_proof_stale_geometry/);
  assert.match(broker, /error\.details\.method/);
  assert.match(broker, /error\.details\.timeoutMs/);
  assert.match(broker, /method: "visual\.inspectTarget"/);
  assert.match(broker, /method: "visual\.inspectPoint"/);
  assert.match(broker, /visual_point_proof\.v1/);
  assert.match(broker, /visual_point_confirmation/);
  assert.match(broker, /virtualOnly === true/);
  assert.match(broker, /sameScroll/);
  assert.match(source, /scroll: \{ x: Math\.round\(scrollX\), y: Math\.round\(scrollY\) \}/);
  assert.match(broker, /scroll: false/);
  assert.match(broker, /\n      locator,\n      locatorDigest:/);
  assert.match(broker, /payload\.locatorDigest === payloadDigest\(this\.ledgerSecret, locator\)/);
  assert.match(broker, /web_operation_source_state_binding_mismatch/);
  assert.match(broker, /live_target_snapshot_sha256/);
});

test("Companion uses semantic input first and falls back to one screenshot-bound physical input only after verified no effect", async () => {
  const source = await readFile(resolve("extension/service-worker.js"), "utf8");

  assert.match(source, /physicalFallback === "on_verified_no_effect"/);
  assert.match(source, /runTypeWithVerifiedPhysicalFallback/);
  assert.match(source, /verifyCommit: true/);
  assert.match(source, /semanticNoEffectVerified/);
  assert.match(source, /semantic_input_effect_ambiguous/);
  assert.match(source, /physical_fallback_target_changed/);
  assert.match(source, /physical_fallback_visual_semantic_mismatch/);
  assert.match(source, /captureExactTabScreenshot/);
  assert.match(source, /sameVisualTargetState/);
  assert.match(source, /method === "visual\.typeText"/);
  assert.match(source, /Input\.insertText/);
  assert.match(source, /chrome\.runtime\.getPlatformInfo\(\)/);
  assert.match(source, /const isMac = \/mac\/iu\.test\(platform\)/);
  assert.match(source, /physicalFallbackAttempted: true/);
  assert.match(source, /operationEffectState: "none"/);
  assert.match(source, /mutationDispatchAttempted: false/);
  assert.match(source, /fallbackReason: "semantic_input_no_effect_verified"/);
  assert.match(source, /action === "verifyTypeValue"/);
  assert.match(source, /physical_input_not_committed/);
  assert.match(source, /physical_fallback_requires_replace_mode/);
  assert.doesNotMatch(source, /page\.click[^\n]+physicalFallback/);
  assert.doesNotMatch(source, /page\.submit[^\n]+physicalFallback/);
});

test("Companion operating contract keeps foreign tasks non-blocking and forbids alternate-method submit retries", async () => {
  const skill = await readFile(resolve("plugins/aos-chrome-companion/skills/aos-chrome-companion/SKILL.md"), "utf8");
  const mcp = await readFile(resolve("src/mcp/server.mjs"), "utf8");

  assert.match(skill, /foreign task's[\s\S]+is not a global stop condition/);
  assert.match(skill, /foreign task tabs must not[\s\S]+`unknown_effect`/);
  assert.match(skill, /use one exact semantic `page\.click`[\s\S]+Never switch submit methods/);
  assert.match(mcp, /foreign resources are informational, never adopt them/);
  assert.match(mcp, /never switch to page\.submit or a second click/);
});

test("Companion can select one exact contenteditable text range before semantic rich-text toolbar actions", async () => {
  const source = await readFile(resolve("extension/service-worker.js"), "utf8");
  const constants = await readFile(resolve("src/shared/constants.mjs"), "utf8");
  const skill = await readFile(resolve("plugins/aos-chrome-companion/skills/aos-chrome-companion/SKILL.md"), "utf8");

  assert.match(source, /case "page\.selectText"/);
  assert.match(source, /action === "selectText"/);
  assert.match(source, /contenteditable_required/);
  assert.match(source, /selection_text_ambiguous/);
  assert.match(source, /selection\.addRange\(range\)/);
  assert.match(source, /selectionCommitted: true/);
  assert.match(constants, /"page\.selectText": 30_000/);
  assert.match(skill, /For contenteditable rich-text editors, use `page\.selectText`/);
  assert.match(skill, /do not[\s\S]+guessed physical drag/);
});

test("Companion semantic locators expose bounded composite, ancestor, and state matching", async () => {
  const source = await readFile(resolve("extension/service-worker.js"), "utf8");
  const mcp = await readFile(resolve("src/mcp/server.mjs"), "utf8");
  assert.match(source, /const ancestorNodes =/);
  assert.match(source, /const matchesState =/);
  assert.match(source, /locator\.allOf/);
  assert.match(source, /locator\.anyOf/);
  assert.match(source, /locator\.ancestor/);
  assert.match(source, /locator\.within/);
  assert.match(source, /state,/);
  assert.match(mcp, /ancestor: z\.record/);
  assert.match(mcp, /within: z\.record/);
  assert.match(mcp, /allOf: z\.array/);
  assert.match(mcp, /anyOf: z\.array/);
  assert.match(mcp, /state: z\.record/);
});

test("Companion maps same-origin nested frame points and exposes a bounded rich-text adapter", async () => {
  const source = await readFile(resolve("extension/service-worker.js"), "utf8");
  const broker = await readFile(resolve("src/broker/broker.mjs"), "utf8");
  const snapshot = await readFile(resolve("extension/semantic-snapshot.js"), "utf8");
  const schema = await readFile(resolve("src/shared/operation-schema.mjs"), "utf8");
  assert.match(source, /const frameCoordinateMap =/);
  assert.match(source, /top-level-viewport/);
  assert.match(source, /framePath/);
  assert.match(source, /frame_coordinate_transform_unavailable/);
  assert.match(source, /action === "richText"/);
  assert.match(source, /richTextStructure/);
  assert.match(source, /rich_text_operation_unsupported/);
  assert.match(source, /document\.execCommand\(command, false, value\)/);
  assert.match(broker, /coordinateSpace/);
  assert.match(broker, /framePath/);
  assert.match(snapshot, /topLevelUrl/);
  assert.match(snapshot, /framePath/);
  assert.match(schema, /\["page\.richText", true, true, false\]/);
});

test("Companion exposes separate bounded visual keyDown/keyUp actions without OS input", async () => {
  const source = await readFile(resolve("extension/service-worker.js"), "utf8");
  const schema = await readFile(resolve("src/shared/operation-schema.mjs"), "utf8");
  assert.match(source, /method === "visual\.pressKey" \|\| method === "visual\.keyDown" \|\| method === "visual\.keyUp"/);
  assert.match(source, /keyEventType/);
  assert.match(source, /osCursorMoved: false/);
  assert.match(schema, /\["visual\.keyDown", true, true, true\]/);
  assert.match(schema, /\["visual\.keyUp", true, true, true\]/);
  assert.doesNotMatch(source, /AppleScript|osascript|CGEvent|RobotJS|robotjs|Accessibility API|native HID/iu);
});
