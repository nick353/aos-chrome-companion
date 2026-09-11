import assert from 'node:assert/strict';
import vm from 'node:vm';
import {spawn} from 'node:child_process';
import {mkdtemp,readFile,writeFile,mkdir,rm,stat,unlink,copyFile} from 'node:fs/promises';
import {createServer} from 'node:http';
import {createHash} from 'node:crypto';
import {gzipSync} from 'node:zlib';
import {join,resolve} from 'node:path';
import {tmpdir} from 'node:os';
import {verifyDownloadedArtifact} from '../src/broker/download-artifact.mjs';
const out=resolve(process.argv[2]??'work/download-dom',new Date().toISOString().replaceAll(':','-'));await mkdir(out,{recursive:true});
const scratch=await mkdtemp(join(tmpdir(),'companion-download-')),profile=join(scratch,'chrome'),downloads=join(scratch,'downloads');await mkdir(downloads);
const source=await readFile(new URL('../extension/service-worker.js',import.meta.url),'utf8');
const injected=source.slice(source.indexOf('async function injectedPageOperation('),source.indexOf('\nchrome.runtime.onMessage.addListener',source.indexOf('async function injectedPageOperation(')));
const downloadFunction=source.slice(source.indexOf('async function runDownload('),source.indexOf('async function withReadOnlyDebugger('));
const csv=Buffer.from('名前,結果\n田中,保存済み 👩🏽‍💻\n'),compressedContent=Buffer.from('日本語の圧縮応答 👩🏽‍💻\n'.repeat(2000));
const png=Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+a3ioAAAAASUVORK5CYII=','base64');
const requests=[];let foreignOrigin;
const send=(res,bytes,filename,headers={})=>{res.writeHead(200,{'content-type':'application/octet-stream','content-disposition':'attachment; filename="'+filename+'"','content-length':bytes.length,'cache-control':'no-store',...headers});res.end(bytes);};
const foreign=createServer((req,res)=>{requests.push({server:'outside',path:req.url});send(res,csv,'outside.csv');});await new Promise(ok=>foreign.listen(0,'127.0.0.1',ok));foreignOrigin='http://127.0.0.1:'+foreign.address().port;
const html=`<!doctype html><meta charset="utf-8"><title>Companion download verification</title><style>body{font:22px system-ui;padding:40px;background:#f6f9fe;color:#173858}a,input{display:block;padding:12px;font:20px system-ui}img{width:48px;height:48px}pre{font:18px system-ui;white-space:pre-wrap}</style><h1>Companion download verification</h1><input id="retained" value="本文を保持 👩🏽‍💻"><a id="csv" href="/csv">日本語CSV</a><img id="image" src="/image.png" alt="Local image"><a id="blob" href="data:text/plain,not-http">Unsupported data URL</a><pre id="results">Ready</pre>`;
const server=createServer((req,res)=>{
  requests.push({server:'page',path:req.url});
  if(req.url==='/csv')send(res,csv,'japanese.csv');
  else if(req.url==='/image.png')send(res,png,'image.png',{'content-type':'image/png'});
  else if(req.url==='/empty')send(res,Buffer.alloc(0),'empty.txt');
  else if(req.url==='/gzip')send(res,gzipSync(compressedContent),'compressed.txt',{'content-encoding':'gzip'});
  else if(req.url==='/redirect'){res.writeHead(302,{location:'/csv'});res.end();}
  else if(req.url==='/outside'){res.writeHead(302,{location:foreignOrigin+'/file'});res.end();}
  else if(req.url==='/interrupted'){res.writeHead(200,{'content-type':'application/octet-stream','content-disposition':'attachment; filename="broken.txt"','content-length':100000});res.write(Buffer.alloc(1000,65));setTimeout(()=>res.destroy(),40);}
  else if(req.url==='/favicon.ico'){res.writeHead(204);res.end();}
  else{res.writeHead(200,{'content-type':'text/html; charset=utf-8'});res.end(html);}
});await new Promise(ok=>server.listen(0,'127.0.0.1',ok));const origin='http://127.0.0.1:'+server.address().port;
const chrome=spawn('/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',['--headless=new','--remote-debugging-port=0','--user-data-dir='+profile,'--no-first-run','--no-default-browser-check','--disable-background-networking','--disable-component-update','--disable-sync','--window-size=1200,900','about:blank'],{stdio:['ignore','ignore','pipe']});
let stderr='';chrome.stderr.on('data',chunk=>{stderr=(stderr+chunk).slice(-10000);});
let socket,nextId=0,nextDownload=0,pendingStart=null;const pending=new Map(),listeners=new Set(),items=new Map(),byGuid=new Map(),adapterCalls=[];
const delay=ms=>new Promise(ok=>setTimeout(ok,ms));
const receipt={startedAt:new Date().toISOString(),chromePid:chrome.pid,sourceDigest:createHash('sha256').update(source).digest('hex'),
  coverage:'Production runDownload and injected media resolver, actual isolated Chrome HTTP downloads, completed local files and production host artifact verifier. A Browser-domain CDP adapter supplies downloads events/API shape; native chrome.downloads permissions, danger classification and history cleanup require installed-extension verification.',cases:[]};
function call(method,params={}){return new Promise((ok,no)=>{const id=++nextId,timer=setTimeout(()=>{pending.delete(id);no(Error('CDP timeout '+method));},10000);pending.set(id,{ok,no,timer});socket.send(JSON.stringify({id,method,params}));});}
function change(delta){for(const fn of listeners)fn(delta);}
try{
  let port;for(let i=0;i<1200;i++){try{port=Number((await readFile(join(profile,'DevToolsActivePort'),'utf8')).split('\n')[0]);break;}catch{if(chrome.exitCode!==null)throw Error('test Chrome exited');await delay(100);}}assert.ok(port);
  const pages=await(await fetch('http://127.0.0.1:'+port+'/json/list')).json();socket=new WebSocket(pages.find(p=>p.type==='page').webSocketDebuggerUrl);await new Promise((ok,no)=>{socket.addEventListener('open',ok,{once:true});socket.addEventListener('error',no,{once:true});});
  socket.addEventListener('message',event=>{
    const m=JSON.parse(event.data);
    if(m.method==='Browser.downloadWillBegin'){
      const p=m.params,id=++nextDownload;assert.ok(pendingStart,'unexpected fixture download');const start=pendingStart;pendingStart=null;clearTimeout(start.timer);
      const item={id,guid:p.guid,url:start.url,finalUrl:p.url,filename:join(downloads,p.guid),suggestedFilename:p.suggestedFilename,state:'in_progress',fileSize:-1,bytesReceived:0,totalBytes:-1,danger:'safe',mime:'application/octet-stream',exists:false};items.set(id,item);byGuid.set(p.guid,item);change({id,url:{current:item.url},finalUrl:{current:item.finalUrl}});start.ok(id);return;
    }
    if(m.method==='Browser.downloadProgress'){
      const p=m.params,item=byGuid.get(p.guid);if(!item)return;item.bytesReceived=p.receivedBytes;item.totalBytes=p.totalBytes;item.state=p.state==='completed'?'complete':p.state==='canceled'?'interrupted':'in_progress';if(p.filePath)item.filename=p.filePath;change({id:item.id,state:{current:item.state}});return;
    }
    if(m.method)return;const p=pending.get(m.id);if(!p)return;pending.delete(m.id);clearTimeout(p.timer);m.error?p.no(Error(JSON.stringify(m.error))):p.ok(m.result);
  });
  receipt.browser=await call('Browser.getVersion');await call('Browser.setDownloadBehavior',{behavior:'allowAndName',downloadPath:downloads,eventsEnabled:true});await call('Page.navigate',{url:origin+'/'});
  const evaluate=async expression=>{const r=await call('Runtime.evaluate',{expression,returnByValue:true,awaitPromise:true});if(r.exceptionDetails)throw Error(JSON.stringify(r.exceptionDetails));return r.result.value;};
  for(let i=0;i<100;i++){if(await evaluate('document.readyState==="complete" && !!document.querySelector("#csv")'))break;await delay(50);}
  const injectedCall=async(action,payload)=>{const result=await evaluate(`(${injected})(${JSON.stringify(action)},${JSON.stringify(payload)})`);if(result.__aosCompanionError)throw Object.assign(Error(result.__aosCompanionError.message),result.__aosCompanionError);return result;};
  const documentId=(await injectedCall('snapshot',{maxTextChars:1000})).pageInstanceId;
  const api={onChanged:{addListener:fn=>listeners.add(fn),removeListener:fn=>listeners.delete(fn)},
    download:params=>{adapterCalls.push({method:'download',url:params.url});assert.equal(listeners.size,1);return new Promise((ok,no)=>{assert.equal(pendingStart,null);const timer=setTimeout(()=>{pendingStart=null;no(Error('download opening timeout'));},10000);pendingStart={url:params.url,ok,no,timer};void call('Page.navigate',{url:params.url}).catch(error=>{if(pendingStart){clearTimeout(pendingStart.timer);pendingStart=null;no(error);}});});},
    search:async({id})=>{assert.ok(Number.isSafeInteger(id));const item=items.get(id);if(!item)return [];try{const local=await stat(item.filename);item.exists=local.isFile();}catch{item.exists=false;}return [{...item}];},
    cancel:async id=>{const item=items.get(id);assert.ok(item);adapterCalls.push({method:'cancel',id});return call('Browser.cancelDownload',{guid:item.guid});},
    removeFile:async id=>{const item=items.get(id);assert.ok(item&&item.filename.startsWith(downloads+'/'));adapterCalls.push({method:'remove',id});await unlink(item.filename);},
    erase:async({id})=>{assert.ok(items.has(id));adapterCalls.push({method:'erase',id});items.delete(id);return [id];},
  };
  const companionError=(code,message,details)=>Object.assign(Error(message),{code,details});
  const context={URL,Date,setTimeout,clearTimeout,chrome:{downloads:api},companionError,requireOptionalPermission:async()=>{},
    requireSafeUrl:value=>{const url=new URL(value);if(!['http:','https:'].includes(url.protocol)||url.username||url.password)throw companionError('url_not_allowed','unsupported');return url.href;},
    originOf:value=>{try{return new URL(value).origin;}catch{return null;}},allowedOriginsOf:values=>new Set(values),runPageOperation:(_tab,action,params)=>injectedCall(action,params)};
  vm.createContext(context);vm.runInContext(downloadFunction,context);
  for(const spec of [
    {name:'Exact anchor -> Japanese CSV',locator:{css:'#csv'},body:csv},
    {name:'Exact image currentSrc -> PNG file',locator:{css:'#image'},body:png},
    {name:'Zero-byte download',path:'/empty',body:Buffer.alloc(0)},
    {name:'Gzip response -> decompressed local content',path:'/gzip',body:compressedContent},
    {name:'Same-origin redirect -> completed artifact',path:'/redirect',body:csv},
  ]){
    const before=adapterCalls.filter(c=>c.method==='download').length;
    const result=await context.runDownload(1,{...(spec.locator?{locator:spec.locator}:{url:origin+spec.path}),pageInstanceId:documentId,allowedOrigins:[origin]});
    const artifact=await verifyDownloadedArtifact(result,{expectedTabId:1});assert.equal(artifact.bytes,spec.body.length);assert.equal(artifact.sha256,createHash('sha256').update(spec.body).digest('hex'));assert.equal(adapterCalls.filter(c=>c.method==='download').length,before+1);
    assert.equal(await evaluate('document.querySelector("#retained").value'),'本文を保持 👩🏽‍💻');assert.equal(listeners.size,0);
    if(spec.locator?.css==='#csv'){receipt.sampleArtifact=join(out,'verified-sample.csv');await copyFile(artifact.path,receipt.sampleArtifact);}
    receipt.cases.push({name:spec.name,passed:true,artifact,transferBytes:result.bytesReceived,fileHashMatchesFixture:true});
  }
  const beforeUnsupported=adapterCalls.length;await assert.rejects(context.runDownload(1,{locator:{css:'#blob'},pageInstanceId:documentId,allowedOrigins:[origin]}),error=>error.code==='download_target_protocol_unsupported'&&error.details.mutationDispatchAttempted===false);assert.equal(adapterCalls.length,beforeUnsupported);receipt.cases.push({name:'Unsupported data media URL fails before download dispatch',passed:true});
  for(const [path,code] of [['/outside','download_redirect_origin_not_allowed'],['/interrupted','download_interrupted']]){
    const before=adapterCalls.filter(c=>c.method==='download').length;await assert.rejects(context.runDownload(1,{url:origin+path,allowedOrigins:[origin]}),{code});assert.equal(adapterCalls.filter(c=>c.method==='download').length,before+1);assert.equal(listeners.size,0);
    if(path==='/outside'){
      const owned=[...byGuid.values()].find(item=>item.id===nextDownload);assert.ok(owned&&owned.filename.startsWith(downloads+'/'));
      for(const filePath of [owned.filename,owned.filename+'.crdownload'])await assert.rejects(stat(filePath),{code:'ENOENT'});
    }
    receipt.cases.push({name:path==='/outside'?'Outside-origin redirect rejected; completed and partial files confirmed absent':'Interrupted download does not produce a verified artifact',passed:true});
  }
  await evaluate('document.querySelector("#results").textContent='+JSON.stringify('PASS '+receipt.cases.length+' scenarios\nMedia locator + absolute local artifact + SHA-256\nJapanese CSV / PNG / zero bytes / gzip / redirect\nUnsupported URL / outside-origin redirect / interruption\nOne download invocation per attempt; original input retained'));
  const screenshot=await call('Page.captureScreenshot',{format:'png'});receipt.image=join(out,'verified.png');await writeFile(receipt.image,Buffer.from(screenshot.data,'base64'));receipt.result='passed';
}catch(error){receipt.result='failed';receipt.error={message:error.message,code:error.code??null};receipt.chromeStderr=stderr;process.exitCode=1;}
finally{
  if(pendingStart){clearTimeout(pendingStart.timer);pendingStart.no(Error('test ended'));pendingStart=null;}
  socket?.close();for(const p of pending.values()){clearTimeout(p.timer);p.no(Error('test ended'));}pending.clear();
  chrome.kill('SIGTERM');if(chrome.exitCode===null&&chrome.signalCode===null)await Promise.race([new Promise(ok=>chrome.once('exit',ok)),delay(3000)]);if(chrome.exitCode===null&&chrome.signalCode===null){chrome.kill('SIGKILL');await new Promise(ok=>chrome.once('exit',ok));}
  receipt.testChromeClosed=chrome.exitCode!==null||chrome.signalCode!==null;await Promise.all([new Promise(ok=>server.close(ok)),new Promise(ok=>foreign.close(ok))]);if(receipt.testChromeClosed)await rm(scratch,{recursive:true,force:true});
  receipt.requests=requests;receipt.adapterCalls=adapterCalls;receipt.requestRetryScope='The wrapper invokes one download per attempt; Chrome itself can retry an interrupted GET. Server requests are retained separately from API invocation counts.';receipt.finishedAt=new Date().toISOString();await writeFile(join(out,'receipt.json'),JSON.stringify(receipt,null,2));console.log(JSON.stringify({result:receipt.result,cases:receipt.cases.map(c=>({name:c.name,passed:c.passed})),record:join(out,'receipt.json'),image:receipt.image,sampleArtifact:receipt.sampleArtifact,testChromeClosed:receipt.testChromeClosed,error:receipt.error}));
}
