import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { collectDoctorDiagnostics } from "../src/shared/doctor-diagnostics.mjs";
import { DEFAULT_COMPANION_EXTENSION_ID, detectTwoExtensionProfile, OFFICIAL_CHROME_EXTENSION_IDS } from "../src/setup/auto-setup.mjs";
import { OPERATION_SCHEMA, OPERATION_SCHEMA_DIGEST, OPERATION_SCHEMA_VERSION } from "../src/shared/constants.mjs";

async function securePreferences(root, profile, settings) {
  const path = join(root, profile, "Secure Preferences");
  await mkdir(join(root, profile), { recursive: true });
  await writeFile(path, JSON.stringify({ extensions: { settings } }));
}

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

test("does not treat install identity stamping as runtime source drift", async () => {
  const root = await mkdtemp(join(tmpdir(), "aos-doctor-drift-"));
  try {
    const installed = join(root, "installed");
    await mkdir(join(root, "src", "shared"), { recursive: true });
    await mkdir(join(installed, "src", "shared"), { recursive: true });
    await writeFile(join(root, "src", "shared", "build-info.mjs"), 'export const INSTALL_BUILD_ID = "source";\n');
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
    assert.equal(report.buildSchema.installationIdentityDrift, true);
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
