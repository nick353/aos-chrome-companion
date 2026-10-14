# Friend setup

## What is included

AOS Chrome Companion uses three cooperating pieces:

- the MV3 Chrome extension, which owns the browser profile;
- the local Native Messaging host and resident broker;
- the Codex plugin, which connects a Codex task to the broker.

Installing only `extension/` is not sufficient because Chrome extensions cannot
silently install a Native Messaging host or change Codex plugin policy.

## Current macOS development setup

This is the reproducible contributor path until a signed public release is
available:

```bash
git clone https://github.com/nick353/aos-chrome-companion.git
cd aos-chrome-companion
npm ci
```

Install Node.js 22 or newer and Google Chrome. Then load `extension/` from
`chrome://extensions` with Developer mode enabled, copy the Companion
extension ID, and run the product installer. It builds and installs the native
recorder, Native Messaging host, broker, and local Codex plugin:

```bash
npm run install:local:macos -- --extension-id <extension-id>
npm run doctor
npm run doctor:strict -- --json
```

The ordinary doctor reports broker health and also displays strict readiness. The strict
doctor is the readiness gate: it exits non-zero while the installed runtime
has source/install drift or active reconciliation, even if the broker is
connected. Historical unknown-effect records remain warnings; they are never
deleted or replayed. Strict readiness covers local two-extension integration;
it does not verify the calling chat's loaded tool catalog, a real website, or
business completion. Companion-only workflows use their own connected-profile,
owner, provenance and exact-target acceptance checks.
Each local install also writes `build-manifest.json` with SHA-256 fingerprints
for the packaged tree, unpacked Extension, and compiled recorder. The Extension
and broker compare those fingerprints at connection time. A same-protocol
stale Extension may connect only to expose status and complete the signed,
idle-boundary reload; page/session actions are blocked until the fingerprints
match. These hashes identify build consistency; they are not a digital
signature or a substitute for a signed public release.

Start a new Codex task after installation. The first task should be read-only;
confirm one connected Companion profile before using any page mutation.

## First-install failure and recovery

This path has isolated fixture coverage, not proof of installation on another
fresh Mac. Keep the installer JSON, a dated `doctor --json` snapshot and the
exact blocker; redact private paths or identities before sharing externally.

| Symptom | Next step and acceptance |
| --- | --- |
| Chrome profile or Companion missing | Load the intended unpacked Extension in Profile 2, then verify its ID and one connected profile. A profile directory name is not a `profileInstanceId`. |
| Native recording permission missing | The user grants Screen & System Audio Recording to the Native Host in macOS settings. Recheck permission and finalize a new file with readable video **and** audio samples. Installation cannot grant this permission. |
| Plugin install reports `EACCES` | Resolve permission on the exact failing user-owned directory. Keep the failed receipt and re-run only the bounded local setup after that repair; no readiness is inferred from broker connectivity. |
| Stale generic CLI path reports `ENOENT` | Companion's generated installer/autosetup/native-host children can discard an invalid inherited generic pin and discover the installed CLI. `AOS_CHROME_COMPANION_CODEX_CLI_PATH` remains authoritative, including an invalid explicit override. Direct callers retain `CODEX_CLI_PATH`; do not rewrite shell or global settings. |
| Setup work lock or guard remains | Inspect owner liveness and use the maintenance dry run below. A timestamp or a historical dead PID does not authorize recovery. |
| Installed plugin exists but a tool is absent in the chat | Inspect the actual calling chat catalog. Finish and reconcile its in-flight invocation before a new task or safe plugin restart; installed inventory does not prove catalog exposure. Do not restart other tasks. |
| Update reports pending refresh | Keep its original receipt and exact blocker. Obtain a fresh idle/ownership boundary before activation, then verify generation, operation schema and build fingerprints together. |

The installer restores its exact source build-info stamp and application swap
when the guarded staging/swap operation fails. Rollback refuses a concurrent
build-info change. This is not a transaction for every later plugin or native
registration step: after activation, preserve the receipt and exact retained
`app-backup-*` path, and have the root reconcile the installed app, source
Extension stamp, wrappers and registrations at an idle boundary. Never restore
only one component into a live mismatched runtime. Do not delete locks, state,
journals or unknown-effect receipts as a rollback shortcut.

## Recoverable dead-lock maintenance

Run only the read-only inspection with the exact supported path:

```bash
node scripts/auto-setup-macos.mjs --lock-maintenance-dry-run "/absolute/Companion/support/setup.lock"
```

The API `inspectCompanionLockMaintenance` in
`src/setup/dead-lock-maintenance.mjs` binds a dry-run plan to the current path,
inode, bytes, PID and owner token. `recoverCompanionDeadLock(plan, options)`
requires root's `verifySchedulingExclusion(lockPath)` callback to independently
prove that scheduler, Native Host, installer, manual and legacy entrypoints
remain excluded throughout apply. Each callback result must bind `lockPath`,
`excluded: true`, `allEntrypointsExcluded: true`, `legacyActorsExcluded: true`,
an `observedAt` within five seconds and a nonempty evidence `source`. These
fields describe externally verified exclusion; writing them alone proves none.
The API does not stop a scheduler or broker and there is no unattended apply flag.

Both guard and work owner must be freshly dead (`ESRCH`); live owners, `EPERM`,
malformed owners, symlinks, unexpected guard contents and changed identity stop.
The dead guard protects the work lock until it is moved first into a private
`lock-recovery/dead-lock-*` directory. The guard moves last. Archived identity
and hashes and absent originals are checked before reporting success. No
age-based reclaim, overwrite or recursive deletion occurs. If apply stops
after preserving the work lock, retain the guard and recovery path, obtain a
new dry run for the remaining guard and re-establish exclusion. After verified
recovery, restore only the excluded Companion entrypoints, converge once and
read the fresh setup receipt. Root performs any live apply; fixtures prove the
algorithm only.

## Automatic Chrome-window recording with audio

`recording.startAuto` records the foremost normal window belonging to the
frontmost Chrome application with macOS ScreenCaptureKit; it no longer guesses
by choosing the largest Chrome window. Bring the intended Chrome window to the
front before starting. If Chrome is not the frontmost application, recording
fails instead of capturing another app. This captures a Chrome window, not a
task-owned tab; Companion tab switches remain visible only while they stay in
that window. `recording.stopAuto` finalizes the `.mov` under
`~/Library/Application Support/AOS Chrome Companion/Recordings/` and returns
size, SHA-256, and media-track verification metadata. Audio is reported as
captured only after the finalized file contains readable audio samples and
video frames. The popup/tabCapture path remains a separate fallback.

The first use requires the user to allow the Native Host in System Settings →
Privacy & Security → Screen & System Audio Recording. This OS permission
cannot be granted or bypassed by an extension. Microphone, other applications,
and the desktop outside the selected Chrome window are excluded. Native
ScreenCaptureKit recording requires macOS 15 or newer.

## If Codex reports `Transport closed`

This means the stdio MCP process owned by Codex App was closed. Do not replay
the last operation. If Codex starts a replacement MCP process for the same
task, call `companion_prepare_resume` with the prior `sessionId` and `runId`;
it performs a fresh broker/owner/profile readback and returns a new
`session_id` only when the same task can safely resume. Old leases are never
reused, and actions are never replayed. A genuinely new Codex task has a
different owner identity and cannot adopt the old task's session; use the
workflow's explicit owner-bound handoff or stop at the returned blocker. An
operation sent before the close remains effect-unknown until the exact page or
provider is read back.

The MCP launcher records `starting root=`, `transport_error`, `setup_error`,
and `shutdown reason=` lines on stderr. Include those bounded diagnostics when
reporting a failure; never include cookies, tokens, or page contents.

## Release path

The one-click experience requires a signed macOS installer containing the
broker, Native Messaging registration, bundled Node runtime, and Codex plugin,
plus a signed Chrome Web Store extension. Those artifacts require a Chrome Web
Store publisher identity and Apple Developer ID signing/notarization. They are
not generated by cloning the repository and are not included in source control.
The local product installer is macOS-only; Windows/Linux native-host installers
and a one-click signed Chrome Web Store package are not available yet. Do not
describe a local Developer Mode installation as a public signed release.

Never put OAuth tokens, broker secrets, cookies, private keys, signed release
artifacts, or personal diagnostic output in this repository.
