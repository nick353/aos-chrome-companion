import { execFile } from "node:child_process";
import { mkdirSync, readdirSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { promisify } from "node:util";

// A real recording (moving video with sound) for what a slideshow replay cannot show: short videos
// on TikTok or Instagram to analyse without downloading them, and how a moving page feels
// (owner, 2026-10-19). The recorded tab is moved alone into its own recording window, which the
// recorder finds by its place on screen, so Chrome never has to come to the front and other tasks'
// tabs never appear in the recording (owner, 2026-10-19:「この録画をしているときはタブが奪われない
// ようにしたらいい」). Nothing is recorded while a camera or microphone is in use (the video's sound
// would play into a call), and a recording that something else got into is never prepared for
// analysis. The recording stops at its limit (at most ten minutes, owner's choice).

const run = promisify(execFile);

export const RECORD_MAX_SECONDS = 600;

export async function readDevicePresence(recorderPath, { exec = run } = {}) {
  const { stdout } = await exec(recorderPath, ["--presence"], { timeout: 10_000 });
  const value = JSON.parse(stdout.trim().split("\n").at(-1));
  return { camera: value.camera === true, microphone: value.microphone === true };
}

// A call or an interview is under way: the recorded video's sound would play into it.
export function ownerOnCall(presence) {
  return presence?.camera === true || presence?.microphone === true;
}

// Why a running recording must stop now, or null to keep going.
export function autoStopReason({ elapsedSeconds, maxSeconds }) {
  return elapsedSeconds >= maxSeconds ? "time_limit" : null;
}

export function recordFolderName(createdAt, tag, label = null) {
  const stamp = new Date(createdAt).toISOString().replace(/\.\d+Z$/u, "").replace(/[-:]/gu, "").replace("T", "-");
  const name = typeof label === "string" ? label.normalize("NFC").replace(/[^\p{L}\p{N}_-]+/gu, "_").replace(/^_+|_+$/gu, "").slice(0, 40) : "";
  return `record-${stamp}-${tag ?? "session"}${name ? `-${name}` : ""}`;
}

// The page part of the recorded window (below the tab strip and the address bar), in movie pixels.
export function pageCrop({ videoWidth, videoHeight, windowBounds, viewport }) {
  const even = value => Math.max(2, Math.floor(value / 2) * 2);
  if (![videoWidth, videoHeight, windowBounds?.width, windowBounds?.height, viewport?.width, viewport?.height].every(value => Number.isFinite(value) && value > 0)) return null;
  const scaleX = videoWidth / windowBounds.width;
  const scaleY = videoHeight / windowBounds.height;
  const width = even(Math.min(videoWidth, viewport.width * scaleX));
  const height = even(Math.min(videoHeight, viewport.height * scaleY));
  return { x: 0, y: Math.max(0, videoHeight - height), width, height };
}

async function probe(exec, ffprobe, file) {
  const { stdout } = await exec(ffprobe, ["-v", "error", "-show_entries", "format=duration:stream=codec_type,width,height", "-of", "json", file], { timeout: 30_000 });
  const value = JSON.parse(stdout);
  const video = (value.streams ?? []).find(stream => stream.codec_type === "video");
  return { durationSeconds: Number(value.format?.duration) || null, hasAudio: (value.streams ?? []).some(stream => stream.codec_type === "audio"),
    width: Number(video?.width) || null, height: Number(video?.height) || null };
}

// Moves the finished movie into its own folder and adds what an AI can read: the page part as
// analysis.mp4 (only when nothing else got into the recording), still frames every few seconds and
// the sound as its own file. The full window movie stays for the owner as recording.mov.
export async function prepareRecordingForAnalysis({ moviePath, outDir, windowBounds = null, viewport = null, blockedReasons = [],
  frameEverySeconds = 2, maxFrames = 150, ffmpeg = "ffmpeg", ffprobe = "ffprobe", exec = run }) {
  mkdirSync(join(outDir, "frames"), { recursive: true, mode: 0o700 });
  const raw = join(outDir, "recording.mov");
  renameSync(moviePath, raw);
  let info = { durationSeconds: null, hasAudio: false, width: null, height: null };
  try { info = await probe(exec, ffprobe, raw); } catch { /* frames below still tell what the video shows */ }
  const { durationSeconds, hasAudio } = info;
  const crop = pageCrop({ videoWidth: info.width, videoHeight: info.height, windowBounds, viewport });
  const cropFilter = crop ? [`crop=${crop.width}:${crop.height}:${crop.x}:${crop.y}`] : [];
  const blocked = blockedReasons.length > 0;
  if (blocked) writeFileSync(join(outDir, "unsafe.json"), `${JSON.stringify({ reasons: blockedReasons }, null, 2)}\n`, { mode: 0o600 });
  let video = null;
  let videoError = null;
  if (!blocked) {
    try {
      await exec(ffmpeg, ["-y", "-hide_banner", "-loglevel", "error", "-i", raw,
        ...(cropFilter.length ? ["-vf", cropFilter.join(",")] : []),
        "-c:v", "libx264", "-preset", "veryfast", "-crf", "28", "-pix_fmt", "yuv420p",
        ...(hasAudio ? ["-c:a", "aac", "-b:a", "128k"] : ["-an"]), "-movflags", "+faststart", join(outDir, "analysis.mp4")], { timeout: 600_000 });
      video = join(outDir, "analysis.mp4");
    } catch (error) { videoError = String(error?.stderr || error?.message || error).slice(-300); }
  }
  let framesError = null;
  // macOS sends a new video frame only when the window changes, so a still page leaves the video track
  // shorter than the recording (2026-10-19: 4.4 s of video in an 8.3 s recording gave 2 frames instead
  // of 5). Hold the last picture to the full length so there is a frame every few seconds to the end.
  const hold = durationSeconds ? [`tpad=stop_mode=clone:stop_duration=${Math.ceil(durationSeconds) + 1}`] : [];
  try {
    await exec(ffmpeg, ["-y", "-hide_banner", "-loglevel", "error", "-i", raw,
      "-vf", [...cropFilter, ...hold, `fps=1/${frameEverySeconds}`, "scale='min(960,iw)':-2"].join(","),
      ...(durationSeconds ? ["-t", String(durationSeconds)] : []),
      "-frames:v", String(maxFrames), "-q:v", "4", join(outDir, "frames", "%04d.jpg")], { timeout: 300_000 });
  } catch (error) { framesError = String(error?.stderr || error?.message || error).slice(-300); }
  let audio = null;
  let audioError = null;
  let audioMaxDb = null;
  if (hasAudio) {
    try {
      await exec(ffmpeg, ["-y", "-hide_banner", "-loglevel", "error", "-i", raw, "-vn", "-c:a", "aac", "-b:a", "96k", join(outDir, "audio.m4a")], { timeout: 300_000 });
      audio = join(outDir, "audio.m4a");
    } catch (error) { audioError = String(error?.stderr || error?.message || error).slice(-300); }
    try {
      const { stderr } = await exec(ffmpeg, ["-hide_banner", "-nostats", "-i", raw, "-vn", "-af", "volumedetect", "-f", "null", "-"], { timeout: 120_000 });
      const found = /max_volume:\s*(-?[\d.]+) dB/u.exec(String(stderr));
      audioMaxDb = found ? Number(found[1]) : null;
    } catch { /* the level stays unknown */ }
  }
  let names = [];
  try { names = readdirSync(join(outDir, "frames")).filter(name => name.endsWith(".jpg")).sort(); } catch { /* none */ }
  return {
    folder: outDir, video, rawVideo: raw, cropped: crop !== null, analysisBlocked: blocked ? blockedReasons : null, videoError,
    durationSeconds, hasAudio, audio, audioError, audioMaxDb, audioSilent: audioMaxDb !== null ? audioMaxDb < -50 : !hasAudio,
    framesError, frameEverySeconds,
    frames: names.map((name, index) => ({ path: join(outDir, "frames", name), atSeconds: index * frameEverySeconds })),
  };
}
