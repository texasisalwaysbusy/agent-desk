import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { test } from "node:test";
import vm from "node:vm";

import { normalizeNativeModels, readNativeModelCatalog } from "../scripts/codex-model-catalog.mjs";
import { handleHostBindingPayload } from "../scripts/codex-injector-runtime.mjs";
import { requestNativeModelCatalog } from "../web/src/nativeModelCatalog.ts";
import { setEmbeddedFrameChallenge } from "../web/src/embeddedHost.mjs";

const nativeModel = (model, extra = {}) => ({
  id: `id-${model}`, model, displayName: model.toUpperCase(), description: "Official catalog model",
  defaultReasoningEffort: "medium",
  supportedReasoningEfforts: [{ reasoningEffort: "medium" }, { reasoningEffort: "high" }],
  ...extra,
});
const models = normalizeNativeModels([nativeModel("test-model")]);

test("native catalog normalizes documented fields only and excludes hidden or unusable entries", () => {
  const result = normalizeNativeModels([
    null, nativeModel("hidden", { hidden: true }), nativeModel("invalid", { supportedReasoningEfforts: [] }),
    nativeModel("test-model", {
      defaultReasoningEffort: "unknown", privateField: "must-not-cross-bridge",
      supportedReasoningEfforts: [{ reasoningEffort: "medium" }, { reasoningEffort: "medium" }, null],
    }),
  ]);
  assert.deepEqual(result, [{ ...models[0], supportedReasoningEfforts: ["medium"] }]);
  assert.equal(JSON.stringify(result).includes("must-not-cross-bridge"), false);
});

test("catalog paginates the read-only model/list method and preserves native default order", async () => {
  const calls = [];
  const result = await readNativeModelCatalog(async (...args) => {
    calls.push(args);
    return calls.length === 1
      ? { data: [nativeModel("other")], nextCursor: "page-two" }
      : { data: [nativeModel("preferred", { isDefault: true }), nativeModel("other")], nextCursor: null };
  }, { now: () => 100 });
  assert.deepEqual(calls, [
    ["model/list", { limit: 100, includeHidden: false }, 8_000],
    ["model/list", { limit: 100, includeHidden: false, cursor: "page-two" }, 8_000],
  ]);
  assert.deepEqual(result.models.map((model) => model.slug), ["preferred", "other"]);
});

test("invalid, empty, oversized and looping responses fail instead of returning partial catalogs", async () => {
  for (const response of [
    {}, { data: [] }, { data: [nativeModel("hidden", { hidden: true })] },
    { data: Array.from({ length: 101 }, () => nativeModel("too-many")) },
    { data: [nativeModel("valid")], nextCursor: {} },
    { data: [nativeModel("valid")], nextCursor: "loop" },
  ]) {
    await assert.rejects(readNativeModelCatalog(async () => response), /invalid|no selectable/);
  }
});

test("catalog enforces page and total time budgets and propagates native errors", async () => {
  let calls = 0;
  await assert.rejects(readNativeModelCatalog(async () => ({
    data: [nativeModel("partial")], nextCursor: `page-${++calls}`,
  })), /page limit/);
  assert.equal(calls, 10);
  const ticks = [0, 0, 8_001];
  await assert.rejects(readNativeModelCatalog(async () => ({ data: [], nextCursor: "next" }), {
    now: () => ticks.shift(),
  }), /timed out/);
  await assert.rejects(readNativeModelCatalog(async () => { throw new Error("native unavailable"); }), /native unavailable/);
});

test("model catalog binding requires authorized context and accepts no arbitrary RPC or extra fields", async () => {
  const responses = [];
  const calls = [];
  const handlers = {
    isAuthorizedContext: (id) => id === 12,
    readModelCatalog: async (request) => { calls.push(request.codexHostId); return { models }; },
    sendResponse: async (_id, response) => responses.push(response),
  };
  const base = { id: "model-request", action: "model-catalog", codexHostId: "local" };
  const send = (request, executionContextId = 12) => handleHostBindingPayload({
    payload: JSON.stringify(request), executionContextId,
  }, handlers);
  assert.deepEqual(await send(base, 99), { responded: false, accepted: false });
  assert.deepEqual(calls, []);
  for (const request of [
    { ...base, method: "thread/start" }, { ...base, params: {} },
    { ...base, codexHostId: "" }, { ...base, codexHostId: "x".repeat(241) },
    { ...base, codexHostId: "bad\nvalue" },
  ]) assert.equal((await send(request)).accepted, false);
  assert.deepEqual(calls, []);
  assert.ok(responses.every((response) => !response.ok));
  await send(base);
  assert.deepEqual(calls, ["local"]);
  assert.deepEqual(responses.at(-1), { id: base.id, ok: true, models });
});

function fakeFrame(t) {
  const original = globalThis.window;
  const originalCapability = globalThis.__CODEX_TASKBOARD_FRAME_CAPABILITY__;
  const listeners = new Set();
  const timers = new Map();
  const sent = [];
  globalThis.__CODEX_TASKBOARD_FRAME_CAPABILITY__ = "frame-capability";
  setEmbeddedFrameChallenge("frame-challenge");
  const parent = { postMessage: (message) => sent.push(message) };
  const window = {
    parent, crypto: { randomUUID: () => "request-1" },
    setTimeout: (callback) => { timers.set(1, callback); return 1; },
    clearTimeout: (id) => timers.delete(id),
    addEventListener: (_type, listener) => listeners.add(listener),
    removeEventListener: (_type, listener) => listeners.delete(listener),
  };
  globalThis.window = window;
  t.after(() => {
    if (original === undefined) delete globalThis.window;
    else globalThis.window = original;
    if (originalCapability === undefined) delete globalThis.__CODEX_TASKBOARD_FRAME_CAPABILITY__;
    else globalThis.__CODEX_TASKBOARD_FRAME_CAPABILITY__ = originalCapability;
    setEmbeddedFrameChallenge("");
  });
  const reply = (payload = {}, overrides = {}) => {
    const event = { source: parent, data: {
      type: "taskboard:model-catalog-response", challenge: "frame-challenge",
      payload: { requestId: "request-1", ok: true, models, ...payload },
    }, ...overrides };
    for (const listener of [...listeners]) listener(event);
  };
  return { sent, reply, listeners, timers, window };
}

test("frontend requires matching parent, challenge and request, then releases its listeners", async (t) => {
  const frame = fakeFrame(t);
  const pending = requestNativeModelCatalog("local", "frame-challenge", new AbortController().signal);
  assert.deepEqual(frame.sent, [{
    type: "taskboard:model-catalog-request", payload: { requestId: "request-1", codexHostId: "local" },
    capability: "frame-capability", challenge: "frame-challenge",
  }]);
  frame.reply({}, { source: {} });
  frame.reply({ requestId: "wrong-request" });
  frame.reply({}, { data: { type: "taskboard:model-catalog-response", challenge: "stale-challenge" } });
  assert.equal(frame.listeners.size, 1);
  frame.reply();
  assert.deepEqual(await pending, { models });
  assert.equal(frame.listeners.size, 0);
  assert.equal(frame.timers.size, 0);
});

test("frontend fails cleanly on native errors, malformed models, timeout, abort and unavailable bridge", async (t) => {
  const frame = fakeFrame(t);
  for (const payload of [{ ok: false, error: "native failed" }, { models: [] }, {
    models: [{ ...models[0], defaultReasoningEffort: "unsupported" }],
  }]) {
    const pending = requestNativeModelCatalog("local", "frame-challenge", new AbortController().signal);
    frame.reply(payload);
    await assert.rejects(pending, /native failed|invalid model/);
    assert.equal(frame.listeners.size, 0);
    assert.equal(frame.timers.size, 0);
  }
  const controller = new AbortController();
  const aborted = requestNativeModelCatalog("local", "frame-challenge", controller.signal);
  controller.abort();
  await assert.rejects(aborted, { name: "AbortError" });
  await assert.rejects(requestNativeModelCatalog("local", "frame-challenge", controller.signal), { name: "AbortError" });
  const timedOut = requestNativeModelCatalog("local", "frame-challenge", new AbortController().signal);
  frame.timers.get(1)();
  await assert.rejects(timedOut, /timed out/);
  assert.equal(frame.listeners.size, 0);
  assert.equal(frame.timers.size, 0);
  frame.window.parent = frame.window;
  await assert.rejects(requestNativeModelCatalog("local", "frame-challenge", new AbortController().signal), /unavailable/);
});

test("injected handler checks hosts and drops responses from a replaced document", async () => {
  const source = await readFile(new URL("../inject/codex-taskboard.user.js", import.meta.url), "utf8");
  const handler = source.slice(source.indexOf("  async function handleModelCatalogRequest("), source.indexOf("  function handleExternalOpen("));
  const sent = [];
  const calls = [];
  const context = vm.createContext({
    frameChallenge: "current-document", taskboardOrigin: "http://127.0.0.1:12345",
    isLocalTaskboardOrigin: () => true, readCodexProjects: () => [{ hostId: "remote-host" }],
    postToFrame: (message) => sent.push(JSON.parse(JSON.stringify(message))),
    requestHost: async (action, payload) => { calls.push([action, payload.codexHostId]); return { ok: true, models }; },
  });
  vm.runInContext(handler, context);
  await context.handleModelCatalogRequest({ requestId: "one", codexHostId: "unknown" });
  assert.equal(sent.at(-1).payload.ok, false);
  assert.deepEqual(calls, []);
  await context.handleModelCatalogRequest({ requestId: "two", codexHostId: "remote-host" });
  assert.deepEqual(calls, [["model-catalog", "remote-host"]]);
  assert.equal(sent.at(-1).challenge, "current-document");
  assert.deepEqual(sent.at(-1).payload.models, models);
  context.requestHost = async () => { context.frameChallenge = "next-document"; return { models }; };
  await context.handleModelCatalogRequest({ requestId: "three", codexHostId: "local" });
  assert.equal(sent.length, 2);
});

test("native catalog is bundled, contract-gated and independent of CLI spawning", async () => {
  const module = await readFile(new URL("../scripts/codex-model-catalog.mjs", import.meta.url), "utf8");
  const prepare = await readFile(new URL("../scripts/prepare-tauri-app.mjs", import.meta.url), "utf8");
  const injector = await readFile(new URL("../scripts/codex-injector.mjs", import.meta.url), "utf8");
  assert.doesNotMatch(module, /child_process|spawn|execFile|auth\.json|skills\/list/);
  assert.match(prepare, /"codex-model-catalog\.mjs"/);
  assert.match(injector, /readModelCatalog: async[\s\S]*?taskboardCompatibilityCapabilities\?\.taskNavigation[\s\S]*?readNativeModelCatalog/);
});
