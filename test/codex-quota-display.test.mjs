import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { test } from "node:test";

import { JSDOM } from "jsdom";

const source = await readFile(
  new URL("../inject/codex-quota-display.user.js", import.meta.url),
  "utf8",
);

function fixture({ onQuotaShadow, modern = false } = {}) {
  const sidebar = modern
    ? `<aside data-app-shell-left-panel-appearance="content-surface">
        <nav role="navigation" aria-label="App navigation">
          <div class="min-h-0 flex-1 overflow-y-auto"><button class="sidebar-item">Projects</button></div>
        </nav>
      </aside>`
    : `<aside class="app-shell-left-panel">
        <div class="sidebar-layout">
          <div data-app-action-sidebar-scroll></div>
          <button aria-label="个人资料">用户</button>
        </div>
      </aside>`;
  const dom = new JSDOM(`<!doctype html><html lang="zh-CN"><style>nav { display:flex; flex-direction:column; }</style><body>${sidebar}</body></html>`, {
    pretendToBeVisual: true,
    runScripts: "outside-only",
    url: "app://codex/",
  });
  dom.window.HTMLElement.prototype.getBoundingClientRect = function getBoundingClientRect() {
    if (this.matches?.("aside.app-shell-left-panel")) {
      return { x: 0, y: 0, top: 0, left: 0, right: 280, bottom: 720, width: 280, height: 720 };
    }
    return { x: 0, y: 0, top: 0, left: 0, right: 260, bottom: 200, width: 260, height: 200 };
  };
  if (onQuotaShadow) {
    const attachShadow = dom.window.HTMLElement.prototype.attachShadow;
    dom.window.HTMLElement.prototype.attachShadow = function attachQuotaShadow(options) {
      const shadow = attachShadow.call(this, options);
      if (this.id === "codex-taskboard-quota-display") onQuotaShadow(shadow);
      return shadow;
    };
  }
  dom.window.eval(source);
  return dom;
}

test("embedded quota card mounts after the native conversation scroller with a closed shadow root", () => {
  const dom = fixture();
  const host = dom.window.document.getElementById("codex-taskboard-quota-display");
  const scroller = dom.window.document.querySelector("[data-app-action-sidebar-scroll]");

  assert.ok(host);
  assert.equal(scroller.nextElementSibling, host);
  assert.equal(host.hidden, false);
  assert.equal(host.shadowRoot, null);
  assert.equal(dom.window.__codexTaskboardQuotaDisplay__.status().mounted, true);
  dom.window.__codexTaskboardQuotaDisplay__.cleanup();
  dom.window.close();
});

test("updated Codex sidebar places the quota card inside the validated navigation flow", () => {
  const dom = fixture({ modern: true });
  try {
    const host = dom.window.document.getElementById("codex-taskboard-quota-display");
    const scroller = dom.window.document.querySelector("nav div.overflow-y-auto");
    assert.equal(scroller.nextElementSibling, host);
    assert.equal(host.hidden, false);
    assert.equal(host.shadowRoot, null);
  } finally {
    dom.window.__codexTaskboardQuotaDisplay__.cleanup();
    dom.window.close();
  }
});

test("quota recovers after unsupported scheduled navigation retained hidden beside the homepage", async () => {
  const dom = fixture({ modern: true });
  try {
    const api = dom.window.__codexTaskboardQuotaDisplay__;
    const home = dom.window.document.querySelector("nav");
    const scheduled = dom.window.document.createElement("nav");
    scheduled.setAttribute("role", "navigation");
    scheduled.setAttribute("aria-label", "Fixture scheduled");
    scheduled.hidden = true;
    scheduled.innerHTML = '<div>Unsupported scheduled fixture</div>';
    home.parentElement.append(scheduled);
    const settle = () => new Promise((resolve) => dom.window.setTimeout(resolve, 0));
    await settle();
    assert.equal(api.status().mounted, true);
    for (let i = 0; i < 3; i++) {
      home.setAttribute("inert", ""); scheduled.hidden = false;
      await settle();
      assert.equal(api.status().mounted, false);
      scheduled.setAttribute("aria-hidden", "true"); home.removeAttribute("inert");
      await settle();
      assert.equal(api.status().mounted, true, "returns without API heartbeat, reinjection or restart");
      scheduled.removeAttribute("aria-hidden"); scheduled.hidden = true;
      await settle();
    }
    assert.equal(dom.window.document.querySelectorAll("#codex-taskboard-quota-display").length, 1);
    const replacement = home.cloneNode(true);
    replacement.querySelector("#codex-taskboard-quota-display").remove();
    home.replaceWith(replacement);
    await settle();
    assert.equal(api.status().mounted, true);
    assert.equal(replacement.lastElementChild.id, "codex-taskboard-quota-display");
    scheduled.hidden = false; scheduled.innerHTML = '<div class="overflow-y-auto"><button class="sidebar-item">Ambiguous</button></div>';
    await settle();
    assert.equal(api.status().mounted, false, "two actually visible native navigations still park");
    scheduled.hidden = true; await settle();
    assert.equal(api.status().mounted, true);
  } finally { dom.window.__codexTaskboardQuotaDisplay__.cleanup(); dom.window.close(); }
});

test("quota never toggles itself when its reserved space shrinks a native scroller to zero height", () => {
  const dom = fixture({ modern: true });
  try {
    const api = dom.window.__codexTaskboardQuotaDisplay__;
    const rect = dom.window.HTMLElement.prototype.getBoundingClientRect;
    dom.window.HTMLElement.prototype.getBoundingClientRect = function () {
      const value = rect.call(this);
      if (this.matches("div.overflow-y-auto") && api.status().mounted) return { ...value, height: 0, bottom: value.top };
      return value;
    };
    for (let i = 0; i < 3; i++) {
      api.heartbeat();
      assert.equal(api.status().mounted, true);
    }
  } finally {
    dom.window.__codexTaskboardQuotaDisplay__.cleanup();
    dom.window.close();
  }
});

test("quota card parks while two sidebars are visible and returns when one remains", async () => {
  const dom = fixture({ modern: true });
  try {
    const document = dom.window.document;
    const host = document.getElementById("codex-taskboard-quota-display");
    const duplicate = document.querySelector("aside").cloneNode(true);
    document.body.append(duplicate);
    await new Promise((resolve) => dom.window.setTimeout(resolve, 0));
    assert.equal(host.hidden, true);
    duplicate.remove();
    await new Promise((resolve) => dom.window.setTimeout(resolve, 0));
    assert.equal(host.hidden, false);
  } finally {
    dom.window.__codexTaskboardQuotaDisplay__.cleanup();
    dom.window.close();
  }
});

test("content-panel spacing changes only the owned card and falls back for an embedded footer", () => {
  const dom = fixture({ modern: true });
  try {
    const document = dom.window.document;
    const api = dom.window.__codexTaskboardQuotaDisplay__;
    const sidebar = document.querySelector("aside");
    const host = document.getElementById("codex-taskboard-quota-display");
    assert.equal(host.getAttribute("data-codex-taskboard-quota-layout"), "content-panel");
    const footer = document.createElement("footer");
    sidebar.append(footer);
    api.heartbeat();
    assert.equal(host.getAttribute("data-codex-taskboard-quota-layout"), "legacy");
    footer.remove();
    api.heartbeat();
    assert.equal(host.getAttribute("data-codex-taskboard-quota-layout"), "content-panel");
    assert.equal(sidebar.getAttribute("style"), null);
    api.cleanup();
    assert.equal(sidebar.querySelectorAll("[data-codex-taskboard-quota-layout]").length, 0);
  } finally {
    dom.window.__codexTaskboardQuotaDisplay__.cleanup();
    dom.window.close();
  }
});

test("quota card reserves footer clearance on its own host through refresh and cleanup", () => {
  let shadow;
  const dom = fixture({ onQuotaShadow: (value) => { shadow = value; } });
  try {
    const api = dom.window.__codexTaskboardQuotaDisplay__;
    const document = dom.window.document;
    const nativeLayout = document.querySelector(".sidebar-layout");
    const nativeFooter = document.querySelector("button");
    const assertClearance = () => {
      const hostRule = shadow.querySelector("style").textContent.match(/:host\s*\{([^}]+)\}/)?.[1];
      assert.match(hostRule, /margin:\s*6px 8px 48px\s*!important\s*;/);
      assert.match(hostRule, /flex:\s*0 0 auto\s*!important\s*;/);
      assert.doesNotMatch(hostRule, /position:\s*(absolute|fixed)|z-index|transform/);
      assert.equal(nativeLayout.getAttribute("style"), null);
      assert.equal(nativeFooter.getAttribute("style"), null);
    };
    assertClearance();
    api.update({
      schemaVersion: 1,
      fetchedAtMs: Date.now(),
      buckets: [{ id: "codex", windows: [
        { kind: "primary", remainingPercent: 47, durationMinutes: 300 },
        { kind: "secondary", remainingPercent: 45, durationMinutes: 10_080 },
      ] }],
    });
    assertClearance();
    assert.equal(shadow.querySelectorAll(".quota-row").length, 2);
    api.cleanup();
    assert.equal(document.getElementById("codex-taskboard-quota-display"), null);
    assert.equal(nativeLayout.children.length, 2);
    assert.equal(nativeLayout.lastElementChild, nativeFooter);
  } finally {
    dom.window.__codexTaskboardQuotaDisplay__.cleanup();
    dom.window.close();
  }
});

test("embedded quota card accepts only a normalized snapshot and survives sidebar replacement", async () => {
  const dom = fixture();
  const api = dom.window.__codexTaskboardQuotaDisplay__;
  assert.equal(api.update({ token: "unsafe" }).accepted, false);

  const result = api.update({
    schemaVersion: 1,
    fetchedAtMs: Date.now(),
    buckets: [{
      id: "codex",
      name: null,
      planType: "pro",
      windows: [
        { kind: "primary", remainingPercent: 81.5, durationMinutes: 300, resetsAtMs: Date.now() + 60_000 },
        { kind: "secondary", remainingPercent: 28, durationMinutes: 10_080, resetsAtMs: Date.now() + 86_400_000 },
      ],
    }],
  });
  assert.equal(result.accepted, true);
  assert.equal(result.freshness, "fresh");
  assert.equal(result.bucketCount, 1);

  const oldSidebar = dom.window.document.querySelector("aside");
  oldSidebar.remove();
  dom.window.document.body.insertAdjacentHTML("beforeend", `
    <aside class="app-shell-left-panel"><div><div data-app-action-sidebar-scroll></div><button aria-label="个人资料">用户</button></div></aside>
  `);
  await new Promise((resolve) => dom.window.setTimeout(resolve, 0));
  const host = dom.window.document.getElementById("codex-taskboard-quota-display");
  assert.equal(host.parentElement, dom.window.document.querySelector("[data-app-action-sidebar-scroll]").parentElement);
  assert.equal(api.status().mounted, true);
  api.cleanup();
  dom.window.close();
});

test("a cleaned quota card remounts when the same source is injected again", () => {
  const dom = fixture({ modern: true });
  try {
    const original = dom.window.__codexTaskboardQuotaDisplay__;
    original.update({
      schemaVersion: 1,
      fetchedAtMs: Date.now(),
      buckets: [{ id: "codex", windows: [
        { kind: "primary", remainingPercent: 47, durationMinutes: 300 },
      ] }],
    });
    original.cleanup();
    assert.equal(original.status().cleaned, true);
    assert.equal(dom.window.document.getElementById("codex-taskboard-quota-display"), null);

    dom.window.eval(source);
    const restored = dom.window.__codexTaskboardQuotaDisplay__;
    assert.equal(restored, original);
    assert.equal(restored.status().cleaned, false);
    assert.equal(restored.status().mounted, true);
    assert.equal(restored.status().freshness, "fresh");
    assert.equal(dom.window.document.querySelectorAll("#codex-taskboard-quota-display").length, 1);
  } finally {
    dom.window.__codexTaskboardQuotaDisplay__.cleanup();
    dom.window.close();
  }
});

test("quota theme follows explicit light/dark changes without waiting for another account snapshot", async () => {
  const dom=fixture(), host=dom.window.document.getElementById("codex-taskboard-quota-display");
  try {
    for(const theme of ["dark","light","dark"]) {
      dom.window.document.documentElement.setAttribute("data-theme",theme);
      await new Promise(resolve=>dom.window.setTimeout(resolve,0));
      assert.equal(host.getAttribute("data-quota-theme"),theme);
    }
  } finally { dom.window.__codexTaskboardQuotaDisplay__.cleanup();dom.window.close(); }
});

test("embedded quota card parks in Settings and exposes no remote UI dependencies", async () => {
  const dom = fixture();
  const api = dom.window.__codexTaskboardQuotaDisplay__;
  const settings = dom.window.document.createElement("section");
  settings.setAttribute("data-settings-panel-slug", "general");
  dom.window.document.body.appendChild(settings);
  await new Promise((resolve) => dom.window.setTimeout(resolve, 0));

  assert.equal(dom.window.document.getElementById("codex-taskboard-quota-display").hidden, true);
  assert.doesNotMatch(source, /https?:\/\/|fetch\(|WebSocket|remote-debugging-port|auth\.json/i);
  assert.doesNotMatch(source, /animation:|transition:/, "static material never needs motion suppression");
  assert.match(source, /forced-colors/);
  api.cleanup();
  dom.window.close();
});

test("embedded quota card remains visible when a parked Settings panel stays in the DOM", async () => {
  const dom = fixture();
  const api = dom.window.__codexTaskboardQuotaDisplay__;
  const settings = dom.window.document.createElement("section");
  settings.setAttribute("data-settings-panel-slug", "general");
  settings.style.display = "none";
  dom.window.document.body.appendChild(settings);
  await new Promise((resolve) => dom.window.setTimeout(resolve, 0));

  assert.equal(dom.window.document.getElementById("codex-taskboard-quota-display").hidden, false);
  assert.equal(api.status().mounted, true);
  api.cleanup();
  dom.window.close();
});
