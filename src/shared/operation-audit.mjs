import { createHash, createHmac, timingSafeEqual } from 'node:crypto';
import { CompanionError } from './errors.mjs';

const STATES = new Set(['prepared', 'dispatched', 'applied', 'unknown_effect', 'reconciled', 'blocked']);
const KEYS = new Set(['limit', 'cursor', 'method', 'state', 'tabId']);
const hash = value => createHash('sha256').update(value).digest('hex');
const invalid = message => new CompanionError('operation_audit_invalid', message);

export function normalizeOperationAudit(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value) || Object.keys(value).some(key => !KEYS.has(key))) throw invalid('audit must contain only limit, cursor, method, state and tabId');
  const limit = value.limit ?? 20;
  if (!Number.isInteger(limit) || limit < 1 || limit > 100) throw invalid('audit.limit must be an integer from 1 to 100');
  const result = { limit };
  if (value.cursor !== undefined) {
    if (typeof value.cursor !== 'string' || value.cursor.length < 1 || value.cursor.length > 2048) throw invalid('audit.cursor is invalid');
    result.cursor = value.cursor;
  }
  if (value.method !== undefined) {
    if (typeof value.method !== 'string' || !/^[A-Za-z][A-Za-z0-9.]{0,99}$/u.test(value.method)) throw invalid('audit.method must be a bounded operation method name');
    result.method = value.method;
  }
  if (value.state !== undefined) {
    if (!STATES.has(value.state)) throw invalid('audit.state is not an operation state');
    result.state = value.state;
  }
  if (value.tabId !== undefined) {
    if (!Number.isSafeInteger(value.tabId) || value.tabId < 0) throw invalid('audit.tabId must be a non-negative integer');
    result.tabId = value.tabId;
  }
  return result;
}

// Preserve the exact legacy signed payload when audit is omitted.
export function taskStatusPayload(params) {
  return { runId: params.runId, taskId: params.taskId, idempotencyKey: params.idempotencyKey ?? null, capsuleId: params.capsuleId ?? null,
    ...(params.audit === undefined ? {} : { audit: normalizeOperationAudit(params.audit) }) };
}

function cursorSignature(secret, body) { return createHmac('sha256', secret).update('aos-operation-audit-cursor-v1\0' + body).digest('hex'); }
function encodeCursor(secret, payload) {
  const body = Buffer.from(JSON.stringify(payload)).toString('base64url');
  return body + '.' + cursorSignature(secret, body);
}
function decodeCursor(secret, cursor, scope) {
  const bad = () => new CompanionError('operation_audit_cursor_invalid', 'The audit cursor is invalid for this task, run or filter; start a new audit page without a cursor');
  if (!/^[A-Za-z0-9_-]{1,1800}\.[a-f0-9]{64}$/u.test(cursor)) throw bad();
  const [body, signature] = cursor.split('.');
  if (!timingSafeEqual(Buffer.from(signature, 'hex'), Buffer.from(cursorSignature(secret, body), 'hex'))) throw bad();
  let value;
  try { value = JSON.parse(Buffer.from(body, 'base64url').toString('utf8')); } catch { throw bad(); }
  if (!value || value.v !== 1 || value.scope !== scope || !Number.isSafeInteger(value.asOf) || value.asOf < 0
    || !Number.isSafeInteger(value.lastTime) || value.lastTime < -1 || !/^[a-f0-9]{64}$/u.test(value.lastHash)) throw bad();
  return value;
}

function timestamp(value) { const time = typeof value === 'string' ? Date.parse(value) : NaN; return Number.isFinite(time) ? time : -1; }
function iso(value) { const time = timestamp(value); return time < 0 ? null : new Date(time).toISOString(); }
function string(value, max = 240) { return typeof value === 'string' ? value.slice(0, max) : null; }
function identifier(value, name, omitted) {
  if (typeof value !== 'string') return null;
  if (value.length <= 4096) return value;
  omitted.push(name);
  return null; // Never return a truncated opaque identifier that could be reused.
}
function target(entry) {
  const binding = entry.binding ?? {}, identity = binding.targetIdentity ?? {};
  let origin = null;
  try { const url = new URL(identity.origin); if (['http:', 'https:'].includes(url.protocol)) origin = url.origin; } catch { /* missing historical origin */ }
  return {
    profileInstanceId: string(binding.profileInstanceId ?? identity.profileInstanceId), generation: string(binding.generation ?? identity.generation),
    tabId: Number.isSafeInteger(binding.tabId ?? identity.tabId) ? (binding.tabId ?? identity.tabId) : null,
    pageInstanceId: string(identity.pageInstanceId), windowId: Number.isSafeInteger(identity.windowId) ? identity.windowId : null,
    frameId: Number.isSafeInteger(identity.frameId) ? identity.frameId : null, origin,
  };
}
function metadata(entry) {
  const omitted = [];
  const result = {
    runId: identifier(entry.binding?.runId, 'runId', omitted),
    operationId: identifier(entry.operationId, 'operationId', omitted),
    idempotencyKey: identifier(entry.idempotencyKey, 'idempotencyKey', omitted),
    method: string(entry.binding?.method, 100), state: string(entry.state, 64), effectState: string(entry.effectState ?? entry.operationEffectState, 64),
    dispatchState: string(entry.dispatchState, 64), dispatchCount: Number.isSafeInteger(entry.dispatchCount) ? entry.dispatchCount : null,
    mutationDispatchAttempted: typeof entry.mutationDispatchAttempted === 'boolean' ? entry.mutationDispatchAttempted : null,
    externalActionExecuted: typeof entry.externalActionExecuted === 'boolean' ? entry.externalActionExecuted : null,
    reconciliationRequired: typeof entry.reconciliationRequired === 'boolean' ? entry.reconciliationRequired
      : entry.state === 'unknown_effect' || entry.effectState === 'unknown_effect',
    brokerEvidence: entry.brokerEvidence === true, resultDigest: string(entry.resultDigest, 256),
    errorCode: string(entry.errorCode ?? entry.error?.code ?? entry.exactBlocker?.code, 100), interruptedClassification: string(entry.interruptedClassification, 100),
    restartRecoveryDisposition: string(entry.restartRecoveryDisposition, 100),
    preparedAt: iso(entry.preparedAt), dispatchedAt: iso(entry.dispatchedAt), updatedAt: iso(entry.updatedAt),
    reconciledAt: iso(entry.reconciledAt), target: target(entry),
  };
  if (omitted.length) result.omittedIdentifiers = Object.fromEntries(omitted.map(key => [key, { reason: 'identifier_exceeds_metadata_limit', sha256: hash(key === 'runId' ? entry.binding.runId : entry[key]) }]));
  return result;
}

/** Latest metadata from the existing ledger, not a second append-only log. */
export function operationAuditPage({ operations, taskId, runId, profileInstanceId = null, audit, secret, now = Date.now() }) {
  const options = normalizeOperationAudit(audit);
  const filters = { method: options.method ?? null, state: options.state ?? null, tabId: options.tabId ?? null };
  const scope = hash(JSON.stringify({ taskId, runId, profileInstanceId, filters }));
  const cursor = options.cursor ? decodeCursor(secret, options.cursor, scope) : null;
  const asOf = cursor?.asOf ?? now;
  const ordered = operations.filter(entry => entry.state !== 'task_tab' && entry.binding?.taskId === taskId
    && (runId == null || entry.binding?.runId === runId) && (profileInstanceId == null || entry.binding?.profileInstanceId === profileInstanceId)
    && typeof entry.idempotencyKey === 'string' && (!options.method || entry.binding.method === options.method)
    && (!options.state || entry.state === options.state) && (options.tabId === undefined || target(entry).tabId === options.tabId))
    .map(entry => ({ entry, time: timestamp(entry.preparedAt), hash: hash(entry.idempotencyKey) }))
    .filter(row => row.time <= asOf)
    .sort((left, right) => right.time - left.time || (left.hash < right.hash ? -1 : left.hash > right.hash ? 1 : 0));
  const remaining = ordered.filter(row => !cursor || row.time < cursor.lastTime || (row.time === cursor.lastTime && row.hash > cursor.lastHash));
  const entries = [];
  let bytes = 0, last = null;
  for (const row of remaining) {
    if (entries.length >= options.limit) break;
    const value = metadata(row.entry), size = Buffer.byteLength(JSON.stringify(value));
    if (entries.length && bytes + size > 256 * 1024) break;
    entries.push(value); bytes += size; last = row;
  }
  const hasMore = remaining.length > entries.length;
  return {
    schema: 'aos.chrome_companion.operation_audit.v1', taskId, runId, filters, order: 'preparedAt_desc_then_identifier_digest',
    preparedBeforeOrAt: new Date(asOf).toISOString(), consistency: 'latest_record_metadata; excludes newer preparations; not immutable state-transition history',
    matchedCount: ordered.length, returnedCount: entries.length, metadataBytes: bytes, entries,
    nextCursor: hasMore && last ? encodeCursor(secret, { v: 1, scope, asOf, lastTime: last.time, lastHash: last.hash }) : null,
    browserCommandsDispatched: 0, rawResultsReturned: false,
  };
}
