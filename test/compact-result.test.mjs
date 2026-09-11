import test from 'node:test';
import assert from 'node:assert/strict';
import { toolResult } from '../src/mcp/result.mjs';

function transaction(result = 'verified') {
  const target = { taskId: 'owner', sessionId: 'session', leaseId: 'lease', tabId: 77, pageInstanceId: 'document', generation: 'generation', profileInstanceId: 'profile', origin: 'https://example.test' };
  const steps = Array.from({ length: 10 }, (_, index) => ({ index, target_identity: target, target_fingerprint: 'f'.repeat(64), effect_class: 'local_ui', reconciliation_required: false, mutation: true }));
  return { schema: 'aos.chrome_companion.transaction.v1', result, effect_state: result === 'verified' ? 'known_effect' : 'unknown_effect',
    step_packets: steps, actions: steps.map(step => ({ index: step.index, method: 'page.type', result: { typed: true, inputValueVerified: true }, step_packet: step })),
    action_preconditions: steps.map(step => ({ index: step.index, target_state_digest: 'd'.repeat(64) })),
    cleanup: { retained: true, lease_released: true }, tab: { id: 77 }, capsule: { capsuleId: 'capsule', state: 'completed', target, effect: {}, resources: { tabId: 77 }, visual: { proof: { repeated: target } }, execution: { provider: 'companion' } },
    action_progress: { applied_action_indices: [0], uncertain_action_indices: [1], remaining_action_indices: [2], replay_allowed: false },
    outcome: { provider_completion: 'unverified', replay_allowed: false },
    exact_blocker: result === 'verified' ? null : { code: 'operation_effect_unknown', message: 'Read the same target' },
    reconciliation: result === 'verified' ? null : { capsule_id: 'capsule', idempotency_key: 'operation' },
    visual_readback: { kind: 'screenshot', dataBase64: 'image-fixture', mimeType: 'image/png' },
  };
}

test('compact results preserve actions, image, effect boundaries, and exact resume data', () => {
  const input = transaction();
  const original = JSON.stringify(input);
  const compact = toolResult(input, { detail: 'compact' });
  const full = toolResult(input, { detail: 'full' });
  const result = compact.structuredContent.result;
  assert.equal(JSON.stringify(input), original, 'formatting must not mutate the broker receipt');
  assert.equal(result.actions.length, 10);
  assert.equal(result.actions[0].result.inputValueVerified, true);
  assert.equal(result.outcome.provider_completion, 'unverified');
  assert.deepEqual(result.next_target_read.arguments, { sessionId: 'session', tabId: 77 });
  assert.equal(compact.content.filter(item => item.type === 'image').length, 1);
  assert.deepEqual(result.action_progress, input.action_progress);
  assert.equal(result.verification.signed_steps, 10);
  assert.equal(full.structuredContent.result.actions[0].step_packet.target_identity.tabId, 77);
  assert.ok(compact.content.at(-1).text.length < full.content.at(-1).text.length * 0.6);
});

test('compact failure results retain the blocker and unresolved action without a replay instruction', () => {
  const input = transaction('unknown_effect');
  const result = toolResult(input, { detail: 'compact' }).structuredContent.result;
  assert.deepEqual(result.exact_blocker, input.exact_blocker);
  assert.deepEqual(result.reconciliation, input.reconciliation);
  assert.deepEqual(result.action_progress.uncertain_action_indices, [1]);
  assert.equal(result.outcome.replay_allowed, false);
  assert.equal(result.browser_mutation_executed, null);
});

test('signed inspection proofs are returned unchanged by compact formatting', () => {
  const proof = { signature: 'opaque', pageInstanceId: 'document', viewport: { width: 1200, height: 800 } };
  const result = toolResult({ visualProof: proof, visual_readback_verified: true }).structuredContent.result;
  assert.deepEqual(result.visualProof, proof);
});
