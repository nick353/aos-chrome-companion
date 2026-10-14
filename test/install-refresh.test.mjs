import assert from "node:assert/strict";
import test from "node:test";
import { readFile } from "node:fs/promises";
import { runInNewContext } from "node:vm";
import { OPERATION_SCHEMA_DIGEST } from "../src/shared/operation-schema.mjs";
import {
  automaticRefreshPlan,
  canSyncControlPlaneArtifacts,
  canRestartResidentBroker,
  deriveMaintenanceProfile,
  resolveRefreshTaskIdentity,
  shouldSuppressRedundantOfflineRestart,
} from "../src/shared/install-refresh.mjs";

test("sync fresh readback rejects missing or stale activation/provenance without live integration", async () => {
  const source = await readFile(new URL("../scripts/sync-control-plane-macos.mjs", import.meta.url), "utf8");
  const functionSource = source.slice(source.indexOf("async function readInstalledLiveStatusUntilReady("), source.indexOf("export function maintenanceBoundary("));
  const profile = { connected: true, buildId: "installed", generation: 2, operationSchemaDigest: OPERATION_SCHEMA_DIGEST,
    buildProvenanceMismatches: [] };
  for (const [overrides, expected] of [[{}, true], [{ buildId: "old" }, false], [{ operationSchemaDigest: "old" }, false],
    [{ buildProvenanceMismatches: undefined }, false], [{ buildProvenanceMismatches: ["extensionTreeSha256"] }, false], [{ generation: null }, false]]) {
    let clock = 0;
    const status = { profiles: [{ ...profile, ...overrides }], runtimeAttestation: { operationSchemaDigest: OPERATION_SCHEMA_DIGEST } };
    const check = runInNewContext(`${functionSource}\nreadInstalledLiveStatusUntilReady`, { OPERATION_SCHEMA_DIGEST,
      Date: { now: () => { clock += 1_000; return clock; } }, setTimeout: (callback) => callback(),
      readInstalledLiveStatus: async () => status, errorText: String });
    const result = await check("mock-app", { expectedBuildId: "installed", timeoutMs: 5_000 });
    assert.equal(result.ready, expected);
  }
  assert.match(source, /\.\.\.controlPlaneSyncReadiness\(receipt\)\.exactBlockers, \.\.\.receipt\.restartBoundary\.blockers/u);
  assert.match(source, /refreshDeferred \? "applied_pending_refresh"/u);
});

test("automatic refresh uses one connected profile and defers before any restart otherwise", () => {
  assert.equal(automaticRefreshPlan({ restartBroker: true, refreshExtension: true, profile: { profileInstanceId: "p", connected: true } }).disposition, "allowed");
  const deferred = automaticRefreshPlan({ restartBroker: true, refreshExtension: true, profile: { profileInstanceId: "p", connected: false } });
  assert.equal(deferred.disposition, "deferred");
  assert.equal(deferred.exactBlocker, "companion_profile_not_uniquely_connected");
  assert.equal(automaticRefreshPlan({ restartBroker: false, refreshExtension: true, profile: null }).disposition, "not_requested");
});

test("automatic refresh never guesses through conflicting Codex identities", () => {
  const conflict = resolveRefreshTaskIdentity({ CODEX_THREAD_ID: "thread-a", CODEX_SESSION_ID: "session-b" });
  assert.equal(conflict.exactBlocker, "codex_thread_identity_conflict");
  assert.equal(conflict.taskId, null);

  assert.deepEqual(resolveRefreshTaskIdentity({ CODEX_THREAD_ID: "thread-a" }), {
    taskId: "thread-a",
    source: "CODEX_THREAD_ID",
    exactBlocker: null,
    details: null,
  });
  assert.deepEqual(resolveRefreshTaskIdentity({}), {
    taskId: null,
    source: "maintenance_session",
    exactBlocker: null,
    details: null,
  });
});

test("control-plane artifacts can converge offline only when the profile is idle", () => {
  const disconnectedIdle = {
    profiles: [{ profileInstanceId: "profile-2", connected: false }],
    logicalSessionCount: 0,
    exactTabLeaseCount: 0,
    pendingOperationCount: 0,
    timedOutOperationActiveCount: 0,
    reconciliationPendingActiveCount: 0,
    queueCount: 0,
    activeTaskTabCount: 0,
  };
  assert.equal(canSyncControlPlaneArtifacts(disconnectedIdle), true);
  assert.equal(canSyncControlPlaneArtifacts({
    ...disconnectedIdle,
    logicalSessionCount: 1,
  }), false);
  assert.equal(canSyncControlPlaneArtifacts({
    ...disconnectedIdle,
    reconciliationPendingActiveCount: 1,
  }), false);
  assert.equal(canSyncControlPlaneArtifacts({
    ...disconnectedIdle,
    profiles: [],
  }), false);
});

test("authoritative live-session counts are not reduced twice", () => {
  assert.equal(canSyncControlPlaneArtifacts({
    profiles: [{ profileInstanceId: "profile-2", connected: false }],
    logicalSessionCount: 1,
    staleIdleSessionCount: 1,
    exactTabLeaseCount: 0,
    pendingOperationCount: 0,
    timedOutOperationActiveCount: 0,
    reconciliationPendingActiveCount: 0,
    queueCount: 0,
    activeTaskTabCount: 0,
  }), false);
  assert.equal(canSyncControlPlaneArtifacts({
    profiles: [{ profileInstanceId: "profile-2", connected: false }],
    logicalSessionCount: 0,
    staleIdleSessionCount: 1,
    exactTabLeaseCount: 0,
    pendingOperationCount: 0,
    timedOutOperationActiveCount: 0,
    reconciliationPendingActiveCount: 0,
    queueCount: 0,
    activeTaskTabCount: 0,
  }), true);
});

test("offline maintenance derives one profile from retained task tabs but rejects ambiguity", () => {
  assert.deepEqual(deriveMaintenanceProfile({
    profiles: [],
    taskTabs: [
      { profileInstanceId: "profile-1", generation: "gen-1", buildId: "install-1" },
      { profileInstanceId: "profile-1", generation: "gen-1" },
    ],
  }), {
    profileInstanceId: "profile-1",
    generation: "gen-1",
    buildId: "install-1",
    connected: false,
    offlineDerived: true,
  });
  assert.equal(deriveMaintenanceProfile({
    profiles: [],
    taskTabs: [{ profileInstanceId: "profile-1" }, { profileInstanceId: "profile-2" }],
  }), null);
});

test("offline pending refresh does not restart the broker on every LaunchAgent tick", () => {
  assert.equal(shouldSuppressRedundantOfflineRestart({
    changed: false,
    restartBroker: true,
    profileConnected: false,
    artifactSyncAllowed: true,
    previousResult: "applied_pending_refresh",
  }), true);
  assert.equal(shouldSuppressRedundantOfflineRestart({
    changed: false,
    restartBroker: true,
    profileConnected: false,
    artifactSyncAllowed: true,
    previousResult: "deferred",
  }), false);
  assert.equal(shouldSuppressRedundantOfflineRestart({
    changed: false,
    restartBroker: true,
    profileConnected: true,
    artifactSyncAllowed: true,
    previousResult: "applied_pending_refresh",
  }), false);
});


test("a disconnected zero-session profile never authorizes restarting the resident broker", () => {
  const idle = { profiles: [{ profileInstanceId: "p", connected: true }], logicalSessionCount: 0, exactTabLeaseCount: 0, pendingOperationCount: 0, queueCount: 0 };
  assert.equal(canRestartResidentBroker(idle), true);
  assert.equal(canRestartResidentBroker({ ...idle, profiles: [{ profileInstanceId: "p", connected: false }] }), false);
  assert.equal(canRestartResidentBroker({ ...idle, logicalSessionCount: 1 }), false);
  assert.equal(canRestartResidentBroker({ ...idle, pendingOperationCount: 1 }), false);
});

test("idle schema upgrade restarts only for a failed hello matching the installed new schema and build", () => {
  const oldDigest = "a".repeat(64), newDigest = "b".repeat(64);
  const installed = { buildId: "install-1", operationSchemaDigest: newDigest };
  const status = { profiles: [{ profileInstanceId: "p", connected: false }], logicalSessionCount: 0, exactTabLeaseCount: 0, pendingOperationCount: 0, queueCount: 0,
    expectedBuildId: "install-1", runtimeAttestation: { operationSchemaDigest: oldDigest },
    profileRegistrationFailures: [{ profileInstanceId: "p", expectedBuildId: "install-1", receivedBuildId: "install-1", exactBlocker: { code: "companion_operation_schema_digest_mismatch", details: { expectedOperationSchemaDigest: oldDigest, receivedOperationSchemaDigest: newDigest } } }] };
  assert.equal(canRestartResidentBroker(status, installed), true);
  for (const field of ["logicalSessionCount", "exactTabLeaseCount", "pendingOperationCount", "queueCount", "timedOutOperationActiveCount", "reconciliationPendingActiveCount", "activeTaskTabCount"]) {
    assert.equal(canRestartResidentBroker({ ...status, [field]: 1 }, installed), false, field);
  }
  assert.equal(canRestartResidentBroker({ ...status, profileRegistrationFailures: [] }, installed), false);
  assert.equal(canRestartResidentBroker({ ...status, profiles: [] }, installed), false);
  assert.equal(canRestartResidentBroker(status, { ...installed, operationSchemaDigest: "c".repeat(64) }), false);
  assert.equal(canRestartResidentBroker(status, { ...installed, buildId: "other" }), false);
  assert.equal(canRestartResidentBroker({ ...status, profiles: [{ profileInstanceId: "other", connected: false }] }, installed), false);
  assert.equal(canRestartResidentBroker({ ...status, expectedBuildId: "other" }, installed), false);
});
