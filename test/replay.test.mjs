import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { mkdirSync } from 'node:fs';
import { buildReplayTimeline, listSessionScreenshots, operationLabel, pruneReplays, replayFolderName, writeReplay } from '../src/mcp/replay.mjs';

// A replay joins the task's operation history with the screens already saved after each
// operation, so the owner and the AI can see afterwards what the AI did (2026-10-19).
const at = iso => Date.parse(iso);
const row = (operationId, method, preparedAt, updatedAt = preparedAt, state = 'applied') => ({ operationId, method, preparedAt, updatedAt, state, tabId: 7 });

test('only this session\'s screens in the time range are listed, oldest first', () => {
  const dir = mkdtempSync(join(tmpdir(), 'replay-shots-'));
  try {
    for (const name of [
      'shot-3000-sabcdef12-aaaaaa.jpg', 'shot-1000-sabcdef12-bbbbbb.png', 'shot-2000-s99999999-cccccc.jpg',
      'shot-500-sabcdef12-dddddd.jpg', 'notes.txt', 'shot-4000-eeeeee.jpg',
    ]) writeFileSync(join(dir, name), 'x');
    assert.deepEqual(listSessionScreenshots(dir, 'sabcdef12', { since: 1000 }).map(shot => shot.at), [1000, 3000]);
    assert.deepEqual(listSessionScreenshots(dir, 'sabcdef12', { since: 0, until: 2000 }).map(shot => shot.at), [500, 1000]);
    assert.deepEqual(listSessionScreenshots(dir, null), []);
    assert.deepEqual(listSessionScreenshots(null, 'sabcdef12'), []);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('each operation owns the screens until the next one starts, and the last keeps them for a grace period', () => {
  const rows = [
    row('op2', 'page.click', '2026-10-19T00:00:10Z'),
    row('op1', 'tabs.navigate', '2026-10-19T00:00:00Z', '2026-10-19T00:00:02Z'),
    row('op3', 'page.type', '2026-10-19T00:00:20Z', '2026-10-19T00:00:21Z', 'unknown_effect'),
  ];
  const shot = (iso, path) => ({ at: at(iso), path });
  const shots = [
    shot('2026-10-18T23:59:58Z', 'lead.jpg'),
    shot('2026-10-19T00:00:03Z', 'a.jpg'), shot('2026-10-19T00:00:05Z', 'b.jpg'),
    shot('2026-10-19T00:00:12Z', 'c.jpg'),
    shot('2026-10-19T00:00:22Z', 'd.jpg'), shot('2026-10-19T00:30:00Z', 'late.jpg'),
  ];
  const steps = buildReplayTimeline(rows, shots);
  assert.deepEqual(steps.map(step => [step.index, step.kind, step.operationId ?? null, step.screenshots]), [
    [1, 'before_first_operation', null, ['lead.jpg']],
    [2, 'operation', 'op1', ['a.jpg', 'b.jpg']],
    [3, 'operation', 'op2', ['c.jpg']],
    [4, 'operation', 'op3', ['d.jpg']],
  ]);
  assert.equal(steps[3].state, 'unknown_effect');
});

test('without operations the saved screens still form one step', () => {
  const steps = buildReplayTimeline([], [{ at: 5, path: 'x.jpg' }, { at: 9, path: 'y.jpg' }]);
  assert.deepEqual(steps, [{ index: 1, kind: 'screens_only', at: 5, screenshots: ['x.jpg', 'y.jpg'] }]);
  assert.deepEqual(buildReplayTimeline([], []), []);
  assert.equal(operationLabel('page.click'), 'クリック');
  assert.equal(operationLabel('page.somethingNew'), 'page.somethingNew');
});

test('the replay copies the screens and writes a timeline without a video when asked not to', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'replay-'));
  try {
    const source = join(dir, 'shot.jpg');
    writeFileSync(source, 'fake-jpeg');
    const steps = buildReplayTimeline([row('op1', 'page.click', '2026-10-19T00:00:00Z', '2026-10-19T00:00:01Z', 'blocked')],
      [{ at: at('2026-10-19T00:00:01Z'), path: source }]);
    steps[0].exactBlocker = 'semantic_locator_ambiguous';
    const out = join(dir, 'out');
    // A folder given with a doubled slash (e.g. from $TMPDIR/…) must not shift the frame paths.
    const result = await writeReplay({ steps, outDir: `${dir}//out`, video: false, meta: { runId: 'run-1' } });
    assert.equal(result.video, null);
    assert.equal(result.frameCount, 1);
    assert.equal(readFileSync(join(out, 'frames', '0001.jpg')).toString(), 'fake-jpeg');
    assert.deepEqual(result.steps[0].frames, [join(out, 'frames', '0001.jpg')]);
    const timeline = JSON.parse(readFileSync(join(out, 'timeline.json'), 'utf8'));
    assert.equal(timeline.runId, 'run-1');
    assert.deepEqual(timeline.steps[0].frames, ['frames/0001.jpg']);
    assert.equal(timeline.steps[0].screenshots, undefined);
    const markdown = readFileSync(join(out, 'timeline.md'), 'utf8');
    assert.match(markdown, /\| 1 \| \d\d:\d\d:\d\d \| クリック \| 止まった（semantic_locator_ambiguous） \| frames\/0001\.jpg \|/u);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

let ffmpegReady = false;
try { execFileSync('ffmpeg', ['-hide_banner', '-version'], { stdio: 'ignore' }); ffmpegReady = true; } catch { /* skipped below */ }

test('screens of different sizes become one subtitled slideshow', { skip: !ffmpegReady && 'ffmpeg is not installed' }, async () => {
  const dir = mkdtempSync(join(tmpdir(), 'replay-video-'));
  try {
    const make = (name, size, color) => {
      execFileSync('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-f', 'lavfi', '-i', `color=${color}:s=${size}`, '-frames:v', '1', join(dir, name)]);
      return join(dir, name);
    };
    const shots = [
      { at: at('2026-10-19T00:00:01Z'), path: make('a.jpg', '1280x800', 'red') },
      { at: at('2026-10-19T00:00:11Z'), path: make('b.jpg', '640x2000', 'blue') },
    ];
    const steps = buildReplayTimeline([row('op1', 'tabs.navigate', '2026-10-19T00:00:00Z'), row('op2', 'page.click', '2026-10-19T00:00:10Z')], shots);
    const out = join(dir, 'out');
    const result = await writeReplay({ steps, outDir: out, secondsPerFrame: 1 });
    assert.equal(result.videoError, null);
    assert.ok(existsSync(result.video));
    const probe = execFileSync('ffprobe', ['-v', 'error', '-show_entries', 'stream=codec_type,width,height', '-of', 'csv=p=0', result.video]).toString();
    assert.match(probe, /video,1280,800/u);
    assert.match(probe, /subtitle/u);
    const subtitles = readFileSync(join(out, 'subtitles.srt'), 'utf8');
    assert.match(subtitles, /#1 ページを開く（完了）/u);
    assert.match(subtitles, /#2 クリック（完了）/u);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('a replay folder is named by its UTC time, session and a cleaned task name', () => {
  const at = Date.UTC(2026, 9, 19, 1, 2, 3);
  assert.equal(replayFolderName(at, 'sabcdef12'), 'replay-20261019-010203-sabcdef12');
  assert.equal(replayFolderName(at, 'sabcdef12', '求人応募／Daijob: 送信'), 'replay-20261019-010203-sabcdef12-求人応募_Daijob_送信');
  assert.equal(replayFolderName(at, null, '../..'), 'replay-20261019-010203-session');
});

// Unused replays are removed (owner, 2026-10-19: 「使わなくなったら動画は消すように」).
test('replays older than a week or beyond the newest count are removed unless kept', () => {
  const root = mkdtempSync(join(tmpdir(), 'replay-prune-'));
  try {
    const now = Date.UTC(2026, 9, 19, 12, 0, 0);
    const day = 86_400_000;
    const make = (ms, extra = '') => {
      const name = replayFolderName(now - ms, 'sabcdef12') + extra;
      mkdirSync(join(root, name), { recursive: true });
      writeFileSync(join(root, name, 'timeline.md'), 'x');
      return name;
    };
    const fresh = make(1 * day);
    const old = make(8 * day);
    const kept = make(30 * day, '-keepme');
    writeFileSync(join(root, kept, 'keep'), '');
    const current = make(9 * day, '-current');
    writeFileSync(join(root, 'companion-1789988199224.mov'), 'old native recording');
    mkdirSync(join(root, 'something-else'));

    const removed = pruneReplays(root, { now, except: join(root, current) });
    assert.deepEqual(removed, [old]);
    for (const name of [fresh, kept, current, 'companion-1789988199224.mov', 'something-else']) assert.ok(existsSync(join(root, name)), name);
    assert.ok(!existsSync(join(root, old)));

    const many = [0, 1, 2].map(hours => make(hours * 3_600_000, `-n${hours}`));
    // Without `except`, the nine-day-old one goes too; the kept one stays even beyond the count.
    const overCount = pruneReplays(root, { now, keepCount: 2 });
    assert.deepEqual(overCount.sort(), [current, fresh, many[2]].sort());
    assert.ok(existsSync(join(root, kept)));
    assert.deepEqual(pruneReplays(join(root, 'missing')), []);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
