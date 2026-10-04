import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { test } from "node:test";
import vm from "node:vm";
import { createHostHeartbeatPump, handleHostBindingPayload } from "../scripts/codex-injector-runtime.mjs";

const source = await readFile(new URL("../scripts/codex-injector.mjs", import.meta.url), "utf8");
const uiSource = await readFile(new URL("../inject/codex-taskboard.user.js", import.meta.url), "utf8");
const flush = async () => { for (let i = 0; i < 25; i++) await Promise.resolve(); };
function clock() {
  let now = 10000;
  let next = 0;
  const timers = new Map();
  return {
    now: () => now,
    schedule(fn, delay) { const id = ++next; timers.set(id, { at: now + delay, fn }); return id; },
    cancel(id) { timers.delete(id); },
    async advance(delay) {
      const end = now + delay;
      await flush();
      for (;;) {
        const pending = [...timers].filter(([, item]) => item.at <= end).sort((a, b) => a[1].at - b[1].at)[0];
        if (!pending) break;
        now = pending[1].at;
        timers.delete(pending[0]);
        pending[1].fn();
        await flush();
      }
      now = end;
      await flush();
    },
  };
}
function harness(hostSource = source) {
  const time = clock();
  const handlers = new Map();
  const calls = [];
  const pulses = [];
  let contextId = 7;
  let restored = 0;
  let worlds = 0;
  let holdWorld = null;
  let holdHeartbeat = null;
  let bindingException = false;
  let heartbeatException = false;
  let windowListeners;
  let ui;
  const newDocument = () => {
    windowListeners = [];
    const win = {
      location: { origin: "app://codex" },
      setTimeout: time.schedule, clearTimeout: time.cancel,
      addEventListener(name, listener) { if (name === "message") windowListeners.push(listener); },
      postMessage(message) {
        for (const listener of [...windowListeners]) listener({ source: win, origin: win.location.origin, data: message });
      },
    };
    ui = vm.createContext({ window: win, Number, Promise,
      Date: { now: time.now }, HOST_CAPABILITY: "fixture-capability",
      HOST_HEARTBEAT_MAX_AGE_MS: 8000, HOST_REQUEST_TIMEOUT_MS: 20000,
      HOST_REQUEST_MESSAGE: "fixture-request", HOST_RESPONSE_MESSAGE: "fixture-response",
      HOST_HEARTBEAT_MESSAGE: "fixture-heartbeat", HOST_STARTUP_TOKEN_NAME: "fixture-token",
      hostHeartbeatAt: 0, hostRequestSequence: 0, hostRequests: new Map(),
      hostError: (text) => new Error(text),
    });
    const request = uiSource.slice(uiSource.indexOf("  function hasLiveHostBinding()"), uiSource.indexOf("  function requestHostEnsure("));
    const response = uiSource.slice(uiSource.indexOf("  function onHostResponse("), uiSource.indexOf("  async function prepareTaskboard("));
    vm.runInContext(request + response, ui);
    win.addEventListener("message", ui.onHostBridgeMessage);
    const installedContext = contextId;
    ui.fixtureBinding = (payload) => emit("Runtime.bindingCalled", {
      name: "fixtureBinding", executionContextId: installedContext, payload,
    });
  };
  const emit = async (name, value = {}) => { for (const fn of handlers.get(name) ?? []) await fn(value); };
  newDocument();
  const cdp = {
    closed: false, taskboardCompatibilityCapabilities: { fullPanel: true, quotaDisplay: true, taskNavigation: true },
    on(name, fn) {
      const list = handlers.get(name) ?? [];
      handlers.set(name, [...list, fn]);
      return () => handlers.set(name, (handlers.get(name) ?? []).filter((item) => item !== fn));
    },
    close() { this.closed = true; },
    async send(method, params) {
      if (this.closed) throw new Error("closed fixture");
      if (method === "Page.getFrameTree") return { frameTree: { frame: { id: "fixture-main" } } };
      if (method === "Page.createIsolatedWorld") {
        worlds++;
        if (holdWorld) return holdWorld;
        return { executionContextId: contextId };
      }
      if (method === "Runtime.addBinding") return {};
      if (method === "Runtime.evaluate") {
        if (params.contextId !== contextId) throw new Error("stale fixture context");
        if (params.expression.includes('type: "fixture-heartbeat"')) {
          if (holdHeartbeat) return holdHeartbeat;
          if (heartbeatException) return { exceptionDetails: {} };
          pulses.push(time.now());
        } else if (bindingException) return { exceptionDetails: {} };
        vm.runInContext(params.expression, ui);
        return { result: {} };
      }
      throw new Error("unexpected fixture method");
    },
  };
  const hostFunction = hostSource.slice(hostSource.indexOf("function installTaskboardHostBinding("), hostSource.indexOf("async function readInjectionStatus("));
  const install = vm.runInNewContext(`(${hostFunction})`, {
    createHostHeartbeatPump: (publish) => createHostHeartbeatPump(publish, { schedule: time.schedule, cancel: time.cancel }),
    handleHostBindingPayload, hostBindingName: "fixtureBinding", hostCapability: "fixture-capability",
    parseTaskboardAutomationHostRequest: () => null,
    openExternalUrl: () => { throw new Error("fixture forbids external access"); },
    openAttachment: () => { throw new Error("fixture forbids attachment access"); },
    hostRequestMessage: "fixture-request", hostResponseMessage: "fixture-response", hostHeartbeatMessage: "fixture-heartbeat",
    setTimeout: time.schedule, clearTimeout: time.cancel,
    restoreQuotaPolicies: async () => { restored++; },
    handoffApproval: async (request) => { calls.push(request); return { fixtureDecision: request.operation }; },
    sendHostResponse: async (_cdp, id, result) => {
      if (id !== contextId) throw new Error("stale fixture response");
      ui.window.postMessage({ type: "fixture-response", capability: "fixture-capability", response: result });
    },
  });
  const bridge = install(cdp, {}, "fixture-startup");
  return {
    time, bridge, cdp, calls, pulses, emit, get ui() { return ui; },
    counters: () => ({ worlds, restored }),
    request: (request) => ui.requestHost("handoff-approval", { request }),
    holdWorld(value) { holdWorld = value; }, holdHeartbeat(value) { holdHeartbeat = value; },
    bindingException(value) { bindingException = value; }, heartbeatException(value) { heartbeatException = value; },
    async reload() {
      await emit("Runtime.executionContextsCleared");
      contextId++;
      newDocument();
    },
  };
}

test("secondary renderer/quota/frame waits cannot expire the ready document's approval channel", async () => {
  for (const blockedStage of ["secondary-renderer", "quota-read", "frame-wait"]) {
    const h = harness();
    await h.bridge.install();
    await h.bridge.publishHeartbeat();
    const unrelatedWork = new Promise((resolve) => h.time.schedule(resolve, 25000));
    await h.time.advance(24000);
    assert.equal(h.ui.hasLiveHostBinding(), true, blockedStage);
    assert.equal((await h.request({ operation: "list", project: null })).fixtureDecision, "list");
    const decision = { operation: "decide", messageId: "12345678-1234-1234-1234-123456789abc",
      revision: "a".repeat(64), decision: "approve", reviewed: ["fixture-version"], reason: "" };
    assert.equal((await h.request(decision)).fixtureDecision, "decide");
    assert.equal(h.calls.filter((call) => call.operation === "decide").length, 1);
    assert.ok(h.pulses.every((at, index) => index === 0 || at - h.pulses[index - 1] <= 2000));
    assert.deepEqual(h.counters(), { worlds: 1, restored: 1 });
    await h.time.advance(1000);
    await unrelatedWork;
    h.bridge.dispose();
  }
});

test("new documents stop the channel until contract validation and a new isolated binding", async () => {
  const h = harness();
  await h.bridge.install();
  await h.bridge.publishHeartbeat();
  await h.reload();
  await h.time.advance(10000);
  await assert.rejects(h.request({ operation: "list", project: null }), /审批通道未连接/);
  await assert.rejects(h.bridge.install(), /no validated/);
  await h.emit("Runtime.bindingCalled", { name: "fixtureBinding", executionContextId: 7,
    payload: JSON.stringify({ id: "old", action: "handoff-approval", request: { operation: "list" } }) });
  assert.equal(h.calls.length, 0);
  h.cdp.taskboardCompatibilityCapabilities = { fullPanel: true };
  await h.bridge.install();
  await h.bridge.publishHeartbeat();
  assert.equal((await h.request({ operation: "list", project: null })).fixtureDecision, "list");
  h.bridge.dispose();
  const before = h.pulses.length;
  await h.time.advance(10000);
  assert.equal(h.pulses.length, before);
  await assert.rejects(h.request({ operation: "list", project: null }), /审批通道未连接/);
});

test("a slow heartbeat cannot overlap, reinstall, or keep a dead approval channel fresh", async () => {
  const h = harness();
  await h.bridge.install();
  await h.bridge.publishHeartbeat();
  h.holdHeartbeat(new Promise(() => {}));
  const first = h.bridge.publishHeartbeat();
  const second = h.bridge.publishHeartbeat();
  const results = Promise.allSettled([first, second]);
  await h.time.advance(3001);
  assert.ok((await results).every((result) => result.status === "rejected"));
  assert.equal(h.cdp.closed, true);
  assert.deepEqual(h.counters(), { worlds: 1, restored: 1 });
  await h.time.advance(8001);
  await assert.rejects(h.request({ operation: "list", project: null }), /审批通道未连接/);
  assert.equal(h.calls.length, 0);
  h.bridge.dispose();
});

test("a document change during installation cannot restore an old binding", async () => {
  const h = harness();
  let release;
  h.holdWorld(new Promise((resolve) => { release = resolve; }));
  const installing = h.bridge.install();
  const rejected = assert.rejects(installing, /document changed/);
  await flush();
  await h.reload();
  release({ executionContextId: 7 });
  await rejected;
  assert.equal(h.pulses.length, 0);
  assert.equal(h.calls.length, 0);
  h.bridge.dispose();
});

test("an old heartbeat timeout cannot close a newly validated document", async () => {
  const h = harness();
  await h.bridge.install();
  await h.bridge.publishHeartbeat();
  h.holdHeartbeat(new Promise(() => {}));
  const old = assert.rejects(h.bridge.publishHeartbeat(), /Timed out/);
  await h.reload();
  h.holdHeartbeat(null);
  h.cdp.taskboardCompatibilityCapabilities = { fullPanel: true };
  await h.bridge.install();
  await h.bridge.publishHeartbeat();
  await h.time.advance(3001);
  await old;
  assert.equal(h.cdp.closed, false);
  assert.equal((await h.request({ operation: "list", project: null })).fixtureDecision, "list");
  h.bridge.dispose();
});

test("binding and heartbeat evaluation failures invalidate the channel", async () => {
  const h = harness();
  h.bindingException(true);
  await assert.rejects(h.bridge.install(), /binding evaluation failed/);
  await assert.rejects(h.bridge.publishHeartbeat(), /not validated/);
  h.bindingException(false);
  h.cdp.taskboardCompatibilityCapabilities = { fullPanel: true };
  await Promise.all([h.bridge.install(), h.bridge.install()]);
  await flush();
  h.heartbeatException(true);
  await assert.rejects(h.bridge.publishHeartbeat(), /heartbeat evaluation failed/);
  assert.equal(h.cdp.closed, true);
  await h.time.advance(8001);
  await assert.rejects(h.request({ operation: "list", project: null }), /审批通道未连接/);
  assert.equal(h.calls.length, 0);
  h.bridge.dispose();
});

test("heartbeat pump stop cancels queued work and restart never overlaps an old publication", async () => {
  const time = clock();
  let calls = 0;
  let release;
  const pump = createHostHeartbeatPump(() => { calls++; return new Promise((resolve) => { release = resolve; }); }, {
    schedule: time.schedule, cancel: time.cancel,
  });
  pump.start(); pump.stop();
  await flush();
  assert.equal(calls, 0);
  pump.start(); await flush();
  assert.equal(calls, 1);
  pump.stop(); pump.start(); await flush();
  assert.equal(calls, 1);
  release(); await flush();
  assert.equal(calls, 2);
  pump.stop(); release(); await time.advance(10000);
  assert.equal(calls, 2);
});

test("installed legacy host reproduces channel expiry during a secondary renderer wait", {
  skip: process.platform !== "win32" || process.env.AGENT_DESK_APPROVAL_COMPARE_INSTALLED !== "1",
}, async () => {
  const legacy = await readFile(`${process.env.LOCALAPPDATA}/Agent Desk/app/scripts/codex-injector.mjs`, "utf8");
  const h = harness(legacy);
  await h.bridge.install();
  await h.bridge.publishHeartbeat();
  await h.time.advance(24000);
  await assert.rejects(h.request({ operation: "list", project: null }), /审批通道未连接/);
  assert.equal(h.calls.length, 0);
});
