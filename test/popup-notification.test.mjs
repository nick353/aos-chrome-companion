import assert from "node:assert/strict";
import test from "node:test";
import { notifyPopupTarget } from "../extension/popup-notification.js";

test("別タブのopenerTabIdが手動のタブでも、Chromeの実際の開き元を伝える", async () => {
  const state = { connected: true, profileInstanceId: "p", generation: "g", port: {} };
  const sent = [];
  await notifyPopupTarget({ sourceTabId: 7, tabId: 8, url: "https://example.test/apply" }, {
    current: () => ({ ...state }), tabs: { get: async () => ({ id: 8, windowId: 2, openerTabId: 1 }) },
    send: message => sent.push(message),
  });
  assert.equal(sent.length, 1);
  assert.equal(sent[0].sourceTabId, 7);
  assert.equal(sent[0].tabId, 8);
  assert.equal(sent[0].windowId, 2);
});

test("未接続・閉鎖済み・世代の変わった別タブの通知は捨てる", async () => {
  for (const failure of ["disconnected", "removed", "generation", "port"]) {
    const state = { connected: failure !== "disconnected", profileInstanceId: "p", generation: "g", port: {} };
    const sent = [];
    await notifyPopupTarget({ sourceTabId: 7, tabId: 8, url: "https://example.test/apply" }, {
      current: () => ({ ...state }), tabs: { get: async () => {
        if (failure === "removed") throw new Error("No tab");
        if (failure === "generation") state.generation = "new";
        if (failure === "port") state.port = {};
        return { id: 8, windowId: 2 };
      } }, send: message => sent.push(message),
    });
    assert.equal(sent.length, 0, failure);
  }
});
