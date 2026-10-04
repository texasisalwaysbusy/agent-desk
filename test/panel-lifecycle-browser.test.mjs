import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { createServer } from "node:http";
import test from "node:test";
import { chrome, offlineBrowser, delay } from "./helpers/offline-browser.mjs";
import { loader } from "./helpers/frame-loader.mjs";
const source=await readFile(new URL('../inject/codex-taskboard.user.js',import.meta.url),'utf8');
test('real parent handshake survives CSP restoration, Settings parking, main-layout and repeated existing conversations',{skip:!chrome},async()=>{
  const html=`<html><head><style>*{box-sizing:border-box}body{margin:0;font:14px system-ui}aside{position:absolute;width:280px;height:700px}nav{height:100%;display:flex;flex-direction:column}.sidebar-item{height:32px;display:flex;padding:4px 8px;font:14px system-ui}.overflow-y-auto{min-height:0;flex:1;overflow:auto}main{position:absolute;left:280px;width:700px;height:700px}main>div,[data-app-shell-main-content-layout],.app-shell-main-content-frame{height:100%;width:100%}.native{position:absolute;inset:0;visibility:visible;background:#fff}</style></head><body><aside data-app-shell-left-panel-appearance="content-surface"><nav role="navigation" aria-label="Fixture"><div><button class="sidebar-item">New chat</button></div><div class="overflow-y-auto" data-app-action-sidebar-scroll><section data-app-action-sidebar-section><button data-app-action-sidebar-thread-id="fixture">Existing conversation</button></section></div></nav></aside><main><div><div data-app-shell-main-content-layout><div class="app-shell-main-content-frame"><div class="native">Synthetic native conversation</div></div></div></div></main></body></html>`;
  const server=createServer((req,res)=>{
    if(req.url==='/module.js'){
      res.setHeader('Content-Type','application/javascript');res.setHeader('Access-Control-Allow-Origin','*');
      res.end('const cap=globalThis.__CODEX_TASKBOARD_FRAME_CAPABILITY__;addEventListener("message",e=>{if(e.source===parent&&e.data?.type==="taskboard:frame-challenge")parent.postMessage({type:"taskboard:ready",capability:cap,challenge:e.data.payload.challenge},"*")});parent.postMessage({type:"taskboard:frame-awaiting-challenge",capability:cap},"*");document.getElementById("root").setAttribute("data-agent-desk-frame-boot","awaiting-challenge")');
    }else{
      res.setHeader('Content-Type','text/html');res.setHeader('Content-Security-Policy',"default-src 'none'; script-src 'unsafe-eval'; style-src 'unsafe-inline'; frame-src 'self'");res.end(html);
    }
  });
  await new Promise(r=>server.listen(0,'127.0.0.1',r));const base=`http://127.0.0.1:${server.address().port}`;
  const failures=[];
  try{await offlineBrowser(base,async page=>{
    await page.send('Runtime.enable');await page.send('Runtime.addBinding',{name:'ownedFixtureRequest'});
    const remove=page.on('Runtime.bindingCalled',async event=>{
      if(event.name!=='ownedFixtureRequest')return;
      const req=JSON.parse(event.payload);
      try{
        if(req.action==='load-frame'){
          const child=`<html><head><meta http-equiv="Content-Security-Policy" content="default-src 'none'; script-src ${base} 'nonce-child'; base-uri ${base}"><base href="${base}/"><script nonce="child">globalThis.__CODEX_TASKBOARD_FRAME_CAPABILITY__=${JSON.stringify(req.frameCapability)}</script><script type="module" src="${base}/module.js"></script></head><body><div id="root"></div></body></html>`;
          await loader({html:child})(page,req.frameName,req.frameCapability);
        }
        await page.send('Runtime.evaluate',{expression:`window.postMessage(${JSON.stringify({type:'__codexTaskboardHostResponseV1',capability:'fixture',response:{id:req.id,ok:true,managed:true,loaded:true}})},location.origin)`});
      }catch(error){failures.push(error.message);}
    });
    await delay(100);
    await page.send('Runtime.evaluate',{expression:`window.__CODEX_TASKBOARD_SOURCE_HASH__='fixture';window.__CODEX_TASKBOARD_HOST_CAPABILITY__='fixture';window.electronBridge={getInitialSidebarBootstrap:()=>Promise.resolve({}),sendMessageFromView(){}};addEventListener('message',e=>{if(e.source===window&&e.data?.type==='__codexTaskboardHostRequestV1')ownedFixtureRequest(JSON.stringify(e.data.payload))});(0,eval)(${JSON.stringify(source)});window.postMessage({type:'__codexTaskboardHostHeartbeatV1',capability:'fixture',at:Date.now()},location.origin)`});
    for(const route of ['existing','settings-return','main-layout','existing-again']){
      if(route==='settings-return'){
        await page.send('Runtime.evaluate',{expression:'window.__codexTaskboardInjection__.open()'});await delay(100);
        // Preserve a usable main while replacing its sidebar and surface, as in
        // the field transition. No manual close masks the automatic lifecycle.
        await page.send('Runtime.evaluate',{expression:`document.querySelector(".overflow-y-auto").hidden=true;var old=document.querySelector("main").firstElementChild;var fresh=old.cloneNode(true);fresh.querySelectorAll('[data-codex-taskboard-owned="true"]').forEach(n=>n.remove());old.replaceWith(fresh)`});await delay(250);
        const parked=await page.send('Runtime.evaluate',{expression:'window.__codexTaskboardInjection__.diagnostics().events.at(-1)',returnByValue:true});
        assert.equal(parked.result.value.active,false);assert.equal(parked.result.value.parkReason,'route-unavailable');
        assert.equal(parked.result.value.failure,'none');assert.equal(parked.result.value.phase,'idle');
        const native=await page.send('Runtime.evaluate',{expression:'getComputedStyle(document.querySelector(".native")).visibility',returnByValue:true});
        assert.equal(native.result.value,'visible');
        const entry=await page.send('Runtime.evaluate',{expression:'getComputedStyle(document.getElementById("codex-taskboard-entry")).display',returnByValue:true});
        assert.equal(entry.result.value,'none','unavailable entry stays hidden in its separate row');
        await page.send('Runtime.evaluate',{expression:'document.querySelector(".overflow-y-auto").hidden=false;window.__codexTaskboardInjection__.refresh()'});
        const returned=await page.send('Runtime.evaluate',{expression:'window.__codexTaskboardInjection__.diagnostics().events.at(-1).active',returnByValue:true});
        assert.equal(returned.result.value,false,'return retains native conversation until an explicit open');
      }else if(route==='main-layout'){
        await page.send('Runtime.evaluate',{expression:'window.__codexTaskboardInjection__.close();var main=document.querySelector("main");main.innerHTML="<div class=app-shell-main-content-frame><div class=native>Synthetic conversation</div></div>";main.setAttribute("data-app-shell-main-content-layout","")'});
      }
      await page.send('Runtime.evaluate',{expression:'window.__codexTaskboardInjection__.open()'});
      let state;
      for(let n=0;n<100;n++){
        const r=await page.send('Runtime.evaluate',{expression:'window.__codexTaskboardInjection__.diagnostics().events.at(-1)',returnByValue:true});state=r.result.value;
        if(state?.phase==='frame'&&state.frameVisible&&state.frameLoadAcknowledged)break;await delay(30);
      }
      assert.deepEqual(failures,[]);assert.equal(state.frameReady,true,route+JSON.stringify(state));assert.equal(state.frameVisible,true,route+JSON.stringify(state));
      assert.equal(state.frameOccluded,false,route+JSON.stringify(state));assert.equal(state.frameAwaitingChallenge,true,route+JSON.stringify(state));assert.equal(state.frameLoadAcknowledged,true,route+JSON.stringify(state));
      assert.equal(state.pageVisibility,'visible');assert.equal(state.mountState,'mounted');
      await page.send('Runtime.evaluate',{expression:'document.querySelector("nav>div button").click()'});await delay(30);
    }
    await page.send('Runtime.evaluate',{expression:'window.__codexTaskboardInjection__.destroy()'});remove();
  });}finally{await new Promise(r=>server.close(r));}
});
