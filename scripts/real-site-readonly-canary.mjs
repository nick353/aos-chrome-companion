#!/usr/bin/env node
/**
 * Opt-in real-site Companion canary.  It only inspects an already
 * Companion-owned task tab; it never adopts a user tab, submits a form,
 * downloads a file, solves a challenge, or changes page state.
 */
import { mkdir, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { BrokerClient } from "../src/client/broker-client.mjs";
import { normalizeError } from "../src/shared/errors.mjs";
import { createId } from "../src/shared/ids.mjs";

const urlArg = process.argv.find((value) => value.startsWith("--url="))?.slice(6);
const taskId = process.argv.find((value) => value.startsWith("--task-id="))?.slice(10) ?? process.env.CODEX_THREAD_ID ?? process.env.CODEX_SESSION_ID;
const tabIdArg = process.argv.find((value) => value.startsWith("--tab-id="))?.slice(9);

function selectOwnedCanaryTarget(owned, expected, explicitTabId) {
  const matching = owned.filter(tab => {
    if (explicitTabId !== undefined && tab.tabId !== Number(explicitTabId)) return false;
    try { return new URL(tab.targetIdentity?.origin).origin === expected.origin; } catch { return false; }
  });
  if (matching.length === 0) throw new Error("real_site_canary_matching_owned_tab_required");
  if (matching.length !== 1) throw new Error("real_site_canary_exact_tab_id_required");
  return matching[0];
}
const report = { schema: "aos.chrome_companion.real_site_readonly_canary.v1", runId: createId("canary"), taskId, startedAt: new Date().toISOString(), result: "blocked", url: urlArg ?? null, exactBlocker: null, readback: null };
const outputDir = resolve("outputs");
await mkdir(outputDir, { recursive: true });
const outputPath = join(outputDir, `real-site-readonly-canary-${report.startedAt.replace(/[:.]/g, "-")}.json`);
let client;
let session;
let lease;
try {
  if (!urlArg) throw new Error("real_site_canary_url_required");
  if (!taskId) throw new Error("real_site_canary_current_task_id_required");
  const ambientTaskId = process.env.CODEX_THREAD_ID ?? process.env.CODEX_SESSION_ID;
  if (ambientTaskId && ambientTaskId !== taskId) throw new Error("real_site_canary_task_identity_mismatch");
  const expected = new URL(urlArg);
  if (!new Set(["http:", "https:"]).has(expected.protocol)) throw new Error("real_site_canary_http_url_required");
  client = await BrokerClient.connect();
  const status = await client.request("status.get", {}, { timeoutMs: 5_000 });
  const profile = status.profiles?.find((candidate) => candidate.connected);
  if (!profile || status.profiles.filter((candidate) => candidate.connected).length !== 1) throw new Error("real_site_canary_profile_not_ready");
  const owned = (status.taskTabs ?? []).filter((tab) => tab.taskId === taskId && tab.profileInstanceId === profile.profileInstanceId && tab.generation === profile.generation);
  if (owned.length === 0) throw new Error("real_site_canary_requires_existing_owned_tab");
  const candidate = selectOwnedCanaryTarget(owned, expected, tabIdArg);
  session = await client.request("session.open", { taskId, label: "Real-site read-only canary", profileInstanceId: profile.profileInstanceId });
  lease = await client.request("lease.acquire", { sessionId: session.sessionId, tabId: candidate.tabId });
  const liveTab = await client.request("operation.execute", { sessionId: session.sessionId, leaseId: lease.leaseId, method: "tabs.get", params: { tabId: candidate.tabId } });
  if (new URL(liveTab.url).href !== expected.href) throw new Error("real_site_canary_live_url_mismatch");
  const snapshot = await client.request("operation.execute", { sessionId: session.sessionId, leaseId: lease.leaseId, method: "page.snapshot", params: { tabId: candidate.tabId, maxTextChars: 30_000 } }, { timeoutMs: 30_000 });
  const captcha = await client.request("operation.execute", { sessionId: session.sessionId, leaseId: lease.leaseId, method: "page.inspectCaptcha", params: { tabId: candidate.tabId } }, { timeoutMs: 15_000 });
  report.readback = { profileInstanceId: profile.profileInstanceId, generation: profile.generation, tabId: candidate.tabId, url: snapshot.url ?? null, pageInstanceId: snapshot.pageInstanceId ?? null, semanticEmpty: snapshot.semanticEmpty === true, visibleCaptchaWidget: captcha.visibleWidget === true };
  if (new URL(snapshot.url).href !== expected.href) throw new Error("real_site_canary_snapshot_url_changed");
  if (captcha.visibleWidget === true) {
    report.exactBlocker = { code: "visible_captcha_widget_user_required", user_action_required: true };
  } else {
    report.result = "verified_read_only";
  }
} catch (error) {
  report.exactBlocker = normalizeError(error);
} finally {
  const cleanupErrors = [];
  if (lease && session) await client?.request("lease.release", { leaseId: lease.leaseId }).catch(error => cleanupErrors.push(normalizeError(error)));
  if (session) await client?.request("session.close", { sessionId: session.sessionId, taskTerminal: false }).catch(error => cleanupErrors.push(normalizeError(error)));
  report.cleanup = { leaseReleased: Boolean(lease) && cleanupErrors.length === 0, sessionClosed: Boolean(session) && cleanupErrors.length === 0, errors: cleanupErrors };
  if (cleanupErrors.length) { report.result = "blocked"; report.exactBlocker ??= { code: "real_site_canary_cleanup_failed" }; }
  client?.close();
  report.finishedAt = new Date().toISOString();
  await writeFile(outputPath, `${JSON.stringify(report, null, 2)}\n`, { mode: 0o600 });
  process.stdout.write(`${outputPath}\n`);
}
if (report.result !== "verified_read_only") process.exitCode = 1;
