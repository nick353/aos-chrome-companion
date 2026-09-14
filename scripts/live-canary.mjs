#!/usr/bin/env node
import { createServer } from "node:http";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { BrokerClient } from "../src/client/broker-client.mjs";
import { materializeUploadParams } from "../src/mcp/action-materializer.mjs";
import { CompanionError, normalizeError } from "../src/shared/errors.mjs";
import { createId } from "../src/shared/ids.mjs";

const runId = createId("canary");
const startedAt = new Date().toISOString();
const outputDir = resolve("outputs");
const outputPath = join(outputDir, `live-canary-${startedAt.replace(/[:.]/g, "-")}.json`);
const report = {
  schema: "aos_chrome_companion_live_canary.v2",
  runId,
  startedAt,
  result: "running",
  profile: null,
  initialInventory: null,
  sessions: [],
  lanes: [],
  parallelReadback: null,
  visualReadback: [],
  metrics: {
    requests: [],
    inFlight: 0,
    maxInFlight: 0,
    queueWaitMs: [],
    timeoutCount: 0,
    targetMismatchCount: 0,
    cleanupAttempts: 0,
    cleanupClosed: 0,
    foregroundLaneRequests: 0,
  },
  cleanup: { tabs: [], sessions: [], finalStatus: null },
  exactBlocker: null,
  failureStep: null,
};

// A live canary is a bounded diagnostic, not a production worker.  Keep every
// step finite so a stalled bridge cannot leave the run looking active forever.
// A transaction may contain several bounded semantic/visual readbacks. Keep
// the client deadline above the per-operation 30s broker deadline so the
// broker can return its signed unknown-effect receipt instead of leaving a
// detached discovered tab behind merely because the client gave up first.
// The Companion operation contract caps one request at 60 seconds. Keep the
// canary within that same public contract instead of failing before dispatch.
const CANARY_REQUEST_TIMEOUT_MS = 60_000;
const CANARY_READ_TIMEOUT_MS = 10_000;
let currentStep = "startup";

function recordMetric(entry) {
  const code = entry?.error?.code ?? entry?.errorCode ?? null;
  if (code && /(?:timeout|timed_out)/iu.test(code)) report.metrics.timeoutCount += 1;
  if (code && /(?:target|owner|generation|frame|lease).*mismatch|mismatch.*(?:target|owner|generation|frame|lease)/iu.test(code)) {
    report.metrics.targetMismatchCount += 1;
  }
  if (Number.isFinite(Number(entry?.queueWaitMs))) report.metrics.queueWaitMs.push(Number(entry.queueWaitMs));
  report.metrics.requests.push({
    ...entry,
    durationMs: Math.max(0, Math.round(Number(entry?.durationMs) || 0)),
  });
}

async function canaryRequest(method, params = {}, { timeoutMs = CANARY_READ_TIMEOUT_MS, lane = null, phase = null } = {}) {
  currentStep = method;
  const startedAtMs = performance.now();
  report.metrics.inFlight += 1;
  report.metrics.maxInFlight = Math.max(report.metrics.maxInFlight, report.metrics.inFlight);
  if (["page.screenshot", "tabs.activate", "visual.target.inspect", "visual.point.inspect"].includes(method)) {
    report.metrics.foregroundLaneRequests += 1;
  }
  try {
    const result = await client.request(method, params, { timeoutMs });
    recordMetric({ kind: "request", method, lane, phase, ok: true, durationMs: performance.now() - startedAtMs, queueWaitMs: result?.queueWaitMs ?? result?.queue_wait_ms ?? null });
    report.metrics.inFlight = Math.max(0, report.metrics.inFlight - 1);
    return result;
  } catch (error) {
    recordMetric({ kind: "request", method, lane, phase, ok: false, durationMs: performance.now() - startedAtMs, error: normalizeError(error) });
    report.metrics.inFlight = Math.max(0, report.metrics.inFlight - 1);
    throw new CompanionError(error?.code ?? "live_canary_request_failed", `Live canary step failed: ${method}`, {
      cause: error?.message ?? String(error),
      method,
      currentStep,
      timeoutMs,
      details: error?.details ?? null,
    });
  }
}

const server = createServer((_request, response) => {
  response.writeHead(200, { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" });
  response.end(`<!doctype html><html><head><title>AOS Companion Canary</title></head><body>
    <main><h1>AOS Companion Canary</h1><label for="canary-semantic-input">Semantic value</label>
    <input id="canary-semantic-input" data-testid="canary-semantic-input" />
    <label for="canary-physical-input">Physical fallback value</label>
    <input id="canary-physical-input" data-testid="canary-physical-input" value="original" />
    <label for="canary-file">Canary upload</label><input hidden type="file" id="canary-file" data-testid="canary-file" />
    <p role="status" data-testid="upload-status">waiting</p><p data-testid="ready">ready</p></main>
    <script>const physicalInput = document.querySelector('#canary-physical-input');
    for (const eventName of ['input', 'change']) physicalInput.addEventListener(eventName, (event) => {
      if (!event.isTrusted) physicalInput.value = 'original';
    });
    document.querySelector('#canary-file').addEventListener('change', () => {
      document.querySelector('#upload-status').textContent = document.querySelector('#canary-file').files.length === 1 ? 'uploaded' : 'missing';
    });</script>
  </body></html>`);
});
await new Promise((resolvePromise, reject) => {
  server.once("error", reject);
  server.listen(0, "127.0.0.1", resolvePromise);
});
const address = server.address();
const origin = `http://127.0.0.1:${address.port}`;
const startUrl = `${origin}/canary`;
const uploadDirectory = await mkdtemp(join(tmpdir(), "aos-companion-live-upload-"));
const uploadPath = join(uploadDirectory, "canary.txt");
await writeFile(uploadPath, `AOS Companion live upload ${runId}\n`, { mode: 0o600 });
const uploadParams = await materializeUploadParams({ filePath: uploadPath, locator: { testId: "canary-file" } });

const client = await BrokerClient.connect();
const laneRecords = [];
let terminalError;

function transaction(record, phase, { keepTaskTab }) {
  currentStep = `task.transaction:${record.lane}:${phase}`;
  const startedAtMs = performance.now();
  report.metrics.inFlight += 1;
  report.metrics.maxInFlight = Math.max(report.metrics.maxInFlight, report.metrics.inFlight);
  return client.requestAuthorizedTransaction({
    sessionId: record.session.sessionId,
    runId: `${runId}:${record.lane}:${phase}`,
    taskId: record.taskId,
    idempotencyKey: `${runId}:${record.lane}:${phase}`,
    intent: `live_canary_${phase}`,
    targetOrigin: origin,
    startUrl,
    allowedOrigins: [origin],
    actions: phase === "create"
      ? [
          { method: "page.type", params: { locator: { testId: "canary-semantic-input" }, text: `semantic-${record.lane}`, clear: true, physicalFallback: "on_verified_no_effect" } },
          { method: "page.type", params: { locator: { testId: "canary-physical-input" }, text: `physical-${record.lane}`, clear: true, physicalFallback: "on_verified_no_effect" } },
          { method: "page.upload", params: uploadParams },
        ]
      : [{ method: "page.waitFor", params: { locator: { testId: "ready" }, timeoutMs: 5_000 } }],
    reuseTaskTab: true,
    keepTaskTab,
    retainOnUnknown: true,
  }, { timeoutMs: CANARY_REQUEST_TIMEOUT_MS }).then((result) => {
    recordMetric({ kind: "authorized_transaction", method: "task.transaction", lane: record.lane, phase, ok: true, durationMs: performance.now() - startedAtMs, queueWaitMs: result?.queueWaitMs ?? result?.queue_wait_ms ?? null });
    report.metrics.inFlight = Math.max(0, report.metrics.inFlight - 1);
    if (phase === "reuse-and-close" || phase === "final-cleanup") {
      report.metrics.cleanupAttempts += 1;
      if (result?.cleanup?.closed === true) report.metrics.cleanupClosed += 1;
    }
    return result;
  }, (error) => {
    recordMetric({ kind: "authorized_transaction", method: "task.transaction", lane: record.lane, phase, ok: false, durationMs: performance.now() - startedAtMs, error: normalizeError(error) });
    report.metrics.inFlight = Math.max(0, report.metrics.inFlight - 1);
    throw error;
  });
}

async function cleanupFailedCanaryTabs() {
  // A transaction can time out after tabs.create has been acknowledged by
  // Chrome but before the client receives its result. Re-discover those tabs
  // by task id and use the normal signed cleanup endpoint. Never close an
  // unknown-effect/reconciliation tab: it is intentionally retained for
  // signed readback instead of being guessed away.
  const status = await canaryRequest("status.get");
  const byTask = new Map((status.taskTabs ?? []).map((entry) => [entry.taskId, entry]));
  report.cleanup.recovered = [];
  for (const record of [...laneRecords].reverse()) {
    const entry = byTask.get(record.taskId);
    if (!entry || record.cleanup?.cleanup?.closed === true) continue;
    const protectedEntry = entry.userHelpRequired === true
      || entry.retentionPolicy === "retain_until_resume"
      || entry.resumeToken
      || ["awaiting_user", "reconciliation_required", "executing"].includes(entry.lifecycleState);
    const cleanupEligible = !protectedEntry
      && ["failed", "completed"].includes(entry.lifecycleState)
      && ["retain", "cleanup"].includes(entry.retentionPolicy);
    if (!cleanupEligible) {
      report.cleanup.recovered.push({ tabId: entry.tabId, taskId: record.taskId, closed: false, preserved: true, reason: entry.retentionReason ?? entry.lifecycleState ?? "protected" });
      continue;
    }
    let cleanupSession = null;
    try {
      cleanupSession = await canaryRequest("session.open", { taskId: record.taskId, label: `Canary cleanup lane ${record.lane}` });
      report.metrics.cleanupAttempts += 1;
      const cleanup = await client.requestCleanupTaskTabs({
        sessionId: cleanupSession.sessionId,
        runId: `${runId}:cleanup:${record.lane}`,
        taskId: record.taskId,
        preserveTabIds: [],
        idempotencyKey: `${runId}:cleanup:${record.lane}`,
      }, { timeoutMs: CANARY_REQUEST_TIMEOUT_MS });
      if (cleanup.closed?.includes?.(entry.tabId) === true) report.metrics.cleanupClosed += 1;
      report.cleanup.recovered.push({ tabId: entry.tabId, taskId: record.taskId, closed: cleanup.closed?.includes?.(entry.tabId) === true, result: cleanup });
    } catch (error) {
      report.cleanup.recovered.push({ tabId: entry.tabId, taskId: record.taskId, closed: false, error: normalizeError(error) });
    } finally {
      if (cleanupSession) {
        try { await canaryRequest("session.close", { sessionId: cleanupSession.sessionId }); } catch { /* preserve the primary cleanup result */ }
      }
    }
  }
}

try {
  const status = await canaryRequest("status.get");
  const connectedProfiles = status.profiles.filter((profile) => profile.connected);
  if (connectedProfiles.length !== 1) {
    throw new CompanionError(
      connectedProfiles.length === 0 ? "profile_not_connected" : "profile_selection_ambiguous",
      `Expected exactly one connected profile; received ${connectedProfiles.length}`,
    );
  }
  report.profile = connectedProfiles[0];

  for (let lane = 1; lane <= 3; lane += 1) {
    const taskId = `${runId}:lane-${lane}`;
    const session = await canaryRequest("session.open", { label: `Canary lane ${lane}`, taskId });
    const record = { lane, taskId, session, retained: null, cleanup: null };
    laneRecords.push(record);
    report.sessions.push({ lane, ...session });
  }

  const inventory = await canaryRequest("operation.execute", {
    sessionId: laneRecords[0].session.sessionId,
    method: "tabs.list",
    params: {},
  });
  report.initialInventory = {
    tabCount: inventory.length,
    activeTabCount: inventory.filter((tab) => tab.active).length,
    windowCount: new Set(inventory.map((tab) => tab.windowId)).size,
  };

  const createStartedAt = performance.now();
  // The physical-fallback lane temporarily promotes its exact task tab to
  // the foreground for trusted CDP input.  Keep those transactions ordered
  // so another canary lane cannot change the active tab between the visual
  // proof and the physical dispatch.  Read-only concurrency is covered by
  // canary:parallel:readonly; this lane specifically proves foreground
  // ownership and the no-replay boundary for physical input.
  const created = [];
  for (const record of laneRecords) {
    const result = await transaction(record, "create", { keepTaskTab: true });
    record.retained = result;
    created.push(result);
  }
  const createElapsedMs = Math.round(performance.now() - createStartedAt);
  created.forEach((result, index) => {
    const record = laneRecords[index];
    if (result.result !== "verified") {
      throw new CompanionError("live_canary_transaction_not_verified", `Lane ${record.lane} transaction was ${result.result ?? "unknown"}`, {
        result: result.result ?? null,
        exactBlocker: result.exact_blocker ?? null,
      });
    }
    if (result.tab?.reused !== false || !Number.isSafeInteger(result.tab?.groupId)) {
      throw new CompanionError("grouped_task_tab_not_verified", `Lane ${record.lane} did not create a verified grouped task tab`);
    }
    // Transaction action records intentionally omit replayable input params;
    // the signed order is the stable identity for these two canary steps.
    const typeInputs = result.actions?.filter((action) => action.method === "page.type") ?? [];
    const semanticInput = typeInputs[0];
    const physicalInput = typeInputs[1];
    if (semanticInput?.result?.semanticCommitted !== true
      || (semanticInput.result.inputStrategy !== undefined && semanticInput.result.inputStrategy !== "semantic")
      || semanticInput.result.physicalFallbackAttempted === true) {
      throw new CompanionError("semantic_input_canary_not_verified", `Lane ${record.lane} did not retain the semantic input path`);
    }
    if (physicalInput?.result?.inputStrategy !== "physical_fallback"
      || physicalInput.result.physicalFallbackAttempted !== true
      || physicalInput.result.physical?.trustedInput !== true) {
      throw new CompanionError("physical_input_canary_not_verified", `Lane ${record.lane} did not complete the verified physical fallback path`);
    }
    const upload = result.actions?.find((action) => action.method === "page.upload");
    if (upload?.result?.uploaded !== true || upload.result.uploadReadbackVerified !== true) {
      throw new CompanionError("upload_canary_not_verified", `Lane ${record.lane} did not complete the verified file-input upload path`);
    }
  });

  const visualResults = await Promise.all(laneRecords.map(async (record) => {
    const lease = await canaryRequest("lease.acquire", { sessionId: record.session.sessionId, tabId: record.retained.tab.id }, { lane: record.lane, phase: "visual" });
    try {
      const screenshot = await canaryRequest("operation.execute", {
        sessionId: record.session.sessionId,
        leaseId: lease.leaseId,
        method: "page.screenshot",
        params: { tabId: record.retained.tab.id },
        timeoutMs: CANARY_REQUEST_TIMEOUT_MS,
      }, { timeoutMs: CANARY_REQUEST_TIMEOUT_MS, lane: record.lane, phase: "visual" });
      if (screenshot.kind !== "screenshot"
        || screenshot.mimeType !== "image/jpeg"
        || typeof screenshot.dataBase64 !== "string"
        || screenshot.dataBase64.length === 0
        || screenshot.restored !== true) {
        throw new CompanionError("visual_readback_not_verified", `Lane ${record.lane} did not return a restored visual screenshot`);
      }
      return {
        lane: record.lane,
        tabId: record.retained.tab.id,
        mimeType: screenshot.mimeType,
        bytes: screenshot.bytes,
        quality: screenshot.quality,
        restored: screenshot.restored,
      };
    } finally {
      await canaryRequest("lease.release", { leaseId: lease.leaseId });
    }
  }));
  report.visualReadback = visualResults;

  const reuseStartedAt = performance.now();
  const reused = await Promise.all(laneRecords.map((record) => transaction(record, "reuse-and-close", { keepTaskTab: false })));
  const reuseElapsedMs = Math.round(performance.now() - reuseStartedAt);
  reused.forEach((result, index) => {
    const record = laneRecords[index];
    record.cleanup = result;
    if (result.result !== "verified"
      || result.tab?.reused !== true
      || result.tab?.id !== record.retained.tab.id
      || result.cleanup?.closed !== true) {
      throw new CompanionError("task_tab_reuse_cleanup_not_verified", `Lane ${record.lane} did not reuse and close its exact task tab`);
    }
    report.lanes.push({
      lane: record.lane,
      taskId: record.taskId,
      tabId: result.tab.id,
      groupId: result.tab.groupId,
      created: true,
      reused: true,
      visualMutationDispatched: record.retained.external_action_executed === true,
      uploadVerified: record.retained.actions?.some((action) => action.method === "page.upload") === true
        && record.retained.actions?.some((action) => action.method === "page.waitFor" && action.result?.ok === true) === true,
      semanticInputStrategy: record.retained.actions?.find((action) => action.method === "page.type" && action.params?.locator?.testId === "canary-semantic-input")?.result?.inputStrategy ?? null,
      physicalInputStrategy: record.retained.actions?.filter((action) => action.method === "page.type")[1]?.result?.inputStrategy ?? null,
      physicalTrustedInput: record.retained.actions?.filter((action) => action.method === "page.type")[1]?.result?.physical?.trustedInput === true,
      cleanupClosed: true,
    });
  });
  report.parallelReadback = {
    createElapsedMs,
    reuseElapsedMs,
    distinctTabIds: [...new Set(created.map((result) => result.tab.id))],
    maxInFlight: report.metrics.maxInFlight,
    foregroundLaneRequests: report.metrics.foregroundLaneRequests,
    queueWaitMs: report.metrics.queueWaitMs,
    timeoutCount: report.metrics.timeoutCount,
    targetMismatchCount: report.metrics.targetMismatchCount,
  };
  report.result = "verified";
} catch (error) {
  terminalError = error;
  report.result = "blocked";
  report.exactBlocker = normalizeError(error);
  report.failureStep = currentStep;
} finally {
  try {
    await cleanupFailedCanaryTabs();
  } catch (error) {
    report.cleanup.recoveryError = normalizeError(error);
  }
  for (const record of [...laneRecords].reverse()) {
    const unknown = record.cleanup?.result === "unknown_effect" || record.retained?.result === "unknown_effect";
    if (record.retained?.tab?.id && record.cleanup?.cleanup?.closed !== true && !unknown) {
      try {
        const cleanup = await transaction(record, "final-cleanup", { keepTaskTab: false });
        report.cleanup.tabs.push({ tabId: record.retained.tab.id, closed: cleanup.cleanup?.closed === true });
      } catch (error) {
        report.cleanup.tabs.push({ tabId: record.retained.tab.id, closed: false, error: normalizeError(error) });
      }
    } else if (record.retained?.tab?.id) {
      report.cleanup.tabs.push({ tabId: record.retained.tab.id, closed: record.cleanup?.cleanup?.closed === true, unknownEffect: unknown });
    }
  }
  for (const record of [...laneRecords].reverse()) {
    try {
      const result = await canaryRequest("session.close", { sessionId: record.session.sessionId });
      report.cleanup.sessions.push({ sessionId: record.session.sessionId, closed: result.closed === true });
    } catch (error) {
      report.cleanup.sessions.push({ sessionId: record.session.sessionId, closed: false, error: normalizeError(error) });
    }
  }
  // Retry discovery after terminal session close. If a request timed out just
  // after tabs.create, the first cleanup pass may have observed the session as
  // still live; the second pass can safely close only ownerless pre-effect
  // tabs whose task has no pending/tombstoned operation.
  try {
    await cleanupFailedCanaryTabs();
  } catch (error) {
    report.cleanup.recoveryAfterSessionCloseError = normalizeError(error);
  }
  report.cleanup.finalStatus = await canaryRequest("status.get").catch((error) => ({ error: normalizeError(error) }));
  const laneMetrics = Array.isArray(report.cleanup.finalStatus?.targetLaneMetrics)
    ? report.cleanup.finalStatus.targetLaneMetrics
    : [];
  report.metrics.brokerTargetLaneMetrics = laneMetrics;
  for (const lane of laneMetrics) {
    if (Number.isFinite(Number(lane.queueWaitMsTotal))) report.metrics.queueWaitMs.push(Number(lane.queueWaitMsTotal));
  }
  report.metrics.queueWaitMsMax = report.metrics.queueWaitMs.length > 0
    ? Math.max(...report.metrics.queueWaitMs)
    : 0;
  report.currentStep = currentStep;
  report.completedAt = new Date().toISOString();
  client.close();
  server.closeAllConnections();
  await new Promise((resolvePromise) => server.close(resolvePromise));
  await rm(uploadDirectory, { recursive: true, force: true });
  await mkdir(outputDir, { recursive: true });
  await writeFile(outputPath, `${JSON.stringify(report, null, 2)}\n`, { mode: 0o600 });
}

process.stdout.write(`${JSON.stringify({ outputPath, ...report }, null, 2)}\n`);
if (terminalError) process.exitCode = 1;
