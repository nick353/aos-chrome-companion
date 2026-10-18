import { spawn } from "node:child_process";
import { copyFileSync, mkdirSync, readdirSync, writeFileSync } from "node:fs";
import { extname, join, relative } from "node:path";

// A replay of what a task did, built from what Companion already keeps: the task's operation
// history and the screens saved after each operation (result.mjs). Nothing new is captured, so
// it costs no browser work. The owner asked for a way to see afterwards what the AI did
// (2026-10-19: 「どうしていたのかAIが把握しやすい」), on a Mac that cannot afford continuous capture.

// The same words the side panel uses, so the owner reads one vocabulary.
const LABELS = {
  "page.type": "文字を入力", "page.click": "クリック", "page.doubleClick": "ダブルクリック",
  "page.upload": "ファイルを添付", "page.uploadMultiple": "ファイルを添付", "page.query": "ページを読取",
  "page.snapshot": "ページを確認", "page.screenshot": "画面を確認", "page.richText": "文章の書式を編集",
  "page.selectOption": "選択肢を選ぶ", "page.setChecked": "チェックを切り替え", "page.pressKey": "キーを押す",
  "page.scroll": "スクロール", "page.hover": "マウスを乗せる", "page.submit": "送信", "page.waitFor": "表示を待つ",
  "page.handleDialog": "確認画面に応答", "page.download": "ダウンロード", "page.selectText": "文字を選択",
  "visual.click": "画面の位置をクリック", "visual.doubleClick": "画面の位置をダブルクリック",
  "visual.typeText": "画面に文字を入力", "visual.pressKey": "キーを押す", "visual.scroll": "スクロール", "visual.drag": "ドラッグ",
  "tabs.create": "タブを作成", "tabs.close": "タブを終了", "tabs.navigate": "ページを開く", "tabs.reload": "再読み込み",
  "tabs.back": "前のページに戻る", "tabs.forward": "次のページに進む", "tabs.activate": "タブを切り替え",
  "clipboard.write": "クリップボードへコピー", "clipboard.read": "クリップボードを読取",
};

const STATES = {
  applied: "完了", reconciled: "確認済み", dispatched: "送信済み・結果待ち", unknown_effect: "結果が不明",
  blocked: "止まった", prepared: "準備のみ",
};

export function operationLabel(method) {
  return LABELS[method] ?? method ?? "（操作なし）";
}

function tokyoTime(ms) {
  return new Intl.DateTimeFormat("ja-JP", { timeZone: "Asia/Tokyo", hour: "2-digit", minute: "2-digit", second: "2-digit", hourCycle: "h23" })
    .format(new Date(ms));
}

// Screens saved by this MCP process are named shot-<ms>-<session tag>-<hex>.<ext>; only the given
// session's screens are taken, so another task's pages never enter this replay.
export function listSessionScreenshots(dir, tag, { since = 0, until = Infinity } = {}) {
  if (!dir || !/^s[0-9a-f]{8}$/u.test(tag ?? "")) return [];
  let names;
  try { names = readdirSync(dir); } catch { return []; }
  return names
    .map(name => {
      const match = /^shot-(\d+)-(s[0-9a-f]{8})-[0-9a-f]+\.(jpg|png|webp)$/u.exec(name);
      return match && match[2] === tag ? { path: join(dir, name), at: Number(match[1]) } : null;
    })
    .filter(shot => shot && shot.at >= since && shot.at < until)
    .sort((left, right) => left.at - right.at);
}

// Each operation owns the screens saved from its start until the next operation starts; the last
// one keeps them for graceMs after it ended. Screens before the first operation form a lead step.
export function buildReplayTimeline(rows, shots, { graceMs = 120_000 } = {}) {
  const operations = rows
    .map(row => ({ ...row, at: Date.parse(row.preparedAt), endAt: Date.parse(row.updatedAt ?? row.preparedAt) }))
    .filter(row => Number.isFinite(row.at))
    .sort((left, right) => left.at - right.at || String(left.operationId).localeCompare(String(right.operationId)));
  const steps = [];
  const take = (from, to) => shots.filter(shot => shot.at >= from && shot.at < to).map(shot => shot.path);
  if (operations.length === 0) {
    if (shots.length) steps.push({ kind: "screens_only", at: shots[0].at, screenshots: shots.map(shot => shot.path) });
  } else {
    const lead = take(-Infinity, operations[0].at);
    if (lead.length) steps.push({ kind: "before_first_operation", at: shots[0].at, screenshots: lead });
    operations.forEach((operation, index) => {
      const next = operations[index + 1];
      const until = next ? next.at : Math.max(operation.at, Number.isFinite(operation.endAt) ? operation.endAt : operation.at) + graceMs;
      steps.push({
        kind: "operation", at: operation.at, operationId: operation.operationId, runId: operation.runId ?? null,
        method: operation.method, tabId: operation.tabId ?? null, state: operation.state ?? null,
        exactBlocker: operation.exactBlocker ?? null, screenshots: take(operation.at, until),
      });
    });
  }
  return steps.map((step, index) => ({ index: index + 1, ...step }));
}

function stepTitle(step) {
  if (step.kind === "before_first_operation") return "最初の操作の前";
  if (step.kind === "screens_only") return "操作の記録なし（画面のみ）";
  return operationLabel(step.method);
}

function srtTime(seconds) {
  const ms = Math.round(seconds * 1000);
  const pad = (value, width = 2) => String(value).padStart(width, "0");
  return `${pad(Math.floor(ms / 3_600_000))}:${pad(Math.floor(ms / 60_000) % 60)}:${pad(Math.floor(ms / 1000) % 60)},${pad(ms % 1000, 3)}`;
}

function runFfmpeg(args, { cwd, ffmpeg = "ffmpeg", timeoutMs = 180_000 } = {}) {
  return new Promise(resolve => {
    let stderr = "";
    let child;
    try {
      child = spawn(ffmpeg, args, { cwd, stdio: ["ignore", "ignore", "pipe"] });
    } catch (error) {
      resolve({ ok: false, error: String(error?.message ?? error) });
      return;
    }
    const timer = setTimeout(() => child.kill("SIGKILL"), timeoutMs);
    child.stderr.on("data", chunk => { stderr = (stderr + chunk).slice(-2_000); });
    child.on("error", error => { clearTimeout(timer); resolve({ ok: false, error: String(error?.message ?? error) }); });
    child.on("close", code => { clearTimeout(timer); resolve(code === 0 ? { ok: true } : { ok: false, error: stderr.trim() || `ffmpeg exited with ${code}` }); });
  });
}

// Copies the screens (Companion deletes its own after two days or 200 files), then writes
// timeline.json, a Japanese timeline.md and, if asked, a slideshow replay.mp4 with subtitles.
export async function writeReplay({ steps, outDir, secondsPerFrame = 1.5, video = true, ffmpeg = "ffmpeg", meta = {} }) {
  mkdirSync(join(outDir, "frames"), { recursive: true, mode: 0o700 });
  const frames = [];
  for (const step of steps) {
    step.frames = [];
    for (const source of step.screenshots) {
      const name = `frames/${String(frames.length + 1).padStart(4, "0")}${extname(source)}`;
      copyFileSync(source, join(outDir, name));
      frames.push({ file: name, step: step.index });
      step.frames.push(join(outDir, name));
    }
  }
  const byIndex = new Map(steps.map(step => [step.index, step]));
  const subtitle = frame => {
    const step = byIndex.get(frame.step);
    const state = step.state ? `（${STATES[step.state] ?? step.state}）` : "";
    return `#${step.index} ${stepTitle(step)}${state} ${tokyoTime(step.at)}`;
  };

  let videoPath = null;
  let videoError = null;
  if (video && frames.length) {
    const list = frames.map(frame => `file '${frame.file}'\nduration ${secondsPerFrame}`).join("\n")
      + `\nfile '${frames.at(-1).file}'\n`;
    writeFileSync(join(outDir, "frames.txt"), list, { mode: 0o600 });
    const srt = frames.map((frame, index) => `${index + 1}\n${srtTime(index * secondsPerFrame)} --> ${srtTime((index + 1) * secondsPerFrame)}\n${subtitle(frame)}\n`).join("\n");
    writeFileSync(join(outDir, "subtitles.srt"), srt, { mode: 0o600 });
    // Screens differ in size (viewport, element crops, full pages), so each is fitted onto one canvas.
    const result = await runFfmpeg(["-y", "-hide_banner", "-loglevel", "error", "-f", "concat", "-safe", "0", "-i", "frames.txt",
      "-i", "subtitles.srt", "-map", "0:v", "-map", "1:s",
      "-vf", "scale=1280:800:force_original_aspect_ratio=decrease,pad=1280:800:(ow-iw)/2:(oh-ih)/2:color=white,format=yuv420p",
      "-r", "5", "-c:v", "libx264", "-preset", "veryfast", "-crf", "28",
      "-c:s", "mov_text", "-metadata:s:s:0", "language=jpn", "replay.mp4"], { cwd: outDir, ffmpeg });
    if (result.ok) videoPath = join(outDir, "replay.mp4");
    else videoError = result.error;
  }

  const timeline = {
    schema: "aos.chrome_companion.replay.v1", createdAt: new Date().toISOString(), ...meta,
    operationCount: steps.filter(step => step.kind === "operation").length, frameCount: frames.length,
    secondsPerFrame, video: videoPath ? "replay.mp4" : null, videoError,
    steps: steps.map(({ screenshots, frames: stepFrames, ...step }) => ({ ...step, at: new Date(step.at).toISOString(),
      frames: stepFrames.map(path => relative(outDir, path)) })),
  };
  writeFileSync(join(outDir, "timeline.json"), `${JSON.stringify(timeline, null, 2)}\n`, { mode: 0o600 });

  const rows = steps.map(step => `| ${step.index} | ${tokyoTime(step.at)} | ${stepTitle(step)} | ${step.state ? (STATES[step.state] ?? step.state) : ""}${step.exactBlocker ? `（${step.exactBlocker}）` : ""} | ${step.frames.length ? step.frames.map(path => relative(outDir, path)).join(" ") : "画面なし"} |`);
  const markdown = [
    "# 振り返り",
    "",
    `- 作成: ${tokyoTime(Date.now())}（日本時間）`,
    `- 操作: ${timeline.operationCount}件 / 画面: ${frames.length}枚`,
    `- 動画: ${videoPath ? "replay.mp4（字幕に操作名と時刻）" : videoError ? `作れなかった（${videoError.slice(0, 200)}）` : "なし"}`,
    "- 画面は、各操作のあとにAIが受け取ったものだけです。操作と操作の間の画面は入っていません。",
    "",
    "| # | 時刻 | 操作 | 結果 | 画面 |",
    "|---|---|---|---|---|",
    ...rows,
    "",
  ].join("\n");
  writeFileSync(join(outDir, "timeline.md"), markdown, { mode: 0o600 });

  return {
    kind: "companion_replay", outDir, video: videoPath, videoError,
    timeline: join(outDir, "timeline.json"), timelineMarkdown: join(outDir, "timeline.md"),
    operationCount: timeline.operationCount, frameCount: frames.length,
    steps: steps.slice(-200).map(step => ({ index: step.index, at: new Date(step.at).toISOString(), title: stepTitle(step),
      method: step.method ?? null, state: step.state ?? null, exactBlocker: step.exactBlocker ?? null, frames: step.frames })),
    stepsTruncated: steps.length > 200,
  };
}
