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
   npm run install:dev:macos -- --extension-id <copied-extension-id>
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

If the status read itself is unavailable or the connected runtime looks stale,
run the local doctor for one bounded snapshot of the common transport causes:

```bash
npm run doctor
npm run doctor -- --json
```

The doctor is read-only. It counts broker processes, inspects the socket/data
directory, compares build and operation-schema values, lists connected
profiles/sessions/leases, reads ledger and reconciliation counts, and compares
the auto-setup receipt with the current Profile 2 detection. It does not start
or stop a broker, reload Chrome, adopt foreign resources, or edit state.

If status reports a different build, profile, task, generation, or lease,
stop and use the exact recovery instruction in the error. Do not retry a
timed-out mutation until its effect has been reconciled.

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

For a complete protocol and security description, see [PROTOCOL.md](PROTOCOL.md)
and [SECURITY.md](SECURITY.md).
