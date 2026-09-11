import assert from 'node:assert/strict';
import test from 'node:test';
import { createUserControls } from '../extension/user-controls.js';
function fixture(saved = {}) {
  let storage = { companionUserControlsV1: saved }, readCount = 0;
  const tabs = new Map([[1,{id:1,url:'https://blocked.test/page'}],[2,{id:2,url:'https://allowed.test/page'}]]);
  const api = { runtime:{id:'extension'}, storage:{local:{get:async()=>storage,set:async value=>{storage=value;}}},
    tabs:{get:async id=>tabs.get(id),query:async()=>[tabs.get(1)]},
    scripting:{executeScript:async()=>{readCount++;return [{result:{url:tabs.get(1).url,title:'Page',selectedText:'Selected'}}];}} };
  return {controls:createUserControls(api),api,tabs,get readCount(){return readCount;},sender:{id:'extension'},get storage(){return storage;}};
}

test('pause persists and stops new mutations without preventing readback or cleanup',async()=>{
  const f=fixture();await f.controls.handle({kind:'controls.pause',paused:true},f.sender);
  await assert.rejects(f.controls.beforeCommand('page.click',{mutation:true}),error=>error.code==='companion_user_paused'&&error.details.mutationDispatchAttempted===false);
  await f.controls.beforeCommand('page.snapshot',{mutation:false});
  await f.controls.beforeCommand('tabs.close',{mutation:true});
  await f.controls.beforeCommand('page.configureViewport',{mutation:true,action:'restore'});
  await assert.rejects(f.controls.beforeCommand('page.configureViewport',{mutation:true,action:'set'}),/paused/);
  const restarted=createUserControls(f.api);
  await assert.rejects(restarted.beforeCommand('page.type',{mutation:true}),/paused/);
  await f.controls.handle({kind:'controls.pause',paused:false},f.sender);
  await f.controls.beforeCommand('page.click',{mutation:true});
});

test('site controls deny the live redirected site and new destinations, with unrelated tabs unaffected',async()=>{
  const f=fixture();await f.controls.handle({kind:'controls.site',origin:'https://blocked.test/path',blocked:true},f.sender);
  await assert.rejects(f.controls.beforeCommand('page.snapshot',{tabId:1,targetOrigin:'https://allowed.test',mutation:false}),/blocked/);
  await assert.rejects(f.controls.beforeCommand('tabs.create',{url:'https://blocked.test/new',mutation:true}),/blocked/);
  await f.controls.beforeCommand('page.snapshot',{tabId:2,mutation:false});
  await f.controls.beforeCommand('tabs.close',{tabId:1,mutation:true});
  await f.controls.handle({kind:'controls.site',origin:'https://blocked.test',blocked:false},f.sender);
  await f.controls.beforeCommand('page.snapshot',{tabId:1,mutation:false});
});

test('page and foreign-extension senders cannot change pause, site policy or extract context',async()=>{
  const f=fixture();
  for(const sender of [{id:'extension',tab:{id:1}},{id:'foreign'},{}]){
    for(const message of [{kind:'controls.pause',paused:true},{kind:'controls.site',origin:'https://blocked.test',blocked:true},{kind:'controls.context'}]){
      await assert.rejects(f.controls.handle(message,sender),/Only the Companion panel/);
    }
  }
  assert.equal(f.controls.state().paused,false);assert.equal(f.readCount,0);
});

test('explicit selection read verifies the current tab and refuses a blocked site',async()=>{
  const f=fixture();const result=await f.controls.handle({kind:'controls.context'},f.sender);
  assert.equal(result.selectedText,'Selected');assert.equal(result.tabId,1);assert.equal(result.snapshotOnly,true);
  await f.controls.handle({kind:'controls.site',origin:'https://blocked.test',blocked:true},f.sender);
  await assert.rejects(f.controls.handle({kind:'controls.context'},f.sender),/Allow this site/);
  assert.equal(f.readCount,1);
});

test('recent operations are bounded, exclude input content and clear independently of browser state',async()=>{
  const f=fixture();for(let i=0;i<40;i++)f.controls.observe('page.type',{operationId:String(i),taskId:'task',taskLabel:'Work',tabId:2,text:'private input',dataBase64:'secret'},'running');
  f.controls.observe('page.type',{operationId:'39'},'finished');
  const state=f.controls.state();assert.equal(state.recentOperations.length,32);assert.equal(state.recentOperations[0].phase,'finished');
  assert.ok(!JSON.stringify(state).includes('private input'));assert.ok(!JSON.stringify(state).includes('dataBase64'));
  await f.controls.handle({kind:'controls.clearRecent'},f.sender);assert.equal(f.controls.state().recentOperations.length,0);assert.equal(f.tabs.size,2);
});

test('a full-tab copy of the bundled panel remains an authorized extension UI',async()=>{
 const f=fixture();const state=await f.controls.handle({kind:'controls.pause',paused:true},{id:'extension',tab:{id:3},url:'chrome-extension://extension/sidepanel.html'});
 assert.equal(state.paused,true);
 await assert.rejects(f.controls.handle({kind:'controls.pause',paused:false},{id:'extension',tab:{id:3},url:'https://site.test/sidepanel.html'}),/Only the Companion panel/);
});
