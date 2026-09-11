import assert from 'node:assert/strict';
import test from 'node:test';
import {readFile} from 'node:fs/promises';
import vm from 'node:vm';
const source=await readFile(new URL('../extension/service-worker.js',import.meta.url),'utf8');
const runSource=source.slice(source.indexOf('async function runDownload('),source.indexOf('async function withReadOnlyDebugger('));
function fixture({early=[],state='complete',downloadError=false,badId=false,resolveError=false}={}){
  const listeners=new Set(),calls=[];
  const companionError=(code,message,details)=>Object.assign(Error(message),{code,details});
  const context={URL,Date,setTimeout,clearTimeout,companionError,requireOptionalPermission:async()=>{},
    requireSafeUrl:value=>{const url=new URL(value);if(!['http:','https:'].includes(url.protocol)||url.username||url.password)throw companionError('url_not_allowed','unsupported');return url.href;},
    originOf:value=>{try{return new URL(value).origin;}catch{return null;}},allowedOriginsOf:values=>new Set(values),
    runPageOperation:async(tabId,action,params)=>{calls.push(['resolve',tabId,action,params]);if(resolveError)throw companionError('semantic_locator_ambiguous','two links');return {downloadUrl:'https://page.test/file.csv',pageInstanceId:'document-a',url:'https://page.test/',element:{tag:'a'}};},
    chrome:{downloads:{onChanged:{addListener:fn=>listeners.add(fn),removeListener:fn=>listeners.delete(fn)},
      download:async params=>{calls.push(['download',params]);assert.equal(listeners.size,1,'event listener precedes download');for(const event of early)for(const fn of listeners)fn(event);if(downloadError)throw Error('interrupted before callback');return badId?null:19;},
      search:async query=>{calls.push(['search',query]);return [{id:19,state,url:'https://page.test/file.csv',finalUrl:'https://page.test/file.csv',filename:'/tmp/成果物.csv',fileSize:30,bytesReceived:10,totalBytes:10,mime:'text/csv',exists:true,danger:'safe'}];},
      cancel:async id=>calls.push(['cancel',id]),removeFile:async id=>calls.push(['remove',id]),erase:async query=>calls.push(['erase',query]),
    }}};
  vm.createContext(context);vm.runInContext(runSource,context);
  return {calls,listeners,run:params=>context.runDownload(7,{url:'https://page.test/file.csv',allowedOrigins:['https://page.test'],...params})};
}
test('instant downloads register events before dispatch and retain the browser absolute path and file size',async()=>{
  const f=fixture({early:[{id:19,state:{current:'complete'}}]});const result=await f.run();
  assert.equal(result.source,'chrome.downloads');assert.equal(result.filePath,'/tmp/成果物.csv');assert.equal(result.filename,'成果物.csv');assert.equal(result.fileSize,30);assert.equal(result.bytesReceived,10);assert.equal(f.listeners.size,0);
});
test('early redirect evidence only cancels and removes the exact returned download, never another item',async()=>{
  const f=fixture({early:[{id:20,finalUrl:{current:'https://other.test/foreign'}},{id:19,finalUrl:{current:'https://other.test/blocked'}}]});
  await assert.rejects(f.run(),{code:'download_redirect_origin_not_allowed'});assert.ok(f.calls.some(c=>c[0]==='cancel'));
  for(const [method,id] of f.calls.filter(c=>['cancel','remove'].includes(c[0])))assert.equal(id,19,method);
  assert.deepEqual(JSON.parse(JSON.stringify(f.calls.find(c=>c[0]==='erase')[1])),{id:19});assert.equal(f.listeners.size,0);
});
test('download dispatch uncertainty removes the listener and cannot run an unscoped search or cleanup',async()=>{
  for(const options of [{downloadError:true},{badId:true}]){
    const f=fixture(options);await assert.rejects(f.run(),error=>error.code==='download_dispatch_unknown'&&error.details.mutationDispatchAttempted===true&&error.details.operationEffectState==='unknown');
    assert.equal(f.calls.filter(c=>['search','cancel','remove','erase'].includes(c[0])).length,0);assert.equal(f.listeners.size,0);
  }
});
test('a locator resolves its media URL in the exact signed document and preparation failures do not dispatch',async()=>{
  const f=fixture();const result=await f.run({url:undefined,locator:{css:'a.asset'},pageInstanceId:'document-a'});assert.equal(result.sourceTarget.resolvedUrl,'https://page.test/file.csv');
  const stale=fixture();await assert.rejects(stale.run({url:undefined,locator:{css:'a.asset'},pageInstanceId:'old-document'}),error=>error.code==='download_target_document_changed'&&error.details.mutationDispatchAttempted===false);
  const ambiguous=fixture({resolveError:true});await assert.rejects(ambiguous.run({url:undefined,locator:{css:'a.asset'},pageInstanceId:'document-a'}),error=>error.code==='semantic_locator_ambiguous'&&error.details.operationEffectState==='none');
  for(const fixture of [stale,ambiguous])assert.equal(fixture.calls.filter(c=>c[0]==='download').length,0);
});
test('interrupted downloads are not reported as saved files and retain no observation listener',async()=>{
  const f=fixture({state:'interrupted'});await assert.rejects(f.run(),{code:'download_interrupted'});assert.equal(f.listeners.size,0);assert.equal(f.calls.filter(c=>c[0]==='download').length,1);
});
