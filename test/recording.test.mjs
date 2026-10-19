import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  RECORD_MAX_SECONDS, autoStopReason, bringAppToFront, frontmostBundleId,
  prepareRecordingForAnalysis, readDevicePresence, recordFolderName,
} from '../src/mcp/recording.mjs';
import { pruneReplays } from '../src/mcp/replay.mjs';

// Recording is allowed whenever the AI needs it, even during the owner's work or a call (owner,
// 2026-10-19: 「私は気にしないで」「こんな感じで分けて普段使っているので」). The longest is ten minutes.

test('a recording runs until its limit, whatever the owner is doing', () => {
  assert.equal(RECORD_MAX_SECONDS, 600);
  assert.equal(autoStopReason({ elapsedSeconds: 10, maxSeconds: 60 }), null);
  assert.equal(autoStopReason({ elapsedSeconds: 60, maxSeconds: 60 }), 'time_limit');
  assert.equal(autoStopReason({ elapsedSeconds: 10, maxSeconds: 60, camera: true, microphone: true }), null);
});

test('devices in use and the front app are read from macOS tools', async () => {
  const exec = async (file, args) => {
    if (file === '/rec' && args[0] === '--presence') return { stdout: '{"camera":true,"microphone":false}\n' };
    if (file.endsWith('lsappinfo') && args[0] === 'front') return { stdout: 'ASN:0x0-0x1a01a:\n' };
    if (file.endsWith('lsappinfo')) return { stdout: '"CFBundleIdentifier"="com.anthropic.claudefordesktop"\n' };
    throw new Error(`unexpected ${file}`);
  };
  assert.deepEqual(await readDevicePresence('/rec', { exec }), { camera: true, microphone: false });
  assert.equal(await frontmostBundleId({ exec }), 'com.anthropic.claudefordesktop');
  assert.equal(await frontmostBundleId({ exec: async () => { throw new Error('no'); } }), null);
});

test('the front goes back to the previous app, but never to Chrome or an odd name', async () => {
  const opened = [];
  const exec = async (file, args) => { opened.push([file, ...args]); return { stdout: '' }; };
  assert.equal(await bringAppToFront('com.apple.Safari', { exec }), true);
  assert.equal(await bringAppToFront('com.google.Chrome', { exec }), false);
  assert.equal(await bringAppToFront('x; rm -rf /', { exec }), false);
  assert.equal(await bringAppToFront(null, { exec }), false);
  assert.deepEqual(opened, [['/usr/bin/open', '-b', 'com.apple.Safari']]);
});

test('recording folders are named like replays, and cleanup removes old ones but never a movie being written', () => {
  const at = Date.UTC(2026, 9, 19, 1, 2, 3);
  assert.equal(recordFolderName(at, 'sabcdef12', 'TikTok 分析'), 'record-20261019-010203-sabcdef12-TikTok_分析');
  const root = mkdtempSync(join(tmpdir(), 'record-prune-'));
  try {
    const now = Date.UTC(2026, 9, 19, 12, 0, 0);
    const old = recordFolderName(now - 8 * 86_400_000, 'sabcdef12');
    mkdirSync(join(root, old));
    writeFileSync(join(root, 'recording-20261001-000000-sabcdef12.mov'), 'live');
    assert.deepEqual(pruneReplays(root, { now }), [old]);
    assert.ok(existsSync(join(root, 'recording-20261001-000000-sabcdef12.mov')));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

let ffmpegReady = false;
try { execFileSync('ffmpeg', ['-hide_banner', '-version'], { stdio: 'ignore' }); ffmpegReady = true; } catch { /* skipped below */ }

test('a finished movie gets its own folder with frames every two seconds and the sound', { skip: !ffmpegReady && 'ffmpeg is not installed' }, async () => {
  const dir = mkdtempSync(join(tmpdir(), 'record-analysis-'));
  try {
    const movie = join(dir, 'recording-x.mov');
    execFileSync('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-f', 'lavfi', '-i', 'testsrc=size=1280x800:rate=15:duration=7',
      '-f', 'lavfi', '-i', 'sine=frequency=440:duration=7', '-shortest', '-c:v', 'libx264', '-c:a', 'aac', movie]);
    const out = join(dir, 'record-20261019-010203-sabcdef12');
    const result = await prepareRecordingForAnalysis({ moviePath: movie, outDir: out });
    assert.ok(!existsSync(movie));
    assert.ok(existsSync(join(out, 'recording.mov')));
    assert.equal(result.hasAudio, true);
    assert.ok(existsSync(result.audio));
    assert.ok(result.durationSeconds > 6 && result.durationSeconds < 8);
    assert.ok(result.frames.length >= 3 && result.frames.length <= 5, String(result.frames.length));
    assert.deepEqual(result.frames.slice(0, 2).map(frame => frame.atSeconds), [0, 2]);
    const size = execFileSync('ffprobe', ['-v', 'error', '-show_entries', 'stream=width', '-of', 'csv=p=0', result.frames[0].path]).toString().trim();
    assert.equal(size, '960');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
