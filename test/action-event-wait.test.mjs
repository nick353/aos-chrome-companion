import assert from 'node:assert/strict';
import test from 'node:test';
import { JavaScriptDialogs } from '../extension/javascript-dialog.js';
import { executeWithExpectedDialog, expectedActionEvent } from '../extension/action-event-wait.js';
import { DebuggerSessionPool } from '../extension/page-observation.js';
import { ACTION_EVENT_CONTRACT } from '../src/shared/operation-schema.mjs';
import { ACTION_EVENT_CONTRACT as extensionContract } from '../extension/operation-schema.generated.js';

const owner = { taskId:'task', sessionId:'session', generation:'generation', operationId:'op-1', tabId:7 };
function fixture() {
  const listeners = [], calls = [], emitted = [];
  const api = { onEvent:{addListener:fn=>listeners.push(fn)}, onDetach:{addListener:()=>{}},
    attach:async()=>calls.push('attach'), detach:async()=>calls.push('detach') };
  const dialogs = new JavaScriptDialogs({ debuggerApi:api, pool:new DebuggerSessionPool(api),
    sendCommand:async(_target,method)=>{calls.push(method);return {};}, redactText:text=>({text}) });
  const open = (source={tabId:7}) => listeners.forEach(fn=>fn(source,'Page.javascriptDialogOpening',{
    type:'confirm',message:'Continue?',url:'https://example.test/',hasBrowserHandler:true,
  }));
  const run = (execute, params={}, method='page.click') => executeWithExpectedDialog({method,
    params:{...owner,expectEvent:{type:'dialog',timeoutMs:100},...params}, dialogs,
    prepare:async()=>calls.push('prepare'), execute, emit:event=>emitted.push(event) });
  return {dialogs,calls,emitted,open,run};
}
test('a synchronous opening is emitted while the original trigger remains pending, then its result settles once', async()=>{
  const f=fixture(); let release, dispatched=0, settled=false;
  try {
    const action=f.run(()=>{dispatched++;assert.ok(f.dialogs.records.get(7).actionWaiter);f.open();return new Promise(resolve=>{release=resolve;});}).then(value=>{settled=true;return value;});
    await new Promise(resolve=>setImmediate(resolve));
    assert.equal(settled,false);assert.equal(dispatched,1);assert.equal(f.emitted.length,1);
    assert.equal(f.emitted[0].operationId,owner.operationId);assert.equal(f.emitted[0].kind,'dialog');
    assert.equal(f.dialogs.records.get(7).actionWaiter,null);
    release({clicked:true});const result=await action;assert.equal(result.clicked,true);assert.equal(result.eventWait.observed,true);
    assert.equal(f.calls.filter(value=>value==='Page.enable').length,1);assert.equal(dispatched,1);
  }finally{await f.dialogs.stopAll('test_finished');}
});
test('already-open and foreign-owner observations reject before the new trigger',async()=>{
  const f=fixture();let dispatched=0;
  try {
    await f.dialogs.inspect(7,owner);f.open();
    await assert.rejects(f.run(()=>{dispatched++;return {};}),{code:'javascript_dialog_already_open'});
    await assert.rejects(f.run(()=>{dispatched++;return {};},{taskId:'foreign'}),{code:'dialog_observation_not_owned'});
    assert.equal(dispatched,0);
  }finally{await f.dialogs.stopAll('test_finished');}
});
test('foreign events and missing events cannot satisfy the wait or replay a completed trigger',async()=>{
  const f=fixture();let dispatched=0;
  try {
    const result=await f.run(()=>{dispatched++;f.open({tabId:8});f.open({tabId:7,sessionId:'child'});return {clicked:true};});
    assert.equal(result.eventWait.observed,false);assert.equal(result.eventWait.exact_blocker,'action_event_timeout');
    assert.equal(dispatched,1);assert.equal(f.emitted.length,0);assert.equal(f.dialogs.records.get(7).actionWaiter,null);
  }finally{await f.dialogs.stopAll('test_finished');}
});
test('trigger failure removes its wait, session stop wakes it, and the generated request contract matches the broker',async()=>{
  assert.deepEqual(extensionContract,ACTION_EVENT_CONTRACT);
  for(const value of [{type:'download'},{type:'dialog',accept:true},{type:'dialog',timeoutMs:0},null]) {
    assert.throws(()=>expectedActionEvent('page.click',value),error=>error.code==='action_event_invalid'&&error.details.mutationDispatchAttempted===false);
  }
  assert.throws(()=>expectedActionEvent('page.query',{type:'dialog'}),{code:'action_event_invalid'});
  const f=fixture();try {
    await assert.rejects(f.run(()=>{throw Error('original failure');}),/original failure/);
    assert.equal(f.dialogs.records.get(7).actionWaiter,null);
    const wait=await f.dialogs.expectOpening(7,owner,15000);
    await f.dialogs.stopForSession(owner.sessionId,owner.generation);assert.equal(await wait.promise,null);
    assert.equal(f.dialogs.records.size,0);
  }finally{await f.dialogs.stopAll('test_finished');}
});
