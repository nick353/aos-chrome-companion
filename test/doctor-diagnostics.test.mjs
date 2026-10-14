import assert from "node:assert/strict";
import { lstat, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createServer } from "node:net";
import test from "node:test";
import { collectDoctorDiagnostics, evaluateDoctorReadiness, formatDoctorText, inspectSetupLock } from "../src/shared/doctor-diagnostics.mjs";
import { DEFAULT_COMPANION_EXTENSION_ID, detectTwoExtensionProfile, OFFICIAL_CHROME_EXTENSION_IDS } from "../src/setup/auto-setup.mjs";
import { OPERATION_SCHEMA, OPERATION_SCHEMA_DIGEST, OPERATION_SCHEMA_VERSION } from "../src/shared/constants.mjs";
import { createRuntimeAttestation } from "../src/shared/runtime-attestation.mjs";

async function securePreferences(root, profile, settings) {
  const path = join(root, profile, "Secure Preferences");
  await mkdir(join(root, profile), { recursive: true });
  await writeFile(path, JSON.stringify({ extensions: { settings } }));
}

test("doctor owner diagnostics are bounded and distinguish dead, live, EPERM and malformed", async () => {
  const root = await mkdtemp(join(tmpdir(), "aos-doctor-owner-"));
  const path = join(root, "setup.lock");
  try {
    await writeFile(path, JSON.stringify({ schema: "companion_lock.v1", pid: 123, token: "12345678-1234-1234-1234-123456789abc", secret: "must-not-leak" }));
    for (const [code, expected] of [[null, "live"], ["ESRCH", "dead"], ["EPERM", "unknown"]]) {
      const result = await inspectSetupLock(path, { probeOwner: () => { if (code) throw Object.assign(new Error(code), { code }); } });
      assert.equal(result.ownerState, expected);
      assert.equal(result.ownerPid, 123);
      assert.doesNotMatch(JSON.stringify(result), /must-not-leak|12345678-1234/u);
    }
    await writeFile(path, '{"pid":123,"token":"malformed"}');
    assert.equal((await inspectSetupLock(path)).ownerState, "unknown");
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("doctor dates receipts without inventing invocation or current-chat catalog verification", async () => {
  const root = await mkdtemp(join(tmpdir(), "aos-doctor-age-"));
  try {
    await writeFile(join(root, "setup-state.json"), JSON.stringify({ checked_at: "2026-10-01T00:00:00Z", setup_complete: true, integration_ready: true, exact_blockers: [] }));
    await writeFile(join(root, "state.json"), JSON.stringify({ operations: [{ state: "dispatched", binding: { method: "page.click" } }] }));
    const report = await collectDoctorDiagnostics({ dataDir: root, statePath: join(root, "state.json"), sourceRoot: root, installedRoot: root, chromeUserDataDir: join(root, "chrome"), brokerProcesses: [],
      now: Date.parse("2026-10-02T00:00:00Z"), status: { reconciliationPendingActiveCount: 0, profiles: [] } });
    assert.equal(report.autoSetup.receipt.ageMs, 86_400_000);
    assert.equal(report.autoSetup.receipt.currentInvocationVerified, false);
    assert.equal(report.autoSetup.receipt.invocationLiveness, "unknown");
    assert.equal(report.exposure.currentChatCatalog.state, "unknown");
    assert.equal(report.exposure.currentChatCatalog.nextAction.foreignRestartAllowed, false);
    const historical = report.maintenance.find((item) => item.code === "reconciliation_backlog");
    assert.equal(historical.severity, "medium");
    assert.equal(historical.activeState, "clear");
    const localReady = { ...report, result: "ok", blockers: [] };
    assert.equal(evaluateDoctorReadiness(localReady, { strict: true }).strict_ready, true);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("doctor current pending sync overrides a prior ready setup receipt without changing connectivity", async () => {
  const root = await mkdtemp(join(tmpdir(), "aos-doctor-pending-sync-"));
  try {
    await writeFile(join(root, "setup-state.json"), JSON.stringify({ setup_complete: true, companion_ready: true, integration_ready: true, exact_blockers: [] }));
    await writeFile(join(root, "control-plane-sync-receipt.json"), JSON.stringify({ result: "applied_pending_refresh", artifactsStaged: true,
      exactBlockers: [], extensionRefresh: { result: "deferred", exactBlocker: "extension_reload_logical_sessions_active" } }));
    const report = await collectDoctorDiagnostics({ dataDir: root, socketPath: join(root, "broker.sock"), statePath: join(root, "state.json"),
      chromeUserDataDir: join(root, "chrome"), sourceRoot: root, installedRoot: root, brokerProcesses: [],
      status: { expectedBuildId: "dev-local", profiles: [{ profileInstanceId: "p1", connected: true, buildId: "dev-local" }] } });
    assert.equal(report.autoSetup.receipt.integrationReady, false);
    assert.equal(report.autoSetup.controlPlaneSync.artifactStaged, true);
    assert.equal(report.autoSetup.controlPlaneSync.runtimeLoaded, false);
    assert.ok(evaluateDoctorReadiness(report, { strict: true }).strict_blockers.includes("extension_reload_logical_sessions_active"));
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("doctor clears dated refresh pending only with fresh matching artifact/runtime proof and preserves integration errors", async () => {
  const root = await mkdtemp(join(tmpdir(), "aos-doctor-reflected-refresh-"));
  try {
    await mkdir(join(root, "src", "shared"), { recursive: true }); await mkdir(join(root, "extension"));
    await writeFile(join(root, "src", "shared", "build-info.mjs"), 'export const INSTALL_BUILD_ID = "installed";\n');
    await writeFile(join(root, "extension", "build-info.js"), 'export const INSTALL_BUILD_ID = "installed";\n');
    await writeFile(join(root, "extension", "operation-schema.generated.json"), JSON.stringify({ schema: OPERATION_SCHEMA, version: OPERATION_SCHEMA_VERSION, schemaDigest: OPERATION_SCHEMA_DIGEST }));
    const pending = { result: "applied_pending_refresh", artifactsStaged: true, exactBlockers: ["extension_reload_logical_sessions_active"],
      extensionRefresh: { result: "deferred", exactBlocker: "extension_reload_logical_sessions_active" } };
    await writeFile(join(root, "control-plane-sync-receipt.json"), JSON.stringify(pending));
    const setup = { setup_complete: true, companion_ready: true, integration_ready: true, exact_blockers: ["extension_reload_logical_sessions_active"] };
    await writeFile(join(root, "setup-state.json"), JSON.stringify(setup));
    const status = { expectedBuildId: "installed", profiles: [{ profileInstanceId: "p1", connected: true, buildId: "installed", generation: "fresh",
      operationSchema: OPERATION_SCHEMA, operationSchemaVersion: OPERATION_SCHEMA_VERSION, operationSchemaDigest: OPERATION_SCHEMA_DIGEST, buildProvenanceMismatches: [] }],
      runtimeAttestation: createRuntimeAttestation({ buildId: "installed", operationSchemaDigest: OPERATION_SCHEMA_DIGEST }) };
    const options = { dataDir: root, socketPath: join(root, "broker.sock"), statePath: join(root, "state.json"), chromeUserDataDir: join(root, "chrome"),
      sourceRoot: root, installedRoot: root, brokerProcesses: [], status };
    const report = await collectDoctorDiagnostics(options);
    assert.equal(report.autoSetup.controlPlaneSync.staleRefreshReconciled, true);
    assert.equal(report.autoSetup.controlPlaneSync.runtimeLoaded, true);
    assert.equal(report.autoSetup.receipt.integrationReady, true); assert.deepEqual(report.autoSetup.receipt.exactBlockers, []);
    assert.equal(report.autoSetup.mismatches.includes("receipt_has_exact_blockers"),false);
    assert.equal(JSON.parse(await readFile(join(root, "control-plane-sync-receipt.json"), "utf8")).result, "applied_pending_refresh");
    await writeFile(join(root, "setup-state.json"), JSON.stringify({ ...setup, integration_ready: false, exact_blockers: ["extension_reload_logical_sessions_active", "broker_auth_failed"] }));
    const auth = await collectDoctorDiagnostics(options);
    assert.equal(auth.autoSetup.receipt.integrationReady, false); assert.deepEqual(auth.autoSetup.receipt.exactBlockers, ["broker_auth_failed"]);
    assert.equal(auth.autoSetup.mismatches.includes("receipt_has_exact_blockers"),true);
    await writeFile(join(root,"setup-state.json"),JSON.stringify({...setup,exact_blockers:["broker_auth_failed"]}));
    assert.equal((await collectDoctorDiagnostics(options)).autoSetup.receipt.integrationReady,false);
    assert.equal((await collectDoctorDiagnostics({ ...options, status: { ...status, expectedBuildId: "old" } })).autoSetup.controlPlaneSync.pendingRefresh, true);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("doctor does not expose persisted ready while a work lock or abandoned guard remains", async () => {
  const root = await mkdtemp(join(tmpdir(), "aos-doctor-current-lock-"));
  try {
    const previous = { setup_complete: true, companion_ready: true, integration_ready: true, exact_blockers: [] };
    await writeFile(join(root, "setup-state.json"), JSON.stringify(previous));
    for (const name of ["setup.lock", "setup.lock.guard", "control-plane-sync.lock", "control-plane-sync.lock.guard"]) {
      if (name.endsWith("guard")) await mkdir(join(root, name));
      else await writeFile(join(root, name), `${process.pid}\n`);
      const report = await collectDoctorDiagnostics({ dataDir: root, socketPath: join(root, "broker.sock"), statePath: join(root, "state.json"),
        chromeUserDataDir: join(root, "chrome"), sourceRoot: root, installedRoot: root, brokerProcesses: [],
        status: { expectedBuildId: "dev-local", profiles: [{ profileInstanceId: "p1", connected: true, buildId: "dev-local" }] } });
      assert.equal(report.autoSetup.receipt.integrationReady, false);
      assert.equal(report.autoSetup.receipt.setupComplete, false);
      const blocker = name.endsWith("guard") ? "companion_lock_guard_legacy_or_uncertain" : name.startsWith("setup") ? "auto_setup_convergence_in_progress" : "control_plane_sync_in_progress";
      assert.ok(evaluateDoctorReadiness(report, { strict: true }).strict_blockers.includes(blocker));
      assert.equal(report.autoSetup.locks.find((lock) => lock.path === join(root, name)).exists, true);
      await rm(join(root, name), { recursive: true });
    }
    assert.equal(await readFile(join(root, "setup-state.json"), "utf8"), JSON.stringify(previous));
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("doctor reports exact dead/uncertain/v2 recovery boundaries instead of forever convergence", async () => {
  const root = await mkdtemp(join(tmpdir(), "aos-doctor-lock-boundary-"));
  try {
    const work = join(root,"setup.lock"), coordinatorPath=work+".coordinator";
    await writeFile(coordinatorPath,"",{mode:0o600}); const stat=await lstat(coordinatorPath);
    const coordinator={path:coordinatorPath,dev:String(stat.dev),ino:String(stat.ino)};
    const deadOwner={schema:"companion_lock.v2",pid:123,token:"12345678-1234-1234-1234-123456789abc",acquireId:"22345678-1234-1234-1234-123456789abc",coordinator};
    const options={dataDir:root,socketPath:join(root,"broker.sock"),statePath:join(root,"state.json"),chromeUserDataDir:join(root,"chrome"),
      sourceRoot:root,installedRoot:root,brokerProcesses:[],status:{profiles:[]},probeOwner:()=>{throw Object.assign(Error("dead"),{code:"ESRCH"});}};
    for (const [bytes,blocker] of [["123\n","companion_legacy_lock_maintenance_required"],["malformed","companion_lock_owner_uncertain"],
      [JSON.stringify(deadOwner),"companion_lock_dead_v2_recovery_available"],
      [JSON.stringify({...deadOwner,coordinator:{...coordinator,ino:"0"}}),"companion_lock_coordinator_identity_changed"]]) {
      await writeFile(work,bytes);
      const report=await collectDoctorDiagnostics(options);
      assert.equal(report.autoSetup.receipt.exactBlockers[0],blocker);
      assert.equal(report.autoSetup.receipt.exactBlockers.includes("auto_setup_convergence_in_progress"),false);
    }
    await rm(work);
    await writeFile(work+".guard.v2",JSON.stringify({schema:"companion_lock_guard.v2",pid:123,workPid:456,token:deadOwner.token,acquireId:deadOwner.acquireId,transactionId:deadOwner.acquireId,coordinator}));
    const report=await collectDoctorDiagnostics(options);
    assert.equal(report.autoSetup.receipt.exactBlockers[0],"companion_lock_dead_v2_recovery_available");
    assert.equal(report.autoSetup.locks.find(lock=>lock.path===work+".guard.v2").coordinatorVerified,true);
  } finally {await rm(root,{recursive:true,force:true});}
});

test("strict readiness requires an existing integrated setup without exact blockers", () => {
  const cases = [
    { receipt: { exists: true, integrationReady: true, exactBlockers: [] }, ready: true, blockers: [] },
    { receipt: { exists: true, integrationReady: false, exactBlockers: [] }, ready: false, blockers: ["integration_not_ready"] },
    { receipt: { exists: true, exactBlockers: [] }, ready: false, blockers: ["integration_not_ready"] },
    { receipt: { exists: false, integrationReady: true, exactBlockers: [] }, ready: false, blockers: ["setup_receipt_missing"] },
    { receipt: undefined, ready: false, blockers: ["setup_receipt_missing", "integration_not_ready"] },
    { receipt: { exists: true, integrationReady: true, exactBlockers: ["spawn old ChatGPT codex ENOENT"] }, ready: false, blockers: ["spawn old ChatGPT codex ENOENT"] },
    { receipt: { exists: true, integrationReady: false, exactBlockers: ["spawn old ChatGPT codex ENOENT"] }, ready: false, blockers: ["integration_not_ready", "spawn old ChatGPT codex ENOENT"] },
  ];
  for (const { receipt, ready, blockers } of cases) {
    const report = { result: "ok", blockers: [], maintenance: [], autoSetup: { receipt } };
    assert.deepEqual(evaluateDoctorReadiness(report, { strict: true }), { strict_ready: ready, strict_blockers: blockers, exitCode: ready ? 0 : 1 });
    assert.equal(evaluateDoctorReadiness(report).exitCode, 0);
    assert.equal(report.result, "ok");
  }
});

test("strict readiness preserves connectivity and high maintenance requirements", () => {
  const report = {
    result: "ok", blockers: [],
    maintenance: [{ code: "active_logical_sessions" }, { code: "terminal_cleanup_pending", severity: "medium" }],
    autoSetup: { receipt: { exists: true, integrationReady: true, exactBlockers: [] } },
  };
  assert.equal(evaluateDoctorReadiness(report, { strict: true }).strict_ready, true);
  report.maintenance.push({ code: "source_install_control_plane_drift", severity: "high" });
  assert.deepEqual(evaluateDoctorReadiness(report, { strict: true }), {
    strict_ready: false, strict_blockers: ["source_install_control_plane_drift"], exitCode: 1,
  });
  assert.equal(evaluateDoctorReadiness(report).exitCode, 0);
  report.maintenance = [];
  for (const result of ["degraded", "unavailable"]) {
    report.result = result;
    report.blockers = [{ code: "broker_status_timeout" }];
    assert.deepEqual(evaluateDoctorReadiness(report, { strict: true }), {
      strict_ready: false, strict_blockers: ["broker_status_timeout"], exitCode: 1,
    });
    assert.equal(evaluateDoctorReadiness(report).exitCode, 1);
  }
});

test("healthy connectivity still reports failed integration and its exact blocker", async () => {
  const root = await mkdtemp(join(tmpdir(), "aos-doctor-integration-"));
  const socketPath = join(root, "broker.sock");
  const server = createServer();
  try {
    await new Promise((resolve, reject) => {
      server.once("error", reject);
      server.listen(socketPath, resolve);
    });
    await writeFile(join(root, "setup-state.json"), JSON.stringify({
      integration_ready: false, exact_blockers: ["spawn old ChatGPT codex ENOENT"],
    }));
    const report = await collectDoctorDiagnostics({
      dataDir: root, socketPath, statePath: join(root, "state.json"),
      chromeUserDataDir: join(root, "chrome"), sourceRoot: root, installedRoot: root,
      brokerProcesses: [], status: {
        expectedBuildId: "dev-local",
        profiles: [{ profileInstanceId: "p1", connected: true, buildId: "dev-local", operationSchema: OPERATION_SCHEMA, operationSchemaDigest: OPERATION_SCHEMA_DIGEST, operationSchemaVersion: OPERATION_SCHEMA_VERSION }],
      },
    });
    assert.equal(report.result, "ok");
    assert.equal(report.autoSetup.receipt.exists, true);
    assert.equal(report.autoSetup.receipt.integrationReady, false);
    assert.deepEqual(evaluateDoctorReadiness(report, { strict: true }), {
      strict_ready: false,
      strict_blockers: ["integration_not_ready", "spawn old ChatGPT codex ENOENT"],
      exitCode: 1,
    });
    assert.equal(evaluateDoctorReadiness(report).exitCode, 0);
    const text = formatDoctorText({ ...report, ...evaluateDoctorReadiness(report, { strict: true }) });
    assert.match(text, /integration ready: false/u);
    assert.match(text, /setup receipt: present/u);
    assert.match(text, /integration blockers:\n- spawn old ChatGPT codex ENOENT/u);
    assert.match(text, /strict ready: false/u);
  } finally {
    if (server.listening) await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
    await rm(root, { recursive: true, force: true });
  }
});

test("detects Companion installation independently when no profile has both extensions", async () => {
  const root = await mkdtemp(join(tmpdir(), "aos-doctor-profile-"));
  try {
    await securePreferences(root, "Profile 1", { [DEFAULT_COMPANION_EXTENSION_ID]: { path: "/companion" } });
    await securePreferences(root, "Profile 2", { [OFFICIAL_CHROME_EXTENSION_IDS[0]]: { path: "/official" } });
    const result = await detectTwoExtensionProfile({ chromeUserDataDir: root });
    assert.equal(result.selected, null);
    assert.equal(result.selectedCompanion?.directory, "Profile 1");
    assert.deepEqual(result.common, []);
    assert.deepEqual(result.installed, {
      official: true,
      companion: true,
      officialProfiles: ["Profile 2"],
      companionProfiles: ["Profile 1"],
    });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("doctor returns a report when broker status times out", async () => {
  const root = await mkdtemp(join(tmpdir(), "aos-doctor-timeout-"));
  try {
    const report = await collectDoctorDiagnostics({
      dataDir: join(root, "data"),
      socketPath: join(root, "missing.sock"),
      statePath: join(root, "state.json"),
      chromeUserDataDir: join(root, "chrome"),
      sourceRoot: root,
      installedRoot: join(root, "installed"),
      brokerProcesses: [],
      status: null,
      statusError: "broker_status_timeout",
    });
    assert.equal(report.readOnly, true);
    assert.equal(report.broker.statusAvailable, false);
    assert.equal(report.broker.statusError, "broker_status_timeout");
    assert.ok(report.blockers.some(({ code }) => code === "broker_status_timeout"));
    assert.equal(report.live, null);
    assert.match(formatDoctorText(report), /integration ready: false\nsetup receipt: missing/u);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("uses broker readback for runtime checks and keeps active usage in maintenance", async () => {
  const root = await mkdtemp(join(tmpdir(), "aos-doctor-runtime-"));
  try {
    const report = await collectDoctorDiagnostics({
      dataDir: root,
      socketPath: join(root, "broker.sock"),
      statePath: join(root, "state.json"),
      chromeUserDataDir: join(root, "chrome"),
      sourceRoot: root,
      installedRoot: join(root, "installed"),
      brokerProcesses: [],
      status: {
        expectedBuildId: "expected-build",
        profiles: [{ profileInstanceId: "p1", connected: true, buildId: "wrong-build" }],
        logicalSessions: [{ sessionId: "s1", taskId: "task-1" }],
        exactTabLeases: [{ leaseId: "l1", sessionId: "s1", taskId: "task-1" }],
      },
    });
    assert.equal(report.buildSchema.runtime.brokerExpectedBuildId, "expected-build");
    assert.deepEqual(report.buildSchema.runtime.connectedProfileMismatches, ["p1"]);
    assert.ok(report.blockers.some(({ code }) => code === "build_or_schema_mismatch"));
    assert.equal(report.blockers.some(({ code }) => code === "active_logical_sessions"), false);
    assert.equal(report.blockers.some(({ code }) => code === "active_tab_leases"), false);
    assert.deepEqual(report.maintenance.map(({ code }) => code), ["active_logical_sessions", "active_tab_leases"]);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("does not treat intentional dev-local install stamping as identity drift", async () => {
  const root = await mkdtemp(join(tmpdir(), "aos-doctor-drift-"));
  try {
    const installed = join(root, "installed");
    await mkdir(join(root, "src", "shared"), { recursive: true });
    await mkdir(join(installed, "src", "shared"), { recursive: true });
    await writeFile(join(root, "src", "shared", "build-info.mjs"), 'export const INSTALL_BUILD_ID = "dev-local";\n');
    await writeFile(join(installed, "src", "shared", "build-info.mjs"), 'export const INSTALL_BUILD_ID = "installed";\n');
    const report = await collectDoctorDiagnostics({
      dataDir: root,
      socketPath: join(root, "broker.sock"),
      statePath: join(root, "state.json"),
      chromeUserDataDir: join(root, "chrome"),
      sourceRoot: root,
      installedRoot: installed,
      brokerProcesses: [],
      status: {
        expectedBuildId: "dev-local",
        profiles: [{ profileInstanceId: "p1", connected: true, buildId: "dev-local", operationSchema: OPERATION_SCHEMA, operationSchemaDigest: OPERATION_SCHEMA_DIGEST, operationSchemaVersion: OPERATION_SCHEMA_VERSION }],
      },
    });
    assert.equal(report.buildSchema.sourceDrift, false);
    assert.equal(report.buildSchema.installationIdentityDrift, false);
    assert.equal(report.buildSchema.runtimeMismatch, false);
    assert.equal(report.blockers.some(({ code }) => code === "build_or_schema_mismatch"), false);
    assert.equal(report.maintenance.some(({ code }) => code === "source_install_control_plane_drift"), false);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("detects real control-plane file drift independently of install identity", async () => {
  const root = await mkdtemp(join(tmpdir(), "aos-doctor-control-plane-drift-"));
  try {
    const installed = join(root, "installed");
    await mkdir(join(root, "src", "shared"), { recursive: true });
    await mkdir(join(installed, "src", "shared"), { recursive: true });
    await writeFile(join(root, "src", "shared", "helper.mjs"), "export const value = 2;\n");
    await writeFile(join(installed, "src", "shared", "helper.mjs"), "export const value = 1;\n");
    const report = await collectDoctorDiagnostics({
      dataDir: root,
      socketPath: join(root, "broker.sock"),
      statePath: join(root, "state.json"),
      chromeUserDataDir: join(root, "chrome"),
      sourceRoot: root,
      installedRoot: installed,
      brokerProcesses: [],
      status: { expectedBuildId: "dev-local", profiles: [{ profileInstanceId: "p1", connected: true, buildId: "dev-local" }] },
    });
    assert.equal(report.buildSchema.sourceDrift, true);
    assert.deepEqual(report.buildSchema.controlPlaneDrift, ["src/shared/helper.mjs"]);
    assert.ok(report.maintenance.some(({ code }) => code === "source_install_control_plane_drift"));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("surfaces reconciliation, terminal cleanup, and large-ledger actions", async () => {
  const root = await mkdtemp(join(tmpdir(), "aos-doctor-maintenance-"));
  try {
    const report = await collectDoctorDiagnostics({
      dataDir: root, socketPath: join(root, "broker.sock"), statePath: join(root, "state.json"),
      chromeUserDataDir: join(root, "chrome"), sourceRoot: root, installedRoot: join(root, "installed"),
      brokerProcesses: [], status: {
        expectedBuildId: "dev-local", profiles: [{ profileInstanceId: "p1", connected: true, buildId: "dev-local" }],
        terminalCleanupPendingTaskTabCount: 1, operationLedgerCount: 10001,
      },
    });
    assert.ok(report.maintenance.some(({ code, nextAction }) => code === "terminal_cleanup_pending" && nextAction));
    assert.ok(report.maintenance.some(({ code, nextAction }) => code === "operation_ledger_large" && nextAction));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
