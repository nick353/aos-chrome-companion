#!/usr/bin/env node
/**
 * Deterministic Companion scheduler canary.
 *
 * This is intentionally a broker fixture rather than a live Chrome run: it
 * opens no user tabs, claims no existing tab, sends no page mutation, and
 * performs no authentication or CAPTCHA work.  It exercises the same socket
 * protocol with a bounded fake Extension relay so that the target-lane
 * concurrency/fairness and profile-global foreground barrier can be measured
 * without leaving a browser tab behind when a renderer is slow.
 */
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { CompanionBroker } from "../src/broker/broker.mjs";
import { BrokerClient } from "../src/client/broker-client.mjs";
import { connectPeer } from "../src/client/connect.mjs";
import { normalizeError } from "../src/shared/errors.mjs";
import { createId } from "../src/shared/ids.mjs";
import { DEFAULT_CAPABILITIES, PROTOCOL_VERSION } from "../src/shared/constants.mjs";
import { INSTALL_BUILD_ID } from "../src/shared/build-info.mjs";
import { ensureBrokerSecret } from "../src/shared/security.mjs";

const profileInstanceId = "profile_parallel_readonly_canary";
const runId = createId("parallel-readonly-canary");
const startedAt = new Date().toISOString();
const outputDir = resolve("outputs");
const outputPath = join(outputDir, `parallel-readonly-canary-${startedAt.replace(/[:.]/g, "-")}.json`);
const report = {
  schema: "aos.chrome_companion.parallel_readonly_canary.v1",
  mode: "broker_fixture",
  runId,
  startedAt,
  result: "running",
  targetLanes: 4,
  foregroundRequests: 3,
  metrics: {
    targetActive: 0,
    targetMaxActive: 0,
    foregroundActive: 0,
    foregroundMaxActive: 0,
    targetStarts: 0,
    foregroundStarts: 0,
    targetCompletions: 0,
    foregroundCompletions: 0,
    targetErrors: 0,
    foregroundErrors: 0,
    targetQueueWaitMs: [],
  },
  broker: null,
  cleanup: { sessionsClosed: 0, leasesReleased: 0 },
  exactBlocker: null,
};

const delayMs = 35;
let tempDir;
let broker;
let extension;
let client;
const sessions = [];

function wait(ms) {
  return new Promise((resolvePromise) => setTimeout(resolvePromise, ms));
}

function sendResult(message) {
  const method = message.method;
  if (method === "page.snapshot") {
    extension.send({
      kind: "command.result",
      operationId: message.operationId,
      result: {
        url: `http://fixture.invalid/tab/${message.params.tabId}`,
        topLevelUrl: `http://fixture.invalid/tab/${message.params.tabId}`,
        title: "AOS Companion read-only fixture",
        pageInstanceId: `page-${message.params.tabId}`,
        text: `read-only tab ${message.params.tabId}`,
        semanticEmpty: false,
      },
    });
    return;
  }
  if (method === "tabs.activate") {
    extension.send({
      kind: "command.result",
      operationId: message.operationId,
      result: { tabId: message.params.tabId, active: true },
    });
    return;
  }
  extension.send({
    kind: "command.result",
    operationId: message.operationId,
    result: { method, tabId: message.params?.tabId ?? null },
  });
}

async function runOperation(record, method) {
  const isForeground = method === "tabs.activate";
  const metrics = report.metrics;
  if (isForeground) {
    metrics.foregroundStarts += 1;
  } else {
    metrics.targetStarts += 1;
  }
  try {
    const result = await client.request("operation.execute", {
      sessionId: record.session.sessionId,
      leaseId: record.lease.leaseId,
      method,
      params: { tabId: record.tabId },
      ...(isForeground ? {} : { timeoutMs: 5_000 }),
    }, { timeoutMs: 10_000 });
    const queueWaitMs = Number(result?.queueWaitMs ?? result?.queue_wait_ms);
    if (!isForeground && Number.isFinite(queueWaitMs)) metrics.targetQueueWaitMs.push(queueWaitMs);
    if (isForeground) metrics.foregroundCompletions += 1;
    else metrics.targetCompletions += 1;
    return result;
  } catch (error) {
    if (isForeground) metrics.foregroundErrors += 1;
    else metrics.targetErrors += 1;
    throw error;
  } finally {
    // Active/max-active are measured at the fake Extension relay below.  That
    // keeps the metric about broker dispatch concurrency, not client promises.
  }
}

async function closeSession(record) {
  if (!record?.session?.sessionId) return;
  try {
    const result = await client.request("session.close", { sessionId: record.session.sessionId });
    if (result?.closed === true) report.cleanup.sessionsClosed += 1;
  } catch {
    // The final status below is authoritative.  Do not retry a close after an
    // ownership/transport uncertainty because the fixture has no external tab.
  }
}

try {
  tempDir = await mkdtemp(join(tmpdir(), "aos-companion-parallel-readonly-"));
  const env = {
    ...process.env,
    AOS_CHROME_COMPANION_DATA_DIR: tempDir,
    AOS_CHROME_COMPANION_SOCKET: join(tempDir, "broker.sock"),
    AOS_CHROME_COMPANION_SECRET_FILE: join(tempDir, "broker-secret"),
  };
  const secret = await ensureBrokerSecret(env);
  broker = new CompanionBroker({ socketPath: env.AOS_CHROME_COMPANION_SOCKET, secret });
  await broker.listen();
  extension = await connectPeer({ role: "extension-relay", autoStart: false, env });
  const helloAck = new Promise((resolvePromise) => {
    const remove = extension.onMessage((message) => {
      if (message.kind !== "extension.hello_ack") return;
      remove();
      resolvePromise(message);
    });
  });
  extension.onMessage(async (message) => {
    if (message.kind !== "command.request") return;
    const foreground = message.method === "tabs.activate";
    const metrics = report.metrics;
    if (foreground) {
      metrics.foregroundActive += 1;
      metrics.foregroundMaxActive = Math.max(metrics.foregroundMaxActive, metrics.foregroundActive);
    } else {
      metrics.targetActive += 1;
      metrics.targetMaxActive = Math.max(metrics.targetMaxActive, metrics.targetActive);
    }
    try {
      await wait(delayMs);
      sendResult(message);
    } finally {
      if (foreground) metrics.foregroundActive = Math.max(0, metrics.foregroundActive - 1);
      else metrics.targetActive = Math.max(0, metrics.targetActive - 1);
    }
  });
  extension.send({
    kind: "extension.hello",
    protocolVersion: PROTOCOL_VERSION,
    profileInstanceId,
    extensionRuntimeId: "runtime_parallel_readonly_canary",
    buildId: INSTALL_BUILD_ID,
    capabilities: DEFAULT_CAPABILITIES,
  });
  await helloAck;

  client = await BrokerClient.connect({ autoStart: false, env });
  for (let index = 0; index < 4; index += 1) {
    const session = await client.request("session.open", {
      taskId: `${runId}:target-${index + 1}`,
      label: `Parallel read-only target ${index + 1}`,
    });
    const tabId = 700 + index;
    const lease = await client.request("lease.acquire", { sessionId: session.sessionId, tabId });
    sessions.push({ session, lease, tabId });
  }

  // Four independent targets verify the default 3-wide target lane and its
  // FIFO queue.  The operation is page.snapshot only (no page mutation).
  await Promise.all(sessions.map((record) => runOperation(record, "page.snapshot")));

  // Profile-global foreground work remains serial even when issued by three
  // different logical sessions.  tabs.activate is metadata/UI state only in
  // this fixture and does not touch a real browser window.
  await Promise.all(sessions.slice(0, 3).map((record) => runOperation(record, "tabs.activate")));

  const status = await client.request("status.get");
  const lane = status.targetLaneMetrics?.find((entry) => entry.profileInstanceId === profileInstanceId) ?? null;
  report.broker = {
    targetLanePolicy: status.targetLanePolicy ?? null,
    targetLaneMetrics: lane,
    logicalSessionCount: status.logicalSessionCount ?? null,
    exactTabLeaseCount: status.exactTabLeaseCount ?? null,
    queueCount: status.queueCount ?? null,
  };
  report.metrics.targetQueueWaitMs.push(Number(lane?.queueWaitMsMax ?? 0));
  if (!lane || lane.maxActive !== 3 || lane.admitted !== 4 || lane.completed !== 4) {
    throw new Error("parallel_readonly_target_lane_metrics_not_verified");
  }
  if (report.metrics.foregroundMaxActive !== 1 || report.metrics.foregroundErrors !== 0) {
    throw new Error("parallel_readonly_foreground_lane_not_serial");
  }
  report.result = "verified_read_only";
} catch (error) {
  report.result = "blocked";
  report.exactBlocker = normalizeError(error);
} finally {
  for (const record of [...sessions].reverse()) {
    if (!client) break;
    try {
      await client.request("lease.release", { leaseId: record.lease.leaseId });
      report.cleanup.leasesReleased += 1;
    } catch {
      // No live browser tab exists in this fixture; status/close is enough.
    }
  }
  for (const record of [...sessions].reverse()) await closeSession(record);
  const finalStatus = client
    ? await client.request("status.get").catch((error) => ({ error: normalizeError(error) }))
    : null;
  report.finalStatus = {
    logicalSessionCount: finalStatus?.logicalSessionCount ?? null,
    exactTabLeaseCount: finalStatus?.exactTabLeaseCount ?? null,
    queueCount: finalStatus?.queueCount ?? null,
  };
  client?.close();
  extension?.close();
  if (broker) await broker.close().catch(() => {});
  if (tempDir) await rm(tempDir, { recursive: true, force: true }).catch(() => {});
  report.finishedAt = new Date().toISOString();
  await mkdir(outputDir, { recursive: true });
  await writeFile(outputPath, `${JSON.stringify(report, null, 2)}\n`, { mode: 0o600 });
}

process.stdout.write(`${JSON.stringify({ outputPath, ...report }, null, 2)}\n`);
if (report.result !== "verified_read_only") process.exitCode = 1;
