import { execFile } from "node:child_process";
import { mkdirSync, readdirSync, renameSync } from "node:fs";
import { join } from "node:path";
import { promisify } from "node:util";

// A real recording (moving video with sound) for what a slideshow replay cannot show: short videos
// on TikTok or Instagram to analyse without downloading them, and how a moving page feels
// (owner, 2026-10-19). The native recorder captures the frontmost Chrome window, so Chrome comes to
// the front; the owner allowed that only while the Mac is not in use: no input for a few minutes and
// no camera or microphone in use (a video interview). The recording stops at its limit (at most ten
// minutes, owner's choice), when the owner comes back, or when a call starts.

const run = promisify(execFile);

export const RECORD_MAX_SECONDS = 600;
export const OWNER_IDLE_SECONDS = 180;
// Input within this many seconds after a longer pause means the owner is back at the Mac.
export const OWNER_RETURN_SECONDS = 20;

export async function readIdleSeconds({ exec = run } = {}) {
  const { stdout } = await exec("/usr/sbin/ioreg", ["-c", "IOHIDSystem", "-d", "4"], { timeout: 5_000, maxBuffer: 8 << 20 });
  const match = /"HIDIdleTime"\s*=\s*(\d+)/u.exec(stdout);
  if (!match) throw Object.assign(new Error("Could not read the time since the last keyboard or mouse input"), { code: "owner_idle_unknown" });
  return Number(match[1]) / 1e9;
}

export async function readDevicePresence(recorderPath, { exec = run } = {}) {
  const { stdout } = await exec(recorderPath, ["--presence"], { timeout: 10_000 });
  const value = JSON.parse(stdout.trim().split("\n").at(-1));
  return { camera: value.camera === true, microphone: value.microphone === true };
}

export async function frontmostBundleId({ exec = run } = {}) {
  try {
    const { stdout: asn } = await exec("/usr/bin/lsappinfo", ["front"], { timeout: 5_000 });
    const { stdout } = await exec("/usr/bin/lsappinfo", ["info", "-only", "bundleid", asn.trim()], { timeout: 5_000 });
    return /"CFBundleIdentifier"="([^"]+)"/u.exec(stdout)?.[1] ?? null;
  } catch {
    return null;
  }
}

export async function bringAppToFront(bundleId, { exec = run } = {}) {
  if (!bundleId || bundleId === "com.google.Chrome" || !/^[A-Za-z0-9.-]+$/u.test(bundleId)) return false;
  try { await exec("/usr/bin/open", ["-b", bundleId], { timeout: 10_000 }); return true; } catch { return false; }
}

// Why recording may not start now, or null when the owner is away.
export function ownerPresenceBlocker({ idleSeconds, camera, microphone }, { minIdleSeconds = OWNER_IDLE_SECONDS } = {}) {
  if (camera) return { code: "owner_on_camera", message: "A camera is in use (a call or an interview); Chrome is not brought to the front now" };
  if (microphone) return { code: "owner_on_microphone", message: "A microphone is in use (a call or an interview); Chrome is not brought to the front now" };
  if (!(idleSeconds >= minIdleSeconds)) {
    return { code: "owner_active", message: `The owner used the Mac ${Math.round(idleSeconds)} seconds ago; recording waits until there has been no input for ${minIdleSeconds} seconds` };
  }
  return null;
}

// Why a running recording must stop now, or null to keep going.
export function autoStopReason({ elapsedSeconds, maxSeconds, idleSeconds, previousIdleSeconds, camera, microphone }) {
  if (elapsedSeconds >= maxSeconds) return "time_limit";
  if (camera || microphone) return "owner_call_started";
  if (Number.isFinite(idleSeconds) && Number.isFinite(previousIdleSeconds)
    && idleSeconds < previousIdleSeconds && idleSeconds < OWNER_RETURN_SECONDS) return "owner_returned";
  return null;
}

export function recordFolderName(createdAt, tag, label = null) {
  const stamp = new Date(createdAt).toISOString().replace(/\.\d+Z$/u, "").replace(/[-:]/gu, "").replace("T", "-");
  const name = typeof label === "string" ? label.normalize("NFC").replace(/[^\p{L}\p{N}_-]+/gu, "_").replace(/^_+|_+$/gu, "").slice(0, 40) : "";
  return `record-${stamp}-${tag ?? "session"}${name ? `-${name}` : ""}`;
}

// Moves the finished movie into its own folder and adds what an AI can read: still frames every
// few seconds and the sound as its own file. The movie itself stays for the owner.
export async function prepareRecordingForAnalysis({ moviePath, outDir, frameEverySeconds = 2, maxFrames = 150, ffmpeg = "ffmpeg", ffprobe = "ffprobe", exec = run }) {
  mkdirSync(join(outDir, "frames"), { recursive: true, mode: 0o700 });
  const video = join(outDir, "recording.mov");
  renameSync(moviePath, video);
  let durationSeconds = null;
  let hasAudio = false;
  try {
    const { stdout } = await exec(ffprobe, ["-v", "error", "-show_entries", "format=duration:stream=codec_type", "-of", "json", video], { timeout: 30_000 });
    const probe = JSON.parse(stdout);
    durationSeconds = Number(probe.format?.duration) || null;
    hasAudio = (probe.streams ?? []).some(stream => stream.codec_type === "audio");
  } catch { /* frames below still tell what the video shows */ }
  let framesError = null;
  try {
    await exec(ffmpeg, ["-y", "-hide_banner", "-loglevel", "error", "-i", video, "-vf", `fps=1/${frameEverySeconds},scale='min(960,iw)':-2`,
      "-frames:v", String(maxFrames), "-q:v", "4", join(outDir, "frames", "%04d.jpg")], { timeout: 300_000 });
  } catch (error) { framesError = String(error?.stderr || error?.message || error).slice(-300); }
  let audio = null;
  let audioError = null;
  if (hasAudio) {
    try {
      await exec(ffmpeg, ["-y", "-hide_banner", "-loglevel", "error", "-i", video, "-vn", "-c:a", "aac", "-b:a", "96k", join(outDir, "audio.m4a")], { timeout: 300_000 });
      audio = join(outDir, "audio.m4a");
    } catch (error) { audioError = String(error?.stderr || error?.message || error).slice(-300); }
  }
  let names = [];
  try { names = readdirSync(join(outDir, "frames")).filter(name => name.endsWith(".jpg")).sort(); } catch { /* none */ }
  return {
    folder: outDir, video, durationSeconds, hasAudio, audio, audioError, framesError, frameEverySeconds,
    frames: names.map((name, index) => ({ path: join(outDir, "frames", name), atSeconds: index * frameEverySeconds })),
  };
}
