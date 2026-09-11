import assert from 'node:assert/strict';
import test from 'node:test';
import vm from 'node:vm';
import { mkdtemp, writeFile, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { materializeUploadParams, materializeUploadMultipleParams } from '../src/mcp/action-materializer.mjs';
import { transactionActionSchema } from '../src/mcp/action-schema.mjs';
import * as z from 'zod/v4';

test('single and multiple uploads preserve the explicit site confirmation across materialization', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'companion-upload-confirmation-'));
  try {
    const filePath = join(dir, '添付.txt');
    await writeFile(filePath, 'confirmed content');
    const confirmationLocator = { role: 'status', text: '添付.txt received', frameId: 2 };
    const options = { locator: { label: '書類', frameId: 2 }, confirmationLocator, confirmationTimeoutMs: 9000 };
    for (const result of [await materializeUploadParams({ ...options, filePath }),
      await materializeUploadMultipleParams({ ...options, filePaths: [filePath] })]) {
      assert.deepEqual(result.confirmationLocator, confirmationLocator);
      assert.equal(result.confirmationTimeoutMs, 9000);
      assert.equal(result.filePath, undefined);
      assert.equal(result.filePaths, undefined);
    }
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test('upload confirmation options are typed and invalid windows fail before file access', async () => {
  const schema = transactionActionSchema(z.looseObject({ label: z.string().optional() }));
  for (const confirmationTimeoutMs of [-1, 0, 99, 15001, '5000']) {
    const params = { filePath: '/missing.txt', locator: { label: 'File' }, confirmationLocator: { label: 'Ready' }, confirmationTimeoutMs };
    assert.equal(schema.safeParse({ method: 'page.upload', params }).success, false);
    await assert.rejects(materializeUploadParams(params), { code: 'upload_confirmation_timeout_invalid' });
  }
  await assert.rejects(materializeUploadParams({ filePath: '/missing.txt', confirmationLocator: [] }), { code: 'upload_confirmation_locator_invalid' });
});

const source = await readFile(new URL('../extension/service-worker.js', import.meta.url), 'utf8');
const start = source.indexOf('async function runAndCheckMutation(');
const end = source.indexOf('\nasync function runPageOperation(', start);
const expectedFiles = [{ name: '添付.txt', size: 7, type: 'text/plain' }];
function workerFixture({ state = 'retained', failProbe = false } = {}) {
  const calls = [], waits = [];
  const context = {
    assertLiveOrigin: async () => {},
    setTimeout: (fn, ms) => { waits.push(ms); fn(); },
    companionError: (code, message, details) => Object.assign(Error(message), { code, details }),
    runPageOperation: async (_tabId, action) => {
      calls.push(action);
      if (action === 'upload' || action === 'uploadMultiple') return {
        uploaded: false, fileInputAssignmentVerified: true, expectedFiles, uploadTiming: {},
      };
      if (failProbe) throw Object.assign(Error('target replaced'), { code: 'semantic_locator_not_found' });
      return { retained: state === 'retained', state,
        files: state === 'retained' ? expectedFiles : state === 'different' ? [{ name: 'wrong.txt', size: 7, type: 'text/plain' }] : [],
        inputFileCount: state === 'retained' || state === 'different' ? 1 : 0,
        url: 'https://owned.example/form', pageInstanceId: 'owned-doc' };
    },
  };
  vm.createContext(context);
  vm.runInContext(source.slice(start, end), context);
  return { calls, waits, run: (allowInputReset = false) => context.runAndCheckMutation(7, 'upload', { locator: { label: 'File' } }, { allowedOrigins: ['https://owned.example'], allowInputReset }) };
}

test('upload verifies the settled control with a read-only probe and dispatches only once', async () => {
  const f = workerFixture(); const value = await f.run();
  assert.equal(value.uploaded, true);
  assert.equal(value.uploadReadbackVerified, true);
  assert.equal(value.uploadReadbackMethod, 'file_input');
  assert.deepEqual(f.calls, ['upload', 'verifyUpload']);
  assert.deepEqual(f.waits, [250]);
});

test('a cleared input without an explicit confirmation remains unknown and is never re-uploaded', async () => {
  const f = workerFixture({ state: 'cleared' });
  await assert.rejects(f.run(), error => error.code === 'upload_file_readback_failed'
    && error.details.operationEffectState === 'unknown'
    && error.details.fileInputAssignmentVerified === true
    && error.details.nextAction === 'inspect_existing_attachment_state_without_reupload');
  assert.deepEqual(f.calls, ['upload', 'verifyUpload']);
});

for (const state of ['cleared', 'replaced']) test(`a ${state} input can proceed only to the bound site confirmation`, async () => {
  const f = workerFixture({ state }); const value = await f.run(true);
  assert.equal(value.uploaded, false);
  assert.equal(value.uploadReadbackVerified, false);
  assert.equal(value.requiresSiteConfirmation, true);
  assert.equal(value.fileInputAssignmentVerified, true);
  assert.deepEqual(f.calls, ['upload', 'verifyUpload']);
});

test('different files are never accepted even when site confirmation was requested', async () => {
  const f = workerFixture({ state: 'different' });
  await assert.rejects(f.run(true), { code: 'upload_file_readback_failed' });
  assert.equal(f.calls.filter(x => x === 'upload').length, 1);
});

test('readback failure after file delivery preserves the unknown effect boundary', async () => {
  const f = workerFixture({ failProbe: true });
  await assert.rejects(f.run(true), error => error.details?.operationEffectState === 'unknown'
    && error.details?.mutationDispatchAttempted === true);
  assert.equal(f.calls.filter(x => x === 'upload').length, 1);
});
