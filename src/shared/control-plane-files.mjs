import { lstat, readdir } from "node:fs/promises";
import { join } from "node:path";

// These two files carry the installation identity and are deliberately kept
// when src/extension are atomically replaced. Every other runtime asset is
// compared, including imported helper modules, generated data and popup UI.
const INSTALLATION_FILES = new Set(["src/shared/build-info.mjs", "extension/build-info.js"]);

export async function controlPlaneFiles(...roots) {
  const files = new Set();
  async function walk(root, relative) {
    const path = join(root, relative);
    let stat;
    try { stat = await lstat(path); }
    catch (error) { if (error?.code === "ENOENT") return; throw error; }
    if (stat.isSymbolicLink()) throw new Error(`control_plane_symlink_not_allowed:${relative}`);
    if (stat.isDirectory()) {
      for (const name of (await readdir(path)).sort()) await walk(root, `${relative}/${name}`);
    } else if (stat.isFile() && !INSTALLATION_FILES.has(relative)) files.add(relative);
  }
  for (const root of roots) {
    await walk(root, "src");
    await walk(root, "extension");
  }
  return [...files].sort();
}
