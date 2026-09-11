import assert from "node:assert/strict";
import test from "node:test";
import { bindTransactionStep, compileTransactionSteps, STEP_PACKET_SCHEMA } from "../src/shared/step-packet.mjs";

test("transaction steps compile once with schema-derived effect metadata", () => {
  const [local, external, read] = compileTransactionSteps([
    { method: "page.type", params: { locator: { testId: "name" }, text: "A" } },
    { method: "page.submit", params: { locator: { testId: "submit" } } },
    { method: "page.snapshot", params: {} },
  ]);
  assert.equal(local.schema, STEP_PACKET_SCHEMA);
  assert.equal(local.mutation, true);
  assert.equal(local.effectClass, "local_ui");
  assert.equal(local.reconciliationRequired, false);
  assert.equal(external.effectClass, "external_commit");
  assert.equal(external.reconciliationRequired, true);
  assert.equal(read.mutation, false);
  assert.equal(read.authorized, false);
  assert.equal(Object.isFrozen(local), true);
});

test("a step packet binds the full live target identity", () => {
  const [step] = compileTransactionSteps([{ method: "page.click", params: { locator: { text: "Continue" } } }]);
  const bound = bindTransactionStep(step, {
    secret: "step-packet-secret",
    taskId: "task-1",
    sessionId: "session-1",
    leaseId: "lease-1",
    generation: "generation-1",
    profileInstanceId: "profile-1",
    tabId: 17,
    pageInstanceId: "document-1",
    windowId: 2,
    frameId: 3,
    origin: "https://example.test",
  });
  assert.equal(bound.targetIdentity.tabId, 17);
  assert.equal(bound.targetIdentity.pageInstanceId, "document-1");
  assert.equal(bound.targetIdentity.frameId, 3);
  assert.match(bound.targetFingerprint, /^[A-Za-z0-9_-]{43}$/u);
  assert.equal(Object.isFrozen(bound), true);
});
