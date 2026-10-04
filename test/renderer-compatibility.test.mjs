import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { test } from "node:test";
import vm from "node:vm";
import { JSDOM } from "jsdom";

import {
  classifyWindowsCodexCompatibility,
  guardRendererInjectionSource,
  normalizeRendererContractProbe,
  parseWindowsCodexVersion,
  probeRendererContract,
  rendererContractProbeExpression,
} from "../scripts/codex-renderer-compatibility.mjs";

const allCapabilities = { fullPanel: true, quotaDisplay: true, taskNavigation: true };
const injectorSource = await readFile(new URL("../scripts/codex-injector.mjs", import.meta.url), "utf8");
const injectionSource = await readFile(new URL("../inject/codex-taskboard.user.js", import.meta.url), "utf8");

function fixture(url = "app://codex/index.html") {
  const dom = new JSDOM(`<!doctype html><html><body>
    <aside class="app-shell-left-panel"><div><div data-app-action-sidebar-scroll>
      <div><button>New task</button><button>Scheduled</button><button>Plugins</button></div>
      <section data-app-action-sidebar-section></section>
    </div></div></aside>
    <main><div><div data-app-shell-main-content-layout>
      <div class="app-shell-main-content-frame"></div>
    </div></div></main>
  </body></html>`, { url, runScripts: "outside-only" });
  dom.window.HTMLElement.prototype.getBoundingClientRect = () => ({
    x: 0, y: 0, top: 0, left: 0, width: 800, height: 600, right: 800, bottom: 600,
  });
  dom.window.electronBridge = { sendMessageFromView() {} };
  return dom;
}

function updatedFixture(url = "app://codex/index.html") {
  const dom = new JSDOM(`<!doctype html><html><body>
    <aside data-app-shell-left-panel-appearance="content-surface">
      <nav role="navigation" aria-label="App navigation">
        <div class="min-h-0 flex-1 overflow-y-auto">
          <div><button class="sidebar-item">New task</button><button class="sidebar-item">Projects</button></div>
        </div>
      </nav>
    </aside>
    <main data-app-shell-main-surface="default">
      <div><div data-app-shell-main-content-layout="full-bleed">
        <div class="_MainContentFrame_example"><div data-app-shell-focus-area="main"></div></div>
        <div class="right-panel"></div>
      </div></div>
    </main>
  </body></html>`, { url, runScripts: "outside-only" });
  dom.window.HTMLElement.prototype.getBoundingClientRect = () => ({
    x: 0, y: 0, top: 0, left: 0, width: 400, height: 600, right: 400, bottom: 600,
  });
  dom.window.electronBridge = { sendMessageFromView() {} };
  return dom;
}

function fixedHeaderFixture() {
  const dom = updatedFixture();
  const aside = dom.window.document.querySelector("aside");
  aside.innerHTML = `<nav aria-label="Other navigation"><div class="overflow-y-auto">
      <button>Other route</button></div></nav>
    <nav role="navigation" aria-label="App navigation">
      <div><div><button class="sidebar-item group"><span>New task</span></button></div></div>
      <div><div class="overflow-y-auto" data-app-action-sidebar-scroll>
        <section data-app-action-sidebar-section>
          <div role="button" tabindex="0" class="sidebar-item group"
            data-app-action-sidebar-project-row><span>Project</span></div>
        </section>
      </div></div>
    </nav>`;
  return dom;
}

function probe(dom) {
  return JSON.parse(JSON.stringify(dom.window.eval(rendererContractProbeExpression)));
}

test("old, current and future Store versions are candidates, never unconditional support", () => {
  for (const version of [
    "26.818.5229.0", "26.818.8289.0", "26.820.7780.0", "26.825.3734.0",
    "26.831.1445.0", "26.831.2377.0", "26.901.1.0", "26.917.1.0",
    "26.924.1866.0", "26.924.2738.0", "26.924.2739.0", "26.925.1.0",
    "27.1.0.0", "65535.65535.65535.65535",
  ]) {
    const decision = classifyWindowsCodexCompatibility({ platform: "win32", version });
    assert.equal(decision.mode, "contract-probe", version);
    assert.equal(decision.capabilities, null, version);
  }
  for (const version of ["26.818.5228.9999", "26.817.9999.0", "25.999.9999.0"]) {
    assert.equal(classifyWindowsCodexCompatibility({ platform: "win32", version }).reason,
      "below-tested-baseline", version);
  }
});

test("malformed, out-of-range and non-Windows versions fail closed", () => {
  for (const version of [null, 26831, "", "unknown", "26.831.1", "26.831.1.0-beta", "26.831.1.0x",
    "-26.831.1.0", "26.831.65536.0", "999999999999.1.1.1", "26.831.1.0\nmalicious"]) {
    assert.equal(parseWindowsCodexVersion(version), null);
    assert.equal(classifyWindowsCodexCompatibility({ platform: "win32", version }).mode,
      "shortcut-plugin-only");
  }
  assert.deepEqual(parseWindowsCodexVersion(" 26.831.2377.0 "), [26, 831, 2377, 0]);
  assert.equal(classifyWindowsCodexCompatibility({ platform: "linux", version: "26.831.2377.0" }).mode,
    "shortcut-plugin-only");
});

test("actual renderer fixture passes without modifying its DOM or calling the native bridge", () => {
  const dom = fixture();
  try {
    dom.window.electronBridge.sendMessageFromView = () => { throw new Error("probe must not call RPC"); };
    const before = dom.serialize();
    const result = normalizeRendererContractProbe(probe(dom));
    assert.equal(result.compatible, true);
    assert.deepEqual(result.capabilities, allCapabilities);
    assert.equal(dom.serialize(), before);
  } finally { dom.window.close(); }
});

test("updated Codex sidebar and split content frame pass the read-only contract", () => {
  const dom = updatedFixture();
  try {
    dom.window.electronBridge.sendMessageFromView = () => { throw new Error("probe must not call RPC"); };
    const before = dom.serialize();
    const result = normalizeRendererContractProbe(probe(dom));
    assert.equal(result.compatible, true);
    assert.deepEqual(result.capabilities, allCapabilities);
    assert.equal(dom.serialize(), before);
    dom.window.document.querySelector('nav[role="navigation"]').remove();
    assert.equal(normalizeRendererContractProbe(probe(dom)).compatible, false);
  } finally { dom.window.close(); }
});

test("updated Codex navigation links qualify only inside the visible native sidebar", () => {
  const dom = updatedFixture();
  try {
    const navigation = dom.window.document.querySelector('nav[role="navigation"]');
    navigation.querySelectorAll("button.sidebar-item").forEach((button) => {
      const link = dom.window.document.createElement("a");
      link.className = button.className;
      link.href = "/projects";
      link.textContent = button.textContent;
      button.replaceWith(link);
    });
    assert.equal(normalizeRendererContractProbe(probe(dom)).compatible, true);
    navigation.querySelectorAll("a.sidebar-item").forEach((link) => link.removeAttribute("href"));
    assert.equal(normalizeRendererContractProbe(probe(dom)).compatible, false);
  } finally { dom.window.close(); }
});

test("read-only renderer shape reports counts without native labels or destinations", () => {
  const dom = updatedFixture();
  try {
    const navigation = dom.window.document.querySelector('nav[role="navigation"]');
    const scroll = navigation.querySelector("div.overflow-y-auto");
    scroll.setAttribute("data-app-action-sidebar-scroll", "");
    const before = dom.serialize();
    const result = normalizeRendererContractProbe(probe(dom));
    assert.equal(dom.serialize(), before);
    assert.deepEqual(result.shape, {
      sameScroll: true,
      navigationElements: 4,
      navigationButtons: 2,
      navigationLinks: 0,
      navigationRoleButtons: 0,
      scrollButtons: 2,
      scrollLinks: 0,
      scrollRoleButtons: 0,
      scrollSidebarItems: 2,
      scrollElements: 3,
      scrollDirectChildren: 1,
    });
    assert.equal(JSON.stringify(result.shape).includes("New task"), false);
  } finally { dom.window.close(); }
});

test("a native navigation link remains a valid reference when modern and legacy scroll markers coincide", () => {
  const dom = updatedFixture();
  try {
    const scroll = dom.window.document.querySelector("div.overflow-y-auto");
    scroll.setAttribute("data-app-action-sidebar-scroll", "");
    scroll.querySelectorAll("button.sidebar-item").forEach((button) => {
      const link = dom.window.document.createElement("a");
      link.className = "sidebar-item";
      link.href = "/projects";
      link.textContent = button.textContent;
      button.replaceWith(link);
    });
    const result = normalizeRendererContractProbe(probe(dom));
    assert.equal(result.compatible, true);
    assert.equal(result.checks.legacyScroll, true);
    assert.equal(result.checks.modernLink, true);
    assert.equal(result.checks.modernReferenceInChosenScroll, true);
    const referenceSource = injectionSource.slice(
      injectionSource.indexOf("function visibleNativeFlow("),
      injectionSource.indexOf("function replaceEntryIcon("),
    );
    const context = vm.createContext({
      document: dom.window.document,
      getComputedStyle: dom.window.getComputedStyle.bind(dom.window),
    });
    vm.runInContext(referenceSource, context);
    assert.equal(vm.runInContext("findReferenceButton().tagName", context), "A");
  } finally { dom.window.close(); }
});

test("26.924 fixed-header row qualifies only with one matching navigation and scroll", () => {
  const dom = fixedHeaderFixture();
  try {
    const before = dom.serialize();
    const result = normalizeRendererContractProbe(probe(dom));
    assert.equal(result.compatible, true);
    assert.equal(result.checks.headerReference, true);
    assert.equal(result.checks.modernButton, false);
    assert.equal(result.shape.sameScroll, true);
    assert.equal(dom.serialize(), before);
    const referenceSource = injectionSource.slice(
      injectionSource.indexOf("function visibleNativeFlow("),
      injectionSource.indexOf("function replaceEntryIcon("),
    );
    const context = vm.createContext({
      document: dom.window.document,
      getComputedStyle: dom.window.getComputedStyle.bind(dom.window),
      ENTRY_ID: "codex-taskboard-entry",
      OWNED_ATTRIBUTE: "data-codex-taskboard-owned",
    });
    vm.runInContext(referenceSource, context);
    assert.equal(vm.runInContext("findReferenceButton().textContent", context), "New task");
    const header = dom.window.document.querySelector('nav[role="navigation"] > div:first-child');
    header.insertAdjacentHTML("beforeend", `<button id="codex-taskboard-entry"
      class="sidebar-item" data-codex-taskboard-owned="true">Agent Desk</button>`);
    assert.equal(normalizeRendererContractProbe(probe(dom)).compatible, true);
    assert.equal(vm.runInContext("findReferenceButton().textContent", context), "New task");
    header.insertAdjacentHTML("beforeend", '<button class="sidebar-item">Ambiguous</button>');
    assert.equal(normalizeRendererContractProbe(probe(dom)).compatible, false);
    assert.equal(vm.runInContext("findReferenceButton()", context), null);
  } finally { dom.window.close(); }
});

test("hidden old navigation cannot displace the visible updated sidebar", () => {
  const dom = updatedFixture();
  try {
    dom.window.document.body.insertAdjacentHTML("afterbegin", `
      <aside class="app-shell-left-panel" style="display:none">
        <div data-app-action-sidebar-scroll><button>Plugins</button></div>
      </aside>
    `);
    const result = normalizeRendererContractProbe(probe(dom));
    assert.equal(result.compatible, true);
    const referenceSource = injectionSource.slice(
      injectionSource.indexOf("function visibleNativeFlow("),
      injectionSource.indexOf("function replaceEntryIcon("),
    );
    const context = vm.createContext({
      document: dom.window.document,
      getComputedStyle: dom.window.getComputedStyle.bind(dom.window),
    });
    vm.runInContext(referenceSource, context);
    assert.equal(vm.runInContext("findReferenceButton().textContent", context), "New task");
    dom.window.document.querySelector("aside.app-shell-left-panel").style.display = "block";
    assert.equal(normalizeRendererContractProbe(probe(dom)).compatible, false);
  } finally { dom.window.close(); }
});

test("updated Codex entry and page mount use the same validated anchors", () => {
  const dom = updatedFixture();
  try {
    const referenceSource = injectionSource.slice(
      injectionSource.indexOf("function visibleNativeFlow("),
      injectionSource.indexOf("function replaceEntryIcon("),
    );
    const pageSource = injectionSource.slice(
      injectionSource.indexOf("function findPageHost()"),
      injectionSource.indexOf("function muteNativeSelection("),
    );
    const context = vm.createContext({
      document: dom.window.document,
      getComputedStyle: dom.window.getComputedStyle.bind(dom.window),
    });
    vm.runInContext(`${referenceSource}\n${pageSource}`, context);
    assert.equal(vm.runInContext("findReferenceButton().textContent", context), "New task");
    assert.equal(vm.runInContext("findPageMount().frameHost", context),
      dom.window.document.querySelector("._MainContentFrame_example"));
  } finally { dom.window.close(); }
});

test("updated sidebar ignores hidden copies and rejects two visible candidates", () => {
  const dom = updatedFixture();
  try {
    const duplicate = dom.window.document.querySelector("aside").cloneNode(true);
    duplicate.style.display = "none";
    dom.window.document.body.prepend(duplicate);
    assert.equal(normalizeRendererContractProbe(probe(dom)).compatible, true);
    duplicate.style.display = "block";
    assert.equal(normalizeRendererContractProbe(probe(dom)).compatible, false);
  } finally { dom.window.close(); }
});

test("missing native bridge only removes optional capabilities", () => {
  const dom = fixture();
  try {
    delete dom.window.electronBridge;
    const result = normalizeRendererContractProbe(probe(dom));
    assert.equal(result.compatible, true);
    assert.deepEqual(result.capabilities, { fullPanel: true, quotaDisplay: false, taskNavigation: false });
  } finally { dom.window.close(); }
});

test("contract rejects missing mount, missing sidebar and non-app origin", () => {
  for (const selector of ["main", "[data-app-action-sidebar-scroll]"]) {
    const dom = fixture();
    try {
      dom.window.document.querySelector(selector).remove();
      assert.equal(normalizeRendererContractProbe(probe(dom)).compatible, false);
    } finally { dom.window.close(); }
  }
  const dom = fixture("https://example.test/");
  try { assert.equal(normalizeRendererContractProbe(probe(dom)).compatible, false); }
  finally { dom.window.close(); }
});

test("capability claims cannot override absent or false prerequisite checks", () => {
  assert.equal(normalizeRendererContractProbe({ schemaVersion: 1, capabilities: allCapabilities }).compatible, false);
  const dom = fixture();
  try {
    for (const key of ["appProtocol", "topFrame", "sidebarScroll", "pageMount", "referenceButton"]) {
      const value = probe(dom);
      value.checks[key] = false;
      assert.deepEqual(normalizeRendererContractProbe(value).capabilities,
        { fullPanel: false, quotaDisplay: false, taskNavigation: false }, key);
    }
    const value = probe(dom);
    value.checks.nativeBridge = "true";
    assert.deepEqual(normalizeRendererContractProbe(value).capabilities,
      { fullPanel: true, quotaDisplay: false, taskNavigation: false });
  } finally { dom.window.close(); }
});

test("probe retries a loading shell but fails closed on evaluation and transport errors", async () => {
  const dom = fixture();
  try {
    let time = 0;
    let attempts = 0;
    const result = await probeRendererContract(async () => ({ result: { value: ++attempts < 3 ? null : probe(dom) } }),
      { timeoutMs: 1000, retryMs: 100, now: () => time, wait: async (delay) => { time += delay; } });
    assert.equal(result.compatible, true);
    assert.equal(attempts, 3);
    assert.equal((await probeRendererContract(async () => ({ exceptionDetails: {} }), { timeoutMs: 0 })).reason,
      "probe-evaluation-failed");
    assert.equal((await probeRendererContract(async () => { throw new Error("closed"); }, { timeoutMs: 0 })).reason,
      "probe-transport-failed");
  } finally { dom.window.close(); }
});

test("document-start injection waits for the shell and rechecks optional capabilities", async () => {
  const dom = fixture();
  try {
    delete dom.window.electronBridge;
    const aside = dom.window.document.querySelector("aside");
    aside.remove();
    const pending = dom.window.eval(guardRendererInjectionSource("window.testInjected = true;", allCapabilities,
      { timeoutMs: 1000, retryMs: 5 }));
    assert.equal(dom.window.testInjected, undefined);
    dom.window.document.body.prepend(aside);
    await pending;
    assert.equal(dom.window.testInjected, true);
    assert.equal(dom.window.__CODEX_TASKBOARD_COMPATIBILITY_CAPABILITIES__.quotaDisplay, false);
  } finally { dom.window.close(); }
});

test("registered source does not inject or publish host configuration in an incompatible document", async () => {
  const script = guardRendererInjectionSource("window.testHostCapability = 'must-not-publish';", allCapabilities,
    { timeoutMs: 0 });
  for (const url of ["https://example.test/", "app://codex/index.html"]) {
    const dom = fixture(url);
    try {
      dom.window.document.querySelector("main").remove();
      await dom.window.eval(script);
      assert.equal(dom.window.testHostCapability, undefined);
      assert.equal(dom.window.__CODEX_TASKBOARD_COMPATIBILITY_CAPABILITIES__, undefined);
    } finally { dom.window.close(); }
  }
  const childWindow = { top: {}, location: { protocol: "app:" } };
  await vm.runInNewContext(script, { window: childWindow });
  assert.equal(childWindow.testHostCapability, undefined);
});

test("an initial contract failure retains only a read-only observer without Page/CSP or bindings", async () => {
  const calls = [];
  const cdp = { send: async (method) => { calls.push(method); }, close: () => calls.push("close") };
  const fnSource = injectorSource.slice(injectorSource.indexOf("async function injectTarget("),
    injectorSource.indexOf("async function injectAll("));
  const inject = vm.runInNewContext(`(${fnSource})`, {
    probeRendererContract: async () => normalizeRendererContractProbe(null),
    logLaunchDiagnostic() {},
    rendererOrdinal: 0,
  });
  const result = await inject({ connect: async () => cdp }, {}, false, null, true, {}, false, null,
    { mode: "contract-probe" });
  assert.equal(result.result.injected, false);
  assert.equal(result.connection, null);
  assert.equal(result.rejectionConnection, cdp);
  assert.deepEqual(calls, ["Runtime.enable"]);
  result.rejectionConnection.close();
  assert.deepEqual(calls, ["Runtime.enable", "close"]);
  calls.length = 0;
  await inject({ connect: async () => cdp }, {}, false, null, false, {}, false, null,
    { mode: "contract-probe" });
  assert.deepEqual(calls, ["Runtime.enable", "close"]);
});

test("detach cancels a document-start wait before its shell becomes ready", async () => {
  const dom = fixture();
  try {
    const main = dom.window.document.querySelector("main");
    main.remove();
    const pending = dom.window.eval(guardRendererInjectionSource("window.lateInjection = true;", allCapabilities,
      { timeoutMs: 1000, retryMs: 5 }));
    dom.window.__CODEX_TASKBOARD_PENDING_INJECTION__.cancelled = true;
    dom.window.document.body.append(main);
    await pending;
    assert.equal(dom.window.lateInjection, undefined);
    assert.equal(dom.window.__CODEX_TASKBOARD_PENDING_INJECTION__, undefined);
  } finally { dom.window.close(); }
  const detachSource = injectorSource.slice(injectorSource.indexOf("async function detachInjection("),
    injectorSource.indexOf("async function revalidateLoadedRenderer("));
  assert.match(detachSource, /__CODEX_TASKBOARD_PENDING_INJECTION__\.cancelled = true/);
  assert.match(detachSource, /__codexTaskboardInjection__\?\.destroy\?\.\(\)/);
});

test("reload failure detaches and a valid reload only retains allowed features", async () => {
  const fnSource = injectorSource.slice(injectorSource.indexOf("async function revalidateLoadedRenderer("),
    injectorSource.indexOf("async function injectTarget("));
  let detached = false;
  let result = normalizeRendererContractProbe(null);
  const validate = vm.runInNewContext(`(${fnSource})`, {
    probeRendererContract: async () => result,
    detachInjection: async () => { detached = true; },
    console: { log() {} },
  });
  const cdp = {};
  assert.equal(await validate(cdp, allCapabilities), false);
  assert.equal(detached, true);
  const dom = fixture();
  try {
    result = normalizeRendererContractProbe(probe(dom));
    assert.equal(await validate(cdp, { ...allCapabilities, quotaDisplay: false }), true);
    assert.equal(cdp.taskboardCompatibilityCapabilities.quotaDisplay, false);
  } finally { dom.window.close(); }
  assert.match(injectorSource, /guardRendererInjectionSource\(runtimeSource, capabilities\)/);
  assert.equal(injectorSource.match(/if \(!\(await revalidateLoadedRenderer\(cdp, capabilities\)\)\) return;/g)?.length, 2);
});

test("a web page titled Codex cannot qualify as a renderer target", () => {
  const fnSource = injectorSource.slice(injectorSource.indexOf("function isCodexTarget("),
    injectorSource.indexOf("function pipeCdpRuntime("));
  const match = vm.runInNewContext(`(${fnSource})`);
  assert.equal(match({ type: "page", title: "Codex", url: "https://example.test/" }), false);
  assert.equal(match({ type: "iframe", title: "Codex", url: "app://codex/index.html" }), false);
  assert.equal(match({ type: "page", url: "app://codex/index.html?initialRoute=%2Fglobal-dictation" }), false);
  assert.equal(match({ type: "page", url: "app://codex/index.html" }), true);
});

test("a Store update racing launch has an error handler instead of an unhandled child error", () => {
  assert.match(injectorSource, /child\.once\("error", \(error\) => browser\.fail\(error\)\)/);
  assert.match(injectorSource, /fallback\.once\("error"/);
  assert.match(injectorSource, /restart Taskboard to revalidate the installed package/);
});
