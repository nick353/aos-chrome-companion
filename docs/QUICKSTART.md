# AOS Chrome Companion quick start

This page is for a first-time user of the local development build. A signed
product release will replace the Developer Mode step with its installer.

## Install and connect

1. Install Node.js 22 or newer and Chrome.
2. In Chrome, open `chrome://extensions`, enable **Developer mode**, choose
   **Load unpacked**, and select the repository's `extension` directory.
3. Copy the ID shown for **AOS Chrome Companion**.
4. From this repository, register the local Native Host and MCP plugin:

   ```bash
   npm ci
   npm run install:local:macos -- --extension-id <copied-extension-id>
   ```

5. Start a new Codex task. The task must use the Companion MCP tools from the
   same installation; do not mix a source checkout with an installed broker.

## Verify before doing work

The official Codex Chrome extension is optional for Companion browser operations.
The two-extension setup receipt describes official integration readiness; it
does not decide whether Companion alone is installed or connected.

Run a read-only status check and confirm one connected Companion profile, or
the exact `profileInstanceId` required by the workflow. A Companion instance
ID is not a Chrome profile directory name. Then use a fresh task tab for the first read. Begin with a semantic
query or snapshot and a reversible action such as scrolling. Confirm the page
readback before making an external change.

An installed build exposes its bundle, Extension, and native-recorder SHA-256
fingerprints in status. A stale same-protocol Extension can only report status
and receive the signed safe-boundary reload; page/session work is blocked until
the fingerprints match. These fingerprints are consistency evidence, not a
publisher signature.

If the status read itself is unavailable or the connected runtime looks stale,
run the local doctor for one bounded snapshot of the common transport causes:

```bash
npm run doctor
npm run doctor -- --json
npm run doctor -- --strict --json
```

The doctor is read-only. It counts broker processes, inspects the socket/data
directory, compares build and operation-schema values, lists connected
profiles/sessions/leases, reads ledger and reconciliation counts, and compares
the auto-setup receipt with the current Profile 2 detection. It does not start
or stop a broker, reload Chrome, adopt foreign resources, or edit state.

Broker health, strict local integration readiness and the calling chat's tool
catalog are separate evidence. Both ordinary and strict doctor output display
strict readiness; only `--strict` changes the exit condition to require it.
Receipt `ageMs` dates a saved observation and never proves its invocation is
still live. Lock owners are reported as dead, live or unknown; `EPERM` remains
unknown. Historical reconciliation totals concern their original exact targets;
an active total of zero and cleanup of zero do not block a new unrelated target.
The doctor cannot see a calling chat catalog and reports it as unknown even
when files and installed plugin inventory match. At a safe boundary, refresh
only the calling task's plugin/catalog, after reconciling its original invocation.
See [Friend setup](FRIEND_SETUP.md) for missing-profile, CLI, permission, update
rollback and guarded dead-lock maintenance instructions. A fresh Mac and real
website/media acceptance remain separate from fixture checks.

If doctor reports `source_install_control_plane_drift`, the checkout and the
installed MCP runtime differ. Run the control-plane sync only after doctor
reports no active leases, queues, pending operations, or active reconciliation:

```bash
node scripts/sync-control-plane-macos.mjs --apply --restart-broker
```

The command defers itself when the boundary is not idle. Do not copy files into
the installed app or kill the broker manually; that can leave the Extension
generation and MCP runtime on different builds.

If status reports a different build, profile, task, generation, or lease,
stop and use the exact recovery instruction in the error. Do not retry a
timed-out mutation until its effect has been reconciled.

## Record an automated Chrome workflow with audio

Use `recording.startAuto` from the Codex/Companion workflow with the intended
Chrome window in front. Native Host captures the foremost normal window of the
frontmost Chrome application; if another app is in front, it fails instead of
guessing a window. This is window capture, not task-owned-tab capture. Use
`recording.stopAuto` to finalize the `.mov` and receive byte count, SHA-256,
and audio/video sample verification. On first use, grant Screen & System Audio
Recording permission to the Native Host in macOS System Settings. This native
path requires macOS 15 or newer. The popup tabCapture recorder remains a
separate fallback.

## Recover safely

- Reconnect only through the same task and profile. Never claim a foreign tab.
- Keep connection recovery in the shared broker/extension lifecycle. Tasks
  resume their own sessions after fresh status; they do not each initiate a
  competing profile-wide reload.
- An accepted or uncertain reload is not a completed recovery. Read status
  and confirm the new generation before resuming. Do not send another reload
  with a different key merely because the first response was lost.
- A status timeout means the current state is unconfirmed, not that the
  extension is absent. Compare fresh transport and setup observations before
  recommending installation.
- Release the task-owned lease and close the logical session after a run.
- If a refresh is deferred, keep the receipt and retry at the stated idle
  boundary; do not repeatedly reload Chrome.
- For a stale task-tab record, use `purge:missing-task-tabs` only after a fresh
  `tabs.list` confirms the exact tab is gone.

### `Transport closed`

The Codex App owns the stdio MCP lifetime. When an MCP process is replaced for
the same Codex task, call `companion_prepare_resume` with the prior `sessionId`
and `runId`. It proves the same task/profile through fresh broker readback and
returns a new `session_id` only when safe; reacquire a fresh lease, never reuse
old leases, and never replay actions. A new Codex task has a different owner
and cannot adopt the old task's session. Never replay an operation whose
response was interrupted; read the exact page or provider first because its
effect may be unknown.

For a complete protocol and security description, see [PROTOCOL.md](PROTOCOL.md)
and [SECURITY.md](SECURITY.md).
