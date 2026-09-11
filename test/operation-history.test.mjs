import assert from 'node:assert/strict';
import test from 'node:test';
import { operationHistory } from '../src/shared/operation-history.mjs';
const entry=(i,taskId='task',profileInstanceId='profile')=>({operationId:'op-'+i,idempotencyKey:'key-'+i,preparedAt:new Date(1000*i).toISOString(),state:'applied',effectState:'known_effect',dispatchCount:1,
 binding:{taskId,profileInstanceId,method:'page.type',runId:'run',tabId:7},params:{text:'private text'},result:{dataBase64:'private bytes'},fingerprint:'private fingerprint'});
const scope={taskId:'task',profileInstanceId:'profile',limit:2};
test('history filters exact owner and profile and projects no page or clipboard payloads',()=>{
 const result=operationHistory([entry(1),entry(2,'foreign'),entry(3,'task','foreign')],scope,'secret');
 assert.deepEqual(result.rows.map(r=>r.operationId),['op-1']);assert.equal(result.historyOnly,true);
 assert.doesNotMatch(JSON.stringify(result),/private text|private bytes|private fingerprint|params/);
});
test('signed history pagination preserves order when newer entries arrive and rejects changed ownership or filters',()=>{
 const records=[entry(1),entry(2),entry(3),entry(4)],first=operationHistory(records,scope,'secret');
 assert.deepEqual(first.rows.map(r=>r.operationId),['op-4','op-3']);
 const second=operationHistory([...records,entry(5)],{...scope,cursor:first.nextCursor},'secret');
 assert.deepEqual(second.rows.map(r=>r.operationId),['op-2','op-1']);assert.equal(second.nextCursor,null);
 for(const changed of [{taskId:'foreign'},{profileInstanceId:'foreign'},{runId:'other'}])assert.throws(()=>operationHistory(records,{...scope,...changed,cursor:first.nextCursor},'secret'),/unchanged cursor/);
 assert.throws(()=>operationHistory(records,{...scope,cursor:first.nextCursor},'other-secret'),/unchanged cursor/);
});
test('history filters preserve unknown reconciliation and do not claim workflow completion',()=>{
 const unknown={...entry(1),state:'unknown_effect',effectState:'unknown_effect'};
 const result=operationHistory([unknown,entry(2)],{...scope,state:'unknown_effect'},'secret');
 assert.equal(result.rows.length,1);assert.equal(result.rows[0].reconciliationRequired,true);assert.equal(result.provider_completion,'unverified');
});
