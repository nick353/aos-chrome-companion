import test from 'node:test';
import assert from 'node:assert/strict';
import { searchBrowserLibrary, configureTaskTab, bookmarkTaskPage } from '../extension/browser-library.js';

test('history permission is checked before accessing any browsing records', async () => {
  let reads = 0;
  await assert.rejects(searchBrowserLibrary({ permissions: { contains: async () => false }, history: { search: async () => { reads++; } } }, { source: 'history' }), error => error.code === 'browser_library_permission_required');
  assert.equal(reads, 0);
});

test('library search respects blocked sites and excludes credentials, protected pages and content', async () => {
  const rows = [
    { id: 1, title: 'One', url: 'https://read.test/one', text: 'page body', lastVisitTime: 7 },
    { id: 2, title: 'Blocked', url: 'https://blocked.test/two' },
    { id: 3, url: 'https://user:secret@read.test/private' }, { id: 4, url: 'chrome://settings' },
  ];
  const result = await searchBrowserLibrary({ permissions: { contains: async () => true }, history: { search: async () => rows } },
    { source: 'history', query: 'one', startTime: 1, endTime: 10 }, ['https://blocked.test']);
  assert.equal(result.count, 1); assert.equal(result.filteredCount, 3);
  assert.equal(result.rows[0].id, '1'); assert.equal(result.rows[0].text, undefined);
  assert.equal(result.storedByCompanion, false);
});

function tabApi({ failMove = false } = {}) {
  const tab = { id: 4, url: 'https://read.test/form', title: 'Form', windowId: 1, index: 1, pinned: false, mutedInfo: { muted: false } };
  const calls = [];
  return { tab, calls, api: { windows: { get: async id => { if (id !== 2) throw Error('No such window'); return { id }; } }, tabs: {
    get: async () => ({ ...tab }),
    update: async (id, props) => { assert.equal(id, 4); calls.push('update'); if (props.pinned !== undefined) tab.pinned = props.pinned; if (props.muted !== undefined) tab.mutedInfo = { muted: props.muted }; },
    move: async (id, props) => { assert.equal(id, 4); calls.push('move'); if (failMove) throw Error('Move interrupted'); if (props.windowId !== undefined) tab.windowId = props.windowId; tab.index = props.index < 0 ? 4 : props.index; },
  } } };
}
test('tab configuration moves the owned ID and verifies the destination without navigation', async () => {
  const fixture = tabApi(); const result = await configureTaskTab(fixture.api, { tabId: 4, pinned: true, muted: true, destinationWindowId: 2, index: -1 });
  assert.equal(result.windowId, 2); assert.equal(result.url, 'https://read.test/form');
  assert.equal(result.indexReadback, 4); assert.equal(result.pinned, true); assert.deepEqual(fixture.calls, ['update', 'move']);
});
test('invalid destination fails before changes, and a partial move failure never repeats the update', async () => {
  const invalid = tabApi(); await assert.rejects(configureTaskTab(invalid.api, { tabId: 4, pinned: true, destinationWindowId: 9 })); assert.equal(invalid.calls.length, 0);
  const partial = tabApi({ failMove: true });
  await assert.rejects(configureTaskTab(partial.api, { tabId: 4, pinned: true, destinationWindowId: 2 }), e => e.details.operationEffectState === 'unknown' && e.details.applied[0] === 'update');
  assert.deepEqual(partial.calls, ['update', 'move']);
});
test('existing bookmarks are returned without duplicate creation and new writes require exact readback', async () => {
  let existing = [{ id: '11', url: 'https://read.test/form', title: 'Saved', parentId: '1' }], writes = 0, failRead = false;
  const api = { permissions: { contains: async () => true }, tabs: { get: async () => ({ id: 4, url: 'https://read.test/form', title: 'Form' }) }, bookmarks: {
    search: async () => existing, create: async props => { writes++; return { ...props, id: '12', parentId: '1' }; },
    get: async id => { if (failRead) throw Error('Read unavailable'); return [{ id, url: 'https://read.test/form', title: 'Form', parentId: '1' }]; },
  } };
  assert.equal((await bookmarkTaskPage(api, { tabId: 4 })).created, false); assert.equal(writes, 0);
  existing = []; assert.equal((await bookmarkTaskPage(api, { tabId: 4 })).created, true); assert.equal(writes, 1);
  failRead = true; await assert.rejects(bookmarkTaskPage(api, { tabId: 4 }), e => e.code === 'bookmark_result_unknown' && e.details.bookmarkId === '12' && e.details.retryWrite === false); assert.equal(writes, 2);
});
