import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { createHash } from 'node:crypto';
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import { isolatedBrowser } from './lib/isolated-browser-fixture.mjs';
import { readSubmissionTransition, captureTransactionReadback } from '../src/shared/transaction-readback.mjs';

const out = resolve(process.argv[2] ?? 'work/submission-readback-dom', new Date().toISOString().replaceAll(':', '-'));
await mkdir(out, { recursive: true });
const source = await readFile(new URL('../extension/service-worker.js', import.meta.url), 'utf8');
const start = source.indexOf('async function injectedPageOperation(');
const injected = source.slice(start, source.indexOf('\nchrome.runtime.onMessage.addListener', start));
const requests = [];
const page = `<!doctype html><meta charset="utf-8"><title>Submission readback regression</title>
<style>body{font:18px system-ui;padding:32px;background:#eef4fa;color:#20364c}button{padding:14px 24px}#status{padding:24px;border:1px solid #a6b8ca;background:white}pre{line-height:1.8}</style>
<h1>Submission readback regression</h1><p>Isolated Chrome, local fixture, no real applications.</p>
<form><label>Name <input value="Fixture applicant"></label><button id="submit" type="submit">Submit fixture</button></form>
<p id="status">Application form</p><pre id="results"></pre><script>
const mode = new URL(location.href).searchParams.get('mode');
document.querySelector('form').addEventListener('submit', async event => {
 event.preventDefault(); await fetch('/submit?mode='+mode,{method:'POST',body:'synthetic application'});
 if(mode==='unchanged')return;
 setTimeout(()=>{document.querySelector('#status').textContent='Application received: '+mode;
 if(mode==='navigate')history.pushState({},'', '/received?mode='+mode);},250);
});</script>`;
const server = createServer(async (request, response) => {
  if (request.url.startsWith('/submit')) { let body = ''; for await (const chunk of request) body += chunk; requests.push({ url: request.url, sha256: createHash('sha256').update(body).digest('hex') }); response.writeHead(201); response.end('received'); }
  else { response.writeHead(200, { 'content-type': 'text/html; charset=utf-8' }); response.end(page); }
});
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
const origin = `http://127.0.0.1:${server.address().port}`;
const receipt = { startedAt: new Date().toISOString(), sourceDigest: createHash('sha256').update(source).digest('hex'),
  coverage: 'Production isolated-world page click/snapshot and production broker readback helpers; actual local HTTP submission count. Native-host/installed transport remains a separate check.', cases: [] };
let browser;
try {
  browser = await isolatedBrowser(); receipt.browser = browser.version;
  for (const mode of ['delayed', 'navigate', 'capture_race', 'unchanged']) {
    await browser.navigate(`${origin}/?mode=${mode}`);
    const readSnapshot = () => browser.productionOperation(injected, 'snapshot', { maxTextChars: 30000 });
    const before = await readSnapshot();
    const requestCount = requests.length;
    const clicked = await browser.productionOperation(injected, 'click', { locator: { css: '#submit' }, allowedOrigins: [origin] });
    assert.equal(clicked.formSubmitControl, true);
    const transition = await readSubmissionTransition({ before, readSnapshot, allowedOrigins: [origin], timeoutMs: 1500 });
    let captures = 0;
    const captured = await captureTransactionReadback({ initialSnapshot: transition.after, readSnapshot, allowedOrigins: [origin],
      takeScreenshot: async () => {
        if (mode === 'capture_race' && ++captures === 1) throw Object.assign(Error('Controlled capture race after real submission'), { code: 'screenshot_target_changed' });
        const image = await browser.call('Page.captureScreenshot', { format: 'png' });
        return { kind: 'screenshot', dataBase64: image.data, url: await browser.evaluate('location.href') };
      } });
    const submissions = requests.length - requestCount;
    const passed = submissions === 1 && transition.transitionObserved === (mode !== 'unchanged')
      && captured.visual.url === captured.after.url && (mode !== 'capture_race' || captured.attempts === 2);
    receipt.cases.push({ mode, passed, submissions, transitionObserved: transition.transitionObserved, readAttempts: transition.attempts, captureAttempts: captured.attempts, finalUrl: captured.after.url });
  }
  await browser.evaluate('document.querySelector("#results").textContent=' + JSON.stringify(receipt.cases.map(item => `${item.passed ? 'PASS' : 'FAIL'} ${item.mode}: ${item.submissions} submission`).join('\n')));
  const image = await browser.call('Page.captureScreenshot', { format: 'png', captureBeyondViewport: true });
  receipt.image = join(out, 'verified.png'); await writeFile(receipt.image, Buffer.from(image.data, 'base64'));
  receipt.httpReceipts = requests; receipt.result = receipt.cases.every(item => item.passed) ? 'passed' : 'failed';
} catch (error) { receipt.result = 'failed'; receipt.error = { code: error.code, message: error.message }; }
finally {
  await browser?.close(); await new Promise(resolve => server.close(resolve));
  receipt.testChromeClosed = browser?.closed ?? true; receipt.finishedAt = new Date().toISOString();
  await writeFile(join(out, 'receipt.json'), JSON.stringify(receipt, null, 2));
  console.log(JSON.stringify({ result: receipt.result, cases: receipt.cases, record: join(out, 'receipt.json'), image: receipt.image, testChromeClosed: receipt.testChromeClosed, error: receipt.error }));
  if (receipt.result !== 'passed') process.exitCode = 1;
}
