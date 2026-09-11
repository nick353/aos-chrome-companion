import assert from 'node:assert/strict';
import vm from 'node:vm';
import { createServer } from 'node:http';
import { createHash } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { isolatedBrowser } from './lib/isolated-browser-fixture.mjs';
import { readCanvasVisualPatch, assertCanvasVisualPatchUnchanged } from '../src/shared/visual-canvas.mjs';

const output = resolve(process.argv[2] ?? '../verification/canvas-geometry-dom', new Date().toISOString().replaceAll(':', '-'));
await mkdir(output, { recursive: true });
const source = await readFile(new URL('../extension/service-worker.js', import.meta.url), 'utf8');
const slice = (start, end) => {
  const from = source.indexOf(start), to = source.indexOf(end, from);
  assert.ok(from >= 0 && to > from); return source.slice(from, to);
};
const injected = slice('async function injectedPageOperation(', '\nchrome.runtime.onMessage.addListener');
const html = `<!doctype html><meta charset="utf-8"><title>Canvas input fixture</title>
<style>body{font:18px system-ui;margin:0;padding:30px;background:#f4f7fb;color:#123451;min-height:1800px}canvas{display:block;margin-top:160px;background:white;touch-action:none}pre{white-space:pre-wrap}</style>
<h1>Companion canvas / viewport</h1><p>Owned fixture · real Chrome pixels and pointer events</p><pre id="result"></pre><canvas width="520" height="280"></canvas>
<script>
const canvas=document.querySelector('canvas'),ctx=canvas.getContext('2d');
window.state={x:100,y:80,clicks:0,drags:0,events:[]};
window.draw=()=>{ctx.fillStyle='#edf2fa';ctx.fillRect(0,0,520,280);ctx.fillStyle='#165ac2';ctx.fillRect(state.x-30,state.y-25,60,50);ctx.fillStyle='#172d4e';ctx.font='18px system-ui';ctx.fillText('Drag the blue rectangle',250,220);};
window.reset=()=>{Object.assign(state,{x:100,y:80,clicks:0,drags:0,events:[]});draw();};
const local=e=>{const r=canvas.getBoundingClientRect();return {x:(e.clientX-r.left)*520/r.width,y:(e.clientY-r.top)*280/r.height};};
let held=false;
canvas.addEventListener('pointerdown',e=>{const p=local(e);held=Math.abs(p.x-state.x)<=30&&Math.abs(p.y-state.y)<=25;state.events.push({type:e.type,buttons:e.buttons,trusted:e.isTrusted});});
canvas.addEventListener('pointermove',e=>{if(held){state.events.push({type:e.type,buttons:e.buttons,trusted:e.isTrusted});if(e.buttons===1){const p=local(e);state.x=p.x;state.y=p.y;state.drags++;draw();}}});
canvas.addEventListener('pointerup',e=>{state.events.push({type:e.type,buttons:e.buttons,trusted:e.isTrusted});held=false;});
canvas.addEventListener('click',e=>{const p=local(e);if(Math.abs(p.x-state.x)<=30&&Math.abs(p.y-state.y)<=25)state.clicks++;});
draw();</script>`;
const server = createServer((_request, response) => { response.writeHead(200, { 'content-type': 'text/html; charset=utf-8' }); response.end(html); });
const receipt = { schema: 'aos.chrome_companion.canvas_geometry_dom_canary.v1', startedAt: new Date().toISOString(),
  coverage: 'Production isolated-world point inspection, lossless region capture, canvas patch comparison and trusted-input function with real Chrome CDP. The Chrome API transport adapter is a fixture; installed Native Messaging is separate.',
  sourceDigest: createHash('sha256').update(source).digest('hex'), cases: [], cleanup: {} };
let browser;
const run = async (name, body) => {
  try { const evidence = await body(); receipt.cases.push({ name, passed: true, ...evidence }); }
  catch (error) { receipt.cases.push({ name, passed: false, error: { message: error.message, code: error.code } }); }
  console.log(JSON.stringify(receipt.cases.at(-1)));
};
try {
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const origin = `http://127.0.0.1:${server.address().port}`;
  browser = await isolatedBrowser({ width: 1100, height: 950 }); receipt.browser = browser.version;
  await browser.navigate(origin + '/');
  const context = {
    console, setTimeout, clearTimeout, Math, Number, String, Promise, Date,
    DEFAULT_SCREENSHOT_QUALITY: 60, MIN_SCREENSHOT_QUALITY: 35, MAX_SCREENSHOT_BYTES: 700000,
    companionError: (code, message, details) => Object.assign(Error(message), { code, details }),
    debuggerError: error => error, requireTrustedDebuggerAccess: async () => {},
    withTimeout: async promise => promise,
    debuggerSessions: { acquire: async () => ({ target: { tabId: 1 }, release: async () => {} }) },
    sendDebuggerCommand: (_target, method, params) => browser.call(method, params),
    runPageOperation: (_tab, action, payload) => browser.productionOperation(injected, action, payload),
    chrome: { tabs: { get: async () => ({ id: 1, windowId: 1 }), query: async () => [{ id: 1, windowId: 1 }], update: async () => browser.call('Page.bringToFront') },
      windows: { update: async () => {}, getLastFocused: async () => ({ id: 1 }) } },
  };
  const functions = vm.runInNewContext(
    slice('function requireVisualPoint(', 'function debuggerError(') +
    slice('async function withReadOnlyDebugger(', 'async function readNativeAccessibility(') +
    slice('async function captureDocumentScreenshot(', 'async function observeDebuggerEvents(') +
    slice('async function moveMouse(', 'function sameVisualTargetState(') +
    '\n({captureDocumentScreenshot,runTrustedVisualInput})', context);
  const point = () => browser.evaluate('(()=>{const r=document.querySelector("canvas").getBoundingClientRect();return {x:r.x+state.x*r.width/520,y:r.y+state.y*r.height/280}})()');
  const inspect = async p => browser.productionOperation(injected, 'inspectVisualPoint', { point: p ?? await point() });
  const patch = inspection => readCanvasVisualPatch({ inspection, secret: 'owned-canvas-fixture',
    capture: options => functions.captureDocumentScreenshot(1, options) });
  const click = p => functions.runTrustedVisualInput(1, 'visual.click', { point: p, allowedOrigins: [origin] });
  const baseline = await browser.evaluate('({width:innerWidth,height:innerHeight,dpr:devicePixelRatio,scale:visualViewport.scale})');

  await run('Fresh canvas pixels permit one trusted click', async () => {
    const before = await inspect(), saved = await patch(before), current = await patch(await inspect(before.point));
    assertCanvasVisualPatchUnchanged(saved, current); await click(before.point);
    const observed = await browser.evaluate('state'); assert.equal(observed.clicks, 1);
    assert.equal(observed.events.every(event => event.trusted), true); return { clicks: observed.clicks, clip: saved.clip };
  });
  await run('Canvas-only redraw invalidates the old point without another click', async () => {
    const before = await inspect(), saved = await patch(before);
    await browser.evaluate('state.x=240;draw()');
    const current = await patch(await inspect(before.point));
    assert.throws(() => assertCanvasVisualPatchUnchanged(saved, current), error => error.code === 'visual_canvas_content_changed');
    assert.equal((await browser.evaluate('state')).clicks, 1); return { inputDispatched: false };
  });
  await run('A fresh point after redraw selects the moved rectangle', async () => {
    const fresh = await inspect(); await patch(fresh); await click(fresh.point);
    assert.equal((await browser.evaluate('state')).clicks, 2); return { clicks: 2 };
  });
  await run('Trusted canvas drag keeps the held button throughout movement', async () => {
    await browser.evaluate('reset()'); const before = await inspect();
    const to = { x: before.point.x + 170, y: before.point.y + 50 };
    await functions.runTrustedVisualInput(1, 'visual.drag', { point: before.point, to, steps: 12, allowedOrigins: [origin] });
    const observed = await browser.evaluate('state');
    assert.ok(observed.drags >= 10, 'Pointer moves must retain buttons=1');
    assert.ok(Math.abs(observed.x - 270) <= 2 && Math.abs(observed.y - 130) <= 2, JSON.stringify(observed));
    assert.equal(observed.events.every(event => event.trusted), true); return { drags: observed.drags, x: observed.x, y: observed.y };
  });
  await run('Scroll changes geometry and a newly resolved point still clicks', async () => {
    await browser.evaluate('reset()'); const before = await inspect();
    await browser.evaluate('scrollTo(0,150)'); const after = await inspect();
    assert.notDeepEqual(after.scroll, before.scroll); assert.notEqual(after.point.y, before.point.y);
    await patch(after); await click(after.point); assert.equal((await browser.evaluate('state')).clicks, 1);
    return { before: before.scroll, after: after.scroll };
  });
  await run('A CSS canvas scale resolves the new visual rectangle', async () => {
    await browser.evaluate('scrollTo(0,0);reset();document.querySelector("canvas").style.transformOrigin="top left";document.querySelector("canvas").style.transform="scale(1.2)"');
    const current = await inspect(); await patch(current); await click(current.point);
    assert.equal((await browser.evaluate('state')).clicks, 1); return { surfaceRect: current.surfaceRect };
  });
  await run('Viewport and display density changes preserve CSS-coordinate input', async () => {
    await browser.evaluate('document.querySelector("canvas").style.transform="";reset()');
    await browser.call('Emulation.setDeviceMetricsOverride', { width: 900, height: 750, deviceScaleFactor: 2, mobile: false });
    const current = await inspect(); assert.equal(current.viewport.devicePixelRatio, 2); assert.equal(current.viewport.width, 900);
    await patch(current); await click(current.point); assert.equal((await browser.evaluate('state')).clicks, 1);
    return { viewport: current.viewport };
  });
  await run('Fixture viewport override restores original dimensions and density', async () => {
    await browser.call('Emulation.clearDeviceMetricsOverride');
    const restored = await browser.evaluate('({width:innerWidth,height:innerHeight,dpr:devicePixelRatio,scale:visualViewport.scale})');
    assert.deepEqual(restored, baseline); return { restored };
  });
  await browser.evaluate(`document.querySelector('#result').textContent=${JSON.stringify(receipt.cases.map(item => `${item.passed ? 'PASS' : 'FAIL'} ${item.name}`).join('\n'))};scrollTo(0,0)`);
  const screenshot = await browser.call('Page.captureScreenshot', { format: 'png', captureBeyondViewport: false });
  await writeFile(join(output, 'verified.png'), Buffer.from(screenshot.data, 'base64'));
  receipt.result = receipt.cases.every(item => item.passed) ? 'passed' : 'failed';
} catch (error) { receipt.result = 'failed'; receipt.error = { message: error.message, code: error.code }; }
finally {
  await browser?.close(); receipt.cleanup.browserClosed = browser?.closed === true;
  await new Promise(resolve => server.close(resolve)); receipt.cleanup.serverClosed = true;
  receipt.finishedAt = new Date().toISOString();
  await writeFile(join(output, 'receipt.json'), JSON.stringify(receipt, null, 2));
  console.log(JSON.stringify({ result: receipt.result, passed: receipt.cases.filter(item => item.passed).length,
    cases: receipt.cases.length, error: receipt.error, receipt: join(output, 'receipt.json') }));
  if (receipt.result !== 'passed') process.exitCode = 1;
}
