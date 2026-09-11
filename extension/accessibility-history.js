const fail = code => Object.assign(new Error('Read a new accessibility snapshot for this exact task, session and document'), { code });
const ownerKey = context => JSON.stringify([context.taskId, context.sessionId, context.generation, context.tabId]);
const documentKey = snapshot => JSON.stringify([snapshot.url, snapshot.documentLoaderId, snapshot.cdpFrameId, snapshot.framePath]);

/** Short-lived, redacted AX snapshots. Indices are local to one snapshot. */
export class AccessibilityHistory {
  constructor({ now = () => Date.now(), id = () => crypto.randomUUID(), limit = 16, ttlMs = 300000 } = {}) {
    Object.assign(this, { now, id, limit, ttlMs }); this.records = new Map();
  }
  clear() { this.records.clear(); }
  closeSession(sessionId, generation) {
    for (const [key, value] of this.records) if (value.sessionId === sessionId && value.generation === generation) this.records.delete(key);
  }
  capture(snapshot, context, sinceSnapshotId) {
    if (![context.taskId, context.sessionId, context.generation].every(value => typeof value === 'string' && value)
      || !Number.isSafeInteger(context.tabId)) throw fail('accessibility_owner_required');
    const now = this.now();
    for (const [key, value] of this.records) if (value.expiresAt <= now) this.records.delete(key);
    const previous = sinceSnapshotId ? this.records.get(sinceSnapshotId) : null;
    if (sinceSnapshotId && (!previous || previous.owner !== ownerKey(context))) throw fail('accessibility_baseline_unavailable');
    if (previous && previous.document !== documentKey(snapshot)) throw fail('accessibility_document_changed');
    if (previous && previous.options !== JSON.stringify([snapshot.depth, snapshot.maxNodes, snapshot.includeIgnored])) throw fail('accessibility_options_changed');
    const nodes = snapshot.nodes.map((node, index) => ({ ...node, index: index + 1 }));
    const snapshotId = this.id(), expiresAt = now + this.ttlMs;
    const result = { ...snapshot, nodes, snapshotId, expiresAt, indicesAreSnapshotLocal: true, indexBase: 1,
      indexActionsSupported: false };
    if (previous) {
      const before = new Map(previous.nodes.map(node => [node.nodeId, node]));
      const after = new Map(nodes.map(node => [node.nodeId, node]));
      const added = nodes.filter(node => !before.has(node.nodeId));
      const removedNodeIds = previous.nodes.filter(node => !after.has(node.nodeId)).map(node => node.nodeId);
      const changed = nodes.filter(node => before.has(node.nodeId) && JSON.stringify(before.get(node.nodeId)) !== JSON.stringify(node));
      result.kind = 'native_accessibility_diff'; delete result.nodes;
      result.diff = { baselineSnapshotId: sinceSnapshotId, added, removedNodeIds, changed,
        unchangedCount: nodes.length - added.length - changed.length,
        complete: !previous.truncated && !snapshot.truncated,
        ...(previous.truncated || snapshot.truncated ? { limitation: 'Changes outside the bounded snapshots are not observed' } : {}) };
    }
    while (this.records.size >= this.limit) this.records.delete(this.records.keys().next().value);
    this.records.set(snapshotId, { owner: ownerKey(context), document: documentKey(snapshot),
      options: JSON.stringify([snapshot.depth, snapshot.maxNodes, snapshot.includeIgnored]),
      sessionId: context.sessionId, generation: context.generation, expiresAt, nodes: structuredClone(nodes), truncated: snapshot.truncated });
    return result;
  }
}
