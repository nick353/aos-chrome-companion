import { spawn } from 'node:child_process';
import { readFile, mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

export async function isolatedBrowser({ binary = process.env.COMPANION_TEST_BROWSER_BINARY ?? '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', width = 1100, height = 800,
  extensions = [], prepareProfile = null, headless = true, routeRequests = null } = {}) {
  const profile = await mkdtemp(join(tmpdir(), 'companion-isolated-fixture-'));
  try { await prepareProfile?.(profile); } catch (error) { await rm(profile, { recursive: true, force: true }); throw error; }
  const child = spawn(binary, [...(headless ? ['--headless=new'] : []), '--remote-debugging-port=0', '--user-data-dir=' + profile,
    ...(extensions.length ? ['--load-extension=' + extensions.join(',')] : []),
    '--no-first-run', '--no-default-browser-check', '--disable-background-networking', '--disable-component-update',
    '--disable-sync', `--window-size=${width},${height}`, 'about:blank'], { stdio: ['ignore', 'ignore', 'pipe'] });
  let socket, routingSocket, nextId = 0, stderr = '', closed = false, launchError;
  const pending = new Map(), eventListeners = new Set();
  child.stderr.on('data', data => { stderr = (stderr + data).slice(-4000); });
  child.on('error', error => { launchError = error; });
  const close = async () => {
    if (closed) return;
    closed = true;
    socket?.close();
    routingSocket?.close();
    for (const request of pending.values()) { clearTimeout(request.timer); request.reject(Error('Fixture closed')); }
    pending.clear();
    if (child.exitCode === null && child.signalCode === null && !launchError) {
      child.kill('SIGTERM');
      await Promise.race([new Promise(resolve => child.once('exit', resolve)), new Promise(resolve => setTimeout(resolve, 3000))]);
      if (child.exitCode === null && child.signalCode === null) {
        child.kill('SIGKILL'); await new Promise(resolve => child.once('exit', resolve));
      }
    }
    await rm(profile, { recursive: true, force: true });
  };
  try {
    let port;
    for (let attempt = 0; attempt < 600; attempt += 1) {
      if (launchError) throw launchError;
      if (child.exitCode !== null || child.signalCode !== null) throw Error('Fixture browser exited: ' + stderr);
      try { port = Number((await readFile(join(profile, 'DevToolsActivePort'), 'utf8')).split('\n')[0]); break; }
      catch { await new Promise(resolve => setTimeout(resolve, 100)); }
    }
    if (!port) throw Error('Fixture browser endpoint unavailable');
    if (routeRequests) {
      // Optional deterministic fixture transport. It affects only this newly
      // launched test browser. The real extension/Native Messaging/broker and
      // renderer run unchanged, but the receipt must identify mocked network.
      const endpoint = await (await fetch(`http://127.0.0.1:${port}/json/version`)).json();
      routingSocket = new WebSocket(endpoint.webSocketDebuggerUrl);
      await new Promise((resolve, reject) => { routingSocket.addEventListener('open', resolve, { once: true }); routingSocket.addEventListener('error', reject, { once: true }); });
      const routingPending = new Map(); let routingId = 0;
      const routeCall = (method, params = {}, sessionId) => new Promise((resolve, reject) => {
        const id = ++routingId;
        const timer = setTimeout(() => { routingPending.delete(id); reject(Error('Fixture routing timeout: ' + method)); }, 10000);
        routingPending.set(id, { resolve, reject, timer });
        routingSocket.send(JSON.stringify({ id, method, params, ...(sessionId ? { sessionId } : {}) }));
      });
      routingSocket.addEventListener('close', () => { for (const p of routingPending.values()) { clearTimeout(p.timer); p.reject(Error('Fixture routing closed')); } routingPending.clear(); });
      routingSocket.addEventListener('message', event => {
        const message = JSON.parse(event.data);
        const request = routingPending.get(message.id);
        if (request) { routingPending.delete(message.id); clearTimeout(request.timer); message.error ? request.reject(Error(message.error.message)) : request.resolve(message.result); return; }
        const handle = async () => {
          if (message.method === 'Target.attachedToTarget') {
            const { sessionId, targetInfo } = message.params;
            if (targetInfo.type === 'page') await routeCall('Fetch.enable', { patterns: [{ urlPattern: 'http://127.0.0.1:*/*', requestStage: 'Request' }] }, sessionId);
            await routeCall('Runtime.runIfWaitingForDebugger', {}, sessionId);
          }
          if (message.method === 'Fetch.requestPaused') {
            const response = await routeRequests(message.params.request);
            if (response) await routeCall('Fetch.fulfillRequest', { requestId: message.params.requestId,
              responseCode: response.status ?? 200,
              responseHeaders: Object.entries(response.headers ?? {}).map(([name, value]) => ({ name, value: String(value) })),
              body: Buffer.from(response.body ?? '').toString('base64') }, message.sessionId);
            else await routeCall('Fetch.continueRequest', { requestId: message.params.requestId }, message.sessionId);
          }
        };
        void handle().catch(error => { stderr = (stderr + '\nFixture routing: ' + error.message).slice(-4000); });
      });
      await routeCall('Target.setAutoAttach', { autoAttach: true, waitForDebuggerOnStart: true, flatten: true,
        filter: [{ type: 'page', exclude: false }] });
    }
    const tabs = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json();
    socket = new WebSocket(tabs.find(tab => tab.type === 'page').webSocketDebuggerUrl);
    await new Promise((resolve, reject) => { socket.addEventListener('open', resolve, { once: true }); socket.addEventListener('error', reject, { once: true }); });
    socket.addEventListener('message', event => {
      const message = JSON.parse(event.data);
      if (message.method) { for (const listener of eventListeners) listener(message.method, message.params ?? {}); return; }
      const request = pending.get(message.id);
      if (!request) return;
      pending.delete(message.id); clearTimeout(request.timer);
      message.error ? request.reject(Object.assign(Error(message.error.message), { details: message.error })) : request.resolve(message.result);
    });
    const call = (method, params = {}) => new Promise((resolve, reject) => {
      const id = ++nextId;
      const timer = setTimeout(() => { pending.delete(id); reject(Error('CDP timeout: ' + method)); }, 20000);
      pending.set(id, { resolve, reject, timer }); socket.send(JSON.stringify({ id, method, params }));
    });
    const evaluate = async (expression, contextId) => {
      const result = await call('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true, ...(contextId ? { contextId } : {}) });
      if (result.exceptionDetails) throw Error(JSON.stringify(result.exceptionDetails));
      return result.result.value;
    };
    const navigate = async url => {
      const navigation = await call('Page.navigate', { url });
      if (navigation.errorText) throw Error('Fixture navigation failed: ' + navigation.errorText);
      for (let attempt = 0; attempt < 200; attempt += 1) {
        try { if (await evaluate('document.readyState === "complete" && location.href === ' + JSON.stringify(url))) return; } catch { /* renderer in transition */ }
        await new Promise(resolve => setTimeout(resolve, 25));
      }
      throw Error('Fixture navigation did not settle');
    };
    const productionOperation = async (source, action, payload = {}) => {
      const { frameTree } = await call('Page.getFrameTree');
      const { executionContextId } = await call('Page.createIsolatedWorld', { frameId: frameTree.frame.id, worldName: 'companion-production-fixture' });
      const result = await evaluate(`(${source})(${JSON.stringify(action)},${JSON.stringify(payload)})`, executionContextId);
      if (result?.__aosCompanionError) {
        const error = result.__aosCompanionError;
        throw Object.assign(Error(error.message), { code: error.code, details: error.details });
      }
      return result;
    };
    await call('Page.enable');
    return { call, evaluate, navigate, productionOperation, close, debuggingPort: port, profile,
      subscribeEvents(listener) { eventListeners.add(listener); return () => eventListeners.delete(listener); },
      version: await call('Browser.getVersion'), get closed() { return closed; }, get stderr() { return stderr; } };
  } catch (error) { await close(); throw error; }
}
