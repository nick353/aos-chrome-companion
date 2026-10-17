import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import vm from 'node:vm';
// A background tab of a site that draws from animation frames reads blank (X, Etsy, TikTok;
// owner, 2026-10-17). The read brings that tab forward, reads again, and gives the window back.
const source = await readFile(new URL('../extension/service-worker.js', import.meta.url), 'utf8');
const helper = source.slice(source.indexOf('const BLANK_PAGE_TEXT_CHARS'), source.indexOf('// Custom virtual lists render'));
const full = 'x'.repeat(500);
function fixture({ alreadyActive = false, drawsWhenActive = true, interrupt = false, field = 'text' } = {}) {
  let active = alreadyActive ? 2 : 1;
  const changes = [], listeners = new Set();
  const chrome = { tabs: {
    get: async () => ({ id: 2, windowId: 8, active: active === 2 }),
    query: async () => [{ id: active }],
    update: async (id) => { active = id; changes.push(id); for (const fn of listeners) fn({ windowId: 8, tabId: id }); },
    onActivated: { addListener: fn => listeners.add(fn), removeListener: fn => listeners.delete(fn) },
  } };
  let reads = 0;
  const read = async () => {
    reads++;
    if (interrupt && reads === 2) await chrome.tabs.update(3);
    const text = active === 2 && drawsWhenActive || interrupt && reads > 1 ? full : '';
    return { url: 'https://x.com/home', [field]: text };
  };
  const run = vm.runInNewContext(helper + '\nreadRenderedInForeground', { chrome, Number, Promise, String, setTimeout });
  return { run: () => run(2, read), changes, reads: () => reads, listeners };
}
test('a blank background read is read again in front and the window gets its tab back', async () => {
  const f = fixture(); const result = await f.run();
  assert.equal(result.text, full); assert.equal(result.renderedInForeground, true);
  assert.deepEqual(f.changes, [2, 1]); assert.equal(f.listeners.size, 0);
});
test('a page with text is read once without touching the tabs', async () => {
  const f = fixture({ alreadyActive: true, drawsWhenActive: true }); await f.run();
  assert.deepEqual(f.changes, []); assert.equal(f.reads(), 1);
});
test('an exported text that stays blank is returned after the wait, and the tab is restored', async () => {
  const f = fixture({ drawsWhenActive: false, field: 'content' }); const result = await f.run();
  assert.equal(result.content, ''); assert.equal(result.renderedInForeground, true);
  assert.deepEqual(f.changes, [2, 1]);
});
test('a user switching tabs meanwhile keeps their choice', async () => {
  const f = fixture({ interrupt: true }); await f.run();
  assert.deepEqual(f.changes, [2, 3]);
});
