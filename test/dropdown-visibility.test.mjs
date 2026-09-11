import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import vm from 'node:vm';
const source = await readFile(new URL('../extension/service-worker.js', import.meta.url), 'utf8');
const helper = source.slice(source.indexOf('async function runVisibleDropdownSelection('), source.indexOf('async function runAndCheckMutation('));
function fixture({ alreadyActive = false, fail = false, interrupt = false, navigate = false } = {}) {
  let active = alreadyActive ? 2 : 1;
  const changes = [], listeners = new Set(), updates = new Set();
  const chrome = { tabs: {
    get: async () => ({ id: 2, windowId: 8, url: navigate && changes.length ? 'https://other.example/' : 'https://fixture.example/', status: 'complete' }),
    query: async () => [{ id: active }],
    update: async (id) => { active = id; changes.push(id); for (const fn of listeners) fn({ windowId: 8, tabId: id }); },
    onActivated: { addListener: fn => listeners.add(fn), removeListener: fn => listeners.delete(fn) },
    onUpdated: { addListener: fn => updates.add(fn), removeListener: fn => updates.delete(fn) },
  } };
  let calls = 0;
  const run = vm.runInNewContext(helper + '\nrunVisibleDropdownSelection', {
    chrome, Number, Promise, assertLiveOrigin: async () => {},
    companionError: (code, message, details) => Object.assign(Error(message), { code, details }),
    runAndCheckMutation: async (id, action, payload) => {
      calls++; assert.equal(active, 2); assert.equal(payload.requireVisible, true);
      if (interrupt) { await chrome.tabs.update(3); await chrome.tabs.update(2); }
      if (fail) throw Error('selection failed');
      return { selectionCommitted: true };
    },
  });
  return { run: () => run(2, {}, {}), changes, calls: () => calls, listeners, updates };
}
test('custom selection activates target once and restores prior tab', async () => {
  const f = fixture(); assert.equal((await f.run()).selectionCommitted, true);
  assert.deepEqual(f.changes, [2, 1]); assert.equal(f.calls(), 1); assert.equal(f.listeners.size + f.updates.size, 0);
});
test('selection failure restores prior tab without replay', async () => {
  const f = fixture({ fail: true }); await assert.rejects(f.run(), /selection failed/);
  assert.deepEqual(f.changes, [2, 1]); assert.equal(f.calls(), 1);
});
test('intervening switch away and back is preserved', async () => {
  const f = fixture({ interrupt: true }); await f.run(); assert.deepEqual(f.changes, [2, 3, 2]);
});
test('already visible target requires no activation', async () => {
  const f = fixture({ alreadyActive: true }); await f.run(); assert.deepEqual(f.changes, []);
});
test('navigation before dispatch prevents selection', async () => {
  const f = fixture({ navigate: true }); await assert.rejects(f.run(), error => error.code === 'dropdown_selection_target_changed');
  assert.equal(f.calls(), 0);
});

test('selection shares the foreground lane with captures and tab activation', async () => {
  const { operationSchemaDocument } = await import('../src/shared/operation-schema.mjs');
  const methods = operationSchemaDocument().methods;
  for (const method of ['page.selectOption', 'page.screenshot', 'tabs.activate']) {
    assert.equal(methods.find(entry => entry.method === method).profileGlobal, true);
  }
});
