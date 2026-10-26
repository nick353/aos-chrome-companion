import assert from "node:assert/strict";
import { createServer } from "node:http";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { BrokerClient } from "../src/client/broker-client.mjs";

// 外部サイトには触れず、実際のChromeで別タブの作成・台帳・閉鎖を確認する。
const taskId = process.env.CODEX_THREAD_ID || process.env.CODEX_SESSION_ID;
if (!taskId) throw new Error("現在の作業の識別子が必要です");
const runId = `popup-cleanup-${Date.now()}`;
const server = createServer((req, res) => {
  res.setHeader("Content-Type", "text/html; charset=utf-8");
  res.end(req.url === "/child" ? "<!doctype html><meta charset=utf-8><h1>別タブの片付け確認</h1>"
    : '<!doctype html><meta charset=utf-8><h1>タブの片付け確認</h1><a data-testid="popup" target="_blank" rel="noopener" href="/child">別タブを開く</a>');
});
await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
const origin = `http://127.0.0.1:${server.address().port}`;
let client, session;
const report = { runId, taskId, startedAt: new Date().toISOString() };
try {
  client = await BrokerClient.connect();
  session = await client.request("session.open", { taskId });
  const before = await client.request("operation.execute", { sessionId: session.sessionId, method: "tabs.list", params: {} });
  const opened = await client.requestAuthorizedTransaction({ sessionId: session.sessionId, taskId, runId,
    idempotencyKey: `${runId}:open`, startUrl: origin, allowedOrigins: [origin], keepTaskTab: true,
    actions: [{ method: "page.click", params: { locator: { testId: "popup" } } }] });
  assert.equal(opened.result, "verified", JSON.stringify({ result: opened.result, blocker: opened.exact_blocker }));
  report.parentTabId = opened.tab.id;
  let child, status;
  for (let i = 0; i < 30; i++) {
    const live = await client.request("operation.execute", { sessionId: session.sessionId, method: "tabs.list", params: {} });
    child = live.find(tab => tab.url === `${origin}/child`);
    status = await client.request("status.get", { taskId, detail: "all" });
    if (child && status.taskTabs.some(tab => tab.tabId === child.id && tab.taskId === taskId)) break;
    await new Promise(resolve => setTimeout(resolve, 200));
  }
  assert.ok(child, "別タブが開かれていません");
  report.childTabId = child.id;
  assert.ok(status.taskTabs.some(tab => tab.tabId === child.id && tab.taskId === taskId), "別タブが台帳に登録されていません");
  report.cleanup = (await client.request("session.close", { sessionId: session.sessionId, taskTerminal: true, abandonUserHelp: true })).cleanup_receipt;
  session = await client.request("session.open", { taskId });
  const after = await client.request("operation.execute", { sessionId: session.sessionId, method: "tabs.list", params: {} });
  assert.ok(!after.some(tab => [report.parentTabId, report.childTabId].includes(tab.id)), "確認用のタブが残っています");
  assert.ok(before.every(tab => after.some(t => t.id === tab.id)), "既存のタブが失われています");
  report.existingTabsPreserved = true;
  report.remainingTestTabs = 0;
  report.result = "passed";
} catch (error) {
  report.result = "failed";
  report.error = error.message;
  process.exitCode = 1;
} finally {
  if (session) report.finalCleanup = await client.request("session.close", { sessionId: session.sessionId, taskTerminal: true, abandonUserHelp: true }).catch(e => ({ error: e.message }));
  client?.close();
  server.closeAllConnections();
  await new Promise(resolve => server.close(resolve));
  await mkdir("outputs", { recursive: true });
  const path = join("outputs", `${runId}.json`);
  await writeFile(path, JSON.stringify(report, null, 2));
  console.log(JSON.stringify({ ...report, evidencePath: path }));
}
