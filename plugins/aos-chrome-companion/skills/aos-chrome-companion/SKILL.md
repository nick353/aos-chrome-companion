---
name: aos-chrome-companion
description: Automatically use the independently owned AOS Chrome Companion Extension as the primary surface for normal Chrome page work, require proactive visual confirmation, and hand off once to the official Extension only after a terminal no-effect Companion failure.
---

# AOS Chrome Companion

Use the `companion_*` MCP tools as the primary browser execution surface for
normal Chrome page work. Make this choice automatically; do not ask the user to
pick between the two installed Extensions when the request is unambiguous.

The legacy mutation entrypoints `companion_create_tab`, `companion_click`,
`companion_type`, `companion_navigate`, and `companion_activate` are no longer advertised and old calls reject before dispatch. Never select
them for a new action. All tab creation/reuse and page mutations must go
through `companion_authorized_transaction`, which supplies the signed
run/task/target/idempotency envelope. A rejection from a legacy entrypoint is
therefore a caller-routing defect, not a reason to retry the same tool.

Route to the official ChatGPT/Codex Extension only when the user or workflow
explicitly requires its side panel, private OpenAI integration, or proof from
that official surface. A workflow compatibility route may select the official
Extension before a run starts when its Companion effect adapter is not yet
implemented. After a Companion read-only attempt has terminated, an automatic
one-way handoff to the official Extension is allowed exactly once only when the
signed receipt proves zero mutation dispatches, no external effect, no
reconciliation requirement, and complete session/lease cleanup. The official
Extension must open or use its own target-scoped handle and perform fresh
semantic plus visual preflight; it must never take over a Companion lease.

1. Call `companion_status` and require exactly one connected profile unless the
   workflow supplies an explicit `profileInstanceId`.
   If the current unpacked Companion build must be reloaded, use the signed
   `companion_reload_extension` tool only at a safe boundary. It rejects active
   leases, pending operations, timed-out mutation tombstones, and unresolved
   reconciliation tabs. Treat the acceptance receipt as a lifecycle boundary:
   immediately call `companion_status`, then open a new logical session. Do not
   open `chrome://extensions`, move the user's OS cursor, or assume the old
   session remains valid. `expectedBuildId` may be supplied to fail closed on a
   stale loaded build. This reload refreshes the currently loaded unpacked
   build; it is not a Web Store update.
2. Open one logical session per Codex task with `companion_open_session`. The
   MCP adapter binds it to the host-provided Codex request metadata (including
   `x-codex-turn-metadata`); local direct runs may use
   `CODEX_THREAD_ID`/`CODEX_SESSION_ID`. Never substitute a parent task ID or
   label.
3. Use the task tab returned by `companion_authorized_transaction`. Reuse it
   only while the same task genuinely needs continuity. Reserve exact tabs for
   lower-level read-only work.
4. Keep the same `sessionId`, `tabId`, and generation while the task continues.
   A transaction releases its operation lease: when
   `cleanup.lease_released=true`, reserve the same task-owned tab again before
   the next lower-level read/inspection. Do not reuse that released `leaseId`
   or share a mutable lease with another task.
5. Distinct leased tabs may operate in parallel. Same-target operations and
   foreground operations are serialized by the broker. A foreign task's
   session, lease, retained tab, or pending operation shown by
   `companion_status` is informational and is not a global stop condition.
   Never adopt, close, release, or mutate that foreign resource; open or reuse
   this task's own logical session and task-owned tab and continue. Stop only
   when the broker returns an exact same-target or profile-global resource
   conflict for this operation. Do not invent blockers such as
   `foreign_owner_current_generation_target_with_pending_operation` merely
   because another task is active in the same profile.
6. Read the exact target immediately before a mutation and read it again after
   the operation when completion matters. `companion_read_page` always captures
   a screenshot from the same session/lease/tab, even when the semantic
   snapshot looks complete. Inspect both. A hidden security-widget string is
   not a semantic/visual conflict by itself: when `CAPTCHA`, `hCaptcha`,
   `Please try again`, or `Verify Answers` exists only in semantic text and the
   screenshot plus rendered DOM show no visible actionable checkbox, dialog,
   image grid, challenge iframe, or paired CAPTCHA input, classify it as a
   passive/hidden widget and continue normal work. A real conflict means the
   rendered actionable-control evidence and screenshot disagree; only then
   keep completion `PENDING_CONFIRMATION` and avoid replay or submit. Use
   `companion_screenshot` directly for another proactive visual checkpoint
   after meaningful UI work.
   Use the shared interaction order for forms and ordinary page controls:
   semantic state plus fresh screenshot -> for ordinary operation controls,
   `companion_inspect_visual_target` or `companion_inspect_visual_point` -> one
   visualProof-bound `visual.*` action -> semantic plus screenshot result
   readback -> task-owned cleanup. This visual-first path applies to buttons,
   tabs, menu items, toggles, hover targets, and scroll targets so the model
   acts like a person looking at the page. Keep the existing semantic/native
   path for text input and supported dropdown selection, where it is more
   reliable. For clear-and-replace text fields, set
   `page.type.params.physicalFallback=on_verified_no_effect`. The Extension
   first uses the native value setter plus `input`/`change`, waits for the exact
   value to commit, and uses trusted physical text input once only when the
   field returned exactly to its original value, the screenshot and semantic
   target still identify the same page/control/rectangle, and physical input
   was explicitly enabled. A partial/different value, moved target, navigation,
   visual conflict, permission failure, or unknown effect must stop without the
   physical attempt. Do not apply automatic physical fallback to click,
   submit, navigation, upload, or dropdown selection merely because the result
   looks unchanged; those operations can have invisible external effects.
   For a visible form submission control, use one exact semantic `page.click`
   as the first and only dispatch; do not call `page.submit` first and then
   retry with `page.click`, or vice versa. If either method dispatched but the
   bounded semantic and visual readback is unchanged, classify the effect as
   unknown, retain only the exact reconciliation tab, and perform signed
   status/provider readback. Never switch submit methods inside the same
   attempt.
7. If a mutation returns `operation_effect_unknown`, do not replay it. Reconcile
   the exact tab and workflow-owned provider receipt first. When the retained
   exact tab later shows visible provider-success evidence, reserve that tab,
   call `companion_inspect_reconciliation` with the specific success text,
   inspect its same-page screenshot, then pass the returned
   `reconciliationProof` unchanged to
   `companion_complete_reconciliation`. On `terminal_cleanup_ready=true`, call
   `companion_close_session(taskTerminal=true)` so the former
   `ai_reconciliation_pending` tab closes. Never mark reconciliation complete
   from a caller-supplied status string, a different tab, or a screenshot
   without the signed exact-page proof.
8. Close the logical session when the task is done. This releases all owned
   leases and, with the default `taskTerminal=true`, closes every completed or
   failed Companion task-owned tab plus safe pre-effect `discovered` retained
   tabs even if an intermediate step used
   `keepTaskTab=true`. Terminal success closes its own task tab immediately. Set
   `keepTaskTab=true` only for a concrete user action, signed reconciliation,
   or planned resume boundary; never use it merely because a page was opened,
   read, or might be useful later. A candidate-local terminal result such as
   submitted, no intake, rejected/unsupported, skipped, expired, or definitive
   no-effect failure must use the default cleanup and must not remain open.
   An `awaiting_user` tab must include
   `retention.reason`, `retention.whyTabWasKept`,
   `retention.requiredUserAction`, and `retention.resumeAction`; the broker
   rejects an unexplained retained tab. Reconciliation tabs are temporary AI
   work, not user handoff tabs, and close after reconciliation is terminal.
   Therefore, when all tasks finish, only tabs with a real user-help retention
   explanation may remain.
   A blocked transaction can contain successful earlier actions. Read
   `effect_state`, `applied_actions`, and `failed_step` separately. If earlier
   actions applied, inspect the retained exact tab and continue only with the
   remaining work; never infer that the whole sequence was unchanged from a
   later step's `no_dispatch`. `browser_mutation_executed` is browser evidence;
   `external_action_executed` does not become true without a provider receipt.
   When `outcome.schema=aos.chrome_companion.transaction_outcome.v1` is present,
   use its applied, remaining, and uncertain action indices plus
   `reconciliation_required` for continuation. `provider_completion` and
   `source_sync` remain unverified until the owning workflow obtains those
   receipts. A successful browser response must not overwrite either field.
9. For mutations use `companion_authorized_transaction`, which reuses or
   creates one grouped task-owned tab and signs the full
   run/task/intent/origin/idempotency/lifecycle payload. Use `page.upload` only
   with an absolute regular non-symlink file in the allowed type and size set.
   Other tabs are read-only in this path. Never forge task ownership with a
   label or replay an idempotency key after `unknown_effect`.
   For dropdowns, never coordinate-click a repeated arrow or a generic
   `Yes`/`No` option. Before the first form mutation, call the read-only
   `companion_inspect_dropdown` preflight on each distinct dropdown pattern.
   Inspect the screenshot returned in the same response. When it returns
   `supported=true`, pass the returned signed `visualProof` unchanged into one
   atomic `page.selectOption` action. The broker rejects a missing, stale, or
   different-session/tab/generation/page/locator proof before dispatch. If `supported=null` or the blocker is `semantic_locator_ambiguous`, keep the
   Companion session, inspect the returned candidates, refine the locator with
   the observed role/name/label, and repeat this read-only preflight. This is
   not an unsupported control or a surface-handoff reason. Scope the
   control with `locator.role` plus `locator.question` or `locator.label` (and only when necessary
   an explicit zero-based `locator.ordinal`), then request exactly one
   `option.label`, `option.value`, or `option.index`. It supports native
   `<select>`, ARIA `combobox` plus controlled `listbox`, and visible custom
   listboxes, and succeeds only when selected-state/value/context readback
   proves the choice committed. Do not replace `dropdown_option_ambiguous`,
   `dropdown_option_not_found`, or `dropdown_selection_not_committed` with
   guessed coordinates.
   When snapshot controls come from an iframe, preserve the returned `frameId`
   in the semantic locator for query/click/type/select/wait operations. The
   Extension executes only in that exact frame and rejects a frame origin
   outside the transaction allowlist. Trusted physical coordinates are not
   inferred from iframe-local geometry; if frame-scoped semantic input proves
   no effect, stop with the exact blocker instead of guessing a whole-tab
   point.
   For contenteditable editors, `page.type(clear=true)` replaces the entire
   editor and must be explicitly intended. To insert at the selected range,
   use `clear=false`; to format existing text, use the selection and toolbar
   path below. Omitting `clear` must never authorize whole-editor replacement.
   For contenteditable rich-text editors, use `page.selectText` with one exact
   editor locator and the exact visible text range before clicking a semantic
   formatting toolbar control. Omit `occurrence` when the text is unique; when
   it repeats, pass the visually confirmed zero-based occurrence. Continue
   only after `selectionCommitted=true`, and rely on the transaction's final
   semantic plus screenshot readback to verify the formatting. If the exact
   text range is absent or ambiguous, stop without a toolbar click; do not
   replace an available semantic range with a guessed physical drag. This
   currently proves exact text selection plus a semantic toolbar click only;
   it does not prove complete heading/list/table rich-structure support. If
   the semantic locator or required structure control is absent, keep the
   exact pre-mutation blocker and do not inject page-specific DOM or use a
   whole-document text replacement as a workaround.
10. Companion page mutations display their own blue cursor and
    `AOS Companion` action label. This is visual ownership evidence, not proof
    that the official Extension is idle.
    For ordinary operation controls, prefer
    `companion_inspect_visual_target` (or `companion_inspect_visual_point` when
    no stable semantic locator exists) with a fresh screenshot and pass its
    single-use `visualProof` to one `visual.*` action. The blue cursor is an
    in-page display-only overlay (`pointer-events:none`); it never moves the
    user's OS cursor. Secondary buttons and shortcut modifiers require
    explicit per-action opt-in, and the target/page/viewport is revalidated
    immediately before dispatch.
    For a cursor preview that must not activate or focus Chrome at all, pass
    `virtualOnly=true` to `visual.pointerMove`; this renders the same blue
    marker without debugger input or foreground activation.
    `companion_screenshot` is read-only visual evidence and may briefly
    activate the exact target tab while restoring the previous active tab.
11. After upgrading from an older Companion build, call
    `companion_group_task_tabs` once per task to group only that task's retained
    tabs. Never use another task ID to migrate foreign tabs.
12. Do not defer tab cleanup until the end of a multi-target workflow. Before
    opening the next candidate, if the previous candidate reached a terminal
    state, call `companion_cleanup_task_tabs` with `dryRun=true`, explicitly
    preserve only the exact active, resume, and reconciliation tabs, inspect
    the candidates, then make exactly one non-dry-run call. If that response is
    empty, errors, or has unknown effect, do not send a second cleanup key;
    reconcile with a fresh tab list/status readback instead. Skip cleanup when
    every tracked tab is still active or intentionally retained. At task
    completion, an audit may do one final dry-run before closing the logical
    session; ordinary operation relies on terminal session close for automatic
    cleanup. Cleanup may close only Companion-tracked terminal or
    stale-generation tabs and must preserve pinned, active, leased,
    live-session, reconciliation, resume, and untracked
    manual/official-Extension tabs.
    Cleanup inventory and receipts are task-scoped: foreign task tabs must not
    appear in `candidates`, `preserved`, `missing`, `busy`, `skipped`, or
    `unknown_effect`. If a cleanup receipt names another task's tab, treat it
    as a product defect, stop that cleanup call, and continue only with the
    current task's exact session-close boundary; do not convert the foreign
    cleanup defect into a permanent blocker for unrelated target-scoped work.

The MCP adapter also binds every session and lease to the task that opened it.
Unknown bindings and cross-task reuse or cleanup are rejected, so retain the
same task context for the full session lifecycle.

For Automation OS work, preserve AOS as the authority for run, task, company,
approval, idempotency, provider receipt, reconciliation, and business
completion. A Companion status, session, lease, or page snapshot is browser
evidence only. Report this surface as
`aos_chrome_companion_profile_instance`; never label it as the official
Extension's `signed_chrome_extension_profile2` proof.

The official Extension and Companion do not exchange private runtime messages.
One-writer safety comes from never mutating a tab that was not provisioned and
leased by that surface. The only automatic cross-surface route is
`aos.safe_extension_surface_handoff.v1`: Companion to official Extension,
one time, after terminal no-effect proof and cleanup. Never hand back in the
same attempt and never use Browser Use, Playwright, in-app browser, raw CDP, or
operating-system automation as a fallback. Block instead of handing off for
effect-unknown/reconciliation, a true rendered-control/visual conflict,
target/origin ambiguity, foreign ownership, a rendered actionable CAPTCHA,
OTP, identity, payment, permissions, or unknown required answers. Passive
CAPTCHA branding, hidden widget text, badges, logos, footer copy, and hidden or
zero-sized frames are not blockers.

For a form whose dropdown pattern is unsupported, decide the surface during
the explicit `companion_inspect_dropdown` plus visual control preflight,
before any form mutation. If the source
receipt is `companion_dropdown_control_unsupported` with mutation dispatch
count `0`, explicit no effect, no reconciliation, and complete Companion
session/tab cleanup, perform the existing one-way handoff once. Tell the user
at the transition with the exact label `Companion → Codex Extension`, then
include `transition_visible=true`, `transition_reason`, destination visual
proof, and cleanup proof in `aos.safe_extension_surface_handoff.v1`. If any
Companion form mutation has already dispatched, do not switch that attempt;
finish or reconcile on Companion, or preserve the exact safe restart point.

For action arguments, read `references/action-parameters.md` only for the method you need. `actions` requires at least one action; use a `page.query` for an initial read-only transaction. Transaction images are returned as native MCP image blocks. `external_action_executed=null` means the browser interaction was observed but external completion was not verified. Use `companion_status(detail="all")` only when a full cross-task diagnostic inventory is needed.

Use `companion_read_urls` for a read-only batch of up to ten supplied URLs;
inspect each row and cleanup result. Use `companion_operation_history` for
task-scoped history instead of requesting the full cross-task status. The
side panel provides pause/resume, site refusal, current operation labels,
and selected text copied for a conversation. History/bookmark permissions
remain optional and are granted or revoked through that panel.

For Google Workspace file exports or timed YouTube transcripts, follow
[provider exports](references/provider-exports.md). These use existing
provider tools; they do not change the selected browser surface for page work.
