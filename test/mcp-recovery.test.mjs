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
import { PROTOCOL_VERSION, DEFAULT_CAPABILITIES } from '../src/shared/constants.mjs';
import { INSTALL_BUILD_ID } from '../src/shared/build-info.mjs';

for (const failure of ['socket', 'generation']) test(`MCP prepare_resume repairs ${failure} and binds the new session without browser dispatch`, async t => {
  const dataDir = await mkdtemp(join(tmpdir(), 'aos-mcp-resume-'));
  const env = { ...process.env, CODEX_THREAD_ID: 'resume-task',
    AOS_CHROME_COMPANION_DATA_DIR: dataDir, AOS_CHROME_COMPANION_SOCKET: join(dataDir, 'broker.sock'),
    AOS_CHROME_COMPANION_SECRET_FILE: join(dataDir, 'secret'),
    AOS_CHROME_COMPANION_CODEX_MCP_ISSUER_SECRET_FILE: join(dataDir, 'issuer'),
    AOS_CHROME_COMPANION_HANDOFF_RECEIPTS_DIR: join(dataDir, 'handoffs') };
  const secret = await ensureBrokerSecret(env);
  const issuerSecret = await ensureIssuerSecret('codex_mcp', env);
  const broker = new CompanionBroker({ socketPath: env.AOS_CHROME_COMPANION_SOCKET, secret,
    statePath: join(dataDir, 'ledger.json'), issuerSecrets: { codex_mcp: issuerSecret }, handoffReceiptsDir: env.AOS_CHROME_COMPANION_HANDOFF_RECEIPTS_DIR });
  await broker.listen();
  const extension = await connectPeer({ role: 'extension-relay', autoStart: false, env });
  const commands = [];
  extension.onMessage(message => { if (message.kind === 'command.request') commands.push(message.method); });
  async function hello(runtime) {
    const ack = new Promise(resolveAck => {
      const remove = extension.onMessage(message => { if (message.kind === 'extension.hello_ack') { remove(); resolveAck(message); } });
    });
    extension.send({ kind: 'extension.hello', protocolVersion: PROTOCOL_VERSION,
      profileInstanceId: 'original-profile', extensionRuntimeId: runtime, buildId: INSTALL_BUILD_ID, capabilities: DEFAULT_CAPABILITIES });
    await ack;
  }
  await hello('first-runtime');
  const transport = new StdioClientTransport({ command: process.execPath, args: [resolve('src/mcp/server.mjs')], cwd: resolve('.'), env, stderr: 'pipe' });
  const client = new Client({ name: 'resume-test', version: '1' });
  t.after(async () => { await client.close(); await transport.close(); extension.close(); await broker.close(); await rm(dataDir, { recursive: true, force: true }); });
  await client.connect(transport);
  const opened = await client.callTool({ name: 'companion_open_session', arguments: { profileInstanceId: 'original-profile' } });
  const sessionId = opened.structuredContent.result.sessionId;
  const oldLease = await client.callTool({ name: 'companion_reserve_tab', arguments: { sessionId, tabId: 808 } });
  if (failure === 'socket') {
    const peer = broker.peers.get(broker.sessions.get(sessionId).peerId);
    const closed = new Promise(resolveClose => peer.socket.once('close', resolveClose));
    peer.socket.destroy(); await closed;
  } else await hello('second-runtime');
  const resumed = await client.callTool({ name: 'companion_prepare_resume', arguments: { sessionId, runId: 'run' } });
  assert.notEqual(resumed.isError, true, JSON.stringify(resumed));
  const result = resumed.structuredContent.result;
  assert.equal(result.resume_ready, true);
  assert.equal(result.session_recovery.actions_replayed, 0);
  assert.notEqual(result.session_id, sessionId);
  assert.equal(result.profile_instance_id, 'original-profile');
  assert.deepEqual(commands, []);
  const reserved = await client.callTool({ name: 'companion_reserve_tab', arguments: { sessionId: result.session_id, tabId: 809 } });
  assert.notEqual(reserved.isError, true);
  const staleLease = await client.callTool({ name: 'companion_release_tab', arguments: { leaseId: oldLease.structuredContent.result.leaseId } });
  assert.equal(staleLease.isError, true);
  await client.callTool({ name: 'companion_release_tab', arguments: { leaseId: reserved.structuredContent.result.leaseId } });
  await client.callTool({ name: 'companion_close_session', arguments: { sessionId: result.session_id, taskTerminal: false } });
});
