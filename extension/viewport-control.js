const error = (code, message, details = {}) => Object.assign(new Error(message), { code,
  details: { operationEffectState: 'none', mutationDispatchAttempted: false, ...details } });
const ownerKey = context => JSON.stringify([context.taskId, context.sessionId, context.generation]);
const viewport = value => ({ width: value.width, height: value.height, devicePixelRatio: value.devicePixelRatio, scale: value.scale });

export function validateViewportOptions(options) {
  if (!['set', 'restore'].includes(options.action)) throw error('viewport_options_invalid', 'Choose set or restore');
  if (options.action === 'restore') return { action: 'restore' };
  const { width, height } = options, deviceScaleFactor = options.deviceScaleFactor ?? 1, durationMs = options.durationMs ?? 300000;
  if (!Number.isSafeInteger(width) || width < 200 || width > 3840 || !Number.isSafeInteger(height) || height < 200 || height > 2160
    || !Number.isFinite(deviceScaleFactor) || deviceScaleFactor < 0.5 || deviceScaleFactor > 3
    || width * height * deviceScaleFactor ** 2 > 16777216
    || !Number.isSafeInteger(durationMs) || durationMs < 1000 || durationMs > 1800000) {
    throw error('viewport_options_invalid', 'Use 200–3840 by 200–2160 CSS pixels, density 0.5–3, at most 16 megapixels, and duration 1–1800 seconds');
  }
  return { action: 'set', width, height, deviceScaleFactor, durationMs };
}

/** Owns only this Companion task's temporary CDP metrics override. */
export class ViewportControls {
  constructor({ pool, sendCommand, readViewport, now = () => Date.now(),
    schedule = (...args) => globalThis.setTimeout(...args), cancel = id => globalThis.clearTimeout(id), onError = () => {} }) {
    Object.assign(this, { pool, sendCommand, readViewport, now, schedule, cancel, onError });
    this.records = new Map();
  }
  assertOwner(record, context) {
    if (!record || record.owner !== ownerKey(context)) throw error('viewport_not_owned', 'This temporary viewport belongs to a different task/session/generation');
  }
  enqueue(record, operation) {
    const run = record.tail.catch(() => {}).then(operation); record.tail = run; return run;
  }
  async configure(tabId, context, options) {
    const validated = validateViewportOptions(options);
    if (![context.taskId, context.sessionId, context.generation].every(value => typeof value === 'string' && value)) throw error('viewport_owner_required', 'Use the broker-bound task/session/generation');
    let record = this.records.get(tabId);
    if (record) this.assertOwner(record, context);
    if (validated.action === 'restore') {
      if (!record) return { restored: true, overrideActive: false, alreadyRestored: true, tabId, viewport: viewport(await this.readViewport(tabId)) };
      record.closing = true;
      return this.enqueue(record, () => this.restoreRecord(record, 'explicit_restore'));
    }
    if (record?.closing) throw error('viewport_restore_pending', 'Wait for this task viewport restoration before setting it again');
    if (!record) {
      if (this.records.size >= 8) throw error('viewport_capacity', 'Restore an owned viewport before configuring another');
      record = { tabId, owner: ownerKey(context), taskId: context.taskId, sessionId: context.sessionId, generation: context.generation,
        tail: Promise.resolve(), lease: null, baseline: null, applied: false, timer: null, closing: false };
      this.records.set(tabId, record);
    }
    return this.enqueue(record, async () => {
      let dispatched = false;
      try {
        if (record.closing) throw error('viewport_cancelled', 'The owning session closed before viewport dispatch');
        record.lease ??= await this.pool.acquire(tabId);
        if (record.closing) throw error('viewport_cancelled', 'The owning session closed before viewport dispatch');
        const before = await this.readViewport(tabId);
        if (!before.pageInstanceId || (context.pageInstanceId && context.pageInstanceId !== before.pageInstanceId)) throw error('viewport_document_changed', 'The signed document changed before viewport dispatch');
        record.baseline ??= viewport(before);
        if (record.closing) throw error('viewport_cancelled', 'The owning session closed before viewport dispatch');
        dispatched = true; record.applied = true;
        await this.sendCommand(record.lease.target, 'Emulation.setDeviceMetricsOverride', {
          width: validated.width, height: validated.height, deviceScaleFactor: validated.deviceScaleFactor, mobile: false,
          // Keep the host view size intact so hidden tabs restore when the
          // metrics override is cleared, without activating or resizing them.
          dontSetVisibleSize: true });
        const after = await this.readViewport(tabId);
        if (after.pageInstanceId !== before.pageInstanceId || after.url !== before.url) throw error('viewport_document_changed', 'The page changed while viewport settings were applied');
        if (Math.abs(after.width - validated.width) > 1 || Math.abs(after.height - validated.height) > 1
          || Math.abs(after.devicePixelRatio - validated.deviceScaleFactor) > 0.01) throw error('viewport_readback_failed', 'Chrome did not expose the requested viewport metrics');
        if (record.timer) this.cancel(record.timer);
        record.expiresAt = this.now() + validated.durationMs;
        record.timer = this.schedule(() => { record.closing = true; void this.enqueue(record, () => this.restoreRecord(record, 'duration_elapsed')).catch(this.onError); }, validated.durationMs);
        return { configured: true, overrideActive: true, tabId, viewport: viewport(after), baseline: record.baseline,
          expiresAt: record.expiresAt, url: after.url, pageInstanceId: after.pageInstanceId, freshVisualProofRequired: true };
      } catch (cause) {
        record.closing = true;
        let restoration;
        try { restoration = await this.restoreRecord(record, 'set_failed'); }
        catch (cleanupError) { restoration = { restored: false, exactBlocker: cleanupError.code ?? 'viewport_restore_unknown' }; }
        throw error(cause.code ?? 'viewport_configuration_failed', cause.message, { mutationDispatchAttempted: dispatched,
          operationEffectState: dispatched ? 'unknown' : 'none', restoration });
      }
    });
  }
  async restoreRecord(record, reason) {
    if (record.timer) this.cancel(record.timer); record.timer = null;
    if (record.applied && !record.discarded) {
      await this.sendCommand(record.lease.target, 'Emulation.clearDeviceMetricsOverride', {});
      record.applied = false;
    }
    const release = record.lease ? await record.lease.release() : { detached: true, reason: 'never_attached' };
    let current;
    if (!record.discarded) current = await this.readViewport(record.tabId);
    if (this.records.get(record.tabId) === record) this.records.delete(record.tabId);
    return { restored: true, overrideActive: false, tabId: record.tabId, reason, debuggerRelease: release,
      ...(current ? { viewport: viewport(current), matchesInitialViewport: JSON.stringify(viewport(current)) === JSON.stringify(record.baseline) } : {}),
      freshVisualProofRequired: true };
  }
  async stopForSession(sessionId, generation) {
    const records = [...this.records.values()].filter(r => r.sessionId === sessionId && r.generation === generation);
    for (const record of records) record.closing = true;
    const results = await Promise.allSettled(records.map(record => this.enqueue(record, () => this.restoreRecord(record, 'session_closed'))));
    for (const result of results) if (result.status === 'rejected') this.onError(result.reason);
    return results;
  }
  async stopAll(reason) {
    const records = [...this.records.values()];
    for (const record of records) record.closing = true;
    const results = await Promise.allSettled(records.map(record => this.enqueue(record, () => this.restoreRecord(record, reason))));
    for (const result of results) if (result.status === 'rejected') this.onError(result.reason);
    return results;
  }
  async tabRemoved(tabId, reason = 'tab_removed') {
    const record = this.records.get(tabId); if (!record) return;
    record.closing = true;
    record.discarded = reason;
    // Chrome has already discarded the target-specific override.
    record.applied = false;
    return this.enqueue(record, () => this.restoreRecord(record, reason));
  }
}
