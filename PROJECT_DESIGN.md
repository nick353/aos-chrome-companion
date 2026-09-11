# AOS Chrome Companion Project Design

Updated: 2026-08-24

## Two-extension runtime contract

The user-facing product consists of exactly the official ChatGPT/Codex Chrome
Extension and AOS Chrome Companion. The Companion's native relay, resident
broker, MCP adapter, reconnect logic, and `task_execution_capsule_v1` are
bundled support components; the user is not asked to install a third runtime or
manually configure AOS, a profile, a session, or a tab. The Companion selects
the profile in which it is installed and multiplexes parallel logical sessions
over one transport owner.

The capsule is the generic workflow boundary for Jobs, AOS, Heavy, MyPro, and
future workflows. It durably records target identity, profile generation,
resource leases, lifecycle state, resume/blocker data, visual proof, and
completion contracts. Same target keys serialize; distinct keys may run in
parallel. Completed capsule tabs clean up by default, while awaiting-user and
reconciliation-required states retain their resume token. Explicit
`keepTaskTab` remains a compatibility override.

This boundary stabilizes browser execution and recovery but cannot bypass
CAPTCHA, OTP, identity verification, payment approvals, website policy, or the
official Extension's private runtime. Opaque same-tab mutations from the
official Extension and Companion are never assumed to be coordinated.

## Desired Future State

AOS Chrome Companion is an independent open-source Chrome automation product
for Codex and Automation OS. A user installs the official ChatGPT/Codex Chrome
Extension and AOS Chrome Companion in the Chrome profile they already use. No
profile number, profile directory, port, broker address, session count, or tab
mapping is configured manually. The Chrome Extensions page contains only the
official Extension and the Companion Extension for this product.

"AOS Chrome Companion" is one installable product rather than a Web Store
Extension alone. It contains a Chrome Web Store MV3 Extension, a signed local
Native Messaging relay and resident broker, a Codex plugin with a bundled MCP
adapter, an Automation OS adapter, diagnostics, and an updater. The installer
provisions these internal components as one product. Chrome and the operating
system may still require explicit first-install permission or trust prompts;
the product does not bypass them or present them as technical configuration.

The controlled profile is defined by where the Companion Extension is running.
The Extension creates a stable random `profile_instance_id` in profile-local
storage and registers that instance with the resident broker. It does not
enumerate Chrome profiles, depend on the name `Profile 2`, ask for the
`management` permission merely to inspect the official Extension, or infer a
profile from an operating-system path. When the Companion is installed in one
profile on a machine, that unique connected instance is the zero-configuration
default. Installing the Companion in several profiles is an explicit advanced
case and must not be resolved by guessing the most recently focused profile.

The browser-execution target is Companion-only: every public Chrome page task
should eventually be executable through Companion without requiring the
official Extension as a browser-control fallback. The official Extension may
remain installed for its side panel, ChatGPT/Codex composer integration, and
other private OpenAI features, but those private product surfaces are not part
of Companion browser-execution parity. The Companion does not patch, proxy,
copy, or depend on the official Extension's private protocol or Native
Messaging Host. Until the public capability and workflow-specific effect
adapters reach parity, the official Extension remains a compatibility route.
One tab has one mutation writer at a time; the Companion never assumes it can
safely coordinate an official-Extension operation that is opaque to it.

A single resident local broker owns Companion transport independently of Codex
tasks. Codex and AOS join it as short-lived logical sessions. Each session can
operate only its exact task tab under an explicit authority envelope. Distinct
tabs may run concurrently, while same-target mutations and foreground, popup,
login, upload, download, clipboard, and other profile-global resources are
serialized for the connected profile instance.

The system makes every browser operation observable as a bounded transaction:

```text
admit logical session
  -> resolve exact profile and target
  -> fresh pre-readback
  -> dispatch once
  -> bounded state-change wait
  -> fresh same-target post-readback
  -> known result, known failure, or unknown effect requiring reconciliation
```

An operation that times out after dispatch is never replayed automatically.
Chrome restart, MV3 service-worker suspension, Extension reload, broker restart,
or Codex task termination invalidates the appropriate runtime generation and
reconnects without creating an extra Chrome window or duplicate task tab.

The Extension includes a small diagnostic surface that tells the user, without
exposing secrets, whether the one-product installation is complete, which
profile instance is connected, its generation, active logical sessions,
exact-tab leases, queued profile-global operations, last failure plane, and
safe recovery state. A green connection is not presented as proof that a
target, action, or business workflow succeeded.

Automation OS remains the authority for company scope, schedules, approvals,
idempotency, durable jobs, external-effect permission, receipts, and business
completion. AOS Chrome Companion is a bounded browser executor and evidence
producer, not a second control plane.

## Success Targets

The following targets express the intended operating quality. They are design
targets and remain assumptions until measured on the implemented system.

1. A normal personal installation requires no profile, port, broker, plugin,
   session, or tab configuration after the unavoidable Chrome and operating-
   system installation confirmations.
2. At least eight logical Codex/AOS sessions can remain connected, and at least
   three workflows can use three distinct exact tabs concurrently without
   sharing a mutable tab handle, selected-tab state, or task owner.
3. Profile-global operations are FIFO-serialized per profile instance with no duplicate
   dispatch after timeout, disconnect, or client cancellation.
4. A 24-hour mixed manual/scheduled soak produces zero ghost windows, zero
   duplicate task tabs for the same reservation, zero foreign-tab mutations,
   and zero stale logical sessions admitted after a generation change.
5. At least 1,000 exact-target read-only transactions complete with at least
   99.5% successful target/readback resolution when the page and Chrome APIs
   themselves are healthy.
6. At least 200 authorized mutation transactions produce zero automatic replay
   of an unknown effect and zero duplicate submit/save/send caused by recovery.
7. MV3 worker suspension, Extension reconnect, broker restart, and client task
   termination each recover or return a stable exact blocker within 30 seconds.
8. Target-scoped readback and authorized target actions work without requiring
   the tab to be selected or the Chrome window to be foreground.
9. One resident broker and one active Extension connection per Chrome profile
   replace per-task browser runtimes; idle helper growth is bounded and does not
   increase with every completed Codex task.
10. Every failure is assigned to one primary plane: extension runtime,
   permission, native transport, broker/session ownership, target/page,
   foreground/profile-global resource, upstream application, or business gate.
11. Secrets, cookies, tokens, page bodies, and submitted personal data are not
    written to general logs. Diagnostic artifacts are bounded, redacted, and
    owner-scoped.
12. The public product can be distributed without developer mode: the Extension
    is Chrome Web Store signed and each supported operating system has a signed,
    updateable Companion installer. Platform-specific release readiness remains
    separately measured rather than inferred from the macOS implementation.

## Strategic Thesis

### Primary bet

Own the complete public boundary from the Companion Extension through its own
Native Messaging relay and local broker, then expose a small versioned protocol
through a bundled Codex plugin/MCP adapter and AOS adapter. The transport owner
must live outside individual tasks; logical sessions and exact-tab leases must
live inside them. The installed profile identifies itself; no external profile
resolver is part of the ordinary path.

This removes the recurring dependency on long-lived Node REPL globals,
browser-client handles, copied owner receipts, hidden capability advertisement,
and a proprietary runtime generation that the project cannot repair. It also
prevents the product from becoming a fragile patch layer over the official
Extension's private implementation.

This project is not an in-place repair, additional wrapper, or renamed next
version of the current **Chrome操作 バージョン1** official-Extension lane. That
lane remains a transitional compatibility path for existing workflows. The
Companion is a new independently owned execution surface with its own Extension
ID, Native Messaging host, broker, protocol, capability model, session model,
and diagnostics. Existing Version 1 lessons and no-replay/ownership invariants
are design evidence and acceptance requirements; its fixed Profile 2 identity,
private official handle, port, receipts, and recovery machinery are not runtime
dependencies of the new product.

### Capabilities unlocked by owning the Extension

Owning both ends of the Companion connection makes several previously missing
or unstable capabilities implementable as explicit public contracts:

- stable profile-local instance identity without `profileOrdering`, display
  names, profile paths, or a machine-specific selector;
- one resident connection with many logical Codex/AOS sessions instead of a
  browser client and mutable global handle per task;
- exact-tab leases, same-target serialization, distinct-target parallelism,
  tab-close cleanup, and task-owned provisioning implemented in the Extension
  and broker rather than inferred from stale receipts;
- ambient Codex task identity binding, reusable task tabs by compatible target,
  Chrome tab-group labeling, and a distinct visible Companion cursor for
  zero-configuration task separation;
- target-scoped DOM readback and authorized action on background tabs without
  requiring `selected`, focus, or an unofficial foreground lease;
- explicit foreground activation, task tab grouping, bounded file-input upload,
  and popup capability contracts using Chrome's public APIs;
- Extension heartbeat, MV3 restart recovery, generation fencing, reconnect
  journals, and bounded backpressure whose behavior we can test and version;
- a mutation journal with pre-readback, one dispatch, post-readback, known or
  unknown effect classification, and no automatic replay of unknown effects;
- stable error codes and a user-visible diagnostic surface that distinguish
  installation, permission, transport, ownership, target, foreground,
  upstream, and business failures;
- optional constrained CDP features such as screenshot or background-tab
  recording without exposing unrestricted CDP as the normal workflow API.

These capabilities can remove the current official-lane failure modes that
come from missing advertisements, task-owned runtime handles, stale owner
lineage, and opaque reconnect behavior. They cannot remove Chrome, operating-
system, website, account, security, or official-Extension boundaries listed in
Fundamental Limitations.

### Supporting bets

- **Same-profile-by-installation.** The ordinary lane is the Chrome profile in
  which the Companion is installed. One installation in one profile is the
  zero-configuration default. Dedicated profiles remain an explicit advanced
  isolation option, not a requirement for scheduled or parallel work.
- **One product, several internal components.** The Web Store Extension, signed
  local relay/broker, Codex plugin/MCP adapter, AOS adapter, diagnostics, and
  updater ship as one Companion product. The user is not asked to wire them
  together or choose a port.
- **One broker, many logical sessions.** The broker is a resident local service.
  It owns the versioned protocol, profile-instance connections, generation
  fences, session TTLs, exact-tab reservations, FIFO queues, and reconciliation
  journal.
- **One writer per tab.** Companion mutations are admitted only for an exact
  task-owned or explicitly attached tab. Same-tab actions are serialized. The
  official Extension remains available, but the product never claims it can
  coordinate an opaque official mutation on the same tab.
- **Companion-first Codex routing.** The bundled plugin combines workflow
  guidance with a controlled MCP tool surface so normal Codex browser work uses
  the Companion executor. Correctness does not depend on an automatically
  trusted hook or on modifying the official Chrome plugin.
- **Restartable MV3 Extension.** Durable connection metadata, pending operation
  envelopes, and recovery markers are stored in Extension storage rather than
  assumed to remain in a service-worker global.
- **Exact target before selected tab.** URL, title, provider tab identity,
  profile instance, and task reservation identify a target. `selected` is only
  an operation-specific foreground observation.
- **Operation-scoped capability checks.** The system probes the documented
  method required for the requested operation. A missing foreground capability
  does not disable target-scoped work.
- **Generation fencing.** Chrome restart, Extension reload, Native Messaging
  reconnect, or broker replacement creates a new profile runtime generation.
  Older sessions and handles cannot cross the fence.
- **Transactional actions.** Every mutation has a fresh semantic target
  resolution, one dispatch, post-readback, effect classification, and an
  explicit reconciliation state. Unknown effects are never retried merely
  because a timeout occurred.
- **Semantic DOM rebinding.** React/SPA transitions resolve controls again from
  the current DOM using role, label, test ID, and visible-state markers instead
  of cached handles or positional indexes.
- **Minimal public control surface.** Browser capabilities are constrained to a
  typed operation set. Arbitrary JavaScript evaluation and unrestricted CDP are
  not the normal business interface.
- **Built-in observability.** The diagnostic UI and broker events expose state
  transitions and resource ownership without asking a task to reconstruct them
  from unrelated JSON files or hidden globals.
- **Resource hygiene.** Completed logical sessions release task leases and
  bounded diagnostics. The broker reclaims only expired, ownerless state and
  never kills or adopts an unknown process or foreign tab.

### Responsibility boundaries

| Component | Owns | Must not own |
| --- | --- | --- |
| Product installer/updater | Install, sign, update, and health-check the Companion Extension, local relay/broker, and Codex/AOS adapters as one compatible release | Bypass Chrome, OS, Codex, or workspace trust and permission prompts |
| MV3 Companion Extension | Chrome API access, profile-local instance identity, tab inventory, exact-tab operations, event stream, persistent reconnect journal, diagnostic UI | Enumerating profiles as the normal selector, inspecting official private state, AOS approvals, schedules, company scope, business completion |
| Native Messaging relay | Extension-to-local transport bootstrap and authenticated broker discovery using the Companion's own host name and allowed origin | Reusing `com.openai.codexextension`, per-task business logic, or browser authority guessing |
| Resident Broker | Versioned protocol, profile generations, logical sessions, leases, FIFO, deadlines, cancellation, operation journal, reconciliation state | Browser account credentials, external-effect approval, provider completion |
| Codex plugin/MCP adapter | Makes the Companion the normal controlled browser tool, converts Codex requests to typed bridge operations, and returns bounded evidence | Direct browser-client setup, automatically trusting hooks, hidden fallback, persistent transport ownership |
| AOS adapter | Binds workflow/run authority to bridge sessions and stores workflow-owned receipts | Treating bridge readiness as job or business success |
| Official Extension | Official side panel, ChatGPT/Codex chat integration, and private OpenAI features | Serving as a dependency for Companion transport or being assumed coordinatable for same-tab mutations |

### De-prioritized alternatives

- Forking or patching the installed OpenAI Extension.
- Trying to repair or intercept the official Extension's private Native
  Messaging connection from a second Extension.
- Reimplementing the official ChatGPT side panel, `@Chrome`, or private thread
  protocol.
- Passing a live browser object, Node REPL global, or owner proof between tasks.
- Hard-coding `Profile 2`, a profile directory, a display name, a port, or a
  fixed machine-specific path into the public product.
- Requiring dedicated scheduled profiles by default. They remain opt-in when a
  user values isolation over same-profile convenience.
- Shipping only a Web Store Extension while asking users to install and wire a
  Native Host, broker, and Codex plugin separately.
- Requesting Chrome's `management` permission only to discover whether the
  official Extension is installed.
- Creating a new browser-client, bridge, window, or task tab for each recovery.
- Treating `tabs.selected()`, capability-list advertisement, a health endpoint,
  or `openTabs()` alone as global readiness.
- Making Playwright, Browser Use CLI, IAB, raw CDP, or OS automation an implicit
  fallback. A different browser surface remains an explicit user/workflow
  selection.

### What must be preserved

- Existing Chrome login state and user-owned tabs.
- Current AOS approval, no-replay, receipt, reconciliation, and cleanup gates.
- CAPTCHA, OTP, identity, payment, permission, and unknown-required-answer human
  boundaries.
- Target-local containment: one blocked tab or workflow must not stop unrelated
  tabs, preparation, or non-browser AOS work.
- Clean-room implementation: no proprietary OpenAI Extension or bundled plugin
  source is copied into this project.
- Browser and operating-system permission prompts, Codex/workspace policy, and
  explicit user safety boundaries remain visible and are never bypassed in the
  name of zero configuration.

## Current Understanding

### User decisions confirmed on 2026-08-24

- Product scope: stabilize the user's Codex/AOS workflows first, then consider a
  general MCP product.
- Installation experience: the Chrome profile containing the official
  Extension is the intended profile; installing the Companion in that same
  profile makes it the target without profile, port, broker, or session setup.
- Visible Chrome installation: the official Extension and the Companion
  Extension are the only two Chrome Extensions required by this product.
- Product packaging: the necessary signed local relay/broker and Codex/AOS
  adapters may exist behind the Companion installation, but must be installed
  and updated as one product rather than exposed as separate technical setup.
- Profile topology: same-profile parallel operation is the default for manual,
  scheduled, and recurring work. Dedicated persistent profiles are optional
  advanced isolation, not the default requirement.
- Coexistence: the official Extension remains installed for official features;
  the Companion is the primary stable browser executor for Codex/AOS work.
- Architectural intent: stop accumulating recovery wrappers around the current
  Chrome操作 バージョン1 lane. Build an owned Extension/runtime so capabilities
  that the official private surface does not expose can be implemented and
  tested directly. Preserve proven safety invariants, not the old runtime
  dependency graph.
- Project ownership: keep the bridge as an independent OSS project; AOS contains
  only a thin adapter.

### Recent-task audit

The design review enumerated 108 unique available tasks and inspected the
latest turn of all 59 tasks updated from 2026-08-17 through 2026-08-24,
including pinned, unpinned, and archived tasks. The main Chrome investigations
were then read more deeply, including ten recent turns of the instability
investigation and eight recent turns of the structure review.

Primary internal evidence:

- `codex://threads/01a00fe4-9c5e-7d00-8b6a-09811c03df36` — repeated owner,
  bridge-generation, tab-handoff, foreground-lease, and multi-session work.
- `codex://threads/01a02f9f-d287-7151-b475-37df27f08979` — initial-path
  reconstruction, empty `tabs.list()`, lease expiry, and bridge-stop mismatch.
- `codex://threads/01a02a91-e400-7620-93a6-17caaff5c562` — successful fresh
  `get() -> openTabs()` alongside stale owner lineage and browser identity.
- `codex://threads/01a030bf-c5f0-7b41-b054-183385581c0d` and earlier Job
  Application Manager runs — selected-tab, preflight, runtime-host, and
  foreground-bridge blockers before application dispatch.
- `codex://threads/01a017a3-fb14-76c1-875c-63dc12e699e7` — viewport-only
  capability, missing foreground activation, and bounded recovery evidence.
- `codex://threads/01a02183-83d7-7f02-b854-93e6719bca6a` — another OSS
  Extension/native-host path whose readiness oscillated and whose native-host
  restart broke interactive X operations.
- `codex://threads/01a01a86-eac3-7773-98c6-d4ef52655cd5` — app-server helper
  accumulation, including many Node/browser helper processes.

The repeated patterns are:

1. Transport can be healthy while copied owner/session lineage is stale.
2. A bridge record can remain while its live browser handle or global binding
   is absent, or a stop request can find nothing to stop.
3. `openTabs()` can work while foreground, DOM, upload, or target ownership is
   unavailable.
4. `selected=null` and foreground lease expiry are often allowed to block work
   that should be target-scoped.
5. Browser and Extension instance identity may change while persistent owner
   metadata retains an older generation.
6. Recreating browser clients and helpers per task increases connection races,
   stale handles, resource use, and operational complexity.
7. Tab grouping is useful visual metadata but is not an ownership boundary;
   new tabs may inherit an unrelated group.
8. A mutation timeout leaves an unknown result. Repeating it is unsafe even if
   the transport is re-established.

### Existing research and public platform facts

The installed OpenAI ChatGPT Extension is not confirmed as forkable OSS. The
local package has no source maps or open-source license, and the bundled Codex
Chrome plugin is marked proprietary. The detailed evidence is recorded in:

`/Users/nichikatanaka/Documents/Codex/automation-os/outputs/chatgpt-chrome-extension-oss-feasibility-20260824.md`

Chrome provides the public primitives needed for an independent implementation:

- Native Messaging:
  https://developer.chrome.com/docs/extensions/develop/concepts/native-messaging
- `chrome.debugger` / Chrome DevTools Protocol access:
  https://developer.chrome.com/docs/extensions/reference/api/debugger
- MV3 service-worker lifecycle:
  https://developer.chrome.com/docs/extensions/develop/migrate/to-service-workers
- Extension distribution constraints:
  https://developer.chrome.com/docs/extensions/how-to/distribute

OpenAI's current Chrome Extension guide says users with multiple Chrome
profiles must use the same active profile in which the Extension is installed,
and that installation includes explicit Chrome permission prompts:

- https://learn.chatgpt.com/docs/chrome-extension

OpenAI's plugin architecture supports packaging workflow skills and a
controlled MCP server together for ChatGPT and Codex. This is the public
integration boundary for Companion-first routing; it is not access to the
official Extension's private protocol:

- https://developers.openai.com/plugins/concepts/plugins
- https://developers.openai.com/plugins/build/plugins

Chrome Native Messaging requires a separately registered host manifest and an
explicit list of allowed Extension origins. Wildcards are not allowed. The
Companion therefore needs its own host name and signed local installation; its
Extension cannot reuse the official host by implication:

- https://developer.chrome.com/docs/extensions/develop/concepts/native-messaging

The clean-room project may study public OSS projects as behavioral and protocol
references, but it must independently select and implement its security model:

- https://github.com/ChromeDevTools/chrome-devtools-mcp
- https://github.com/hangwin/mcp-chrome
- https://github.com/remorses/playwriter

## Important Gaps

1. **Stable local trust boundary.** The exact authentication and endpoint model
   between adapters and the resident broker must prevent unrelated local
   processes from issuing browser commands. A restrictive Unix-domain socket
   and task-scoped capability tokens are the current assumption.
2. **Typed operation protocol.** The durable protocol must cover readback,
   action, navigation, screenshot, foreground, popup, file chooser, download,
   recording, cancellation, reconciliation, and cleanup without exposing a
   default arbitrary-code interface.
3. **Zero-configuration profile registration.** The Companion must generate and
   persist a profile-local instance identity, make the unique connected instance
   the default, and fail safely rather than guess when several Companion profile
   instances are connected.
4. **Target identity and reservation.** The system needs a stable exact-target
   identity that survives provider tab-ID rotation without equating unrelated
   URLs or taking over user-owned tabs.
5. **Effect reconciliation.** The protocol needs workflow-neutral evidence for
   submitted, not-submitted, and unknown outcomes while leaving the final
   business judgment to the AOS adapter.
6. **DOM and CDP security.** The balance between `chrome.scripting`, DOM
   snapshots, and a constrained `chrome.debugger` command allowlist requires a
   formal threat model. Unrestricted evaluation is not an acceptable default.
7. **Upload and file boundaries.** File chooser handling needs explicit path
   allowlists, per-operation authority, user-visible diagnostics, and no generic
   filesystem read capability.
8. **One-product distribution and updates.** Development can use an unpacked
   Extension, but the public product needs Chrome Web Store signing, signed
   operating-system installers, compatible relay/broker/plugin versions,
   automatic updates, and a repair flow that does not ask users to wire paths or
   ports manually.
9. **Coexistence and cutover.** The Companion must coexist with the official
   Extension, use a different Native Messaging host name, never overwrite
   `com.openai.codexextension`, and make Companion-first routing clear. Because
   the official Extension's active mutation state is private, same-tab
   simultaneous use cannot be coordinated perfectly and must be excluded by the
   product contract and normal routing.
10. **Observable resource budgets.** Broker memory, Extension connections,
    session count, pending journals, diagnostics retention, and reconnect rate
    need explicit limits and pressure behavior.
11. **Acceptance evidence.** Static tests are insufficient. The product needs
    live canaries for suspend/reconnect/restart, concurrent exact tabs,
    foreground FIFO, upload, unknown-effect reconciliation, foreign-tab safety,
    and cleanup.
12. **Codex installation and policy.** The Companion installer can bundle a
    Codex plugin/MCP server, but personal, managed, and enterprise Codex
    environments may impose different plugin availability, approval, and trust
    policies. Correctness must not depend on silently trusting a hook.
13. **Multi-profile ambiguity.** Zero configuration is safe when exactly one
    Companion profile instance is connected. If a user installs it in several
    profiles, the product needs an explicit, persistent selection or workflow
    binding; using last focus or a display name as authority is unsafe.

## Fundamental Limitations

These limitations remain even if the Companion is implemented correctly.
They are product boundaries, not defects to hide with retries or fallbacks.

1. **It cannot repair the official Extension internally.** The Companion cannot
   inspect, patch, intercept, or guarantee the official side panel, private
   Native Messaging protocol, OpenAI service, or `@Chrome` implementation. The
   official Extension can still fail independently while Companion operations
   remain healthy.
2. **It cannot guarantee safety when two opaque writers mutate the same tab.**
   Companion sessions can coordinate with one another, but the Companion cannot
   atomically lock an official-Extension mutation it cannot observe. The normal
   contract is Companion-first browser execution and one writer per tab. If a
   user explicitly invokes both executors on the same tab at the same time, the
   result is outside the stability guarantee.
3. **It cannot provide a truly zero-interaction installation.** Chrome Web Store
   installation, broad site permissions where required, operating-system code
   signing and Native Host registration, and Codex/workspace plugin policy may
   require explicit user or administrator confirmation. The goal is zero manual
   technical configuration after those security confirmations.
4. **It cannot bypass human or provider security gates.** CAPTCHA, OTP, identity
   verification, payment, unknown required answers, account locks, workspace
   policy, and provider approvals remain user or administrator boundaries.
5. **It cannot control every Chrome surface.** Browser-protected pages, Chrome
   Web Store pages, browser chrome, some embedded viewers, and APIs unavailable
   to normal Extensions may remain unsupported. Unsupported capability returns
   an exact blocker rather than an alternate hidden automation route.
6. **It cannot make arbitrary websites permanently stable.** DOM changes,
   anti-automation defenses, expired authentication, site rate limits, network
   failures, removed routes, and upstream application defects require bounded
   adapters, fresh readback, or user intervention.
7. **It cannot promise unlimited parallelism.** Distinct exact tabs can run in
   parallel, but same-target operations and profile-global resources are
   serialized. CPU, memory, network, Chrome debugger attachment, site limits,
   downloads, file choosers, focus, popups, and authentication create finite
   capacity and backpressure.
8. **It cannot override debugger or DevTools contention.** Chrome may allow only
   one debugger attachment for a target. DevTools, another Extension, or the
   official Extension may make a debugger-dependent operation unavailable. The
   Companion must report and contain this target-local blocker.
9. **It cannot infer the intended profile safely when several Companion
   instances are installed.** One installed instance is zero-configuration. A
   multi-profile installation requires an explicit binding and is not resolved
    from last focus, profile display name, or filesystem order.

## Companion-only browser execution cutover

The official Extension stops being a browser-control dependency only after all
of the following are true. Private OpenAI UI features are explicitly outside
this cutover and may still require the official product.

1. Semantic parity covers checkbox/radio state, keyboard actions, scroll,
   history navigation, dialogs, file chooser, downloads, clipboard, console
   readback, frames, shadow DOM, and page-defined tools.
2. A constrained first-class visual-input capability covers pointer move,
   coordinate click/double-click, drag, and key input with screenshot-bound
   target proof. It must not expose unrestricted CDP or arbitrary page code.
3. Every visual mutation remains task-owned, generation-fenced, origin-bound,
   idempotent, no-replay, and followed by semantic plus visual readback.
4. Each AOS workflow has a Companion effect adapter with provider receipt,
   source sync, reconciliation, and terminal tab cleanup. A generic successful
   click is never treated as workflow completion.
5. Resume, AOS, Heavy, MyPro, Jobs, Daily AI, NisenPrints, prompt transfer, and
   social publishing pass representative live canaries, including reconnect,
   timeout/late-result reconciliation, unsupported controls, and user-only
   authentication stops.
6. The adaptive selector is changed to Companion-only browser execution only
   after those proofs are current. Until then, effect workflows without a
   Companion effect adapter select the official Extension before dispatch, and
   a safe terminal no-effect attempt may transition one way only.
10. **It cannot turn browser success into business completion.** A connected
    Extension, successful tab action, screenshot, or DOM state does not prove an
    application, post, upload, purchase, or other external workflow completed.
    Workflow-specific receipts, reconciliation, and approval remain with AOS or
    the calling client.
11. **It cannot make secrets risk-free.** Logged-in pages and broad browser
    access are inherently sensitive. The product can minimize permissions,
    redact diagnostics, use task-scoped capability tokens, and avoid general
    logging, but it cannot eliminate the consequences of a compromised local
    machine, malicious page, Extension supply-chain compromise, or hostile
    same-user process without a stronger operating-system security boundary.

## Key Decisions And Assumptions

### Decisions

1. The product working name is **AOS Chrome Companion**. The repository may
   retain `aos-chrome-bridge` as its internal working directory during the
   transition, but that is not the user-facing product concept.
2. Codex and Automation OS are the first supported clients; a generic MCP
   product is a later option, not the initial strategic constraint.
3. The default browser topology is the same Chrome profile in which the user
   installs both the official Extension and the Companion Extension. Dedicated
   profiles are optional advanced isolation.
4. The normal zero-configuration case has exactly one connected Companion
   profile instance. Multiple Companion profile instances require explicit
   binding and are not guessed.
5. The project replaces the browser-control execution surface, not ChatGPT's
   side panel or private `@Chrome` integration.
6. AOS Chrome Companion is one product containing a Web Store Extension, signed
   Native Messaging relay and resident broker, Codex plugin/MCP adapter, AOS
   adapter, diagnostics, and updater.
7. The Extension, Native Messaging relay, resident broker, Codex plugin/MCP
   adapter, and AOS adapter use one versioned clean-room protocol with explicit
   component boundaries.
8. Browser transport outlives a task; logical sessions and tab leases do not.
9. Distinct exact tabs may execute in parallel. Same-target and profile-global
   operations are serialized.
10. Foreground state is operation-scoped and is not a prerequisite for
    target-scoped readback or actions.
11. Unknown mutation results are reconciled and never automatically replayed.
12. AOS retains all workflow/business authority and completion semantics.
13. The official Extension remains installed for official features. The
    Companion uses a separate Extension ID, host name, storage namespace,
    broker endpoint, selector surface, and runtime identity.
14. Companion-first routing and one writer per tab are part of the product
    contract. Simultaneous official and Companion mutation of the same tab is
    outside the stability guarantee.
15. Zero configuration means no manual technical wiring after explicit
    installation, permission, and policy confirmations; it does not mean
    bypassing Chrome, operating-system, Codex, or administrator security gates.

### Assumptions

- During development, the user can enable developer mode and install an unpacked
  Companion Extension in the intended Chrome profile. Public distribution does
  not depend on developer mode.
- The initial macOS environment can install a user-scoped signed Native
  Messaging relay and resident broker without requiring an unauthenticated TCP
  listener. Other operating systems require their own signed installer and
  registration implementation.
- Codex can consume the Companion through a bundled plugin containing workflow
  guidance and a controlled MCP server, consistent with the public plugin
  architecture. AOS can consume the same versioned broker protocol through a
  thin adapter without making either adapter the workflow authority.
- A unique Companion profile instance is sufficient for zero-configuration
  routing on the user's current machine. Multi-profile Companion installation
  is not assumed to be zero-configuration.
- Public Chrome APIs provide enough control for the required workflows; any
  unsupported operation remains an exact capability gap rather than a reason to
  emulate the proprietary protocol.

## Deferred Or Not Yet Decided

- Final product and Extension display names, icons, and public branding.
- License selection for the new OSS repository.
- Implementation language and packaging for the broker and Native Host.
- Exact installer and update technology for each supported operating system.
- Whether the bundled Codex MCP server is local-only stdio, a restrictive local
  socket service, or both behind one plugin package.
- Exact Chrome API mix for each operation (`chrome.scripting`, constrained CDP,
  or another public API).
- Long-term Extension distribution: unpacked development, unlisted Chrome Web
  Store, or public listing.
- The order and acceptance standard for macOS, Windows, and Linux public
  support.
- The explicit binding experience when a user deliberately installs the
  Companion in several Chrome profiles.
- Whether and when generic third-party MCP clients become supported.
- Whether background tab recording belongs in the core product or an optional
  module.
- Exact retention periods and resource ceilings for diagnostic events.
- The cutover date at which any AOS workflow should select the new surface by
  default. No current selector is changed by this design document.

## Project Summary

AOS Chrome Companion should become a clean-room, independently owned Chrome
automation product for Codex and Automation OS. The user installs the official
Extension and the Companion Extension in the desired Chrome profile; the
Companion identifies that profile instance automatically and provisions its
signed local relay/broker and Codex/AOS adapters as one product. Its central
design move is to separate long-lived browser transport from short-lived task
ownership: one resident broker manages the versioned profile-instance
connection, while each task receives a generation-fenced logical session and
exact-tab lease.

The product succeeds when same-profile concurrent exact-tab work is routine,
restart and MV3 suspension are bounded state changes, foreground contention is
localized, unknown mutations are never replayed, helper growth is bounded, and
diagnostics identify the true failure plane quickly. The official Extension
remains for official features, while Companion-first routing and one writer per
tab protect normal Codex/AOS browser execution. It does not repair the official
private protocol, coordinate opaque same-tab official mutations, bypass human
or platform safety gates, promise unlimited parallelism, or take business
authority away from AOS. The main unresolved strategy questions concern the
local trust model, constrained DOM/CDP interface, signed cross-platform
packaging, multi-profile binding, and eventual generic MCP scope.
