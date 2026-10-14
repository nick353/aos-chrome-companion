# Root recovery boundaries

This release separates runtime connectivity, installation/integration readiness
and provider/business completion. A historical deferred receipt or one retained
target must not be interpreted as a global browser failure.

## Setup transaction recovery

Normal acquisition and release run inside a one-shot kernel-flock transaction.
The coordinator inode is stable. Complete validated v2 markers are published
atomically without replacing an existing destination; partial staged writes are
not final markers. Dead helper results are reconciled to the original IDs and
held marker identity, not by replaying an acquisition or adopting another owner.
Release finalization applies only to the exactly owned local lease after proof
that its original helper is dead. If proof is insufficient, retain the original
lease identity and report the cause. Legacy markers require separately verified
maintenance exclusions and are never age-deleted.

Fresh matching runtime and artifact provenance may supersede an obsolete
activation-pending receipt. It does not prove authentication, integration,
provider completion or installation on another computer.

## Owned navigation recovery

Obtain fresh status, open this task's session and reserve its exact tab. Use the
current inventory URL/window/pending URL tuple with navigation diagnostics.
Only an explicitly intended stop uses the separately signed stop-loading tool.
It dispatches once through the Extension's own guarded debugger transport;
normal page reads still reject pending navigation. No reload, unknown operation,
submission or provider effect is replayed or declared reconciled.

After a stop, verify the same document and actual contents before continuing
readback. An unresolved reload/navigation still blocks external mutations on
that physical target, even from another task or run. Diagnostics, a successful
stop, the same URL or a new session do not settle the original operation; use
the existing operation-bound reconciliation contract. Independent targets can
continue within their own authority.
Foreign/manual tabs and out-of-allowlist pending origins are not recoverable by
this task. A failure after dispatch remains unknown; do not repeat the stop.

## Clipboard longevity

Completed source metadata may be compacted, but exact request binding and the
completed dedupe identity must remain durable. A compacted duplicate is a
historical acknowledged write with no new dispatch, never evidence of a paste
or provider completion. Unfinished intents remain immutable. Actual storage
exhaustion stops before a new native write, rather than deleting uncertain
history or permitting old operation IDs to execute again.

## Acceptance limits

Fixture/static/source-suite results do not prove actual Note framework saves,
current-build recording audio, every website, or installation on another Mac.
Those need separately authorized exact-target readback. Report implementation,
activation and real-workflow verification separately.
