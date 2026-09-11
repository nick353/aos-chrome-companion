#!/usr/bin/env node

import { BrokerClient } from "../src/client/broker-client.mjs";

function parseArgs(argv) {
  const output = { dryRun: true, preserveTabIds: [], runId: null };
  for (let index = 0; index < argv.length; index += 1) {
    const value = argv[index];
    if (value === "--execute") output.dryRun = false;
    else if (value === "--run-id") output.runId = argv[++index];
    else if (value === "--preserve-tab") output.preserveTabIds.push(Number(argv[++index]));
    else if (value === "--help") output.help = true;
    else throw new Error(`Unknown argument: ${value}`);
  }
  if (output.preserveTabIds.some((value) => !Number.isSafeInteger(value) || value < 0)) {
    throw new Error("Every --preserve-tab value must be a non-negative integer");
  }
  output.preserveTabIds = [...new Set(output.preserveTabIds)].sort((left, right) => left - right);
  return output;
}

const options = parseArgs(process.argv.slice(2));
if (options.help) {
  process.stdout.write("Usage: npm run cleanup:task-tabs -- [--execute] [--run-id <id>] [--preserve-tab <tabId>]...\n");
  process.exit(0);
}

const taskId = process.env.CODEX_THREAD_ID || process.env.CODEX_SESSION_ID;
if (!taskId) throw new Error("CODEX_THREAD_ID or CODEX_SESSION_ID is required");
const runId = options.runId || `task-tab-cleanup-${new Date().toISOString().replaceAll(/[^0-9]/g, "").slice(0, 14)}`;
const client = await BrokerClient.connect();
let session;
try {
  const status = await client.request("status.get");
  const connectedProfiles = (status.profiles || []).filter((profile) => profile.connected === true);
  if (connectedProfiles.length !== 1) {
    throw new Error(`Expected exactly one connected Companion profile, received ${connectedProfiles.length}`);
  }
  session = await client.request("session.open", {
    taskId,
    profileInstanceId: connectedProfiles[0].profileInstanceId,
    label: "owner-safe task-tab cleanup",
  });
  const result = await client.requestCleanupTaskTabs({
    sessionId: session.sessionId,
    runId,
    taskId,
    idempotencyKey: `${runId}:cleanup`,
    preserveTabIds: options.preserveTabIds,
    dryRun: options.dryRun,
  });
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
  if (result.unknown_effect?.length > 0) process.exitCode = 4;
} finally {
  if (session) await client.request("session.close", { sessionId: session.sessionId }).catch(() => {});
  client.close();
}
