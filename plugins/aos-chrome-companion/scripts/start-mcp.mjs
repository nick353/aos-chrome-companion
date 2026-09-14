#!/usr/bin/env node
import { access } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const roots = [
  process.env.AOS_CHROME_COMPANION_ROOT,
  fileURLToPath(new URL("../../../", import.meta.url)),
  join(homedir(), "Library", "Application Support", "AOS Chrome Companion", "app"),
].filter(Boolean);

let started = false;
for (const root of roots) {
  const entry = join(root, "src", "mcp", "server.mjs");
  try {
    await access(entry);
    const setupEntry = join(root, "src", "setup", "auto-setup.mjs");
    void access(setupEntry)
      .then(() => import(pathToFileURL(setupEntry).href))
      .then(({ convergeCompanionSetup }) => convergeCompanionSetup({ trigger: "codex_plugin" }))
      .catch((error) => {
        const message = error instanceof Error ? error.message : String(error);
        process.stderr.write(`AOS Chrome Companion setup_error ${message}\n`);
      });
    process.stderr.write(`AOS Chrome Companion MCP starting root=${root}\n`);
    await import(pathToFileURL(entry).href);
    started = true;
    process.exitCode = 0;
    break;
  } catch (error) {
    if (error?.code !== "ENOENT") throw error;
  }
}

if (!started) {
  throw new Error(
    "AOS Chrome Companion runtime is not installed. Reinstall the Companion product or set AOS_CHROME_COMPANION_ROOT.",
  );
}
