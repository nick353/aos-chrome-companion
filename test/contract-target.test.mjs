import assert from "node:assert/strict";
import test from "node:test";
import {
  DEFAULT_CAPABILITIES,
  EXTENSION_METHODS,
  MUTATION_METHODS,
  OPERATION_DEFINITIONS,
  OPERATION_SCHEMA_DIGEST,
  PROFILE_GLOBAL_METHODS,
  TARGET_METHODS,
} from "../src/shared/constants.mjs";
import {
  MUTATION_METHODS as GENERATED_MUTATION_METHODS,
  OPERATION_SCHEMA_DIGEST as GENERATED_OPERATION_SCHEMA_DIGEST,
  OPERATION_DEFINITIONS as GENERATED_OPERATION_DEFINITIONS,
} from "../extension/operation-schema.generated.js";
import { operationSchemaDocument } from "../src/shared/operation-schema.mjs";
import {
  TARGET_IDENTITY_FIELDS,
  canonicalTargetIdentity,
  normalizeTargetIdentity,
  rebuildTaskTabIdentity,
  targetIdentityDigest,
  targetIdentityMatches,
  taskTabIdentityConsistent,
} from "../src/shared/task-runtime.mjs";

test("operation method sets are derived from one runtime schema", () => {
  assert.equal(new Set(OPERATION_DEFINITIONS.map(({ method }) => method)).size, OPERATION_DEFINITIONS.length);
  for (const definition of OPERATION_DEFINITIONS) {
    assert.equal(EXTENSION_METHODS.has(definition.method), true);
    assert.equal(TARGET_METHODS.has(definition.method), definition.targetScoped);
    assert.equal(MUTATION_METHODS.has(definition.method), definition.mutation);
    assert.equal(PROFILE_GLOBAL_METHODS.has(definition.method), definition.profileGlobal);
  }
  assert.deepEqual(new Set(DEFAULT_CAPABILITIES), EXTENSION_METHODS);
  assert.deepEqual(GENERATED_OPERATION_DEFINITIONS, OPERATION_DEFINITIONS);
  assert.deepEqual(new Set(GENERATED_MUTATION_METHODS), MUTATION_METHODS);
  assert.equal(operationSchemaDocument().schemaDigest, OPERATION_SCHEMA_DIGEST);
  assert.equal(GENERATED_OPERATION_SCHEMA_DIGEST, OPERATION_SCHEMA_DIGEST);
});

test("target identity has a stable complete shape and canonical fingerprint", () => {
  const first = normalizeTargetIdentity({
    taskId: " task-1 ",
    sessionId: "session-1",
    leaseId: "lease-1",
    generation: "generation-1",
    profileInstanceId: "profile-1",
    tabId: 42,
    pageInstanceId: "document-1",
    windowId: 7,
    locator: { frameId: 3 },
    url: "https://example.test/form",
  });
  const second = normalizeTargetIdentity({
    url: "https://example.test/form/path",
    windowId: 7,
    frameId: 3,
    pageInstanceId: "document-1",
    tabId: 42,
    profileInstanceId: "profile-1",
    generation: "generation-1",
    leaseId: "lease-1",
    sessionId: "session-1",
    taskId: "task-1",
  });
  assert.deepEqual(Object.keys(first).filter((key) => key !== "schema").sort(), [...TARGET_IDENTITY_FIELDS].sort());
  assert.equal(first.origin, "https://example.test");
  assert.equal(first.frameId, 3);
  assert.equal(targetIdentityMatches(first, second), true);
  assert.equal(canonicalTargetIdentity(first), canonicalTargetIdentity(second));
  assert.notEqual(targetIdentityDigest("secret", first), targetIdentityDigest("secret", { ...first, windowId: 8 }));
});

test("unknown target identity fields remain explicit instead of collapsing to tabId", () => {
  const target = normalizeTargetIdentity({ tabId: 42, origin: "*", windowId: "7" });
  assert.equal(target.tabId, 42);
  assert.equal(target.windowId, null);
  assert.equal(target.origin, null);
  for (const field of TARGET_IDENTITY_FIELDS) assert.ok(Object.hasOwn(target, field), field);
});

test("task-tab identity is rebuilt when ownership moves and rejects stale denormalized fields", () => {
  const original = {
    profileInstanceId: "profile-1",
    generation: "generation-1",
    tabId: 42,
    taskId: "source-task",
    sessionId: "source-session",
    targetIdentity: normalizeTargetIdentity({
      profileInstanceId: "profile-1",
      generation: "generation-1",
      tabId: 42,
      taskId: "source-task",
      sessionId: "source-session",
      leaseId: "source-lease",
      origin: "https://example.test/form",
    }),
  };
  original.targetFingerprint = targetIdentityDigest("secret", original.targetIdentity);
  assert.equal(taskTabIdentityConsistent("secret", original), true);

  const stale = { ...original, taskId: "destination-task", sessionId: "destination-session" };
  assert.equal(taskTabIdentityConsistent("secret", stale), false);

  const rebuilt = {
    ...stale,
    ...rebuildTaskTabIdentity("secret", stale, {
      taskId: "destination-task",
      sessionId: "destination-session",
      leaseId: "destination-lease",
      profileInstanceId: "profile-1",
      generation: "generation-1",
      tabId: 42,
    }),
  };
  assert.equal(taskTabIdentityConsistent("secret", rebuilt), true);
  assert.equal(rebuilt.targetIdentity.taskId, "destination-task");
  assert.equal(rebuilt.targetIdentity.sessionId, "destination-session");
  assert.equal(rebuilt.targetIdentity.leaseId, "destination-lease");
  assert.notEqual(rebuilt.targetFingerprint, original.targetFingerprint);
});
