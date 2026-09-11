import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, mkdir, writeFile, rm, symlink } from "node:fs/promises";
import { join, dirname } from "node:path";
import { tmpdir } from "node:os";
import { compareControlPlaneArtifacts } from "../src/setup/auto-setup.mjs";
import { controlPlaneFiles } from "../src/shared/control-plane-files.mjs";

test("automatic comparison detects helper-only changes, additions and deletions while preserving installation identities", async () => {
  const root = await mkdtemp(join(tmpdir(), "companion-all-runtime-files-"));
  const sourceRoot = join(root, "source"), installedRoot = join(root, "installed");
  const put = async (base, path, value) => { await mkdir(dirname(join(base, path)), { recursive: true }); await writeFile(join(base, path), value); };
  try {
    for (const base of [sourceRoot, installedRoot]) {
      await put(base, "extension/service-worker.js", "unchanged");
      await put(base, "extension/page-observation.js", "old helper");
      await put(base, "src/shared/build-info.mjs", base);
      await put(base, "extension/build-info.js", base);
    }
    assert.equal((await compareControlPlaneArtifacts({ sourceRoot, installedRoot })).match, true);
    await put(sourceRoot, "extension/page-observation.js", "fixed helper");
    await put(sourceRoot, "src/shared/new-module.mjs", "new module");
    await put(installedRoot, "extension/removed.css", "stale installed asset");
    const comparison = await compareControlPlaneArtifacts({ sourceRoot, installedRoot });
    assert.deepEqual(comparison.mismatches, ["extension/page-observation.js", "extension/removed.css", "src/shared/new-module.mjs"]);
    assert.equal(comparison.files["extension/removed.css"].source.exists, false);
    assert.equal(comparison.files["src/shared/new-module.mjs"].installed.exists, false);
    assert.equal(comparison.files["extension/build-info.js"], undefined);
    assert.equal(comparison.files["src/shared/build-info.mjs"], undefined);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("runtime inventory never follows a symlink into an unrelated tree", async () => {
  const root = await mkdtemp(join(tmpdir(), "companion-runtime-symlink-"));
  try {
    await mkdir(join(root, "src")); await mkdir(join(root, "outside"));
    await symlink(join(root, "outside"), join(root, "src", "linked"));
    await assert.rejects(controlPlaneFiles(root), /control_plane_symlink_not_allowed:src\/linked/u);
  } finally { await rm(root, { recursive: true, force: true }); }
});
