import assert from "node:assert/strict";
import { createServer } from "node:http";
import test from "node:test";
import { chrome, offlineBrowser, delay } from "./helpers/offline-browser.mjs";
import { loader } from "./helpers/frame-loader.mjs";

test("a fresh opaque frame inherits native CSP after the initial bypass is restored", { skip: !chrome }, async () => {
  const server = createServer((req, res) => {
    if (req.url === "/module.js") {
      res.setHeader("Content-Type", "application/javascript");
      res.setHeader("Access-Control-Allow-Origin", "*");
      res.end('document.getElementById("root").setAttribute("data-agent-desk-frame-boot","awaiting-challenge");addEventListener("message",e=>{if(e.source!==parent||!e.data?.policyTest)return;const s=document.createElement("script");s.textContent="document.getElementById(\\"root\\").dataset.violation=\\"yes\\"";document.body.append(s);parent.postMessage({policyResult:document.getElementById("root").dataset.violation||"none"},"*")});parent.postMessage({boot:true,cap:globalThis.fixtureCapability},"*")');
    } else {
      res.setHeader("Content-Type", "text/html");
      res.setHeader("Content-Security-Policy", "default-src 'none'; script-src 'nonce-fixture'; style-src 'unsafe-inline'; frame-src 'self'");
      res.end('<html><body><section id="codex-taskboard-page" data-codex-taskboard-owned="true"></section><script nonce="fixture">window.boots=[];window.policies=[];addEventListener("message",e=>{if(e.data?.boot)boots.push(e.data);if(e.data?.policyResult)policies.push(e.data.policyResult)});window.makeFrame=()=>{document.querySelector("iframe")?.remove();const f=document.createElement("iframe");f.id="codex-taskboard-frame";f.name="owned-fixture";f.sandbox="allow-scripts allow-forms allow-modals allow-downloads";f.src="about:blank";document.getElementById("codex-taskboard-page").append(f)}</script></body></html>');
    }
  });
  await new Promise(r => server.listen(0, "127.0.0.1", r));
  const base = `http://127.0.0.1:${server.address().port}`;
  const observations = [];
  try {
    await offlineBrowser(base, async page => {
      for (let i=0;i<50;i++) {
        const ready=await page.send("Runtime.evaluate",{expression:"typeof makeFrame==='function'",returnByValue:true});
        if (ready.result.value) break; await delay(30);
      }
      for (const bypass of [true, false, true]) {
        await page.send("Page.setBypassCSP", { enabled: bypass });
        await page.send("Runtime.evaluate", { expression: "makeFrame()" });
        await delay(50);
        const {frameTree}=await page.send("Page.getFrameTree");
        const child=frameTree.childFrames.find(f=>f.frame.name==='owned-fixture').frame;
        await page.send("Page.setDocumentContent",{frameId:child.id,html:`<html><head><script>globalThis.fixtureCapability='fixed'</script><script type="module" src="${base}/module.js"></script></head><body><div id="root"></div></body></html>`});
        await delay(200);
        const result=await page.send("Runtime.evaluate",{expression:"boots.length",returnByValue:true});
        observations.push(result.result.value);
        await page.send("Page.setBypassCSP",{enabled:false});
      }
      // Exercise the exact production initializer under restored strict CSP.
      for(let n=0;n<3;n++) {
        await page.send('Runtime.evaluate',{expression:'makeFrame()'});await delay(50);
        const html=`<html><head><meta http-equiv="Content-Security-Policy" content="default-src 'none'; script-src ${base} 'nonce-child'; connect-src ${base}; base-uri ${base}"><script nonce="child">globalThis.fixtureCapability='fixed'</script><script type="module" src="${base}/module.js"></script></head><body><div id="root"></div></body></html>`;
        await loader({html})(page,'owned-fixture','fixed');
        await page.send('Runtime.evaluate',{expression:'document.querySelector("iframe").contentWindow.postMessage({policyTest:true},"*")'});await delay(50);
        const policy=await page.send('Runtime.evaluate',{expression:'policies.at(-1)',returnByValue:true});
        assert.equal(policy.result.value,'none','owned child CSP also applies after restore');
        await page.send('Runtime.evaluate',{expression:'var s=document.createElement("script");s.textContent="globalThis.nativeViolation=true";document.body.append(s);s.remove()'});
        const value=await page.send('Runtime.evaluate',{expression:'({boots:boots.length,violation:globalThis.nativeViolation===true})',returnByValue:true});
        assert.equal(value.result.value.boots,3+n);assert.equal(value.result.value.violation,false,"native CSP restored after each load");
      }
    });
    assert.deepEqual(observations,[1,1,2],JSON.stringify(observations));
  } finally { await new Promise(r=>server.close(r)); }
});
