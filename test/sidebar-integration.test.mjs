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
  const dom = new JSDOM(`<!doctype html><html><style>nav { display:flex; flex-direction:column; }</style><body>
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

test("header entry owns a separate row, parks on unsupported routes and restores without native mutations", () => {
  const dom = fixture(true);
  try {
    const d = dom.window.document, nav = d.querySelector("nav"), header = nav.firstElementChild;
    const nativeMarkup = header.outerHTML;
    header.style.display = "flex";
    const expectedHeader = header.outerHTML;
    dom.window.eval(quotaSource); dom.window.eval(deskSource);
    const api = dom.window.__codexTaskboardInjection__, entry = d.getElementById("codex-taskboard-entry");
    const branch = nav.querySelector(".overflow-y-auto").parentElement;
    assert.equal(entry.parentElement, nav); assert.equal(entry.nextElementSibling, branch);
    assert.equal(header.outerHTML, expectedHeader); bothMounted(dom);
    assert.equal(api.diagnostics().events.at(-1).entrySeparateRow, true);
    header.hidden = true; branch.hidden = true; api.refresh();
    assert.equal(entry.hidden, true, "independent row must not survive without its native reference");
    header.hidden = false; branch.hidden = false; api.refresh(); bothMounted(dom);
    assert.equal(entry.hidden, false);
    api.destroy();
    assert.equal(header.outerHTML, expectedHeader);
    header.removeAttribute("style"); assert.equal(header.outerHTML, nativeMarkup);
  } finally { dispose(dom); }
});

for (const invalid of ["wrong-owner", "wrong-layout", "wrong-position", "duplicate"]) {
  test(`strict native contract cannot ignore an entry row with ${invalid}`, () => {
    const dom = fixture(false);
    try {
      dom.window.eval(deskSource);
      const d = dom.window.document, entry = d.getElementById("codex-taskboard-entry");
      assert.equal(contract(dom).checks.headerReference, true);
      if (invalid === "wrong-owner") entry.setAttribute("data-codex-taskboard-owned", "other");
      else if (invalid === "wrong-layout") entry.setAttribute("data-codex-taskboard-entry-layout", "other");
      else if (invalid === "wrong-position") entry.parentElement.append(entry);
      else entry.after(entry.cloneNode(true));
      assert.equal(contract(dom).checks.headerReference, false);
      assert.equal(contract(dom).compatible, false);
    } finally { dispose(dom); }
  });
}

for (const nested of [false, true]) {
  for (const hiddenBy of ["hidden", "inert", "aria-hidden", "display", "visibility"]) {
    for (const position of ["before-header", "between", "after-scroll"]) {
      test(`retained native child ${hiddenBy}/${position}/${nested ? "wrapped" : "direct"} cannot poison home recovery or New Chat contract`, async () => {
        const dom = fixture(nested);
        try {
          dom.window.eval(quotaSource); dom.window.eval(deskSource);
          const document = dom.window.document, nav = document.querySelector("nav");
          const header = nav.firstElementChild, scroll = nav.querySelector(".overflow-y-auto");
          const branch = nested ? scroll.parentElement : scroll;
          const retained = document.createElement("div"); retained.className = "overflow-y-auto";
          const hide = (node, value) => {
            if (hiddenBy === "hidden" || hiddenBy === "inert") node.toggleAttribute(hiddenBy, value);
            else if (hiddenBy === "aria-hidden") { if (value) node.setAttribute(hiddenBy, "true"); else node.removeAttribute(hiddenBy); }
            else node.style[hiddenBy] = value ? (hiddenBy === "display" ? "none" : "hidden") : "";
          };
          hide(retained, true);
          if (position === "before-header") nav.prepend(retained);
          else if (position === "between") header.after(retained);
          else nav.append(retained);
          const settle = () => new Promise(resolve => dom.window.setTimeout(resolve, 100));
          await settle(); bothMounted(dom);
          for (let round = 0; round < 3; round++) {
            hide(header, true); hide(branch, true); hide(retained, false);
            await settle();
            assert.equal(dom.window.__codexTaskboardQuotaDisplay__.status().mounted, false,
              "unreferenced scheduled layout parks; no fallback to hidden home");
            hide(header, false); hide(branch, false); hide(retained, true);
            await settle(); bothMounted(dom);
            const diagnostic = dom.window.__codexTaskboardQuotaDisplay__.diagnostics().events.at(-1);
            assert.equal(diagnostic.reason, "mounted"); assert.equal(diagnostic.nativeChildren, 3); assert.equal(diagnostic.hiddenNativeChildren, 1);
          }
          document.getElementById("codex-taskboard-entry").click();
          header.querySelector("button:not([data-codex-taskboard-owned])").click();
          assert.equal(document.documentElement.hasAttribute("data-codex-taskboard-open"), false);
        } finally { dispose(dom); }
      });
    }
  }
}

test("hidden retained native navigation does not poison quota, entry or renderer contract; visible ambiguity is rejected", async () => {
  const dom = fixture(true);
  try {
    dom.window.eval(quotaSource); dom.window.eval(deskSource);
    const home = dom.window.document.querySelector('nav');
    const retained = home.cloneNode(true);
    retained.querySelectorAll('[data-codex-taskboard-owned]').forEach((node) => node.remove());
    retained.setAttribute('aria-hidden', 'true');
    home.parentElement.append(retained);
    await new Promise((resolve) => dom.window.setTimeout(resolve, 100));
    bothMounted(dom);
    home.setAttribute('inert', ''); retained.removeAttribute('aria-hidden');
    await new Promise((resolve) => dom.window.setTimeout(resolve, 100));
    bothMounted(dom);
    assert.equal(dom.window.document.getElementById('codex-taskboard-entry').closest('nav'), retained);
    home.removeAttribute('inert');
    await new Promise((resolve) => dom.window.setTimeout(resolve, 0));
    assert.equal(contract(dom).compatible, false);
    assert.equal(dom.window.__codexTaskboardQuotaDisplay__.status().mounted, false);
    retained.setAttribute('aria-hidden', 'true');
    await new Promise((resolve) => dom.window.setTimeout(resolve, 100));
    bothMounted(dom);
  } finally { dispose(dom); }
});

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

for (const nested of [false, true]) test(`the combined ${nested ? "wrapped" : "direct"} sidebar rejects unknown siblings and incorrectly positioned owned cards`, () => {
  const dom = fixture(nested);
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
