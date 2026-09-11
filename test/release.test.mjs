import assert from "node:assert/strict";
import { readFile, mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import test from "node:test";
import { parseReleaseArgs, prepareRuntimeEntitlements, stampReleaseBuildIdentity, verifyStandaloneNodeDependencies } from "../scripts/build-release-macos.mjs";

test("Node distribution signing preserves V8 entitlements and removes debugger attachment", () => {
  const source = {
    "com.apple.security.cs.allow-jit": true,
    "com.apple.security.cs.allow-unsigned-executable-memory": true,
    "com.apple.security.cs.disable-library-validation": true,
    "com.apple.security.get-task-allow": true,
  };
  const prepared = prepareRuntimeEntitlements(source);
  assert.equal(prepared["com.apple.security.cs.allow-jit"], true);
  assert.equal(prepared["com.apple.security.cs.allow-unsigned-executable-memory"], true);
  assert.equal(prepared["com.apple.security.cs.disable-library-validation"], true);
  assert.equal(Object.hasOwn(prepared, "com.apple.security.get-task-allow"), false);
  assert.equal(source["com.apple.security.get-task-allow"], true);
  assert.throws(() => prepareRuntimeEntitlements([]), error => error.code === "release_runtime_entitlements_invalid");
});

test("release rejects a Homebrew Node binary whose dylibs would be absent on the destination", () => {
  assert.throws(() => verifyStandaloneNodeDependencies("/usr/local/bin/node:\n\t@rpath/libnode.147.dylib (compatibility version 147.0.0, current version 147.0.0)\n\t/usr/lib/libSystem.B.dylib (compatibility version 1.0.0, current version 1351.0.0)"), error => error.code === "release_node_not_standalone");
  assert.throws(() => verifyStandaloneNodeDependencies("node:\n\t/usr/local/opt/icu4c/lib/libicu.dylib (compatibility version 1.0.0, current version 1.0.0)"), error => error.code === "release_node_not_standalone");
  assert.equal(verifyStandaloneNodeDependencies("node:\n\t/System/Library/Frameworks/Security.framework/Versions/A/Security (compatibility version 1.0.0, current version 1.0.0)\n\t/usr/lib/libSystem.B.dylib (compatibility version 1.0.0, current version 1.0.0)").length, 2);
  assert.throws(() => verifyStandaloneNodeDependencies("node:"), error => error.code === "release_node_dependencies_unverified");
});

test("release staging replaces mismatched broker and extension identities with one receipt-bound value", async t => {
  const root = await mkdtemp(join(tmpdir(), "companion-release-identity-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const app = join(root, "app"), extension = join(root, "extension");
  for (const dir of [join(app, "src", "shared"), join(app, "extension"), extension]) await mkdir(dir, { recursive: true });
  const paths = [join(app, "src", "shared", "build-info.mjs"), join(app, "extension", "build-info.js"), join(extension, "build-info.js")];
  for (const [index, path] of paths.entries()) await writeFile(path, `export const INSTALL_BUILD_ID = "old-${index}";\n`);
  const buildId = "release-12345678-1234-4321-abcd-123456789abc";
  await stampReleaseBuildIdentity(app, extension, buildId);
  for (const path of paths) assert.equal(await readFile(path, "utf8"), `export const INSTALL_BUILD_ID = "${buildId}";\n`);
});
import { parseWebStoreArgs, publishWebStore } from "../scripts/publish-web-store.mjs";

test("release CLI requires an exact Chrome Extension ID", () => {
  assert.throws(() => parseReleaseArgs([]), (error) => error?.code === "release_extension_id_invalid");
  assert.equal(parseReleaseArgs(["--extension-id", "pmoolbkcamcemmfonlaenelcbdlcngmb"]).extensionId, "pmoolbkcamcemmfonlaenelcbdlcngmb");
});

test("Web Store publisher keeps OAuth tokens out of argv", async () => {
  const args = parseWebStoreArgs([
    "--zip", "/tmp/extension.zip",
    "--publisher-id", "publisher",
    "--extension-id", "pmoolbkcamcemmfonlaenelcbdlcngmb",
  ]);
  await assert.rejects(() => publishWebStore(args, {}), (error) => error?.code === "chrome_web_store_access_token_missing");
});

test("release build contains the signed and notarized distribution gates", async () => {
  const source = await readFile(new URL("../scripts/build-release-macos.mjs", import.meta.url), "utf8");
  assert.match(source, /codesign/);
  assert.match(source, /productsign/);
  assert.match(source, /notarytool/);
  assert.match(source, /stapler/);
  assert.match(source, /chrome_web_store_publish_receipt_missing/);
  assert.match(source, /runtime.*node/s);
  assert.match(source, /aos-chrome-companion-autosetup/);
  assert.match(source, /LAUNCH_AGENT_ROOT/);
  assert.match(source, /StartInterval/);
  assert.match(source, /marketplace\.json/);
});
