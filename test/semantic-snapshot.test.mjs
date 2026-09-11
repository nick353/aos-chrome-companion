import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import test from "node:test";
import { mergeSemanticSnapshotResults } from "../extension/semantic-snapshot.js";

test("semantic snapshots merge meaningful iframe content when the main frame is empty", () => {
  const snapshot = mergeSemanticSnapshotResults([
    { frameId: 0, result: { url: "https://example.test/", title: "Shell", readyState: "complete", pageInstanceId: "main-doc", text: "", controls: [] } },
    { frameId: 4, result: { url: "https://form.example.test/", title: "Form", readyState: "complete", pageInstanceId: "frame-doc", text: "応募フォーム", controls: [{ tag: "button", role: "button", name: "送信" }] } },
  ], 30_000);
  assert.equal(snapshot.url, "https://example.test/");
  assert.equal(snapshot.text, "応募フォーム");
  assert.equal(snapshot.controls[0].frameId, 4);
  assert.equal(snapshot.frames[1].url, "https://form.example.test/");
  assert.equal(snapshot.frames[1].pageInstanceId, "frame-doc");
  assert.equal(snapshot.frameCount, 2);
  assert.equal(snapshot.semanticEmpty, false);
});

test("semantic snapshots stay bounded and report a truly empty multi-frame result", () => {
  const bounded = mergeSemanticSnapshotResults([
    { frameId: 0, result: { url: "https://example.test/", title: "Bounded", readyState: "complete", text: "abcdef", controls: [] } },
  ], 4);
  assert.equal(bounded.text, "abcd");
  const empty = mergeSemanticSnapshotResults([
    { frameId: 0, result: { url: "https://example.test/", title: "Empty", readyState: "complete", text: "", controls: [] } },
    { frameId: 2, result: { url: "https://frame.example.test/", title: "Empty frame", readyState: "complete", text: "", controls: [] } },
  ]);
  assert.equal(empty.semanticEmpty, true);
});

test("extension snapshot execution covers all frames and open shadow roots", async () => {
  const source = await readFile(resolve("extension/service-worker.js"), "utf8");
  assert.match(source, /allFrames: true/);
  assert.match(source, /frameIds: \[requestedFrameId\]/);
  assert.match(source, /target_frame_origin_not_allowed/);
  assert.match(source, /element\.shadowRoot/);
  assert.match(source, /querySemantic/);
  assert.match(source, /valuePresent/);
});
