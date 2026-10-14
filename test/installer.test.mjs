import assert from "node:assert/strict";
import { chmod, lstat, mkdir, mkdtemp, readFile, readdir, realpath, rename, rm, writeFile } from "node:fs/promises";
import { resolve, join } from "node:path";
import { tmpdir } from "node:os";
import { randomUUID } from "node:crypto";
import { runInNewContext } from "node:vm";
import test from "node:test";

test("installer source stamp rollback restores only its own exact write; conflicts and failed writes preserve originals", async () => {
  const root = await realpath(await mkdtemp(join(tmpdir(), "companion-installer-rollback-")));
  try {
    const source = await readFile(resolve("scripts/install-local-macos.mjs"), "utf8");
    const helpers = source.slice(source.indexOf("async function stampSourceExtensionBuildId("), source.indexOf("const { extensionId, installCodexPlugin }"));
    const path = join(root, "build-info.js");
    await writeFile(path, "original build metadata\n");
    const context = { readFile, writeFile, lstat, chmod, rename, rm, join, process, randomUUID,
      assertNoSymlinkComponents: async (target) => { if ((await lstat(target)).isSymbolicLink()) throw new Error("symlink"); },
      buildInfoSource: (build) => `build:${build}\n` };
    const api = runInNewContext(`${helpers}\n({ stampSourceExtensionBuildId, rollbackSourceExtensionBuildId })`, context);
    const stamp = await api.stampSourceExtensionBuildId(root, "fixture-build", null);
    assert.equal(await readFile(path, "utf8"), "build:fixture-build\n");
    await api.rollbackSourceExtensionBuildId(stamp);
    assert.equal(await readFile(path, "utf8"), "original build metadata\n");
    const conflicting = await api.stampSourceExtensionBuildId(root, "fixture-build-2", null);
    await writeFile(path, "concurrent writer\n");
    await assert.rejects(api.rollbackSourceExtensionBuildId(conflicting), /source_extension_build_info_rollback_conflict/u);
    assert.equal(await readFile(path, "utf8"), "concurrent writer\n");
    const failureApi = runInNewContext(`${helpers}\n({ stampSourceExtensionBuildId })`, { ...context, rename: async () => { throw Object.assign(new Error("permission denied"), { code: "EACCES" }); } });
    await assert.rejects(failureApi.stampSourceExtensionBuildId(root, "failed-build", null), /permission denied/u);
    assert.equal(await readFile(path, "utf8"), "concurrent writer\n");
    assert.deepEqual(await readdir(root), ["build-info.js"]);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("local installer packages one Companion product and keeps the two-extension release boundary", async () => {
  const source = await readFile(resolve("scripts/install-local-macos.mjs"), "utf8");
  const fsImport = source.match(/import \{([\s\S]*?)\} from "node:fs\/promises";/u)?.[1] ?? "";
  assert.match(fsImport, /\bopen\b/u);
  for (const entry of ["src", "extension", "plugins", "scripts", "package.json", "package-lock.json"]) {
    assert.match(source, new RegExp(`\\[?\\\"${entry}\\\"`));
  }
  assert.match(source, /AOS_CHROME_COMPANION_EXTENSION_ORIGIN/);
  assert.match(source, /NativeMessagingHosts/);
  assert.match(source, /\["plugin",\s*"marketplace",\s*"add"/);
  assert.match(source, /\["plugin",\s*"add"/);
  assert.match(source, /AOS Chrome Companion/);
  assert.match(source, /aos-chrome-companion-autosetup/);
  assert.match(source, /AOS_CHROME_COMPANION_SOURCE_ROOT/);
  assert.match(source, /AOS_CHROME_COMPANION_INSTALL_ROOT/);
  assert.match(source, /StartInterval/);
  assert.match(source, /launchctl/);
  assert.match(source, /codexPlugin/);
  assert.match(source, /plugin.*marketplace.*add/s);
  assert.match(source, /plugin.*add/s);
  assert.match(source, /setupComplete/);
  assert.match(source, /chrome_web_store_signed_extension_missing/);
  assert.match(source, /apple_developer_id_pkg_signature_missing/);
  assert.match(source, /notarization_missing/);
  assert.match(source, /bundled_node_runtime_missing/);
  assert.match(source, /installBuildId/);
  assert.match(source, /sourceExtensionRoot/);
  assert.match(source, /stampSourceExtensionBuildId/);
  assert.match(source, /rollbackSourceExtensionBuildId/);
  assert.match(source, /flag:\s*"wx"/u);
  assert.match(source, /sourceBuildInfoStamp\s*=\s*await\s+stampSourceExtensionBuildId/s);
  assert.match(source, /sourceBuildInfoStamp[\s\S]*?rename\(appDir, backupDir\)/s);
  assert.match(source, /rollbackOnFailure/);
  assert.match(source, /source_extension_build_info_not_regular_file/);
  assert.match(source, /source_extension_build_info_rollback_conflict/);
  assert.match(source, /buildInfoSource\(installBuildId, provenance\)/u);
  assert.match(source, /bundleTreeSha256/u);
  assert.match(source, /extensionTreeSha256/u);
  assert.match(source, /nativeRecorderSha256/u);
  assert.match(source, /aos_chrome_companion_build_manifest\.v1/u);
  assert.match(source, /sourceExtensionBuildInfoPath/);
  assert.match(source, /sourceExtensionBuildInfo:\s*\{/u);
  assert.match(source, /readInstalledBuildId\(appDir\)/u);
  assert.match(source, /previousInstallBuildId\s*\?\?\s*SOURCE_BUILD_ID/u);
  assert.match(source, /sync-control-plane-macos\.mjs.*--restart-broker/s);
  assert.match(source, /No manual Extension reload is required/u);
  assert.match(source, /src.*shared.*build-info\.mjs/);
  assert.match(source, /extension.*build-info\.js/);
  assert.match(source, /pruneApplicationBackups/);
  assert.match(source, /backupRetention/);
  assert.match(source, /autoSetupStdoutPath/);
  assert.match(source, /autoSetupStderrPath/);
  assert.match(source, /open\(logPath,\s*"a",\s*0o600\)/);
  assert.match(source, /chmod\(logPath,\s*0o600\)/);
  assert.match(source, /StandardOutPath.*autoSetupStdoutPath/s);
  assert.match(source, /StandardErrorPath.*autoSetupStderrPath/s);
  assert.doesNotMatch(source, /install.*third.*extension/iu);
  assert.doesNotMatch(source, /profile.*manual.*required/iu);

  const sourceBuildInfo = await readFile(resolve("extension/build-info.js"), "utf8");
  // A fresh source checkout uses dev-local; a local install may stamp its
  // unpacked extension to match the separately installed broker.
  assert.match(sourceBuildInfo, /INSTALL_BUILD_ID\s*=\s*"(?:dev-local|install-[0-9a-f-]{36})"/u);
  assert.match(sourceBuildInfo, /BUNDLE_TREE_SHA256\s*=\s*(?:null|"[a-f0-9]{64}")/u);

  const sync = await readFile(resolve("scripts/sync-control-plane-macos.mjs"), "utf8");
  assert.match(sync, /refreshExtensionBeforeRestart/u);
  assert.match(sync, /updateAutoSetupWrapper/u);
  assert.match(sync, /AOS_CHROME_COMPANION_SOURCE_ROOT/u);
  assert.match(sync, /AOS_CHROME_COMPANION_INSTALL_ROOT/u);
  assert.match(sync, /extensionRefresh\?\.result\s*!==\s*"reflected"/u);
  assert.match(sync, /companion_profile_not_connected_after_broker_restart/u);
  assert.match(sync, /do_not_repeat_extension_reload/u);
  assert.match(sync, /releaseOwnedLock/u);
  assert.match(sync, /process\.once\(signal/u);
  assert.match(sync, /releaseCompanionLock\(lockLease\)/u);
  assert.match(sync, /acquireCompanionLock\(lockPath/u);
  assert.match(sync, /priorReceiptEvidence: \{ current: false/u);
  assert.match(sync, /AOS_CHROME_COMPANION_MANAGED_CHILD=1/u);
  assert.match(source, /AOS_CHROME_COMPANION_MANAGED_CHILD_PROVENANCE=companion_autosetup_wrapper/u);
  for (const generator of [source, sync]) {
    assert.match(generator, /AOS_CHROME_COMPANION_MANAGED_CHILD=1 AOS_CHROME_COMPANION_MANAGED_CHILD_PROVENANCE=companion_native_host_wrapper AOS_CHROME_COMPANION_EXTENSION_ORIGIN=/u);
  }
  assert.match(sync, /receipt\.nativeHostWrapper = await updateNativeHostWrapper\(\{ supportDir, appDir, extensionId: args\.extensionId \}\)/u);
  assert.match(source, /resolveCompanionCodexSelection\(process\.env/u);
  assert.doesNotMatch(source, /run\("codex"/u);

  const server = await readFile(resolve("src/mcp/server.mjs"), "utf8");
  assert.match(server, /transport\.onerror/);
  assert.match(server, /transport\.onclose/);
  assert.match(server, /shutdown\("transport_closed"\)/);
  assert.match(server, /shuttingDown/);

  const broker = await readFile(resolve("src/broker/broker.mjs"), "utf8");
  const serviceWorker = await readFile(resolve("extension/service-worker.js"), "utf8");
  assert.match(broker, /buildProvenanceMismatches/u);
  assert.match(broker, /companion_build_refresh_required/u);
  assert.match(broker, /allowBuildMismatch: true/u);
  assert.doesNotMatch(broker, /throw new CompanionError\("extension_build_provenance_mismatch"/u);
  assert.match(broker, /componentHashes:\s*\{/u);
  assert.match(serviceWorker, /bundleTreeSha256:\s*BUNDLE_TREE_SHA256/u);
  assert.match(serviceWorker, /nativeRecorderSha256:\s*NATIVE_RECORDER_SHA256/u);

  const launcher = await readFile(resolve("plugins/aos-chrome-companion/scripts/start-mcp.mjs"), "utf8");
  assert.match(launcher, /MCP starting root=/);
  assert.match(launcher, /setup_error/);
  assert.match(launcher, /let started = false/);
  assert.match(launcher, /fileURLToPath\(new URL\("\.\.\/\.\.\/\.\.\/"/);
});
