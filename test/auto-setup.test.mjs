import assert from "node:assert/strict";
import { chmod, mkdir, mkdtemp, readFile, realpath, rm, stat, symlink, lstat, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";
import { OPERATION_SCHEMA_DIGEST } from "../src/shared/constants.mjs";
import { createRuntimeAttestation } from "../src/shared/runtime-attestation.mjs";
import {
  AUTO_SETUP_SCHEMA,
  resolveCodexCommand,
  resolveCompanionCodexSelection,
  acquireCompanionLock,
  releaseCompanionLock,
  controlPlaneSyncReadiness,
  DEFAULT_COMPANION_EXTENSION_ID,
  OFFICIAL_CHROME_EXTENSION_IDS,
  compareControlPlaneArtifacts,
  convergeCompanionSetup,
  detectTwoExtensionProfile,
  pruneApplicationBackups,
  requestAutomaticControlPlaneSync,
  setupReceiptIsStable,
} from "../src/setup/auto-setup.mjs";

async function writeJson(path, value) {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, `${JSON.stringify(value, null, 2)}\n`);
}

test("Companion managed CLI discovery is explicit, child-only, and preserves authoritative overrides", async () => {
  const environment = { PATH: "/usr/bin:/bin", CODEX_CLI_PATH: "/stale/ChatGPT/codex" };
  const original = { ...environment };
  const executableExists = async (path) => path === "/usr/local/bin/codex" || path === "/custom/codex";
  for (const options of [{}, { managedChild: true }, { managedChild: true, provenance: "caller" }]) {
    const result = await resolveCompanionCodexSelection(environment, { ...options, executableExists });
    assert.equal(result.command, environment.CODEX_CLI_PATH);
    assert.equal(result.managedChild, false);
  }
  const managed = await resolveCompanionCodexSelection(environment, { managedChild: true,
    provenance: "companion_autosetup_wrapper", executableExists });
  assert.equal(managed.command, "/usr/local/bin/codex");
  assert.equal(managed.discardedInheritedPin, environment.CODEX_CLI_PATH);
  assert.equal(managed.provenance, "companion_autosetup_wrapper");
  for (const override of ["/custom/codex", "/invalid/user/codex"]) {
    assert.equal(await resolveCodexCommand({ ...environment, CODEX_CLI_PATH: override }, executableExists), override);
    const result = await resolveCompanionCodexSelection({ ...environment, AOS_CHROME_COMPANION_CODEX_CLI_PATH: override },
      { managedChild: true, provenance: "companion_installer_default", executableExists });
    assert.equal(result.command, override);
    assert.equal(result.explicitOverride, true);
  }
  const custom = await resolveCompanionCodexSelection({ ...environment, CODEX_CLI_PATH: "/custom/codex" },
    { managedChild: true, provenance: "companion_autosetup_wrapper", executableExists });
  assert.equal(custom.command, "/custom/codex");
  assert.equal(custom.discardedInheritedPin, null);
  assert.deepEqual(environment, original);
});

test("pending refresh preserves its primary blocker and requires fresh activation provenance", () => {
  const pending = { result: "applied_pending_refresh", artifactsStaged: true, exactBlockers: [],
    restartBoundary: { blockers: [] }, extensionRefresh: { result: "deferred", exactBlocker: "extension_reload_logical_sessions_active" } };
  assert.deepEqual(controlPlaneSyncReadiness(pending), { pendingRefresh: true, artifactStaged: true,
    runtimeLoaded: false, exactBlockers: ["extension_reload_logical_sessions_active"], exactBlocker: "extension_reload_logical_sessions_active" });
  for (const receipt of [{ result: "restarted" }, { result: "applied", statusAfter: { connectedProfileCount: 1 } },
    { result: "restarted", statusAfter: { connectedProfileCount: 1 }, extensionRefresh: { postRestartReadback: { ready: true } } }]) {
    assert.equal(controlPlaneSyncReadiness(receipt).runtimeLoaded, false);
    assert.equal(controlPlaneSyncReadiness(receipt).exactBlocker, "control_plane_activation_not_verified");
  }
  const reflected = { result: "restarted", artifactsStaged: true, exactBlockers: [], statusAfter: { connectedProfileCount: 1 },
    extensionRefresh: { result: "reflected", postRestartReadback: { ready: true, provenanceVerified: true } } };
  assert.equal(controlPlaneSyncReadiness(reflected).runtimeLoaded, true);
  assert.equal(controlPlaneSyncReadiness(reflected).pendingRefresh, false);
  assert.equal(controlPlaneSyncReadiness({ ...reflected, extensionRefresh: pending.extensionRefresh }).runtimeLoaded, false);
});

const deadOwner = () => { throw Object.assign(new Error("dead"), { code: "ESRCH" }); };

test("fresh matching artifacts and verified runtime resolve only a dated refresh boundary", () => {
  const pending = { result: "applied_pending_refresh", artifactsStaged: true, exactBlockers: ["extension_reload_logical_sessions_active"],
    extensionRefresh: { result: "deferred", exactBlocker: "extension_reload_logical_sessions_active" } };
  const profile = { connected: true, buildId: "installed", operationSchemaDigest: OPERATION_SCHEMA_DIGEST, generation: "fresh", buildProvenanceMismatches: [] };
  const liveStatus = { expectedBuildId: "installed", profiles: [profile],
    runtimeAttestation: createRuntimeAttestation({ buildId: "installed", operationSchemaDigest: OPERATION_SCHEMA_DIGEST }) };
  const proof = { liveStatus, expectedBuildId: "installed", artifactsMatch: true };
  const current = controlPlaneSyncReadiness(pending, proof);
  assert.equal(current.staleRefreshReconciled, true); assert.equal(current.pendingRefresh, false); assert.equal(current.runtimeLoaded, true);
  for (const missing of [{ artifactsMatch: false }, { expectedBuildId: "wrong" }, { liveStatus: undefined },
    { liveStatus: { ...liveStatus, profiles: [{ ...profile, buildProvenanceMismatches: ["extension_tree_sha256"] }] } },
    { liveStatus: { ...liveStatus, profiles: [{ ...profile, generation: null }] } },
    { liveStatus: { ...liveStatus, profiles: [profile, profile] } },
    { liveStatus: { ...liveStatus, runtimeAttestation: { ...liveStatus.runtimeAttestation, attestationDigest: "forged" } } }])
    assert.equal(controlPlaneSyncReadiness(pending, { ...proof, ...missing }).pendingRefresh, true);
  for (const blocker of ["broker_auth_failed", "native_host_invalid", "codex_plugin_list_failed", "profile_binding_mismatch", "integration_not_ready"])
    assert.ok(controlPlaneSyncReadiness({ ...pending, exactBlockers: [blocker] }, proof).exactBlockers.includes(blocker));
  assert.equal(controlPlaneSyncReadiness({ ...pending, result: "failed" }, proof).pendingRefresh, true);
});

test("Companion lock preserves old live, EPERM and malformed owners regardless of mtime", async () => {
  const root = await realpath(await mkdtemp(join(tmpdir(), "aos-companion-lock-live-")));
  const path = join(root, "setup.lock");
  try {
    for (const [text, probeOwner, blocker] of [[`${process.pid}\n`, () => {}, "companion_lock_owner_live_or_unverifiable"],
      ["1\n", () => { throw Object.assign(new Error("permission"), { code: "EPERM" }); }, "companion_lock_owner_live_or_unverifiable"],
      ["unknown owner\n", deadOwner, "companion_lock_owner_uncertain"]]) {
      await writeFile(path, text);
      await utimes(path, 1, 1);
      const result = await acquireCompanionLock(path, { probeOwner, legacyRolloutConfirmed: true });
      assert.equal(result.acquired, false);
      assert.equal(result.exactBlocker, blocker);
      assert.equal(await readFile(path, "utf8"), text);
    }
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("dead legacy and v1 token locks require exclusion-bound maintenance even with old rollout flag", async () => {
  const root = await realpath(await mkdtemp(join(tmpdir(), "aos-companion-lock-dead-")));
  const path = join(root, "setup.lock");
  try {
    for (const text of ["2147483647\n", JSON.stringify({ schema: "companion_lock.v1", pid: 2147483647, token: "12345678-1234-1234-1234-123456789abc" })]) {
      await writeFile(path, text);
      const blocked = await acquireCompanionLock(path, { probeOwner: deadOwner });
      assert.equal(blocked.acquired, false);
      assert.equal(blocked.exactBlocker, "companion_legacy_lock_maintenance_required");
      assert.equal(await readFile(path, "utf8"), text);
      const lease = await acquireCompanionLock(path, { probeOwner: deadOwner, legacyRolloutConfirmed: true });
      assert.equal(lease.acquired, false);
      assert.equal(lease.exactBlocker, "companion_legacy_lock_maintenance_required");
      assert.equal(await readFile(path, "utf8"), text);
    }
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("cooperative lock serializes concurrent owners and preserves replacement tokens", async () => {
  const root = await realpath(await mkdtemp(join(tmpdir(), "aos-companion-lock-concurrent-")));
  const path = join(root, "setup.lock");
  try {
    const leases = await Promise.all(Array.from({ length: 8 }, () => acquireCompanionLock(path)));
    assert.equal(leases.filter((lease) => lease.acquired).length, 1);
    const first = leases.find((lease) => lease.acquired);
    assert.equal((await releaseCompanionLock(first)).released, true);
    const second = await acquireCompanionLock(path);
    assert.equal(second.acquired, true);
    assert.notEqual(second.token, first.token);
    assert.equal((await releaseCompanionLock(first)).released, false);
    assert.equal(JSON.parse(await readFile(path, "utf8")).token, second.token);
    assert.equal((await releaseCompanionLock(second)).released, true);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("ordinary lock write failure cleans owned guard; abandoned guard is bounded and preserved", async () => {
  const root = await realpath(await mkdtemp(join(tmpdir(), "aos-companion-lock-guard-")));
  const path = join(root, "setup.lock");
  try {
    assert.equal((await acquireCompanionLock(path, { testFaultAt: "after_guard" })).exactBlocker, "companion_lock_fixture_write_failed");
    await assert.rejects(stat(`${path}.guard.v2`), { code: "ENOENT" });
    await assert.rejects(stat(path), { code: "ENOENT" });
    await mkdir(`${path}.guard`);
    const started = Date.now();
    const blocked = await acquireCompanionLock(path, { guardWaitMs: 30 });
    assert.equal(blocked.acquired, false);
    assert.equal(blocked.exactBlocker, "companion_lock_guard_legacy_or_uncertain");
    assert.ok(Date.now() - started < 1_000);
    assert.equal((await stat(`${path}.guard`)).isDirectory(), true);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("guard prepublication failure leaves no final guard; replaced owner token is preserved", async () => {
  const root = await realpath(await mkdtemp(join(tmpdir(), "aos-companion-lock-owner-")));
  const path = join(root, "setup.lock");
  try {
    assert.equal((await acquireCompanionLock(path, { testFaultAt: "guard_stage_partial" })).exactBlocker, "companion_lock_fixture_write_failed");
    await assert.rejects(stat(`${path}.guard.v2`), { code: "ENOENT" });
    const replacement = { pid: process.pid, token: "replacement-guard-owner" };
    const blocked = await acquireCompanionLock(path, { testPauseAt: "after_work", onPhase: async () => {
      await writeJson(`${path}.guard.v2`, replacement);
    } });
    assert.equal(blocked.exactBlocker, "companion_lock_marker_identity_changed");
    assert.deepEqual(JSON.parse(await readFile(`${path}.guard.v2`, "utf8")), replacement);
    assert.equal((await stat(path)).isFile(), true);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("busy setup returns current nonready and labels prior ready receipt without overwriting it", async () => {
  const root = await realpath(await mkdtemp(join(tmpdir(), "aos-companion-lock-busy-")));
  const path = join(root, "setup.lock");
  const statePath = join(root, "setup-state.json");
  try {
    const previous = { schema: AUTO_SETUP_SCHEMA, setup_complete: true, companion_ready: true, integration_ready: true };
    await writeJson(statePath, previous);
    const lease = await acquireCompanionLock(path);
    let calls = 0;
    const result = await convergeCompanionSetup({ platform: "darwin", lockPath: path, statePath,
      environment: {}, runCommand: async () => { calls += 1; throw new Error("must not dispatch"); } });
    assert.equal(result.integration_ready, false);
    assert.equal(result.setup_complete, false);
    assert.equal(result.companion_ready, false);
    assert.ok(result.exact_blockers.includes("auto_setup_convergence_in_progress"));
    assert.deepEqual(result.prior_receipt_evidence, { current: false, receipt: previous });
    assert.deepEqual(JSON.parse(await readFile(statePath, "utf8")), previous);
    assert.equal(calls, 0);
    await releaseCompanionLock(lease);
  } finally { await rm(root, { recursive: true, force: true }); }
});

async function fixture() {
  const root = await realpath(await mkdtemp(join(tmpdir(), "aos-companion-auto-setup-")));
  const homePath = join(root, "home");
  const sourceRoot = join(root, "app");
  const chromeUserDataDir = join(homePath, "Library", "Application Support", "Google", "Chrome");
  const officialExtensionId = OFFICIAL_CHROME_EXTENSION_IDS[0];
  await writeJson(join(chromeUserDataDir, "Profile 2", "Secure Preferences"), {
    extensions: {
      settings: {
        [officialExtensionId]: { path: `${officialExtensionId}/1.0.0_0`, manifest: { name: "ChatGPT" } },
        [DEFAULT_COMPANION_EXTENSION_ID]: { path: join(sourceRoot, "extension") },
      },
    },
  });
  await mkdir(join(sourceRoot, "src", "native-host"), { recursive: true });
  await writeFile(join(sourceRoot, "src", "native-host", "main.mjs"), "// fixture\n");
  await writeJson(join(sourceRoot, ".agents", "plugins", "marketplace.json"), {
    name: "aos-chrome-companion-local",
    plugins: [],
  });
  const officialExecutable = join(root, "official-host");
  await writeFile(officialExecutable, "#!/bin/sh\nexit 0\n", { mode: 0o700 });
  await chmod(officialExecutable, 0o700);
  await writeJson(join(homePath, "Library", "Application Support", "Google", "Chrome", "NativeMessagingHosts", "com.openai.codexextension.json"), {
    name: "com.openai.codexextension",
    description: "Official fixture",
    path: officialExecutable,
    type: "stdio",
    allowed_origins: [`chrome-extension://${officialExtensionId}/`],
  });
  return { root, homePath, sourceRoot, chromeUserDataDir };
}

function installedPluginList() {
  return {
    code: 0,
    stdout: JSON.stringify({
      installed: [
        { name: "chrome", marketplaceName: "openai-bundled", installed: true, enabled: true },
        { name: "aos-chrome-companion", marketplaceName: "aos-chrome-companion-local", installed: true, enabled: true },
      ],
    }),
    stderr: "",
    exactBlocker: null,
  };
}

test("fresh onboarding with a missing profile returns nonready without plugin invocation", async () => {
  const item = await fixture();
  try {
    const result = await convergeCompanionSetup({ platform: "darwin", homePath: item.homePath, sourceRoot: item.sourceRoot,
      chromeUserDataDir: join(item.root, "missing-chrome"), environment: { AOS_CHROME_COMPANION_DATA_DIR: join(item.root, "support") },
      runCommand: async () => { throw new Error("no plugin call permitted without a selected profile"); } });
    assert.equal(result.setup_complete, false);
    assert.equal(result.companion_ready, false);
    assert.equal(result.integration_ready, false);
    assert.ok(result.exact_blockers.includes("companion_chrome_extension_not_installed_in_profile"));
    assert.equal(result.profile_directory, null);
  } finally { await rm(item.root, { recursive: true, force: true }); }
});

test("onboarding plugin permission failure keeps exact blocker and never reports integrated readiness", async () => {
  const item = await fixture();
  try {
    const result = await convergeCompanionSetup({ platform: "darwin", homePath: item.homePath, sourceRoot: item.sourceRoot,
      chromeUserDataDir: item.chromeUserDataDir, environment: { AOS_CHROME_COMPANION_DATA_DIR: join(item.root, "support"), AOS_WEB_OPERATION_BACKEND_CONFIG: join(item.root, "selector.json") },
      runCommand: async () => ({ code: 1, stdout: "", stderr: "EACCES: plugin directory permission denied", exactBlocker: "EACCES: plugin directory permission denied" }) });
    assert.equal(result.integration_ready, false);
    assert.equal(result.setup_complete, false);
    assert.ok(result.exact_blockers.some((entry) => entry.includes("EACCES")));
    assert.match(result.next_action, /Codex plugin setup failed/u);
  } finally { await rm(item.root, { recursive: true, force: true }); }
});

test("managed convergence selects once in its child environment without changing parent pins", async () => {
  const item = await fixture();
  try {
    const bin = join(item.root, "bin");
    await mkdir(bin);
    const cli = join(bin, "codex");
    await writeFile(cli, "#!/bin/sh\nexit 0\n", { mode: 0o700 });
    const environment = { PATH: bin, CODEX_CLI_PATH: "/stale/ChatGPT/codex", AOS_CHROME_COMPANION_DATA_DIR: join(item.root, "support"),
      AOS_WEB_OPERATION_BACKEND_CONFIG: join(item.root, "selector.json") };
    const original = { ...environment };
    let calls = 0;
    const result = await convergeCompanionSetup({ platform: "darwin", homePath: item.homePath, sourceRoot: item.sourceRoot,
      chromeUserDataDir: item.chromeUserDataDir, environment, managedChild: true, managedChildProvenance: "companion_autosetup_wrapper",
      runCommand: async (command, args, options) => { calls += 1; assert.equal(command, cli);
        assert.equal(options.env.CODEX_CLI_PATH, cli); assert.equal(args[1], "list"); return installedPluginList(); } });
    assert.equal(result.integration_ready, true);
    assert.equal(result.components.codex_cli_selection.discardedInheritedPin, original.CODEX_CLI_PATH);
    assert.equal(calls, 1);
    assert.deepEqual(environment, original);
    calls = 0;
    const failed = await convergeCompanionSetup({ platform: "darwin", homePath: item.homePath, sourceRoot: item.sourceRoot,
      chromeUserDataDir: item.chromeUserDataDir, environment: { ...environment, AOS_CHROME_COMPANION_CODEX_CLI_PATH: "/invalid/user/codex" },
      managedChild: true, managedChildProvenance: "companion_autosetup_wrapper", runCommand: async (command) => {
        calls += 1; assert.equal(command, "/invalid/user/codex"); return { code: 1, stdout: "", stderr: "", exactBlocker: "spawn ENOENT" }; } });
    assert.equal(failed.integration_ready, false);
    assert.equal(calls, 1);
  } finally { await rm(item.root, { recursive: true, force: true }); }
});

test("native-host convergence preserves direct and custom authority without command fallback", async () => {
  const item = await fixture();
  try {
    const bin = join(item.root, "bin");
    await mkdir(bin);
    const cli = join(bin, "codex");
    await writeFile(cli, "#!/bin/sh\nexit 0\n", { mode: 0o700 });
    const environment = { PATH: bin, CODEX_CLI_PATH: "/stale/ChatGPT/codex",
      AOS_CHROME_COMPANION_DATA_DIR: join(item.root, "support"), AOS_WEB_OPERATION_BACKEND_CONFIG: join(item.root, "selector.json") };
    const cases = [
      { options: {}, command: environment.CODEX_CLI_PATH, managed: false, fail: true },
      { options: { managedChild: true }, command: environment.CODEX_CLI_PATH, managed: false, fail: true },
      { options: { managedChild: true, managedChildProvenance: "custom" }, command: environment.CODEX_CLI_PATH, managed: false, fail: true },
      { options: { managedChild: true, managedChildProvenance: "companion_native_host_wrapper" }, command: cli, managed: true },
      { options: { managedChild: true, managedChildProvenance: "companion_native_host_wrapper" },
        environment: { CODEX_CLI_PATH: cli }, command: cli, managed: true, fail: true },
      ...[cli, "/invalid/companion/codex"].map((override) => ({
        options: { managedChild: true, managedChildProvenance: "companion_native_host_wrapper" },
        environment: { AOS_CHROME_COMPANION_CODEX_CLI_PATH: override }, command: override, managed: true, fail: true,
      })),
    ];
    for (const scenario of cases) {
      const scopedEnvironment = { ...environment, ...scenario.environment };
      const original = { ...scopedEnvironment };
      let calls = 0;
      const result = await convergeCompanionSetup({ platform: "darwin", trigger: "native_host",
        homePath: item.homePath, sourceRoot: item.sourceRoot, chromeUserDataDir: item.chromeUserDataDir,
        environment: scopedEnvironment, ...scenario.options, runCommand: async (command, args, options) => {
          calls += 1;
          assert.equal(command, scenario.command);
          assert.deepEqual(args, ["plugin", "list", "--json"]);
          assert.equal(options.env.CODEX_CLI_PATH, scenario.managed ? scenario.command : original.CODEX_CLI_PATH);
          return scenario.fail ? { code: 1, stdout: "", stderr: "fixture command failed", exactBlocker: "fixture_command_failed" } : installedPluginList();
        } });
      assert.equal(calls, 1);
      assert.equal(result.integration_ready, !scenario.fail);
      assert.equal(result.components.codex_cli_selection.managedChild, scenario.managed);
      if (scenario.fail) assert.ok(result.exact_blockers.includes("fixture_command_failed"));
      assert.deepEqual(scopedEnvironment, original);
      const wrapper = await readFile(result.components.companion_native_host.wrapperPath, "utf8");
      assert.match(wrapper, /AOS_CHROME_COMPANION_MANAGED_CHILD=1 AOS_CHROME_COMPANION_MANAGED_CHILD_PROVENANCE=companion_native_host_wrapper /u);
      assert.doesNotMatch(wrapper, /CODEX_CLI_PATH=/u);
    }
  } finally { await rm(item.root, { recursive: true, force: true }); }
});

test("staged pending refresh makes setup nonready and retains the signed refresh blocker", async () => {
  const item = await fixture();
  try {
    const syncSource = join(item.root, "source");
    await mkdir(join(syncSource, "scripts"), { recursive: true });
    await writeFile(join(syncSource, "scripts", "sync-control-plane-macos.mjs"), "// mock only\n");
    const options = { platform: "darwin", homePath: item.homePath, sourceRoot: item.sourceRoot, syncSourceRoot: syncSource,
      chromeUserDataDir: item.chromeUserDataDir, environment: { AOS_CHROME_COMPANION_DATA_DIR: join(item.root, "support"),
        AOS_WEB_OPERATION_BACKEND_CONFIG: join(item.root, "selector.json") } };
    const pending = await convergeCompanionSetup({ ...options, runCommand: async (_command, args) => args[0] === "plugin"
      ? installedPluginList() : { code: 3, stdout: JSON.stringify({ result: "applied_pending_refresh", artifactsStaged: true,
        exactBlockers: [], restartBoundary: { blockers: [] }, extensionRefresh: { result: "deferred", exactBlocker: "extension_reload_logical_sessions_active" } }) } });
    assert.equal(pending.integration_ready, false);
    assert.equal(pending.companion_ready, false);
    assert.ok(pending.exact_blockers.includes("extension_reload_logical_sessions_active"));
    assert.equal(pending.components.control_plane_sync.artifactStaged, true);
    assert.equal(pending.components.control_plane_sync.runtimeLoaded, false);
    const ready = await convergeCompanionSetup({ ...options, runCommand: async (_command, args) => args[0] === "plugin"
      ? installedPluginList() : { code: 0, stdout: JSON.stringify({ result: "restarted", statusAfter: { connectedProfileCount: 1 },
        extensionRefresh: { result: "reflected", postRestartReadback: { ready: true, provenanceVerified: true } }, exactBlockers: [] }) } });
    assert.equal(ready.integration_ready, true);
    assert.equal(ready.components.control_plane_sync.runtimeLoaded, true);
  } finally { await rm(item.root, { recursive: true, force: true }); }
});

test("auto setup detects both Profile 2 Extensions and converges every local support component", async () => {
  const item = await fixture();
  try {
    const selectorPath = join(item.root, "selector.json");
    const statePath = join(item.root, "setup-state.json");
    const environment = {
      ...process.env,
      AOS_CHROME_COMPANION_DATA_DIR: join(item.root, "support"),
      AOS_WEB_OPERATION_BACKEND_CONFIG: selectorPath,
    };
    const detected = await detectTwoExtensionProfile({ chromeUserDataDir: item.chromeUserDataDir });
    assert.equal(detected.selected?.directory, "Profile 2");
    const first = await convergeCompanionSetup({
      platform: "darwin",
      homePath: item.homePath,
      sourceRoot: item.sourceRoot,
      chromeUserDataDir: item.chromeUserDataDir,
      statePath,
      lockPath: join(item.root, "setup.lock"),
      environment,
      nodeExecutable: process.execPath,
      runCommand: async () => installedPluginList(),
      trigger: "test",
    });
    assert.equal(first.schema, AUTO_SETUP_SCHEMA);
    assert.equal(first.setup_complete, true);
    assert.equal(first.companion_ready, true);
    assert.equal(first.integration_ready, true);
    assert.deepEqual(first.exact_blockers, []);
    assert.equal(first.profile_directory, "Profile 2");
    assert.equal(first.components.official_codex_plugin.installed, true);
    assert.equal(first.components.companion_codex_plugin.installed, true);
    assert.equal(first.components.adaptive_selector.backend, "aos_chrome_companion");
    assert.equal(first.components.adaptive_selector.revision, 2);
    assert.equal(first.components.control_plane_sync.result, "not_configured");
    const selector = JSON.parse(await readFile(selectorPath, "utf8"));
    assert.equal(selector.route_authority, "adaptive_two_extension_resolver");
    assert.equal(selector.routing_mode, "adaptive_two_extension");
    assert.equal(selector.routing_policy.preserve_active_run_backend, true);
    assert.equal(selector.routing_policy.no_post_dispatch_fallback, true);
    assert.equal((await stat(selectorPath)).mode & 0o777, 0o600);
    assert.equal((await stat(statePath)).mode & 0o777, 0o600);

    const second = await convergeCompanionSetup({
      platform: "darwin",
      homePath: item.homePath,
      sourceRoot: item.sourceRoot,
      chromeUserDataDir: item.chromeUserDataDir,
      statePath,
      lockPath: join(item.root, "setup.lock"),
      environment,
      nodeExecutable: process.execPath,
      runCommand: async () => installedPluginList(),
      trigger: "test-repeat",
    });
    assert.equal(second.setup_complete, true);
    assert.deepEqual(second.changes, []);
  } finally {
    await rm(item.root, { recursive: true, force: true });
  }
});

test("automatic control-plane sync detects source drift and delegates one signed idle refresh", async () => {
  const root = await realpath(await mkdtemp(join(tmpdir(), "aos-companion-auto-sync-")));
  const sourceRoot = join(root, "source");
  const installedRoot = join(root, "installed");
  const files = [
    "src/mcp/server.mjs",
    "src/broker/broker.mjs",
    "src/broker/main.mjs",
    "src/client/broker-client.mjs",
    "src/client/connect.mjs",
    "src/native-host/main.mjs",
    "src/shared/task-runtime.mjs",
    "src/shared/recovery-state.mjs",
    "src/shared/extension-refresh.mjs",
    "src/shared/install-refresh.mjs",
    "extension/service-worker.js",
    "extension/operation-schema.generated.js",
  ];
  try {
    for (const relative of files) {
      await mkdir(dirname(join(sourceRoot, relative)), { recursive: true });
      await mkdir(dirname(join(installedRoot, relative)), { recursive: true });
      await writeFile(join(sourceRoot, relative), `source:${relative}\n`);
      await writeFile(join(installedRoot, relative), `installed:${relative}\n`);
    }
    await mkdir(join(sourceRoot, "scripts"), { recursive: true });
    await writeFile(join(sourceRoot, "scripts", "sync-control-plane-macos.mjs"), "// fixture\n");
    const comparison = await compareControlPlaneArtifacts({ sourceRoot, installedRoot });
    assert.equal(comparison.match, false);
    assert.equal(comparison.exactBlocker, "companion_control_plane_drift");
    let invocation = null;
    const result = await requestAutomaticControlPlaneSync({
      sourceRoot,
      installedRoot,
      extensionId: DEFAULT_COMPANION_EXTENSION_ID,
      trigger: "launch_agent",
      runCommand: async (command, args, options) => {
        invocation = { command, args, timeoutMs: options.timeoutMs, sourceRoot: options.env.AOS_CHROME_COMPANION_SOURCE_ROOT };
        return {
          code: 0,
          stdout: JSON.stringify({
            result: "restarted",
            extensionRefresh: { result: "reflected", postRestartReadback: { ready: true, provenanceVerified: true } },
            statusAfter: { connectedProfileCount: 1 },
          }),
          stderr: "",
        };
      },
    });
    assert.equal(result.attempted, true);
    assert.equal(result.result, "restarted");
    assert.equal(result.reflected, true);
    assert.equal(invocation.args.at(0), join(sourceRoot, "scripts", "sync-control-plane-macos.mjs"));
    assert.equal(invocation.args.includes("--restart-broker"), true);
    assert.equal(invocation.timeoutMs, 90_000);
    assert.equal(invocation.sourceRoot, sourceRoot);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("a deferred sync receipt retries a resident-broker restart even after app hashes match", async () => {
  const root = await realpath(await mkdtemp(join(tmpdir(), "aos-companion-auto-sync-pending-")));
  const sourceRoot = join(root, "source");
  const installedRoot = join(root, "installed");
  const files = [
    "src/mcp/server.mjs",
    "src/broker/broker.mjs",
    "src/broker/main.mjs",
    "src/client/broker-client.mjs",
    "src/client/connect.mjs",
    "src/native-host/main.mjs",
    "src/shared/task-runtime.mjs",
    "src/shared/recovery-state.mjs",
    "src/shared/extension-refresh.mjs",
    "src/shared/install-refresh.mjs",
    "extension/service-worker.js",
    "extension/operation-schema.generated.js",
  ];
  try {
    for (const relative of files) {
      await mkdir(dirname(join(sourceRoot, relative)), { recursive: true });
      await mkdir(dirname(join(installedRoot, relative)), { recursive: true });
      const content = `same:${relative}\n`;
      await writeFile(join(sourceRoot, relative), content);
      await writeFile(join(installedRoot, relative), content);
    }
    await mkdir(join(sourceRoot, "scripts"), { recursive: true });
    await writeFile(join(sourceRoot, "scripts", "sync-control-plane-macos.mjs"), "// fixture\n");
    await writeJson(join(root, "control-plane-sync-receipt.json"), { sourceRoot, result: "deferred" });
    let calls = 0;
    const result = await requestAutomaticControlPlaneSync({
      sourceRoot,
      installedRoot,
      extensionId: DEFAULT_COMPANION_EXTENSION_ID,
      runCommand: async () => {
        calls += 1;
        return {
          code: 0,
          stdout: JSON.stringify({ result: "restarted", extensionRefresh: { result: "reflected", postRestartReadback: { ready: true, provenanceVerified: true } }, statusAfter: { connectedProfileCount: 1 } }),
          stderr: "",
        };
      },
    });
    assert.equal(result.comparison.match, true);
    assert.equal(result.pendingRefresh, false);
    assert.equal(result.forced, true);
    assert.equal(result.reflected, true);
    assert.equal(calls, 1);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("backup retention moves recoverably and ignores invalid, symlink, and non-directory candidates", async () => {
  const root = await realpath(await mkdtemp(join(tmpdir(), "aos-companion-retention-")));
  try {
    const trashParent = join(root, ".Trash");
    await mkdir(trashParent, { mode: 0o700 });
    const trashDestination = join(trashParent, "AOS-Chrome-Companion-backups-install-test");
    const names = [
      "app-backup-2026-08-20T00-00-00-000Z",
      "app-backup-2026-08-21T00-00-00-000Z",
      "app-backup-2026-08-22T00-00-00-000Z",
      "app-backup-2026-08-23T00-00-00-000Z",
      "app-backup-not-a-timestamp",
      "app-staging-123",
    ];
    for (const name of names) await mkdir(join(root, name), { recursive: true });
    await writeFile(join(root, "app-backup-2026-08-22T00-00-00-000Z", "marker"), "keep\n");
    const symlinkTarget = join(root, "symlink-target");
    await mkdir(symlinkTarget);
    await rm(join(root, "app-backup-2026-08-21T00-00-00-000Z"), { recursive: true });
    await symlink(symlinkTarget, join(root, "app-backup-2026-08-21T00-00-00-000Z"));
    await rm(join(root, "app-backup-2026-08-20T00-00-00-000Z"), { recursive: true });
    await writeFile(join(root, "app-backup-2026-08-20T00-00-00-000Z"), "not a directory\n");
    const result = await pruneApplicationBackups({ supportDir: root, keep: 1, trashDestination, trashRoot: trashParent });
    assert.deepEqual(result.moved.map((entry) => entry.name), ["app-backup-2026-08-22T00-00-00-000Z"]);
    assert.equal(result.moved[0].destinationName, "app-backup-2026-08-22T00-00-00-000Z");
    assert.equal((await stat(result.trashDestination)).mode & 0o777, 0o700);
    assert.equal(Object.hasOwn(result, "removed"), false);
    assert.equal(await readFile(join(result.trashDestination, result.moved[0].destinationName, "marker"), "utf8"), "keep\n");
    await assert.rejects(stat(join(root, "app-backup-2026-08-22T00-00-00-000Z")));
    assert.equal((await lstat(join(root, "app-backup-2026-08-21T00-00-00-000Z"))).isSymbolicLink(), true);
    assert.equal((await stat(join(root, "app-backup-2026-08-20T00-00-00-000Z"))).isFile(), true);
    assert.equal(await stat(join(root, "app-backup-not-a-timestamp")).then(() => true), true);
    assert.equal(await stat(join(root, "app-staging-123")).then(() => true), true);
    const outside = join(root, "outside");
    await mkdir(outside);
    await assert.rejects(pruneApplicationBackups({ supportDir: root, keep: 1, trashDestination: join(outside, "AOS-Chrome-Companion-backups-invalid"), trashRoot: trashParent }), /backup_retention_trash_root_mismatch/u);
    const source = await readFile(new URL("../src/setup/auto-setup.mjs", import.meta.url), "utf8");
    const retentionSource = source.slice(source.indexOf("export async function pruneApplicationBackups"), source.indexOf("export function setupReceiptIsStable"));
    assert.doesNotMatch(retentionSource, /\brm\s*\(/u);
    assert.equal(setupReceiptIsStable({ setup_complete: true, changes: [], exact_blockers: [] }, "launch_agent"), true);
    assert.equal(setupReceiptIsStable({ setup_complete: true, changes: [], exact_blockers: [] }, "native_host"), false);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("auto setup uses the explicit Codex CLI path under a restricted LaunchAgent PATH", async () => {
  const item = await fixture();
  try {
    const commands = [];
    const codexCliPath = "/Applications/ChatGPT.app/Contents/Resources/codex";
    const result = await convergeCompanionSetup({
      platform: "darwin",
      homePath: item.homePath,
      sourceRoot: item.sourceRoot,
      chromeUserDataDir: item.chromeUserDataDir,
      statePath: join(item.root, "setup-state.json"),
      lockPath: join(item.root, "setup.lock"),
      environment: {
        PATH: "/usr/bin:/bin:/usr/sbin:/sbin",
        CODEX_CLI_PATH: codexCliPath,
        AOS_CHROME_COMPANION_DATA_DIR: join(item.root, "support"),
        AOS_WEB_OPERATION_BACKEND_CONFIG: join(item.root, "selector.json"),
      },
      nodeExecutable: process.execPath,
      runCommand: async (command, args, options) => {
        assert.equal(options.env.PATH, `${dirname(process.execPath)}:/usr/bin:/bin:/usr/sbin:/sbin`);
        commands.push(command);
        return installedPluginList();
      },
      trigger: "test-launch-agent",
    });
    assert.equal(result.setup_complete, true);
    assert.deepEqual(commands, [codexCliPath]);
  } finally {
    await rm(item.root, { recursive: true, force: true });
  }
});

test("auto setup reports standalone Companion readiness while integration waits for the official Extension", async () => {
  const item = await fixture();
  try {
    const securePreferences = join(item.chromeUserDataDir, "Profile 2", "Secure Preferences");
    const preferences = JSON.parse(await readFile(securePreferences, "utf8"));
    delete preferences.extensions.settings[OFFICIAL_CHROME_EXTENSION_IDS[0]];
    await writeJson(securePreferences, preferences);
    let commandCount = 0;
    const result = await convergeCompanionSetup({
      platform: "darwin",
      homePath: item.homePath,
      sourceRoot: item.sourceRoot,
      chromeUserDataDir: item.chromeUserDataDir,
      statePath: join(item.root, "setup-state.json"),
      lockPath: join(item.root, "setup.lock"),
      environment: { ...process.env, AOS_CHROME_COMPANION_DATA_DIR: join(item.root, "support") },
      nodeExecutable: process.execPath,
      runCommand: async () => { commandCount += 1; return installedPluginList(); },
      trigger: "test-missing-official",
    });
    assert.equal(result.setup_complete, false);
    assert.equal(result.companion_ready, true);
    assert.equal(result.integration_ready, false);
    assert.match(result.exact_blockers.join("\n"), /official_chrome_extension_not_installed_in_common_profile/u);
    assert.doesNotMatch(result.exact_blockers.join("\n"), /companion_chrome_extension_not_installed/u);
    assert.ok(commandCount > 0, "Companion component verification runs independently");
  } finally {
    await rm(item.root, { recursive: true, force: true });
  }
});


test("native-host minimal PATH resolves the installed Codex CLI without changing PATH", async () => {
  const environment = { PATH: "/usr/bin:/bin" };
  const seen = [];
  const resolved = await resolveCodexCommand(environment, async (path) => { seen.push(path); return path === "/usr/local/bin/codex"; });
  assert.equal(resolved, "/usr/local/bin/codex");
  assert.equal(environment.PATH, "/usr/bin:/bin");
  assert.deepEqual(seen, ["/usr/bin/codex", "/bin/codex", "/usr/local/bin/codex"]);
  assert.equal(await resolveCodexCommand({ CODEX_CLI_PATH: "/custom/codex" }, () => { throw new Error("must honor explicit path"); }), "/custom/codex");
});

test('minute ticks reuse plugin checks but invalidate config changes and periodically recheck', async () => {
  const item = await fixture();
  try {
    let now = Date.now();
    const calls = [];
    const environment = { PATH: process.env.PATH, CODEX_CLI_PATH: process.execPath,
      CODEX_HOME: join(item.homePath, '.codex'), AOS_CHROME_COMPANION_DATA_DIR: join(item.root, 'support'),
      AOS_WEB_OPERATION_BACKEND_CONFIG: join(item.root, 'selector.json') };
    const options = { platform: 'darwin', ...item, environment, trigger: 'launch_agent',
      statePath: join(item.root, 'setup-state.json'), lockPath: join(item.root, 'setup.lock'), now: () => now,
      runCommand: async (command, args) => { calls.push(args); return installedPluginList(); } };
    const first = await convergeCompanionSetup(options);
    assert.equal(first.setup_complete, true);
    assert.equal(calls.length, 1);
    now += 60_000;
    const cached = await convergeCompanionSetup(options);
    assert.equal(cached.components.plugin_verification.reused, true);
    assert.equal(calls.length, 1);
    assert.equal(cached.components.plugin_verification.verified_at, first.components.plugin_verification.verified_at);
    await mkdir(environment.CODEX_HOME, { recursive: true });
    await writeFile(join(environment.CODEX_HOME, 'config.toml'), '# changed\n');
    await convergeCompanionSetup(options);
    assert.equal(calls.length, 2);
    now += 10 * 60_000;
    await convergeCompanionSetup(options);
    assert.equal(calls.length, 3);
    await convergeCompanionSetup({ ...options, trigger: 'manual' });
    assert.equal(calls.length, 4);
    await rm(join(item.chromeUserDataDir, 'Profile 2', 'Secure Preferences'));
    const missing = await convergeCompanionSetup(options);
    assert.equal(missing.setup_complete, false);
    assert.ok(missing.exact_blockers.some((x) => x.includes('extension_not_installed')));
  } finally { await rm(item.root, { recursive: true, force: true }); }
});
test('failed plugin checks are never cached across minute ticks', async () => {
  const item = await fixture();
  try {
    let calls = 0;
    const options = { platform: 'darwin', ...item, trigger: 'launch_agent',
      environment: { PATH: process.env.PATH, CODEX_CLI_PATH: process.execPath,
        AOS_CHROME_COMPANION_DATA_DIR: join(item.root, 'support'), AOS_WEB_OPERATION_BACKEND_CONFIG: join(item.root, 'selector.json') },
      statePath: join(item.root, 'state.json'), lockPath: join(item.root, 'setup.lock'),
      runCommand: async () => { calls++; return calls === 1 ? { code: 1, stdout: '', exactBlocker: 'test_inventory_failed' } : installedPluginList(); } };
    assert.equal((await convergeCompanionSetup(options)).setup_complete, false);
    assert.equal((await convergeCompanionSetup(options)).setup_complete, true);
    assert.equal(calls, 2);
  } finally { await rm(item.root, { recursive: true, force: true }); }
});
