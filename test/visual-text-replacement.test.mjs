import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import test from 'node:test';
const source=await readFile(new URL('../extension/service-worker.js',import.meta.url),'utf8');
const start=source.indexOf('    if (method === "visual.typeText") {');
const end=source.indexOf('    throw companionError("capability_not_supported", `Unsupported trusted visual input:',start);
const AsyncFunction=Object.getPrototypeOf(async function(){}).constructor;
const type=new AsyncFunction('env',`with(env) { ${source.slice(start,end)} }`);
function fixture({selectedAll=true,committed=true}={}){
  const calls=[];
  const env={method:'visual.typeText',params:{text:'修正後 テスト住所 👩🏽‍💻',clear:true},tabId:7,target:{tabId:7},point:{x:30,y:40},virtualCursorShown:true,
    chrome:{runtime:{getPlatformInfo:async()=>({os:'mac'})}},dispatchMouseClick:async()=>calls.push('click'),
    companionError:(code,message,details)=>Object.assign(new Error(message),{code,details}),
    sendDebuggerCommand:async(target,method,params)=>calls.push({method,params}),
    runPageOperation:async(tabId,action)=>{calls.push(action);return action==='verifyTypeSelection'?{selectedAll}:{committed};}};
  return {env,calls};
}
test('visual replacement uses Chrome selectAll and verifies before inserting, without a separate delete',async()=>{
  const f=fixture();const result=await type(f.env);
  assert.equal(result.valueVerified,true);
  const down=f.calls.find(call=>call.method==='Input.dispatchKeyEvent');
  assert.deepEqual(down.params.commands,['selectAll']);assert.equal(down.params.windowsVirtualKeyCode,65);assert.equal(down.params.modifiers,4);
  assert.ok(f.calls.indexOf('verifyTypeSelection')<f.calls.findIndex(call=>call.method==='Input.insertText'));
  assert.equal(f.calls.at(-1),'verifyTypeValue');
  assert.ok(f.calls.every(call=>call.params?.key!=='Backspace'));
});
test('failed select-all does not insert replacement into the middle of an existing value',async()=>{
  const f=fixture({selectedAll:false});await assert.rejects(type(f.env),{code:'physical_input_selection_failed'});
  assert.ok(f.calls.every(call=>call.method!=='Input.insertText'));
});
test('a wrong physical replacement is not reported as typed or verified',async()=>{
  const f=fixture({committed:false});await assert.rejects(type(f.env),error=>error.code==='physical_input_not_committed'&&error.details.mutationDispatchAttempted===true);
  assert.equal(f.calls.filter(call=>call.method==='Input.insertText').length,1);
});
const semanticStart=source.indexOf('async function runAndCheckMutation('),semanticEnd=source.indexOf('async function runPageOperation(',semanticStart);
const semantic=new AsyncFunction('env',`with(env) { ${source.slice(semanticStart,semanticEnd)};return runAndCheckMutation(7,'type',{},{}); }`);
test('the normal semantic route cannot turn an uncommitted input into a verified transaction',async()=>{
  await assert.rejects(semantic({runPageOperation:async()=>({typed:false,semanticCommitted:false,valueLength:4,expectedValueLength:5}),assertLiveOrigin:async()=>{},companionError:(code,message,details)=>Object.assign(new Error(message),{code,details})}),{code:'semantic_input_not_committed'});
});
