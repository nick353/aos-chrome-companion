import assert from "node:assert/strict";
import test from "node:test";
import vm from "node:vm";
import { readFile } from "node:fs/promises";

const source = await readFile(new URL("../extension/service-worker.js", import.meta.url), "utf8");
const branchStart = source.indexOf('    if (payload.operation === "splitParagraph") {');
const branchEnd = source.indexOf("    const before = richTextStructure(element);", branchStart);
const error = (code, message, details) => Object.assign(Error(message), { code, details });
const text = value => ({ nodeType: 3, nodeValue: value, get textContent() { return this.nodeValue; }, childNodes: [] });
function element(tag, children = [], attributes = []) {
  const node = { nodeType: 1, tagName: tag.toUpperCase(), attributes, childNodes: children, isContentEditable: true, isConnected: true,
    get children() { return this.childNodes.filter(child => child.nodeType === 1); },
    get textContent() { return this.childNodes.map(child => child.textContent).join(""); },
    get innerHTML() { return this.childNodes.map(child => child.nodeType === 3 ? child.nodeValue : child.outerHTML).join(""); },
    get outerHTML() { return `<${tag}${attributes.map(a => ` ${a.name}="${a.value}"`).join("")}>${this.innerHTML}</${tag}>`; },
    contains(child) { return child === this || this.childNodes.some(node => node === child || node.contains?.(child)); },
    closest(selector) { return selector === tag ? this : this.parentElement?.closest(selector); }, focus() {},
  };
  for (const child of children) child.parentElement = child.parentNode = node;
  return node;
}
const clone = node => node.nodeType === 3 ? text(node.nodeValue) : element(node.tagName.toLowerCase(), node.childNodes.map(clone), node.attributes.map(a => ({ ...a })));
const firstText = node => node.nodeType === 3 ? node : node.childNodes.map(firstText).find(Boolean);
const childPath = (root, target) => {
  if (root === target) return [];
  for (let index = 0; index < root.childNodes.length; index++) {
    const rest = childPath(root.childNodes[index], target); if (rest) return [index, ...rest];
  }
  return null;
};
function fixture({ mark = "strong", nested = false, attributes = [], includeBr = false, mutation, beforeDispatch, delayed = false, normalizeMark = false } = {}) {
  const value = "見出し😀本文", offset = 5;
  const marked = element(mark, nested ? [element("em", [text(value)])] : [text(value)], attributes);
  const lead = includeBr ? [text("前"), element("br")] : [];
  const paragraph = element("p", [...lead, marked]), tail = element("p", [text("unchanged outside")]);
  const editor = element("div", [paragraph, tail]);
  const caretNode = firstText(marked);
  let caret = { collapsed: true, startContainer: caretNode, startOffset: offset, cloneRange() { return { ...this }; } };
  let calls = 0;
  let pending, reads = 0;
  const offsetOf = (root, container, at) => {
    let total = 0, found;
    const visit = node => {
      if (node.nodeType === 3) { if (node === container) found = total + at; total += node.nodeValue.length; }
      else for (let index = 0; index <= node.childNodes.length; index++) {
        if (node === container && index === at) found = total;
        if (index < node.childNodes.length) visit(node.childNodes[index]);
      }
    };
    visit(root); return found;
  };
  const fragment = (root, start, end) => {
    let total = 0;
    const slice = node => {
      if (node.nodeType === 3) {
        const from = total; total += node.nodeValue.length;
        const part = node.nodeValue.slice(Math.max(0, start - from), Math.max(0, Math.min(node.nodeValue.length, end - from)));
        return part ? text(part) : null;
      }
      const from = total, children = node.childNodes.map(slice).filter(Boolean);
      if (node.tagName === "BR") return total >= start && total < end ? clone(node) : null;
      if (children.length || from === end && start === end) return element(node.tagName.toLowerCase(), children, node.attributes.map(a => ({ ...a })));
      return null;
    };
    return { childNodes: root.childNodes.map(slice).filter(Boolean) };
  };
  const document = {
    createRange: () => ({ root: editor, end: null, start: null,
      selectNodeContents(root) { this.root = root; }, setEnd(node, at) { this.end = [node, at]; }, setStart(node, at) { this.start = [node, at]; },
      toString() { return this.root.textContent.slice(this.start ? offsetOf(this.root, ...this.start) : 0, this.end ? offsetOf(this.root, ...this.end) : undefined); },
      cloneContents() { return fragment(this.root, this.start ? offsetOf(this.root, ...this.start) : 0, this.end ? offsetOf(this.root, ...this.end) : this.root.textContent.length); },
    }),
    execCommand(command) {
      assert.equal(command, "insertParagraph"); calls++;
      const commit = () => {
      const wrap = part => element(normalizeMark ? ({ b: "strong", i: "em" })[mark] ?? mark : mark, nested ? [element("em", [text(part)])] : [text(part)]);
      const left = element("p", [...lead.map(clone), wrap(value.slice(0, offset))]);
      const right = element("p", [wrap(value.slice(offset))]);
      editor.childNodes = [left, right, tail]; for (const child of editor.childNodes) child.parentElement = editor;
      caret = { ...caret, startContainer: firstText(right), startOffset: 0 };
      if (mutation === "dropMark") right.childNodes = [text(value.slice(offset))];
      if (mutation === "outside") tail.childNodes = [text("changed outside")];
      if (mutation === "body") firstText(right).nodeValue += "x";
      if (mutation === "caret") caret.startOffset = 1;
      if (mutation === "precedingBr") { right.childNodes.unshift(element("br")); }
      if (mutation === "markAttributes") right.children[0].attributes.push({ name: "class", value: "changed" });
      };
      if (delayed) pending = commit; else commit();
      return true;
    },
  };
  const context = vm.createContext({ document, getSelection: () => ({ rangeCount: 1, getRangeAt: () => caret }),
    operationError: error, find: () => editor, visualize: async () => { if (beforeDispatch === "caret") caret.startOffset++;
      if (beforeDispatch === "html") marked.attributes.push({ name: "class", value: "changed" }); }, wait: async () => { if (++reads === 3) pending?.(); },
    richTextStructure: () => ({}), location: { href: "https://editor.test/body" } });
  vm.runInContext(`async function run(payload) { let element = find(); ${source.slice(branchStart, branchEnd)} }`, context);
  const expectedBody = editor.textContent, fullOffset = offsetOf(editor, caretNode, offset);
  const guards = { operation: "splitParagraph", expectedBody, expectedFullBody: expectedBody,
    expectedSelection: { start: fullOffset, end: fullOffset }, expectedCaret: { path: childPath(editor, caretNode), offset }, expectedEditorHtml: editor.innerHTML };
  return { run: overrides => context.run({ ...guards, ...overrides }), calls: () => calls, editor, expectedBody };
}

test("exact guarded split preserves attribute-free semantic marks, nested marks and BR fragments", async () => {
  for (const mark of ["b", "strong", "i", "em", "u"]) {
    for (const options of [{}, { nested: true }, { includeBr: true }]) {
      const f = fixture({ mark, ...options }), result = await f.run();
      assert.equal(result.paragraphSplitVerified, true); assert.equal(result.contentPreserved, true);
      assert.equal(result.clipboardUsed, false); assert.equal(f.calls(), 1);
      assert.equal(f.editor.textContent, f.expectedBody);
      assert.equal(f.editor.children[2].textContent, "unchanged outside");
    }
  }
});

test("inline split rejects missing HTML/exact caret, links, spans and attributes before the native command", async () => {
  for (const options of [{ mark: "a" }, { mark: "span" }, { mark: "code" }, { attributes: [{ name: "class", value: "mark" }] },
    { beforeDispatch: "caret" }, { beforeDispatch: "html" }]) {
    const f = fixture(options); await assert.rejects(f.run()); assert.equal(f.calls(), 0);
  }
  for (const guards of [{ expectedEditorHtml: undefined }, { expectedEditorHtml: "changed" },
    { expectedCaret: { path: [0, 0], offset: 5 } }, { expectedFullBody: "changed" }]) {
    const f = fixture(); await assert.rejects(f.run(guards)); assert.equal(f.calls(), 0);
  }
});

test("post-command mark/body/outside/caret corruption fails readback after one command and no repair", async () => {
  for (const mutation of ["dropMark", "outside", "body", "caret", "precedingBr", "markAttributes"]) {
    const f = fixture({ mutation }); await assert.rejects(f.run()); assert.equal(f.calls(), 1);
  }
});

test("one paragraph dispatch observes delayed framework commit and semantic B/I normalization", async () => {
  for (const mark of ["b", "i"]) {
    const f = fixture({ mark, delayed: true, normalizeMark: true });
    const result = await f.run(); assert.equal(result.fullBodyVerified, true); assert.equal(f.calls(), 1);
    assert.equal(f.editor.children[2].textContent, "unchanged outside");
  }
});
