import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { BrokerClient } from "../src/client/broker-client.mjs";

function createFakePeer(onSend) {
  const messageListeners = new Set();
  const closeListeners = new Set();
  let closed = false;
  return {
    send(message) {
      if (closed) throw new Error("fake peer closed");
      onSend?.(message, (reply) => {
        queueMicrotask(() => {
          for (const listener of messageListeners) listener(reply);
        });
      });
    },
    onMessage(listener) {
      messageListeners.add(listener);
      return () => messageListeners.delete(listener);
    },
    onClose(listener) {
      closeListeners.add(listener);
      return () => closeListeners.delete(listener);
    },
    close() {
      if (closed) return;
      closed = true;
      for (const listener of closeListeners) listener();
    },
  };
}

async function reconnectHarness(t, handlers) {
  const dataDir = await mkdtemp(join(tmpdir(), "aos-companion-client-reconnect-"));
  t.after(() => rm(dataDir, { recursive: true, force: true }));
  const env = {
    ...process.env,
    AOS_CHROME_COMPANION_DATA_DIR: dataDir,
    AOS_CHROME_COMPANION_SECRET_FILE: join(dataDir, "secret"),
    AOS_CHROME_COMPANION_CODEX_MCP_ISSUER_SECRET_FILE: join(dataDir, "issuer"),
  };
  let attempts = 0;
  const connectPeerFactory = async () => {
    const handler = handlers[attempts] ?? handlers.at(-1);
    attempts += 1;
    return createFakePeer(handler);
  };
  const client = await BrokerClient.connect({ env, connectPeerFactory, autoStart: false });
  t.after(() => client.close());
  return { client, attempts: () => attempts };
}

test("read-only broker status reconnects once after a stale socket timeout", async (t) => {
  const harness = await reconnectHarness(t, [
    () => {},
    (message, reply) => reply({ id: message.id, ok: true, result: { protocolVersion: "test", profiles: [] } }),
  ]);
  t.mock.timers.enable({ apis: ["setTimeout", "Date"] });
  const statusPromise = harness.client.request("status.get", {}, { timeoutMs: 1000 });
  t.mock.timers.tick(500);
  const status = await statusPromise;
  assert.equal(status.protocolVersion, "test");
  assert.equal(harness.attempts(), 2);
  assert.deepEqual(harness.client.connectionInfo(), {
    connected: true,
    connectionGeneration: 2,
    reconnectCount: 1,
  });
});

test("read-only status does not create an issuer secret after the client closes", async (t) => {
  const dataDir = await mkdtemp(join(tmpdir(), "aos-companion-client-read-only-"));
  t.after(() => rm(dataDir, { recursive: true, force: true }));
  const issuerPath = join(dataDir, "issuer");
  const peer = createFakePeer((message, reply) => reply({ id: message.id, ok: true, result: { profiles: [] } }));
  const client = new BrokerClient(peer, {
    env: {
      ...process.env,
      AOS_CHROME_COMPANION_DATA_DIR: dataDir,
      AOS_CHROME_COMPANION_CODEX_MCP_ISSUER_SECRET_FILE: issuerPath,
    },
  });
  await client.request("status.get", {}, { timeoutMs: 15 });
  client.close();
  await assert.rejects(() => import("node:fs/promises").then(({ access }) => access(issuerPath)), { code: "ENOENT" });
});

test("mutation requests are never replayed while reconnecting", async (t) => {
  const messages = [];
  const harness = await reconnectHarness(t, [message => { messages.push(message); }]);
  await assert.rejects(
    harness.client.request("task.transaction", { runId: "run_no_replay" }, { timeoutMs: 15 }),
    (error) => error.code === "broker_request_timeout",
  );
  assert.equal(messages.filter(message => message.method === "task.transaction").length, 1);
  assert.equal(messages.filter(message => message.method === "request.cancel").length, 1);
  assert.equal(messages.at(-1).params.requestId, messages[0].id);
  assert.equal(harness.attempts(), 1);
  assert.equal(harness.client.connectionInfo().reconnectCount, 0);
});

test("read-only reconnect never renews an exhausted request deadline", async t => {
  const requests = [];
  const { client, attempts } = await reconnectHarness(t, [(message) => { if (message.method === 'status.get') requests.push(message); }]);
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'] });
  const startedAt = Date.now();
  const pending = client.request('status.get', {}, { timeoutMs: 1000 }).then(value => ({ value }), error => ({ error }));
  t.mock.timers.tick(500);
  for (let turn = 0; turn < 20 && requests.length < 2; turn += 1) await Promise.resolve();
  assert.equal(attempts(), 2); assert.equal(requests.length, 2);
  assert.equal(requests[0].deadlineAt, startedAt + 500);
  assert.equal(requests[1].deadlineAt, startedAt + 1000);
  t.mock.timers.tick(500);
  assert.equal((await pending).error?.code, 'broker_request_timeout');
  assert.equal(attempts(), 2);
});


test("owned session recovery reconnects only to the original task and profile", async t => {
  const calls = [];
  const replyTo = (message, reply) => {
    calls.push(message);
    const result = message.method === "status.get"
      ? { profiles: [{ profileInstanceId: "p", connected: true }, { profileInstanceId: "foreign", connected: true }] }
      : { sessionId: calls.length === 1 ? "old" : "fresh", taskId: message.params.taskId, profileInstanceId: message.params.profileInstanceId, generation: "g", label: "mine" };
    reply({ id: message.id, ok: true, result });
  };
  const { client, attempts } = await reconnectHarness(t, [replyTo, replyTo]);
  await client.request("session.open", { taskId: "mine", profileInstanceId: "p" });
  client.peer.close();
  const recovered = await client.recoverOwnedSession({ sessionId: "old", taskId: "mine" });
  assert.equal(recovered.sessionId, "fresh");
  assert.equal(attempts(), 2);
  assert.deepEqual(calls.map(call => call.method), ["session.open", "status.get", "session.open"]);
  assert.equal(calls.at(-1).params.profileInstanceId, "p");
  assert.equal(calls.at(-1).params.taskId, "mine");
});

test("session recovery refuses unknown and foreign task bindings without requests", async t => {
  let calls = 0;
  const { client } = await reconnectHarness(t, [(message, reply) => {
    calls++;
    reply({ id: message.id, ok: true, result: { sessionId: "s", taskId: "mine", profileInstanceId: "p" } });
  }]);
  await client.request("session.open", { taskId: "mine", profileInstanceId: "p" });
  for (const params of [{ sessionId: "unknown", taskId: "mine" }, { sessionId: "s", taskId: "foreign" }]) {
    await assert.rejects(client.recoverOwnedSession(params), { code: "session_recovery_binding_missing" });
  }
  assert.equal(calls, 1);
});

test("session recovery never falls back when only a different profile is connected", async t => {
  const methods = [];
  const { client } = await reconnectHarness(t, [(message, reply) => {
    methods.push(message.method);
    reply({ id: message.id, ok: true, result: message.method === "status.get"
      ? { profiles: [{ profileInstanceId: "foreign", connected: true }] }
      : { sessionId: "s", taskId: "mine", profileInstanceId: "p" } });
  }]);
  await client.request("session.open", { taskId: "mine", profileInstanceId: "p" });
  await assert.rejects(client.recoverOwnedSession({ sessionId: "s", taskId: "mine" }), { code: "profile_not_connected" });
  assert.deepEqual(methods, ["session.open", "status.get"]);
});

test("closed sessions cannot be silently recovered", async t => {
  const { client } = await reconnectHarness(t, [(message, reply) => reply({ id: message.id, ok: true,
    result: message.method === "session.close" ? { closed: true } : { sessionId: "s", taskId: "mine", profileInstanceId: "p" } })]);
  await client.request("session.open", { taskId: "mine", profileInstanceId: "p" });
  await client.request("session.close", { sessionId: "s" });
  await assert.rejects(client.recoverOwnedSession({ sessionId: "s", taskId: "mine" }), { code: "session_recovery_binding_missing" });
});

test("a screenshot completing within its operation deadline is not cut off at the old RPC deadline", async t => {
  const { client, attempts } = await reconnectHarness(t, [(message, reply) => {
    setTimeout(() => reply({ id: message.id, ok: true, result: { kind: "screenshot", tabId: 7 } }), 25_000);
  }]);
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const result = client.request("operation.execute", { sessionId: "owned", method: "page.screenshot", params: { tabId: 7 }, timeoutMs: 30_000 });
  t.mock.timers.tick(25_000);
  assert.equal((await result).tabId, 7);
  assert.equal(attempts(), 1);
});
