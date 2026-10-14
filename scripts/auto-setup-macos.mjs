#!/usr/bin/env node

import { convergeCompanionSetup, setupReceiptIsStable } from "../src/setup/auto-setup.mjs";
import { inspectCompanionLockMaintenance } from "../src/setup/dead-lock-maintenance.mjs";
import { aosRunActive } from "../src/shared/aos-run-active.mjs";

// Explicit read-only maintenance entry. Apply is an API requiring root's fresh
// scheduling-exclusion verifier, never an automatic scheduler-side reclaim.
if (process.argv[2] === "--lock-maintenance-dry-run") {
  if (process.argv.length !== 4) throw new Error("exact_lock_path_required");
  const plan = await inspectCompanionLockMaintenance(process.argv[3]);
  process.stdout.write(`${JSON.stringify(plan, null, 2)}\n`);
  process.exit(plan.allowed ? 0 : 3);
}
if (process.argv.length > 2) throw new Error("unknown_auto_setup_argument");
// No setup change while an AOS run is under way; the next minute's check picks it up.
if (aosRunActive()) process.exit(0);

const result = await convergeCompanionSetup({
  trigger: process.env.AOS_CHROME_COMPANION_SETUP_TRIGGER || "launch_agent",
  managedChild: process.env.AOS_CHROME_COMPANION_MANAGED_CHILD === "1",
  managedChildProvenance: process.env.AOS_CHROME_COMPANION_MANAGED_CHILD_PROVENANCE,
});
if (!setupReceiptIsStable(result, process.env.AOS_CHROME_COMPANION_SETUP_TRIGGER || "launch_agent")) {
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
}
process.exitCode = result.setup_complete ? 0 : 3;
