import { createHash } from "node:crypto";
import { lstat, readFile, realpath } from "node:fs/promises";
import { homedir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { CompanionError } from "./errors.mjs";

const RECEIPT_SCHEMA = "codex_hookless_handoff_receipt.v1";
const MAX_RECEIPT_BYTES = 1024 * 1024;
const SAFE_TASK_ID = /^[A-Za-z0-9._:-]{1,200}$/u;

function fail(code, message, details = undefined) {
  throw new CompanionError(code, message, details);
}

export function resolveHandoffReceiptsDir(env = process.env) {
  return resolve(env.AOS_CHROME_COMPANION_HANDOFF_RECEIPTS_DIR
    ?? join(homedir(), ".codex", "project-state-ledger", "handoff-receipts"));
}

export async function readHandoffSourceGate({ taskId, receiptsDir = resolveHandoffReceiptsDir() }) {
  if (!SAFE_TASK_ID.test(String(taskId ?? ""))) {
    fail("handoff_task_identity_invalid", "Handoff source task ID must be a bounded safe identifier");
  }
  const configuredRoot = resolve(receiptsDir);
  let rootStat;
  let root;
  try {
    rootStat = await lstat(configuredRoot);
    root = await realpath(configuredRoot);
  } catch (error) {
    if (error?.code === "ENOENT") return { implementationAllowed: true, sourceStatus: "active", destinationTaskId: null };
    fail("handoff_receipts_root_unavailable", "Hookless handoff receipt root is unavailable");
  }
  if (!rootStat.isDirectory() || rootStat.isSymbolicLink()) {
    fail("handoff_receipts_root_unsafe", "Hookless handoff receipt root must be a non-symlink directory");
  }
  const target = join(configuredRoot, `${taskId}.json`);
  let stat;
  let canonicalTarget;
  let raw;
  try {
    stat = await lstat(target);
    canonicalTarget = await realpath(target);
    raw = await readFile(target, "utf8");
  } catch (error) {
    if (error?.code === "ENOENT") return { implementationAllowed: true, sourceStatus: "active", destinationTaskId: null };
    fail("handoff_receipt_unavailable", "Hookless handoff receipt is unavailable");
  }
  if (!stat.isFile() || stat.isSymbolicLink() || dirname(canonicalTarget) !== root
    || basename(canonicalTarget) !== `${taskId}.json` || stat.size > MAX_RECEIPT_BYTES || (stat.mode & 0o077) !== 0) {
    fail("handoff_source_gate_invalid", "Existing source handoff gate is not a safe private receipt");
  }
  let receipt;
  try {
    receipt = JSON.parse(raw);
  } catch {
    fail("handoff_source_gate_invalid", "Existing source handoff gate is not valid JSON");
  }
  const cancelled = receipt?.schema === RECEIPT_SCHEMA
    && receipt.source_thread_id === taskId
    && typeof receipt.destination_thread_id === "string"
    && receipt.destination_thread_id.length > 0
    && receipt.status === "cancelled_by_user"
    && receipt.source_status === "active"
    && receipt.implementation_allowed === true
    && receipt.source_task_archived === false
    && receipt.source_task_visible === true
    && receipt.cancellation_evidence?.user_requested === true
    && receipt.cancellation_evidence?.destination_state === "idle_interrupted"
    && receipt.cancellation_evidence?.external_effect_state === "observed_false";
  if (cancelled) {
    return {
      implementationAllowed: true,
      sourceStatus: "active",
      destinationTaskId: receipt.destination_thread_id,
      handoffSuppressed: true,
      handoffSuppressionReason: "cancelled_by_user",
      receiptSha256: createHash("sha256").update(raw).digest("hex"),
    };
  }
  const blocked = receipt?.schema === RECEIPT_SCHEMA
    && receipt.source_thread_id === taskId
    && typeof receipt.destination_thread_id === "string"
    && receipt.destination_thread_id.length > 0
    && receipt.implementation_allowed === false
    && ["reconciliation_only", "handoff_completed"].includes(receipt.source_status)
    && ["reconciliation_required", "completed"].includes(receipt.status)
    && receipt.source_task_archived === false
    && receipt.source_task_visible === true;
  if (!blocked) {
    fail("handoff_source_gate_invalid", "Existing source handoff receipt does not satisfy the fail-closed source gate contract");
  }
  return {
    implementationAllowed: false,
    sourceStatus: receipt.source_status,
    destinationTaskId: receipt.destination_thread_id,
    receiptSha256: createHash("sha256").update(raw).digest("hex"),
  };
}

export async function validateHandoffReceipt({
  receiptPath,
  receiptsDir = resolveHandoffReceiptsDir(),
  sourceTaskId,
  destinationTaskId,
}) {
  if (!SAFE_TASK_ID.test(String(sourceTaskId ?? "")) || !SAFE_TASK_ID.test(String(destinationTaskId ?? ""))) {
    fail("handoff_task_identity_invalid", "Handoff source and destination task IDs must be bounded safe identifiers");
  }
  const configuredRoot = resolve(receiptsDir);
  let rootStat;
  let root;
  try {
    rootStat = await lstat(configuredRoot);
    root = await realpath(configuredRoot);
  } catch {
    fail("handoff_receipts_root_unavailable", "Hookless handoff receipt root is unavailable");
  }
  if (!rootStat.isDirectory() || rootStat.isSymbolicLink()) {
    fail("handoff_receipts_root_unsafe", "Hookless handoff receipt root must be a non-symlink directory");
  }
  const target = resolve(String(receiptPath ?? ""));
  const expectedName = `${sourceTaskId}.json`;
  if (dirname(target) !== configuredRoot || basename(target) !== expectedName) {
    fail("handoff_receipt_path_invalid", "Handoff receipt must be the exact source-bound file inside the configured receipt root");
  }
  let stat;
  let canonicalTarget;
  let raw;
  try {
    stat = await lstat(target);
    canonicalTarget = await realpath(target);
    raw = await readFile(target, "utf8");
  } catch {
    fail("handoff_receipt_unavailable", "Hookless handoff receipt is unavailable");
  }
  if (!stat.isFile() || stat.isSymbolicLink() || dirname(canonicalTarget) !== root || basename(canonicalTarget) !== expectedName || stat.size > MAX_RECEIPT_BYTES) {
    fail("handoff_receipt_unsafe", "Handoff receipt must be a bounded canonical regular non-symlink file");
  }
  if ((stat.mode & 0o077) !== 0) {
    fail("handoff_receipt_permissions_unsafe", "Handoff receipt must not be accessible by group or other users");
  }
  let receipt;
  try {
    receipt = JSON.parse(raw);
  } catch {
    fail("handoff_receipt_json_invalid", "Handoff receipt is not valid JSON");
  }
  const valid = receipt?.schema === RECEIPT_SCHEMA
    && receipt.source_thread_id === sourceTaskId
    && receipt.destination_thread_id === destinationTaskId
    && receipt.implementation_allowed === false
    && ["reconciliation_only", "handoff_completed"].includes(receipt.source_status)
    && ["reconciliation_required", "completed"].includes(receipt.status)
    && typeof receipt.packet_content_sha256 === "string"
    && /^[a-f0-9]{64}$/u.test(receipt.packet_content_sha256)
    && receipt.source_task_archived === false
    && receipt.source_task_visible === true;
  if (!valid) {
    fail("handoff_receipt_contract_mismatch", "Handoff receipt does not authorize this exact source-to-destination transfer");
  }
  return {
    receipt,
    receiptPath: target,
    receiptSha256: createHash("sha256").update(raw).digest("hex"),
  };
}
