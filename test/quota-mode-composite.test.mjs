import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { promisify } from "node:util";
import { test } from "node:test";

const chrome = [process.env.CHROME_BIN, "C:/Program Files/Google/Chrome/Application/chrome.exe",
  "/usr/bin/google-chrome", "/usr/bin/chromium"].find((p) => p && existsSync(p));
const source = await readFile(new URL("../inject/codex-quota-display.user.js", import.meta.url), "utf8");

function fixture(script, { width = 280, zoom = 1, wrapped = false, finalMode = "codex", retained = false, retainedChild = false } = {}) {
  return `<!doctype html><html lang="zh-CN"><meta charset="utf-8"><style>
    *,::before,::after {box-sizing:border-box;margin:0;padding:0;border:0 solid;}
    body {zoom:${zoom};font-family:system-ui;background:white;}
    aside {margin:12px 0 0 56px;width:${width}px;height:720px;overflow:hidden;background:#f6f6f6;}
    nav {height:100%;display:flex;flex-direction:column;}
    .native-header {height:80px;flex:none;padding:16px;order:1;}
    .native-branch {order:2;flex:1;min-height:0;display:flex;flex-direction:column;}
    nav[data-mode="scheduled"] .native-branch {flex:0 0 auto;height:140px;}
    .overflow-y-auto {flex:1;min-height:0;overflow:auto;}
    .rows {height:900px;padding:12px;}
    nav[data-mode="scheduled"] .rows {height:120px;}
    [data-settings-panel-slug] {width:400px;height:300px;}
    nav.unknown {flex-direction:row;}
  </style><aside data-app-shell-left-panel-appearance="content-surface"><nav role="navigation" aria-label="App navigation"></nav></aside>
  <pre id="result"></pre><script>
    const sidebar=document.querySelector('aside'); const nav=sidebar.querySelector('nav');
    function nativeMarkup(mode) {
      const scroll='<div class="overflow-y-auto '+(${wrapped}?'':'native-branch')+'" data-app-action-sidebar-scroll><div class="rows"><button class="sidebar-item">Fixture item</button></div></div>';
      return '<div class="native-header"><h2>'+(mode==='scheduled'?'定时任务':'Codex')+'</h2><button class="sidebar-item">Fixture action</button></div>'+(${wrapped}?'<div class="native-branch">'+scroll+'</div>':scroll);
    }
    function change(mode) {nav.dataset.mode=mode;nav.innerHTML=nativeMarkup(mode);
      if (${retainedChild}) {const nativeRetained=document.createElement('div');nativeRetained.hidden=true;nav.append(nativeRetained);}}
    change('codex');
    if (${retained}) {const oldMode=nav.cloneNode(true);oldMode.hidden=true;sidebar.append(oldMode);}
    let shadow;
    const attach=HTMLElement.prototype.attachShadow;
    HTMLElement.prototype.attachShadow=function(options) {const value=attach.call(this,options);if(this.id==='codex-taskboard-quota-display')shadow=value;return value;};
    (0,eval)(${JSON.stringify(script)});
    const api=window.__codexTaskboardQuotaDisplay__;
    const snapshot={schemaVersion:1,fetchedAtMs:Date.now(),buckets:[{id:'codex',windows:[
      {kind:'primary',remainingPercent:68,durationMinutes:300,resetsAtMs:Date.now()+3600000},
      {kind:'secondary',remainingPercent:79,durationMinutes:10080,resetsAtMs:Date.now()+200000000}]}]};
    api.update(snapshot);
    function measure() {
      const host=shadow.host;
      const card=shadow.querySelector('.quota-card').getBoundingClientRect();
      const pane=sidebar.getBoundingClientRect();const header=nav.querySelector('.native-header').getBoundingClientRect();
      const scroll=nav.querySelector('.overflow-y-auto');
      const nativeBranch=scroll.closest('.native-branch');
      return {mode:nav.dataset.mode,mounted:api.status().mounted,directNavigation:host.parentElement===nav,
        afterBranch:host.previousElementSibling===nativeBranch,gap:(pane.bottom-card.bottom)/${zoom},
        belowHeader:card.top>=header.bottom,headerAtTop:Math.abs(header.top-pane.top)<1,
        listAboveCard:nativeBranch.getBoundingClientRect().bottom<=card.top+1,
        scrollable:scroll.clientHeight>0,fits:card.left>=pane.left&&card.right<=pane.right,
        ownedOrder:getComputedStyle(host).order,nativeHeaderStyle:nav.querySelector('.native-header').getAttribute('style'),
        nativeScrollStyle:scroll.getAttribute('style')};
    }
    const phases=[measure()];
    for(const mode of ['scheduled','codex','scheduled','codex']) {
      change(mode);api.heartbeat();api.update(snapshot);phases.push(measure());
    }
    change('scheduled');const emptyScroll=nav.querySelector('.overflow-y-auto');emptyScroll.removeAttribute('data-app-action-sidebar-scroll');emptyScroll.querySelector('button').remove();api.heartbeat();phases.push(measure());
    const extra=document.createElement('div');extra.className='overflow-y-auto';extra.style='height:100px';extra.innerHTML='<button class="sidebar-item">Ambiguous</button>';nav.append(extra);api.heartbeat();
    const ambiguousParked=!api.status().mounted;extra.remove();api.heartbeat();
    nav.classList.add('unknown');api.heartbeat();const unknownParked=!api.status().mounted;nav.classList.remove('unknown');api.heartbeat();
    sidebar.style.width='56px';api.heartbeat();const collapsedParked=!api.status().mounted;sidebar.style.width='${width}px';api.heartbeat();
    const settings=document.createElement('section');settings.dataset.settingsPanelSlug='fixture';document.body.append(settings);api.heartbeat();const settingsParked=!api.status().mounted;settings.remove();api.heartbeat();
    change(${JSON.stringify(finalMode)});const nativeBefore=nav.innerHTML;api.heartbeat();phases.push(measure());
    api.cleanup();const nativeRestored=nav.innerHTML===nativeBefore;
    api.mount();api.update(snapshot);
    document.getElementById('result').textContent=JSON.stringify({phases,ambiguousParked,unknownParked,collapsedParked,settingsParked,nativeRestored});
  </script></html>`;
}

async function run(script, scenario, name) {
  const temporary = await mkdtemp(path.join(os.tmpdir(), "agent-desk-quota-mode-"));
  assert.equal(path.dirname(path.resolve(temporary)), path.resolve(os.tmpdir()));
  assert.ok(path.basename(temporary).startsWith("agent-desk-quota-mode-"));
  try {
    const html = path.join(temporary, "fixture.html");
    await writeFile(html, fixture(script, scenario));
    const profile = await mkdtemp(path.join(temporary, "chrome-"));
    const screenshot = process.env.QUOTA_MODE_SCREENSHOT_DIR ? [
      `--screenshot=${path.resolve(process.env.QUOTA_MODE_SCREENSHOT_DIR, `${name}.png`)}`,
    ] : [];
    if (screenshot.length) await mkdir(process.env.QUOTA_MODE_SCREENSHOT_DIR, { recursive: true });
    const { stdout } = await promisify(execFile)(chrome, ["--headless=new", "--no-first-run", "--no-default-browser-check",
      "--disable-background-networking", "--disable-extensions", `--user-data-dir=${profile}`,
      "--window-size=900,1650", "--dump-dom", ...screenshot, pathToFileURL(html).href,
    ], { timeout: 30000, windowsHide: true, maxBuffer: 2_000_000 });
    return JSON.parse(stdout.match(/<pre id="result">([^<]+)<\/pre>/)?.[1] || "null");
  } finally { await rm(temporary, { recursive: true, force: true, maxRetries: 3 }); }
}

test("quota remains at the native bottom across ordered/wrapped Codex and scheduled layouts", { skip: !chrome }, async () => {
  for (const [name, scenario] of [
    ["codex-direct", { width: 280, zoom: 1, wrapped: false }],
    ["scheduled-direct", { width: 200, zoom: 1, wrapped: false, finalMode: "scheduled" }],
    ["codex-wrapped", { width: 280, zoom: 1, wrapped: true }],
    ["scheduled-wrapped-zoom200", { width: 200, zoom: 2, wrapped: true, finalMode: "scheduled" }],
    ["retained-home", { width: 280, zoom: 1, retained: true }],
    ["retained-wrapped", { width: 200, zoom: 1, wrapped: true, retained: true }],
  ]) {
    const result = await run(source, scenario, name);
    assert.ok(result, name);
    for (const phase of result.phases) {
      for (const flag of ["mounted", "directNavigation", "afterBranch", "belowHeader", "headerAtTop", "listAboveCard", "scrollable", "fits"]) {
        assert.equal(phase[flag], true, `${name}/${phase.mode}/${flag}: ${JSON.stringify(phase)}`);
      }
      assert.ok(Math.abs(phase.gap - 12) < 0.5, `${name}/${phase.mode}: ${phase.gap}`);
      assert.equal(phase.nativeHeaderStyle, null);
      assert.equal(phase.nativeScrollStyle, null);
    }
    for (const flag of ["ambiguousParked", "unknownParked", "collapsedParked", "settingsParked", "nativeRestored"]) assert.equal(result[flag], true, `${name}/${flag}`);
  }
});

test("installed 1.0.7 quota reproduces permanent parking with a retained hidden native navigation", {
  skip: !chrome || process.env.AGENT_DESK_QUOTA_RECOVERY_COMPARE !== "1",
}, async () => {
  const oldSource = await readFile(`${process.env.LOCALAPPDATA}/Agent Desk/app/inject/codex-quota-display.user.js`, "utf8");
  assert.match(oldSource, /const VERSION = "1.0.7"/);
  const result = await run(oldSource, { retained: true }, "old-retained-navigation");
  assert.ok(result.phases.every((phase) => !phase.mounted));
});

test("frozen 1.0.9 versus recovery: retained hidden branch across routes, widths and real browser geometry", {
  skip: !chrome || !existsSync(new URL("../dist/maintenance/20260930-quota-lifecycle-trace/extracted/app/inject/codex-quota-display.user.js", import.meta.url)),
}, async () => {
  const baseline = await readFile(new URL("../dist/maintenance/20260930-quota-lifecycle-trace/extracted/app/inject/codex-quota-display.user.js", import.meta.url), "utf8");
  for (const scenario of [{ width: 280, retainedChild: true }, { width: 200, zoom: 2, wrapped: true, retainedChild: true }]) {
    const old = await run(baseline, scenario, "frozen-hidden-child");
    assert.ok(old.phases.every(phase => !phase.mounted));
    const fixed = await run(source, scenario, "recovered-hidden-child");
    for (const phase of fixed.phases) {
      assert.equal(phase.mounted, true); assert.equal(phase.fits, true); assert.equal(phase.listAboveCard, true);
      assert.ok(Math.abs(phase.gap - 12) < 0.5);
      assert.equal(phase.nativeHeaderStyle, null); assert.equal(phase.nativeScrollStyle, null);
    }
    for (const flag of ["ambiguousParked", "unknownParked", "collapsedParked", "settingsParked", "nativeRestored"]) assert.equal(fixed[flag], true);
  }
});

test("installed old quota reproduces top drift under native CSS order", {
  skip: !chrome || process.env.AGENT_DESK_QUOTA_COMPARE_INSTALLED !== "1",
}, async () => {
  const legacy = await readFile(`${process.env.LOCALAPPDATA}/Agent Desk/app/inject/codex-quota-display.user.js`, "utf8");
  const result = await run(legacy, { width: 280, zoom: 1 }, "legacy-drift");
  assert.ok(result);
  assert.equal(result.phases[0].belowHeader, false);
  assert.ok(result.phases[0].gap > 12);
});
