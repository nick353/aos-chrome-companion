#!/usr/bin/env node
import { collectDoctorDiagnostics, formatDoctorText } from "../src/shared/doctor-diagnostics.mjs";
import { writeFile } from "node:fs/promises";

function parseArgs(argv) {
  const options = {};
  for (let index = 0; index < argv.length; index += 1) {
    const value = argv[index];
    if (value === "--json") options.json = true;
    else if (value === "--output" || value.startsWith("--output=")) options.output = value === "--output" ? argv[++index] : value.slice("--output=".length);
    else if (value === "--data-dir") options.dataDir = argv[++index];
    else if (value === "--socket") options.socketPath = argv[++index];
    else if (value === "--state-file") options.statePath = argv[++index];
    else if (value === "--source-root") options.sourceRoot = argv[++index];
    else if (value === "--installed-root") options.installedRoot = argv[++index];
    else if (value === "--chrome-user-data-dir") options.chromeUserDataDir = argv[++index];
    else if (value === "--help") options.help = true;
    else throw new Error(`Unknown argument: ${value}`);
  }
  return options;
}

const options = parseArgs(process.argv.slice(2));
if (options.help) {
  process.stdout.write("Usage: npm run doctor -- [--json] [--output <path>] [--data-dir <path>] [--socket <path>] [--state-file <path>] [--source-root <path>] [--installed-root <path>] [--chrome-user-data-dir <path>]\n");
  process.exit(0);
}
try {
  const report = await collectDoctorDiagnostics(options);
  // --output was the legacy JSON-file interface; retain that shape unless
  // the caller explicitly asks for text-only output behavior.
  const output = (options.json || options.output) ? `${JSON.stringify(report, null, 2)}\n` : formatDoctorText(report);
  if (options.output) await writeFile(options.output, output, { mode: 0o600 });
  process.stdout.write(output);
  process.exitCode = report.result === "ok" ? 0 : 1;
} catch (error) {
  process.stderr.write(`${JSON.stringify({ schema: "aos.chrome_companion.doctor_diagnostics.v1", result: "unavailable", readOnly: true, error: error instanceof Error ? error.message : String(error) })}\n`);
  process.exitCode = 1;
}
