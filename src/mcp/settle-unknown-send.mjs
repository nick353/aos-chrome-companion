import { createHash } from 'node:crypto';
import { readUrls } from './read-urls.mjs';

const squash = (value) => String(value ?? '').normalize('NFKC').replace(/\s+/gu, ' ').trim().toLowerCase();

/** Settle an uncertain send from where the site lists sent items (owner, 2026-10-16). The evidence page
 * is read in a temporary task tab of its own (the read-only readUrls path), the phrase is looked for in
 * its text, and the broker decides: sent, not seen yet, or not sent. Nothing is ever sent again here.
 */
export async function settleUnknownSend(client, { sessionId, taskId, runId, idempotencyKey, capsuleId, evidenceUrl, successQuery }, { signal } = {}) {
  const read = await readUrls(client, { sessionId, taskId, runId,
    idempotencyKey: `${idempotencyKey}:evidence:${Date.now()}`, urls: [evidenceUrl], concurrency: 1, maxCharsPerPage: 20000 }, { signal });
  const row = read.rows[0] ?? {};
  if (row.status !== 'read') {
    return { outcome: 'evidence_unreadable', evidence: { url: evidenceUrl, status: row.status ?? 'failed', exact_blocker: row.exact_blocker ?? row.error ?? null },
      resend_allowed: false, next_action: 'fix_the_evidence_url_or_try_again; do not send again' };
  }
  const found = squash(row.text).includes(squash(successQuery));
  const evidenceDigest = createHash('sha256').update(String(row.text ?? ''), 'utf8').digest('hex');
  const settled = await client.requestSettleFromEvidence({ sessionId, taskId, runId, idempotencyKey, capsuleId,
    evidenceUrl, successQuery, found, evidenceDigest });
  return { ...settled, found, evidence: { url: row.finalUrl ?? evidenceUrl, title: row.title ?? null, truncated: row.truncated === true },
    screenshot: row.screenshot ?? null };
}
