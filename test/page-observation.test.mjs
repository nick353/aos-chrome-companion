import assert from 'node:assert/strict';
import test from 'node:test';
import {readFile} from 'node:fs/promises';
import vm from 'node:vm';
import {DebuggerSessionPool, PageObservations} from '../extension/page-observation.js';
import {createUserControls} from '../extension/user-controls.js';
import {executeWithExpectedDialog} from '../extension/action-event-wait.js';
const source=await readFile(new URL('../extension/service-worker.js',import.meta.url),'utf8');
const redact=vm.runInNewContext(source.slice(source.indexOf('function redactPeripheralText('),source.indexOf('async function runClipboardOperation('))+'\nredactPeripheralText');
const owner={taskId:'task-a',sessionId:'session-a',generation:'gen-a'};
test('default observation timers preserve the browser global receiver through start and stop',async()=>{
  const module=await readFile(new URL('../extension/page-observation.js',import.meta.url),'utf8');
  const context=vm.createContext({URL,TextEncoder});
  vm.runInContext(`globalThis.scheduled=0;globalThis.cancelled=0;
    globalThis.setTimeout=function(){if(this!==globalThis)throw new TypeError('Illegal invocation');scheduled++;return 1;};
    globalThis.clearTimeout=function(){if(this!==globalThis)throw new TypeError('Illegal invocation');cancelled++;};`,context);
  const {PageObservations:BrowserObservations,DebuggerSessionPool:BrowserPool}=vm.runInContext(module.replaceAll('export class ','class ')+'\n({PageObservations,DebuggerSessionPool})',context);
  let detached=0;const api={attach:async()=>{},detach:async()=>{detached++;},onEvent:{addListener(){}},onDetach:{addListener(){}}};
  const observations=new BrowserObservations({debuggerApi:api,pool:new BrowserPool(api),uuid:()=> 'browser-timer',redactText:redact,
    sendCommand:async()=>({frameTree:{frame:{id:'main',url:'https://page.test/'}}})});
  const started=await observations.control(7,owner,{action:'start'});assert.equal(started.status,'recording');
  const stopped=await observations.control(7,owner,{action:'stop',observationId:started.observationId});
  assert.equal(stopped.debuggerRelease.detached,true);assert.equal(context.scheduled,1);assert.equal(context.cancelled,1);assert.equal(detached,1);
});
function fixture({attachError=false,bodyError=false,body='日本語の応答',mimeType='text/plain',changedDuringStart=false}={}) {
  const calls=[],events=new Set(),detachEvents=new Set(),timers=new Map();let next=0,frameReads=0;
  const api={onEvent:{addListener:fn=>events.add(fn)},onDetach:{addListener:fn=>detachEvents.add(fn)},
    attach:async target=>{calls.push(['attach',target.tabId]);if(attachError)throw Error('Another debugger is already attached');},detach:async target=>calls.push(['detach',target.tabId])};
  const pool=new DebuggerSessionPool(api);
  const observations=new PageObservations({debuggerApi:api,pool,redactText:redact,uuid:()=>String(++next),now:()=>10000,
    schedule:fn=>{const id=++next;timers.set(id,fn);return id;},cancel:id=>timers.delete(id),
    sendCommand:async(target,method,params)=>{calls.push([method,target.tabId,params]);
      if(method==='Page.getFrameTree')return {frameTree:{frame:{id:'frame-main',url:changedDuringStart&&frameReads++>0?'https://other.test/':'https://page.test/start'}}};
      if(method==='Network.getResponseBody'){if(bodyError)throw Error('No resource with given identifier');return {body,base64Encoded:false};}
      return {};}});
  const event=(method,params={},tabId=7,extra={})=>{for(const fn of events)fn({tabId,...extra},method,params);};
  const log=(text,tabId=7)=>event('Runtime.consoleAPICalled',{type:'log',timestamp:11000,executionContextId:1,args:[{type:'string',value:text}]},tabId);
  const request=(id='r1',url='https://page.test/data')=>{
    event('Network.requestWillBeSent',{requestId:id,frameId:'frame-main',loaderId:'loader-a',type:'Fetch',timestamp:1,request:{url,method:'POST',postData:'dummy-request-secret',headers:{Authorization:'dummy-auth-secret'}}});
    event('Network.responseReceived',{requestId:id,frameId:'frame-main',type:'Fetch',timestamp:2,response:{url,status:201,mimeType,protocol:'h2',headers:{'set-cookie':'dummy-cookie-secret'}}});
    event('Network.loadingFinished',{requestId:id,timestamp:3,encodedDataLength:30});
  };
  return {calls,api,pool,observations,event,log,request,timers,detach:reason=>{for(const fn of detachEvents)fn({tabId:7},reason);},start:options=>observations.control(7,owner,{action:'start',...options}),control:(id,action,options={})=>observations.control(7,owner,{action,observationId:id,...options})};
}
test('continuous entries survive intervening debugger operations and cursor reads do not repeat entries',async()=>{
  const f=fixture();const start=await f.start();f.log('before operation');
  const input=await f.pool.acquire(7);f.log('during operation');await input.release();
  assert.equal(f.calls.filter(c=>c[0]==='attach').length,1);assert.equal(f.calls.filter(c=>c[0]==='detach').length,0);
  const first=await f.control(start.observationId,'read',{limit:1});assert.equal(first.entries[0].text,'before operation');assert.equal(first.truncated,true);
  const second=await f.control(start.observationId,'read',{cursor:first.cursor});assert.deepEqual(second.entries.map(e=>e.text),['during operation']);
  assert.equal((await f.control(start.observationId,'read',{cursor:second.cursor})).entries.length,0);
  const stopped=await f.control(start.observationId,'stop');assert.equal(stopped.status,'stopped');assert.equal(stopped.debuggerRelease.detached,true);assert.equal(f.calls.filter(c=>c[0]==='detach').length,1);
});
test('observer stop waits for an in-flight debugger share before detaching',async()=>{
  const f=fixture();const start=await f.start();const input=await f.pool.acquire(7);
  const stopped=await f.control(start.observationId,'stop');assert.equal(stopped.debuggerRelease.reason,'shared_operation_active');assert.equal(f.calls.filter(c=>c[0]==='detach').length,0);
  await input.release();assert.equal(f.calls.filter(c=>c[0]==='detach').length,1);
});
test('foreign tabs, child debugger sessions, owners, generations and cursors cannot join an observation',async()=>{
  const f=fixture();const start=await f.start();f.log('foreign tab',8);f.event('Runtime.consoleAPICalled',{args:[{value:'foreign child'}]},7,{sessionId:'child'});
  assert.equal((await f.control(start.observationId,'read')).entries.length,0);
  for(const context of [{...owner,taskId:'foreign'},{...owner,sessionId:'foreign'},{...owner,generation:'foreign'}])await assert.rejects(f.observations.control(7,context,{action:'read',observationId:start.observationId}),{code:'page_observation_not_owned'});
  await assert.rejects(f.observations.control(8,owner,{action:'read',observationId:start.observationId}),{code:'page_observation_target_mismatch'});
  await assert.rejects(f.control(start.observationId,'read',{cursor:'other-observation:0'}),{code:'page_observation_cursor_invalid'});
  await f.control(start.observationId,'stop');
});
test('bounded buffers report cursor gaps and serialize multibyte entries inside the requested output bound',async()=>{
  const f=fixture();const start=await f.start({maxEntries:10,maxBufferBytes:10000});for(let i=0;i<25;i++)f.log('日本語'.repeat(700)+i);
  const result=await f.control(start.observationId,'read',{cursor:start.cursor,maxBytes:10000});assert.equal(result.cursorExpired,true);assert.ok(result.droppedEntries>0);assert.ok(Buffer.byteLength(JSON.stringify(result))<=10000);assert.ok(result.entries.length>0);
  await f.control(start.observationId,'stop');
});
test('network metadata includes status and frame while omitting request bodies, headers and URL credentials',async()=>{
  const f=fixture();const start=await f.start();f.request('r1','https://user:pass@page.test/data?token=dummy-private-token');
  const result=await f.control(start.observationId,'read');assert.equal(result.entries.length,3);assert.equal(result.entries[1].status,201);assert.equal(result.entries[1].frameId,'frame-main');
  assert.doesNotMatch(JSON.stringify(result),/dummy-request-secret|dummy-auth-secret|dummy-cookie-secret|dummy-private-token|user:pass/);
  await assert.rejects(f.control(start.observationId,'body',{requestId:'r1'}),{code:'page_observation_body_not_enabled'});await f.control(start.observationId,'stop');
});
test('text response body reads use only an observed finished same-origin request and never replay a request',async()=>{
  const f=fixture({body:'Bearer abcdefghijklmnop\n日本語の応答'});const start=await f.start({allowResponseBodies:true});f.request();
  const body=await f.control(start.observationId,'body',{requestId:'r1'});assert.equal(body.requestReplayed,false);assert.match(body.body,/日本語/);assert.doesNotMatch(body.body,/abcdefghijklmnop/);
  f.request('cross','https://other.test/data');await assert.rejects(f.control(start.observationId,'body',{requestId:'cross'}),{code:'page_observation_body_origin_not_allowed'});
  await assert.rejects(f.control(start.observationId,'body',{requestId:'unobserved'}),{code:'page_observation_request_unavailable'});
  assert.deepEqual(f.calls.filter(c=>c[0]==='Network.getResponseBody').map(c=>c[2].requestId),['r1']);await f.control(start.observationId,'stop');
});
test('evicted response bodies and binary MIME types give exact errors without fetching',async()=>{
  for(const [options,code] of [[{bodyError:true},'page_observation_body_unavailable'],[{mimeType:'image/png'},'page_observation_body_not_text']]){
    const f=fixture(options);const start=await f.start({allowResponseBodies:true});f.request();await assert.rejects(f.control(start.observationId,'body',{requestId:'r1'}),{code});await f.control(start.observationId,'stop');
  }
});
test('same-origin navigation keeps capture but a new top-level origin ends it',async()=>{
  const f=fixture();const start=await f.start();f.event('Page.frameNavigated',{frame:{id:'frame-new',url:'https://page.test/next'}});f.log('same origin');
  f.event('Page.frameNavigated',{frame:{id:'frame-other',url:'https://other.test/'}});f.log('must not capture');
  const result=await f.control(start.observationId,'read');assert.equal(result.stopReason,'page_origin_changed');assert.deepEqual(result.entries.map(e=>e.text),['same origin']);assert.equal(result.pageUrl,'https://page.test/next');
  await f.control(start.observationId,'stop');
});
test('session close discards only its own buffers and attachment; debugger detach never auto-reattaches',async()=>{
  const f=fixture();const one=await f.start();const two=await f.observations.control(8,{...owner,sessionId:'other-session'},{action:'start'});
  await f.observations.stopForSession(owner.sessionId,'wrong-generation');assert.equal(f.observations.activeTabs.size,2);
  await f.observations.stopForSession(owner.sessionId,owner.generation);assert.equal(f.observations.records.has(one.observationId),false);assert.equal(f.observations.activeTabs.size,1);
  assert.ok(f.observations.records.has(two.observationId));assert.deepEqual(f.calls.filter(c=>c[0]==='detach').map(c=>c[1]),[7]);
  await f.observations.stopAll('connection_lost');assert.equal(f.observations.records.size,0);assert.deepEqual(f.calls.filter(c=>c[0]==='detach').map(c=>c[1]),[7,8]);
  const fresh=await f.start();const count=f.calls.filter(c=>c[0]==='attach').length;f.detach('canceled_by_user');f.log('detached');const stopped=await f.control(fresh.observationId,'read');assert.equal(stopped.stopReason,'debugger_detached:canceled_by_user');assert.equal(f.calls.filter(c=>c[0]==='attach').length,count);
});
test('duration expiry and tab closure stop capture without losing the last readable summary',async()=>{
  const f=fixture();const start=await f.start({durationMs:1000});f.log('last event');for(const timer of [...f.timers.values()])timer();
  const expired=await f.control(start.observationId,'read');assert.equal(expired.stopReason,'duration_elapsed');assert.equal(expired.entries.length,1);
  const next=await f.start();await f.observations.tabRemoved(7);assert.equal((await f.control(next.observationId,'read')).stopReason,'tab_closed');
});
test('debugger pool coalesces same-target acquisition and does not adopt another debugger',async()=>{
  const f=fixture();const leases=await Promise.all([f.pool.acquire(7),f.pool.acquire(7)]);assert.equal(f.calls.filter(c=>c[0]==='attach').length,1);await leases[0].release();await leases[1].release();await leases[1].release();assert.equal(f.calls.filter(c=>c[0]==='detach').length,1);
  const blocked=fixture({attachError:true});await assert.rejects(blocked.start(),/Another debugger/);assert.equal(blocked.calls.filter(c=>c[0]==='detach').length,0);assert.equal(blocked.observations.records.size,0);
});
test('native lifecycle notifications require the live profile/generation and command identity overrides caller fields',async()=>{
  const handler=source.slice(source.indexOf('async function handleNativeMessage('),source.indexOf('\nfunction sendCommandError('));
  const stopped=[],executed=[];
  const ctx={performance,executeWithExpectedDialog,runtimeState:{port:{},profileInstanceId:'profile-a',generation:'gen-a'},accessibilityHistory:{closeSession(){}},pageObservations:{stopForSession:async(...args)=>stopped.push(args)},javaScriptDialogs:{stopForSession:async()=>{}},viewportControls:{stopForSession:async()=>{}},MUTATION_OPERATION_METHODS:new Set(),
    userControls:createUserControls({storage:{local:{get:async()=>({})}}}),
    executeCommand:async(method,params)=>{executed.push({method,params});return {};},postNativeMessage:()=>{},sendCommandError:()=>{throw Error('unexpected error');}};
  vm.createContext(ctx);vm.runInContext(handler,ctx);
  for(const patch of [{profileInstanceId:'foreign'},{generation:'foreign'},{}])await ctx.handleNativeMessage({kind:'session.closed',profileInstanceId:'profile-a',generation:'gen-a',sessionId:'session-a',...patch});
  assert.deepEqual(stopped,[['session-a','gen-a']]);
  await ctx.handleNativeMessage({kind:'command.request',profileInstanceId:'profile-a',generation:'gen-a',sessionId:'session-a',taskId:'task-a',method:'page.observe',params:{sessionId:'forged',generation:'forged',taskId:'forged'}});
  assert.equal(executed[0].params.sessionId,'session-a');assert.equal(executed[0].params.generation,'gen-a');assert.equal(executed[0].params.taskId,'task-a');
});
test('a failed debugger detach remains explicit and never triggers adoption or a second detach',async()=>{
  const f=fixture();f.api.detach=async()=>{f.calls.push(['detach-failed',7]);throw Error('synthetic detach failure');};
  const start=await f.start();const stopped=await f.control(start.observationId,'stop');assert.equal(stopped.debuggerRelease.reason,'detach_failed');
  await assert.rejects(f.pool.acquire(7),{code:'page_observation_debugger_release_unknown'});assert.equal(f.calls.filter(c=>c[0]==='attach').length,1);assert.equal(f.calls.filter(c=>c[0]==='detach-failed').length,1);
  f.pool.detached(7);assert.equal(f.pool.targets.size,0);
});
test('navigation between frame lookup and domain enable cannot start capture under an old origin',async()=>{
  const f=fixture({changedDuringStart:true});await assert.rejects(f.start(),{code:'page_observation_target_changed'});
  assert.equal(f.observations.activeTabs.size,0);assert.equal(f.observations.records.size,0);assert.equal(f.calls.filter(c=>c[0]==='detach').length,1);
});

test('page events can be registered before an action without enabling request or console capture',async()=>{
  const f=fixture();const start=await f.start({console:false,network:false,events:['navigation','fileChooser','dialog','download']});
  f.event('Page.navigatedWithinDocument',{frameId:'frame-main',url:'https://page.test/next#ready',navigationType:'historyApi'});
  f.event('Page.lifecycleEvent',{frameId:'frame-main',name:'networkIdle',loaderId:'loader',timestamp:2});
  f.event('Page.lifecycleEvent',{frameId:'foreign',name:'load'});
  f.event('Page.fileChooserOpened',{frameId:'frame-main',backendNodeId:42,mode:'selectMultiple'});
  f.event('Page.javascriptDialogOpening',{type:'prompt',message:'Enter text',defaultPrompt:'secret-default'});
  f.event('Page.javascriptDialogClosed',{result:true,userInput:'secret-value'});
  f.event('Page.downloadWillBegin',{frameId:'frame-main',guid:'one',url:'https://page.test/file?token=secret-download',suggestedFilename:'file.txt'});
  const result=await f.control(start.observationId,'read',{cursor:start.cursor});
  assert.deepEqual(result.entries.map(e=>e.kind),['navigation','navigation','fileChooser','dialog','dialog','download']);
  assert.equal(result.entries[0].sameDocument,true);assert.equal(result.entries[1].loadState,'networkIdle');
  assert.equal(result.entries[2].fileSelectionIntercepted,false);assert.equal(result.entries[5].fileVerified,false);
  assert.doesNotMatch(JSON.stringify(result),/secret-default|secret-value|secret-download/);
  assert.deepEqual(f.calls.find(c=>c[0]==='Page.enable')[2],{enableFileChooserOpenedEvent:true});
  assert.equal(f.calls.some(c=>c[0]==='Page.setInterceptFileChooserDialog'),false);
  assert.equal(f.calls.some(c=>c[0]==='Runtime.enable'||c[0]==='Network.enable'),false);
  await f.control(start.observationId,'stop');
});

test('popup creation requires an observed exact opener and one matching URL and never grants task ownership',async()=>{
  for(const createdFirst of [false,true]){
    const f=fixture();const start=await f.start({console:false,network:false,events:['popup']});
    const popup={id:8,openerTabId:7,windowId:2,url:'https://page.test/popup'};
    if(createdFirst)f.observations.tabCreated(popup);
    f.event('Page.windowOpen',{url:popup.url,userGesture:true});
    if(!createdFirst)f.observations.tabCreated(popup);
    f.observations.tabCreated({...popup,id:9,openerTabId:999});
    const result=await f.control(start.observationId,'read');
    const confirmed=result.entries.filter(e=>e.tabCreationVerified);assert.equal(confirmed.length,1);
    assert.equal(confirmed[0].tabId,8);assert.equal(confirmed[0].taskOwnershipGranted,false);
    assert.equal(confirmed[0].popupRequestId,result.entries[0].popupRequestId);
    await f.control(start.observationId,'stop');
  }
});

test('blank popup can be associated after URL commit while two equal requests remain ambiguous',async()=>{
  const f=fixture();const start=await f.start({events:['popup']});
  f.event('Page.windowOpen',{url:'https://page.test/popup'});
  f.observations.tabCreated({id:8,openerTabId:7,windowId:2,url:'about:blank'});
  assert.equal((await f.control(start.observationId,'read')).entries.length,1);
  f.observations.tabUpdated(8,{url:'https://page.test/popup',windowId:2});
  f.event('Page.windowOpen',{url:'https://page.test/ambiguous'});f.event('Page.windowOpen',{url:'https://page.test/ambiguous'});
  f.observations.tabCreated({id:9,openerTabId:7,url:'https://page.test/ambiguous'});
  assert.deepEqual((await f.control(start.observationId,'read')).entries.filter(e=>e.tabCreationVerified).map(e=>e.tabId),[8]);
  await f.control(start.observationId,'stop');
});

test('cross-origin navigation records the transition then ends observation before new document content',async()=>{
  const f=fixture();const start=await f.start({events:['navigation']});
  f.event('Page.frameNavigated',{frame:{id:'frame-new',url:'https://other.test/path?token=private-navigation'}});
  f.log('new-origin-content');const result=await f.control(start.observationId,'read');
  assert.equal(result.status,'stopped');assert.equal(result.stopReason,'page_origin_changed');
  assert.equal(result.entries.length,1);assert.equal(result.entries[0].event,'Page.frameNavigated');
  assert.doesNotMatch(JSON.stringify(result),/private-navigation|new-origin-content/);
});
