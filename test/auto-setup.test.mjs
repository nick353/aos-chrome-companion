import assert from "node:assert/strict";
import { chmod, mkdir, mkdtemp, readFile, realpath, rm, stat, symlink, lstat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";
import {
  AUTO_SETUP_SCHEMA,
  resolveCodexCommand,
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
            extensionRefresh: { result: "reflected" },
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
          stdout: JSON.stringify({ result: "restarted", extensionRefresh: { result: "reflected" }, statusAfter: { connectedProfileCount: 1 } }),
          stderr: "",
        };
      },
    });
    assert.equal(result.comparison.match, true);
    assert.equal(result.pendingRefresh, true);
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
