import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { EventEmitter } from "node:events";
import { PassThrough, Writable } from "node:stream";
import { createNativeRecordingController, recorderArguments } from "../src/native-host/native-recording.mjs";

const root = resolve(import.meta.dirname, "..");

test("Companion keeps the explicit tab fallback recording contract", async () => {
  const manifest = JSON.parse(await readFile(resolve(root, "extension/manifest.json"), "utf8"));
  assert.ok(manifest.permissions.includes("tabCapture"));
  assert.ok(manifest.optional_permissions.includes("downloads"));
  assert.equal(manifest.commands["recording-start"].suggested_key.mac, "Command+Shift+9");
  assert.equal(manifest.commands["recording-stop"].suggested_key.mac, "Command+Shift+0");
  const worker = await readFile(resolve(root, "extension/service-worker.js"), "utf8");
  const offscreen = await readFile(resolve(root, "extension/offscreen.js"), "utf8");
  const popup = await readFile(resolve(root, "extension/popup.js"), "utf8");
  assert.match(worker, /recording_user_gesture_required/);
  assert.match(worker, /chrome\.tabCapture\.getMediaStreamId/);
  assert.match(worker, /chrome\.commands\.onCommand/);
  assert.match(offscreen, /chromeMediaSource: "tab"/);
  assert.match(offscreen, /audioCaptured: true/);
  assert.match(offscreen, /chrome\.downloads\.download/);
  assert.match(popup, /Start tab recording with audio/);
});

test("Native recording is installed as a ScreenCaptureKit audio path", async () => {
  const source = await readFile(resolve(root, "native-recording/CompanionScreenRecorder.swift"), "utf8");
  const host = await readFile(resolve(root, "src/native-host/main.mjs"), "utf8");
  const installer = await readFile(resolve(root, "scripts/install-local-macos.mjs"), "utf8");
  assert.match(source, /configuration\.capturesAudio = true/);
  assert.match(source, /SCRecordingOutput/);
  assert.match(source, /com\.google\.Chrome/);
  assert.match(source, /frontmostChromeWindow/);
  // The recording window is found by its place on screen, so Chrome need not be in front.
  assert.match(source, /--bounds/);
  assert.match(source, /chromeWindow\(matching: bounds/);
  assert.match(source, /recording_window_ambiguous/);
  assert.doesNotMatch(source, /largestChromeWindow/);
  assert.match(source, /frontmostApplication/);
  assert.match(source, /audio_samples=/);
  assert.match(host, /nativeRecordingStatus/);
  assert.match(host, /startNativeRecording/);
  assert.match(host, /stopNativeRecording/);
  assert.match(host, /finalizeNativeRecordingOnDisconnect/);
  assert.match(installer, /"native-recording"/);
  assert.match(installer, /CompanionScreenRecorder\.swift/);
  assert.match(installer, /aos-chrome-companion-recorder/);
});

test("Native recording transactions do not depend on a disposable page tab", async () => {
  const schema = await readFile(resolve(root, "src/shared/operation-schema.mjs"), "utf8");
  const broker = await readFile(resolve(root, "src/broker/broker.mjs"), "utf8");
  assert.match(schema, /\["recording\.status", false, false, true\]/);
  assert.match(schema, /\["recording\.startAuto", false, true, true\]/);
  assert.match(schema, /\["recording\.stopAuto", false, true, true\]/);
  assert.match(broker, /#executeProfileGlobalTransaction/);
  assert.match(broker, /steps\.every\(step => !step\.targetScoped\)/);
});

async function recordingFixture(t, { finalize = true, stopTimeoutMs = 100, terminateTimeoutMs = 30, killTimeoutMs = 100 } = {}) {
  const directory = await mkdtemp(resolve(tmpdir(), "aos-native-recording-test-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const helper = resolve(directory, "recorder");
  const recordingsDir = resolve(directory, "recordings");
  await writeFile(helper, "fixture");
  const children = [];
  const controller = createNativeRecordingController({
    recorderPath: helper,
    recordingsDir,
    stopTimeoutMs,
    terminateTimeoutMs,
    killTimeoutMs,
    execFileImpl: async () => { throw new Error("ffprobe should not be needed when the helper supplies evidence"); },
    spawnProcess(_command, args) {
      const child = new EventEmitter();
      child.stdout = new PassThrough();
      child.stderr = new PassThrough();
      child.kills = [];
      child.finalizeCount = 0;
      child.exitWith = (code, signal = null) => {
        child.stdout.end();
        child.stderr.end();
        child.emit("exit", code, signal);
      };
      child.stdin = new Writable({
        write(_chunk, _encoding, callback) { callback(); },
        final(callback) {
          child.finalizeCount += 1;
          if (!finalize) { callback(); return; }
          void writeFile(args[1], "fixture-movie").then(() => {
            child.stdout.write("native_recording_stopped window_id=44 audio_track=1 audio_samples=4096 video_frames=45 duration_seconds=1.5\n");
            setTimeout(() => child.exitWith(0), 5);
            callback();
          }, callback);
        },
      });
      child.kill = signal => {
        child.kills.push(signal);
        if (signal === "SIGKILL") setTimeout(() => child.exitWith(137, signal), 5);
        return true;
      };
      children.push(child);
      setTimeout(() => child.stdout.write("native_recording_started window_id=44 target=frontmost_chrome_window audio_requested=1\n"), 0);
      return child;
    },
  });
  return { controller, children, recordingsDir };
}

test("native recording keeps process handles private and verifies audio only after finalization", async t => {
  const { controller, children } = await recordingFixture(t);
  const started = await controller.start({ filename: "resume-test" });
  assert.equal(started.audioRequested, true);
  assert.equal(started.audioCaptured, false);
  const status = controller.status();
  assert.equal(status.active, true);
  assert.equal(status.phase, "recording");
  assert.equal(status.audioCaptured, false);
  assert.equal("child" in status, false);
  assert.doesNotThrow(() => JSON.stringify(status));

  const results = await Promise.all([controller.stop(), controller.stop()]);
  assert.deepEqual(results[0], results[1]);
  assert.equal(children[0].finalizeCount, 1);
  assert.equal(results[0].phase, "finalized");
  assert.equal(results[0].audioTrackVerified, true);
  assert.equal(results[0].audioCaptured, true);
  assert.equal(results[0].mediaVerified, true);
  assert.match(results[0].sha256, /^[a-f0-9]{64}$/u);
  assert.equal(controller.status().active, false);
  assert.equal(controller.status().audioCaptured, true);
});

test("native host disconnect finalizes the recording through the shared stop path", async t => {
  const { controller, children } = await recordingFixture(t);
  await controller.start();
  const result = await controller.finalizeOnDisconnect();
  assert.deepEqual(result, { attempted: true, finalized: true, mediaVerified: true });
  assert.equal(children[0].finalizeCount, 1);
  assert.equal(controller.status().active, false);
});

test("native recording stop escalates in bounded order and keeps failure truthful", async t => {
  const { controller, children } = await recordingFixture(t, { finalize: false, stopTimeoutMs: 20, terminateTimeoutMs: 20, killTimeoutMs: 100 });
  await controller.start();
  await assert.rejects(controller.stop(), error => error.code === "recording_stop_failed");
  assert.deepEqual(children[0].kills, ["SIGTERM", "SIGKILL"]);
  assert.equal(controller.status().active, false);
  assert.equal(controller.status().audioCaptured, false);
  assert.equal(controller.status().phase, "failed");
});

test("The recorder is told which window to record by its place on screen", () => {
  assert.deepEqual(recorderArguments("/r/a.mov"), ["--output", "/r/a.mov"]);
  assert.deepEqual(recorderArguments("/r/a.mov", { left: 0, top: 25, width: 599, height: 875 }),
    ["--output", "/r/a.mov", "--bounds", "0,25,599,875"]);
  assert.throws(() => recorderArguments("/r/a.mov", { left: 0, top: 25, width: 0, height: 875 }), { code: "recording_window_bounds_invalid" });
});
