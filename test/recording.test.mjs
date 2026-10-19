import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  RECORD_MAX_SECONDS, autoStopReason, ownerOnCall, pageCrop,
  prepareRecordingForAnalysis, readDevicePresence, recordFolderName,
} from '../src/mcp/recording.mjs';
import { pruneReplays } from '../src/mcp/replay.mjs';

// Recording is allowed whenever the AI needs it, even during the owner's work (owner, 2026-10-19:
// 「私は気にしないで」), but not during a call: the recorded video's sound would play into it (owner,
// 2026-10-19: 通話中は待つ). The longest is ten minutes.

test('a recording runs until its limit', () => {
  assert.equal(RECORD_MAX_SECONDS, 600);
  assert.equal(autoStopReason({ elapsedSeconds: 10, maxSeconds: 60 }), null);
  assert.equal(autoStopReason({ elapsedSeconds: 60, maxSeconds: 60 }), 'time_limit');
});

test('a camera or microphone in use means a call, and no recording starts', async () => {
  const exec = async (file, args) => {
    if (file === '/rec' && args[0] === '--presence') return { stdout: '{"camera":true,"microphone":false}\n' };
    throw new Error(`unexpected ${file}`);
  };
  const presence = await readDevicePresence('/rec', { exec });
  assert.deepEqual(presence, { camera: true, microphone: false });
  assert.equal(ownerOnCall(presence), true);
  assert.equal(ownerOnCall({ camera: false, microphone: true }), true);
  assert.equal(ownerOnCall({ camera: false, microphone: false }), false);
  assert.equal(ownerOnCall(null), false);
});

test('only the page part of the recording window goes to analysis', () => {
  const windowBounds = { left: 0, top: 25, width: 599, height: 875 };
  assert.deepEqual(pageCrop({ videoWidth: 598, videoHeight: 874, windowBounds, viewport: { width: 599, height: 785 } }),
    { x: 0, y: 90, width: 598, height: 784 });
  assert.deepEqual(pageCrop({ videoWidth: 1198, videoHeight: 1750, windowBounds, viewport: { width: 599, height: 785 } }),
    { x: 0, y: 180, width: 1198, height: 1570 });
  assert.equal(pageCrop({ videoWidth: 598, videoHeight: 874, windowBounds, viewport: null }), null);
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

// macOS stops sending frames while a page stands still, so the video track can end long before the
// sound (2026-10-19: 4.4 s of video in an 8.3 s recording). Frames still cover the whole recording.
test('a still page still gets a frame every two seconds to the end of the recording', { skip: !ffmpegReady && 'ffmpeg is not installed' }, async () => {
  const dir = mkdtempSync(join(tmpdir(), 'record-still-'));
  try {
    const movie = join(dir, 'recording-still.mov');
    execFileSync('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-f', 'lavfi', '-i', 'testsrc=size=640x400:rate=15:duration=3',
      '-f', 'lavfi', '-i', 'sine=frequency=440:duration=9', '-c:v', 'libx264', '-c:a', 'aac', movie]);
    const result = await prepareRecordingForAnalysis({ moviePath: movie, outDir: join(dir, 'out') });
    assert.ok(result.durationSeconds > 8.5, String(result.durationSeconds));
    assert.equal(result.frames.length, 5, String(result.frames.length));
    assert.equal(result.frames.at(-1).atSeconds, 8);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('a clean recording gets the page-only analysis.mp4; one that another page got into gets none', { skip: !ffmpegReady && 'ffmpeg is not installed' }, async () => {
  const dir = mkdtempSync(join(tmpdir(), 'record-crop-'));
  try {
    const make = name => {
      const movie = join(dir, name);
      execFileSync('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-f', 'lavfi', '-i', 'testsrc=size=598x874:rate=15:duration=4',
        '-f', 'lavfi', '-i', 'sine=frequency=440:duration=4', '-shortest', '-c:v', 'libx264', '-c:a', 'aac', movie]);
      return movie;
    };
    const windowBounds = { left: 0, top: 25, width: 598, height: 874 };
    const viewport = { width: 598, height: 784 };
    const clean = await prepareRecordingForAnalysis({ moviePath: make('recording-a.mov'), outDir: join(dir, 'a'), windowBounds, viewport });
    assert.equal(clean.video, join(dir, 'a', 'analysis.mp4'));
    assert.equal(clean.cropped, true);
    assert.equal(clean.analysisBlocked, null);
    assert.equal(clean.audioSilent, false);
    const size = execFileSync('ffprobe', ['-v', 'error', '-select_streams', 'v', '-show_entries', 'stream=width,height', '-of', 'csv=p=0', clean.video]).toString().trim();
    assert.equal(size, '598,784');
    assert.ok(existsSync(join(dir, 'a', 'recording.mov')));

    const dirty = await prepareRecordingForAnalysis({ moviePath: make('recording-b.mov'), outDir: join(dir, 'b'), windowBounds, viewport,
      blockedReasons: ['other_tab_shown_in_recording_window'] });
    assert.equal(dirty.video, null);
    assert.deepEqual(dirty.analysisBlocked, ['other_tab_shown_in_recording_window']);
    assert.ok(!existsSync(join(dir, 'b', 'analysis.mp4')));
    assert.ok(existsSync(join(dir, 'b', 'unsafe.json')));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// A page that never got a person's click plays muted: the recording has a sound track that is all
// silence (2026-10-19: -91 dB), and the AI must tell Gemini there is no sound.
test('a silent sound track is reported as silent', { skip: !ffmpegReady && 'ffmpeg is not installed' }, async () => {
  const dir = mkdtempSync(join(tmpdir(), 'record-silent-'));
  try {
    const movie = join(dir, 'recording-s.mov');
    execFileSync('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-f', 'lavfi', '-i', 'testsrc=size=320x240:rate=15:duration=3',
      '-f', 'lavfi', '-i', 'anullsrc=r=48000:cl=stereo', '-t', '3', '-c:v', 'libx264', '-c:a', 'aac', movie]);
    const result = await prepareRecordingForAnalysis({ moviePath: movie, outDir: join(dir, 'out') });
    assert.equal(result.hasAudio, true);
    assert.equal(result.audioSilent, true);
    assert.equal(result.cropped, false);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
