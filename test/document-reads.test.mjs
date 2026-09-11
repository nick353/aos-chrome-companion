import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import test from 'node:test';
import vm from 'node:vm';
import {DebuggerSessionPool} from '../extension/page-observation.js';
import {AccessibilityHistory} from '../extension/accessibility-history.js';
const source = await readFile(new URL('../extension/service-worker.js',import.meta.url),'utf8');
const methods = source.slice(source.indexOf('async function withReadOnlyDebugger('),source.indexOf('async function observeDebuggerEvents('));
const redaction = source.slice(source.indexOf('function redactPeripheralText('),source.indexOf('async function runClipboardOperation('));
function harness({nodes=[],frameTree=null,documentChanged=false,captureData='aGVsbG8=',measurements=[],captureFailure=false,layoutChanged=false}={}) {
  const calls=[];let documentReads=0,measureIndex=0,layoutReads=0;
  const ctx={Date,URL,accessibilityHistory:new AccessibilityHistory(),DEFAULT_SCREENSHOT_QUALITY:60,MIN_SCREENSHOT_QUALITY:35,MAX_SCREENSHOT_BYTES:700000,
    companionError:(code,message,details)=>Object.assign(new Error(message),{code,details}),
    debuggerError:error=>Object.assign(new Error(error.message),{code:'debugger_failed'}),
    requireTrustedDebuggerAccess:async()=>{calls.push('permission');},
    chrome:{debugger:{attach:async target=>calls.push(['attach',target]),detach:async target=>calls.push(['detach',target])}},
    runPageOperation:async(tabId,action)=>{calls.push(action);return measurements[Math.min(measureIndex++,measurements.length-1)];},
    sendDebuggerCommand:async(target,method,params)=>{
      calls.push([method,params]);assert.equal(target.tabId,7);
      if(method==='Page.getFrameTree')return {frameTree:frameTree??{frame:{id:'frame-main',loaderId:documentChanged&&documentReads++>0?'loader-2':'loader-1',url:'https://owned.test/'}}};
      if(method==='Accessibility.getFullAXTree')return {nodes};
      if(method==='Page.getLayoutMetrics')return {cssContentSize:{x:0,y:0,width:1200,height:layoutChanged&&layoutReads++>0?4000:3000},cssLayoutViewport:{clientWidth:1200,clientHeight:800,pageX:0,pageY:0},cssVisualViewport:{clientWidth:1200,clientHeight:800,pageX:0,pageY:0,scale:1}};
      if(method==='Page.captureScreenshot'){if(captureFailure)throw Error('capture failed');return {data:captureData};}
      throw Error('Unexpected debugger command '+method);
    }};
  ctx.debuggerSessions=new DebuggerSessionPool(ctx.chrome.debugger);
  vm.createContext(ctx);vm.runInContext(redaction+methods+'\nglobalThis.readAX=(tabId,params)=>readNativeAccessibility(tabId,{taskId:"fixture-task",sessionId:"fixture-session",generation:"fixture-generation",...params});globalThis.capture=captureDocumentScreenshot;',ctx);
  return {ctx,calls};
}
const nativeNodes=[
  {nodeId:'1',frameId:'frame-main',role:{value:'RootWebArea'},name:{value:'Sample'},childIds:['2','9']},
  {nodeId:'2',parentId:'1',ignored:true,childIds:['3']},
  {nodeId:'3',parentId:'2',role:{value:'textbox'},name:{value:'Password'},value:{value:'dummy-password'},nameSources:[{attributeValue:'dummy-secret'}],childIds:['4'],properties:[{name:'required',value:{value:true}},{name:'valuetext',value:{value:'dummy-password'}}]},
  {nodeId:'4',parentId:'3',role:{value:'generic'},childIds:['5']},
  {nodeId:'5',parentId:'4',role:{value:'StaticText'},name:{value:'dummy-password'}},
  {nodeId:'9',parentId:'1',frameId:'frame-foreign',role:{value:'RootWebArea'},name:{value:'Other frame'},childIds:['10']},
  {nodeId:'10',parentId:'9',name:{value:'foreign child must not leak'},role:{value:'StaticText'}},
];
test('native AX keeps hierarchy through ignored nodes and excludes raw form values and child frames',async()=>{
  const {ctx,calls}=harness({nodes:nativeNodes});const result=await ctx.readAX(7,{});
  assert.equal(result.count,2);assert.equal(result.nodes[1].parentId,'1');assert.deepEqual(Array.from(result.nodes[0].childIds),['3']);
  assert.equal(result.nodes[1].properties.required,true);
  assert.doesNotMatch(JSON.stringify(result),/dummy-password|dummy-secret|foreign child/);
  assert.equal(result.formValuesIncluded,false);assert.equal(result.scope,'main_frame');
  assert.equal(result.editableDescendantsIncluded,false);
  assert.equal(result.limits.depthBoundaryObserved,false,'intentionally omitted child frames are not depth truncation');
  assert.equal(calls.at(-1)[0],'detach');assert.ok(calls.some(call=>call[0]==='Accessibility.getFullAXTree'&&call[1].depth===12));
});
test('native AX reports node and depth truncation and can include ignored nodes',async()=>{
  const {ctx}=harness({nodes:[...nativeNodes,{nodeId:'20',parentId:'1',childIds:['21']}]});const result=await ctx.readAX(7,{maxNodes:1,depth:2,includeIgnored:true});
  assert.equal(result.count,1);assert.equal(result.limits.nodeLimitReached,true);assert.equal(result.truncated,true);
  assert.equal(result.limits.depthBoundaryObserved,true);
});
test('native AX rejects same-URL document replacement and detaches',async()=>{
  const {ctx,calls}=harness({nodes:nativeNodes,documentChanged:true});
  await assert.rejects(ctx.readAX(7,{}),{code:'page_read_target_changed'});assert.equal(calls.at(-1)[0],'detach');
});
test('native AX selects one permitted child frame and gives its own document identity',async()=>{
 const child={frame:{id:'child',loaderId:'child-loader',url:'https://owned.test/child'}};
 const {ctx,calls}=harness({frameTree:{frame:{id:'frame-main',loaderId:'root-loader',url:'https://owned.test/'},childFrames:[child]},nodes:[{nodeId:'11',frameId:'child',role:{value:'RootWebArea'},name:{value:'Child'}}]});
 const result=await ctx.readAX(7,{framePath:[0]});assert.equal(result.scope,'selected_child_frame');assert.equal(result.documentLoaderId,'child-loader');assert.equal(result.nodes[0].index,1);
 assert.ok(calls.some(c=>c[0]==='Accessibility.getFullAXTree'&&c[1].frameId==='child'));
});
test('missing or unpermitted child frames do not dispatch an accessibility read',async()=>{
 const frameTree={frame:{id:'frame-main',loaderId:'root-loader',url:'https://owned.test/'},childFrames:[{frame:{id:'child',loaderId:'child-loader',url:'https://foreign.test/'}}]};
 for(const [path,code] of [[[0],'target_frame_origin_not_allowed'],[[1],'page_read_frame_unavailable'],[[-1],'page_read_frame_path_invalid']]){
   const {ctx,calls}=harness({frameTree});await assert.rejects(ctx.readAX(7,{framePath:path}),{code});assert.equal(calls.some(c=>c[0]==='Accessibility.getFullAXTree'),false);
 }
});
test('native AX unchanged diff retains its redaction and snapshot-local index contract',async()=>{
 const {ctx}=harness({nodes:nativeNodes});const first=await ctx.readAX(7,{}),next=await ctx.readAX(7,{sinceSnapshotId:first.snapshotId});assert.equal(next.kind,'native_accessibility_diff');assert.equal(next.diff.changed.length,0);assert.equal(next.diff.unchangedCount,2);assert.equal(next.indexActionsSupported,false);assert.doesNotMatch(JSON.stringify(next),/dummy-password|dummy-secret/);
});
test('full-page and region captures use document CSS geometry without viewport emulation',async()=>{
  const {ctx,calls}=harness();const full=await ctx.capture(7,{fullPage:true});
  assert.equal(full.captureMode,'full_page');assert.equal(full.clip.height,3000);assert.equal(full.bytes,5);assert.equal(full.foregroundActivated,false);
  assert.equal(full.viewportChanged,false);
  const clip=await ctx.capture(7,{clip:{x:50,y:700,width:200,height:100}});
  assert.equal(clip.captureMode,'document_clip');assert.equal(clip.clip.y,700);
  const command=calls.filter(call=>call[0]==='Page.captureScreenshot').at(-1);
  assert.equal(command[1].captureBeyondViewport,true);assert.equal(command[1].clip.scale,1);
  assert.ok(calls.every(call=>typeof call==='string'||!String(call[0]).startsWith('Emulation.')));
});
test('invalid screenshot regions never dispatch a capture',async()=>{
  for(const params of [{fullPage:true,clip:{}},{clip:{x:0,y:0,width:0,height:20}},{clip:{x:1190,y:0,width:100,height:20}},{clip:{x:0,y:0,width:Infinity,height:20}}]){
    const {ctx,calls}=harness();await assert.rejects(ctx.capture(7,params),error=>['screenshot_options_invalid','screenshot_clip_invalid'].includes(error.code));
    assert.ok(!calls.some(call=>call[0]==='Page.captureScreenshot'));
  }
});
test('oversized screenshots retry only the read and never return an oversized image',async()=>{
  const {ctx,calls}=harness({captureData:'A'.repeat(200000)});
  await assert.rejects(ctx.capture(7,{fullPage:true,maxBytes:100000}),{code:'screenshot_too_large'});
  assert.equal(calls.filter(call=>call[0]==='Page.captureScreenshot').length,3);assert.equal(calls.at(-1)[0],'detach');
});
test('element crop verifies geometry and document again after capture',async()=>{
  const target={pageInstanceId:'document-1',documentRect:{x:30,y:1200,width:200,height:80}};
  const {ctx}=harness({measurements:[target,target]});const result=await ctx.capture(7,{elementLocator:{css:'#target'}});
  assert.equal(result.captureMode,'element_crop');assert.equal(result.clip.y,1200);
  const moved=harness({measurements:[target,{...target,documentRect:{...target.documentRect,y:1300}}]});
  await assert.rejects(moved.ctx.capture(7,{elementLocator:{css:'#target'}}),{code:'screenshot_target_changed'});
  assert.equal(moved.calls.at(-1)[0],'detach');
});
test('screenshot failure releases the debugger connection',async()=>{
  const {ctx,calls}=harness({captureFailure:true});await assert.rejects(ctx.capture(7,{fullPage:true}),/capture failed/);
  assert.equal(calls.at(-1)[0],'detach');
});
test('growing documents do not return a partial image labelled full-page',async()=>{
  const {ctx,calls}=harness({layoutChanged:true});await assert.rejects(ctx.capture(7,{fullPage:true}),{code:'screenshot_target_changed'});
  assert.equal(calls.at(-1)[0],'detach');
});
