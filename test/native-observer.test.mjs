import assert from "node:assert/strict";
import test from "node:test";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { watchNativeRegisteredProcess } from "../scripts/codex-process-observer.mjs";
import { createLoopbackCandidateRuntime } from "../scripts/codex-cdp-loopback-candidate.mjs";
import { sanitizeStartupDiagnostic } from "../shared/startup-diagnostics.mjs";

function fixture(timeoutMs = 1000) {
  const child = new EventEmitter(); child.stdout = new PassThrough(); child.stderr = new PassThrough(); child.stdin = new PassThrough(); child.exitCode = null;
  const requests = [], diagnostics = []; let starts = 0, killed = 0;
  child.stdin.on("data", chunk => requests.push(JSON.parse(String(chunk))));
  child.kill = () => { killed++; };
  const observer = watchNativeRegisteredProcess(123, 41415, { executable: path.resolve("agent-desk-launcher.exe"), timeoutMs,
    onDiagnostic: v => diagnostics.push(v),
    start: (_exe, args, options) => {
      starts++; assert.deepEqual(args,["--agent-desk-observe","123","41415"]); assert.equal(options.windowsHide,true);
      assert.deepEqual(options.stdio,["pipe","pipe","pipe"]); return child;
    } });
  const send = value => child.stdout.write(JSON.stringify(value)+"\n");
  const sample = (id, extra={}) => send({ event:"sample",id,stage:"listener-table",elapsedMs:1,processAlive:true,listenerOwned:true,...extra });
  return { observer,child,requests,diagnostics,send,sample,stats:()=>({starts,killed}) };
}
test("native observer coalesces callers and requires a new matching sample for every probe",async()=>{
  const f=fixture();try{
    f.send({event:"ready"});assert.equal(await f.observer.ready,true);
    const a=f.observer.inspect(),b=f.observer.inspect();assert.equal(a,b);assert.equal(f.requests.length,1);
    f.sample(1);assert.equal((await a).listenerOwned,true);
    const c=f.observer.inspect();assert.equal(f.requests.length,2);f.sample(2,{listenerOwned:false});assert.equal((await c).listenerOwned,false);
    assert.equal(f.stats().starts,1);
  }finally{f.observer.close();}
  assert.equal(f.stats().killed,1);
});
test("a late timed-out result cannot satisfy a newer probe or silently restore ownership",async()=>{
  const f=fixture(20);try{
    f.send({event:"ready"});await f.observer.ready;
    await assert.rejects(f.observer.inspect(),e=>e.code==="ETIMEDOUT"&&e.reason==="helper-timeout");
    const next=f.observer.inspect();let settled=false;next.then(()=>{settled=true;});
    f.sample(1);await new Promise(r=>setTimeout(r,1));assert.equal(settled,false);
    f.sample(2);assert.equal((await next).observationSequence,2);assert.equal(f.stats().starts,1);
  }finally{f.observer.close();}
});
test("three native timeouts retain the existing safety stop without respawning or querying HTTP",async()=>{
  const f=fixture(10);const events=[];f.send({event:"ready"});await f.observer.ready;
  const runtime=createLoopbackCandidateRuntime(41415,123,{processObserver:f.observer,inspect:()=>f.observer.inspect(),
    onObservation:v=>events.push(v),fetchTargets:()=>assert.fail("unknown ownership"),connectSocket:()=>assert.fail("unknown ownership")});
  try{
    await assert.rejects(runtime.targets(),e=>e.observationPending);
    await assert.rejects(runtime.targets(),e=>e.observationPending);
    await assert.rejects(runtime.targets(),/unavailable/);
    assert.equal(runtime.isHealthy(),false);assert.equal(runtime.failureReason(),"process-observation-unavailable");
    assert.deepEqual(events.map(v=>v.observationFailures),[1,2,3]);assert.equal(f.stats().starts,1);
  }finally{runtime.close();}
});
test("native verified, failure and recovery samples carry bounded stages without flooding every poll",async()=>{
  const f=fixture(15);let time=0;const events=[];f.send({event:"ready"});await f.observer.ready;
  const runtime=createLoopbackCandidateRuntime(41415,123,{processObserver:f.observer,inspect:()=>f.observer.inspect(),now:()=>time,
    onObservation:v=>events.push(v),fetchTargets:async()=>({ok:true,json:async()=>[]})});
  try{
    let pending=runtime.targets();f.sample(1);await pending;
    pending=runtime.targets();f.sample(2);await pending;
    assert.deepEqual(events.map(v=>v.observation),["verified"]);
    await assert.rejects(runtime.targets(),e=>e.observationPending);
    pending=runtime.targets();f.sample(4);await pending;
    assert.deepEqual(events.map(v=>v.observation),["verified","timeout","recovered"]);
    time=60_000;pending=runtime.targets();f.sample(5);await pending;assert.equal(events.at(-1).observation,"verified");
  }finally{runtime.close();}
});
for(const value of [{event:"sample",id:99}, {event:"ready",private:"secret"}, {event:"fault",reason:"private URL",stage:"listener-table"}]){
 test("native protocol rejects unexpected authority/metadata: "+JSON.stringify(value),async()=>{
  const f=fixture();f.send(value);assert.equal(await f.observer.ready,false);assert.equal(f.observer.isHealthy(),false);
  assert.ok(!JSON.stringify(f.diagnostics).includes("private URL"));f.observer.close();
 });
}
test("helper exit is unknown; only an actual observed target handle supplies exit codes including 259",async()=>{
 for(const code of [0,17,259,0xc0000005]){
  const f=fixture();f.send({event:"ready"});await f.observer.ready;f.send({event:"exit",exitCode:code});f.child.emit("close",0);
  assert.equal(f.observer.exitCode(),code);assert.equal(f.observer.isHealthy(),true);f.observer.close();
 }
 const f=fixture();f.send({event:"ready"});await f.observer.ready;f.child.emit("close",0);
 assert.equal(f.observer.exitCode(),null);assert.equal(f.observer.isHealthy(),false);f.observer.close();
});
test("output overflow, native query errors and shutdown invalidate pending work without raw diagnostics",async()=>{
 const f=fixture();f.send({event:"ready"});await f.observer.ready;
 const pending=f.observer.inspect();f.send({event:"sample",id:1,stage:"listener-ipv6",elapsedMs:2,reason:"tcp-table-error",nativeCode:5});
 await assert.rejects(pending,e=>e.nativeCode===5&&e.stage==="listener-ipv6");
 const next=f.observer.inspect();f.observer.close();await assert.rejects(next,/unavailable/);
 const noisy=fixture();noisy.child.stdout.write("private".repeat(1024));assert.equal(await noisy.observer.ready,false);
 assert.equal(noisy.diagnostics.at(-1).reason,"output-limit");assert.ok(!JSON.stringify(noisy.diagnostics).includes("private"));noisy.observer.close();
});
test("production binds the bundled native child, skips UI setup and packages its fixed JS client",async()=>{
 const [injector,rust,prepare,client]=await Promise.all(["scripts/codex-injector.mjs","src-tauri/src/main.rs","scripts/prepare-tauri-app.mjs","scripts/codex-process-observer.mjs"].map(n=>readFile(new URL("../"+n,import.meta.url),"utf8")));
 assert.match(injector,/inspect: \(\) => processObserver.inspect\(\)/);assert.match(injector,/watchNativeRegisteredProcess\(activated.pid, port/);
 assert.ok(!injector.includes("watchRegisteredProcess("));assert.match(prepare,/"codex-process-observer.mjs"/);
 assert.ok(rust.indexOf("native_observer::try_main()")>rust.indexOf("fn main()"));
 assert.ok(rust.includes('CODEX_TASKBOARD_OBSERVER_EXECUTABLE'));assert.doesNotMatch(client,/"powershell.exe"|Get-NetTCPConnection/i);
});
test("new observer diagnostics and runtime failure classification reject arbitrary metadata",()=>{
 const result=sanitizeStartupDiagnostic(JSON.stringify({launchDiagnostic:{event:"runtime-failed",reason:"process-observation-unavailable",backend:"native-tcp-table",stage:"listener-ipv6",nativeCode:5,observation:"failed",observationSequence:4,elapsedMs:21,private:"secret"}}));
 assert.equal(result.reason,"process-observation-unavailable");assert.equal(result.nativeCode,5);assert.equal(result.private,undefined);
});
