import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { defaultScreenshotDir, saveScreenshot, sessionTag, toolResult } from '../src/mcp/result.mjs';
import { calledByCodex } from '../src/mcp/task-context.mjs';

// A screenshot is also kept as a file and its path returned, so a task can hand the very screen it
// saw to a second reader (AOS's aos_check_screen, 2026-10-18).
const picture = Buffer.from('fake-jpeg-bytes').toString('base64');
const shot = (data = picture) => ({ kind: 'screenshot', mimeType: 'image/jpeg', dataBase64: data, tabId: 7 });

test('a screenshot is saved as a file and its path comes back as savedPath', () => {
  const dir = mkdtempSync(join(tmpdir(), 'shots-'));
  try {
    const result = toolResult({ visual_readback: shot() }, { screenshotDir: dir });
    const saved = result.structuredContent.result.visual_readback.savedPath;
    assert.ok(saved.startsWith(dir));
    assert.equal(readFileSync(saved).toString(), 'fake-jpeg-bytes');
    assert.equal(result.structuredContent.result.visual_readback.dataBase64, undefined);
    assert.equal(result.content.filter(item => item.type === 'image').length, 1);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('without a folder nothing is saved, and test runs default to no folder', () => {
  const result = toolResult({ visual_readback: shot() });
  assert.equal(result.structuredContent.result.visual_readback.savedPath, undefined);
  assert.equal(defaultScreenshotDir({ NODE_TEST_CONTEXT: 'child-v8' }), null);
  assert.equal(defaultScreenshotDir({ AOS_CHROME_COMPANION_SCREENSHOT_DIR: '/tmp/x', NODE_TEST_CONTEXT: 'child' }), '/tmp/x');
});

test('only the newest 200 and none older than two days are kept', () => {
  const dir = mkdtempSync(join(tmpdir(), 'shots-'));
  try {
    const now = Date.now();
    writeFileSync(join(dir, `shot-${now - 3 * 24 * 3600_000}-aaaaaa.jpg`), 'old');
    writeFileSync(join(dir, 'notes.txt'), 'not a screenshot');
    for (let i = 0; i < 205; i++) saveScreenshot(picture, 'image/jpeg', dir, now - 1000 + i);
    const shots = readdirSync(dir).filter(name => name.startsWith('shot-'));
    assert.equal(shots.length, 200);
    assert.ok(!shots.some(name => name.includes('aaaaaa')));
    assert.ok(readdirSync(dir).includes('notes.txt'));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('a folder that cannot be written does not break the screenshot', () => {
  assert.equal(saveScreenshot(picture, 'image/jpeg', '/dev/null/cannot'), null);
  const result = toolResult({ visual_readback: shot() }, { screenshotDir: '/dev/null/cannot' });
  assert.equal(result.structuredContent.result.visual_readback.savedPath, undefined);
  assert.equal(result.content.filter(item => item.type === 'image').length, 1);
});

test("the task's session goes into the file name, so one run's screens can be found again", () => {
  const dir = mkdtempSync(join(tmpdir(), 'shots-'));
  try {
    const result = toolResult({ visual_readback: shot() }, { screenshotDir: dir, screenshotTag: 's42a6ff0a' });
    assert.match(result.structuredContent.result.visual_readback.savedPath, /\/shot-\d+-s42a6ff0a-[0-9a-f]{6}\.jpg$/);
    assert.equal(sessionTag('session_42a6ff0a-0171-4fe1-9914-e8122d0be963'), 's42a6ff0a');
    assert.equal(sessionTag('lease_1234'), null);
    // a tag that is not a session tag never reaches the file name
    assert.match(saveScreenshot(picture, 'image/jpeg', dir, Date.now(), '../../x'), /\/shot-\d+-[0-9a-f]{6}\.jpg$/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// Codex reads an image block of a call from its code tool as base64 text it cannot see (2026-10-19:
// 74% of the tool output of AOS's heavy runs). Codex gets the saved file instead; others the picture.
test('for Codex a saved screenshot comes back as its file only; one that could not be saved keeps its picture', () => {
  const dir = mkdtempSync(join(tmpdir(), 'shots-'));
  try {
    const result = toolResult({ visual_readback: shot(), visualProof: { screenshotPath: '/x/shot.jpg' } }, { screenshotDir: dir, inlineImages: false });
    const readback = result.structuredContent.result.visual_readback;
    assert.ok(readback.savedPath.startsWith(dir));
    assert.equal(readFileSync(readback.savedPath).toString(), 'fake-jpeg-bytes');
    assert.match(readback.picture, /view_image/);
    assert.equal(result.structuredContent.result.visualProof.screenshotPath, '/x/shot.jpg');
    assert.equal(result.content.filter(item => item.type === 'image').length, 0);
    assert.ok(!JSON.stringify(result.content).includes(picture), 'no base64 in what Codex reads');
    const unsaved = toolResult({ visual_readback: shot() }, { screenshotDir: '/dev/null/cannot', inlineImages: false });
    assert.equal(unsaved.content.filter(item => item.type === 'image').length, 1);
    const other = toolResult({ visual_readback: shot() }, { screenshotDir: dir });
    assert.equal(other.content.filter(item => item.type === 'image').length, 1);
    assert.equal(other.structuredContent.result.visual_readback.picture, undefined);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('a call is from Codex when its metadata or its process carries a Codex thread id', () => {
  assert.equal(calledByCodex(undefined, {}), false);
  assert.equal(calledByCodex({ _meta: {} }, {}), false);
  assert.equal(calledByCodex(undefined, { CODEX_THREAD_ID: '01a1' }), true);
  assert.equal(calledByCodex(undefined, { CODEX_SESSION_ID: ' ' }), false);
  assert.equal(calledByCodex({ _meta: { 'openai/threadId': '01a15440' } }, {}), true);
  // Claude Code's Companion carries CODEX_THREAD_ID=claude-code-… and CLAUDECODE=1: not Codex.
  assert.equal(calledByCodex(undefined, { CODEX_THREAD_ID: 'claude-code-5b79f63e', CLAUDECODE: '1' }), false);
  assert.equal(calledByCodex(undefined, { CODEX_THREAD_ID: 'claude-code-5b79f63e' }), false);
  assert.equal(calledByCodex({ _meta: { 'openai/threadId': '01a15440' } }, { CLAUDECODE: '1' }), true, "Codex's own metadata still wins");
  assert.equal(calledByCodex({ _meta: { 'openai/threadId': 'a', codexThreadId: 'b' } }, {}), true, 'conflicting ids are still Codex');
});

test('for Codex a transaction keeps only the total of its per-operation timings', () => {
  const tx = () => ({ schema: 'aos.chrome_companion.transaction.v1', result: 'verified', actions: [],
    operation_timing: { schema: 'x', operations: [
      { method: 'tabs.create', timings_ms: { total: 120.5, queue: 1 } },
      { method: 'page.click', timings_ms: { total: 30 }, error_code: 'semantic_locator_not_found' }] } });
  const codex = toolResult(tx(), { inlineImages: false }).structuredContent.result;
  assert.deepEqual(codex.operation_timing, { total_ms: 150.5, operations: 2, errors: [{ method: 'page.click', error_code: 'semantic_locator_not_found' }] });
  assert.equal(codex.result, 'verified');
  const other = toolResult(tx()).structuredContent.result;
  assert.equal(other.operation_timing.operations.length, 2, 'other clients keep every timing');
});
