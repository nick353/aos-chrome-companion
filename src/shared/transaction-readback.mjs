import { createHash } from 'node:crypto';
import { CompanionError } from './errors.mjs';

const TRANSIENT_READ_ERRORS = new Set(['screenshot_target_changed', 'page_execution_empty', 'target_frame_unavailable']);
const delay = milliseconds => new Promise(resolve => setTimeout(resolve, milliseconds));

export function semanticReadback(snapshot = {}) {
  return {
    url: snapshot.url,
    title: snapshot.title,
    page_instance_id: snapshot.pageInstanceId ?? null,
    text_sha256: createHash('sha256').update(String(snapshot.text ?? ''), 'utf8').digest('hex'),
  };
}

function checkOrigin(snapshot, allowedOrigins) {
  let origin;
  try { origin = new URL(snapshot?.url).origin; } catch { /* rejected below */ }
  if (!origin || !allowedOrigins.includes(origin)) {
    throw new CompanionError('redirect_origin_escape', 'Post-action readback left the approved origin set; inspect the retained target without repeating the action');
  }
}

export function observedTransition(before, after) {
  return String(before?.url ?? '') !== String(after?.url ?? '')
    || (before?.pageInstanceId ?? null) !== (after?.pageInstanceId ?? null)
    || semanticReadback(before).text_sha256 !== semanticReadback(after).text_sha256;
}

// All retries in this module are reads. A delayed response must never cause
// the click, form submission, upload, or other action to be dispatched again.
export async function readSubmissionTransition({ before, readSnapshot, allowedOrigins, timeoutMs = 1500, intervalMs = 100 }) {
  const deadline = Date.now() + timeoutMs;
  let attempts = 0;
  let after;
  do {
    attempts += 1;
    try {
      after = await readSnapshot();
      checkOrigin(after, allowedOrigins);
      if (observedTransition(before, after)) return { after, transitionObserved: true, attempts };
    } catch (error) {
      if (!TRANSIENT_READ_ERRORS.has(error?.code) || Date.now() >= deadline) throw error;
    }
    if (Date.now() >= deadline) break;
    await delay(Math.min(intervalMs, Math.max(0, deadline - Date.now())));
  } while (Date.now() <= deadline);
  return { after, transitionObserved: false, attempts };
}

export async function captureTransactionReadback({ initialSnapshot, readSnapshot, takeScreenshot, allowedOrigins, maxAttempts = 3, intervalMs = 100 }) {
  let after = initialSnapshot;
  let lastError;
  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    try {
      if (!after || attempt > 1) after = await readSnapshot();
      checkOrigin(after, allowedOrigins);
      const visual = await takeScreenshot();
      if (visual?.kind !== 'screenshot' || !visual.dataBase64
        || visual.url !== after.url
        || (visual.pageInstanceId && after.pageInstanceId && visual.pageInstanceId !== after.pageInstanceId)) {
        throw new CompanionError('screenshot_target_changed', 'The page changed between semantic readback and capture');
      }
      return { after, visual, attempts: attempt };
    } catch (error) {
      lastError = error;
      if (!TRANSIENT_READ_ERRORS.has(error?.code) || attempt === maxAttempts) throw error;
      await delay(intervalMs);
    }
  }
  throw lastError;
}

export function transactionOutcome(receipt) {
  const progress = receipt.action_progress;
  const applied = progress?.applied_action_indices ?? receipt.actions?.map(action => action.index) ?? [];
  const remaining = progress?.remaining_action_indices ?? [];
  const uncertain = progress?.uncertain_action_indices ?? [];
  const providerCompletion = receipt.provider_completion ?? 'unverified';
  const sourceSync = receipt.source_sync ?? 'unverified';
  return {
    schema: 'aos.chrome_companion.transaction_outcome.v1',
    browser_effect: receipt.effect_state ?? 'no_dispatch',
    applied_action_indices: applied,
    remaining_action_indices: remaining,
    uncertain_action_indices: uncertain,
    visual_readback: receipt.visual_readback?.kind === 'screenshot' ? 'verified' : 'unavailable',
    // A UI transition or upload control is not a provider receipt or a
    // source-system sync. These fields are populated only by that workflow.
    provider_completion: providerCompletion,
    source_sync: sourceSync,
    // This is intentionally false unless the owning workflow supplies both
    // provider and source-system evidence. A successful browser transaction
    // must never be presented as business completion.
    business_completion: providerCompletion === 'verified' && sourceSync === 'verified' ? 'verified' : 'unverified',
    completion_gate: {
      browser_readback: receipt.result === 'verified' ? 'verified' : 'unverified',
      provider_receipt: providerCompletion,
      source_sync: sourceSync,
      cleanup: receipt.cleanup?.verified === true || receipt.cleanup?.closed === true ? 'verified' : 'unverified',
    },
    reconciliation_required: receipt.capsule?.state === 'reconciliation_required' || Boolean(receipt.reconciliation),
    replay_allowed: false,
    next_action: receipt.result === 'verified' ? 'continue_from_verified_page'
      : receipt.reconciliation ? 'inspect_same_target_and_reconcile'
        : applied.length ? 'read_same_target_then_continue_remaining_actions'
          : 'correct_reported_precondition_then_continue',
  };
}
