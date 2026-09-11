import assert from 'node:assert/strict';
import vm from 'node:vm';
import { createServer } from 'node:http';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { PageObservations, DebuggerSessionPool } from '../extension/page-observation.js';
import { isolatedBrowser } from './lib/isolated-browser-fixture.mjs';

const output = resolve(process.argv[2] ?? '../verification/page-events-dom', new Date().toISOString().replaceAll(':', '-'));
await mkdir(output, { recursive: true });
const source = await readFile(new URL('../extension/service-worker.js', import.meta.url), 'utf8');
const redact = vm.runInNewContext(source.slice(source.indexOf('function redactPeripheralText('), source.indexOf('async function runClipboardOperation(')) + '\nredactPeripheralText');
const html = '<!doctype html><meta charset="utf-8"><title>Companion page events</title><style>body{font:21px system-ui;padding:40px;background:#f4f8ff;color:#142f53}li{margin:12px 0}input,button{font:20px system-ui;margin:15px}</style><h1>Companion ページイベント確認</h1><input id="file" type="file"><button id="click">テストページ</button><ul id="results"></ul>';
const handler = (request, response) => {
  if (request.url === '/download') { response.writeHead(200, { 'content-type': 'text/plain', 'content-disposition': 'attachment; filename="companion-event-fixture.txt"' }); response.end('owned fixture download'); return; }
  response.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' }); response.end(html);
};
const server = createServer(handler), secondServer = createServer(handler);
const owner = { taskId: 'page-events-fixture', sessionId: 'owned-fixture-session', generation: 'fixture-generation' };
const receipt = { schema: 'aos.chrome_companion.page_events_dom_canary.v1', startedAt: new Date().toISOString(),
  scope: 'Production PageObservations with real Chrome CDP events; extension Native Messaging transport is not part of this fixture', cases: [], result: 'running', cleanup: {} };
let browser, observations, observationId, cursor;
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
const read = () => observations.control(1, owner, { action: 'read', observationId, cursor });
const until = async (predicate, description) => {
  for (let attempt = 0; attempt < 100; attempt++) { const value = await predicate(); if (value) return value; await delay(50); }
  throw Error(description);
};
const check = async (name, predicate) => {
  const result = await until(async () => { const data = await read(); return predicate(data) ? data : null; }, 'Missing ' + name);
  receipt.cases.push({ name, passed: true, events: result.entries }); cursor = result.cursor;
};
try {
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  await new Promise(resolve => secondServer.listen(0, '127.0.0.1', resolve));
  const origin = `http://127.0.0.1:${server.address().port}`;
  const secondOrigin = `http://127.0.0.1:${secondServer.address().port}`;
  browser = await isolatedBrowser(); receipt.browser = browser.version;
  await browser.navigate(origin + '/');
  const eventListeners = new Set();
  browser.subscribeEvents((method, params) => { for (const listener of eventListeners) listener({ tabId: 1 }, method, params); });
  const api = { onEvent: { addListener: listener => eventListeners.add(listener) }, onDetach: { addListener() {} }, attach: async () => {}, detach: async () => {} };
  observations = new PageObservations({ debuggerApi: api, pool: new DebuggerSessionPool(api),
    sendCommand: (_target, method, params) => browser.call(method, params), redactText: redact });
  const start = await observations.control(1, owner, { action: 'start', console: false, network: false,
    events: ['navigation', 'popup', 'fileChooser', 'dialog', 'download'] });
  observationId = start.observationId; cursor = start.cursor;
  await browser.evaluate('history.pushState({}, "", "/spa#ready")');
  await check('SPA navigation is captured after registration', data => data.entries.some(entry => entry.sameDocument === true && entry.url.endsWith('/spa#ready')));
  await browser.navigate(origin + '/next');
  await check('Navigation and load state survive a document replacement', data => data.entries.some(entry => entry.sameDocument === false) && data.entries.some(entry => entry.loadState === 'load'));
  await browser.call('Runtime.evaluate', { expression: 'window.open("/popup", "_blank"); void 0', userGesture: true });
  await check('Popup request is retained without claiming the new tab', data => data.entries.some(entry => entry.kind === 'popup' && entry.tabCreationVerified === false));
  await browser.call('Runtime.evaluate', { expression: 'document.querySelector("#file").click()', userGesture: true });
  await check('Native file chooser opening is observed without intercepting files', data => data.entries.some(entry => entry.kind === 'fileChooser' && entry.fileSelectionIntercepted === false));
  await browser.call('Runtime.evaluate', { expression: 'setTimeout(()=>confirm("Fixture confirmation"),0)', userGesture: true });
  await check('Dialog opening is observed before its response', data => data.entries.some(entry => entry.event === 'Page.javascriptDialogOpening'));
  await browser.call('Page.handleJavaScriptDialog', { accept: false });
  await check('Dialog closure is observed without exposing prompt input', data => data.entries.some(entry => entry.event === 'Page.javascriptDialogClosed' && entry.accepted === false));
  // The download directory belongs to this isolated browser and is deleted
  // with its profile. Observation itself never changes download policy.
  await browser.call('Browser.setDownloadBehavior', { behavior: 'allow', downloadPath: join(browser.profile, 'fixture-downloads'), eventsEnabled: true });
  await browser.evaluate('const a=document.createElement("a");a.href="/download";a.download="companion-event-fixture.txt";document.body.append(a);a.click();a.remove()');
  await check('Click-triggered download events are observed', data => data.entries.some(entry => entry.kind === 'download' && entry.event === 'Page.downloadWillBegin'));
  await until(async () => (await readFile(join(browser.profile, 'fixture-downloads/companion-event-fixture.txt'), 'utf8').catch(() => null)) === 'owned fixture download', 'Fixture download file was not completed');
  receipt.downloadFixtureFileVerified = true;
  await browser.navigate(secondOrigin + '/');
  await check('New origin transition is captured before observation ends', data => data.status === 'stopped' && data.stopReason === 'page_origin_changed' && data.entries.some(entry => entry.url === secondOrigin + '/'));
  await browser.evaluate(`document.querySelector('#results').innerHTML=${JSON.stringify(receipt.cases.map(item => '<li>✓ ' + item.name + '</li>').join(''))}`);
  const screenshot = await browser.call('Page.captureScreenshot', { format: 'png' });
  await writeFile(join(output, 'verified.png'), Buffer.from(screenshot.data, 'base64'));
  receipt.result = 'passed';
} catch (error) { receipt.result = 'failed'; receipt.error = { message: error.message, code: error.code }; }
finally {
  await observations?.stopAll('fixture_complete').catch(() => {});
  await browser?.close(); receipt.cleanup.browserClosed = browser?.closed === true;
  await Promise.all([new Promise(resolve => server.close(resolve)), new Promise(resolve => secondServer.close(resolve))]); receipt.cleanup.serversClosed = true;
  receipt.finishedAt = new Date().toISOString();
  await writeFile(join(output, 'receipt.json'), JSON.stringify(receipt, null, 2));
  console.log(JSON.stringify({ result: receipt.result, cases: receipt.cases.length, error: receipt.error, receipt: join(output, 'receipt.json') }));
  if (receipt.result !== 'passed') process.exitCode = 1;
}
