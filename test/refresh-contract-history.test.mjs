import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { chmod, lstat, mkdir, mkdtemp, readFile, readdir, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, relative, sep } from 'node:path';
import test from 'node:test';
import { verifyInstalledRefreshContract, saveRefreshContractHistory, readRefreshContractHistory,
  historicalRefreshContractMatches } from '../src/shared/refresh-contract-history.mjs';
import { operationSchemaDocument } from '../src/shared/operation-schema.mjs';
import { CompanionBroker } from '../src/broker/broker.mjs';
import { BrokerClient } from '../src/client/broker-client.mjs';
import { connectPeer } from '../src/client/connect.mjs';
import { ensureBrokerSecret } from '../src/shared/security.mjs';
import { INSTALL_BUILD_ID, BUNDLE_TREE_SHA256, EXTENSION_TREE_SHA256, NATIVE_RECORDER_SHA256 } from '../src/shared/build-info.mjs';

const sha = value => createHash('sha256').update(value).digest('hex');
function contract() {
  const doc = structuredClone(operationSchemaDocument());
  doc.methods = doc.methods.filter(item => !['tabs.stopLoading', 'tabs.navigationDiagnostics'].includes(item.method));
  doc.capabilities = doc.methods.map(item => item.method);
  doc.schemaDigest = sha(JSON.stringify({ schema: doc.schema, version: doc.version, methods: doc.methods,
    authorizedTransactionMethods: doc.authorizedTransactionMethods, actionEvents: doc.actionEvents }));
  return doc;
}
// Independent copy of the installer's exact manifest ordering/exclusions.
async function installerHashTree(root, excluded = new Set()) {
  const files = [];
  async function visit(directory) {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      const path = join(directory, entry.name), relativePath = relative(root, path).split(sep).join('/');
      if (relativePath.split('/').includes('node_modules') || excluded.has(relativePath)) continue;
      if (entry.isSymbolicLink()) throw new Error('fixture symlink');
      if (entry.isDirectory()) await visit(path);
      else if (entry.isFile()) files.push({ path, relativePath });
    }
  }
  await visit(root);
  files.sort((a, b) => a.relativePath.localeCompare(b.relativePath));
  const hash = createHash('sha256');
  for (const file of files) hash.update(`${file.relativePath}\0${sha(await readFile(file.path))}\n`, 'utf8');
  return hash.digest('hex');
}
async function fixture(t, buildId = `install-${randomUUID()}`, doc = contract()) {
  const dir = await mkdtemp(join(tmpdir(), 'companion-refresh-history-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const app = join(dir, 'app');
  for (const path of ['src/shared', 'extension', 'node_modules/ignored']) await mkdir(join(app, path), { recursive: true, mode: 0o700 });
  await writeFile(join(app, 'src/shared/constants.mjs'), 'export const PROTOCOL_VERSION = "0.1.0";\n');
  await writeFile(join(app, 'extension/operation-schema.generated.json'), JSON.stringify(doc));
  await writeFile(join(app, 'native-recording-bin'), 'independent native fixture');
  await writeFile(join(app, 'node_modules/ignored/ignored'), 'excluded');
  const hashes = { bundleTreeSha256: await installerHashTree(app, new Set(['src/shared/build-info.mjs', 'extension/build-info.js', 'build-manifest.json'])),
    extensionTreeSha256: await installerHashTree(join(app, 'extension'), new Set(['build-info.js'])),
    nativeRecorderSha256: sha(await readFile(join(app, 'native-recording-bin'))) };
  const info = `export const INSTALL_BUILD_ID = ${JSON.stringify(buildId)};\nexport const BUNDLE_TREE_SHA256 = "${hashes.bundleTreeSha256}";\nexport const EXTENSION_TREE_SHA256 = "${hashes.extensionTreeSha256}";\nexport const NATIVE_RECORDER_SHA256 = "${hashes.nativeRecorderSha256}";\nthrow new Error("never execute historical code");\n`;
  await writeFile(join(app, 'src/shared/build-info.mjs'), info);
  await writeFile(join(app, 'extension/build-info.js'), info);
  await writeFile(join(app, 'build-manifest.json'), JSON.stringify({ schema: 'aos_chrome_companion_build_manifest.v1', buildId, ...hashes }));
  const expected = { expectedBuildId: buildId, expectedOperationSchemaDigest: doc.schemaDigest,
    expectedBundleTreeSha256: hashes.bundleTreeSha256, expectedExtensionTreeSha256: hashes.extensionTreeSha256,
    expectedNativeRecorderSha256: hashes.nativeRecorderSha256 };
  const record = await verifyInstalledRefreshContract(app, expected);
  return { dir, app, hashes, record, expected, historyPath: join(dir, 'refresh-contract-history.json') };
}

test('refresh history verifier hashes actual installed trees and parses literals without executing historical code', async t => {
  const { app, hashes, record, expected } = await fixture(t);
  for (const [field, value] of Object.entries(hashes)) assert.equal(record[field], value);
  assert.equal(record.operationSchemaDigest, expected.expectedOperationSchemaDigest);
  await assert.rejects(verifyInstalledRefreshContract(app, { ...expected, expectedBuildId: `install-${randomUUID()}` }));
  await assert.rejects(verifyInstalledRefreshContract(app, { ...expected, expectedBundleTreeSha256: 'f'.repeat(64) }));
  await writeFile(join(app, 'extension/changed.js'), 'changed actual tree');
  await assert.rejects(verifyInstalledRefreshContract(app, expected));
});

test('refresh history supports dev-local bootstrap with the same exact verified tuple only', async t => {
  const { record, historyPath } = await fixture(t, 'dev-local');
  await saveRefreshContractHistory(historyPath, record);
  assert.equal(historicalRefreshContractMatches((await readRefreshContractHistory(historyPath)).records[0], record), true);
  assert.equal(historicalRefreshContractMatches(record, { ...record, buildId: `install-${randomUUID()}` }), false);
});

test('refresh history atomically retains three distinct verified tuples and survives fresh reads', async t => {
  const { record, historyPath } = await fixture(t);
  for (let index = 0; index < 4; index++) await saveRefreshContractHistory(historyPath,
    { ...record, buildId: `install-00000000-0000-0000-0000-00000000000${index}` });
  const saved = await readRefreshContractHistory(historyPath);
  assert.equal(saved.records.length, 3);
  assert.equal(saved.records[0].buildId.endsWith('1'), true);
  await saveRefreshContractHistory(historyPath, saved.records[1]);
  assert.equal((await readRefreshContractHistory(historyPath)).records.length, 3);
  assert.equal((await lstat(historyPath)).mode & 0o777, 0o600);
  assert.equal((await readdir(dirname(historyPath))).some(name => name.endsWith('.tmp')), false);
});

test('refresh history rejects missing truncated tampered insecure and symlink files without replacing them', async t => {
  const { dir, record, historyPath } = await fixture(t);
  await assert.rejects(readRefreshContractHistory(historyPath), { code: 'ENOENT' });
  await saveRefreshContractHistory(historyPath, record);
  const saved = await readFile(historyPath, 'utf8');
  for (const patch of [{ operationSchemaDigest: 'f'.repeat(64) }, { capabilities: ['extension.reload'] },
    { verificationVersion: 2 }, { operationSchemaVersion: 2 }, { protocolVersion: '0.2.0' },
    { operationContract: { ...record.operationContract, methods: record.operationContract.methods.filter(item => item.method !== 'extension.reload') } }]) {
    await writeFile(historyPath, JSON.stringify({ schema: 'companion_refresh_contract_history.v1', records: [{ ...record, ...patch }] }));
    await assert.rejects(readRefreshContractHistory(historyPath));
  }
  await writeFile(historyPath, '{"schema":');
  await assert.rejects(saveRefreshContractHistory(historyPath, record));
  assert.equal(await readFile(historyPath, 'utf8'), '{"schema":');
  await writeFile(historyPath, saved);
  await chmod(historyPath, 0o666);
  await assert.rejects(readRefreshContractHistory(historyPath));
  await chmod(historyPath, 0o600);
  const link = join(dir, 'linked-history.json');
  await symlink(historyPath, link);
  await assert.rejects(readRefreshContractHistory(link));
  await assert.rejects(saveRefreshContractHistory(link, record));
  await chmod(dir, 0o755);
  await assert.rejects(readRefreshContractHistory(historyPath));
  await chmod(dir, 0o700);
});

test('refresh tuple matching denies partial unknown forged hashes and reload-incompatible contracts', async t => {
  const { record } = await fixture(t);
  assert.equal(historicalRefreshContractMatches(record, record), true);
  for (const field of ['buildId', 'protocolVersion', 'operationSchema', 'operationSchemaVersion', 'operationSchemaDigest',
    'capabilities', 'capabilitiesDigest', 'bundleTreeSha256', 'extensionTreeSha256', 'nativeRecorderSha256']) {
    assert.equal(historicalRefreshContractMatches(record, { ...record, [field]: undefined }), false);
  }
  assert.equal(historicalRefreshContractMatches(record, { ...record, bundleTreeSha256: 'f'.repeat(64) }), false);
  const invalid = structuredClone(record);
  invalid.operationContract.methods.find(item => item.method === 'extension.reload').mutation = false;
  assert.equal(historicalRefreshContractMatches(invalid, invalid), false);
});

function once(peer, predicate) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => { remove(); reject(new Error('fixture message timeout')); }, 3000);
    const remove = peer.onMessage(message => { if (predicate(message)) { clearTimeout(timer); remove(); resolve(message); } });
  });
}

test('verified historical contract registers refresh-only ACK, denies ordinary operations and reloads once into current generation', async t => {
  const { dir, record, historyPath } = await fixture(t, INSTALL_BUILD_ID);
  await saveRefreshContractHistory(historyPath, record);
  const env = { ...process.env, AOS_CHROME_COMPANION_DATA_DIR: dir, AOS_CHROME_COMPANION_SOCKET: join(dir, 'broker.sock'),
    AOS_CHROME_COMPANION_SECRET_FILE: join(dir, 'secret'), AOS_CHROME_COMPANION_CODEX_MCP_ISSUER_SECRET_FILE: join(dir, 'issuer') };
  await writeFile(env.AOS_CHROME_COMPANION_CODEX_MCP_ISSUER_SECRET_FILE, 'fixture-issuer\n', { mode: 0o600 });
  const secret = await ensureBrokerSecret(env);
  const broker = new CompanionBroker({ socketPath: env.AOS_CHROME_COMPANION_SOCKET, secret, issuerSecrets: { codex_mcp: 'fixture-issuer' } });
  await broker.listen();
  const extension = await connectPeer({ role: 'extension-relay', env, autoStart: false });
  const client = await BrokerClient.connect({ env, autoStart: false, issuer: 'codex_mcp' });
  t.after(async () => { client.close(); extension.close(); await broker.close(); });
  const hello = { kind: 'extension.hello', ...record, profileInstanceId: 'historical-profile', extensionRuntimeId: 'old-runtime' };
  const ack = once(extension, message => message.kind === 'extension.hello_ack');
  extension.send(hello);
  const old = await ack;
  assert.equal(old.operationSchemaDigest, record.operationSchemaDigest, 'ACK must echo old loaded contract');
  const profile = (await client.request('status.get')).profiles[0];
  assert.equal(profile.buildCompatibility, 'refresh_required');
  assert.equal(profile.buildProvenanceMismatches.includes('operationSchemaDigest'), true);
  assert.equal(profile.buildProvenanceMismatches.includes('capabilitiesDigest'), true);
  const session = await client.request('session.open', { taskId: 'refresh-owner' });
  await assert.rejects(client.request('operation.execute', { sessionId: session.sessionId, method: 'tabs.list', params: {} }), { code: 'companion_build_refresh_required' });
  await assert.rejects(client.requestAuthorizedTransaction({ sessionId: session.sessionId, taskId: session.taskId, runId: 'blocked-run',
    idempotencyKey: 'blocked-transaction', startUrl: 'https://example.test/', allowedOrigins: ['https://example.test'], actions: [] }), { code: 'companion_build_refresh_required' });
  let reloads = 0;
  extension.onMessage(message => {
    if (message.kind !== 'command.request') return;
    assert.equal(message.method, 'extension.reload'); reloads++;
    assert.equal(message.params.expectedBuildId, INSTALL_BUILD_ID);
    extension.send({ kind: 'command.result', operationId: message.operationId, result: { accepted: true, scheduled: true, buildId: INSTALL_BUILD_ID } });
  });
  await client.requestExtensionReload({ sessionId: session.sessionId, taskId: session.taskId, runId: 'refresh-run', idempotencyKey: 'refresh-once', expectedBuildId: INSTALL_BUILD_ID });
  await assert.rejects(client.requestExtensionReload({ sessionId: session.sessionId, taskId: session.taskId, runId: 'refresh-run', idempotencyKey: 'refresh-twice', expectedBuildId: INSTALL_BUILD_ID }), { code: 'extension_reload_busy' });
  assert.equal(reloads, 1);
  const current = operationSchemaDocument();
  const freshAck = once(extension, message => message.kind === 'extension.hello_ack');
  extension.send({ kind: 'extension.hello', profileInstanceId: hello.profileInstanceId, extensionRuntimeId: 'fresh-runtime', buildId: INSTALL_BUILD_ID,
    protocolVersion: '0.1.0', operationSchema: current.schema, operationSchemaVersion: current.version,
    operationSchemaDigest: current.schemaDigest, capabilities: current.capabilities, capabilitiesDigest: sha(JSON.stringify([...current.capabilities].sort())),
    bundleTreeSha256: BUNDLE_TREE_SHA256, extensionTreeSha256: EXTENSION_TREE_SHA256, nativeRecorderSha256: NATIVE_RECORDER_SHA256 });
  assert.notEqual((await freshAck).generation, old.generation);
  assert.equal((await client.request('status.get')).profiles[0].buildCompatibility, 'current');
});

test('broker historical contract admission fails closed on absent history or unknown/partial/forged hello', async t => {
  const { dir, record, historyPath } = await fixture(t, INSTALL_BUILD_ID);
  const env = { ...process.env, AOS_CHROME_COMPANION_DATA_DIR: dir, AOS_CHROME_COMPANION_SOCKET: join(dir, 'broker.sock'), AOS_CHROME_COMPANION_SECRET_FILE: join(dir, 'secret') };
  const broker = new CompanionBroker({ socketPath: env.AOS_CHROME_COMPANION_SOCKET, secret: await ensureBrokerSecret(env) });
  await broker.listen();
  const extension = await connectPeer({ role: 'extension-relay', env, autoStart: false });
  t.after(async () => { extension.close(); await broker.close(); });
  const hello = { kind: 'extension.hello', ...record, profileInstanceId: 'denied-profile', extensionRuntimeId: 'old-runtime' };
  async function rejected(patch = {}) {
    const result = once(extension, message => message.kind === 'peer.error'); extension.send({ ...hello, ...patch });
    assert.ok((await result).error.code); assert.equal(broker.snapshot().profiles.length, 0);
  }
  await rejected();
  await saveRefreshContractHistory(historyPath, record);
  for (const patch of [{ operationSchemaDigest: 'f'.repeat(64) }, { bundleTreeSha256: null }, { capabilitiesDigest: 'f'.repeat(64) },
    { operationSchemaVersion: 2 }, { protocolVersion: '0.2.0' }, { buildId: `install-${randomUUID()}` }, { nativeRecorderSha256: null }]) await rejected(patch);
  await writeFile(historyPath, '{');
  await rejected();
});
