import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import test from 'node:test';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { CompanionBroker } from '../src/broker/broker.mjs';
import { connectPeer } from '../src/client/connect.mjs';
import { ensureBrokerSecret } from '../src/shared/security.mjs';
import { ensureIssuerSecret } from '../src/shared/task-runtime.mjs';
import { DEFAULT_CAPABILITIES, PROTOCOL_VERSION } from '../src/shared/constants.mjs';
import { INSTALL_BUILD_ID } from '../src/shared/build-info.mjs';

// Real MCP child processes and broker persistence; the browser relay is a
// deterministic double. Installed Chrome continuation is a separate canary.
const origin = 'https://resume.example.test';
const taskId = 'mcp-process-resume-owner';
const profileInstanceId = 'mcp-process-resume-profile';
const imageData = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+a3ioAAAAASUVORK5CYII=';
const delay = ms => new Promise(resolveDelay => setTimeout(resolveDelay, ms));

async function until(predicate, message) {
  for (let i = 0; i < 200; i++) {
    if (predicate()) return;
    await delay(10);
  }
  assert.fail(message);
}

for (const shutdown of ['close', 'SIGKILL']) {
  for (const effect of ['partial', 'unknown', 'unknown_first']) {
    test(`fresh MCP process after ${shutdown} preserves ${effect} progress without replay`, { timeout: 30_000 }, async t => {
      const isUnknown = effect !== 'partial';
      const firstUncertain = effect === 'unknown_first';
      const dataDir = await mkdtemp(join(tmpdir(), 'aos-mcp-process-'));
      const env = { ...process.env, CODEX_THREAD_ID: taskId,
        AOS_CHROME_COMPANION_DATA_DIR: dataDir,
        AOS_CHROME_COMPANION_SOCKET: join(dataDir, 'broker.sock'),
        AOS_CHROME_COMPANION_SECRET_FILE: join(dataDir, 'secret'),
        AOS_CHROME_COMPANION_CODEX_MCP_ISSUER_SECRET_FILE: join(dataDir, 'issuer'),
        AOS_CHROME_COMPANION_HANDOFF_RECEIPTS_DIR: join(dataDir, 'handoffs') };
      const secret = await ensureBrokerSecret(env);
      const issuerSecret = await ensureIssuerSecret('codex_mcp', env);
      const broker = new CompanionBroker({ socketPath: env.AOS_CHROME_COMPANION_SOCKET, secret,
        statePath: join(dataDir, 'ledger.json'), issuerSecrets: { codex_mcp: issuerSecret },
        handoffReceiptsDir: env.AOS_CHROME_COMPANION_HANDOFF_RECEIPTS_DIR });
      const children = [];
      let extension;
      t.after(async () => {
        for (const child of children) { await child.client.close(); await child.transport.close(); }
        extension?.close();
        await broker.close();
        await rm(dataDir, { recursive: true, force: true });
      });
      await broker.listen();
      extension = await connectPeer({ role: 'extension-relay', autoStart: false, env });
      const ack = new Promise(resolveAck => {
        const off = extension.onMessage(message => { if (message.kind === 'extension.hello_ack') { off(); resolveAck(message); } });
      });
      extension.send({ kind: 'extension.hello', protocolVersion: PROTOCOL_VERSION, profileInstanceId,
        extensionRuntimeId: 'unchanged-browser-runtime', buildId: INSTALL_BUILD_ID, capabilities: DEFAULT_CAPABILITIES });
      await ack;
      const tabs = new Map();
      const commands = [];
      let secondAvailable = false;
      extension.onMessage(message => {
        if (message.kind !== 'command.request') return;
        commands.push(message);
        const { method, params = {}, operationId } = message;
        const reply = result => extension.send({ kind: 'command.result', operationId, result });
        const tab = tabs.get(params.tabId);
        if (method === 'tabs.list') return reply([...tabs.values()]);
        if (method === 'tabs.create') {
          const created = { id: 11001, windowId: 1, active: false, pinned: false, groupId: null,
            url: params.url, title: 'resume fixture', first: '', second: '' };
          tabs.set(created.id, created); return reply(created);
        }
        if (method === 'tabs.groupTask') { tab.groupId = 17; return reply(tab); }
        if (method === 'tabs.close') { tabs.delete(params.tabId); return reply({ closed: true, tabId: params.tabId }); }
        if (method === 'tabs.navigate') { tab.url = params.url; tab.first = ''; tab.second = ''; return reply(tab); }
        if (method === 'page.snapshot') return reply({ url: tab.url, title: tab.title, readyState: 'complete',
          text: `${tab.first}|${tab.second}`, pageInstanceId: 'same-document', controls: [] });
        if (method === 'page.query') return reply({ url: tab.url, pageInstanceId: 'same-document', count: 1,
          matches: [{ tag: 'p', text: `${tab.first}|${tab.second}` }] });
        if (method === 'visual.inspectTarget') return reply({ url: tab.url, pageInstanceId: 'same-document',
          element: { tag: 'input', role: 'textbox', name: params.locator.testId, testId: params.locator.testId },
          rect: { x: 10, y: 10, width: 300, height: 40 }, clippedRect: { x: 10, y: 10, width: 300, height: 40 },
          point: { x: 160, y: 30 }, viewport: { width: 1200, height: 800, devicePixelRatio: 1 } });
        if (method === 'page.screenshot') return reply({ kind: 'screenshot', mimeType: 'image/png',
          dataBase64: imageData, tabId: tab.id, windowId: 1, url: tab.url, capturedAt: new Date().toISOString() });
        if (method === 'page.type') {
          const field = params.locator.testId;
          if (field === (firstUncertain ? 'first' : 'second') && !secondAvailable) {
            if (isUnknown) tab[field] = params.text;
            extension.send({ kind: 'command.error', operationId, error: {
              code: isUnknown ? 'operation_effect_unknown' : 'semantic_locator_not_found',
              message: 'controlled field failure',
              details: { operationEffectState: isUnknown ? 'unknown' : 'none', mutationDispatchAttempted: isUnknown },
            } });
            return;
          }
          tab[field] = params.text; return reply({ typed: true, value: params.text });
        }
        extension.send({ kind: 'command.error', operationId, error: { code: 'test_unhandled_command', message: method } });
      });
      async function openProcess() {
        const transport = new StdioClientTransport({ command: process.execPath, args: [resolve('src/mcp/server.mjs')],
          cwd: resolve('.'), env, stderr: 'pipe' });
        const client = new Client({ name: 'process-resume-test', version: '1' });
        const child = { client, transport };
        children.push(child);
        await client.connect(transport);
        return { ...child, pid: transport.pid, call: (name, args) => client.callTool({ name, arguments: args }) };
      }
      function success(result) {
        assert.notEqual(result.isError, true, JSON.stringify(result));
        return result.structuredContent.result;
      }
      const first = await openProcess();
      const session = success(await first.call('companion_open_session', { profileInstanceId }));
      const actions = [
        { method: 'page.type', params: { locator: { testId: 'first' }, text: '保持する日本語\n第二行😀', clear: true } },
        { method: 'page.type', params: { locator: { testId: 'second' }, text: '残りの入力', clear: true } },
      ];
      const transaction = { sessionId: session.sessionId, runId: 'process-resume-run', idempotencyKey: 'first-attempt',
        startUrl: `${origin}/form`, allowedOrigins: [origin], actions };
      const initialResponse = await first.call('companion_authorized_transaction', transaction);
      const original = success(initialResponse);
      const summaryText = JSON.parse(initialResponse.content.find(block => block.type === 'text').text);
      assert.equal(summaryText.response_detail, 'summary');
      for (const key of ['result', 'action_progress', 'effect_state', 'exact_blocker', 'cleanup']) assert.deepEqual(summaryText[key], original[key]);
      assert.equal(summaryText.capsule.capsuleId, original.capsule.capsuleId);
      assert.equal(original.result, isUnknown ? 'unknown_effect' : 'blocked');
      assert.deepEqual(original.action_progress.applied_action_indices, firstUncertain ? [] : [0], JSON.stringify({ blocker: original.exact_blocker, commands: commands.map(command => command.method) }));
      assert.deepEqual(original.action_progress.remaining_action_indices, effect === 'partial' || firstUncertain ? [1] : []);
      if (firstUncertain) {
        assert.deepEqual(original.action_progress.uncertain_action_indices, [0]);
        assert.equal(original.cleanup.retained, true);
        assert.equal(broker.taskLedger.getTaskTab(profileInstanceId, original.tab.id).retentionReason, 'local_ui_effect_unknown');
      }
      const firstText = tabs.get(original.tab.id).first;
      assert.equal(firstText, actions[0].params.text);
      const beforeAudit = commands.length;
      const audited = success(await first.call('companion_transaction_status', { sessionId: session.sessionId, runId: transaction.runId, audit: { limit: 1 } }));
      assert.equal(audited.audit.returnedCount, 1);
      assert.ok(audited.audit.nextCursor);
      assert.equal(commands.length, beforeAudit, 'MCP audit must not dispatch browser work');
      const oldLease = success(await first.call('companion_reserve_tab', { sessionId: session.sessionId, tabId: original.tab.id }));
      if (shutdown === 'SIGKILL') process.kill(first.pid, 'SIGKILL');
      else await first.client.close();
      await until(() => !broker.sessions.has(session.sessionId), 'the original MCP process session must terminate');
      assert.equal(broker.leases.has(oldLease.leaseId), false);
      if (firstUncertain) assert.equal(broker.taskLedger.getTaskTab(profileInstanceId, original.tab.id).retentionPolicy, 'retain_until_resume');
      const second = await openProcess();
      assert.notEqual(second.pid, first.pid);
      const oldSession = await second.call('companion_prepare_resume', { sessionId: session.sessionId, runId: transaction.runId });
      assert.equal(oldSession.isError, true);
      assert.match(oldSession.content[0].text, /mcp_session_task_binding_missing/u);
      const fresh = success(await second.call('companion_open_session', { profileInstanceId }));
      const commandCount = commands.length;
      const nextPage = success(await second.call('companion_transaction_status', { sessionId: fresh.sessionId, runId: transaction.runId,
        audit: { limit: 1, cursor: audited.audit.nextCursor } }));
      assert.notEqual(nextPage.audit.entries[0].idempotencyKey, audited.audit.entries[0].idempotencyKey);
      assert.equal(commands.length, commandCount, 'the audit cursor survives MCP replacement without a browser command');
      const resumed = success(await second.call('companion_prepare_resume', { sessionId: fresh.sessionId,
        runId: transaction.runId, idempotencyKey: transaction.idempotencyKey, capsuleId: original.capsule.capsuleId }));
      assert.equal(commands.length, commandCount, 'resume preparation must not dispatch browser operations');
      assert.deepEqual(resumed.action_progress, original.action_progress);
      assert.equal(resumed.replay_allowed, false);
      assert.equal(resumed.profile_instance_id, profileInstanceId);
      assert.equal(tabs.get(original.tab.id).first, firstText);
      if (isUnknown) {
        assert.equal(resumed.resume_ready, false);
        assert.ok(resumed.blockers.some(blocker => blocker.code === 'reconciliation_required'));
        assert.equal(broker.taskLedger.getTaskCapsule(original.capsule.capsuleId).effect.effectState, 'unknown_effect');
      } else {
        assert.equal(resumed.resume_ready, true, JSON.stringify(resumed.blockers));
        assert.equal(resumed.target_reservation.arguments.tabId, original.tab.id);
        const lease = success(await second.call('companion_reserve_tab', resumed.target_reservation.arguments));
        const read = success(await second.call('companion_read_page', { sessionId: fresh.sessionId, leaseId: lease.leaseId, tabId: original.tab.id }));
        assert.ok(JSON.stringify(read).includes('保持する日本語'));
        await second.call('companion_release_tab', { leaseId: lease.leaseId });
        secondAvailable = true;
        const finishedResponse = await second.call('companion_authorized_transaction', { ...transaction,
          sessionId: fresh.sessionId, tabId: original.tab.id, idempotencyKey: 'remaining-only',
          responseDetail: 'full', actions: resumed.action_progress.remaining_action_indices.map(index => actions[index]) });
        const finished = success(finishedResponse);
        assert.deepEqual(JSON.parse(finishedResponse.content.find(block => block.type === 'text').text), finished);
        assert.equal(finished.result, 'verified', JSON.stringify(finished.exact_blocker));
        assert.equal(finished.cleanup.closed, true);
        assert.equal(tabs.has(original.tab.id), false);
        assert.equal(commands.filter(command => command.method === 'tabs.create').length, 1);
        assert.equal(commands.filter(command => command.method === 'tabs.navigate').length, 0);
      }
      assert.equal(commands.filter(command => command.method === 'page.type' && command.params.locator.testId === 'first').length, 1);
      assert.equal(commands.filter(command => command.method === 'page.type' && command.params.locator.testId === 'second').length, effect === 'partial' ? 2 : firstUncertain ? 0 : 1);
      const foreign = await second.call('companion_prepare_resume', { sessionId: fresh.sessionId,
        taskId: 'different-owner', runId: transaction.runId, capsuleId: original.capsule.capsuleId });
      assert.equal(foreign.isError, true);
      assert.match(foreign.content[0].text, /task_id_mismatch/u);
      await second.call('companion_close_session', { sessionId: fresh.sessionId, taskTerminal: false });
    });
  }
}
