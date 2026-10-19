import { execFile, spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { access, mkdir, stat } from "node:fs/promises";
import { createReadStream } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { CompanionError } from "../shared/errors.mjs";

const execFileAsync = promisify(execFile);
const SUPPORT_DIR = join(homedir(), "Library", "Application Support", "AOS Chrome Companion");
const RECORDINGS_DIR = join(SUPPORT_DIR, "Recordings");
const RECORDER = join(SUPPORT_DIR, "bin", "aos-chrome-companion-recorder");
const START_TIMEOUT_MS = 8_000;
const STOP_TIMEOUT_MS = 12_000;
const TERMINATE_TIMEOUT_MS = 3_000;
const KILL_TIMEOUT_MS = 1_500;

// CompanionError keeps code and details across the broker, so the AI sees why a recording did not
// start (2026-10-19: a plain Error lost the recorder's reason on the way and arrived as internal_error).
const error = (code, message, details = {}) => new CompanionError(code, message, details);

// The recording window's place on screen, passed to the recorder so it records that window even
// while another app is in front.
export function recorderArguments(recordingPath, windowBounds) {
  const args = ["--output", recordingPath];
  if (windowBounds === undefined || windowBounds === null) return args;
  const values = ["left", "top", "width", "height"].map(key => Number(windowBounds?.[key]));
  if (!values.every(Number.isFinite) || values[2] <= 0 || values[3] <= 0) {
    throw error("recording_window_bounds_invalid", "Give the recording window's left, top, width and height");
  }
  return [...args, "--bounds", values.join(",")];
}
const safeName = (value) => String(value || `companion-${Date.now()}`).replace(/[^a-zA-Z0-9._-]+/g, "-").slice(0, 120);

function waitFor(promise, timeoutMs, code, message) {
  let timer;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => reject(error(code, message)), timeoutMs);
    timer.unref?.();
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

async function inspectMedia(recordingPath, execFileImpl = execFileAsync) {
  try {
    const { stdout } = await execFileImpl("ffprobe", [
      "-v", "error",
      "-count_packets",
      "-show_entries", "format=duration:stream=codec_type,codec_name,duration,nb_frames,nb_read_packets",
      "-of", "json", recordingPath,
    ], { maxBuffer: 1024 * 1024 });
    const payload = JSON.parse(stdout);
    const streams = Array.isArray(payload.streams) ? payload.streams : [];
    const video = streams.find(stream => stream.codec_type === "video");
    const audio = streams.find(stream => stream.codec_type === "audio");
    const videoFrames = Number(video?.nb_frames || video?.nb_read_packets || 0);
    const audioPackets = Number(audio?.nb_read_packets || 0);
    const videoDurationSeconds = Number(video?.duration || payload.format?.duration || 0);
    const audioDurationSeconds = Number(audio?.duration || 0);
    const audioTrackVerified = Boolean(audio && audioPackets > 0 && audioDurationSeconds > 0);
    const mediaVerified = Boolean(video && videoFrames >= 2 && videoDurationSeconds > 0 && audioTrackVerified);
    return {
      mediaVerified,
      audioTrackVerified,
      videoFrames,
      audioPackets,
      videoDurationSeconds,
      audioDurationSeconds,
      ...(mediaVerified ? { videoCodec: video.codec_name, audioCodec: audio.codec_name } : {
        mediaVerificationReason: "missing_video_audio_packets_or_frames",
      }),
    };
  } catch (cause) {
    return {
      mediaVerified: false,
      audioTrackVerified: false,
      mediaVerificationReason: "media_probe_unavailable_or_invalid_media",
      mediaVerificationError: String(cause?.message || cause).slice(0, 500),
    };
  }
}

function publicState(recording, lastResult) {
  const active = recording !== null;
  return {
    active,
    phase: recording?.phase ?? lastResult?.phase ?? "idle",
    recordingPath: recording?.recordingPath ?? lastResult?.recordingPath ?? null,
    filename: recording?.filename ?? lastResult?.filename ?? null,
    startedAt: recording?.startedAt ?? lastResult?.startedAt ?? null,
    stoppedAt: lastResult?.stoppedAt ?? null,
    audioRequested: active ? true : lastResult?.audioRequested === true,
    audioCaptured: active ? false : lastResult?.audioCaptured === true,
    audioTrackVerified: active ? false : lastResult?.audioTrackVerified === true,
    mediaVerified: active ? false : lastResult?.mediaVerified === true,
    captureTarget: recording?.captureTarget ?? lastResult?.captureTarget ?? null,
    lastError: recording?.lastError ?? lastResult?.lastError ?? null,
    lastResult: lastResult ? { ...lastResult } : null,
    surface: "chrome-window",
    captureEngine: "ScreenCaptureKit+SCRecordingOutput",
  };
}

function mediaEvidenceFromHelper(recording) {
  const line = recording.stdout.split(/\r?\n/u).find(value => value.startsWith("native_recording_stopped "));
  if (!line) return null;
  const field = name => new RegExp(`(?:^|\\s)${name}=([^\\s]+)`, "u").exec(line)?.[1] ?? null;
  const audioSamples = Number(field("audio_samples"));
  const videoFrames = Number(field("video_frames"));
  const durationSeconds = Number(field("duration_seconds"));
  const audioTrackVerified = field("audio_track") === "1" && Number.isSafeInteger(audioSamples) && audioSamples > 0;
  const mediaVerified = audioTrackVerified && Number.isSafeInteger(videoFrames) && videoFrames >= 2
    && Number.isFinite(durationSeconds) && durationSeconds > 0;
  return {
    mediaVerified,
    audioTrackVerified,
    audioSamples: Number.isSafeInteger(audioSamples) ? audioSamples : 0,
    videoFrames: Number.isSafeInteger(videoFrames) ? videoFrames : 0,
    videoDurationSeconds: Number.isFinite(durationSeconds) ? durationSeconds : 0,
    audioDurationSeconds: Number.isFinite(durationSeconds) && audioTrackVerified ? durationSeconds : 0,
    mediaVerificationReason: mediaVerified ? undefined : "native_helper_media_evidence_incomplete",
  };
}

/**
 * A small injectable controller keeps process handles private and lets tests
 * exercise stop races/timeouts without launching ScreenCaptureKit.
 */
export function createNativeRecordingController({
  recorderPath = RECORDER,
  recordingsDir = RECORDINGS_DIR,
  spawnProcess = spawn,
  execFileImpl = execFileAsync,
  accessPath = access,
  makeDirectory = mkdir,
  statFile = stat,
  startTimeoutMs = START_TIMEOUT_MS,
  stopTimeoutMs = STOP_TIMEOUT_MS,
  terminateTimeoutMs = TERMINATE_TIMEOUT_MS,
  killTimeoutMs = KILL_TIMEOUT_MS,
} = {}) {
  let active = null;
  let lastResult = null;

  function status() {
    return publicState(active, lastResult);
  }

  async function start(params = {}) {
    if (active) throw error("recording_already_active", "A Companion native recording is already active", { recordingPath: active.recordingPath });
    await accessPath(recorderPath).catch(() => {
      throw error("recording_native_helper_missing", "The Companion native recording helper is not installed");
    });
    await makeDirectory(recordingsDir, { recursive: true, mode: 0o700 });
    const filename = `${safeName(params.filename || `companion-${Date.now()}`)}.mov`;
    const recordingPath = join(recordingsDir, filename);
    const args = recorderArguments(recordingPath, params.windowBounds);
    const captureTarget = args.includes("--bounds") ? "recording_window" : "frontmost_chrome_window";
    const child = spawnProcess(recorderPath, args, { stdio: ["pipe", "pipe", "pipe"] });
    let resolveExit;
    const record = {
      child,
      recordingPath,
      filename,
      startedAt: new Date().toISOString(),
      phase: "starting",
      stdout: "",
      stderr: "",
      startSeen: false,
      stopSignalSent: false,
      stopPromise: null,
      exitInfo: null,
      lastError: null,
      exitPromise: new Promise(resolve => { resolveExit = resolve; }),
      resolveExit,
      startPromise: null,
      captureTarget,
      resolveStart: null,
      rejectStart: null,
    };
    record.startPromise = new Promise((resolve, reject) => {
      record.resolveStart = resolve;
      record.rejectStart = reject;
    });
    active = record;

    child.stdout.on("data", chunk => {
      record.stdout = `${record.stdout}${chunk.toString()}`.slice(-16_000);
      if (record.stdout.includes("native_recording_started") && !record.startSeen) {
        record.startSeen = true;
        record.phase = "recording";
        record.resolveStart();
      }
    });
    child.stderr.on("data", chunk => {
      record.stderr = `${record.stderr}${chunk.toString()}`.slice(-8_000);
    });
    child.once("error", cause => {
      record.exitInfo = { error: cause };
      record.rejectStart(error("recording_start_failed", "Native recording helper could not start", { message: String(cause?.message || cause).slice(0, 500) }));
      record.resolveExit(record.exitInfo);
    });
    child.once("exit", (code, signal) => {
      record.exitInfo = { code, signal };
      if (!record.startSeen) {
        const reason = /native_recording_[a-z_]+/u.exec(record.stderr)?.[0] ?? null;
        record.rejectStart(error("recording_start_failed", `Native recording helper exited before confirming capture${reason ? ` (${reason})` : ""}`, {
          code, signal, reason, stderr: record.stderr.trim().slice(-2_000), stdout: record.stdout.trim().slice(-2_000),
        }));
      } else if (record.phase === "recording") {
        record.phase = "helper_exited";
        record.lastError = code === 0 ? null : "recording_helper_exited_unexpectedly";
      }
      record.resolveExit(record.exitInfo);
    });

    try {
      await waitFor(record.startPromise, startTimeoutMs, "recording_start_timeout", "Native recording helper did not confirm start");
      return {
        active: true,
        phase: "recording",
        recordingPath,
        filename,
        startedAt: record.startedAt,
        audioRequested: true,
        audioCaptured: false,
        audioTrackVerified: false,
        mediaVerified: false,
        captureTarget,
        surface: "chrome-window",
        captureEngine: "ScreenCaptureKit+SCRecordingOutput",
        scope: "window",
      };
    } catch (cause) {
      record.phase = "start_failed_stopping";
      record.lastError = cause?.code ?? "recording_start_failed";
      try { child.stdin.end(); record.stopSignalSent = true; } catch { /* signal escalation below */ }
      try { child.kill("SIGTERM"); } catch { /* bounded wait still applies */ }
      try {
        await waitFor(record.exitPromise, terminateTimeoutMs, "recording_helper_stop_timeout", "Failed recorder did not exit after start failure");
        if (active === record) active = null;
      } catch {
        record.phase = "stop_failed";
      }
      throw cause;
    }
  }

  async function stop() {
    const record = active;
    if (!record) throw error("recording_not_active", "No Companion native recording is active");
    if (record.stopPromise) return record.stopPromise;

    record.phase = "stopping";
    record.stopPromise = (async () => {
      try {
        if (!record.exitInfo) {
          if (!record.stopSignalSent) {
            record.stopSignalSent = true;
            record.child.stdin.end();
          }
          try {
            await waitFor(record.exitPromise, stopTimeoutMs, "recording_stop_timeout", "Native recording helper did not finalize before its deadline");
          } catch (stopError) {
            record.phase = "terminating";
            try { record.child.kill("SIGTERM"); } catch { /* escalate to SIGKILL after the bounded wait */ }
            try {
              await waitFor(record.exitPromise, terminateTimeoutMs, "recording_terminate_timeout", "Native recording helper did not exit after SIGTERM");
            } catch {
              try { record.child.kill("SIGKILL"); } catch { /* final wait remains bounded */ }
              await waitFor(record.exitPromise, killTimeoutMs, "recording_kill_timeout", "Native recording helper did not exit after SIGKILL");
            }
            if (!record.exitInfo) throw stopError;
          }
        }
        if (record.exitInfo?.error) {
          throw error("recording_stop_failed", "Native recording helper failed", { message: String(record.exitInfo.error?.message || record.exitInfo.error).slice(0, 500) });
        }
        if (record.exitInfo?.code !== 0) {
          throw error("recording_stop_failed", "Native recording helper failed to finalize", {
            code: record.exitInfo?.code ?? null,
            signal: record.exitInfo?.signal ?? null,
            stderr: record.stderr.trim().slice(-2_000),
          });
        }
        const file = await statFile(record.recordingPath).catch(() => null);
        if (!file || file.size < 1) throw error("recording_empty", "Native recording produced no media bytes");
        const digest = createHash("sha256");
        await new Promise((resolve, reject) => {
          const stream = createReadStream(record.recordingPath);
          stream.on("data", chunk => digest.update(chunk));
          stream.once("end", resolve);
          stream.once("error", reject);
        });
        const media = mediaEvidenceFromHelper(record) ?? await inspectMedia(record.recordingPath, execFileImpl);
        const result = {
          active: false,
          phase: "finalized",
          recordingPath: record.recordingPath,
          filename: record.filename,
          startedAt: record.startedAt,
          bytes: file.size,
          sha256: digest.digest("hex"),
          audioRequested: true,
          audioTrackVerified: media.audioTrackVerified === true,
          audioCaptured: media.audioTrackVerified === true,
          ...media,
          captureTarget: record.captureTarget,
          surface: "chrome-window",
          captureEngine: "ScreenCaptureKit+SCRecordingOutput",
          scope: "window",
          stoppedAt: new Date().toISOString(),
          helper: "native",
        };
        lastResult = result;
        if (active === record) active = null;
        return { ...result };
      } catch (cause) {
        record.lastError = cause?.code ?? "recording_stop_failed";
        if (record.exitInfo) {
          lastResult = {
            active: false,
            phase: "failed",
            recordingPath: record.recordingPath,
            filename: record.filename,
            startedAt: record.startedAt,
            audioRequested: true,
            audioCaptured: false,
            audioTrackVerified: false,
            mediaVerified: false,
            lastError: record.lastError,
          };
          if (active === record) active = null;
        } else {
          record.phase = "stop_failed";
          record.stopPromise = null;
        }
        throw cause;
      }
    })();
    return record.stopPromise;
  }

  async function finalizeOnDisconnect() {
    if (!active) return { attempted: false, finalized: false, reason: "not_recording" };
    try {
      const result = await stop();
      return { attempted: true, finalized: result.phase === "finalized", mediaVerified: result.mediaVerified === true };
    } catch (cause) {
      return { attempted: true, finalized: false, reason: cause?.code ?? "recording_disconnect_finalize_failed" };
    }
  }

  return { status, start, stop, finalizeOnDisconnect };
}

const controller = createNativeRecordingController();

export async function nativeRecordingStatus() {
  return controller.status();
}

export async function startNativeRecording(params = {}) {
  return controller.start(params);
}

export async function stopNativeRecording() {
  return controller.stop();
}

export async function finalizeNativeRecordingOnDisconnect() {
  return controller.finalizeOnDisconnect();
}
