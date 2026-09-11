import assert from "node:assert/strict";
import { copyFile, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import * as z from "zod/v4";
import { transactionActionSchema } from "../src/mcp/action-schema.mjs";
import { CompanionBroker, deriveActiveReconciliationCounts, isAllowedTaskFrameOrigin, isSafePreEffectTaskTab, shouldRequestBrokerRestartForBuildMismatch } from "../src/broker/broker.mjs";
import { BrokerClient } from "../src/client/broker-client.mjs";
import { connectPeer } from "../src/client/connect.mjs";
import { DEFAULT_CAPABILITIES, PROTOCOL_VERSION } from "../src/shared/constants.mjs";
import { INSTALL_BUILD_ID } from "../src/shared/build-info.mjs";
import { ensureBrokerSecret } from "../src/shared/security.mjs";
import {
  TaskOperationLedger,
  createAuthorityEnvelope,
  deriveTaskTargetKey,
  normalizeTaskExecutionCapsule,
  taskTabIdentityConsistent,
  targetIdentityDigest,
  transitionTaskExecutionCapsule,
} from "../src/shared/task-runtime.mjs";

function onceMessage(peer, predicate) {
  return new Promise((resolve) => {
    const remove = peer.onMessage((message) => {
      if (predicate(message)) {
        remove();
        resolve(message);
      }
    });
  });
}

test("task frame origin checks require an allowlisted live frame URL", () => {
  assert.equal(isAllowedTaskFrameOrigin({ frameId: 2, url: "https://example.test/embed" }, ["https://example.test"]), true);
  assert.equal(isAllowedTaskFrameOrigin({ frameId: 2, url: "https://foreign.test/embed" }, ["https://example.test"]), false);
  assert.equal(isAllowedTaskFrameOrigin({ frameId: 2, url: "not-a-url" }, ["https://example.test"]), false);
  assert.equal(isAllowedTaskFrameOrigin({ frameId: 0, url: null, topLevelUrl: "https://example.test/form" }, ["https://example.test"]), true);
  assert.equal(isAllowedTaskFrameOrigin({ frameId: 2, url: null, topLevelUrl: "https://example.test/form" }, ["https://example.test"]), false);
});

test("only install-stamped build mismatches request a resident broker restart", () => {
  assert.equal(shouldRequestBrokerRestartForBuildMismatch(
    "install-4b113c6a-6359-4362-ae3a-960d0187fb9d",
    "install-9f2f3d4c-6d8e-4a1b-9c0d-123456789abc",
  ), true);
  assert.equal(shouldRequestBrokerRestartForBuildMismatch("dev-local", "install-9f2f3d4c-6d8e-4a1b-9c0d-123456789abc"), false);
  assert.equal(shouldRequestBrokerRestartForBuildMismatch("install-not-a-uuid", "install-9f2f3d4c-6d8e-4a1b-9c0d-123456789abc"), false);
});

test("active reconciliation status counts one task lineage across tab, capsule, and operation records", () => {
  const taskTab = {
    taskId: "task-1",
    runId: "run-1",
    sessionId: "session-1",
    generation: "generation-1",
    profileInstanceId: "profile-1",
    tabId: 42,
    lifecycleState: "reconciliation_required",
    retentionPolicy: "retain_until_resume",
  };
  const capsule = {
    taskId: "task-1",
    runId: "run-1",
    state: "reconciliation_required",
    target: { ...taskTab, pageInstanceId: "page-1", windowId: 3, frameId: 0 },
  };
  const operation = {
    state: "unknown_effect",
    effectState: "unknown_effect",
    operationId: "op-1",
    idempotencyKey: "idem-1",
    binding: { ...taskTab, method: "page.submit", targetIdentity: { ...taskTab, pageInstanceId: null, windowId: null, frameId: 0 } },
  };
  const result = deriveActiveReconciliationCounts({ taskTabs: [taskTab], capsules: [capsule], operations: [operation] });
  assert.equal(result.activeCount, 1);
  assert.equal(result.activeTabCount, 1);
  assert.equal(result.activeCapsuleCount, 1);
  assert.equal(result.activeOperationCount, 1);
});

test("ownerless reconciliation evidence does not count as live profile work", () => {
  const taskTab = {
    taskId: "task-ownerless",
    runId: "run-ownerless",
    sessionId: "expired-session",
    generation: "generation-1",
    profileInstanceId: "profile-1",
    tabId: 43,
    lifecycleState: "reconciliation_required",
    retentionPolicy: "retain_until_resume",
  };
  const result = deriveActiveReconciliationCounts({
    taskTabs: [taskTab],
    capsules: [{ taskId: taskTab.taskId, runId: taskTab.runId, state: "reconciliation_required", target: taskTab }],
    operations: [{
      state: "unknown_effect",
      effectState: "unknown_effect",
      operationId: "op-ownerless",
      idempotencyKey: "idem-ownerless",
      binding: { ...taskTab, method: "page.submit" },
    }],
    activeSessionIds: new Set(),
    leasedTabKeys: new Set(),
  });
  assert.equal(result.activeCount, 0);
  assert.equal(result.activeTabCount, 0);
  assert.equal(result.activeCapsuleCount, 0);
  assert.equal(result.activeOperationCount, 0);
});

test("signed extension reload dispatches a profile-global command and returns a fresh-generation boundary", async () => {
  const dataDir = await mkdtemp(join(tmpdir(), "aos-companion-extension-reload-test-"));
  const env = {
    ...process.env,
    AOS_CHROME_COMPANION_DATA_DIR: dataDir,
    AOS_CHROME_COMPANION_SOCKET: join(dataDir, "broker.sock"),
    AOS_CHROME_COMPANION_SECRET_FILE: join(dataDir, "secret"),
    AOS_CHROME_COMPANION_CODEX_MCP_ISSUER_SECRET_FILE: join(dataDir, "codex-issuer"),
  };
  const secret = await ensureBrokerSecret(env);
  const issuerSecret = "extension-reload-issuer-secret";
  await writeFile(env.AOS_CHROME_COMPANION_CODEX_MCP_ISSUER_SECRET_FILE, `${issuerSecret}\n`, { mode: 0o600 });
  const broker = new CompanionBroker({
    socketPath: env.AOS_CHROME_COMPANION_SOCKET,
    secret,
    issuerSecrets: { codex_mcp: issuerSecret },
  });
  await broker.listen();
  const extension = await connectPeer({ role: "extension-relay", autoStart: false, env });
  const helloAck = onceMessage(extension, (message) => message.kind === "extension.hello_ack");
  extension.send({
    kind: "extension.hello",
    protocolVersion: PROTOCOL_VERSION,
    profileInstanceId: "profile_extension_reload",
    extensionRuntimeId: "runtime_extension_reload",
    buildId: INSTALL_BUILD_ID,
    capabilities: DEFAULT_CAPABILITIES,
  });
  await helloAck;
  const runtimeContractStatus = broker.snapshot();
  const runtimeContractProfile = runtimeContractStatus.profiles.find((profile) => profile.profileInstanceId === "profile_extension_reload");
  assert.deepEqual(runtimeContractProfile.capabilities, DEFAULT_CAPABILITIES, "registration preserves every declared capability without a legacy fixed limit");
  assert.equal(runtimeContractProfile.operationSchema, null);
  assert.equal(runtimeContractStatus.recovery.profiles.find((profile) => profile.profileInstanceId === "profile_extension_reload").state, "runtime_update_pending");
  const reloadCommands = [];
  extension.onMessage((message) => {
    if (message.kind !== "command.request" || message.method !== "extension.reload") return;
    reloadCommands.push(message);
    extension.send({
      kind: "command.result",
      operationId: message.operationId,
      result: {
        accepted: true,
        scheduled: true,
        delayMs: 150,
        buildId: INSTALL_BUILD_ID,
        generation: "gen_before_reload",
      },
    });
  });
  const client = await BrokerClient.connect({ autoStart: false, env });
  const session = await client.request("session.open", { label: "extension reload", taskId: "task-extension-reload" });
  try {
    await assert.rejects(client.requestExtensionReload({
      sessionId: session.sessionId,
      taskId: "task-extension-reload",
      runId: "run-extension-reload-mismatch",
      idempotencyKey: "idem-extension-reload-mismatch",
      expectedBuildId: "install-00000000-0000-0000-0000-000000000000",
    }), (error) => error.code === "extension_build_id_mismatch");
    const result = await client.requestExtensionReload({
      sessionId: session.sessionId,
      taskId: "task-extension-reload",
      runId: "run-extension-reload",
      idempotencyKey: "idem-extension-reload",
      reason: "signed test reload",
      expectedBuildId: INSTALL_BUILD_ID,
    });
    assert.equal(result.accepted, true);
    assert.equal(result.freshSessionRequired, true);
    assert.equal(result.reconnectReadback, "companion_status");
    assert.equal(reloadCommands.length, 1);
    assert.equal(reloadCommands[0].method, "extension.reload");
    assert.equal(reloadCommands[0].params.reason, "signed test reload");
    assert.equal(broker.snapshot().pendingOperationCount, 0);
  } finally {
    client.close();
    extension.close();
    await broker.close();
    await rm(dataDir, { recursive: true, force: true });
  }
});

test("extension reload is deferred while a profile lease is active", async () => {
  const dataDir = await mkdtemp(join(tmpdir(), "aos-erb-"));
  const env = {
    ...process.env,
    AOS_CHROME_COMPANION_DATA_DIR: dataDir,
    AOS_CHROME_COMPANION_SOCKET: join(dataDir, "broker.sock"),
    AOS_CHROME_COMPANION_SECRET_FILE: join(dataDir, "secret"),
    AOS_CHROME_COMPANION_CODEX_MCP_ISSUER_SECRET_FILE: join(dataDir, "codex-issuer"),
  };
  const secret = await ensureBrokerSecret(env);
  const issuerSecret = "extension-reload-busy-issuer-secret";
  await writeFile(env.AOS_CHROME_COMPANION_CODEX_MCP_ISSUER_SECRET_FILE, `${issuerSecret}\n`, { mode: 0o600 });
  const broker = new CompanionBroker({
    socketPath: env.AOS_CHROME_COMPANION_SOCKET,
    secret,
    issuerSecrets: { codex_mcp: issuerSecret },
  });
  await broker.listen();
  const extension = await connectPeer({ role: "extension-relay", autoStart: false, env });
  const helloAck = onceMessage(extension, (message) => message.kind === "extension.hello_ack");
  extension.send({
    kind: "extension.hello",
    protocolVersion: PROTOCOL_VERSION,
    profileInstanceId: "profile_extension_reload_busy",
    extensionRuntimeId: "runtime_extension_reload_busy",
    buildId: INSTALL_BUILD_ID,
    capabilities: DEFAULT_CAPABILITIES,
  });
  await helloAck;
  let reloadDispatchCount = 0;
  extension.onMessage((message) => {
    if (message.kind === "command.request" && message.method === "extension.reload") reloadDispatchCount += 1;
  });
  const client = await BrokerClient.connect({ autoStart: false, env });
  const session = await client.request("session.open", { label: "extension reload busy", taskId: "task-extension-reload-busy" });
  const lease = await client.request("lease.acquire", { sessionId: session.sessionId, tabId: 9123 });
  try {
    await assert.rejects(client.requestExtensionReload({
      sessionId: session.sessionId,
      taskId: "task-extension-reload-busy",
      runId: "run-extension-reload-busy",
      idempotencyKey: "idem-extension-reload-busy",
    }), (error) => error.code === "extension_reload_busy");
    assert.equal(reloadDispatchCount, 0);
  } finally {
    await client.request("lease.release", { leaseId: lease.leaseId });
    client.close();
    extension.close();
    await broker.close();
    await rm(dataDir, { recursive: true, force: true });
  }
});

test("extension reload reservation is single-flight across task sessions", async () => {
  const dataDir = await mkdtemp(join(tmpdir(), "aos-er-single-flight-"));
  const env = {
    ...process.env,
    AOS_CHROME_COMPANION_DATA_DIR: dataDir,
    AOS_CHROME_COMPANION_SOCKET: join(dataDir, "broker.sock"),
    AOS_CHROME_COMPANION_SECRET_FILE: join(dataDir, "secret"),
    AOS_CHROME_COMPANION_CODEX_MCP_ISSUER_SECRET_FILE: join(dataDir, "codex-issuer"),
  };
  const secret = await ensureBrokerSecret(env);
  const issuerSecret = "extension-reload-single-flight-issuer-secret";
  await writeFile(env.AOS_CHROME_COMPANION_CODEX_MCP_ISSUER_SECRET_FILE, `${issuerSecret}\n`, { mode: 0o600 });
  const broker = new CompanionBroker({
    socketPath: env.AOS_CHROME_COMPANION_SOCKET,
    secret,
    issuerSecrets: { codex_mcp: issuerSecret },
  });
  await broker.listen();
  const extension = await connectPeer({ role: "extension-relay", autoStart: false, env });
  const helloAck = onceMessage(extension, (message) => message.kind === "extension.hello_ack");
  extension.send({
    kind: "extension.hello",
    protocolVersion: PROTOCOL_VERSION,
    profileInstanceId: "profile_extension_reload_single_flight",
    extensionRuntimeId: "runtime_extension_reload_single_flight",
    buildId: INSTALL_BUILD_ID,
    capabilities: DEFAULT_CAPABILITIES,
  });
  const initialHello = await helloAck;
  const reloadCommands = [];
  extension.onMessage((message) => {
    if (message.kind === "command.request" && message.method === "extension.reload") reloadCommands.push(message);
  });
  const client = await BrokerClient.connect({ autoStart: false, env });
  const firstSession = await client.request("session.open", { label: "reload owner", taskId: "task-reload-owner" });
  try {
    const first = client.requestExtensionReload({
      sessionId: firstSession.sessionId,
      taskId: "task-reload-owner",
      runId: "run-reload-owner",
      idempotencyKey: "idem-reload-owner",
    });
    await new Promise((resolve) => {
      const check = () => reloadCommands.length > 0 ? resolve() : setTimeout(check, 5);
      check();
    });
    const secondSession = await client.request("session.open", { label: "reload contender", taskId: "task-reload-contender" });
    await assert.rejects(client.requestExtensionReload({
      sessionId: secondSession.sessionId,
      taskId: "task-reload-contender",
      runId: "run-reload-contender",
      idempotencyKey: "idem-reload-contender",
    }), (error) => error.code === "extension_reload_busy"
      && error.details.ownerTaskId === "task-reload-owner"
      && error.details.generation === initialHello.generation
      && error.details.phase === "dispatching");
    assert.equal(reloadCommands.length, 1);
    extension.send({
      kind: "command.result",
      operationId: reloadCommands[0].operationId,
      result: { accepted: true, scheduled: true, buildId: INSTALL_BUILD_ID },
    });
    await first;
    const reservation = broker.snapshot().extensionReloadReservations[0];
    assert.equal(reservation.ownerTaskId, "task-reload-owner");
    assert.equal(reservation.phase, "awaiting_reconnect");
  } finally {
    client.close();
    extension.close();
    await broker.close();
    await rm(dataDir, { recursive: true, force: true });
  }
});

test("pre-dispatch reload authority failures release the reservation for one valid retry", async () => {
  const dataDir = await mkdtemp(join(tmpdir(), "aos-er-authority-gate-"));
  const env = {
    ...process.env,
    AOS_CHROME_COMPANION_DATA_DIR: dataDir,
    AOS_CHROME_COMPANION_SOCKET: join(dataDir, "broker.sock"),
    AOS_CHROME_COMPANION_SECRET_FILE: join(dataDir, "secret"),
    AOS_CHROME_COMPANION_CODEX_MCP_ISSUER_SECRET_FILE: join(dataDir, "codex-issuer"),
  };
  const secret = await ensureBrokerSecret(env);
  const issuerSecret = "extension-reload-authority-gate-issuer-secret";
  await writeFile(env.AOS_CHROME_COMPANION_CODEX_MCP_ISSUER_SECRET_FILE, `${issuerSecret}\n`, { mode: 0o600 });
  const broker = new CompanionBroker({
    socketPath: env.AOS_CHROME_COMPANION_SOCKET,
    secret,
    issuerSecrets: { codex_mcp: issuerSecret },
  });
  await broker.listen();
  const extension = await connectPeer({ role: "extension-relay", autoStart: false, env });
  const helloAck = onceMessage(extension, (message) => message.kind === "extension.hello_ack");
  extension.send({
    kind: "extension.hello",
    protocolVersion: PROTOCOL_VERSION,
    profileInstanceId: "profile_extension_reload_authority_gate",
    extensionRuntimeId: "runtime_extension_reload_authority_gate",
    buildId: INSTALL_BUILD_ID,
    capabilities: DEFAULT_CAPABILITIES,
  });
  await helloAck;
  const client = await BrokerClient.connect({ autoStart: false, env });
  const session = await client.request("session.open", { label: "reload authority gate", taskId: "task-reload-authority-gate" });
  const reloadCommands = [];
  extension.onMessage((message) => {
    if (message.kind !== "command.request" || message.method !== "extension.reload") return;
    reloadCommands.push(message);
    extension.send({
      kind: "command.result",
      operationId: message.operationId,
      result: { accepted: true, scheduled: true, buildId: INSTALL_BUILD_ID },
    });
  });
  try {
    await assert.rejects(client.request("extension.reload", {
      sessionId: session.sessionId,
      taskId: "task-reload-authority-gate",
      runId: "run-reload-missing-authority",
      idempotencyKey: "idem-reload-missing-authority",
    }), (error) => error.code === "mutation_authority_required");
    assert.deepEqual(broker.snapshot().extensionReloadReservations, []);

    const invalidPayload = {
      runId: "run-reload-invalid-authority",
      taskId: "task-reload-authority-gate",
      reason: "invalid authority",
      expectedBuildId: null,
    };
    const invalidAuthority = createAuthorityEnvelope({
      issuer: "codex_mcp",
      secret: issuerSecret,
      runId: invalidPayload.runId,
      taskId: invalidPayload.taskId,
      ownerKey: session.sessionId,
      method: "extension.reload",
      intent: "extension_reload",
      targetOrigin: "*",
      idempotencyKey: "idem-reload-invalid-authority",
      payload: invalidPayload,
      approved: true,
    });
    invalidAuthority.signature = "tampered";
    await assert.rejects(client.request("extension.reload", {
      ...invalidPayload,
      sessionId: session.sessionId,
      idempotencyKey: "idem-reload-invalid-authority",
      authority: invalidAuthority,
    }), (error) => error.code === "authority_signature_invalid");
    assert.deepEqual(broker.snapshot().extensionReloadReservations, []);

    await client.requestExtensionReload({
      sessionId: session.sessionId,
      taskId: "task-reload-authority-gate",
      runId: "run-reload-valid-authority",
      idempotencyKey: "idem-reload-valid-authority",
    });
    assert.equal(reloadCommands.length, 1);
  } finally {
    client.close();
    extension.close();
    await broker.close();
    await rm(dataDir, { recursive: true, force: true });
  }
});

test("acknowledged reload remains guarded through timeout and broker restart until fresh generation", async () => {
  const dataDir = await mkdtemp(join(tmpdir(), "aos-er-restart-"));
  const env = {
    ...process.env,
    AOS_CHROME_COMPANION_DATA_DIR: dataDir,
    AOS_CHROME_COMPANION_SOCKET: join(dataDir, "broker.sock"),
    AOS_CHROME_COMPANION_SECRET_FILE: join(dataDir, "secret"),
    AOS_CHROME_COMPANION_CODEX_MCP_ISSUER_SECRET_FILE: join(dataDir, "codex-issuer"),
  };
  const secret = await ensureBrokerSecret(env);
  const issuerSecret = "extension-reload-restart-issuer-secret";
  await writeFile(env.AOS_CHROME_COMPANION_CODEX_MCP_ISSUER_SECRET_FILE, `${issuerSecret}\n`, { mode: 0o600 });
  const makeBroker = () => new CompanionBroker({
    socketPath: env.AOS_CHROME_COMPANION_SOCKET,
    secret,
    issuerSecrets: { codex_mcp: issuerSecret },
  });
  const broker = makeBroker();
  await broker.listen();
  const extension = await connectPeer({ role: "extension-relay", autoStart: false, env });
  const helloAck = onceMessage(extension, (message) => message.kind === "extension.hello_ack");
  extension.send({
    kind: "extension.hello",
    protocolVersion: PROTOCOL_VERSION,
    profileInstanceId: "profile_extension_reload_restart",
    extensionRuntimeId: "runtime_extension_reload_restart",
    buildId: INSTALL_BUILD_ID,
    capabilities: DEFAULT_CAPABILITIES,
  });
  const initialHello = await helloAck;
  const reloadCommand = onceMessage(extension, (message) => message.kind === "command.request" && message.method === "extension.reload");
  const client = await BrokerClient.connect({ autoStart: false, env });
  const session = await client.request("session.open", { label: "reload restart", taskId: "task-reload-restart" });
  try {
    const first = client.requestExtensionReload({
      sessionId: session.sessionId,
      taskId: "task-reload-restart",
      runId: "run-reload-restart",
      idempotencyKey: "idem-reload-restart",
    });
    const command = await reloadCommand;
    extension.send({
      kind: "command.result",
      operationId: command.operationId,
      result: { accepted: true, scheduled: true, buildId: INSTALL_BUILD_ID },
    });
    await first;
    await new Promise((resolve) => setTimeout(resolve, 2_100));
    await assert.rejects(client.requestExtensionReload({
      sessionId: session.sessionId,
      taskId: "task-reload-restart",
      runId: "run-reload-restart-2",
      idempotencyKey: "idem-reload-restart-2",
    }), (error) => error.code === "extension_reload_busy");
    client.close();
    extension.close();
    await broker.close();

    const restarted = makeBroker();
    await restarted.listen();
    try {
      const restored = restarted.snapshot().extensionReloadReservations[0];
      assert.equal(restored.ownerTaskId, "task-reload-restart");
      assert.equal(restored.generation, initialHello.generation);
      assert.equal(restored.phase, "awaiting_reconnect");
      assert.equal(restored.durable, true);

      const extensionAfterRestart = await connectPeer({ role: "extension-relay", autoStart: false, env });
      try {
        const freshHello = onceMessage(extensionAfterRestart, (message) => message.kind === "extension.hello_ack");
        extensionAfterRestart.send({
          kind: "extension.hello",
          protocolVersion: PROTOCOL_VERSION,
          profileInstanceId: "profile_extension_reload_restart",
          extensionRuntimeId: "runtime_extension_reload_restart_fresh",
          buildId: INSTALL_BUILD_ID,
          capabilities: DEFAULT_CAPABILITIES,
        });
        const fresh = await freshHello;
        assert.notEqual(fresh.generation, initialHello.generation);
        assert.deepEqual(restarted.snapshot().extensionReloadReservations, []);
      } finally {
        extensionAfterRestart.close();
      }
    } finally {
      await restarted.close();
    }
  } finally {
    client.close();
    extension.close();
    if (!broker.closing) await broker.close();
    await rm(dataDir, { recursive: true, force: true });
  }
});

test("explicit missing-record purge removes only absent stale task-tab records", async () => {
  const dataDir = await mkdtemp(join(tmpdir(), "aos-companion-missing-purge-test-"));
  const env = {
    ...process.env,
    AOS_CHROME_COMPANION_DATA_DIR: dataDir,
    AOS_CHROME_COMPANION_SOCKET: join(dataDir, "broker.sock"),
    AOS_CHROME_COMPANION_SECRET_FILE: join(dataDir, "secret"),
    AOS_CHROME_COMPANION_CODEX_MCP_ISSUER_SECRET_FILE: join(dataDir, "codex-issuer"),
  };
  const secret = await ensureBrokerSecret(env);
  const issuerSecret = "missing-purge-issuer-secret";
  await writeFile(env.AOS_CHROME_COMPANION_CODEX_MCP_ISSUER_SECRET_FILE, `${issuerSecret}\n`, { mode: 0o600 });
  const broker = new CompanionBroker({
    socketPath: env.AOS_CHROME_COMPANION_SOCKET,
    secret,
    issuerSecrets: { codex_mcp: issuerSecret },
  });
  await broker.listen();
  const extension = await connectPeer({ role: "extension-relay", autoStart: false, env });
  const helloAck = onceMessage(extension, (message) => message.kind === "extension.hello_ack");
  extension.send({
    kind: "extension.hello",
    protocolVersion: PROTOCOL_VERSION,
    profileInstanceId: "profile_missing_purge",
    extensionRuntimeId: "runtime_missing_purge",
    buildId: INSTALL_BUILD_ID,
    capabilities: DEFAULT_CAPABILITIES,
  });
  await helloAck;
  extension.onMessage((message) => {
    if (message.kind !== "command.request" || message.method !== "tabs.list") return;
    extension.send({
      kind: "command.result",
      operationId: message.operationId,
      result: [{ id: 9001, windowId: 1, index: 0, active: true, pinned: false, url: "chrome://extensions/" }],
    });
  });
  const oldGeneration = "gen_missing_purge_old";
  const taskTabs = [
    { tabId: 9000, taskId: "foreign-stale-task", sessionId: "foreign-session", generation: oldGeneration },
    { tabId: 9001, taskId: "foreign-live-task", sessionId: "foreign-live-session", generation: oldGeneration },
  ];
  for (const tab of taskTabs) {
    await broker.taskLedger.recordTaskTab({
      ...tab,
      profileInstanceId: "profile_missing_purge",
      runId: `${tab.taskId}:run`,
      lifecycleState: "reconciliation_required",
      retentionPolicy: "retain_until_resume",
      quarantine: "stale_generation",
      userHelpRequired: false,
    });
  }
  const client = await BrokerClient.connect({ autoStart: false, env });
  const session = await client.request("session.open", { label: "missing purge", taskId: "purge-requester" });
  try {
    const result = await client.requestPurgeMissingTaskTabs({
      sessionId: session.sessionId,
      taskId: "purge-requester",
      runId: "run-missing-purge",
      idempotencyKey: "idem-missing-purge",
      profileInstanceId: "profile_missing_purge",
      tabIds: [9000, 9001],
      confirmMissingOnly: true,
    });
    assert.deepEqual(result.purged_tab_ids, [9000]);
    assert.deepEqual(result.live_tab_ids, [9001]);
    assert.equal(result.tabs_close_dispatched, false);
    assert.equal(result.external_action_executed, false);
    assert.deepEqual(broker.taskLedger.listTaskTabs().map((entry) => entry.tabId), [9001]);
  } finally {
    await client.request("session.close", { sessionId: session.sessionId, taskTerminal: false });
    client.close();
    extension.close();
    await broker.close();
    await rm(dataDir, { recursive: true, force: true });
  }
});

test("timed-out operations leave active status and retain only a bounded late-result tombstone", async () => {
  const dataDir = await mkdtemp(join(tmpdir(), "aos-companion-timeout-tombstone-test-"));
  const env = {
    ...process.env,
    AOS_CHROME_COMPANION_DATA_DIR: dataDir,
    AOS_CHROME_COMPANION_SOCKET: join(dataDir, "broker.sock"),
    AOS_CHROME_COMPANION_SECRET_FILE: join(dataDir, "secret"),
  };
  const secret = await ensureBrokerSecret(env);
  const broker = new CompanionBroker({ socketPath: env.AOS_CHROME_COMPANION_SOCKET, secret });
  await broker.listen();
  const extension = await connectPeer({ role: "extension-relay", autoStart: false, env });
  const helloAck = onceMessage(extension, (message) => message.kind === "extension.hello_ack");
  extension.send({
    kind: "extension.hello",
    protocolVersion: PROTOCOL_VERSION,
    profileInstanceId: "profile_timeout_tombstone",
    extensionRuntimeId: "runtime_timeout_tombstone",
    buildId: INSTALL_BUILD_ID,
    capabilities: DEFAULT_CAPABILITIES,
  });
  await helloAck;
  const commands = [];
  extension.onMessage((message) => {
    if (message.kind === "command.request" && message.method === "page.snapshot") commands.push(message);
  });
  const client = await BrokerClient.connect({ autoStart: false, env });
  const session = await client.request("session.open", { label: "timeout tombstone" });
  const lease = await client.request("lease.acquire", { sessionId: session.sessionId, tabId: 9401 });
  try {
    await assert.rejects(client.request("operation.execute", {
      sessionId: session.sessionId,
      leaseId: lease.leaseId,
      method: "page.snapshot",
      params: { tabId: 9401 },
      timeoutMs: 100,
    }), (error) => error.code === "operation_timeout");
    const afterTimeout = broker.snapshot();
    assert.equal(afterTimeout.pendingOperationCount, 0);
    // Read-only operations get one bounded same-target retry; both timed-out
    // dispatches remain bounded evidence tombstones but do not block
    // reconciliation or a fresh task because no external effect was possible.
    assert.equal(afterTimeout.timedOutOperationCount, 2);
    assert.equal(afterTimeout.timedOutOperationUnresolvedCount, 0);
    assert.equal(afterTimeout.reconciliationPendingCount, 0);
    assert.equal(commands.length, 2);
    for (const command of commands) {
      extension.send({
        kind: "command.result",
        operationId: command.operationId,
        result: { url: "https://example.test/late", title: "late", text: "late", pageInstanceId: "late-doc" },
      });
    }
    await new Promise((resolve) => setTimeout(resolve, 50));
    const afterLateResult = broker.snapshot();
    assert.equal(afterLateResult.pendingOperationCount, 0);
    assert.equal(afterLateResult.timedOutOperationCount, 0);
  } finally {
    client.close();
    extension.close();
    await broker.close();
    await rm(dataDir, { recursive: true, force: true });
  }
});

test("local UI mutation timeout stays out of external reconciliation", async () => {
  const dataDir = await mkdtemp(join(tmpdir(), "aos-companion-local-timeout-test-"));
  const env = {
    ...process.env,
    AOS_CHROME_COMPANION_DATA_DIR: dataDir,
    AOS_CHROME_COMPANION_SOCKET: join(dataDir, "broker.sock"),
    AOS_CHROME_COMPANION_SECRET_FILE: join(dataDir, "secret"),
  };
  const secret = await ensureBrokerSecret(env);
  const broker = new CompanionBroker({ socketPath: env.AOS_CHROME_COMPANION_SOCKET, secret });
  await broker.listen();
  const extension = await connectPeer({ role: "extension-relay", autoStart: false, env });
  const helloAck = onceMessage(extension, (message) => message.kind === "extension.hello_ack");
  extension.send({
    kind: "extension.hello",
    protocolVersion: PROTOCOL_VERSION,
    profileInstanceId: "profile_local_timeout",
    extensionRuntimeId: "runtime_local_timeout",
    buildId: INSTALL_BUILD_ID,
    capabilities: DEFAULT_CAPABILITIES,
  });
  await helloAck;
  // Deliberately omit a command result: the broker's bounded timeout path is
  // the behavior under test, not the Extension fixture.
  const client = await BrokerClient.connect({ autoStart: false, env });
  const session = await client.request("session.open", { label: "local timeout" });
  const lease = await client.request("lease.acquire", { sessionId: session.sessionId, tabId: 9501 });
  try {
    await assert.rejects(client.request("operation.execute", {
      sessionId: session.sessionId,
      leaseId: lease.leaseId,
      method: "page.type",
      params: { tabId: 9501, locator: { testId: "name" }, text: "bounded" },
      timeoutMs: 100,
    }), (error) => error.code === "operation_effect_unknown" && error.details.reconciliationRequired === false);
    const status = broker.snapshot();
    assert.equal(status.reconciliationPendingCount, 0);
    assert.equal(status.timedOutOperationUnresolvedCount, 0);
  } finally {
    client.close();
    extension.close();
    await broker.close();
    await rm(dataDir, { recursive: true, force: true });
  }
});

test("broker retries one timed-out read on the same target but never broadens its scope", async () => {
  const dataDir = await mkdtemp(join(tmpdir(), "aos-companion-read-retry-test-"));
  const env = {
    ...process.env,
    AOS_CHROME_COMPANION_DATA_DIR: dataDir,
    AOS_CHROME_COMPANION_SOCKET: join(dataDir, "broker.sock"),
    AOS_CHROME_COMPANION_SECRET_FILE: join(dataDir, "secret"),
  };
  const secret = await ensureBrokerSecret(env);
  const broker = new CompanionBroker({ socketPath: env.AOS_CHROME_COMPANION_SOCKET, secret });
  await broker.listen();
  const extension = await connectPeer({ role: "extension-relay", autoStart: false, env });
  const helloAck = onceMessage(extension, (message) => message.kind === "extension.hello_ack");
  extension.send({
    kind: "extension.hello",
    protocolVersion: PROTOCOL_VERSION,
    profileInstanceId: "profile_read_retry",
    extensionRuntimeId: "runtime_read_retry",
    buildId: INSTALL_BUILD_ID,
    capabilities: DEFAULT_CAPABILITIES,
  });
  await helloAck;
  let attempts = 0;
  extension.onMessage((message) => {
    if (message.kind !== "command.request" || message.method !== "page.snapshot") return;
    attempts += 1;
    if (attempts === 1) return;
    extension.send({
      kind: "command.result",
      operationId: message.operationId,
      result: { url: "https://example.test/form", title: "ready", text: "ready", pageInstanceId: "doc-read-retry" },
    });
  });
  const client = await BrokerClient.connect({ autoStart: false, env });
  const session = await client.request("session.open", { label: "read retry" });
  const lease = await client.request("lease.acquire", { sessionId: session.sessionId, tabId: 7001 });
  const result = await client.request("operation.execute", {
    sessionId: session.sessionId,
    leaseId: lease.leaseId,
    method: "page.snapshot",
    params: { tabId: 7001 },
    timeoutMs: 100,
  });
  assert.equal(result.pageInstanceId, "doc-read-retry");
  assert.equal(attempts, 2);
  client.close();
  extension.close();
  await broker.close();
  await rm(dataDir, { recursive: true, force: true });
});

test("fresh exact lease repairs same-task stale task-tab identity without adopting foreign work", async () => {
  const dataDir = await mkdtemp(join(tmpdir(), "aos-companion-identity-repair-test-"));
  const env = {
    ...process.env,
    AOS_CHROME_COMPANION_DATA_DIR: dataDir,
    AOS_CHROME_COMPANION_SOCKET: join(dataDir, "broker.sock"),
    AOS_CHROME_COMPANION_SECRET_FILE: join(dataDir, "secret"),
  };
  const secret = await ensureBrokerSecret(env);
  const ledgerSecret = "aos-chrome-companion-ledger";
  const broker = new CompanionBroker({ socketPath: env.AOS_CHROME_COMPANION_SOCKET, secret });
  await broker.listen();
  const extension = await connectPeer({ role: "extension-relay", autoStart: false, env });
  const helloAck = onceMessage(extension, (message) => message.kind === "extension.hello_ack");
  extension.send({
    kind: "extension.hello",
    protocolVersion: PROTOCOL_VERSION,
    profileInstanceId: "profile_identity_repair",
    extensionRuntimeId: "runtime_identity_repair",
    buildId: INSTALL_BUILD_ID,
    capabilities: DEFAULT_CAPABILITIES,
  });
  const ack = await helloAck;
  const client = await BrokerClient.connect({ autoStart: false, env });
  const session = await client.request("session.open", { taskId: "task_identity_repair" });
  const stale = await broker.taskLedger.recordTaskTab({
    profileInstanceId: "profile_identity_repair",
    generation: ack.generation,
    tabId: 812,
    taskId: "task_identity_repair",
    runId: "run_identity_repair",
    sessionId: "old-process-session",
    lifecycleState: "completed",
    retentionPolicy: "retain",
    targetIdentity: {
      schema: "aos.chrome_companion.target_identity.v1",
      taskId: "task_identity_repair",
      sessionId: "old-process-session",
      leaseId: null,
      generation: ack.generation,
      profileInstanceId: "profile_identity_repair",
      tabId: 812,
      pageInstanceId: null,
      windowId: null,
      frameId: 0,
      origin: null,
    },
    targetFingerprint: targetIdentityDigest(ledgerSecret, {
      taskId: "task_identity_repair",
      sessionId: "old-process-session",
      generation: ack.generation,
      profileInstanceId: "profile_identity_repair",
      tabId: 812,
      frameId: 0,
    }),
  });
  broker.taskTabs.set("profile_identity_repair:812", stale);
  assert.equal(taskTabIdentityConsistent(ledgerSecret, stale), true);
  const lease = await client.request("lease.acquire", { sessionId: session.sessionId, tabId: 812 });
  assert.ok(lease.leaseId);
  const repaired = broker.taskTabs.get("profile_identity_repair:812");
  assert.equal(repaired.sessionId, session.sessionId);
  assert.equal(repaired.identityRepairReason, "same_task_fresh_lease");
  assert.equal(taskTabIdentityConsistent(ledgerSecret, repaired), true);
  client.close();
  extension.close();
  await broker.close();
  await rm(dataDir, { recursive: true, force: true });
});

test("profile reconnect closes inactive ownerless ledger-only tabs without touching active tabs", async () => {
  const dataDir = await mkdtemp(join(tmpdir(), "aos-companion-ownerless-cleanup-test-"));
  const env = {
    ...process.env,
    AOS_CHROME_COMPANION_DATA_DIR: dataDir,
    AOS_CHROME_COMPANION_SOCKET: join(dataDir, "broker.sock"),
    AOS_CHROME_COMPANION_SECRET_FILE: join(dataDir, "secret"),
  };
  const secret = await ensureBrokerSecret(env);
  const broker = new CompanionBroker({ socketPath: env.AOS_CHROME_COMPANION_SOCKET, secret });
  await broker.listen();
  const profileInstanceId = "profile_ownerless_cleanup";
  const tabId = 8_121;
  const activeSiblingTabId = 8_122;
  const liveTabs = new Map([[tabId, {
    id: tabId,
    windowId: 1,
    index: 1,
    active: false,
    pinned: false,
    groupId: 77,
    url: "https://example.test/ownerless",
    title: "ownerless",
  }], [activeSiblingTabId, {
    id: activeSiblingTabId,
    windowId: 1,
    index: 0,
    active: true,
    pinned: false,
    groupId: 77,
    url: "https://example.test/active-sibling",
    title: "active sibling",
  }]]);
  const stale = await broker.taskLedger.recordTaskTab({
    profileInstanceId,
    generation: "gen_ownerless_old",
    tabId,
    taskId: "task_ownerless_cleanup",
    runId: "run_ownerless_cleanup",
    sessionId: "session_lost_owner",
    lifecycleState: "completed",
    retentionPolicy: "ledger_only",
    quarantine: "stale_generation",
    userHelpRequired: false,
    resumeToken: null,
    ledgerOnlyAt: new Date().toISOString(),
  });
  broker.taskTabs.set(`${profileInstanceId}:${tabId}`, stale);
  const extension = await connectPeer({ role: "extension-relay", autoStart: false, env });
  const commands = [];
  extension.onMessage((message) => {
    if (message.kind !== "command.request") return;
    commands.push(message);
    if (message.method === "tabs.list") {
      extension.send({ kind: "command.result", operationId: message.operationId, result: [...liveTabs.values()] });
    } else if (message.method === "tabs.close") {
      liveTabs.delete(message.params.tabId);
      extension.send({ kind: "command.result", operationId: message.operationId, result: { closed: true, tabId: message.params.tabId } });
    }
  });
  const helloAck = onceMessage(extension, (message) => message.kind === "extension.hello_ack");
  extension.send({
    kind: "extension.hello",
    protocolVersion: PROTOCOL_VERSION,
    profileInstanceId,
    extensionRuntimeId: "runtime_ownerless_cleanup",
    buildId: INSTALL_BUILD_ID,
    capabilities: DEFAULT_CAPABILITIES,
  });
  await helloAck;
  const deadline = Date.now() + 2_000;
  while (Date.now() < deadline && (liveTabs.has(tabId) || broker.taskLedger.getTaskTab(profileInstanceId, tabId))) {
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  try {
    assert.equal(liveTabs.has(tabId), false);
    assert.equal(liveTabs.has(activeSiblingTabId), true);
    assert.equal(broker.taskLedger.getTaskTab(profileInstanceId, tabId), null);
    assert.deepEqual(commands.map((command) => command.method), ["tabs.list", "tabs.close"]);
  } finally {
    extension.close();
    await broker.close();
    await rm(dataDir, { recursive: true, force: true });
  }
});

async function createCapsuleHarness({ failVisualInspectionFor = null, failPostTypeReadback = false, uploadBehavior = null, postCaptureBehavior = null, semanticGuards = false, interceptCommand = null } = {}) {
  const dataDir = await mkdtemp(join(tmpdir(), "aos-companion-capsule-integration-"));
  const issuerSecret = "capsule-integration-issuer";
  const env = {
    ...process.env,
    AOS_CHROME_COMPANION_DATA_DIR: dataDir,
    AOS_CHROME_COMPANION_SOCKET: join(dataDir, "broker.sock"),
    AOS_CHROME_COMPANION_SECRET_FILE: join(dataDir, "secret"),
    AOS_CHROME_COMPANION_CODEX_MCP_ISSUER_SECRET_FILE: join(dataDir, "codex-issuer"),
  };
  await writeFile(env.AOS_CHROME_COMPANION_CODEX_MCP_ISSUER_SECRET_FILE, `${issuerSecret}\n`, { mode: 0o600 });
  const handoffReceiptsDir = join(dataDir, "handoff-receipts");
  await mkdir(handoffReceiptsDir, { recursive: true, mode: 0o700 });
  const secret = await ensureBrokerSecret(env);
  const broker = new CompanionBroker({
    socketPath: env.AOS_CHROME_COMPANION_SOCKET,
    secret,
    issuerSecrets: { codex_mcp: issuerSecret },
    statePath: join(dataDir, "ledger.json"),
    handoffReceiptsDir,
  });
  await broker.listen();
  const liveTabs = new Map();
  const commands = [];
  const visualInspectionCounts = new Map();
  let nextTabId = 10_000;
  let postActionCaptureCount = 0;
  let extension;
  const attachExtension = async (profileInstanceId = "profile_capsule") => {
    extension = await connectPeer({ role: "extension-relay", autoStart: false, env });
    const helloAck = onceMessage(extension, (message) => message.kind === "extension.hello_ack");
    extension.send({ kind: "extension.hello", protocolVersion: PROTOCOL_VERSION, profileInstanceId, extensionRuntimeId: `runtime-${nextTabId}`, buildId: INSTALL_BUILD_ID, capabilities: DEFAULT_CAPABILITIES });
    await helloAck;
    extension.onMessage((message) => {
      if (message.kind !== "command.request") return;
      commands.push(message);
      const tabId = message.params?.tabId;
      if (interceptCommand?.({ message, tab: liveTabs.get(tabId), extension })) return;
      if (message.method === "tabs.list") {
        extension.send({ kind: "command.result", operationId: message.operationId, result: [...liveTabs.values()] });
      } else if (message.method === "tabs.create") {
        const tab = { id: nextTabId++, url: message.params.url, title: "capsule", groupId: null };
        liveTabs.set(tab.id, tab);
        extension.send({ kind: "command.result", operationId: message.operationId, result: tab });
      } else if (message.method === "tabs.groupTask") {
        const tab = liveTabs.get(tabId);
        const result = { ...tab, groupId: 77 };
        liveTabs.set(tabId, result);
        extension.send({ kind: "command.result", operationId: message.operationId, result });
      } else if (message.method === "tabs.navigate") {
        const tab = liveTabs.get(tabId);
        const result = { ...tab, url: message.params.url };
        liveTabs.set(tabId, result);
        extension.send({ kind: "command.result", operationId: message.operationId, result });
      } else if (message.method === "tabs.configure") {
        const tab = liveTabs.get(tabId);
        const changed = { ...tab, windowId: message.params.destinationWindowId ?? tab.windowId ?? 1,
          pinned: message.params.pinned ?? tab.pinned ?? false, index: message.params.index ?? tab.index ?? 0 };
        liveTabs.set(tabId, changed);
        extension.send({ kind: "command.result", operationId: message.operationId,
          result: { configured: true, tabId, windowId: changed.windowId, pinned: changed.pinned, index: changed.index, url: changed.url } });
      } else if (message.method === "tabs.close") {
        liveTabs.delete(tabId);
        extension.send({ kind: "command.result", operationId: message.operationId, result: { closed: true, tabId } });
      } else if (message.method === "page.snapshot") {
        const tab = liveTabs.get(tabId);
        if (tab?.pendingSubmit) liveTabs.set(tabId, { ...tab, pendingSubmit: false, submitted: true, url: "https://example.test/received", text: "Application received" });
        if (tab?.dialog) {
          extension.send({ kind: "command.error", operationId: message.operationId, error: { code: "dialog_blocks_renderer", message: "A modal prevents DOM execution" } });
          return;
        }
        if (failPostTypeReadback && tab?.typed) {
          extension.send({ kind: "command.error", operationId: message.operationId, error: { code: "operation_timeout", message: "synthetic post-edit readback failure" } });
          return;
        }
        extension.send({ kind: "command.result", operationId: message.operationId, result: { url: tab?.url ?? "https://example.test/", title: tab?.title ?? "capsule", text: tab?.text ?? "ready", pageInstanceId: `document-${tabId}-${tab?.url}` } });
      } else if (message.method === "page.inspectDialog") {
        const tab = liveTabs.get(tabId), dialog = tab?.dialog;
        extension.send({ kind: "command.result", operationId: message.operationId, result: {
          present: !!dialog, url: tab?.url, title: tab?.title, evidenceKind: "javascript_dialog_observation", documentTextRead: false,
          ...(dialog ? { dialogId: dialog.id, pageInstanceId: `javascript-dialog:${dialog.id}`, message: dialog.message, type: dialog.type, dialogUrl: dialog.url ?? tab.url } : {}) } });
      } else if (message.method === "page.handleDialog") {
        const tab = liveTabs.get(tabId), dialog = tab?.dialog;
        if (!dialog || dialog.id !== message.params.expectedDialogId || message.params.pageInstanceId !== `javascript-dialog:${dialog.id}` || dialog.message !== message.params.expectedMessage) {
          extension.send({ kind: "command.error", operationId: message.operationId, error: { code: "javascript_dialog_mismatch", message: "Observed dialog mismatch", details: { operationEffectState: "none", mutationDispatchAttempted: false } } });
        } else if (tab.dialogFault === "unknown") {
          tab.dialog = null;
          extension.send({ kind: "command.error", operationId: message.operationId, error: { code: "javascript_dialog_close_unknown", message: "Close event unavailable", details: { operationEffectState: "unknown", mutationDispatchAttempted: true } } });
        } else {
          tab.dialog = tab.nextDialog ?? null;
          extension.send({ kind: "command.result", operationId: message.operationId, result: { handled: true, accepted: message.params.accept, type: dialog.type, dialogId: dialog.id, closedVerified: true, nextDialogPresent: !!tab.dialog } });
        }
      } else if (message.method === "page.download") {
        const tab = liveTabs.get(tabId);
        extension.send({ kind: "command.result", operationId: message.operationId, result: tab.downloadReceipt });
      } else if (message.method === "clipboard.write") {
        const tab = liveTabs.get(tabId);
        if (tab.clipboardFault) extension.send({kind:"command.error",operationId:message.operationId,error:{code:"clipboard_write_result_unknown",message:"Clipboard acknowledgement lost",details:{operationEffectState:"unknown",mutationDispatchAttempted:true,retryWrite:false}}});
        else extension.send({kind:"command.result",operationId:message.operationId,result:{written:true,binary:true,writeAcknowledged:true,pasteVerified:false,contentReturned:false,formats:message.params.formats.map(format=>({mimeType:format.mimeType,inputBytes:Buffer.from(format.dataBase64,"base64").length}))}});
      } else if (message.method === "page.query") {
        const tab = liveTabs.get(tabId);
        const text = tab?.text ?? "ready";
        const matched = message.params?.locator?.testId === "upload-ready"
          ? uploadBehavior === "already-present" || tab?.attachmentReady === true
          : text.toLocaleLowerCase().includes(String(message.params?.query ?? "").toLocaleLowerCase());
        const matches = matched
          ? [{ tag: "h2", role: "heading", name: text, text, rect: { x: 20, y: 20, width: 320, height: 40 } }]
          : [];
        extension.send({
          kind: "command.result",
          operationId: message.operationId,
          result: {
            query: message.params?.query,
            matches,
            count: matches.length,
            limit: message.params?.limit ?? 10,
            url: tab?.url ?? "https://example.test/",
            pageInstanceId: `document-${tabId}-${tab?.url}`,
          },
        });
      } else if (message.method === "page.screenshot") {
        const tab = liveTabs.get(tabId);
        if (postCaptureBehavior && (tab?.typed || tab?.submitted)) {
          postActionCaptureCount += 1;
          if (postCaptureBehavior === "permanent" || postActionCaptureCount === 1) {
            extension.send({ kind: "command.error", operationId: message.operationId, error: { code: "screenshot_target_changed", message: "synthetic transition during capture" } });
            return;
          }
        }
        extension.send({
          kind: "command.result",
          operationId: message.operationId,
          result: {
            kind: "screenshot",
            dataBase64: Buffer.from(`screenshot-${tabId}-${tab?.url}-${tab?.screenshotVersion ?? "stable"}`, "utf8").toString("base64"),
            mimeType: message.params?.format === "png" ? "image/png" : "image/jpeg",
            tabId,
            url: tab?.url ?? "https://example.test/",
            title: tab?.title ?? "capsule",
            capturedAt: new Date().toISOString(),
          },
        });
      } else if (message.method === "visual.inspectPoint") {
        const tab = liveTabs.get(tabId);
        extension.send({ kind: "command.result", operationId: message.operationId, result: {
          supported: true, url: tab.url, pageInstanceId: `document-${tabId}-${tab.url}`, point: message.params.point,
          viewport: tab.visualViewport ?? { width: 1000, height: 700, devicePixelRatio: 1, scale: 1 },
          scroll: tab.visualScroll ?? { x: 0, y: 0 }, surfaceKind: tab.canvas === false ? "dom" : "canvas",
          surfaceRect: { x: 20, y: 20, width: 500, height: 400 }, frameId: 0,
        } });
      } else if (message.method === "visual.inspectTarget") {
        const tab = liveTabs.get(tabId);
        if (failVisualInspectionFor && message.params?.locator?.testId === failVisualInspectionFor) {
          extension.send({
            kind: "command.error",
            operationId: message.operationId,
            error: { code: "operation_timeout", message: "synthetic visual inspection timeout", details: { method: "visual.inspectTarget", timeoutMs: 100 } },
          });
          return;
        }
        const locatorKey = JSON.stringify(message.params?.locator ?? {});
        const inspectionCount = (visualInspectionCounts.get(locatorKey) ?? 0) + 1;
        visualInspectionCounts.set(locatorKey, inspectionCount);
        const shifted = message.params?.locator?.testId === "replace-before-dispatch" && inspectionCount > 1;
        extension.send({ kind: "command.result", operationId: message.operationId, result: {
          url: tab?.url ?? "https://example.test/",
          pageInstanceId: `document-${tabId}-${tab?.url}`,
          element: { tag: "button", role: "button", name: message.params?.locator?.testId ?? message.params?.locator?.text ?? "target", testId: message.params?.locator?.testId ?? null },
          rect: { x: shifted ? 20 : 10, y: 10, width: 100, height: 30 },
          clippedRect: { x: shifted ? 20 : 10, y: 10, width: 100, height: 30 },
          point: { x: shifted ? 70 : 60, y: 25 },
          viewport: { width: 1200, height: 800, devicePixelRatio: 1 },
          ...(semanticGuards ? { semanticGuard: { id: `fresh-${tabId}-${inspectionCount}`, methods: ["page.click", "page.submit"], expiresAt: Date.now() + 30000 } } : {}),
        } });
      } else if (message.method === "page.upload" || message.method === "page.uploadMultiple") {
        if (uploadBehavior) {
          const tab = liveTabs.get(tabId);
          liveTabs.set(tabId, { ...tab, attachmentReady: uploadBehavior === "accepted", text: uploadBehavior === "accepted" ? "test.txt received" : tab.text });
          extension.send({ kind: "command.result", operationId: message.operationId, result: {
            uploaded: false, fileInputAssignmentVerified: true, uploadReadbackVerified: false, requiresSiteConfirmation: true,
            expectedFiles: [{ name: "test.txt", size: 7, type: "text/plain" }], readback: { inputFileCount: 0, state: "cleared" },
          } });
        } else {
          extension.send({ kind: "command.error", operationId: message.operationId,
            error: { code: "semantic_locator_ambiguous", message: "two file inputs",
              details: { operationEffectState: "none", mutationDispatchAttempted: false } } });
        }
      } else if (message.method === "page.type") {
        const tab = liveTabs.get(tabId);
        liveTabs.set(tabId, { ...tab, text: message.params.text, typed: true });
        extension.send({ kind: "command.result", operationId: message.operationId, result: { typed: true, value: message.params.text } });
      } else if (message.method === "page.click" && message.params?.locator?.testId === "timeout") {
        // Synthetic dispatch timeout/unknown-effect response; the broker must
        // retain the capsule and never replay this command.
        setTimeout(() => extension?.send({ kind: "command.error", operationId: message.operationId, error: { code: "operation_effect_unknown", message: "synthetic mutation timeout" } }), 10);
      } else if (message.method === "page.click" && message.params?.locator?.testId === "submit-delayed") {
        const tab = liveTabs.get(tabId);
        liveTabs.set(tabId, { ...tab, pendingSubmit: true });
        extension.send({ kind: "command.result", operationId: message.operationId, result: { clicked: true, formSubmitControl: true, mutationDispatchAttempted: true } });
      } else if (message.method === "page.click" && message.params?.locator?.testId === "submit-no-transition") {
        extension.send({
          kind: "command.result",
          operationId: message.operationId,
          result: {
            clicked: true,
            formSubmitControl: true,
            mutationDispatchAttempted: true,
          },
        });
      } else if (message.method === "tabs.back") {
        extension.send({
          kind: "command.error",
          operationId: message.operationId,
          error: {
            code: "history_entry_unavailable",
            message: "The exact tab has no previous history entry",
            details: { operationEffectState: "none", mutationDispatchAttempted: false, direction: "back" },
          },
        });
      } else if (message.method === "page.click" && message.params?.locator?.testId === "navigate-then-continue") {
        const tab = liveTabs.get(tabId);
        liveTabs.set(tabId, { ...tab, url: `${new URL(tab.url).origin}/after-click` });
        extension.send({ kind: "command.result", operationId: message.operationId, result: { clicked: true, tabId } });
      } else if (message.method === "page.waitFor" && message.params?.locator?.testId === "upload-ready") {
        if (liveTabs.get(tabId)?.attachmentReady) extension.send({ kind: "command.result", operationId: message.operationId, result: { found: true, element: { text: "test.txt received" } } });
        else extension.send({ kind: "command.error", operationId: message.operationId, error: { code: "page_wait_timeout", message: "Attachment has not become ready" } });
      } else if (message.method === "page.waitFor" && message.params?.locator?.testId === "slow") {
        setTimeout(() => extension?.send({ kind: "command.result", operationId: message.operationId, result: { found: true } }), 180);
      } else {
        extension.send({ kind: "command.result", operationId: message.operationId, result: { found: true, tabId } });
      }
    });
    return extension;
  };
  await attachExtension();
  const client = await BrokerClient.connect({ autoStart: false, env, issuer: "codex_mcp" });
  const session = await client.request("session.open", { taskId: "capsule_task", label: "capsule integration" });
  return {
    dataDir,
    env,
    broker,
    client,
    session,
    liveTabs,
    commands,
    handoffReceiptsDir,
    attachExtension,
    get extensionPeer() { return extension; },
    resolveVisualFailure() { failVisualInspectionFor = null; },
    async close() {
      client.close();
      extension?.close();
      await broker.close();
      await rm(dataDir, { recursive: true, force: true });
    },
  };
}

function dialogEventFor(message, changes = {}) {
  const at = new Date().toISOString();
  return { kind: "dialog", present: true, operationId: message.operationId, tabId: message.params.tabId,
    dialogId: "opening-triggered", pageInstanceId: "javascript-dialog:opening-triggered", type: "confirm",
    message: "Continue?", messageExactAvailable: true, requiresUser: false, dialogUrl: "https://example.test/form",
    armedAt: at, openedAt: at, ...changes };
}

test("pre-armed dialog continuation retains the original command and resumes only unattempted actions", async () => {
  let trigger;
  const harness = await createCapsuleHarness({ interceptCommand: ({ message, tab, extension }) => {
    if (message.method === "page.click" && message.params.expectEvent) {
      trigger = message; tab.dialog = { id: "opening-triggered", type: "confirm", message: "Continue?" };
      extension.send({ kind: "command.event", operationId: message.operationId, event: dialogEventFor(message) });
      return true;
    }
    if (message.method === "page.handleDialog") setTimeout(() => extension.send({ kind: "command.result", operationId: trigger.operationId, result: { clicked: true } }), 10);
    return false;
  } });
  const { client, session, commands, broker } = harness;
  const base = { sessionId: session.sessionId, taskId: session.taskId, targetOrigin: "https://example.test",
    startUrl: "https://example.test/form", allowedOrigins: ["https://example.test"], runId: "dialog-trigger" };
  try {
    const started = await client.requestAuthorizedTransaction({ ...base, idempotencyKey: "dialog-trigger", actions: [
      { method: "page.click", params: { locator: { testId: "open" }, expectEvent: { type: "dialog" } } },
      { method: "page.type", params: { locator: { testId: "body" }, text: "remaining" } },
    ] });
    assert.equal(started.exact_blocker.code, "action_event_pending"); assert.equal(started.effect_state, "unknown_effect");
    assert.equal(started.cleanup.retained, true); assert.equal(started.cleanup.closed, false);
    assert.deepEqual(started.action_progress.remaining_action_indices, [1]); assert.deepEqual(started.action_progress.uncertain_action_indices, [0]);
    const response = { ...base, tabId: started.tab.id, actions: [{ method: "page.handleDialog", params: { expectedMessage: "Continue?", expectedDialogId: "opening-triggered", accept: false } }] };
    const wrongId = await client.requestAuthorizedTransaction({ ...response, idempotencyKey: "wrong-dialog", actions: [{ method: "page.handleDialog", params: { expectedMessage: "Continue?", expectedDialogId: "other", accept: false } }] });
    assert.equal(wrongId.exact_blocker.code, "javascript_dialog_identity_mismatch");
    const wrongRun = await client.requestAuthorizedTransaction({ ...response, idempotencyKey: "wrong-run", runId: "other" });
    assert.equal(wrongRun.exact_blocker.code, "action_event_continuation_binding_mismatch");
    assert.equal(commands.filter(command => command.method === "page.handleDialog").length, 0);
    const completed = await client.requestAuthorizedTransaction({ ...response, idempotencyKey: "dialog-response" });
    assert.equal(completed.result, "verified", JSON.stringify(completed.exact_blocker));
    assert.equal(completed.trigger_continuation.state, "readback_verified");
    assert.deepEqual(completed.trigger_continuation.action_progress.remaining_action_indices, [1]);
    assert.deepEqual(completed.trigger_continuation.action_progress.uncertain_action_indices, []);
    assert.equal(broker.taskLedger.get(started.action_event.idempotencyKey).state, "reconciled");
    assert.equal(broker.taskLedger.getTaskCapsule(started.capsule.capsuleId).effect.reconciliationRequired, false);
    const status = await client.requestTaskStatus({ sessionId: session.sessionId, taskId: session.taskId,
      runId: base.runId, idempotencyKey: "dialog-trigger", capsuleId: started.capsule.capsuleId });
    assert.equal(status.effect_state, "known_effect");
    assert.equal(status.reconciliation_required, false);
    const resumed = await client.requestPrepareResume({ ...base, idempotencyKey: "dialog-trigger", capsuleId: started.capsule.capsuleId });
    assert.deepEqual(resumed.action_progress.remaining_action_indices, [1]); assert.deepEqual(resumed.action_progress.uncertain_action_indices, []);
    assert.equal(commands.filter(command => command.method === "page.click").length, 1);
    assert.equal(commands.filter(command => command.method === "page.type").length, 0);
  } finally { await harness.close(); }
});

test("forged or mismatched dialog events never release the original pending operation", async () => {
  let triggerResolve;
  const triggered = new Promise(resolve => { triggerResolve = resolve; });
  const harness = await createCapsuleHarness({ interceptCommand: ({ message }) => {
    if (message.method === "page.click") { triggerResolve(message); return true; } return false;
  } });
  const { client, session, broker, extensionPeer } = harness;
  let foreign;
  try {
    const action = client.requestAuthorizedTransaction({ sessionId: session.sessionId, taskId: session.taskId,
      targetOrigin: "https://example.test", startUrl: "https://example.test/form", allowedOrigins: ["https://example.test"],
      runId: "event-binding", idempotencyKey: "event-binding", actions: [{ method: "page.click", params: { locator: { testId: "open" }, expectEvent: { type: "dialog", timeoutMs: 15000 } } }] });
    const trigger = await triggered;
    foreign = await connectPeer({ role: "extension-relay", autoStart: false, env: harness.env });
    const ack = onceMessage(foreign, message => message.kind === "extension.hello_ack");
    foreign.send({ kind: "extension.hello", protocolVersion: PROTOCOL_VERSION, profileInstanceId: "foreign-events",
      extensionRuntimeId: "foreign-runtime", buildId: INSTALL_BUILD_ID, capabilities: DEFAULT_CAPABILITIES }); await ack;
    let rejected = onceMessage(foreign, message => message.kind === "peer.error");
    foreign.send({ kind: "command.event", operationId: trigger.operationId, event: dialogEventFor(trigger) });
    assert.equal((await rejected).error.code, "extension_operation_peer_mismatch");
    for (const changed of [{ tabId: trigger.params.tabId + 1 }, { dialogUrl: "https://foreign.test/" }, { armedAt: "2020-01-01T00:00:00.000Z" }]) {
      rejected = onceMessage(extensionPeer, message => message.kind === "peer.error");
      extensionPeer.send({ kind: "command.event", operationId: trigger.operationId, event: dialogEventFor(trigger, changed) });
      assert.equal((await rejected).error.code, "action_event_binding_mismatch");
      assert.equal(broker.pendingOperations.has(trigger.operationId), true);
    }
    extensionPeer.send({ kind: "command.event", operationId: trigger.operationId, event: dialogEventFor(trigger) });
    const pending = await action; assert.equal(pending.exact_blocker.code, "action_event_pending");
    assert.equal(broker.timedOutOperations.has(trigger.operationId), true);
  } finally { foreign?.close(); await harness.close(); }
});

test("a missing pre-armed event keeps the trigger applied and excludes it from resume", async () => {
  const harness = await createCapsuleHarness({ interceptCommand: ({ message, extension }) => {
    if (message.method !== "page.click") return false;
    extension.send({ kind: "command.result", operationId: message.operationId, result: { clicked: true, eventWait: { type: "dialog", observed: false, exact_blocker: "action_event_timeout" } } }); return true;
  } });
  const { client, session, commands } = harness;
  try {
    const result = await client.requestAuthorizedTransaction({ sessionId: session.sessionId, taskId: session.taskId,
      targetOrigin: "https://example.test", startUrl: "https://example.test/form", allowedOrigins: ["https://example.test"],
      runId: "event-missing", idempotencyKey: "event-missing", actions: [
        { method: "page.click", params: { locator: { testId: "open" }, expectEvent: { type: "dialog" } } },
        { method: "page.type", params: { locator: { testId: "body" }, text: "remaining" } },
      ] });
    assert.equal(result.exact_blocker.code, "action_event_timeout"); assert.equal(result.effect_state, "known_effect");
    assert.deepEqual(result.action_progress.applied_action_indices, [0]); assert.deepEqual(result.action_progress.remaining_action_indices, [1]);
    assert.equal(result.cleanup.retained, true); assert.equal(commands.filter(command => command.method === "page.click").length, 1);
    assert.equal(commands.filter(command => command.method === "page.type").length, 0);
  } finally { await harness.close(); }
});

test("schema-valid drags bind both inspected targets and reject a moved destination before dispatch", async () => {
  const harness = await createCapsuleHarness();
  const { client, session, commands } = harness;
  const origin = "https://example.test";
  const schema = transactionActionSchema(z.object({testId:z.string()}));
  try {
    const base = {sessionId:session.sessionId, taskId:session.taskId, targetOrigin:origin, startUrl:origin + "/drag", allowedOrigins:[origin], keepTaskTab:true};
    const prepared = await client.requestAuthorizedTransaction({...base,runId:"drag-prepare",idempotencyKey:"drag-prepare",actions:[{method:"page.query",params:{query:"ready"}}]});
    assert.equal(prepared.result,"verified");
    for (const [index, destination] of ["drag-destination", "replace-before-dispatch"].entries()) {
      const tabId = prepared.tab.id;
      const lease = await client.request("lease.acquire",{sessionId:session.sessionId,tabId});
      const inspect = testId => client.request("visual.target.inspect",{sessionId:session.sessionId,leaseId:lease.leaseId,tabId,locator:{testId}});
      const from = await inspect("drag-source-" + index), to = await inspect(destination);
      const action = schema.parse({method:"visual.drag",params:{visualProof:from.visualProof,toVisualProof:to.visualProof,steps:12}});
      const start = commands.length;
      const result = await client.requestAuthorizedTransaction({...base,tabId,runId:"drag-"+index,idempotencyKey:"drag-"+index,actions:[action]});
      const dispatched = commands.slice(start).filter(command => command.method === "visual.drag");
      if (index === 0) {
        assert.equal(result.result,"verified");assert.equal(dispatched.length,1);
        assert.deepEqual(dispatched[0].params.point,from.visualProof.point);
        assert.deepEqual(dispatched[0].params.to,to.visualProof.point);
        assert.equal("visualProof" in dispatched[0].params,false);assert.equal("toVisualProof" in dispatched[0].params,false);
        assert.equal(result.actions[0].visual_target_proof_verified,true);
      } else {
        assert.equal(result.result,"blocked");assert.equal(result.exact_blocker.code,"visual_target_proof_stale_geometry");
        assert.equal(dispatched.length,0);assert.equal(result.external_action_executed,false);
      }
    }
  } finally { await harness.close(); }
});

test("canvas point proofs reject redraw, replacement, scroll, density and viewport changes before input", async () => {
  for (const change of ['unchanged', 'redraw', 'replacement', 'scroll', 'density', 'viewport', 'pageScale']) {
    const harness = await createCapsuleHarness();
    const { client, session, liveTabs, commands } = harness;
    try {
      const origin = 'https://example.test', base = { sessionId: session.sessionId, taskId: session.taskId,
        targetOrigin: origin, startUrl: origin + '/canvas', allowedOrigins: [origin], keepTaskTab: true };
      const prepared = await client.requestAuthorizedTransaction({ ...base, runId: 'canvas-prepare', idempotencyKey: 'canvas-prepare', actions: [{ method: 'page.query', params: { query: 'ready' } }] });
      const tabId = prepared.tab.id, tab = liveTabs.get(tabId);
      const lease = await client.request('lease.acquire', { sessionId: session.sessionId, tabId });
      const proof = await client.request('visual.point.inspect', { sessionId: session.sessionId, leaseId: lease.leaseId, tabId, point: { x: 100, y: 100 } });
      assert.ok(proof.visualProof.canvasPatch?.imageDigest);
      if (change === 'redraw') tab.screenshotVersion = 'new canvas pixels';
      if (change === 'replacement') tab.canvas = false;
      if (change === 'scroll') tab.visualScroll = { x: 0, y: 80 };
      if (['density', 'viewport', 'pageScale'].includes(change)) tab.visualViewport = {
        width: change === 'viewport' ? 800 : 1000, height: 700,
        devicePixelRatio: change === 'density' ? 2 : 1, scale: change === 'pageScale' ? 1.5 : 1,
      };
      const start = commands.length;
      const result = await client.requestAuthorizedTransaction({ ...base, tabId, runId: 'canvas-click', idempotencyKey: 'canvas-click',
        actions: [{ method: 'visual.click', params: { visualProof: proof.visualProof } }] });
      const dispatched = commands.slice(start).filter(command => command.method === 'visual.click');
      if (change === 'unchanged') {
        assert.equal(result.result, 'verified'); assert.equal(dispatched.length, 1);
      } else {
        assert.equal(result.result, 'blocked'); assert.equal(dispatched.length, 0);
        assert.equal(result.exact_blocker.code, ['redraw', 'replacement'].includes(change) ? 'visual_canvas_content_changed' : 'visual_target_proof_stale_geometry');
        assert.equal(result.external_action_executed, false);
      }
    } finally { await harness.close(); }
  }
});

test("signed MIME clipboard writes preserve acknowledgement uncertainty without automatic replay", async () => {
  for (const unknown of [false,true]) {
    const harness=await createCapsuleHarness(),{client,session,liveTabs,commands}=harness;
    try {
      const origin="https://example.test",base={sessionId:session.sessionId,taskId:session.taskId,targetOrigin:origin,startUrl:origin+"/clipboard",allowedOrigins:[origin],keepTaskTab:true};
      const prepared=await client.requestAuthorizedTransaction({...base,runId:"clipboard-prepare",idempotencyKey:"clipboard-prepare",actions:[{method:"page.query",params:{query:"ready"}}]});
      liveTabs.get(prepared.tab.id).clipboardFault=unknown;
      const action=transactionActionSchema(z.object({label:z.string()})).parse({method:"clipboard.write",params:{approved:true,formats:[{mimeType:"text/html",dataBase64:Buffer.from("<b>日本語</b>").toString("base64")}]}});
      const result=await client.requestAuthorizedTransaction({...base,tabId:prepared.tab.id,runId:"clipboard-write",idempotencyKey:"clipboard-write",actions:[action]});
      assert.equal(commands.filter(command=>command.method==="clipboard.write").length,1);
      if (unknown) {
        assert.equal(result.result,"unknown_effect");assert.deepEqual(result.action_progress.uncertain_action_indices,[0]);assert.deepEqual(result.action_progress.remaining_action_indices,[]);assert.equal(result.cleanup.retained,true);
        const resume=await client.requestPrepareResume({sessionId:session.sessionId,taskId:session.taskId,runId:"clipboard-write",capsuleId:result.capsule.capsuleId});
        assert.deepEqual(resume.action_progress.remaining_action_indices,[]);assert.equal(commands.filter(command=>command.method==="clipboard.write").length,1);
      } else {
        assert.equal(result.result,"verified");assert.equal(result.actions[0].result.writeAcknowledged,true);assert.equal(result.actions[0].result.pasteVerified,false);assert.equal(result.actions.length,1);
      }
    } finally {await harness.close();}
  }
});

test("signed dialog transactions bind the observed opening and avoid DOM reads until it closes", async () => {
  const harness = await createCapsuleHarness();
  const {client, session, liveTabs, commands} = harness;
  const origin = "https://example.test";
  try {
    const base = { sessionId: session.sessionId, taskId: session.taskId, targetOrigin: origin, startUrl: origin + "/dialog", allowedOrigins: [origin] };
    const prepared = await client.requestAuthorizedTransaction({ ...base, runId: "dialog-prepare", idempotencyKey: "dialog-prepare", keepTaskTab: true,
      actions: [{ method: "page.query", params: { query: "ready" } }] });
    assert.equal(prepared.result, "verified");
    const tab = liveTabs.get(prepared.tab.id);
    tab.dialog = { id: "opening-one", type: "prompt", message: "Label" };
    const start = commands.length;
    const result = await client.requestAuthorizedTransaction({ ...base, tabId: tab.id, runId: "dialog-handle", idempotencyKey: "dialog-handle", keepTaskTab: true,
      actions: [{ method: "page.handleDialog", params: { expectedMessage: "Label", accept: true, promptText: "日本語 👩🏽‍💻" } }] });
    assert.equal(result.result, "verified");assert.equal(result.pre.read_kind, "javascript_dialog");assert.equal(result.pre.text_sha256, null);
    const dispatched = commands.slice(start), handleIndex = dispatched.findIndex(command => command.method === "page.handleDialog");
    assert.ok(handleIndex >= 0);assert.equal(dispatched.slice(0, handleIndex).filter(command => command.method === "page.snapshot").length, 0);
    assert.equal(dispatched.filter(command => command.method === "page.handleDialog").length, 1);
    assert.equal(dispatched[handleIndex].params.expectedDialogId, "opening-one");
    assert.equal(dispatched[handleIndex].params.pageInstanceId, "javascript-dialog:opening-one");
    assert.equal(result.actions[0].result.closedVerified, true);
    assert.ok(dispatched.slice(handleIndex + 1).some(command => command.method === "page.snapshot"));
    assert.ok(liveTabs.has(tab.id));
  } finally { await harness.close(); }
});

test("dialog response errors and subsequent dialogs preserve the exact page with no automatic second response", async () => {
  for (const scenario of ["mismatch", "unknown", "next-dialog"]) {
    const harness = await createCapsuleHarness();
    const {client, session, liveTabs, commands, broker} = harness;
    const origin = "https://example.test";
    try {
      const base = { sessionId: session.sessionId, taskId: session.taskId, targetOrigin: origin, startUrl: origin + "/dialog-" + scenario, allowedOrigins: [origin] };
      const prepared = await client.requestAuthorizedTransaction({ ...base, runId: "prepare-" + scenario, idempotencyKey: "prepare-" + scenario, keepTaskTab: true,
        actions: [{ method: "page.query", params: { query: "ready" } }] });
      const tab = liveTabs.get(prepared.tab.id);tab.dialog = { id: "opening-one", type: "confirm", message: "Confirm" };
      if (scenario === "unknown") tab.dialogFault = "unknown";
      if (scenario === "next-dialog") tab.nextDialog = { id: "opening-two", type: "prompt", message: "Next question" };
      const start = commands.length;
      const result = await client.requestAuthorizedTransaction({ ...base, tabId: tab.id, runId: "response-" + scenario, idempotencyKey: "response-" + scenario,
        actions: [{ method: "page.handleDialog", params: { expectedMessage: scenario === "mismatch" ? "Wrong" : "Confirm", accept: true } }] });
      assert.equal(result.cleanup.closed, false, scenario);assert.equal(result.cleanup.retained, true, scenario);assert.ok(liveTabs.has(tab.id));
      assert.equal(commands.slice(start).filter(command => command.method === "page.handleDialog").length, 1);
      if (scenario === "next-dialog") {
        assert.equal(result.result, "verified");assert.equal(result.continuation_required, true);assert.equal(result.visual_readback.screenshotAvailable, false);
        assert.equal(commands.slice(start).filter(command => command.method === "page.snapshot").length, 0);
        assert.equal(broker.taskLedger.getTaskTab(session.profileInstanceId, tab.id).retentionPolicy, "retain");
      } else if (scenario === "unknown") {
        assert.equal(result.effect_state, "unknown_effect");
      } else {
        assert.equal(result.effect_state, "known_no_effect");
        assert.equal(broker.taskLedger.getTaskTab(session.profileInstanceId, tab.id).retentionPolicy, "retain");
      }
    } finally { await harness.close(); }
  }
});

test("dialog responses require a signed single-action transaction with the exact owned tab", async () => {
  const harness = await createCapsuleHarness();
  const {client, session, commands} = harness;
  try {
    const base = {sessionId: session.sessionId, taskId: session.taskId, targetOrigin: "https://example.test", startUrl: "https://example.test/", allowedOrigins: ["https://example.test"],
      actions: [{method: "page.handleDialog", params: {expectedMessage: "Confirm", accept: true}}]};
    await assert.rejects(client.requestAuthorizedTransaction({...base, runId: "missing-tab", idempotencyKey: "missing-tab"}), {code: "transaction_dialog_exact_action_required"});
    await assert.rejects(client.requestAuthorizedTransaction({...base, tabId: 1234, runId: "mixed-actions", idempotencyKey: "mixed-actions", actions: [...base.actions, {method: "page.query", params: {query: "ready"}}]}), {code: "transaction_dialog_exact_action_required"});
    assert.equal(commands.filter(command => command.method === "page.handleDialog").length, 0);
  } finally { await harness.close(); }
});

test("download transactions verify local artifacts and never retry a completed download after file readback fails", async () => {
  for (const scenario of ["verified", "missing", "size-mismatch"]) {
    const harness = await createCapsuleHarness();
    const {client, session, liveTabs, commands, dataDir, broker} = harness;
    const origin = "https://example.test";
    try {
      const base = {sessionId:session.sessionId,taskId:session.taskId,targetOrigin:origin,allowedOrigins:[origin],startUrl:origin+"/download-"+scenario,keepTaskTab:true};
      const prepared = await client.requestAuthorizedTransaction({...base,runId:"prepare-download-"+scenario,idempotencyKey:"prepare-download-"+scenario,actions:[{method:"page.query",params:{query:"ready"}}]});
      const tab = liveTabs.get(prepared.tab.id), filePath = join(dataDir,"result.txt"), body = "保存した本文 👩🏽‍💻";
      if (scenario !== "missing") await writeFile(filePath,body);
      tab.downloadReceipt = {source:"chrome.downloads",downloadId:19,tabId:tab.id,state:"complete",filename:"result.txt",filePath,fileSize:scenario === "size-mismatch" ? 1 : Buffer.byteLength(body),mimeType:"text/plain",bytesReceived:2};
      const start = commands.length;
      const result = await client.requestAuthorizedTransaction({...base,tabId:tab.id,runId:"download-"+scenario,idempotencyKey:"download-"+scenario,actions:[{method:"page.download",params:{url:origin+"/result.txt"}}]});
      assert.equal(commands.slice(start).filter(c=>c.method === "page.download").length,1);
      if (scenario === "verified") {
        assert.equal(result.result,"verified");assert.equal(result.artifacts[0].verified,true);assert.equal(result.artifacts[0].bytes,Buffer.byteLength(body));assert.match(result.artifacts[0].sha256,/^[a-f0-9]{64}$/u);
        assert.equal(result.actions[0].result.artifact.sha256,result.artifacts[0].sha256);
        assert.equal(broker.taskLedger.getTaskTab(session.profileInstanceId,tab.id).taskId,session.taskId);
      } else {
        assert.equal(result.result,"blocked");assert.equal(result.effect_state,"known_effect");assert.equal(result.artifacts[0].verified,false);assert.equal(result.artifacts[0].downloadComplete,true);assert.equal(result.artifacts[0].retryDownload,false);
        assert.deepEqual(result.action_progress.remaining_action_indices,[]);assert.deepEqual(result.action_progress.applied_action_indices,[0]);assert.equal(result.cleanup.retained,true);
        const resumeStart = commands.length;
        const resume = await client.requestPrepareResume({sessionId:session.sessionId,taskId:session.taskId,runId:"download-"+scenario,capsuleId:result.capsule.capsuleId});
        assert.deepEqual(resume.action_progress.remaining_action_indices,[]);
        assert.equal(commands.slice(resumeStart).filter(c=>c.method === "page.download").length,0);
      }
    } finally { await harness.close(); }
  }
});

test("task cleanup folds old reconciliation tabs without closing their evidence", async () => {
  const harness = await createCapsuleHarness();
  const { broker, client, session, liveTabs, commands } = harness;
  const tabId = 10_900;
  const origin = "https://example.test";
  liveTabs.set(tabId, {
    id: tabId,
    windowId: 1,
    index: 0,
    active: false,
    pinned: false,
    url: `${origin}/old-reconciliation`,
    title: "old reconciliation",
    groupId: null,
  });
  await broker.taskLedger.recordTaskTab({
    profileInstanceId: session.profileInstanceId,
    generation: "gen_old_reconciliation",
    tabId,
    taskId: session.taskId,
    runId: "run_old_reconciliation",
    sessionId: "session_old_reconciliation",
    lifecycleState: "reconciliation_required",
    retentionPolicy: "retain_until_resume",
    userHelpRequired: false,
  });
  try {
    const result = await client.requestCleanupTaskTabs({
      sessionId: session.sessionId,
      runId: "run_visual_cleanup",
      taskId: session.taskId,
      idempotencyKey: "idem_visual_cleanup",
      preserveTabIds: [],
      dryRun: false,
    });
    assert.deepEqual(result.collapse_candidates, [tabId]);
    assert.deepEqual(result.collapsed, [{ tabId, groupId: 77 }]);
    assert.deepEqual(result.closed, []);
    assert.equal(liveTabs.has(tabId), true);
    const groupCommand = commands.find((command) => command.method === "tabs.groupTask" && command.params?.tabId === tabId);
    assert.equal(groupCommand.params.collapsed, true);
    assert.equal(groupCommand.params.visualOnlyCleanup, true);
    assert.equal(broker.taskLedger.getTaskTab(session.profileInstanceId, tabId).lifecycleState, "reconciliation_required");
  } finally {
    await harness.close();
  }
});

test("task cleanup computes pending task ownership before pruning discovered tabs", async () => {
  const harness = await createCapsuleHarness();
  const { broker, client, session, liveTabs } = harness;
  const tabId = 10_902;
  liveTabs.set(tabId, {
    id: tabId,
    windowId: 1,
    index: 0,
    active: false,
    pinned: false,
    url: "https://example.test/discovered-orphan",
    title: "discovered orphan",
    groupId: null,
  });
  await broker.taskLedger.recordTaskTab({
    profileInstanceId: session.profileInstanceId,
    generation: session.generation,
    tabId,
    taskId: session.taskId,
    runId: "run_discovered_orphan",
    sessionId: "session_lost_before_dispatch",
    lifecycleState: "discovered",
    retentionPolicy: "retain",
    userHelpRequired: false,
    resumeToken: null,
  });
  try {
    const result = await client.requestCleanupTaskTabs({
      sessionId: session.sessionId,
      runId: "run_cleanup_discovered_orphan",
      taskId: session.taskId,
      idempotencyKey: "idem_cleanup_discovered_orphan",
      preserveTabIds: [],
      dryRun: false,
    });
    assert.deepEqual(result.closed, [tabId]);
    assert.equal(liveTabs.has(tabId), false);
    assert.equal(broker.taskLedger.getTaskTab(session.profileInstanceId, tabId), null);
  } finally {
    await harness.close();
  }
});

test("ledger-only task tabs are closed on the next fresh owner cleanup", async () => {
  const harness = await createCapsuleHarness();
  const { broker, client, session, liveTabs } = harness;
  const tabId = 10_901;
  liveTabs.set(tabId, {
    id: tabId,
    windowId: 1,
    index: 0,
    active: false,
    pinned: false,
    url: "https://example.test/orphaned-task",
    title: "orphaned task",
    groupId: null,
  });
  await broker.taskLedger.recordTaskTab({
    profileInstanceId: session.profileInstanceId,
    generation: session.generation,
    tabId,
    taskId: session.taskId,
    runId: "run_orphaned_task",
    sessionId: "session_lost_owner",
    lifecycleState: "executing",
    retentionPolicy: "retain_until_resume",
    resumeToken: "resume_orphaned_task",
    userHelpRequired: false,
  });
  const detached = await broker.taskLedger.detachUnknownTaskTabs({
    sessionIds: new Set(["session_lost_owner"]),
    reason: "client_transport_disconnected",
    detachOrphaned: true,
  });
  assert.deepEqual(detached.map((entry) => entry.tabId), [tabId]);
  broker.taskTabs.set(`${session.profileInstanceId}:${tabId}`, detached[0]);
  try {
    const result = await client.requestCleanupTaskTabs({
      sessionId: session.sessionId,
      runId: "run_fresh_cleanup",
      taskId: session.taskId,
      idempotencyKey: "idem_fresh_cleanup",
      preserveTabIds: [],
      dryRun: false,
    });
    assert.deepEqual(result.closed, [tabId]);
    assert.equal(liveTabs.has(tabId), false);
    assert.equal(broker.taskTabs.has(`${session.profileInstanceId}:${tabId}`), false);
    assert.equal(broker.taskLedger.getTaskTab(session.profileInstanceId, tabId), null);
  } finally {
    await harness.close();
  }
});

test("task_execution_capsule_v1 is workflow-generic and fences target identity", () => {
  const workflows = ["Jobs", "AOS", "Heavy", "MyPro"];
  for (const workflowType of workflows) {
    const capsule = normalizeTaskExecutionCapsule({ workflowType, startUrl: "https://example.test/work/item" }, {
      taskId: `task-${workflowType}`,
      runId: `run-${workflowType}`,
      startUrl: "https://example.test/work/item",
      targetOrigin: "https://example.test",
      allowedOrigins: ["https://example.test"],
    });
    assert.equal(capsule.schema, "aos.chrome_companion.task_execution_capsule.v1");
    assert.equal(capsule.workflowType, workflowType);
    assert.equal(capsule.target.targetKey, "url:https://example.test/work/item");
    const admitted = transitionTaskExecutionCapsule(capsule, "admitted");
    const bound = transitionTaskExecutionCapsule(admitted, "target_bound", { target: { ...admitted.target, generation: "generation-1" } });
    assert.equal(bound.target.generation, "generation-1");
    assert.throws(() => transitionTaskExecutionCapsule(bound, "completed"), /Invalid task capsule transition/);
  }
  assert.notEqual(
    deriveTaskTargetKey({ startUrl: "https://example.test/work/a" }),
    deriveTaskTargetKey({ startUrl: "https://example.test/work/b" }),
  );
});

test("multi-action transactions reject replaced targets and require a fresh checkpoint after navigation", async () => {
  const harness = await createCapsuleHarness();
  const { client, session, commands } = harness;
  const origin = "https://example.test";
  const transact = (runId, idempotencyKey, actions) => client.requestAuthorizedTransaction({
    sessionId: session.sessionId,
    runId,
    taskId: "capsule_task",
    idempotencyKey,
    targetOrigin: origin,
    startUrl: `${origin}/form`,
    allowedOrigins: [origin],
    actions,
    capsule: { workflowType: "Jobs", targetKey: runId },
  });
  try {
    const replaced = await transact("run_replaced_target", "idem_replaced_target", [{ method: "page.click", params: { locator: { testId: "replace-before-dispatch" } } }]);
    assert.equal(replaced.result, "blocked");
    assert.equal(replaced.exact_blocker.code, "transaction_action_target_changed");
    assert.equal(commands.filter((command) => command.method === "page.click" && command.params?.locator?.testId === "replace-before-dispatch").length, 0);

    const navigated = await transact("run_navigation_checkpoint", "idem_navigation_checkpoint", [
      { method: "page.click", params: { locator: { testId: "navigate-then-continue" } } },
      { method: "page.type", params: { locator: { testId: "later-field" }, text: "must not dispatch" } },
    ]);
    assert.equal(navigated.result, "blocked");
    assert.equal(navigated.exact_blocker.code, "transaction_navigation_checkpoint_required");
    assert.equal(commands.filter((command) => command.method === "page.type" && command.params?.locator?.testId === "later-field").length, 0);

    const unavailableHistory = await transact("run_history_unavailable", "idem_history_unavailable", [
      { method: "tabs.back", params: {} },
    ]);
    assert.equal(unavailableHistory.result, "blocked");
    assert.equal(unavailableHistory.exact_blocker.code, "history_entry_unavailable");
    assert.equal(unavailableHistory.reconciliation, undefined);
    assert.equal(unavailableHistory.cleanup.closed, true);
  } finally {
    await harness.close();
  }
});

test("broker isolates sessions, parallelizes distinct tabs, serializes foreground, and never replays timeout", async () => {
  const dataDir = await mkdtemp(join(tmpdir(), "aos-companion-test-"));
  const env = {
    ...process.env,
    AOS_CHROME_COMPANION_DATA_DIR: dataDir,
    AOS_CHROME_COMPANION_SOCKET: join(dataDir, "broker.sock"),
    AOS_CHROME_COMPANION_SECRET_FILE: join(dataDir, "secret"),
  };
  const secret = await ensureBrokerSecret(env);
  const broker = new CompanionBroker({ socketPath: env.AOS_CHROME_COMPANION_SOCKET, secret });
  await broker.listen();

  const extension = await connectPeer({ role: "extension-relay", autoStart: false, env });
  const helloAck = onceMessage(extension, (message) => message.kind === "extension.hello_ack");
  extension.send({
    kind: "extension.hello",
    protocolVersion: PROTOCOL_VERSION,
    profileInstanceId: "profile_test",
    extensionRuntimeId: "runtime_test",
    buildId: INSTALL_BUILD_ID,
    capabilities: DEFAULT_CAPABILITIES,
  });
  await helloAck;

  let activeOperations = 0;
  let maxParallel = 0;
  let clickDispatchCount = 0;
  extension.onMessage((message) => {
    if (message.kind !== "command.request") return;
    if (message.method === "page.click") {
      clickDispatchCount += 1;
      return;
    }
    activeOperations += 1;
    maxParallel = Math.max(maxParallel, activeOperations);
    setTimeout(() => {
      activeOperations -= 1;
      extension.send({
        kind: "command.result",
        operationId: message.operationId,
        result: { method: message.method, tabId: message.params.tabId ?? null },
      });
    }, 40);
  });

  const firstClient = await BrokerClient.connect({ autoStart: false, env });
  const secondClient = await BrokerClient.connect({ autoStart: false, env });
  const firstSession = await firstClient.request("session.open", { label: "first" });
  const secondSession = await firstClient.request("session.open", { label: "second-same-client" });
  const firstLease = await firstClient.request("lease.acquire", { sessionId: firstSession.sessionId, tabId: 101 });
  const secondLease = await firstClient.request("lease.acquire", { sessionId: secondSession.sessionId, tabId: 202 });

  await assert.rejects(
    firstClient.request("lease.acquire", { sessionId: secondSession.sessionId, tabId: 101 }),
    (error) => error.code === "tab_lease_conflict",
  );

  await Promise.all([
    firstClient.request("operation.execute", {
      sessionId: firstSession.sessionId,
      leaseId: firstLease.leaseId,
      method: "page.snapshot",
      params: { tabId: 101 },
    }),
    firstClient.request("operation.execute", {
      sessionId: secondSession.sessionId,
      leaseId: secondLease.leaseId,
      method: "page.snapshot",
      params: { tabId: 202 },
    }),
  ]);
  assert.equal(maxParallel, 2);

  maxParallel = 0;
  await Promise.all([
    firstClient.request("operation.execute", {
      sessionId: firstSession.sessionId,
      leaseId: firstLease.leaseId,
      method: "tabs.activate",
      params: { tabId: 101 },
    }),
    firstClient.request("operation.execute", {
      sessionId: secondSession.sessionId,
      leaseId: secondLease.leaseId,
      method: "tabs.activate",
      params: { tabId: 202 },
    }),
  ]);
  assert.equal(maxParallel, 1);

  maxParallel = 0;
  await Promise.all([
    firstClient.request("operation.execute", {
      sessionId: firstSession.sessionId,
      leaseId: firstLease.leaseId,
      method: "page.type",
      params: { tabId: 101, locator: { testId: "first" }, text: "first", physicalFallback: "on_verified_no_effect" },
    }),
    firstClient.request("operation.execute", {
      sessionId: secondSession.sessionId,
      leaseId: secondLease.leaseId,
      method: "page.type",
      params: { tabId: 202, locator: { testId: "second" }, text: "second", physicalFallback: "on_verified_no_effect" },
    }),
  ]);
  assert.equal(maxParallel, 1);

  maxParallel = 0;
  await Promise.all([
    firstClient.request("operation.execute", {
      sessionId: firstSession.sessionId,
      leaseId: firstLease.leaseId,
      method: "page.screenshot",
      params: { tabId: 101 },
    }),
    firstClient.request("operation.execute", {
      sessionId: secondSession.sessionId,
      leaseId: secondLease.leaseId,
      method: "page.screenshot",
      params: { tabId: 202 },
    }),
  ]);
  assert.equal(maxParallel, 1);

  await assert.rejects(
    secondClient.request("session.close", { sessionId: firstSession.sessionId }),
    (error) => error.code === "session_not_owned",
  );

  await assert.rejects(
    firstClient.request("operation.execute", {
      sessionId: firstSession.sessionId,
      leaseId: firstLease.leaseId,
      method: "page.click",
      params: { tabId: 101, locator: { role: "button", name: "Submit" } },
      timeoutMs: 100,
    }),
    (error) => error.code === "operation_effect_unknown",
  );
  assert.equal(clickDispatchCount, 1);

  const snapshot = await firstClient.request("status.get");
  assert.equal(snapshot.profiles.length, 1);
  assert.equal(snapshot.logicalSessionCount, 2);
  assert.equal(snapshot.exactTabLeaseCount, 2);
  assert.equal(snapshot.logicalSessions.length, 2);
  assert.equal(snapshot.logicalSessions[0].peerId, undefined);
  assert.equal(snapshot.exactTabLeases.length, 2);
  assert.ok(snapshot.exactTabLeases.every((lease) => lease.taskId === null));

  firstClient.close();
  secondClient.close();
  extension.close();
  await broker.close();
  await rm(dataDir, { recursive: true, force: true });
});

test("broker applies bounded FIFO backpressure across distinct target tabs", async () => {
  const dataDir = await mkdtemp(join(tmpdir(), "aos-companion-target-lane-"));
  const env = {
    ...process.env,
    AOS_CHROME_COMPANION_DATA_DIR: dataDir,
    AOS_CHROME_COMPANION_SOCKET: join(dataDir, "broker.sock"),
    AOS_CHROME_COMPANION_SECRET_FILE: join(dataDir, "secret"),
  };
  const secret = await ensureBrokerSecret(env);
  const broker = new CompanionBroker({ socketPath: env.AOS_CHROME_COMPANION_SOCKET, secret });
  await broker.listen();
  const extension = await connectPeer({ role: "extension-relay", autoStart: false, env });
  const helloAck = onceMessage(extension, (message) => message.kind === "extension.hello_ack");
  extension.send({
    kind: "extension.hello",
    protocolVersion: PROTOCOL_VERSION,
    profileInstanceId: "profile_target_lane",
    extensionRuntimeId: "runtime_target_lane",
    buildId: INSTALL_BUILD_ID,
    capabilities: DEFAULT_CAPABILITIES,
  });
  await helloAck;
  let active = 0;
  let maxActive = 0;
  extension.onMessage((message) => {
    if (message.kind !== "command.request" || message.method !== "page.snapshot") return;
    active += 1;
    maxActive = Math.max(maxActive, active);
    setTimeout(() => {
      active -= 1;
      extension.send({ kind: "command.result", operationId: message.operationId, result: { tabId: message.params.tabId, pageInstanceId: `page-${message.params.tabId}` } });
    }, 35);
  });
  const client = await BrokerClient.connect({ autoStart: false, env });
  const sessions = [];
  try {
    for (let index = 0; index < 4; index += 1) {
      const session = await client.request("session.open", { label: `target lane ${index}` });
      const lease = await client.request("lease.acquire", { sessionId: session.sessionId, tabId: 700 + index });
      sessions.push({ session, lease });
    }
    await Promise.all(sessions.map(({ session, lease }) => client.request("operation.execute", {
      sessionId: session.sessionId,
      leaseId: lease.leaseId,
      method: "page.snapshot",
      params: { tabId: lease.tabId },
    })));
    assert.equal(maxActive, 3);
    const status = await client.request("status.get");
    assert.equal(status.targetLanePolicy.maxConcurrency, 3);
    assert.equal(status.targetLanePolicy.fairness, "fifo_per_profile");
    const metrics = status.targetLaneMetrics.find((entry) => entry.profileInstanceId === "profile_target_lane");
    assert.equal(metrics.maxActive, 3);
    assert.equal(metrics.admitted, 4);
    assert.equal(metrics.completed, 4);
    assert.ok(metrics.queueWaitMsMax >= 0);
  } finally {
    client.close();
    extension.close();
    await broker.close();
    await rm(dataDir, { recursive: true, force: true });
  }
});

test("session.open reuses one task session, transfers an idle owner, and rejects an active owner conflict", async () => {
  const dataDir = await mkdtemp(join(tmpdir(), "aos-companion-task-session-test-"));
  const env = {
    ...process.env,
    AOS_CHROME_COMPANION_DATA_DIR: dataDir,
    AOS_CHROME_COMPANION_SOCKET: join(dataDir, "broker.sock"),
    AOS_CHROME_COMPANION_SECRET_FILE: join(dataDir, "secret"),
  };
  const secret = await ensureBrokerSecret(env);
  const broker = new CompanionBroker({ socketPath: env.AOS_CHROME_COMPANION_SOCKET, secret });
  await broker.listen();

  const extension = await connectPeer({ role: "extension-relay", autoStart: false, env });
  const helloAck = onceMessage(extension, (message) => message.kind === "extension.hello_ack");
  extension.send({
    kind: "extension.hello",
    protocolVersion: PROTOCOL_VERSION,
    profileInstanceId: "profile_task_session",
    extensionRuntimeId: "runtime_task_session",
    buildId: INSTALL_BUILD_ID,
    capabilities: DEFAULT_CAPABILITIES,
  });
  await helloAck;

  const firstClient = await BrokerClient.connect({ autoStart: false, env });
  const secondClient = await BrokerClient.connect({ autoStart: false, env });
  const thirdClient = await BrokerClient.connect({ autoStart: false, env });
  const original = await firstClient.request("session.open", { taskId: "task-one", label: "first" });
  const sameOwner = await firstClient.request("session.open", { taskId: "task-one", label: "updated" });
  assert.equal(sameOwner.sessionId, original.sessionId);
  assert.equal(sameOwner.reused, true);
  assert.equal(sameOwner.ownerTransferred, false);
  assert.equal(sameOwner.label, "updated");
  assert.equal((await firstClient.request("status.get")).logicalSessionCount, 1);

  const transferred = await secondClient.request("session.open", { taskId: "task-one", label: "new owner" });
  assert.equal(transferred.sessionId, original.sessionId);
  assert.equal(transferred.reused, true);
  assert.equal(transferred.ownerTransferred, true);
  await assert.rejects(
    firstClient.request("session.close", { sessionId: original.sessionId }),
    (error) => error.code === "session_not_owned",
  );

  const lease = await secondClient.request("lease.acquire", { sessionId: transferred.sessionId, tabId: 303 });
  await assert.rejects(
    thirdClient.request("session.open", { taskId: "task-one", label: "conflict" }),
    (error) => error.code === "task_session_owner_conflict"
      && error.details?.ownerSessionId === original.sessionId
      && error.details?.leaseCount === 1,
  );
  await secondClient.request("lease.release", { leaseId: lease.leaseId });
  await secondClient.request("session.close", { sessionId: transferred.sessionId });

  firstClient.close();
  secondClient.close();
  thirdClient.close();
  extension.close();
  await broker.close();
  await rm(dataDir, { recursive: true, force: true });
});

test("same Extension runtime reconnect preserves the profile generation and task-tab provenance", async () => {
  const dataDir = await mkdtemp(join(tmpdir(), "aos-companion-same-runtime-reconnect-"));
  const env = {
    ...process.env,
    AOS_CHROME_COMPANION_DATA_DIR: dataDir,
    AOS_CHROME_COMPANION_SOCKET: join(dataDir, "broker.sock"),
    AOS_CHROME_COMPANION_SECRET_FILE: join(dataDir, "secret"),
  };
  const secret = await ensureBrokerSecret(env);
  const broker = new CompanionBroker({ socketPath: env.AOS_CHROME_COMPANION_SOCKET, secret });
  await broker.listen();

  const firstExtension = await connectPeer({ role: "extension-relay", autoStart: false, env });
  const firstAckPromise = onceMessage(firstExtension, (message) => message.kind === "extension.hello_ack");
  firstExtension.send({
    kind: "extension.hello",
    protocolVersion: PROTOCOL_VERSION,
    profileInstanceId: "profile_same_runtime",
    extensionRuntimeId: "runtime_same_browser_session",
    buildId: INSTALL_BUILD_ID,
    capabilities: DEFAULT_CAPABILITIES,
  });
  const firstAck = await firstAckPromise;
  const taskTab = await broker.taskLedger.recordTaskTab({
    profileInstanceId: "profile_same_runtime",
    generation: firstAck.generation,
    tabId: 808,
    taskId: "task_same_runtime",
    runId: "run_same_runtime",
    sessionId: "session_previous_transport",
    retentionPolicy: "retain",
    lifecycleState: "completed",
  });
  broker.taskTabs.set("profile_same_runtime:808", taskTab);

  const secondExtension = await connectPeer({ role: "extension-relay", autoStart: false, env });
  const secondAckPromise = onceMessage(secondExtension, (message) => message.kind === "extension.hello_ack");
  secondExtension.send({
    kind: "extension.hello",
    protocolVersion: PROTOCOL_VERSION,
    profileInstanceId: "profile_same_runtime",
    extensionRuntimeId: "runtime_same_browser_session",
    buildId: INSTALL_BUILD_ID,
    capabilities: DEFAULT_CAPABILITIES,
  });
  const secondAck = await secondAckPromise;
  assert.equal(secondAck.generation, firstAck.generation);
  assert.equal(broker.taskTabs.get("profile_same_runtime:808").quarantine, undefined);

  const client = await BrokerClient.connect({ autoStart: false, env });
  const status = await client.request("status.get");
  assert.equal(status.quarantinedTaskTabCount, 0);
  assert.equal(status.profiles[0].generation, firstAck.generation);

  client.close();
  secondExtension.close();
  firstExtension.close();
  await broker.close();
  await rm(dataDir, { recursive: true, force: true });
});

test("cold broker restart recovers a persisted Extension generation and quarantines a changed runtime", async () => {
  const dataDir = await mkdtemp(join(tmpdir(), "aos-companion-cold-restart-"));
  const env = {
    ...process.env,
    AOS_CHROME_COMPANION_DATA_DIR: dataDir,
    AOS_CHROME_COMPANION_SOCKET: join(dataDir, "broker.sock"),
    AOS_CHROME_COMPANION_SECRET_FILE: join(dataDir, "secret"),
  };
  const secret = await ensureBrokerSecret(env);
  const statePath = join(dataDir, "ledger.json");

  const start = async (extensionRuntimeId) => {
    const broker = new CompanionBroker({ socketPath: env.AOS_CHROME_COMPANION_SOCKET, secret, statePath });
    await broker.listen();
    const extension = await connectPeer({ role: "extension-relay", autoStart: false, env });
    const ackPromise = onceMessage(extension, (message) => message.kind === "extension.hello_ack");
    extension.send({
      kind: "extension.hello",
      protocolVersion: PROTOCOL_VERSION,
      profileInstanceId: "profile_cold_restart",
      extensionRuntimeId,
      buildId: INSTALL_BUILD_ID,
      capabilities: DEFAULT_CAPABILITIES,
    });
    const ack = await ackPromise;
    return { broker, extension, ack };
  };

  const first = await start("runtime_persisted");
  const taskTab = await first.broker.taskLedger.recordTaskTab({
    profileInstanceId: "profile_cold_restart",
    generation: first.ack.generation,
    tabId: 909,
    taskId: "task_cold_restart",
    runId: "run_cold_restart",
    sessionId: "session_cold_restart",
    retentionPolicy: "retain",
    lifecycleState: "completed",
  });
  first.broker.taskTabs.set("profile_cold_restart:909", taskTab);
  first.extension.close();
  await first.broker.close();

  const offline = new CompanionBroker({ socketPath: env.AOS_CHROME_COMPANION_SOCKET, secret, statePath });
  await offline.listen();
  const offlineStatus = offline.snapshot();
  assert.equal(offlineStatus.profiles.length, 1);
  assert.equal(offlineStatus.profiles[0].profileInstanceId, "profile_cold_restart");
  assert.equal(offlineStatus.profiles[0].connected, false);
  await offline.close();

  const second = await start("runtime_persisted");
  assert.equal(second.ack.generation, first.ack.generation);
  assert.equal(second.broker.taskTabs.get("profile_cold_restart:909").quarantine, undefined);
  second.extension.close();
  await second.broker.close();

  const third = await start("runtime_changed");
  assert.notEqual(third.ack.generation, first.ack.generation);
  assert.equal(third.broker.taskTabs.get("profile_cold_restart:909").quarantine, "stale_generation");
  third.extension.close();
  await third.broker.close();
  await rm(dataDir, { recursive: true, force: true });
});

test("fresh signed task status reads unknown state after the original session is closed without dispatching", async () => {
  const dataDir = await mkdtemp(join(tmpdir(), "aos-companion-status-test-"));
  const env = {
    ...process.env,
    AOS_CHROME_COMPANION_DATA_DIR: dataDir,
    AOS_CHROME_COMPANION_SOCKET: join(dataDir, "broker.sock"),
    AOS_CHROME_COMPANION_SECRET_FILE: join(dataDir, "secret"),
    AOS_CHROME_COMPANION_AOS_ISSUER_SECRET_FILE: join(dataDir, "aos-issuer"),
  };
  await writeFile(env.AOS_CHROME_COMPANION_AOS_ISSUER_SECRET_FILE, "issuer-secret\n", { mode: 0o600 });
  const secret = await ensureBrokerSecret(env);
  const broker = new CompanionBroker({
    socketPath: env.AOS_CHROME_COMPANION_SOCKET,
    secret,
    issuerSecrets: { aos: "issuer-secret" },
    statePath: join(dataDir, "ledger.json"),
  });
  await broker.listen();
  const extension = await connectPeer({ role: "extension-relay", autoStart: false, env });
  const helloAck = onceMessage(extension, (message) => message.kind === "extension.hello_ack");
  extension.send({ kind: "extension.hello", protocolVersion: PROTOCOL_VERSION, profileInstanceId: "profile_status", extensionRuntimeId: "runtime_status", buildId: INSTALL_BUILD_ID, capabilities: DEFAULT_CAPABILITIES });
  await helloAck;
  let dispatchCount = 0;
  extension.onMessage((message) => { if (message.kind === "command.request") dispatchCount += 1; });

  const client = await BrokerClient.connect({ autoStart: false, env, issuer: "aos" });
  const original = await client.request("session.open", { taskId: "task_status" });
  await broker.taskLedger.prepare({
    idempotencyKey: "idem_status",
    fingerprint: "fingerprint_status",
    binding: { runId: "run_status", taskId: "task_status", sessionId: original.sessionId, ownerKey: original.sessionId, method: "page.click" },
  });
  await broker.taskLedger.transition("idem_status", "dispatched", { operationId: "operation_status" });
  await broker.taskLedger.transition("idem_status", "unknown_effect");
  await client.request("session.close", { sessionId: original.sessionId });
  const fresh = await client.request("session.open", { taskId: "different_task" });
  const status = await client.requestTaskStatus({ sessionId: fresh.sessionId, runId: "run_status", taskId: "task_status", idempotencyKey: "idem_status" });
  assert.equal(status.state, "unknown_effect");
  assert.equal(status.dispatch_count, 1);
  assert.equal(status.current_profile_connected, true);
  assert.equal(status.generation_matches, false);
  assert.equal(status.ledger_tab_present, false);
  assert.equal(status.tab_quarantined, false);
  assert.equal(status.resume_disposition, "open_fresh_target_then_reconcile");
  assert.equal(status.continuation_allowed, false);
  assert.equal(dispatchCount, 0);
  await broker.taskLedger.transition("idem_status", "reconciled", {
    brokerEvidence: true,
    resultDigest: "late-result-digest",
  });
  const reconciled = await client.requestTaskStatus({
    sessionId: fresh.sessionId,
    runId: "run_status",
    taskId: "task_status",
    idempotencyKey: "idem_status",
  });
  assert.equal(reconciled.operation_state, "reconciled");
  assert.equal(reconciled.broker_evidence, true);
  assert.equal(reconciled.late_result_reconciled, true);
  assert.equal(reconciled.resume_disposition, "open_fresh_target_then_reconcile");
  assert.equal(reconciled.continuation_allowed, false);
  assert.equal(reconciled.restart_point, "fresh_target_readback_then_terminal_cleanup");
  assert.equal(dispatchCount, 0);
  await assert.rejects(client.requestTaskStatus({ sessionId: fresh.sessionId, runId: "forged_run", taskId: "task_status", idempotencyKey: "idem_status" }), (error) => error.code === "task_status_not_found");
  client.close();
  extension.close();
  await broker.close();
  await rm(dataDir, { recursive: true, force: true });
});

test("signed reconciliation archive is owner-scoped and does not lower the scheduler gate", async () => {
  const dataDir = await mkdtemp(join(tmpdir(), "aos-companion-archive-broker-test-"));
  const env = {
    ...process.env,
    AOS_CHROME_COMPANION_DATA_DIR: dataDir,
    AOS_CHROME_COMPANION_SOCKET: join(dataDir, "broker.sock"),
    AOS_CHROME_COMPANION_SECRET_FILE: join(dataDir, "secret"),
    AOS_CHROME_COMPANION_CODEX_MCP_ISSUER_SECRET_FILE: join(dataDir, "codex-issuer"),
  };
  const secret = await ensureBrokerSecret(env);
  const issuerSecret = "archive-broker-issuer-secret";
  await writeFile(env.AOS_CHROME_COMPANION_CODEX_MCP_ISSUER_SECRET_FILE, `${issuerSecret}\n`, { mode: 0o600 });
  const broker = new CompanionBroker({
    socketPath: env.AOS_CHROME_COMPANION_SOCKET,
    secret,
    issuerSecrets: { codex_mcp: issuerSecret },
    statePath: join(dataDir, "ledger.json"),
  });
  await broker.listen();
  const extension = await connectPeer({ role: "extension-relay", autoStart: false, env });
  const helloAck = onceMessage(extension, (message) => message.kind === "extension.hello_ack");
  extension.send({ kind: "extension.hello", protocolVersion: PROTOCOL_VERSION, profileInstanceId: "profile_archive", extensionRuntimeId: "runtime_archive", buildId: INSTALL_BUILD_ID, capabilities: DEFAULT_CAPABILITIES });
  await helloAck;
  const client = await BrokerClient.connect({ autoStart: false, env });
  const session = await client.request("session.open", { taskId: "task_archive" });
  const entry = await broker.taskLedger.prepare({
    idempotencyKey: "idem_archive_broker",
    fingerprint: "fingerprint_archive_broker",
    binding: { runId: "run_archive_broker", taskId: "task_archive", sessionId: session.sessionId, ownerKey: session.sessionId, method: "page.click" },
  });
  await broker.taskLedger.transition(entry.idempotencyKey, "dispatched", { operationId: "operation_archive_broker" });
  await broker.taskLedger.transition(entry.idempotencyKey, "unknown_effect", { reason: "test_unknown_effect" });
  try {
    const result = await client.requestArchiveReconciliation({
      sessionId: session.sessionId,
      runId: "run_archive_broker",
      taskId: "task_archive",
      idempotencyKey: "archive-request-1",
      operationIds: [entry.operationId],
      reason: "operator reviewed backlog",
      confirmArchiveOnly: true,
    });
    assert.equal(result.status, "archived");
    assert.equal(result.archived_count, 1);
    assert.equal(result.state_unchanged, true);
    assert.equal(result.evidence_preserved, true);
    assert.equal(result.scheduler_gate.reconciliation_pending_count, 1);
    assert.equal(result.scheduler_gate.reconciliation_pending_visible_count, 0);
    assert.equal(broker.taskLedger.get(entry.idempotencyKey).state, "unknown_effect");
    assert.equal(broker.taskLedger.get(entry.idempotencyKey).archiveId, "archive-request-1");
    assert.equal(broker.snapshot().reconciliationPendingCount, 1);
    assert.equal(broker.snapshot().reconciliationPendingVisibleCount, 0);
    assert.equal(broker.snapshot().reconciliationPendingArchivedCount, 1);

    const repeated = await client.requestArchiveReconciliation({
      sessionId: session.sessionId,
      runId: "run_archive_broker",
      taskId: "task_archive",
      idempotencyKey: "archive-request-1",
      operationIds: [entry.operationId],
      reason: "same request retry",
      confirmArchiveOnly: true,
    });
    assert.equal(repeated.archived_count, 0);
    assert.equal(repeated.already_archived_count, 1);
    await assert.rejects(client.requestArchiveReconciliation({
      sessionId: session.sessionId,
      runId: "run_archive_broker",
      taskId: "task_archive",
      idempotencyKey: "archive-request-foreign",
      operationIds: [entry.operationId],
      reason: "must not archive under a different id",
      confirmArchiveOnly: true,
    }), (error) => error.message.includes("different archive id"));
  } finally {
    await client.request("session.close", { sessionId: session.sessionId });
    client.close();
    extension.close();
    await broker.close();
    await rm(dataDir, { recursive: true, force: true });
  }
});

test("rejects missing and mismatched Extension build IDs and exposes the exact registration blocker", async () => {
  const dataDir = await mkdtemp(join(tmpdir(), "aos-companion-build-id-test-"));
  const env = {
    ...process.env,
    AOS_CHROME_COMPANION_DATA_DIR: dataDir,
    AOS_CHROME_COMPANION_SOCKET: join(dataDir, "broker.sock"),
    AOS_CHROME_COMPANION_SECRET_FILE: join(dataDir, "secret"),
  };
  const secret = await ensureBrokerSecret(env);
  const broker = new CompanionBroker({ socketPath: env.AOS_CHROME_COMPANION_SOCKET, secret });
  await broker.listen();
  const extension = await connectPeer({ role: "extension-relay", autoStart: false, env });
  const missing = onceMessage(extension, (message) => message.kind === "peer.error");
  extension.send({ kind: "extension.hello", protocolVersion: PROTOCOL_VERSION, profileInstanceId: "profile_build", extensionRuntimeId: "runtime_missing", capabilities: DEFAULT_CAPABILITIES });
  assert.equal((await missing).error.code, "extension_build_id_missing");
  const mismatched = onceMessage(extension, (message) => message.kind === "peer.error");
  extension.send({ kind: "extension.hello", protocolVersion: PROTOCOL_VERSION, profileInstanceId: "profile_build", extensionRuntimeId: "runtime_mismatch", buildId: "install-old", capabilities: DEFAULT_CAPABILITIES });
  assert.equal((await mismatched).error.code, "extension_build_id_mismatch");
  const status = broker.snapshot();
  assert.equal(status.expectedBuildId, INSTALL_BUILD_ID);
  assert.equal(status.profiles.length, 0);
  assert.equal(status.profileRegistrationFailures.at(-1).exactBlocker.code, "extension_build_id_mismatch");
  assert.equal(status.profileRegistrationFailures.at(-1).receivedBuildId, "install-old");
  extension.close();
  await broker.close();
  await rm(dataDir, { recursive: true, force: true });
});

test("default terminal cleanup closes safe discovered retained tabs and own idle leases but preserves foreign or busy leases, user-help, and pinned tabs", async () => {
  const dataDir = await mkdtemp(join(tmpdir(), "aos-term-"));
  const env = {
    ...process.env,
    AOS_CHROME_COMPANION_DATA_DIR: dataDir,
    AOS_CHROME_COMPANION_SOCKET: join(dataDir, "broker.sock"),
    AOS_CHROME_COMPANION_SECRET_FILE: join(dataDir, "secret"),
  };
  const secret = await ensureBrokerSecret(env);
  const broker = new CompanionBroker({ socketPath: env.AOS_CHROME_COMPANION_SOCKET, secret });
  await broker.listen();
  const extension = await connectPeer({ role: "extension-relay", autoStart: false, env });
  const helloAck = onceMessage(extension, (message) => message.kind === "extension.hello_ack");
  extension.send({ kind: "extension.hello", protocolVersion: PROTOCOL_VERSION, profileInstanceId: "profile_terminal_discovered", extensionRuntimeId: "runtime_terminal_discovered", buildId: INSTALL_BUILD_ID, capabilities: DEFAULT_CAPABILITIES });
  const ack = await helloAck;
  const liveTabs = new Map([
    [110, { id: 110, url: "https://example.test/safe", active: true, pinned: false }],
    [111, { id: 111, url: "https://example.test/help", active: false, pinned: false }],
    [112, { id: 112, url: "https://example.test/leased", active: false, pinned: false }],
    [113, { id: 113, url: "https://example.test/pinned", active: false, pinned: true }],
  ]);
  for (const tabId of [114, 115, 116]) liveTabs.set(tabId, { id: tabId, url: `https://example.test/lease-${tabId}`, active: false, pinned: false });
  const closeCommands = [];
  extension.onMessage((message) => {
    if (message.kind !== "command.request") return;
    if (message.method === "tabs.list") {
      extension.send({ kind: "command.result", operationId: message.operationId, result: [...liveTabs.values()] });
    } else if (message.method === "tabs.close") {
      closeCommands.push(message.params.tabId);
      liveTabs.delete(message.params.tabId);
      extension.send({ kind: "command.result", operationId: message.operationId, result: { closed: true, tabId: message.params.tabId } });
    }
  });
  const client = await BrokerClient.connect({ autoStart: false, env });
  const session = await client.request("session.open", { taskId: "task_terminal_discovered" });
  await broker.taskLedger.recordTaskTab({ profileInstanceId: "profile_terminal_discovered", generation: ack.generation, tabId: 110, taskId: "task_terminal_discovered", runId: "run_safe", sessionId: "old-session", lifecycleState: "discovered", retentionPolicy: "retain", userHelpRequired: false });
  await broker.taskLedger.recordTaskTab({ profileInstanceId: "profile_terminal_discovered", generation: ack.generation, tabId: 111, taskId: "task_terminal_discovered", runId: "run_help", sessionId: session.sessionId, lifecycleState: "awaiting_user", retentionPolicy: "retain_until_resume", userHelpRequired: true, resumeToken: "resume_help" });
  await broker.taskLedger.recordTaskTab({ profileInstanceId: "profile_terminal_discovered", generation: ack.generation, tabId: 112, taskId: "task_terminal_discovered", runId: "run_lease", sessionId: session.sessionId, lifecycleState: "discovered", retentionPolicy: "retain", userHelpRequired: false });
  await broker.taskLedger.recordTaskTab({ profileInstanceId: "profile_terminal_discovered", generation: ack.generation, tabId: 113, taskId: "task_terminal_discovered", runId: "run_pinned", sessionId: session.sessionId, lifecycleState: "discovered", retentionPolicy: "retain", userHelpRequired: false });
  for (const tabId of [110, 111, 112, 113]) broker.taskTabs.set(`profile_terminal_discovered:${tabId}`, broker.taskLedger.getTaskTab("profile_terminal_discovered", tabId));
  await client.request("lease.acquire", { sessionId: session.sessionId, tabId: 112 });
  const foreign = await client.request("session.open", { taskId: "other-task" });
  for (const tabId of [114, 115, 116]) {
    await broker.taskLedger.recordTaskTab({ profileInstanceId: "profile_terminal_discovered", generation: ack.generation, tabId, taskId: "task_terminal_discovered", sessionId: session.sessionId, lifecycleState: "completed", retentionPolicy: "retain" });
    broker.taskTabs.set(`profile_terminal_discovered:${tabId}`, broker.taskLedger.getTaskTab("profile_terminal_discovered", tabId));
  }
  const foreignLease = await client.request("lease.acquire", { sessionId: foreign.sessionId, tabId: 114 });
  for (const tabId of [115, 116]) await client.request("lease.acquire", { sessionId: session.sessionId, tabId });
  broker.pendingOperations.set("pending-cleanup-test", { sessionId: session.sessionId, params: { tabId: 115 } });
  broker.timedOutOperations.set("timeout-cleanup-test", { sessionId: session.sessionId, binding: { tabId: 116 } });
  const closed = await client.request("session.close", { sessionId: session.sessionId });
  broker.pendingOperations.delete("pending-cleanup-test");
  broker.timedOutOperations.delete("timeout-cleanup-test");
  assert.deepEqual(closeCommands, [110, 112]);
  assert.deepEqual(closed.terminal_tab_cleanup.closed, [110, 112]);
  assert.equal(closed.cleanup_receipt.schema, "aos.chrome_companion.owner_cleanup_receipt.v1");
  assert.equal(closed.cleanup_receipt.owner_task_id, "task_terminal_discovered");
  assert.equal(closed.cleanup_receipt.owner_session_id, session.sessionId);
  assert.equal(closed.cleanup_receipt.session_closed, true);
  assert.equal(closed.cleanup_receipt.foreign_tabs_mutated, false);
  assert.deepEqual(closed.cleanup_receipt.closed, [110, 112]);
  assert.equal(closed.terminal_tab_cleanup.retained.some((item) => item.tabId === 111), true);
  assert.deepEqual(closed.terminal_tab_cleanup.skipped, [114, 115, 116].map(tabId => ({ tabId, reason: "leased" })));
  assert.equal(closed.task_terminal, true);
  assert.equal(closed.terminal_tab_cleanup.retained.some((item) => item.tabId === 113 && item.retention_reason === "pinned"), true);
  assert.equal(liveTabs.has(111), true);
  assert.equal(liveTabs.has(112), false);
  assert.equal(closed.cleanup_receipt.leases_released, 3);
  assert.equal(broker.leases.has(foreignLease.leaseId), true);
  assert.equal(broker.sessions.has(foreign.sessionId), true);
  for (const tabId of [114, 115, 116]) assert.equal(liveTabs.has(tabId), true);
  await client.request("session.close", { sessionId: foreign.sessionId, taskTerminal: false });
  assert.equal(liveTabs.has(113), true);
  client.close();
  extension.close();
  await broker.close();
  await rm(dataDir, { recursive: true, force: true });
});

test("pre-effect cleanup accepts deleted prior sessions but protects a live other session", () => {
  const entry = { lifecycleState: "discovered", retentionPolicy: "retain", userHelpRequired: false };
  assert.equal(isSafePreEffectTaskTab({ ...entry, sessionId: "old-session" }, { sessionId: "fresh-session", liveSessionIds: new Set(["fresh-session"]) }), true);
  assert.equal(isSafePreEffectTaskTab({ ...entry, sessionId: "live-other-session" }, { sessionId: "fresh-session", liveSessionIds: new Set(["fresh-session", "live-other-session"]) }), false);
  assert.equal(isSafePreEffectTaskTab({ ...entry, taskId: "task-with-pending-operation", sessionId: "old-session" }, {
    sessionId: "fresh-session",
    liveSessionIds: new Set(["fresh-session"]),
    pendingTaskIds: new Set(["task-with-pending-operation"]),
  }), false);
});

test("hookless receipt transfers only live unleased retained source tabs to the exact destination task", async () => {
  const harness = await createCapsuleHarness();
  const { broker, client, session, liveTabs, commands, handoffReceiptsDir } = harness;
  const origin = "https://example.test";
  try {
    const retained = await client.requestAuthorizedTransaction({
      sessionId: session.sessionId,
      runId: "run_source",
      taskId: "capsule_task",
      idempotencyKey: "idem_source",
      targetOrigin: origin,
      startUrl: `${origin}/handoff`,
      allowedOrigins: [origin],
      actions: [{ method: "page.waitFor", params: { locator: { testId: "ready" }, timeoutMs: 100 } }],
      capsule: { workflowType: "Jobs", targetKey: "handoff-target" },
      keepTaskTab: true,
    });
    const foreignTabId = 88_001;
    liveTabs.set(foreignTabId, { id: foreignTabId, url: `${origin}/official-or-foreign`, title: "foreign" });
    const receiptPath = join(handoffReceiptsDir, "capsule_task.json");
    await writeFile(receiptPath, `${JSON.stringify({
      schema: "codex_hookless_handoff_receipt.v1",
      status: "reconciliation_required",
      source_status: "reconciliation_only",
      implementation_allowed: false,
      source_thread_id: "capsule_task",
      destination_thread_id: "destination_task",
      packet_content_sha256: "a".repeat(64),
      source_task_archived: false,
      source_task_visible: true,
    })}\n`, { mode: 0o600 });
    const destination = await client.request("session.open", { taskId: "destination_task", label: "handoff destination" });
    const sourceLease = await client.request("lease.acquire", { sessionId: session.sessionId, tabId: retained.tab.id });
    await assert.rejects(client.requestTransferHandoffTabs({
      sessionId: destination.sessionId,
      runId: "run_destination",
      sourceTaskId: "capsule_task",
      destinationTaskId: "destination_task",
      receiptPath,
      idempotencyKey: "transfer_busy",
    }), (error) => error.code === "handoff_tabs_busy");
    assert.equal(broker.taskTabs.get(`profile_capsule:${retained.tab.id}`).taskId, "capsule_task");
    await client.request("lease.release", { leaseId: sourceLease.leaseId });

    const commandCountBefore = commands.length;
    const transferred = await client.requestTransferHandoffTabs({
      sessionId: destination.sessionId,
      runId: "run_destination",
      sourceTaskId: "capsule_task",
      destinationTaskId: "destination_task",
      receiptPath,
      idempotencyKey: "transfer_ready",
    });
    assert.deepEqual(transferred.transferred, [retained.tab.id]);
    assert.equal(transferred.external_action_executed, false);
    assert.equal(commands.slice(commandCountBefore).every((command) => command.method === "tabs.list"), true);
    const ledgerTab = broker.taskTabs.get(`profile_capsule:${retained.tab.id}`);
    assert.equal(ledgerTab.taskId, "destination_task");
    assert.equal(ledgerTab.handoffSourceTaskId, "capsule_task");
    assert.equal(ledgerTab.sessionId, destination.sessionId);
    assert.equal(ledgerTab.targetIdentity.taskId, "destination_task");
    assert.equal(ledgerTab.targetIdentity.sessionId, destination.sessionId);
    assert.equal(ledgerTab.targetIdentity.leaseId, null);
    assert.equal(ledgerTab.targetFingerprint, targetIdentityDigest(broker.ledgerSecret, ledgerTab.targetIdentity));
    assert.equal(broker.taskTabs.has(`profile_capsule:${foreignTabId}`), false);

    const again = await client.requestTransferHandoffTabs({
      sessionId: destination.sessionId,
      runId: "run_destination",
      sourceTaskId: "capsule_task",
      destinationTaskId: "destination_task",
      receiptPath,
      idempotencyKey: "transfer_idempotent_readback",
    });
    assert.deepEqual(again.transferred, []);
    assert.deepEqual(again.already_transferred, [retained.tab.id]);

    await assert.rejects(client.requestAuthorizedTransaction({
      sessionId: session.sessionId,
      runId: "run_source_after_handoff",
      taskId: "capsule_task",
      idempotencyKey: "idem_source_after_handoff",
      targetOrigin: origin,
      startUrl: `${origin}/must-not-open`,
      allowedOrigins: [origin],
      actions: [{ method: "page.waitFor", params: { locator: { testId: "ready" }, timeoutMs: 100 } }],
      capsule: { workflowType: "Jobs", targetKey: "must-not-open" },
    }), (error) => error.code === "source_handoff_implementation_forbidden"
      && error.details?.destinationTaskId === "destination_task");
  } finally {
    await harness.close();
  }
});

test("direct_application keeps normal current-owner applications independent from the source-return gate", async () => {
  const harness = await createCapsuleHarness();
  const { client, session, handoffReceiptsDir } = harness;
  const origin = "https://example.test";
  const receiptPath = join(handoffReceiptsDir, "capsule_task.json");
  await writeFile(receiptPath, `${JSON.stringify({
    schema: "codex_hookless_handoff_receipt.v1",
    status: "reconciliation_required",
    source_status: "reconciliation_only",
    implementation_allowed: false,
    source_thread_id: "capsule_task",
    destination_thread_id: "destination_task",
    packet_content_sha256: "a".repeat(64),
    source_task_archived: false,
    source_task_visible: true,
  })}\n`, { mode: 0o600 });
  try {
    const direct = await client.requestAuthorizedTransaction({
      sessionId: session.sessionId,
      runId: "run_direct_application",
      taskId: "capsule_task",
      idempotencyKey: "idem_direct_application",
      intent: "direct_application",
      targetOrigin: origin,
      startUrl: `${origin}/direct-application`,
      allowedOrigins: [origin],
      actions: [{ method: "page.waitFor", params: { locator: { testId: "ready" }, timeoutMs: 100 } }],
      capsule: { workflowType: "Jobs", targetKey: "direct-application" },
    });
    assert.equal(direct.result, "verified");
    assert.equal(direct.exact_blocker, null);
    assert.equal(direct.external_action_executed, false);
    assert.equal(direct.cleanup.closed, true);

    await assert.rejects(client.requestAuthorizedTransaction({
      sessionId: session.sessionId,
      runId: "run_generic_after_direct_application",
      taskId: "capsule_task",
      idempotencyKey: "idem_generic_after_direct_application",
      targetOrigin: origin,
      startUrl: `${origin}/generic-must-remain-blocked`,
      allowedOrigins: [origin],
      actions: [{ method: "page.waitFor", params: { locator: { testId: "ready" }, timeoutMs: 100 } }],
      capsule: { workflowType: "Jobs", targetKey: "generic-after-direct-application" },
    }), (error) => error.code === "source_handoff_implementation_forbidden"
      && error.details?.destinationTaskId === "destination_task");
  } finally {
    await harness.close();
  }
});

test("authorized transaction closes terminal tabs by default, forgets provenance, and binds ownership to run", async () => {
  const dataDir = await mkdtemp(join(tmpdir(), "aos-companion-cleanup-test-"));
  const issuerSecret = "cleanup-issuer-secret";
  const env = {
    ...process.env,
    AOS_CHROME_COMPANION_DATA_DIR: dataDir,
    AOS_CHROME_COMPANION_SOCKET: join(dataDir, "broker.sock"),
    AOS_CHROME_COMPANION_SECRET_FILE: join(dataDir, "secret"),
    AOS_CHROME_COMPANION_CODEX_MCP_ISSUER_SECRET_FILE: join(dataDir, "codex-issuer"),
  };
  await writeFile(env.AOS_CHROME_COMPANION_CODEX_MCP_ISSUER_SECRET_FILE, `${issuerSecret}\n`, { mode: 0o600 });
  const secret = await ensureBrokerSecret(env);
  const broker = new CompanionBroker({
    socketPath: env.AOS_CHROME_COMPANION_SOCKET,
    secret,
    issuerSecrets: { codex_mcp: issuerSecret },
    statePath: join(dataDir, "ledger.json"),
  });
  await broker.listen();

  const extension = await connectPeer({ role: "extension-relay", autoStart: false, env });
  const helloAck = onceMessage(extension, (message) => message.kind === "extension.hello_ack");
  extension.send({ kind: "extension.hello", protocolVersion: PROTOCOL_VERSION, profileInstanceId: "profile_cleanup", extensionRuntimeId: "runtime_cleanup", buildId: INSTALL_BUILD_ID, capabilities: DEFAULT_CAPABILITIES });
  await helloAck;
  const commands = [];
  extension.onMessage((message) => {
    if (message.kind !== "command.request") return;
    commands.push(message);
    if (message.method === "tabs.create" && message.params.url.endsWith("/race")) {
      extension.send({ kind: "extension.event", event: "task.tab.created", operationId: message.operationId, profileInstanceId: "profile_cleanup", tabId: 304 });
      extension.send({ kind: "command.error", operationId: message.operationId, error: { code: "navigation_commit_timeout", message: "synthetic create race", details: { createdTabId: 304 } } });
      return;
    }
    const result = message.method === "tabs.list"
      ? []
      : message.method === "tabs.create"
      ? { id: 303, url: "http://127.0.0.1:8787/" }
      : message.method === "page.snapshot"
        ? { url: "http://127.0.0.1:8787/", title: "canary", text: "ready", pageInstanceId: "document-303" }
        : message.method === "page.screenshot"
          ? { kind: "screenshot", dataBase64: Buffer.from("cleanup fixture").toString("base64"), url: "http://127.0.0.1:8787/", tabId: message.params.tabId, pageInstanceId: "document-303" }
        : message.method === "visual.inspectTarget"
          ? { url: "http://127.0.0.1:8787/", element: { tag: "input", role: "textbox", name: "Full name", testId: null }, rect: { x: 10, y: 10, width: 100, height: 30 }, clippedRect: { x: 10, y: 10, width: 100, height: 30 }, point: { x: 60, y: 25 }, viewport: { width: 1200, height: 800, devicePixelRatio: 1 } }
        : message.method === "tabs.close"
          ? { closed: true, tabId: message.params.tabId }
          : { found: true };
    extension.send({ kind: "command.result", operationId: message.operationId, result });
  });

  const client = await BrokerClient.connect({ autoStart: false, env, issuer: "codex_mcp" });
  const session = await client.request("session.open", { taskId: "task_cleanup" });
  const origin = "http://127.0.0.1:8787";
  const transaction = await client.requestAuthorizedTransaction({
    sessionId: session.sessionId,
    runId: "run_cleanup",
    taskId: "task_cleanup",
    idempotencyKey: "idem_cleanup",
    targetOrigin: origin,
    startUrl: `${origin}/`,
    allowedOrigins: [origin],
    actions: [{
      method: "page.type",
      params: {
        locator: { role: "textbox", label: "Full name" },
        text: "Test User",
      },
    }],
  });
  assert.equal(transaction.result, "verified");
  assert.equal(transaction.cleanup.closed, true);
  const phaseNames = ["admission", "tab_setup", "pre_read_and_binding", "actions", "visual_readback", "finalization"];
  for (const phase of phaseNames) assert.ok(Number.isFinite(transaction.timings_ms[phase]) && transaction.timings_ms[phase] >= 0, phase);
  const phaseTotal = phaseNames.reduce((sum, phase) => sum + transaction.timings_ms[phase], 0);
  assert.ok(Math.abs(phaseTotal - transaction.timings_ms.total) < 0.01, "phases account for the complete transaction without overlap");
  const typeCommand = commands.find((command) => command.method === "page.type");
  assert.equal(typeCommand.params.locator.label, "Full name");
  assert.equal(typeCommand.params.text, "Test User");
  const closeCommand = commands.find((command) => command.method === "tabs.close");
  assert.deepEqual(closeCommand.allowedOrigins, [origin]);
  assert.equal(closeCommand.targetOrigin, origin);
  assert.equal((await client.request("status.get")).taskTabCount, 0);
  assert.equal(broker.taskLedger.getTaskTab("profile_cleanup", 303), null);

  const racedSession = await client.request("session.open", { taskId: "task_race" });
  const raced = await client.requestAuthorizedTransaction({
    sessionId: racedSession.sessionId,
    runId: "run_race",
    taskId: "task_race",
    idempotencyKey: "idem_race",
    targetOrigin: origin,
    startUrl: `${origin}/race`,
    allowedOrigins: [origin],
    actions: [{ method: "page.waitFor", params: { locator: { testId: "done" }, timeoutMs: 100 } }],
    keepTaskTab: false,
  });
  assert.equal(raced.result, "unknown_effect");
  assert.equal(raced.cleanup.closed, true);
  assert.ok(Number.isFinite(raced.timings_ms.tab_setup), "a failed phase still carries timing evidence");
  assert.equal(raced.timings_ms.actions, undefined, "unreached phases are not reported as completed work");
  assert.equal(broker.taskLedger.getTaskTab("profile_cleanup", 304), null);
  assert.equal((await client.request("status.get")).taskTabCount, 0);

  await broker.taskLedger.recordTaskTab({ profileInstanceId: "profile_cleanup", generation: transaction.profile.generation, tabId: 404, taskId: "same-task", runId: "owned-run" });
  const otherRunSession = await client.request("session.open", { taskId: "same-task" });
  const otherRunLease = await client.request("lease.acquire", { sessionId: otherRunSession.sessionId, tabId: 404 });
  const operationParams = { tabId: 404, allowedOrigins: [origin], targetOrigin: origin };
  const wrongRunAuthority = createAuthorityEnvelope({
    issuer: "codex_mcp",
    secret: issuerSecret,
    runId: "other-run",
    taskId: "same-task",
    ownerKey: otherRunSession.sessionId,
    method: "tabs.close",
    intent: "tabs.close",
    targetOrigin: origin,
    idempotencyKey: "wrong-run-close",
    payload: operationParams,
  });
  await assert.rejects(client.request("operation.execute", {
    sessionId: otherRunSession.sessionId,
    leaseId: otherRunLease.leaseId,
    method: "tabs.close",
    params: operationParams,
    authority: wrongRunAuthority,
    taskOwnedRequired: true,
  }), (error) => error.code === "task_tab_ownership_required");
  assert.equal(commands.filter((command) => command.params?.tabId === 404).length, 0);

  client.close();
  extension.close();
  await broker.close();
  await rm(dataDir, { recursive: true, force: true });
});

test("authorized transactions reuse only explicitly retained tabs and close explicit ephemeral tabs", async () => {
  const dataDir = await mkdtemp(join(tmpdir(), "aos-companion-reuse-test-"));
  const issuerSecret = "reuse-issuer-secret";
  const env = {
    ...process.env,
    AOS_CHROME_COMPANION_DATA_DIR: dataDir,
    AOS_CHROME_COMPANION_SOCKET: join(dataDir, "broker.sock"),
    AOS_CHROME_COMPANION_SECRET_FILE: join(dataDir, "secret"),
    AOS_CHROME_COMPANION_CODEX_MCP_ISSUER_SECRET_FILE: join(dataDir, "codex-issuer"),
  };
  await writeFile(env.AOS_CHROME_COMPANION_CODEX_MCP_ISSUER_SECRET_FILE, `${issuerSecret}\n`, { mode: 0o600 });
  const secret = await ensureBrokerSecret(env);
  const broker = new CompanionBroker({
    socketPath: env.AOS_CHROME_COMPANION_SOCKET,
    secret,
    issuerSecrets: { codex_mcp: issuerSecret },
    statePath: join(dataDir, "ledger.json"),
  });
  await broker.listen();
  const extension = await connectPeer({ role: "extension-relay", autoStart: false, env });
  const helloAck = onceMessage(extension, (message) => message.kind === "extension.hello_ack");
  extension.send({ kind: "extension.hello", protocolVersion: PROTOCOL_VERSION, profileInstanceId: "profile_reuse", extensionRuntimeId: "runtime_reuse", buildId: INSTALL_BUILD_ID, capabilities: DEFAULT_CAPABILITIES });
  await helloAck;
  const origin = "http://127.0.0.1:8787";
  const liveTabs = new Map();
  const commands = [];
  let nextTabId = 501;
  extension.onMessage((message) => {
    if (message.kind !== "command.request") return;
    commands.push(message);
    let result;
    if (message.method === "tabs.list") result = [...liveTabs.values()];
    else if (message.method === "tabs.create") {
      result = { id: nextTabId++, url: message.params.url, title: "task", groupId: 7 };
      liveTabs.set(result.id, result);
    } else if (message.method === "tabs.groupTask") {
      result = { ...liveTabs.get(message.params.tabId), grouped: true, groupId: 7 };
    } else if (message.method === "tabs.navigate") {
      result = { ...liveTabs.get(message.params.tabId), url: message.params.url };
      liveTabs.set(message.params.tabId, result);
    } else if (message.method === "tabs.close") {
      liveTabs.delete(message.params.tabId);
      result = { closed: true, tabId: message.params.tabId };
    } else if (message.method === "page.snapshot") {
      const tab = liveTabs.get(message.params.tabId);
      result = { url: tab.url, title: tab.title, text: "ready", pageInstanceId: `document-${tab.id}-${tab.url}` };
    } else if (message.method === "visual.inspectTarget") {
      const tab = liveTabs.get(message.params.tabId);
      result = {
        url: tab.url,
        pageInstanceId: `document-${tab.id}-${tab.url}`,
        element: { tag: "select", role: "combobox", name: message.params?.locator?.question ?? message.params?.locator?.text ?? "target", testId: null },
        rect: { x: 10, y: 10, width: 100, height: 30 },
        clippedRect: { x: 10, y: 10, width: 100, height: 30 },
        point: { x: 60, y: 25 },
        viewport: { width: 1200, height: 800, devicePixelRatio: 1 },
      };
    } else if (message.method === "page.inspectDropdown") {
      const tab = liveTabs.get(message.params.tabId);
      result = {
        supported: true,
        kind: "native_select",
        url: tab.url,
        title: tab.title,
        locator: message.params.locator,
        options: [{ label: "Yes", value: "yes" }, { label: "No", value: "no" }],
      };
    } else if (message.method === "page.screenshot") {
      const tab = liveTabs.get(message.params.tabId);
      result = {
        kind: "screenshot",
        dataBase64: Buffer.from("dropdown visual", "utf8").toString("base64"),
        mimeType: "image/jpeg",
        tabId: tab.id,
        url: tab.url,
        title: tab.title,
        capturedAt: new Date().toISOString(),
      };
    } else result = { found: true };
    extension.send({ kind: "command.result", operationId: message.operationId, result });
  });

  const client = await BrokerClient.connect({ autoStart: false, env, issuer: "codex_mcp" });
  const session = await client.request("session.open", { taskId: "task_reuse", label: "Reuse task" });
  const transaction = (runId, idempotencyKey, overrides = {}) => client.requestAuthorizedTransaction({
    sessionId: session.sessionId,
    runId,
    taskId: "task_reuse",
    idempotencyKey,
    targetOrigin: origin,
    startUrl: `${origin}/work`,
    allowedOrigins: [origin],
    actions: [{ method: "page.waitFor", params: { locator: { testId: "ready" }, timeoutMs: 100 } }],
    keepTaskTab: true,
    ...overrides,
  });
  const first = await transaction("run_reuse_1", "idem_reuse_1");
  const groupedExisting = await client.requestGroupTaskTabs({
    sessionId: session.sessionId,
    runId: "run_group_existing",
    taskId: "task_reuse",
    idempotencyKey: "idem_group_existing",
  });
  const second = await transaction("run_reuse_2", "idem_reuse_2");
  assert.equal(first.tab.id, 501);
  assert.equal(first.tab.reused, false);
  assert.equal(second.tab.id, 501);
  assert.equal(second.tab.reused, true);
  const retainedStatus = await client.request("status.get");
  const retainedTabStatus = retainedStatus.taskTabs.find((entry) => entry.tabId === 501);
  assert.equal(retainedTabStatus.retentionReason, "terminal_cleanup_pending");
  assert.match(retainedTabStatus.whyTabWasKept, /terminal/u);
  assert.equal(retainedStatus.activeTaskTabCount, 0);
  assert.equal(retainedStatus.terminalCleanupPendingTaskTabCount, 0);
  assert.equal(commands.filter((command) => command.method === "tabs.create").length, 1);
  assert.deepEqual(groupedExisting.grouped, [{ tabId: 501, groupId: 7 }]);
  assert.equal(commands.filter((command) => command.method === "tabs.groupTask").length, 2);
  assert.equal(commands.find((command) => command.method === "tabs.create").taskId, "task_reuse");
  assert.equal(commands.find((command) => command.method === "tabs.create").taskLabel, "Reuse task");
  assert.equal((await client.request("status.get")).taskTabCount, 1);

  const corrected = await transaction("run_reuse_corrected", "idem_reuse_corrected", {
    startUrl: `${origin}/work/corrected`,
  });
  assert.equal(corrected.tab.id, 501);
  assert.equal(corrected.tab.reused, true);
  assert.equal(commands.filter((command) => command.method === "tabs.create").length, 1);
  assert.equal(commands.some((command) => command.method === "tabs.navigate"
    && command.params.tabId === 501
    && command.params.url === `${origin}/work/corrected`), true);
  const reboundTab = broker.taskTabs.get("profile_reuse:501");
  assert.equal(reboundTab.targetKey, `url:${origin}/work/corrected`);
  assert.equal(reboundTab.targetIdentity.taskId, "task_reuse");
  assert.equal(reboundTab.targetIdentity.sessionId, session.sessionId);
  assert.equal(reboundTab.targetIdentity.leaseId, null);
  assert.equal(reboundTab.targetFingerprint, targetIdentityDigest(broker.ledgerSecret, reboundTab.targetIdentity));

  const dropdownLocator = { role: "combobox", question: "Are you authorized to work in Japan?" };
  const dropdownLease = await client.request("lease.acquire", { sessionId: session.sessionId, tabId: 501 });
  const dropdownInspection = await client.request("dropdown.inspect", {
    sessionId: session.sessionId,
    leaseId: dropdownLease.leaseId,
    tabId: 501,
    locator: dropdownLocator,
  });
  assert.equal(dropdownInspection.kind, "dropdown_visual_confirmation");
  assert.equal(dropdownInspection.visual_readback_verified, true);
  assert.equal(dropdownInspection.visualProof.supported, true);
  const statusDuringInspection = await client.request("status.get");
  assert.equal(statusDuringInspection.logicalSessions[0].ownerTaskId, "task_reuse");
  assert.equal(statusDuringInspection.exactTabLeases[0].ownerTaskId, "task_reuse");
  assert.equal(statusDuringInspection.taskTabs[0].taskId, "task_reuse");
  const dropdownSelected = await transaction("run_dropdown", "idem_dropdown", {
    startUrl: `${origin}/work/corrected`,
    actions: [{
      method: "page.selectOption",
      params: {
        locator: dropdownLocator,
        option: { label: "Yes" },
        visualProof: dropdownInspection.visualProof,
      },
    }],
  });
  assert.equal(dropdownSelected.result, "verified");
  assert.equal(dropdownSelected.actions[0].dropdown_visual_proof_verified, true);
  const selectCommand = commands.find((command) => command.method === "page.selectOption");
  assert.equal(selectCommand.params.locator.question, "Are you authorized to work in Japan?");
  assert.equal(selectCommand.params.option.label, "Yes");
  assert.equal("visualProof" in selectCommand.params, false);

  const dropdownWithoutProof = await transaction("run_dropdown_no_proof", "idem_dropdown_no_proof", {
    startUrl: `${origin}/work/corrected`,
    reuseTaskTab: false,
    keepTaskTab: false,
    actions: [{
      method: "page.selectOption",
      params: { locator: dropdownLocator, option: { label: "Yes" } },
    }],
  });
  assert.equal(dropdownWithoutProof.result, "blocked");
  assert.equal(dropdownWithoutProof.exact_blocker.code, "dropdown_visual_proof_required");

  const statusWithOwners = await client.request("status.get");
  assert.equal(statusWithOwners.logicalSessions[0].ownerTaskId, "task_reuse");
  assert.equal(statusWithOwners.taskTabs[0].taskId, "task_reuse");

  const cleanupDryRun = await client.requestCleanupTaskTabs({
    sessionId: session.sessionId,
    runId: "run_cleanup_ordinary_completed",
    taskId: "task_reuse",
    idempotencyKey: "idem_cleanup_ordinary_completed",
    preserveTabIds: [],
    dryRun: true,
  });
  assert.deepEqual(cleanupDryRun.candidates, [501]);

  const ephemeral = await transaction("run_ephemeral", "idem_ephemeral", { reuseTaskTab: false, keepTaskTab: false });
  assert.equal(ephemeral.tab.id, 503);
  assert.equal(ephemeral.cleanup.closed, true);
  assert.equal(liveTabs.has(502), false);
  assert.equal(liveTabs.has(501), true);

  const otherSession = await client.request("session.open", { taskId: "task_other", label: "Other task" });
  const otherTask = await client.requestAuthorizedTransaction({
    sessionId: otherSession.sessionId,
    runId: "run_other",
    taskId: "task_other",
    idempotencyKey: "idem_other",
    targetOrigin: origin,
    startUrl: `${origin}/other`,
    allowedOrigins: [origin],
    actions: [{ method: "page.waitFor", params: { locator: { testId: "ready" }, timeoutMs: 100 } }],
    keepTaskTab: true,
  });
  assert.equal(otherTask.tab.id, 504);
  const ownerScopedCleanup = await client.requestCleanupTaskTabs({
    sessionId: session.sessionId,
    runId: "run_cleanup_owner_scope",
    taskId: "task_reuse",
    idempotencyKey: "idem_cleanup_owner_scope",
    preserveTabIds: [],
    dryRun: true,
  });
  assert.deepEqual(ownerScopedCleanup.candidates, [501]);
  assert.equal(ownerScopedCleanup.candidates.includes(otherTask.tab.id), false);
  assert.equal(ownerScopedCleanup.preserved.some((entry) => entry.tabId === otherTask.tab.id), false);

  const closedSession = await client.request("session.close", { sessionId: session.sessionId });
  assert.equal(closedSession.closed, true);
  assert.equal(closedSession.task_terminal, true);
  assert.deepEqual(closedSession.terminal_tab_cleanup.closed, [501]);
  assert.equal(liveTabs.has(501), false);
  assert.equal(liveTabs.has(otherTask.tab.id), true);

  const otherClosed = await client.request("session.close", { sessionId: otherSession.sessionId });
  assert.deepEqual(otherClosed.terminal_tab_cleanup.closed, [otherTask.tab.id]);
  assert.equal(liveTabs.has(otherTask.tab.id), false);

  client.close();
  extension.close();
  await broker.close();
  await rm(dataDir, { recursive: true, force: true });
});

test("broker integration enforces capsule target parallelism, lifecycle status, generation quarantine, and no foreign adoption", async () => {
  const harness = await createCapsuleHarness();
  const { broker, client, session, liveTabs, commands } = harness;
  const origin = "https://example.test";
  const tx = (runId, idempotencyKey, capsule, actions = [{ method: "page.waitFor", params: { locator: { testId: "ready" }, timeoutMs: 100 } }], overrides = {}) => client.requestAuthorizedTransaction({
    sessionId: session.sessionId,
    runId,
    taskId: "capsule_task",
    idempotencyKey,
    targetOrigin: origin,
    startUrl: `${origin}/${capsule.targetKey}`,
    allowedOrigins: [origin],
    actions,
    capsule,
    ...overrides,
  });
  try {
    const distinct = await Promise.all([
      tx("run_jobs", "idem_jobs", { workflowType: "Jobs", targetKey: "jobs:1" }, undefined, { keepTaskTab: true }),
      tx("run_aos", "idem_aos", { workflowType: "AOS", targetKey: "aos:1" }, undefined, { keepTaskTab: true }),
      tx("run_heavy", "idem_heavy", { workflowType: "Heavy", targetKey: "heavy:1" }, undefined, { keepTaskTab: true }),
      tx("run_mypro", "idem_mypro", { workflowType: "MyPro", targetKey: "mypro:1" }, undefined, { keepTaskTab: true }),
    ]);
    assert.deepEqual(distinct.map((result) => result.result), ["verified", "verified", "verified", "verified"]);
    assert.equal(new Set(distinct.map((result) => result.tab.id)).size, 4);
    for (const result of distinct) {
      assert.equal(result.capsule.effect.effectState, result.effect_state);
      assert.equal(result.capsule.effect.externalActionExecuted, result.external_action_executed);
      assert.equal(result.capsule.effect.dispatchCount, result.dispatch_count);
    }

    const sameTargetFirst = tx("run_same_1", "idem_same_1", { workflowType: "Jobs", targetKey: "same-target" }, [{ method: "page.waitFor", params: { locator: { testId: "slow" }, timeoutMs: 1_000 } }], { keepTaskTab: true });
    await new Promise((resolve) => setTimeout(resolve, 20));
    await assert.rejects(
      tx("run_same_2", "idem_same_2", { workflowType: "Jobs", targetKey: "same-target" }, undefined, { keepTaskTab: true }),
      (error) => error.code === "target_resource_busy",
    );
    const sameTargetResult = await sameTargetFirst;
    assert.equal(sameTargetResult.result, "verified");
    assert.equal(commands.filter((command) => command.method === "tabs.create" && command.taskId === "capsule_task").length, 4);

    const awaiting = await tx("run_awaiting", "idem_awaiting", {
      workflowType: "AOS",
      targetKey: "awaiting",
      state: "awaiting_user",
      visual: { required: true, proof: "semantic-pre-read" },
      completion: { contract: "AOS.completion.v1" },
      retention: {
        policy: "retain_until_resume",
        userHelpRequired: true,
        reason: "user_security_code_required",
        whyTabWasKept: "The exact page is waiting for the user's one-time security code.",
        requiredUserAction: "Enter the one-time security code in this tab.",
        resumeAction: "fresh_readback_then_resume",
      },
    });
    assert.equal(awaiting.capsule.state, "awaiting_user");
    assert.ok(awaiting.capsule.resumeToken);
    assert.equal(awaiting.cleanup.retained, true);
    const awaitingStatus = await client.requestTaskStatus({ sessionId: session.sessionId, runId: "run_awaiting", taskId: "capsule_task", idempotencyKey: "idem_awaiting" });
    assert.equal(awaitingStatus.state, "awaiting_user");
    assert.equal(awaitingStatus.target.targetKey, "awaiting");
    assert.equal(awaitingStatus.tab.id, awaiting.tab.id);
    assert.equal(awaitingStatus.generation, session.generation);
    assert.ok(awaitingStatus.resume_token);
    assert.equal(awaitingStatus.visual.required, true);
    assert.equal(awaitingStatus.completion.contract, "AOS.completion.v1");
    assert.equal(awaitingStatus.restart_point, "user_resume_token");
    assert.equal(awaitingStatus.tab_retention.user_help_required, true);
    assert.equal(awaitingStatus.tab_retention.retention_reason, "user_security_code_required");
    assert.match(awaitingStatus.tab_retention.why_tab_was_kept, /one-time security code/);
    assert.equal(awaitingStatus.tab_retention.required_user_action, "Enter the one-time security code in this tab.");
    await assert.rejects(
      tx("run_unexplained_wait", "idem_unexplained_wait", { workflowType: "AOS", targetKey: "unexplained", state: "awaiting_user" }),
      (error) => error.code === "awaiting_user_tab_retention_explanation_required",
    );

    const timeoutBefore = commands.length;
    const unknown = await tx("run_unknown", "idem_unknown", { workflowType: "Heavy", targetKey: "unknown" }, [{ method: "page.click", params: { locator: { testId: "timeout" }, timeoutMs: 100 } }]);
    assert.equal(unknown.result, "unknown_effect");
    assert.equal(unknown.capsule.state, "reconciliation_required");
    assert.deepEqual(unknown.action_progress.remaining_action_indices, []);
    assert.deepEqual(unknown.action_progress.uncertain_action_indices, [0]);
    assert.ok(unknown.capsule.resumeToken);
    assert.equal(unknown.cleanup.retained, true);
    const statusBefore = commands.length;
    const unknownStatus = await client.requestTaskStatus({ sessionId: session.sessionId, runId: "run_unknown", taskId: "capsule_task", idempotencyKey: "idem_unknown" });
    assert.equal(unknownStatus.state, "reconciliation_required");
    assert.equal(commands.length, statusBefore);
    assert.equal(timeoutBefore < statusBefore, true);

    const directSubmitUnknown = await tx(
      "run_submit_no_transition",
      "idem_submit_no_transition",
      { workflowType: "Jobs", targetKey: "submit-no-transition" },
      [{ method: "page.submit", params: { locator: { testId: "submit-no-transition" } } }],
    );
    assert.equal(directSubmitUnknown.result, "unknown_effect");
    assert.equal(directSubmitUnknown.exact_blocker.code, "operation_effect_unknown");
    assert.equal(directSubmitUnknown.exact_blocker.details.method, "page.submit");

    const submitClickCommandCountBefore = commands.filter((command) => command.method === "page.click"
      && command.params?.locator?.testId === "submit-no-transition").length;
    const semanticSubmitUnknown = await tx(
      "run_submit_click_no_transition",
      "idem_submit_click_no_transition",
      { workflowType: "Jobs", targetKey: "submit-click-no-transition" },
      [{ method: "page.click", params: { locator: { testId: "submit-no-transition" } } }],
    );
    assert.equal(semanticSubmitUnknown.result, "unknown_effect");
    assert.equal(semanticSubmitUnknown.exact_blocker.code, "operation_effect_unknown");
    assert.equal(semanticSubmitUnknown.exact_blocker.details.method, "page.click");
    assert.deepEqual(semanticSubmitUnknown.continuation, {
      allowed: false,
      reason: "reconciliation_required",
      restart_point: "signed_task_status_readback",
      exact_blocker: "operation_effect_unknown",
    });
    assert.equal(commands.filter((command) => command.method === "page.click"
      && command.params?.locator?.testId === "submit-no-transition").length, submitClickCommandCountBefore + 1);
    const reconciliationTab = liveTabs.get(semanticSubmitUnknown.tab.id);
    liveTabs.set(semanticSubmitUnknown.tab.id, { ...reconciliationTab, text: "Application submitted!" });
    const reconciliationLease = await client.request("lease.acquire", {
      sessionId: session.sessionId,
      tabId: semanticSubmitUnknown.tab.id,
    });
    const reconciliationInspection = await client.requestInspectReconciliation({
      sessionId: session.sessionId,
      leaseId: reconciliationLease.leaseId,
      tabId: semanticSubmitUnknown.tab.id,
      runId: "run_submit_click_no_transition",
      taskId: "capsule_task",
      idempotencyKey: "idem_submit_click_no_transition",
      capsuleId: semanticSubmitUnknown.capsule.capsuleId,
      successQuery: "Application submitted!",
    });
    assert.equal(reconciliationInspection.kind, "reconciliation_visual_confirmation");
    assert.equal(reconciliationInspection.successEvidence.count, 1);
    await assert.rejects(
      client.requestCompleteReconciliation({
        sessionId: session.sessionId,
        leaseId: reconciliationLease.leaseId,
        tabId: semanticSubmitUnknown.tab.id,
        runId: "run_submit_click_no_transition",
        taskId: "capsule_task",
        idempotencyKey: "idem_submit_click_no_transition",
        capsuleId: semanticSubmitUnknown.capsule.capsuleId,
        reconciliationProof: {
          ...reconciliationInspection.reconciliationProof,
          successQuery: "Application accepted!",
        },
      }),
      (error) => error.code === "reconciliation_visual_proof_invalid",
    );
    liveTabs.set(semanticSubmitUnknown.tab.id, {
      ...liveTabs.get(semanticSubmitUnknown.tab.id),
      screenshotVersion: "changed-after-inspection",
    });
    await assert.rejects(
      client.requestCompleteReconciliation({
        sessionId: session.sessionId,
        leaseId: reconciliationLease.leaseId,
        tabId: semanticSubmitUnknown.tab.id,
        runId: "run_submit_click_no_transition",
        taskId: "capsule_task",
        idempotencyKey: "idem_submit_click_no_transition",
        capsuleId: semanticSubmitUnknown.capsule.capsuleId,
        reconciliationProof: reconciliationInspection.reconciliationProof,
      }),
      (error) => error.code === "reconciliation_readback_changed",
    );
    liveTabs.set(semanticSubmitUnknown.tab.id, {
      ...liveTabs.get(semanticSubmitUnknown.tab.id),
      screenshotVersion: "stable",
    });
    const reconciliationCompletion = await client.requestCompleteReconciliation({
      sessionId: session.sessionId,
      leaseId: reconciliationLease.leaseId,
      tabId: semanticSubmitUnknown.tab.id,
      runId: "run_submit_click_no_transition",
      taskId: "capsule_task",
      idempotencyKey: "idem_submit_click_no_transition",
      capsuleId: semanticSubmitUnknown.capsule.capsuleId,
      reconciliationProof: reconciliationInspection.reconciliationProof,
    });
    assert.equal(reconciliationCompletion.status, "completed");
    assert.equal(reconciliationCompletion.terminal_cleanup_ready, true);
    const reconciledStatus = await client.requestTaskStatus({ sessionId: session.sessionId,
      runId: "run_submit_click_no_transition", taskId: "capsule_task", idempotencyKey: "idem_submit_click_no_transition" });
    assert.equal(reconciledStatus.effect_state, "known_effect");
    assert.equal(reconciledStatus.reconciliation_required, false);
    assert.equal(broker.taskLedger.getTaskCapsule(semanticSubmitUnknown.capsule.capsuleId).state, "completed");
    assert.equal(broker.taskTabs.get(`profile_capsule:${semanticSubmitUnknown.tab.id}`).lifecycleState, "completed");
    assert.equal(broker.taskTabs.get(`profile_capsule:${semanticSubmitUnknown.tab.id}`).retentionPolicy, "cleanup");
    await assert.rejects(
      client.requestCompleteReconciliation({
        sessionId: session.sessionId,
        leaseId: reconciliationLease.leaseId,
        tabId: semanticSubmitUnknown.tab.id,
        runId: "run_submit_click_no_transition",
        taskId: "capsule_task",
        idempotencyKey: "idem_submit_click_no_transition",
        capsuleId: semanticSubmitUnknown.capsule.capsuleId,
        reconciliationProof: reconciliationInspection.reconciliationProof,
      }),
      (error) => ["task_reconciliation_state_invalid", "reconciliation_visual_proof_invalid"].includes(error.code),
    );
    await client.request("lease.release", { leaseId: reconciliationLease.leaseId });

    const completed = await tx("run_completed", "idem_completed", { workflowType: "MyPro", targetKey: "completed" });
    assert.equal(completed.capsule.state, "completed");
    assert.equal(completed.cleanup.closed, true);
    assert.equal(liveTabs.has(completed.tab.id), false);

    const retainedGenerationOne = await tx("run_generation_1", "idem_generation_1", { workflowType: "Jobs", targetKey: "generation-target" }, undefined, { keepTaskTab: true });
    const oldTabId = retainedGenerationOne.tab.id;
    const oldGeneration = session.generation;
    const staleReconciliation = await tx(
      "run_stale_reconciliation",
      "idem_stale_reconciliation",
      { workflowType: "Jobs", targetKey: "stale-reconciliation" },
      [{ method: "page.click", params: { locator: { testId: "timeout" }, timeoutMs: 100 } }],
      { keepTaskTab: true, reuseTaskTab: false },
    );
    const staleReconciliationTabId = staleReconciliation.tab.id;
    const staleReconciliationCapsuleId = staleReconciliation.capsule.capsuleId;
    assert.equal(staleReconciliation.result, "unknown_effect");
    assert.equal(staleReconciliation.capsule.state, "reconciliation_required");
    await harness.attachExtension("profile_capsule");
    const afterReconnect = await client.request("status.get");
    assert.equal(afterReconnect.quarantinedTaskTabCount >= 1, true);
    assert.equal(broker.taskTabs.get(`profile_capsule:${oldTabId}`).quarantine, "stale_generation");
    assert.equal(broker.taskTabs.get(`profile_capsule:${staleReconciliationTabId}`).quarantine, "stale_generation");
    const freshSession = await client.request("session.open", { taskId: "capsule_task" });
    const fresh = await client.requestAuthorizedTransaction({
      sessionId: freshSession.sessionId,
      runId: "run_generation_2",
      taskId: "capsule_task",
      idempotencyKey: "idem_generation_2",
      targetOrigin: origin,
      startUrl: `${origin}/generation-target`,
      allowedOrigins: [origin],
      actions: [{ method: "page.waitFor", params: { locator: { testId: "ready" }, timeoutMs: 100 } }],
      capsule: { workflowType: "Jobs", targetKey: "generation-target" },
      keepTaskTab: true,
    });
    assert.notEqual(fresh.tab.id, oldTabId);
    assert.notEqual(fresh.profile.generation, oldGeneration);
    assert.equal(fresh.stale_generation_cleanup.closed.includes(oldTabId), true);
    assert.equal(fresh.stale_generation_cleanup.retained.some((entry) => entry.tab_id === staleReconciliationTabId), true);
    assert.equal(liveTabs.has(oldTabId), false);

    liveTabs.set(staleReconciliationTabId, {
      ...liveTabs.get(staleReconciliationTabId),
      text: "Application submitted!",
    });
    const rebound = await client.requestRebindReconciliation({
      sessionId: freshSession.sessionId,
      runId: "run_stale_reconciliation",
      taskId: "capsule_task",
      idempotencyKey: "idem_stale_reconciliation",
      capsuleId: staleReconciliationCapsuleId,
      tabId: staleReconciliationTabId,
      fromGeneration: oldGeneration,
    });
    assert.equal(rebound.status, "rebound");
    assert.equal(rebound.from_generation, oldGeneration);
    assert.equal(rebound.generation, fresh.profile.generation);
    assert.equal(rebound.external_action_executed, false);
    assert.equal(broker.taskTabs.get(`profile_capsule:${staleReconciliationTabId}`).quarantine, null);
    assert.equal(broker.taskTabs.get(`profile_capsule:${staleReconciliationTabId}`).generation, fresh.profile.generation);
    const reboundStatus = await client.requestTaskStatus({
      sessionId: freshSession.sessionId,
      runId: "run_stale_reconciliation",
      taskId: "capsule_task",
      idempotencyKey: "idem_stale_reconciliation",
      capsuleId: staleReconciliationCapsuleId,
    });
    assert.equal(reboundStatus.generation_matches, true);
    assert.equal(reboundStatus.tab_quarantined, false);
    assert.equal(reboundStatus.resume_disposition, "resume_same_generation");
    assert.equal(reboundStatus.reconciliation_generation_rebind.toGeneration, fresh.profile.generation);
    const reboundInspection = await client.requestInspectReconciliation({
      sessionId: freshSession.sessionId,
      leaseId: rebound.lease.leaseId,
      tabId: staleReconciliationTabId,
      runId: "run_stale_reconciliation",
      taskId: "capsule_task",
      idempotencyKey: "idem_stale_reconciliation",
      capsuleId: staleReconciliationCapsuleId,
      successQuery: "Application submitted!",
    });
    assert.equal(reboundInspection.successEvidence.count, 1);
    const reboundCompletion = await client.requestCompleteReconciliation({
      sessionId: freshSession.sessionId,
      leaseId: rebound.lease.leaseId,
      tabId: staleReconciliationTabId,
      runId: "run_stale_reconciliation",
      taskId: "capsule_task",
      idempotencyKey: "idem_stale_reconciliation",
      capsuleId: staleReconciliationCapsuleId,
      reconciliationProof: reboundInspection.reconciliationProof,
    });
    assert.equal(reboundCompletion.status, "completed");
    assert.equal(reboundCompletion.terminal_cleanup_ready, true);
    await client.request("lease.release", { leaseId: rebound.lease.leaseId });

    const foreignTabId = 19_999;
    liveTabs.set(foreignTabId, { id: foreignTabId, url: `${origin}/foreign`, title: "foreign" });
    const cleanup = await client.requestCleanupTaskTabs({
      sessionId: freshSession.sessionId,
      runId: "run_cleanup_quarantine",
      taskId: "capsule_task",
      idempotencyKey: "idem_cleanup_quarantine",
      preserveTabIds: [fresh.tab.id],
      dryRun: false,
    });
    assert.equal(liveTabs.has(oldTabId), false);
    assert.equal(liveTabs.has(fresh.tab.id), true);
    assert.equal(liveTabs.has(foreignTabId), true);
    assert.equal(cleanup.preserved.some((entry) => entry.reasons.includes("lifecycle:awaiting_user")), true);
    assert.equal(cleanup.preserved.some((entry) => entry.reasons.includes("lifecycle:reconciliation_required")), true);
    const foreign = await client.requestAuthorizedTransaction({
      sessionId: freshSession.sessionId,
      runId: "run_foreign",
      taskId: "capsule_task",
      idempotencyKey: "idem_foreign",
      targetOrigin: origin,
      startUrl: `${origin}/foreign`,
      allowedOrigins: [origin],
      actions: [{ method: "page.waitFor", params: { locator: { testId: "ready" }, timeoutMs: 100 } }],
      capsule: { workflowType: "AOS", targetKey: "foreign" },
    });
    assert.notEqual(foreign.tab.id, foreignTabId);
    assert.equal(liveTabs.has(foreignTabId), true);
  } finally {
    await harness.close();
  }
});

test("pre-dispatch semantic inspection timeout does not inherit setup mutation effect", async () => {
  const harness = await createCapsuleHarness({ failVisualInspectionFor: "preflight-timeout" });
  const { broker, client, session, liveTabs, commands } = harness;
  const origin = "https://example.test";
  try {
    const result = await client.requestAuthorizedTransaction({
      sessionId: session.sessionId,
      runId: "run_preflight_timeout",
      taskId: "capsule_task",
      idempotencyKey: "idem_preflight_timeout",
      targetOrigin: origin,
      startUrl: `${origin}/preflight-timeout`,
      allowedOrigins: [origin],
      actions: [{ method: "page.click", params: { locator: { testId: "preflight-timeout" } } }],
      requireCapabilityHandshake: true,
      capsule: { workflowType: "Jobs", targetKey: "preflight-timeout" },
    });

    assert.equal(result.result, "blocked");
    assert.equal(result.exact_blocker.code, "operation_timeout");
    assert.equal(result.exact_blocker.details.method, "visual.inspectTarget");
    assert.equal(result.capsule.state, "failed");
    assert.equal(result.effect_state, "no_dispatch");
    assert.equal(result.dispatch_count, 0);
    assert.equal(result.external_action_executed, false);
    assert.equal(result.capsule.effect.effectState, "no_dispatch");
    assert.equal(result.capsule.effect.dispatchCount, 0);
    assert.equal(result.capsule.effect.externalActionExecuted, false);
    assert.equal(result.cleanup.closed, true);
    assert.equal(result.reconciliation, undefined);
    assert.equal(commands.some((command) => command.method === "page.click"), false);
    assert.equal(commands.some((command) => command.method === "page.submit"), false);
    assert.equal(liveTabs.has(result.tab.id), false);
    assert.equal(broker.taskTabs.has(`profile_capsule:${result.tab.id}`), false);
  } finally {
    await harness.close();
  }
});

test("owner-signed repair clears only a proven pre-dispatch visual false positive", async () => {
  const harness = await createCapsuleHarness();
  const { broker, client, session, liveTabs, commands } = harness;
  const origin = "https://example.test";
  const tabId = 10001;
  const runId = "run_repair_pre_dispatch";
  const idempotencyKey = "idem_repair_pre_dispatch";
  const capsuleId = "capsule_repair_pre_dispatch";
  try {
    liveTabs.set(tabId, { id: tabId, url: `${origin}/repair-pre-dispatch`, title: "repair target", groupId: 77 });
    const capsule = normalizeTaskExecutionCapsule({
      capsuleId,
      taskId: "capsule_task",
      runId,
      workflowType: "Jobs",
      targetKey: `url:${origin}/repair-pre-dispatch`,
      allowedOrigins: [origin],
      profileInstanceId: session.profileInstanceId,
      generation: session.generation,
      state: "reconciliation_required",
      blocker: { code: "operation_timeout", message: "synthetic visual inspection timeout", details: { method: "visual.inspectTarget", timeoutMs: 30_000 } },
      retention: { policy: "retain_until_resume", resumeToken: "resume-repair" },
      effect: { effectClass: "read_only_or_authorized", authoritySource: "signed_authority", idempotencyKey, unknownEffectPolicy: "reconcile_before_retry" },
      resources: { tabId },
    });
    await broker.taskLedger.putTaskCapsule(capsule);
    await broker.taskLedger.recordTaskTab({
      profileInstanceId: session.profileInstanceId,
      generation: session.generation,
      tabId,
      taskId: "capsule_task",
      runId,
      sessionId: "old-session",
      targetKey: capsule.target.targetKey,
      lifecycleState: "reconciliation_required",
      retentionPolicy: "retain_until_resume",
      resumeToken: "resume-repair",
      userHelpRequired: false,
    });
    broker.taskTabs.set(`profile_capsule:${tabId}`, broker.taskLedger.getTaskTab(session.profileInstanceId, tabId));

    const repaired = await client.requestRepairPreDispatchReadonly({
      sessionId: session.sessionId,
      runId,
      taskId: "capsule_task",
      idempotencyKey,
      capsuleId,
      profileInstanceId: session.profileInstanceId,
      tabId,
      confirmNoEffect: true,
    });
    assert.equal(repaired.status, "reclassified_pre_dispatch_failure");
    assert.equal(repaired.capsule.state, "failed");
    assert.equal(repaired.taskTab.lifecycleState, "failed");
    assert.equal(repaired.taskTab.retentionPolicy, "cleanup");
    assert.equal(repaired.mutationDispatchAttempted, false);
    assert.equal(repaired.externalActionExecuted, false);
    assert.equal(repaired.terminalCleanupReady, true);
    assert.equal(liveTabs.has(tabId), true);
    assert.equal(commands.filter((command) => ["page.click", "page.selectText", "visual.inspectTarget"].includes(command.method)).length, 0);
  } finally {
    await harness.close();
  }
});


test("a successful edit survives a later pre-dispatch failure in both receipt and capsule", async () => {
  const harness = await createCapsuleHarness({ failVisualInspectionFor: "later-failure" });
  const { client, session, commands, liveTabs } = harness;
  try {
    const result = await client.requestAuthorizedTransaction({
      sessionId: session.sessionId, runId: "run_partial_edit", taskId: "capsule_task",
      idempotencyKey: "idem_partial_edit", targetOrigin: "https://example.test",
      startUrl: "https://example.test/editor", allowedOrigins: ["https://example.test"],
      actions: [
        { method: "page.type", params: { locator: { testId: "editor" }, text: "new text", clear: true } },
        { method: "page.click", params: { locator: { testId: "later-failure" } } },
      ],
    });
    assert.equal(result.result, "blocked");
    assert.equal(result.effect_state, "known_effect");
    assert.equal(result.failed_step.effect_state, "no_dispatch");
    assert.equal(result.completed_mutation_count, 1);
    assert.deepEqual(result.action_progress.remaining_action_indices, [1]);
    assert.deepEqual(result.action_progress.applied_action_indices, [0]);
    assert.deepEqual(result.capsule.effect.actionProgress, result.action_progress);
    const resumed = await client.requestPrepareResume({ sessionId: session.sessionId, taskId: "capsule_task", runId: "run_partial_edit", capsuleId: result.capsule.capsuleId });
    assert.equal(resumed.resume_ready, true);
    assert.deepEqual(resumed.action_progress.remaining_action_indices, [1]);
    assert.equal(resumed.target_reservation.arguments.tabId, result.tab.id);
    assert.equal(resumed.replay_allowed, false);
    assert.equal(liveTabs.get(result.tab.id).text, "new text");
    assert.equal(result.dispatch_count, 1);
    assert.equal(result.capsule.effect.effectState, "known_effect");
    assert.equal(result.capsule.effect.externalActionExecuted, true);
    assert.equal(result.cleanup.retained, true);
    assert.equal(liveTabs.has(result.tab.id), true);
    assert.equal(commands.filter(command => command.method === "page.type").length, 1);
    assert.equal(commands.filter(command => command.method === "page.click").length, 0);
    const checkpoint = join(harness.dataDir, "resume-copy.json");
    await copyFile(harness.broker.taskLedger.statePath, checkpoint);
    await copyFile(`${harness.broker.taskLedger.statePath}.journal`, `${checkpoint}.journal`);
    const restored = new TaskOperationLedger({ statePath: checkpoint, secret: harness.broker.ledgerSecret });
    await restored.ready();
    assert.deepEqual(restored.getTaskCapsule(result.capsule.capsuleId).effect.actionProgress, result.action_progress);
    restored.close();
    const targetKey = `${session.profileInstanceId}:${result.tab.id}`;
    const target = harness.broker.taskTabs.get(targetKey);
    harness.broker.taskTabs.set(`${session.profileInstanceId}:99999`, { ...target, tabId: 99999 });
    const exact = await client.requestPrepareResume({ sessionId: session.sessionId, taskId: "capsule_task", runId: "run_partial_edit", capsuleId: result.capsule.capsuleId });
    assert.equal(exact.target_reservation.arguments.tabId, result.tab.id);
    harness.broker.taskTabs.delete(targetKey);
    const missing = await client.requestPrepareResume({ sessionId: session.sessionId, taskId: "capsule_task", runId: "run_partial_edit", capsuleId: result.capsule.capsuleId });
    assert.equal(missing.exact_blocker.code, "resume_target_missing");
    assert.equal(missing.target_reservation, null);
    harness.broker.taskTabs.set(targetKey, { ...target, quarantine: "stale_generation" });
    const stale = await client.requestPrepareResume({ sessionId: session.sessionId, taskId: "capsule_task", runId: "run_partial_edit", capsuleId: result.capsule.capsuleId });
    assert.equal(stale.exact_blocker.code, "resume_target_generation_stale");
    assert.equal(stale.target_reservation, null);
    harness.broker.taskTabs.set(targetKey, target);
    harness.broker.taskTabs.delete(`${session.profileInstanceId}:99999`);
    harness.resolveVisualFailure();
    const closedOwner = await client.request("session.close", { sessionId: session.sessionId });
    assert.equal(liveTabs.has(result.tab.id), true);
    assert.deepEqual(closedOwner.cleanup_receipt.closed, []);
    assert.equal(closedOwner.cleanup_receipt.retained[0].retention_reason, "partial_actions_applied");
    Object.assign(session, await client.request("session.open", { taskId: "capsule_task", profileInstanceId: session.profileInstanceId }));
    client.peer.close();
    Object.assign(session, await client.recoverOwnedSession({ sessionId: session.sessionId, taskId: "capsule_task" }));
    const reconnected = await client.requestPrepareResume({ sessionId: session.sessionId, taskId: "capsule_task", runId: "run_partial_edit", capsuleId: result.capsule.capsuleId });
    assert.equal(reconnected.resume_ready, true);
    assert.equal(reconnected.target_reservation.arguments.tabId, result.tab.id);
    assert.equal(harness.broker.taskTabs.get(targetKey).retentionPolicy, "retain_until_resume");
    const reserved = await client.request("lease.acquire", reconnected.target_reservation.arguments);
    const readback = await client.request("operation.execute", { sessionId: session.sessionId, leaseId: reserved.leaseId, method: "page.snapshot", params: { tabId: result.tab.id } });
    assert.equal(readback.text, "new text");
    await client.request("lease.release", { leaseId: reserved.leaseId });
    const continued = await client.requestAuthorizedTransaction({
      sessionId: session.sessionId, runId: "run_partial_edit", taskId: "capsule_task",
      idempotencyKey: "idem_partial_remaining", targetOrigin: "https://example.test",
      startUrl: "https://example.test/editor", allowedOrigins: ["https://example.test"],
      actions: [{ method: "page.click", params: { locator: { testId: "later-failure" } } }],
    });
    assert.equal(continued.result, "verified");
    assert.equal(continued.tab.id, result.tab.id);
    assert.equal(commands.filter(command => command.method === "page.type").length, 1);
    assert.equal(commands.filter(command => command.method === "page.click").length, 1);
  } finally { await harness.close(); }
});


test("post-dispatch readback failure preserves an applied edit even without an action receipt", async () => {
  const harness = await createCapsuleHarness({ failPostTypeReadback: true });
  const { client, session, liveTabs } = harness;
  try {
    const result = await client.requestAuthorizedTransaction({
      sessionId: session.sessionId, runId: "run_post_edit_readback", taskId: "capsule_task",
      idempotencyKey: "idem_post_edit_readback", targetOrigin: "https://example.test",
      startUrl: "https://example.test/editor", allowedOrigins: ["https://example.test"],
      actions: [{ method: "page.type", params: { locator: { testId: "editor" }, text: "retained edit", clear: true } }],
    });
    assert.equal(liveTabs.get(result.tab.id).text, "retained edit");
    assert.equal(result.actions.length, 0);
    assert.equal(result.applied_actions.length, 1);
    assert.deepEqual(result.action_progress.applied_action_indices, [0]);
    assert.deepEqual(result.action_progress.verified_action_indices, []);
    assert.deepEqual(result.action_progress.remaining_action_indices, []);
    assert.equal(result.effect_state, "known_effect");
    assert.equal(result.capsule.effect.effectState, "known_effect");
    assert.equal(result.dispatch_count, 1);
    assert.equal(result.cleanup.retained, true);
  } finally { await harness.close(); }
});

test("a delayed submit transition and transient capture recover with one click", async () => {
  const harness = await createCapsuleHarness({ postCaptureBehavior: "transient" });
  const { client, session, commands } = harness;
  try {
    const result = await client.requestAuthorizedTransaction({
      sessionId: session.sessionId, runId: "run_delayed_submit", taskId: "capsule_task",
      idempotencyKey: "idem_delayed_submit", targetOrigin: "https://example.test",
      startUrl: "https://example.test/apply", allowedOrigins: ["https://example.test"], keepTaskTab: true,
      actions: [{ method: "page.click", params: { locator: { testId: "submit-delayed" } } }],
    });
    assert.equal(result.result, "verified");
    assert.equal(result.post.url, "https://example.test/received");
    assert.equal(result.visual_readback.url, result.post.url);
    assert.equal(result.visual_readback_attempts, 2);
    assert.equal(result.actions[0].submission_readback.transition_observed, true);
    assert.ok(result.actions[0].submission_readback.read_attempts >= 2);
    assert.equal(result.outcome.provider_completion, "unverified");
    assert.equal(result.outcome.visual_readback, "verified");
    assert.equal(commands.filter(command => command.method === "page.click").length, 1);
  } finally { await harness.close(); }
});

test("a permanent capture failure retains the completed edit and only requests readback", async () => {
  const harness = await createCapsuleHarness({ postCaptureBehavior: "permanent" });
  const { client, session, commands, liveTabs } = harness;
  try {
    const result = await client.requestAuthorizedTransaction({
      sessionId: session.sessionId, runId: "run_capture_failure", taskId: "capsule_task",
      idempotencyKey: "idem_capture_failure", targetOrigin: "https://example.test",
      startUrl: "https://example.test/editor", allowedOrigins: ["https://example.test"],
      actions: [{ method: "page.type", params: { locator: { testId: "editor" }, text: "Retain this edit", clear: true } }],
    });
    assert.equal(result.result, "blocked");
    assert.equal(result.effect_state, "known_effect");
    assert.equal(result.outcome.visual_readback, "unavailable");
    assert.equal(result.outcome.provider_completion, "unverified");
    assert.equal(result.outcome.next_action, "read_same_target_then_continue_remaining_actions");
    assert.deepEqual(result.outcome.remaining_action_indices, []);
    assert.equal(result.cleanup.retained, true);
    assert.equal(liveTabs.get(result.tab.id).text, "Retain this edit");
    assert.equal(commands.filter(command => command.method === "page.type").length, 1);
  } finally { await harness.close(); }
});

test("a valid inspected final click survives visual readback failure without replay", async () => {
  const harness = await createCapsuleHarness({ postCaptureBehavior: "permanent", semanticGuards: true });
  const { broker, client, session, commands, liveTabs } = harness;
  const request = {
    sessionId: session.sessionId, runId: "run_final_click_readback", taskId: "capsule_task",
    idempotencyKey: "idem_final_click_readback", targetOrigin: "https://example.test",
    startUrl: "https://example.test/apply", allowedOrigins: ["https://example.test"], keepTaskTab: true,
    actions: [{ method: "page.click", params: { locator: { testId: "submit-delayed" } } }],
  };
  try {
    const first = await client.requestAuthorizedTransaction(request);
    assert.equal(first.result, "blocked");
    assert.equal(first.effect_state, "known_effect");
    assert.equal(first.dispatch_count, 1);
    assert.equal(first.external_action_executed, true);
    assert.equal(first.outcome.visual_readback, "unavailable");
    assert.equal(first.outcome.provider_completion, "unverified");
    assert.equal(first.capsule.state, "failed");
    assert.equal(first.cleanup.retained, true);
    assert.equal(first.capsule.effect.effectState, "known_effect");
    assert.equal(first.capsule.effect.dispatchCount, 1);
    assert.equal(broker.taskLedger.getTaskCapsule(first.capsule.capsuleId).effect.dispatchCount, 1);
    assert.equal(commands.filter((command) => command.method === "visual.inspectTarget").length, 1);
    assert.equal(commands.filter((command) => command.method === "page.click").length, 1);
    assert.equal(commands.filter((command) => command.method === "page.submit").length, 0);
    assert.equal(liveTabs.get(first.tab.id).submitted, true);

    const second = await client.requestAuthorizedTransaction(request);
    assert.equal(second.result, "blocked");
    assert.equal(commands.filter((command) => command.method === "page.click").length, 1);
    assert.equal(commands.filter((command) => command.method === "page.submit").length, 0);
    assert.equal(broker.taskLedger.getTaskCapsule(first.capsule.capsuleId).effect.dispatchCount, 1);
    assert.equal(liveTabs.get(first.tab.id).submitted, true);
  } finally { await harness.close(); }
});

test("signed reconciliation clears the exact operation and preserves remaining work across restart", async () => {
  const harness = await createCapsuleHarness();
  const { client, session, broker, commands, liveTabs } = harness;
  try {
    const result = await client.requestAuthorizedTransaction({ sessionId: session.sessionId,
      taskId: "capsule_task", runId: "reconcile_remaining", idempotencyKey: "reconcile_remaining",
      startUrl: "https://example.test/apply", allowedOrigins: ["https://example.test"],
      actions: [{ method: "page.click", params: { locator: { testId: "timeout" } } },
        { method: "page.type", params: { locator: { testId: "editor" }, text: "remaining action" } }],
    });
    assert.equal(result.result, "unknown_effect");
    assert.deepEqual(result.action_progress.remaining_action_indices, [1]);
    const unresolvedKey = broker.taskLedger.listOperations().find(entry => entry.binding?.runId === "reconcile_remaining" && entry.state === "unknown_effect").idempotencyKey;
    const foreignBinding = { taskId: "other_task", runId: "reconcile_remaining", tabId: result.tab.id, profileInstanceId: session.profileInstanceId };
    await broker.taskLedger.prepare({ idempotencyKey: "reconcile_remaining:999", binding: foreignBinding, fingerprint: "foreign" });
    await broker.taskLedger.transition("reconcile_remaining:999", "dispatched");
    await broker.taskLedger.transition("reconcile_remaining:999", "unknown_effect");
    liveTabs.set(result.tab.id, { ...liveTabs.get(result.tab.id), text: "Application submitted!" });
    const lease = await client.request("lease.acquire", { sessionId: session.sessionId, tabId: result.tab.id });
    const binding = { sessionId: session.sessionId, leaseId: lease.leaseId, tabId: result.tab.id,
      taskId: "capsule_task", runId: "reconcile_remaining", idempotencyKey: "reconcile_remaining", capsuleId: result.capsule.capsuleId };
    const inspection = await client.requestInspectReconciliation({ ...binding, successQuery: "Application submitted!" });
    const completion = await client.requestCompleteReconciliation({ ...binding, reconciliationProof: inspection.reconciliationProof });
    assert.equal(completion.status, "ready_to_resume");
    assert.equal(completion.terminal_cleanup_ready, false);
    assert.deepEqual(completion.action_progress.remaining_action_indices, [1]);
    assert.deepEqual(completion.action_progress.uncertain_action_indices, []);
    assert.equal(broker.taskLedger.get(unresolvedKey).effectState, "known_effect");
    assert.equal(broker.taskLedger.get("reconcile_remaining:999").effectState, "unknown_effect");
    const resumed = await client.requestPrepareResume({ sessionId: session.sessionId, taskId: "capsule_task",
      runId: "reconcile_remaining", capsuleId: result.capsule.capsuleId });
    assert.equal(resumed.resume_ready, true);
    assert.deepEqual(resumed.action_progress.remaining_action_indices, [1]);
    assert.equal(resumed.unresolved_operation_count, 0);
    const status = await client.requestTaskStatus({ sessionId: session.sessionId, taskId: "capsule_task",
      runId: "reconcile_remaining", capsuleId: result.capsule.capsuleId });
    assert.equal(status.effect_state, "known_effect");
    assert.equal(status.tab_retention.retained, true);
    const checkpoint = join(harness.dataDir, "reconciled-copy.json");
    await copyFile(broker.taskLedger.statePath, checkpoint);
    await copyFile(`${broker.taskLedger.statePath}.journal`, `${checkpoint}.journal`);
    const restored = new TaskOperationLedger({ statePath: checkpoint, secret: broker.ledgerSecret });
    await restored.ready();
    assert.equal(restored.get(unresolvedKey).effectState, "known_effect");
    assert.equal(restored.getTaskCapsule(result.capsule.capsuleId).effect.effectState, "known_effect");
    restored.close();
    assert.equal(commands.filter(command => command.method === "page.click").length, 1);
    assert.equal(commands.filter(command => command.method === "page.type").length, 0);
  } finally { await harness.close(); }
});


test("reusing an equivalent canonical URL preserves the document without navigation", async () => {
  const harness = await createCapsuleHarness();
  const { client, session, liveTabs, commands } = harness;
  const base = { sessionId: session.sessionId, taskId: "capsule_task", runId: "run_canonical_url", targetOrigin: "https://example.test", startUrl: "https://example.test", allowedOrigins: ["https://example.test"], keepTaskTab: true };
  try {
    const first = await client.requestAuthorizedTransaction({ ...base, idempotencyKey: "idem_canonical_edit", actions: [{ method: "page.type", params: { locator: { testId: "editor" }, text: "keep this edit", clear: true } }] });
    const tab = liveTabs.get(first.tab.id);
    liveTabs.set(tab.id, { ...tab, url: new URL(tab.url).href });
    const next = await client.requestAuthorizedTransaction({ ...base, idempotencyKey: "idem_canonical_reuse", actions: [{ method: "page.query", params: { query: "keep this edit" } }] });
    assert.equal(next.result, "verified");
    assert.equal(next.tab.reused, true);
    assert.equal(next.tab.id, tab.id);
    assert.equal(next.actions[0].result.count, 1);
    assert.equal(commands.filter(command => command.method === "tabs.navigate").length, 0);
  } finally { await harness.close(); }
});

test("explicit transaction tab preserves SPA state and never reloads its startUrl", async () => {
  const harness = await createCapsuleHarness();
  const { client, session, liveTabs, commands } = harness;
  const base = { sessionId: session.sessionId, taskId: "capsule_task", runId: "run_spa_continue", targetOrigin: "https://example.test", startUrl: "https://example.test/editor", allowedOrigins: ["https://example.test"], keepTaskTab: true };
  try {
    const first = await client.requestAuthorizedTransaction({ ...base, idempotencyKey: "idem_spa_edit", actions: [{ method: "page.type", params: { locator: { testId: "editor" }, text: "入力を保持 👩🏽‍💻", clear: true } }] });
    const tab = liveTabs.get(first.tab.id);
    tab.url = "https://example.test/editor/next#detail";
    const next = await client.requestAuthorizedTransaction({ ...base, tabId: tab.id, idempotencyKey: "idem_spa_continue", actions: [{ method: "page.query", params: { query: "入力を保持" } }] });
    assert.equal(next.result, "verified");
    assert.equal(next.tab.id, tab.id);
    assert.equal(next.actions[0].result.count, 1);
    assert.equal(liveTabs.get(tab.id).text, "入力を保持 👩🏽‍💻");
    assert.equal(liveTabs.get(tab.id).url, "https://example.test/editor/next#detail");
    assert.equal(commands.filter(command => command.method === "tabs.navigate").length, 0);
    assert.equal(commands.filter(command => command.method === "tabs.create").length, 1);
    const beforeInvalid = commands.length;
    const missing = await client.requestAuthorizedTransaction({ ...base, tabId: 9999, idempotencyKey: "idem_missing_tab", actions: [{ method: "page.query", params: { query: "ready" } }] });
    assert.equal(missing.result, "blocked");
    assert.equal(missing.exact_blocker.code, "task_target_unavailable");
    assert.ok(commands.slice(beforeInvalid).every(command => command.method === "tabs.list"));
  } finally { await harness.close(); }
});


test("upload preparation failures do not create a reconciliation gate", async () => {
  const harness = await createCapsuleHarness();
  const { client, session, broker } = harness;
  try {
    const result = await client.requestAuthorizedTransaction({ sessionId: session.sessionId,
      taskId: "capsule_task", runId: "upload-preparation", idempotencyKey: "upload-preparation",
      startUrl: "https://example.test/upload", allowedOrigins: ["https://example.test"], keepTaskTab: true,
      actions: [{ method: "page.upload", params: { locator: { label: "File" }, file: {
        name: "test.txt", mimeType: "text/plain", dataBase64: Buffer.from("fixture").toString("base64"), size: 7 } } }] });
    assert.equal(result.result, "blocked");
    assert.equal(result.exact_blocker.code, "semantic_locator_ambiguous");
    assert.deepEqual(result.action_progress.remaining_action_indices, [0]);
    assert.equal(result.action_progress.fresh_target_readback_required, true);
    assert.equal(result.effect_state, "known_no_effect");
    assert.equal(result.external_action_executed, false);
    assert.equal(broker.snapshot().reconciliationPendingActiveCount, 0);
    assert.equal(result.capsule.state, "failed");
  } finally { await harness.close(); }
});

test("signed local fixture retirement accepts an ordinary owner task and preserves foreign resources", async () => {
  const harness = await createCapsuleHarness();
  const { client, session, broker, liveTabs, commands } = harness;
  try {
    for (const [tabId, taskId, url] of [[11901, "capsule_task", "http://127.0.0.1:8123/"], [11902, "foreign_task", "http://127.0.0.1:8123/"], [11903, "capsule_task", "https://provider.test/"]]) {
      liveTabs.set(tabId, { id: tabId, url, active: false, pinned: false, windowId: 1 });
      const entry = await broker.taskLedger.recordTaskTab({ profileInstanceId: session.profileInstanceId, generation: session.generation,
        tabId, taskId, runId: "fixture-run", sessionId: "finished-owner", lifecycleState: "reconciliation_required",
        retentionPolicy: "retain_until_resume", userHelpRequired: false });
      broker.taskTabs.set(`${session.profileInstanceId}:${tabId}`, entry);
    }
    const request = tabId => client.requestRetireLocalCanary({ sessionId: session.sessionId,
      taskId: "capsule_task", runId: "fixture-run", profileInstanceId: session.profileInstanceId,
      tabId, idempotencyKey: "retire-" + tabId, confirmSyntheticCanary: true });
    await assert.rejects(request(11902), { code: "task_id_mismatch" });
    await assert.rejects(request(11903), { code: "synthetic_canary_target_invalid" });
    assert.equal((await request(11901)).retired, true);
    assert.deepEqual(commands.filter(c => c.method === "tabs.close").map(c => c.params.tabId), [11901]);
    assert.equal(liveTabs.has(11902), true); assert.equal(liveTabs.has(11903), true);
  } finally { await harness.close(); }
});

test("continuous observation rejects foreign task tabs before dispatch and session close notifies the matching extension", async () => {
  const harness = await createCapsuleHarness();
  const { client, session, broker, liveTabs, commands } = harness;
  try {
    for (const [tabId, taskId] of [[11910, session.taskId], [11911, "foreign_task"]]) {
      liveTabs.set(tabId, { id: tabId, url: "https://example.test/", active: false, pinned: false });
      const entry = await broker.taskLedger.recordTaskTab({ profileInstanceId: session.profileInstanceId, generation: session.generation,
        tabId, taskId, runId: "observation-run", sessionId: session.sessionId, lifecycleState: "active", retentionPolicy: "retain" });
      broker.taskTabs.set(`${session.profileInstanceId}:${tabId}`, entry);
      const lease = await client.request("lease.acquire", { sessionId: session.sessionId, tabId });
      const read = () => client.request("operation.execute", { sessionId: session.sessionId, leaseId: lease.leaseId, method: "page.observe", params: { tabId, action: "start", sessionId: "forged-session", generation: "forged-generation" } });
      if (taskId === session.taskId) await read();
      else await assert.rejects(read(), { code: "task_tab_ownership_required" });
    }
    const observed = commands.filter(command => command.method === "page.observe");
    assert.equal(observed.length, 1); assert.equal(observed[0].params.tabId, 11910);
    assert.equal(observed[0].sessionId, session.sessionId); assert.equal(observed[0].generation, session.generation);
    const notice = onceMessage(harness.extensionPeer, message => message.kind === "session.closed" && message.sessionId === session.sessionId);
    await client.request("session.close", { sessionId: session.sessionId, taskTerminal: false });
    const closed = await notice;
    assert.equal(closed.profileInstanceId, session.profileInstanceId); assert.equal(closed.generation, session.generation);
    assert.equal(liveTabs.has(11911), true);
  } finally { await harness.close(); }
});

for (const method of ['page.upload', 'page.uploadMultiple']) test(method + ' completes from a newly visible attachment confirmation after the input is consumed', async () => {
  const harness = await createCapsuleHarness({ uploadBehavior: 'accepted' });
  try {
    const file = { name: 'test.txt', mimeType: 'text/plain', dataBase64: Buffer.from('fixture').toString('base64'), size: 7 };
    const result = await harness.client.requestAuthorizedTransaction({ sessionId: harness.session.sessionId,
      taskId: 'capsule_task', runId: 'upload-site-confirmation', idempotencyKey: 'upload-site-confirmation',
      startUrl: 'https://example.test/upload', allowedOrigins: ['https://example.test'], keepTaskTab: true,
      actions: [{ method, params: { locator: { label: 'File' }, ...(method === 'page.upload' ? { file } : { files: [file] }),
        confirmationLocator: { testId: 'upload-ready' }, confirmationTimeoutMs: 700 } }] });
    assert.equal(result.result, 'verified', JSON.stringify(result.exact_blocker));
    assert.equal(result.actions[0].result.uploadReadbackMethod, 'site_confirmation');
    assert.equal(result.actions[0].result.siteConfirmationVerified, true);
    assert.equal(result.actions[0].result.uploadControlReadbackVerified, false);
    assert.equal(result.actions[0].upload_readback_verified, true);
    assert.equal(harness.commands.filter(c => c.method === method).length, 1);
    assert.equal(harness.commands.find(c => c.method === method).params.allowInputReset, true);
    assert.equal(harness.commands.find(c => c.method === 'page.waitFor').params.timeoutMs, 700);
  } finally { await harness.close(); }
});

test('an existing attachment confirmation cannot certify a new upload', async () => {
  const harness = await createCapsuleHarness({ uploadBehavior: 'already-present' });
  try {
    const result = await harness.client.requestAuthorizedTransaction({ sessionId: harness.session.sessionId,
      taskId: 'capsule_task', runId: 'upload-stale-confirmation', idempotencyKey: 'upload-stale-confirmation',
      startUrl: 'https://example.test/upload', allowedOrigins: ['https://example.test'], keepTaskTab: true,
      actions: [{ method: 'page.upload', params: { locator: { label: 'File' }, file: { name: 'test.txt', mimeType: 'text/plain', dataBase64: 'Zml4dHVyZQ==', size: 7 }, confirmationLocator: { testId: 'upload-ready' } } }] });
    assert.equal(result.result, 'blocked');
    assert.equal(result.exact_blocker.code, 'upload_confirmation_already_present');
    assert.equal(result.effect_state, 'known_no_effect');
    assert.equal(harness.commands.filter(c => c.method === 'page.upload').length, 0);
  } finally { await harness.close(); }
});

test('a missing site confirmation preserves the delivered upload and is never re-dispatched', async () => {
  const harness = await createCapsuleHarness({ uploadBehavior: 'pending' });
  try {
    const request = { sessionId: harness.session.sessionId,
      taskId: 'capsule_task', runId: 'upload-pending-confirmation', idempotencyKey: 'upload-pending-confirmation',
      startUrl: 'https://example.test/upload', allowedOrigins: ['https://example.test'], keepTaskTab: true,
      actions: [{ method: 'page.upload', params: { locator: { label: 'File' }, file: { name: 'test.txt', mimeType: 'text/plain', dataBase64: 'Zml4dHVyZQ==', size: 7 }, confirmationLocator: { testId: 'upload-ready' } } }] };
    const result = await harness.client.requestAuthorizedTransaction(request);
    assert.equal(result.result, 'unknown_effect');
    assert.equal(result.exact_blocker.code, 'upload_confirmation_not_observed');
    assert.equal(result.effect_state, 'unknown_effect');
    assert.equal(result.capsule.state, 'reconciliation_required');
    assert.equal(result.applied_actions.length, 1);
    await harness.client.requestAuthorizedTransaction(request).catch(() => {});
    assert.equal(harness.commands.filter(c => c.method === 'page.upload').length, 1);
  } finally { await harness.close(); }
});

test('read URLs uses the actual signed broker receipt and closes only its temporary pages', async () => {
  const { readUrls } = await import('../src/mcp/read-urls.mjs');
  const harness = await createCapsuleHarness();
  try {
    harness.liveTabs.set(99, { id: 99, url: 'https://example.test/user', title: 'User tab' });
    const result = await readUrls(harness.client, { sessionId: harness.session.sessionId,
      taskId: harness.session.taskId, runId: 'read-urls', idempotencyKey: 'read-urls',
      urls: ['https://example.test/one', 'https://example.test/two', 'https://example.test/one'] });
    assert.deepEqual(result.rows.map(row => row.status), ['read', 'read', 'read']);
    assert.deepEqual(result.rows.map(row => row.text), ['ready', 'ready', 'ready']);
    assert.equal(result.cleanupComplete, true);
    assert.deepEqual([...harness.liveTabs.keys()], [99]);
    assert.equal(harness.commands.filter(command => command.method === 'tabs.create').length, 2);
    assert.equal(harness.commands.filter(command => command.method === 'tabs.close').length, 2);
    assert.equal(harness.commands.filter(command => command.method === 'page.click' || command.method === 'page.submit').length, 0);
  } finally { await harness.close(); }
});

test('tab movement preserves exact ownership and updates durable window identity for continuation', async () => {
  const harness = await createCapsuleHarness();
  try {
    const base = { sessionId: harness.session.sessionId, taskId: harness.session.taskId,
      startUrl: 'https://example.test/form', allowedOrigins: ['https://example.test'], keepTaskTab: true };
    const opened = await harness.client.requestAuthorizedTransaction({ ...base, runId: 'move-open', idempotencyKey: 'move-open', actions: [{ method: 'page.query', params: { query: 'ready' } }] });
    assert.equal(opened.result, 'verified', JSON.stringify(opened.exact_blocker));
    const initialRecord = harness.broker.taskLedger.getTaskTab(harness.session.profileInstanceId, opened.tab.id);
    const moved = await harness.client.requestAuthorizedTransaction({ ...base, runId: 'move-apply', idempotencyKey: 'move-apply', tabId: opened.tab.id,
      actions: [{ method: 'tabs.configure', params: { destinationWindowId: 22, index: -1 } }, { method: 'page.query', params: { query: 'ready' } }] });
    assert.equal(moved.result, 'verified', JSON.stringify({ blocker: moved.exact_blocker, target: moved.target_resolution,
      initial: { tab: opened.tab, record: initialRecord }, live: [...harness.liveTabs.values()] }));
    const tab = harness.broker.taskLedger.getTaskTab(harness.session.profileInstanceId, opened.tab.id);
    assert.equal(tab.windowId, 22); assert.equal(tab.targetIdentity.windowId, 22);
    assert.equal(moved.capsule.target.windowId, 22);
    const next = await harness.client.requestAuthorizedTransaction({ ...base, runId: 'move-reuse', idempotencyKey: 'move-reuse', tabId: opened.tab.id,
      actions: [{ method: 'page.query', params: { query: 'ready' } }] });
    assert.equal(next.result, 'verified'); assert.equal(next.tab.id, opened.tab.id);
    assert.equal(harness.commands.filter(command => command.method === 'tabs.create').length, 1);
    const history = await harness.client.request('task.history', { sessionId: harness.session.sessionId, method: 'tabs.configure' });
    assert.equal(history.rows.length, 1); assert.equal(history.taskId, harness.session.taskId);
  } finally { await harness.close(); }
});

test("transaction reuses one inspection only when its extension token supports atomic target validation", async () => {
  const harness = await createCapsuleHarness({ semanticGuards: true });
  const { client, session, commands } = harness;
  try {
    const result = await client.requestAuthorizedTransaction({ sessionId: session.sessionId, runId: 'run_atomic_semantic_guard',
      taskId: session.taskId, idempotencyKey: 'idem_atomic_semantic_guard', startUrl: 'https://example.test/guard',
      targetOrigin: 'https://example.test', allowedOrigins: ['https://example.test'],
      actions: [{ method: 'page.click', params: { locator: { testId: 'guarded-button' }, semanticGuardId: 'caller-token-must-not-be-trusted' } }],
      executionCapsule: { workflowType: 'test', goalRef: 'guard-count', planRef: 'guard-count' } });
    assert.equal(result.result, 'verified');
    const inspections = commands.filter(c => c.method === 'visual.inspectTarget');
    const clicks = commands.filter(c => c.method === 'page.click');
    assert.equal(inspections.length, 1);
    assert.equal(clicks.length, 1);
    assert.equal(clicks[0].params.semanticGuardId, `fresh-${clicks[0].params.tabId}-1`);
    assert.notEqual(clicks[0].params.semanticGuardId, 'caller-token-must-not-be-trusted');
  } finally { await harness.close(); }
});
