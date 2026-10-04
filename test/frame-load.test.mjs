import assert from "node:assert/strict";
import test from "node:test";
import { loader } from "./helpers/frame-loader.mjs";
test('every later frame bootstrap restores CSP, including document failure and changed contracts',async()=>{
  for(const failure of [false,true]) {
    const calls=[];
    const cdp={on:()=>()=>{},send:async(method,params)=>{
      calls.push([method,params]);
      if(method==='Page.getFrameTree')return{frameTree:{frame:{id:'root'},childFrames:[{frame:{id:'child',parentId:'root',name:'owned',url:'about:blank'}}]}};
      if(method==='Page.setDocumentContent'&&failure)throw new Error('fixture-write-failed');
      if(method==='Page.createIsolatedWorld')return{executionContextId:1};
      if(method==='Runtime.evaluate')return{result:{value:true}};
      if(method==='Target.getTargets')return{targetInfos:[]};
      return{};
    }};
    if(failure)await assert.rejects(loader()(cdp,'owned','fixed'),/write-failed/);
    else {await loader()(cdp,'owned','fixed');await loader()(cdp,'owned','fixed');}
    const toggles=calls.filter(([m])=>m==='Page.setBypassCSP').map(([,p])=>p.enabled);
    assert.deepEqual(toggles,failure?[true,false]:[true,false,true,false]);
    assert.equal(cdp.taskboardFrameLoadInFlight,false);
    await assert.rejects(loader({compatible:false})(cdp,'owned','fixed'),/contract/);
    assert.equal(calls.filter(([m])=>m==='Page.setBypassCSP').length,toggles.length);
  }
});
test('unexpected nested or navigated frames cannot receive a document or a CSP bypass',async()=>{
  for(const frame of [{parentId:'other',url:'about:blank'},{parentId:'root',url:'https://unrelated.invalid'}]) {
    const cdp={send:async method=>{
      assert.equal(method,'Page.getFrameTree');return{frameTree:{frame:{id:'root'},childFrames:[{frame:{...frame,id:'child',name:'owned'}}]}};
    }};
    await assert.rejects(loader()(cdp,'owned','fixed'),/fresh direct child/);
  }
});
test('top document navigation invalidates the bootstrap and restores CSP',async()=>{
  let navigated;const toggles=[];
  const cdp={on:(name,fn)=>{navigated=fn;return()=>{};},send:async(method,p)=>{
    if(method==='Page.getFrameTree')return{frameTree:{frame:{id:'root'},childFrames:[{frame:{id:'child',parentId:'root',name:'owned',url:'about:blank'}}]}};
    if(method==='Page.setBypassCSP'){toggles.push(p.enabled);return{};}
    if(method==='Page.setDocumentContent'){navigated({frame:{id:'new-root'}});return{};}
    if(method==='Page.createIsolatedWorld')return{executionContextId:1};
    if(method==='Runtime.evaluate')return{result:{value:true}};
    if(method==='Target.getTargets')return{targetInfos:[]};
  }};
  await assert.rejects(loader()(cdp,'owned','fixed'),/document changed or expired/);
  assert.equal(toggles.at(-1),false);
});

test('an OOPIF restoration session can only disable CSP bypass on the exact owned frame and is detached',async()=>{
  for(const failed of [false,true]){
    const calls=[];let receive;
    const cdp={on:(name,handler)=>{assert.equal(name,'Target.receivedMessageFromTarget');receive=handler;return()=>{};},send:async(method,p)=>{
      calls.push(method);
      if(method==='Target.getTargets')return{targetInfos:[{targetId:'other',type:'iframe'},{targetId:'owned-frame',type:'iframe'}]};
      if(method==='Target.attachToTarget'){assert.deepEqual(JSON.parse(JSON.stringify(p)),{targetId:'owned-frame',flatten:false});return{sessionId:'owned-session'};}
      if(method==='Target.sendMessageToTarget'){
        assert.equal(p.sessionId,'owned-session');assert.deepEqual(JSON.parse(p.message),{id:1,method:'Page.setBypassCSP',params:{enabled:false}});
        queueMicrotask(()=>receive({sessionId:'owned-session',message:JSON.stringify({id:1,...(failed?{error:{message:'private'}}:{result:{}})})}));return{};
      }
      if(method==='Target.detachFromTarget'){assert.equal(p.sessionId,'owned-session');return{};}
      assert.fail('unexpected child operation '+method);
    }};
    if(failed)await assert.rejects(loader({restoreOnly:true})(cdp,'owned-frame'),e=>/restoration failed/.test(e.message)&&!e.message.includes('private'));
    else await loader({restoreOnly:true})(cdp,'owned-frame');
    assert.equal(calls.at(-1),'Target.detachFromTarget');
  }
  await loader({restoreOnly:true})({send:async method=>{assert.equal(method,'Target.getTargets');return{targetInfos:[{targetId:'other',type:'iframe'},{targetId:'owned-frame',type:'page'}]};}},'owned-frame');
});
