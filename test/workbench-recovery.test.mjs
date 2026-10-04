import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import test from "node:test";
import { JSDOM } from "jsdom";
import vm from "node:vm";
import { createQuotaObserver } from "../scripts/codex-quota-observer.mjs";
import { createWorkbenchTraceBudget } from "../shared/workbench-trace.mjs";
import { sanitizeStartupDiagnostic } from "../shared/startup-diagnostics.mjs";

const source = await readFile(new URL("../inject/codex-taskboard.user.js", import.meta.url), "utf8");
const tick = () => new Promise(resolve => setTimeout(resolve, 25));
async function until(predicate) {
  for (let n = 0; n < 40; n++) { if (predicate()) return; await tick(); }
  assert.fail("isolated workbench did not reach expected state");
}
function fixture({ contextStalled = false, handshake = true, fastTimeout = false, script = source, defer = {} } = {}) {
  const dom = new JSDOM(`<aside data-app-shell-left-panel-appearance="content-surface">
    <nav role="navigation" aria-label="PRIVATE_NAV"><div><button class="sidebar-item">PRIVATE_NEW_CHAT</button></div>
    <div class="overflow-y-auto" data-app-action-sidebar-scroll><section data-app-action-sidebar-section>
    <button class="sidebar-item" data-app-action-sidebar-thread-id="private-thread">PRIVATE_CHAT</button>
    </section></div></nav></aside><main><div><div data-app-shell-main-content-layout>
    <div class="app-shell-main-content-frame"></div></div></div></main>`,
  { url: "app://codex/private-conversation", runScripts: "outside-only", pretendToBeVisual: true });
  const w = dom.window, frames = [], requests = [], state = { handshake, defer, deferred: [], contract: true };
  w.HTMLElement.prototype.getBoundingClientRect = () => ({ width: 400, height: 600, top: 0, left: 0, right: 400, bottom: 600 });
  const nativeTimeout = w.setTimeout.bind(w);
  w.setTimeout = (fn, delay, ...args) => nativeTimeout(fn, fastTimeout && delay === 12000 ? 60 : delay, ...args);
  const hostEvent = data => w.dispatchEvent(new w.MessageEvent("message", {
    source: w, origin: w.location.origin, data,
  }));
  w.__CODEX_TASKBOARD_HOST_CAPABILITY__ = "private-host-capability";
  w.__CODEX_TASKBOARD_MANAGED_ORIGIN__ = "http://127.0.0.1:47823";
  w.__CODEX_TASKBOARD_SOURCE_HASH__ = "fixture";
  w.electronBridge = {
    getInitialSidebarBootstrap: () => contextStalled ? new Promise(() => {}) : Promise.resolve({}),
    sendMessageFromView(message) {
      if (message.type === "fetch") w.dispatchEvent(new w.MessageEvent("message", {
        data: { type: "fetch-response", requestId: message.requestId, bodyJsonString: "{}" },
      }));
    },
  };
  w.postMessage = message => {
    if (message.type !== "__codexTaskboardHostRequestV1") return;
    const request = message.payload; requests.push(request);
    const respond = ok => hostEvent({ type: "__codexTaskboardHostResponseV1", capability: w.__CODEX_TASKBOARD_HOST_CAPABILITY__,
      response: { id: request.id, ok, managed: true, restarted: false, ...(ok ? {} : {error:'fixture-contract-refused'}) } });
    if (request.action === "load-frame" && !state.contract) { respond(false); return; }
    if (request.action === "load-frame") {
      const iframe = Array.from(w.document.querySelectorAll("iframe")).find(node => node.name === request.frameName);
      assert.ok(iframe);
      const originalWindow = iframe.contentWindow;
      const record = { iframe, originalWindow, capability: request.frameCapability, challenge: "" };
      frames.push(record);
      const ready = () => w.dispatchEvent(new w.MessageEvent("message", { source: originalWindow, origin: "null",
        data: { type: "taskboard:ready", capability: record.capability, challenge: record.challenge } }));
      record.ready = ready;
      originalWindow.postMessage = event => {
        if (event.type === "taskboard:frame-challenge") {
          record.challenge = event.payload.challenge;
          if (state.handshake) ready();
        }
      };
      iframe.dispatchEvent(new w.Event("load"));
    }
    if (state.defer[request.action]) state.deferred.push({ request, complete: respond });
    else respond(true);
  };
  w.eval(script);
  hostEvent({ type: "__codexTaskboardHostHeartbeatV1", capability: w.__CODEX_TASKBOARD_HOST_CAPABILITY__, at: Date.now() });
  const api = w.__codexTaskboardInjection__;
  return { dom, w, api, frames, requests, state,
    dispose() { api.destroy(); w.close(); } };
}

test("slow native conversation metadata cannot block a panel, and native New Chat closes it", async () => {
  const h = fixture({ contextStalled: true });
  try {
    h.api.open(); await until(() => h.api.ready);
    assert.equal(h.frames.length, 1);
    assert.equal(h.api.diagnostics().events.at(-1).phase, "frame");
    assert.doesNotMatch(JSON.stringify(h.api.diagnostics()), /PRIVATE|private-|capability|challenge|http|conversation/);
    h.w.document.querySelector("nav > div button").click();
    assert.equal(h.api.diagnostics().events.at(-1).active, false);
    h.api.open(); await until(() => h.api.ready);
    assert.equal(h.frames.length, 1, "connected ready frame can be reused on the same surface");
  } finally { h.dispose(); }
});

test("native surface replacement resets frame authority and rejects a stale ready handshake", async () => {
  const h = fixture({ contextStalled: true });
  try {
    h.api.open(); await until(() => h.api.ready);
    const old = h.frames[0]; h.state.handshake = false;
    const surface = h.w.document.querySelector("[data-app-shell-main-content-layout]").parentElement;
    const replacement = surface.cloneNode(true);
    replacement.querySelectorAll('[data-codex-taskboard-owned="true"]').forEach(node => node.remove());
    surface.replaceWith(replacement);
    h.api.refresh(); await until(() => h.frames.length === 2);
    const fresh = h.frames[1];
    assert.equal(old.iframe.isConnected, false);
    assert.notEqual(fresh.capability, old.capability);
    assert.notEqual(fresh.challenge, old.challenge);
    old.ready(); assert.equal(h.api.ready, false);
    fresh.ready(); await until(() => h.api.ready);
    assert.equal(h.api.diagnostics().events.at(-1).frameConnected, true);
    h.api.refresh(); await tick();
    assert.equal(h.frames.length, 2, "stable surface does not trigger reload loops");
  } finally { h.dispose(); }
});

test("frame timeout stays failed without automatic retry; explicit reload recovers with new authority", async () => {
  const h = fixture({ handshake: false, fastTimeout: true, contextStalled: true });
  try {
    h.api.open(); await until(() => h.api.diagnostics().events.at(-1)?.phase === "error");
    assert.equal(h.api.diagnostics().events.at(-1).failure, "frame-timeout");
    await tick(); assert.equal(h.frames.length, 1);
    h.state.handshake = true;
    assert.equal(h.api.reloadFrame(), true); await until(() => h.api.ready);
    assert.equal(h.frames.length, 2);
    assert.equal(h.api.diagnostics().events.at(-1).failure, "none");
    assert.notEqual(h.frames[0].capability, h.frames[1].capability);
  } finally { h.dispose(); }
});

test("retained hidden native route cannot capture a ready workbench in an invisible surface", async () => {
  const h = fixture({ contextStalled: true });
  try {
    const main = h.w.document.querySelector("main"), old = main.firstElementChild;
    const current = old.cloneNode(true);
    old.hidden = true; main.append(current);
    h.api.open(); await until(() => h.api.ready);
    assert.equal(h.w.document.getElementById("codex-taskboard-page").parentElement, current);
    assert.equal(h.api.diagnostics().events.at(-1).pageVisible, true);
    assert.equal(h.api.diagnostics().events.at(-1).frameVisible, true);
    h.api.close(); current.hidden = true; old.hidden = false;
    h.api.open(); await until(() => h.api.ready);
    assert.equal(h.w.document.getElementById("codex-taskboard-page").parentElement, old);
    assert.equal(h.frames.length, 2);
    assert.equal(h.api.diagnostics().events.at(-1).frameVisible, true);
  } finally { h.dispose(); }
});

test("main itself can be the validated layout, and unavailable mounts cannot reuse a hidden ready frame", async () => {
  const h=fixture();
  try {
    h.api.open();await until(()=>h.api.ready);h.api.close();
    const main=h.w.document.querySelector('main');main.hidden=true;
    const requestCount=h.requests.length;
    h.api.open();await tick();
    let event=h.api.diagnostics().events.at(-1);
    assert.equal(event.mountState,'unavailable');assert.equal(event.active,false);
    assert.equal(event.failure,'mount-unavailable');assert.equal(event.pageVisibility,'hidden');
    assert.equal(h.requests.length,requestCount,"unmounted frame is never ensured/reused");
    main.hidden=false;main.innerHTML='<div class="app-shell-main-content-frame"></div>';
    main.setAttribute('data-app-shell-main-content-layout','');
    h.api.open();await until(()=>h.api.ready);event=h.api.diagnostics().events.at(-1);
    assert.equal(h.w.document.getElementById('codex-taskboard-page').parentElement,main);
    assert.equal(event.mountState,'mounted');assert.equal(event.frameVisible,true);assert.equal(event.failure,'none');
  } finally {h.dispose();}
});

test("a new explicit reload clears a prior timeout before the next handshake completes", async()=>{
  const h=fixture({handshake:false,fastTimeout:true});
  try{
    h.api.open();await until(()=>h.api.diagnostics().events.at(-1)?.phase==='error');
    assert.equal(h.api.diagnostics().events.at(-1).failure,'frame-timeout');
    h.api.reloadFrame();
    assert.equal(h.api.diagnostics().events.at(-1).failure,'none');
  }finally{h.dispose();}
});

const frozenPath = new URL("../dist/maintenance/20261001-updated-sidebar-recovery/extracted/app/inject/codex-taskboard.user.js", import.meta.url);
const glassBaseline = new URL("../dist/maintenance/20261001-quota-glass-a/extracted/app/inject/codex-taskboard.user.js", import.meta.url);

function replaceSurface(h) {
  const old=h.w.document.querySelector('main').firstElementChild;
  const fresh=old.cloneNode(true);
  fresh.querySelectorAll('[data-codex-taskboard-owned="true"]').forEach(n=>n.remove());
  old.replaceWith(fresh);
}

test('frozen 0.6.20 remounts into an unavailable sidebar route and reports load-failed', {skip:!existsSync(glassBaseline)}, async()=>{
  const h=fixture({script:await readFile(glassBaseline,'utf8')});
  try {
    h.api.open();await until(()=>h.api.ready);
    h.w.document.querySelector('nav').hidden=true;h.state.contract=false;
    replaceSurface(h);h.api.refresh();
    await until(()=>h.api.diagnostics().events.some(e=>e.failure==='load-failed'));
    assert.equal(h.api.diagnostics().events.at(-1).active,true);
  }finally{h.dispose();}
});

test('active route loss parks without remounting; native content and an existing conversation recover', async()=>{
  for(const loss of ['sidebar','main','ambiguous']){
    const h=fixture();
    try{
      h.api.open();await until(()=>h.api.diagnostics().events.at(-1).frameLoadAcknowledged);
      const before=h.requests.length,nav=h.w.document.querySelector('nav'),main=h.w.document.querySelector('main');
      if(loss==='sidebar')nav.hidden=true;
      if(loss==='main')main.hidden=true;
      if(loss==='ambiguous')h.w.document.body.append(main.cloneNode(true));
      h.state.contract=false;
      if(loss==='sidebar')replaceSurface(h);
      h.api.refresh();await tick();
      const event=h.api.diagnostics().events.at(-1);
      assert.equal(event.active,false,loss);assert.equal(event.parkReason,'route-unavailable');
      assert.equal(event.phase,'idle');assert.equal(event.failure,'none');assert.equal(event.routeEligible,false);
      assert.equal(h.requests.length,before,'no request on an unsupported route');
      assert.equal(h.w.document.querySelectorAll('[data-codex-taskboard-native-hidden]').length,0);
      nav.hidden=false;main.hidden=false;
      if(loss==='ambiguous')h.w.document.querySelectorAll('main')[1].remove();
      h.state.contract=true;h.api.refresh();await tick();
      assert.equal(h.api.diagnostics().events.at(-1).active,false,'route return does not reopen over native content');
      h.api.open();await until(()=>h.api.diagnostics().events.at(-1).frameVisible);
      assert.equal(h.api.diagnostics().events.at(-1).failure,'none');
    }finally{h.dispose();}
  }
});

test('route loss during ensure ignores its late success or failure before any frame bootstrap',async()=>{
  for(const ok of [true,false]){
    const h=fixture({defer:{ensure:true}});
    try{
      h.api.open();await until(()=>h.state.deferred.length===1);
      h.w.document.querySelector('nav').hidden=true;
      h.state.deferred.shift().complete(ok);
      await until(()=>h.api.diagnostics().events.at(-1).active===false);
      assert.equal(h.frames.length,0);assert.equal(h.api.diagnostics().events.at(-1).failure,'none');
      h.w.document.querySelector('nav').hidden=false;h.state.defer.ensure=false;h.api.refresh();h.api.open();
      await until(()=>h.api.diagnostics().events.at(-1).frameVisible);
    }finally{h.dispose();}
  }
});

test('rapid reopen waits for the old bootstrap and cannot display unacknowledged readiness',async()=>{
  const h=fixture({defer:{'load-frame':true}});
  try{
    h.api.open();await until(()=>h.state.deferred.length===1);
    assert.equal(h.api.ready,true);assert.equal(h.api.diagnostics().events.at(-1).frameLoadAcknowledged,false);
    const stale=h.frames[0];h.api.close();h.api.open();await tick();
    assert.equal(h.frames.length,1);assert.equal(h.api.diagnostics().events.at(-1).frameVisible,false);
    assert.equal(h.api.diagnostics().events.at(-1).loadStage,'queued');
    h.state.defer['load-frame']=false;h.state.deferred.shift().complete(true);
    await until(()=>h.api.diagnostics().events.at(-1).frameVisible);
    assert.equal(h.frames.length,2);assert.notEqual(h.frames[1].capability,stale.capability);
    stale.ready();assert.equal(h.api.diagnostics().events.at(-1).failure,'none');
  }finally{h.dispose();}
});

test('eligible route failures keep their stage and require explicit recovery',async()=>{
  const h=fixture();
  try{
    h.state.contract=false;h.api.open();await until(()=>h.api.diagnostics().events.at(-1).failure==='load-failed');
    const event=h.api.diagnostics().events.at(-1);
    assert.equal(event.loadStage,'bootstrap');assert.equal(event.routeEligible,true);
    const count=h.requests.length;h.api.refresh();await tick();assert.equal(h.requests.length,count);
    h.state.contract=true;h.api.open();await until(()=>h.api.diagnostics().events.at(-1).frameVisible);
  }finally{h.dispose();}
});

test('actual injector writer preserves bootstrap and observation events without arbitrary details',async()=>{
  const injector=await readFile(new URL('../scripts/codex-injector.mjs',import.meta.url),'utf8');
  const frozen=existsSync(glassBaseline) ? await readFile(new URL('../dist/maintenance/20261001-quota-glass-a/extracted/app/scripts/codex-injector.mjs',import.meta.url),'utf8') : null;
  for(const [script,current] of [[injector,true],...(frozen?[[frozen,false]]:[])]){
    const output=[];
    const fn=vm.runInNewContext(script.slice(script.indexOf('function logLaunchDiagnostic('),script.indexOf('const taskboardOrigin ='))+'\nlogLaunchDiagnostic',{
      console:{log:s=>output.push(JSON.parse(s))},startupDiagnosticPath:null,startupAttemptId:null,
      taskboardVersion:'fixture',codexPackageVersion:'fixture',sanitizeQuotaTrace:x=>x,sanitizeWorkbenchTrace:x=>x,
    });
    fn('frame-bootstrap',{bootstrap:'contract-refused',nonce:'PRIVATE',error:'PRIVATE'});
    fn('process-observation',{observation:'recovered',observationFailures:1,stderr:'PRIVATE'});
    assert.equal(output.length,current?2:0);
    if(current){
      assert.equal(output[0].launchDiagnostic.bootstrap,'contract-refused');
      assert.equal(output[1].launchDiagnostic.observation,'recovered');
      assert.equal(output[1].launchDiagnostic.observationFailures,1);
      assert.doesNotMatch(JSON.stringify(output),/PRIVATE/);
    }
  }
  const trace=sanitizeStartupDiagnostic(JSON.stringify({launchDiagnostic:{event:'workbench-trace',trace:{loadStage:'bootstrap',parkReason:'route-unavailable',routeEligible:false,nativeText:'PRIVATE'}}})).trace;
  assert.deepEqual(trace,{loadStage:'bootstrap',parkReason:'route-unavailable',routeEligible:false});
});
const previousPath=new URL('../dist/maintenance/20261001-conversation-quota-visual/extracted/app/inject/codex-taskboard.user.js',import.meta.url);
test('frozen 0.6.19 reuses a ready hidden frame when the current route has no mount',{skip:!existsSync(previousPath)},async()=>{
  const h=fixture({script:await readFile(previousPath,'utf8')});
  try {
    h.api.open();await until(()=>h.api.ready);h.api.close();
    h.w.document.querySelector('main').hidden=true;h.api.open();await tick();
    const state=h.api.diagnostics().events.at(-1);
    assert.equal(state.active,true);assert.equal(state.frameReady,true);assert.equal(state.pageConnected,true);
    assert.equal(state.pageVisible,false);assert.equal(state.frameVisible,false);assert.equal(state.frameOccluded,false);
  }finally{h.dispose();}
});
test("frozen 0.6.17 reports a connected ready frame while mounting in the retained hidden route", { skip: !existsSync(frozenPath) }, async () => {
  const h = fixture({contextStalled:true, script:await readFile(frozenPath,"utf8")});
  try {
    const main=h.w.document.querySelector("main"), old=main.firstElementChild;
    old.hidden=true;main.append(old.cloneNode(true));main.lastElementChild.hidden=false;
    h.api.open();await until(()=>h.api.ready);
    assert.equal(h.w.document.getElementById("codex-taskboard-page").parentElement,old);
    assert.equal(h.api.diagnostics().events.at(-1).frameConnected,true);
    assert.ok(h.w.document.getElementById("codex-taskboard-page").closest("[hidden]"));
  } finally {h.dispose();}
});

test("connected ready frame outside the visible page reports error health rather than ready", () => {
  const health = [];
  const cdp = { closed: false, on: () => () => {}, send: async () => ({result:{value:null}}) };
  const observer = createQuotaObserver(cdp, 1, () => {}, {schedule:()=>1, cancel:()=>{}, reportHealth: s=>health.push(s)});
  try {
    for (const [sequence, visible] of [[1, false], [2, true]]) observer.capture({appProtocol:true,topFrame:true,
      workbench:{schemaVersion:1,sequence,events:[{sequence,phase:"frame",active:true,destroyed:false,
        frameReady:true,frameConnected:true,pageConnected:true,hostBindingLive:true,pageVisible:visible,frameVisible:visible}]}});
    assert.deepEqual(health, ["error", "ready"]);
    observer.capture({appProtocol:true,topFrame:true,workbench:{schemaVersion:1,sequence:3,events:[{
      sequence:3,phase:"frame",active:true,destroyed:false,frameReady:true,frameConnected:true,pageConnected:true,
      hostBindingLive:true,pageVisible:true,frameVisible:true,frameOccluded:true}]}});
    assert.equal(health.at(-1),"error","a geometrically visible but intercepted frame is unhealthy");
  } finally {observer.dispose();}
});

test("frame handshake diagnostics retain only bounded facts, never authority or native hit content", () => {
  const safe=sanitizeStartupDiagnostic(JSON.stringify({launchDiagnostic:{event:"workbench-trace",trace:{phase:"loading",
    frameAwaitingChallenge:true,frameLoadAcknowledged:true,frameLoadEvents:2,frameOccluded:false,
    challenge:"PRIVATE",capability:"PRIVATE",hitElement:"PRIVATE",nativeCSS:"PRIVATE"}}})).trace;
  assert.equal(safe.frameLoadEvents,2);assert.equal(safe.frameAwaitingChallenge,true);
  assert.equal(safe.frameLoadAcknowledged,true);assert.equal(safe.frameOccluded,false);
  assert.doesNotMatch(JSON.stringify(safe),/PRIVATE/);
  const invalid=sanitizeStartupDiagnostic(JSON.stringify({launchDiagnostic:{event:"workbench-trace",trace:{
    frameLoadEvents:1001,frameAwaitingChallenge:"true",frameOccluded:{text:"PRIVATE"}}}})).trace;
  assert.equal(invalid.frameLoadEvents,undefined);assert.equal(invalid.frameAwaitingChallenge,undefined);
  assert.equal(invalid.frameOccluded,undefined);
});

test('new mount, bootstrap and observation diagnostics discard arbitrary native or helper data',()=>{
  const trace=sanitizeStartupDiagnostic(JSON.stringify({launchDiagnostic:{event:'workbench-trace',trace:{mountState:'unavailable',pageVisibility:'clipped',frameVisibility:'native-hidden',pageHidden:true,failure:'mount-unavailable',nativeCSS:'PRIVATE'}}})).trace;
  assert.equal(trace.mountState,'unavailable');assert.equal(trace.pageVisibility,'clipped');assert.equal(trace.pageHidden,true);assert.doesNotMatch(JSON.stringify(trace),/PRIVATE/);
  const observation=sanitizeStartupDiagnostic(JSON.stringify({launchDiagnostic:{event:'process-observation',observation:'timeout',observationFailures:1,stderr:'PRIVATE',command:'PRIVATE'}}));
  assert.deepEqual(observation,{event:'process-observation',observation:'timeout',observationFailures:1});
  const bootstrap=sanitizeStartupDiagnostic(JSON.stringify({launchDiagnostic:{event:'frame-bootstrap',bootstrap:'ready',nonce:'PRIVATE'}}));
  assert.deepEqual(bootstrap,{event:'frame-bootstrap',bootstrap:'ready'});
});

test("workbench health remains current after trace budget exhaustion and without quota API", () => {
  const records = [], health = [], handlers = new Map();
  const budget = createWorkbenchTraceBudget(record => records.push(record));
  const cdp = { closed: false, on(name, handler) { handlers.set(name, handler); return () => handlers.delete(name); },
    send: async () => ({ result: { value: null } }) };
  const observer = createQuotaObserver(cdp, 3, () => {}, { emitWorkbench: budget,
    reportHealth: value => health.push(value), schedule: () => 1, cancel: () => {} });
  try {
    for (let sequence = 1; sequence <= 60; sequence++) observer.capture({
      appProtocol: true, topFrame: true, apiPresent: false,
      workbench: { schemaVersion: 1, sequence, events: [{ sequence, phase: sequence % 2 ? "frame" : "error",
        active: true, destroyed: false, pageConnected: true, frameConnected: true, frameReady: true,
        hostBindingLive: true, failure: "none", privateTitle: "PRIVATE" }] },
    });
    assert.equal(records.length, 49); assert.equal(records.at(-1).phase, "trace-limit");
    assert.equal(health.length, 60); assert.equal(health.at(-1), "error");
    assert.doesNotMatch(JSON.stringify(records), /PRIVATE/);
    const diagnostic = sanitizeStartupDiagnostic(JSON.stringify({ launchDiagnostic: {
      event: "workbench-health", health: "error", token: "PRIVATE", renderer: 3 } }));
    assert.deepEqual(diagnostic, { event: "workbench-health", renderer: 3, health: "error" });
    observer.capture({ appProtocol: true, topFrame: false, apiPresent: false,
      workbench: { schemaVersion: 1, sequence: 61, events: [{ sequence: 61, active: false, destroyed: false }] } });
    assert.equal(health.length, 60, "child-frame cannot supply host health");
    observer.capture({ appProtocol: true, topFrame: true, apiPresent: false,
      workbench: { schemaVersion: 1, sequence: 61, events: [{ active: false, destroyed: false }] } });
    assert.equal(health.length, 60, "malformed state cannot produce a false inactive status");
    observer.capture({ appProtocol: true, topFrame: true, apiPresent: false,
      workbench: { schemaVersion: 1, sequence: 61, events: [{ sequence: 61, phase: "idle", active: false, destroyed: false }] } });
    assert.equal(health.at(-1), "inactive", "malformed events cannot poison the sequence cursor");
  } finally { observer.dispose(); }
});
