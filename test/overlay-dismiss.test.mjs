import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import vm from "node:vm";
import { DebuggerSessionPool } from "../extension/page-observation.js";

// 2026-10-19 (owner): a window laid over the page (a feedback box, a cookie or app prompt) hid the
// control a run had to press; 42 clicks a week stopped as covered, and a CrowdWorks proposal was
// never sent. The Companion closes such a window once, only with a control that closes or
// postpones it, or one Escape, and then checks the target again.
const source = await readFile(new URL("../extension/service-worker.js", import.meta.url), "utf8");
const slice = (from, to) => {
  const start = source.indexOf(from), end = source.indexOf(to, start);
  assert.ok(start > 0 && end > start, `${from} .. ${to}`);
  return source.slice(start, end);
};
const input = slice("async function runTrustedVisualInput(", "\nfunction sameVisualTargetState(");
const mouse = slice("async function dispatchMouseClick(", "\nconst TRUSTED_VISUAL_KEYS");
const error = (code, message, details) => Object.assign(new Error(message), { code, details });
const element = { tag: "button", role: "button", name: "提案する", testId: null };
const guard = {
  kind: "target", locator: { role: "button", name: "提案する" }, point: { x: 300, y: 400 },
  rect: { x: 250, y: 380, width: 100, height: 40 }, viewport: { width: 1200, height: 800, devicePixelRatio: 2, scale: 1 },
  scroll: { x: 0, y: 0 }, pageUrl: "https://crowdworks.jp/proposals/new", pageInstanceId: "doc", frameId: 0, framePath: [],
  coordinateSpace: "top-level-viewport", allowMovedTarget: true, elementRef: "ref-submit", element,
};

async function click({ coveredTimes = 1, dismissal = { overlayFound: true, attempted: true, method: "close_control", control: "閉じる", cleared: true } } = {}) {
  const commands = [], actions = [];
  let covered = coveredTimes;
  const ctx = {
    requireTrustedDebuggerAccess: async () => {}, requireVisualPoint: (p) => p, companionError: error, withTimeout: (p) => p,
    visualButton: (b) => b ?? "left", visualClickCount: (c) => c, visualHoldMs: (h) => h ?? 0,
    sendDebuggerCommand: async (_target, name, params) => { commands.push({ name, params }); },
    runPageOperation: async (_tab, action, payload) => {
      if (action === "showVisualPoint") return { shown: true };
      actions.push({ action, payload });
      if (action === "dismissOverlay") return dismissal;
      if (covered > 0) { covered -= 1; throw error("visual_target_not_at_point", "The inspected point is covered by another element"); }
      return { supported: true, url: guard.pageUrl, topLevelUrl: guard.pageUrl, pageInstanceId: "doc", point: { x: 300, y: 400 },
        clippedRect: { x: 250, y: 380, width: 100, height: 40 }, viewport: guard.viewport, scroll: { x: 0, y: 0 },
        framePath: [], coordinateSpace: "top-level-viewport", element, elementRefMatched: true };
    },
    chrome: { tabs: { get: async (id) => ({ id, windowId: 2 }), query: async () => [{ id: 11, windowId: 2 }], update: async () => {} },
      windows: { update: async () => {} }, debugger: { attach: async () => {}, detach: async () => {} } },
  };
  ctx.debuggerSessions = new DebuggerSessionPool(ctx.chrome.debugger);
  vm.createContext(ctx);
  vm.runInContext(`${mouse}\n${input}`, ctx);
  let result, thrown;
  try { result = await ctx.runTrustedVisualInput(11, "visual.click", { point: guard.point, visualTargetGuard: guard, allowedOrigins: ["https://crowdworks.jp"] }); }
  catch (caught) { thrown = caught; }
  return { result, thrown, commands, actions };
}

test("a covered target: the window is closed once, the target checked again, then clicked", async () => {
  const r = await click();
  assert.ifError(r.thrown);
  assert.deepEqual(r.actions.map((a) => a.action), ["inspectVisualTarget", "dismissOverlay", "inspectVisualTarget"]);
  assert.deepEqual(JSON.parse(JSON.stringify(r.actions[1].payload.locator)), guard.locator);
  assert.equal(r.commands.length, 3);
  assert.equal(r.result.clickGuardReadback.overlayDismissal.control, "閉じる");
});

test("a window that stays, or a target still covered after closing, stops without any mouse input", async () => {
  for (const options of [{ dismissal: { overlayFound: true, attempted: true, method: "escape", cleared: false } },
    { coveredTimes: 2 }, { dismissal: { overlayFound: false, attempted: false, cleared: false } }]) {
    const r = await click(options);
    assert.equal(r.thrown?.code, "visual_target_not_at_point");
    assert.equal(r.commands.length, 0);
    assert.equal(r.actions.filter((a) => a.action === "dismissOverlay").length, 1, "closes at most once");
    assert.ok(r.thrown.details.overlayDismissal);
  }
});

test("an uncovered target never touches any window", async () => {
  const r = await click({ coveredTimes: 0 });
  assert.ifError(r.thrown);
  assert.equal(r.actions.some((a) => a.action === "dismissOverlay"), false);
});

const naming = slice("  const looseKey = ", "  const parentSemanticNode = ");
const closing = slice("  const DISMISS_KEYS = ", "  const PAGE_FRAME_ROLES = ");
const normalize = (value) => String(value ?? "").replace(/\s+/g, " ").trim();
const { dismissesOnly } = vm.runInNewContext(`${naming}\n${closing}\n({ dismissesOnly })`, {
  normalize, lower: (value) => normalize(value).toLocaleLowerCase(), accessibleName: () => "", referencedText: () => "",
  iconName: () => "", implicitRole: () => "",
});

test("only controls that close or postpone a window may be pressed", () => {
  for (const name of ["閉じる", "×", "✕", "Close", "close dialog", "あとで", "後で", "今はしない", "Not now", "スキップ", "Skip", "Maybe later", "Dismiss"]) {
    assert.equal(dismissesOnly(name), true, name);
  }
  for (const name of ["同意する", "すべて許可", "Accept all cookies", "Allow", "登録する", "Sign up", "購入", "送信", "はい", "OK", "続行",
    "アプリをインストール", "Install app", "閉じて同意する", "退会", "削除", "Unfollow", "提案する", ""]) {
    assert.equal(dismissesOnly(name), false, name);
  }
});
