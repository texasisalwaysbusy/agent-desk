import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { test } from "node:test";
import { JSDOM } from "jsdom";

import {
  normalizeRendererContractProbe,
  rendererContractProbeExpression,
} from "../scripts/codex-renderer-compatibility.mjs";

const quotaSource = await readFile(new URL("../inject/codex-quota-display.user.js", import.meta.url), "utf8");
const deskSource = await readFile(new URL("../inject/codex-taskboard.user.js", import.meta.url), "utf8");
const snapshot = () => ({ schemaVersion: 1, fetchedAtMs: Date.now(), buckets: [{
  id: "codex", windows: [{ kind: "primary", remainingPercent: 60, durationMinutes: 300 },
    { kind: "secondary", remainingPercent: 40, durationMinutes: 10080 }],
}] });

function fixture(nested) {
  const scroll = `<div class="overflow-y-auto" data-app-action-sidebar-scroll>
    <section data-app-action-sidebar-section><div role="button" class="sidebar-item"
      data-app-action-sidebar-project-row>Fixture project</div></section></div>`;
  const dom = new JSDOM(`<!doctype html><html><body>
    <aside data-app-shell-left-panel-appearance="content-surface">
      <nav role="navigation" aria-label="App navigation">
        <div><button class="sidebar-item">New chat</button></div>
        ${nested ? `<div>${scroll}</div>` : scroll}
      </nav>
    </aside>
    <main><div><div data-app-shell-main-content-layout>
      <div class="app-shell-main-content-frame"></div>
    </div></div></main>
  </body></html>`, { url: "app://codex/", runScripts: "outside-only", pretendToBeVisual: true });
  dom.window.HTMLElement.prototype.getBoundingClientRect = () => ({
    width: 400, height: 600, top: 0, left: 0, right: 400, bottom: 600,
  });
  dom.window.electronBridge = { sendMessageFromView() {} };
  dom.window.__CODEX_TASKBOARD_SOURCE_HASH__ = "integration-fixture";
  return dom;
}

function contract(dom) {
  return normalizeRendererContractProbe(dom.window.eval(rendererContractProbeExpression));
}

function bothMounted(dom) {
  const document = dom.window.document;
  assert.equal(document.querySelectorAll("#codex-taskboard-entry").length, 1);
  assert.equal(document.querySelectorAll("#codex-taskboard-quota-display").length, 1);
  assert.equal(dom.window.__codexTaskboardQuotaDisplay__.status().mounted, true);
  assert.equal(contract(dom).compatible, true);
  assert.equal(contract(dom).checks.headerReference, true);
}

function dispose(dom) {
  dom.window.__codexTaskboardInjection__?.destroy();
  dom.window.__codexTaskboardQuotaDisplay__?.cleanup();
  dom.window.close();
}

for (const nested of [false, true]) {
  for (const quotaFirst of [true, false]) {
    test(`entry and quota coexist with ${nested ? "wrapped" : "direct"} scroll and ${quotaFirst ? "quota" : "entry"} mounted first`, async () => {
      const dom = fixture(nested);
      try {
        assert.equal(contract(dom).compatible, true);
        dom.window.eval(quotaFirst ? quotaSource : deskSource);
        dom.window.eval(quotaFirst ? deskSource : quotaSource);
        await new Promise((resolve) => dom.window.setTimeout(resolve, 0));
        dom.window.__codexTaskboardInjection__.refresh();
        dom.window.__codexTaskboardQuotaDisplay__.update(snapshot());
        bothMounted(dom);
        assert.equal(dom.window.__codexTaskboardQuotaDisplay__.status().freshness, "fresh");

        // React may replace either native section while the owned singletons remain.
        const navigation = dom.window.document.querySelector('nav[role="navigation"]');
        const newHeader = navigation.firstElementChild.cloneNode(true);
        newHeader.querySelectorAll("[data-codex-taskboard-owned]").forEach((node) => node.remove());
        navigation.firstElementChild.replaceWith(newHeader);
        const scroll = navigation.querySelector("[data-app-action-sidebar-scroll]");
        scroll.replaceWith(scroll.cloneNode(true));
        await new Promise((resolve) => dom.window.setTimeout(resolve, 0));
        dom.window.__codexTaskboardInjection__.refresh();
        bothMounted(dom);

        dom.window.__codexTaskboardInjection__.destroy();
        dom.window.__codexTaskboardQuotaDisplay__.cleanup();
        dom.window.eval(quotaSource);
        dom.window.eval(deskSource);
        bothMounted(dom);
        assert.equal(dom.window.__codexTaskboardQuotaDisplay__.status().freshness, "fresh");
      } finally { dispose(dom); }
    });
  }
}

test("the combined sidebar rejects unknown siblings and incorrectly positioned owned cards", () => {
  const dom = fixture(false);
  try {
    dom.window.eval(quotaSource);
    assert.equal(contract(dom).compatible, true);
    const navigation = dom.window.document.querySelector('nav[role="navigation"]');
    const unexpected = dom.window.document.createElement("div");
    navigation.append(unexpected);
    assert.equal(contract(dom).compatible, false);
    unexpected.remove();
    const host = dom.window.document.getElementById("codex-taskboard-quota-display");
    host.setAttribute("data-codex-taskboard-owned", "wrong-owner");
    assert.equal(contract(dom).compatible, false);
    host.setAttribute("data-codex-taskboard-owned", "quota-display");
    navigation.prepend(host);
    assert.equal(contract(dom).compatible, false);
  } finally { dispose(dom); }
});

for (const label of ["新聊天", "新聊天 Ctrl+N", "Start a conversation"]) {
  test(`native New Chat navigation restores the complete workspace for ${label}`, () => {
    const dom = fixture(false);
    try {
      const document = dom.window.document;
      const nativeNewChat = document.querySelector("button.sidebar-item");
      nativeNewChat.innerHTML = `<span>${label}</span>`;
      const main = document.querySelector("main");
      main.insertAdjacentHTML("afterbegin", `<header data-app-shell-header-layout="home">
        <div data-testid="app-shell-header-context-menu-surface"><button>Native action</button></div>
        <div><div data-app-shell-header-obstacle><button>聊天 / 工作</button></div></div>
        <button id="window-control">Minimize</button>
      </header>`);
      document.body.insertAdjacentHTML("beforeend", `<div data-app-shell-header-obstacle id="unrelated">Unrelated</div>`);
      dom.window.eval(quotaSource);
      dom.window.eval(deskSource);
      const api = dom.window.__codexTaskboardInjection__;
      const hidden = "data-codex-taskboard-native-hidden";
      const nativeViewport = document.querySelector("[data-app-shell-main-content-layout]");
      let nativeClicks = 0;
      nativeNewChat.addEventListener("click", (event) => {
        nativeClicks += 1;
        assert.equal(event.defaultPrevented, false);
        assert.equal(document.documentElement.hasAttribute("data-codex-taskboard-open"), false,
          "restore before the native click handler runs, including when already on New Chat");
        assert.equal(nativeViewport.hasAttribute(hidden), false);
      });
      for (let iteration = 0; iteration < 2; iteration += 1) {
        document.getElementById("codex-taskboard-entry").click();
        assert.equal(document.documentElement.getAttribute("data-codex-taskboard-open"), "true");
        assert.equal(main.querySelector("[data-app-shell-header-obstacle]").getAttribute(hidden), "true");
        assert.equal(document.getElementById("window-control").hasAttribute(hidden), false);
        assert.equal(document.getElementById("unrelated").hasAttribute(hidden), false);
        // A native rerender must be suppressed too; closing must restore the replacement.
        const obstacle = main.querySelector("[data-app-shell-header-obstacle]");
        obstacle.replaceWith(obstacle.cloneNode(true));
        main.querySelector("[data-app-shell-header-obstacle]").removeAttribute(hidden);
        api.refresh();
        assert.equal(main.querySelector("[data-app-shell-header-obstacle]").getAttribute(hidden), "true");
        nativeNewChat.querySelector("span").click();
        assert.equal(document.querySelectorAll(`[${hidden}]`).length, 0);
        assert.equal(document.getElementById("codex-taskboard-page").hidden, true);
        bothMounted(dom);
      }
      assert.equal(nativeClicks, 2);
      const project = document.querySelector("[data-app-action-sidebar-project-row]");
      project.setAttribute("data-app-action-sidebar-thread-id", "fixture-thread");
      project.setAttribute("aria-current", "page");
      api.open();
      assert.equal(project.hasAttribute("aria-current"), false);
      project.click();
      assert.equal(document.documentElement.hasAttribute("data-codex-taskboard-open"), false);
      assert.equal(project.getAttribute("aria-current"), "page");
      bothMounted(dom);
      api.open();
      api.destroy();
      assert.equal(document.querySelectorAll(`[${hidden}]`).length, 0);
    } finally { dispose(dom); }
  });
}

test("section toggles and unknown header controls do not close the workbench", () => {
  const dom = fixture(false);
  try {
    dom.window.eval(deskSource);
    const document = dom.window.document;
    const scroll = document.querySelector("[data-app-action-sidebar-scroll]");
    scroll.insertAdjacentHTML("beforeend", `<button data-app-action-sidebar-section-toggle>新聊天</button><button>Unknown</button>`);
    dom.window.__codexTaskboardInjection__.open();
    for (const button of scroll.querySelectorAll("button")) {
      button.click();
      assert.equal(document.documentElement.getAttribute("data-codex-taskboard-open"), "true");
    }
  } finally { dispose(dom); }
});
