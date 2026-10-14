#!/usr/bin/env node
// A fresh headless Chrome uses Chromium's platform-independent clipboard.
// This fixture never loads the native-host extension or reads the OS clipboard.
import assert from 'node:assert/strict';
import {spawn} from 'node:child_process';
import {createHash} from 'node:crypto';
import {createServer} from 'node:http';
import {readFile,writeFile,mkdir,mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {resolve,join} from 'node:path';
import vm from 'node:vm';
import {MAX_CLIPBOARD_BINARY_BYTES} from '../src/shared/peripheral-policy.mjs';
import {encodeNativeCommand} from '../src/shared/native-command-transfer.mjs';
import {NativeMessageDecoder} from '../src/shared/framing.mjs';
import {NativeCommandAssembler} from '../extension/native-command-transfer.js';
import {materializeTransactionActions} from '../src/mcp/action-materializer.mjs';
import {createUserControls} from '../extension/user-controls.js';
import {executeWithExpectedDialog} from '../extension/action-event-wait.js';
import {DebuggerSessionPool} from '../extension/page-observation.js';
import {MUTATION_METHODS} from '../extension/operation-schema.generated.js';
import {mergeSemanticSnapshotResults} from '../extension/semantic-snapshot.js';
import {checkFrameOrigin} from '../extension/frame-origin.js';

const out=resolve(process.argv[2]??'../clipboard-dom-wave17',new Date().toISOString().replaceAll(':','-'));await mkdir(out,{recursive:true});
const scratch=await mkdtemp(join(tmpdir(),'aos-clipboard-dom-')),profile=join(scratch,'profile');await mkdir(profile);
const source=await readFile(new URL('../extension/service-worker.js',import.meta.url),'utf8');
function workerSection(start,end){const a=source.indexOf(start),b=source.indexOf(end,a);assert.ok(a>=0&&b>a,'Production worker section missing: '+start);return source.slice(a,b);}
const worker=[
  workerSection('function timeoutError(','async function waitForScreenshotSlot('),
  workerSection('function companionError(','function requireSafeUrl('),
  workerSection('function originOf(','async function probeCommittedDocument('),
  workerSection('function requireVisualPoint(','async function startCompanionTabRecording('),
  workerSection('async function runClipboardOperation(','async function runBinaryClipboardOperation('),
  workerSection('async function sendDebuggerCommand(','function sameVisualTargetState('),
  workerSection('async function executeCommand(','async function waitForPageLocator('),
  workerSection('async function runAndCheckMutation(','chrome.runtime.onMessage.addListener('),
].join('\n');
const offscreen=await readFile(new URL('../extension/offscreen.js',import.meta.url),'utf8');
const policy=await readFile(new URL('../extension/peripheral-policy.generated.js',import.meta.url),'utf8');
const html=`<!doctype html><meta charset="utf-8"><title>Companion clipboard verification</title><style>body{font:21px system-ui;padding:35px;background:#f5f8fd;color:#123456}textarea,#editor{display:block;padding:16px;width:95%;min-height:65px;border:2px solid #789;background:white}pre{font:18px system-ui;white-space:pre-wrap}img{image-rendering:pixelated;width:128px;height:128px}</style><h1>Companion clipboard verification</h1><p>Isolated Chrome clipboard · actual paste events</p><textarea id="plain"></textarea><div id="editor" contenteditable="true" aria-label="Rich text paste"></div><pre id="range-result"></pre><pre id="results">Ready</pre><script>
globalThis.pastes=[];globalThis.pageScriptExecuted=false;
document.addEventListener('paste',event=>{const data=event.clipboardData,record={trusted:event.isTrusted,types:[...data.types],text:data.getData('text/plain'),html:data.getData('text/html'),files:[]};pastes.push(record);for(const file of data.files){(async()=>{const bitmap=await createImageBitmap(file),canvas=document.createElement('canvas');canvas.width=bitmap.width;canvas.height=bitmap.height;const ctx=canvas.getContext('2d');ctx.drawImage(bitmap,0,0);const pixels=ctx.getImageData(0,0,canvas.width,canvas.height).data;record.files.push({type:file.type,bytes:file.size,width:canvas.width,height:canvas.height,pixelSha256:[...new Uint8Array(await crypto.subtle.digest('SHA-256',pixels))].map(v=>v.toString(16).padStart(2,'0')).join('')});bitmap.close();})().catch(e=>record.error=e.message);}});
</script>`;
const server=createServer((req,res)=>{res.writeHead(200,{'content-type':'text/html; charset=utf-8','cache-control':'no-store'});res.end(html);});await new Promise(ok=>server.listen(0,'127.0.0.1',ok));const origin='http://127.0.0.1:'+server.address().port;
const chrome=spawn('/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',['--headless=new','--remote-debugging-port=0','--user-data-dir='+profile,'--no-first-run','--no-default-browser-check','--disable-background-networking','--disable-component-update','--disable-sync','--window-size=1200,1000','about:blank'],{stdio:['ignore','ignore','pipe']});
let stderr='',socket,nextId=0;chrome.stderr.on('data',data=>{stderr=(stderr+data).slice(-10000);});const pending=new Map(),delay=ms=>new Promise(ok=>setTimeout(ok,ms));
const receipt={startedAt:new Date().toISOString(),chromePid:chrome.pid,sourceDigest:createHash('sha256').update(source).digest('hex'),offscreenDigest:createHash('sha256').update(offscreen).digest('hex'),
  coverage:'Production native framing/assembly/dispatcher, user controls with isolated storage, clipboard/offscreen implementation, page.selectText and trustedVisualKeyMetadata/runTrustedVisualInput through production executeCommand. Chrome API adapters target only a fresh headless Chrome and local synthetic DOM; clipboard is Chromium headless clipboard. Installed-extension permission grants, broker signed visual-proof validation and real window focus remain separate checks. No OS clipboard or provider draft is read or written.',cases:[]};
function call(method,params={}){return new Promise((ok,no)=>{const id=++nextId,timer=setTimeout(()=>{pending.delete(id);no(Error('CDP timeout '+method));},15000);pending.set(id,{ok,no,timer});socket.send(JSON.stringify({id,method,params}));});}
try{
  let port;for(let i=0;i<1200;i++){try{port=Number((await readFile(join(profile,'DevToolsActivePort'),'utf8')).split('\n')[0]);break;}catch{if(chrome.exitCode!==null)throw Error('test Chrome exited');await delay(100);}}assert.ok(port);
  const pages=await(await fetch('http://127.0.0.1:'+port+'/json/list')).json();socket=new WebSocket(pages.find(p=>p.type==='page').webSocketDebuggerUrl);await new Promise((ok,no)=>{socket.addEventListener('open',ok,{once:true});socket.addEventListener('error',no,{once:true});});
  socket.addEventListener('message',event=>{const m=JSON.parse(event.data);if(m.method)return;const p=pending.get(m.id);if(!p)return;pending.delete(m.id);clearTimeout(p.timer);m.error?p.no(Error(JSON.stringify(m.error))):p.ok(m.result);});
  receipt.browser=await call('Browser.getVersion');await call('Browser.grantPermissions',{origin,permissions:['clipboardReadWrite','clipboardSanitizedWrite']});await call('Page.navigate',{url:origin+'/'});await call('Page.bringToFront');
  const evaluate=async (expression,contextId)=>{const r=await call('Runtime.evaluate',{expression,...(contextId?{contextId}:{}),returnByValue:true,awaitPromise:true,userGesture:true});if(r.exceptionDetails)throw Error(JSON.stringify(r.exceptionDetails));return r.result.value;};
  for(let i=0;i<100;i++){if(await evaluate('document.readyState==="complete" && !!document.querySelector("#editor")'))break;await delay(50);}
  const runtimeScript=policy.replaceAll('export const ','const ')+'\nglobalThis.chrome={runtime:{id:"fixture-extension",onMessage:{addListener:fn=>{globalThis.offscreenListener=fn;}}}};\n'+offscreen.replace(/^import[\s\S]*?from "\.\/peripheral-policy\.generated\.js";\n/u,'')+'\nglobalThis.clipboardWriteCalls=0;const nativeWrite=navigator.clipboard.write.bind(navigator.clipboard);navigator.clipboard.write=async items=>{clipboardWriteCalls++;return nativeWrite(items);};';
  await evaluate(runtimeScript);
  const {frameTree:{frame}}=await call('Page.getFrameTree');
  const {executionContextId}=await call('Page.createIsolatedWorld',{frameId:frame.id,worldName:'companion-canary'});
  const tabId=101,windowId=1,storage={physicalInputEnabled:true},debuggerCommands=[];
  const fixturePermissions=new Set(['debugger','clipboardRead','clipboardWrite']);
  const requireFixtureTab=id=>assert.equal(id,tabId,'Adapter must target the isolated fixture tab');
  const fixtureTab=async()=>({id:tabId,windowId,url:await evaluate('location.href'),title:'Companion clipboard verification',active:true,status:'complete'});
  const chromeApi={
    storage:{local:{get:async key=>({[key]:structuredClone(storage[key])}),set:async values=>Object.assign(storage,structuredClone(values))}},
    permissions:{contains:async ({permissions})=>permissions.every(permission=>fixturePermissions.has(permission))},
    runtime:{id:'fixture-extension',getPlatformInfo:async()=>({os:process.platform==='darwin'?'mac':process.platform==='win32'?'win':'linux'}),
      sendMessage:message=>evaluate('new Promise(resolve=>offscreenListener('+JSON.stringify(message)+',{id:"fixture-extension"},resolve))')},
    offscreen:{hasDocument:async()=>await evaluate('typeof offscreenListener === "function"'),createDocument:async()=>{throw Error('Fixture offscreen bridge was not initialized');}},
    tabs:{get:async id=>{requireFixtureTab(id);return fixtureTab();},query:async()=>[await fixtureTab()],
      update:async(id,values)=>{requireFixtureTab(id);assert.deepEqual(JSON.parse(JSON.stringify(values)),{active:true});await call('Page.bringToFront');return fixtureTab();}},
    windows:{update:async(id,values)=>{assert.equal(id,windowId);assert.deepEqual(JSON.parse(JSON.stringify(values)),{focused:true});await call('Page.bringToFront');},getLastFocused:async()=>({id:windowId})},
    debugger:{attach:async target=>{requireFixtureTab(target.tabId);await call('Page.enable');},detach:async target=>{requireFixtureTab(target.tabId);await call('Page.disable');},
      sendCommand:async(target,method,params)=>{requireFixtureTab(target.tabId);debuggerCommands.push({method,params:JSON.parse(JSON.stringify(params))});return call(method,params);}},
    scripting:{executeScript:async request=>{requireFixtureTab(request.target.tabId);assert.equal(request.world,'ISOLATED');
      const result=await evaluate('('+request.func.toString()+')(...'+JSON.stringify(request.args)+')',executionContextId);
      return [{frameId:0,documentId:frame.loaderId,result}];}},
  };
  const userControls=createUserControls(chromeApi);
  const context={performance,URL,atob,setTimeout,clearTimeout,MAX_CLIPBOARD_BINARY_BYTES,MUTATION_METHODS,
    READ_API_TIMEOUT_MS:10000,PAGE_MUTATION_EXECUTION_TIMEOUT_MS:30000,PHYSICAL_INPUT_ENABLED_KEY:'physicalInputEnabled',
    executeWithExpectedDialog,javaScriptDialogs:null,userControls,mergeSemanticSnapshotResults,checkFrameOrigin,
    chrome:chromeApi,debuggerSessions:new DebuggerSessionPool(chromeApi.debugger)};
  vm.createContext(context);vm.runInContext(worker,context);
  const format=(mimeType,text)=>({mimeType,dataBase64:Buffer.from(text).toString('base64')});
  const transferReplies=[],transferErrors=[];let nextOperation=0;
  context.runtimeState={port:{},profileInstanceId:'clipboard-profile',generation:'clipboard-generation'};context.commandAssembler=new NativeCommandAssembler();
  context.postNativeMessage=message=>transferReplies.push(message);context.sendCommandError=(id,code,message,details)=>transferErrors.push(Object.assign(Error(message),{code,details}));
  vm.runInContext(source.slice(source.indexOf('async function handleNativeMessage('),source.indexOf('\nfunction sendCommandError(')),context);
  const command=async(method,params)=>{
    const priorReplies=transferReplies.length,priorErrors=transferErrors.length;
    const [action]=await materializeTransactionActions([{method,params:{tabId,...params}}]);
    const request={kind:'command.request',operationId:'clipboard-'+(++nextOperation),profileInstanceId:'clipboard-profile',generation:'clipboard-generation',taskId:'clipboard-fixture',targetOrigin:origin,allowedOrigins:[origin],...action};
    const frames=[...encodeNativeCommand(request)],decoder=new NativeMessageDecoder();
    for(const frame of frames){assert.ok(frame.readUInt32LE(0)<=1048576);for(const message of decoder.push(frame))await context.handleNativeMessage(message);}
    if(transferErrors.length>priorErrors)throw transferErrors.at(-1);
    assert.equal(transferReplies.length,priorReplies+1);receipt.maxNativeFramesPerWrite=Math.max(receipt.maxNativeFramesPerWrite??0,frames.length);return transferReplies.at(-1).result;
  };
  const write=formats=>command('clipboard.write',{formats,approved:true});
  const shortcut=async key=>{
    const point=await evaluate('(()=>{const r=document.activeElement.getBoundingClientRect();return {x:r.x+20,y:r.y+20};})()');
    const before=debuggerCommands.length;
    const result=await command('visual.pressKey',{tabId,point,key,modifiers:[process.platform==='darwin'?'meta':'ctrl'],allowShortcut:true,clickBeforeKey:false});
    assert.equal(result.trustedInput,true);assert.equal(result.osCursorMoved,false);
    const dispatched=debuggerCommands.slice(before);assert.equal(dispatched.length,2);
    assert.equal(dispatched[0].method,'Input.dispatchKeyEvent');assert.equal(dispatched[1].params.commands,undefined);
    assert.ok(!('nativeVirtualKeyCode' in dispatched[0].params));
    receipt.shortcuts??=[];receipt.shortcuts.push({key,result,dispatch:dispatched});return result;
  };
  async function paste(selector){
    const count=await evaluate('pastes.length');await evaluate('document.querySelector('+JSON.stringify(selector)+').focus()');
    await shortcut('a');await shortcut('v');
    for(let i=0;i<100;i++){if(await evaluate('pastes.length>'+count))return;await delay(50);}throw Error('No trusted paste event');
  }
  const japanese='日本語の貼り付け\n改行と 👩🏽‍💻';const textReceipt=await write([format('text/plain',japanese)]);await paste('#plain');assert.equal(await evaluate('document.querySelector("#plain").value'),japanese);assert.equal(await evaluate('pastes.at(-1).trusted'),true);assert.equal(textReceipt.pasteVerified,false);receipt.cases.push({name:'Japanese, emoji and newlines -> trusted plain-text paste',passed:true});
  const original='残す前 日本語👩🏽‍💻置換対象 残す後',selected='日本語👩🏽‍💻置換対象',replacement='安全な貼り付け✨';
  await evaluate('document.querySelector("#editor").textContent='+JSON.stringify(original));
  const selection=await command('page.selectText',{tabId,locator:{css:'#editor'},text:selected});
  assert.equal(selection.selectionCommitted,true);assert.equal(selection.contentPreserved,true);
  assert.equal(await evaluate('String(getSelection())'),selected);
  assert.equal(await evaluate('document.querySelector("#editor").textContent'),original);
  await evaluate('globalThis.copies=[];document.addEventListener("copy",event=>copies.push({trusted:event.isTrusted,selected:String(getSelection())}))');
  await shortcut('c');assert.equal(await evaluate('navigator.clipboard.readText()'),selected);
  assert.equal(await evaluate('copies.at(-1).trusted'),true);
  await write([format('text/plain',replacement)]);assert.equal(await evaluate('String(getSelection())'),selected);
  await shortcut('v');
  const rangeReadback=await evaluate('({text:document.querySelector("#editor").textContent,trusted:pastes.at(-1).trusted,pasted:pastes.at(-1).text})');
  assert.equal(rangeReadback.text,original.replace(selected,replacement));assert.equal(rangeReadback.trusted,true);assert.equal(rangeReadback.pasted,replacement);
  await evaluate('document.querySelector("#range-result").textContent='+JSON.stringify('Verified selected-range final text: '+rangeReadback.text));
  receipt.cases.push({name:'Production page.selectText + trusted copy + paste replaces only selected UTF-16 range',passed:true,selection,readback:rangeReadback});
  for(const [control,code] of [[{kind:'controls.pause',paused:true},'companion_user_paused'],[{kind:'controls.site',origin,blocked:true},'companion_site_blocked']]){
    await userControls.handle(control,{id:chromeApi.runtime.id});
    const before={writes:await evaluate('clipboardWriteCalls'),dispatch:debuggerCommands.length,text:await evaluate('document.querySelector("#editor").textContent')};
    for(const [method,params] of [['clipboard.write',{formats:[format('text/plain','must not write')],approved:true}],['visual.pressKey',{tabId,point:{x:50,y:50},key:'v',modifiers:['meta'],allowShortcut:true,clickBeforeKey:false}],['page.selectText',{tabId,locator:{css:'#editor'},text:replacement}]]){
      await assert.rejects(command(method,params),error=>error.code===code&&error.details.mutationDispatchAttempted===false&&error.details.operationEffectState==='none');
    }
    assert.equal(await evaluate('clipboardWriteCalls'),before.writes);assert.equal(debuggerCommands.length,before.dispatch);
    assert.equal(await evaluate('document.querySelector("#editor").textContent'),before.text);
    const saved=storage.companionUserControlsV1;assert.ok(saved);assert.equal(control.kind==='controls.pause'?saved.paused:saved.blockedOrigins.includes(origin),true);
    receipt.cases.push({name:code+' -> production controls reject write, selection and shortcut before dispatch',passed:true});
    await userControls.handle(control.kind==='controls.pause'?{kind:control.kind,paused:false}:{kind:control.kind,origin,blocked:false},{id:chromeApi.runtime.id});
  }
  const rich='<h2>見出し</h2><p><strong>太字</strong>と<a href="'+origin+'/reference">リンク</a></p><script>globalThis.pageScriptExecuted=true<'+ '/script>';
  await write([format('text/html',rich),format('text/plain','見出し\n太字とリンク')]);await paste('#editor');
  const richRead=await evaluate('({html:document.querySelector("#editor").innerHTML,heading:!!document.querySelector("#editor h2"),strong:!!document.querySelector("#editor strong, #editor b"),link:document.querySelector("#editor a")?.href,text:document.querySelector("#editor").innerText,scriptExecuted:pageScriptExecuted,trusted:pastes.at(-1).trusted,types:pastes.at(-1).types})');
  assert.equal(richRead.heading,true);assert.equal(richRead.strong,true);assert.equal(richRead.link,origin+'/reference');assert.equal(richRead.scriptExecuted,false);assert.equal(richRead.trusted,true);assert.ok(!richRead.html.includes('<script'));receipt.cases.push({name:'HTML + plain fallback -> heading, bold and link paste; script inert',passed:true,readback:richRead});
  const png=await evaluate('(async()=>{const c=document.createElement("canvas");c.width=32;c.height=32;const x=c.getContext("2d");x.fillStyle="#2463b5";x.fillRect(0,0,32,32);x.fillStyle="#ffce45";x.fillRect(8,8,16,16);const pixels=x.getImageData(0,0,32,32).data;return {dataBase64:c.toDataURL("image/png").split(",")[1],pixelSha256:[...new Uint8Array(await crypto.subtle.digest("SHA-256",pixels))].map(v=>v.toString(16).padStart(2,"0")).join("")};})()');
  const pngPath=join(scratch,'local-image.png');await writeFile(pngPath,Buffer.from(png.dataBase64,'base64'));
  const pngReceipt=await write([{mimeType:'image/png',filePath:pngPath}]);await paste('#editor');let pasted;
  for(let i=0;i<100;i++){pasted=await evaluate('pastes.at(-1)');if(pasted.files.length)break;await delay(50);}assert.equal(pasted.trusted,true);assert.equal(pasted.files.length,1);assert.equal(pasted.files[0].type,'image/png');assert.equal(pasted.files[0].pixelSha256,png.pixelSha256);assert.equal(await evaluate('document.querySelectorAll("#editor img").length'),1);receipt.cases.push({name:'PNG -> actual image paste with identical decoded pixels',passed:true,inputBytes:pngReceipt.size,pastedFile:pasted.files[0]});
  const limit=Buffer.alloc(MAX_CLIPBOARD_BINARY_BYTES,65),limitPath=join(scratch,'limit.txt');await writeFile(limitPath,limit);await write([{mimeType:'text/plain',filePath:limitPath}]);const limitRead=await evaluate('(async()=>{const text=await navigator.clipboard.readText();return {bytes:new TextEncoder().encode(text).length,sha256:[...new Uint8Array(await crypto.subtle.digest("SHA-256",new TextEncoder().encode(text)))].map(v=>v.toString(16).padStart(2,"0")).join("")};})()');assert.equal(limitRead.bytes,limit.length);assert.equal(limitRead.sha256,createHash('sha256').update(limit).digest('hex'));receipt.cases.push({name:'2 MiB local MIME file -> exact clipboard readback through native frames',passed:true,...limitRead});
  const before=await evaluate('clipboardWriteCalls');
  for(const [formats,code] of [[[format('text/plain',limit),format('text/html','x')],'clipboard_payload_too_large'],[[format('image/jpeg','x')],'clipboard_write_mime_unsupported'],[[{mimeType:'text/html',dataBase64:'%%%'}],'clipboard_base64_invalid']]){await assert.rejects(write(formats),error=>error.code===code&&error.details.mutationDispatchAttempted===false);assert.equal(await evaluate('clipboardWriteCalls'),before);receipt.cases.push({name:code+' -> no write dispatch',passed:true});}
  assert.equal(await evaluate('navigator.clipboard.readText().then(text=>text.length)'),MAX_CLIPBOARD_BINARY_BYTES);
  assert.equal(await evaluate('document.querySelector("#plain").value'),japanese);
  await evaluate('document.querySelector("#results").textContent='+JSON.stringify('PASS '+receipt.cases.length+' scenarios\nProduction shortcut dispatch + page.selectText + trusted copy/paste\nPause/site block: no dispatch\nJapanese + emoji + newlines; rich HTML preserved\nPNG decoded pixels identical; 2 MiB readback\nOS clipboard untouched; installed-extension check pending'));
  const screenshot=await call('Page.captureScreenshot',{format:'png'});receipt.image=join(out,'verified.png');await writeFile(receipt.image,Buffer.from(screenshot.data,'base64'));receipt.actualWrites=await evaluate('clipboardWriteCalls');receipt.result='passed';
}catch(error){receipt.result='failed';receipt.error={message:error.message,code:error.code??null};receipt.chromeStderr=stderr;process.exitCode=1;}
finally{
  socket?.close();for(const p of pending.values()){clearTimeout(p.timer);p.no(Error('test ended'));}pending.clear();chrome.kill('SIGTERM');if(chrome.exitCode===null&&chrome.signalCode===null)await Promise.race([new Promise(ok=>chrome.once('exit',ok)),delay(3000)]);if(chrome.exitCode===null&&chrome.signalCode===null){chrome.kill('SIGKILL');await new Promise(ok=>chrome.once('exit',ok));}
  receipt.testChromeClosed=chrome.exitCode!==null||chrome.signalCode!==null;await new Promise(ok=>server.close(ok));if(receipt.testChromeClosed)await rm(scratch,{recursive:true,force:true});receipt.finishedAt=new Date().toISOString();await writeFile(join(out,'receipt.json'),JSON.stringify(receipt,null,2));console.log(JSON.stringify({result:receipt.result,cases:receipt.cases.length,record:join(out,'receipt.json'),image:receipt.image,testChromeClosed:receipt.testChromeClosed,error:receipt.error}));
}
