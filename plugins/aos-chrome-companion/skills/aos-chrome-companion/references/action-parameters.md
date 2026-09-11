# Action arguments

Use one signed transaction with at least one action. The tool schema exposes required fields for common methods. All actions retain the task/session/tab and allowed origins; never copy stale proof to a new lease or page.

| Method | Parameters |
|---|---|
| page.query | query and/or locator; optional attributes, offset, limit, includeHidden, frameId; use for the first read-only transaction |
| page.type | locator with role+label/name, text; clear defaults true; physicalFallback=on_verified_no_effect for exact clear-and-replace |
| page.click / doubleClick / hover | exact locator; ordinary controls prefer fresh visual proof and the corresponding visual action; submit uses one semantic click |
| page.setChecked | locator, checked boolean |
| page.pressKey | locator, key |
| page.selectText | contenteditable locator, exact rendered text including line/paragraph breaks; optional adjacent prefix/suffix and occurrence among their matching ranges |
| page.selectOption | role+label/question locator, option {label/value/index}, unchanged visualProof from inspect_dropdown |
| visual.click / doubleClick | unchanged visualProof from inspect_visual_target/point; optional button and explicit secondary-button opt-in |
| visual.pressKey / keyDown / keyUp | visualProof, key; supported key/modifier set only |
| visual.typeText | visualProof, text |
| visual.pointerMove | visualProof; virtualOnly=true for a preview without foreground activation |
| visual.scroll | visualProof; optional bounded deltaX/deltaY |
| visual.drag | visualProof for the source and toVisualProof for the destination, from separate current inspections in the same tab and lease; optional steps; both coordinates are derived from these proofs |
| page.upload / uploadMultiple | locator, absolute filePath / filePaths; supported type, regular non-symlink files; 25 MiB per file and per upload, up to 10 files; optional confirmationLocator and confirmationTimeoutMs (100–15000) identify a newly visible attachment-ready state; large payloads are transported in verified fragments |
| page.richText | editor locator; operation bold/italic/underline/heading/formatBlock/unorderedList/orderedList/indent/outdent/horizontalRule; optional exact text, occurrence and blockTag (p/h1-h6/blockquote/pre); block formatting requires one complete block |
| clipboard.write | explicit text (including empty) OR formats [{mimeType,dataBase64/filePath}] with approved:true; each representation needs exactly one base64 payload or absolute regular non-symlink file; unique text/plain, text/html, image/png, at most 2 MiB total; write acknowledgement does not prove paste |
| page.handleDialog | a single action with exact owned transaction tabId; expectedMessage (empty allowed), accept boolean; optional expectedDialogId / expectedType; accepting an ordinary prompt requires explicit promptText (empty allowed, up to 10,000 characters) |
| page.download | exactly one HTTP(S) url or main-frame link/media locator; optional relative filename; artifacts include the verified absolute path, local bytes and SHA-256 |
| tabs.navigate | url within allowedOrigins; finish at navigation, then read again before further mutations |
| tabs.back / forward / reload | no locator; fresh readback after navigation |

Locators support CSS plus role/name/label, `exact`, `nameRegex`/`textRegex`
(`{pattern, flags}` with i/m/u flags), `allOf`/`anyOf`, `within`/`ancestor`,
`has`/`hasNot`, `hasText`/`hasNotText`, and an outer `nth` (zero-based) or `last:true`.
`exact:true` compares normalized, case-sensitive text. `exact:false` keeps all
case-insensitive substring matches. Omitting it preserves the legacy preference
for a case-insensitive exact name. CSS queries include open Shadow DOM roots;
use `within` to constrain a target to its shadow host. A single-target action
reports ambiguity instead of choosing the first match. Keep index selection at
the outer locator after filtering.

For a list of document links, use `locator:{css:"a.doc"}` and
`attributes:["href","title"]`. `count` is the returned page size;
`totalCount` is the observed matching count, with `totalCountExact:false` if the
5,000-candidate scan limit was reached. Follow `nextOffset` for subsequent pages.
Missing attributes return null; sensitive attributes and form value attributes
are redacted. Attribute values are bounded to 2,000 characters each and 32,000
characters per result, with explicit truncation metadata. Hidden elements are
excluded unless `includeHidden:true` is requested for a read.

For visual exports, `companion_screenshot` accepts `fullPage:true` or
`clip:{x,y,width,height}` in document CSS pixels. These options use the existing
debugger opt-in and return a JPEG without changing the viewport. Set maxBytes
up to 2,000,000 if the default 700,000 bytes is too small. `companion_element_screenshot`
defaults to an exact main-frame crop; `mode:viewport` returns the legacy viewport
image plus bounds. A changed document, moving element, or growing page requires
a fresh read. Native accessibility roles/names/states are available through
`companion_read_accessibility`; it omits form values and editable descendants.
The default is the main frame. Use `framePath:[0,1]` for the second child of the
first child frame within the operation's allowed origins. Returned one-based
indices belong to that `snapshotId` and are not action targets. For a compact
diff, pass `sinceSnapshotId` with the same read options. A baseline expires after
five minutes and is bound to the same task, session, generation and document;
an unavailable baseline requires a new full read. Truncation limits change
coverage. This does not replace the normal semantic-plus-image read.

If a dropdown preflight returns supported=null, query the same page, inspect candidate role/name/label, and refine once per new evidence. Only a resolved unsupported control is a handoff candidate. Proof expiry and ambiguity do not authorize an alternate submit or effect replay.

When a custom dropdown declares `aria-controls` or `aria-owns`, selection waits
for the requested option in that associated menu. An empty or not-yet-created
menu does not permit selecting a same-named option from another menu. The
existing bounded timeout applies; ambiguous labels require an observed exact value
or a more precise option specification.

For searchable controls, enter the query with `page.type`, read the resulting
menu and obtain the current dropdown proof before selection. An expanded menu
stays open. Matching query text alone is not a selection receipt: the option
must expose a selected state or a change from immediately before its click.

The transaction's verified result confirms the browser operation/readback. It does not establish provider/business completion. external_action_executed=null and external_effect_confirmation=not_verified preserve that distinction.

For a signed transaction expected to open a dialog, add
`expectEvent:{type:"dialog",timeoutMs:5000}` to the trigger's params. Supported
triggers are page click/doubleClick/pressKey/submit, visual click/doubleClick/pressKey,
and tabs navigate/back/forward/reload. The timeout accepts 100–15,000 ms and
defaults to 5,000 ms; other event types are not supported here.
An `action_event_pending` result retains the page and leaves the original trigger
uncertain. Use one separately signed `page.handleDialog` action with the original
session, run and tab, a new idempotency key, and the exact returned dialog ID and
message. Never repeat the trigger. Only after `trigger_continuation.state` is
`readback_verified` may `prepare_resume` expose the unattempted remainder. This
browser readback does not verify a provider receipt. Session replacement and
chained-dialog trigger reconciliation remain unverified. An `action_event_timeout`
after a completed trigger also excludes that trigger from remaining actions.

For a separate observation, call `companion_inspect_dialog` before triggering a
dialog. It holds a task-owned
observation for five minutes and returns an observed opening identity even after
that modal is already open. Chromium does not replay openings that predate the
observation; a timeout or missing opening never permits retriggering the action.
For an observed dialog, release the read lease and use one signed
`page.handleDialog` action on that exact tab. The broker binds the opening instead
of executing blocked DOM reads, and the response must have a matching close event.
OTP, identity and sensitive confirmation dialogs still require user handling.
Prompt values and default text are not returned in the response. A new dialog
opened by the page is retained for a separate signed action. Once no dialog is
pending, `companion_inspect_dialog` with `action:"stop"` releases the observation;
session close, tab close and generation changes also end it.

For a saved file, use the returned `artifacts` entry with `verified:true`.
The browser's download state and basename alone do not prove a usable file.
Companion reads the exact completed local file and verifies its size and hash;
compressed transfer sizes are not used as local file lengths. A missing or
changed file leaves the download applied and returns a file-readback blocker,
with no remaining download action to replay. Blob/data URLs and child-frame
media locator binding are currently explicit unsupported cases. Download
retries performed internally by Chrome are distinct from Companion dispatches.

For HTML with a plain-text fallback, send both MIME representations in one
`clipboard.write`, for example `formats:[{mimeType:"text/html",dataBase64:"PGI+SGk8L2I+"},{mimeType:"text/plain",dataBase64:"SGk="}],approved:true`.
For a local PNG, prefer `formats:[{mimeType:"image/png",filePath:"/absolute/image.png"}],approved:true`.
Local files are bounded and checked for changes before signing; file paths stay
on the host. Large MIME commands use the existing
verified native fragments; every native message stays below Chrome's 1 MiB limit.
Chrome may normalize HTML or re-encode PNG. Verify the actual paste in the exact
destination editor; matching input bytes are not a universal paste criterion.
A failed or lost write acknowledgement remains uncertain and is never replayed.

Transaction text is concise by default. Complete details remain in
`structuredContent.result`; use `responseDetail:"full"` for a client that reads
only text and needs the complete legacy JSON. Summaries retain action results,
partial/unknown progress, blockers, artifacts and cleanup. Inspection proofs
and read-page content are not shortened.

### Profile library and task tab organization

`companion_search_browser_library` reads bounded history/bookmark metadata only after the user enables the matching optional permission in the panel. It excludes blocked sites and protected URLs. `companion_list_windows` supplies existing destination window IDs. Use `tabs.configure` in a signed transaction for pinned/muted states or `destinationWindowId`/`index` (-1 means the end); this operates only on the task-owned exact tab and never reloads its page. `page.bookmark` creates or returns the current task page's bookmark after the optional bookmark permission, and verifies the stored item. It does not change an existing bookmark's title or folder.

`responseDetail: summary` is the default for transaction text and retains complete structured evidence. Use `full` for full JSON text or `compact` when the consumer explicitly accepts removal of repeated target bindings. Upload site confirmation and the outcome's applied/remaining/uncertain actions remain visible.

## Events before an action

Call `companion_observe_page` with `action: "start"` and
`events: ["navigation", "popup", "fileChooser", "dialog", "download"]` before
the triggering action. Set `console: false, network: false` when only page
events are needed. Keep the returned `observationId` and `cursor`; release the
read lease, perform the normal authorized action once, reserve the same tab,
then read new events with that cursor. The observer does not hold an operation
queue while waiting. Stop it when the workflow no longer needs events.

Same-origin navigation keeps observation; a different top-level origin records
the transition and ends capture before reading the new document. Popup
requests are paired only with an exact opener and a single matching URL; the
returned association does not authorize operating the new tab. File chooser
events contain control metadata and require the user's file selection; the
observer neither intercepts the dialog nor reads file paths. Dialog results
omit prompt values. Download events use the legacy Page events as best-effort
notification: verify the actual completed file through the download result.
A missing event never authorizes repeating the original action.

For a canvas point, `companion_inspect_visual_point` also binds a lossless
64 CSS-pixel neighborhood to the signed proof. If that neighborhood changes,
`visual_canvas_content_changed` returns before input: inspect the new image
and obtain a new point proof. Scroll, viewport, display density, and page scale
changes also invalidate the previous proof. The patch checks the neighborhood,
not every pixel of the canvas, and does not prove application-level object
identity or prevent a redraw after the final read. Visual drag keeps the left
button held during movement; inspect both endpoints before using it.

For operation history, use the existing `companion_transaction_status` with
`sessionId`, `runId` and optional `audit:{limit:20,method:"page.type",state:"applied"}`.
An optional `tabId` filter selects recorded operation targets. Follow
`audit.nextCursor` with the same filters for more entries; a new MCP session
for the same task can continue the cursor. The audit is scoped to the signed
task/run, makes no browser call and returns metadata/digests without result
bodies or authority values. Entries with no recorded target keep null target
fields. This is current ledger metadata, not immutable event history or proof
that an uncertain provider effect succeeded. Omit `audit` for ordinary status.

### Temporary viewport and density

Use `page.configureViewport` only inside the signed transaction for this task's leased tab:

- Set: `{ "action": "set", "width": 900, "height": 700, "deviceScaleFactor": 1.5 }`.
- Restore: `{ "action": "restore" }`. Finish with this action when the altered viewport is no longer needed.

Set requires the existing debugger/input opt-in. Restoring this task's own
override remains available after input opt-out or pause.

The operation changes that tab's CDP layout metrics, without resizing the browser window, modifying another tab, or changing the per-site Chrome zoom preference. Width is 200–3840, height 200–2160 CSS pixels, density 0.5–3, and the rendered area is limited to 16 megapixels. Optional `durationMs` defaults to 5 minutes and is bounded to 1 second–30 minutes. The override is tied to task/session/generation; session end, native disconnect, generation change and expiry restore it. A failed explicit restore remains owned for a restore-only retry. Tab removal discards the tab-specific override.

Set and restore invalidate old visual geometry. Obtain new screenshots and point proofs before later visual input. A restore response includes fresh metrics and whether they match the initial viewport; a user's intervening window resize may legitimately make them differ. This is desktop layout emulation, not a promise of mobile user-agent, touch or OS display emulation.

### Reuse of semantic target inspection

For click and submit, the current extension may return an opaque, one-use isolated-world element token. The broker carries only the token from the current step's inspection and skips the redundant second inspector call. The renderer compares the exact DOM object, document, accessible state, viewport and geometry before the first input. Changed or expired tokens fail before input; an on-focus replacement stops the click and reports the local effect as uncertain. Other actions and older extensions keep the existing second inspection. This reduces one broker/extension read round trip for the covered methods; it does not prove a speed advantage over the official extension.

Custom dropdown waits also wake on observed DOM changes, so hidden-tab timer throttling does not hide an option response that arrived within the requested deadline. Observers are released on each wake or poll timeout. The page's own delayed work may still exceed that deadline; a timeout does not establish that an option was selected.
