import { randomBytes } from "node:crypto";
import { mkdirSync, readdirSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { resolveDataDir } from "../shared/paths.mjs";

const fields = (value, names) => Object.fromEntries(names.filter(name => Object.hasOwn(value ?? {}, name)).map(name => [name, value[name]]));

// Screenshots are also kept as files for a while, so a task can hand the very screen it saw to a
// second reader (AOS's aos_check_screen: Claude looks before a button that cannot be taken back,
// 2026-10-18). Only the newest 200 and none older than two days stay. Test runs keep none unless a
// folder is named.
const SCREENSHOT_KEEP = 200;
const SCREENSHOT_MAX_AGE_MS = 2 * 24 * 3600_000;
export function defaultScreenshotDir(env = process.env) {
  return env.AOS_CHROME_COMPANION_SCREENSHOT_DIR ?? (env.NODE_TEST_CONTEXT ? null : join(resolveDataDir(env), "screenshots"));
}

// The task's session goes into the name ("s" + its first 8 hex digits), so the screens one run saw can
// be found again from the session ids in its steps (AOS's check of a finished run).
export function sessionTag(sessionId) {
  const m = /^session_([0-9a-f]{8})/.exec(String(sessionId ?? ""));
  return m ? `s${m[1]}` : null;
}

export function saveScreenshot(dataBase64, mimeType, dir, now = Date.now(), tag = null) {
  try {
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    const ext = /png/.test(mimeType) ? "png" : /webp/.test(mimeType) ? "webp" : "jpg";
    const label = /^s[0-9a-f]{8}$/.test(tag ?? "") ? `${tag}-` : "";
    const path = join(dir, `shot-${now}-${label}${randomBytes(3).toString("hex")}.${ext}`);
    writeFileSync(path, Buffer.from(dataBase64, "base64"), { mode: 0o600 });
    // Names start with the time, so they sort oldest first.
    const shots = readdirSync(dir).filter(name => /^shot-\d+-/.test(name)).sort();
    shots.forEach((name, index) => {
      if (shots.length - index > SCREENSHOT_KEEP || now - Number(name.split("-")[1]) > SCREENSHOT_MAX_AGE_MS) {
        try { unlinkSync(join(dir, name)); } catch { /* already gone */ }
      }
    });
    return path;
  } catch {
    return null; // a full or unwritable disk must not break the screenshot itself
  }
}

// The native MCP structured result remains complete for existing callers.
// Text-only clients can request the legacy full JSON with responseDetail:full.
export function transactionTextSummary(value) {
  if (value?.schema !== 'aos.chrome_companion.transaction.v1') return value;
  const summary = fields(value, ['schema', 'result', 'outcome', 'run_id', 'task_id', 'profile', 'tab',
    'pre', 'post', 'frames', 'effect_state', 'effect_state_scope', 'dispatch_count',
    'completed_mutation_count', 'browser_mutation_executed', 'external_action_executed',
    'external_action_dispatched', 'potential_external_effect', 'external_effect_confirmation',
    'failed_step', 'action_progress', 'action_event', 'event_wait', 'trigger_continuation', 'exact_blocker', 'reconciliation', 'continuation', 'continuation_required',
    'block_scope', 'affected_target', 'independent_work_allowed', 'next_action',
    'cleanup', 'lease_state', 'next_target_read', 'visual_readback', 'artifacts', 'completed_at']);
  for (const key of ['actions', 'applied_actions']) {
    if (Array.isArray(value[key])) summary[key] = value[key].map(action => fields(action,
      ['index', 'method', 'result', 'mutation', 'effectClass', 'reconciliationRequired',
        'visual_target_proof_verified', 'dropdown_visual_proof_verified']));
  }
  if (value.capsule) summary.capsule = fields(value.capsule,
    ['capsuleId', 'state', 'target', 'blocker', 'restartPoint', 'resumeToken', 'retention', 'completion']);
  if (value.timings_ms) summary.timings_ms = { total: value.timings_ms.total };
  if (value.result !== 'verified' && value.target_resolution) summary.target_resolution = value.target_resolution;
  if (value.stale_generation_cleanup) {
    const cleanup = value.stale_generation_cleanup;
    // Preserve every warning or affected target; omit an entirely empty sweep.
    if (cleanup.examined > 0 || Object.values(cleanup).some(item => Array.isArray(item) && item.length > 0)) summary.stale_generation_cleanup = cleanup;
  }
  summary.response_detail = 'summary';
  summary.full_result_available_in = 'structuredContent.result';
  return summary;
}

/** Keep browser evidence small and expose screenshots as native MCP images. */
export function toolResult(value, { textDetail = 'full', detail = 'full', screenshotDir = null, screenshotTag = null } = {}) {
  const images = [];
  const seen = new Map(); // picture → the file it was saved to (null when not saved)
  function visit(item) {
    if (Array.isArray(item)) return item.map(visit);
    if (!item || typeof item !== 'object') return item;
    const screenshot = item.kind === 'screenshot' && typeof item.dataBase64 === 'string' && typeof item.mimeType === 'string';
    if (screenshot && !seen.has(item.dataBase64)) {
      seen.set(item.dataBase64, screenshotDir ? saveScreenshot(item.dataBase64, item.mimeType, screenshotDir, Date.now(), screenshotTag) : null);
      images.push({ type: 'image', data: item.dataBase64, mimeType: item.mimeType });
    }
    const savedPath = screenshot ? seen.get(item.dataBase64) : null;
    const kept = Object.entries(item).filter(([key]) => !(screenshot && key === 'dataBase64')).map(([key, entry]) => [key, visit(entry)]);
    return Object.fromEntries(savedPath ? [...kept, ['savedPath', savedPath]] : kept);
  }
  const metadata = visit(value);
  if (metadata?.visual_readback_verified === true && metadata?.visualProof
    && metadata.visualProof.supported !== false && metadata.supported !== false && metadata.supported !== null) {
    metadata.proof_usage = {
      lease_state: 'reserved',
      keep_lease_until_transaction: true,
      next_tool: 'companion_authorized_transaction',
      after_lease_release: 'discard_this_proof_and_inspect_again_with_a_fresh_lease',
    };
  }
  if (metadata?.schema === 'aos.chrome_companion.transaction.v1') {
    // A successful browser dispatch is not a provider receipt. Keep the broker's
    // conservative no-replay classification; project external evidence honestly.
    const evidence = [...(metadata.actions ?? []), ...(metadata.applied_actions ?? [])];
    const risk = evidence.some(action => action.step_packet?.reconciliation_required === true || action.reconciliationRequired === true)
      || metadata.reconciliation != null;
    const dispatched = metadata.external_action_executed === true || evidence.some(action => action.mutation === true || metadata.step_packets?.some(step => step.index === action.index && step.mutation === true));
    metadata.browser_mutation_executed = metadata.effect_state === 'unknown_effect' ? null : dispatched;
    metadata.external_action_dispatched = risk && (dispatched || metadata.effect_state === 'unknown_effect');
    metadata.potential_external_effect = risk;
    metadata.external_effect_confirmation = risk ? 'not_verified' : 'not_applicable';
    metadata.effect_state_scope = 'browser_operation';
    metadata.external_action_executed = risk ? null : false;
    if (metadata.capsule?.effect) {
      metadata.capsule.effect.browserMutationExecuted = metadata.browser_mutation_executed;
      metadata.capsule.effect.externalActionExecuted = metadata.external_action_executed;
    }
    if (metadata.cleanup?.lease_released === true) {
      metadata.lease_state = 'released';
      const sessionId = metadata.capsule?.target?.sessionId;
      if (metadata.cleanup.retained === true && sessionId && Number.isSafeInteger(metadata.tab?.id)) {
        metadata.next_target_read = {
          tool: 'companion_reserve_tab',
          arguments: { sessionId, tabId: metadata.tab.id },
          then: 'read_or_inspect_the_same_target_with_the_returned_lease',
        };
      }
    }
  }
  if (metadata?.schema === 'aos.chrome_companion.transaction.v1') {
    if (detail === 'compact') compactTransaction(metadata);
    metadata.detail = detail === 'compact' ? 'compact' : 'full';
  }
  const textValue = textDetail === 'summary' ? transactionTextSummary(metadata) : metadata;
  // The proof goes first, before the picture: a run that prints the whole result got it cut off
  // after the image data and copied the proof by hand with typos (2026-10-19, Threads replies).
  const proofFirst = metadata?.visualProof?.proofId
    ? [{ type: 'text', text: JSON.stringify({ proofId: metadata.visualProof.proofId,
      use: 'pass visualProof: { proofId } (or the whole visualProof unchanged) to one visual.* action', visualProof: metadata.visualProof }) }]
    : [];
  return { content: [...proofFirst, ...images, { type: 'text', text: JSON.stringify(textValue) }], structuredContent: { result: metadata } };
}

function compactTransaction(metadata) {
  // Preserve each result, image, proof, blocker, and resume argument. The
  // repeated signed target metadata remains available when detail=full is
  // requested; normal actions do not need to echo it at every nesting level.
  const stepCount = metadata.step_packets?.length;
  const preconditionCount = metadata.action_preconditions?.length;
  if (stepCount !== undefined || preconditionCount !== undefined) {
    metadata.verification = { signed_steps: stepCount ?? 0, checked_targets: preconditionCount ?? 0 };
  }
  delete metadata.step_packets;
  delete metadata.action_preconditions;
  for (const action of metadata.actions ?? []) {
    if (action.step_packet) {
      action.effect_class = action.step_packet.effect_class;
      action.reconciliation_required = action.step_packet.reconciliation_required === true;
      delete action.step_packet;
    }
  }
  const capsule = metadata.capsule;
  if (capsule) {
    const kept = ['schema', 'capsuleId', 'workflowType', 'taskId', 'runId', 'state', 'target', 'resources', 'effect',
      'blocker', 'restartPoint', 'resumeToken', 'completion', 'retention', 'updatedAt'];
    metadata.capsule = Object.fromEntries(kept.filter(key => capsule[key] !== undefined).map(key => [key, capsule[key]]));
  }
}

export function taskStatus(result, taskId, detail = 'task') {
  if (detail === 'all') return { ...result, detail };
  const owns = entry => entry?.taskId === taskId || entry?.ownerTaskId === taskId;
  const filtered = { ...result, detail };
  for (const field of ['logicalSessions', 'exactTabLeases', 'pendingOperations', 'taskTabs', 'recoveryHandles', 'handoffAcks']) {
    filtered[field] = (result[field] ?? []).filter(owns);
  }
  if (result.recovery) filtered.recovery = { ...result.recovery, tasks: (result.recovery.tasks ?? []).filter(owns) };
  filtered.inventoryScope = 'current_task; global counts remain profile-wide';
  return filtered;
}
