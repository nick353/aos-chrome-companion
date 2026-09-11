#!/usr/bin/env node
import { copyFile, chmod, mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { NATIVE_HOST_NAME } from "../src/shared/constants.mjs";

function parseArgs(argv) {
  const output = {};
  for (let index = 0; index < argv.length; index += 1) {
    if (argv[index] === "--extension-id") output.extensionId = argv[++index];
  }
  return output;
}

const { extensionId } = parseArgs(process.argv.slice(2));
if (!/^[a-p]{32}$/.test(extensionId ?? "")) {
  process.stderr.write("Usage: npm run install:dev:macos -- --extension-id <32-character Chrome extension ID>\n");
  process.exit(2);
}

if (process.platform !== "darwin") {
  throw new Error("This development installer currently supports macOS only");
}

const root = resolve(fileURLToPath(new URL("..", import.meta.url)));
const supportDir = join(homedir(), "Library", "Application Support", "AOS Chrome Companion");
const binDir = join(supportDir, "bin");
const hostEntry = join(root, "src", "native-host", "main.mjs");
const wrapperPath = join(binDir, "aos-chrome-companion-host");
const manifestDir = join(
  homedir(),
  "Library",
  "Application Support",
  "Google",
  "Chrome",
  "NativeMessagingHosts",
);
const manifestPath = join(manifestDir, `${NATIVE_HOST_NAME}.json`);
await mkdir(binDir, { recursive: true, mode: 0o700 });
await mkdir(manifestDir, { recursive: true, mode: 0o700 });

const extensionOrigin = `chrome-extension://${extensionId}/`;
const wrapper = [
  "#!/bin/sh",
  `AOS_CHROME_COMPANION_EXTENSION_ORIGIN=${JSON.stringify(extensionOrigin)} exec ${JSON.stringify(process.execPath)} ${JSON.stringify(hostEntry)} "$@"`,
  "",
].join("\n");
await writeFile(wrapperPath, wrapper, { mode: 0o700 });
await chmod(wrapperPath, 0o700);

try {
  await readFile(manifestPath);
  const backup = `${manifestPath}.backup-${new Date().toISOString().replace(/[:.]/g, "-")}`;
  await copyFile(manifestPath, backup);
} catch (error) {
  if (error?.code !== "ENOENT") throw error;
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

process.stdout.write(`${JSON.stringify({
  installed: true,
  extensionId,
  extensionDirectory: join(root, "extension"),
  nativeHostManifest: manifestPath,
  nativeHostWrapper: wrapperPath,
  next: "Reload the unpacked Extension once, then open its popup and require Connected.",
}, null, 2)}\n`);
