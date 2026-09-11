import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { readFile, mkdir, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { resolve, join } from 'node:path';
import { isolatedBrowser } from './lib/isolated-browser-fixture.mjs';
import { ViewportControls } from '../extension/viewport-control.js';
const output=resolve(process.argv[2]??'../verification/viewport-dom',new Date().toISOString().replaceAll(':','-'));await mkdir(output,{recursive:true});
const source=await readFile(new URL('../extension/service-worker.js',import.meta.url),'utf8');
const injected=source.slice(source.indexOf('async function injectedPageOperation('),source.indexOf('\nchrome.runtime.onMessage.addListener'));
const server=createServer((_req,res)=>{res.setHeader('Content-Type','text/html; charset=utf-8');res.end('<!doctype html><meta charset="utf-8"><style>body{font:18px system-ui;padding:30px;background:#f4f7fb;color:#12415c}pre{white-space:pre-wrap;line-height:1.8}</style><h1>Companion temporary viewport</h1><p>Real Chrome layout and pixel density. Task-scoped restore.</p><pre id="results"></pre>');});
const receipt={schema:'aos.chrome_companion.viewport_dom_canary.v1',startedAt:new Date().toISOString(),sourceDigest:createHash('sha256').update(source).digest('hex'),scope:'Production viewport controller and isolated-world readback, real Chrome CDP through a fixture transport. Ordinary installed runtime separate.',cases:[],cleanup:{}};
let browser,controls,owner;const commands=[];
const run=async(name,body)=>{try{const detail=await body();receipt.cases.push({name,passed:true,...detail});}catch(error){receipt.cases.push({name,passed:false,error:{message:error.message,code:error.code}});}console.log(JSON.stringify(receipt.cases.at(-1)));};
try{
 await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));browser=await isolatedBrowser();receipt.browser=browser.version;await browser.navigate(`http://127.0.0.1:${server.address().port}/`);
 const read=()=>browser.productionOperation(injected,'inspectViewport',{});const baseline=await read();receipt.baseline=baseline;
 const windowBefore=await browser.evaluate('({outerWidth,outerHeight,screenX,screenY})');
 controls=new ViewportControls({pool:{acquire:async tabId=>({target:{tabId},release:async()=>({detached:false,reason:'fixture_retains_its_transport'})})},
  sendCommand:(_target,method,params)=>{commands.push(method);return browser.call(method,params);},readViewport:read});
 owner={taskId:'viewport-fixture',sessionId:'viewport-session',generation:'viewport-gen',pageInstanceId:baseline.pageInstanceId};
 await run('Set 900 by 700 CSS pixels at density 2',async()=>{const result=await controls.configure(1,owner,{action:'set',width:900,height:700,deviceScaleFactor:2});assert.equal(result.viewport.width,900);assert.equal(result.viewport.height,700);assert.equal(result.viewport.devicePixelRatio,2);assert.deepEqual(await browser.evaluate('({outerWidth,outerHeight,screenX,screenY})'),windowBefore);return {viewport:result.viewport};});
 await run('Reject foreign session restoration without another command',async()=>{const count=commands.length;await assert.rejects(controls.configure(1,{...owner,sessionId:'foreign'},{action:'restore'}),{code:'viewport_not_owned'});assert.equal(commands.length,count);});
 await run('Explicit restore returns to the initial viewport',async()=>{const result=await controls.configure(1,owner,{action:'restore'});assert.equal(result.matchesInitialViewport,true);assert.equal(result.viewport.width,baseline.width);return {viewport:result.viewport};});
 await run('Duration expiry clears the override automatically',async()=>{await controls.configure(1,owner,{action:'set',width:720,height:640,durationMs:1000});for(let i=0;i<100&&controls.records.size;i++)await new Promise(resolve=>setTimeout(resolve,25));assert.equal(controls.records.size,0);const actual=await read();assert.equal(actual.width,baseline.width);assert.equal(actual.devicePixelRatio,baseline.devicePixelRatio);});
 await run('Session end restores layout and density',async()=>{await controls.configure(1,owner,{action:'set',width:1000,height:750,deviceScaleFactor:1.5});const results=await controls.stopForSession(owner.sessionId,owner.generation);assert.ok(results.every(r=>r.status==='fulfilled'));const actual=await read();assert.equal(actual.width,baseline.width);assert.equal(actual.height,baseline.height);assert.equal(actual.devicePixelRatio,baseline.devicePixelRatio);});
 await run('A stale document cannot receive a viewport change',async()=>{const count=commands.length;await assert.rejects(controls.configure(1,{...owner,pageInstanceId:'stale'},{action:'set',width:900,height:700}),{code:'viewport_document_changed'});assert.equal(commands.length,count);});
 await browser.evaluate(`document.querySelector('#results').textContent=${JSON.stringify(receipt.cases.map(c=>(c.passed?'PASS ':'FAIL ')+c.name).join('\n'))}`);
 const screenshot=await browser.call('Page.captureScreenshot',{format:'png'});await writeFile(join(output,'verified.png'),Buffer.from(screenshot.data,'base64'));receipt.result=receipt.cases.every(c=>c.passed)?'passed':'failed';
}catch(error){receipt.result='failed';receipt.error={message:error.message,code:error.code};}
finally{await controls?.stopAll('fixture_cleanup');if(browser){await browser.close();receipt.cleanup.browserClosed=true;}await new Promise(resolve=>server.close(resolve));receipt.cleanup.serverClosed=true;receipt.finishedAt=new Date().toISOString();await writeFile(join(output,'receipt.json'),JSON.stringify(receipt,null,2));console.log(JSON.stringify({result:receipt.result,passed:receipt.cases.filter(c=>c.passed).length,receipt:join(output,'receipt.json')}));if(receipt.result!=='passed')process.exitCode=1;}
