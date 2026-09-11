import assert from 'node:assert/strict';
import test from 'node:test';
import {toolResult} from '../src/mcp/result.mjs';

function transaction({unknown=false}={}) {
  const screenshot={kind:'screenshot',mimeType:'image/jpeg',dataBase64:'aGVsbG8=',tabId:71,url:'https://owned.test/'};
  return {schema:'aos.chrome_companion.transaction.v1',result:unknown?'unknown_effect':'verified',run_id:'run-1',task_id:'task-1',
    profile:{profileInstanceId:'profile-1',generation:'generation-1'},tab:{id:71},pre:{url:'https://owned.test/',text_sha256:'before'},post:{url:'https://owned.test/',text_sha256:'after'},
    actions:[{index:0,method:'page.query',result:{matches:[{text:'本文 👩🏽‍💻',href:'https://owned.test/result'}]},step_packet:{target_identity:{proof:'detailed-binding'},reconciliation_required:false},before:{text_sha256:'before'},after:{text_sha256:'after'}}],
    ...(unknown?{applied_actions:[{index:0,method:'page.query',result:{matches:[{text:'本文 👩🏽‍💻'}]}}],failed_step:{index:1,effect_state:'unknown_effect'},action_progress:{applied_action_indices:[0],remaining_action_indices:[2],uncertain_action_indices:[1],replay_allowed:false},exact_blocker:{code:'operation_effect_unknown',message:'Read back without replay'},reconciliation:{required:true,operationId:'op-1'},continuation:{allowed:false}}:{}),
    effect_state:unknown?'unknown_effect':'known_no_effect',dispatch_count:unknown?2:1,external_action_executed:unknown?null:false,
    cleanup:{retained:true,lease_released:true,exact_blocker:{code:'cleanup_waits_for_readback'}},visual_readback:screenshot,
    artifacts:[{verified:true,path:'/tmp/owned-result.csv',bytes:16,sha256:'verified-digest'}],
    operation_timing:{schema:'aos.chrome_companion.operation_timing.v1',truncated:false,operations:[{method:'page.query',timings_ms:{queue:5,transport_and_extension:20}}]},
    step_packets:[{index:0,method:'page.query',mutation:false},{index:1,method:'page.submit',mutation:true,reconciliation_required:true}],
    capsule:{capsuleId:'capsule-1',state:unknown?'reconciliation_required':'completed',target:{sessionId:'session-1',tabId:71,pageInstanceId:'page-1'},effect:{effectState:unknown?'unknown_effect':'known_no_effect'},retention:{reason:'readback_required',requiredUserAction:null},visual:{lastScreenshot:screenshot},resources:{tabId:71}},
  };
}

test('summary text preserves real read results and artifacts, while full structured evidence remains unchanged',()=>{
  const input=transaction(),before=JSON.stringify(input),full=toolResult(input),summary=toolResult(input,{textDetail:'summary'});
  assert.deepEqual(summary.structuredContent,full.structuredContent);assert.equal(JSON.stringify(input),before);
  const text=JSON.parse(summary.content.find(block=>block.type==='text').text),details=summary.structuredContent.result;
  assert.deepEqual(text.actions[0].result,details.actions[0].result);assert.deepEqual(text.artifacts,details.artifacts);
  assert.deepEqual(details.operation_timing,input.operation_timing);assert.equal(text.operation_timing,undefined);
  assert.equal(text.capsule.target.pageInstanceId,'page-1');assert.deepEqual(text.cleanup,details.cleanup);assert.deepEqual(text.next_target_read.arguments,{sessionId:'session-1',tabId:71});
  assert.equal(details.actions[0].step_packet.target_identity.proof,'detailed-binding');assert.equal(text.actions[0].step_packet,undefined);assert.equal(text.full_result_available_in,'structuredContent.result');
  assert.equal(summary.content.filter(block=>block.type==='image').length,1);assert.equal(summary.content.filter(block=>block.type==='image')[0].data,'aGVsbG8=');
  assert.equal(JSON.stringify(text).includes('dataBase64'),false);assert.ok(JSON.stringify(text).length<JSON.stringify(details).length);
});

test('summary text never turns unknown actions into runnable remaining work or hides cleanup blockers',()=>{
  const result=toolResult(transaction({unknown:true}),{textDetail:'summary'}),full=result.structuredContent.result,text=JSON.parse(result.content.find(block=>block.type==='text').text);
  for(const key of ['result','effect_state','dispatch_count','action_progress','failed_step','exact_blocker','reconciliation','continuation','cleanup','applied_actions','external_action_executed','external_effect_confirmation']) {
    assert.deepEqual(text[key],full[key],key);
  }
  assert.deepEqual(text.action_progress.remaining_action_indices,[2]);assert.deepEqual(text.action_progress.uncertain_action_indices,[1]);assert.equal(text.capsule.state,'reconciliation_required');
});

test('full text stays backward compatible and fresh inspection proofs are never summarized',()=>{
  const full=toolResult(transaction(),{textDetail:'full'});assert.deepEqual(JSON.parse(full.content.find(block=>block.type==='text').text),full.structuredContent.result);
  const inspection={kind:'visual_target_confirmation',visualProof:{signature:'opaque-exact-proof',point:{x:40,y:60}},visual_readback_verified:true};
  const summary=toolResult(inspection,{textDetail:'summary'});assert.deepEqual(JSON.parse(summary.content.find(block=>block.type==='text').text),summary.structuredContent.result);assert.equal(summary.structuredContent.result.visualProof.signature,'opaque-exact-proof');
});
