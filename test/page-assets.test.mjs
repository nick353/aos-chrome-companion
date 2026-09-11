import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import test from 'node:test';
import {MUTATION_METHODS, TARGET_METHODS, DEFAULT_CAPABILITIES} from '../src/shared/operation-schema.mjs';
const source=await readFile(new URL('../extension/service-worker.js',import.meta.url),'utf8');
const start=source.indexOf('  if (action === "assets") {'),end=source.indexOf('  if (action === "readNetwork") {',start);
const AsyncFunction=Object.getPrototypeOf(async function(){}).constructor;
const run=new AsyncFunction('env',`with(env){${source.slice(start,end)}}`);
function node(tag,props={}) {return {localName:tag,id:'',getAttribute(name){return this[name]??null;},querySelector(){return null;},...props};}
function fixture({elements=[],sheets=[],resources=[],payload={}}={}) {
 return {action:'assets',payload,pageInstanceId:'document1',crypto:{randomUUID:()=> 'inventory1'},document:{baseURI:'https://page.test/current/',styleSheets:sheets},location:{href:'https://page.test/current/'},
   querySemantic:(_selector,limit)=>elements.slice(0,limit),getComputedStyle:element=>({getPropertyValue:property=>property==='background-image'?element.background??'none':'none'}),
   XMLSerializer:class {serializeToString(element){return element.markup??'<svg />';}},normalize:v=>String(v??'').trim(),redactExportText:(value,max)=>({text:String(value).slice(0,max),truncated:String(value).length>max}),
   performance:{getEntriesByType:()=>resources},operationError:(code,message)=>Object.assign(Error(message),{code}),fetch:()=>{throw Error('inventory must not fetch');}};
}
test('assets retain page identity, merge observed sources, and resolve CSS and font URLs against their stylesheet',async()=>{
 const result=await run(fixture({elements:[node('img',{src:'https://page.test/image.png',currentSrc:'https://page.test/image.png'}),node('div',{background:'url("https://page.test/image.png")'})],
   sheets:[{href:'https://cdn.test/styles/main.css',cssRules:[{type:5,style:{getPropertyValue:()=> 'url("../fonts/font.woff2")'}},{type:1,style:{cssText:'background:url(../images/bg.png)'}}]}],
   resources:[{name:'https://page.test/image.png',initiatorType:'img'}]}));
 assert.equal(result.pageInstanceId,'document1');assert.equal(result.pageUrl,'https://page.test/current/');assert.equal(result.explicitFetchesRequested,0);
 assert.equal(result.assets.filter(a=>a.url==='https://page.test/image.png').length,1);
 assert.ok(result.assets.find(a=>a.url==='https://page.test/image.png').sources.some(s=>s.kind==='resource'));
 assert.ok(result.assets.some(a=>a.kind==='font'&&a.url==='https://cdn.test/fonts/font.woff2'));
 assert.ok(result.assets.some(a=>a.kind==='image'&&a.url==='https://cdn.test/images/bg.png'));
});
test('asset URL credentials, known secret query fields, and inline data bodies are omitted',async()=>{
 const result=await run(fixture({elements:[node('img',{src:'https://user:pass@cdn.test/a.png?token=private-token&v=1'}),node('img',{src:'data:image/png;base64,private-image-body'})]}));
 assert.doesNotMatch(JSON.stringify(result),/private-token|user:pass|private-image-body/);
 assert.equal(result.assets[0].urlRedacted,true);assert.match(result.assets[0].url,/v=1/);assert.equal(result.assets[1].inline,true);
});
test('file kind filtering and inline SVG inventory remain explicit',async()=>{
 const result=await run(fixture({payload:{kinds:['video']},elements:[node('img',{src:'/a.png'}),node('video',{src:'/v.mp4'}),node('svg',{id:'logo',markup:'<svg><path d="M0 0"/></svg>'})]}));
 assert.deepEqual(result.assets.map(a=>a.kind),['video']);assert.equal(result.inlineSvgs[0].name,'logo');assert.match(result.inlineSvgs[0].markup,/<path/);
});
test('asset, element and output limits are visible rather than claiming a complete inventory',async()=>{
 const elements=Array.from({length:8},(_,i)=>node('img',{src:`https://cdn.test/${i}.png`}));
 const limited=await run(fixture({elements,payload:{limit:1,maxElements:2}}));assert.equal(limited.assets.length,1);assert.equal(limited.limits.assetLimitReached,true);assert.equal(limited.limits.elementLimitReached,true);assert.equal(limited.truncated,true);
 const large=await run(fixture({elements:[node('svg',{markup:'<svg>'+ 'x'.repeat(30000)+'</svg>'})],payload:{maxBytes:10000}}));assert.equal(large.limits.outputLimitReached,true);assert.ok(Buffer.byteLength(JSON.stringify(large))<=10000);
});
test('inaccessible stylesheet diagnostics also respect the output budget',async()=>{
 const sheets=Array.from({length:30},(_,i)=>({href:'https://cdn.test/'+i+'x'.repeat(1900)+'.css',get cssRules(){throw Error('SecurityError');}}));
 const result=await run(fixture({sheets,payload:{maxBytes:10000}}));assert.ok(result.unreadableStylesheets.length>0);assert.ok(Buffer.byteLength(JSON.stringify(result))<=10000);assert.equal(result.truncated,true);
});
test('assets are a target-scoped read in the generated runtime contract',()=>{
 assert.ok(TARGET_METHODS.has('page.assets'));assert.equal(MUTATION_METHODS.has('page.assets'),false);assert.ok(DEFAULT_CAPABILITIES.includes('page.assets'));assert.equal(new Set(DEFAULT_CAPABILITIES).size,DEFAULT_CAPABILITIES.length);
});
test('long page identity is redacted and counted inside the serialized byte budget',async()=>{
 const env=fixture({elements:Array.from({length:30},(_,i)=>node('img',{src:'https://cdn.test/'+i+'x'.repeat(300)+'.png'})),payload:{maxBytes:10000}});
 env.location.href='https://user:pass@page.test/current/?token=private-token&long='+'x'.repeat(15000);
 const result=await run(env);assert.equal(result.pageUrlRedacted,true);assert.equal(result.url,result.pageUrl);assert.doesNotMatch(JSON.stringify(result),/private-token|user:pass/);
 assert.ok(Buffer.byteLength(JSON.stringify(result))<=10000);assert.equal(result.summary.totalCount,result.assets.length);assert.equal(result.limits.outputLimitReached,true);
});
test('resource scan limit is reported even when duplicates merge into one asset',async()=>{
 const result=await run(fixture({resources:Array.from({length:5001},()=>({name:'https://page.test/image.png',initiatorType:'img'}))}));
 assert.equal(result.assets.length,1);assert.equal(result.limits.resourceLimitReached,true);assert.equal(result.truncated,true);
});
