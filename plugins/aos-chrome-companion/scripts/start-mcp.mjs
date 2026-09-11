#!/usr/bin/env node
import { access } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

const roots = [
  process.env.AOS_CHROME_COMPANION_ROOT,
  join(homedir(), "Library", "Application Support", "AOS Chrome Companion", "app"),
].filter(Boolean);

for (const root of roots) {
  const entry = join(root, "src", "mcp", "server.mjs");
  try {
    await access(entry);
    const setupEntry = join(root, "src", "setup", "auto-setup.mjs");
    void access(setupEntry)
      .then(() => import(pathToFileURL(setupEntry).href))
      .then(({ convergeCompanionSetup }) => convergeCompanionSetup({ trigger: "codex_plugin" }))
      .catch(() => {});
    await import(pathToFileURL(entry).href);
    process.exitCode = 0;
    break;
  } catch (error) {
    if (error?.code !== "ENOENT") throw error;
  }
}

if (process.exitCode !== 0) {
  throw new Error(
    "AOS Chrome Companion runtime is not installed. Reinstall the Companion product or set AOS_CHROME_COMPANION_ROOT.",
  );
}
