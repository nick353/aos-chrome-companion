import assert from "node:assert/strict";
import test from "node:test";
import {
  createRecoveryHandle,
  deriveRecoveryIndex,
  deriveRecoveryState,
  verifyRecoveryHandle,
} from "../src/shared/recovery-state.mjs";
import { createHandoffAck, verifyHandoffAck } from "../src/shared/task-runtime.mjs";

test("canonical recovery state distinguishes execution idle from reconciliation pending", () => {
  const result = deriveRecoveryState({
    taskId: "task-note",
    profile: { profileInstanceId: "profile-1", generation: "gen-1", connected: true },
    timedOutOperations: [{ taskId: "task-note", profileInstanceId: "profile-1", operationId: "op-1" }],
    reconciliationOperations: [{ taskId: "task-note", profileInstanceId: "profile-1", operationId: "op-1", state: "unknown_effect" }],
    taskTabs: [{ taskId: "task-note", profileInstanceId: "profile-1", tabId: 42, lifecycleState: "reconciliation_required" }],
  });
  assert.equal(result.state, "reconciliation_pending");
  assert.equal(result.executionIdle, true);
  assert.equal(result.fullyIdle, false);
  assert.equal(result.counts.reconciliationOperations, 1);
  assert.equal(result.primaryBlocker.code, "reconciliation_required");
  assert.match(result.nextAction, /reconciliation/u);
});

test("canonical recovery state reports a user gate before reconciliation", () => {
  const result = deriveRecoveryState({
    taskId: "task-auth",
    taskTabs: [{ taskId: "task-auth", tabId: 7, lifecycleState: "awaiting_user", userHelpRequired: true }],
  });
  assert.equal(result.state, "waiting_user");
  assert.equal(result.primaryBlocker.code, "user_help_required");
  assert.equal(result.counts.userHelpTabs, 1);
});

test("recovery index partitions profile and task state", () => {
  const index = deriveRecoveryIndex({
    profiles: [
      { profileInstanceId: "profile-1", generation: "gen-1", connected: true },
      { profileInstanceId: "profile-2", generation: "gen-2", connected: true },
    ],
    sessions: [{ sessionId: "session-1", taskId: "task-1", profileInstanceId: "profile-1" }],
    taskTabs: [{ taskId: "task-2", profileInstanceId: "profile-2", tabId: 2, lifecycleState: "completed" }],
  });
  assert.equal(index.tasks.length, 2);
  assert.equal(index.tasks.find((entry) => entry.taskId === "task-1").state, "working");
  assert.equal(index.tasks.find((entry) => entry.taskId === "task-2").state, "cleanup_ready");
  assert.equal(index.profiles.length, 2);
});

test("recovery index exposes a missing runtime contract instead of masking an old Extension", () => {
  const index = deriveRecoveryIndex({
    profiles: [{
      profileInstanceId: "profile-old",
      generation: "gen-old",
      connected: true,
      buildId: "install-current",
      expectedBuildId: "install-current",
      operationSchema: null,
      operationSchemaVersion: null,
      capabilitiesDigest: null,
    }],
    runtimeUpdatePendingByProfile: new Set(["profile-old"]),
  });
  assert.equal(index.profiles[0].state, "runtime_update_pending");
  assert.equal(index.profiles[0].runtimeUpdatePending, true);
  assert.match(index.profiles[0].nextAction, /runtime_refresh/u);
});

test("recovery handle carries complete target identity and detects tampering", () => {
  const secret = "recovery-secret";
  const handle = createRecoveryHandle(secret, {
    taskId: "task-1",
    runId: "run-1",
    ownerKey: "session-1",
    profileInstanceId: "profile-1",
    generation: "gen-1",
    tabId: 9,
    pageInstanceId: "doc-9",
    windowId: 3,
    frameId: 2,
    origin: "https://example.test/form",
  });
  assert.equal(handle.schema, "aos.chrome_companion.recovery_handle.v1");
  assert.equal(handle.targetIdentity.frameId, 2);
  assert.equal(verifyRecoveryHandle(secret, handle, { taskId: "task-1", runId: "run-1" }).handleId, handle.handleId);
  assert.throws(() => verifyRecoveryHandle(secret, { ...handle, targetIdentity: { ...handle.targetIdentity, tabId: 10 } }), /signature|fingerprint/u);
});

test("handoff acknowledgement is signed and idempotent-shaped", () => {
  const ack = createHandoffAck("handoff-secret", {
    sourceTaskId: "source-task",
    destinationTaskId: "destination-task",
    runId: "run-1",
    receiptSha256: "a".repeat(64),
    transferred: [4, 2, 2],
    missing: [8],
  });
  assert.deepEqual(ack.transferred, [2, 4]);
  assert.equal(verifyHandoffAck("handoff-secret", ack, { destinationTaskId: "destination-task" }).status, "accepted");
  assert.throws(() => verifyHandoffAck("handoff-secret", { ...ack, runId: "run-other" }), /signature/u);
});
