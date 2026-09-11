#!/usr/bin/env node

import { convergeCompanionSetup, setupReceiptIsStable } from "../src/setup/auto-setup.mjs";

const result = await convergeCompanionSetup({ trigger: process.env.AOS_CHROME_COMPANION_SETUP_TRIGGER || "launch_agent" });
if (!setupReceiptIsStable(result, process.env.AOS_CHROME_COMPANION_SETUP_TRIGGER || "launch_agent")) {
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
}
process.exitCode = result.setup_complete ? 0 : 3;
