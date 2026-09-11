#!/usr/bin/env node

import crypto from "node:crypto";
import { execFileSync } from "node:child_process";
import { access, readFile, mkdtemp, readdir, rm, lstat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { inspectRuntimeSignature, verifyStandaloneNodeDependencies } from "./build-release-macos.mjs";

function fail(code, message) { const error = new Error(message); error.code = code; throw error; }
async function sha256(path) { return crypto.createHash("sha256").update(await readFile(path)).digest("hex"); }
function run(command, args) {
  try { return execFileSync(command, args, { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim(); }
  catch (error) { fail("release_verification_command_failed", `${command}: ${String(error?.stderr || error?.stdout || error.message).trim()}`); }
}

async function findBuildIdentityFiles(root) {
  const found = [];
  for (const entry of await readdir(root, { withFileTypes: true })) {
    const path = join(root, entry.name);
    if (entry.isDirectory()) found.push(...await findBuildIdentityFiles(path));
    else if (entry.isFile() && (path.endsWith("/app/src/shared/build-info.mjs") || path.endsWith("/app/extension/build-info.js"))) found.push(path);
  }
  return found;
}

function packageSignature(path, expectedSigned) {
  try { return { signed: true, summary: run("pkgutil", ["--check-signature", path]) }; }
  catch (error) {
    if (expectedSigned !== true && /no signature/i.test(error.message)) return { signed: false, summary: "unsigned local candidate" };
    throw error;
  }
}

export async function verifyRelease(receiptPath) {
  const absoluteReceipt = resolve(receiptPath);
  const receipt = JSON.parse(await readFile(absoluteReceipt, "utf8"));
  if (receipt?.schema !== "aos_chrome_companion_release_candidate.v1") fail("release_receipt_schema_invalid", "Unexpected release receipt schema");
  const root = dirname(absoluteReceipt);
  const extensionZip = join(root, receipt.extension_zip.file);
  const macosPackage = join(root, receipt.macos_package.file);
  await access(extensionZip);
  await access(macosPackage);
  if (await sha256(extensionZip) !== receipt.extension_zip.sha256) fail("release_extension_hash_mismatch", "Extension ZIP hash mismatch");
  if (await sha256(macosPackage) !== receipt.macos_package.sha256) fail("release_package_hash_mismatch", "macOS package hash mismatch");
  run("/usr/bin/unzip", ["-tq", extensionZip]);
  const manifest = JSON.parse(run("/usr/bin/unzip", ["-p", extensionZip, "manifest.json"]));
  if (manifest.name !== "AOS Chrome Companion") fail("release_extension_development_name_present", "Release Extension still has a development name");
  if (!/^release-[0-9a-f-]{36}$/u.test(receipt.build_id ?? "")) fail("release_build_identity_missing", "Rebuild the candidate with a recorded broker/extension identity");
  const expectedBuildFile = `export const INSTALL_BUILD_ID = ${JSON.stringify(receipt.build_id)};`;
  if (run("/usr/bin/unzip", ["-p", extensionZip, "build-info.js"]).trim() !== expectedBuildFile) fail("release_build_identity_mismatch", "Extension ZIP build identity does not match the receipt");
  let packagedRuntime;
  const unpacked = await mkdtemp(join(tmpdir(), "companion-release-verify-"));
  try {
    const expanded = join(unpacked, "expanded");
    run("pkgutil", ["--expand-full", macosPackage, expanded]);
    const identities = await findBuildIdentityFiles(expanded);
    if (identities.length !== 2) fail("release_package_identity_missing", "Package must contain one broker and one extension build identity");
    for (const path of identities) {
      if (!(await lstat(path)).isFile() || (await readFile(path, "utf8")).trim() !== expectedBuildFile) fail("release_build_identity_mismatch", "Packaged broker/extension identity does not match the receipt");
    }
    const applicationRoot = identities.find(path => path.endsWith("/app/src/shared/build-info.mjs")).slice(0, -"/src/shared/build-info.mjs".length);
    const runtime = join(dirname(applicationRoot), "runtime", "node");
    const license = join(dirname(applicationRoot), "runtime", "LICENSE");
    if (!(await lstat(runtime)).isFile() || !(await lstat(license)).isFile()) fail("release_packaged_runtime_missing", "Package must include a regular Node executable and its LICENSE");
    if (await sha256(runtime) !== receipt.bundled_node?.sha256 || await sha256(license) !== receipt.bundled_node?.license_sha256) fail("release_packaged_runtime_hash_mismatch", "Packaged Node or LICENSE does not match the receipt");
    const dependencies = verifyStandaloneNodeDependencies(run("/usr/bin/otool", ["-L", runtime]));
    const version = run("/usr/bin/env", ["-i", "PATH=/usr/bin:/bin", runtime, "--version"]);
    if (version !== receipt.bundled_node.version) fail("release_packaged_runtime_version_mismatch", "Packaged Node version does not match the receipt");
    const runtimeSignature = inspectRuntimeSignature(runtime);
    if (receipt.bundled_node.distribution_signed && (!runtimeSignature.valid || !runtimeSignature.hardened_runtime
      || runtimeSignature.debug_entitlement_enabled || !runtimeSignature.authorities.some(authority => authority.startsWith("Developer ID Application:")))) {
      fail("release_packaged_runtime_signature_invalid", "Packaged Node lacks its declared distribution signature");
    }
    if (receipt.release_ready && (!receipt.bundled_node.distribution_signed || !receipt.macos_package.signed || !receipt.macos_package.notarized || receipt.remaining_release_blockers?.length)) fail("release_readiness_inconsistent", "Release readiness contradicts the packaged artifacts or remaining blockers");
    packagedRuntime = { execution_verified: true, version, standalone_dependencies: dependencies, license_hash_valid: true, signature: runtimeSignature };
  } finally { await rm(unpacked, { recursive: true, force: true }); }
  const signature = packageSignature(macosPackage, receipt.macos_package.signed);
  let notarization = "not_checked";
  if (receipt.macos_package.notarized) {
    run("xcrun", ["stapler", "validate", macosPackage]);
    notarization = "valid";
  }
  return {
    ok: true,
    schema: "aos_chrome_companion_release_verification.v1",
    receipt_path: absoluteReceipt,
    extension_zip_hash_valid: true,
    extension_manifest_valid: true,
    macos_package_hash_valid: true,
    build_id: receipt.build_id,
    package_and_extension_build_identity_valid: true,
    packaged_runtime: packagedRuntime,
    macos_package_signed: signature.signed,
    macos_package_signature_summary: signature.summary.split("\n").slice(0, 3),
    notarization,
    release_ready: receipt.release_ready === true,
    remaining_release_blockers: receipt.remaining_release_blockers || [],
  };
}

const invoked = process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (invoked) {
  try {
    const index = process.argv.indexOf("--receipt");
    if (index < 0 || !process.argv[index + 1]) fail("release_receipt_required", "Usage: --receipt /absolute/path/release-receipt.json");
    process.stdout.write(`${JSON.stringify(await verifyRelease(process.argv[index + 1]), null, 2)}\n`);
  } catch (error) {
    process.stderr.write(`${JSON.stringify({ ok: false, exact_blocker: error?.code || "release_verification_failed", message: error?.message || String(error) })}\n`);
    process.exitCode = 1;
  }
}
