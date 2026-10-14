// The broker signs and runs at most MAX_ACTIONS_PER_TRANSACTION actions at a
// time. A longer list (for example "select each of 11 sizes, then press Fill"
// three times per size) is split here into consecutive transactions on the
// same task tab. Each part has its own idempotency key, and the split stops at
// the first part that is not verified, so nothing after an uncertain or
// blocked action is ever dispatched.

export const MAX_ACTIONS_PER_TRANSACTION = 32;
export const MAX_SPLIT_ACTIONS = MAX_ACTIONS_PER_TRANSACTION * 8;

function shiftIndices(values, offset) {
  return Array.isArray(values) ? values.map((value) => (Number.isSafeInteger(value) ? value + offset : value)) : values;
}

export async function runSplitTransaction(run, params, actions, { size = MAX_ACTIONS_PER_TRANSACTION } = {}) {
  if (actions.length <= size) return run({ ...params, actions });
  const parts = [];
  for (let offset = 0; offset < actions.length; offset += size) parts.push({ offset, actions: actions.slice(offset, offset + size) });
  const summaries = [];
  let tabId = params.tabId;
  let result = null;
  for (const [index, part] of parts.entries()) {
    const last = index === parts.length - 1;
    const partParams = {
      ...params,
      idempotencyKey: `${params.idempotencyKey}:part-${index + 1}-of-${parts.length}`,
      actions: part.actions,
      // Earlier parts must leave the tab open for the next part.
      ...(last ? {} : { keepTaskTab: true }),
      ...(index > 0 ? { tabId, reuseTaskTab: true, precondition: null } : {}),
    };
    result = await run(partParams);
    const partTabId = result?.tab?.id;
    if (Number.isSafeInteger(partTabId)) tabId = partTabId;
    summaries.push({
      part: index + 1,
      idempotency_key: partParams.idempotencyKey,
      action_offset: part.offset,
      action_count: part.actions.length,
      result: result?.result ?? null,
      tab_id: Number.isSafeInteger(partTabId) ? partTabId : null,
    });
    if (result?.result !== "verified") break;
  }
  const stoppedAt = summaries.at(-1);
  const stoppedOffset = stoppedAt.action_offset;
  const progress = result?.action_progress;
  return {
    ...result,
    split_transaction: {
      total_actions: actions.length,
      parts: parts.length,
      completed_parts: summaries.filter((entry) => entry.result === "verified").length,
      part_results: summaries,
      // Indices below refer to the caller's original action list.
      stopped_part_action_offset: stoppedOffset,
      remaining_action_indices: stoppedAt.result === "verified" ? []
        : [
          ...(shiftIndices(progress?.remaining_action_indices, stoppedOffset) ?? []),
          ...Array.from({ length: Math.max(0, actions.length - (stoppedOffset + stoppedAt.action_count)) }, (_, i) => stoppedOffset + stoppedAt.action_count + i),
        ],
      uncertain_action_indices: shiftIndices(progress?.uncertain_action_indices, stoppedOffset) ?? [],
      next_action: stoppedAt.result === "verified" ? "all_parts_verified"
        : "handle_the_stopped_part_like_a_single_transaction_then_continue_only_the_remaining_actions",
    },
  };
}
