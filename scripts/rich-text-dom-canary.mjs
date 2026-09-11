import assert from 'node:assert/strict';
import {spawn} from 'node:child_process';
import {readFile,writeFile,mkdir,mkdtemp,rm} from 'node:fs/promises';
import {createHash} from 'node:crypto';
import {resolve,join} from 'node:path';
import {tmpdir} from 'node:os';
import {createServer} from 'node:http';
const sourcePath=resolve(process.argv[2] ?? 'extension/service-worker.js');
const out=resolve(process.argv[3] ?? 'work/rich-text-dom',new Date().toISOString().replaceAll(':','-'));await mkdir(out,{recursive:true});
const profile=await mkdtemp(join(tmpdir(),'companion-rich-text-'));
const source=await readFile(sourcePath,'utf8');
const injected=source.slice(source.indexOf('async function injectedPageOperation('),source.indexOf('\nchrome.runtime.onMessage.addListener',source.indexOf('async function injectedPageOperation(')));
assert.ok(injected.startsWith('async function injectedPageOperation('));
const html=`<!doctype html><meta charset="utf-8"><title>Companion rich text DOM regression</title><style>body{font:18px system-ui;padding:24px;color:#163456;background:#f6f9fe}iframe{width:100%;height:240px;border:1px solid #cbd5e1}pre{white-space:pre-wrap}</style><h1>Companion rich text DOM regression</h1><p>Owned synthetic editors only. No provider content.</p><pre id="results">Running</pre><div id="fixture"></div>`;
const requests=[];
const server=createServer(async(req,res)=>{if(req.url?.startsWith('/data?')){let body='';for await(const part of req)body+=part;requests.push({url:req.url,method:req.method,body});res.writeHead(201,{'content-type':'application/json; charset=utf-8'});res.end(JSON.stringify({message:'日本語の応答',ok:true}));}else if(req.url==='/favicon.ico'){res.writeHead(204);res.end();}else {res.writeHead(200,{'content-type':'text/html; charset=utf-8'});res.end(html);}});
await new Promise(ok=>server.listen(0,'127.0.0.1',ok));const origin='http://127.0.0.1:'+server.address().port;
const chrome=spawn('/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',['--headless=new','--remote-debugging-port=0','--user-data-dir='+profile,'--no-first-run','--no-default-browser-check','--disable-background-networking','--disable-component-update','--disable-sync','--window-size=1200,900','about:blank'],{stdio:['ignore','ignore','pipe']});
let stderr='';chrome.stderr.on('data',chunk=>{stderr=(stderr+chunk).slice(-10000);});
let socket;const eventListeners=new Set(),detachListeners=new Set();const pending=new Map();let nextId=0;
function call(method,params={}) { return new Promise((ok,no)=>{const id=++nextId;const timer=setTimeout(()=>{pending.delete(id);no(Error('CDP timeout '+method));},10000);pending.set(id,{ok,no,timer});socket.send(JSON.stringify({id,method,params}));}); }
const receipt={startedAt:new Date().toISOString(),chromePid:chrome.pid,coverage:'Full production injectedPageOperation in actual DOM in a fresh isolated headless Chrome profile. Native installed extension transport is a separate canary.',sourcePath,sourceDigest:createHash('sha256').update(source).digest('hex'),cases:[]};
try {
 let port;
 for(let i=0;i<1200;i++){try{port=Number((await readFile(join(profile,'DevToolsActivePort'),'utf8')).split('\n')[0]);break;}catch{if(chrome.exitCode!==null)throw Error('test Chrome exited '+chrome.exitCode);await new Promise(ok=>setTimeout(ok,100));}}
 assert.ok(port,'test Chrome debugging endpoint unavailable');
 const pages=await(await fetch('http://127.0.0.1:'+port+'/json/list')).json();const page=pages.find(p=>p.type==='page');assert.ok(page);
 socket=new WebSocket(page.webSocketDebuggerUrl);await new Promise((ok,no)=>{socket.addEventListener('open',ok,{once:true});socket.addEventListener('error',no,{once:true});});
 socket.addEventListener('message',event=>{const message=JSON.parse(event.data);if(message.method){for(const listener of eventListeners)listener({tabId:1},message.method,message.params);return;}const p=pending.get(message.id);if(!p)return;pending.delete(message.id);clearTimeout(p.timer);message.error?p.no(Error(JSON.stringify(message.error))):p.ok(message.result);});
 receipt.browser=await call('Browser.getVersion');await call('Page.enable');await call('Page.navigate',{url:origin+'/'});
 const evalLocal=async expression=>{const r=await call('Runtime.evaluate',{expression,returnByValue:true,awaitPromise:true});if(r.exceptionDetails)throw Error(JSON.stringify(r.exceptionDetails));return r.result.value;};
 for(let i=0;i<50;i++){if(await evalLocal('document.readyState === "complete" && !!document.querySelector("#run")'))break;await new Promise(ok=>setTimeout(ok,100));}
 await evalLocal('window.productionInjected = '+JSON.stringify(injected));
 const cases = [
  {name:'plain text root editor',html:'見出し',success:true},
  {name:'normal separate paragraph',html:'<p>見出し</p><p>本文です</p>',success:true},
  {name:'already h2',html:'<h2>見出し</h2><p>本文です</p>',success:true,dispatch:0},
  {name:'framework reverted command',html:'<p>見出し</p><p>本文です</p>',mode:'revert',error:'rich_text_command_not_committed'},
  {name:'body text lost',html:'<p>見出し</p><p>本文です</p>',mode:'lost',error:'rich_text_content_changed'},
  {name:'outside same length text changed',html:'<p>見出し</p><p>本文です</p>',mode:'sameLength',error:'rich_text_content_changed'},
  {name:'framework reverts on input',html:'<p>見出し</p><p>本文です</p>',mode:'inputRevert',error:'rich_text_command_not_committed'},
  {name:'outside structure changed',html:'<p>見出し</p><p>本文です</p>',mode:'outsideStructure',error:'rich_text_outside_selection_changed'},
  {name:'partial paragraph newline',html:'<p>見出し\n本文です</p>',error:'rich_text_block_boundary_required',dispatch:0},
  {name:'partial paragraph br',html:'<p>見出し<br>本文です</p>',error:'rich_text_block_boundary_required',dispatch:0},
  {name:'multiple whole blocks',html:'<p>見出し</p><p>第二段落</p><p>本文です</p>',text:'見出し第二段落',error:'rich_text_multiple_block_format_unsupported',dispatch:0},
  {name:'empty paragraph caret',html:'<p><br></p><p>本文です</p>',caret:true,success:true},
  {name:'duplicate occurrence',html:'<p>見出し</p><p>見出し</p><p>本文です</p>',occurrence:1,success:true},
  {name:'ambiguous exact text',html:'<p>見出し</p><p>見出し</p>',error:'selection_text_ambiguous',dispatch:0},
  {name:'occurrence outside matches',html:'<p>見出し</p><p>本文です</p>',occurrence:2,error:'selection_occurrence_invalid',dispatch:0},
  {name:'selection in another editor',html:'<p>見出し</p>',outside:true,error:'rich_text_selection_outside_editor',dispatch:0},
  {name:'bold native input once',html:'<p>見出し</p><p>本文です</p>',operation:'bold',success:true,inputCount:1},
  {name:'bold toggle off',html:'<p><b>見出し</b></p><p>本文です</p>',operation:'bold',success:true},
  {name:'italic partial range',html:'<p>前見出し後</p><p>本文です</p>',operation:'italic',success:true},
  {name:'framework replaces editor root',html:'<p>見出し</p><p>本文です</p>',mode:'replaceRoot',success:true},
  {name:'breaks links empty outside retained',html:'<p><a href="/owned">見出し</a><br>続き</p><p><br></p><p>本文です</p>',text:'見出し続き',success:true},
  {name:'selected break removed',html:'<p>見出し<br>続き</p><p>本文です</p>',text:'見出し続き',mode:'loseBreak',error:'rich_text_command_not_committed'},
  {name:'selected link destination changed',html:'<p><a href="/owned">見出し</a></p><p>本文です</p>',mode:'changeLink',error:'rich_text_command_not_committed'},
  {name:'empty existing heading',html:'<h2><br></h2><p>本文です</p>',caret:true,success:true,dispatch:0},
  {name:'underline',html:'<p>見出し</p><p>本文です</p>',operation:'underline',success:true},
  {name:'ordered list',html:'<p>見出し</p><p>本文です</p>',operation:'orderedList',success:true},
  {name:'ordered list toggle off',html:'<ol><li>見出し</li></ol><p>本文です</p>',operation:'orderedList',success:true},
  {name:'horizontal rule at caret',html:'<p>見出し</p><p>本文です</p>',operation:'horizontalRule',caret:true,success:true},
  {name:'horizontal rule with selected text',html:'<p>見出し</p><p>本文です</p>',operation:'horizontalRule',error:'rich_text_caret_required',dispatch:0},
  {name:'unordered list',html:'<p>見出し</p><p>本文です</p>',operation:'unorderedList',success:true},
  {name:'indent',html:'<p>見出し</p><p>本文です</p>',operation:'indent',success:true},
  {name:'outdent',html:'<blockquote><p>見出し</p></blockquote><p>本文です</p>',operation:'outdent',success:true},
 ];
 for (const specification of cases) {
   const observed = await evalLocal(`(async()=>{
    const c=${JSON.stringify(specification)};
    const frame=document.createElement('iframe');document.querySelector('#fixture').replaceChildren(frame);
    frame.srcdoc='<meta charset="utf-8"><style>body{font:20px system-ui}#editor{border:1px solid #aaa;padding:10px}</style><div id="editor" contenteditable="true">'+c.html+'</div><div id="other" contenteditable="true">別エディター</div>';
    await new Promise(ok=>frame.onload=ok);
    const w=frame.contentWindow,d=w.document;w.eval(window.productionInjected+';window.runProduction=injectedPageOperation');
    const editor=d.querySelector('#editor');const initialHtml=editor.innerHTML;let dispatch=0,inputCount=0;const native=d.execCommand.bind(d);
    editor.addEventListener('input',()=>{inputCount++;if(c.mode==='inputRevert')editor.innerHTML=initialHtml;if(c.mode==='replaceRoot')editor.replaceWith(editor.cloneNode(true));});
    d.execCommand=(command,ui,value)=>{dispatch++;if(c.mode==='revert')return true;const result=native(command,ui,value);const e=d.querySelector('#editor');if(c.mode==='lost')e.innerHTML='<h2>見出し</h2>';if(c.mode==='sameLength')e.lastElementChild.textContent='別文です';if(c.mode==='outsideStructure')e.lastElementChild.outerHTML='<h3>本文です</h3>';if(c.mode==='loseBreak')e.querySelector('br').remove();if(c.mode==='changeLink')e.querySelector('a').setAttribute('href','/changed');return result;};
    const payload={locator:{css:'#editor'},operation:c.operation??'heading',blockTag:'h2'};
    if(c.caret||c.outside){const target=c.outside?d.querySelector('#other'):editor.firstElementChild;target.focus();const r=d.createRange();r.selectNodeContents(target);if(c.caret)r.collapse(true);w.getSelection().removeAllRanges();w.getSelection().addRange(r);}else payload.text=c.text??'見出し';
    if(c.occurrence!==undefined)payload.occurrence=c.occurrence;
    const result=await w.runProduction('richText',payload);
    return {result,dispatch,inputCount,initialHtml,finalHtml:d.querySelector('#editor').innerHTML,finalText:d.querySelector('#editor').textContent};
   })()`);
   const error=observed.result.__aosCompanionError;
   const passed=specification.success ? observed.result.structureCommitted===true && !error : error?.code===specification.error;
   const dispatchPassed=specification.dispatch===undefined || observed.dispatch===specification.dispatch;
   const effectPassed=!error || error.details?.operationEffectState === (observed.dispatch===0?'none':'unknown');
   const inputPassed=specification.inputCount===undefined||observed.inputCount===specification.inputCount;
   receipt.cases.push({name:specification.name,passed:passed&&dispatchPassed&&effectPassed&&inputPassed,specification,observed});
   await evalLocal('document.querySelector("#results").textContent='+JSON.stringify(receipt.cases.map(c=>(c.passed?'PASS ':'FAIL ')+c.name).join('\n')));
 }
 const selectionCases = [
  {name:'select text across inline nodes',html:'<p><span>見</span><b>出し</b></p>',text:'見出し'},
  {name:'select two paragraphs with blank line',html:'<p>見出し</p><p>本文です</p>',text:'見出し\n\n本文です'},
  {name:'select div paragraphs',html:'<div>段落一</div><div>段落二</div>',text:'段落一\n段落二'},
  {name:'select BR line break',html:'<p>見出し<br>本文です</p>',text:'見出し\n本文です'},
  {name:'select linked lines and emoji',html:'<p><a href="/owned">見出し😀</a><br>続き</p><p>本文</p>',text:'見出し😀\n続き'},
  {name:'select literal pre newline',html:'<pre>見出し\n本文です</pre>',text:'見出し\n本文です'},
  {name:'select collapsed whitespace',html:'<p>前    見出し\n   本文です 後</p>',text:'見出し 本文です'},
  {name:'select includes spaces at boundaries',html:'<p>前 見出し 後</p>',text:' 見出し '},
  {name:'select ignores hidden duplicate',html:'<p><span hidden>見出し</span>見出し</p>',text:'見出し'},
  {name:'select duplicate occurrence',html:'<p>見出し</p><p>見出し</p>',text:'見出し',occurrence:1},
  {name:'select duplicate prefix and suffix',html:'<p>第一節 見出し 前半</p><p>第二節 見出し 後半</p>',text:'見出し',prefix:'第二節 ',suffix:' 後半'},
  {name:'select duplicate suffix alone',html:'<p>見出し 前半</p><p>見出し 後半</p>',text:'見出し',suffix:' 後半'},
  {name:'select ambiguous text has no effect',html:'<p>見出し</p><p>見出し</p>',text:'見出し',error:'selection_text_ambiguous',dispatched:false},
  {name:'select missing text has no effect',html:'<p>本文</p>',text:'見出し',error:'selection_text_not_found',dispatched:false},
  {name:'select unmatched context has no effect',html:'<p>見出し</p>',text:'見出し',prefix:'存在しない',error:'selection_text_not_found',dispatched:false},
  {name:'select invalid occurrence has no effect',html:'<p>見出し</p>',text:'見出し',occurrence:1,error:'selection_occurrence_invalid',dispatched:false},
  {name:'select unsupported text transform has no effect',html:'<p style="text-transform:uppercase">heading</p>',text:'HEADING',error:'selection_rendered_mapping_unavailable',dispatched:false},
  {name:'select detects focus body change',html:'<p>見出し</p><p>本文です</p>',text:'見出し',mode:'focusChange',error:'selection_editor_changed_before_dispatch',dispatched:false,changed:true},
  {name:'select rejects same text in other editor after event',html:'<p>見出し</p>',text:'見出し',mode:'moveOther',error:'selection_not_committed',dispatched:true},
  {name:'select detects event body change',html:'<p>見出し</p><p>本文です</p>',text:'見出し',mode:'selectionChange',error:'selection_editor_content_changed',dispatched:true,changed:true},
  {name:'select detects cleared selection after event',html:'<p>見出し</p>',text:'見出し',mode:'clearSelection',error:'selection_not_committed',dispatched:true},
 ];
 for (const specification of selectionCases) {
   const observed = await evalLocal(`(async()=>{
    const c=${JSON.stringify(specification)};
    const frame=document.createElement('iframe');document.querySelector('#fixture').replaceChildren(frame);
    frame.srcdoc='<meta charset="utf-8"><style>body{font:20px system-ui}#editor{border:1px solid #aaa;padding:10px}</style><div id="editor" contenteditable="true">'+c.html+'</div><div id="other" contenteditable="true">見出し</div>';
    await new Promise(ok=>frame.onload=ok);
    const w=frame.contentWindow,d=w.document;w.eval(window.productionInjected+';window.runProduction=injectedPageOperation');
    const editor=d.querySelector('#editor'),initialHtml=editor.innerHTML,initialRendered=editor.innerText;
    let selectionEventHandled=false,events=0;
    if(c.mode==='focusChange'){const nativeFocus=editor.focus.bind(editor);editor.focus=()=>{nativeFocus();editor.lastElementChild.textContent='別文です';};}
    d.addEventListener('selectionchange',()=>{
      events++;
      if(selectionEventHandled||w.getSelection().toString()!==c.text)return;
      selectionEventHandled=true;
      if(c.mode==='selectionChange')editor.lastElementChild.textContent='別文です';
      if(c.mode==='clearSelection')w.getSelection().removeAllRanges();
      if(c.mode==='moveOther'){const r=d.createRange();r.selectNodeContents(d.querySelector('#other'));w.getSelection().removeAllRanges();w.getSelection().addRange(r);}
    });
    const payload={locator:{css:'#editor'},text:c.text};
    for(const key of ['prefix','suffix','occurrence'])if(c[key]!==undefined)payload[key]=c[key];
    const result=await w.runProduction('selectText',payload);
    const selection=w.getSelection(),range=selection.rangeCount===1?selection.getRangeAt(0):null;
    return {result,initialHtml,finalHtml:editor.innerHTML,initialRendered,selectedText:selection.toString(),selectionInside:!!range&&editor.contains(range.startContainer)&&editor.contains(range.endContainer),events};
   })()`);
   const error=observed.result.__aosCompanionError;
   const success=!specification.error;
   const matched=success ? observed.result.selectionCommitted===true&&!error&&observed.selectedText===specification.text&&observed.selectionInside : error?.code===specification.error;
   const effectPassed=success||error?.details?.operationEffectState===(specification.dispatched||specification.changed?'unknown':'none');
   const dispatchPassed=success||error?.details?.mutationDispatchAttempted===specification.dispatched;
   const contentPassed=specification.changed?observed.finalHtml!==observed.initialHtml:observed.finalHtml===observed.initialHtml;
   receipt.cases.push({name:specification.name,passed:matched&&effectPassed&&dispatchPassed&&contentPassed,specification,observed});
   await evalLocal('document.querySelector("#results").textContent='+JSON.stringify(receipt.cases.map(c=>(c.passed?'PASS ':'FAIL ')+c.name).join('\n')));
 }
 const screenshot=await call('Page.captureScreenshot',{format:'png',captureBeyondViewport:true});receipt.image=join(out,'verified.png');await writeFile(receipt.image,Buffer.from(screenshot.data,'base64'));
 receipt.result=receipt.cases.every(c=>c.passed)?'passed':'failed';if(receipt.result==='failed')process.exitCode=1;
}catch(error){receipt.result='failed';receipt.error={message:error.message,code:error.code??null};receipt.chromeStderr=stderr;process.exitCode=1;}
finally {
 socket?.close();for(const p of pending.values()){clearTimeout(p.timer);p.no(Error('test ended'));}pending.clear();
 chrome.kill('SIGTERM');await Promise.race([new Promise(ok=>chrome.once('exit',ok)),new Promise(ok=>setTimeout(ok,3000))]);if(chrome.exitCode===null&&chrome.signalCode===null){chrome.kill('SIGKILL');await new Promise(ok=>chrome.once('exit',ok));}
 receipt.testChromeClosed=chrome.exitCode!==null||chrome.signalCode!==null;receipt.chromeExitCode=chrome.exitCode;receipt.chromeSignalCode=chrome.signalCode;await new Promise(ok=>server.close(ok));if(receipt.testChromeClosed)await rm(profile,{recursive:true,force:true});
 receipt.finishedAt=new Date().toISOString();await writeFile(join(out,'receipt.json'),JSON.stringify(receipt,null,2));console.log(JSON.stringify({result:receipt.result,cases:receipt.cases.map(c=>({name:c.name,passed:c.passed,error:c.observed?.result?.__aosCompanionError?.code})),record:join(out,'receipt.json'),image:receipt.image,testChromeClosed:receipt.testChromeClosed,error:receipt.error}));
}
