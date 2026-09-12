import assert from "node:assert/strict";
import test from "node:test";
import { DYNAMIC_TARGET_ADAPTER_SCHEMA, DYNAMIC_TARGET_STATUS, resolveDynamicTaskTarget } from "../src/shared/dynamic-target-adapter.mjs";

const session = {
  taskId: "task-1",
  sessionId: "session-1",
  generation: "generation-1",
  profileInstanceId: "profile-1",
};

const descriptor = {
  taskId: "task-1",
  targetKey: "url:https://example.test/apply",
  targetOrigin: "https://example.test",
  allowedOrigins: ["https://example.test"],
};

function entry(overrides = {}) {
  return {
    taskId: "task-1",
    profileInstanceId: "profile-1",
    generation: "generation-1",
    tabId: 10,
    targetKey: descriptor.targetKey,
    retentionPolicy: "retain",
    lifecycleState: "completed",
    targetIdentity: { origin: "https://example.test", frameId: 0 },
    ...overrides,
  };
}

function live(overrides = {}) {
  return { id: 10, url: "https://example.test/apply", windowId: 3, ...overrides };
}

test("dynamic target adapter resolves one exact task-owned target", () => {
  const result = resolveDynamicTaskTarget({
    session,
    descriptor,
    taskTabs: [entry()],
    inventory: [live()],
    leases: [],
  });
  assert.equal(result.schema, DYNAMIC_TARGET_ADAPTER_SCHEMA);
  assert.equal(result.status, DYNAMIC_TARGET_STATUS.RESOLVED);
  assert.equal(result.resolution, "exact");
  assert.deepEqual(result.candidates, [10]);
  assert.equal(result.targetIdentity.taskId, "task-1");
  assert.equal(result.targetIdentity.generation, "generation-1");
  assert.equal(result.targetIdentity.windowId, 3);
});

test("explicit tab targeting preserves current routes and cannot fall back to another resource", () => {
  const resolve = (entries, tabs, extra = {}) => resolveDynamicTaskTarget({ session,
    descriptor: { ...descriptor, tabId: 10 }, taskTabs: entries, inventory: tabs, allowSameOriginReuse: true, ...extra });
  const changedRoute = live({ url: "https://example.test/next#detail" });
  const result = resolve([entry({ targetKey: "different" }), entry({ tabId: 11 })], [changedRoute, live({ id: 11 })]);
  assert.equal(result.status, "resolved");
  assert.equal(result.live.url, changedRoute.url);
  assert.deepEqual(result.candidates, [10]);
  for (const override of [{ taskId: "foreign" }, { profileInstanceId: "foreign" }, { generation: "old" }]) {
    assert.notEqual(resolve([entry(override), entry({ tabId: 11 })], [changedRoute, live({ id: 11 })]).status, "resolved");
  }
  assert.equal(resolve([entry()], [live({ url: "https://foreign.test/" })]).status, "not_found");
  assert.equal(resolve([entry()], []).status, "not_found");
  assert.equal(resolve([entry()], []).exactBlocker, "task_target_tab_missing");
  assert.equal(resolve([], []).exactBlocker, "task_target_unavailable");
  assert.equal(resolve([], [], { descriptor: { ...descriptor, tabId: 10 } }).exactBlocker, "task_target_unavailable");
  assert.equal(resolve([entry({ targetKey: "different", lifecycleState: "reconciliation_required" })], [changedRoute]).status, "protected");
  assert.equal(resolve([entry({ targetKey: "different" })], [changedRoute], { leases: [{ tabId: 10, sessionId: "another" }] }).status, "busy");
});

test("dynamic target adapter rejects duplicate exact matches as ambiguous", () => {
  const result = resolveDynamicTaskTarget({
    session,
    descriptor,
    taskTabs: [entry({ tabId: 10 }), entry({ tabId: 11 })],
    inventory: [live({ id: 10 }), live({ id: 11 })],
  });
  assert.equal(result.status, DYNAMIC_TARGET_STATUS.AMBIGUOUS);
  assert.equal(result.exactBlocker, "dynamic_target_multiple_exact_matches");
  assert.deepEqual(result.candidates, [10, 11]);
});

test("dynamic target adapter returns busy for an exact target leased by another session", () => {
  const result = resolveDynamicTaskTarget({
    session,
    descriptor,
    taskTabs: [entry()],
    inventory: [live()],
    leases: [{ tabId: 10, sessionId: "foreign-session" }],
  });
  assert.equal(result.status, DYNAMIC_TARGET_STATUS.BUSY);
  assert.equal(result.exactBlocker, "target_resource_busy");
});

test("dynamic target adapter protects reconciliation and stale-generation records", () => {
  const protectedResult = resolveDynamicTaskTarget({
    session,
    descriptor,
    taskTabs: [entry({ lifecycleState: "reconciliation_required" })],
    inventory: [live()],
  });
  assert.equal(protectedResult.status, DYNAMIC_TARGET_STATUS.PROTECTED);
  assert.equal(protectedResult.exactBlocker, "reconciliation_required");

  const staleResult = resolveDynamicTaskTarget({
    session,
    descriptor,
    taskTabs: [entry({ generation: "generation-old" })],
    inventory: [live()],
  });
  assert.equal(staleResult.status, DYNAMIC_TARGET_STATUS.STALE);
  assert.equal(staleResult.exactBlocker, "target_generation_mismatch");
});

test("dynamic target adapter only reuses one ordinary same-origin tab when explicitly enabled", () => {
  const result = resolveDynamicTaskTarget({
    session,
    descriptor: { ...descriptor, targetKey: "url:https://example.test/next" },
    taskTabs: [entry({ targetKey: "url:https://example.test/previous" })],
    inventory: [live({ url: "https://example.test/previous" })],
    allowSameOriginReuse: true,
  });
  assert.equal(result.status, DYNAMIC_TARGET_STATUS.RESOLVED);
  assert.equal(result.resolution, "same_origin_reuse");
});

test("dynamic target adapter does not reuse multiple same-origin tabs", () => {
  const result = resolveDynamicTaskTarget({
    session,
    descriptor: { ...descriptor, targetKey: "url:https://example.test/next" },
    taskTabs: [entry({ tabId: 10, targetKey: "url:https://example.test/previous-a" }), entry({ tabId: 11, targetKey: "url:https://example.test/previous-b" })],
    inventory: [live({ id: 10, url: "https://example.test/previous-a" }), live({ id: 11, url: "https://example.test/previous-b" })],
    allowSameOriginReuse: true,
  });
  assert.equal(result.status, DYNAMIC_TARGET_STATUS.AMBIGUOUS);
  assert.equal(result.exactBlocker, "dynamic_target_multiple_same_origin_candidates");
});
