import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import test from "node:test";
import { JSDOM } from "jsdom";
import { rendererContractProbeExpression, normalizeRendererContractProbe } from "../scripts/codex-renderer-compatibility.mjs";
import { sanitizeStartupDiagnostic } from "../shared/startup-diagnostics.mjs";

const desk = await readFile(new URL("../inject/codex-taskboard.user.js", import.meta.url), "utf8");
const quota = await readFile(new URL("../inject/codex-quota-display.user.js", import.meta.url), "utf8");
const prior = new URL("../dist/maintenance/20261004-discovery-timeout-investigation/extracted/app/scripts/codex-renderer-compatibility.mjs", import.meta.url);
function fixture({ nested, legacy, rows }) {
  const scroll = `<div class="overflow-y-auto" ${legacy ? 'data-app-action-sidebar-scroll' : ''}>
    <section data-app-action-sidebar-section><div role="button" class="sidebar-item" data-app-action-sidebar-thread-id="fixture">Fixture thread</div></section></div>`;
  const dom = new JSDOM(`<html><style>nav{display:flex;flex-direction:column}</style><body>
    <aside data-app-shell-left-panel-appearance="content-surface"><nav role="navigation" aria-label="Fixture">
    <div class="fixture-header">${Array.from({length:rows}, (_,i)=>`<div><button class="sidebar-item"><svg></svg><span>${i ? 'PRIVATE_NICKNAME' : 'PRIVATE_NEW_CHAT'}</span></button></div>`).join('')}</div>
    ${nested ? `<div>${scroll}</div>` : scroll}</nav></aside>
    <main><div><div data-app-shell-main-content-layout><div class="app-shell-main-content-frame"></div></div></div></main></body></html>`,
    { url:"app://codex/", runScripts:"outside-only", pretendToBeVisual:true });
  const w = dom.window;
  w.HTMLElement.prototype.getBoundingClientRect = () => ({ width:280,height:700,top:0,left:0,right:280,bottom:700 });
  w.electronBridge={ sendMessageFromView(){ throw Error("Read-only probe cannot call RPC"); } };
  w.__CODEX_TASKBOARD_SOURCE_HASH__="fixture";
  return dom;
}
const contract = dom => normalizeRendererContractProbe(dom.window.eval(rendererContractProbeExpression));
function refresh(dom) { dom.window.__codexTaskboardInjection__.refresh(); dom.window.__codexTaskboardQuotaDisplay__.heartbeat(); }
function dispose(dom) { dom.window.__codexTaskboardInjection__?.destroy(); dom.window.__codexTaskboardQuotaDisplay__?.cleanup(); dom.window.close(); }

test("frozen previous contract passes one row but rejects the same header after a Pro row is added", {skip:!existsSync(prior)}, async () => {
  const old=await import(prior.href);
  const dom=fixture({nested:true,legacy:true,rows:1});
  try {
    assert.equal(old.normalizeRendererContractProbe(dom.window.eval(old.rendererContractProbeExpression)).compatible,true);
    dom.window.document.querySelector('.fixture-header').insertAdjacentHTML('beforeend','<button class="sidebar-item">Your dot</button>');
    const rejected=old.normalizeRendererContractProbe(dom.window.eval(old.rendererContractProbeExpression));
    assert.equal(rejected.checks.sidebarScroll,true);assert.equal(rejected.checks.pageMount,true);
    assert.equal(rejected.checks.headerReference,false);assert.equal(rejected.compatible,false);
    assert.equal(contract(dom).compatible,true);
  } finally { dispose(dom); }
});

test("Pro and non-Pro headers: read-only contract, entry/quota agreement, row changes, route parking, replacement and cleanup", () => {
  for (const nested of [false,true]) for (const legacy of [false,true]) for (const rows of [1,2,3]) {
    const dom = fixture({nested,legacy,rows});
    try {
      const d=dom.window.document, nav=d.querySelector('nav'), header=nav.firstElementChild, scroll=nav.lastElementChild;
      const before=dom.serialize(); assert.equal(contract(dom).compatible,true); assert.equal(dom.serialize(),before);
      assert.equal(contract(dom).shape.headerNativeRows,rows);
      const native=header.outerHTML;
      dom.window.eval(quota); dom.window.eval(desk);
      const entry=d.getElementById('codex-taskboard-entry'), card=d.getElementById('codex-taskboard-quota-display');
      function mounted(expectedRows) {
        refresh(dom);
        assert.equal(contract(dom).compatible,true); assert.equal(contract(dom).shape.headerNativeRows,expectedRows);
        assert.equal(entry.hidden,false); assert.equal(entry.parentElement,nav); assert.equal(entry.nextElementSibling,scroll);
        assert.equal(card.previousElementSibling,scroll); assert.equal(dom.window.__codexTaskboardQuotaDisplay__.status().mounted,true);
        assert.equal(d.querySelectorAll('#codex-taskboard-entry').length,1); assert.equal(d.querySelectorAll('#codex-taskboard-quota-display').length,1);
      }
      mounted(rows); assert.equal(header.outerHTML,native);
      header.insertAdjacentHTML('beforeend','<div hidden><button class="sidebar-item">HIDDEN</button></div><div role="menu"><button class="sidebar-item">MENU</button></div>');
      mounted(rows);
      header.insertAdjacentHTML('beforeend','<div class="added"><button class="sidebar-item">PRIVATE_DOT</button></div>');
      mounted(rows+1); header.querySelector('.added').remove(); mounted(rows);
      for (let n=0;n<3;n++) {
        header.hidden=true; scroll.hidden=true; refresh(dom);
        assert.equal(entry.hidden,true); assert.equal(card.hidden,true); assert.equal(contract(dom).compatible,false);
        header.hidden=false; scroll.hidden=false; mounted(rows);
      }
      const clone=header.cloneNode(true);header.replaceWith(clone);mounted(rows);
      dom.window.__codexTaskboardInjection__.destroy();dom.window.__codexTaskboardQuotaDisplay__.cleanup();
      assert.equal(d.querySelector('[data-codex-taskboard-owned]'),null);
    } finally { dispose(dom); }
  }
});

test("multiple header rows do not weaken rejection of duplicate navigations, scrolls, headers or unbounded row counts", () => {
  for (const invalid of ['navigation','scroll','header','order','rows','hidden']) {
    const dom=fixture({nested:false,legacy:false,rows:2});
    try {
      const d=dom.window.document,nav=d.querySelector('nav'),header=nav.firstElementChild;
      if(invalid==='navigation') nav.after(nav.cloneNode(true));
      if(invalid==='scroll') nav.append(nav.lastElementChild.cloneNode(true));
      if(invalid==='header') nav.insertBefore(header.cloneNode(true),nav.lastElementChild);
      if(invalid==='order') nav.append(header);
      if(invalid==='rows') for(let i=0;i<7;i++) header.insertAdjacentHTML('beforeend','<button class="sidebar-item">Fixture</button>');
      if(invalid==='hidden') header.hidden=true;
      assert.equal(contract(dom).compatible,false,invalid);
      dom.window.eval(quota);dom.window.eval(desk);
      assert.equal(d.getElementById('codex-taskboard-entry'),null,invalid);
      assert.equal(dom.window.__codexTaskboardQuotaDisplay__.status().mounted,false,invalid);
    } finally { dispose(dom); }
  }
});

test("new header diagnostics are bounded metadata and never contain native labels", () => {
  const dom=fixture({nested:true,legacy:false,rows:2});
  try {
    const result=contract(dom);
    const clean=sanitizeStartupDiagnostic(JSON.stringify({launchDiagnostic:{event:'renderer-contract',checks:result.checks,shape:{...result.shape,privateLabel:'PRIVATE_NICKNAME'}}}));
    assert.equal(clean.shape.headerNativeRows,2);assert.equal(clean.shape.navigationDirectChildren,2);
    assert.doesNotMatch(JSON.stringify(clean),/PRIVATE|Nickname|privateLabel/);
    const invalid=sanitizeStartupDiagnostic(JSON.stringify({launchDiagnostic:{event:'renderer-contract',shape:{headerNativeRows:1001,navigationDirectChildren:-1}}}));
    assert.equal(invalid.shape.headerNativeRows,undefined);assert.equal(invalid.shape.navigationDirectChildren,undefined);
  } finally { dispose(dom); }
});

test("native rows may be narrower than their validated container but must have visible geometry", () => {
  for(const width of [0,56,90]) {
    const dom=fixture({nested:true,legacy:false,rows:2});
    try {
      dom.window.HTMLElement.prototype.getBoundingClientRect=function(){return {
        width:this.tagName==='BUTTON'?width:280,height:32,top:0,left:0,right:280,bottom:32,
      };};
      // Sidebar visibility requires its real-sized container, independent of row width.
      dom.window.document.querySelector('aside').getBoundingClientRect=()=>({width:280,height:700,top:0,left:0,right:280,bottom:700});
      assert.equal(contract(dom).compatible,width>0);
      dom.window.eval(quota);dom.window.eval(desk);
      assert.equal(Boolean(dom.window.document.getElementById('codex-taskboard-entry')),width>0);
      assert.equal(dom.window.__codexTaskboardQuotaDisplay__.status().mounted,width>0);
    } finally {dispose(dom);}
  }
});
