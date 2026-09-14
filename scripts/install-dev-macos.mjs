#!/usr/bin/env node
import { spawn } from "node:child_process";
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
    let settled = false;
    const finish = (code, error = null) => {
      if (settled) return;
      settled = true;
      resolvePromise({
        code,
        stdout: Buffer.concat(stdout).toString("utf8").trim(),
        stderr: error?.message || Buffer.concat(stderr).toString("utf8").trim(),
      });
    };
    child.once("error", (error) => finish(null, error));
    child.once("exit", (code) => finish(code));
  });
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

const marketplaceName = "aos-chrome-companion-dev";
const marketplacePath = join(root, ".agents", "plugins", "marketplace.json");
await mkdir(dirname(marketplacePath), { recursive: true, mode: 0o700 });
await writeFile(marketplacePath, `${JSON.stringify({
  name: marketplaceName,
  interface: { displayName: "AOS Chrome Companion Development" },
  plugins: [{
    name: "aos-chrome-companion",
    source: { source: "local", path: "./plugins/aos-chrome-companion" },
    policy: { installation: "AVAILABLE", authentication: "ON_INSTALL" },
    category: "Productivity",
  }],
}, null, 2)}\n`, { mode: 0o600 });

const marketplace = await run("codex", ["plugin", "marketplace", "add", root], { cwd: root });
const marketplaceAdded = marketplace.code === 0
  || /already|exists|configured/iu.test(`${marketplace.stdout} ${marketplace.stderr}`);
let codexPlugin = { marketplaceAdded, installed: false, exactBlocker: null };
if (marketplaceAdded) {
  const installed = await run("codex", ["plugin", "add", `aos-chrome-companion@${marketplaceName}`], { cwd: root });
  codexPlugin = {
    marketplaceAdded,
    installed: installed.code === 0,
    exactBlocker: installed.code === 0 ? null : installed.stderr || installed.stdout || "codex_plugin_install_failed",
  };
} else {
  codexPlugin.exactBlocker = marketplace.stderr || marketplace.stdout || "codex_marketplace_install_failed";
}

process.stdout.write(`${JSON.stringify({
  installed: true,
  extensionId,
  extensionDirectory: join(root, "extension"),
  nativeHostManifest: manifestPath,
  nativeHostWrapper: wrapperPath,
  codexPlugin,
  next: "Reload the unpacked Extension once, then open its popup and require Connected.",
}, null, 2)}\n`);
