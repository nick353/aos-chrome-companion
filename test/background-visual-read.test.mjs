import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import vm from 'node:vm';
const source=await readFile(new URL('../extension/service-worker.js',import.meta.url),'utf8');

test('visual inspection reads committed scroll geometry without a throttled page timer',async()=>{
  const a=source.indexOf('  if (action === "inspectVisualTarget") {');
  const b=source.indexOf('  if (action === "inspectVisualPoint") {',a);
  let rect={left:0,top:1000,right:40,bottom:1040,x:0,y:1000,width:40,height:40};
  let scrollOptions;
  const element={scrollIntoView:options=>{scrollOptions=options;rect={...rect,top:30,bottom:70,y:30};},getBoundingClientRect:()=>rect};
  const ctx={crypto:globalThis.crypto,action:'inspectVisualTarget',payload:{locator:{label:'target'}},find:()=>element,
    wait:()=>{throw Error('hidden page timer was awaited');},innerWidth:500,innerHeight:300,
    devicePixelRatio:1,scrollX:0,scrollY:0,pageInstanceId:'page',location:{href:'https://owned.test/'},
    describe:()=>({name:'target'}),frameCoordinateMap:point=>({supported:true,point,framePath:[],viewport:{width:500,height:300}})};
  const result=await vm.runInNewContext('(async()=>{'+source.slice(a,b)+'})()',ctx);
  assert.equal(scrollOptions.behavior,'instant');
  assert.equal(result.point.y,50);
  assert.equal(result.rect.y,30);
});

for(const visibilityState of ['hidden','visible'])test('pointer preview handles '+visibilityState+' tab without delaying hidden completion',async()=>{
  const a=source.indexOf('  const visualizePoint =');
  const b=source.indexOf('  const wait =',a);
  const appended=[];
  let waits=0;
  const ctx={document:{visibilityState,getElementById:()=>null,createElement:()=>({style:{},attachShadow:()=>({append:x=>appended.push(x)}),remove:()=>{}}),documentElement:{append:()=>{}}},
    window:{},innerWidth:500,innerHeight:300,payload:{companionContext:{taskLabel:'Current task'}},normalize:x=>String(x??''),
    wait:async()=>{waits++;},setTimeout:()=>{},operationError:(code,message)=>Object.assign(new Error(message),{code})};
  const result=await vm.runInNewContext('(async()=>{'+source.slice(a,b)+'return visualizePoint({x:50,y:60});})()',ctx);
  assert.equal(result.shown,true);
  assert.equal(waits,visibilityState==='hidden'?0:1);
  if(visibilityState==='hidden')assert.ok(appended.some(node=>node.textContent?.includes('animation:none')));
});
