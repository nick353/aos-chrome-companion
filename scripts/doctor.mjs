#!/usr/bin/env node
// Compatibility entrypoint. Keep diagnosis read-only and broker-independent.
import { collectDoctorDiagnostics } from '../src/shared/doctor-diagnostics.mjs';
import { writeFile } from 'node:fs/promises';

const argv = process.argv.slice(2);
const outputIndex = argv.findIndex(value => value === '--output');
const outputEquals = argv.find(value => value.startsWith('--output='));
const output = outputEquals?.slice('--output='.length) ?? (outputIndex >= 0 ? argv[outputIndex + 1] : null);
const options = { output, strict: argv.includes('--strict') };
for (let index = 0; index < argv.length; index += 1) {
  const value = argv[index];
  if (value === '--output' || value.startsWith('--output=') || value === '--json' || value === '--strict') continue;
  if (value === '--data-dir') options.dataDir = argv[++index];
  else if (value === '--socket') options.socketPath = argv[++index];
  else if (value === '--state-file') options.statePath = argv[++index];
  else if (value === '--source-root') options.sourceRoot = argv[++index];
  else if (value === '--installed-root') options.installedRoot = argv[++index];
  else if (value === '--chrome-user-data-dir') options.chromeUserDataDir = argv[++index];
}
try {
  const report = await collectDoctorDiagnostics(options);
  const strictMaintenance = (report.maintenance ?? []).filter(item => item.severity === 'high');
  if (options.strict) {
    report.strict_ready = report.result === 'ok' && strictMaintenance.length === 0;
    report.strict_blockers = strictMaintenance.map(item => item.code);
  }
  const text = `${JSON.stringify(report, null, 2)}\n`;
  if (output) await writeFile(output, text, { mode: 0o600 });
  process.stdout.write(text);
  process.exitCode = report.result === 'ok' && (!options.strict || strictMaintenance.length === 0) ? 0 : 1;
} catch (error) {
  process.stdout.write(`${JSON.stringify({ schema: 'aos.chrome_companion.doctor_diagnostics.v1', result: 'unavailable', readOnly: true, error: error instanceof Error ? error.message : String(error) }, null, 2)}\n`);
  process.exitCode = 1;
}
