# AOS Chrome Companion

A clean-room Chrome execution surface for Codex and Automation OS. It is built
to coexist with the official ChatGPT/Codex Extension while owning its own MV3
Extension, Native Messaging relay, resident broker, versioned protocol, logical
sessions, and exact-tab leases.

This repository contains the Companion source and packaging definitions. The
Chrome extension is one part of the product: a usable installation also needs
the local Native Messaging host/broker and the Codex plugin. It does not patch
or replace the official Extension.

The project is released under the [MIT License](LICENSE).

## Status and installation model

The current release candidate is macOS-first. A friend can use the source from
this repository, but a Chrome Web Store install alone cannot install a Native
Messaging host or register a Codex plugin. The supported flow is:

1. Install the signed Companion product package for macOS.
2. Install/enable the AOS Chrome Companion extension in the same Chrome
   profile.
3. Start Codex; the bundled plugin connects to the local broker.

The repository also contains a Developer Mode path for contributors. Windows,
Linux, other Chromium browsers, and a public Chrome Web Store listing are not
claimed as ready until their signed package and end-to-end verification exist.

New users should start with [docs/QUICKSTART.md](docs/QUICKSTART.md), which
covers installation, the first read-only check, and safe recovery.

## Live connection doctor

When a live Companion connection is missing or reports an unexpected build,
run the read-only doctor. It reports broker process multiplicity, socket and
data paths, source/installed build and operation-schema agreement, connected
profiles, logical sessions, tab leases, durable ledger/reconciliation backlog,
and auto-setup receipt mismatches. It never starts, stops, reloads, cleans up,
or writes Companion state:

```bash
npm run doctor
npm run doctor -- --json
```

Use `--data-dir`, `--socket`, `--state-file`, `--installed-root`, or
`--chrome-user-data-dir` when diagnosing a non-default installation. A
non-zero exit means the report contains a blocker; use the exact blocker and
the paths in the JSON report as the restart point.

When a session appears to disconnect, run the read-only doctor before
restarting anything:

```bash
npm run doctor -- --output=outputs/doctor-latest.json
```

It reports duplicate brokers, stale MCP processes, profile/build drift,
reconciliation backlog, and ledger pressure without claiming or closing any
foreign session or tab.

## Two-extension target release (not the current local development install)

The intended signed release has exactly two user-visible Chrome Extensions: the
official ChatGPT/Codex Extension and AOS Chrome Companion. The Companion
bundles its Native Messaging relay, resident broker, MCP adapter, and task
execution capsule as internal support components; they are not a third Chrome
Extension or separate product, and users do not manually configure an AOS
endpoint, profile number, session, or tab.

The current local development build still requires Developer Mode, loading an
unpacked Extension, copying its ID, and running the macOS installer. Those are
development steps and must not be described as the final two-click release.
The release builder bundles the selected Node executable; the existing x64
package includes it. Public release readiness still requires the Chrome Web
Store receipt, Apple Developer ID signing/notarization, and a separately
verified runtime/package for each additional architecture such as arm64.
Use the generated release receipt for the status of a particular build.

## Automatic two-Extension convergence

After the Companion product bootstrap has been installed once, setup is
convergent and unattended. The MV3 `onInstalled` connection, the Companion
Native Host, the Codex plugin startup, and a 60-second macOS LaunchAgent all
invoke the same idempotent setup owner. As soon as the official ChatGPT/Codex
Extension and AOS Chrome Companion are both enabled in Chrome Profile 2, it:

- verifies (but never fabricates) the official Extension Native Host;
- repairs the Companion Native Host registration for the installed Extension ID;
- installs/enables `chrome@openai-bundled` and the local Companion Codex plugin;
- writes the adaptive two-Extension selector with Companion as the normal-work
  preference and preserves non-Chrome selections;
- stores a bounded `setup-state.json` receipt and shows **Automatic setup:
  Ready** in the Companion popup.

This makes later Extension reinstall/update flows zero-configuration on a Mac
that already has the signed Companion product bootstrap. A fresh Mac still
needs that signed/notarized product bootstrap once: Chrome Extension code
cannot write a Native Messaging Host manifest or silently approve Codex plugin
policy. Chrome, macOS, and Codex permission prompts remain explicit security
boundaries.

### Control-plane-only repair

When the installed MCP/broker is older than this checkout, the control plane
can be synchronized without opening `chrome://extensions` or closing retained
task tabs. The command requires an idle broker (no logical sessions, leases,
pending operations, queues, or active task tabs), preserves the current
Extension build ID, atomically replaces `app/src`, requests one signed
Extension runtime reload at that idle boundary, gracefully restarts the
verified resident broker, and records a receipt under the Companion support
directory. If the profile is not connected or work is active, it defers before
the broker restart and records the exact restart point for the next tick:

```bash
npm run sync:control-plane:macos -- \
  --apply --restart-broker \
  --extension-id <companion-extension-id>
```

Stale-generation reconciliation tabs are intentionally retained. After this
command, start a fresh Codex task so its MCP startup snapshot includes the
latest `companion_rebind_reconciliation` and `companion_refresh_extension`
tools; the already-running task's tool list is not mutated in place.

## Read-only endurance checks

`npm run soak:readonly` samples broker health for 24 hours. Its result is
`verified_status_sampling` only when every sample succeeds; this mode does
not prove browser operation. Reports are checkpointed during the run, and
interruption or a failed sample produces a nonzero exit code.

To exercise the browser through the Companion MCP adapter, use an explicit
current task identity and browser mode. Each sample opens a local fixture in
its own task tab, verifies semantic content and an image receipt, then closes
that tab and checks session/lease cleanup. The default interval is five
minutes. `--app-dir` selects the installed runtime to measure:

```bash
node scripts/soak-readonly.mjs --mode=browser \
  --task-id=<current-codex-task-id> \
  --app-dir="/absolute/path/to/installed/app" \
  --duration-ms=86400000 --interval-ms=300000
```

This measures local browser execution and cleanup across the stated duration;
it does not establish real-provider task success. Review the first screenshot
and the recorded sample errors. For an existing real-site task tab, use
`canary:real:readonly` with the exact URL and, when needed, `--tab-id`. The
canary requires current-task ownership and a matching live URL, and closes
only its newly opened logical session while preserving the existing tab.

## Release packaging

The release builder produces a Chrome Web Store ZIP and a macOS flat installer
that contains the Companion runtime, production dependencies, Native Messaging
manifest, Codex plugin files, and a selected Node executable. Secrets are never
accepted on command-line arguments.

```bash
npm run release:build:macos -- \
  --extension-id <web-store-extension-id> \
  --node-runtime /absolute/path/to/node \
  --node-license /absolute/path/to/Node-distribution/LICENSE \
  --application-signing-identity "Developer ID Application: ..." \
  --installer-signing-identity "Developer ID Installer: ..." \
  --notary-profile <notarytool-keychain-profile>

npm run release:verify:macos -- \
  --receipt /absolute/path/to/release-receipt.json
```

Use an official standalone Node distribution for the target architecture. The
builder rejects Homebrew or other binaries with external dylib dependencies,
bundles the distribution LICENSE, and runs the relocated executable. It also
stamps one release build ID into the packaged broker and both extension copies.
When a Developer ID Application identity is supplied, the builder preserves
Node's V8 entitlements and removes `com.apple.security.get-task-allow` before
re-signing, then checks the signature and JavaScript execution. An existing
vendor signature can still contain the debugger entitlement; the receipt
records that condition and does not treat it as distribution-ready. Apple
Distribution certificates do not substitute for Developer ID certificates.

Upload uses the Chrome Web Store API v2. Put the short-lived OAuth access token
in `CHROME_WEB_STORE_ACCESS_TOKEN`, then pass only public identifiers and the
ZIP path. Omit `--publish` for upload-only staging; include it to submit the
uploaded item for review.

```bash
CHROME_WEB_STORE_ACCESS_TOKEN=... npm run release:publish:webstore -- \
  --zip /absolute/path/to/extension.zip \
  --publisher-id <publisher-id> \
  --extension-id <web-store-extension-id> \
  --publish
```

The Companion can stabilize browser transport, target ownership, reconnect,
parallel sessions, lifecycle cleanup, and visual readback. It cannot bypass
CAPTCHA, OTP, identity verification, payment approval, website policy, or the
official Extension's private runtime. A simultaneous opaque mutation by the
official Extension and Companion on the same tab is therefore serialized or
reported as a conflict.

When the profile reaches a safe boundary, the MCP tool
`companion_reload_extension` can reload the unpacked Companion directly through
its signed broker path. It does not open `chrome://extensions` or move the
user's OS cursor. The request is deferred while leases, pending operations,
timeouts, or reconciliation work remain; after acceptance, the caller must
read fresh status and open a new logical session because the Extension
generation changes. This is a runtime reload of the currently loaded build,
not a Chrome Web Store download or publication.

## Implemented vertical slice

- profile-local stable instance ID;
- Native Messaging connection with automatic local broker startup;
- one resident broker with authenticated client connections;
- multiple generation-fenced logical sessions;
- automatic binding to the host-supplied Codex thread metadata for each MCP
  request (with `CODEX_THREAD_ID`/`CODEX_SESSION_ID` fallback for local runs);
- exclusive exact-tab leases;
- distinct-tab parallel queues and profile-global FIFO;
- grouped reusable Companion-owned tabs per Codex task and compatible target;
- fresh-inventory dynamic target resolution keyed by task/session/lease/generation,
  with typed ambiguous/busy/stale/protected outcomes and no foreign-tab adoption;
- bounded tab list/create/get/close/activate/navigate/group operations;
- bounded semantic page snapshot/click/type/upload/submit/wait operations;
- exact semantic text-range selection inside contenteditable rich-text editors,
  so a following semantic toolbar click can format the intended text without a
  guessed mouse drag;
- exact-frame semantic actions for iframe controls, with explicit frame-origin
  authorization and no unsafe conversion of frame-local geometry into physical
  whole-tab coordinates;
- native/ARIA/custom dropdown inspection with same-tab screenshot-bound signed
  proof before atomic selection;
- screenshot-bound arbitrary visible-point inspection for Codex-style visual
  actions, with a temporary blue in-page cursor that never moves the OS cursor;
- `visual.pointerMove` also supports a `virtualOnly` preview that never
  activates or focuses the Chrome window;
- automatic exact-tab visual fallback when semantic readback is empty, incomplete, or ambiguous;
- visible animated Companion cursor and action label for every page mutation;
- alarm-backed MV3 reconnect watchdog and hello timeout;
- mutation timeout classified as unknown effect with no replay;
- visible submit controls use one semantic click; an unchanged post-dispatch
  readback becomes unknown effect instead of an alternate-method retry;
- signed semantic-plus-screenshot reconciliation completion turns a confirmed
  provider-success tab from reconciliation retention into terminal cleanup;
- owner-visible session/lease status and deterministic timeout resume disposition;
- receipt-bound hookless transfer of retained Companion tabs into the exact destination task;
- terminal-success tab cleanup by default, plus task-ID-scoped stale task-tab
  cleanup that never lists or closes foreign-task, manual, or
  official-Extension tabs;
- explicit signed missing-record purge for user-approved stale-generation
  task tabs whose exact Chrome tab is already absent; live tabs are always
  retained and no `tabs.close` is dispatched;
- owner-scoped display archival for unresolved reconciliation records, keeping
  state/evidence immutable and leaving the scheduler's full pending gate
  unchanged;
- signed per-install task authority and atomic idempotency ledger;
- durable `task_execution_capsule_v1` lifecycle, target identity, resume,
  visual-proof, and workflow completion metadata;
- task-owned authorized transaction with origin redirect guard;
- Codex plugin and MCP tools;
- connection diagnostic popup;
- macOS development Native Host installer.

## Development

```bash
npm install
npm run check
npm test
```

To load the development Extension, open `chrome://extensions` in the intended
Chrome profile, enable Developer mode, choose **Load unpacked**, and select the
absolute `extension/` directory from this repository. Copy the resulting
32-character Extension ID, then register the development Native Host:

```bash
npm run install:dev:macos -- --extension-id <extension-id>
```

When Chrome has already been closed and a fresh `tabs.list` confirms that a
specific stale task-tab no longer exists, purge only those exact records with
an explicit approval flag:

```bash
npm run purge:missing-task-tabs -- --execute --task-id <task-id> \
  --tab-id <tab-id> [--tab-id <tab-id> ...]
```

This command removes internal task-tab records only; it never closes a live
tab or replays the original operation.

The first development load still requires one manual **Load unpacked** action.
After that bootstrap, `install:local:macos` and
`sync:control-plane:macos --restart-broker` perform the signed runtime reload
and broker reconnect automatically whenever the idle connected boundary is
available; no recurring Developer Mode Reload click is required. Their receipt
is the source of truth when a refresh is deferred.

## MCP tools

The source plugin lives under `plugins/aos-chrome-companion`. Its MCP server
exposes status, session, tab reservation, page read (with automatic visual
fallback), exact-tab screenshot,
authorized semantic transactions, upload, wait, release, and close operations. Each request is
bound to the host-provided Codex task metadata, and every session and lease is
checked against that task before use. The source plugin's `.mcp.json`
contains the current development checkout path; the signed product installer
must rewrite that path to its installed application directory.

Protocol and current security boundaries are documented in
`docs/PROTOCOL.md` and `docs/SECURITY.md`.

## Automation OS adapter

Automation OS uses a thin adapter at
`automation-os/scripts/aos-chrome-companion-adapter.mjs`. Its initial stage is
target-scoped and read-only: it binds one AOS run/task to one logical Companion
session and exact tab, returns a redacted receipt, and closes the session. An
explicit `mode=authorized` request uses the signed task transaction path and
reuses or creates that task's grouped Companion-owned tab; other tabs remain
read-only. Provider receipts
remain untrusted until AOS validates them and performs independent readback.
It reports `aos_chrome_companion_profile_instance` as its own execution
surface; it never presents Companion evidence as an official-Extension
receipt.
