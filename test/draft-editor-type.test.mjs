import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

// The production page.type branch against a Draft.js double (X's post box). A direct DOM edit
// showed the lines in the box while X published one paragraph (AOS run 8184, 2026-10-18), so a
// Draft.js editor gets the text as a paste and only the same line blocks count as committed.
const source = await readFile(new URL("../extension/service-worker.js", import.meta.url), "utf8");
const start = source.indexOf('  if (action === "type") {');
const end = source.indexOf('  if (action === "verifyTypeValue") {', start);
assert.ok(start > 0 && end > start);
const AsyncFunction = Object.getPrototypeOf(async function () {}).constructor;
const pageType = new AsyncFunction("env", `with (env) { ${source.slice(start, end)} }`);

const body = "中国がAIを含む40技術の輸出規制案を公表\n\nAI関連は先端モデルなど23件\n・まだ草案の段階";

class DataTransfer {
  constructor() { this.values = new Map(); }
  setData(type, value) { this.values.set(type, value); }
  getData(type) { return this.values.get(type) ?? ""; }
}
class ClipboardEvent {
  constructor(type, init) { Object.assign(this, { type, clipboardData: init.clipboardData, defaultPrevented: false }); }
  preventDefault() { this.defaultPrevented = true; }
}

// onPaste: "split" makes one block per line like Draft.js, "merge" keeps one block, "ignore"
// leaves the editor alone. Before is the editor's current lines.
function draftEnv({ onPaste = "split", before = [""], clear = true, text = body, draft = true } = {}) {
  let blocks = [...before];
  const calls = { insertNode: 0, collapse: [], events: [] };
  const element = {
    isContentEditable: true,
    get innerText() { return blocks.join("\n"); },
    get textContent() { return blocks.join(""); },
    matches: (selector) => draft && selector === ".public-DraftEditor-content",
    querySelector: (selector) => (draft && selector === "[data-contents='true']" ? {} : null),
    querySelectorAll: (selector) => (selector === "[data-block='true']" && draft ? blocks.map((line) => ({ textContent: line })) : []),
    scrollIntoView() {}, focus() {},
    dispatchEvent(event) {
      calls.events.push(event.type ?? event.constructor.name);
      if (event.type !== "paste" || onPaste === "ignore") return true;
      const pasted = event.clipboardData.getData("text/plain").split("\n");
      if (onPaste === "merge") blocks = [pasted.join("")];
      else if (clear) blocks = pasted;
      else { const last = blocks.pop(); blocks.push(last + pasted[0], ...pasted.slice(1)); }
      event.preventDefault();
      return false;
    },
  };
  const range = { selectNodeContents() {}, collapse: (toStart) => calls.collapse.push(toStart), deleteContents() {},
    insertNode: () => { calls.insertNode++; }, setStartAfter() {} };
  class Input {}
  const env = {
    action: "type", payload: { locator: {}, text, clear, clearExplicit: clear, verifyCommit: true },
    find: () => element, HTMLInputElement: Input, HTMLTextAreaElement: Input, HTMLSelectElement: class {},
    operationError: (code, message) => Object.assign(new Error(message), { code }), describe: () => ({}),
    visualize: async () => {}, wait: async () => {}, DataTransfer, ClipboardEvent,
    InputEvent: class { constructor(type) { this.type = type; } }, Event: class { constructor(type) { this.type = type; } },
    globalThis: { getSelection: () => ({ removeAllRanges() {}, addRange() {} }) },
    document: { createRange: () => range, createElement: () => ({ firstChild: null }), createDocumentFragment: () => ({ lastChild: null, appendChild() {} }) },
  };
  return { env, calls, blocks: () => blocks };
}

test("a Draft.js editor gets the lines as a paste and one block per line counts as committed", async () => {
  const { env, calls, blocks } = draftEnv();
  const result = await pageType(env);
  assert.deepEqual(blocks(), body.split("\n"));
  assert.equal(result.semanticCommitted, true);
  assert.equal(result.draftEditor, true);
  assert.equal(result.draftPasteHandled, true);
  assert.equal(result.draftLinesVerified, true);
  assert.deepEqual([result.lineCount, result.expectedLineCount], [4, 4]);
  // No direct DOM edit and no synthetic input event that Draft.js would read from the DOM.
  assert.equal(calls.insertNode, 0);
  assert.deepEqual(calls.events, ["paste"]);
});

test("lines that Draft.js keeps in one block are never counted as committed", async () => {
  const { env } = draftEnv({ onPaste: "merge" });
  const result = await pageType(env);
  assert.equal(result.semanticCommitted, false);
  assert.equal(result.typed, false);
  assert.equal(result.draftLinesVerified, false);
  assert.deepEqual([result.lineCount, result.expectedLineCount], [1, 4]);
});

test("an editor that ignores the paste is left untouched and reported as no effect", async () => {
  const { env, calls, blocks } = draftEnv({ onPaste: "ignore" });
  const result = await pageType(env);
  assert.deepEqual(blocks(), [""]);
  assert.equal(result.semanticCommitted, false);
  assert.equal(result.semanticNoEffectVerified, true);
  assert.equal(result.draftPasteHandled, false);
  assert.equal(calls.insertNode, 0);
});

test("appending to a Draft.js editor pastes at the end and checks the joined lines", async () => {
  const { env, calls, blocks } = draftEnv({ before: ["1行目"], clear: false, text: "（続き）\n\n・2行目" });
  const result = await pageType(env);
  assert.deepEqual(blocks(), ["1行目（続き）", "", "・2行目"]);
  assert.deepEqual(calls.collapse, [false]);
  assert.equal(result.semanticCommitted, true);
  assert.equal(result.expectedLineCount, 3);
});

test("other rich editors keep the DOM insertion path", async () => {
  const { env, calls } = draftEnv({ draft: false, text: "Line one" });
  const result = await pageType(env);
  assert.equal(calls.insertNode, 1);
  assert.equal(result.draftEditor, undefined);
  assert.ok(calls.events.includes("input"));
});

test("a Draft.js editor that did not take multi-line text never falls back to one physical retype", () => {
  const fallback = source.slice(source.indexOf("async function runTypeWithVerifiedPhysicalFallback("), source.indexOf("async function executeCommand("));
  const guard = fallback.indexOf("draft_editor_multiline_physical_fallback_unsupported");
  assert.ok(guard > 0);
  assert.match(fallback.slice(guard - 200, guard), /semantic\?\.draftEditor === true && String\(payload\.text\)\.includes\("\\n"\)/);
  // The guard sits before the tab is brought forward for the physical input.
  assert.ok(guard < fallback.indexOf('runTrustedVisualInput(tabId, "visual.typeText"'));
  assert.ok(guard < fallback.indexOf("chrome.tabs.update(tabId, { active: true })"));
});
