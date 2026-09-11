#!/usr/bin/env node
import { execFile } from "node:child_process";
import { readFile, readdir } from "node:fs/promises";
import { extname, join, resolve } from "node:path";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";

const execFileAsync = promisify(execFile);
const root = resolve(fileURLToPath(new URL("..", import.meta.url)));
const syntaxRoots = ["src", "scripts", "extension", "plugins/aos-chrome-companion/scripts"];
const jsonFiles = [
  "package.json",
  "extension/manifest.json",
  "extension/operation-schema.generated.json",
  "plugins/aos-chrome-companion/.codex-plugin/plugin.json",
  "plugins/aos-chrome-companion/.mcp.json",
];

async function collect(directory) {
  const output = [];
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) output.push(...await collect(path));
    else output.push(path);
  }
  return output;
}

for (const relative of jsonFiles) {
  JSON.parse(await readFile(join(root, relative), "utf8"));
}

// Keep the shipped Extension contract synchronized with the runtime source
// table.  This catches capability drift before a local reload can advertise
// methods that the broker does not accept (or vice versa).
await execFileAsync(process.execPath, [join(root, "scripts/generate-operation-schema.mjs"), "--check"]);

for (const relative of syntaxRoots) {
  for (const path of await collect(join(root, relative))) {
    if (new Set([".js", ".mjs"]).has(extname(path))) {
      await execFileAsync(process.execPath, ["--check", path]);
    }
  }
}

const manifest = JSON.parse(await readFile(join(root, "extension/manifest.json"), "utf8"));
if (manifest.manifest_version !== 3) throw new Error("Extension must use Manifest V3");
if (!manifest.permissions.includes("nativeMessaging")) throw new Error("nativeMessaging permission is required");
for (const permission of ["alarms", "tabGroups"]) {
  if (!manifest.permissions.includes(permission)) throw new Error(`${permission} permission is required`);
}
const serviceWorker = await readFile(join(root, "extension/service-worker.js"), "utf8");
const generatedSchema = JSON.parse(await readFile(join(root, "extension/operation-schema.generated.json"), "utf8"));
for (const capability of ["extension.reload", "tabs.groupTask", "page.upload", "page.uploadMultiple", "page.screenshot", "page.inspectDropdown", "page.selectOption", "page.inspectCaptcha", "page.domDiff", "page.readNetwork", "page.elementScreenshot", "page.webMcpCall", "tabs.claimExisting"]) {
  if (!generatedSchema.capabilities.includes(capability)) throw new Error(`Extension capability is missing: ${capability}`);
}
if (!serviceWorker.includes("operation-schema.generated.js")) throw new Error("Extension capabilities must come from the generated schema artifact");
const offscreen = await readFile(join(root, "extension/offscreen.js"), "utf8");
if (!offscreen.includes("user_action_required") || !offscreen.includes("clipboard_binary_opt_in_required")) throw new Error("Native chooser and binary clipboard safety boundaries are missing");
if (!offscreen.includes("peripheral-policy.generated.js") || !serviceWorker.includes("peripheral-policy.generated.js")) throw new Error("Binary clipboard policy must come from the generated shared artifact");
for (const forbidden of ["CGEvent", "AppleScript", "RobotJS", "osascript", "robotjs"]) {
  if (serviceWorker.includes(forbidden) || offscreen.includes(forbidden)) throw new Error(`OS input automation is forbidden: ${forbidden}`);
}
if (!serviceWorker.includes("CODEX_THREAD_ID") && !(await readFile(join(root, "src/mcp/task-context.mjs"), "utf8")).includes("CODEX_THREAD_ID")) {
  throw new Error("Codex task identity binding is missing");
}
if (JSON.stringify(manifest).includes("hehggadaopoacecdllhhajmbjkdcmajg")) {
  throw new Error("Companion must not depend on the official Extension ID");
}

process.stdout.write("Static checks passed.\n");
