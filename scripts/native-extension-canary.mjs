import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { createHash, generateKeyPairSync } from 'node:crypto';
import { chmod, cp, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { isolatedBrowser } from './lib/isolated-browser-fixture.mjs';
import { CompanionBroker } from '../src/broker/broker.mjs';
import { BrokerClient } from '../src/client/broker-client.mjs';
import { ensureBrokerSecret } from '../src/shared/security.mjs';
import { ensureIssuerSecret } from '../src/shared/task-runtime.mjs';
import { materializeUploadParams } from '../src/mcp/action-materializer.mjs';
import { readUrls } from '../src/mcp/read-urls.mjs';
import { INSTALL_BUILD_ID } from '../src/shared/build-info.mjs';

// This test owns every browser profile, native host registration, secret,
// broker, page and uploaded file. It never registers or refreshes an installed
// browser extension, touches the host clipboard, or invokes a real provider.
const source = fileURLToPath(new URL('../', import.meta.url));
const output = resolve(process.argv[2] ?? '../verification/native-extension', new Date().toISOString().replaceAll(':', '-'));
await mkdir(output, { recursive: true });
const lab = await mkdtemp(join(tmpdir(), 'aos-native-lab-'));
const dataDir = join(lab, 'data');
await mkdir(dataDir, { mode: 0o700 });
const env = { ...process.env, AOS_CHROME_COMPANION_DATA_DIR: dataDir,
  AOS_CHROME_COMPANION_SOCKET: join(lab, 'broker.sock'),
  AOS_CHROME_COMPANION_STATE_FILE: join(dataDir, 'state.json'),
  AOS_CHROME_COMPANION_SECRET_FILE: join(dataDir, 'broker-secret'),
  AOS_CHROME_COMPANION_AOS_ISSUER_SECRET_FILE: join(dataDir, 'aos-issuer-secret'),
  AOS_CHROME_COMPANION_CODEX_MCP_ISSUER_SECRET_FILE: join(dataDir, 'codex_mcp-issuer-secret'),
  AOS_CHROME_COMPANION_AUTO_SETUP: '0' };
const extension = join(lab, 'extension');
await cp(join(source, 'extension'), extension, { recursive: true });
await writeFile(join(extension, 'build-info.js'), `export const INSTALL_BUILD_ID = ${JSON.stringify(INSTALL_BUILD_ID)};\n`);
const publicKey = generateKeyPairSync('rsa', { modulusLength: 2048 }).publicKey.export({ type: 'spki', format: 'der' });
const extensionId = createHash('sha256').update(publicKey).digest('hex').slice(0, 32).replace(/[0-9a-f]/g, c => 'abcdefghijklmnop'[parseInt(c, 16)]);
const manifest = JSON.parse(await readFile(join(extension, 'manifest.json'), 'utf8'));
if (process.env.COMPANION_TEST_LIBRARY === '1') {
  // A separately declared test-profile permission state; this does not
  // simulate a user's consent click or change any installed permission.
  manifest.permissions.push('history', 'bookmarks');
  manifest.optional_permissions = manifest.optional_permissions.filter(permission => !['history', 'bookmarks'].includes(permission));
}
manifest.key = publicKey.toString('base64');
await writeFile(join(extension, 'manifest.json'), JSON.stringify(manifest, null, 2));
env.AOS_CHROME_COMPANION_EXTENSION_ORIGIN = `chrome-extension://${extensionId}/`;
const quote = value => "'" + value.replaceAll("'", "'\\''") + "'";
let hostExecutable = process.execPath, hostSource = source;
if (process.env.COMPANION_TEST_RELOCATE_NATIVE === '1') {
  // Test the payload outside the authoring Documents directory, in an owned
  // disposable installation root. No OS privacy or execution policy changes.
  hostExecutable = join(lab, 'runtime', 'node'); hostSource = join(lab, 'app');
  await mkdir(join(lab, 'runtime'), { recursive: true });
  await cp(process.execPath, hostExecutable);
  await chmod(hostExecutable, 0o755);
  await cp(join(source, 'src'), join(hostSource, 'src'), { recursive: true });
  await cp(join(source, 'extension'), join(hostSource, 'extension'), { recursive: true });
  await cp(join(source, 'package.json'), join(hostSource, 'package.json'));
  assert.equal(createHash('sha256').update(await readFile(hostExecutable)).digest('hex'), createHash('sha256').update(await readFile(process.execPath)).digest('hex'));
}
const wrapper = join(lab, 'native-host.sh');
const nativeHostDiagnostics = join(lab, 'native-host.stderr');
await writeFile(wrapper, '#!/bin/sh\n' + Object.entries(env).filter(([name]) => name.startsWith('AOS_CHROME_COMPANION_')).map(([name, value]) => `export ${name}=${quote(value)}`).join('\n') + `\n/bin/date -u +%Y-%m-%dT%H:%M:%SZ >> ${quote(nativeHostDiagnostics)}\nexec ${quote(hostExecutable)} ${quote(join(hostSource, 'src/native-host/main.mjs'))} "$@" 2>> ${quote(nativeHostDiagnostics)}\n`, { mode: 0o700 });
await chmod(wrapper, 0o700);
const receipt = { schema: 'aos.chrome_companion.native_extension_canary.v1', startedAt: new Date().toISOString(),
  scope: 'Actual unpacked extension, Native Messaging host, strict signed broker, and local HTTP fixture in an isolated Chrome for Testing profile',
  extensionId, cases: [], timings: [], cleanup: {}, result: 'running',
  networkTransport: process.env.COMPANION_TEST_ROUTE_HTTP === '1' ? 'CDP fixture response forwarding to local HTTP server; native browser network not verified' : 'native_browser_network' };
receipt.installationBuildId = INSTALL_BUILD_ID;
receipt.sourceDigests = Object.fromEntries(await Promise.all(['extension/service-worker.js', 'extension/accessibility-history.js', 'src/broker/broker.mjs', 'src/native-host/main.mjs'].map(async path => [path, createHash('sha256').update(await readFile(join(source, path))).digest('hex')])));
const received = { uploads: [], submissions: 0 };
const controlsOnly = process.env.COMPANION_TEST_CONTROLS_ONLY === '1';
receipt.controlsOnly = controlsOnly;
receipt.nativeRuntimeRelocatedToOwnedTemporaryRoot = process.env.COMPANION_TEST_RELOCATE_NATIVE === '1';
const fileContents = '日本語の添付確認\nexactly once\n';
const expectedHash = createHash('sha256').update(fileContents).digest('hex');
const server = createServer(async (request, response) => {
  if (request.method === 'POST') {
    const chunks = []; for await (const chunk of request) chunks.push(chunk);
    if (request.url === '/upload') received.uploads.push({ size: Buffer.concat(chunks).length, sha256: createHash('sha256').update(Buffer.concat(chunks)).digest('hex') });
    if (request.url === '/submit') received.submissions += 1;
    response.writeHead(200, { 'content-type': 'application/json' }); response.end(JSON.stringify({ accepted: true })); return;
  }
  if (request.url === '/dropdown-options') {
    // Delay the fixture server, not the hidden renderer's throttled timers.
    await new Promise(resolve => setTimeout(resolve, 200));
    response.writeHead(200, { 'content-type': 'application/json', 'cache-control': 'no-store' });
    response.end(JSON.stringify({ label: 'Japan', value: 'jp' })); return;
  }
  response.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' });
  if (request.url === '/ax-child') {
    response.end('<!doctype html><meta charset="utf-8"><h1>AX child only</h1><button>Child AX button</button><label>AX text field<input value="fixture-private-value"></label>');
    return;
  }
  if (request.url === '/dropdown') {
    response.end('<!doctype html><meta charset="utf-8"><h1>Native dropdown fixture</h1><button role="combobox" data-testid="country" aria-controls="owned-countries">Choose country</button><div id="owned-countries" role="listbox"></div><div role="listbox"><button role="option" data-value="foreign" onclick="this.setAttribute(\'aria-selected\',\'true\');document.querySelector(\'#result\').textContent=\'Foreign menu clicked\'">Japan</button></div><p id="result">Waiting</p><script>document.querySelector(\'[data-testid=country]\').onclick=async()=>{const candidate=await (await fetch(\'/dropdown-options\')).json();const option=document.createElement(\'button\');option.setAttribute(\'role\',\'option\');option.setAttribute(\'data-value\',candidate.value);option.textContent=candidate.label;option.onclick=()=>{option.setAttribute(\'aria-selected\',\'true\');document.querySelector(\'[data-testid=country]\').textContent=\'Japan\';document.querySelector(\'#result\').textContent=\'Own country chosen\'};document.querySelector(\'#owned-countries\').replaceChildren(option)}</script>');
    return;
  }
  response.end(`<!doctype html><html lang="ja"><head><title>Companion native fixture ${request.url}</title></head><body style="font:20px sans-serif;padding:40px">
  <main><h1>Companion 実拡張の動作確認</h1><p data-testid="ready">ready ${request.url}</p>
  <form><label>添付ファイル <input type="file" data-testid="file"></label><div id="receipt"></div>
  <button type="submit" data-testid="submit">送信テスト</button><p id="result">送信前</p></form></main>
  <button type="button" data-testid="viewport-target" onclick="this.textContent='Viewport click confirmed'">Viewport target</button>
  ${request.url === '/form' ? '<iframe title="AX child frame" src="/ax-child"></iframe>' : ''}
  <script>window.fixtureEvents={input:0,change:0};const f=document.querySelector('input');
  f.addEventListener('input',()=>fixtureEvents.input++);f.addEventListener('change',async()=>{fixtureEvents.change++;const file=f.files[0];f.value='';await new Promise(r=>setTimeout(r,450));await fetch('/upload',{method:'POST',body:file});document.querySelector('#receipt').innerHTML='<p data-testid="attachment">native-fixture.txt 受領済み</p>';});
  document.querySelector('form').addEventListener('submit',async event=>{event.preventDefault();await new Promise(r=>setTimeout(r,600));await fetch('/submit',{method:'POST',body:'native fixture'});document.querySelector('#result').textContent='送信完了・受領番号 fixture-001';});</script></body></html>`);
});
let browser, broker, client, session, diagnosticsTimer;
const delay = ms => new Promise(r => setTimeout(r, ms));
const check = (name, evidence) => { receipt.cases.push({ name, passed: true, ...evidence }); console.log(JSON.stringify({ case: name, passed: true })); };
try {
  const secret = await ensureBrokerSecret(env);
  const issuerSecrets = { aos: await ensureIssuerSecret('aos', env), codex_mcp: await ensureIssuerSecret('codex_mcp', env) };
  broker = new CompanionBroker({ socketPath: env.AOS_CHROME_COMPANION_SOCKET, secret, issuerSecrets,
    statePath: env.AOS_CHROME_COMPANION_STATE_FILE, handoffReceiptsDir: join(lab, 'handoffs') });
  await broker.listen();
  await new Promise(r => server.listen(0, '127.0.0.1', r));
  const origin = `http://127.0.0.1:${server.address().port}`;
  const binary = process.env.COMPANION_TEST_BROWSER_BINARY;
  if (!binary?.includes('Google Chrome for Testing')) throw Error('This extension fixture requires an explicit Chrome for Testing binary');
  browser = await isolatedBrowser({ binary, headless: process.env.COMPANION_TEST_HEADLESS !== '0', extensions: [extension],
    routeRequests: process.env.COMPANION_TEST_ROUTE_HTTP === '1' ? async request => {
      if (new URL(request.url).origin !== origin) return null;
      const response = await fetch(request.url, { method: request.method, ...(request.postData !== undefined ? { body: request.postData } : {}) });
      return { status: response.status, headers: { 'content-type': response.headers.get('content-type') ?? 'text/plain' }, body: Buffer.from(await response.arrayBuffer()) };
    } : null,
    prepareProfile: async profile => {
    const directory = join(profile, 'NativeMessagingHosts'); await mkdir(directory, { recursive: true });
    await writeFile(join(directory, 'com.aos.chrome_companion.json'), JSON.stringify({
      name: 'com.aos.chrome_companion', description: 'Isolated Companion test native host', path: wrapper,
      type: 'stdio', allowed_origins: [env.AOS_CHROME_COMPANION_EXTENSION_ORIGIN] }));
  } });
  receipt.browser = browser.version;
  receipt.headless = process.env.COMPANION_TEST_HEADLESS !== '0';
  if (!controlsOnly) {
    await browser.navigate(origin + '/boot');
    check('test_browser_http_navigation', { origin });
  }
  client = await BrokerClient.connect({ env, autoStart: false });
  let status;
  for (let attempt = 0; attempt < 300; attempt += 1) {
    status = await client.request('status.get');
    if (status.profiles?.some(p => p.connected)) break;
    await delay(100);
  }
  receipt.connection = status.profiles;
  receipt.targets = (await (await fetch(`http://127.0.0.1:${browser.debuggingPort}/json/list`)).json()).map(({id,type,url})=>({id,type,url}));
  await browser.navigate(`chrome-extension://${extensionId}/sidepanel.html`);
  for (let attempt = 0; attempt < 200; attempt += 1) {
    receipt.extensionState = await browser.evaluate('chrome.runtime.sendMessage({kind:"status.get"})');
    status = await client.request('status.get');
    if (receipt.extensionState.connected && status.profiles?.some(profile => profile.connected && profile.generation === receipt.extensionState.generation)) break;
    await delay(100);
  }
  receipt.connection = status.profiles;
  assert.equal(status.profiles.filter(p => p.connected).length, 1, 'Actual extension must connect through its isolated Native Messaging manifest');
  assert.equal(receipt.extensionState.connected, true, 'Extension must have received the same-generation hello acknowledgement');
  check('actual_native_extension_connection', { version: status.profiles[0].extensionVersion });
  receipt.liveDiagnostics = [];
  let diagnosticBusy = false;
  diagnosticsTimer = setInterval(async () => {
    if (diagnosticBusy) return; diagnosticBusy = true;
    try {
      const observed = await browser.evaluate('Promise.all([chrome.runtime.sendMessage({kind:"controls.get"}),chrome.tabs.query({})]).then(([controls,tabs])=>({controls,tabs:tabs.map(({id,url,status,groupId})=>({id,url,status,groupId}))}))');
      receipt.liveDiagnostics.push({ at: new Date().toISOString(), ...observed });
      await writeFile(join(output, 'live-diagnostics.json'), JSON.stringify(receipt.liveDiagnostics, null, 2));
      console.log(JSON.stringify({ phase: 'native_diagnostic', operations: observed.controls?.recentOperations?.map(({method,phase,errorCode})=>({method,phase,errorCode})), tabs: observed.tabs?.length }));
    } catch (error) { console.log(JSON.stringify({ phase: 'native_diagnostic', error: error.message })); }
    finally { diagnosticBusy = false; }
  }, 10000);
  const taskId = 'native-fixture-' + Date.now();
  session = await client.request('session.open', { taskId, label: 'Companion 実拡張の動作確認' });
  if (controlsOnly) {
    if (process.env.COMPANION_TEST_LIBRARY === '1') {
      receipt.libraryPermissionSetup = 'Explicit permissions in this disposable fixture manifest; production permissions remain optional';
      await browser.evaluate(`Promise.all([chrome.history.addUrl({url:'https://fixture-library.example/history'}),chrome.bookmarks.create({title:'Companion fixture bookmark',url:'https://fixture-library.example/bookmark'})])`);
      for (const source of ['history', 'bookmarks']) {
        const library = await client.request('operation.execute', { sessionId: session.sessionId,
          method: 'browser.searchLibrary', params: { source, query: 'fixture-library.example', limit: 10 } });
        assert.equal(library.rows.length, 1); assert.equal(library.storedByCompanion, false);
        check('actual_' + source + '_search', { count: library.count });
      }
      await browser.evaluate(`chrome.runtime.sendMessage({kind:'controls.site',origin:'https://fixture-library.example',blocked:true})`);
      const filtered = await client.request('operation.execute', { sessionId: session.sessionId,
        method: 'browser.searchLibrary', params: { source: 'history', query: 'fixture-library.example' } });
      assert.equal(filtered.count, 0); assert.equal(filtered.filteredCount, 1);
      check('actual_history_respects_blocked_site', { count: filtered.count });
    } else {
      await assert.rejects(client.request('operation.execute', { sessionId: session.sessionId,
        method: 'browser.searchLibrary', params: { source: 'history', query: 'fixture' } }), error => error.code === 'browser_library_permission_required');
      check('actual_optional_history_permission_required', {});
    }
    await browser.evaluate('chrome.runtime.sendMessage({kind:"controls.pause",paused:true})');
    const blocked = await client.requestAuthorizedTransaction({ sessionId: session.sessionId, taskId,
      runId: taskId + ':paused', idempotencyKey: taskId + ':paused', intent: 'authorized_transaction',
      startUrl: origin + '/paused', targetOrigin: origin, allowedOrigins: [origin],
      actions: [{ method: 'page.query', params: { locator: { css: 'body' } } }],
      reuseTaskTab: false, keepTaskTab: false, retainOnUnknown: false });
    await writeFile(join(output, 'paused-transaction.json'), JSON.stringify(blocked, null, 2));
    assert.equal(blocked.exact_blocker?.code, 'companion_user_paused');
    assert.equal(blocked.external_action_executed, false);
    assert.equal((await browser.evaluate('chrome.tabs.query({})')).length, 1);
    check('actual_pause_prevents_native_tab_dispatch', { code: blocked.exact_blocker.code });
    await browser.evaluate('chrome.runtime.sendMessage({kind:"controls.pause",paused:false})');
    await browser.evaluate(`chrome.runtime.sendMessage({kind:"controls.site",origin:${JSON.stringify(origin)},blocked:true})`);
    const siteBlocked = await client.requestAuthorizedTransaction({ sessionId: session.sessionId, taskId,
      runId: taskId + ':site-blocked', idempotencyKey: taskId + ':site-blocked', intent: 'authorized_transaction',
      startUrl: origin + '/site-blocked', targetOrigin: origin, allowedOrigins: [origin],
      actions: [{ method: 'page.query', params: { locator: { css: 'body' } } }],
      reuseTaskTab: false, keepTaskTab: false, retainOnUnknown: false });
    assert.equal(siteBlocked.exact_blocker?.code, 'companion_site_blocked');
    assert.equal(siteBlocked.external_action_executed, false);
    assert.equal((await browser.evaluate('chrome.tabs.query({})')).length, 1);
    check('actual_site_permission_prevents_native_dispatch', { code: siteBlocked.exact_blocker.code });
    const history = await client.request('task.history', { sessionId: session.sessionId, limit: 100 });
    assert.equal(history.taskId, taskId); assert.ok(history.rows.length >= 2);
    check('native_history_and_readback_during_pause', { entries: history.rows.length });
    await browser.navigate(`chrome-extension://${extensionId}/sidepanel.html`);
    const screenshot = await browser.call('Page.captureScreenshot', { format: 'png' });
    await writeFile(join(output, 'native-panel.png'), Buffer.from(screenshot.data, 'base64'));
  } else {
  const start = performance.now();
  const bulk = await readUrls(client, { sessionId: session.sessionId, taskId, runId: taskId + ':read',
    idempotencyKey: taskId + ':read', urls: [origin + '/a', origin + '/b', origin + '/a'], concurrency: 2, maxCharsPerPage: 1500 });
  await writeFile(join(output, 'bulk-read.json'), JSON.stringify(bulk, null, 2));
  receipt.timings.push({ phase: 'bulk_read', durationMs: performance.now() - start });
  assert.equal(bulk.coverage.read, 3); assert.equal(bulk.cleanupComplete, true);
  assert.match(bulk.rows[0].text, /ready \/a/); assert.match(bulk.rows[1].text, /ready \/b/);
  check('bulk_urls_native_read_and_cleanup', { coverage: bulk.coverage, duplicateOf: bulk.rows[2].duplicateOf });
  // The disposable test extension opts in explicitly; installed user settings
  // are never read or changed by this fixture.
  const debuggerOptIn = await browser.evaluate('chrome.runtime.sendMessage({kind:"physicalInput.set",enabled:true})');
  assert.equal(debuggerOptIn.enabled, true);
  receipt.debuggerOptInSetup = 'Explicit opt-in in the owned disposable test profile only';
  const viewportResult = await client.requestAuthorizedTransaction({ sessionId: session.sessionId, taskId,
    runId: taskId + ':viewport', idempotencyKey: taskId + ':viewport', intent: 'authorized_transaction',
    startUrl: origin + '/viewport', targetOrigin: origin, allowedOrigins: [origin],
    actions: [{ method: 'page.configureViewport', params: { action: 'set', width: 900, height: 700, deviceScaleFactor: 1.5 } },
      { method: 'page.query', params: { locator: { css: 'body' } } },
      { method: 'page.click', params: { locator: { testId: 'viewport-target' } } },
      { method: 'page.configureViewport', params: { action: 'restore' } }],
    readbackMaxTextChars: 2000, reuseTaskTab: false, keepTaskTab: false }, { timeoutMs: 120000 });
  await writeFile(join(output, 'viewport-transaction.json'), JSON.stringify(viewportResult, null, 2));
  assert.equal(viewportResult.result, 'verified', JSON.stringify(viewportResult.exact_blocker));
  assert.equal(viewportResult.actions[0].result.viewport.width, 900);
  assert.equal(viewportResult.actions[0].result.viewport.devicePixelRatio, 1.5);
  assert.equal(viewportResult.actions[1].result.count, 1);
  assert.match(viewportResult.post.text, /Viewport click confirmed/);
  assert.equal(viewportResult.actions[3].result.restored, true);
  assert.equal(viewportResult.actions[3].result.matchesInitialViewport, true);
  assert.equal(viewportResult.cleanup.closed, true);
  check('temporary_viewport_native_set_restore_and_cleanup', { configured: viewportResult.actions[0].result.viewport,
    restored: viewportResult.actions[3].result.viewport });
  const dropdownSetup = await client.requestAuthorizedTransaction({ sessionId: session.sessionId, taskId,
    runId: taskId + ':dropdown-setup', idempotencyKey: taskId + ':dropdown-setup', intent: 'authorized_transaction',
    startUrl: origin + '/dropdown', targetOrigin: origin, allowedOrigins: [origin],
    actions: [{ method: 'page.query', params: { locator: { testId: 'country' } } }],
    reuseTaskTab: false, keepTaskTab: true }, { timeoutMs: 120000 });
  assert.equal(dropdownSetup.result, 'verified');
  const dropdownLease = await client.request('lease.acquire', { sessionId: session.sessionId, tabId: dropdownSetup.tab.id });
  const dropdownInspection = await client.request('dropdown.inspect', { sessionId: session.sessionId, leaseId: dropdownLease.leaseId,
    tabId: dropdownSetup.tab.id, locator: { testId: 'country' } });
  assert.equal(dropdownInspection.supported, true);
  await writeFile(join(output, 'dropdown-preflight.jpg'), Buffer.from(dropdownInspection.visual.dataBase64, 'base64'));
  const dropdownResult = await client.requestAuthorizedTransaction({ sessionId: session.sessionId, taskId, tabId: dropdownSetup.tab.id,
    runId: taskId + ':dropdown', idempotencyKey: taskId + ':dropdown', intent: 'authorized_transaction',
    startUrl: origin + '/dropdown', targetOrigin: origin, allowedOrigins: [origin],
    actions: [{ method: 'page.selectOption', params: { locator: { testId: 'country' }, option: { label: 'Japan' }, visualProof: dropdownInspection.visualProof, timeoutMs: 5000 } }],
    readbackMaxTextChars: 2000, reuseTaskTab: true, keepTaskTab: false }, { timeoutMs: 120000 });
  await writeFile(join(output, 'dropdown-transaction.json'), JSON.stringify(dropdownResult, null, 2));
  assert.equal(dropdownResult.result, 'verified', JSON.stringify(dropdownResult.exact_blocker));
  assert.equal(dropdownResult.actions[0].result.option.value, 'jp');
  assert.match(dropdownResult.post.text, /Own country chosen/); assert.doesNotMatch(dropdownResult.post.text, /Foreign menu clicked/);
  assert.equal(dropdownResult.cleanup.closed, true);
  check('native_async_dropdown_preserves_associated_menu', { optionValue: dropdownResult.actions[0].result.option.value });
  const filePath = join(lab, 'native-fixture.txt'); await writeFile(filePath, fileContents);
  const upload = await materializeUploadParams({ filePath, locator: { testId: 'file' },
    confirmationLocator: { testId: 'attachment' }, confirmationTimeoutMs: 5000 });
  const result = await client.requestAuthorizedTransaction({ sessionId: session.sessionId, taskId,
    runId: taskId + ':form', idempotencyKey: taskId + ':form', intent: 'authorized_transaction',
    startUrl: origin + '/form', targetOrigin: origin, allowedOrigins: [origin],
    actions: [{ method: 'page.upload', params: upload }, { method: 'page.click', params: { locator: { testId: 'submit' } } }],
    readbackMaxTextChars: 5000, reuseTaskTab: false, keepTaskTab: true, retainOnUnknown: true }, { timeoutMs: 120000 });
  await writeFile(join(output, 'form-transaction.json'), JSON.stringify(result, null, 2));
  assert.equal(result.result, 'verified', JSON.stringify(result.exact_blocker));
  assert.equal(received.uploads.length, 1); assert.equal(received.uploads[0].sha256, expectedHash);
  check('upload_cleared_input_and_site_receipt', { uploads: received.uploads.length, sha256: expectedHash });
  assert.equal(received.submissions, 1); assert.match(result.post.text, /送信完了/);
  check('delayed_submission_readback_without_replay', { submissions: received.submissions, providerReceipt: 'fixture-001', outcome: result.outcome });
  const axLease = await client.request('lease.acquire', { sessionId: session.sessionId, tabId: result.tab.id });
  try {
    const readAX = params => client.request('operation.execute', { sessionId: session.sessionId, leaseId: axLease.leaseId,
      method: 'page.accessibilitySnapshot', params: { tabId: result.tab.id, maxNodes: 200, depth: 12, ...params } });
    const axBase = await readAX({});
    assert.equal(axBase.kind, 'native_accessibility_snapshot');
    assert.equal(axBase.nodes[0].index, 1); assert.equal(axBase.indexActionsSupported, false);
    assert.ok(!axBase.nodes.some(node => node.name === 'AX child only'));
    const axDiff = await readAX({ sinceSnapshotId: axBase.snapshotId });
    assert.equal(axDiff.kind, 'native_accessibility_diff'); assert.equal(axDiff.diff.changed.length, 0);
    const axChild = await readAX({ framePath: [0] });
    assert.equal(axChild.scope, 'selected_child_frame'); assert.ok(axChild.nodes.some(node => node.name === 'Child AX button'));
    assert.ok(!JSON.stringify(axChild).includes('fixture-private-value'));
    await writeFile(join(output, 'accessibility-snapshots.json'), JSON.stringify({ axBase, axDiff, axChild }, null, 2));
    check('native_accessibility_child_redaction_and_snapshot_diff', { mainCount: axBase.count, childCount: axChild.count,
      unchangedCount: axDiff.diff.unchangedCount, formValuesIncluded: axChild.formValuesIncluded });
  } finally { await client.request('lease.release', { sessionId: session.sessionId, leaseId: axLease.leaseId }); }
  const history = await client.request('task.history', { sessionId: session.sessionId, limit: 100 });
  await writeFile(join(output, 'operation-history.json'), JSON.stringify(history, null, 2));
  assert.ok((history.rows ?? []).length > 0); assert.equal(history.taskId, taskId);
  check('native_operation_history_owned_scope', { count: history.rows.length });
  await browser.navigate(`chrome-extension://${extensionId}/sidepanel.html`);
  for (let attempt = 0; attempt < 40; attempt += 1) { if (await browser.evaluate('document.body.innerText.includes("Chromeに接続済み")')) break; await delay(50); }
  assert.ok(await browser.evaluate('document.body.innerText.includes("Chromeに接続済み")'));
  const uiState = await browser.evaluate('chrome.runtime.sendMessage({kind:"controls.get"})');
  assert.ok(uiState.recentOperations.length > 0);
  await browser.evaluate('document.querySelector("#pause").click()');
  for (let attempt = 0; attempt < 40; attempt += 1) { if (await browser.evaluate('document.body.innerText.includes("新しい操作を一時停止しています")')) break; await delay(50); }
  assert.equal((await browser.evaluate('chrome.runtime.sendMessage({kind:"controls.get"})')).paused, true);
  check('actual_extension_pause_ui', { recentOperations: uiState.recentOperations.length });
  const shot = await browser.call('Page.captureScreenshot', { format: 'png', captureBeyondViewport: true });
  await writeFile(join(output, 'native-panel.png'), Buffer.from(shot.data, 'base64'));
  await browser.evaluate('document.querySelector("#pause").click()');
  const cleanup = await client.requestCleanupTaskTabs({ sessionId: session.sessionId, taskId,
    runId: taskId + ':cleanup', idempotencyKey: taskId + ':cleanup', preserveTabIds: [] });
  receipt.cleanup.taskTabs = cleanup;
  }
  receipt.result = 'passed';
} catch (error) {
  receipt.result = 'failed'; receipt.error = { message: error.message, code: error.code, stack: error.stack };
} finally {
  receipt.nativeHostDiagnostics = await readFile(nativeHostDiagnostics, 'utf8').catch(() => 'native wrapper did not start');
  clearInterval(diagnosticsTimer);
  if (session) { try { await client.request('session.close', { sessionId: session.sessionId }); receipt.cleanup.sessionClosed = true; } catch { receipt.cleanup.sessionClosed = false; } }
  client?.close(); await browser?.close(); await broker?.close();
  if (server.listening) await new Promise(r => server.close(r));
  await rm(lab, { recursive: true, force: true });
  receipt.cleanup.browserClosed = browser?.closed ?? true; receipt.cleanup.labRemoved = true;
  receipt.browserDiagnostics = browser?.stderr;
  receipt.finishedAt = new Date().toISOString();
  await writeFile(join(output, 'receipt.json'), JSON.stringify(receipt, null, 2));
  console.log(JSON.stringify({ result: receipt.result, cases: receipt.cases.length, error: receipt.error, record: join(output, 'receipt.json') }));
  if (receipt.result !== 'passed') process.exitCode = 1;
}
