import assert from "node:assert/strict";
import test from "node:test";
import { encodeNativeMessage, NativeMessageDecoder, JsonLineDecoder } from "../src/shared/framing.mjs";

test("native framing survives fragmented and combined chunks", () => {
  const first = encodeNativeMessage({ hello: "世界" });
  const second = encodeNativeMessage({ count: 2 });
  const combined = Buffer.concat([first, second]);
  const decoder = new NativeMessageDecoder();
  assert.deepEqual(decoder.push(combined.subarray(0, 3)), []);
  assert.deepEqual(decoder.push(combined.subarray(3, first.length + 2)), [{ hello: "世界" }]);
  assert.deepEqual(decoder.push(combined.subarray(first.length + 2)), [{ count: 2 }]);
});

test("broker JSON lines preserve Japanese and emoji across arbitrary socket byte boundaries", () => {
  const messages = [{ text: "日本語の本文 👩🏽‍💻", label: "見出し" }, { text: "次の行 café" }];
  const bytes = Buffer.from(messages.map(value => JSON.stringify(value) + "\n").join(""));
  const decoder = new JsonLineDecoder();
  const actual = [];
  for (const byte of bytes) actual.push(...decoder.push(Buffer.from([byte])));
  assert.deepEqual(actual, messages);
});

test("native frames preserve byte-at-a-time headers, UTF-8 bodies and subsequent messages", () => {
  const messages = [{ text: "日本語 👩🏽‍💻" }, { text: "次の本文" }, {}];
  const bytes = Buffer.concat(messages.map(encodeNativeMessage));
  const decoder = new NativeMessageDecoder();
  const actual = [];
  for (let index = 0; index < bytes.length; index += 1) actual.push(...decoder.push(bytes.subarray(index, index + 1)));
  assert.deepEqual(actual, messages);
});

test("native framing rejects invalid JSON and length before accepting a body", () => {
  const empty = Buffer.alloc(4);
  assert.throws(() => new NativeMessageDecoder().push(empty), { code: "native_message_invalid_json" });
  const oversized = Buffer.alloc(4); oversized.writeUInt32LE(1024 * 1024 + 1);
  assert.throws(() => new NativeMessageDecoder().push(oversized), { code: "native_message_too_large" });
});

test("JSON lines handle blank lines and several records after a fragmented prefix", () => {
  const decoder = new JsonLineDecoder();
  assert.deepEqual(decoder.push(Buffer.from('\n  \n{"text":"日')), []);
  assert.deepEqual(decoder.push(Buffer.from('本語"}\n\n{"next":true}\n{"pending":')), [{ text: "日本語" }, { next: true }]);
  assert.deepEqual(decoder.push(Buffer.from('false}\n')), [{ pending: false }]);
});
