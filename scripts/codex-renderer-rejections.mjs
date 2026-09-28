// Read-only rejected renderers are reconsidered on a new document, not on
// an endless timer. One warm-up retry accommodates the initial React mount.
export class RendererRejectionCache {
  constructor({ now = Date.now } = {}) {
    this.records = new Map();
    this.now = now;
  }

  get(id) { return this.records.get(id); }
  keys() { return this.records.keys(); }

  delete(id) {
    const record = this.records.get(id);
    if (!record) return;
    this.records.delete(id);
    record.removeListener?.();
    record.connection?.close();
  }

  clear() { for (const id of this.keys()) this.delete(id); }

  shouldProbe(id) {
    const record = this.get(id);
    return !record || this.now() >= record.retryAt;
  }

  remember(id, connection, details, allowWarmup) {
    const prior = this.get(id);
    const attempts = (prior?.attempts || 0) + 1;
    this.delete(id);
    const record = {
      ...details,
      attempts,
      connection,
      retryAt: allowWarmup && attempts < 2 ? this.now() + 3_000 : Infinity,
    };
    this.records.set(id, record);
    if (connection) {
      record.removeListener = connection.on("Runtime.executionContextsCleared", () => {
        if (this.get(id) === record) this.delete(id);
      });
    }
  }
}
