// A recording window holds the one tab being recorded, so other tasks' tabs never appear in a
// recording (owner, 2026-10-19: a 48 s test recording showed Green and Pasona pages for a moment,
// because another task switched tabs in the same window to take its screenshots). While a recording
// window exists, other windows are not brought in front of it and new tabs do not open in it, and
// anything that would put another page in the recording is written down so the recording is never
// sent for analysis (owner, 2026-10-19:「この録画をしているときはタブが奪われないようにしたらいい」).

const STORAGE_KEY = 'companion.recordingWindow.v1';
const DEFAULT_WIDTH = 600;
const MIN_WIDTH = 360;
// Leave part of the original window uncovered: Chrome stops drawing a window that is fully hidden,
// and the other tasks keep working in it while the recording runs.
const KEEP_VISIBLE = 100;
const GRACE_SECONDS = 180;

function error(code, message, details = {}) {
  return Object.assign(new Error(message), { code, details: { mutationDispatchAttempted: false, operationEffectState: 'none', ...details } });
}

const sameBounds = (a, b) => ['left', 'top', 'width', 'height'].every(key => a?.[key] === b?.[key]);

// Where the recording window goes: over the left part of the task's own window, same top and
// height, narrower so the original window stays partly visible, and never exactly the size of
// another window (the recorder finds the window by its position and size).
export function recordingWindowBounds(original, others = [], requestedWidth = DEFAULT_WIDTH) {
  const height = original.height;
  const room = original.width - KEEP_VISIBLE;
  let width = room >= MIN_WIDTH ? Math.max(MIN_WIDTH, Math.min(requestedWidth, room)) : original.width;
  if (width % 2 === 0) width -= 1;
  const bounds = { left: original.left, top: original.top, width, height };
  while ([original, ...others].some(other => sameBounds(other, bounds))) bounds.width -= 2;
  return bounds;
}

export function createRecordingWindows(api, { now = () => Date.now(), sleep = ms => new Promise(resolve => setTimeout(resolve, ms)) } = {}) {
  let state = null;

  const save = () => api.storage?.session?.set?.({ [STORAGE_KEY]: state }).catch?.(() => {});
  const taint = (reason, detail = {}) => {
    if (!state || state.taints.some(item => item.reason === reason)) return;
    state.taints.push({ reason, at: new Date(now()).toISOString(), ...detail });
    void save();
  };
  const expired = () => state && now() > state.deadline;

  async function restore() {
    try {
      const stored = (await api.storage?.session?.get?.(STORAGE_KEY))?.[STORAGE_KEY];
      if (stored && Number.isSafeInteger(stored.windowId) && !state) state = stored;
    } catch { /* nothing to restore */ }
  }

  function active() {
    if (expired()) void end(state.tabId, { reason: 'deadline' });
    return state;
  }

  // Other tasks still switch tabs inside their own window; only bringing another window in front
  // of the recording window is held back while it records.
  function focusAllowed(windowId) {
    const current = active();
    return !current || windowId === current.windowId;
  }

  async function windowForNewTab() {
    const current = active();
    if (!current) return {};
    try {
      const focused = await api.windows.getLastFocused();
      if (focused?.id === current.windowId) return { windowId: current.originalWindowId };
    } catch { /* fall back to Chrome's choice; the listener below still moves a stray tab out */ }
    return {};
  }

  async function readViewport(tabId) {
    for (let waited = 0; waited <= 2000; waited += 250) {
      const tab = await api.tabs.get(tabId);
      if (tab.width > 0 && tab.height > 0) return { tab, viewport: { width: tab.width, height: tab.height } };
      await sleep(250);
    }
    const tab = await api.tabs.get(tabId);
    return { tab, viewport: null };
  }

  async function isolate({ tabId, width, maxSeconds = 600, allowedOrigins = [] }) {
    if (active()) {
      if (state.tabId === tabId) throw error('recording_window_already_open', 'This tab is already in a recording window', { windowId: state.windowId });
      throw error('recording_window_busy', 'Another recording window is open; try again after it finishes', { windowId: state.windowId });
    }
    const before = await api.tabs.get(tabId);
    const original = await api.windows.get(before.windowId);
    const others = (await api.windows.getAll({ windowTypes: ['normal'] })).filter(window => window.id !== original.id);
    const bounds = recordingWindowBounds(original, others, width ?? DEFAULT_WIDTH);
    let created;
    try {
      created = await api.windows.create({ tabId, focused: false, type: 'normal', ...bounds });
    } catch (failure) {
      throw error('recording_window_create_failed', 'Chrome could not open the recording window', { message: String(failure?.message || failure).slice(0, 300) });
    }
    state = { tabId, windowId: created.id, originalWindowId: original.id, originalIndex: before.index,
      allowedOrigins: allowedOrigins.filter(value => typeof value === 'string'),
      startedAt: new Date(now()).toISOString(), deadline: now() + (maxSeconds + GRACE_SECONDS) * 1000, taints: [] };
    await save();
    try {
      if (before.mutedInfo?.muted) await api.tabs.update(tabId, { muted: false });
      await api.tabs.update(tabId, { active: true });
    } catch { /* the readback below reports the state */ }
    // Chrome opens an unfocused window behind the task's window, where it is fully hidden and Chrome
    // stops drawing it (2026-10-19: a playing video was recorded as one still picture). Raise it.
    let raised = false;
    try { await api.windows.update(created.id, { focused: true }); raised = true; } catch { /* reported as raised: false */ }
    const placed = await api.windows.get(created.id);
    const { tab, viewport } = await readViewport(tabId);
    if (tab.windowId !== created.id) taint('recording_tab_left_window');
    return { configured: true, recordingWindow: true, raised, tabId, windowId: created.id, previousWindowId: original.id,
      bounds: { left: placed.left, top: placed.top, width: placed.width, height: placed.height }, viewport,
      audible: tab.audible === true, muted: tab.mutedInfo?.muted === true, url: tab.url };
  }

  // play: the service worker's trusted click on the video, then the fixed page step that plays it
  // with sound from its start.
  async function startMedia(tabId, play) {
    if (!active() || state.tabId !== tabId) throw error('recording_window_not_open', 'Start media only in this tab\'s recording window');
    const media = await play();
    let tab = await api.tabs.get(tabId);
    for (let waited = 0; !tab.audible && waited < 2000; waited += 250) { await sleep(250); tab = await api.tabs.get(tabId); }
    return { configured: true, recordingMedia: true, tabId, windowId: tab.windowId, audible: tab.audible === true, media };
  }

  async function end(tabId, { reason = 'requested' } = {}) {
    if (!state || state.tabId !== tabId) return { configured: true, recordingWindowEnded: false, tabId, reason: 'not_open' };
    const ending = state;
    state = null;
    await api.storage?.session?.remove?.(STORAGE_KEY)?.catch?.(() => {});
    let windowId = null;
    let movedBack = false;
    try {
      await api.windows.get(ending.originalWindowId);
      await api.tabs.move(tabId, { windowId: ending.originalWindowId, index: ending.originalIndex });
      movedBack = true;
    } catch { /* the original window is gone: the tab stays where it is */ }
    try { windowId = (await api.tabs.get(tabId)).windowId; } catch { /* the tab was closed */ }
    return { configured: true, recordingWindowEnded: true, tabId, windowId, previousWindowId: ending.windowId,
      movedBack, endedBy: reason, startedAt: ending.startedAt, taints: ending.taints };
  }

  // Everything that would put another page into the recording, written down as it happens.
  function attach(events = api) {
    events.tabs.onCreated?.addListener(tab => {
      if (!active() || tab.windowId !== state.windowId || tab.id === state.tabId) return;
      taint('other_tab_opened_in_recording_window');
      void api.tabs.move(tab.id, { windowId: state.originalWindowId, index: -1 }).catch(() => {});
    });
    events.tabs.onAttached?.addListener((tabId, info) => {
      if (!active() || info.newWindowId !== state.windowId || tabId === state.tabId) return;
      taint('other_tab_moved_into_recording_window');
      void api.tabs.move(tabId, { windowId: state.originalWindowId, index: -1 }).catch(() => {});
    });
    events.tabs.onActivated?.addListener(info => {
      if (active() && info.windowId === state.windowId && info.tabId !== state.tabId) taint('other_tab_shown_in_recording_window');
    });
    // Moving the tab into the recording window also detaches it from its first window; only leaving
    // the recording window counts.
    events.tabs.onDetached?.addListener((tabId, info) => {
      if (active() && tabId === state.tabId && info?.oldWindowId === state.windowId) taint('recording_tab_left_window');
    });
    // Nothing is left to protect once the recorded tab or its window is gone; the recording stays
    // blocked from analysis because its end can no longer be checked.
    const forget = reason => { taint(reason); state = null; void api.storage?.session?.remove?.(STORAGE_KEY)?.catch?.(() => {}); };
    events.tabs.onRemoved?.addListener(tabId => { if (active() && tabId === state.tabId) forget('recording_tab_closed'); });
    events.tabs.onUpdated?.addListener((tabId, change) => {
      if (!active() || tabId !== state.tabId || !change.url) return;
      let origin = null;
      try { origin = new URL(change.url).origin; } catch { /* not a web page */ }
      if (!origin || (state.allowedOrigins.length && !state.allowedOrigins.includes(origin))) taint('recording_tab_left_allowed_sites', { origin });
    });
    events.windows.onRemoved?.addListener(windowId => { if (active() && windowId === state.windowId) forget('recording_window_closed'); });
  }

  return { restore, isolate, startMedia, end, focusAllowed, windowForNewTab, attach, status: () => (state ? { ...state, taints: [...state.taints] } : null) };
}
