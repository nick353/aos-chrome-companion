import test from 'node:test';
import assert from 'node:assert/strict';
import { createRecordingWindows, recordingWindowBounds } from '../extension/recording-window.js';

// A small Chrome stand-in: windows and tabs, the events the controller listens to, and a record of
// every move so a test can see where tabs went.
function fakeChrome({ originalWindow = { id: 1, left: 0, top: 25, width: 1280, height: 875 } } = {}) {
  const listeners = {};
  const on = name => ({ addListener: fn => { (listeners[name] ??= []).push(fn); } });
  const emit = (name, ...args) => (listeners[name] ?? []).forEach(fn => fn(...args));
  const windows = new Map([[originalWindow.id, { ...originalWindow, type: 'normal' }]]);
  const tabs = new Map([
    [10, { id: 10, windowId: 1, index: 3, url: 'https://www.tiktok.com/@a/video/1', audible: false, mutedInfo: { muted: true } }],
    [11, { id: 11, windowId: 1, index: 4, url: 'https://mail.google.com/', audible: false, mutedInfo: { muted: false } }],
  ]);
  let nextWindow = 50;
  let lastFocused = 1;
  const moves = [];
  const api = {
    storage: { session: { set: async () => {}, get: async () => ({}), remove: async () => {} } },
    windows: {
      get: async id => { if (!windows.has(id)) throw new Error('no window'); return { ...windows.get(id) }; },
      getAll: async () => [...windows.values()].map(w => ({ ...w })),
      getLastFocused: async () => ({ id: lastFocused }),
      create: async ({ tabId, left, top, width, height }) => {
        const id = nextWindow++;
        windows.set(id, { id, left, top, width, height, type: 'normal' });
        const tab = tabs.get(tabId);
        emit('tabs.onDetached', tabId, { oldWindowId: tab.windowId });
        tab.windowId = id; tab.index = 0; tab.width = width; tab.height = height - 90;
        emit('tabs.onAttached', tabId, { newWindowId: id });
        return { id };
      },
      onRemoved: on('windows.onRemoved'),
    },
    tabs: {
      get: async id => { if (!tabs.has(id)) throw new Error('no tab'); return { ...tabs.get(id) }; },
      update: async (id, change) => {
        const tab = tabs.get(id);
        if (change.muted !== undefined) tab.mutedInfo = { muted: change.muted };
        return { ...tab };
      },
      move: async (id, { windowId, index }) => { moves.push([id, windowId, index]); const tab = tabs.get(id); tab.windowId = windowId; tab.index = index; return { ...tab }; },
      onCreated: on('tabs.onCreated'), onAttached: on('tabs.onAttached'), onActivated: on('tabs.onActivated'),
      onDetached: on('tabs.onDetached'), onRemoved: on('tabs.onRemoved'), onUpdated: on('tabs.onUpdated'),
    },
  };
  return { api, emit, tabs, windows, moves, focus: id => { lastFocused = id; } };
}

function controller(chrome, clock = { t: 0 }) {
  const recording = createRecordingWindows(chrome.api, { now: () => clock.t, sleep: async ms => { clock.t += ms; } });
  recording.attach(chrome.api);
  return recording;
}

test('the recording window covers the left of the task window, stays narrower, and never matches another window', () => {
  const original = { left: 0, top: 25, width: 1280, height: 875 };
  assert.deepEqual(recordingWindowBounds(original), { left: 0, top: 25, width: 599, height: 875 });
  assert.deepEqual(recordingWindowBounds({ ...original, width: 600 }, [], 600), { left: 0, top: 25, width: 499, height: 875 });
  assert.deepEqual(recordingWindowBounds({ ...original, width: 400 }), { left: 0, top: 25, width: 399, height: 875 });
  assert.deepEqual(recordingWindowBounds(original, [{ left: 0, top: 25, width: 599, height: 875 }]), { left: 0, top: 25, width: 597, height: 875 });
});

test('a recorded tab moves alone into its window, unmuted, and other windows cannot come over it', async () => {
  const chrome = fakeChrome();
  const recording = controller(chrome);
  const opened = await recording.isolate({ tabId: 10, width: 600, maxSeconds: 60, allowedOrigins: ['https://www.tiktok.com'] });
  assert.equal(opened.recordingWindow, true);
  assert.equal(opened.windowId, 50);
  assert.deepEqual(opened.bounds, { left: 0, top: 25, width: 599, height: 875 });
  assert.deepEqual(opened.viewport, { width: 599, height: 785 });
  assert.equal(chrome.tabs.get(10).mutedInfo.muted, false);
  assert.deepEqual(recording.status().taints, [], 'moving the tab in is not another page getting in');
  assert.equal(recording.focusAllowed(1), false);
  assert.equal(recording.focusAllowed(50), true);
  assert.deepEqual(await recording.windowForNewTab(), {});
  chrome.focus(50);
  assert.deepEqual(await recording.windowForNewTab(), { windowId: 1 });
  await assert.rejects(recording.isolate({ tabId: 11 }), { code: 'recording_window_busy' });
});

test('anything that puts another page into the recording window is written down, and stray tabs are moved out', async () => {
  const chrome = fakeChrome();
  const recording = controller(chrome);
  await recording.isolate({ tabId: 10, allowedOrigins: ['https://www.tiktok.com'] });
  chrome.emit('tabs.onCreated', { id: 99, windowId: 50 });
  chrome.emit('tabs.onActivated', { tabId: 99, windowId: 50 });
  chrome.emit('tabs.onActivated', { tabId: 11, windowId: 1 });
  chrome.emit('tabs.onUpdated', 10, { url: 'https://www.tiktok.com/@a/video/2' });
  chrome.emit('tabs.onUpdated', 10, { url: 'https://accounts.google.com/' });
  await new Promise(resolve => setImmediate(resolve));
  assert.deepEqual(recording.status().taints.map(item => item.reason),
    ['other_tab_opened_in_recording_window', 'other_tab_shown_in_recording_window', 'recording_tab_left_allowed_sites']);
  assert.deepEqual(chrome.moves, [[99, 1, -1]]);
});

test('ending moves the tab back to its place and returns what got in; afterwards windows focus freely', async () => {
  const chrome = fakeChrome();
  const recording = controller(chrome);
  await recording.isolate({ tabId: 10 });
  chrome.emit('tabs.onActivated', { tabId: 77, windowId: 50 });
  const ended = await recording.end(10);
  assert.equal(ended.recordingWindowEnded, true);
  assert.equal(ended.movedBack, true);
  assert.equal(ended.windowId, 1);
  assert.deepEqual(ended.taints.map(item => item.reason), ['other_tab_shown_in_recording_window']);
  assert.deepEqual(chrome.moves.at(-1), [10, 1, 3]);
  assert.equal(recording.focusAllowed(1), true);
  assert.equal((await recording.end(10)).reason, 'not_open');
});

test('a closed recorded tab ends the watch at once, and a forgotten window ends at its deadline', async () => {
  const chrome = fakeChrome();
  const clock = { t: 0 };
  const recording = controller(chrome, clock);
  await recording.isolate({ tabId: 10 });
  chrome.emit('tabs.onRemoved', 10);
  assert.equal(recording.status(), null);
  assert.equal(recording.focusAllowed(1), true);

  await recording.isolate({ tabId: 11, maxSeconds: 10 });
  assert.equal(recording.focusAllowed(1), false);
  clock.t += (10 + 181) * 1000;
  assert.equal(recording.focusAllowed(1), true);
});

test('media starts only in the recording window and waits for Chrome to hear it', async () => {
  const chrome = fakeChrome();
  const recording = controller(chrome);
  await recording.isolate({ tabId: 10 });
  let played = 0;
  const result = await recording.startMedia(10, async () => {
    played += 1;
    chrome.tabs.get(10).audible = true;
    return { found: true, paused: false, muted: false, durationSeconds: 21.4 };
  });
  assert.equal(played, 1);
  assert.equal(result.audible, true);
  assert.equal(result.media.durationSeconds, 21.4);
  await assert.rejects(recording.startMedia(11, async () => ({})), { code: 'recording_window_not_open' });
});

// The media step is a click through the debugger and a fixed page step; the extension still
// evaluates no script text (p3-capabilities.test.mjs).
test('the media step clicks the video through the debugger and evaluates no script', async () => {
  const { readFile } = await import('node:fs/promises');
  const source = await readFile(new URL('../extension/service-worker.js', import.meta.url), 'utf8');
  const step = source.slice(source.indexOf('async function startRecordingMedia('), source.indexOf('async function sendDebuggerCommand('));
  assert.match(step, /Input\.dispatchMouseEvent/);
  assert.match(step, /"recordingMedia", \{ phase: "locate" \}/);
  assert.match(step, /"recordingMedia", \{ phase: "play" \}/);
  assert.doesNotMatch(source, /Runtime\.evaluate/);
  assert.match(source, /if \(action === "recordingMedia"\)/);
});
