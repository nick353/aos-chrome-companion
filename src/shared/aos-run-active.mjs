import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

// AOS (~/Projects/aos-v2) keeps this file while one of its runs is under way: "<agent pid> <run id>".
// Reinstalling Companion then takes its tools away from that run (AOS runs 410 and 411, 2026-10-12),
// so the owner's rule (2026-10-14) is that Companion is set up or reinstalled only while AOS is idle.
export const AOS_RUN_ACTIVE_FILE = join(homedir(), ".config", "aos", "run-active");

// The AOS run id while a run is under way (the file is there and its agent is alive), otherwise null.
export function aosRunActive(file = AOS_RUN_ACTIVE_FILE) {
  let pid, run;
  try {
    [pid, run] = readFileSync(file, "utf8").trim().split(/\s+/);
  } catch {
    return null;
  }
  try {
    process.kill(Number(pid), 0);
  } catch (error) {
    if (error?.code !== "EPERM") return null; // the agent is gone; a leftover file does not block
  }
  return run || "unknown";
}
