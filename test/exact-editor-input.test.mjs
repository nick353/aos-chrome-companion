import assert from "node:assert/strict";
import { createHash, webcrypto } from "node:crypto";
import { readFile } from "node:fs/promises";
import test from "node:test";
import vm from "node:vm";

const source = await readFile(new URL("../extension/service-worker.js", import.meta.url), "utf8");
const error = (code, message, details) => Object.assign(new Error(message), { code, details });
function exactFixture(children) {
  const text = value => ({ nodeType: 3, nodeValue: value });
  const node = (tag, children = []) => ({ nodeType: 1, tagName: tag.toUpperCase(), childNodes: children });
  const editor = Object.assign(node("div", children?.({ text, node }) ?? [node("p", [text("alpha"), node("br"), node("span", [text("😀beta")])])]), { isContentEditable: true, id: "body" });
  const selectionNode = editor.childNodes[0]?.childNodes[2]?.childNodes?.[0] ?? editor;
  let selected = { startContainer: selectionNode, startOffset: 2,
    endContainer: selectionNode, endOffset: 2, collapsed: true };
  const selection = { rangeCount: 1, getRangeAt: () => selected, removeAllRanges() {}, addRange(range) { selected = range; } };
  editor.focus = () => {};
  const document = { title: "Article", activeElement: editor, querySelectorAll: () => [editor], createRange: () => ({
    setStart(node, offset) { this.startContainer = node; this.startOffset = offset; },
    collapse() { this.endContainer = this.startContainer; this.endOffset = this.startOffset; this.collapsed = true; },
  }) };
  const context = vm.createContext({ crypto: webcrypto, TextEncoder, document, getSelection: () => selection,
    visible: () => true, operationError: error, location: { href: "https://editor.note.com/notes/article/edit/" }, pageInstanceId: "doc" });
  const start = source.indexOf("  const exactEditorState = async () => {");
  const end = source.indexOf('  if (action === "query") {', start);
  vm.runInContext(`async function run(action, payload) { ${source.slice(start, end)} }`, context);
  return { editor, document, selection, setRange: value => { selected = value; },
    run: (action = "query", params = {}) => context.run(action, { exactEditor: true, locator: { css: "div.ProseMirror" }, ...params }) };
}

test("exact opt-in preserves line breaks, decorations, UTF-16 offsets and body identity", async () => {
  const fixture = exactFixture();
  const read = await fixture.run();
  assert.equal(read.body, "alpha\n😀beta");
  assert.equal(read.bodySha256, createHash("sha256").update(read.body).digest("hex"));
  assert.equal(read.selection.start, 8); assert.equal(read.selection.end, 8);
  assert.equal(read.selection.offsetUnit, "utf16"); assert.equal(read.truncated, false);
  assert.equal(read.articleIdentity.editorId, "body"); assert.equal(read.url, "https://editor.note.com/notes/article/edit/");
  assert.equal(await fixture.run("query", { exactEditor: false }), undefined, "ordinary query falls through to original implementation");
});

test("single paragraph with 311 br returns all 6066 units and projects 6087 target", async () => {
  const fixture = exactFixture(({ text, node }) => [node("p", [text("a".repeat(5755)), ...Array.from({ length: 311 }, () => node("br"))])]);
  const read = await fixture.run();
  assert.equal(read.body.length, 6066); assert.equal(read.body.split("\n").length - 1, 311);
  const question = "質問: 入社後に改善したい業務は何ですか。";
  assert.equal(question.length, 21); assert.equal((read.body.slice(0, 10) + question + read.body.slice(10)).length, 6087);
  await assert.rejects(fixture.run("query", { maxEditorChars: 6065 }), { code: "exact_editor_oversize" });
});

test("exact reader rejects ambiguous, noneditable, unsupported and oversized structures", async () => {
  for (const mutation of [fixture => { fixture.document.querySelectorAll = () => [fixture.editor, fixture.editor]; },
    fixture => { fixture.editor.isContentEditable = false; }]) {
    const fixture = exactFixture(); mutation(fixture);
    await assert.rejects(fixture.run(), { code: "exact_editor_not_unique" });
  }
  await assert.rejects(exactFixture(({ node }) => [node("table")]).run(), { code: "exact_editor_structure_unsupported" });
  await assert.rejects(exactFixture().run("query", { locator: { css: "textarea" } }), { code: "exact_editor_locator_required" });
});

test("collapsed helper rebuilds decorated positions and rejects changed body or selection", async () => {
  const fixture = exactFixture();
  const body = (await fixture.run()).body;
  const prepared = await fixture.run("prepareExactEditor", { expectedBody: body, offset: 6, requireSelection: true, establishSelection: true });
  assert.equal(prepared.selection.start, 6); assert.equal(prepared.selection.collapsed, true);
  await assert.rejects(fixture.run("verifyExactEditor", { expectedBody: body, offset: 7, requireSelection: true }), { code: "exact_editor_selection_changed" });
  await assert.rejects(fixture.run("verifyExactEditor", { expectedBody: "changed", offset: 6, requireSelection: true }), { code: "exact_editor_body_changed" });
});

function inputFixture({ body = "alpha beta", selectionOffset = 6, afterBody, page = "doc", verifyError, establishError } = {}) {
  const calls = [];
  const context = vm.createContext({
    chrome: { tabs: { get: async () => ({ id: 42, windowId: 9 }), query: async () => [], update: async () => {} },
      windows: { update: async () => {}, getLastFocused: async () => ({ id: 9 }) } },
    requireTrustedDebuggerAccess: async () => {}, withTimeout: promise => promise,
    debuggerSessions: { acquire: async () => ({ release: async () => {} }) },
    sendDebuggerCommand: async (target, method, payload) => { calls.push({ method, payload }); body = afterBody ?? body.slice(0, selectionOffset) + payload.text + body.slice(selectionOffset); },
    companionError: error, debuggerError: value => value,
    runPageOperation: async (tab, action, payload) => {
      if (action === "prepareExactEditor" && establishError) throw error("exact_editor_body_changed");
      if (verifyError) throw error(verifyError);
      if (body !== payload.expectedBody) throw error("exact_editor_body_changed");
      if (payload.requireSelection && selectionOffset !== payload.offset) throw error("exact_editor_selection_changed");
      return { body, pageInstanceId: page, url: "https://editor.note.com/notes/article/edit/", bodySha256: "hash" };
    },
  });
  vm.runInContext(source.slice(source.indexOf("async function runTrustedVisualInput("), source.indexOf("\nfunction sameVisualTargetState(")), context);
  const guard = { expectedBody: "alpha beta", expectedFullBody: "alpha NEWbeta", offset: 6, url: "https://editor.note.com/notes/article/edit/" };
  return { calls, run: (overrides = {}) => context.runTrustedVisualInput(42, "visual.typeText", { clear: false, clickBeforeType: false, text: "NEW", pageInstanceId: "doc", editorGuard: guard, ...overrides }) };
}

test("trusted no-click insertion emits exactly one insertText and verifies full body", async () => {
  const fixture = inputFixture(); const result = await fixture.run();
  assert.equal(result.fullBodyVerified, true); assert.equal(result.clipboardUsed, false);
  assert.deepEqual(fixture.calls.map(item => item.method), ["Input.insertText"]);
});

test("changed body, selection, projection or page identity dispatches no insertion", async () => {
  for (const options of [{ body: "changed" }, { selectionOffset: 3 }, { page: "other" }]) {
    const fixture = inputFixture(options); await assert.rejects(fixture.run()); assert.equal(fixture.calls.length, 0);
  }
  const fixture = inputFixture();
  await assert.rejects(fixture.run({ clear: true }), { code: "exact_editor_guard_required" });
  assert.equal(fixture.calls.length, 0);
});

test("post insertion mismatch is unknown and never replayed", async () => {
  const fixture = inputFixture({ afterBody: "unrelated app state" });
  await assert.rejects(fixture.run(), value => value.code === "exact_editor_input_not_committed" && value.details.operationEffectState === "unknown");
  assert.equal(fixture.calls.length, 1);
});
