import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const source = await readFile(new URL("../extension/service-worker.js", import.meta.url), "utf8");
const start = source.indexOf('  if (action === "type") {');
const end = source.indexOf('  if (action === "verifyTypeValue") {', start);
assert.ok(start > 0 && end > start);
// Execute the actual production type branch with a bounded DOM double. This
// test never opens a real editor or contacts an external provider.
const AsyncFunction = Object.getPrototypeOf(async function () {}).constructor;
const run = new AsyncFunction("env", `with (env) { ${source.slice(start, end)} }`);

function fixture({ editable = true, original = "本文を保持する", clear = true, clearExplicit = false } = {}) {
  let mutations = 0;
  let focused = false;
  class Input { constructor() { this.value = original; } }
  class TextArea extends Input {}
  class Select {}
  const element = editable ? { isContentEditable: true, textContent: original, get innerText() { return this.textContent; } } : new Input();
  Object.assign(element, { scrollIntoView() {}, focus() { focused = true; }, dispatchEvent() {} });
  const range = { collapsed: false, selectNodeContents() {}, collapse() { this.collapsed = true; },
    deleteContents() { mutations++; if (!this.collapsed) element.textContent = ""; },
    insertNode(node) { mutations++; element.textContent += node.text; }, setStartAfter() {} };
  const env = { action: "type", payload: { locator: {}, text: "見出し", clear, clearExplicit },
    find: () => element, HTMLInputElement: Input, HTMLTextAreaElement: TextArea, HTMLSelectElement: Select,
    operationError(code, message, details) { return Object.assign(new Error(message), { code, details }); },
    visualize: async () => {}, describe: () => ({}),
    document: { createRange: () => range,
      createElement: () => ({ set innerText(text) { this.firstChild = text ? { text, parent: this } : null; } }),
      createDocumentFragment: () => ({ text: "", appendChild(node) { this.text += node.text; this.lastChild = node; node.parent.firstChild = null; } }) },
    globalThis: { getSelection: () => ({ removeAllRanges() {}, addRange() {} }) },
    InputEvent: class {}, Event: class {} };
  return { env, element, mutations: () => mutations, focused: () => focused };
}

test("implicit clear cannot delete a populated contenteditable, even after text selection", async () => {
  const f = fixture();
  await assert.rejects(run(f.env), error => error.code === "contenteditable_replace_requires_explicit_clear"
    && error.details.operationEffectState === "none" && error.details.mutationDispatchAttempted === false);
  assert.equal(f.element.textContent, "本文を保持する");
  assert.equal(f.mutations(), 0);
  assert.equal(f.focused(), false);
});

test("explicit whole-editor replacement remains available for authorized restoration", async () => {
  const f = fixture({ clearExplicit: true });
  const result = await run(f.env);
  assert.equal(f.element.textContent, "見出し");
  assert.equal(result.valueLength, 3);
});

test("explicit append preserves the existing document", async () => {
  const f = fixture({ clear: false });
  await run(f.env);
  assert.equal(f.element.textContent, "本文を保持する見出し");
});

test("typing into an empty editor remains possible", async () => {
  const f = fixture({ original: "" });
  await run(f.env);
  assert.equal(f.element.textContent, "見出し");
});

test("ordinary input replacement retains existing behavior", async () => {
  const f = fixture({ editable: false });
  await run(f.env);
  assert.equal(f.element.value, "見出し");
});

test("both semantic and opt-in physical fallback routes preserve clear intent", () => {
  const route = source.slice(source.indexOf('case "page.type":'), source.indexOf('case "page.upload":'));
  assert.equal(route.split("clearExplicit: params.clear === true").length - 1, 2);
});
