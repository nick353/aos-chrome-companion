import assert from 'node:assert/strict';
import test from 'node:test';
import {JavaScriptDialogs} from '../extension/javascript-dialog.js';
import {DebuggerSessionPool} from '../extension/page-observation.js';
const owner={taskId:'task-a',sessionId:'session-a',generation:'gen-a'};
const origin='https://page.test';
function fixture({closed='normal',enable='normal'}={}) {
  const events=new Set(),detaches=new Set(),calls=[];let serial=0;
  const api={onEvent:{addListener:fn=>events.add(fn)},onDetach:{addListener:fn=>detaches.add(fn)},
    attach:async target=>calls.push(['attach',target.tabId]),detach:async target=>calls.push(['detach',target.tabId])};
  const emit=(method,params,source={tabId:7})=>{for(const fn of events)fn(source,method,params);};
  const open=(params={},source)=>emit('Page.javascriptDialogOpening',{type:'prompt',message:'Label',url:origin+'/',frameId:'frame-main',defaultPrompt:'never-return-default',hasBrowserHandler:true,...params},source);
  const dialogs=new JavaScriptDialogs({debuggerApi:api,pool:new DebuggerSessionPool(api),uuid:()=>String(++serial),redactText:text=>({text}),eventTimeoutMs:30,enableTimeoutMs:30,
    sendCommand:async(target,method,params)=>{
      calls.push([method,target.tabId,params]);
      if(method==='Page.enable'){
        if(enable==='pending')return new Promise(()=>{});
        if(enable==='opens-while-pending'){open();return new Promise(()=>{});}
      }
      if(method==='Page.handleJavaScriptDialog'){
        if(closed==='error')throw Error('never echo prompt text in transport error');
        if(closed!=='missing')emit('Page.javascriptDialogClosed',{frameId:closed==='wrong-frame'?'foreign':'frame-main',result:closed==='wrong-result'?!params.accept:params.accept,userInput:closed==='wrong-input'?'wrong':params.promptText??''});
        if(closed==='next-dialog')open({message:'Next question'});
      }
      return {};
    }});
  const inspect=()=>dialogs.inspect(7,owner);
  const handle=async(params={})=>{const snapshot=await inspect();return dialogs.handle(7,owner,{expectedDialogId:snapshot.dialogId,pageInstanceId:snapshot.pageInstanceId,expectedMessage:'Label',accept:true,promptText:'日本語 👩🏽‍💻',allowedOrigins:[origin],...params});};
  return {calls,dialogs,inspect,open,emit,handle,detaches,stop:()=>dialogs.stopAll('test_finished')};
}
test('observation spans inspect, already-open modal and close; the modal path never enables Page again',async()=>{
  const f=fixture();try{
    assert.equal((await f.inspect()).present,false);f.open();const before=await f.inspect();const second=await f.inspect();
    assert.equal(before.dialogId,second.dialogId);assert.equal(before.promptTextRequired,true);assert.equal(before.requiresUser,false);
    assert.doesNotMatch(JSON.stringify(before),/never-return-default/);
    const result=await f.handle();assert.equal(result.closedVerified,true);assert.equal(result.accepted,true);assert.equal(result.promptTextReturned,false);
    assert.doesNotMatch(JSON.stringify(result),/日本語/);assert.equal((await f.inspect()).present,false);
    assert.equal(f.calls.filter(c=>c[0]==='Page.enable').length,1);assert.equal(f.calls.filter(c=>c[0]==='Page.handleJavaScriptDialog').length,1);
    assert.deepEqual(await f.dialogs.stop(7,owner),{observing:false,stopped:true});assert.equal(f.calls.filter(c=>c[0]==='detach').length,1);
  }finally{await f.stop();}
});
test('prompt empty input and cancellation, alert, confirm and beforeunload verify the exact close event',async()=>{
  for(const options of [
    {type:'prompt',accept:true,promptText:''},{type:'prompt',accept:false},
    {type:'alert',accept:true},{type:'confirm',accept:false},{type:'beforeunload',message:'',accept:false},
  ]){
    const f=fixture();try{await f.inspect();f.open(options);const snapshot=await f.inspect();
      const result=await f.dialogs.handle(7,owner,{expectedDialogId:snapshot.dialogId,pageInstanceId:snapshot.pageInstanceId,expectedMessage:options.message??'Label',allowedOrigins:[origin],...options});
      assert.equal(result.closedVerified,true);assert.equal(result.accepted,options.accept);
    }finally{await f.stop();}
  }
});
test('unobserved, replaced or mismatched dialogs do not dispatch a response',async()=>{
  const f=fixture();try{
    await assert.rejects(f.handle(),error=>error.code==='javascript_dialog_not_observed'&&error.details.mutationDispatchAttempted===false);
    f.open();const first=await f.inspect();f.emit('Page.javascriptDialogClosed',{frameId:'frame-main',result:false,userInput:''});f.open();
    for(const [params,code] of [[{expectedDialogId:first.dialogId},'javascript_dialog_identity_mismatch'],[{expectedMessage:'Different'},'javascript_dialog_mismatch'],[{expectedType:'confirm'},'javascript_dialog_mismatch'],[{allowedOrigins:['https://other.test']},'javascript_dialog_origin_not_allowed']]){
      await assert.rejects(f.handle(params),error=>error.code===code&&error.details.operationEffectState==='none');
    }
    assert.equal(f.calls.filter(c=>c[0]==='Page.handleJavaScriptDialog').length,0);
  }finally{await f.stop();}
});
test('prompt input must be explicit and applies only to accepting a prompt',async()=>{
  const f=fixture();try{await f.inspect();f.open();const snapshot=await f.inspect();const base={expectedDialogId:snapshot.dialogId,pageInstanceId:snapshot.pageInstanceId,expectedMessage:'Label',accept:true,allowedOrigins:[origin]};
    await assert.rejects(f.dialogs.handle(7,owner,base),{code:'dialog_prompt_text_required'});
    await assert.rejects(f.dialogs.handle(7,owner,{...base,promptText:'x'.repeat(10001)}),{code:'dialog_prompt_text_required'});
    await assert.rejects(f.dialogs.handle(7,owner,{...base,accept:false,promptText:'unused'}),{code:'dialog_prompt_text_not_applicable'});
    assert.equal(f.calls.filter(c=>c[0]==='Page.handleJavaScriptDialog').length,0);
  }finally{await f.stop();}
});
test('sensitive dialogs keep text local and require user handling',async()=>{
  for(const message of ['Enter OTP 123456','本人確認の認証コード 123456','Payment confirmation']){
    const f=fixture();try{await f.inspect();f.open({message});const result=await f.inspect();assert.equal(result.requiresUser,true);assert.equal(result.messageExactAvailable,false);assert.doesNotMatch(result.message,/123456/);
      await assert.rejects(f.handle({expectedMessage:message}),{code:'sensitive_dialog_user_required'});assert.equal(f.calls.filter(c=>c[0]==='Page.handleJavaScriptDialog').length,0);
    }finally{await f.stop();}
  }
});
test('foreign task/session/generation, child targets and foreign tabs cannot enter the observation',async()=>{
  const f=fixture();try{await f.inspect();f.open({}, {tabId:8});f.open({}, {tabId:7,sessionId:'child'});assert.equal((await f.inspect()).present,false);
    for(const change of [{taskId:'foreign'},{sessionId:'foreign'},{generation:'foreign'}])await assert.rejects(f.dialogs.inspect(7,{...owner,...change}),{code:'dialog_observation_not_owned'});
    await f.dialogs.stopForSession(owner.sessionId,'foreign');assert.equal(f.dialogs.records.size,1);
    await f.dialogs.stopForSession(owner.sessionId,owner.generation);assert.equal(f.dialogs.records.size,0);
  }finally{await f.stop();}
});
test('missing, wrong or failed close evidence remains unknown after exactly one response dispatch',async()=>{
  for(const closed of ['missing','wrong-frame','wrong-result','wrong-input','error']){
    const f=fixture({closed});try{await f.inspect();f.open();await assert.rejects(f.handle(),error=>error.details.operationEffectState==='unknown'&&error.details.mutationDispatchAttempted===true);
      assert.equal(f.calls.filter(c=>c[0]==='Page.handleJavaScriptDialog').length,1);
    }finally{await f.stop();}
  }
});
test('a follow-on dialog has a new identity and remains observed without automatic response',async()=>{
  const f=fixture({closed:'next-dialog'});try{await f.inspect();f.open();const first=await f.inspect();const result=await f.handle();assert.equal(result.nextDialogPresent,true);
    const next=await f.inspect();assert.equal(next.message,'Next question');assert.notEqual(first.dialogId,next.dialogId);
    await assert.rejects(f.dialogs.stop(7,owner),{code:'javascript_dialog_pending'});assert.equal(f.calls.filter(c=>c[0]==='Page.handleJavaScriptDialog').length,1);
  }finally{await f.stop();}
});
test('Page.enable timeout is bounded without replay; an opening event can resolve a renderer-blocked enable',async()=>{
  const unavailable=fixture({enable:'pending'});await assert.rejects(unavailable.inspect(),{code:'dialog_observation_start_timeout'});assert.equal(unavailable.dialogs.records.size,0);assert.equal(unavailable.calls.filter(c=>c[0]==='detach').length,1);
  const pending=fixture({enable:'opens-while-pending'});try{assert.equal((await pending.inspect()).present,true);assert.equal((await pending.handle()).closedVerified,true);}finally{await pending.stop();}
});
test('debugger detach interrupts a pending response as unknown and removes the record',async()=>{
  const f=fixture({closed:'missing'});try{await f.inspect();f.open();const handling=f.handle();await new Promise(ok=>setImmediate(ok));for(const detach of f.detaches)detach({tabId:7});
    await assert.rejects(handling,error=>error.details.operationEffectState==='unknown');assert.equal(f.dialogs.records.size,0);
  }finally{await f.stop();}
});
