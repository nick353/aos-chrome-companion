import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import vm from "node:vm";
import { DebuggerSessionPool } from "../extension/page-observation.js";

// 2026-10-19: on Instagram, Threads, X and TikTok a click stopped as "moved" 56 times a day because
// the proof required identical pixels, and a click by name stopped 39 times as "not found" and 28
// as "ambiguous". The owner allowed relaxing the safety checks (delete, payment, double send and
// other sites stay). These tests pin the new rules: the click goes to the same element at its
// current position; names are read more widely; and repeated controls are chosen only when the
// page says which.
const source = await readFile(new URL("../extension/service-worker.js", import.meta.url), "utf8");
const slice = (from, to) => {
  const start = source.indexOf(from), end = source.indexOf(to, start);
  assert.ok(start > 0 && end > start, `${from} .. ${to}`);
  return source.slice(start, end);
};
const input = slice("async function runTrustedVisualInput(", "\nfunction sameVisualTargetState(");
const mouse = slice("async function dispatchMouseClick(", "\nconst TRUSTED_VISUAL_KEYS");
const error = (code, message, details) => Object.assign(new Error(message), { code, details });

const element = { tag: "div", role: "button", name: "いいね！", testId: null };
const guardBase = {
  kind: "target", locator: { role: "button", name: "いいね！" }, point: { x: 300, y: 400 },
  rect: { x: 288, y: 388, width: 24, height: 24 }, viewport: { width: 1200, height: 800, devicePixelRatio: 2, scale: 1 },
  scroll: { x: 0, y: 1500 }, pageUrl: "https://www.instagram.com/", pageInstanceId: "doc", frameId: 0, framePath: [],
  coordinateSpace: "top-level-viewport", allowMovedTarget: true, elementRef: "ref-like", element,
};

async function click({ guard = guardBase, current = {}, pageError = null, method = "visual.click" } = {}) {
  const commands = [], payloads = [];
  const ctx = {
    requireTrustedDebuggerAccess: async () => {}, requireVisualPoint: (p) => p, companionError: error, withTimeout: (p) => p,
    visualButton: (b) => b ?? "left", visualClickCount: (c) => c, visualHoldMs: (h) => h ?? 0,
    sendDebuggerCommand: async (_target, name, params) => { commands.push({ name, params }); },
    runPageOperation: async (_tab, action, payload) => {
      if (action === "showVisualPoint") return { shown: true };
      payloads.push({ action, payload });
      if (pageError) throw pageError;
      return {
        supported: true, url: guard.pageUrl, topLevelUrl: guard.pageUrl, pageInstanceId: guard.pageInstanceId,
        point: { x: 300, y: 344 }, clippedRect: { x: 288, y: 332, width: 24, height: 24 },
        viewport: { width: 1200, height: 860, devicePixelRatio: 2, scale: 1 }, scroll: { x: 0, y: 1556 },
        framePath: [], coordinateSpace: "top-level-viewport", element, elementRefMatched: true, ...current,
      };
    },
    chrome: { tabs: { get: async (id) => ({ id, windowId: 2 }), query: async () => [{ id: 11, windowId: 2 }], update: async () => {} },
      windows: { update: async () => {} }, debugger: { attach: async () => {}, detach: async () => {} } },
  };
  ctx.debuggerSessions = new DebuggerSessionPool(ctx.chrome.debugger);
  vm.createContext(ctx);
  vm.runInContext(`${mouse}\n${input}`, ctx);
  let result, thrown;
  try {
    result = await ctx.runTrustedVisualInput(11, method, { point: guard.point, visualTargetGuard: guard, allowedOrigins: ["https://www.instagram.com"] });
  } catch (caught) { thrown = caught; }
  return { result, thrown, commands, payloads };
}

test("a moved feed button is clicked once at its current position when it is the same element", async () => {
  const r = await click();
  assert.ifError(r.thrown);
  assert.equal(r.payloads[0].payload.elementRef, "ref-like");
  assert.equal(r.payloads[0].payload.requireHitOwner, true);
  assert.equal(r.payloads[0].payload.markOperated, true);
  assert.deepEqual(r.commands.map((c) => c.params.type), ["mouseMoved", "mousePressed", "mouseReleased"]);
  for (const command of r.commands) assert.deepEqual([command.params.x, command.params.y], [300, 344]);
  assert.equal(r.result.clickGuardReadback.mode, "same_element");
  assert.equal(r.result.clickGuardReadback.targetMoved, true);
  assert.deepEqual([r.result.point.x, r.result.point.y], [300, 344]);
});

test("a double click follows the moved element with both clicks", async () => {
  const r = await click({ method: "visual.doubleClick" });
  assert.ifError(r.thrown);
  assert.equal(r.commands.length, 6);
  for (const command of r.commands) assert.deepEqual([command.params.x, command.params.y], [300, 344]);
});

test("without the remembered object, one unique element with the same tag, role, name and test id is enough", async () => {
  const r = await click({ current: { elementRefMatched: null } });
  assert.ifError(r.thrown);
  assert.equal(r.commands.length, 3);
});

for (const [label, current, mismatch] of [
  ["the remembered element is gone and another one matches", { elementRefMatched: false }, "sameElement"],
  ["another element with a different name", { elementRefMatched: null, element: { ...element, name: "「いいね！」を取り消す" } }, "sameElement"],
  ["an element chosen among several", { elementRefMatched: null, targetChoice: { disambiguatedBy: "only_one_in_view" } }, "sameElement"],
  ["another document", { pageInstanceId: "other-doc" }, "samePage"],
  ["another page", { topLevelUrl: "https://www.instagram.com/p/other/" }, "samePage"],
  ["another frame", { framePath: [3] }, "sameFrame"],
  ["a point outside the viewport", { point: { x: 300, y: 900 } }, "pointInViewport"],
]) test(`no mouse input when ${label}`, async () => {
  const r = await click({ current });
  assert.equal(r.thrown?.code, "visual_target_proof_stale_geometry");
  assert.ok(r.thrown.details.mismatches.includes(mismatch), JSON.stringify(r.thrown.details.mismatches));
  assert.equal(r.thrown.details.mutationDispatchAttempted, false);
  assert.equal(r.commands.length, 0);
});

test("a covered target still stops before any input", async () => {
  const r = await click({ pageError: error("visual_target_not_at_point", "covered") });
  assert.equal(r.thrown?.code, "visual_target_not_at_point");
  assert.equal(r.commands.length, 0);
});

test("a canvas proof and a guard from an older broker keep the exact geometry", async () => {
  for (const guard of [{ ...guardBase, canvas: true }, { ...guardBase, allowMovedTarget: undefined }]) {
    const r = await click({ guard });
    assert.equal(r.thrown?.code, "visual_target_proof_stale_geometry");
    assert.equal("elementRef" in r.payloads[0].payload, false);
    assert.equal(r.commands.length, 0);
  }
});

test("a point proof follows its control's small move", async () => {
  const guard = { ...guardBase, kind: "point", locator: null, element: undefined, hitElement: element, elementRef: "ref-point" };
  const r = await click({ guard, current: { point: { x: 310, y: 380 }, hitElement: element, elementRefMatched: true } });
  assert.ifError(r.thrown);
  assert.equal(r.payloads[0].action, "inspectVisualPoint");
  assert.equal(r.payloads[0].payload.allowShift, true);
  for (const command of r.commands) assert.deepEqual([command.params.x, command.params.y], [310, 380]);
});

// --- names ---
const naming = slice("  const looseKey = ", "  const parentSemanticNode = ");
function fakeElement({ tag = "div", attrs = {}, innerText = "", textContent = innerText, icons = [] } = {}) {
  return {
    tagName: tag.toUpperCase(), attrs, innerText, textContent,
    getAttribute: (name) => attrs[name] ?? null,
    querySelectorAll: () => icons,
    querySelector: () => null,
  };
}
const icon = (tag, attrs, text = "") => ({ tagName: tag.toUpperCase(), textContent: text, getAttribute: (name) => attrs[name] ?? null });
const normalize = (value) => String(value ?? "").replace(/\s+/g, " ").trim();
const namesContext = {
  normalize, lower: (value) => normalize(value).toLocaleLowerCase(),
  accessibleName: (element) => normalize(element.attrs["aria-label"] || element.innerText),
  referencedText: () => "", iconName: () => "",
  implicitRole: (element) => ({ BUTTON: "button", A: "link", H2: "heading" })[element.tagName] ?? "",
};
const names = vm.runInNewContext(`${naming}\n({ looseNameMatches, sameRoleFamily, otherNames, looseKey })`, namesContext);

test("names are read from the hidden side-bar label, the icon and the English word", () => {
  // Instagram's collapsed side bar: the link reads as the avatar's alt, the label is hidden.
  const profile = fakeElement({ tag: "a", attrs: { href: "/nisen_prints/" }, innerText: "", textContent: "プロフィール",
    icons: [icon("img", { alt: "nisen_printsのプロフィール写真" })] });
  assert.equal(names.looseNameMatches(profile, "プロフィール", true), true);
  assert.equal(names.looseNameMatches(profile, "Profile", true), true);
  const like = fakeElement({ attrs: { role: "button" }, icons: [icon("svg", { "aria-label": "いいね！" }), icon("title", {}, "いいね！")] });
  assert.equal(names.looseNameMatches(like, "いいね", true), true);
  assert.equal(names.looseNameMatches(like, "Like", true), true);
  assert.equal(names.looseNameMatches(like, "ＬＩＫＥ", true), true);
  assert.equal(names.looseNameMatches(like, "コメント", true), false);
  const reply = fakeElement({ tag: "button", attrs: { "aria-label": "0 Replies. Reply" } });
  assert.equal(names.looseNameMatches(reply, "返信", false), true);
  assert.equal(names.looseNameMatches(reply, "返信", true), false);
});

test("the wide reading never lands on undo, delete, purchase or payment controls unless asked", () => {
  const unlike = fakeElement({ attrs: { role: "button" }, icons: [icon("svg", { "aria-label": "「いいね！」を取り消す" })] });
  assert.equal(names.looseNameMatches(unlike, "いいね", false), false);
  assert.equal(names.looseNameMatches(unlike, "like", false), false);
  assert.equal(names.looseNameMatches(unlike, "取り消す", false), true);
  for (const label of ["投稿を削除", "Delete post", "購入する", "Buy now", "お支払い", "退会する", "Unfollow"]) {
    assert.equal(names.looseNameMatches(fakeElement({ tag: "button", attrs: { "aria-label": label } }), label.includes("投稿") ? "投稿" : "post", false), false, label);
  }
});

test("button, link, menu item and tab are one family only in the wide reading", () => {
  assert.equal(names.sameRoleFamily(fakeElement({ attrs: { role: "menuitem" } }), "button"), true);
  assert.equal(names.sameRoleFamily(fakeElement({ tag: "a", attrs: { href: "/x" } }), "button"), true);
  assert.equal(names.sameRoleFamily(fakeElement({ tag: "button" }), "submit"), true);
  assert.equal(names.sameRoleFamily(fakeElement({ tag: "h2" }), "button"), false);
  assert.equal(names.sameRoleFamily(fakeElement({ tag: "button" }), "textbox"), false);
});

// --- repeated controls ---
const choosing = slice("  const fullyInViewport = ", "  const markOperated = ");
function node(name, { rect = [0, 0, 20, 20], href = null, parent = null } = {}) {
  const self = {
    name, parent, children: [],
    getBoundingClientRect: () => ({ left: rect[0], top: rect[1], right: rect[0] + rect[2], bottom: rect[1] + rect[3], width: rect[2], height: rect[3] }),
    closest: (selector) => (selector === "a[href]" && href ? { href } : null),
    contains(other) { for (let current = other; current; current = current.parent) if (current === self) return true; return false; },
  };
  parent?.children.push(self);
  return self;
}
function chooser({ dialogs = [], last = null } = {}) {
  const ctx = {
    innerWidth: 1000, innerHeight: 800, boxOf: (element) => element.getBoundingClientRect(),
    lower: (value) => String(value ?? "").toLocaleLowerCase(), accessibleName: (element) => element.name,
    RISKY_NAME: /取り?消|削除|購入|delete|purchase/iu, visible: () => true,
    querySemantic: () => dialogs, parentSemanticNode: (element) => element.parent ?? null,
    __aosCompanionLastTargetV1: last ? { deref: () => last } : undefined,
  };
  return vm.runInNewContext(`${choosing}\npreferAmong`, ctx);
}

const picked = (choice) => (choice ? [choice.element, choice.by] : null);

test("repeated controls: the post operated last, then the open dialog, then the only one on screen", () => {
  const feed = node("feed");
  const posts = [0, 1, 2].map((index) => node(`post${index}`, { parent: feed }));
  const likes = posts.map((post, index) => node("いいね", { parent: post, rect: [10, 100 + index * 500, 24, 24] }));
  const comments = posts.map((post, index) => node("コメント", { parent: post, rect: [50, 100 + index * 500, 24, 24] }));
  likes[1].isConnected = true;
  assert.deepEqual(picked(chooser({ last: likes[1] })(comments)), [comments[1], "last_operated"]);
  const dialog = node("dialog");
  const inDialog = node("コメント", { parent: dialog, rect: [400, 300, 24, 24] });
  assert.deepEqual(picked(chooser({ dialogs: [dialog] })([...comments, inDialog])), [inDialog, "open_dialog"]);
  // Only the first post is on screen (the others start at y=600 and y=1100 and end below 800).
  const onScreen = [node("返信", { rect: [10, 100, 24, 24] }), node("返信", { rect: [10, 790, 24, 24] }), node("返信", { rect: [10, 1290, 24, 24] })];
  assert.deepEqual(picked(chooser()(onScreen)), [onScreen[0], "only_one_in_view"]);
  assert.equal(chooser()([node("返信", { rect: [10, 100, 24, 24] }), node("返信", { rect: [10, 300, 24, 24] })]), null);
});

test("two links to the same place are one target; risky names are never chosen", () => {
  const avatar = node("kazune0814", { href: "https://www.instagram.com/kazune0814/", rect: [0, 900, 30, 30] });
  const handle = node("kazune0814", { href: "https://www.instagram.com/kazune0814/", rect: [40, 100, 80, 20] });
  assert.deepEqual(picked(chooser()([avatar, handle])), [handle, "same_link"]);
  assert.equal(chooser()([node("x", { href: "https://site.test/#" }), node("x", { href: "https://site.test/#" })]), null);
  assert.equal(chooser()([node("投稿を削除", { rect: [0, 0, 20, 20] }), node("投稿を削除", { rect: [0, 900, 20, 20] })]), null);
});
