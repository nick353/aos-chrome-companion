import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import vm from 'node:vm';
import { ViewportControls, validateViewportOptions } from '../extension/viewport-control.js';
const owner={taskId:'task-a',sessionId:'session-a',generation:'gen-a',pageInstanceId:'document-a'};
const options={action:'set',width:900,height:700,deviceScaleFactor:2};
function fixture(){
 const original={width:1200,height:800,devicePixelRatio:1,scale:1,url:'https://example.test',pageInstanceId:'document-a'};
 const live=new Map([[1,{...original}],[2,{...original}]]),commands=[],timers=new Map(),released=[];let acquireWait=null,setFailure=false,clearFailure=false,readFailure=false;
 const controls=new ViewportControls({pool:{acquire:async tabId=>{if(acquireWait)await acquireWait;return {target:{tabId},release:async()=>{released.push(tabId);return {detached:true};}};}},
  readViewport:async id=>{if(readFailure)throw Error('read failure');return {...live.get(id)};},
  sendCommand:async(target,method,params)=>{commands.push({tabId:target.tabId,method,params});if(method.includes('setDevice')){Object.assign(live.get(target.tabId),{width:params.width,height:params.height,devicePixelRatio:params.deviceScaleFactor});if(setFailure)throw Error('lost set result');}else{if(clearFailure)throw Error('lost clear result');live.set(target.tabId,{...original});}},
  schedule:(fn,delay)=>{timers.set(fn,delay);return fn;},cancel:id=>timers.delete(id)});
 return {controls,live,commands,timers,released,original,set acquireWait(v){acquireWait=v;},set setFailure(v){setFailure=v;},set clearFailure(v){clearFailure=v;},set readFailure(v){readFailure=v;}};
}
test('viewport dimensions are bounded before acquiring the debugger',async()=>{
 const f=fixture();for(const patch of [{width:0},{height:5000},{deviceScaleFactor:4},{width:3840,height:2160,deviceScaleFactor:3},{durationMs:1800001}])await assert.rejects(f.controls.configure(1,owner,{...options,...patch}),{code:'viewport_options_invalid'});
 assert.equal(f.commands.length,0);assert.equal(f.controls.records.size,0);assert.deepEqual(validateViewportOptions({action:'restore'}),{action:'restore'});
});
test('viewport set keeps its debugger lease and explicit restore clears metrics with readback',async()=>{
 const f=fixture(),r=await f.controls.configure(1,owner,options);assert.equal(r.configured,true);assert.equal(r.viewport.devicePixelRatio,2);assert.equal(r.freshVisualProofRequired,true);assert.deepEqual(f.released,[]);
 const restored=await f.controls.configure(1,owner,{action:'restore'});assert.equal(restored.restored,true);assert.equal(restored.matchesInitialViewport,true);assert.deepEqual(f.live.get(1),f.original);assert.deepEqual(f.released,[1]);assert.equal(f.timers.size,0);
});
test('foreign task, session and generation cannot change or restore a viewport',async()=>{
 const f=fixture();await f.controls.configure(1,owner,options);
 for(const field of ['taskId','sessionId','generation'])for(const action of ['set','restore'])await assert.rejects(f.controls.configure(1,{...owner,[field]:'foreign'},{...options,action}),{code:'viewport_not_owned'});
 assert.equal(f.commands.length,1);await f.controls.stopAll('test_cleanup');
});
test('session close while debugger acquisition is pending prevents a later viewport dispatch',async()=>{
 const f=fixture();let resolve;f.acquireWait=new Promise(r=>resolve=r);const set=f.controls.configure(1,owner,options);await Promise.resolve();
 const stop=f.controls.stopForSession(owner.sessionId,owner.generation);resolve();await assert.rejects(set,{code:'viewport_cancelled'});await stop;
 assert.equal(f.commands.length,0);assert.equal(f.controls.records.size,0);
});
test('duration expiry and session cleanup restore only their matching task viewport',async()=>{
 const f=fixture();await f.controls.configure(1,owner,options);await f.controls.configure(2,{...owner,sessionId:'session-b'},options);
 const timer=[...f.timers.keys()][0];timer();await f.controls.records.get(1).tail;
 assert.deepEqual(f.live.get(1),f.original);assert.equal(f.live.get(2).width,900);
 await f.controls.stopForSession('session-a','gen-a');assert.equal(f.controls.records.has(2),true);await f.controls.stopForSession('session-b','gen-a');assert.equal(f.controls.records.size,0);
});
test('lost set result restores the owned override once and never repeats set',async()=>{
 const f=fixture();f.setFailure=true;await assert.rejects(f.controls.configure(1,owner,options),e=>e.details.mutationDispatchAttempted&&e.details.restoration.restored);
 assert.deepEqual(f.commands.map(c=>c.method),['Emulation.setDeviceMetricsOverride','Emulation.clearDeviceMetricsOverride']);assert.deepEqual(f.live.get(1),f.original);
});
test('failed restore stays owned and retry clears only the existing override',async()=>{
 const f=fixture();await f.controls.configure(1,owner,options);f.clearFailure=true;await assert.rejects(f.controls.configure(1,owner,{action:'restore'}));assert.equal(f.controls.records.has(1),true);
 await assert.rejects(f.controls.configure(1,owner,options),{code:'viewport_restore_pending'});f.clearFailure=false;await f.controls.configure(1,owner,{action:'restore'});
 assert.equal(f.commands.filter(c=>c.method.includes('setDevice')).length,1);assert.deepEqual(f.live.get(1),f.original);
});
test('document mismatch is rejected before CDP configuration',async()=>{
 const f=fixture();await assert.rejects(f.controls.configure(1,{...owner,pageInstanceId:'foreign-document'},options),{code:'viewport_document_changed'});assert.equal(f.commands.length,0);assert.equal(f.controls.records.size,0);
});
test('tab closure discards its override without sending commands to a missing target',async()=>{
 const f=fixture();await f.controls.configure(1,owner,options);await f.controls.tabRemoved(1);assert.equal(f.commands.length,1);assert.equal(f.controls.records.size,0);assert.equal(f.timers.size,0);
});

test('extension opt-out prevents setting a viewport while allowing owned restoration',async()=>{
 const source=await readFile(new URL('../extension/service-worker.js',import.meta.url),'utf8');
 const start=source.indexOf('async function executeCommand('),end=source.indexOf('\nasync function ',start+1);
 const f=fixture();await f.controls.configure(1,owner,options);
 const context={viewportControls:f.controls,requireTabId:id=>id,assertLiveOrigin:async()=>{},
   requireTrustedDebuggerAccess:async()=>{throw Object.assign(Error('input disabled'),{code:'visual_input_permission_required'});}};
 vm.runInNewContext(source.slice(start,end)+'\nglobalThis.runViewport=executeCommand;',context);
 await assert.rejects(context.runViewport('page.configureViewport',{...owner,...options,tabId:1}),{code:'visual_input_permission_required'});
 const result=await context.runViewport('page.configureViewport',{...owner,action:'restore',tabId:1});
 assert.equal(result.restored,true);assert.equal(result.matchesInitialViewport,true);
 assert.deepEqual(f.commands.map(c=>c.method),['Emulation.setDeviceMetricsOverride','Emulation.clearDeviceMetricsOverride']);
});

test('restoration reads the viewport after releasing the debugger session',async()=>{
 const original={width:1100,height:657,devicePixelRatio:1,scale:1,url:'https://example.test',pageInstanceId:'document-a'};
 let live={...original};
 const controls=new ViewportControls({pool:{acquire:async()=>({target:{tabId:1},release:async()=>{live={...original};return {detached:true};}})},
   readViewport:async()=>({...live}),sendCommand:async(_target,method,params)=>{live=method.includes('setDevice')?{...live,width:params.width,height:params.height,devicePixelRatio:params.deviceScaleFactor}:{...live,devicePixelRatio:1};}});
 await controls.configure(1,owner,options);const result=await controls.configure(1,owner,{action:'restore'});
 assert.equal(result.matchesInitialViewport,true);assert.equal(result.viewport.width,1100);
});
