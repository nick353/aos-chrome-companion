import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { readFile, writeFile, mkdir, mkdtemp, rm } from 'node:fs/promises';
import { createServer } from 'node:http';
import { createHash } from 'node:crypto';
import { resolve, join } from 'node:path';
import { tmpdir } from 'node:os';
import vm from 'node:vm';

const sourcePath = resolve(process.argv[2] ?? 'extension/service-worker.js');
const out = resolve(process.argv[3] ?? 'work/upload-dom', new Date().toISOString().replaceAll(':', '-'));
await mkdir(out, { recursive: true });
const source = await readFile(sourcePath, 'utf8');
const start = source.indexOf('async function injectedPageOperation(');
const injected = source.slice(start, source.indexOf('\nchrome.runtime.onMessage.addListener', start));
const workerStart = source.indexOf('async function runAndCheckMutation(');
const worker = source.slice(workerStart, source.indexOf('\nasync function runPageOperation(', workerStart));
assert.ok(start > 0 && workerStart > 0);
const file = { name: '検証添付.txt', mimeType: 'text/plain', dataBase64: Buffer.from('file contents 日本語').toString('base64') };
const expectedHash = createHash('sha256').update(Buffer.from(file.dataBase64, 'base64')).digest('hex');
const receipts = [];
const html = `<!doctype html><meta charset="utf-8"><title>Companion upload regression</title>
<style>body{font:18px system-ui;padding:30px;background:#f5f8fc;color:#14314a}section{padding:24px;background:white;border:1px solid #bcccdc;border-radius:12px}#status{padding:16px}pre{white-space:pre-wrap}</style>
<h1>Companion upload regression</h1><p>Fresh isolated browser. Local synthetic attachments only.</p>
<section><label>書類 <input id="upload" type="file" multiple></label><p id="status" role="status">Waiting</p></section><pre id="results"></pre>
<script>
const mode = new URL(location.href).searchParams.get('mode');
window.stats = {input:0, change:0, privateCalls:0, received:[]};
const input = document.querySelector('#upload');
input.__reactProps$fixture = {onChange:()=>window.stats.privateCalls++};
input.addEventListener('input',()=>window.stats.input++);
input.addEventListener('change',async()=>{
  window.stats.change++;
  const files = [...input.files];
  if (mode === 'clear' || mode === 'no_confirmation' || mode === 'multiple') input.value = '';
  if (mode === 'replace') {const replacement = input.cloneNode(); replacement.value = ''; input.replaceWith(replacement);}
  if (mode === 'clone_retained') input.replaceWith(input.cloneNode());
  if (mode === 'different') {const transfer = new DataTransfer();transfer.items.add(new File(['wrong'], 'wrong.txt', {type:'text/plain'}));input.files = transfer.files;}
  if (mode === 'delayed_clear') setTimeout(()=>{input.value='';},120);
  if (mode === 'navigate') { location.href = '/changed'; return; }
  if (mode === 'no_confirmation') return;
  for (const f of files) {
    const digest = [...new Uint8Array(await crypto.subtle.digest('SHA-256',await f.arrayBuffer()))].map(v=>v.toString(16).padStart(2,'0')).join('');
    const accepted = {name:f.name,size:f.size,digest};
    const response = await fetch('/accept', {method:'POST',body:JSON.stringify({mode,...accepted})});
    if (response.ok) window.stats.received.push(accepted);
  }
  document.querySelector('#status').textContent = window.stats.received.map(f=>f.name).join(', ')+' ready';
});
</script>`;
const server = createServer(async (req, res) => {
  if (req.url === '/accept') { let body=''; for await (const part of req) body+=part;
    receipts.push(JSON.parse(body)); res.writeHead(201, {'content-type':'application/json'}); res.end('{"accepted":true}');
  } else {res.writeHead(200, {'content-type':'text/html; charset=utf-8'});res.end(html);}
});
await new Promise(ok=>server.listen(0,'127.0.0.1',ok));
const origin='http://127.0.0.1:'+server.address().port;
const profile=await mkdtemp(join(tmpdir(),'companion-upload-dom-'));
const chrome=spawn('/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', ['--headless=new','--remote-debugging-port=0','--user-data-dir='+profile,'--no-first-run','--no-default-browser-check','--disable-background-networking','--disable-component-update','--disable-sync','--window-size=1100,800','about:blank'],{stdio:['ignore','ignore','pipe']});
let socket,stderr='',nextId=0;chrome.stderr.on('data',b=>stderr=(stderr+b).slice(-8000));
const pending=new Map();
const call=(method,params={})=>new Promise((ok,no)=>{const id=++nextId;const timer=setTimeout(()=>{pending.delete(id);no(Error('CDP timeout '+method));},20000);pending.set(id,{ok,no,timer});socket.send(JSON.stringify({id,method,params}));});
const evaluate=async(expression,contextId)=>{const r=await call('Runtime.evaluate',{expression,returnByValue:true,awaitPromise:true,...(contextId?{contextId}:{})});if(r.exceptionDetails)throw Error(JSON.stringify(r.exceptionDetails));return r.result.value;};
const receipt={startedAt:new Date().toISOString(),sourcePath,sourceDigest:createHash('sha256').update(source).digest('hex'),coverage:'Production upload and worker readback in a real isolated Chrome world; local HTTP receipts and event counts. Installed native-host/MCP transport is a separate test.',cases:[]};
try {
  let port;
  for(let i=0;i<600;i++){try{port=Number((await readFile(join(profile,'DevToolsActivePort'),'utf8')).split('\n')[0]);break;}catch{if(chrome.exitCode!==null)throw Error('test Chrome exited');await new Promise(ok=>setTimeout(ok,100));}}
  assert.ok(port,'isolated Chrome endpoint unavailable');
  const tabs=await(await fetch('http://127.0.0.1:'+port+'/json/list')).json();
  socket=new WebSocket(tabs.find(t=>t.type==='page').webSocketDebuggerUrl);
  await new Promise((ok,no)=>{socket.addEventListener('open',ok,{once:true});socket.addEventListener('error',no,{once:true});});
  socket.addEventListener('message',event=>{const value=JSON.parse(event.data),p=pending.get(value.id);if(!p)return;pending.delete(value.id);clearTimeout(p.timer);value.error?p.no(Error(JSON.stringify(value.error))):p.ok(value.result);});
  receipt.browser=await call('Browser.getVersion');await call('Page.enable');
  const cases=[
    {mode:'retain',success:true,readback:'file_input'},
    {mode:'clear',confirmation:true,success:true,readback:'site_confirmation_pending'},
    {mode:'replace',confirmation:true,success:true,readback:'site_confirmation_pending'},
    {mode:'clone_retained',confirmation:true,success:true,readback:'file_input'},
    {mode:'delayed_clear',confirmation:true,success:true,readback:'site_confirmation_pending'},
    {mode:'multiple',confirmation:true,success:true,readback:'site_confirmation_pending',multiple:true},
    {mode:'clear',confirmation:false,error:'upload_file_readback_failed'},
    {mode:'different',confirmation:true,error:'upload_file_readback_failed'},
    {mode:'no_confirmation',confirmation:false,error:'upload_file_readback_failed'},
  ];
  for (const c of cases) {
    await call('Page.navigate',{url:origin+'/?mode='+c.mode});
    for(let i=0;i<100;i++){if(await evaluate('document.readyState === "complete" && !!window.stats'))break;await new Promise(ok=>setTimeout(ok,30));}
    const {frameTree}=await call('Page.getFrameTree');
    const {executionContextId}=await call('Page.createIsolatedWorld',{frameId:frameTree.frame.id,worldName:'companion-upload-fixture',grantUniveralAccess:false});
    await evaluate(injected+';globalThis.runProduction=injectedPageOperation;',executionContextId);
    const privatePropsVisible=await evaluate('Object.keys(document.querySelector("#upload")).some(key=>key.startsWith("__reactProps$"))',executionContextId);
    const actions=[];
    const context={setTimeout,
      companionError:(code,message,details)=>Object.assign(Error(message),{code,details}),
      assertLiveOrigin:async()=>assert.equal(new URL(await evaluate('location.href')).origin,origin),
      runPageOperation:async(_tab,action,payload)=>{actions.push(action);const r=await evaluate('runProduction('+JSON.stringify(action)+','+JSON.stringify(payload)+')',executionContextId);if(r?.__aosCompanionError){const e=r.__aosCompanionError;throw Object.assign(Error(e.message),{code:e.code,details:e.details});}return r;},
    };
    vm.createContext(context);vm.runInContext(worker,context);
    const payload={locator:{css:'#upload'},...(c.multiple?{files:[file,{...file,name:'second.txt'}]}:{file})};
    let result,error;
    try{result=await context.runAndCheckMutation(1,c.multiple?'uploadMultiple':'upload',payload,{allowedOrigins:[origin],allowInputReset:c.confirmation===true});}catch(e){error={code:e.code,message:e.message,details:e.details};}
    const stats=await evaluate('window.stats');
    const status=await evaluate('document.querySelector("#status").textContent');
    const sameFiles=stats.received.every(f=>f.digest===expectedHash);
    const accepted=c.mode==='no_confirmation'?stats.received.length===0:stats.received.length===(c.multiple?2:1);
    const passed=stats.input===1&&stats.change===1&&stats.privateCalls===0&&!privatePropsVisible&&sameFiles&&accepted
      &&(c.success?(!error&&result.uploadReadbackMethod===c.readback):error?.code===c.error)
      &&actions.filter(a=>a==='upload'||a==='uploadMultiple').length===1;
    receipt.cases.push({specification:c,passed,result,error,stats,status,privatePropsVisible,actions});
  }
  receipt.httpReceipts=receipts;
  await evaluate('document.querySelector("#results").textContent='+JSON.stringify(receipt.cases.map(c=>(c.passed?'PASS ':'FAIL ')+c.specification.mode+(c.specification.confirmation?' / confirmation':'')).join('\n')));
  const screenshot=await call('Page.captureScreenshot',{format:'png',captureBeyondViewport:true});receipt.image=join(out,'verified.png');await writeFile(receipt.image,Buffer.from(screenshot.data,'base64'));
  receipt.result=receipt.cases.every(c=>c.passed)?'passed':'failed';if(receipt.result==='failed')process.exitCode=1;
}catch(error){receipt.result='failed';receipt.error={message:error.message};receipt.chromeStderr=stderr;process.exitCode=1;}
finally {
  socket?.close();for(const p of pending.values()){clearTimeout(p.timer);p.no(Error('test ended'));}pending.clear();
  chrome.kill('SIGTERM');await Promise.race([new Promise(ok=>chrome.once('exit',ok)),new Promise(ok=>setTimeout(ok,3000))]);
  if(chrome.exitCode===null&&chrome.signalCode===null){chrome.kill('SIGKILL');await new Promise(ok=>chrome.once('exit',ok));}
  receipt.testChromeClosed=chrome.exitCode!==null||chrome.signalCode!==null;
  await new Promise(ok=>server.close(ok));if(receipt.testChromeClosed)await rm(profile,{recursive:true,force:true});
  receipt.finishedAt=new Date().toISOString();await writeFile(join(out,'receipt.json'),JSON.stringify(receipt,null,2));
  console.log(JSON.stringify({result:receipt.result,cases:receipt.cases.map(c=>({mode:c.specification.mode,confirmation:c.specification.confirmation,passed:c.passed,error:c.error?.code})),record:join(out,'receipt.json'),image:receipt.image,testChromeClosed:receipt.testChromeClosed,error:receipt.error}));
}
