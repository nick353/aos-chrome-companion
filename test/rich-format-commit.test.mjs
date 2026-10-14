import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import vm from "node:vm";

const source = await readFile(new URL("../extension/service-worker.js", import.meta.url), "utf8");
const start = source.indexOf("    const before = richTextStructure(element);");
const end = source.indexOf('  if (action === "scroll") {', start);
const text = value => ({ nodeType: 3, nodeValue: value, get length() { return this.nodeValue.length; }, get textContent() { return this.nodeValue; } });
function node(tag, children = []) {
  const item = { nodeType: 1, tagName: tag.toUpperCase(), childNodes: children, attributes: [], isConnected: true,
    get textContent() { return this.childNodes.map(n => n.textContent).join(""); },
    get innerHTML() { return this.childNodes.map(n => n.nodeType === 3 ? n.nodeValue : n.outerHTML).join(""); },
    get outerHTML() { return `<${this.tagName}>${this.innerHTML}</${this.tagName}>`; },
    contains(n) { return n === this || this.childNodes.some(child => child === n || child.contains?.(n)); },
    closest(selector) { return selector.split(",").includes(this.tagName.toLowerCase()) ? this : this.parentElement?.closest(selector); },
    querySelectorAll() { return this.childNodes.filter(n => n.nodeType === 1 && ["P", "H2"].includes(n.tagName)); },
    querySelector() { return null; }, focus() {}, dispatchEvent() {},
  };
  children.forEach(child => { child.parentElement = child.parentNode = item; }); return item;
}
function fixture({ corruption, noCommit = false, delayed = true, normalizeMark = true } = {}) {
  const marked = node("b", [text("heading 😀")]), paragraph = node("p", [marked]), tail = node("p", [text("outside body")]), editor = node("div", [paragraph, tail]);
  let selected, pending, reads = 0, commands = 0;
  const offset = (root, target, at) => {
    let total = 0, result;
    const visit = n => {
      if (n.nodeType === 3) { if (n === target) result = total + at; total += n.length; }
      else for (let index = 0; index <= n.childNodes.length; index++) {
        if (n === target && index === at) result = total;
        if (index < n.childNodes.length) visit(n.childNodes[index]);
      }
    }; visit(root); return result;
  };
  const range = () => ({ root: editor, startContainer: editor, startOffset: 0, endContainer: editor, endOffset: editor.childNodes.length,
    selectNodeContents(root) { this.root = root; this.startContainer = this.endContainer = root; this.startOffset = 0; this.endOffset = root.childNodes.length; },
    setStart(n, at) { this.startContainer = n; this.startOffset = at; }, setEnd(n, at) { this.endContainer = n; this.endOffset = at; },
    get collapsed() { return this.startContainer === this.endContainer && this.startOffset === this.endOffset; },
    toString() { return this.root.textContent.slice(offset(this.root, this.startContainer, this.startOffset), offset(this.root, this.endContainer, this.endOffset)); },
    cloneRange() { return Object.assign(range(), this); }, intersectsNode() { return false; },
  });
  const selection = { get rangeCount() { return selected ? 1 : 0; }, getRangeAt: () => selected,
    removeAllRanges() { selected = null; }, addRange(value) { selected = value; } };
  const document = { createRange: range, addEventListener() {}, removeEventListener() {},
    createTreeWalker(root) {
      const list = []; const collect = n => n.nodeType === 3 ? list.push(n) : n.childNodes.forEach(collect); collect(root);
      let index = -1; return { currentNode: null, nextNode() { this.currentNode = list[++index]; return Boolean(this.currentNode); } };
    },
    execCommand(command, ignored, value) {
      assert.equal(command, "formatBlock"); assert.equal(value, "h2"); commands++;
      const commit = () => {
        if (!noCommit) paragraph.tagName = "H2";
        if (normalizeMark) marked.tagName = "STRONG";
        if (corruption === "body") marked.childNodes[0].nodeValue += "changed";
        if (corruption === "outside") tail.attributes.push({ name: "class", value: "changed" });
        if (corruption === "mark") marked.attributes.push({ name: "class", value: "changed" });
      };
      if (delayed) pending = commit; else commit(); return true;
    },
  };
  const context = vm.createContext({ document, Node: { TEXT_NODE: 3, ELEMENT_NODE: 1 }, NodeFilter: { SHOW_TEXT: 4 },
    getSelection: () => selection, getComputedStyle: n => ({ fontWeight: n.closest("b,strong") ? "700" : "400", fontStyle: "normal", textDecorationLine: "none" }),
    richTextStructure: () => ({}), richTextCommand: () => ({ command: "formatBlock", value: "h2" }),
    find: () => editor, visualize: async () => {}, wait: async () => { if (++reads === 3) pending?.(); },
    operationError: (code, message) => Object.assign(Error(message), { code }), describe: () => ({}),
    location: { href: "https://fixture.test/editor" }, InputEvent: class {}, Event: class {},
  });
  vm.runInContext(`async function run(payload) { let element = find(), richTextMutationAttempted = false; ${source.slice(start, end)}`, context);
  return { run: () => context.run({ operation: "heading", text: "heading 😀" }), commands: () => commands, editor, tail };
}

test("normal rich formatting observes one delayed commit and safe inline mark normalization with full body/outside proof", async () => {
  const f = fixture(), result = await f.run();
  assert.equal(result.structureCommitted, true); assert.equal(result.fullBodyVerified, true);
  assert.equal(result.outsideSelectionPreserved, true); assert.equal(f.commands(), 1);
  assert.equal(f.editor.textContent, "heading 😀outside body");
});

test("normal rich formatting never repeats a noncommitted or body/attribute/outside-changing command", async () => {
  for (const options of [{ noCommit: true }, { corruption: "body" }, { corruption: "outside" }, { corruption: "mark" }]) {
    const f = fixture(options); await assert.rejects(f.run()); assert.equal(f.commands(), 1);
  }
});
