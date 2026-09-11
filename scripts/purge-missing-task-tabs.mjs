#!/usr/bin/env node

import { writeFile } from "node:fs/promises";
import { BrokerClient } from "../src/client/broker-client.mjs";

function parseArgs(argv) {
  const result = { tabIds: [], execute: false, runId: null, taskId: null, receiptPath: null };
  for (let index = 0; index < argv.length; index += 1) {
    const value = argv[index];
    if (value === "--task-id") result.taskId = argv[++index] ?? null;
    else if (value === "--tab-id") result.tabIds.push(Number(argv[++index]));
    else if (value === "--run-id") result.runId = argv[++index] ?? null;
    else if (value === "--receipt") result.receiptPath = argv[++index] ?? null;
    else if (value === "--execute") result.execute = true;
    else if (value === "--help") result.help = true;
    else throw new Error(`Unknown argument: ${value}`);
  }
  if (result.help) return result;
  if (!result.execute) throw new Error("--execute is required for missing task-tab purge");
  if (!result.taskId) throw new Error("--task-id is required");
  if (result.tabIds.length === 0 || result.tabIds.some((value) => !Number.isSafeInteger(value) || value < 0)) {
    throw new Error("At least one valid --tab-id is required");
  }
  result.tabIds = [...new Set(result.tabIds)].sort((left, right) => left - right);
  result.runId ||= `missing-task-tab-purge-${new Date().toISOString().replace(/[^0-9]/gu, "").slice(0, 14)}`;
  return result;
}

function usage() {
  process.stderr.write(
    "Usage: npm run purge:missing-task-tabs -- --execute --task-id <task> --tab-id <id> [--tab-id <id>] [--run-id <id>] [--receipt <path>]\n",
  );
}

const options = parseArgs(process.argv.slice(2));
if (options.help) {
  usage();
  process.exit(0);
}

const client = await BrokerClient.connect({ autoStart: false });
let session;
try {
  session = await client.request("session.open", {
    taskId: options.taskId,
    label: "explicit missing stale task-tab purge",
  });
  const result = await client.requestPurgeMissingTaskTabs({
    sessionId: session.sessionId,
    taskId: options.taskId,
    runId: options.runId,
    idempotencyKey: `${options.runId}:purge`,
    profileInstanceId: session.profileInstanceId,
    tabIds: options.tabIds,
    confirmMissingOnly: true,
  });
  const receipt = {
    ...result,
    command: "purge:missing-task-tabs",
    approval: "explicit_user_approved_missing_record_only",
  };
  if (options.receiptPath) await writeFile(options.receiptPath, `${JSON.stringify(receipt, null, 2)}\n`, { mode: 0o600 });
  process.stdout.write(`${JSON.stringify(receipt, null, 2)}\n`);
  if (result.live_tab_ids?.length || result.retained?.length) process.exitCode = 4;
} finally {
  if (session) await client.request("session.close", { sessionId: session.sessionId, taskTerminal: false }).catch(() => {});
  client.close();
}
