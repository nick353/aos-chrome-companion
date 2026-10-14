import { execFile } from "node:child_process";
import { readFile } from "node:fs/promises";
import { promisify } from "node:util";

export async function companionBootIdentity() {
  if (process.platform === "darwin") {
    const { stdout } = await promisify(execFile)("/usr/sbin/sysctl", ["-n", "kern.boottime"], { timeout: 2000 });
    const match = stdout.match(/sec\s*=\s*(\d+),\s*usec\s*=\s*(\d+)/u);
    if (match) return `darwin:${match[1]}:${match[2]}`;
  } else if (process.platform === "linux") {
    const value = (await readFile("/proc/sys/kernel/random/boot_id", "utf8")).trim();
    if (/^[0-9a-f-]{36}$/u.test(value)) return `linux:${value}`;
  }
  throw new Error("companion_lock_boot_identity_unavailable");
}
