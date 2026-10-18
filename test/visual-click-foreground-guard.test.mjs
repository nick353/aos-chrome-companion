import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import test from 'node:test';
import vm from 'node:vm';
import {DebuggerSessionPool} from '../extension/page-observation.js';

const source=await readFile(new URL('../extension/service-worker.js',import.meta.url),'utf8');
const input=source.slice(source.indexOf('async function runTrustedVisualInput('),source.indexOf('\nfunction sameVisualTargetState('));
const mouse=source.slice(source.indexOf('async function dispatchMouseClick('),source.indexOf('\nconst TRUSTED_VISUAL_KEYS'));
const inspect=source.slice(source.indexOf('  if (action === "inspectVisualTarget") {'),source.indexOf('  if (action === "inspectVisualPoint") {'));
const before={kind:'target',locator:{role:'button',name:'参考画像ライブラリ'},point:{x:293,y:400},rect:{x:238.625,y:391.359375,width:108,height:17.140625},viewport:{width:714,height:635,devicePixelRatio:2,scale:1},scroll:{x:0,y:0},pageUrl:'https://owned.test/pose',pageInstanceId:'doc',frameId:0,framePath:[],coordinateSpace:'top-level-viewport'};
const error=(code,message,details)=>Object.assign(new Error(message),{code,details});

async function run({method='visual.click',change=null,point=false,missing=false}={}){
 const guard=structuredClone(before);if(point){guard.kind='point';guard.locator=null;}
 const current={supported:true,url:guard.pageUrl,topLevelUrl:guard.pageUrl,pageInstanceId:guard.pageInstanceId,point:structuredClone(guard.point),clippedRect:structuredClone(guard.rect),viewport:structuredClone(guard.viewport),scroll:structuredClone(guard.scroll),framePath:[],coordinateSpace:guard.coordinateSpace};
 const commands=[],events=[];
 const ctx={requireTrustedDebuggerAccess:async()=>{},requireVisualPoint:p=>p,companionError:error,withTimeout:p=>p,
  visualButton:b=>b??'left',visualClickCount:c=>c,visualHoldMs:h=>h??0,
  sendDebuggerCommand:async(_target,name,params)=>{events.push('input');commands.push({name,params});},
  runPageOperation:async(_tab,action,payload)=>{
   events.push(action);
   if(action==='showVisualPoint'){
    if(change==='overlay-layout')current.point.y+=55;
    return {shown:true};
   }
   assert.equal(payload.scroll,false);
   assert.equal(payload.requireHitOwner,!point);
   assert.equal(action,point?'inspectVisualPoint':'inspectVisualTarget');
   if(change==='occluded')throw error('visual_target_not_at_point','Upload label owns the old point');
   return current;
  },
  chrome:{tabs:{get:async id=>({id,windowId:2}),query:async()=>[{id:11,windowId:2}],update:async()=>{
   events.push('activate');
   if(change==='activation-viewport')current.viewport.height=691;
   if(change==='activation-width')current.viewport.width=715;
   if(change==='short-viewport')current.viewport.height=180;
   if(change==='density')current.viewport.devicePixelRatio=1;
   if(change==='scale')current.viewport.scale=1.1;
   if(change==='rect')current.clippedRect.y+=55;
   if(change==='scroll')current.scroll.y+=55;
   if(change==='document')current.pageInstanceId='other-doc';
   if(change==='url')current.topLevelUrl='https://owned.test/other';
   if(change==='frame')current.framePath=[1];
   if(change==='coordinate-space')current.coordinateSpace='frame-local';
  }},windows:{update:async()=>{events.push('focus');}},debugger:{attach:async()=>{events.push('attach');},detach:async()=>{events.push('detach');}}},
 };
 ctx.debuggerSessions=new DebuggerSessionPool(ctx.chrome.debugger);vm.createContext(ctx);vm.runInContext(mouse+'\n'+input,ctx);
 let result,thrown;
 try{result=await ctx.runTrustedVisualInput(11,method,{point:guard.point,visualTargetGuard:missing?undefined:guard,allowedOrigins:['https://owned.test']});}catch(e){thrown=e;}
 return {result,thrown,commands,events};
}

for(const change of ['activation-width','short-viewport','overlay-layout','density','scale','rect','scroll','document','url','frame','coordinate-space','occluded'])test(`trusted click stops before all mouse input after ${change}`,async()=>{
 const r=await run({change});assert(r.thrown);assert.equal(r.thrown.code,change==='occluded'?'visual_target_not_at_point':'visual_target_proof_stale_geometry');
 assert.equal(r.thrown.details.operationEffectState,'none');assert.equal(r.thrown.details.mutationDispatchAttempted,false);assert.equal(r.commands.length,0);
 assert(r.events.indexOf('inspectVisualTarget')>r.events.indexOf('activate'));assert(r.events.indexOf('inspectVisualTarget')>r.events.indexOf('showVisualPoint'));
});
for(const method of ['visual.click','visual.doubleClick'])test(`${method}: height-only extent change keeps exact target geometry and hit ownership`,async()=>{
 const r=await run({method,change:'activation-viewport'});assert.ifError(r.thrown);
 assert.equal(r.commands.length,method==='visual.click'?3:6);
 assert.equal(r.result.clickGuardReadback.viewportHeightChanged,true);
 assert.equal(r.result.clickGuardReadback.sameTargetGeometry,true);
 assert.equal(r.result.clickGuardReadback.hitOwnerVerified,true);
});
test('missing broker-verified click guard never dispatches mouse input',async()=>{const r=await run({missing:true});assert.equal(r.thrown.code,'visual_click_guard_required');assert.equal(r.commands.length,0);});
for(const method of ['visual.click','visual.doubleClick'])test(`${method}: unchanged exact target retains the original trusted gesture`,async()=>{
 const r=await run({method});assert.ifError(r.thrown);assert.equal(r.result.trustedInput,true);assert.equal(r.commands.length,method==='visual.click'?3:6);
 assert.deepEqual(r.commands.map(c=>c.params.type),method==='visual.click'?['mouseMoved','mousePressed','mouseReleased']:['mouseMoved','mousePressed','mouseReleased','mouseMoved','mousePressed','mouseReleased']);
 assert(r.events.indexOf('inspectVisualTarget')<r.events.indexOf('input'));
});
for(const change of [null,'activation-viewport'])test(`explicit point proof keeps its geometry boundary (${change??'unchanged'})`,async()=>{
 const r=await run({point:true,change});if(change){assert.equal(r.thrown.code,'visual_target_proof_stale_geometry');assert.equal(r.commands.length,0);}else{assert.ifError(r.thrown);assert.equal(r.commands.length,3);}
});

for(const hitKind of ['exact','descendant','shadow-descendant','upload-label','sticky-generate','none'])test(`post-activation hit ownership: ${hitKind}`,async()=>{
 const rect={left:238.625,top:391.359375,right:346.625,bottom:408.5,x:238.625,y:391.359375,width:108,height:17.140625};
 const element={getBoundingClientRect:()=>rect,isConnected:true};let hit;
 if(hitKind==='exact')hit=element;
 else if(hitKind==='descendant')hit={parentNode:element};
 else if(hitKind==='shadow-descendant'){
  const root={host:element,getRootNode:()=>root};const leaf={parentNode:root};element.shadowRoot={elementFromPoint:()=>leaf};hit=element;
 }else if(hitKind==='none')hit=null;else hit={parentNode:null,getRootNode:()=>({})};
 const ctx={boxOf:element=>element.getBoundingClientRect(),scrollTargetOf:element=>element,crypto:globalThis.crypto,action:'inspectVisualTarget',payload:{locator:before.locator,scroll:false,requireHitOwner:true},find:()=>element,innerWidth:714,innerHeight:635,devicePixelRatio:2,scrollX:0,scrollY:0,pageInstanceId:'doc',location:{href:before.pageUrl},document:{elementFromPoint:()=>hit},describe:()=>({name:'Library'}),operationError:error,frameCoordinateMap:point=>({supported:true,point,framePath:[],coordinateSpace:'top-level-viewport',viewport:before.viewport,scroll:before.scroll})};
 if(['upload-label','sticky-generate','none'].includes(hitKind))await assert.rejects(vm.runInNewContext('(async()=>{'+inspect+'})()',ctx),e=>e.code==='visual_target_not_at_point');
 else{const r=await vm.runInNewContext('(async()=>{'+inspect+'})()',ctx);assert.equal(r.supported,true);assert.equal(r.point.y,400);}
});
