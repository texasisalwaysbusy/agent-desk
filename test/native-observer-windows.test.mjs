import test from "node:test";
import assert from "node:assert/strict";
import {createServer} from "node:net";
import {spawn} from "node:child_process";
import {readFile} from "node:fs/promises";
import {watchNativeRegisteredProcess} from "../scripts/codex-process-observer.mjs";
const executable=process.env.AGENT_DESK_NATIVE_TEST_EXE;
const skipped=process.platform!=="win32"||!executable;
const listen=async(host,port=0)=>{const server=createServer();await new Promise((resolve,reject)=>{server.once("error",reject);server.listen({host,port,ipv6Only:host==="::1"},resolve);});return server;};
const stop=server=>new Promise(resolve=>server.close(resolve));
const delay=ms=>new Promise(resolve=>setTimeout(resolve,ms));
async function observer(pid,port){
 const bytes=await readFile(executable);
 // Optimized Rust can inline the argument comparison as machine immediates.
 // Require the new observer module and its native API imports in that case;
 // an older GUI launcher must still be refused before it is spawned.
 const hasNativeMode=bytes.includes(Buffer.from("--agent-desk-observe"))
  || ["native_observer.rs","GetExtendedTcpTable","OpenProcess"].every(marker=>bytes.includes(Buffer.from(marker)));
 assert.ok(hasNativeMode,"fresh native mode required before launching a fixture");
 const result=watchNativeRegisteredProcess(pid,port,{executable});assert.equal(await result.ready,true);return result;
}
test("Windows native TCP ownership: cold start, warm fresh probes, disappearance, recovery and wildcard", {skip:skipped}, async()=>{
 let server=await listen("127.0.0.1");const port=server.address().port;const started=performance.now();const probe=await observer(process.pid,port);
 try{
  const timings=[];
  for(let i=0;i<40;i++){const result=await probe.inspect();assert.equal(result.listenerOwned,true);timings.push(result.elapsedMs);}
  await stop(server);server=null;assert.equal((await probe.inspect()).listenerOwned,false);
  server=await listen("127.0.0.1",port);assert.equal((await probe.inspect()).listenerOwned,true);
  await stop(server);server=await listen("0.0.0.0",port);assert.equal((await probe.inspect()).listenerOwned,false);
  console.log(JSON.stringify({kind:"native-owned-fixture",coldAndFortyMs:Math.round(performance.now()-started),warmMaxMs:Math.max(...timings),queries:40}));
 }finally{probe.close();if(server)await stop(server);}
});
test("Windows native TCP rejects duplicate IPv4/IPv6 and the wrong owner", {skip:skipped},async()=>{
 const first=await listen("127.0.0.1");const port=first.address().port;let second,probe;
 try{
  probe=await observer(process.pid,port);assert.equal((await probe.inspect()).listenerOwned,true);
  second=await listen("::1",port);assert.equal((await probe.inspect()).listenerOwned,false);
 }finally{probe?.close();if(second)await stop(second);await stop(first);}
 const child=spawn(process.execPath,["-e","setInterval(()=>{},1000)"],{stdio:"ignore",windowsHide:true});const server=await listen("127.0.0.1");
 try{probe=await observer(child.pid,server.address().port);assert.equal((await probe.inspect()).listenerOwned,false);}
 finally{probe?.close();child.kill();await new Promise(r=>child.once("close",r));await stop(server);}
});
test("Windows retained handle records real normal/crash-like exit codes and helper EOF leaves target alive", {skip:skipped},async()=>{
 for(const code of [0,17,259]){
  const child=spawn(process.execPath,["-e","process.stdin.once('data',()=>process.exit(Number(process.argv[1])))",String(code)],{stdio:["pipe","ignore","ignore"],windowsHide:true});
  const server=await listen("127.0.0.1");let probe;
  try{
   probe=await observer(child.pid,server.address().port);
   const closed=new Promise(r=>child.once("close",r));child.stdin.write("exit\n");await closed;
   for(let i=0;i<100&&probe.exitCode()===null;i++)await delay(10);
   assert.equal(probe.exitCode(),code);
  }finally{probe?.close();if(child.exitCode===null)child.kill();await stop(server);}
 }
 const child=spawn(process.execPath,["-e","setInterval(()=>{},1000)"],{stdio:"ignore",windowsHide:true});
 const server=await listen("127.0.0.1");
 try{const probe=await observer(child.pid,server.address().port);probe.close();await delay(40);assert.equal(child.exitCode,null);}
 finally{const closed=new Promise(r=>child.once("close",r));child.kill();await closed;await stop(server);}
});
