import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {createHash} from 'node:crypto';
import {join} from 'node:path';
import test from 'node:test';
import {CompanionError,normalizeError} from '../src/shared/errors.mjs';
const source=await readFile(new URL('../scripts/soak-readonly.mjs',import.meta.url),'utf8');
const start=source.indexOf('async function browserSample('),end=source.indexOf('\nasync function main()',start);
const AsyncFunction=Object.getPrototypeOf(async function(){}).constructor;
const run=new AsyncFunction('env',`with(env){${source.slice(start,end)};return browserSample({taskId:'fixture-task',origin:'http://127.0.0.1:1234',marker:'marker',runId:'run',outputDir:'.',index:1,appDir:'.'});}`);
function env({openError=false,blocked=false,cleanupError=false}={}){
 const wrap=result=>({structuredContent:{result},content:[]});
 class Client {async connect(){}async close(){}async callTool({name}){
   if(name==='companion_status')return wrap({profiles:[{connected:true,generation:'gen'}],clientOwnedLogicalSessionIds:[],clientOwnedExactTabLeaseIds:[]});
   if(name==='companion_open_session')return openError?{isError:true,content:[{type:'text',text:JSON.stringify({code:'profile_not_connected',message:'original diagnostic'})}]}:wrap({sessionId:'session'});
   if(name==='companion_close_session')return wrap({cleanup_receipt:{status:cleanupError?'partial':'completed',closed:cleanupError?[]:[7],skipped:cleanupError?[{tabId:7,reason:'leased'}]:[],retained:[]}});
   const raw=wrap({result:blocked?'blocked':'verified',tab:{id:7},actions:[{method:'page.query',result:{text:'marker'}}],exact_blocker:blocked?{code:'semantic_locator_not_found',message:'specific target'}:null,failed_step:blocked?{index:0,effect_state:'known_no_effect'}:null});
   raw.content=[{type:'image',data:Buffer.from('fixture screenshot').toString('base64')}];return raw;
 }}
 return {Client,StdioClientTransport:class {async close(){}},CompanionError,normalizeError,join,createHash,writeFile:async()=>{}};
}
test('soak preserves the actual text-only MCP error code and failed tool',async()=>{
 const s=await run(env({openError:true}));assert.equal(s.error.code,'profile_not_connected');assert.equal(s.error.message,'original diagnostic');assert.equal(s.error.details.tool,'companion_open_session');assert.equal(s.verified,false);assert.equal(s.stop,true);
});
test('soak keeps a blocked transaction cause and failed step instead of only a generic read error',async()=>{
 const s=await run(env({blocked:true}));assert.equal(s.transactionFailure.exactBlocker.code,'semantic_locator_not_found');assert.equal(s.transactionFailure.failedStep.index,0);assert.equal(s.transactionFailure.tabId,7);assert.equal(s.verified,false);assert.equal(s.error.code,'soak_browser_readback_not_verified');
});
test('soak retains terminal cleanup reasons and fails the sample',async()=>{
 const s=await run(env({cleanupError:true}));assert.deepEqual(s.cleanup.skipped,[{tabId:7,reason:'leased'}]);assert.equal(s.cleanup.status,'partial');assert.equal(s.cleanupError.code,'soak_cleanup_not_verified');assert.equal(s.verified,false);assert.equal(s.stop,true);
});
