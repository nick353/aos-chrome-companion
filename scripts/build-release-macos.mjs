#!/usr/bin/env node

import crypto from "node:crypto";
import { execFileSync, spawnSync } from "node:child_process";
import {
  access,
  chmod,
  cp,
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { NATIVE_HOST_NAME } from "../src/shared/constants.mjs";

const PRODUCT_ROOT = "/Library/Application Support/AOS Chrome Companion";
const NATIVE_MANIFEST_ROOT = "/Library/Google/Chrome/NativeMessagingHosts";
const LAUNCH_AGENT_ROOT = "/Library/LaunchAgents";
const AUTO_SETUP_LABEL = "com.nichikatanaka.aos-chrome-companion-autosetup";

function fail(code, message) {
  const error = new Error(message);
  error.code = code;
  throw error;
}

export async function stampReleaseBuildIdentity(applicationRoot, extensionRoot, buildId) {
  if (!/^release-[0-9a-f-]{36}$/u.test(buildId)) fail("release_build_id_invalid", "A release needs one generated build identity");
  const contents = `export const INSTALL_BUILD_ID = ${JSON.stringify(buildId)};\n`;
  const paths = [join(applicationRoot, "src", "shared", "build-info.mjs"),
    join(applicationRoot, "extension", "build-info.js"), join(extensionRoot, "build-info.js")];
  for (const path of paths) await writeFile(path, contents, { mode: 0o644 });
  for (const path of paths) if (await readFile(path, "utf8") !== contents) fail("release_build_identity_mismatch", "Broker and extension build identities differ");
}

export function parseReleaseArgs(argv) {
  const args = {};
  for (let index = 0; index < argv.length; index += 1) {
    const value = argv[index];
    if (value === "--extension-id") args.extensionId = argv[++index];
    else if (value === "--node-runtime") args.nodeRuntime = argv[++index];
    else if (value === "--node-license") args.nodeLicense = argv[++index];
    else if (value === "--output-dir") args.outputDir = argv[++index];
    else if (value === "--application-signing-identity") args.applicationSigningIdentity = argv[++index];
    else if (value === "--installer-signing-identity") args.installerSigningIdentity = argv[++index];
    else if (value === "--notary-profile") args.notaryProfile = argv[++index];
    else fail("release_argument_invalid", `Unknown argument: ${value}`);
  }
  if (!/^[a-p]{32}$/u.test(args.extensionId || "")) {
    fail("release_extension_id_invalid", "--extension-id must be a 32-character Chrome Extension ID");
  }
  return args;
}

function run(command, args, options = {}) {
  try {
    const output = execFileSync(command, args, {
      cwd: options.cwd,
      encoding: "utf8",
      env: options.env || process.env,
      input: options.input,
      stdio: options.capture === false ? "inherit" : [options.input === undefined ? "ignore" : "pipe", "pipe", "pipe"],
    });
    return typeof output === "string" ? output.trim() : "";
  } catch (error) {
    const stderr = String(error?.stderr || "").trim();
    const stdout = String(error?.stdout || "").trim();
    fail(options.code || "release_command_failed", `${command} failed: ${stderr || stdout || error.message}`);
  }
}

async function exists(path) {
  try { await access(path); return true; } catch { return false; }
}

async function assertNoSymlinks(root) {
  const stat = await lstat(root);
  if (stat.isSymbolicLink()) fail("release_symlink_rejected", `Symlink is not allowed: ${root}`);
  if (!stat.isDirectory()) return;
  for (const entry of await readdir(root, { withFileTypes: true })) {
    await assertNoSymlinks(join(root, entry.name));
  }
}

async function listFiles(root, relative = "") {
  const result = [];
  for (const entry of await readdir(join(root, relative), { withFileTypes: true })) {
    const next = join(relative, entry.name);
    if (entry.isDirectory()) result.push(...await listFiles(root, next));
    else if (entry.isFile()) result.push(next);
    else fail("release_non_regular_file_rejected", `Unsupported release entry: ${join(root, next)}`);
  }
  return result.sort();
}

async function sha256(path) {
  return crypto.createHash("sha256").update(await readFile(path)).digest("hex");
}

function nodeArchitecture(runtime) {
  return run(runtime, ["-p", "process.arch"], { code: "release_node_runtime_unusable" });
}

export function verifyStandaloneNodeDependencies(output) {
  const dependencies = String(output).split("\n").slice(1)
    .map(line => line.trim().replace(/\s+\(compatibility version.*$/u, "")).filter(Boolean);
  if (dependencies.length === 0) fail("release_node_dependencies_unverified", "otool did not report the Node runtime dependencies");
  const external = dependencies.filter(path => !path.startsWith("/usr/lib/") && !path.startsWith("/System/Library/"));
  if (external.length > 0) fail("release_node_not_standalone", `Node depends on libraries outside macOS: ${external.join(", ")}. Use an official standalone Node binary.`);
  return dependencies;
}

export function prepareRuntimeEntitlements(entitlements) {
  if (!entitlements || typeof entitlements !== "object" || Array.isArray(entitlements)) fail("release_runtime_entitlements_invalid", "Node entitlements must be a property-list dictionary");
  const prepared = structuredClone(entitlements);
  delete prepared["com.apple.security.get-task-allow"];
  return prepared;
}

export function inspectRuntimeSignature(runtime) {
  const display = spawnSync("/usr/bin/codesign", ["-d", "--verbose=4", runtime], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
  if (display.status !== 0) {
    if (/code object is not signed at all/u.test(String(display.stderr))) return { valid: false, unsigned: true, entitlements: {}, authorities: [] };
    fail("release_runtime_signature_unreadable", String(display.stderr || display.error?.message));
  }
  const authorities = [...String(display.stderr).matchAll(/^Authority=(.+)$/gmu)].map(match => match[1]);
  const entitlementsXml = run("/usr/bin/codesign", ["-d", "--entitlements", ":-", runtime]);
  const entitlements = entitlementsXml ? JSON.parse(run("/usr/bin/plutil", ["-convert", "json", "-o", "-", "-"], { input: entitlementsXml })) : {};
  let valid = true;
  try { run("/usr/bin/codesign", ["--verify", "--strict", runtime]); } catch { valid = false; }
  return { valid, unsigned: false, authorities, hardened_runtime: /flags=.+\(.*runtime.*\)/u.test(display.stderr), entitlements,
    debug_entitlement_enabled: entitlements["com.apple.security.get-task-allow"] === true };
}

export async function buildMacosRelease(args) {
  if (process.platform !== "darwin") fail("release_macos_required", "macOS is required to build the installer package");
  const sourceRoot = resolve(fileURLToPath(new URL("..", import.meta.url)));
  const packageJson = JSON.parse(await readFile(join(sourceRoot, "package.json"), "utf8"));
  const version = String(packageJson.version || "").trim();
  const buildId = `release-${crypto.randomUUID()}`;
  if (!/^\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?$/u.test(version)) fail("release_version_invalid", "package.json version is invalid");

  const nodeRuntime = resolve(args.nodeRuntime || process.execPath);
  await assertNoSymlinks(nodeRuntime);
  const nodeDependencies = verifyStandaloneNodeDependencies(run("/usr/bin/otool", ["-L", nodeRuntime]));
  const nodeLicense = resolve(args.nodeLicense || join(dirname(dirname(nodeRuntime)), "LICENSE"));
  if (!await exists(nodeLicense)) fail("release_node_license_missing", "Include the Node distribution LICENSE with --node-license");
  await assertNoSymlinks(nodeLicense);
  if (!(await lstat(nodeLicense)).isFile() || !/copyright/iu.test(await readFile(nodeLicense, "utf8"))) fail("release_node_license_invalid", "The Node license must be a regular distribution LICENSE file");
  const architecture = nodeArchitecture(nodeRuntime);
  if (!new Set(["x64", "arm64"]).has(architecture)) fail("release_node_architecture_unsupported", `Unsupported Node architecture: ${architecture}`);
  const outputDir = resolve(args.outputDir || join(sourceRoot, "outputs", "release", `${version}-${architecture}`));
  if (await exists(outputDir)) fail("release_output_exists", `Release output already exists: ${outputDir}`);
  await mkdir(dirname(outputDir), { recursive: true, mode: 0o755 });

  for (const entry of ["src", "extension", "plugins", "scripts", "package.json", "package-lock.json", "README.md", "PROJECT_DESIGN.md"]) {
    await assertNoSymlinks(join(sourceRoot, entry));
  }

  const staging = await mkdtemp(join(tmpdir(), "aos-companion-release-"));
  const stagedOutput = join(staging, "output");
  const payloadRoot = join(staging, "payload");
  const productRoot = join(payloadRoot, PRODUCT_ROOT);
  const applicationRoot = join(productRoot, "app");
  const runtimeRoot = join(productRoot, "runtime");
  const binRoot = join(productRoot, "bin");
  const nativeManifestRoot = join(payloadRoot, NATIVE_MANIFEST_ROOT);
  const launchAgentRoot = join(payloadRoot, LAUNCH_AGENT_ROOT);
  const extensionStage = join(staging, "extension");
  await mkdir(stagedOutput, { recursive: true, mode: 0o755 });

  try {
    for (const entry of ["src", "extension", "plugins", "scripts", "package.json", "package-lock.json", "README.md", "PROJECT_DESIGN.md"]) {
      await cp(join(sourceRoot, entry), join(applicationRoot, entry), { recursive: true, force: false, errorOnExist: true });
    }
    run("npm", ["ci", "--omit=dev", "--ignore-scripts", "--no-audit", "--no-fund"], {
      cwd: applicationRoot,
      capture: false,
      code: "release_dependency_install_failed",
    });

    await mkdir(runtimeRoot, { recursive: true, mode: 0o755 });
    const bundledNode = join(runtimeRoot, "node");
    await cp(nodeRuntime, bundledNode, { force: false, errorOnExist: true });
    await cp(nodeLicense, join(runtimeRoot, "LICENSE"), { force: false, errorOnExist: true });
    await chmod(bundledNode, 0o755);
    const sourceRuntimeSignature = inspectRuntimeSignature(bundledNode);
    if (args.applicationSigningIdentity) {
      const entitlementsPath = join(staging, "node-distribution-entitlements.plist");
      run("/usr/bin/plutil", ["-convert", "xml1", "-o", entitlementsPath, "-"], {
        input: JSON.stringify(prepareRuntimeEntitlements(sourceRuntimeSignature.entitlements)),
      });
      run("codesign", [
        "--force", "--options", "runtime", "--timestamp", "--entitlements", entitlementsPath,
        "--sign", args.applicationSigningIdentity, bundledNode,
      ], { code: "release_application_signing_failed" });
      run("codesign", ["--verify", "--strict", "--verbose=2", bundledNode], { code: "release_application_signature_invalid" });
    }
    const runtimeSignature = inspectRuntimeSignature(bundledNode);
    const applicationSigned = Boolean(args.applicationSigningIdentity) && runtimeSignature.valid && runtimeSignature.hardened_runtime
      && runtimeSignature.authorities.some(authority => authority.startsWith("Developer ID Application:"))
      && runtimeSignature.debug_entitlement_enabled !== true;
    if (args.applicationSigningIdentity && !applicationSigned) fail("release_developer_id_application_signature_invalid", "Distribution signing must produce a valid hardened Developer ID Application signature without get-task-allow");
    const bundledNodeVersion = run(bundledNode, ["--version"], { env: { PATH: "/usr/bin:/bin" }, code: "release_bundled_node_unusable" });
    // Exercise V8 after re-signing so a version-only probe cannot hide missing JIT entitlements.
    run(bundledNode, ["-e", "let x=0; for(let i=0;i<100000;i++) x+=i; if(x!==4999950000) process.exit(1)"], { env: { PATH: "/usr/bin:/bin" }, code: "release_bundled_node_execution_failed" });

    await mkdir(binRoot, { recursive: true, mode: 0o755 });
    const installedNode = join(PRODUCT_ROOT, "runtime", "node");
    const installedHost = join(PRODUCT_ROOT, "app", "src", "native-host", "main.mjs");
    const wrapperPath = join(binRoot, "aos-chrome-companion-host");
    await writeFile(wrapperPath, [
      "#!/bin/sh",
      `AOS_CHROME_COMPANION_EXTENSION_ORIGIN=${JSON.stringify(`chrome-extension://${args.extensionId}/`)} exec ${JSON.stringify(installedNode)} ${JSON.stringify(installedHost)} "$@"`,
      "",
    ].join("\n"), { mode: 0o755 });
    await chmod(wrapperPath, 0o755);

    const autoSetupWrapperPath = join(binRoot, "aos-chrome-companion-autosetup");
    await writeFile(autoSetupWrapperPath, [
      "#!/bin/sh",
      `AOS_CHROME_COMPANION_SETUP_TRIGGER=launch_agent exec ${JSON.stringify(installedNode)} ${JSON.stringify(join(PRODUCT_ROOT, "app", "scripts", "auto-setup-macos.mjs"))}`,
      "",
    ].join("\n"), { mode: 0o755 });
    await chmod(autoSetupWrapperPath, 0o755);

    const pluginMcpPath = join(applicationRoot, "plugins", "aos-chrome-companion", ".mcp.json");
    await writeFile(pluginMcpPath, `${JSON.stringify({
      mcpServers: {
        "aos-chrome-companion": {
          command: installedNode,
          args: [join(PRODUCT_ROOT, "app", "plugins", "aos-chrome-companion", "scripts", "start-mcp.mjs")],
          cwd: join(PRODUCT_ROOT, "app"),
          env: { AOS_CHROME_COMPANION_ROOT: join(PRODUCT_ROOT, "app") },
          enabled: true,
          startup_timeout_sec: 15,
          tool_timeout_sec: 90,
        },
      },
    }, null, 2)}\n`, { mode: 0o644 });
    const pluginManifestPath = join(applicationRoot, "plugins", "aos-chrome-companion", ".codex-plugin", "plugin.json");
    const pluginManifest = JSON.parse(await readFile(pluginManifestPath, "utf8"));
    pluginManifest.version = `${version.split("+")[0]}+codex.release`;
    await writeFile(pluginManifestPath, `${JSON.stringify(pluginManifest, null, 2)}\n`, { mode: 0o644 });
    const marketplacePath = join(applicationRoot, ".agents", "plugins", "marketplace.json");
    await mkdir(dirname(marketplacePath), { recursive: true, mode: 0o755 });
    await writeFile(marketplacePath, `${JSON.stringify({
      name: "aos-chrome-companion-local",
      interface: { displayName: "AOS Chrome Companion" },
      plugins: [{
        name: "aos-chrome-companion",
        source: { source: "local", path: "./plugins/aos-chrome-companion" },
        policy: { installation: "AVAILABLE", authentication: "ON_INSTALL" },
        category: "Productivity",
      }],
    }, null, 2)}\n`, { mode: 0o644 });

    await mkdir(nativeManifestRoot, { recursive: true, mode: 0o755 });
    await writeFile(join(nativeManifestRoot, `${NATIVE_HOST_NAME}.json`), `${JSON.stringify({
      name: NATIVE_HOST_NAME,
      description: "AOS Chrome Companion native relay",
      path: join(PRODUCT_ROOT, "bin", "aos-chrome-companion-host"),
      type: "stdio",
      allowed_origins: [`chrome-extension://${args.extensionId}/`],
    }, null, 2)}\n`, { mode: 0o644 });

    await mkdir(launchAgentRoot, { recursive: true, mode: 0o755 });
    await writeFile(join(launchAgentRoot, `${AUTO_SETUP_LABEL}.plist`), `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>${AUTO_SETUP_LABEL}</string>
  <key>ProgramArguments</key>
  <array><string>${join(PRODUCT_ROOT, "bin", "aos-chrome-companion-autosetup")}</string></array>
  <key>RunAtLoad</key><true/>
  <key>StartInterval</key><integer>60</integer>
  <key>ProcessType</key><string>Background</string>
</dict>
</plist>
`, { mode: 0o644 });

    await cp(join(sourceRoot, "extension"), extensionStage, { recursive: true, force: false, errorOnExist: true });
    await stampReleaseBuildIdentity(applicationRoot, extensionStage, buildId);
    const releaseManifestPath = join(extensionStage, "manifest.json");
    const extensionManifest = JSON.parse(await readFile(releaseManifestPath, "utf8"));
    extensionManifest.name = "AOS Chrome Companion";
    extensionManifest.version = version.split(/[+-]/u)[0];
    await writeFile(releaseManifestPath, `${JSON.stringify(extensionManifest, null, 2)}\n`, { mode: 0o644 });
    const extensionFiles = await listFiles(extensionStage);
    const extensionZip = join(stagedOutput, `aos-chrome-companion-extension-${version}.zip`);
    run("/usr/bin/zip", ["-X", "-q", extensionZip, ...extensionFiles], {
      cwd: extensionStage,
      code: "release_extension_zip_failed",
    });

    const unsignedPkg = join(stagedOutput, `aos-chrome-companion-macos-${version}-${architecture}-unsigned.pkg`);
    run("pkgbuild", [
      "--root", payloadRoot,
      "--identifier", "com.nichikatanaka.aos-chrome-companion",
      "--version", version.split(/[+-]/u)[0],
      "--install-location", "/",
      unsignedPkg,
    ], { code: "release_pkgbuild_failed" });

    let packagePath = unsignedPkg;
    let packageSigned = false;
    if (args.installerSigningIdentity) {
      const signedPkg = join(stagedOutput, `aos-chrome-companion-macos-${version}-${architecture}.pkg`);
      run("productsign", ["--sign", args.installerSigningIdentity, unsignedPkg, signedPkg], {
        code: "release_installer_signing_failed",
      });
      packagePath = signedPkg;
      packageSigned = true;
      run("pkgutil", ["--check-signature", packagePath], { code: "release_installer_signature_invalid" });
    }

    let notarized = false;
    if (args.notaryProfile) {
      if (!packageSigned) fail("release_notarization_requires_signed_pkg", "Notarization requires a Developer ID Installer-signed package");
      if (!applicationSigned) fail("release_notarization_requires_signed_runtime", "Notarization requires the prepared Developer ID Application-signed runtime");
      run("xcrun", [
        "notarytool", "submit", packagePath,
        "--keychain-profile", args.notaryProfile,
        "--wait", "--output-format", "json",
      ], { code: "release_notarization_failed" });
      run("xcrun", ["stapler", "staple", packagePath], { code: "release_staple_failed" });
      run("xcrun", ["stapler", "validate", packagePath], { code: "release_staple_validation_failed" });
      notarized = true;
    }

    const blockers = [];
    if (!applicationSigned) blockers.push("distribution_developer_id_application_signature_missing");
    if (runtimeSignature.debug_entitlement_enabled) blockers.push("bundled_runtime_get_task_allow_enabled");
    if (!packageSigned) blockers.push("apple_developer_id_pkg_signature_missing");
    if (!notarized) blockers.push("notarization_missing");
    if (architecture !== "arm64") blockers.push("arm64_bundled_node_runtime_missing");
    if (architecture !== "x64") blockers.push("x64_bundled_node_runtime_missing");
    blockers.push("chrome_web_store_publish_receipt_missing");

    const receipt = {
      schema: "aos_chrome_companion_release_candidate.v1",
      created_at: new Date().toISOString(),
      version,
      build_id: buildId,
      extension_id: args.extensionId,
      architecture,
      bundled_node: { version: bundledNodeVersion, architecture, sha256: await sha256(bundledNode),
        license_sha256: await sha256(join(runtimeRoot, "LICENSE")), standalone_dependencies: nodeDependencies,
        relocated_execution_verified: true, source_signature: sourceRuntimeSignature,
        signature: runtimeSignature, distribution_signed: applicationSigned },
      extension_zip: { file: extensionZip.split("/").pop(), sha256: await sha256(extensionZip) },
      macos_package: { file: packagePath.split("/").pop(), sha256: await sha256(packagePath), signed: packageSigned, notarized },
      unsigned_package: { file: unsignedPkg.split("/").pop(), sha256: await sha256(unsignedPkg) },
      release_ready: blockers.length === 0,
      remaining_release_blockers: blockers,
      source_revision: null,
    };
    await writeFile(join(stagedOutput, "release-receipt.json"), `${JSON.stringify(receipt, null, 2)}\n`, { mode: 0o644 });
    await cp(stagedOutput, outputDir, { recursive: true, force: false, errorOnExist: true });
    return {
      ...receipt,
      output_dir: outputDir,
      extension_zip: { ...receipt.extension_zip, path: join(outputDir, receipt.extension_zip.file) },
      macos_package: { ...receipt.macos_package, path: join(outputDir, receipt.macos_package.file) },
      unsigned_package: { ...receipt.unsigned_package, path: join(outputDir, receipt.unsigned_package.file) },
      receipt_path: join(outputDir, "release-receipt.json"),
    };
  } finally {
    await rm(staging, { recursive: true, force: true });
  }
}

const invoked = process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (invoked) {
  try {
    const result = await buildMacosRelease(parseReleaseArgs(process.argv.slice(2)));
    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
  } catch (error) {
    process.stderr.write(`${JSON.stringify({ ok: false, exact_blocker: error?.code || "release_build_failed", message: error?.message || String(error) })}\n`);
    process.exitCode = 1;
  }
}
