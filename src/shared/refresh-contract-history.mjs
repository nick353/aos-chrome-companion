import { createHash, randomUUID } from 'node:crypto';
import { constants } from 'node:fs';
import { lstat, mkdir, open, readFile, readdir, rename, unlink } from 'node:fs/promises';
import { dirname, join, relative, resolve, sep } from 'node:path';

export const REFRESH_CONTRACT_HISTORY_SCHEMA = 'companion_refresh_contract_history.v1';
const HASH = /^[a-f0-9]{64}$/u;
const ARTIFACTS = ['bundleTreeSha256', 'extensionTreeSha256', 'nativeRecorderSha256'];
const sha = data => createHash('sha256').update(data).digest('hex');
const capDigest = list => sha(JSON.stringify([...list].sort()));
const fail = () => { throw new Error('refresh_contract_history_invalid'); };
const tupleIdentity = value => JSON.stringify([value.buildId, value.protocolVersion, value.operationSchemaVersion,
  value.operationSchemaDigest, value.capabilitiesDigest, ...ARTIFACTS.map(field => value[field])]);

function validateRecord(record) {
  if (!record || record.verificationVersion !== 1 || record.protocolVersion !== '0.1.0'
    || !(record.buildId === 'dev-local' || /^install-[0-9a-f-]{36}$/u.test(record.buildId ?? ''))
    || record.operationSchema !== 'aos.chrome_companion.operation_schema.v1' || record.operationSchemaVersion !== 1
    || !HASH.test(record.operationSchemaDigest ?? '') || !HASH.test(record.capabilitiesDigest ?? '')
    || ARTIFACTS.some(field => !HASH.test(record[field] ?? ''))
    || !Number.isFinite(Date.parse(record.verifiedAt ?? ''))) fail();
  const fields = ['buildId', 'protocolVersion', 'operationSchema', 'operationSchemaVersion', 'operationSchemaDigest',
    'capabilities', 'capabilitiesDigest', ...ARTIFACTS, 'operationContract', 'verificationVersion', 'verifiedAt'];
  if (Object.keys(record).length !== fields.length || Object.keys(record).some(field => !fields.includes(field))) fail();
  const doc = record.operationContract;
  if (!doc || doc.schema !== record.operationSchema || doc.version !== record.operationSchemaVersion
    || doc.schemaDigest !== record.operationSchemaDigest || !Array.isArray(doc.methods) || doc.methods.length > 256
    || !Array.isArray(doc.authorizedTransactionMethods) || !doc.actionEvents) fail();
  const names = doc.methods.map(item => item?.method);
  if (names.some(name => typeof name !== 'string' || !name || name.length > 128) || new Set(names).size !== names.length
    || doc.methods.some(item => ['targetScoped', 'mutation', 'profileGlobal'].some(field => typeof item[field] !== 'boolean'))
    || JSON.stringify(record.capabilities) !== JSON.stringify(names)
    || JSON.stringify(doc.capabilities) !== JSON.stringify(names) || capDigest(names) !== record.capabilitiesDigest) fail();
  const digest = sha(JSON.stringify({ schema: doc.schema, version: doc.version, methods: doc.methods,
    authorizedTransactionMethods: doc.authorizedTransactionMethods, actionEvents: doc.actionEvents }));
  if (digest !== record.operationSchemaDigest) fail();
  const reload = doc.methods.find(item => item.method === 'extension.reload');
  if (!reload || reload.targetScoped !== false || reload.mutation !== true || reload.profileGlobal !== true) fail();
  return record;
}

async function securePath(path, { createParent = false } = {}) {
  const absolute = resolve(path);
  let current = '/';
  for (const part of absolute.split('/').filter(Boolean)) {
    current = join(current, part);
    try {
      const stat = await lstat(current);
      if (stat.isSymbolicLink() && current !== '/var' && current !== '/tmp') fail();
    } catch (error) { if (error.code === 'ENOENT') break; throw error; }
  }
  if (createParent) await mkdir(dirname(absolute), { recursive: true, mode: 0o700 });
  const parent = await lstat(dirname(absolute));
  if (!parent.isDirectory() || parent.isSymbolicLink() || (parent.mode & 0o077) !== 0
    || typeof process.getuid === 'function' && parent.uid !== process.getuid()) fail();
  return { absolute, parent };
}

export async function readRefreshContractHistory(path) {
  const { absolute } = await securePath(path);
  const file = await open(absolute, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const stat = await file.stat();
    if (!stat.isFile() || (stat.mode & 0o077) !== 0 || stat.size > 512_000
      || typeof process.getuid === 'function' && stat.uid !== process.getuid()) fail();
    const history = JSON.parse(await file.readFile('utf8'));
    if (history.schema !== REFRESH_CONTRACT_HISTORY_SCHEMA || !Array.isArray(history.records)
      || history.records.length < 1 || history.records.length > 3) fail();
    if (Object.keys(history).length !== 2 || Object.keys(history).some(field => !['schema', 'records'].includes(field))) fail();
    const keys = history.records.map(record => tupleIdentity(validateRecord(record)));
    if (new Set(keys).size !== keys.length) fail();
    return history;
  } finally { await file.close(); }
}

export async function saveRefreshContractHistory(path, record) {
  record = structuredClone(record);
  validateRecord(record);
  const { absolute, parent } = await securePath(path, { createParent: true });
  let previous = [];
  try { previous = (await readRefreshContractHistory(absolute)).records; }
  catch (error) { if (error.code !== 'ENOENT') throw error; }
  const records = [...previous.filter(value => tupleIdentity(value) !== tupleIdentity(record)), record].slice(-3);
  const history = { schema: REFRESH_CONTRACT_HISTORY_SCHEMA, records };
  const temporary = `${absolute}.${randomUUID()}.tmp`;
  const file = await open(temporary, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
  try {
    await file.writeFile(`${JSON.stringify(history)}\n`); await file.sync(); await file.close();
    const checked = await securePath(absolute);
    if (checked.parent.ino !== parent.ino || checked.parent.dev !== parent.dev) fail();
    await rename(temporary, absolute);
    return history;
  } finally { await file.close().catch(() => {}); await unlink(temporary).catch(error => { if (error.code !== 'ENOENT') throw error; }); }
}

export function historicalRefreshContractMatches(record, hello) {
  try { validateRecord(record); } catch { return false; }
  const fields = ['buildId', 'protocolVersion', 'operationSchema', 'operationSchemaVersion', 'operationSchemaDigest', 'capabilitiesDigest', ...ARTIFACTS];
  return fields.every(field => hello[field] === record[field])
    && Array.isArray(hello.capabilities) && hello.capabilities.every(value => typeof value === 'string')
    && new Set(hello.capabilities).size === hello.capabilities.length
    && capDigest(hello.capabilities) === record.capabilitiesDigest;
}

// Exactly the installer manifest algorithm; never import or execute an old app.
async function hashTree(root, excludedPaths = new Set()) {
  const files = [];
  async function visit(directory) {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      const path = join(directory, entry.name);
      const relativePath = relative(root, path).split(sep).join('/');
      if (relativePath.split('/').includes('node_modules') || excludedPaths.has(relativePath)) continue;
      if (entry.isSymbolicLink()) fail();
      if (entry.isDirectory()) await visit(path);
      else if (entry.isFile()) files.push({ path, relativePath });
    }
  }
  await visit(root);
  files.sort((left, right) => left.relativePath.localeCompare(right.relativePath));
  const manifest = createHash('sha256');
  for (const file of files) manifest.update(`${file.relativePath}\0${sha(await readFile(file.path))}\n`, 'utf8');
  return manifest.digest('hex');
}

function literal(source, name) {
  const matches = [...source.matchAll(new RegExp(`export\\s+const\\s+${name}\\s*=\\s*("[^"\\r\\n]*"|'[^'\\r\\n]*')\\s*;`, 'gu'))];
  if (matches.length !== 1) fail();
  const raw = matches[0][1];
  return raw.startsWith('"') ? JSON.parse(raw) : raw.slice(1, -1);
}

export async function verifyInstalledRefreshContract(appRoot, expected = {}) {
  const root = resolve(appRoot);
  if ((await lstat(root)).isSymbolicLink()) fail();
  for (const path of ['build-manifest.json', 'src/shared/build-info.mjs', 'extension/build-info.js',
    'extension/operation-schema.generated.json', 'src/shared/constants.mjs', 'native-recording-bin']) {
    if (!(await lstat(join(root, path))).isFile()) fail();
  }
  const manifest = JSON.parse(await readFile(join(root, 'build-manifest.json'), 'utf8'));
  const buildInfo = await readFile(join(root, 'src/shared/build-info.mjs'), 'utf8');
  const extensionBuildInfo = await readFile(join(root, 'extension/build-info.js'), 'utf8');
  const contract = JSON.parse(await readFile(join(root, 'extension/operation-schema.generated.json'), 'utf8'));
  const constantsSource = await readFile(join(root, 'src/shared/constants.mjs'), 'utf8');
  if (manifest.schema !== 'aos_chrome_companion_build_manifest.v1' || !expected.expectedBuildId
    || manifest.buildId !== expected.expectedBuildId || literal(buildInfo, 'INSTALL_BUILD_ID') !== manifest.buildId
    || literal(extensionBuildInfo, 'INSTALL_BUILD_ID') !== manifest.buildId) fail();
  const actual = {
    bundleTreeSha256: await hashTree(root, new Set(['src/shared/build-info.mjs', 'extension/build-info.js', 'build-manifest.json'])),
    extensionTreeSha256: await hashTree(join(root, 'extension'), new Set(['build-info.js'])),
    nativeRecorderSha256: sha(await readFile(join(root, 'native-recording-bin'))),
  };
  for (const field of ARTIFACTS) {
    if (actual[field] !== manifest[field] || literal(buildInfo, field === 'bundleTreeSha256' ? 'BUNDLE_TREE_SHA256' : field === 'extensionTreeSha256' ? 'EXTENSION_TREE_SHA256' : 'NATIVE_RECORDER_SHA256') !== actual[field]
      || literal(extensionBuildInfo, field === 'bundleTreeSha256' ? 'BUNDLE_TREE_SHA256' : field === 'extensionTreeSha256' ? 'EXTENSION_TREE_SHA256' : 'NATIVE_RECORDER_SHA256') !== actual[field]) fail();
    const expectedName = `expected${field[0].toUpperCase()}${field.slice(1)}`;
    if (expected[expectedName] !== undefined && expected[expectedName] !== actual[field]) fail();
  }
  if (expected.expectedOperationSchemaDigest !== undefined && expected.expectedOperationSchemaDigest !== contract.schemaDigest) fail();
  return validateRecord({ buildId: manifest.buildId, protocolVersion: literal(constantsSource, 'PROTOCOL_VERSION'),
    operationSchema: contract.schema, operationSchemaVersion: contract.version, operationSchemaDigest: contract.schemaDigest,
    capabilities: contract.methods.map(item => item.method), capabilitiesDigest: capDigest(contract.methods.map(item => item.method)),
    ...actual, operationContract: contract, verificationVersion: 1, verifiedAt: new Date().toISOString() });
}
