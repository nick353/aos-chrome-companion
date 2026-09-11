import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { readFile, mkdir, writeFile } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import { isolatedBrowser } from './lib/isolated-browser-fixture.mjs';

const output=resolve(process.argv[2]??'../verification/frame-boundaries',new Date().toISOString().replaceAll(':','-'));
await mkdir(output,{recursive:true});
const worker=await readFile(new URL('../extension/service-worker.js',import.meta.url),'utf8');
const injected=worker.slice(worker.indexOf('async function injectedPageOperation('),worker.indexOf('\nchrome.runtime.onMessage.addListener'));
let browser,origin,crossOrigin;
const receipt={schema:'companion.frame_boundaries.v1',startedAt:new Date().toISOString(),cases:[],cleanup:{},
  scope:'Production injected operation in actual nested and cross-origin Chrome frames. CDP fixture transport, without broker/Native Messaging authorization. Closed Shadow DOM boundary is reported, not bypassed.'};
const page=(title,content)=>'<!doctype html><meta charset="utf-8"><style>body{font:18px system-ui;padding:20px}iframe{width:850px;height:330px;border:4px solid #658}button{padding:14px}</style><h1>'+title+'</h1>'+content;
const child=page('Nested child','<button data-testid="child" onclick="document.body.dataset.count=String(Number(document.body.dataset.count)+1);this.textContent=\'Child clicked\'">Child target</button><script>document.body.dataset.count="0"</script>');
const server=createServer((req,res)=>{res.setHeader('Content-Type','text/html; charset=utf-8');
  if(req.url==='/inner')res.end(child);
  else if(req.url==='/outer')res.end(page('Outer frame','<iframe id="inner" src="'+origin+'/inner"></iframe>'));
  else res.end(page('Companion frame boundaries','<div id="open"></div><div id="closed"></div><iframe id="outer" src="'+origin+'/outer"></iframe><iframe id="cross" src="'+crossOrigin+'/cross"></iframe><pre id="results"></pre><script>window.openClicks=0;document.querySelector("#open").attachShadow({mode:"open"}).innerHTML=\'<button data-testid="open-target" onclick="window.openClicks++">Open shadow target</button>\';document.querySelector("#closed").attachShadow({mode:"closed"}).innerHTML=\'<button data-testid="closed-target">Closed shadow target</button>\';</script>'));
});
const crossServer=createServer((_req,res)=>{res.setHeader('Content-Type','text/html; charset=utf-8');res.end(page('Cross-origin child','<button data-testid="cross-target" onclick="document.body.dataset.count=String(Number(document.body.dataset.count)+1)">Cross target</button><script>document.body.dataset.count="0"</script>'));});
const flatten=node=>[node.frame,...(node.childFrames??[]).flatMap(flatten)];
const frames=async()=>flatten((await browser.call('Page.getFrameTree')).frameTree);
async function context(frame){return (await browser.call('Page.createIsolatedWorld',{frameId:frame.id,worldName:'companion-production-frame-canary'})).executionContextId;}
async function operation(frame,action,payload={}){const result=await browser.evaluate(`(${injected})(${JSON.stringify(action)},${JSON.stringify(payload)})`,await context(frame));if(result?.__aosCompanionError)throw Object.assign(Error(result.__aosCompanionError.message),result.__aosCompanionError);return result;}
const run=async(name,fn)=>{try{receipt.cases.push({name,passed:true,...await fn()});}catch(error){receipt.cases.push({name,passed:false,error:{code:error.code,message:error.message}});}console.log(JSON.stringify(receipt.cases.at(-1)));};
try{
 await new Promise(r=>crossServer.listen(0,'127.0.0.1',r));crossOrigin=`http://127.0.0.1:${crossServer.address().port}`;
 await new Promise(r=>server.listen(0,'127.0.0.1',r));origin=`http://127.0.0.1:${server.address().port}`;
 browser=await isolatedBrowser();receipt.browser=browser.version;await browser.navigate(origin+'/');
 const current=await frames(),main=current.find(f=>f.url===origin+'/'),nested=current.find(f=>f.url===origin+'/inner'),cross=current.find(f=>f.url===crossOrigin+'/cross');
 assert.ok(main&&nested&&cross);let oldGuard;
 await run('Read the nested child document',async()=>{const result=await operation(nested,'snapshot',{maxTextChars:1000});assert.equal(result.url,origin+'/inner');assert.match(result.text,/Nested child/);return {url:result.url};});
 await run('Nested same-origin target maps to top-level coordinates and clicks once',async()=>{const proof=await operation(nested,'inspectVisualTarget',{locator:{testId:'child'}});assert.equal(proof.coordinateSpace,'top-level-viewport');const expected=await browser.evaluate(`(()=>{const outer=document.querySelector('#outer'),inner=outer.contentDocument.querySelector('#inner'),target=inner.contentDocument.querySelector('[data-testid=child]'),a=outer.getBoundingClientRect(),b=inner.getBoundingClientRect(),t=target.getBoundingClientRect();return {x:Math.round(a.left+outer.clientLeft+b.left+inner.clientLeft+t.left+t.width/2),y:Math.round(a.top+outer.clientTop+b.top+inner.clientTop+t.top+t.height/2)};})()`);assert.deepEqual(proof.point,expected);oldGuard=proof.semanticGuard.id;const result=await operation(nested,'click',{locator:{testId:'child'},semanticGuardId:oldGuard});assert.equal(result.clicked,true);assert.equal(await browser.evaluate('Number(document.body.dataset.count)',await context(nested)),1);return {framePath:proof.framePath,point:proof.point};});
 await run('Open shadow DOM target can be resolved and clicked',async()=>{const result=await operation(main,'query',{locator:{testId:'open-target'}});assert.equal(result.count,1);await operation(main,'click',{locator:{testId:'open-target'}});assert.equal(await browser.evaluate('window.openClicks'),1);});
 await run('Closed shadow DOM is outside DOM locators but visible through native AX',async()=>{const result=await operation(main,'query',{locator:{testId:'closed-target'}});assert.equal(result.count,0);const ax=await browser.call('Accessibility.getFullAXTree',{frameId:main.id});assert.ok(ax.nodes.some(n=>n.role?.value==='button'&&n.name?.value==='Closed shadow target'));return {domMatches:0,nativeAxButtonPresent:true};});
 await run('Read an explicitly selected cross-origin child',async()=>{const result=await operation(cross,'snapshot',{maxTextChars:1000});assert.equal(result.url,crossOrigin+'/cross');assert.match(result.text,/Cross-origin child/);});
 await run('Cross-origin visual mapping refuses unsupported coordinates before input',async()=>{const proof=await operation(cross,'inspectVisualTarget',{locator:{testId:'cross-target'}});assert.equal(proof.supported,false);assert.equal(proof.exact_blocker,'frame_coordinate_transform_unavailable');assert.equal(proof.mutation_dispatch_attempted,false);assert.equal(await browser.evaluate('Number(document.body.dataset.count)',await context(cross)),0);});
 for(const [name,style] of [['CSS scale','transform:scale(0.8);transform-origin:top left'],['Frame padding','padding:12px']])await run(name+' preserves the actual nested click position',async()=>{
   await browser.evaluate('document.querySelector("#outer").style.cssText='+JSON.stringify(style));
   try{const before=await browser.evaluate('Number(document.body.dataset.count)',await context(nested));const proof=await operation(nested,'inspectVisualTarget',{locator:{testId:'child'}});assert.equal(proof.supported,true);await browser.call('Input.dispatchMouseEvent',{type:'mousePressed',...proof.point,button:'left',clickCount:1});await browser.call('Input.dispatchMouseEvent',{type:'mouseReleased',...proof.point,button:'left',clickCount:1});assert.equal(await browser.evaluate('Number(document.body.dataset.count)',await context(nested)),before+1);return {point:proof.point};}
   finally{await browser.evaluate('document.querySelector("#outer").style.cssText=""');}
 });
 await run('Rotation and reflection are refused before a whole-tab coordinate is returned',async()=>{
   for(const transform of ['rotate(1deg)','scaleX(-1)']){
     await browser.evaluate('document.querySelector("#outer").style.transform='+JSON.stringify(transform));
     try{const proof=await operation(nested,'inspectVisualTarget',{locator:{testId:'child'}});assert.equal(proof.supported,false);assert.equal(proof.exact_blocker,'frame_coordinate_transform_unavailable');assert.equal(proof.point,undefined);}
     finally{await browser.evaluate('document.querySelector("#outer").style.transform=""');}
   }
 });
 await run('Recreated nested frame rejects a semantic token from its old document',async()=>{
   const before=await operation(nested,'inspectVisualTarget',{locator:{testId:'child'}});
   await browser.evaluate('document.querySelector("#outer").contentDocument.querySelector("#inner").outerHTML='+JSON.stringify('<iframe id="inner" src="'+origin+'/inner"></iframe>'));
   let replacement;for(let i=0;i<100;i++){replacement=(await frames()).find(f=>f.url===origin+'/inner'&&f.id!==nested.id);if(replacement)break;await new Promise(r=>setTimeout(r,20));}assert.ok(replacement);
   await assert.rejects(operation(replacement,'click',{locator:{testId:'child'},semanticGuardId:before.semanticGuard.id}),{code:'transaction_action_target_changed'});assert.equal(await browser.evaluate('Number(document.body.dataset.count)',await context(replacement)),0);
 });
 await browser.evaluate('document.querySelector("#results").textContent='+JSON.stringify(receipt.cases.map(c=>(c.passed?'PASS ':'FAIL ')+c.name).join('\n')));
 await browser.evaluate('document.querySelectorAll("iframe").forEach(f=>f.style.display="none")');
 const screenshot=await browser.call('Page.captureScreenshot',{format:'png'});await writeFile(join(output,'verified.png'),Buffer.from(screenshot.data,'base64'));
 receipt.result=receipt.cases.every(c=>c.passed)?'passed':'failed';
}catch(error){receipt.result='failed';receipt.error={message:error.message,code:error.code};}
finally{if(browser){await browser.close();receipt.cleanup.browserClosed=true;}await Promise.all([new Promise(r=>server.close(r)),new Promise(r=>crossServer.close(r))]);receipt.cleanup.serversClosed=true;receipt.finishedAt=new Date().toISOString();await writeFile(join(output,'receipt.json'),JSON.stringify(receipt,null,2));console.log(JSON.stringify({result:receipt.result,receipt:join(output,'receipt.json')}));if(receipt.result!=='passed')process.exitCode=1;}
