const STORAGE_KEY = 'companionUserControlsV1';
const CLEANUP_METHODS = new Set(['tabs.close', 'extension.reload']);
function blocked(code, message) {
  return Object.assign(new Error(message), { code, details: { operationEffectState: 'none', mutationDispatchAttempted: false,
    nextAction: 'Use the Companion panel to resume or allow this site; keep the current page and readback' } });
}
function originOf(value) { try { const url = new URL(value); return ['http:', 'https:'].includes(url.protocol) ? url.origin : null; } catch { return null; } }

export function createUserControls(api) {
  let paused = false, blockedOrigins = new Set(), recent = [], saveQueue = Promise.resolve();
  const ready = api.storage.local.get(STORAGE_KEY).then(saved => {
    paused = saved[STORAGE_KEY]?.paused === true;
    blockedOrigins = new Set((saved[STORAGE_KEY]?.blockedOrigins ?? []).map(originOf).filter(Boolean));
  });
  const state = () => ({ paused, blockedOrigins: [...blockedOrigins], recentOperations: recent.slice().reverse(),
    dataRetention: 'Controls are stored in this profile. Recent operation labels are held in memory, at most 32; page text and clipboard content are not stored here.' });
  const persist = () => {
    const value = { paused, blockedOrigins: [...blockedOrigins] };
    saveQueue = saveQueue.catch(() => {}).then(() => api.storage.local.set({ [STORAGE_KEY]: value }));
    return saveQueue;
  };
  async function beforeCommand(method, params) {
    await ready;
    if (method === 'page.configureViewport' && params.action === 'restore') return;
    if (paused && params.mutation && !CLEANUP_METHODS.has(method)) throw blocked('companion_user_paused', 'Companion page actions are paused by the user; reads and cleanup remain available');
    if (blockedOrigins.size && !CLEANUP_METHODS.has(method)) {
      const urls = [params.url, params.targetOrigin];
      if (Number.isSafeInteger(params.tabId)) urls.push((await api.tabs.get(params.tabId)).url);
      if (urls.some(url => blockedOrigins.has(originOf(url)))) throw blocked('companion_site_blocked', 'The user blocked Companion access to this site');
    }
  }
  function observe(method, params, phase, error) {
    if (!params.operationId) return;
    const entry = recent.find(item => item.operationId === params.operationId) ?? {
      operationId: params.operationId, taskId: params.taskId ?? null, taskLabel: String(params.taskLabel ?? '').slice(0, 128),
      tabId: Number.isSafeInteger(params.tabId) ? params.tabId : null, method, startedAt: new Date().toISOString() };
    entry.phase = phase;
    entry.errorCode = error?.code ?? null;
    if (phase !== 'running') entry.finishedAt = new Date().toISOString();
    if (!recent.includes(entry)) recent.push(entry);
    recent = recent.slice(-32);
  }
  async function handle(message, sender) {
    const panelUrl = `chrome-extension://${api.runtime.id}/sidepanel.html`;
    const popupUrl = `chrome-extension://${api.runtime.id}/popup.html`;
    if (sender?.id !== api.runtime.id || (sender?.tab && sender.url !== panelUrl && sender.url !== popupUrl)) {
      throw blocked('companion_controls_sender_invalid', 'Only the Companion panel can change these controls');
    }
    await ready;
    if (message.kind === 'controls.get') return state();
    if (message.kind === 'controls.pause') { paused = message.paused === true; await persist(); return state(); }
    if (message.kind === 'controls.site') {
      const origin = originOf(message.origin);
      if (!origin) throw blocked('companion_controls_origin_invalid', 'Select an HTTP or HTTPS site');
      message.blocked === true ? blockedOrigins.add(origin) : blockedOrigins.delete(origin);
      await persist(); return state();
    }
    if (message.kind === 'controls.clearRecent') { recent = []; return state(); }
    if (message.kind === 'controls.context') {
      const tabs = await api.tabs.query({ active: true, currentWindow: true });
      const tab = tabs[0];
      if (!tab || !originOf(tab.url)) throw blocked('companion_context_page_unavailable', 'Open a web page before reading its selection');
      if (blockedOrigins.has(originOf(tab.url))) throw blocked('companion_site_blocked', 'Allow this site in the panel before reading its selection');
      const results = await api.scripting.executeScript({ target: { tabId: tab.id }, world: 'ISOLATED',
        func: () => ({ url: location.href, title: document.title, selectedText: String(getSelection() ?? '').slice(0, 4000) }) });
      const result = results[0]?.result;
      const current = await api.tabs.get(tab.id);
      if (!result || current.url !== result.url) throw blocked('companion_context_page_changed', 'The page changed while its selection was read; select it again');
      return { tabId: tab.id, ...result, origin: originOf(result.url), snapshotOnly: true };
    }
    if (message.kind === 'controls.activeSite') {
      const tabs = await api.tabs.query({ active: true, currentWindow: true });
      return { origin: originOf(tabs[0]?.url), tabId: tabs[0]?.id ?? null };
    }
    throw blocked('companion_controls_method_invalid', 'Unknown panel action');
  }
  return { beforeCommand, observe, handle, state };
}
