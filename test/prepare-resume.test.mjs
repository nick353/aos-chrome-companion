import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { CompanionBroker } from "../src/broker/broker.mjs";
import { BrokerClient } from "../src/client/broker-client.mjs";
import { connectPeer } from "../src/client/connect.mjs";
import { DEFAULT_CAPABILITIES, PROTOCOL_VERSION } from "../src/shared/constants.mjs";
import { INSTALL_BUILD_ID } from "../src/shared/build-info.mjs";
import { ensureBrokerSecret } from "../src/shared/security.mjs";
import { normalizeTaskExecutionCapsule } from "../src/shared/task-runtime.mjs";

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

test("prepare_resume returns a signed, read-only ready decision for a fresh owner", async () => {
  const dataDir = await mkdtemp(join(tmpdir(), "aos-companion-prepare-resume-"));
  const handoffDir = join(dataDir, "handoff-receipts");
  const env = {
    ...process.env,
    AOS_CHROME_COMPANION_DATA_DIR: dataDir,
    AOS_CHROME_COMPANION_SOCKET: join(dataDir, "broker.sock"),
    AOS_CHROME_COMPANION_SECRET_FILE: join(dataDir, "secret"),
    AOS_CHROME_COMPANION_AOS_ISSUER_SECRET_FILE: join(dataDir, "aos-issuer"),
    AOS_CHROME_COMPANION_HANDOFF_RECEIPTS_DIR: handoffDir,
  };
  await mkdir(handoffDir, { recursive: true, mode: 0o700 });
  await writeFile(env.AOS_CHROME_COMPANION_AOS_ISSUER_SECRET_FILE, "prepare-resume-secret\n", { mode: 0o600 });
  const secret = await ensureBrokerSecret(env);
  const broker = new CompanionBroker({
    socketPath: env.AOS_CHROME_COMPANION_SOCKET,
    secret,
    issuerSecrets: { aos: "prepare-resume-secret" },
    handoffReceiptsDir: handoffDir,
  });
  await broker.listen();
  const extension = await connectPeer({ role: "extension-relay", autoStart: false, env });
  const helloAck = onceMessage(extension, (message) => message.kind === "extension.hello_ack");
  extension.send({
    kind: "extension.hello",
    protocolVersion: PROTOCOL_VERSION,
    profileInstanceId: "profile_prepare_resume",
    extensionRuntimeId: "runtime_prepare_resume",
    buildId: INSTALL_BUILD_ID,
    capabilities: DEFAULT_CAPABILITIES,
  });
  await helloAck;
  const client = await BrokerClient.connect({ autoStart: false, env, issuer: "aos" });
  const session = await client.request("session.open", { taskId: "task_prepare_resume" });
  try {
    const capsule = normalizeTaskExecutionCapsule({
      capsuleId: "capsule_prepare_resume",
      taskId: "task_prepare_resume",
      runId: "run_prepare_resume",
      workflowType: "AOS",
      targetKey: "prepare-resume",
      allowedOrigins: ["https://example.test"],
      profileInstanceId: session.profileInstanceId,
      generation: session.generation,
      state: "discovered",
    });
    await broker.taskLedger.putTaskCapsule(capsule);
    const result = await client.requestPrepareResume({
      sessionId: session.sessionId,
      taskId: "task_prepare_resume",
      runId: "run_prepare_resume",
    });
    assert.equal(result.schema, "aos.chrome_companion.prepare_resume.v1");
    assert.equal(result.resume_ready, true);
    assert.equal(result.exact_blocker, null);
    assert.equal(result.effect_state, "no_dispatch");
    assert.equal(result.external_action_executed, false);
    assert.equal(result.replay_allowed, false);
    assert.equal(result.next_action, "open_fresh_task_transaction_or_continue_same_owner_session");
    assert.equal(result.operation_effect_proof?.schema, "aos.chrome_companion.operation_effect_proof.v1");
    assert.equal(result.capsule_id, "capsule_prepare_resume");
    assert.equal(result.capsule_state, "discovered");
    assert.equal(result.capsule_target.targetKey, "prepare-resume");
  } finally {
    client.close();
    extension.close();
    await broker.close();
    await rm(dataDir, { recursive: true, force: true });
  }
});

test("prepare_resume keeps direct applications independent from the source-return gate", async () => {
  const dataDir = await mkdtemp(join(tmpdir(), "aos-companion-prepare-resume-direct-"));
  const handoffDir = join(dataDir, "handoff-receipts");
  const env = {
    ...process.env,
    AOS_CHROME_COMPANION_DATA_DIR: dataDir,
    AOS_CHROME_COMPANION_SOCKET: join(dataDir, "broker.sock"),
    AOS_CHROME_COMPANION_SECRET_FILE: join(dataDir, "secret"),
    AOS_CHROME_COMPANION_AOS_ISSUER_SECRET_FILE: join(dataDir, "aos-issuer"),
    AOS_CHROME_COMPANION_HANDOFF_RECEIPTS_DIR: handoffDir,
  };
  await mkdir(handoffDir, { recursive: true, mode: 0o700 });
  await writeFile(env.AOS_CHROME_COMPANION_AOS_ISSUER_SECRET_FILE, "prepare-resume-direct-secret\n", { mode: 0o600 });
  const secret = await ensureBrokerSecret(env);
  const broker = new CompanionBroker({
    socketPath: env.AOS_CHROME_COMPANION_SOCKET,
    secret,
    issuerSecrets: { aos: "prepare-resume-direct-secret" },
    handoffReceiptsDir: handoffDir,
  });
  await broker.listen();
  const extension = await connectPeer({ role: "extension-relay", autoStart: false, env });
  const helloAck = onceMessage(extension, (message) => message.kind === "extension.hello_ack");
  extension.send({
    kind: "extension.hello",
    protocolVersion: PROTOCOL_VERSION,
    profileInstanceId: "profile_prepare_resume_direct",
    extensionRuntimeId: "runtime_prepare_resume_direct",
    buildId: INSTALL_BUILD_ID,
    capabilities: DEFAULT_CAPABILITIES,
  });
  await helloAck;
  const client = await BrokerClient.connect({ autoStart: false, env, issuer: "aos" });
  const session = await client.request("session.open", { taskId: "task_prepare_resume_direct" });
  try {
    const receiptPath = join(handoffDir, "task_prepare_resume_direct.json");
    await writeFile(receiptPath, `${JSON.stringify({
      schema: "codex_hookless_handoff_receipt.v1",
      status: "reconciliation_required",
      source_status: "reconciliation_only",
      implementation_allowed: false,
      source_thread_id: "task_prepare_resume_direct",
      destination_thread_id: "destination_task",
      packet_content_sha256: "a".repeat(64),
      source_task_archived: false,
      source_task_visible: true,
    })}\n`, { mode: 0o600 });
    const direct = await client.requestPrepareResume({
      sessionId: session.sessionId,
      taskId: "task_prepare_resume_direct",
      runId: "run_prepare_resume_direct",
      intent: "direct_application",
    });
    assert.equal(direct.schema, "aos.chrome_companion.prepare_resume.v1");
    assert.equal(direct.intent, "direct_application");
    assert.equal(direct.resume_ready, true);
    assert.equal(direct.exact_blocker, null);
    assert.equal(direct.replay_allowed, false);

    const generic = await client.requestPrepareResume({
      sessionId: session.sessionId,
      taskId: "task_prepare_resume_direct",
      runId: "run_prepare_resume_generic",
    });
    assert.equal(generic.intent, "prepare_resume");
    assert.equal(generic.resume_ready, false);
    assert.equal(generic.exact_blocker?.code, "source_handoff_implementation_forbidden");
  } finally {
    client.close();
    extension.close();
    await broker.close();
    await rm(dataDir, { recursive: true, force: true });
  }
});
