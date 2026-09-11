import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { readFile, mkdir, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { resolve, join } from 'node:path';
import { isolatedBrowser } from './lib/isolated-browser-fixture.mjs';
const output=resolve(process.argv[2]??'../verification/semantic-guard-dom',new Date().toISOString().replaceAll(':','-'));
await mkdir(output,{recursive:true});
const source=await readFile(new URL('../extension/service-worker.js',import.meta.url),'utf8');
const injected=source.slice(source.indexOf('async function injectedPageOperation('),source.indexOf('\nchrome.runtime.onMessage.addListener'));
let submissions=0;
const html=`<!doctype html><meta charset="utf-8"><style>body{font:18px system-ui;padding:30px;color:#123450;background:#f4f7fb}button{width:160px;height:45px;margin:20px}pre{white-space:pre-wrap}</style><h1>Companion atomic target guard</h1><button id="target" type="button">Apply</button><form id="form"><button type="submit">Submit</button></form><pre id="results"></pre><script>window.clicks=0;document.querySelector('#target').addEventListener('click',()=>window.clicks++);document.querySelector('#form').addEventListener('submit',e=>{e.preventDefault();fetch('/submit',{method:'POST'});});</script>`;
const server=createServer((req,res)=>{if(req.method==='POST'){submissions++;res.end('received');}else{res.setHeader('Content-Type','text/html; charset=utf-8');res.end(html);}});
const receipt={schema:'aos.chrome_companion.semantic_guard_dom_canary.v1',startedAt:new Date().toISOString(),sourceDigest:createHash('sha256').update(source).digest('hex'),
 scope:'Production isolated-world inspection and click/submit in real Chrome; direct fixture CDP transport, normal installed runtime separate',cases:[],cleanup:{}};
let browser,origin;
const run=async(name,body)=>{try{await browser.navigate(origin+'/case?name='+encodeURIComponent(name));await body();receipt.cases.push({name,passed:true});}catch(error){receipt.cases.push({name,passed:false,error:{message:error.message,code:error.code}});}console.log(JSON.stringify(receipt.cases.at(-1)));};
const inspect=async(css='#target')=>browser.productionOperation(injected,'inspectVisualTarget',{locator:{css},scroll:false});
const act=async(id,action='click',css='#target')=>browser.productionOperation(injected,action,{locator:{css},semanticGuardId:id});
const rejected=async(proof)=>{await assert.rejects(act(proof.semanticGuard.id),error=>error.code==='transaction_action_target_changed'&&error.details?.mutationDispatchAttempted===false);assert.equal(await browser.evaluate('clicks'),0);};
try{
 await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));origin=`http://127.0.0.1:${server.address().port}`;
 browser=await isolatedBrowser();receipt.browser=browser.version;
 await run('One fresh inspection permits exactly one click',async()=>{const p=await inspect();assert.ok(p.semanticGuard?.id);const result=await act(p.semanticGuard.id);assert.equal(result.clicked,true);assert.equal(await browser.evaluate('clicks'),1);});
 await run('Same-content DOM replacement is rejected before input',async()=>{const p=await inspect();await browser.evaluate('target.replaceWith(target.cloneNode(true))');await rejected(p);});
 await run('Changed accessible name is rejected before input',async()=>{const p=await inspect();await browser.evaluate('target.textContent="Changed"');await rejected(p);});
 await run('Changed target rectangle is rejected before input',async()=>{const p=await inspect();await browser.evaluate('target.style.marginLeft="100px"');await rejected(p);});
 await run('Changed viewport rejects the old inspection',async()=>{const p=await inspect();await browser.call('Emulation.setDeviceMetricsOverride',{width:850,height:700,deviceScaleFactor:2,mobile:false});try{await rejected(p);}finally{await browser.call('Emulation.clearDeviceMetricsOverride');}});
 await run('An inspection token cannot be replayed',async()=>{const p=await inspect();await act(p.semanticGuard.id);await assert.rejects(act(p.semanticGuard.id),error=>error.code==='transaction_action_target_changed');assert.equal(await browser.evaluate('clicks'),1);});
 await run('Focus replacement cannot click the detached old node',async()=>{await browser.call('Page.bringToFront');await browser.evaluate('target.blur(); target.addEventListener("focus",()=>{window.focusReplaced=true;target.replaceWith(target.cloneNode(true));},{once:true})');const p=await inspect();await assert.rejects(act(p.semanticGuard.id),error=>error.code==='transaction_action_target_changed'&&error.details?.operationEffectState==='unknown');assert.equal(await browser.evaluate('window.focusReplaced'),true);assert.equal(await browser.evaluate('clicks'),0);});
 await run('Page scripts cannot read the isolated element records',async()=>{await inspect();assert.equal(await browser.evaluate('typeof globalThis.__aosCompanionSemanticGuardsV1'),'undefined');});
 await run('One guarded form submit produces one HTTP request',async()=>{const before=submissions,p=await inspect('#form');const result=await act(p.semanticGuard.id,'submit','#form');assert.equal(result.submitted,true);for(let i=0;i<30&&submissions===before;i++)await new Promise(r=>setTimeout(r,20));assert.equal(submissions-before,1);});
 await browser.evaluate(`document.querySelector('#results').textContent=${JSON.stringify(receipt.cases.map(r=>(r.passed?'PASS ':'FAIL ')+r.name).join('\n'))}`);
 const screenshot=await browser.call('Page.captureScreenshot',{format:'png',captureBeyondViewport:true});await writeFile(join(output,'verified.png'),Buffer.from(screenshot.data,'base64'));
 receipt.result=receipt.cases.every(c=>c.passed)?'passed':'failed';
}catch(error){receipt.result='failed';receipt.error={message:error.message,code:error.code};}
finally{if(browser){await browser.close();receipt.cleanup.browserClosed=true;}await new Promise(r=>server.close(r));receipt.cleanup.serverClosed=true;receipt.finishedAt=new Date().toISOString();await writeFile(join(output,'receipt.json'),JSON.stringify(receipt,null,2));console.log(JSON.stringify({result:receipt.result,passed:receipt.cases.filter(c=>c.passed).length,receipt:join(output,'receipt.json')}));if(receipt.result!=='passed')process.exitCode=1;}
