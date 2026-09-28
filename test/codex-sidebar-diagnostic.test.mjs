import assert from "node:assert/strict";
import { test } from "node:test";
import { readFile } from "node:fs/promises";
import { JSDOM } from "jsdom";

import {
  normalizeSidebarDiagnostic,
  sidebarDiagnosticExpression,
} from "../scripts/codex-sidebar-diagnostic.mjs";

test("sidebar diagnostic distinguishes navigation from scroll without reading labels or URLs", () => {
  const dom = new JSDOM(`<!doctype html><html><body>
    <aside data-app-shell-left-panel-appearance="content-surface">
      <nav role="navigation" aria-label="Private navigation label">
        <div><div data-app-action-sidebar-scroll class="overflow-y-auto">
          <section data-app-action-sidebar-section><div role="link" tabindex="0"
            data-app-action-sidebar-thread-row="private-id">Private task title</div></section>
        </div></div>
      </nav>
      <a href="/private/destination" role="link">Private destination</a>
    </aside>
  </body></html>`, { url: "app://codex/index.html", runScripts: "outside-only" });
  try {
    dom.window.HTMLElement.prototype.getBoundingClientRect = () => ({
      width: 400, height: 600,
    });
    const before = dom.serialize();
    const result = normalizeSidebarDiagnostic(dom.window.eval(sidebarDiagnosticExpression));
    assert.equal(dom.serialize(), before);
    assert.equal(result.visibleAsideCount, 1);
    assert.equal(result.asides[0].scrollCount, 1);
    assert.equal(result.asides[0].scrolls[0].legacy, true);
    assert.deepEqual(result.asides[0].navs[0].scrolls, [0]);
    assert.ok(result.asides[0].interactives.some((item) =>
      item.role === "link" && item.scroll === 0));
    assert.ok(result.asides[0].interactives.some((item) =>
      item.role === "link" && item.scroll === -1));
    const safe = JSON.stringify(result);
    for (const secret of ["Private", "/private", "private-id"]) {
      assert.equal(safe.includes(secret), false);
    }
  } finally { dom.window.close(); }
});

test("untrusted diagnostic result is bounded and strips unexpected content", () => {
  const result = normalizeSidebarDiagnostic({
    schemaVersion: 1,
    asides: Array.from({ length: 20 }, () => ({
      tree: Array.from({ length: 100 }, () => ({
        tag: "secret", role: "secret", classes: ["private", "sidebar-item"],
        dataNames: ["data-private-secret", "data-app-action-sidebar-thread-row"],
        children: 100000,
      })),
    })),
  });
  assert.equal(result.asides.length, 3);
  assert.equal(result.asides[0].tree.length, 64);
  assert.equal(result.asides[0].tree[0].tag, "other");
  assert.deepEqual(result.asides[0].tree[0].classes, ["sidebar-item"]);
  assert.deepEqual(result.asides[0].tree[0].dataNames,
    ["data-app-action-sidebar-thread-row"]);
  assert.equal(result.asides[0].tree[0].children, null);
  assert.equal(JSON.stringify(result).includes("secret"), false);
});

test("diagnostic-only source path returns before CSP bypass and UI injection", async () => {
  const source = await readFile(new URL("../scripts/codex-injector.mjs", import.meta.url), "utf8");
  const target = source.slice(source.indexOf("async function injectTarget"),
    source.indexOf("async function injectAll"));
  const diagnostic = target.indexOf("if (sidebarDiagnosticOnly)");
  assert.ok(diagnostic > target.indexOf("probeRendererContract"));
  assert.ok(diagnostic < target.indexOf("currentInjectionSource"));
  assert.ok(diagnostic < target.indexOf('Page.setBypassCSP", { enabled: true }'));
  assert.match(source, /sidebarDiagnosticOnly && !options\.windowsLoopbackCandidate/);
  assert.doesNotMatch(sidebarDiagnosticExpression,
    /createElement|appendChild|insertAdjacent|setAttribute|\.click\(|localStorage|sessionStorage/);
});
