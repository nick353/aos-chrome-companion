import assert from 'node:assert/strict';
import test from 'node:test';
import {readFile,writeFile,mkdtemp,rm,symlink} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import vm from 'node:vm';
import {createHash,webcrypto} from 'node:crypto';
import {BINARY_CLIPBOARD_MIME_ALLOWLIST, MAX_CLIPBOARD_BINARY_BYTES} from '../src/shared/peripheral-policy.mjs';
import * as z from 'zod/v4';
import {transactionActionSchema} from '../src/mcp/action-schema.mjs';
import {materializeTransactionActions} from '../src/mcp/action-materializer.mjs';

const offscreen = (await readFile(new URL('../extension/offscreen.js',import.meta.url),'utf8')).replace(/^import[\s\S]*?from "\.\/peripheral-policy\.generated\.js";\n/u,'');
const worker = await readFile(new URL('../extension/service-worker.js',import.meta.url),'utf8');
const workerFunction = worker.slice(worker.indexOf('async function runClipboardOperation('),worker.indexOf('async function runBinaryClipboardOperation('));
const format = (mimeType,text) => ({mimeType,dataBase64:Buffer.from(text).toString('base64')});
const schema = transactionActionSchema(z.object({label:z.string()}));

function fixture({writeRejects=false, acknowledgementLost=false, wrongBinding=false, unsupported=false, mutateAck, liveUrl='https://page.test/body'}={}) {
  let listener,nextOperation=0;const writes=[],messages=[],storage=new Map();
  const companionError=(code,message,details)=>Object.assign(Error(message),{code,details});
  class ClipboardItem { constructor(data){this.data=data;} static supports(type){return !unsupported && ['text/plain','text/html','image/png'].includes(type);} }
  const context={crypto:webcrypto,TextEncoder,URL,Blob,Uint8Array,atob,btoa,ClipboardItem,BINARY_CLIPBOARD_MIME_ALLOWLIST,MAX_CLIPBOARD_BINARY_BYTES,
    navigator:{clipboard:{write:async items=>{writes.push(items);if(writeRejects)throw Error('write acknowledgement unavailable');},writeText:async text=>{writes.push([{text}]);if(writeRejects)throw Error('write acknowledgement unavailable');}}},
    chrome:{runtime:{id:'own-extension',onMessage:{addListener:fn=>{listener=fn;}}}}};
  vm.createContext(context);vm.runInContext(offscreen,context);
  const bind=message=>{
    const payload=message.formats?{formats:message.formats.map(({mimeType,dataBase64})=>({mimeType,dataBase64}))}:{text:message.text};
    return {operationId:`source-${++nextOperation}`,generation:'generation-a',...message,payloadSha256:createHash('sha256').update(JSON.stringify(payload)).digest('hex')};
  };
  const send=(message,sender={id:'own-extension'})=>new Promise((resolve,reject)=>{
    if(message.kind.includes('clipboard')&&message.kind.endsWith('write')&&!message.operationId)message=bind(message);
    const returned=listener(message,sender,resolve);if(returned===false)resolve({ignored:true});
  });
  const workerContext={crypto:webcrypto,TextEncoder,URL,atob,MAX_CLIPBOARD_BINARY_BYTES,requireOptionalPermission:async()=>{},ensureOffscreenClipboard:async()=>{},requireTabId:value=>value,
    companionError,chrome:{tabs:{get:async()=>({id:42,url:liveUrl})},runtime:{id:'own-extension',getURL:path=>`chrome-extension://own-extension/${path}`,
      sendMessage:async message=>{messages.push(message);const result=await send(message);if(acknowledgementLost)throw Error('channel closed');return mutateAck?mutateAck(result):wrongBinding?{...result,taskId:'different-task'}:result;}},
      storage:{local:{get:async key=>key===null?Object.fromEntries(storage):{[key]:storage.get(key)},set:async values=>{for(const [key,value] of Object.entries(values))storage.set(key,JSON.parse(JSON.stringify(value)));}}}}};
  vm.createContext(workerContext);
  vm.runInContext(worker.slice(worker.indexOf('async function handleClipboardSourceStorage('),worker.indexOf('async function runClipboardOperation(')),workerContext);
  context.chrome.runtime.sendMessage=async message=>{
    try{return {ok:true,value:await workerContext.handleClipboardSourceStorage(message,{id:'own-extension',url:'chrome-extension://own-extension/offscreen.html'})};}
    catch(error){return {ok:false,code:error.code??'clipboard_source_storage_unavailable'};}
  };
  vm.runInContext(workerFunction,workerContext);
  vm.runInContext(worker.slice(worker.indexOf('function originOf('),worker.indexOf('async function probeCommittedDocument(')),workerContext);
  vm.runInContext(worker.slice(worker.indexOf('async function executeCommand('),worker.indexOf('async function waitForPageLocator(')),workerContext);
  const params=value=>({operationId:`worker-${++nextOperation}`,generation:'generation-a',taskId:'task-a',targetOrigin:'https://page.test',approved:true,...value});
  return {writes,messages,send,storage,run:value=>workerContext.runClipboardOperation('clipboard.write',params(value)),
    dispatch:value=>workerContext.executeCommand('clipboard.write',{mutation:true,tabId:42,allowedOrigins:['https://page.test'],...params(value)})};
}

test('HTML and text are written as one item, with metadata returned and no automatic paste',async()=>{
  const f=fixture(),formats=[format('text/html','<h2>日本語</h2>'),format('text/plain','日本語')];
  const result=await f.run({formats});assert.equal(f.writes.length,1);assert.equal(f.writes[0].length,1);
  assert.equal(await f.writes[0][0].data['text/html'].text(),'<h2>日本語</h2>');
  assert.equal(await f.writes[0][0].data['text/plain'].text(),'日本語');
  assert.equal(result.size,Buffer.byteLength('<h2>日本語</h2>日本語'));assert.equal(result.writeAcknowledged,true);assert.equal(result.pasteVerified,false);
  assert.equal(JSON.stringify(result).includes('dataBase64'),false);assert.equal(f.messages[0].taskId,'task-a');assert.equal(f.messages[0].targetOrigin,'https://page.test');
});

test('MIME writes validate both the public schema and execution boundary before dispatch',async()=>{
  const invalid=[{}, {formats:[format('text/html','a')],approved:false}, {text:'a',formats:[format('text/html','a')]},
    {formats:[format('image/jpeg','a')]}, {formats:[format('text/plain','a'),format('text/plain','b')]},
    {formats:[]}, {formats:[{mimeType:'text/html',dataBase64:'%%%'}]}];
  for(const params of invalid){
    const f=fixture();await assert.rejects(f.run(params),e=>e.details?.mutationDispatchAttempted===false && e.details.operationEffectState==='none');assert.equal(f.writes.length,0);assert.equal(f.messages.length,0);
  }
  for(const params of invalid) assert.equal(schema.safeParse({method:'clipboard.write',params}).success,false);
  assert.equal(schema.safeParse({method:'clipboard.write',params:{text:''}}).success,true);
  assert.equal(schema.safeParse({method:'clipboard.write',params:{formats:[format('image/png','png')],approved:true}}).success,true);
});

test('combined decoded MIME bytes are limited to 2 MiB, including all representations',async()=>{
  const f=fixture();const large=format('text/plain',Buffer.alloc(MAX_CLIPBOARD_BINARY_BYTES,65));
  assert.equal(schema.safeParse({method:'clipboard.write',params:{formats:[large],approved:true}}).success,true);
  assert.equal((await f.run({formats:[large]})).size,MAX_CLIPBOARD_BINARY_BYTES);assert.equal(f.writes.length,1);
  await assert.rejects(f.run({formats:[large,format('text/html','x')]}),{code:'clipboard_payload_too_large'});assert.equal(f.writes.length,1);
  const direct=await f.send({kind:'offscreen.clipboard.binary.write',taskId:'task-a',targetOrigin:'https://page.test',optIn:true,formats:[large,format('text/html','x')]});
  assert.equal(direct.code,'clipboard_payload_too_large');assert.equal(direct.details.operationEffectState,'none');assert.equal(f.writes.length,1);
});

test('offscreen blocks foreign/content-script senders and missing bindings before writing',async()=>{
  const f=fixture(),message={kind:'offscreen.clipboard.binary.write',taskId:'task-a',targetOrigin:'https://page.test',optIn:true,formats:[format('text/html','a')]};
  for(const sender of [{id:'foreign-extension'},{id:'own-extension',tab:{id:1}}])assert.equal((await f.send(message,sender)).ignored,true);
  for(const [field,value,code] of [['taskId','', 'clipboard_task_binding_required'],['targetOrigin','file:///tmp/a','clipboard_origin_binding_required'],['optIn',false,'clipboard_binary_opt_in_required']]){
    const result=await f.send({...message,[field]:value});assert.equal(result.code,code);assert.equal(result.details.mutationDispatchAttempted,false);
  }
  assert.equal(f.writes.length,0);
});

test('unsupported browser MIME is known no effect; rejected or lost write acknowledgement is unknown and never retried',async()=>{
  const unsupported=fixture({unsupported:true});await assert.rejects(unsupported.run({formats:[format('image/png','x')]}),e=>e.code==='clipboard_write_mime_unsupported'&&e.details.mutationDispatchAttempted===false);assert.equal(unsupported.writes.length,0);
  for(const options of [{writeRejects:true},{acknowledgementLost:true},{wrongBinding:true}]){
    const f=fixture(options);await assert.rejects(f.run({formats:[format('text/html','<p>日本語</p>')]}),e=>e.code==='clipboard_write_result_unknown'&&e.details.operationEffectState==='unknown'&&e.details.retryWrite===false);assert.equal(f.writes.length,1);
  }
});

test('text clipboard accepts exactly 100000 UTF-16 units and rejects excess before offscreen dispatch',async()=>{
  const accepted=fixture(),text='😀'.repeat(50000);
  const result=await accepted.run({text});assert.equal(result.chars,100000);assert.equal(accepted.writes.length,1);
  const excess=fixture();await assert.rejects(excess.run({text:text+'x'}),error=>error.code==='clipboard_payload_too_large'&&error.details.operationEffectState==='none'&&error.details.mutationDispatchAttempted===false);
  assert.equal(excess.messages.length,0);assert.equal(excess.writes.length,0);assert.equal(excess.storage.size,0);
  const direct=await excess.send({kind:'offscreen.clipboard.write',taskId:'task-a',targetOrigin:'https://page.test',text:text+'x'});
  assert.equal(direct.details.operationEffectState,'none');assert.equal(excess.writes.length,0);assert.equal(excess.storage.size,0);
});

test('MIME ACK requires exact terminal metadata and complete task/origin/generation/payload binding',async()=>{
  for(const mutate of [
    result=>({...result,binary:false}),
    result=>({...result,sourceReceipt:{...result.sourceReceipt,ack:{...result.sourceReceipt.ack,binary:false}}}),
    result=>({...result,sourceReceipt:{...result.sourceReceipt,ack:{...result.sourceReceipt.ack,size:999}}}),
    result=>({...result,sourceReceipt:{...result.sourceReceipt,ack:{...result.sourceReceipt.ack,formats:[]}}}),
    ...['taskId','targetOrigin','generation','payloadSha256','operationId'].map(field=>result=>({...result,sourceReceipt:{...result.sourceReceipt,sourceBinding:{...result.sourceReceipt.sourceBinding,[field]:'other'}}})),
  ]){
    const f=fixture({mutateAck:mutate});
    await assert.rejects(f.run({formats:[format('text/html','<p>Bound</p>')]}),error=>error.code==='clipboard_write_result_unknown'&&error.details.operationEffectState==='unknown'&&error.details.retryWrite===false);
    assert.equal(f.writes.length,1);assert.equal(f.messages.length,1);
  }
});

test('actual clipboard dispatcher rejects live-origin mismatch before offscreen write',async()=>{
  for(const options of [{liveUrl:'https://foreign.test/body'},{}]){
    const f=fixture(options);
    await assert.rejects(f.dispatch({text:'Bound',...(options.liveUrl?{}:{targetOrigin:'https://other.test'})}),error=>['target_origin_not_allowed','target_origin_mismatch'].includes(error.code));
    assert.equal(f.writes.length,0);assert.equal(f.messages.length,0);assert.equal(f.storage.size,0);
  }
  const valid=fixture();assert.equal((await valid.dispatch({text:'Bound'})).written,true);assert.equal(valid.writes.length,1);
});

test('worker accepts exact compacted text/MIME receipts as historical ACK with no new write or paste claim',async()=>{
  for(const payload of [{text:'Bound'},{formats:[format('text/plain','Bound'),format('text/html','<b>Bound</b>')]}]) {
    const f=fixture(),first=await f.run(payload),binding=first.sourceReceipt.sourceBinding;
    for(let index=1;index<512;index++)f.storage.set(`companion.clipboard.source.v1:seed-${index}`,
      {...first.sourceReceipt,sourceBinding:{...binding,operationId:`seed-${index}`}});
    await f.run({text:'new'});
    const result=await f.run({...payload,operationId:binding.operationId});
    assert.equal(result.compacted,true);assert.equal(result.written,false);assert.equal(result.writeAcknowledged,true);
    assert.equal(result.acknowledgedHistorical,true);assert.equal(result.pasteVerified,false);assert.equal(result.contentReturned,false);
    assert.equal(result.mutationDispatchAttempted,false);assert.equal(f.writes.length,2);
    assert.equal(result.sourceReceipt.ack,undefined);
  }
});

test('local MIME files materialize before signing and keep filesystem paths out of the command',async()=>{
  const directory=await mkdtemp(join(tmpdir(),'aos-clipboard-file-test-'));
  try {
    const filePath=join(directory,'日本語.html'),body='<h2>見出し 👩🏽‍💻</h2>';await writeFile(filePath,body);
    const action=schema.parse({method:'clipboard.write',params:{formats:[{mimeType:'text/html',filePath},format('text/plain','見出し')],approved:true}});
    const [prepared]=await materializeTransactionActions([action]);
    assert.equal(Buffer.from(prepared.params.formats[0].dataBase64,'base64').toString('utf8'),body);assert.equal('filePath' in prepared.params.formats[0],false);
    const f=fixture();assert.equal((await f.run(prepared.params)).written,true);assert.equal(f.writes.length,1);
    assert.equal(schema.safeParse({method:'clipboard.write',params:{approved:true,formats:[{mimeType:'text/html',filePath,dataBase64:'YQ=='}]}}).success,false);
  } finally {await rm(directory,{recursive:true,force:true});}
});

test('MIME file preparation rejects missing, relative, symlink, non-regular, empty and oversized sources without a browser command',async()=>{
  const directory=await mkdtemp(join(tmpdir(),'aos-clipboard-file-boundary-'));
  try {
    const local=join(directory,'source.txt'),link=join(directory,'link.txt'),empty=join(directory,'empty.txt'),large=join(directory,'large.txt');
    await writeFile(local,'source');await symlink(local,link);await writeFile(empty,'');await writeFile(large,Buffer.alloc(MAX_CLIPBOARD_BINARY_BYTES+1));
    for(const filePath of ['relative.txt',join(directory,'missing.txt'),link,directory,empty,large]) {
      await assert.rejects(materializeTransactionActions([{method:'clipboard.write',params:{approved:true,formats:[{mimeType:'text/plain',filePath}]}}]),error=>error.details.operationEffectState==='none'&&error.details.mutationDispatchAttempted===false);
    }
    await assert.rejects(materializeTransactionActions([{method:'clipboard.write',params:{approved:true,formats:[{mimeType:'text/plain',filePath:local,dataBase64:'YQ=='}]}}]),{code:'clipboard_write_payload_invalid'});
  } finally {await rm(directory,{recursive:true,force:true});}
});
