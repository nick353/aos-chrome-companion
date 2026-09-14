import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import test from "node:test";

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
  assert.match(source, /writeFile\(join\(stagingDir, "src", "shared", "build-info\.mjs"\), buildInfoSource\(installBuildId\)/u);
  assert.match(source, /writeFile\(join\(stagingDir, "extension", "build-info\.js"\), buildInfoSource\(installBuildId\)/u);
  assert.match(source, /sourceExtensionBuildInfoPath/);
  assert.match(source, /sourceExtensionBuildInfo:\s*\{/u);
  assert.match(source, /readInstalledBuildId\(appDir\)/u);
  assert.match(source, /previousInstallBuildId\s*\?\?\s*`install-\$\{randomUUID\(\)\}`/u);
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

  const sync = await readFile(resolve("scripts/sync-control-plane-macos.mjs"), "utf8");
  assert.match(sync, /refreshExtensionBeforeRestart/u);
  assert.match(sync, /updateAutoSetupWrapper/u);
  assert.match(sync, /AOS_CHROME_COMPANION_SOURCE_ROOT/u);
  assert.match(sync, /AOS_CHROME_COMPANION_INSTALL_ROOT/u);
  assert.match(sync, /extensionRefresh\?\.result\s*!==\s*"reflected"/u);
  assert.match(sync, /companion_profile_not_connected_after_broker_restart/u);
  assert.match(sync, /do_not_repeat_extension_reload/u);

  const server = await readFile(resolve("src/mcp/server.mjs"), "utf8");
  assert.match(server, /transport\.onerror/);
  assert.match(server, /transport\.onclose/);
  assert.match(server, /shutdown\("transport_closed"\)/);
  assert.match(server, /shuttingDown/);

  const launcher = await readFile(resolve("plugins/aos-chrome-companion/scripts/start-mcp.mjs"), "utf8");
  assert.match(launcher, /MCP starting root=/);
  assert.match(launcher, /setup_error/);
  assert.match(launcher, /let started = false/);
  assert.match(launcher, /fileURLToPath\(new URL\("\.\.\/\.\.\/\.\.\/"/);
});
