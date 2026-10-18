import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import vm from "node:vm";

// 2026-10-18: doda's "入力内容を確認する" is a <p> inside an <a>; a locator by that name matched both.
const source = await readFile(new URL("../extension/service-worker.js", import.meta.url), "utf8");
const block = source.slice(source.indexOf("  const CONTROL_ROLES = new Set("), source.indexOf("  const find = (locator, options = {}) => {"));
const { oneControlAmong } = vm.runInNewContext(`${block}\n({ oneControlAmong })`, {});

const node = (tag, { attrs = {}, children = [] } = {}) => {
  const element = { tagName: tag.toUpperCase(), attrs, children,
    getAttribute: (name) => attrs[name] ?? null, hasAttribute: (name) => name in attrs,
    contains(other) { return other === element || children.some((child) => child.contains(other)); } };
  return element;
};

test("a label inside its link resolves to the link", () => {
  const label = node("p");
  const link = node("a", { attrs: { href: "/confirm" }, children: [label] });
  assert.equal(oneControlAmong([label, link]), link);
});

test("a row that wraps one button resolves to the button", () => {
  const button = node("div", { attrs: { role: "button" } });
  const row = node("li", { children: [button] });
  assert.equal(oneControlAmong([row, button]), button);
});

test("separate controls or unrelated elements still stop as ambiguous", () => {
  const first = node("a", { attrs: { href: "/a" } });
  const second = node("a", { attrs: { href: "/b" } });
  assert.equal(oneControlAmong([first, second]), null);
  const slot = node("li");
  const other = node("li");
  assert.equal(oneControlAmong([slot, other]), null);
  const button = node("button");
  assert.equal(oneControlAmong([button, node("p")]), null);
});
