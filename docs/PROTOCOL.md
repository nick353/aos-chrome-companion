# AOS Chrome Companion Protocol 0.1

The local protocol uses authenticated newline-delimited JSON over a user-only
Unix-domain socket. Chrome Native Messaging uses its required 32-bit native
length prefix between the MV3 Extension and the relay.

## Peers

- `extension-relay`: one Chrome-started relay for one connected Companion
  Extension instance.
- `client`: a Codex MCP adapter, AOS adapter, diagnostic client, or test client.

Every peer begins with `peer.hello`, protocol version `0.1.0`, its role, and the
32-byte local broker secret. The socket and secret are both user-only.

## Profile generation

The Extension hello also carries an install-specific `buildId`, the generated
operation schema/version, and a capabilities digest. The first local install
writes a unique value to both the staged Extension and Node broker; later local
updates keep that value stable and use the signed `extension.reload` boundary
to load the new source. The broker exposes the values as `expectedBuildId` and
runtime contract fields in status and rejects explicitly mismatched values
before a profile becomes connected. A missing contract is kept visible as
`runtime_update_pending` rather than being filled with the broker's values, so
an older installed Extension cannot look current. A build change also
invalidates a persisted runtime binding so old task tabs are quarantined
instead of being silently reused.

The Extension stores a random `profile_instance_id` in `chrome.storage.local`.
Transient Native Messaging reconnects keep the same runtime identity and
generation so a short port loss does not quarantine every task tab. An explicit
`extension.reload` rotates the runtime identity and receives a new broker
generation. Logical sessions, tab leases, and pending operations cannot cross a
generation change.

## Client methods

- `status.get`
- `capabilities.get`
- `profile.list`
- `extension.reload`
- `session.open`, `session.close`
- `lease.acquire`, `lease.release`
- `operation.execute`
- `task.transaction`
- `task.tabs.group`
- `task.tabs.transfer`
- `task.status`
- `operation.reconcile`
- `request.cancel` (only a request ID on the same authenticated client connection)

`operation.execute` accepts only the typed Extension method allowlist. Every
target-scoped operation requires a matching logical session, generation, exact
tab ID, and exact-tab lease. Distinct tabs have separate queues. Profile-global
operations share a FIFO queue.

`capabilities.get` is a read-only planning aid. It derives its `capabilities`
array from the same `OPERATION_DEFINITIONS` used by admission and handshake,
and includes each method's target scope, mutation/profile-global class,
prerequisites, permission class, recovery rule, short purpose, and expected
readback. The response also includes the operation schema
digest and an observed `runtime` list with connected profile generation,
build/schema identifiers, and capability digest. A static capability entry is
not proof that a target is available or that a site accepted an upload, save, or
submission; callers must still inspect the exact target and use the normal
transaction/readback contract. Optional exact `methods` filtering only reduces
the returned list and causes no tab, lease, or page operation.

Client request envelopes include an absolute `deadlineAt`, bounded to ten
minutes. The broker applies it to queue admission as well as dispatch; legacy
envelopes without a deadline receive a bounded default. `BrokerClient` forwards
timeouts and `AbortSignal` cancellation, and the MCP adapter carries the SDK's
per-call signal through authority signing. Cancellation cannot target another
client's request. Releasing an owned lease or session remains possible from an
aborted MCP call's cleanup. Read-only reconnect attempts share the original
deadline instead of receiving a new full budget.

Before sending a queued command, and again after its durable dispatch
reservation, the broker revalidates the original session, current profile
generation and transport, exact lease, task/run ownership, and authority expiry.
An expired or cancelled command that never reached the transport is recorded
as `no_dispatch`, with `dispatchCount:0` and `mutationDispatchAttempted:false`.
Cancelled ordering markers remain behind their predecessor until it drains;
later same-tab work cannot overtake an older operation.

Cancellation does not undo an already dispatched browser command. The broker
continues collecting that command's original result and stops subsequent
dispatches in the cancelled request. A missing mutation result is
`unknown_effect`, including local input, and must not be replayed. Local input
uncertainty has `reconciliationRequired:false` for the external-provider gate;
its page and action progress still require exact-target readback. An authentic
late result can reconcile the original ledger entry without another command.
An uncertain first local edit is retained through MCP replacement even when
no earlier action completed. Protocol tests use controlled broker/relay and
real MCP processes; installed Chrome load and fairness are separate evidence.

`page.query` accepts a text query and/or structured locator, optional explicit
attribute names, pagination (`offset`, `limit` up to 100), and `includeHidden`.
Structured locators can combine CSS, semantic fields, exact/regular-expression
text matching, ancestor/descendant constraints and an outer match index. Open
Shadow DOM is traversed within the authorized frame. Results distinguish the
returned `count` from `totalCount`, expose `nextOffset`, and mark scan/attribute
truncation. The 5,000-candidate bound is not a claim of a complete document scan;
single-target actions require a narrower selector when that bound is reached.
These are typed data operations, not arbitrary JavaScript evaluation or a full
Playwright API implementation. See the plugin action-parameters reference for
matching behavior and examples.

`page.screenshot` is a read-only target operation that is serialized through
the profile-global FIFO because Chrome's `captureVisibleTab` captures the
currently active tab. The Extension temporarily activates the exact leased
tab, captures a bounded JPEG, and restores the previous active tab when
possible. The result is returned as an MCP image block plus redacted metadata;
it never performs a page mutation. If the target cannot be kept active or the
bounded image size cannot be met, the operation fails closed.

Optional `fullPage:true` or `clip:{x,y,width,height}` selects a document capture
through Chrome's public `Page.captureScreenshot` command. Clip coordinates are
document CSS pixels; the region must fit inside the page, at most 32,768 pixels
per side and 32 million CSS pixels. The default byte limit is 700,000 and the
document-capture maximum is 2,000,000. The image is JPEG, with bounded quality
reduction when necessary. This path uses the existing debugger opt-in and does
not send viewport emulation or tab activation commands. It rejects a changed
document loader, URL, layout, or viewport during capture. Ordinary viewport
capture retains its 700,000-byte maximum.

`page.elementScreenshot` defaults to `mode:crop`: it measures one main-frame
element in document coordinates without scrolling, captures that exact region,
then verifies the element and document again. `mode:viewport` preserves the
legacy viewport image with target geometry. Child-frame crops remain unsupported
until their coordinate transforms can be verified.

`page.accessibilitySnapshot` returns Chrome's native selected-frame accessibility
nodes through `Accessibility.getFullAXTree`. It includes computed roles, names,
descriptions, selected observable states, and parent/child relationships, with
ignored nodes optionally included. Node values, editable descendants (which can
repeat an input value as static text), raw name sources and child-frame subtrees
are omitted. Limits are 2,000 returned nodes, depth 50, and 100,000 text
characters, with truncation metadata. The default is the main frame; `framePath`
selects one child using up to eight zero-based child indices, within the operation's
allowed origins. The selected frame and root document identities are checked again
after the read. Out-of-process child debugger targets are not expanded automatically.
Each node has a one-based `index`, bound to `snapshotId`; these indices and node IDs
are not mutation targets (`indexActionsSupported:false`). Pass `sinceSnapshotId`
with the same depth, node limit and ignored-node option to receive only additions,
removed IDs and changed nodes. Diffs are limited to the observed bounded trees;
truncation prevents a complete-coverage claim. Baselines are scoped to task/session/
generation/tab/document, expire after five minutes, are capped at sixteen snapshots,
and clear on disconnect or owner-session close. The existing semantic snapshot remains the
default read and continues to include its proactive visual confirmation.

`page.assets` / `companion_list_page_assets` inventories file declarations in
the exact leased document: images, video, fonts, stylesheets, scripts and other
observed resources, plus inline SVG markup. File entries have inventory-scoped
IDs, a kind/name/URL and observed sources (attributes, computed styles, readable
CSS rules or Resource Timing). Duplicate absolute URLs merge their sources.
CSS URLs resolve against their stylesheet, including imports and adopted
stylesheets in discovered open shadow roots. Inline SVG markup is untrusted
page source, not a sanitized standalone export. Inventory IDs are read results,
not authorization tokens or durable download handles.

The operation performs no explicit asset fetches. It reads the current page
state and resource timing buffer, which may be incomplete; normal page loading
can continue during the read. Cross-origin stylesheets whose CSS rules are
unreadable are reported without a fetch fallback. Limits cover file count
(100 default, 500 maximum), scanned elements (1,000 default, 5,000 maximum),
5,000 CSS rules, the last 5,000 resource entries, 100 inline SVGs and 20,000
characters per SVG. `maxBytes` bounds the serialized inventory before transport
metadata (150,000 default; 10,000–500,000). Truncation flags and summary counts
describe the returned data; they do not assert whole-site coverage. URLs omit
credentials and recognized secret query fields and are capped at 2,000
characters. `kinds`, `includeComputedStyles` and `includeInlineSvgs` narrow the
read. Load any needed lazy UI first, then list again. Child frames require an
explicit permitted `frameId`; a parent read does not expand them. Asset bundling
is not implemented by this listing operation.

`page.observe` / `companion_observe_page` starts bounded console and network
observation before the operation being investigated. `action:start` returns
an `observationId` and cursor; `action:read` with both returns only newer
entries. Start is idempotent within the same tab/task/session/generation and
keeps the existing capture options and buffer. Request, response and finish/
failure records include the request ID, protocol timestamp, status/type when
available and frame ID. Console entries retain their protocol timestamp and
mark messages Chrome may have replayed from before observation began. This
does not expose an arbitrary CDP command or JavaScript evaluation API.

Observation requires a task-owned tab and exact lease on every call. It shares
the Extension's own debugger attachment with visual input and document reads;
an attachment owned by another debugger is never adopted. The final borrower
releases the attachment. `action:stop` reports that release result. Session
deletion sends a matching profile/generation/session lifecycle notification;
the Extension then stops and discards only those observation buffers. Native
port loss discards all buffers in that disconnected Extension, and tab closure
or browser debugger detachment stops its observation without reattaching.
Session-close notification is asynchronous; explicit observer stop is the
path for a direct debugger-release receipt.

Defaults are five minutes, 1,000 entries and 1,000,000 buffer bytes. Maximums
are 30 minutes, 5,000 entries, 2,000,000 buffer bytes, eight active tabs and
20 retained observation records. Cursors expose evicted entries through
`cursorExpired` and `droppedEntries`; they do not silently claim lossless
capture. A new top-level origin stops the observer. Buffers are in memory and
do not survive an Extension restart. Child debugger sessions, workers,
WebSocket payloads, headers and request bodies are not captured. The existing
Resource Timing and short console tools remain available for simple reads.

`allowResponseBodies:true` at start enables `action:body` for one captured,
finished same-origin request ID. Only textual MIME types are returned, with
recognized secret patterns redacted and a text length bound. The public
`Network.getResponseBody` command reads Chrome's retained data; an evicted or
unavailable body produces an exact error and never replays or fetches the
request. Cross-origin and binary bodies are outside this operation's scope.

References: [Chrome debugger lifecycle](https://developer.chrome.com/docs/extensions/reference/api/debugger),
[Network events and response bodies](https://chromedevtools.github.io/devtools-protocol/tot/Network/)
and [Runtime console events](https://chromedevtools.github.io/devtools-protocol/tot/Runtime/).

Protocol references: [Chrome Page capture and layout methods](https://chromedevtools.github.io/devtools-protocol/tot/Page/)
and [Chrome Accessibility methods](https://chromedevtools.github.io/devtools-protocol/tot/Accessibility/).

`visual.point.inspect` is a read-only exact-tab operation for a user-visible
viewport point when semantic locators cannot identify the control. It captures
the point's current page instance, viewport, and a same-tab screenshot into a
single-use signed proof. A later `visual.*` action must present that proof and
the broker revalidates the page instance, point, and viewport immediately
before dispatch. The Extension renders only a temporary in-page blue cursor
(`pointer-events:none`); it never moves or synthesizes the user's OS cursor.

The MCP `companion_read_page` tool invokes this operation automatically when
its semantic snapshot is empty, still loading, or ambiguous. It returns the
semantic result together with the image block and a reason of
`semantic_snapshot_ambiguous` or `semantic_snapshot_error`. The image is
evidence for the current tab only; disagreement between semantic and visual
evidence remains `PENDING_CONFIRMATION` and never triggers a replay.

The local LaunchAgent also performs a read-only control-plane hash comparison
between the development source and the installed Companion app.  When drift
is found (or the previous sync receipt was deferred because a session was
busy), it invokes one supported `sync-control-plane-macos` attempt.  That
script is the only path allowed to perform the profile-global refresh: it
requires an idle, reconciled profile, requests the signed Extension reload,
restarts the resident broker, and requires a changed generation readback.
Busy sessions leave a private deferred receipt for the next tick; no Chrome
UI reload button, duplicate broker, or operation replay is used.

## Mutation timeout

A timed-out read returns `operation_timeout`. A timed-out mutation returns
`operation_effect_unknown`. The broker does not dispatch the mutation again.
The caller must reconcile the exact target and any workflow-specific receipt.

Profile-global tab lifecycle operations use bounded method-specific defaults:
`tabs.create` and `tabs.navigate` use 30 seconds, `tabs.close`,
`tabs.activate`, and `tabs.groupTask` use 20 seconds, and `page.screenshot`
uses 30 seconds. Other operations retain the 15-second default. These values
cover normal navigation/grouping latency without removing the no-replay rule.
The Extension also spaces `captureVisibleTab` calls by a bounded cooldown so
parallel visual readbacks stay below Chrome's per-second capture quota.

`extension.reload` is a signed, profile-global lifecycle control. The broker
accepts it only from an owned session at a safe boundary: no active lease,
pending operation, active timed-out mutation, or live unresolved reconciliation
tab may exist in that profile. Historical `ledger_only` tabs and their
unknown-effect evidence do not count as live profile work. The Extension returns an acceptance receipt,
rotates its runtime identity, and invokes `chrome.runtime.reload()` without
opening `chrome://extensions`, moving the user's OS cursor, or touching page
tabs. The resulting hello handshake receives a new profile generation; callers
must read fresh `companion_status` and open a new logical session before doing
more work. A supplied `expectedBuildId` is checked by both broker and Extension
so a stale or mismatched loaded build cannot be reloaded accidentally.

## Task authority and task-owned mutations

The broker peer secret only authenticates the socket peer. Mutations also carry
an `aos.chrome_companion.authority.v1` HMAC envelope signed by the per-install
`aos` or `codex_mcp` issuer secret. The envelope binds issuer, run, task,
session owner, exact method and intent, target origin, idempotency key, payload
digest, time window, and nonce. Issuer files are user-only (`0600`) and are
never logged.

`task.transaction` accepts an optional internal `task_execution_capsule_v1`.
Its target identity is a stable `targetKey` (derived from a canonical locator
or full start URL when omitted), workflow type, lifecycle state, resume token,
visual proof metadata, and completion contract. It reuses one task-owned tab
only when task ID, target key, and the current profile generation all match.
A currently leased matching target returns `target_resource_busy`; a tab for
another target is never adopted. Tabs from an older generation remain
quarantined and are never rebound to the new generation. The transaction takes a
pre-snapshot, performs a bounded semantic action sequence, validates the live
origin before and after each mutation, and returns redacted pre/post evidence.
Other tabs remain read-only. The lifecycle flags (`reuseTaskTab`,
`keepTaskTab`, and `retainOnUnknown`) and capsule input are part of the signed
payload. Capsule callers default completed tabs to cleanup; `awaiting_user` and
`reconciliation_required` retain a tab and resume token. Explicit
`keepTaskTab` remains a compatibility override.

`status.get` returns bounded, content-free `logicalSessions` and
`exactTabLeases` summaries. They expose task/session/lease ownership and
profile generation only; page URLs, text, secrets, peer IDs, and authority
envelopes are never included. The MCP adapter also marks the session and lease
IDs owned by the current Codex task.

The same response includes a self-consistent `runtimeAttestation`, a canonical
`recovery` index, opaque signed `recoveryHandles`, and persisted `handoffAcks`.
`recovery.profiles` and `recovery.tasks` each expose exactly one state and one
next action: `working`, `execution_idle`, `reconciliation_pending`,
`runtime_update_pending`, `cleanup_ready`, `waiting_user`, `blocked`, or
`done`. `execution_idle` is deliberately distinct from `fullyIdle`; unresolved
ledger effects remain visible and keep replay gates closed, while detached
`ledger_only` browser tabs do not keep profile refresh or unrelated execution
blocked. A recovery handle binds
task, run, session owner, profile generation, tab, page instance, window, frame,
and origin, but is transport metadata—not mutation authority. A handoff ACK is
HMAC-bound to the source/destination/run and receipt hash and is readback
evidence only.

`task.status` is a fresh signed read-only readback. It returns capsule state,
target key/locator, tab and current generation, blocker/restart point, resume
token, visual metadata, completion fields, and content-free liveness fields.
`resume_disposition` deterministically distinguishes same-generation resume,
fresh-target reconciliation, another signed status read, and completion. It
never calls the page or replays an operation.

The Codex MCP adapter binds `taskId` to the host-supplied MCP request metadata
used by Codex app tools, including `x-codex-turn-metadata` (falling back to
`CODEX_THREAD_ID`/`CODEX_SESSION_ID` only for local execution), and rejects a
caller-supplied mismatch or conflicting identities. The adapter records the
task that opened each logical session and lease; every later session/lease
operation must carry the same current task identity. Unknown bindings and
cross-task session or lease use fail closed, including close and cleanup paths.
`page.upload` materializes explicit local files inside the MCP process and
sends no local path to Chrome. Upload materialization accepts up to 25 MiB per file and 25 MiB total per
`page.uploadMultiple` command (1–10 files). These are explicit local regular
non-symlink files of a supported type. A successful file-input readback proves
attachment in that input; it does not prove submission to a provider.
Both upload operations have a 60-second broker deadline, including transport,
and a 45-second page-execution deadline. These are bounded waits, not retries;
a timed-out dispatched operation still requires readback before continuation.
Successful `uploadTiming` separates page preparation, assignment/readback,
page injection (including the Chrome bridge), and the final origin read, and
reports page visibility. It does not measure provider-side processing.

Native Messaging has directional limits: host-to-Chrome messages are at most
1 MiB; Chrome-to-host messages are at most 64 MiB. Explicit upload
commands larger than 1 MiB are transported as `command.chunk` packets,
with 384 KiB of command bytes per packet. Reassembly is capped at 36 MiB per
command, two concurrent transfers, and 30 seconds. Sequence, envelope, byte
count and SHA-256 must match before dispatch. Disconnect discards partial
transfers; the relay never retries an upload. Other oversized commands are
rejected before dispatch. See the [Chrome Native Messaging specification](https://developer.chrome.com/docs/extensions/develop/concepts/native-messaging).
`tabs.groupTask` and page mutations
receive the bound task context for group titles and the visible Companion
action marker. The operation ledger records
`prepared -> dispatched -> applied|unknown_effect -> reconciled`; a duplicate
fingerprint or a late result with a different profile, generation, session,
owner, tab, or payload is rejected. A broker restart converts dispatched work
to `unknown_effect`; it is never replayed automatically.

`maintenance.operations.archive` is an owner-scoped display-maintenance
operation for unresolved ledger records. It requires a signed exact task/run
binding and explicit archive-only confirmation, preserves the original state,
evidence, and binding, and is idempotent for the supplied archive key. It
never reconciles, replays, deletes, closes tabs, or lowers
`reconciliationPendingCount`; `companion_status` additionally reports
informational visible and archived pending counts.

`task.tabs.group` is a signed migration/maintenance method. It inventories the
current profile, groups only ledger-proven tabs for the bound task, skips leased
or unsupported tabs, removes missing provenance, and never adopts another
task's or the official Extension's tabs.  Its optional `collapsed` flag folds
the task group after grouping; this changes only the Chrome tab-group display,
not page/provider state.

`maintenance.tabs.cleanup` closes terminal/stale-generation tabs that are
explicitly cleanup-eligible.  Retained `reconciliation_required` and
`operation_effect_unknown` tabs are not closed: when they are old, unleased,
non-pinned, non-active, and not user-help tabs, cleanup folds their task group
and reports `collapse_candidates`/`collapsed` in the receipt.  This keeps the
browser surface tidy while preserving the tab and its evidence for signed
reconciliation.

When the owning client, Extension transport, or broker is lost, the browser
tab and the provider-effect record are separated.  An unresolved task-tab is
marked `retentionPolicy=ledger_only` and carries `tabDisposition=ledger_only`;
the operation ledger/capsule remains `unknown_effect` evidence, but the tab is
disposable and is not a resume prerequisite.  On the next owner-scoped fresh
inventory, an exact task-owned, unleased, non-pinned, non-active ledger-only
tab is closed once (or its record is removed when already absent).  If the tab
close acknowledgement is itself unknown, only the tab record is discarded;
the close operation's evidence remains in the ledger and is never replayed.
User-help tabs, active/pinned tabs, live-owner tabs, foreign tabs, and browser
internal/unsupported origins remain protected.  A new task/run uses a fresh
tab and a new idempotency key; it never replays the old unknown operation.

`task.tabs.transfer` is the hookless historyless-handoff ownership operation.
The destination session signs the exact source, destination, run, and private
receipt path. The broker accepts only the source-bound `0600` receipt inside
the configured `~/.codex/project-state-ledger/handoff-receipts` directory and
verifies that the receipt names the current destination, forbids further source
implementation, keeps the source visible, and records a claimed or completed
handoff. It then atomically rebinds only live, current-generation, unleased,
retained Companion ledger tabs. Cleanup, quarantined, foreign, and official
Extension tabs are never adopted. The transfer records source and receipt-hash
provenance, is idempotent for that exact receipt, and performs only a tab
inventory read—never a page mutation or replay.

The operation ledger and task transaction expose an explicit four-state effect
classification: `no_dispatch` (no external dispatch occurred),
`known_no_effect` (a bounded attempt/readback proved no external effect),
`known_effect` (the broker observed the effect), and `unknown_effect` (the
effect may have happened and must be reconciled). Read-only timeouts remain
bounded late-result evidence but do not create an active reconciliation gate.
`task.prepare_resume` is a signed, read-only owner check that returns the
current session/generation/target identity, exact blocker, next action, and an
`aos.chrome_companion.operation_effect_proof.v1` when a stable operation
binding exists. It never opens, claims, mutates, or replays a tab.

The same private receipt is also a source-task mutation gate. Once it records
`implementation_allowed=false`, the broker rejects any later source-owned
transaction, grouping, or low-level mutation with
`source_handoff_implementation_forbidden`; signed status reads, lease release,
and session cleanup remain available for reconciliation. This prevents a stale
source task from creating a second browser effect after its destination was
claimed.

The MV3 service worker uses both a best-effort timer and persistent Chrome
alarms for reconnect, plus a bounded hello-ack timeout. Every successful
reconnect creates a new generation and invalidates older sessions and leases.

### Continuing a specific tab without reloading

`companion_authorized_transaction` / `task.transaction` accept optional `tabId`.
Pass the previous result's `tab.id` to continue that exact retained task tab at
its **current** URL. `startUrl` remains required as the creation/authority
origin descriptor; with `tabId` it is not a navigation instruction. This keeps
SPA route changes and unsaved form values across separate transactions. An
explicit `tabs.navigate` action is still available when navigation is intended.

The tab ID is included in the signed payload. Resolution requires the same
task, profile and generation, a fresh live inventory, an allowed current
origin, an available lease and an unprotected retained record. Missing or
protected targets do not fall back to another tab or create a replacement.
`tabId` with `reuseTaskTab:false` is invalid. Omission preserves the existing
create/reuse-and-navigate behavior. Tab retention still requires `keepTaskTab`
or the existing capsule retention policy; this option does not adopt user tabs.

### Text replacement and locator waits

Rich-editor typing inserts explicit line-break nodes and compares rendered
`innerText`, including blank/trailing lines, instead of treating raw
`textContent` equality as visible success. Explicit append preserves existing
formatting; populated whole-editor replacement still requires explicit clear.
The normal mutation route reports `semantic_input_not_committed` when the
requested value was not retained.

Trusted `visual.typeText` replacement uses the public CDP selectAll editing
command and a virtual key code, checks the complete focused-field selection,
then inserts replacement text without a separate destructive Backspace. It
checks the resulting value before reporting `valueVerified:true`. Failure to
select the field reports `physical_input_selection_failed` before text dispatch;
a mismatched result reports `physical_input_not_committed` after dispatch.
This verification covers ordinary input/textarea and contenteditable. A
nonempty native input that does not expose a verifiable selection (for example
some email/number controls) can reject physical replacement; use the semantic
field route where supported. `clear:false` remains insertion at the clicked
caret and does not claim whole-field value verification.

CDP reference: https://chromedevtools.github.io/devtools-protocol/tot/Input/#method-dispatchKeyEvent

`page.waitFor` polls a one-shot page probe from the extension worker. Its
`condition` is `visible` by default and may be `attached`, `detached`, or
`hidden`; the worker retries until that condition is met. Malformed selectors,
invalid regular expressions and ambiguous matches retain their actionable errors. The final fresh probe
runs even when a delayed worker wakeup crosses the deadline. This avoids a
page timer missing a target that already exists, but cannot guarantee an app's
own background timers will run by the caller's deadline. URL/load-state/popup
wait conditions remain separate future work.

Schema-upgrade recovery: a disconnected profile alone cannot authorize a
resident broker restart. An idle broker may restart when its recorded failed
Extension hello proves the same profile/install has already loaded **exactly**
the new installed operation-schema digest while the resident broker expects
the old digest. Active work, a different build/profile, or missing/mismatched
registration evidence still defers. This avoids waiting for a connection that
the old broker necessarily rejects. A subsequent ordinary signed reload and
fresh generation readback establish the latest Extension source reflection;
schema equality alone does not prove the service-worker source is current.

Native hello timeouts explicitly clear `connecting`, drop the exact port and
schedule reconnect before calling `Port.disconnect()`. Chrome does not emit
`onDisconnect` on the side that called `disconnect`; relying on that event can
leave the worker permanently connecting. Schema/capability handshake errors
also tear down immediately. The bounded regression executes a port double
with this documented event behavior and confirms the next hello succeeds.
Reference: https://developer.chrome.com/docs/extensions/reference/api/runtime#type-Port

Terminal session cleanup may close an eligible task-owned tab while holding that closing session’s idle lease. It keeps the lease reserved until session deletion, avoiding a release/reacquire gap. Foreign leases, active transactions, pending operations and unresolved timed-out operations remain protected.

Upload locators are matched only against file inputs before ordinal selection; a visible label and its associated file input no longer cause a false ambiguity. Upload preparation errors before the FileList assignment explicitly return operationEffectState=none and mutationDispatchAttempted=false. Errors after assignment preserve uncertainty and are not replayed.

Explicitly confirmed synthetic localhost retirement is now scoped to the signing session’s task and exact run/tab. Real Codex task IDs are accepted; arbitrary canary-name patterns are not authority. Foreign tasks, provider URLs, live owners and leases remain rejected, and unresolved operation evidence is preserved.

## Download artifacts

`page.download` accepts exactly one credential-free HTTP(S) `url` or an exact
main-frame link/media `locator`. The latter resolves the anchor destination or
current image/video/audio source through a read-only page operation and binds
the result to the signed page instance. The source element and page accompany
the completion receipt. Blob/data sources and child-frame locator downloads
remain unsupported until a page-triggered download workflow is available.

Register Chrome download changes before dispatch and retain early changes until
the returned numeric download ID is known. Filter every cancellation, removal
and history cleanup to that ID. The terminal poll still checks final URL, danger
and completion state. Failure to obtain a valid ID is unknown and never runs an
unscoped search or cleanup.

The browser receipt retains `filename` as a basename for compatibility and adds
the browser-owned absolute `filePath`, `fileSize` and MIME metadata. After the
operation is recorded as applied, the broker opens only that exact regular file,
rejects final-path symlinks, hashes its bytes and rechecks file/path identity,
size and timestamps. Compare local size with Chrome's post-decompression
`fileSize`, never compressed transfer sizes. The transaction returns a
`local_download` artifact with `verified:true`, absolute path, bytes and SHA-256.
A missing, changed or unreadable completed file yields a readback blocker and an
unverified artifact; the download stays applied and is excluded from remaining
actions. No remote request is used to repair a missing file.

Chrome may internally retry an interrupted download. Companion invocation counts
do not claim that every underlying HTTP GET occurs only once. Reference:
[Chrome downloads API](https://developer.chrome.com/docs/extensions/reference/api/downloads).

## JavaScript dialog observation and response

`page.inspectDialog` starts or reads a five-minute observation owned by the
broker's exact task, session, generation and tab. `action:stop` releases it once
no dialog is pending. Install the observation before the triggering action:
Chromium's `Page.enable` does not replay already emitted dialog openings, and
renderer commands can block while a modal is open. Repeated inspection uses the
same live opening identity without re-enabling Page or running DOM code. A dialog
that predates observation remains explicitly unavailable; no trigger is replayed.

`page.handleDialog` is permitted through one signed action on an exact owned
`tabId`. The broker uses the observed `javascript-dialog:<id>` identity for this
specific response and labels it as dialog evidence, with no document text digest.
It does not substitute this identity for a semantic DOM read in other actions.
The extension rechecks the opening, exact message, type and allowed frame origin.
An accepted ordinary prompt requires a literal `promptText`, including `""` when
an empty response is intended, at most 10,000 characters. Cancellation requires
no prompt text. Sensitive prompts require user handling and do not expose their
message or default input in observation results.

The closed-event listener precedes the response command. Both acknowledgement
and the same opening's close event must confirm the requested result; accepted
prompt input is compared locally and not returned. Missing/mismatched close
evidence is an unknown effect and never retries. A following dialog keeps the
same task tab and reports continuation, rather than attempting a blocked DOM
read or closing the tab. Failure to respond also retains the exact page. Ordinary
post-response DOM and screenshot readback resume once no modal is observed.
Native session/tab/generation cleanup releases the corresponding debugger share.

For a triggering action inside a signed transaction, set
`params.expectEvent: { type: "dialog", timeoutMs: 5000 }`. The worker installs the
opening listener before dispatching the action. The timeout defaults to 5,000 ms
and accepts 100–15,000 ms. This contract is part of the operation schema digest;
an older worker cannot silently ignore the expectation. Supported triggers are
`page.click`, `page.doubleClick`, `page.pressKey`, `page.submit`, `visual.click`,
`visual.doubleClick`, `visual.pressKey`, and `tabs.navigate/back/forward/reload`.
The event type is currently limited to `dialog`.

When a modal opens, `command.event` reports the operation-bound opening while
the original command remains alive. The broker returns `action_event_pending`
with `action_event` and preserves the exact tab. It does not run a blocked DOM
read or the remaining actions. The trigger remains uncertain and cannot be
replayed. Send one new signed `page.handleDialog` transaction with the original
task, session, run and exact tab, a new idempotency key, and the returned exact
`expectedDialogId` and `expectedMessage`. The response still passes the ordinary
ownership, generation, origin, quarantine and lease checks. Wrong identities
and sensitive dialogs do not dispatch a response.

After the matching close event, fresh DOM readback and the original command's
authentic late acknowledgement, `trigger_continuation.state` becomes
`readback_verified`. The original capsule then excludes the trigger from
uncertain and remaining actions; `prepare_resume` exposes only the unattempted
actions. This confirms a browser operation, with `provider_receipt_verified:
false`. It does not confirm a provider save, purchase, submission or delivery.
If the original acknowledgement is still unavailable, the trigger stays unknown.
If a completed trigger emits no opening by the deadline, `action_event_timeout`
preserves its applied status and never places it back in the remaining actions.

This continuation covers one opening in the same live session and generation.
Chained openings and a process/session replacement while the modal is open are
not established by this flow; they remain retained for separate readback and
must not cause an automatic response or trigger replay. The executable canary
`scripts/dialog-dom-canary.mjs <output-dir> --trigger-events` checks alert,
confirm and prompt through actual Chrome and the signed broker, including a
first transaction that creates its own tab. Its CDP relay adapter does not prove
installed native transport or normal host MCP publication.

Protocol/source references:
[Page domain](https://chromedevtools.github.io/devtools-protocol/tot/Page/),
[Chromium PageHandler](https://chromium.googlesource.com/chromium/src/+/refs/heads/main/content/browser/devtools/protocol/page_handler.cc).

## Rich-text formatting readback

`page.selectText` matches the editor's rendered `innerText`, so callers include
the actual line and paragraph separators in `text`. Optional `prefix` and
`suffix` match immediately adjacent rendered text before applying the
zero-based `occurrence` to any remaining matches. It maps rendered characters
to existing text-node boundaries before focus or selection; hidden duplicate
text does not count. Unsupported rendered-to-DOM mappings, including case
transforms that change characters, fail before selection dispatch. The final
native selection must have the exact requested text and the exact bound start
and end points, and the editor content must remain unchanged after events.
Preparation errors report no effect. A content change or failed verification
after selection reports an uncertain effect and never retries or clears a
replacement selection.

After an MCP process exits, call `companion_open_session` with the same host
task identity and original profile before `companion_prepare_resume`. The new
process does not inherit old session/lease bindings. Supply the original
run and capsule/idempotency identity, reserve and read the returned exact tab,
then submit only the returned remaining action indices under a new key.
Unknown effects remain reconciliation-required across both graceful process
close and SIGKILL; opening a process never replays an action.

`page.richText` binds one range to the exact contenteditable editor. A heading
(or `formatBlock`) request must cover one complete existing block; partial
paragraphs return `rich_text_block_boundary_required` before dispatch, and
multiple selected blocks return `rich_text_multiple_block_format_unsupported`
because Chromium can merge them. It does not split or replace user content.
An already matching heading returns `alreadySatisfied: true` without dispatch.

Success requires exact editor text preservation, preservation of text and
semantic structure outside the affected range, and the requested formatting in
the final DOM after input/change handlers and a bounded settling interval.
Selected heading content also preserves links, breaks and embedded elements;
harmless text-node splits and Chromium moving a break into an adjacent link
are normalized without normalizing text. `execCommand`'s boolean and element
counts are diagnostic only. Native input events are not duplicated.

Errors before command dispatch preserve `operationEffectState: none` only when
no editor change was observed. Once a command is attempted or preparation
changes the editor, failures remain `unknown`; callers must read the current
state without replay. This bounded DOM check does not prove a provider save,
framework model persistence, or stability after later asynchronous changes.

Run the production injected-function regression in a fresh, owned macOS Chrome
profile with `node scripts/rich-text-dom-canary.mjs`. It writes a receipt and
screenshot and closes only its own test Chrome. Installed Companion transport
and provider editors require separate verification.

`visual.drag` accepts two unchanged signed proofs: `visualProof` for the source
and `toVisualProof` for the destination. Inspect both under the same exact-tab
lease. The broker revalidates both geometries and derives `point`/`to`; a raw
destination coordinate cannot replace the destination proof. A moved target
blocks the drag before input dispatch and requires fresh inspection.

`clipboard.write` accepts either explicit text (at most 100,000 characters,
including an empty string) or `formats` with `approved:true`. Formats are 1–3
unique MIME representations of one ClipboardItem: text/plain, text/html and
image/png, with at most 2 MiB of decoded bytes in total. The existing task/tab,
origin, signature, optional Chrome permission and profile-global queue apply.
Each representation supplies exactly one `dataBase64` or absolute `filePath`.
Before signing, the MCP materializer reads only the specified regular,
non-symlink file, bounds total bytes and checks descriptor/path metadata before
and after reading. The native command receives MIME bytes without local paths.
Large MIME commands use the digest-verified native command fragments; each
host-to-Chrome message stays below 1 MiB. An incomplete or corrupt transfer
never dispatches the write. The offscreen page verifies the task/origin binding
and MIME support before calling the clipboard API.

The response contains MIME/byte metadata and `writeAcknowledged:true`, with
`pasteVerified:false`; it returns no clipboard payload. An acknowledgement
failure or mismatch leaves an uncertain effect, with `retryWrite:false`.
Clipboard write does not paste into the destination. PNG may be re-encoded and
HTML normalized by Chrome, so verify the actual pasted content/structure or
decoded image pixels. `scripts/clipboard-dom-canary.mjs` exercises the production
framing, write route and offscreen function with actual clipboard/paste in a
fresh headless Chrome, whose clipboard is independent of the OS clipboard.
Installed offscreen permissions/focus and provider paste behavior require
separate confirmation.

`companion_authorized_transaction` defaults to `responseDetail:"summary"` for
its text block. The summary retains every action's data result, artifact,
partial/uncertain action index, effect classification, blocker, target,
retention/cleanup state and next read arguments. It omits duplicate step
binding diagnostics, per-action timing/read hashes and an empty stale-generation
sweep from the text. Nonempty stale cleanup results remain visible.

`structuredContent.result` remains the full existing result, and native images
remain byte-for-byte unchanged. Existing structured consumers do not lose
fields. Text-only consumers needing all legacy fields can set
`responseDetail:"full"`; it serializes the complete result into the text block.
Fresh inspection proofs and ordinary page reads are never summarized.
`scripts/measure-result-size.mjs INPUT_RECEIPT OUTPUT_JSON` compares both
presentations of identical recorded results and images in UTF-8 bytes. Byte
savings do not establish a token-cost or live-latency improvement.

Transaction `operation_timing` records up to 256 dispatched attempts inside
that transaction. It contains method, attempt number, queue scope, outcome and
numeric durations, without action arguments, URLs, task IDs or page content.
Concurrent transactions have separate traces. The default text summary omits
this diagnostic trace; the full structured result and `responseDetail:"full"`
retain it. `truncated:true` means more attempts occurred than the trace retains.
No extra browser commands or persistence writes are made to collect it.

Broker durations distinguish validation, durable prepare, queue wait,
durable dispatch, transport plus extension work, and completion persistence
plus ownership bookkeeping. Persistence durations include waiting for the
ledger's mutex. `extension_timings_ms` uses the extension's monotonic clock;
its total lies inside the broker transport interval and must not be added to
that interval. Tab creation additionally measures Chrome tab creation,
navigation completion, origin checking, task grouping and final tab readback.
An older extension can omit these fields. Failed commands keep completed
phase timings, without implying that an unmeasured phase completed.

`status.ledgerPersistence.byMode` separates cumulative write count, elapsed
time, maximum duration, serialized bytes and serialization time for journal
appends versus full checkpoints. This is process-lifetime telemetry, not a
durable audit trail. `scripts/measure-ledger-persistence.mjs OUTPUT_JSON` uses
synthetic histories of 0 and 10,834 records in alternating order, verifies
all acknowledged records after reopening, and removes its own temporary files.
Its RSS samples share a process and cannot establish isolated memory cost.
Neither synthetic timings nor an uncontrolled soak establishes the cause of
a delay in a different browser run. The soak recorder retains transaction
operation timings when the installed runtime supplies them.

`companion_transaction_status` optionally accepts
`audit:{limit:20,method:"page.type",state:"applied",tabId:44}`. All audit fields
are optional; `limit` is 1–100. The audit reads only the exact signed task/run
from the existing operation ledger. Filters are included in the signed
request. The default status request retains its previous signature shape.
Codex status sessions must belong to the requested task. Existing AOS
delegated status reads still use their separately signed task/run authority;
they do not grant a target lease or permission to resume from another owner.

The `audit` result returns newest preparations first, with recorded operation
identity, state/effect classification, dispatch count, timestamps, target
metadata and result digest. It excludes result bodies, screenshots, inputs,
authority envelopes and filesystem contents. It makes no browser call and
does not create a second audit store. A missing target component stays null;
for example, a tab ID may not yet have existed when `tabs.create` was prepared.
The independent task and run binding of every selected operation and capsule
must match. When both are specified, their transaction/step keys must also
match. A tab recorded for another run is never reported as the retained target.

Continue with the returned `nextCursor` and the same filters. Cursors are
signed and bound to the task/run/filter; they survive MCP process replacement
and cannot be reused for another scope. Page size may change. Preparations
newer than the first page's cutoff are excluded. States are the latest ledger
metadata at each read, so this is not immutable state-transition history;
state changes or a re-preparation can change later-page membership. Start a
new first page for a fresh view. Metadata has a 256 KiB page budget in addition
to the item limit. An opaque identifier over 4096 characters is omitted with
an explicit reason and digest, never returned as a misleading truncated ID.

An audit-only read with no matching capsule can return `result:"audit_readback"`
and an empty or operation-only history. In that case `effect_state` is null
and `continuation_allowed` is false. Audit metadata cannot confirm a provider
effect, reconcile an unknown operation or authorize a replay. Authority and
ledger validation errors keep their exact typed code through the broker
response instead of collapsing into `internal_error`.
