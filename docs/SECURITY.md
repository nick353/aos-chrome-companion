# Security boundary

The development build is a clean-room Companion and does not read, patch, or
reuse the official OpenAI Extension ID, source, storage, Native Messaging host,
or private protocol.

Current controls:

- user-only broker directory, Unix socket, and random secret;
- exact allowed Extension origin in the Native Messaging manifest;
- typed browser method allowlist without arbitrary JavaScript evaluation;
- semantic locators instead of caller-supplied JavaScript;
- credential-free `http(s)` navigation validation;
- exact-tab leases and generation fences;
- no automatic replay after mutation timeout;
- explicit no-dispatch/known-no-effect/known-effect/unknown-effect states;
- signed task-scoped operation-effect proofs and read-only resume preparation;
- bounded page snapshots and redacted broker diagnostics.
- explicit attribute reads with sensitive names and form value attributes
  redacted, bounded aggregate output, and reported truncation; editable input
  values are not used as fallback accessible names;
- exact leased-tab visual screenshots with temporary foreground activation,
  bounded JPEG size, and best-effort restoration of the previous active tab;
- separate per-install `aos` and `codex_mcp` authority issuer secrets;
- signed authority binding and nonce replay protection;
- task-created-tab provenance; caller labels cannot make an existing tab mutable;
- host-supplied MCP Codex task-ID binding with mismatch/conflict rejection;
- MCP-adapter session/lease task bindings that fail closed on unknown or
  cross-task cleanup and operation requests;
- compatible-target task-tab reuse, exact lease exclusion, and task-specific Chrome group;
- distinct visible `AOS Companion` cursor/action marker for page mutations;
- screenshot-bound virtual cursor and visual-point proofs use Chrome debugger
  input only; they explicitly report `osCursorMoved=false` and never invoke
  AppleScript, Accessibility/CGEvent, RobotJS, native HID, or shell focus;
- bounded upload allowlist (regular non-symlink files, 25 MiB maximum per file and upload);
- committed navigation and pre/post live-origin checks;
- read-only source/install control-plane drift detection before any automatic
  local refresh;
- deferred-refresh receipts that retry only at an idle, reconciled boundary;
- atomic, mode-0600 idempotency ledger with restart-to-unknown conversion;
- semantic authorized transaction path; arbitrary JavaScript/eval is not exposed.

Development limitations:

- `<all_urls>` is currently required for background-tab scripting and must be
  explained during installation;
- a malicious process running as the same operating-system user may still read
  the local secret unless stronger platform isolation is added;
- signed installers, update signing, extension review, and supply-chain
  hardening remain release work;
- browser-protected pages, CAPTCHA, OTP, identity, payment, administrator
  policy, and opaque official-Extension mutations remain outside this trust
  boundary.
- the official Extension has no public coordination hook used here; tab groups,
  leases, and visible markers protect Companion-owned tabs but cannot
  atomically lock an opaque official mutation on the same tab;
- provider receipts are untrusted input; AOS must independently validate the
  provider receipt and perform post-readback/source reconciliation before
  declaring business completion.
