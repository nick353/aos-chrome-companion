import assert from "node:assert/strict";
import { chmod, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { readHandoffSourceGate, validateHandoffReceipt } from "../src/shared/handoff-receipt.mjs";

function receipt(destination = "destination-task") {
  return {
    schema: "codex_hookless_handoff_receipt.v1",
    status: "completed",
    source_status: "handoff_completed",
    implementation_allowed: false,
    source_thread_id: "source-task",
    destination_thread_id: destination,
    packet_content_sha256: "b".repeat(64),
    source_task_archived: false,
    source_task_visible: true,
  };
}

test("validates an exact private source-bound hookless handoff receipt", async () => {
  const root = await mkdtemp(join(tmpdir(), "aos-handoff-receipt-"));
  await chmod(root, 0o700);
  try {
    const path = join(root, "source-task.json");
    await writeFile(path, `${JSON.stringify(receipt())}\n`, { mode: 0o600 });
    const result = await validateHandoffReceipt({
      receiptPath: path,
      receiptsDir: root,
      sourceTaskId: "source-task",
      destinationTaskId: "destination-task",
    });
    assert.equal(result.receipt.source_status, "handoff_completed");
    assert.match(result.receiptSha256, /^[a-f0-9]{64}$/u);
    const sourceGate = await readHandoffSourceGate({ taskId: "source-task", receiptsDir: root });
    assert.equal(sourceGate.implementationAllowed, false);
    assert.equal(sourceGate.destinationTaskId, "destination-task");
    const absentGate = await readHandoffSourceGate({ taskId: "not-a-source", receiptsDir: root });
    assert.equal(absentGate.implementationAllowed, true);

    await assert.rejects(validateHandoffReceipt({
      receiptPath: path,
      receiptsDir: root,
      sourceTaskId: "source-task",
      destinationTaskId: "another-task",
    }), (error) => error.code === "handoff_receipt_contract_mismatch");

    const outside = join(root, "outside.json");
    await writeFile(outside, `${JSON.stringify(receipt())}\n`, { mode: 0o600 });
    const link = join(root, "source-task-link.json");
    await symlink(outside, link);
    await assert.rejects(validateHandoffReceipt({
      receiptPath: link,
      receiptsDir: root,
      sourceTaskId: "source-task-link",
      destinationTaskId: "destination-task",
    }), (error) => ["handoff_receipt_unsafe", "handoff_receipt_contract_mismatch"].includes(error.code));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("a user-cancelled handoff reactivates only the exact source task", async () => {
  const root = await mkdtemp(join(tmpdir(), "aos-handoff-cancelled-"));
  await chmod(root, 0o700);
  try {
    const cancelled = {
      ...receipt(),
      status: "cancelled_by_user",
      source_status: "active",
      implementation_allowed: true,
      cancellation_evidence: {
        user_requested: true,
        destination_state: "idle_interrupted",
        external_effect_state: "observed_false",
      },
    };
    await writeFile(join(root, "source-task.json"), `${JSON.stringify(cancelled)}\n`, { mode: 0o600 });
    const gate = await readHandoffSourceGate({ taskId: "source-task", receiptsDir: root });
    assert.equal(gate.implementationAllowed, true);
    assert.equal(gate.sourceStatus, "active");
    assert.equal(gate.handoffSuppressed, true);
    assert.equal(gate.handoffSuppressionReason, "cancelled_by_user");
    assert.equal(gate.destinationTaskId, "destination-task");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
