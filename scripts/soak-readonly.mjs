#!/usr/bin/env node
/** Status sampling by default; --mode=browser explicitly exercises a fresh
 * task-owned local fixture tab per sample, then verifies its cleanup. No page
 * mutation, foreign tab adoption, provider submission or permission change. */
import { createServer } from "node:http";
import { createHash } from "node:crypto";
import { mkdir, writeFile, rename } from "node:fs/promises";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { setTimeout as delay } from "node:timers/promises";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { BrokerClient } from "../src/client/broker-client.mjs";
import { CompanionError, normalizeError } from "../src/shared/errors.mjs";
import { createId } from "../src/shared/ids.mjs";

function parseArgs(argv) {
  const args = new Map(argv.filter(value => value.startsWith("--")).map(value => {
    const index = value.indexOf("=");
    return index < 0 ? [value.slice(2), true] : [value.slice(2, index), value.slice(index + 1)];
  }));
  const mode = args.get("mode") ?? "status";
  const durationMs = Number(args.get("duration-ms") ?? 24 * 60 * 60_000);
  const intervalMs = Number(args.get("interval-ms") ?? (mode === "browser" ? 5 * 60_000 : 60_000));
  if (!["status", "browser"].includes(mode)) throw new Error("soak_mode_invalid");
  if (!Number.isFinite(durationMs) || durationMs < 1000 || durationMs > 72 * 60 * 60_000) throw new Error("soak_duration_requires_1_second_to_72_hours");
  if (!Number.isFinite(intervalMs) || intervalMs < 1000 || intervalMs > 15 * 60_000 || Math.ceil(durationMs / intervalMs) > 10_000) throw new Error("soak_interval_invalid_or_more_than_10000_samples");
  const taskId = args.get("task-id") ?? process.env.CODEX_THREAD_ID ?? process.env.CODEX_SESSION_ID;
  const ambientTask = process.env.CODEX_THREAD_ID ?? process.env.CODEX_SESSION_ID;
  if (mode === "browser" && (typeof taskId !== "string" || !taskId)) throw new Error("soak_browser_task_identity_required");
  if (mode === "browser" && ambientTask && ambientTask !== taskId) throw new Error("soak_task_identity_mismatch");
  return { mode, durationMs, intervalMs, taskId, outputDir: resolve(args.get("output-dir") ?? "outputs"),
    appDir: resolve(args.get("app-dir") ?? fileURLToPath(new URL("../", import.meta.url))) };
}

async function statusSample() {
  const client = await BrokerClient.connect({ autoStart: false });
  try {
    const status = await client.request("status.get", {}, { timeoutMs: 5_000 });
    const connectedProfiles = status.profiles?.filter(profile => profile.connected).length ?? 0;
    return { verified: connectedProfiles > 0, connectedProfiles,
      ...(connectedProfiles ? {} : { error: { code: "soak_no_connected_profile" } }),
      logicalSessionCount: status.logicalSessionCount ?? null, exactTabLeaseCount: status.exactTabLeaseCount ?? null,
      pendingOperationCount: status.pendingOperationCount ?? null, queueCount: status.queueCount ?? null,
      ledgerPersistence: status.ledgerPersistence ?? null };
  } finally { client.close(); }
}

async function browserSample({ taskId, origin, marker, runId, outputDir, index, appDir }) {
  const transport = new StdioClientTransport({ command: process.execPath, args: [join(appDir, "src/mcp/server.mjs")],
    cwd: appDir, env: { ...process.env, CODEX_THREAD_ID: taskId }, stderr: "pipe" });
  const client = new Client({ name: "companion-readonly-soak", version: "2" });
  const sample = { verified: false, screenshotDigests: [], cleanup: null };
  let sessionId, tabId, sessionOpenAttempted = false;
  async function call(name, args = {}) {
    const raw = await client.callTool({ name, arguments: args }, undefined, { timeout: 90_000 });
    const value = raw.structuredContent?.result;
    if (raw.isError || !value) {
      let failure = value?.exact_blocker;
      if (!failure && raw.isError) {
        try { failure = JSON.parse((raw.content ?? []).find(part => part.type === "text")?.text ?? "null"); } catch { /* malformed diagnostic */ }
      }
      throw new CompanionError(typeof failure?.code === "string" ? failure.code : "soak_tool_failed",
        typeof failure?.message === "string" ? failure.message : name + " failed", { tool: name });
    }
    for (const [imageIndex, image] of (raw.content ?? []).filter(part => part.type === "image").entries()) {
      const bytes = Buffer.from(image.data, "base64");
      sample.screenshotDigests.push(createHash("sha256").update(bytes).digest("hex"));
      if (index === 0) { const path = join(outputDir, runId + "-first-" + imageIndex + ".jpg"); await writeFile(path, bytes, { mode: 0o600 }); sample.firstScreenshot = path; }
    }
    sample.outputBytes = (sample.outputBytes ?? 0) + Buffer.byteLength(JSON.stringify(raw));
    return value;
  }
  try {
    await client.connect(transport);
    const before = await call("companion_status");
    sample.runtime = { expectedBuildId: before.expectedBuildId ?? null, brokerStartedAt: before.startedAt ?? null,
      generations: (before.profiles ?? []).filter(profile => profile.connected).map(profile => profile.generation) };
    if (before.clientOwnedLogicalSessionIds?.length) throw new CompanionError("soak_existing_task_session_in_use", "The current task already has a live session");
    sessionOpenAttempted = true;
    sessionId = (await call("companion_open_session", { label: "Companion 長時間読取検証" })).sessionId;
    const value = await call("companion_authorized_transaction", { sessionId, runId,
      idempotencyKey: runId + "-sample-" + index, startUrl: origin + "/", allowedOrigins: [origin], keepTaskTab: true,
      actions: [{ method: "page.query", params: { query: marker } }] });
    tabId = value.tab?.id;
    sample.transactionResult = value.result;
    if (value.result !== "verified") sample.transactionFailure = {
      exactBlocker: value.exact_blocker ?? null, failedStep: value.failed_step ?? null,
      effectState: value.effect_state ?? null, actionProgress: value.action_progress ?? null,
      tabId: tabId ?? null, cleanup: value.cleanup ?? null,
    };
    sample.timingsMs = value.timings_ms ?? null;
    sample.operationTiming = value.operation_timing ?? null;
    sample.stepTimings = (value.actions ?? []).map(action => ({ method: action.method, timingsMs: action.timings_ms ?? null }));
    if (value.result !== "verified" || !Number.isSafeInteger(tabId) || !JSON.stringify(value.actions).includes(marker) || sample.screenshotDigests.length === 0) throw new CompanionError("soak_browser_readback_not_verified", "Browser content, screenshot, or transaction was not verified");
    sample.verified = true;
  } catch (error) { sample.error = normalizeError(error); }
  finally {
    if (sessionId) {
      try {
        const close = await call("companion_close_session", { sessionId, taskTerminal: true });
        const after = await call("companion_status");
        const closedTabs = close.cleanup_receipt?.closed ?? [];
        sample.cleanup = { closedTabs, status: close.cleanup_receipt?.status ?? null, skipped: close.cleanup_receipt?.skipped ?? [], unknownEffect: close.cleanup_receipt?.unknown_effect ?? [], exactBlocker: close.cleanup_receipt?.exact_blocker ?? null, retained: close.cleanup_receipt?.retained ?? [], ownSessions: after.clientOwnedLogicalSessionIds?.length ?? null, ownLeases: after.clientOwnedExactTabLeaseIds?.length ?? null };
        if ((tabId && !closedTabs.includes(tabId)) || sample.cleanup.retained.length || sample.cleanup.ownSessions !== 0 || sample.cleanup.ownLeases !== 0) throw new CompanionError("soak_cleanup_not_verified", "Task fixture cleanup was not verified");
      } catch (error) { sample.cleanupError = normalizeError(error); sample.verified = false; sample.stop = true; }
    } else if (sessionOpenAttempted) { sample.stop = true; sample.cleanupError = { code: "soak_session_open_receipt_missing" }; }
    await client.close().catch(() => {}); await transport.close().catch(() => {});
  }
  return sample;
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  const runId = createId("soak");
  const report = { schema: "aos.chrome_companion.readonly_soak.v2", runId, mode: options.mode,
    taskId: options.mode === "browser" ? options.taskId : null, mcpAppDir: options.mode === "browser" ? options.appDir : null, startedAt: new Date().toISOString(),
    durationMs: options.durationMs, intervalMs: options.intervalMs, result: "running", samples: [], coverage: options.mode === "browser" ? "local_fixture_open_read_visual_receipt_cleanup" : "broker_status_only" };
  await mkdir(options.outputDir, { recursive: true });
  const outputPath = join(options.outputDir, runId + ".json");
  async function checkpoint() {
    await writeFile(outputPath + ".tmp", JSON.stringify(report, null, 2) + "\n", { mode: 0o600 });
    await rename(outputPath + ".tmp", outputPath);
  }
  const abort = new AbortController();
  const stop = () => abort.abort();
  process.once("SIGINT", stop); process.once("SIGTERM", stop);
  let server, origin;
  const marker = "Companion-soak-" + runId;
  const start = performance.now();
  try {
    if (options.mode === "browser") {
      server = createServer((_request, response) => { response.writeHead(200, { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" }); response.end(`<!doctype html><meta charset="utf-8"><title>Companion read-only soak</title><style>body{font:22px system-ui;margin:60px}</style><h1>Companion 長時間読取検証</h1><p>${marker}</p><p>日本語と絵文字 👩🏽‍💻</p>`); });
      await new Promise((resolvePromise, reject) => { server.once("error", reject); server.listen(0, "127.0.0.1", resolvePromise); });
      origin = "http://127.0.0.1:" + server.address().port;
    }
    await checkpoint();
    process.stdout.write(JSON.stringify({ outputPath, result: "running", mode: options.mode, pid: process.pid }) + "\n");
    do {
      if (abort.signal.aborted) break;
      const sampledAt = performance.now();
      let sample;
      try { sample = options.mode === "browser" ? await browserSample({ ...options, origin, marker, runId, index: report.samples.length }) : await statusSample(); }
      catch (error) { sample = { verified: false, error: normalizeError(error) }; }
      report.samples.push({ capturedAt: new Date().toISOString(), ms: performance.now() - sampledAt, ...sample });
      report.elapsedMs = performance.now() - start;
      await checkpoint();
      if (sample.stop || report.elapsedMs >= options.durationMs) break;
      await delay(Math.min(options.intervalMs, options.durationMs - report.elapsedMs), undefined, { signal: abort.signal }).catch(error => { if (error.name !== "AbortError") throw error; });
    } while (performance.now() - start < options.durationMs);
    report.elapsedMs = performance.now() - start;
    report.successfulSamples = report.samples.filter(sample => sample.verified).length;
    report.failedSamples = report.samples.length - report.successfulSamples;
    report.fullDurationObserved = !abort.signal.aborted && report.elapsedMs >= options.durationMs;
    const times = report.samples.map(sample => sample.ms).sort((a, b) => a - b);
    report.latencyMs = { p50: times[Math.max(0, Math.ceil(times.length * 0.5) - 1)] ?? null, p95: times[Math.max(0, Math.ceil(times.length * 0.95) - 1)] ?? null };
    report.result = abort.signal.aborted ? "interrupted" : report.failedSamples || !report.fullDurationObserved || report.successfulSamples === 0 ? "failed" : options.mode === "browser" ? "verified_local_browser_sampling" : "verified_status_sampling";
  } catch (error) { report.result = "failed"; report.exactBlocker = normalizeError(error); }
  finally {
    if (server) { server.closeAllConnections(); await new Promise(resolvePromise => server.close(resolvePromise)); }
    process.removeListener("SIGINT", stop); process.removeListener("SIGTERM", stop);
    report.finishedAt = new Date().toISOString(); await checkpoint();
  }
  process.stdout.write(JSON.stringify({ outputPath, result: report.result, successfulSamples: report.successfulSamples, failedSamples: report.failedSamples }) + "\n");
  if (!report.result.startsWith("verified_")) process.exitCode = 1;
}

await main().catch(error => { process.stderr.write(JSON.stringify(normalizeError(error)) + "\n"); process.exitCode = 1; });
