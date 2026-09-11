import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";
import { CompanionBroker } from "../src/broker/broker.mjs";
import { connectPeer } from "../src/client/connect.mjs";
import { ensureBrokerSecret } from "../src/shared/security.mjs";
import { INSTALL_BUILD_ID } from "../src/shared/build-info.mjs";
import { DEFAULT_CAPABILITIES, PROTOCOL_VERSION } from "../src/shared/constants.mjs";

async function run(t, { connected = false, interrupt = false } = {}) {
  const dir = await mkdtemp(join(tmpdir(), "companion-soak-test-"));
  const env = { ...process.env, AOS_CHROME_COMPANION_DATA_DIR: dir, AOS_CHROME_COMPANION_SOCKET: join(dir, "broker.sock"), AOS_CHROME_COMPANION_SECRET_FILE: join(dir, "secret"), AOS_CHROME_COMPANION_AUTO_SETUP: "0" };
  const broker = new CompanionBroker({ socketPath: env.AOS_CHROME_COMPANION_SOCKET, secret: await ensureBrokerSecret(env) });
  await broker.listen();
  let extension;
  t.after(async () => { extension?.close(); await broker.close(); await rm(dir, { recursive: true, force: true }); });
  if (connected) {
    extension = await connectPeer({ role: "extension-relay", autoStart: false, env });
    const ready = new Promise(resolvePromise => extension.onMessage(message => { if (message.kind === "extension.hello_ack") resolvePromise(); }));
    extension.send({ kind: "extension.hello", protocolVersion: PROTOCOL_VERSION, profileInstanceId: "profile-soak", extensionRuntimeId: "runtime-soak", buildId: INSTALL_BUILD_ID, capabilities: DEFAULT_CAPABILITIES });
    await ready;
  }
  const child = spawn(process.execPath, [resolve("scripts/soak-readonly.mjs"), "--mode=status", "--duration-ms=" + (interrupt ? 10_000 : 1000), "--interval-ms=1000", "--output-dir=" + dir], { env, stdio: ["ignore", "pipe", "pipe"] });
  t.after(() => { if (child.exitCode === null) child.kill("SIGKILL"); });
  let stdout = "", stderr = "", interrupted = false;
  child.stderr.on("data", chunk => { stderr += chunk; });
  child.stdout.on("data", chunk => {
    stdout += chunk;
    if (interrupt && !interrupted && stdout.includes('"running"')) { interrupted = true; child.kill("SIGTERM"); }
  });
  const code = await new Promise(resolvePromise => child.on("exit", resolvePromise));
  assert.equal(stderr, "");
  const summary = JSON.parse(stdout.trim().split("\n").at(-1));
  return { code, report: JSON.parse(await readFile(summary.outputPath, "utf8")), broker };
}

test("soak fails when samples cannot see a connected extension", { timeout: 10_000 }, async t => {
  const { code, report } = await run(t);
  assert.equal(code, 1);
  assert.equal(report.result, "failed");
  assert.ok(report.failedSamples > 0);
  assert.equal(report.samples[0].error.code, "soak_no_connected_profile");
  assert.equal(report.coverage, "broker_status_only");
});

test("healthy status sampling makes no browser or long-duration claim", { timeout: 10_000 }, async t => {
  const { code, report, broker } = await run(t, { connected: true });
  assert.equal(code, 0);
  assert.equal(report.result, "verified_status_sampling");
  assert.equal(report.durationMs, 1000);
  assert.equal(report.fullDurationObserved, true);
  assert.equal(broker.snapshot().logicalSessionCount, 0);
  assert.equal(broker.snapshot().taskTabCount, 0);
});

test("interrupted soak leaves a readable checkpoint and cannot be reported verified", { timeout: 10_000 }, async t => {
  const { code, report } = await run(t, { connected: true, interrupt: true });
  assert.equal(code, 1);
  assert.equal(report.result, "interrupted");
  assert.equal(report.fullDurationObserved, false);
  assert.ok(report.finishedAt);
});
