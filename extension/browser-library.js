function error(code, message, details = {}) {
  return Object.assign(new Error(message), { code, details: { mutationDispatchAttempted: false, operationEffectState: 'none', ...details } });
}
function safePage(value) {
  try { const url = new URL(value); return ['http:', 'https:'].includes(url.protocol) && !url.username && !url.password ? url : null; } catch { return null; }
}

export async function searchBrowserLibrary(api, { source, query = '', limit = 50, startTime, endTime }, blockedOrigins = []) {
  if (!['history', 'bookmarks'].includes(source)) throw error('browser_library_source_invalid', 'Choose history or bookmarks');
  if (typeof query !== 'string' || query.length > 200 || !Number.isSafeInteger(limit) || limit < 1 || limit > 100) {
    throw error('browser_library_query_invalid', 'Use a query up to 200 characters and a result limit from 1 to 100');
  }
  if ([startTime, endTime].some(value => value !== undefined && (!Number.isFinite(value) || value < 0))
    || (startTime !== undefined && endTime !== undefined && startTime > endTime)) throw error('browser_history_time_invalid', 'Use an ordered time range in Unix milliseconds');
  if (!await api.permissions.contains({ permissions: [source] })) throw error('browser_library_permission_required',
    `Allow ${source} access in the Companion panel before searching`, { nextAction: 'Allow this optional access in the Companion panel, then repeat the read' });
  const values = source === 'history'
    ? await api.history.search({ text: query, maxResults: limit, ...(startTime !== undefined ? { startTime } : {}), ...(endTime !== undefined ? { endTime } : {}) })
    : await api.bookmarks.search(query);
  const blocked = new Set(blockedOrigins);
  const allowed = values.filter(value => { const url = safePage(value.url); return url && !blocked.has(url.origin); });
  const rows = allowed.slice(0, limit).map(value => ({ id: String(value.id), title: String(value.title ?? '').slice(0, 500),
    url: value.url, ...(source === 'history' ? { lastVisitTime: value.lastVisitTime ?? null, visitCount: value.visitCount ?? null }
      : { parentId: value.parentId ?? null, dateAdded: value.dateAdded ?? null }) }));
  return { source, rows, count: rows.length, truncated: allowed.length > limit || (source === 'history' && values.length === limit),
    filteredCount: values.length - allowed.length, containsPageContents: false, storedByCompanion: false };
}

export async function configureTaskTab(api, params) {
  const { tabId, pinned, muted, index, destinationWindowId: windowId } = params;
  if (!Number.isSafeInteger(tabId) || tabId < 0
    || [pinned, muted].some(value => value !== undefined && typeof value !== 'boolean')
    || (index !== undefined && (!Number.isSafeInteger(index) || index < -1))
    || (windowId !== undefined && (!Number.isSafeInteger(windowId) || windowId < 0))
    || [pinned, muted, index, windowId].every(value => value === undefined)) {
    throw error('task_tab_configuration_invalid', 'Provide a pinned/muted state or a destination window/index for this task tab');
  }
  const before = await api.tabs.get(tabId);
  if (windowId !== undefined) await api.windows.get(windowId);
  let attempted = false;
  const applied = [];
  try {
    if (pinned !== undefined || muted !== undefined) {
      attempted = true;
      await api.tabs.update(tabId, { ...(pinned !== undefined ? { pinned } : {}), ...(muted !== undefined ? { muted } : {}) });
      applied.push('update');
    }
    if (index !== undefined || windowId !== undefined) {
      attempted = true;
      await api.tabs.move(tabId, { index: index ?? -1, ...(windowId !== undefined ? { windowId } : {}) });
      applied.push('move');
    }
    const after = await api.tabs.get(tabId);
    if (after.id !== before.id || after.url !== before.url
      || (pinned !== undefined && after.pinned !== pinned)
      || (muted !== undefined && after.mutedInfo?.muted !== muted)
      || (windowId !== undefined && after.windowId !== windowId)) {
      throw error('task_tab_configuration_readback_mismatch', 'The tab configuration changed during readback');
    }
    return { configured: true, tabId, windowId: after.windowId, index: after.index, pinned: after.pinned,
      muted: after.mutedInfo?.muted ?? false, applied, previousWindowId: before.windowId,
      indexRequested: index ?? null, indexReadback: after.index, url: after.url };
  } catch (failure) {
    failure.details = { ...(failure.details ?? {}), mutationDispatchAttempted: attempted,
      operationEffectState: attempted ? 'unknown' : 'none', applied, nextAction: 'Read this exact tab before any further configuration' };
    throw failure;
  }
}

export async function bookmarkTaskPage(api, { tabId, title, parentId }) {
  if (!await api.permissions.contains({ permissions: ['bookmarks'] })) throw error('browser_library_permission_required', 'Allow bookmarks access in the Companion panel first');
  if ((title !== undefined && (typeof title !== 'string' || title.length > 500))
    || (parentId !== undefined && (typeof parentId !== 'string' || !parentId))) throw error('bookmark_parameters_invalid', 'Use a title up to 500 characters and an existing folder ID');
  const tab = await api.tabs.get(tabId);
  if (!safePage(tab.url)) throw error('bookmark_page_invalid', 'Bookmark a task-owned HTTP or HTTPS page');
  if (parentId) { const parent = (await api.bookmarks.get(parentId))[0]; if (!parent || parent.url) throw error('bookmark_parent_invalid', 'Select an existing bookmark folder'); }
  // Creating a duplicate bookmark for the same URL does not help a retry.
  // Return the existing item without changing its title or location.
  const existing = (await api.bookmarks.search({ url: tab.url })).find(value => parentId === undefined || value.parentId === parentId);
  if (existing) return { bookmarked: true, created: false, bookmarkId: existing.id, title: existing.title, url: existing.url, parentId: existing.parentId };
  let created;
  try {
    created = await api.bookmarks.create({ url: tab.url, title: title ?? tab.title ?? tab.url, ...(parentId ? { parentId } : {}) });
    const current = (await api.bookmarks.get(created.id))[0];
    if (!current || current.url !== tab.url || current.title !== created.title) throw Error('Bookmark readback changed');
    return { bookmarked: true, created: true, bookmarkId: current.id, title: current.title, url: current.url, parentId: current.parentId };
  } catch (failure) {
    throw error('bookmark_result_unknown', 'Read the bookmark collection before another write', {
      mutationDispatchAttempted: true, operationEffectState: 'unknown', bookmarkId: created?.id ?? null, retryWrite: false });
  }
}
