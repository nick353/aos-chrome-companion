#!/usr/bin/env node

import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import {
  access,
  chmod,
  copyFile,
  cp,
  mkdir,
  open,
  readFile,
  rename,
  rm,
  writeFile,
  lstat,
  readdir,
} from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { NATIVE_HOST_NAME } from "../src/shared/constants.mjs";
import { pruneApplicationBackups } from "../src/setup/auto-setup.mjs";

function parseArgs(argv) {
  const output = { installCodexPlugin: true };
  for (let index = 0; index < argv.length; index += 1) {
    if (argv[index] === "--extension-id") output.extensionId = argv[++index];
    else if (argv[index] === "--skip-codex-plugin") output.installCodexPlugin = false;
  }
  return output;
}

function run(command, args, options = {}) {
  return new Promise((resolvePromise, reject) => {
    const child = spawn(command, args, {
      cwd: options.cwd,
      env: options.env || process.env,
      stdio: ["ignore", "pipe", "pipe"],
    });
    const stdout = [];
    const stderr = [];
    child.stdout.on("data", (chunk) => stdout.push(chunk));
    child.stderr.on("data", (chunk) => stderr.push(chunk));
    child.once("error", reject);
    child.once("exit", (code) => {
      const result = {
        code,
        stdout: Buffer.concat(stdout).toString("utf8").trim(),
        stderr: Buffer.concat(stderr).toString("utf8").trim(),
      };
      if (code === 0 || options.allowFailure) resolvePromise(result);
      else reject(new Error(`${command} failed (${code}): ${result.stderr || result.stdout}`));
    });
  });
}

async function exists(path) {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

async function assertNoSymlinkComponents(path, { allowMissingLeaf = true } = {}) {
  const absolute = resolve(path);
  const parts = absolute.split("/").filter(Boolean);
  let current = "/";
  for (let index = 0; index < parts.length; index += 1) {
    current = join(current, parts[index]);
    try {
      const stat = await lstat(current);
      if (stat.isSymbolicLink()) throw new Error(`Refusing symlink path component: ${current}`);
    } catch (error) {
      if (error?.code === "ENOENT" && allowMissingLeaf) return;
      throw error;
    }
  }
}

async function assertTreeNoSymlinks(root) {
  await assertNoSymlinkComponents(root, { allowMissingLeaf: false });
  const rootStat = await lstat(root);
  if (!rootStat.isDirectory()) return;
  for (const entry of await readdir(root, { withFileTypes: true })) {
    const child = join(root, entry.name);
    if (entry.isSymbolicLink()) throw new Error(`Refusing symlink install source: ${child}`);
    if (entry.isDirectory()) await assertTreeNoSymlinks(child);
  }
}

function buildInfoSource(buildId) {
  return `export const INSTALL_BUILD_ID = ${JSON.stringify(buildId)};\n`;
}

async function readInstalledBuildId(appDir) {
  const buildInfoPath = join(appDir, "src", "shared", "build-info.mjs");
  try {
    const source = await readFile(buildInfoPath, "utf8");
    const match = /INSTALL_BUILD_ID\s*=\s*["']([^"']+)["']/u.exec(source);
    return match?.[1] && /^install-[0-9a-f-]{36}$/u.test(match[1]) ? match[1] : null;
  } catch {
    return null;
  }
}

/**
 * Stamp the unpacked source Extension before swapping the broker application.
 * The source tree is the path Chrome reloads from, so it must carry the exact
 * build ID that the staged Node broker will enforce.  The write is atomic and
 * refuses symlinked path components or a symlink target.
 */
async function stampSourceExtensionBuildId(extensionRoot, buildId) {
  await assertNoSymlinkComponents(extensionRoot);
  const target = join(extensionRoot, "build-info.js");
  await assertNoSymlinkComponents(target);
  const targetStat = await lstat(target);
  if (targetStat.isSymbolicLink() || !targetStat.isFile()) {
    throw new Error("source_extension_build_info_not_regular_file");
  }
  const previousContent = await readFile(target, "utf8");
  const nextContent = buildInfoSource(buildId);
  const temporary = `${target}.${process.pid}-${randomUUID()}.tmp`;
  try {
    await writeFile(temporary, nextContent, { flag: "wx", mode: targetStat.mode & 0o777 });
    await chmod(temporary, targetStat.mode & 0o777);
    await assertNoSymlinkComponents(temporary);
    await rename(temporary, target);
  } catch (error) {
    await rm(temporary, { force: true }).catch(() => {});
    throw error;
  }
  return { path: target, buildId, previousContent, nextContent };
}

async function rollbackSourceExtensionBuildId(stamp) {
  if (!stamp) return { attempted: false, restored: true };
  await assertNoSymlinkComponents(stamp.path);
  const targetStat = await lstat(stamp.path);
  if (targetStat.isSymbolicLink() || !targetStat.isFile()) {
    throw new Error("source_extension_build_info_rollback_target_invalid");
  }
  const currentContent = await readFile(stamp.path, "utf8");
  if (currentContent !== stamp.nextContent) {
    throw new Error("source_extension_build_info_rollback_conflict");
  }
  const temporary = `${stamp.path}.${process.pid}-${randomUUID()}.rollback.tmp`;
  try {
    await writeFile(temporary, stamp.previousContent, { flag: "wx", mode: targetStat.mode & 0o777 });
    await chmod(temporary, targetStat.mode & 0o777);
    await assertNoSymlinkComponents(temporary);
    await rename(temporary, stamp.path);
  } catch (error) {
    await rm(temporary, { force: true }).catch(() => {});
    throw error;
  }
  return { attempted: true, restored: true };
}

const { extensionId, installCodexPlugin } = parseArgs(process.argv.slice(2));
if (!/^[a-p]{32}$/.test(extensionId ?? "")) {
  process.stderr.write(
    "Usage: npm run install:local:macos -- --extension-id <32-character Chrome extension ID> [--skip-codex-plugin]\n",
  );
  process.exit(2);
}
if (process.platform !== "darwin") {
  throw new Error("The local product installer currently supports macOS only");
}

const sourceRoot = resolve(fileURLToPath(new URL("..", import.meta.url)));
const supportDir = join(homedir(), "Library", "Application Support", "AOS Chrome Companion");
const appDir = join(supportDir, "app");
const stagingDir = join(supportDir, `.app-staging-${process.pid}`);
const timestamp = new Date().toISOString().replace(/[:.]/g, "-");
const backupDir = join(supportDir, `app-backup-${timestamp}`);
const backupTrashDestination = join(homedir(), ".Trash", `AOS-Chrome-Companion-backups-${timestamp}`);
const binDir = join(supportDir, "bin");
const wrapperPath = join(binDir, "aos-chrome-companion-host");
const manifestDir = join(homedir(), "Library", "Application Support", "Google", "Chrome", "NativeMessagingHosts");
const manifestPath = join(manifestDir, `${NATIVE_HOST_NAME}.json`);
const extensionOrigin = `chrome-extension://${extensionId}/`;
const marketplaceName = "aos-chrome-companion-local";
const sourceExtensionRoot = join(sourceRoot, "extension");
const sourceExtensionBuildInfoPath = join(sourceExtensionRoot, "build-info.js");
const previousInstallBuildId = await readInstalledBuildId(appDir);
// Keep the install build stable across local updates.  The explicit
// extension.reload boundary rotates the runtime identity and generation, so
// rotating the build id here only creates a temporary mismatch window where
// the old resident broker cannot accept the still-loaded Extension.  A first
// install still receives a unique id; subsequent updates reuse that id while
// the signed refresh loads the new source.
const installBuildId = previousInstallBuildId ?? `install-${randomUUID()}`;
const installBuildIdReused = Boolean(previousInstallBuildId);

await assertNoSymlinkComponents(supportDir);
await assertNoSymlinkComponents(stagingDir);
await assertNoSymlinkComponents(appDir);
await assertNoSymlinkComponents(manifestDir);
for (const entry of ["src", "extension", "plugins", "scripts", "package.json", "package-lock.json", "README.md", "PROJECT_DESIGN.md"]) {
  await assertTreeNoSymlinks(join(sourceRoot, entry));
}
await mkdir(supportDir, { recursive: true, mode: 0o700 });
await rm(stagingDir, { recursive: true, force: true });
await mkdir(stagingDir, { recursive: true, mode: 0o700 });

let sourceBuildInfoStamp = null;
const appSwap = { previousMoved: false, newInstalled: false };
try {
  for (const entry of ["src", "extension", "plugins", "scripts", "package.json", "package-lock.json", "README.md", "PROJECT_DESIGN.md"] ) {
    await cp(join(sourceRoot, entry), join(stagingDir, entry), {
      recursive: true,
      force: false,
      errorOnExist: true,
    });
  }

  // Bind the staged Node broker and unpacked Extension to one install. The
  // source tree keeps a safe dev-local default; the local install value is
  // stable across updates and the signed Extension refresh rotates the
  // runtime identity at the safe boundary.
  await writeFile(join(stagingDir, "src", "shared", "build-info.mjs"), buildInfoSource(installBuildId), { mode: 0o600 });
  await writeFile(join(stagingDir, "extension", "build-info.js"), buildInfoSource(installBuildId), { mode: 0o600 });

  const packageJsonPath = join(stagingDir, "package.json");
  const packageJson = JSON.parse(await readFile(packageJsonPath, "utf8"));
  const pluginRoot = join(stagingDir, "plugins", "aos-chrome-companion");
  const pluginManifestPath = join(pluginRoot, ".codex-plugin", "plugin.json");
  const pluginManifest = JSON.parse(await readFile(pluginManifestPath, "utf8"));
  pluginManifest.version = `${String(packageJson.version || "0.1.0").split("+")[0]}+codex.local-${timestamp}`;
  await writeFile(pluginManifestPath, `${JSON.stringify(pluginManifest, null, 2)}\n`, { mode: 0o600 });
  await writeFile(join(pluginRoot, ".mcp.json"), `${JSON.stringify({
    mcpServers: {
      "aos-chrome-companion": {
        command: "node",
        args: ["scripts/start-mcp.mjs"],
        cwd: ".",
        env: { AOS_CHROME_COMPANION_ROOT: appDir },
        enabled: true,
        startup_timeout_sec: 15,
        tool_timeout_sec: 90,
      },
    },
  }, null, 2)}\n`, { mode: 0o600 });

  const marketplacePath = join(stagingDir, ".agents", "plugins", "marketplace.json");
  await mkdir(dirname(marketplacePath), { recursive: true, mode: 0o700 });
  await writeFile(marketplacePath, `${JSON.stringify({
    name: marketplaceName,
    interface: { displayName: "AOS Chrome Companion Local" },
    plugins: [{
      name: "aos-chrome-companion",
      source: { source: "local", path: "./plugins/aos-chrome-companion" },
      policy: { installation: "AVAILABLE", authentication: "ON_INSTALL" },
      category: "Productivity",
    }],
  }, null, 2)}\n`, { mode: 0o600 });

  await run("npm", ["ci", "--omit=dev", "--ignore-scripts", "--no-audit", "--no-fund"], { cwd: stagingDir });

  // Chrome reloads the unpacked Extension from the source tree, not from the
  // staged app. Stamp it before the app swap so a source failure leaves the
  // currently running broker/application untouched.
  sourceBuildInfoStamp = await stampSourceExtensionBuildId(sourceExtensionRoot, installBuildId);

  if (await exists(appDir)) {
    await rename(appDir, backupDir);
    appSwap.previousMoved = true;
  }
  await rename(stagingDir, appDir);
  appSwap.newInstalled = true;
} catch (error) {
  const rollbackErrors = [];
  try {
    // If the swap got as far as the new app, move it out of the active path
    // before restoring the previous app. This path is only reached on a
    // subsequent installer failure and never removes the user's old app.
    if (appSwap.newInstalled && await exists(appDir)) {
      await assertNoSymlinkComponents(appDir);
      await rename(appDir, stagingDir);
    }
    if (appSwap.previousMoved && await exists(backupDir)) {
      await assertNoSymlinkComponents(backupDir);
      await rename(backupDir, appDir);
    }
  } catch (rollbackError) {
    rollbackErrors.push(`app_swap_rollback_failed:${rollbackError.message}`);
  }
  try {
    await rollbackSourceExtensionBuildId(sourceBuildInfoStamp);
  } catch (rollbackError) {
    rollbackErrors.push(`source_build_info_rollback_failed:${rollbackError.message}`);
  }
  try {
    await assertNoSymlinkComponents(stagingDir);
    await rm(stagingDir, { recursive: true, force: true });
  } catch (cleanupError) {
    rollbackErrors.push(`staging_cleanup_failed:${cleanupError.message}`);
  }
  if (rollbackErrors.length > 0) {
    throw new AggregateError([error, ...rollbackErrors.map((message) => new Error(message))], "local_install_rollback_incomplete");
  }
  throw error;
}

const backupRetention = await pruneApplicationBackups({
  supportDir,
  keep: 3,
  trashDestination: backupTrashDestination,
  trashRoot: join(homedir(), ".Trash"),
});

await mkdir(binDir, { recursive: true, mode: 0o700 });
await mkdir(manifestDir, { recursive: true, mode: 0o700 });
await assertNoSymlinkComponents(wrapperPath);
await assertNoSymlinkComponents(manifestPath);
const wrapper = [
  "#!/bin/sh",
  `AOS_CHROME_COMPANION_EXTENSION_ORIGIN=${JSON.stringify(extensionOrigin)} exec ${JSON.stringify(process.execPath)} ${JSON.stringify(join(appDir, "src", "native-host", "main.mjs"))} "$@"`,
  "",
].join("\n");
await writeFile(wrapperPath, wrapper, { mode: 0o700 });
await chmod(wrapperPath, 0o700);

let nativeManifestBackup = null;
if (await exists(manifestPath)) {
  nativeManifestBackup = `${manifestPath}.backup-${timestamp}`;
  await copyFile(manifestPath, nativeManifestBackup);
}
const temporaryManifest = `${manifestPath}.tmp-${process.pid}`;
await writeFile(temporaryManifest, `${JSON.stringify({
  name: NATIVE_HOST_NAME,
  description: "AOS Chrome Companion native relay",
  path: wrapperPath,
  type: "stdio",
  allowed_origins: [extensionOrigin],
}, null, 2)}\n`, { mode: 0o600 });
await rename(temporaryManifest, manifestPath);

const autoSetupLabel = "com.nichikatanaka.aos-chrome-companion-autosetup";
const autoSetupWrapperPath = join(binDir, "aos-chrome-companion-autosetup");
const launchAgentsDir = join(homedir(), "Library", "LaunchAgents");
const launchAgentPath = join(launchAgentsDir, `${autoSetupLabel}.plist`);
const logsDir = join(supportDir, "logs");
const autoSetupStdoutPath = join(logsDir, "autosetup.stdout.log");
const autoSetupStderrPath = join(logsDir, "autosetup.stderr.log");
await mkdir(launchAgentsDir, { recursive: true, mode: 0o700 });
await mkdir(logsDir, { recursive: true, mode: 0o700 });
for (const logPath of [autoSetupStdoutPath, autoSetupStderrPath]) {
  const logHandle = await open(logPath, "a", 0o600);
  await logHandle.close();
  await chmod(logPath, 0o600);
}
await writeFile(autoSetupWrapperPath, [
  "#!/bin/sh",
  `AOS_CHROME_COMPANION_SETUP_TRIGGER=launch_agent AOS_CHROME_COMPANION_SOURCE_ROOT=${JSON.stringify(sourceRoot)} AOS_CHROME_COMPANION_INSTALL_ROOT=${JSON.stringify(appDir)} exec ${JSON.stringify(process.execPath)} ${JSON.stringify(join(appDir, "scripts", "auto-setup-macos.mjs"))}`,
  "",
].join("\n"), { mode: 0o700 });
await chmod(autoSetupWrapperPath, 0o700);
const xml = (value) => String(value).replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;");
const launchAgent = `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>${autoSetupLabel}</string>
  <key>ProgramArguments</key>
  <array><string>${xml(autoSetupWrapperPath)}</string></array>
  <key>RunAtLoad</key><true/>
  <key>StartInterval</key><integer>60</integer>
  <key>ProcessType</key><string>Background</string>
  <key>StandardOutPath</key><string>${xml(autoSetupStdoutPath)}</string>
  <key>StandardErrorPath</key><string>${xml(autoSetupStderrPath)}</string>
</dict>
</plist>
`;
await writeFile(launchAgentPath, launchAgent, { mode: 0o600 });
await chmod(launchAgentPath, 0o600);

let codexPlugin = {
  requested: installCodexPlugin,
  marketplaceAdded: false,
  installed: false,
  exactBlocker: null,
  staleRemoved: [],
  staleCleanupBlockers: [],
};
if (installCodexPlugin) {
  const marketplace = await run("codex", ["plugin", "marketplace", "add", appDir], { allowFailure: true });
  codexPlugin.marketplaceAdded = marketplace.code === 0
    || /already|exists|configured/iu.test(`${marketplace.stdout} ${marketplace.stderr}`);
  if (codexPlugin.marketplaceAdded) {
    const installed = await run("codex", ["plugin", "add", `aos-chrome-companion@${marketplaceName}`], { allowFailure: true });
    codexPlugin.installed = installed.code === 0;
    if (!codexPlugin.installed) codexPlugin.exactBlocker = installed.stderr || installed.stdout || "codex_plugin_install_failed";
    if (codexPlugin.installed) {
      // Keep the app-local marketplace as the single source of truth.  Older
      // installers could leave the same plugin installed from another local
      // marketplace, which makes new tasks pick a stale MCP bundle.
      const listed = await run("codex", ["plugin", "list", "--json"], { allowFailure: true });
      if (listed.code !== 0) {
        codexPlugin.staleCleanupBlockers.push(listed.stderr || listed.stdout || "codex_plugin_list_failed");
      } else {
        try {
          const registry = JSON.parse(listed.stdout || "{}");
          const stale = Array.isArray(registry.installed)
            ? registry.installed.filter((entry) => entry?.name === "aos-chrome-companion"
              && entry?.marketplaceName !== marketplaceName
              && entry?.installed !== false)
            : [];
          for (const entry of stale) {
            if (typeof entry.pluginId !== "string" || !entry.pluginId) {
              codexPlugin.staleCleanupBlockers.push("codex_plugin_id_missing");
              continue;
            }
            const removed = await run("codex", ["plugin", "remove", entry.pluginId, "--json"], { allowFailure: true });
            if (removed.code === 0) codexPlugin.staleRemoved.push(entry.pluginId);
            else codexPlugin.staleCleanupBlockers.push(removed.stderr || removed.stdout || `codex_plugin_remove_failed:${entry.pluginId}`);
          }
        } catch {
          codexPlugin.staleCleanupBlockers.push("codex_plugin_list_invalid_json");
        }
        if (codexPlugin.staleCleanupBlockers.length > 0 && !codexPlugin.exactBlocker) {
          codexPlugin.exactBlocker = codexPlugin.staleCleanupBlockers[0];
        }
      }
    }
  } else {
    codexPlugin.exactBlocker = marketplace.stderr || marketplace.stdout || "codex_marketplace_install_failed";
  }
}

const launchDomain = `gui/${process.getuid()}`;
await run("launchctl", ["bootout", `${launchDomain}/${autoSetupLabel}`], { allowFailure: true });
const launchAgentBootstrap = await run("launchctl", ["bootstrap", launchDomain, launchAgentPath], { allowFailure: true });
const autoSetupRun = await run(autoSetupWrapperPath, [], { allowFailure: true });
let autoSetupReceipt = null;
try {
  autoSetupReceipt = JSON.parse(autoSetupRun.stdout || "null");
} catch {
  autoSetupReceipt = null;
}
if (!autoSetupReceipt && autoSetupRun.code === 0) autoSetupReceipt = { setup_complete: true, exact_blockers: [], changes: [] };

// Converge the resident broker and the unpacked Extension without requiring a
// user to open chrome://extensions and press Reload.  The sync script performs
// a signed, task-owned Extension refresh before it restarts the broker; when a
// task is active or the profile is disconnected it returns a precise deferred
// receipt and leaves the existing runtime untouched.
const runtimeSyncRun = await run(
  process.execPath,
  [join(sourceRoot, "scripts", "sync-control-plane-macos.mjs"), "--apply", "--restart-broker", "--extension-id", extensionId],
  { cwd: sourceRoot, allowFailure: true },
);
let runtimeSyncReceipt = null;
try {
  runtimeSyncReceipt = JSON.parse(runtimeSyncRun.stdout || "null");
} catch {
  runtimeSyncReceipt = null;
}
if (!runtimeSyncReceipt && runtimeSyncRun.code !== 0) {
  runtimeSyncReceipt = {
    result: "deferred",
    exactBlockers: [runtimeSyncRun.stderr || runtimeSyncRun.stdout || "control_plane_sync_failed"],
  };
}

process.stdout.write(`${JSON.stringify({
  schema: "aos_chrome_companion_local_install.v1",
  installed: true,
  releaseReady: false,
  extensionId,
  installBuildId,
  installBuildIdReused,
  extensionDirectory: join(appDir, "extension"),
  sourceExtensionBuildInfo: {
    path: sourceExtensionBuildInfoPath,
    buildId: installBuildId,
    stamped: true,
    atomic: true,
    symlinkSafe: true,
    rollbackOnFailure: true,
  },
  applicationRoot: appDir,
  previousApplicationBackup: await exists(backupDir) ? backupDir : null,
  backupRetention,
  nativeHostManifest: manifestPath,
  nativeHostManifestBackup: nativeManifestBackup,
  nativeHostWrapper: wrapperPath,
  autoSetup: {
    launchAgentPath,
    wrapperPath: autoSetupWrapperPath,
    launchAgentLoaded: launchAgentBootstrap.code === 0,
    setupComplete: autoSetupReceipt?.setup_complete === true,
    exactBlockers: autoSetupReceipt?.exact_blockers
      ?? (autoSetupRun.code === 0 ? [] : [autoSetupRun.stderr || "auto_setup_initial_convergence_failed"]),
  },
  controlPlaneSync: runtimeSyncReceipt,
  codexPlugin,
  remainingReleaseBlockers: [
    "chrome_web_store_signed_extension_missing",
    "apple_developer_id_pkg_signature_missing",
    "notarization_missing",
    "bundled_node_runtime_missing",
  ],
  next: autoSetupReceipt?.setup_complete === true && ["restarted", "applied"].includes(runtimeSyncReceipt?.result)
    ? "No manual Extension reload is required. The signed refresh and broker restart completed at an idle boundary."
    : autoSetupReceipt?.setup_complete === true
      ? `Runtime refresh is deferred: ${runtimeSyncReceipt?.exactBlockers?.[0] ?? "wait for an idle connected Companion profile; the next install or scheduler tick retries automatically"}.`
    : "Keep both Extensions enabled in Profile 2. The background setup retries automatically; inspect setup-state.json for any permission or policy blocker.",
}, null, 2)}\n`);
