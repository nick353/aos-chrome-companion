import { spawn } from "node:child_process";
import {
  access,
  chmod,
  lstat,
  mkdir,
  open,
  readFile,
  readdir,
  realpath,
  rename,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import { constants as fsConstants } from "node:fs";
import { createHash } from "node:crypto";
import { homedir } from "node:os";
import { delimiter, dirname, isAbsolute, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { NATIVE_HOST_NAME } from "../shared/constants.mjs";
import { controlPlaneFiles } from "../shared/control-plane-files.mjs";

export const AUTO_SETUP_SCHEMA = "aos_chrome_companion_auto_setup.v1";
export const DEFAULT_COMPANION_EXTENSION_ID = "pmoolbkcamcemmfonlaenelcbdlcngmb";
export const OFFICIAL_CHROME_EXTENSION_IDS = Object.freeze([
  "hehggadaopoacecdllhhajmbjkdcmajg",
  "odlomjlbamekndcpllcnffbgeohgkmjh",
]);

const APPLICATION_BACKUP_NAME = /^app-backup-\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}-\d{3}Z$/u;

const OFFICIAL_NATIVE_HOST_NAME = "com.openai.codexextension";
const MARKETPLACE_NAME = "aos-chrome-companion-local";
const SETUP_LOCK_STALE_MS = 120_000;
const COMMAND_TIMEOUT_MS = 20_000;
const PLUGIN_RECHECK_MS = 10 * 60_000;
const CONTROL_PLANE_SYNC_TIMEOUT_MS = 90_000;
const ROUTING_POLICY = Object.freeze({
  decision_scope: "browser_stage_before_skill_or_preflight",
  explicit_user_or_workflow_requirement_wins: true,
  preserve_active_run_backend: true,
  normal_default: "aos_chrome_companion",
  effect_adapter_resolution: "effectful_adapter_required",
  official_surface_requirement: "chrome_plugin",
  no_post_dispatch_fallback: true,
  reroute_after_terminal_no_effect_only: true,
  safe_surface_handoff_schema: "aos.safe_extension_surface_handoff.v1",
  safe_surface_handoff_direction: "aos_chrome_companion_to_chrome_plugin_once",
  proactive_visual_readback_required: true,
  human_verification_detection: "rendered_actionable_control_plus_visual_confirmation",
  passive_security_branding_not_blocker: true,
  unsafe_handoff_conditions: Object.freeze([
    "operation_effect_unknown",
    "reconciliation_required",
    "semantic_visual_conflict",
    "auth_or_human_verification",
    "target_or_owner_ambiguity",
  ]),
});

/**
 * Keep only a small recoverable install history. The matcher is deliberately
 * strict and the scan is direct-child-only: app, staging trees, logs, and
 * arbitrary support files can never be selected by this retention pass.
 * Old backups are moved with rename(2) into an explicitly supplied Trash
 * directory; this function never recursively deletes a backup.
 */
export async function pruneApplicationBackups({ supportDir, keep = 3, trashDestination, trashRoot = join(homedir(), ".Trash") } = {}) {
  if (typeof supportDir !== "string" || !supportDir) throw new Error("backup_retention_support_dir_required");
  if (typeof trashDestination !== "string" || !trashDestination) throw new Error("backup_retention_trash_destination_required");
  const supportRoot = await realpath(supportDir);
  const supportParent = await realpath(dirname(resolve(supportRoot)));
  if (supportParent !== dirname(supportRoot)) throw new Error("backup_retention_support_parent_mismatch");
  const requestedTrash = resolve(trashDestination);
  const trashName = requestedTrash.split("/").at(-1) ?? "";
  if (!/^AOS-Chrome-Companion-backups-[A-Za-z0-9._-]+$/u.test(trashName)) {
    throw new Error("backup_retention_trash_destination_invalid");
  }
  const trashParent = dirname(requestedTrash);
  const trashParentReal = await realpath(trashParent);
  if (trashParentReal !== trashParent) throw new Error("backup_retention_trash_parent_mismatch");
  const trashRootReal = await realpath(resolve(trashRoot));
  if (trashParentReal !== trashRootReal) throw new Error("backup_retention_trash_root_mismatch");
  const entries = await readdir(supportRoot, { withFileTypes: true });
  const backups = entries
    .filter((entry) => APPLICATION_BACKUP_NAME.test(entry.name))
    .sort((left, right) => right.name.localeCompare(left.name));
  const keepCount = Math.max(0, Number.isSafeInteger(keep) ? keep : 3);
  const retained = backups.slice(0, keepCount).map((entry) => entry.name);
  const candidates = backups.slice(keepCount);
  const moved = [];
  const errors = [];
  let selectedTrashDestination = null;
  let trashDirectoryReady = false;
  const ensureTrashDirectory = async () => {
    if (trashDirectoryReady) return selectedTrashDestination;
    for (let index = 0; index < 100; index += 1) {
      const suffix = index === 0 ? "" : `-${index}`;
      const candidate = `${requestedTrash}${suffix}`;
      try {
        await mkdir(candidate, { mode: 0o700 });
        await chmod(candidate, 0o700);
        selectedTrashDestination = candidate;
        trashDirectoryReady = true;
        return candidate;
      } catch (error) {
        if (error?.code !== "EEXIST") throw error;
        const statValue = await lstat(candidate);
        if (!statValue.isDirectory() || statValue.isSymbolicLink()) throw new Error("backup_retention_trash_collision_not_directory");
      }
    }
    throw new Error("backup_retention_trash_collision_exhausted");
  };
  for (const entry of candidates) {
    const sourcePath = resolve(supportRoot, entry.name);
    if (dirname(sourcePath) !== supportRoot) {
      errors.push({ name: entry.name, error: "backup_retention_source_parent_mismatch", sourcePreserved: true });
      continue;
    }
    let sourceStat;
    try {
      sourceStat = await lstat(sourcePath);
    } catch (error) {
      errors.push({ name: entry.name, error: errorText(error), sourcePreserved: true });
      continue;
    }
    if (sourceStat.isSymbolicLink() || !sourceStat.isDirectory()) {
      errors.push({ name: entry.name, error: sourceStat.isSymbolicLink() ? "backup_retention_symlink_rejected" : "backup_retention_non_directory_rejected", sourcePreserved: true });
      continue;
    }
    try {
      const destination = await ensureTrashDirectory();
      let destinationName = entry.name;
      let destinationPath = join(destination, destinationName);
      for (let index = 0; index < 100; index += 1) {
        try {
          await lstat(destinationPath);
          destinationName = `${entry.name}-${index + 1}`;
          destinationPath = join(destination, destinationName);
        } catch (error) {
          if (error?.code === "ENOENT") break;
          throw error;
        }
      }
      await rename(sourcePath, destinationPath);
      moved.push({ name: entry.name, destinationName });
    } catch (error) {
      errors.push({ name: entry.name, error: errorText(error), sourcePreserved: true });
    }
  }
  return {
    kept: retained,
    moved,
    trashDestination: selectedTrashDestination,
    errors,
  };
}

export function setupReceiptIsStable(result, trigger) {
  return trigger === "launch_agent"
    && result?.setup_complete === true
    && Array.isArray(result?.changes)
    && result.changes.length === 0
    && Array.isArray(result?.exact_blockers)
    && result.exact_blockers.length === 0;
}

function errorText(error) {
  return error instanceof Error ? error.message : String(error);
}

async function exists(path) {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

async function readJson(path) {
  try {
    return JSON.parse(await readFile(path, "utf8"));
  } catch (error) {
    if (error?.code === "ENOENT") return null;
    throw error;
  }
}

async function assertNoSymlinkComponents(path) {
  const absolute = resolve(path);
  const parts = absolute.split("/").filter(Boolean);
  let current = "/";
  for (const part of parts) {
    current = join(current, part);
    try {
      const value = await lstat(current);
      if (value.isSymbolicLink()) throw new Error(`auto_setup_symlink_path_rejected:${current}`);
    } catch (error) {
      if (error?.code === "ENOENT") return;
      throw error;
    }
  }
}

async function atomicJson(path, value, mode = 0o600) {
  await assertNoSymlinkComponents(path);
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  const temporary = `${path}.${process.pid}.tmp`;
  await writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`, { mode });
  await chmod(temporary, mode);
  await rename(temporary, path);
  await chmod(path, mode);
}

export function runSetupCommand(command, args, { env = process.env, timeoutMs = COMMAND_TIMEOUT_MS } = {}) {
  return new Promise((resolvePromise) => {
    const child = spawn(command, args, {
      env,
      stdio: ["ignore", "pipe", "pipe"],
    });
    const stdout = [];
    const stderr = [];
    let settled = false;
    const finish = (result) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolvePromise(result);
    };
    const timer = setTimeout(() => {
      child.kill("SIGTERM");
      finish({ code: null, stdout: "", stderr: "", exactBlocker: `auto_setup_command_timeout:${command}` });
    }, timeoutMs);
    child.stdout.on("data", (chunk) => stdout.push(chunk));
    child.stderr.on("data", (chunk) => stderr.push(chunk));
    child.once("error", (error) => finish({ code: null, stdout: "", stderr: "", exactBlocker: `auto_setup_command_failed:${command}:${errorText(error)}` }));
    child.once("exit", (code) => finish({
      code,
      stdout: Buffer.concat(stdout).toString("utf8").trim(),
      stderr: Buffer.concat(stderr).toString("utf8").trim(),
      exactBlocker: code === 0 ? null : `auto_setup_command_failed:${command}:${code}`,
    }));
  });
}

async function fileDigest(file) {
  try {
    const value = await readFile(file);
    return {
      exists: true,
      sha256: createHash("sha256").update(value).digest("hex"),
      bytes: value.byteLength,
    };
  } catch (error) {
    if (error?.code === "ENOENT") return { exists: false, sha256: null, bytes: 0 };
    throw error;
  }
}

/**
 * Compare the installed control plane with the source tree that the local
 * developer build is expected to reflect.  This is deliberately read-only;
 * the caller decides whether an idle signed refresh may be attempted.
 */
export async function compareControlPlaneArtifacts({ sourceRoot, installedRoot } = {}) {
  if (typeof sourceRoot !== "string" || !sourceRoot) throw new Error("control_plane_source_root_required");
  if (typeof installedRoot !== "string" || !installedRoot) throw new Error("control_plane_installed_root_required");
  const source = resolve(sourceRoot);
  const installed = resolve(installedRoot);
  const files = {};
  const runtimeFiles = await controlPlaneFiles(source, installed);
  for (const relative of runtimeFiles) {
    const sourceFingerprint = await fileDigest(join(source, relative));
    const installedFingerprint = await fileDigest(join(installed, relative));
    files[relative] = { source: sourceFingerprint, installed: installedFingerprint };
  }
  const mismatches = runtimeFiles.filter((relative) => {
    const item = files[relative];
    return item.source.exists !== item.installed.exists || item.source.sha256 !== item.installed.sha256;
  });
  return {
    schema: "aos.chrome_companion.control_plane_artifact_comparison.v1",
    sourceRoot: source,
    installedRoot: installed,
    files,
    match: mismatches.length === 0,
    mismatches,
    exactBlocker: mismatches.length > 0 ? "companion_control_plane_drift" : null,
  };
}

function parseCommandJson(result) {
  try {
    const parsed = JSON.parse(result?.stdout || "null");
    return parsed && typeof parsed === "object" ? parsed : null;
  } catch {
    return null;
  }
}

/**
 * Reconcile source/install drift without requiring the user to press Reload in
 * chrome://extensions.  The control-plane script performs the actual idle
 * boundary, signed Extension reload, broker restart, and fresh generation
 * readback.  This helper only launches it after a read-only hash comparison;
 * a busy profile is returned as a precise deferred receipt and is retried by
 * the next launch-agent tick.
 */
export async function requestAutomaticControlPlaneSync({
  sourceRoot,
  installedRoot,
  extensionId,
  environment = process.env,
  runCommand = runSetupCommand,
  trigger = "launch_agent",
  nodeExecutable = process.execPath,
  force = false,
} = {}) {
  const source = resolve(sourceRoot || "");
  const installed = resolve(installedRoot || "");
  const script = join(source, "scripts", "sync-control-plane-macos.mjs");
  if (!sourceRoot || !installedRoot || source === installed || !await exists(script)) {
    return {
      schema: "aos.chrome_companion.control_plane_auto_sync.v1",
      attempted: false,
      result: "not_configured",
      trigger,
      externalActionExecuted: false,
      noReplay: true,
      exactBlocker: null,
    };
  }
  const comparison = await compareControlPlaneArtifacts({ sourceRoot: source, installedRoot: installed });
  // An install can swap the app directory while the old resident broker is
  // still serving the socket.  In that case source/install hashes already
  // match, but the previous sync receipt is explicitly deferred at a busy
  // boundary.  Treat that receipt as a one-shot pending refresh marker so the
  // next idle LaunchAgent tick retries the supported restart automatically.
  const pendingReceiptPath = join(dirname(installed), "control-plane-sync-receipt.json");
  const pendingReceipt = await readJson(pendingReceiptPath).catch(() => null);
  const pendingRefresh = pendingReceipt?.sourceRoot === source
    && (pendingReceipt?.result === "deferred"
      || pendingReceipt?.result === "applied_pending_refresh"
      || pendingReceipt?.extensionRefresh?.result === "deferred");
  if (comparison.match && !force && !pendingRefresh) {
    return {
      schema: "aos.chrome_companion.control_plane_auto_sync.v1",
      attempted: false,
      result: "already_current",
      trigger,
      comparison,
      pendingRefresh: false,
      externalActionExecuted: false,
      noReplay: true,
      exactBlocker: null,
    };
  }
  if (!/^[a-p]{32}$/u.test(String(extensionId || ""))) {
    return {
      schema: "aos.chrome_companion.control_plane_auto_sync.v1",
      attempted: false,
      result: "deferred",
      trigger,
      comparison,
      externalActionExecuted: false,
      noReplay: true,
      exactBlocker: "companion_extension_id_invalid",
    };
  }
  const commandResult = await runCommand(
    nodeExecutable,
    [script, "--apply", "--restart-broker", "--extension-id", String(extensionId)],
    {
      env: {
        ...environment,
        AOS_CHROME_COMPANION_SOURCE_ROOT: source,
        AOS_CHROME_COMPANION_INSTALL_ROOT: installed,
      },
      timeoutMs: CONTROL_PLANE_SYNC_TIMEOUT_MS,
    },
  );
  const receipt = parseCommandJson(commandResult);
  const result = receipt?.result || (commandResult?.code === 0 ? "restarted" : "deferred");
  const exactBlockers = Array.isArray(receipt?.exactBlockers)
    ? receipt.exactBlockers
    : commandResult?.exactBlocker
      ? [commandResult.exactBlocker]
      : commandResult?.code === 0 ? [] : ["control_plane_sync_failed"];
  return {
    schema: "aos.chrome_companion.control_plane_auto_sync.v1",
    attempted: true,
    result,
    trigger,
    comparison,
    receipt,
    command: { code: commandResult?.code ?? null, exactBlocker: commandResult?.exactBlocker ?? null },
    externalActionExecuted: false,
    noReplay: true,
    exactBlocker: exactBlockers[0] ?? null,
    exactBlockers,
    pendingRefresh,
    forced: force || pendingRefresh,
    reflected: ["applied", "restarted"].includes(result)
      && receipt?.extensionRefresh?.result !== "deferred"
      && receipt?.statusAfter?.connectedProfileCount !== 0,
  };
}

function extensionInstalled(settings, extensionId) {
  const entry = settings?.extensions?.settings?.[extensionId];
  if (!entry || typeof entry !== "object") return false;
  if (entry.state === 0) return false;
  if (Array.isArray(entry.disable_reasons) && entry.disable_reasons.length > 0) return false;
  return Boolean(entry.path || entry.manifest || entry.location !== undefined || entry.creation_flags !== undefined);
}

export async function detectTwoExtensionProfile({ chromeUserDataDir, companionExtensionId = DEFAULT_COMPANION_EXTENSION_ID } = {}) {
  const entries = await readdir(chromeUserDataDir, { withFileTypes: true }).catch((error) => {
    if (error?.code === "ENOENT") return [];
    throw error;
  });
  const profiles = [];
  for (const entry of entries) {
    if (!entry.isDirectory() || (entry.name !== "Default" && !/^Profile \d+$/u.test(entry.name))) continue;
    const settings = await readJson(join(chromeUserDataDir, entry.name, "Secure Preferences"));
    if (!settings) continue;
    const officialExtensionId = OFFICIAL_CHROME_EXTENSION_IDS.find((id) => extensionInstalled(settings, id)) ?? null;
    profiles.push({
      directory: entry.name,
      officialExtensionId,
      companionExtensionId: extensionInstalled(settings, companionExtensionId) ? companionExtensionId : null,
    });
  }
  const common = profiles.filter((profile) => profile.officialExtensionId && profile.companionExtensionId);
  const selected = common.find((profile) => profile.directory === "Profile 2")
    ?? (common.length === 1 ? common[0] : null);
  const companionProfiles = profiles.filter((profile) => profile.companionExtensionId);
  const selectedCompanion = companionProfiles.find((profile) => profile.directory === "Profile 2")
    ?? (companionProfiles.length === 1 ? companionProfiles[0] : null);
  return {
    profiles,
    common,
    selected,
    companionProfiles,
    selectedCompanion,
    installed: {
      official: profiles.some((profile) => Boolean(profile.officialExtensionId)),
      companion: profiles.some((profile) => Boolean(profile.companionExtensionId)),
      officialProfiles: profiles.filter((profile) => profile.officialExtensionId).map((profile) => profile.directory),
      companionProfiles: profiles.filter((profile) => profile.companionExtensionId).map((profile) => profile.directory),
    },
  };
}

function manifestCandidatePaths(homePath, name) {
  return [
    join(homePath, "Library", "Application Support", "Google", "Chrome", "NativeMessagingHosts", `${name}.json`),
    join("/Library", "Google", "Chrome", "NativeMessagingHosts", `${name}.json`),
  ];
}

async function executable(path) {
  try {
    await access(path, fsConstants.X_OK);
    return true;
  } catch {
    return false;
  }
}

async function verifyNativeHost({ homePath, name, extensionId }) {
  for (const path of manifestCandidatePaths(homePath, name)) {
    const manifest = await readJson(path).catch(() => null);
    if (!manifest) continue;
    const origin = `chrome-extension://${extensionId}/`;
    const ok = manifest.name === name
      && manifest.type === "stdio"
      && typeof manifest.path === "string"
      && resolve(manifest.path) === manifest.path
      && Array.isArray(manifest.allowed_origins)
      && manifest.allowed_origins.includes(origin)
      && await executable(manifest.path);
    return { ok, path, executable: manifest.path ?? null, exactBlocker: ok ? null : `native_host_invalid:${name}` };
  }
  return { ok: false, path: null, executable: null, exactBlocker: `native_host_missing:${name}` };
}

async function ensureCompanionNativeHost({ homePath, sourceRoot, extensionId, nodeExecutable, environment }) {
  const supportDir = environment.AOS_CHROME_COMPANION_DATA_DIR
    || join(homePath, "Library", "Application Support", "AOS Chrome Companion");
  const binDir = join(supportDir, "bin");
  const wrapperPath = join(binDir, "aos-chrome-companion-host");
  const manifestPath = join(homePath, "Library", "Application Support", "Google", "Chrome", "NativeMessagingHosts", `${NATIVE_HOST_NAME}.json`);
  const extensionOrigin = `chrome-extension://${extensionId}/`;
  await assertNoSymlinkComponents(supportDir);
  await mkdir(binDir, { recursive: true, mode: 0o700 });
  const wrapper = [
    "#!/bin/sh",
    `AOS_CHROME_COMPANION_EXTENSION_ORIGIN=${JSON.stringify(extensionOrigin)} exec ${JSON.stringify(nodeExecutable)} ${JSON.stringify(join(sourceRoot, "src", "native-host", "main.mjs"))} "$@"`,
    "",
  ].join("\n");
  const currentWrapper = await readFile(wrapperPath, "utf8").catch(() => null);
  let changed = false;
  if (currentWrapper !== wrapper) {
    await assertNoSymlinkComponents(wrapperPath);
    await writeFile(wrapperPath, wrapper, { mode: 0o700 });
    await chmod(wrapperPath, 0o700);
    changed = true;
  }
  const desiredManifest = {
    name: NATIVE_HOST_NAME,
    description: "AOS Chrome Companion native relay",
    path: wrapperPath,
    type: "stdio",
    allowed_origins: [extensionOrigin],
  };
  const currentManifest = await readJson(manifestPath).catch(() => null);
  if (JSON.stringify(currentManifest) !== JSON.stringify(desiredManifest)) {
    await atomicJson(manifestPath, desiredManifest);
    changed = true;
  }
  return { ok: true, changed, manifestPath, wrapperPath };
}

function parsePluginList(result) {
  if (result.code !== 0) return null;
  try {
    const parsed = JSON.parse(result.stdout || "{}");
    return Array.isArray(parsed.installed) ? parsed.installed : [];
  } catch {
    return null;
  }
}

function installedPlugin(entries, name, marketplaceName) {
  return entries.find((entry) => entry?.name === name
    && (!marketplaceName || entry?.marketplaceName === marketplaceName)
    && entry?.installed !== false
    && entry?.enabled !== false) ?? null;
}

export async function resolveCodexCommand(environment, executableExists = async (path) => {
  try { await access(path, fsConstants.X_OK); return (await stat(path)).isFile(); } catch { return false; }
}) {
  const explicit = String(environment.CODEX_CLI_PATH || "").trim();
  if (explicit) return explicit;
  // Native Messaging inherits Chrome's minimal PATH, not the user's shell.
  const candidates = [
    ...String(environment.PATH || "").split(delimiter).filter(isAbsolute).map((dir) => join(dir, "codex")),
    "/usr/local/bin/codex", "/opt/homebrew/bin/codex",
    "/Applications/Codex.app/Contents/Resources/codex",
    "/Applications/ChatGPT.app/Contents/Resources/codex",
  ];
  for (const candidate of new Set(candidates)) if (await executableExists(candidate)) return candidate;
  return "codex";
}

async function ensureCodexPlugins({ sourceRoot, environment, runCommand }) {
  // npm's Codex launcher uses /usr/bin/env node. Supply this already-running
  // Node runtime only to the child CLI, without changing Chrome/system PATH.
  const commandEnvironment = { ...environment, PATH: [dirname(process.execPath), environment.PATH || "/usr/bin:/bin"].join(delimiter) };
  const changes = [];
  const blockers = [];
  const codexCommand = await resolveCodexCommand(environment);
  let listedResult = await runCommand(codexCommand, ["plugin", "list", "--json"], { env: commandEnvironment });
  let entries = parsePluginList(listedResult);
  if (!entries) {
    return { ok: false, changes, exactBlockers: [listedResult.exactBlocker || "codex_plugin_list_failed"], official: false, companion: false };
  }
  const installationNeeded = !installedPlugin(entries, "chrome", "openai-bundled")
    || !installedPlugin(entries, "aos-chrome-companion", MARKETPLACE_NAME);
  if (!installedPlugin(entries, "chrome", "openai-bundled")) {
    const added = await runCommand(codexCommand, ["plugin", "add", "chrome@openai-bundled"], { env: commandEnvironment });
    if (added.code === 0) changes.push("official_codex_chrome_plugin_installed");
    else blockers.push(added.exactBlocker || "official_codex_chrome_plugin_install_failed");
  }
  if (!installedPlugin(entries, "aos-chrome-companion", MARKETPLACE_NAME)) {
    const marketplacePath = join(sourceRoot, ".agents", "plugins", "marketplace.json");
    if (!await exists(marketplacePath)) {
      blockers.push("companion_local_marketplace_missing");
    } else {
      const marketplace = await runCommand(codexCommand, ["plugin", "marketplace", "add", sourceRoot], { env: commandEnvironment });
      const marketplaceReady = marketplace.code === 0 || /already|exists|configured/iu.test(`${marketplace.stdout} ${marketplace.stderr}`);
      if (!marketplaceReady) blockers.push(marketplace.exactBlocker || "companion_marketplace_install_failed");
      else {
        const added = await runCommand(codexCommand, ["plugin", "add", `aos-chrome-companion@${MARKETPLACE_NAME}`], { env: commandEnvironment });
        if (added.code === 0) changes.push("companion_codex_plugin_installed");
        else blockers.push(added.exactBlocker || "companion_codex_plugin_install_failed");
      }
    }
  }
  if (installationNeeded) {
    listedResult = await runCommand(codexCommand, ["plugin", "list", "--json"], { env: commandEnvironment });
    entries = parsePluginList(listedResult) ?? [];
  }
  const official = Boolean(installedPlugin(entries, "chrome", "openai-bundled"));
  const companion = Boolean(installedPlugin(entries, "aos-chrome-companion", MARKETPLACE_NAME));
  if (!official && !blockers.some((item) => item.includes("official_codex"))) blockers.push("official_codex_chrome_plugin_not_enabled");
  if (!companion && !blockers.some((item) => item.includes("companion"))) blockers.push("companion_codex_plugin_not_enabled");
  return { ok: official && companion && blockers.length === 0, changes, exactBlockers: blockers, official, companion };
}

// The minute tick still checks Extensions, native hosts, routing, code drift
// and deferred refresh. Only the expensive CLI inventory may reuse a recent
// successful read, invalidated immediately by local configuration changes.
async function pluginVerificationFingerprint({ environment, homePath, sourceRoot }) {
  const codexHome = environment.CODEX_HOME || join(homePath, ".codex");
  const codexCommand = await resolveCodexCommand(environment);
  const paths = [join(codexHome, "config.toml"), join(codexHome, "plugins", "cache", "openai-bundled", "chrome"),
    join(codexHome, "plugins", "cache", MARKETPLACE_NAME, "aos-chrome-companion"),
    join(sourceRoot, ".agents", "plugins", "marketplace.json"), codexCommand];
  const metadata = await Promise.all(paths.map(async (path) => {
    try { const value = await stat(path); return [path, value.dev, value.ino, value.size, value.mtimeMs, value.ctimeMs]; }
    catch (error) { if (error?.code === "ENOENT") return [path, "missing"]; throw error; }
  }));
  return createHash("sha256").update(JSON.stringify(metadata)).digest("hex");
}

function selectorCore(payload) {
  if (!payload || typeof payload !== "object") return null;
  const { updated_at: _updatedAt, ...rest } = payload;
  return rest;
}

async function ensureAdaptiveSelector({ environment, homePath, profileDirectory }) {
  const path = environment.AOS_WEB_OPERATION_BACKEND_CONFIG
    || environment.AUTOMATION_OS_WEB_OPERATION_BACKEND_CONFIG
    || join(homePath, ".social-flow", "web-operation-backend.json");
  const existing = await readJson(path).catch(() => null);
  const priorRevision = Number(existing?.revision);
  const revision = Number.isSafeInteger(priorRevision) && priorRevision > 0 ? priorRevision : 2;
  const preserveNonChrome = existing?.backend === "browser_use_cli" || existing?.backend === "playwright";
  const backend = preserveNonChrome ? existing.backend : "aos_chrome_companion";
  const chromeProfile = {
    id: profileDirectory.toLowerCase().replaceAll(" ", ""),
    name: profileDirectory,
    directory: profileDirectory,
    surface: "signed_chrome_extension_profile2",
  };
  const backendChanged = Boolean(existing) && (existing.backend !== backend
    || existing?.chrome_profile?.directory !== profileDirectory);
  const payload = {
    schema: "web_operation_backend_config.v1",
    source: "automation_os",
    backend,
    revision: backendChanged ? revision + 1 : revision,
    route_authority: "adaptive_two_extension_resolver",
    routing_mode: "adaptive_two_extension",
    preferred_backend: backend,
    backend_role: "preferred_backend_not_final_route",
    browser_surface: backend === "aos_chrome_companion" ? "aos_chrome_companion_profile_instance" : backend,
    preferred_browser_surface: backend === "aos_chrome_companion" ? "aos_chrome_companion_profile_instance" : backend,
    browser_surface_role: "preferred_surface_not_run_proof",
    chrome_profile_surface_role: "profile_metadata_only_not_route_authority",
    routing_policy: ROUTING_POLICY,
    chrome_profile: chromeProfile,
    updated_at: existing?.updated_at || new Date().toISOString(),
  };
  const changed = JSON.stringify(selectorCore(existing)) !== JSON.stringify(selectorCore(payload));
  if (changed) {
    payload.updated_at = new Date().toISOString();
    await atomicJson(path, payload);
  }
  return { ok: true, changed, path, backend: payload.backend, revision: payload.revision };
}

async function acquireSetupLock(lockPath) {
  await mkdir(dirname(lockPath), { recursive: true, mode: 0o700 });
  try {
    const handle = await open(lockPath, "wx", 0o600);
    await handle.writeFile(`${process.pid}\n`);
    await handle.close();
    return true;
  } catch (error) {
    if (error?.code !== "EEXIST") throw error;
    const value = await stat(lockPath).catch(() => null);
    if (value && Date.now() - value.mtimeMs > SETUP_LOCK_STALE_MS) {
      await rm(lockPath, { force: true });
      return acquireSetupLock(lockPath);
    }
    return false;
  }
}

export async function convergeCompanionSetup(options = {}) {
  const environment = options.environment || process.env;
  const homePath = options.homePath || homedir();
  const platform = options.platform || process.platform;
  const sourceRoot = resolve(options.sourceRoot || fileURLToPath(new URL("../..", import.meta.url)));
  const installedRoot = resolve(
    options.installedRoot
      || environment.AOS_CHROME_COMPANION_INSTALL_ROOT
      || sourceRoot,
  );
  // The installed app normally resolves its own copy as sourceRoot.  A local
  // development build may additionally point at the checkout so the
  // launch-agent can detect source drift and invoke the supported signed
  // refresh path automatically.
  const syncSourceRoot = resolve(
    options.syncSourceRoot
      || environment.AOS_CHROME_COMPANION_SOURCE_ROOT
      || sourceRoot,
  );
  const dataDir = environment.AOS_CHROME_COMPANION_DATA_DIR
    || join(homePath, "Library", "Application Support", "AOS Chrome Companion");
  const statePath = options.statePath || join(dataDir, "setup-state.json");
  const lockPath = options.lockPath || join(dataDir, "setup.lock");
  if (platform !== "darwin") {
    const unsupported = {
      schema: AUTO_SETUP_SCHEMA,
      setup_complete: false,
      companion_ready: false,
      integration_ready: false,
      checked_at: new Date().toISOString(),
      trigger: options.trigger || "unknown",
      exact_blockers: ["auto_setup_macos_only"],
      next_action: "Install the platform-specific Companion product bootstrap.",
    };
    if (options.writeState !== false) await atomicJson(statePath, unsupported);
    return unsupported;
  }
  if (!await acquireSetupLock(lockPath)) {
    return await readJson(statePath) || {
      schema: AUTO_SETUP_SCHEMA,
      setup_complete: false,
      companion_ready: false,
      integration_ready: false,
      checked_at: new Date().toISOString(),
      trigger: options.trigger || "unknown",
      exact_blockers: ["auto_setup_convergence_in_progress"],
      next_action: "Wait for the current setup convergence to finish.",
    };
  }
  try {
    const companionExtensionId = options.companionExtensionId || environment.AOS_CHROME_COMPANION_EXTENSION_ID || DEFAULT_COMPANION_EXTENSION_ID;
    const chromeUserDataDir = options.chromeUserDataDir
      || join(homePath, "Library", "Application Support", "Google", "Chrome");
    const detection = await detectTwoExtensionProfile({ chromeUserDataDir, companionExtensionId });
    const selected = detection.selected;
    const companionSelected = detection.selectedCompanion;
    const changes = [];
    const exactBlockers = [];
    if (!selected?.officialExtensionId) exactBlockers.push("official_chrome_extension_not_installed_in_common_profile");
    if (!companionSelected?.companionExtensionId) exactBlockers.push("companion_chrome_extension_not_installed_in_profile");
    if (detection.common.length > 1 && !detection.common.some((item) => item.directory === "Profile 2")) {
      exactBlockers.push("multiple_common_chrome_profiles_require_explicit_binding");
    }
    if (selected && selected.directory !== "Profile 2") {
      exactBlockers.push(`chrome_profile2_required_for_current_aos_contract:${selected.directory}`);
    }
    if (companionSelected && companionSelected.directory !== "Profile 2") {
      exactBlockers.push(`chrome_profile2_required_for_companion:${companionSelected.directory}`);
    }

    const companionNativeHost = await ensureCompanionNativeHost({
      homePath,
      sourceRoot: installedRoot,
      extensionId: companionExtensionId,
      nodeExecutable: options.nodeExecutable || process.execPath,
      environment,
    });
    if (companionNativeHost.changed) changes.push("companion_native_host_reconciled");
    const officialNativeHost = selected?.officialExtensionId
      ? await verifyNativeHost({ homePath, name: OFFICIAL_NATIVE_HOST_NAME, extensionId: selected.officialExtensionId })
      : { ok: false, path: null, executable: null, exactBlocker: "official_native_host_waiting_for_extension" };
    if (!officialNativeHost.ok) exactBlockers.push(officialNativeHost.exactBlocker);

    let plugins = { ok: false, changes: [], exactBlockers: ["two_extension_profile_not_ready"], official: false, companion: false };
    let selector = { ok: false, changed: false, path: null, backend: null, revision: null };
    let controlPlaneSync = {
      schema: "aos.chrome_companion.control_plane_auto_sync.v1",
      attempted: false,
      result: "not_ready",
      trigger: options.trigger || "manual",
      externalActionExecuted: false,
      noReplay: true,
      exactBlocker: null,
    };
    if (companionSelected?.directory === "Profile 2") {
      const now = options.now?.() ?? Date.now();
      const fingerprint = await pluginVerificationFingerprint({ environment, homePath, sourceRoot });
      const previous = await readJson(statePath);
      const cached = previous?.components?.plugin_verification;
      const age = now - Date.parse(cached?.verified_at ?? "");
      const reuse = options.trigger === "launch_agent"
        && previous?.components?.official_codex_plugin?.installed === true
        && previous?.components?.companion_codex_plugin?.installed === true
        && cached?.fingerprint === fingerprint && cached?.ok === true
        && age >= 0 && age < PLUGIN_RECHECK_MS;
      if (reuse) {
        plugins = { ok: true, changes: [], exactBlockers: [], official: true, companion: true,
          verification: { ...cached, reused: true } };
      } else {
        plugins = await ensureCodexPlugins({ sourceRoot, environment, runCommand: options.runCommand || runSetupCommand });
        plugins.verification = { ok: plugins.ok, fingerprint, verified_at: new Date(now).toISOString(), reused: false };
      }
      changes.push(...plugins.changes);
      exactBlockers.push(...plugins.exactBlockers);
      selector = await ensureAdaptiveSelector({ environment, homePath, profileDirectory: companionSelected.directory });
      if (selector.changed) changes.push("adaptive_two_extension_selector_reconciled");
      if (companionSelected.companionExtensionId) {
        controlPlaneSync = await requestAutomaticControlPlaneSync({
          sourceRoot: syncSourceRoot,
          installedRoot,
          extensionId: companionSelected.companionExtensionId,
          environment,
          runCommand: options.runCommand || runSetupCommand,
          trigger: options.trigger || "manual",
          nodeExecutable: options.nodeExecutable || process.execPath,
        });
        if (controlPlaneSync.result === "applied" || controlPlaneSync.result === "restarted") {
          changes.push("companion_control_plane_reflected");
        } else if (controlPlaneSync.attempted && controlPlaneSync.exactBlockers?.length) {
          exactBlockers.push(...controlPlaneSync.exactBlockers);
        }
      }
    }
    const setupComplete = Boolean(selected)
      && selected.directory === "Profile 2"
      && officialNativeHost.ok
      && companionNativeHost.ok
      && plugins.ok
      && selector.ok
      && exactBlockers.length === 0;
    const companionReady = Boolean(companionSelected)
      && companionSelected.directory === "Profile 2"
      && companionNativeHost.ok
      && plugins.companion === true
      && selector.ok;
    const controlPlaneBlocker = controlPlaneSync.exactBlocker || controlPlaneSync.exactBlockers?.[0] || null;
    const nextAction = setupComplete
      ? "No manual setup is required. Keep both Chrome Extensions enabled; new browser stages resolve the Extension automatically."
      : controlPlaneBlocker === "logical_sessions_active"
        ? "The current task remains untouched. After its logical session closes, the LaunchAgent will refresh the control plane and read back a new generation automatically."
        : controlPlaneBlocker
          ? `Automatic control-plane refresh is deferred (${controlPlaneBlocker}); the LaunchAgent will retry at the next idle boundary.`
          : !plugins.ok && companionSelected
            ? `Codex plugin setup failed (${plugins.exactBlockers?.[0] ?? "codex_plugin_list_failed"}); verify CODEX_CLI_PATH or the installed Codex CLI. Companion remains installed while integration is pending.`
          : detection.installed.companion && detection.installed.official
            ? "For two-extension integration, enable both Chrome Extensions in the same Profile 2. Companion remains independently installed and usable while convergence is pending."
            : detection.installed.companion
              ? "Companion is installed and can operate independently. Install and enable the official Chrome Extension in Profile 2 to complete two-extension integration."
              : detection.installed.official
                ? "The official Chrome Extension is installed. Install and enable Companion in Profile 2 to complete two-extension integration."
                : "Install and enable Companion and the official Chrome Extension in Profile 2 to complete two-extension integration.";
    const state = {
      schema: AUTO_SETUP_SCHEMA,
      setup_complete: setupComplete,
      companion_ready: companionReady,
      integration_ready: setupComplete,
      checked_at: new Date().toISOString(),
      trigger: options.trigger || "manual",
      profile_directory: selected?.directory ?? companionSelected?.directory ?? null,
      components: {
        official_chrome_extension: { installed: detection.installed.official, extension_id: selected?.officialExtensionId ?? null, profile_directories: detection.installed.officialProfiles },
        companion_chrome_extension: { installed: detection.installed.companion, extension_id: selected?.companionExtensionId ?? companionExtensionId, profile_directories: detection.installed.companionProfiles },
        official_native_host: officialNativeHost,
        companion_native_host: companionNativeHost,
        plugin_verification: plugins.verification ?? null,
        official_codex_plugin: { installed: plugins.official },
        companion_codex_plugin: { installed: plugins.companion },
        adaptive_selector: selector,
        control_plane_sync: controlPlaneSync,
      },
      changes,
      exact_blockers: [...new Set(exactBlockers.filter(Boolean))],
      activation_boundary: "new_codex_tasks_load_newly_installed_plugin_tools",
      next_action: nextAction,
    };
    if (options.writeState !== false) await atomicJson(statePath, state);
    return state;
  } catch (error) {
    const state = {
      schema: AUTO_SETUP_SCHEMA,
      setup_complete: false,
      companion_ready: false,
      integration_ready: false,
      checked_at: new Date().toISOString(),
      trigger: options.trigger || "unknown",
      exact_blockers: [`auto_setup_failed:${errorText(error)}`],
      next_action: "Keep both Extensions enabled and inspect the setup-state receipt before retrying.",
    };
    if (options.writeState !== false) await atomicJson(statePath, state).catch(() => {});
    return state;
  } finally {
    await rm(lockPath, { force: true }).catch(() => {});
  }
}
