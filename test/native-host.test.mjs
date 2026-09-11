import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";
import { CompanionBroker } from "../src/broker/broker.mjs";
import { DEFAULT_CAPABILITIES, PROTOCOL_VERSION } from "../src/shared/constants.mjs";
import { INSTALL_BUILD_ID } from "../src/shared/build-info.mjs";
import { encodeNativeMessage, NativeMessageDecoder, JsonLineDecoder, writeJsonLine } from "../src/shared/framing.mjs";
import { NativeCommandAssembler } from "../extension/native-command-transfer.js";
import { ensureBrokerSecret } from "../src/shared/security.mjs";

test("native host relays Chrome framing to the resident broker", async (t) => {
  const dataDir = await mkdtemp(join(tmpdir(), "aos-companion-native-"));
  const origin = "chrome-extension://aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa/";
  const env = {
    ...process.env,
    AOS_CHROME_COMPANION_DATA_DIR: dataDir,
    AOS_CHROME_COMPANION_SOCKET: join(dataDir, "broker.sock"),
    AOS_CHROME_COMPANION_SECRET_FILE: join(dataDir, "secret"),
    AOS_CHROME_COMPANION_EXTENSION_ORIGIN: origin,
    AOS_CHROME_COMPANION_AUTO_SETUP: "0",
  };
  const secret = await ensureBrokerSecret(env);
  const broker = new CompanionBroker({ socketPath: env.AOS_CHROME_COMPANION_SOCKET, secret });
  await broker.listen();
  const child = spawn(process.execPath, [resolve("src/native-host/main.mjs"), origin], {
    cwd: resolve("."),
    env,
    stdio: ["pipe", "pipe", "pipe"],
  });
  t.after(async () => {
    child.stdin.end();
    if (child.exitCode === null) child.kill("SIGTERM");
    await broker.close();
    await rm(dataDir, { recursive: true, force: true });
  });
  let stderr = "";
  child.stderr.on("data", chunk => { stderr += chunk; });
  const decoder = new NativeMessageDecoder();
  const acknowledgement = new Promise((resolvePromise, reject) => {
    const timer = setTimeout(() => reject(new Error(`Native host acknowledgement timed out: ${stderr.slice(-1200)}`)), 10_000);
    child.stdout.on("data", (chunk) => {
      for (const message of decoder.push(chunk)) {
        if (message.kind === "relay.error") { clearTimeout(timer); reject(new Error(JSON.stringify(message.error))); }
        if (message.kind === "extension.hello_ack") {
          clearTimeout(timer);
          resolvePromise(message);
        }
      }
    });
  });
  child.stdin.write(encodeNativeMessage({
    kind: "extension.hello",
    protocolVersion: PROTOCOL_VERSION,
    profileInstanceId: "profile_native_test",
    extensionRuntimeId: "runtime_native_test",
    buildId: INSTALL_BUILD_ID,
    capabilities: DEFAULT_CAPABILITIES,
  }));
  const message = await acknowledgement;
  assert.equal(message.profileInstanceId, "profile_native_test");
  assert.match(message.generation, /^gen_/);
  const relay = broker.peers.get(broker.profiles.get("profile_native_test").peerId);
  const largeCommand = { kind: "command.request", operationId: "op-transport-probe", method: "page.upload",
    profileInstanceId: message.profileInstanceId, generation: message.generation,
    taskId: "transport-only", taskLabel: "日本語の通信検証", params: { file: { dataBase64: Buffer.alloc(2 * 1024 * 1024, 151).toString("base64") } } };
  const receivedCommand = new Promise((resolvePromise, reject) => {
    const nativeDecoder = new NativeMessageDecoder();
    const assembler = new NativeCommandAssembler();
    const timer = setTimeout(() => { assembler.clear(); reject(new Error("Large native command timed out")); }, 5000);
    let chain = Promise.resolve();
    child.stdout.on("data", (chunk) => {
      for (const packet of nativeDecoder.push(chunk)) {
        if (packet.kind !== "command.chunk") continue;
        chain = chain.then(async () => {
          const assembled = await assembler.accept(packet);
          if (assembled) { clearTimeout(timer); resolvePromise(assembled); }
        }).catch((error) => { clearTimeout(timer); assembler.clear(); reject(error); });
      }
    });
  });
  writeJsonLine(relay.socket, largeCommand);
  assert.deepEqual(await receivedCommand, largeCommand);
  // The reverse direction has a 64 MiB protocol budget. Exercise the actual
  // native-host decoder with a binary-sized reply, without a browser effect.
  const largeReply = { kind: "command.result", operationId: largeCommand.operationId,
    result: { text: "日本語 👩🏽‍💻", dataBase64: largeCommand.params.file.dataBase64 } };
  const receivedReply = new Promise((resolvePromise, reject) => {
    const lines = new JsonLineDecoder();
    const timer = setTimeout(() => reject(new Error("Large native reply timed out")), 5000);
    relay.socket.on("data", (chunk) => {
      for (const value of lines.push(chunk)) if (value.operationId === largeCommand.operationId) { clearTimeout(timer); resolvePromise(value); }
    });
  });
  const replyBody = Buffer.from(JSON.stringify(largeReply));
  const replyHeader = Buffer.alloc(4); replyHeader.writeUInt32LE(replyBody.length);
  child.stdin.write(Buffer.concat([replyHeader, replyBody]));
  assert.deepEqual(await receivedReply, largeReply);
  child.stdin.end();
  await new Promise((resolvePromise) => child.once("exit", resolvePromise));
  assert.equal(child.exitCode, 0);
  await broker.close();
  await rm(dataDir, { recursive: true, force: true });
});

test("native host exits so Chrome can reconnect after the broker disconnects", async (t) => {
  const dataDir = await mkdtemp(join(tmpdir(), "aos-companion-native-reconnect-"));
  const origin = "chrome-extension://bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb/";
  const env = {
    ...process.env,
    AOS_CHROME_COMPANION_DATA_DIR: dataDir,
    AOS_CHROME_COMPANION_SOCKET: join(dataDir, "broker.sock"),
    AOS_CHROME_COMPANION_SECRET_FILE: join(dataDir, "secret"),
    AOS_CHROME_COMPANION_EXTENSION_ORIGIN: origin,
    AOS_CHROME_COMPANION_AUTO_SETUP: "0",
  };
  const secret = await ensureBrokerSecret(env);
  const broker = new CompanionBroker({ socketPath: env.AOS_CHROME_COMPANION_SOCKET, secret });
  await broker.listen();
  const child = spawn(process.execPath, [resolve("src/native-host/main.mjs"), origin], {
    cwd: resolve("."),
    env,
    stdio: ["pipe", "pipe", "pipe"],
  });
  t.after(async () => {
    child.stdin.end();
    if (child.exitCode === null) child.kill("SIGTERM");
    await broker.close();
    await rm(dataDir, { recursive: true, force: true });
  });
  let stderr = "";
  child.stderr.on("data", chunk => { stderr += chunk; });
  const decoder = new NativeMessageDecoder();
  const acknowledgement = new Promise((resolvePromise, reject) => {
    const timer = setTimeout(() => reject(new Error(`Native host acknowledgement timed out: ${stderr.slice(-1200)}`)), 10_000);
    child.stdout.on("data", (chunk) => {
      for (const message of decoder.push(chunk)) {
        if (message.kind === "relay.error") { clearTimeout(timer); reject(new Error(JSON.stringify(message.error))); }
        if (message.kind === "extension.hello_ack") {
          clearTimeout(timer);
          resolvePromise(message);
        }
      }
    });
  });
  child.stdin.write(encodeNativeMessage({
    kind: "extension.hello",
    protocolVersion: PROTOCOL_VERSION,
    profileInstanceId: "profile_native_reconnect_test",
    extensionRuntimeId: "runtime_native_reconnect_test",
    buildId: INSTALL_BUILD_ID,
    capabilities: DEFAULT_CAPABILITIES,
  }));
  await acknowledgement;

  const exit = new Promise((resolvePromise, reject) => {
    const timer = setTimeout(() => reject(new Error("Native host did not exit after broker disconnect")), 10_000);
    child.once("exit", (code) => {
      clearTimeout(timer);
      resolvePromise(code);
    });
  });
  await broker.close();
  assert.equal(await exit, 1);
  await rm(dataDir, { recursive: true, force: true });
});
