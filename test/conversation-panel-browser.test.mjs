import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { createServer } from "node:http";
import test from "node:test";
import { chrome, offlineBrowser, delay } from "./helpers/offline-browser.mjs";
const source=await readFile(new URL("../inject/codex-taskboard.user.js",import.meta.url),"utf8");
const oldPath=new URL("../dist/maintenance/20261001-bounded-entry-recovery/extracted/app/inject/codex-taskboard.user.js",import.meta.url);
function fixture(script,noLoad) {
  return `<!doctype html><html><meta charset="utf-8"><style>
  *{box-sizing:border-box}body{margin:0;font:14px system-ui}aside{position:absolute;width:280px;height:700px}
  nav{height:100%;display:flex;flex-direction:column}nav>div:first-child{flex:none;padding:8px}
  .sidebar-item{height:32px;display:flex;align-items:center;padding:4px 8px;font:13px/20px Arial;gap:8px}
  .sidebar-item svg{width:18px;height:18px}.overflow-y-auto{min-height:0;flex:1;overflow:auto}
  main{position:absolute;left:280px;top:0;width:700px;height:700px}.surface,.viewport,.app-shell-main-content-frame{width:100%;height:100%}
  .viewport{position:relative;z-index:2}.conversation{position:absolute;inset:0;visibility:visible;pointer-events:auto;background:#fafafa}
  body[data-mode="newchat"] .conversation{visibility:inherit}
  </style><body data-mode="thread"><aside data-app-shell-left-panel-appearance="content-surface"><nav role="navigation" aria-label="Fixture">
  <div><button class="sidebar-item"><svg></svg><span class="text-fade-truncate">New chat</span></button></div>
  <div class="overflow-y-auto" data-app-action-sidebar-scroll><section data-app-action-sidebar-section>
  <div role="button" data-app-action-sidebar-thread-id="fixture">Existing conversation</div></section></div></nav></aside>
  <main><div class="surface"><div class="viewport" data-app-shell-main-content-layout><div class="app-shell-main-content-frame">
  <div class="conversation">Native conversation with explicitly visible descendants</div></div></div></div></main><pre id="result"></pre><script>
  window.__CODEX_TASKBOARD_SOURCE_HASH__='fixture';window.__CODEX_TASKBOARD_HOST_CAPABILITY__='fixture-capability';
  window.electronBridge={getInitialSidebarBootstrap:()=>Promise.resolve({}),sendMessageFromView(){}};
  if(${noLoad}){const add=HTMLIFrameElement.prototype.addEventListener;HTMLIFrameElement.prototype.addEventListener=function(type,...args){if(type!=='load')return add.call(this,type,...args)}}
  window.addEventListener('message',event=>{
    if(event.source!==window||event.data?.type!=='__codexTaskboardHostRequestV1')return;
    const request=event.data.payload;
    if(request.action==='load-frame'){
      const f=[...document.querySelectorAll('iframe')].find(f=>f.name===request.frameName);
      const cap=JSON.stringify(request.frameCapability);
      f.srcdoc='<html><body style="margin:0;background:#e6f4ef">Isolated workbench fixture<script>'+\
        'const cap='+cap+';window.addEventListener("message",e=>{if(e.source===parent&&e.data?.type==="taskboard:frame-challenge")parent.postMessage({type:"taskboard:ready",capability:cap,challenge:e.data.payload.challenge},"*")});'+\
        'parent.postMessage({type:"taskboard:frame-awaiting-challenge",capability:cap},"*");<'+ '/script></body></html>';
    }
    window.postMessage({type:'__codexTaskboardHostResponseV1',capability:'fixture-capability',response:{id:request.id,ok:true,managed:true,loaded:true}},location.origin);
  });
  (0,eval)(${JSON.stringify(script)});
  window.postMessage({type:'__codexTaskboardHostHeartbeatV1',capability:'fixture-capability',at:Date.now()},location.origin);
  const api=window.__codexTaskboardInjection__,sleep=ms=>new Promise(r=>setTimeout(r,ms));
  (async()=>{await sleep(50);const results=[];for(const mode of ['thread','newchat','thread']){
    document.body.dataset.mode=mode;document.getElementById('codex-taskboard-entry').click();
    for(let i=0;i<40&&!api.ready;i++)await sleep(25);await sleep(50);
    const f=document.getElementById('codex-taskboard-frame'),box=f?.getBoundingClientRect();
    results.push({mode,ready:api.ready,hit:!!box&&document.elementFromPoint(box.left+box.width/2,box.top+box.height/2)===f,
      state:api.diagnostics().events.at(-1)});
    document.querySelector('nav>div button').click();await sleep(25);
  }api.destroy();document.getElementById('result').textContent=JSON.stringify(results)})().catch(e=>document.getElementById('result').textContent=JSON.stringify({error:e.message}));
  </script></body></html>`;
}
async function run(script,noLoad=false) {
  const server=createServer((req,res)=>{res.setHeader("Content-Type","text/html;charset=utf-8");res.end(fixture(script,noLoad));});
  await new Promise(resolve=>server.listen(0,"127.0.0.1",resolve));
  try {
    return await offlineBrowser(`http://127.0.0.1:${server.address().port}/`, async page => {
      for (let n=0;n<120;n++) {
        const result=await page.send("Runtime.evaluate", { expression:"document.getElementById('result')?.textContent", returnByValue:true });
        if(result.result.value)return JSON.parse(result.result.value);
        await delay(50);
      }
      throw new Error("Synthetic conversation fixture did not complete");
    });
  } finally {await new Promise(r=>server.close(r));}
}
test("existing conversation/New Chat/existing conversation opens a real isolated frame above visible native descendants",{skip:!chrome},async()=>{
  for(const noLoad of [false,true]){
    const results=await run(source,noLoad);assert.ok(Array.isArray(results),JSON.stringify(results));
    assert.equal(results.length,3);
    for(const result of results){assert.equal(result.ready,true,JSON.stringify(results));assert.equal(result.hit,true,JSON.stringify(results));
      assert.equal(result.state.frameOccluded,false);assert.equal(result.state.frameAwaitingChallenge,true);}
  }
});
test("frozen 0.6.18 can report a ready visible frame while an existing conversation intercepts its hit area",{skip:!chrome||!existsSync(oldPath)},async()=>{
  const results=await run(await readFile(oldPath,"utf8"));
  assert.equal(results[0].ready,true,JSON.stringify(results));assert.equal(results[0].state.frameVisible,true);assert.equal(results[0].hit,false);
  assert.equal(results[1].hit,true);assert.equal(results[2].hit,false);
});
