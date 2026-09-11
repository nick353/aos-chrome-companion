import { createHash } from 'node:crypto';
import { CompanionError, normalizeError } from '../shared/errors.mjs';

function webUrl(value) {
  let url;
  try { url = new URL(value); } catch { throw new CompanionError('read_urls_invalid_url', 'Provide an absolute HTTP or HTTPS URL'); }
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) {
    throw new CompanionError('read_urls_invalid_url', 'Only HTTP or HTTPS URLs without embedded credentials are supported');
  }
  return url;
}

/** Uses the normal signed transaction and owner cleanup path. Cancellation
 * stops new reads; an already dispatched read is awaited through cleanup.
 * Neither a second navigation nor an unrelated task tab is used on failure.
 */
export async function readUrls(client, { sessionId, taskId, runId, idempotencyKey, urls,
  allowedOrigins = [], concurrency = 2, maxCharsPerPage = 12000 }, { signal } = {}) {
  if (!Array.isArray(urls) || urls.length < 1 || urls.length > 10) throw new CompanionError('read_urls_count_invalid', 'Provide 1 to 10 URLs');
  if (!Number.isInteger(concurrency) || concurrency < 1 || concurrency > 2) throw new CompanionError('read_urls_concurrency_invalid', 'Use concurrency 1 or 2');
  if (!Number.isInteger(maxCharsPerPage) || maxCharsPerPage < 100 || maxCharsPerPage > 20000) throw new CompanionError('read_urls_text_limit_invalid', 'Use 100 to 20000 characters per page');
  const parsed = urls.map(webUrl);
  const origins = [...new Set([...parsed.map(url => url.origin), ...allowedOrigins.map(value => webUrl(value).origin)])];
  const rows = new Array(parsed.length);
  const jobs = [], byUrl = new Map();
  for (const [index, url] of parsed.entries()) {
    const canonical = url.href;
    if (byUrl.has(canonical)) continue;
    byUrl.set(canonical, index);
    jobs.push({ index, url });
  }
  let next = 0;
  await Promise.all(Array.from({ length: Math.min(concurrency, jobs.length) }, async () => {
    while (next < jobs.length) {
      const { index, url } = jobs[next++];
      if (signal?.aborted) { rows[index] = { url: url.href, status: 'cancelled', dispatched: false, cleanup: { required: false } }; continue; }
      const digest = createHash('sha256').update(url.href).digest('hex').slice(0, 16);
      try {
        const result = await client.requestAuthorizedTransaction({ sessionId, taskId, runId,
          idempotencyKey: `${idempotencyKey}:url:${index}:${digest}`, intent: 'authorized_transaction',
          startUrl: url.href, targetOrigin: url.origin, allowedOrigins: origins,
          actions: [{ method: 'page.query', params: { locator: { css: 'body' }, limit: 1 } }],
          reuseTaskTab: false, keepTaskTab: false, retainOnUnknown: false,
          readbackMaxTextChars: maxCharsPerPage,
        }, { timeoutMs: 120000 });
        const page = result.post ?? {};
        const content = typeof page.text === 'string' ? page.text : '';
        rows[index] = { url: url.href, finalUrl: page.url ?? result.tab?.url ?? null,
          title: page.title ?? null, status: result.result === 'verified' ? 'read' : 'failed',
          text: content.slice(0, maxCharsPerPage), truncated: content.length > maxCharsPerPage || page.text_truncated === true,
          exact_blocker: result.exact_blocker ?? null, cleanup: result.cleanup ?? null,
          screenshot: result.visual_readback ?? null, readback: { textSha256: page.text_sha256 ?? null,
            provider_completion: 'not_applicable', source: 'same_transaction_page_readback' } };
      } catch (error) {
        rows[index] = { url: url.href, status: 'failed', error: normalizeError(error),
          cleanup: { verified: false, nextAction: 'Read this exact transaction status; do not repeat navigation until cleanup is known' } };
      }
    }
  }));
  for (const [index, url] of parsed.entries()) {
    const original = byUrl.get(url.href);
    if (original !== index) rows[index] = { ...rows[original], duplicateOf: original, screenshot: null };
  }
  return { schema: 'aos.chrome_companion.read_urls.v1', taskId, runId,
    cancelled: Boolean(signal?.aborted), rows, coverage: { requested: urls.length, unique: jobs.length,
      read: rows.filter(row => row.status === 'read').length,
      failed: rows.filter(row => row.status === 'failed').length,
      cancelled: rows.filter(row => row.status === 'cancelled').length },
    cleanupComplete: rows.every(row => row.cleanup?.closed === true || row.cleanup?.required === false),
    externalActionExecuted: false, provider_completion: 'not_applicable' };
}
