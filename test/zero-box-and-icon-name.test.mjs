import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import vm from "node:vm";

// 2026-10-18: Threads' side links (/search, /@account) are 0x0 anchors around a sized icon, and
// Instagram's like/comment buttons are named only by their svg. Both were refused as not found.
const source = await readFile(new URL("../extension/service-worker.js", import.meta.url), "utf8");
const slice = (from, to) => source.slice(source.indexOf(from), source.indexOf(to));
const geometry = slice("  // A control can have no box of its own", "  const implicitRole = ");
const naming = slice("  // An icon-only control takes its name", "  const accessibleName = ");

class Element {
  constructor({ tag = "div", rect = [0, 0, 0, 0], style = {}, attrs = {}, children = [], text = "" } = {}) {
    Object.assign(this, { tagName: tag.toUpperCase(), rectValues: rect, style, attrs, children, textContent: text });
    for (const child of children) child.parent = this;
  }
  getBoundingClientRect() {
    const [x, y, width, height] = this.rectValues;
    return { x, y, width, height, left: x, top: y, right: x + width, bottom: y + height };
  }
  getAttribute(name) { return this.attrs[name] ?? null; }
  descendants() { return this.children.flatMap((child) => [child, ...child.descendants()]); }
  querySelectorAll(selector) { assert.equal(selector, "*"); return this.descendants(); }
  querySelector(selector) {
    const tests = {
      "svg[aria-label]": (e) => e.tagName === "SVG" && e.attrs["aria-label"] !== undefined,
      "[role='img'][aria-label]": (e) => e.attrs.role === "img" && e.attrs["aria-label"] !== undefined,
      "img[alt]:not([alt=''])": (e) => e.tagName === "IMG" && !!e.attrs.alt,
      "svg title": (e) => e.tagName === "TITLE" && e.parent?.tagName === "SVG",
    };
    const parts = selector.split(/,\s*/u);
    for (const part of parts) assert.ok(tests[part], `unexpected selector ${part}`);
    return this.descendants().find((e) => parts.some((part) => tests[part](e))) ?? null;
  }
}
class DOMRect {
  constructor(x, y, width, height) { Object.assign(this, { x, y, width, height, left: x, top: y, right: x + width, bottom: y + height }); }
}
const context = {
  DOMRect,
  getComputedStyle: (element) => ({ display: "block", visibility: "visible", overflowX: "visible", overflowY: "visible", ...element.style }),
};
const { boxOf, scrollTargetOf, visible } = vm.runInNewContext(`${geometry}\n({ boxOf, scrollTargetOf, visible })`, context);
const { iconName } = vm.runInNewContext(`${naming}\n({ iconName })`, context);

test("a zero-size link is measured and scrolled by the icon it draws", () => {
  const icon = new Element({ tag: "svg", rect: [22, 318, 24, 24] });
  const link = new Element({ tag: "a", attrs: { href: "/search" }, children: [new Element({ children: [icon] })] });
  assert.equal(visible(link), true);
  const box = boxOf(link);
  assert.deepEqual([box.x, box.y, box.width, box.height], [22, 318, 24, 24]);
  assert.equal(scrollTargetOf(link), icon);
});

test("display: contents counts its children even when it reports clipping", () => {
  const link = new Element({ tag: "a", style: { display: "contents", overflowX: "hidden", overflowY: "hidden" },
    children: [new Element({ rect: [10, 10, 30, 20] }), new Element({ rect: [50, 15, 10, 10] })] });
  const box = boxOf(link);
  assert.deepEqual([box.x, box.y, box.width, box.height], [10, 10, 50, 20]);
});

test("a zero-size box that clips its children, or only hidden children, stays hidden", () => {
  const clipped = new Element({ style: { overflowX: "hidden", overflowY: "hidden" }, children: [new Element({ rect: [0, 0, 100, 20] })] });
  assert.equal(visible(clipped), false);
  const hiddenOnly = new Element({ children: [new Element({ rect: [0, 0, 100, 20], style: { visibility: "hidden" } }),
    new Element({ rect: [0, 0, 100, 20], style: { display: "none" } })] });
  assert.equal(visible(hiddenOnly), false);
  const empty = new Element();
  assert.equal(scrollTargetOf(empty), empty);
});

test("an element with its own box keeps it", () => {
  const button = new Element({ tag: "button", rect: [5, 6, 70, 30], children: [new Element({ rect: [0, 0, 500, 500] })] });
  const box = boxOf(button);
  assert.deepEqual([box.x, box.y, box.width, box.height], [5, 6, 70, 30]);
  assert.equal(scrollTargetOf(button), button);
  assert.equal(visible(new Element({ rect: [0, 0, 10, 10], style: { display: "none" } })), false);
});

test("an icon-only button is named by its icon", () => {
  const like = new Element({ attrs: { role: "button" }, children: [new Element({ children: [new Element({ tag: "svg", attrs: { "aria-label": "いいね！" } })] })] });
  assert.equal(iconName(like), "いいね！");
  const titled = new Element({ attrs: { role: "button" }, children: [new Element({ tag: "svg", children: [new Element({ tag: "title", text: "コメント" })] })] });
  assert.equal(iconName(titled), "コメント");
  const picture = new Element({ tag: "a", children: [new Element({ tag: "img", attrs: { alt: "" } }), new Element({ tag: "img", attrs: { alt: "プロフィール写真" } })] });
  assert.equal(iconName(picture), "プロフィール写真");
  assert.equal(iconName(new Element({ children: [new Element({ tag: "span" })] })), "");
});

test("the name falls back to the icon only after every other source", () => {
  const start = source.indexOf("  const accessibleName = (element) => normalize(");
  const body = source.slice(start, source.indexOf(");", start));
  assert.ok(body.trimEnd().endsWith("|| iconName(element),"), "iconName must be the last fallback");
});
