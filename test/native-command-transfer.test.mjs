import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import vm from "node:vm";
import test from "node:test";
import { NativeCommandAssembler, MAX_COMMAND_TRANSFER_BYTES } from "../extension/native-command-transfer.js";
import { executeWithExpectedDialog } from "../extension/action-event-wait.js";
import { encodeNativeCommand } from "../src/shared/native-command-transfer.mjs";
import { NativeMessageDecoder } from "../src/shared/framing.mjs";
import { MAX_NATIVE_MESSAGE_BYTES, MAX_EXTENSION_MESSAGE_BYTES } from "../src/shared/constants.mjs";
import { createUserControls } from "../extension/user-controls.js";

function command(method = "page.upload") {
  return { kind: "command.request", operationId: "op-upload", profileInstanceId: "profile-a", generation: "gen-a", method,
    taskId: "task-a", taskLabel: "日本語のタスク 👩🏽‍💻", params: { file: { name: "履歴書.pdf", dataBase64: Buffer.alloc(2 * 1024 * 1024, 137).toString("base64") } } };
}

function packets(value) {
  const decoder = new NativeMessageDecoder();
  return [...encodeNativeCommand(value)].flatMap((frame) => {
    assert.ok(frame.readUInt32LE(0) <= MAX_NATIVE_MESSAGE_BYTES);
    return decoder.push(frame);
  });
}

test("large upload commands cross native frames without changing Japanese text or binary bytes", async () => {
  for (const method of ["page.upload", "page.uploadMultiple", "clipboard.write"]) {
    const original = command(method);
    const chunks = packets(original);
    assert.ok(chunks.length > 1);
    const receiver = new NativeCommandAssembler();
    for (const chunk of chunks.slice(0, -1)) assert.equal(await receiver.accept(chunk), null);
    assert.deepEqual(await receiver.accept(chunks.at(-1)), original);
  }
  const small = { kind: "command.request", method: "page.query", params: { query: "日本語" } };
  assert.deepEqual(packets(small), [small]);
});

test("a 2 MiB MIME clipboard write is reassembled once without exposing an oversized native frame", async () => {
  const original = { ...command("clipboard.write"), params: { approved:true, formats:[{mimeType:"text/html",dataBase64:Buffer.alloc(2*1024*1024,65).toString("base64")}] } };
  const chunks = packets(original), receiver = new NativeCommandAssembler();
  assert.ok(chunks.length > 1);
  for (const chunk of chunks.slice(0,-1)) assert.equal(await receiver.accept(chunk),null);
  assert.deepEqual(await receiver.accept(chunks.at(-1)),original);
  await assert.rejects(receiver.accept(chunks.at(-1)),{code:"native_command_transfer_invalid"});
  receiver.clear();
});

test("corrupt, missing, oversized, reordered and changed-envelope fragments never yield a command", async () => {
  const chunks = packets(command());
  for (const variant of [
    [chunks[1]],
    [chunks[0], chunks[0]],
    [{ ...chunks[0], totalBytes: MAX_COMMAND_TRANSFER_BYTES + 1 }],
    [chunks[0], { ...chunks[1], generation: "other" }],
    [chunks[0], { ...chunks[1], dataBase64: "bad!" }],
    [...chunks.slice(0, -1), { ...chunks.at(-1), dataBase64: "AAAA" + chunks.at(-1).dataBase64.slice(4) }],
  ]) {
    const receiver = new NativeCommandAssembler();
    await assert.rejects(async () => { for (const chunk of variant) await receiver.accept(chunk); }, { code: "native_command_transfer_invalid" });
    receiver.clear();
  }
  const receiver = new NativeCommandAssembler();
  await receiver.accept(chunks[0]);
  receiver.clear();
  await assert.rejects(receiver.accept(chunks[1]), { code: "native_command_transfer_invalid" });
  assert.throws(() => packets(command("page.type")), { code: "native_message_too_large" });
});

test("incomplete command transfer expires and cannot resume from a later piece", async () => {
  const chunks = packets(command());
  let expired;
  const expiration = new Promise((resolve) => { expired = resolve; });
  const receiver = new NativeCommandAssembler({ timeoutMs: 10, onExpire: expired });
  // Keep the test alive while the production cleanup timer is unref'ed.
  const keepAlive = setTimeout(() => {}, 1000);
  try {
    await receiver.accept(chunks[0]);
    assert.equal(await expiration, "op-upload");
    await assert.rejects(receiver.accept(chunks[1]), { code: "native_command_transfer_invalid" });
  } finally { clearTimeout(keepAlive); receiver.clear(); }
});

test("disconnect during digest discards the completed bytes without returning a command", async () => {
  const chunks = packets(command());
  const receiver = new NativeCommandAssembler();
  for (const chunk of chunks.slice(0, -1)) await receiver.accept(chunk);
  const completed = receiver.accept(chunks.at(-1));
  receiver.clear();
  await assert.rejects(completed, { code: "native_command_transfer_invalid" });
});

test("Chrome-to-host binary result uses its directional limit while outbound messages remain capped", () => {
  const value = { kind: "command.result", result: { dataBase64: Buffer.alloc(2 * 1024 * 1024, 99).toString("base64") } };
  const body = Buffer.from(JSON.stringify(value));
  const header = Buffer.alloc(4); header.writeUInt32LE(body.length);
  const frame = Buffer.concat([header, body]);
  assert.throws(() => new NativeMessageDecoder().push(frame), { code: "native_message_too_large" });
  const decoder = new NativeMessageDecoder({ maxBytes: MAX_EXTENSION_MESSAGE_BYTES });
  assert.deepEqual(decoder.push(frame), [value]);
  const tooLarge = Buffer.alloc(4); tooLarge.writeUInt32LE(MAX_EXTENSION_MESSAGE_BYTES + 1);
  assert.throws(() => decoder.push(tooLarge), { code: "native_message_too_large" });
});

test("real extension dispatcher executes reassembled command once and rejects an old generation", async () => {
  const source = await readFile(new URL("../extension/service-worker.js", import.meta.url), "utf8");
  const handler = source.slice(source.indexOf("async function handleNativeMessage("), source.indexOf("\nfunction sendCommandError("));
  const dispatched = [], errors = [], replies = [];
  const context = { performance, executeWithExpectedDialog, javaScriptDialogs: null, runtimeState: { port: {}, generation: "gen-a", profileInstanceId: "profile-a" },
    userControls: createUserControls({ storage: { local: { get: async () => ({}) } } }),
    commandAssembler: new NativeCommandAssembler(), MUTATION_OPERATION_METHODS: new Set(["page.upload"]),
    executeCommand: async (method, params) => { dispatched.push({ method, params }); return { uploaded: true }; },
    postNativeMessage: (message) => replies.push(message), sendCommandError: (...args) => errors.push(args) };
  vm.createContext(context); vm.runInContext(handler, context);
  const chunks = packets(command());
  for (const chunk of chunks.slice(0, -1)) { await context.handleNativeMessage(chunk); assert.equal(dispatched.length, 0); }
  await context.handleNativeMessage(chunks.at(-1));
  assert.equal(dispatched.length, 1);
  assert.equal(dispatched[0].params.taskId, "task-a");
  assert.equal(dispatched[0].params.taskLabel, command().taskLabel);
  assert.equal(replies[0].kind, "command.result");
  context.runtimeState.generation = "gen-new";
  await context.handleNativeMessage(chunks[0]);
  assert.equal(dispatched.length, 1);
  assert.equal(errors[0][1], "extension_generation_stale");
  const broken = packets({ ...command(), generation: "gen-new", operationId: "op-corrupt" });
  broken.at(-1).dataBase64 = "AAAA" + broken.at(-1).dataBase64.slice(4);
  for (const chunk of broken) await context.handleNativeMessage(chunk);
  assert.equal(dispatched.length, 1);
  assert.equal(errors[1][1], "native_command_transfer_invalid");
  assert.equal(errors[1][3].operationEffectState, "none");
  assert.equal(errors[1][3].mutationDispatchAttempted, false);
});
