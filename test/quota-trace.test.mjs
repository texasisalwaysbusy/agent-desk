import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import test from "node:test";
import { JSDOM } from "jsdom";
import { createQuotaObserver, quotaTraceExpression } from "../scripts/codex-quota-observer.mjs";
import { createQuotaTraceBudget, sanitizeQuotaTrace } from "../shared/quota-trace.mjs";
import { sanitizeStartupDiagnostic } from "../shared/startup-diagnostics.mjs";

const source = await readFile(new URL("../inject/codex-quota-display.user.js", import.meta.url), "utf8");
function fixture(script = source) {
  const dom = new JSDOM('<style>nav{display:flex;flex-direction:column}</style><aside data-app-shell-left-panel-appearance="content-surface"><nav role="navigation" aria-label="PRIVATE_LABEL"><div><button class="sidebar-item">PRIVATE_TITLE</button></div><div class="overflow-y-auto" data-app-action-sidebar-scroll><button class="sidebar-item">PRIVATE_CHAT</button></div></nav></aside>',
    { url: "app://codex/private-route", runScripts: "outside-only", pretendToBeVisual: true });
  dom.window.HTMLElement.prototype.getBoundingClientRect = function () {
    return { width: 280, height: 720, left: 0, top: 0, right: 280, bottom: 720 };
  };
  dom.window.eval(script);
  return dom;
}
const settle = (dom) => new Promise((resolve) => dom.window.setTimeout(resolve, 0));
test("resize storm preserves semantic failures, settled geometry and later route evidence within the bounded trace", () => {
  const dom = fixture();
  try {
    const w = dom.window, api = w.__codexTaskboardQuotaDisplay__;
    w.document.querySelector("nav").style.overflowY = "hidden";
    let now = Date.now() + 1001, width = 280, top = 0;
    w.Date.now = () => now;
    const original = w.HTMLElement.prototype.getBoundingClientRect;
    w.HTMLElement.prototype.getBoundingClientRect = function () {
      const box = original.call(this);
      return this.id === "codex-taskboard-quota-display" ? {...box,width,right:width,top,bottom:top+box.height} : box;
    };
    for (let i = 0; i < 500; i++) { width = 200 + i % 250; now += 2; api.diagnostics(); }
    top = 900; api.diagnostics();
    assert.equal(api.diagnostics().events.at(-1).clipped, true, "clipping is not throttled as geometry noise");
    top = 0; api.diagnostics();
    assert.equal(api.diagnostics().events.at(-1).clipped, false);
    width = 320; now += 1001;
    assert.equal(api.diagnostics().events.at(-1).width, 320, "final geometry is sampled after settling");
    const nav = w.document.querySelector("nav"); nav.hidden = true; api.heartbeat();
    nav.hidden = false; api.heartbeat();
    assert.equal(api.diagnostics().events.at(-1).reason, "mounted");
    assert.ok(api.diagnostics().events.length < 20, "500 resize changes must not consume the 96-record field budget");
  } finally { dom.window.__codexTaskboardQuotaDisplay__.cleanup(); dom.window.close(); }
});
test("trace distinguishes parked structure, restored identity, clipping and cleanup without private content", async () => {
  const dom = fixture();
  try {
    const api = dom.window.__codexTaskboardQuotaDisplay__;
    const nav = dom.window.document.querySelector("nav");
    const first = api.diagnostics().events.at(-1);
    assert.equal(first.reason, "mounted");
    nav.append(dom.window.document.createElement("footer"));
    await settle(dom);
    assert.equal(api.diagnostics().events.at(-1).reason, "scroll-order");
    nav.lastElementChild.remove(); await settle(dom);
    assert.equal(api.diagnostics().events.at(-1).reason, "mounted");
    const replacement = nav.cloneNode(true);
    replacement.querySelector("#codex-taskboard-quota-display").remove(); nav.replaceWith(replacement);
    await settle(dom);
    assert.notEqual(api.diagnostics().events.at(-1).navigationIdentity, first.navigationIdentity);
    replacement.style.opacity = "0"; await settle(dom);
    assert.equal(api.diagnostics().events.at(-1).ancestorHidden, true);
    replacement.style.opacity = "1";
    replacement.style.overflowY = "hidden";
    const rect = dom.window.HTMLElement.prototype.getBoundingClientRect;
    dom.window.HTMLElement.prototype.getBoundingClientRect = function () {
      const value = rect.call(this);
      return this.id === "codex-taskboard-quota-display" ? { ...value, top: 800, bottom: 1520 } : value;
    };
    assert.equal(api.diagnostics().events.at(-1).clipped, true);
    assert.equal(api.status().mounted, true, "mounted alone does not prove on-screen visibility");
    api.cleanup();
    const last = api.diagnostics().events.at(-1);
    assert.equal(last.reason, "cleanup"); assert.equal(last.connected, false); assert.equal(last.cleaned, true);
    const encoded = JSON.stringify(api.diagnostics());
    assert.doesNotMatch(encoded, /PRIVATE|private-route|aria-label|remainingPercent|fetchedAtMs/);
  } finally { dom.window.__codexTaskboardQuotaDisplay__.cleanup(); dom.window.close(); }
});

test("trace is read only, deduplicated, bounded and includes intermediate park then home restore", async () => {
  const dom = fixture();
  try {
    const api = dom.window.__codexTaskboardQuotaDisplay__;
    const before = dom.window.document.body.innerHTML;
    const initial = api.diagnostics().sequence;
    for (let n = 0; n < 20; n++) api.diagnostics();
    assert.equal(api.diagnostics().sequence, initial);
    assert.equal(dom.window.document.body.innerHTML, before);
    const nav = dom.window.document.querySelector("nav");
    nav.style.flexDirection = "row"; await settle(dom);
    nav.style.flexDirection = "column"; await settle(dom);
    const reasons = Array.from(api.diagnostics(initial).events, (e) => e.reason);
    assert.ok(reasons.includes("navigation-flow")); assert.equal(reasons.at(-1), "mounted");
    for (let n = 0; n < 140; n++) { nav.style.opacity = n % 2 ? "1" : "0"; api.diagnostics(); }
    const trace = api.diagnostics();
    assert.equal(trace.events.length, 128); assert.ok(trace.oldestSequence > initial);
    assert.equal(api.diagnostics(trace.sequence).events.length, 0);
  } finally { dom.window.__codexTaskboardQuotaDisplay__.cleanup(); dom.window.close(); }
});

test("recovery preserves established 1.0.8 placement decisions in non-regression composite fixtures", {
  skip: !existsSync(new URL("../dist/maintenance/20260930-archive-quota-recovery/extracted/app/inject/codex-quota-display.user.js", import.meta.url)),
}, async () => {
  const baseline = await readFile(new URL("../dist/maintenance/20260930-archive-quota-recovery/extracted/app/inject/codex-quota-display.user.js", import.meta.url), "utf8");
  const outputs = [];
  for (const script of [baseline, source]) {
    const dom = fixture(script);
    try {
      const api = dom.window.__codexTaskboardQuotaDisplay__, document = dom.window.document;
      const nav = document.querySelector("nav"), values = [];
      const measure = () => values.push([api.status().mounted, document.querySelectorAll("#codex-taskboard-quota-display").length]);
      measure(); nav.style.flexDirection = "row"; await settle(dom); measure();
      nav.style.flexDirection = "column"; await settle(dom); measure();
      const duplicate = nav.cloneNode(true); duplicate.querySelector("#codex-taskboard-quota-display").remove(); nav.parentElement.append(duplicate);
      await settle(dom); measure(); duplicate.hidden = true; await settle(dom); measure();
      const settings = document.createElement("section"); settings.dataset.settingsPanelSlug = "PRIVATE"; document.body.append(settings);
      await settle(dom); measure(); settings.remove(); await settle(dom); measure();
      api.cleanup(); measure(); dom.window.eval(script); measure();
      outputs.push(values);
    } finally { dom.window.__codexTaskboardQuotaDisplay__.cleanup(); dom.window.close(); }
  }
  assert.deepEqual(outputs[1], outputs[0]);
});

test("frozen 1.0.9 reproduces reported scroll-order deadlock; recovery restores the same document", {
  skip: !existsSync(new URL("../dist/maintenance/20260930-quota-lifecycle-trace/extracted/app/inject/codex-quota-display.user.js", import.meta.url)),
}, async () => {
  const old = await readFile(new URL("../dist/maintenance/20260930-quota-lifecycle-trace/extracted/app/inject/codex-quota-display.user.js", import.meta.url), "utf8");
  for (const [script, restored] of [[old, false], [source, true]]) {
    const dom = fixture(script);
    try {
      const api = dom.window.__codexTaskboardQuotaDisplay__, nav = dom.window.document.querySelector("nav");
      const header = nav.firstElementChild, homeScroll = nav.querySelector(".overflow-y-auto");
      const scheduled = dom.window.document.createElement("div"); nav.append(scheduled);
      header.hidden = true; homeScroll.hidden = true; await settle(dom);
      assert.equal(api.status().mounted, false);
      scheduled.hidden = true; header.hidden = false; homeScroll.hidden = false; await settle(dom);
      const event = api.diagnostics().events.at(-1);
      assert.equal(event.nativeChildren, 3); assert.equal(event.hiddenNativeChildren, 1);
      assert.equal(event.reason, restored ? "mounted" : "scroll-order");
      assert.equal(api.status().mounted, restored);
      assert.equal(event.connected, true); assert.equal(event.cleaned, false);
      for (let n = 0; n < 3; n++) { await settle(dom); assert.equal(api.status().mounted, restored); }
    } finally { dom.window.__codexTaskboardQuotaDisplay__.cleanup(); dom.window.close(); }
  }
});

function observerHarness(send) {
  const handlers = new Map(), timers = [], records = [], calls = [];
  const cdp = { closed: false, on(name, handler) { handlers.set(name, handler); return () => handlers.delete(name); },
    send(method, params) { calls.push({ method, params }); return send(method, params); } };
  const observer = createQuotaObserver(cdp, 2, (r) => records.push(r), {
    schedule(fn) { timers.push(fn); return fn; }, cancel(fn) { const i = timers.indexOf(fn); if (i >= 0) timers.splice(i, 1); },
  });
  return { cdp, observer, handlers, timers, records, calls };
}
const observation = (events = [], sequence = events.at(-1)?.sequence ?? 0) => ({ result: { value: {
  appProtocol: true, topFrame: true, apiPresent: true,
  trace: { schemaVersion: 1, version: "1.0.9", sequence, events },
} } });

test("observer retains rapid transitions between samples and reads only fixed managed-page metadata", async () => {
  const h = observerHarness(async () => observation([
    { sequence: 1, reason: "mounted", connected: true, url: "PRIVATE" },
    { sequence: 2, reason: "navigation-count", hidden: true },
    { sequence: 3, reason: "mounted", hidden: false },
  ]));
  try {
    await h.observer.sample();
    assert.deepEqual(h.records.filter((r) => r.sequence).map((r) => r.reason), ["mounted", "navigation-count", "mounted"]);
    assert.doesNotMatch(JSON.stringify(h.records), /PRIVATE/);
    assert.ok(h.records.every((r) => r.renderer === 2));
    assert.deepEqual(h.calls.map((r) => r.method), ["Runtime.evaluate"]);
    assert.doesNotMatch(quotaTraceExpression(0), /fetch|innerHTML|textContent|WebSocket|account\/|\.heartbeat|\.mount|\.cleanup/);
  } finally { h.observer.dispose(); }
});

test("pending old-document sample cannot contaminate a new document or overlap", async () => {
  let release;
  const h = observerHarness(() => new Promise((resolve) => { release = resolve; }));
  await Promise.resolve();
  const pending = h.observer.sample(); assert.equal(h.calls.length, 1);
  h.handlers.get("Runtime.executionContextsCleared")();
  release(observation([{ sequence: 1, reason: "cleanup", cleaned: true }])); await pending;
  assert.equal(h.records.some((r) => r.cleaned), false);
  h.observer.capture(observation([{ sequence: 1, reason: "mounted" }]).result.value);
  assert.equal(h.records.at(-1).documentGeneration, 1);
  h.observer.dispose(); assert.equal(h.timers.length, 0); assert.equal(h.handlers.size, 0);
});

test("observer reports ring gaps, module resets and cleanup before disposal without new commands", async () => {
  const h = observerHarness(async () => observation([{ sequence: 140, reason: "mounted" }], 140));
  await h.observer.sample(); assert.equal(h.records.find((r) => r.lostEvents)?.lostEvents, 139);
  h.observer.capture(observation([{ sequence: 1, reason: "mounted" }]).result.value);
  assert.equal(h.records.some((r) => r.sequenceReset === true), true);
  h.observer.capture(observation([{ sequence: 2, reason: "cleanup", cleaned: true }]).result.value);
  assert.equal(h.records.at(-1).cleaned, true);
  h.observer.dispose(); await h.observer.sample(); assert.equal(h.calls.length, 1);
});

test("diagnostic transport failure does not close the connection, throw or modify host policy", async () => {
  const h = observerHarness(async () => { throw new Error("PRIVATE_ERROR"); });
  await h.observer.sample();
  assert.equal(h.records.at(-1).phase, "transport-failed"); assert.equal(h.cdp.closed, false);
  assert.equal(h.timers.length, 1); assert.doesNotMatch(JSON.stringify(h.records), /PRIVATE_ERROR/);
  h.cdp.closed = true; await h.observer.sample(); assert.equal(h.timers.length, 0);
});

test("writer budget and reader independently sanitize diagnostic data", () => {
  const records = [], write = createQuotaTraceBudget((record) => records.push(record), 2);
  for (let n = 0; n < 12; n++) write({ phase: "sample", renderer: 1, reason: "mounted", sequence: n, token: "PRIVATE" });
  assert.equal(records.length, 3); assert.equal(records.at(-1).phase, "trace-limit");
  const raw = { phase: "sample", reason: "PRIVATE", width: Infinity, height: -99999,
    hostCount: 1001, top: -30, cleaned: true, token: "PRIVATE", account: { id: "PRIVATE" } };
  assert.deepEqual(sanitizeQuotaTrace(raw), { phase: "sample", top: -30, cleaned: true });
  assert.deepEqual(sanitizeStartupDiagnostic(JSON.stringify({ launchDiagnostic: { event: "quota-trace", trace: raw } })),
    { event: "quota-trace", trace: { phase: "sample", top: -30, cleaned: true } });
});
