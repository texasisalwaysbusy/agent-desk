import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { promisify } from "node:util";
import test from "node:test";
const chrome = [process.env.CHROME_BIN, "C:/Program Files/Google/Chrome/Application/chrome.exe", "/usr/bin/chromium"]
  .find(candidate => candidate && existsSync(candidate));
const desk = await readFile(new URL("../inject/codex-taskboard.user.js", import.meta.url), "utf8");
const quota = await readFile(new URL("../inject/codex-quota-display.user.js", import.meta.url), "utf8");
const baselinePath = new URL("../dist/maintenance/20260930-quota-lifecycle-trace/extracted/app/inject/codex-taskboard.user.js", import.meta.url);
function fixture(script, width, headerLayout, ordered, sizing = "fixed") {
  const sizeRule = sizing === "fixed" ? "height:40px" : sizing === "full" ? "height:100%;min-height:100%"
    : sizing === "inline" ? "height:40px" : "height:40px;min-height:40px";
  const inline = sizing === "inline" ? 'style="height:100%;min-height:100%;flex:1 1 100%;position:relative"' : "";
  return `<!doctype html><html lang="zh-CN"><meta charset="utf-8"><style>
    *{box-sizing:border-box}body{margin:0;font:14px system-ui}
    aside{width:${width}px;height:720px;margin:12px;overflow:hidden}
    nav{height:100%;display:flex;flex-direction:column}
    .native-header{display:${headerLayout};${headerLayout === "grid" ? "grid-template-columns:repeat(2,minmax(0,1fr));" : ""}padding:8px;flex:none;order:${ordered ? 1 : 0}}
    .sidebar-item{display:flex;align-items:center;flex:1;min-width:0;${sizeRule};padding:8px;white-space:nowrap;overflow:hidden}
    ${sizing === "context" ? 'nav > .sidebar-item{height:100%;min-height:100%;flex:1 1 100%}' : ''}
    .overflow-y-auto{flex:1;min-height:0;overflow:auto;order:${ordered ? 2 : 0}}
    .rows{height:900px}.sidebar-item svg{width:20px;flex:none;margin-right:8px}
  </style><aside data-app-shell-left-panel-appearance="content-surface"><nav role="navigation" aria-label="Fixture">
    <div class="native-header"><button class="sidebar-item" ${inline}><svg></svg><span class="text-fade-truncate">新聊天</span></button></div>
    <div class="overflow-y-auto" data-app-action-sidebar-scroll><section data-app-action-sidebar-section class="rows">
    <div role="button" data-app-action-sidebar-project-row>Fixture</div></section></div></nav></aside>
    <main><div><div data-app-shell-main-content-layout><div class="app-shell-main-content-frame"></div></div></div></main>
    <pre id="result"></pre><script>
    window.electronBridge={sendMessageFromView(){}};
    window.__CODEX_TASKBOARD_SOURCE_HASH__='fixture';
    const nav=document.querySelector('nav'),header=nav.firstElementChild,scroll=nav.querySelector('.overflow-y-auto');
    const before=header.outerHTML;const baselineWidth=header.querySelector('button').getBoundingClientRect().width;
    (0,eval)(${JSON.stringify(quota)});(0,eval)(${JSON.stringify(script)});
    const api=window.__codexTaskboardInjection__,quotaApi=window.__codexTaskboardQuotaDisplay__;
    const entry=document.getElementById('codex-taskboard-entry'),native=header.querySelector('button');
    function measure(){const e=entry.getBoundingClientRect(),n=native.getBoundingClientRect(),s=scroll.getBoundingClientRect(),p=nav.getBoundingClientRect();
      return{sameHeight:Math.min(e.bottom,n.bottom)>Math.max(e.top,n.top)+1,
        separate:entry.parentElement===nav,below:e.top>=n.bottom,listBelow:s.top>=e.bottom,
        width:e.width,height:e.height,listHeight:s.height,nativeWidth:n.width,baselineWidth,fits:e.left>=p.left&&e.right<=p.right,
        nativeUnchanged:header.outerHTML===before,quota:quotaApi.status().mounted,
        nativeFont:getComputedStyle(native.querySelector('span')).font,entryFont:getComputedStyle(entry.querySelector('span')).font,
        nativeIconLeft:native.querySelector('svg').getBoundingClientRect().left,entryIconLeft:entry.querySelector('svg').getBoundingClientRect().left,
        nativeLabelLeft:native.querySelector('span').getBoundingClientRect().left,entryLabelLeft:entry.querySelector('span').getBoundingClientRect().left,
        arrowWidth:entry.querySelector('.entry-chevron')?.getBoundingClientRect().width,
        quotaClipped:quotaApi.diagnostics().events.at(-1)?.clipped,
        diagnostics:api.diagnostics?api.diagnostics().events.at(-1):null};}
    const phases=[measure()];
    const retained=document.createElement('div');retained.hidden=true;nav.append(retained);api.refresh();quotaApi.heartbeat();phases.push(measure());
    const parked=[];
    for(let n=0;n<3;n++){
      header.hidden=true;scroll.hidden=true;api.refresh();quotaApi.heartbeat();parked.push(entry.hidden);
      header.hidden=false;scroll.hidden=false;api.refresh();quotaApi.heartbeat();phases.push(measure());
    }
    const replacement=header.cloneNode(true);replacement.querySelectorAll('[data-codex-taskboard-owned]').forEach(node=>node.remove());
    header.replaceWith(replacement);api.refresh();quotaApi.heartbeat();
    const repaired=document.getElementById('codex-taskboard-entry')?.getBoundingClientRect();
    const restoredReference=replacement.querySelector('button').getBoundingClientRect();
    const replacedSeparately=Boolean(repaired&&repaired.top>=restoredReference.bottom);
    api.destroy();quotaApi.cleanup();
    const cleaned=!document.querySelector('[data-codex-taskboard-owned]');
    document.getElementById('result').textContent=JSON.stringify({phases,parked,replacedSeparately,cleaned});
  </script></html>`;
}
async function run(script, width, layout, ordered, sizing) {
  const folder = await mkdtemp(path.join(os.tmpdir(), "agent-desk-entry-row-"));
  assert.equal(path.dirname(path.resolve(folder)), path.resolve(os.tmpdir()));
  assert.ok(path.basename(folder).startsWith("agent-desk-entry-row-"));
  try {
    const html = path.join(folder, "fixture.html"); await writeFile(html, fixture(script, width, layout, ordered, sizing));
    const profile = await mkdtemp(path.join(folder, "chrome-"));
    const { stdout } = await promisify(execFile)(chrome, ["--headless=new", "--no-first-run", "--no-default-browser-check",
      "--disable-background-networking", "--disable-extensions", `--user-data-dir=${profile}`,
      "--dump-dom", pathToFileURL(html).href], { timeout: 30000, windowsHide: true, maxBuffer: 2000000 });
    return JSON.parse(stdout.match(/<pre id="result">([^<]+)<\/pre>/)?.[1] || "null");
  } finally { await rm(folder, { recursive: true, force: true, maxRetries: 3 }); }
}
test("native horizontal/grid New Chat row versus independent workbench entry: geometry, routes, reparent and cleanup", { skip: !chrome }, async () => {
  for (const sizing of ["fixed", "full", "inline", "context"])
  for (const layout of ["flex", "grid"]) for (const width of [200, 280, 400]) for (const ordered of [false, true]) {
    const result = await run(desk, width, layout, ordered, sizing); assert.ok(result);
    for (const phase of result.phases) {
      assert.equal(phase.sameHeight, false); assert.equal(phase.separate, true);
      assert.equal(phase.below, true); assert.equal(phase.listBelow, true); assert.equal(phase.fits, true);
      assert.equal(phase.nativeWidth, phase.baselineWidth); assert.equal(phase.nativeUnchanged, true);
      assert.equal(phase.quota, true); assert.ok(phase.width >= width - 20);
      assert.equal(phase.height, 40); assert.ok(phase.listHeight >= 400);
      assert.equal(phase.quotaClipped, false);
      assert.equal(phase.entryFont,phase.nativeFont);assert.ok(Math.abs(phase.entryIconLeft-phase.nativeIconLeft)<1);
      assert.ok(Math.abs(phase.entryLabelLeft-phase.nativeLabelLeft)<1);assert.equal(phase.arrowWidth,12);
      assert.equal(phase.diagnostics.entryOversized, false); assert.equal(phase.diagnostics.listUsable, true);
      assert.equal(phase.diagnostics.entrySeparateRow, true); assert.equal(phase.diagnostics.entrySharesNativeRow, false);
    }
    assert.ok(result.parked.every(Boolean)); assert.equal(result.replacedSeparately, true); assert.equal(result.cleaned, true);
  }
});
test("frozen 0.6.17 reproduces the giant entry, collapsed list and clipped quota with contextual native sizing", {
  skip: !chrome || !existsSync(new URL("../dist/maintenance/20261001-updated-sidebar-recovery/extracted/app/inject/codex-taskboard.user.js", import.meta.url)),
}, async () => {
  const bad = await readFile(new URL("../dist/maintenance/20261001-updated-sidebar-recovery/extracted/app/inject/codex-taskboard.user.js", import.meta.url), "utf8");
  for (const sizing of ["full", "inline", "context"]) {
    const result = await run(bad, 280, "flex", false, sizing);
    assert.ok(result.phases[0].height > 600, sizing);
    assert.ok(result.phases[0].listHeight < 80, sizing);
    assert.equal(result.phases[0].quotaClipped, true, sizing);
    assert.equal(result.phases[0].diagnostics.entrySeparateRow, true);
  }
});
test("frozen installed workbench reproduces side-by-side New Chat and entry under the same native CSS", {
  skip: !chrome || !existsSync(baselinePath),
}, async () => {
  const baseline = await readFile(baselinePath, "utf8");
  for (const layout of ["flex", "grid"]) {
    const result = await run(baseline, 280, layout, false);
    assert.equal(result.phases[0].sameHeight, true); assert.equal(result.phases[0].separate, false);
    if (layout === "flex") assert.ok(result.phases[0].nativeWidth < result.phases[0].baselineWidth);
  }
});
