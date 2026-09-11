import { CompanionError } from './errors.mjs';
import { operationAuditPage } from './operation-audit.mjs';

/** Profile-wide view of the same ledger query used by transaction-status audit. */
export function operationHistory(entries, { taskId, profileInstanceId, runId = null, method = null, state = null, limit = 50, cursor = null }, secret) {
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > 100) throw new CompanionError('operation_history_limit_invalid', 'Use a limit from 1 to 100');
  let page;
  try {
    page = operationAuditPage({ operations: entries, taskId, profileInstanceId, runId, secret,
      audit: { limit, ...(method ? { method } : {}), ...(state ? { state } : {}), ...(cursor ? { cursor } : {}) } });
  } catch (error) {
    if (error?.code === 'operation_audit_cursor_invalid' || (cursor && error?.code === 'operation_audit_invalid')) {
      throw new CompanionError('operation_history_cursor_invalid', 'Use the unchanged cursor from this task and the same filters');
    }
    throw error;
  }
  const rows = page.entries.map(entry => ({ operationId: entry.operationId, runId: entry.runId,
    method: entry.method, tabId: entry.target.tabId, state: entry.state, effectState: entry.effectState,
    dispatchState: entry.dispatchState, dispatchCount: entry.dispatchCount ?? 0,
    preparedAt: entry.preparedAt, updatedAt: entry.updatedAt, exactBlocker: entry.errorCode,
    reconciliationRequired: entry.reconciliationRequired }));
  return { schema: 'aos.chrome_companion.operation_history.v1', taskId, profileInstanceId, rows,
    nextCursor: page.nextCursor, count: rows.length, source: 'existing_task_operation_ledger',
    historyOnly: true, provider_completion: 'unverified' };
}
