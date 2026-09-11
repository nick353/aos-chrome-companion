#!/usr/bin/env node

/**
 * One-shot maintenance entrypoint for an abandoned localhost Companion
 * canary. It deliberately accepts only an exact tab/run and an explicit
 * synthetic-only confirmation; all scope checks remain in the broker.
 */
import { BrokerClient } from "../src/client/broker-client.mjs";

function parseArgs(argv) {
  const args = {};
  for (let index = 0; index < argv.length; index += 1) {
    const value = argv[index];
    if (value === "--tab-id") args.tabId = Number(argv[++index]);
    else if (value === "--run-id") args.runId = argv[++index];
    else if (value === "--profile-instance-id") args.profileInstanceId = argv[++index];
    else if (value === "--idempotency-key") args.idempotencyKey = argv[++index];
    else if (value === "--confirm-synthetic-canary") args.confirmSyntheticCanary = true;
    else if (value === "--help") args.help = true;
  }
  return args;
}

function usage() {
  process.stderr.write(
    "Usage: node scripts/retire-local-canary.mjs --tab-id <id> --run-id <canary-run> --idempotency-key <key> --confirm-synthetic-canary [--profile-instance-id <id>]\n",
  );
}

const args = parseArgs(process.argv.slice(2));
if (args.help || !Number.isSafeInteger(args.tabId) || typeof args.runId !== "string" || typeof args.idempotencyKey !== "string" || args.confirmSyntheticCanary !== true) {
  usage();
  process.exit(args.help ? 0 : 2);
}
const taskId = process.env.CODEX_THREAD_ID || process.env.CODEX_SESSION_ID;
if (typeof taskId !== "string" || !taskId) throw new Error("codex_task_identity_required");

const client = await BrokerClient.connect({ autoStart: false });
let session = null;
try {
  session = await client.request("session.open", {
    taskId,
    label: "signed local canary retirement",
    ...(args.profileInstanceId ? { profileInstanceId: args.profileInstanceId } : {}),
  });
  const result = await client.requestRetireLocalCanary({
    sessionId: session.sessionId,
    taskId,
    runId: args.runId,
    tabId: args.tabId,
    idempotencyKey: args.idempotencyKey,
    confirmSyntheticCanary: true,
    ...(args.profileInstanceId ? { profileInstanceId: args.profileInstanceId } : {}),
  });
  process.stdout.write(`${JSON.stringify(result)}\n`);
} finally {
  if (session) await client.request("session.close", { sessionId: session.sessionId, taskTerminal: false }).catch(() => {});
  client.close();
}
