import assert from "node:assert/strict";
import { test } from "node:test";
import { RendererRejectionCache } from "../scripts/codex-renderer-rejections.mjs";

function connection() {
  const handlers = new Map();
  return {
    closed: false,
    on(method, listener) { handlers.set(method, listener); return () => handlers.delete(method); },
    emit(method) { handlers.get(method)?.(); },
    close() { this.closed = true; },
  };
}

test("a rejected initial document has only one warm-up retry", () => {
  let now = 0;
  const cache = new RendererRejectionCache({ now: () => now });
  const first = connection();
  cache.remember("MAIN", first, { reason: "not-ready" }, true);
  now = 2999;
  assert.equal(cache.shouldProbe("MAIN"), false);
  now = 3000;
  assert.equal(cache.shouldProbe("MAIN"), true);
  const second = connection();
  cache.remember("MAIN", second, { reason: "contract-missing" }, true);
  assert.equal(first.closed, true);
  now = 1_000_000;
  assert.equal(cache.shouldProbe("MAIN"), false);
  second.emit("Runtime.executionContextsCleared");
  assert.equal(second.closed, true);
  assert.equal(cache.shouldProbe("MAIN"), true);
  cache.clear();
});

test("auxiliary rejections after a ready main window wait for a new document", () => {
  const cache = new RendererRejectionCache();
  const rejected = connection();
  cache.remember("AUX", rejected, {}, false);
  assert.equal(cache.shouldProbe("AUX"), false);
  rejected.emit("Page.loadEventFired");
  assert.equal(cache.shouldProbe("AUX"), false);
  rejected.emit("Runtime.executionContextsCleared");
  assert.equal(cache.shouldProbe("AUX"), true);
});

test("removed targets and shutdown close every retained read-only observer", () => {
  const cache = new RendererRejectionCache();
  const first = connection(); const second = connection();
  cache.remember("A", first, {}, true);
  cache.remember("B", second, {}, false);
  cache.delete("A");
  assert.equal(first.closed, true);
  assert.equal(second.closed, false);
  cache.clear();
  assert.equal(second.closed, true);
  assert.deepEqual([...cache.keys()], []);
});
