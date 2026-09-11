#!/usr/bin/env node
import { BrokerClient } from "../src/client/broker-client.mjs";
import { normalizeError } from "../src/shared/errors.mjs";
import { createId } from "../src/shared/ids.mjs";
import { resolveCodexTaskId } from "../src/mcp/task-context.mjs";

const taskId = resolveCodexTaskId();
if (!taskId) {
  process.stderr.write(`${JSON.stringify({ result: "blocked", exactBlocker: { code: "codex_thread_identity_unavailable" } }, null, 2)}\n`);
  process.exit(1);
}

const client = await BrokerClient.connect();
let session;
try {
  session = await client.request("session.open", {
    taskId,
    label: process.env.CODEX_THREAD_TITLE || `Task ${taskId.slice(-8)}`,
  });
  const runId = createId("group_task_tabs");
  const result = await client.requestGroupTaskTabs({
    sessionId: session.sessionId,
    runId,
    taskId,
    idempotencyKey: runId,
  });
  process.stdout.write(`${JSON.stringify({ result: "verified", ...result }, null, 2)}\n`);
} catch (error) {
  process.stderr.write(`${JSON.stringify({ result: "blocked", exactBlocker: normalizeError(error) }, null, 2)}\n`);
  process.exitCode = 1;
} finally {
  if (session) await client.request("session.close", { sessionId: session.sessionId }).catch(() => {});
  client.close();
}
