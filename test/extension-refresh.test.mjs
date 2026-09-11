import assert from "node:assert/strict";
import test from "node:test";
import { BrokerClient } from "../src/client/broker-client.mjs";
import {
  EXTENSION_REFRESH_BOUNDARY_SCHEMA,
  planExtensionRefreshBoundary,
  verifyFreshExtensionGeneration,
} from "../src/shared/extension-refresh.mjs";

function status({ generation = "gen-1", runtime = "runtime-1", connected = true, sessions = [], leases = 0, pending = 0, timedOut = 0, queue = 0, taskTabs = [], capabilities = ["extension.reload"] } = {}) {
  return {
    profiles: [{
      profileInstanceId: "profile-1",
      generation,
      extensionRuntimeId: runtime,
      buildId: "install-1",
      connected,
      capabilities,
    }],
    logicalSessions: sessions,
    exactTabLeaseCount: leases,
    pendingOperationCount: pending,
    timedOutOperationCount: timedOut,
    queueCount: queue,
    taskTabs,
  };
}

test("refresh preflight defers active profile work with exact blockers", () => {
  const result = planExtensionRefreshBoundary(status({
    sessions: [{ sessionId: "current", profileInstanceId: "profile-1" }, { sessionId: "other", profileInstanceId: "profile-1" }],
    leases: 1,
    pending: 1,
    taskTabs: [{ profileInstanceId: "profile-1", lifecycleState: "reconciliation_required" }],
  }), { profileInstanceId: "profile-1", ignoreSessionId: "current", expectedBuildId: "install-1" });
  assert.equal(result.schema, EXTENSION_REFRESH_BOUNDARY_SCHEMA);
  assert.equal(result.disposition, "deferred");
  assert.equal(result.exactBlocker, "pending_operation");
  assert.deepEqual(result.blockers.map((item) => item.code), ["pending_operation", "active_lease", "active_browser_session", "active_browser_task", "reconciliation_required"]);
});

test("refresh preflight allows one signed reload at a fully idle boundary", () => {
  const result = planExtensionRefreshBoundary(status({ sessions: [{ sessionId: "current", profileInstanceId: "profile-1" }] }), {
    profileInstanceId: "profile-1",
    ignoreSessionId: "current",
    expectedBuildId: "install-1",
  });
  assert.equal(result.disposition, "allowed");
  assert.equal(result.exactBlocker, null);
  assert.equal(result.counts.activeSessionCount, 0);
});

test("refresh ignores retained completed terminal tabs", () => {
  const result = planExtensionRefreshBoundary(status({
    taskTabs: [{
      profileInstanceId: "profile-1",
      tabId: 42,
      lifecycleState: "completed",
      retentionPolicy: "retain",
    }],
  }), {
    profileInstanceId: "profile-1",
    expectedBuildId: "install-1",
  });
  assert.equal(result.disposition, "allowed");
  assert.equal(result.counts.activeTaskTabCount, 0);
  assert.equal(result.counts.reconciliationTabCount, 0);
});

test("refresh ignores ledger-only tabs and their historical timeout count", () => {
  const result = planExtensionRefreshBoundary(status({
    timedOut: 4,
    taskTabs: [{
      profileInstanceId: "profile-1",
      tabId: 43,
      lifecycleState: "reconciliation_required",
      retentionPolicy: "ledger_only",
      userHelpRequired: false,
    }],
  }), {
    profileInstanceId: "profile-1",
    expectedBuildId: "install-1",
  });
  assert.equal(result.disposition, "deferred");
  // Old status producers expose only timedOutOperationCount; the preflight
  // remains conservative until the broker publishes the scoped active count.
  assert.equal(result.exactBlocker, "timed_out_operation");
  const current = planExtensionRefreshBoundary({
    ...status({
      timedOut: 4,
      taskTabs: [{
        profileInstanceId: "profile-1",
        tabId: 43,
        lifecycleState: "reconciliation_required",
        retentionPolicy: "ledger_only",
        userHelpRequired: false,
      }],
    }),
    timedOutOperationActiveCount: 0,
  }, { profileInstanceId: "profile-1", expectedBuildId: "install-1" });
  assert.equal(current.disposition, "allowed");
  assert.equal(current.counts.timedOutOperationCount, 0);
  assert.equal(current.counts.reconciliationTabCount, 0);
});

test("refresh defers every pre/post execution lifecycle", () => {
  for (const lifecycleState of ["admitted", "target_bound", "pre_read", "executing", "post_read", "awaiting_user"]) {
    const result = planExtensionRefreshBoundary(status({
      sessions: [{ sessionId: "active", profileInstanceId: "profile-1" }],
      taskTabs: [{ profileInstanceId: "profile-1", sessionId: "active", lifecycleState }],
    }), { profileInstanceId: "profile-1", expectedBuildId: "install-1" });
    assert.equal(result.disposition, "deferred", lifecycleState);
    // The live session is the first and most specific profile-global blocker;
    // the task-tab lifecycle is still included in the detailed blocker list.
    assert.equal(result.exactBlocker, "active_browser_session", lifecycleState);
    assert.equal(result.blockers.some((item) => item.code === "active_browser_task"), true, lifecycleState);
  }
});

test("refresh does not wait on an ownerless retained reconciliation tab", () => {
  const result = planExtensionRefreshBoundary(status({
    taskTabs: [{
      profileInstanceId: "profile-1",
      sessionId: "expired-session",
      tabId: 44,
      lifecycleState: "reconciliation_required",
      retentionPolicy: "retain_until_resume",
    }],
  }), { profileInstanceId: "profile-1", expectedBuildId: "install-1" });
  assert.equal(result.disposition, "allowed");
  assert.equal(result.counts.activeTaskTabCount, 0);
  assert.equal(result.counts.reconciliationTabCount, 0);
});

test("fresh generation proof rejects same-generation status and accepts a rotated runtime", () => {
  const before = status();
  const unchanged = verifyFreshExtensionGeneration(before, status(), { profileInstanceId: "profile-1", expectedBuildId: "install-1" });
  assert.equal(unchanged.disposition, "deferred");
  assert.equal(unchanged.exactBlocker, "extension_reload_generation_not_reflected");

  const reflected = verifyFreshExtensionGeneration(before, status({ generation: "gen-2", runtime: "runtime-2" }), {
    profileInstanceId: "profile-1",
    expectedBuildId: "install-1",
  });
  assert.equal(reflected.disposition, "reflected");
  assert.equal(reflected.freshGeneration, true);
  assert.equal(reflected.runtimeIdentityChanged, true);
});

test("BrokerClient refresh waits for a fresh generation without reusing the old session", async () => {
  const client = Object.create(BrokerClient.prototype);
  let statusCalls = 0;
  client.request = async (method) => {
    assert.equal(method, "status.get");
    statusCalls += 1;
    return status({ generation: statusCalls < 2 ? "gen-1" : "gen-2", runtime: statusCalls < 2 ? "runtime-1" : "runtime-2" });
  };
  client.requestExtensionReload = async (params) => ({ accepted: true, scheduled: true, buildId: params.expectedBuildId, generation: "gen-1" });
  const result = await client.requestExtensionReloadAndReadback({
    sessionId: "current",
    profileInstanceId: "profile-1",
    taskId: "task-1",
    runId: "run-1",
    idempotencyKey: "idem-1",
    expectedBuildId: "install-1",
  }, { timeoutMs: 5_000, pollIntervalMs: 1 });
  assert.equal(result.result, "reflected");
  assert.equal(result.freshSessionRequired, true);
  assert.equal(result.verification.generationAfter, "gen-2");
  assert.equal(statusCalls, 2);
});

test("BrokerClient refresh returns a no-replay timeout receipt when generation never changes", async () => {
  const client = Object.create(BrokerClient.prototype);
  client.request = async () => status();
  client.requestExtensionReload = async () => ({ accepted: true, scheduled: true, buildId: "install-1", generation: "gen-1" });
  const result = await client.requestExtensionReloadAndReadback({
    sessionId: "current",
    profileInstanceId: "profile-1",
    taskId: "task-1",
    runId: "run-1",
    idempotencyKey: "idem-2",
    expectedBuildId: "install-1",
  }, { timeoutMs: 1_000, pollIntervalMs: 50 });
  assert.equal(result.result, "deferred");
  assert.equal(result.exactBlocker, "extension_reload_generation_not_reflected");
  assert.equal(result.noReplay, true);
});
