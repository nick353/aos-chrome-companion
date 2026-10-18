import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

// The production verifyTypeValue branch, run against small element doubles: a rich editor that
// reshapes line breaks still counts as holding the typed text, a changed word never does, and a
// plain input must match exactly.
const source = await readFile(new URL("../extension/service-worker.js", import.meta.url), "utf8");
const start = source.indexOf('  if (action === "verifyTypeValue") {');
const end = source.indexOf('  if (action === "verifyTypeSelection") {', start);
assert.ok(start > 0 && end > start);
const AsyncFunction = Object.getPrototypeOf(async function () {}).constructor;
const verify = new AsyncFunction("env", `with (env) { ${source.slice(start, end)} }`);

class Input {}
class TextArea extends Input {}
const env = (element, expectedText) => ({
  action: "verifyTypeValue", payload: { point: { x: 1, y: 1 }, expectedText },
  focusedTextInputAtPoint: () => element, find: () => element, HTMLInputElement: Input, HTMLTextAreaElement: TextArea,
  operationError: (code, message) => Object.assign(new Error(message), { code }), describe: () => ({}), boxOf: (element) => element.getBoundingClientRect(), scrollTargetOf: (element) => element, 
  location: { href: "https://www.linkedin.com/feed/" }, pageInstanceId: "doc-1",
});
const editor = (innerText) => ({ isContentEditable: true, innerText });
const input = (value) => Object.assign(new Input(), { isContentEditable: false, value });
const typed = "Gemini 4 Argon brings AI work beyond the chat window.\n\nGoogle launched Argon.\n→ Tasks continue.\n→ 40 apps.";

test("a rich editor that turns paragraph breaks into extra blank lines still holds the typed text", async () => {
  const shown = "Gemini 4 Argon brings AI work beyond the chat window.\n\n\nGoogle launched Argon.\n→ Tasks continue.\u00a0\n→ 40 apps.\u200b";
  const result = await verify(env(editor(shown), typed));
  assert.equal(result.committed, true);
  assert.equal(result.commitMatch, "editor_lines");
});

test("an exact editor match is reported as exact", async () => {
  const result = await verify(env(editor(typed), typed));
  assert.deepEqual([result.committed, result.commitMatch], [true, "exact"]);
});

test("a changed, missing or merged line is never counted as committed", async () => {
  for (const shown of [
    typed.replace("Argon brings", "Argon bring"),
    typed.replace("\n→ 40 apps.", ""),
    typed.replace("Argon.\n→ Tasks", "Argon. → Tasks"),
  ]) {
    const result = await verify(env(editor(shown), typed));
    assert.deepEqual([result.committed, result.commitMatch], [false, "mismatch"]);
  }
});

test("a plain input or textarea still has to match exactly", async () => {
  const result = await verify(env(input("住所 1-2-3 "), "住所 1-2-3"));
  assert.deepEqual([result.committed, result.commitMatch], [false, "mismatch"]);
  assert.equal((await verify(env(input("住所 1-2-3"), "住所 1-2-3"))).committed, true);
});

// The production page.type branch: appending after Enter in a rich editor reads back with extra
// blank lines (AOS run 619, 2026-10-15) and still counts as committed; a changed line never does.
const typeStart = source.indexOf('  if (action === "type") {');
const typeEnd = source.indexOf('  if (action === "verifyTypeValue") {', typeStart);
assert.ok(typeStart > 0 && typeEnd > typeStart);
const pageType = new AsyncFunction("env", `with (env) { ${source.slice(typeStart, typeEnd)} }`);
// shownAfter is what the field holds after the input; a list gives one value per later read (a
// framework editor rebuilding itself), the last one repeating.
const appendEnv = (before, shownAfter, text = "Google launched Argon.") => {
  const element = { isContentEditable: true, innerText: before, textContent: before, scrollIntoView() {}, focus() {}, dispatchEvent() {} };
  const later = Array.isArray(shownAfter) ? shownAfter : [shownAfter];
  let reads = 0;
  Object.defineProperty(element, "innerText", { get: () => (reads++ === 0 ? before : later[Math.min(reads - 2, later.length - 1)]), set() {} });
  const range = { selectNodeContents() {}, collapse() {}, deleteContents() {}, insertNode() {}, setStartAfter() {} };
  return {
    action: "type", payload: { locator: {}, text, clear: false, verifyCommit: true },
    find: () => element, HTMLInputElement: Input, HTMLTextAreaElement: TextArea, HTMLSelectElement: class {},
    operationError: (code, message) => Object.assign(new Error(message), { code }), describe: () => ({}), boxOf: (element) => element.getBoundingClientRect(), scrollTargetOf: (element) => element, 
    visualize: async () => {}, wait: async () => {}, InputEvent: class {}, Event: class {},
    globalThis: { getSelection: () => ({ removeAllRanges() {}, addRange() {} }) },
    document: { createRange: () => range, createElement: () => ({ firstChild: null }), createDocumentFragment: () => ({ lastChild: null, appendChild() {} }) },
  };
};

test("page.type after Enter in a rich editor counts the reshaped lines as committed", async () => {
  const before = "Gemini 4 Argon brings AI work beyond the chat window.\n\n";
  const result = await pageType(appendEnv(before, `${before}\n\nGoogle launched Argon.​`));
  assert.equal(result.semanticCommitted, true);
});

test("page.type never counts a changed line as committed", async () => {
  const before = "Gemini 4 Argon brings AI work beyond the chat window.\n\n";
  const result = await pageType(appendEnv(before, `${before}\nGoogle launch Argon.`));
  assert.equal(result.semanticCommitted, false);
});

// Threads (Lexical, 2026-10-18): right after the input the field reads empty while the editor
// rebuilds it, then it holds the caption once.
const caption = "雨もう上がってるのに、この子は認めてないみたいです🐈";

test("page.type waits for a framework editor that rebuilds the field after the input", async () => {
  const result = await pageType(appendEnv("\n", ["", "\n", `${caption}\n`], caption));
  assert.equal(result.semanticCommitted, true);
  assert.equal(result.valueLength, `${caption}\n`.length);
});

test("page.type never counts a doubled or vanished caption, however long it waits", async () => {
  assert.equal((await pageType(appendEnv("\n", ["", `${caption}\n${caption}`], caption))).semanticCommitted, false);
  assert.equal((await pageType(appendEnv("\n", [""], caption))).semanticCommitted, false);
});
