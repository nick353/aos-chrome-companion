import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import vm from 'node:vm';
import { toolResult, taskStatus } from '../src/mcp/result.mjs';
import { transactionActionSchema } from '../src/mcp/action-schema.mjs';
import * as z from 'zod/v4';
import { createUserControls } from '../extension/user-controls.js';
import { executeWithExpectedDialog } from '../extension/action-event-wait.js';
import { NativeCommandAssembler } from '../extension/native-command-transfer.js';
import { MUTATION_METHODS } from '../extension/operation-schema.generated.js';

const source = await readFile(new URL('../extension/service-worker.js', import.meta.url), 'utf8');
function trustedKeyFixture(platform = 'mac', { platformError = false, fallbackPlatform = '' } = {}) {
  const commands = [];
  let releases = 0;
  const context = {
    navigator: { platform: fallbackPlatform },
    companionError: (code, message, details) => Object.assign(new Error(message), { code, details }),
    requireTrustedDebuggerAccess: async () => {}, requireVisualPoint: point => point,
    withTimeout: async value => await value, runPageOperation: async () => ({}),
    sendDebuggerCommand: async (target, method, params) => { commands.push({ target, method, params }); },
    debuggerSessions: { acquire: async () => ({ release: async () => { releases++; } }) },
    chrome: {
      runtime: { getPlatformInfo: async () => { if (platformError) throw new Error('probe failed'); return { os: platform }; } },
      tabs: { get: async id => ({ id, windowId: 1 }), query: async () => [{ id: 101, windowId: 1 }], update: async () => ({}) },
      windows: { update: async () => ({}) },
    },
  };
  vm.createContext(context);
  const start = source.indexOf('function visualButton(');
  const end = source.indexOf('function sameVisualTargetState(', start);
  vm.runInContext(source.slice(start, end), context);
  return { context, commands, get releases() { return releases; }, run: (params, method = 'visual.pressKey') => context.runTrustedVisualInput(101, method, { point: { x: 10, y: 20 }, ...params }) };
}

test('native dispatcher honors persisted user pause and blocked origin before any trusted shortcut dispatch', async () => {
  for (const [saved, code] of [
    [{ paused: true, blockedOrigins: [] }, 'companion_user_paused'],
    [{ paused: false, blockedOrigins: ['https://fixture.example'] }, 'companion_site_blocked'],
  ]) {
    const fixture = trustedKeyFixture();
    const errors = [], results = [], context = fixture.context;
    let executions = 0;
    const storage = { companionUserControlsV1: saved };
    context.chrome.runtime.id = 'fixture-extension';
    context.chrome.storage = { local: {
      get: async key => ({ [key]: structuredClone(storage[key]) }),
      set: async value => Object.assign(storage, structuredClone(value)),
    } };
    context.chrome.tabs.get = async id => ({ id, windowId: 1, url: 'https://fixture.example/editor' });
    context.userControls = createUserControls(context.chrome);
    Object.assign(context, { performance, executeWithExpectedDialog, javaScriptDialogs: null,
      runtimeState: { port: {}, generation: 'fixture-generation', profileInstanceId: 'fixture-profile' },
      commandAssembler: new NativeCommandAssembler(), MUTATION_OPERATION_METHODS: new Set(MUTATION_METHODS),
      executeCommand: async (method, params) => { executions++; return context.runTrustedVisualInput(params.tabId, method, params); },
      postNativeMessage: message => results.push(message),
      sendCommandError: (id, errorCode, message, details) => errors.push({ id, code: errorCode, message, details }),
    });
    vm.runInContext(source.slice(source.indexOf('async function handleNativeMessage('), source.indexOf('\nfunction sendCommandError(')), context);
    const request = { kind: 'command.request', operationId: 'blocked-shortcut', profileInstanceId: 'fixture-profile',
      generation: 'fixture-generation', targetOrigin: 'https://fixture.example', allowedOrigins: ['https://fixture.example'],
      method: 'visual.pressKey', params: { tabId: 101, point: { x: 10, y: 20 }, key: 'v', modifiers: ['meta'], allowShortcut: true, clickBeforeKey: false } };
    await context.handleNativeMessage(request);
    assert.equal(errors.length, 1);
    assert.equal(errors[0].code, code);
    assert.deepEqual(errors[0].details, { operationEffectState: 'none', mutationDispatchAttempted: false,
      nextAction: 'Use the Companion panel to resume or allow this site; keep the current page and readback' });
    assert.equal(executions, 0);
    assert.equal(fixture.commands.length, 0);
    assert.equal(fixture.releases, 0);
    assert.equal(results.length, 0);
    await context.userControls.handle(saved.paused ? { kind: 'controls.pause', paused: false }
      : { kind: 'controls.site', origin: 'https://fixture.example', blocked: false }, { id: context.chrome.runtime.id });
    await context.handleNativeMessage({ ...request, operationId: 'resumed-shortcut' });
    assert.equal(executions, 1);
    assert.equal(errors.length, 1);
    assert.equal(results.length, 1);
    assert.equal(fixture.commands.length, 2);
    assert.equal(fixture.releases, 1);
    assert.deepEqual(Array.from(fixture.commands[0].params.commands), ['paste']);
    assert.equal(fixture.commands[1].params.commands, undefined);
  }
});

test('trusted key events carry code and virtual key metadata for the bounded key set', async () => {
  for (const [key, code, virtualKey, eventKey] of [
    ['c', 'KeyC', 67, 'c'], ['C', 'KeyC', 67, 'C'], ['7', 'Digit7', 55, '7'],
    ['Enter', 'Enter', 13, 'Enter'], ['Space', 'Space', 32, ' '],
    ['ArrowLeft', 'ArrowLeft', 37, 'ArrowLeft'], ['F12', 'F12', 123, 'F12'],
  ]) {
    const fixture = trustedKeyFixture();
    await fixture.run({ key, clickBeforeKey: false });
    const events = fixture.commands.filter(command => command.method === 'Input.dispatchKeyEvent').map(command => JSON.parse(JSON.stringify(command.params)));
    assert.deepEqual(events, ['keyDown', 'keyUp'].map(type => ({ type, key: eventKey, code, windowsVirtualKeyCode: virtualKey, modifiers: 0 })));
    assert.equal(fixture.releases, 1);
  }
});

test('trusted shortcuts dispatch only exact platform copy cut paste and selectAll commands on key down', async () => {
  for (const [platform, modifier] of [['mac', 'meta'], ['win', 'ctrl'], ['linux', 'control'], ['cros', 'ctrl']]) {
    for (const [key, command] of [['a', 'selectAll'], ['c', 'copy'], ['x', 'cut'], ['v', 'paste']]) {
      const fixture = trustedKeyFixture(platform);
      await fixture.run({ key, modifiers: [modifier], allowShortcut: true, clickBeforeKey: false });
      assert.equal(fixture.commands.length, 2);
      assert.deepEqual(Array.from(fixture.commands[0].params.commands), [command]);
      assert.equal(fixture.commands[1].params.commands, undefined);
      assert.equal(fixture.commands[0].params.windowsVirtualKeyCode, key.toUpperCase().charCodeAt(0));
    }
  }
  const fallback = trustedKeyFixture('', { platformError: true, fallbackPlatform: 'MacIntel' });
  await fallback.run({ key: 'c', modifiers: ['command'], allowShortcut: true, clickBeforeKey: false });
  assert.deepEqual(Array.from(fallback.commands[0].params.commands), ['copy']);
});

test('shortcut opt-in and exact modifier restrictions precede any click or key dispatch', async () => {
  for (const modifier of ['alt', 'ctrl', 'meta', 'command', 'cmd', 'control']) {
    const fixture = trustedKeyFixture();
    await assert.rejects(fixture.run({ key: 'c', modifiers: [modifier] }), { code: 'visual_modifier_requires_explicit_opt_in' });
    assert.equal(fixture.commands.length, 0);
    assert.equal(fixture.releases, 1);
  }
  for (const [platform, modifiers, key] of [
    ['mac', ['ctrl'], 'c'], ['win', ['meta'], 'c'], ['unknown', ['ctrl'], 'c'],
    ['mac', ['meta', 'shift'], 'c'], ['mac', ['meta', 'alt'], 'c'], ['mac', ['meta', 'ctrl'], 'c'],
    ['mac', [], 'c'], ['mac', ['meta'], 'b'],
  ]) {
    const fixture = trustedKeyFixture(platform);
    await fixture.run({ key, modifiers, allowShortcut: true, clickBeforeKey: false });
    assert.equal(fixture.commands[0].params.commands, undefined);
  }
  for (const key of ['!', 'F13', 'Unidentified']) {
    const fixture = trustedKeyFixture();
    await assert.rejects(fixture.run({ key }), { code: 'visual_key_not_allowed' });
    assert.equal(fixture.commands.length, 0);
  }
  const invalidModifier = trustedKeyFixture();
  await assert.rejects(invalidModifier.run({ key: 'c', modifiers: ['invalid'], allowShortcut: true }), { code: 'visual_modifier_not_allowed' });
  assert.equal(invalidModifier.commands.length, 0);
});

test('pressKey clicks by default while explicit no-click and separate key down/up preserve selection', async () => {
  const defaults = trustedKeyFixture();
  await defaults.run({ key: 'Enter' });
  assert.deepEqual(defaults.commands.map(command => command.method), ['Input.dispatchMouseEvent', 'Input.dispatchMouseEvent', 'Input.dispatchMouseEvent', 'Input.dispatchKeyEvent', 'Input.dispatchKeyEvent']);
  assert.deepEqual(defaults.commands.slice(0, 3).map(command => command.params.type), ['mouseMoved', 'mousePressed', 'mouseReleased']);
  for (const method of ['visual.pressKey', 'visual.keyDown', 'visual.keyUp']) {
    const fixture = trustedKeyFixture();
    await fixture.run({ key: 'v', modifiers: ['cmd'], allowShortcut: true, clickBeforeKey: false }, method);
    assert.equal(fixture.commands.some(command => command.method === 'Input.dispatchMouseEvent'), false);
    assert.equal(fixture.commands.length, method === 'visual.pressKey' ? 2 : 1);
    if (method === 'visual.keyUp') assert.equal(fixture.commands[0].params.commands, undefined);
    else assert.deepEqual(Array.from(fixture.commands[0].params.commands), ['paste']);
  }
});

function screenshotFixture(hooks = {}) {
  let active = hooks.initialActive ?? 101, url = hooks.initialUrl ?? 'https://owned.example/', captures = 0;
  let windowId = 1, status = hooks.initialStatus ?? 'complete';
  let pendingUrl = null, documentId = hooks.documentId === undefined ? 'browser-document-1' : hooks.documentId;
  let readyState = hooks.readyState ?? (status === 'loading' ? 'loading' : 'complete'), documentUrl = null, probes = 0, updates = 0;
  const events = { activated: new Set(), updated: new Set() };
  const event = key => ({ addListener: fn => events[key].add(fn), removeListener: fn => events[key].delete(fn) });
  const api = {
    switchTo(id) { active = id; for (const fn of events.activated) fn({ windowId: 1, tabId: id }); },
    navigate() { url = 'https://owned.example/next'; for (const fn of events.updated) fn(101, { url }); },
    setCurrent(values) {
      if ('active' in values) active = values.active;
      if ('url' in values) url = values.url;
      if ('windowId' in values) windowId = values.windowId;
      if ('status' in values) status = values.status;
      if ('pendingUrl' in values) pendingUrl = values.pendingUrl;
    },
    setDocument(values) {
      if ('documentId' in values) documentId = values.documentId;
      if ('readyState' in values) readyState = values.readyState;
      if ('url' in values) documentUrl = values.url;
    },
    loadingThenComplete() {
      status = 'loading'; for (const fn of events.updated) fn(101, { status });
      status = 'complete'; for (const fn of events.updated) fn(101, { status });
    },
    get captures() { return captures; }, get active() { return active; },
    get listenerCount() { return events.activated.size + events.updated.size; },
    get probes() { return probes; }, get updates() { return updates; },
  };
  const context = { DEFAULT_SCREENSHOT_QUALITY: 60, MAX_SCREENSHOT_BYTES: 1000000, MIN_SCREENSHOT_QUALITY: 20,
    READ_API_TIMEOUT_MS: 10000, DEFAULT_NAVIGATION_TIMEOUT_MS: hooks.navigationTimeoutMs ?? 30000,
    URL, setTimeout, clearTimeout, injectedPageOperation: () => {}, requireTabId: id => id, sanitizeTab: tab => tab,
    companionError: (code,message,details) => Object.assign(new Error(message), {code,details}),
    waitForScreenshotSlot: async () => hooks.wait?.(api),
    chrome: { tabs: {
      onActivated: event('activated'), onUpdated: event('updated'),
      get: async id => ({ id, windowId, url, title: 'Owned', status, pendingUrl }),
      query: async () => [{ id: active, windowId: 1 }], update: async (id, values) => {
        if (values.active) api.switchTo(id);
        if (values.url) { updates++; url = values.url; await hooks.update?.(api); }
        return { id, windowId, url, status };
      },
      captureVisibleTab: async () => { captures++; return await hooks.capture?.(api) ?? 'data:image/jpeg;base64,aGVsbG8='; },
    }, scripting: { executeScript: async request => {
      probes++;
      const replacement = await hooks.probe?.(api, request);
      return replacement ?? [{ frameId: 0, documentId, result: { url: documentUrl ?? url, readyState, pageInstanceId: 'untrusted-page-global' } }];
    } } },
  };
  vm.createContext(context);
  vm.runInContext(source.slice(source.indexOf('function timeoutError('), source.indexOf('const READ_ONLY_PAGE_ACTIONS')), context);
  vm.runInContext(source.slice(source.indexOf('async function executePageScriptWithReadRetry('), source.indexOf('async function waitForScreenshotSlot(')), context);
  vm.runInContext(source.slice(source.indexOf('function requireSafeUrl('), source.indexOf('async function waitForTabSettled(')), context);
  const a = source.indexOf('function screenshotBytes(');
  const b = source.indexOf('\nasync function ', source.indexOf('async function captureExactTabScreenshot(',a)+10);
  vm.runInContext(source.slice(a,b),context);
  const navigateStart = source.indexOf('    case "tabs.navigate": {');
  const navigateEnd = source.indexOf('    case "tabs.back": {', navigateStart);
  vm.runInContext(`async function navigateFixture(params) { switch ('tabs.navigate') { ${source.slice(navigateStart, navigateEnd)} } }`, context);
  return { run: options => context.captureExactTabScreenshot(101, options), api,
    probe: options => context.probeCommittedDocument(101, options),
    waitCommitted: options => context.waitForCommittedTab(101, options),
    navigate: params => context.navigateFixture({ tabId: 101, url: 'https://owned.example/', allowedOrigins: ['https://owned.example'], mutation: true, ...params }),
  };
}
test('capture succeeds only for the unchanged exact target', async () => {
  const f=screenshotFixture();const result=await f.run();assert.equal(result.tabId,101);assert.equal(result.dataBase64,'aGVsbG8=');assert.equal(f.api.captures,1);
});
test('capture rejects a tab switch during the screenshot slot wait before taking an image', async () => {
  const f=screenshotFixture({ wait: api => api.switchTo(202) });
  await assert.rejects(f.run(),{code:'screenshot_target_changed'});assert.equal(f.api.captures,0);assert.equal(f.api.active,202);
});
test('capture rejects a switch away and back during capture', async () => {
  const f=screenshotFixture({ capture: api => { api.switchTo(202);api.switchTo(101); } });
  await assert.rejects(f.run(),{code:'screenshot_target_changed'});
});
test('capture rejects navigation during capture', async () => {
  const f=screenshotFixture({ capture: api => api.navigate() });await assert.rejects(f.run(),{code:'screenshot_target_changed'});
});
test('transient image readback is retried once and only on the unchanged target', async () => {
  const f=screenshotFixture({capture: api => {if(api.captures===1)throw new Error('Failed to capture tab: image readback failed');}});
  await f.run();assert.equal(f.api.captures,2);
  const failing=screenshotFixture({capture:()=>{throw new Error('image readback failed');}});
  await assert.rejects(failing.run(),/image readback failed/);assert.equal(failing.api.captures,2);
});

const noCaptureChangeReasons = {
  activationInterruption: false, activeTabMismatch: false, windowMismatch: false, urlMismatch: false, loading: false,
};
for (const [reason, change] of [
  ['activationInterruption', api => { api.switchTo(202); api.switchTo(101); }],
  ['activeTabMismatch', api => api.setCurrent({ active: 202 })],
  ['windowMismatch', api => api.setCurrent({ windowId: 2 })],
  ['urlMismatch', api => api.setCurrent({ url: 'https://owned.example/changed' })],
  ['loading', api => api.setCurrent({ status: 'loading' })],
]) {
  test(`capture diagnostic isolates ${reason} without conflating other causes`, async () => {
    const f = screenshotFixture({ wait: change });
    await assert.rejects(f.run(), error => {
      assert.equal(error.code, 'screenshot_target_changed');
      assert.deepEqual(JSON.parse(JSON.stringify(error.details.reasons)), { ...noCaptureChangeReasons, [reason]: true });
      assert.equal(error.details.phase, 'after_slot');
      assert.equal(error.details.attempt, 1);
      assert.equal(error.details.targetTabId, 101);
      assert.equal(error.details.currentTabId, 101);
      assert.equal(error.details.targetWindowId, 1);
      assert.equal(error.details.currentWindowId, reason === 'windowMismatch' ? 2 : 1);
      assert.equal(error.details.activeTabId, reason === 'activeTabMismatch' ? 202 : 101);
      assert.equal(error.details.activeWindowId, 1);
      return true;
    });
    assert.equal(f.api.captures, 0);
    assert.equal(f.api.listenerCount, 0);
  });
}
test('capture diagnostic retains simultaneous reasons with bounded redacted output', async () => {
  const sensitiveUrl = `https://owned.example/private?token=${'secret'.repeat(2000)}`;
  const f = screenshotFixture({ initialUrl: sensitiveUrl, capture: api => {
    api.switchTo(202);
    api.setCurrent({ windowId: 2, url: `${sensitiveUrl}&changed=true`, status: 'loading' });
  } });
  await assert.rejects(f.run(), error => {
    assert.deepEqual(JSON.parse(JSON.stringify(error.details.reasons)), Object.fromEntries(Object.keys(noCaptureChangeReasons).map(key => [key, true])));
    assert.equal(error.details.phase, 'after_capture');
    assert.equal(error.details.attempt, 1);
    const output = JSON.stringify({ code: error.code, message: error.message, details: error.details });
    assert.ok(output.length < 800);
    assert.ok(!output.includes('https://'));
    assert.ok(!output.includes('secret'));
    assert.ok(!output.includes('dataBase64'));
    return true;
  });
  assert.equal(f.api.captures, 1);
  assert.equal(f.api.listenerCount, 0);
});
test('capture diagnostic preserves transient document interruption causes', async () => {
  for (const [reason, change] of [
    ['loading', api => api.loadingThenComplete()],
    ['urlMismatch', api => { api.navigate(); api.setCurrent({ url: 'https://owned.example/' }); }],
  ]) {
    const f = screenshotFixture({ capture: change });
    await assert.rejects(f.run(), error => {
      assert.deepEqual(JSON.parse(JSON.stringify(error.details.reasons)), { ...noCaptureChangeReasons, [reason]: true });
      assert.equal(error.details.phase, 'after_capture');
      return true;
    });
  }
});
test('capture diagnostic identifies initial assertion and readback retry guard', async () => {
  const initial = screenshotFixture({ initialStatus: 'loading' });
  await assert.rejects(initial.run(), error => error.code === 'screenshot_target_changed'
    && error.details.phase === 'before_capture' && error.details.attempt === 0 && error.details.reasons.loading);
  assert.equal(initial.api.captures, 0);
  const retry = screenshotFixture({ capture: api => {
    api.setCurrent({ windowId: 2 });
    throw new Error('image readback failed');
  } });
  await assert.rejects(retry.run(), error => error.code === 'screenshot_target_changed'
    && error.details.phase === 'retry_guard' && error.details.attempt === 1 && error.details.reasons.windowMismatch);
  assert.equal(retry.api.captures, 1);
});
test('capture diagnostic attempt counts remain bounded across read retries and quality fallback', async () => {
  const oversized = `data:image/jpeg;base64,${'a'.repeat(140000)}`;
  const f = screenshotFixture({ capture: api => {
    if (api.captures === 1 || api.captures === 3) throw new Error('image readback failed');
    if (api.captures === 4) api.setCurrent({ status: 'loading' });
    return oversized;
  } });
  await assert.rejects(f.run({ maxBytes: 100000 }), error => error.code === 'screenshot_target_changed'
    && error.details.phase === 'after_capture' && error.details.attempt === 4 && error.details.reasons.loading);
  assert.equal(f.api.captures, 4);
});
test('capture diagnostics preserve successful active-tab restoration and listener cleanup', async () => {
  const f = screenshotFixture({ initialActive: 202 });
  const result = await f.run();
  assert.equal(result.restored, true);
  assert.equal(f.api.active, 202);
  assert.equal(f.api.listenerCount, 0);
  assert.equal(result.reasons, undefined);
  assert.equal(result.phase, undefined);
});
test('initial Chrome loading permits a stable interactive browser-owned document capture', async () => {
  const f = screenshotFixture({ initialStatus: 'loading', readyState: 'interactive' });
  const observed = await f.probe({ expectedWindowId: 1, expectedUrl: 'https://owned.example/', allowedOrigins: ['https://owned.example'] });
  assert.equal(observed.documentId, 'browser-document-1');
  assert.equal(observed.readyState, 'interactive');
  assert.equal(observed.url, 'https://owned.example/');
  const result = await f.run();
  assert.equal(result.dataBase64, 'aGVsbG8=');
  assert.equal(f.api.captures, 1);
  assert.equal(f.api.probes, 4); // Explicit probe, initial assertion, slot, and image assertion.
});
for (const [name, hooks, code] of [
  ['DOM loading', { readyState: 'loading' }, 'document_not_ready'],
  ['missing browser identity', { documentId: null }, 'document_identity_unavailable'],
  ['permission failure', { probe: () => { throw Object.assign(new Error('Cannot access page'), { code: 'permission_denied' }); } }, 'permission_denied'],
  ['malformed result', { probe: () => [{}] }, 'document_probe_invalid'],
  // A document swapped during the probe answers nothing: still loading, read again (Gmail, 2026-10-18).
  ['empty answer while the document is replaced', { probe: () => [{ frameId: 0, result: null }] }, 'document_not_ready'],
  ['no answer at all', { probe: () => [] }, 'document_not_ready'],
  ['invalid readyState', { readyState: 'unknown' }, 'document_probe_invalid'],
  ['document URL mismatch', { probe: api => api.setDocument({ url: 'https://owned.example/other' }) }, 'document_target_changed'],
  ['pending redirect', { probe: api => api.setCurrent({ pendingUrl: 'https://owned.example/redirect' }) }, 'document_target_changed'],
  ['window changed during probe', { probe: api => api.setCurrent({ windowId: 2 }) }, 'document_target_changed'],
  ['URL changed during probe', { probe: api => api.setCurrent({ url: 'https://owned.example/next' }) }, 'document_target_changed'],
]) {
  test(`committed-document probe fails closed for ${name}`, async () => {
    const direct = screenshotFixture(hooks);
    await assert.rejects(direct.probe(), { code });
    const capture = screenshotFixture(hooks);
    await assert.rejects(capture.run(), { code: 'screenshot_target_changed' });
    assert.equal(capture.api.captures, 0);
    assert.equal(capture.api.listenerCount, 0);
  });
}
test('committed-document probe rejects unresolved pending URLs before injection and disallowed origins', async () => {
  const pending = screenshotFixture();
  pending.api.setCurrent({ pendingUrl: 'https://owned.example/' });
  await assert.rejects(pending.probe(), { code: 'document_target_changed' });
  assert.equal(pending.api.probes, 0);
  const foreign = screenshotFixture();
  await assert.rejects(foreign.probe({ allowedOrigins: ['https://foreign.example'] }), { code: 'target_origin_not_allowed' });
  await assert.rejects(foreign.run({ allowedOrigins: ['https://foreign.example'] }), { code: 'screenshot_target_changed' });
  assert.equal(foreign.api.probes, 0);
});
for (const [phase, hooks, captureCount] of [
  ['after_slot', { wait: api => api.setDocument({ documentId: 'browser-document-2' }) }, 0],
  ['after_capture', { capture: api => api.setDocument({ documentId: 'browser-document-2' }) }, 1],
  ['after_slot', { probe: api => { if (api.probes === 2) api.setDocument({ documentId: 'browser-document-2' }); } }, 0],
]) {
  test(`capture rejects same-URL document replacement at ${phase} after ${captureCount} images`, async () => {
    const f = screenshotFixture(hooks);
    await assert.rejects(f.run(), error => error.code === 'screenshot_target_changed' && error.details.phase === phase);
    assert.equal(f.api.captures, captureCount);
  });
}
test('initial interactive loading does not relax subsequent loading events or activation interruptions', async () => {
  for (const change of [api => api.loadingThenComplete(), api => { api.switchTo(202); api.switchTo(101); }]) {
    const f = screenshotFixture({ initialStatus: 'loading', readyState: 'interactive', capture: change });
    await assert.rejects(f.run(), { code: 'screenshot_target_changed' });
    assert.equal(f.api.captures, 1);
  }
});
test('committed navigation accepts interactive DOM while Chrome status remains loading', async () => {
  const f = screenshotFixture({ initialStatus: 'loading', readyState: 'interactive' });
  const tab = await f.waitCommitted({ requestedUrl: 'https://owned.example/', timeoutMs: 30, expectedWindowId: 1 });
  assert.equal(tab.status, 'loading');
  assert.equal(tab.id, 101);
});
test('same-URL navigation dispatch requires a new Chrome-owned document identity', async () => {
  const stale = screenshotFixture({ navigationTimeoutMs: 25 });
  await assert.rejects(stale.navigate(), { code: 'navigation_commit_timeout' });
  assert.equal(stale.api.updates, 1);
  const changed = screenshotFixture({ navigationTimeoutMs: 30, update: api => api.setDocument({ documentId: 'browser-document-2', readyState: 'interactive' }) });
  const tab = await changed.navigate();
  assert.equal(tab.id, 101);
  assert.equal(changed.api.updates, 1);
  assert.ok(changed.api.probes >= 2);
});
test('navigation probes browser identity before dispatch and fails closed if it is missing', async () => {
  const f = screenshotFixture({ documentId: null });
  await assert.rejects(f.navigate(), { code: 'document_identity_unavailable' });
  assert.equal(f.api.updates, 0);
  await assert.rejects(f.waitCommitted({ requestedUrl: 'https://owned.example/', previousUrl: 'https://owned.example/' }), { code: 'previous_document_identity_required' });
});
test('navigation deadline bounds a stalled probe instead of adding its normal ten-second API timeout', async () => {
  const f = screenshotFixture({ probe: () => new Promise(() => {}) });
  const started = Date.now();
  await assert.rejects(f.waitCommitted({ requestedUrl: 'https://owned.example/', timeoutMs: 25 }), { code: 'navigation_commit_timeout' });
  assert.ok(Date.now() - started < 500);
  assert.equal(f.api.probes, 1);
  const direct = screenshotFixture({ probe: () => new Promise(() => {}) });
  await assert.rejects(direct.probe({ deadline: Date.now() + 20 }), { code: 'document_readiness_timeout' });
});
test('committed-document probe normalizes the nested script timeout before the outer timer fires', async () => {
  const f = screenshotFixture({ probe: () => { throw Object.assign(new Error('inner script timeout'), { code: 'page_execution_timeout' }); } });
  await assert.rejects(f.probe(), { code: 'document_readiness_timeout' });
  await assert.rejects(f.waitCommitted({ requestedUrl: 'https://owned.example/', timeoutMs: 30 }), { code: 'navigation_commit_timeout' });
});
for (const [name, initialUrl, requestedUrl] of [
  ['add', 'https://owned.example/', 'https://owned.example/#section'],
  ['change', 'https://owned.example/#old', 'https://owned.example/#new'],
  ['remove', 'https://owned.example/#section', 'https://owned.example/'],
  ['normalized intent', 'https://owned.example/', 'https://OWNED.example:443/#section'],
]) {
  test(`fragment-only navigation can ${name} a fragment on the unchanged committed document`, async () => {
    // These success cases test fragment/document identity, not scheduler latency.
    // Leave room for loaded-suite pauses; deadline rejection cases retain 25ms.
    const f = screenshotFixture({ initialUrl, navigationTimeoutMs: 1_000,
      update: api => { api.setCurrent({ status: 'loading' }); api.setDocument({ readyState: 'interactive' }); } });
    const result = await f.navigate({ url: requestedUrl });
    assert.equal(result.url, new URL(requestedUrl).href);
    assert.equal(f.api.updates, 1);
    assert.equal((await f.probe()).documentId, 'browser-document-1');
  });
}
for (const [name, initialUrl, requestedUrl, update, expectedCode = 'navigation_commit_timeout', probe] of [
  ['identical URL', 'https://owned.example/', 'https://owned.example/'],
  ['identical hash', 'https://owned.example/#same', 'https://owned.example/#same'],
  ['old URL', 'https://owned.example/', 'https://owned.example/#new', api => api.setCurrent({ url: 'https://owned.example/' })],
  ['unexpected hash', 'https://owned.example/', 'https://owned.example/#new', api => api.setCurrent({ url: 'https://owned.example/#unexpected' })],
  ['path change', 'https://owned.example/', 'https://owned.example/other#new'],
  ['query change', 'https://owned.example/?old=1', 'https://owned.example/?new=1#new'],
  ['pending redirect', 'https://owned.example/', 'https://owned.example/#new', api => api.setCurrent({ pendingUrl: 'https://owned.example/redirect' })],
  ['document URL disagreement', 'https://owned.example/', 'https://owned.example/#new', api => api.setDocument({ url: 'https://owned.example/#other' })],
  ['window change', 'https://owned.example/', 'https://owned.example/#new', api => api.setCurrent({ windowId: 2 })],
  ['origin change', 'https://owned.example/', 'https://owned.example/#new', api => api.setCurrent({ url: 'https://foreign.example/#new' }), 'target_origin_not_allowed'],
  ['DOM loading', 'https://owned.example/', 'https://owned.example/#new', api => api.setDocument({ readyState: 'loading' })],
  ['probe failure', 'https://owned.example/', 'https://owned.example/#new', undefined, 'permission_denied', api => {
    if (api.updates > 0) throw Object.assign(new Error('Cannot probe the dispatched document'), { code: 'permission_denied' });
  }],
]) {
  test(`fragment navigation exception rejects ${name} without another dispatch`, async () => {
    const f = screenshotFixture({ initialUrl, navigationTimeoutMs: 25, update, probe });
    await assert.rejects(f.navigate({ url: requestedUrl }), { code: expectedCode });
    assert.equal(f.api.updates, 1);
  });
}
test('fragment navigation whose browser document is replaced uses the normal new-document path', async () => {
  const f = screenshotFixture({ navigationTimeoutMs: 25, update: api => api.setDocument({ documentId: 'browser-document-2' }) });
  const result = await f.navigate({ url: 'https://owned.example/#section' });
  assert.equal(result.url, 'https://owned.example/#section');
  assert.equal((await f.probe()).documentId, 'browser-document-2');
  assert.equal(f.api.updates, 1);
});
test('ambiguous dropdown remains a refinable locator error, not an unsupported-control handoff', async () => {
  const a=source.indexOf('  if (action === "inspectDropdown") {');const b=source.indexOf('\n  if (action === ',a+10);
  const branch=source.slice(a,b);
  const context={ action:'inspectDropdown',payload:{locator:{label:'Choice'}},location:{href:'https://owned.example/'},find:()=>{throw Object.assign(new Error('matched 4'),{code:'semantic_locator_ambiguous',details:{candidates:[{role:'combobox',name:'Choice'}]}});} };
  const result=vm.runInNewContext(`(()=>{${branch}})()`,context);
  assert.equal(result.supported,null);assert.equal(result.exact_blocker,'semantic_locator_ambiguous');assert.equal(result.surface_handoff_candidate,false);assert.equal(result.candidates[0].role,'combobox');
});
test('nested transaction images are native MCP blocks without base64 in text or structured metadata', () => {
  const screenshot={kind:'screenshot',mimeType:'image/jpeg',dataBase64:'aGVsbG8=',tabId:101};
  const result=toolResult({schema:'aos.chrome_companion.transaction.v1',visual_readback:screenshot,other:{visual:screenshot}});
  assert.equal(result.content.filter(x=>x.type==='image').length,1);assert.ok(!result.content.find(x=>x.type==='text').text.includes('dataBase64'));assert.equal(result.structuredContent.result.visual_readback.tabId,101);
});
test('dispatch is not reported as confirmed external completion', () => {
  const result=toolResult({schema:'aos.chrome_companion.transaction.v1',result:'verified',external_action_executed:true,actions:[{step_packet:{reconciliation_required:true},result:{trustedInput:true}}],capsule:{effect:{externalActionExecuted:true}}}).structuredContent.result;
  assert.equal(result.external_action_executed,null);assert.equal(result.external_action_dispatched,true);assert.equal(result.potential_external_effect,true);assert.equal(result.capsule.effect.externalActionExecuted,null);assert.equal(result.external_effect_confirmation,'not_verified');
});
test('default status excludes foreign history while preserving global activity counts', () => {
  const foreign=Array.from({length:1000},(_,i)=>({taskId:`foreign-${i}`,signature:'opaque'}));
  const source={logicalSessionCount:1001,logicalSessions:[...foreign,{taskId:'mine'}],recoveryHandles:foreign,recovery:{tasks:foreign,aggregate:{state:'working'}}};
  const own=taskStatus(source,'mine');assert.equal(own.logicalSessionCount,1001);assert.equal(own.logicalSessions.length,1);assert.equal(own.recovery.tasks.length,0);assert.ok(JSON.stringify(own).length<600);assert.equal(taskStatus(source,'mine','all').recoveryHandles.length,1000);
});

test('visual proof usage keeps the exact lease until its transaction consumes the proof', () => {
  const inspected=toolResult({visual_readback_verified:true,visualProof:{signature:'opaque'},target:{supported:true}}).structuredContent.result;
  assert.equal(inspected.proof_usage.keep_lease_until_transaction,true);
  assert.equal(inspected.proof_usage.next_tool,'companion_authorized_transaction');
  assert.match(inspected.proof_usage.after_lease_release,/inspect_again/);
  const unsupported=toolResult({visual_readback_verified:true,supported:false,visualProof:{supported:false}}).structuredContent.result;
  assert.equal(unsupported.proof_usage,undefined);
});

test('retained transactions return exact fresh-read arguments after releasing their lease', () => {
  const result=toolResult({schema:'aos.chrome_companion.transaction.v1',cleanup:{lease_released:true,retained:true},tab:{id:77},capsule:{target:{sessionId:'owned'}}}).structuredContent.result;
  assert.equal(result.lease_state,'released');
  assert.deepEqual(result.next_target_read.arguments,{sessionId:'owned',tabId:77});
  const closed=toolResult({schema:'aos.chrome_companion.transaction.v1',cleanup:{lease_released:true,closed:true},tab:{id:77},capsule:{target:{sessionId:'owned'}}}).structuredContent.result;
  assert.equal(closed.next_target_read,undefined);
});
test('action schema advertises and validates required typed arguments before dispatch', () => {
  const schema=transactionActionSchema(z.object({role:z.string(),label:z.string().optional()}));
  assert.equal(schema.safeParse({method:'page.type',params:{locator:{role:'textbox'}}}).success,false);
  assert.equal(schema.safeParse({method:'visual.click',params:{}}).success,false);
  const ok=schema.parse({method:'page.type',params:{locator:{role:'textbox'},text:'hello',clear:true,customFutureOption:1}});assert.equal(ok.params.customFutureOption,1);
});


test('local browser edits are not labelled as an externally completed action', () => {
  const result=toolResult({schema:'aos.chrome_companion.transaction.v1',effect_state:'known_effect',external_action_executed:true,applied_actions:[{index:0,mutation:true,reconciliationRequired:false}],capsule:{effect:{externalActionExecuted:true}}}).structuredContent.result;
  assert.equal(result.browser_mutation_executed,true);
  assert.equal(result.external_action_executed,false);
  assert.equal(result.external_action_dispatched,false);
  assert.equal(result.capsule.effect.browserMutationExecuted,true);
  assert.equal(result.capsule.effect.externalActionExecuted,false);
});


test('label matching excludes siblings that merely share the same question context', () => {
  const a=source.indexOf('  const matchesSimpleLocator =');
  const b=source.indexOf('  const matchesLocator =',a);
  const context={lower:x=>String(x??'').toLowerCase(),accessibleName:x=>x.name,implicitRole:x=>x.role,matchesState:()=>true,semanticContext:()=>true};
  const matches=vm.runInNewContext(`(()=>{${source.slice(a,b)}return matchesSimpleLocator;})()`,context);
  const field=(name,role)=>({name,role,getAttribute:()=>null});
  const choice=field('Audit choice','combobox'),name=field('Audit name','textbox');
  assert.equal(matches(choice,{label:'Audit choice'}),true);
  assert.equal(matches(name,{label:'Audit choice'}),false);
  assert.equal(matches(name,{question:'Audit choice'}),true);
});


test('injected locator errors survive serialization with their actionable code', async () => {
  const a=source.indexOf('async function injectedPageOperation(');
  const b=source.indexOf('\nchrome.runtime.onMessage',a);
  const context={document:{querySelectorAll:()=>[]},crypto:{randomUUID:()=> 'fixture-id'}};
  vm.createContext(context);vm.runInContext(source.slice(a,b),context);
  const result=await context.injectedPageOperation('inspectVisualTarget',{locator:{role:'button',name:'actually a checkbox'}});
  assert.equal(result.__aosCompanionError.code,'semantic_locator_not_found');
  assert.equal(result.__aosCompanionError.details.nextAction,'query_current_page_then_refine_locator');
  assert.equal(result.__aosCompanionError.details.operationEffectState,undefined);
});

test('page-operation runner unwraps a serialized locator error before target binding', async () => {
  const a=source.indexOf('async function runPageOperation(');
  const b=source.indexOf('\nasync function injectedPageOperation(',a);
  const context={READ_ONLY_PAGE_ACTIONS:new Set(['inspectVisualTarget']),executePageScriptWithReadRetry:async()=>[{frameId:0,result:{__aosCompanionError:{code:'semantic_locator_not_found',message:'No matching button',details:{nextAction:'refine_locator'}}}}],bindInjectionDocumentIdentity:x=>x,companionError:(code,message,details)=>Object.assign(new Error(message),{code,details})};
  context.PAGE_MUTATION_EXECUTION_TIMEOUT_MS=30_000;
  vm.createContext(context);vm.runInContext(source.slice(a,b),context);
  await assert.rejects(context.runPageOperation(1,'inspectVisualTarget',{locator:{role:'button'}}),error=>error.code==='semantic_locator_not_found'&&error.details.nextAction==='refine_locator');
});

test('upload execution has a bounded longer wait and a timeout never retries or reports no effect', async () => {
  const a=source.indexOf('async function runPageOperation('), b=source.indexOf('\nasync function injectedPageOperation(',a);
  for (const action of ['upload','uploadMultiple','click']) {
    let calls=0,timeout;
    const context={PAGE_MUTATION_EXECUTION_TIMEOUT_MS:30_000,READ_ONLY_PAGE_ACTIONS:new Set(),injectedPageOperation:()=>{},
      chrome:{scripting:{executeScript:async()=>{calls++;return [];}}},
      withTimeout:async(promise,ms,code)=>{await promise;timeout=ms;throw Object.assign(Error('late'),{code});}};
    vm.createContext(context);vm.runInContext(source.slice(a,b),context);
    await assert.rejects(context.runPageOperation(1,action,{}),error=>error.code==='page_mutation_execution_timeout'
      &&error.details.operationEffectState==='unknown'&&error.details.mutationDispatchAttempted===true&&error.details.timeoutMs===timeout);
    assert.equal(timeout,action==='click'?30_000:45_000);assert.equal(calls,1);
  }
});
