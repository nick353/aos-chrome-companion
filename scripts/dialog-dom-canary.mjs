import assert from 'node:assert/strict';
import vm from 'node:vm';
import {spawn} from 'node:child_process';
import {readFile,writeFile,mkdir,mkdtemp,rm} from 'node:fs/promises';
import {createHash} from 'node:crypto';
import {resolve,join} from 'node:path';
import {tmpdir} from 'node:os';
import {createServer} from 'node:http';
import {JavaScriptDialogs} from '../extension/javascript-dialog.js';
import {executeWithExpectedDialog} from '../extension/action-event-wait.js';
import {DebuggerSessionPool} from '../extension/page-observation.js';
import {CompanionBroker} from '../src/broker/broker.mjs';
import {BrokerClient} from '../src/client/broker-client.mjs';
import {connectPeer} from '../src/client/connect.mjs';
import {ensureBrokerSecret} from '../src/shared/security.mjs';
import {ensureIssuerSecret,createAuthorityEnvelope} from '../src/shared/task-runtime.mjs';
import {DEFAULT_CAPABILITIES,PROTOCOL_VERSION} from '../src/shared/constants.mjs';
import {INSTALL_BUILD_ID} from '../src/shared/build-info.mjs';

const out=resolve(process.argv[2]??'work/dialog-dom',new Date().toISOString().replaceAll(':','-'));await mkdir(out,{recursive:true});
const triggerBaseline=process.argv.includes('--trigger-baseline');
const triggerEvents=process.argv.includes('--trigger-events');
const scratch=await mkdtemp(join(tmpdir(),'companion-dialog-')),profile=join(scratch,'chrome');
const source=await readFile(new URL('../extension/service-worker.js',import.meta.url),'utf8');
const injected=source.slice(source.indexOf('async function injectedPageOperation('),source.indexOf('\nchrome.runtime.onMessage.addListener',source.indexOf('async function injectedPageOperation(')));
const wrappers=source.slice(source.indexOf('async function inspectJavaScriptDialog('),source.indexOf('async function readConsole('));
const redact=vm.runInNewContext(source.slice(source.indexOf('function redactPeripheralText('),source.indexOf('async function runClipboardOperation('))+'\nredactPeripheralText');
const html=`<!doctype html><meta charset="utf-8"><title>Companion dialog verification</title><style>body{font:22px system-ui;background:#f6f9fe;color:#15365a;padding:40px}button,input{font:22px system-ui;padding:12px;margin:15px}pre{white-space:pre-wrap;font:19px system-ui}</style><h1>Companion dialog verification</h1><input id="retained" value="未保存の本文 👩🏽‍💻"><button id="activate">Activate test page</button><pre id="results">Ready</pre><script>window.dialogResults=[];window.showFixtureDialog=function(c){let value;if(c.type==='prompt')value=prompt(c.message,'Default stays local');else if(c.type==='confirm')value=confirm(c.message);else{alert(c.message);value='alert closed'}window.dialogResults.push(value);if(c.chain){const next=prompt('Next question','');window.dialogResults.push(next)}document.querySelector('#results').textContent=JSON.stringify(window.dialogResults)};</script>`;
const triggerHtml=html+'<section>'+['alert','confirm','prompt'].map(type=>`<button type="button" data-testid="trigger-${type}" onclick="window.showFixtureDialog({type:\'${type}\',message:\'Triggered ${type}\'})">Open ${type}</button>`).join('')+'</section>';
const server=createServer((req,res)=>{if(req.url==='/favicon.ico'){res.writeHead(204);res.end();}else{res.writeHead(200,{'content-type':'text/html; charset=utf-8'});res.end(triggerBaseline||triggerEvents?triggerHtml:html);}});
await new Promise(ok=>server.listen(0,'127.0.0.1',ok));const origin='http://127.0.0.1:'+server.address().port;
const chrome=spawn('/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',['--headless=new','--remote-debugging-port=0','--user-data-dir='+profile,'--no-first-run','--no-default-browser-check','--disable-background-networking','--disable-component-update','--disable-sync','--window-size=1200,900','about:blank'],{stdio:['ignore','ignore','pipe']});
let stderr='';chrome.stderr.on('data',chunk=>{stderr=(stderr+chunk).slice(-10000);});
let socket,broker,client,relay,dialogs,currentTab=null,nextId=0,session;
const pending=new Map(),events=new Set(),detachEvents=new Set(),commands=[],cdpCalls=[];
const delay=ms=>new Promise(ok=>setTimeout(ok,ms));
async function until(predicate,message){for(let i=0;i<100;i++){if(await predicate())return;await delay(30);}throw Error(message);}
function call(method,params={}){return new Promise((ok,no)=>{const id=++nextId,timer=setTimeout(()=>{pending.delete(id);no(Error('CDP timeout '+method));},10000);pending.set(id,{ok,no,timer});cdpCalls.push({method,at:new Date().toISOString()});socket.send(JSON.stringify({id,method,params}));});}
const receipt={startedAt:new Date().toISOString(),chromePid:chrome.pid,sourceDigest:createHash('sha256').update(source).digest('hex'),
  dialogModuleDigest:createHash('sha256').update(await readFile(new URL('../extension/javascript-dialog.js',import.meta.url))).digest('hex'),
  coverage:'Production JavaScriptDialogs and service-worker dialog wrappers, real signed BrokerClient/CompanionBroker and durable ledger, actual Chrome modal events and post-dialog DOM. An owned CDP adapter supplies chrome.debugger/tabs and extension relay transport. Installed extension permissions, native transport and normal MCP host publication are separate.',cases:[]};
try{
 let port;for(let i=0;i<1200;i++){try{port=Number((await readFile(join(profile,'DevToolsActivePort'),'utf8')).split('\n')[0]);break;}catch{if(chrome.exitCode!==null)throw Error('test Chrome exited');await delay(100);}}
 assert.ok(port,'test Chrome endpoint unavailable');
 const pages=await(await fetch('http://127.0.0.1:'+port+'/json/list')).json(),page=pages.find(p=>p.type==='page');assert.ok(page);
 socket=new WebSocket(page.webSocketDebuggerUrl);await new Promise((ok,no)=>{socket.addEventListener('open',ok,{once:true});socket.addEventListener('error',no,{once:true});});
 socket.addEventListener('message',event=>{const m=JSON.parse(event.data);if(m.method){for(const fn of events)fn({tabId:1},m.method,m.params);return;}const p=pending.get(m.id);if(!p)return;pending.delete(m.id);clearTimeout(p.timer);m.error?p.no(Error(JSON.stringify(m.error))):p.ok(m.result);});
 receipt.browser=await call('Browser.getVersion');
 const evaluate=async expression=>{const r=await call('Runtime.evaluate',{expression,returnByValue:true,awaitPromise:true});if(r.exceptionDetails)throw Error(JSON.stringify(r.exceptionDetails));return r.result.value;};
 const snapshot=async()=>{const r=await evaluate(`(${injected})('snapshot',{maxTextChars:30000})`);if(r.__aosCompanionError)throw Object.assign(Error(r.__aosCompanionError.message),r.__aosCompanionError);return {...r,windowId:1,frameId:0};};
 let attached=false;
 const api={onEvent:{addListener:fn=>events.add(fn)},onDetach:{addListener:fn=>detachEvents.add(fn)},attach:async()=>{assert.equal(attached,false);attached=true;},detach:async()=>{attached=false;}};
 dialogs=new JavaScriptDialogs({debuggerApi:api,pool:new DebuggerSessionPool(api),sendCommand:(_target,method,params)=>call(method,params),redactText:redact});
 const context={requireTrustedDebuggerAccess:async()=>{},javaScriptDialogs:dialogs,chrome:{tabs:{get:async()=>{const info=(await call('Target.getTargetInfo')).targetInfo;return {...currentTab,url:info.url,title:info.title};}}}};
 vm.createContext(context);vm.runInContext(wrappers,context);
 const env={...process.env,AOS_CHROME_COMPANION_DATA_DIR:scratch,AOS_CHROME_COMPANION_SOCKET:join(scratch,'broker.sock'),AOS_CHROME_COMPANION_SECRET_FILE:join(scratch,'secret'),AOS_CHROME_COMPANION_CODEX_MCP_ISSUER_SECRET_FILE:join(scratch,'issuer')};
 const secret=await ensureBrokerSecret(env),issuer=await ensureIssuerSecret('codex_mcp',env);
 broker=new CompanionBroker({socketPath:env.AOS_CHROME_COMPANION_SOCKET,secret,statePath:join(scratch,'ledger.json'),issuerSecrets:{codex_mcp:issuer}});await broker.listen();
 relay=await connectPeer({role:'extension-relay',autoStart:false,env});const ack=new Promise(ok=>{const off=relay.onMessage(m=>{if(m.kind==='extension.hello_ack'){off();ok(m);}});});
 relay.send({kind:'extension.hello',protocolVersion:PROTOCOL_VERSION,profileInstanceId:'dialog-fixture-profile',extensionRuntimeId:'dialog-fixture-runtime',buildId:INSTALL_BUILD_ID,capabilities:DEFAULT_CAPABILITIES});await ack;
 relay.onMessage(message=>{
   if(message.kind==='session.closed'){void dialogs.stopForSession(message.sessionId,message.generation);return;}
   if(message.kind!=='command.request')return;
   const execute=async()=>{
     const {method,params={}}=message;commands.push({method,tabId:params.tabId??null,modalOpen:dialogs.records.get(1)?.current!==null&&!!dialogs.records.get(1),at:new Date().toISOString()});
     if(method==='tabs.list')return currentTab?[currentTab]:[];
     if(method==='tabs.create'){assert.equal(currentTab,null);await call('Page.navigate',{url:params.url});await until(()=>evaluate('document.readyState==="complete" && !!document.querySelector("#retained")'),'fixture did not load');currentTab={id:1,windowId:1,url:params.url,title:'Companion dialog verification',groupId:null,active:false,pinned:false};return currentTab;}
     if(method==='tabs.groupTask'){currentTab.groupId=17;return {...currentTab};}
     if(method==='tabs.close'){await dialogs.tabRemoved(1);currentTab=null;return {closed:true,tabId:1};}
     if(method==='page.snapshot')return snapshot();
     if(method==='page.query'){const r=await evaluate(`(${injected})('query',${JSON.stringify(params)})`);if(r.__aosCompanionError)throw Object.assign(Error(r.__aosCompanionError.message),r.__aosCompanionError);return r;}
     if(['page.click','page.type','visual.inspectTarget'].includes(method)){
       const action=method==='visual.inspectTarget'?'inspectVisualTarget':method.slice(5);
       const r=await evaluate(`(${injected})(${JSON.stringify(action)},${JSON.stringify({...params,companionContext:{taskId:message.taskId,taskLabel:message.taskLabel}})})`);
       if(r.__aosCompanionError)throw Object.assign(Error(r.__aosCompanionError.message),r.__aosCompanionError);return r;
     }
     if(method==='page.screenshot'){const image=await call('Page.captureScreenshot',{format:'png'});return {kind:'screenshot',mimeType:'image/png',dataBase64:image.data,tabId:1,url:currentTab.url,capturedAt:new Date().toISOString()};}
     const trusted={...params,taskId:message.taskId,sessionId:message.sessionId,generation:message.generation,allowedOrigins:message.allowedOrigins,targetOrigin:message.targetOrigin};
     if(method==='page.inspectDialog')return context.inspectJavaScriptDialog(1,trusted);
     if(method==='page.handleDialog')return context.handleJavaScriptDialog(1,trusted);
     throw Error('Unimplemented fixture adapter '+method);
   };
   const trusted={...message.params,operationId:message.operationId,taskId:message.taskId,sessionId:message.sessionId,generation:message.generation};
   void executeWithExpectedDialog({method:message.method,params:trusted,dialogs,prepare:async()=>assert.equal(new URL(currentTab.url).origin,origin),
     execute,emit:event=>relay.send({kind:'command.event',operationId:message.operationId,event})})
     .then(result=>relay.send({kind:'command.result',operationId:message.operationId,result}),error=>relay.send({kind:'command.error',operationId:message.operationId,error:{code:error.code??'fixture_adapter_error',message:error.message,details:error.details}}));
 });
 client=await BrokerClient.connect({autoStart:false,env,issuer:'codex_mcp'});session=await client.request('session.open',{taskId:'dialog-fixture-owner',label:'Dialog canary'});
 const base={sessionId:session.sessionId,taskId:session.taskId,targetOrigin:origin,allowedOrigins:[origin],startUrl:origin+'/',keepTaskTab:true};
 if(!triggerEvents){
   const prepared=await client.requestAuthorizedTransaction({...base,runId:'prepare',idempotencyKey:'prepare',actions:[{method:'page.query',params:{query:'Ready'}}]});assert.equal(prepared.result,'verified');
   const lease=await client.request('lease.acquire',{sessionId:session.sessionId,tabId:1});
   const observing=await client.request('operation.execute',{sessionId:session.sessionId,leaseId:lease.leaseId,method:'page.inspectDialog',params:{tabId:1}});assert.equal(observing.observing,true);assert.equal(observing.present,false);await client.request('lease.release',{leaseId:lease.leaseId});
 }
 if(triggerEvents){
   receipt.coverage+=' This mode also executes the production pre-armed event wrapper and command.event path with signed multi-action transactions, exact dialog continuation and original-result reconciliation; the injected semantic operation uses an owned CDP adapter.';
   for(const type of ['alert','confirm','prompt']){
     const runId='trigger-event-'+type,at=commands.length,started=Date.now();
     const startedWithoutTab=currentTab===null;
     const beforeText=startedWithoutTab?'未保存の本文 👩🏽‍💻':await evaluate('document.querySelector("#retained").value');
     const pendingResult=await client.requestAuthorizedTransaction({...base,...(currentTab?{tabId:1}:{}),runId,idempotencyKey:runId,actions:[
       {method:'page.click',params:{locator:{testId:'trigger-'+type},expectEvent:{type:'dialog',timeoutMs:2000}}},
       {method:'page.type',params:{locator:{css:'#retained'},text:beforeText+' 続行',clear:true}},
     ]});
     assert.equal(pendingResult.exact_blocker?.code,'action_event_pending',JSON.stringify(pendingResult));
     assert.equal(pendingResult.action_event.type,type);assert.equal(pendingResult.cleanup.retained,true);
     assert.deepEqual(pendingResult.action_progress.uncertain_action_indices,[0]);assert.deepEqual(pendingResult.action_progress.remaining_action_indices,[1]);
     assert.equal(commands.slice(at).filter(c=>c.method==='page.type').length,0);
     assert.equal(commands.slice(at).filter(c=>c.method==='page.snapshot'&&c.modalOpen).length,0);
     const opening=pendingResult.action_event;
     const handled=await client.requestAuthorizedTransaction({...base,tabId:1,runId,idempotencyKey:runId+'-response',actions:[{method:'page.handleDialog',params:{
       expectedMessage:opening.message,expectedDialogId:opening.dialogId,expectedType:type,accept:type!=='confirm',...(type==='prompt'?{promptText:'日本語の応答 👩🏽‍💻'}:{}),
     }}]});
     assert.equal(handled.result,'verified',JSON.stringify(handled));assert.equal(handled.actions[0].result.closedVerified,true);
     assert.equal(handled.trigger_continuation?.state,'readback_verified',JSON.stringify(handled.trigger_continuation));
     assert.deepEqual(handled.trigger_continuation.action_progress.remaining_action_indices,[1]);
     assert.deepEqual(handled.trigger_continuation.action_progress.uncertain_action_indices,[]);
     assert.equal(await evaluate('document.querySelector("#retained").value'),beforeText);
     const resumed=await client.requestPrepareResume({sessionId:session.sessionId,taskId:session.taskId,runId,idempotencyKey:runId,capsuleId:pendingResult.capsule.capsuleId});
     assert.deepEqual(resumed.action_progress.remaining_action_indices,[1]);assert.deepEqual(resumed.action_progress.uncertain_action_indices,[]);
     const continued=await client.requestAuthorizedTransaction({...base,tabId:1,runId,idempotencyKey:runId+'-remaining',actions:[
       {method:'page.type',params:{locator:{css:'#retained'},text:beforeText+' 続行',clear:true}},
     ]});
     assert.equal(continued.result,'verified',JSON.stringify(continued));assert.equal(await evaluate('document.querySelector("#retained").value'),beforeText+' 続行');
     const used=commands.slice(at);assert.equal(used.filter(c=>c.method==='page.click').length,1);assert.equal(used.filter(c=>c.method==='page.type').length,1);
     assert.equal(used.filter(c=>c.method==='tabs.create').length,startedWithoutTab?1:0);
     receipt.cases.push({name:'Pre-armed '+type+' -> exact signed response -> original receipt -> remaining input',passed:true,elapsedMs:Date.now()-started,
       startedWithoutTab,tabCreates:used.filter(c=>c.method==='tabs.create').length,
       clickDispatches:1,remainingInputDispatches:1,domReadsWhileModal:used.filter(c=>c.method==='page.snapshot'&&c.modalOpen).length,
       pendingResult,handled,resumed,continued});
   }
   await evaluate('document.querySelector("#results").textContent='+JSON.stringify('PASS: pre-armed alert / confirm / prompt\nOriginal trigger dispatched once; no modal DOM read\nExact signed response, authentic original result\nOnly the remaining input runs; Japanese text retained'));
 } else if(triggerBaseline){
   const owned=await client.request('lease.acquire',{sessionId:session.sessionId,tabId:1});
   const signed=(method,id,params,timeoutMs=5000)=>client.request('operation.execute',{sessionId:session.sessionId,leaseId:owned.leaseId,method,params,timeoutMs,
     authority:createAuthorityEnvelope({issuer:'codex_mcp',secret:issuer,runId:'prepare',taskId:session.taskId,ownerKey:session.sessionId,
       method,intent:method,targetOrigin:origin,idempotencyKey:id,payload:params,approved:true}),taskOwnedRequired:true});
   for(const type of ['alert','confirm','prompt']){
     const id='trigger-baseline-'+type,started=Date.now(),before=commands.length;
     const click=signed('page.click',id,{tabId:1,locator:{testId:'trigger-'+type},allowedOrigins:[origin],targetOrigin:origin},1500).then(value=>({value}),error=>({error}));
     await until(()=>dialogs.records.get(1)?.current?.type===type,'click did not open '+type);
     let inspectSettled=false;
     const inspection=client.request('operation.execute',{sessionId:session.sessionId,leaseId:owned.leaseId,method:'page.inspectDialog',params:{tabId:1}}).then(value=>{inspectSettled=true;return value;});
     await delay(150);const inspectionReturnedDuringClick=inspectSettled;
     const outcome=await click;
     const observed=await inspection;assert.equal(observed.present,true);assert.equal(observed.type,type);
     const dom=await client.request('operation.execute',{sessionId:session.sessionId,leaseId:owned.leaseId,method:'page.snapshot',params:{tabId:1},timeoutMs:200})
       .then(value=>({value}),error=>({error:{code:error.code,message:error.message}}));
     const handled=await signed('page.handleDialog',id+'-response',{tabId:1,expectedMessage:'Triggered '+type,expectedDialogId:observed.dialogId,
       pageInstanceId:observed.pageInstanceId,expectedType:type,accept:type==='alert',allowedOrigins:[origin],targetOrigin:origin});
     assert.equal(handled.closedVerified,true);
     await until(()=>['applied','reconciled'].includes(broker.taskLedger.get(id)?.state),'the original click must settle from its authentic result without replay');
     assert.equal(commands.slice(before).filter(command=>command.method==='page.click').length,1);
     assert.equal(await evaluate('document.querySelector("#retained").value'),'未保存の本文 👩🏽‍💻');
     receipt.cases.push({name:'Click-triggered '+type,inspectionReturnedDuringClick,clickOutcome:outcome.error?{code:outcome.error.code,message:outcome.error.message}:outcome.value,
       domOutcome:dom.error??{returned:true},clickDispatches:1,finalOperationState:broker.taskLedger.get(id)?.state,elapsedMs:Date.now()-started});
   }
   await client.request('lease.release',{leaseId:owned.leaseId});
   await evaluate('document.querySelector("#results").textContent='+JSON.stringify('DIAGNOSTIC: click-triggered alert / confirm / prompt\nSeparate click result, dialog observation and DOM read\nInput retained; original click never replayed'));
 } else {
 let serial=0;
 const respond=async(spec)=>{
   const opening=dialogs.records.get(1).current;assert.ok(opening,'missing observed Chrome dialog');const start=commands.length;
   const params={expectedMessage:spec.message,expectedDialogId:opening.id,expectedType:spec.type,accept:spec.accept,...(Object.hasOwn(spec,'promptText')?{promptText:spec.promptText}:{})};
   const result=await client.requestAuthorizedTransaction({...base,tabId:1,runId:'response-'+(++serial),idempotencyKey:'response-'+serial,actions:[{method:'page.handleDialog',params}]});
   const used=commands.slice(start);assert.equal(used.filter(c=>c.method==='page.handleDialog').length,1);assert.equal(used.filter(c=>c.method==='page.snapshot'&&c.modalOpen).length,0);
   assert.equal(result.result,'verified',JSON.stringify({result:result.result,error:result.exact_blocker}));assert.equal(result.actions[0].result.closedVerified,true);
   return {result,used};
 };
 const specifications=[
   {name:'Japanese prompt',type:'prompt',message:'Label',accept:true,promptText:'日本語 👩🏽‍💻',expected:'日本語 👩🏽‍💻'},
   {name:'Explicit empty prompt',type:'prompt',message:'Blank label',accept:true,promptText:'',expected:''},
   {name:'Cancel prompt',type:'prompt',message:'Cancel label',accept:false,expected:null},
   {name:'Already-open alert',type:'alert',message:'Notice',accept:true,expected:'alert closed'},
   {name:'Accept confirm',type:'confirm',message:'Confirm one',accept:true,expected:true},
   {name:'Cancel confirm',type:'confirm',message:'Confirm two',accept:false,expected:false},
 ];
 for(const spec of specifications){
   await evaluate('setTimeout(()=>window.showFixtureDialog('+JSON.stringify(spec)+'),50)');await until(()=>dialogs.records.get(1)?.current,'dialog did not open');
   await delay(100);const handled=await respond(spec);const actual=await evaluate('window.dialogResults.at(-1)');assert.deepEqual(actual,spec.expected);assert.equal(await evaluate('document.querySelector("#retained").value'),'未保存の本文 👩🏽‍💻');
   receipt.cases.push({name:spec.name,passed:true,closedVerified:handled.result.actions[0].result.closedVerified,domReadsWhileModal:0,commands:handled.used.map(c=>c.method)});
 }
 const chain={type:'confirm',message:'Continue to prompt',chain:true,accept:true};await evaluate('setTimeout(()=>window.showFixtureDialog('+JSON.stringify(chain)+'),50)');await until(()=>dialogs.records.get(1)?.current,'chain did not open');
 const first=await respond(chain);assert.equal(first.result.continuation_required,true);assert.equal(first.result.visual_readback.screenshotAvailable,false);assert.equal(first.result.cleanup.retained,true);
 const next=await respond({type:'prompt',message:'Next question',accept:false});assert.equal(next.result.actions[0].result.closedVerified,true);
 receipt.cases.push({name:'Follow-on dialog is retained with distinct identity, then handled in a fresh signed transaction',passed:true});
 // Real sticky activation precedes beforeunload. Its message is browser-owned
 // and CDP intentionally exposes the empty string instead of website copy.
 await call('Input.dispatchMouseEvent',{type:'mousePressed',x:600,y:180,button:'left',clickCount:1});await call('Input.dispatchMouseEvent',{type:'mouseReleased',x:600,y:180,button:'left',clickCount:1});
 await evaluate('window.onbeforeunload=event=>{event.preventDefault();event.returnValue=""}');
 const navigation=call('Page.navigate',{url:origin+'/next'}).then(value=>({value}),error=>({error:error.message}));
 await until(()=>dialogs.records.get(1)?.current?.type==='beforeunload','beforeunload not observed');
 const cancelled=await respond({type:'beforeunload',message:'',accept:false});await navigation;assert.equal(cancelled.result.actions[0].result.closedVerified,true);assert.equal(await evaluate('document.querySelector("#retained").value'),'未保存の本文 👩🏽‍💻');
 await evaluate('window.onbeforeunload=null');receipt.cases.push({name:'Already-open beforeunload cancellation preserves the current page and unsaved input',passed:true});
 await evaluate('document.querySelector("#results").textContent='+JSON.stringify('PASS '+receipt.cases.length+' scenarios\nJapanese / empty / cancelled prompts\nAlert / confirm / chained dialogs / beforeunload\nExact opening + signed response + closed event\nUnsaved input preserved; no DOM read while a modal is open'));
 }
 const finalImage=await call('Page.captureScreenshot',{format:'png'});receipt.image=join(out,'verified.png');await writeFile(receipt.image,Buffer.from(finalImage.data,'base64'));
 receipt.result=triggerBaseline?'diagnostic_complete':'passed';receipt.commands=commands;receipt.cdpMethods=cdpCalls.map(c=>c.method);
}catch(error){receipt.result='failed';receipt.error={message:error.message,code:error.code??null};receipt.chromeStderr=stderr;receipt.commands=commands;process.exitCode=1;}
finally{
 if(dialogs)await dialogs.stopAll('test_finished');
 if(client&&session)try{await client.request('session.close',{sessionId:session.sessionId});}catch{}
 client?.close();relay?.close();if(broker)await broker.close();socket?.close();for(const p of pending.values()){clearTimeout(p.timer);p.no(Error('test ended'));}pending.clear();
 chrome.kill('SIGTERM');if(chrome.exitCode===null&&chrome.signalCode===null)await Promise.race([new Promise(ok=>chrome.once('exit',ok)),delay(3000)]);if(chrome.exitCode===null&&chrome.signalCode===null){chrome.kill('SIGKILL');await new Promise(ok=>chrome.once('exit',ok));}
 receipt.testChromeClosed=chrome.exitCode!==null||chrome.signalCode!==null;await new Promise(ok=>server.close(ok));if(receipt.testChromeClosed)await rm(scratch,{recursive:true,force:true});
 receipt.finishedAt=new Date().toISOString();await writeFile(join(out,'receipt.json'),JSON.stringify(receipt,null,2));console.log(JSON.stringify({result:receipt.result,cases:receipt.cases.map(c=>({name:c.name,passed:c.passed})),record:join(out,'receipt.json'),image:receipt.image,testChromeClosed:receipt.testChromeClosed,error:receipt.error}));
}
