import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import vm from 'node:vm';
import { toolResult, taskStatus } from '../src/mcp/result.mjs';
import { transactionActionSchema } from '../src/mcp/action-schema.mjs';
import * as z from 'zod/v4';

const source = await readFile(new URL('../extension/service-worker.js', import.meta.url), 'utf8');
function screenshotFixture(hooks = {}) {
  let active = 101, url = 'https://owned.example/', captures = 0;
  const events = { activated: new Set(), updated: new Set() };
  const event = key => ({ addListener: fn => events[key].add(fn), removeListener: fn => events[key].delete(fn) });
  const api = {
    switchTo(id) { active = id; for (const fn of events.activated) fn({ windowId: 1, tabId: id }); },
    navigate() { url = 'https://owned.example/next'; for (const fn of events.updated) fn(101, { url }); },
    get captures() { return captures; }, get active() { return active; },
  };
  const context = { DEFAULT_SCREENSHOT_QUALITY: 60, MAX_SCREENSHOT_BYTES: 1000000, MIN_SCREENSHOT_QUALITY: 20,
    companionError: (code,message) => Object.assign(new Error(message), {code}),
    waitForScreenshotSlot: async () => hooks.wait?.(api),
    chrome: { tabs: {
      onActivated: event('activated'), onUpdated: event('updated'),
      get: async id => ({ id, windowId: 1, url, title: 'Owned', status: 'complete' }),
      query: async () => [{ id: active }], update: async id => api.switchTo(id),
      captureVisibleTab: async () => { captures++; await hooks.capture?.(api); return 'data:image/jpeg;base64,aGVsbG8='; },
    } },
  };
  vm.createContext(context);
  const a = source.indexOf('function screenshotBytes(');
  const b = source.indexOf('\nasync function ', source.indexOf('async function captureExactTabScreenshot(',a)+10);
  vm.runInContext(source.slice(a,b),context);
  return { run: () => context.captureExactTabScreenshot(101), api };
}
test('capture succeeds only for the unchanged exact target', async () => {
  const f=screenshotFixture();const result=await f.run();assert.equal(result.tabId,101);assert.equal(result.dataBase64,'aGVsbG8=');assert.equal(f.api.captures,1);
});
test('capture rejects a tab switch during the screenshot slot wait before taking an image', async () => {
  const f=screenshotFixture({ wait: api => api.switchTo(202) });
  await assert.rejects(f.run(),{code:'screenshot_target_changed'});assert.equal(f.api.captures,0);assert.equal(f.api.active,202);
});
test('capture rejects a switch away and back during capture', async () => {
  const f=screenshotFixture({ capture: api => { api.switchTo(202);api.switchTo(101); } });
  await assert.rejects(f.run(),{code:'screenshot_target_changed'});
});
test('capture rejects navigation during capture', async () => {
  const f=screenshotFixture({ capture: api => api.navigate() });await assert.rejects(f.run(),{code:'screenshot_target_changed'});
});
test('transient image readback is retried once and only on the unchanged target', async () => {
  const f=screenshotFixture({capture: api => {if(api.captures===1)throw new Error('Failed to capture tab: image readback failed');}});
  await f.run();assert.equal(f.api.captures,2);
  const failing=screenshotFixture({capture:()=>{throw new Error('image readback failed');}});
  await assert.rejects(failing.run(),/image readback failed/);assert.equal(failing.api.captures,2);
});
test('ambiguous dropdown remains a refinable locator error, not an unsupported-control handoff', async () => {
  const a=source.indexOf('  if (action === "inspectDropdown") {');const b=source.indexOf('\n  if (action === ',a+10);
  const branch=source.slice(a,b);
  const context={ action:'inspectDropdown',payload:{locator:{label:'Choice'}},location:{href:'https://owned.example/'},find:()=>{throw Object.assign(new Error('matched 4'),{code:'semantic_locator_ambiguous',details:{candidates:[{role:'combobox',name:'Choice'}]}});} };
  const result=vm.runInNewContext(`(()=>{${branch}})()`,context);
  assert.equal(result.supported,null);assert.equal(result.exact_blocker,'semantic_locator_ambiguous');assert.equal(result.surface_handoff_candidate,false);assert.equal(result.candidates[0].role,'combobox');
});
test('nested transaction images are native MCP blocks without base64 in text or structured metadata', () => {
  const screenshot={kind:'screenshot',mimeType:'image/jpeg',dataBase64:'aGVsbG8=',tabId:101};
  const result=toolResult({schema:'aos.chrome_companion.transaction.v1',visual_readback:screenshot,other:{visual:screenshot}});
  assert.equal(result.content.filter(x=>x.type==='image').length,1);assert.ok(!result.content.find(x=>x.type==='text').text.includes('dataBase64'));assert.equal(result.structuredContent.result.visual_readback.tabId,101);
});
test('dispatch is not reported as confirmed external completion', () => {
  const result=toolResult({schema:'aos.chrome_companion.transaction.v1',result:'verified',external_action_executed:true,actions:[{step_packet:{reconciliation_required:true},result:{trustedInput:true}}],capsule:{effect:{externalActionExecuted:true}}}).structuredContent.result;
  assert.equal(result.external_action_executed,null);assert.equal(result.external_action_dispatched,true);assert.equal(result.potential_external_effect,true);assert.equal(result.capsule.effect.externalActionExecuted,null);assert.equal(result.external_effect_confirmation,'not_verified');
});
test('default status excludes foreign history while preserving global activity counts', () => {
  const foreign=Array.from({length:1000},(_,i)=>({taskId:`foreign-${i}`,signature:'opaque'}));
  const source={logicalSessionCount:1001,logicalSessions:[...foreign,{taskId:'mine'}],recoveryHandles:foreign,recovery:{tasks:foreign,aggregate:{state:'working'}}};
  const own=taskStatus(source,'mine');assert.equal(own.logicalSessionCount,1001);assert.equal(own.logicalSessions.length,1);assert.equal(own.recovery.tasks.length,0);assert.ok(JSON.stringify(own).length<600);assert.equal(taskStatus(source,'mine','all').recoveryHandles.length,1000);
});

test('visual proof usage keeps the exact lease until its transaction consumes the proof', () => {
  const inspected=toolResult({visual_readback_verified:true,visualProof:{signature:'opaque'},target:{supported:true}}).structuredContent.result;
  assert.equal(inspected.proof_usage.keep_lease_until_transaction,true);
  assert.equal(inspected.proof_usage.next_tool,'companion_authorized_transaction');
  assert.match(inspected.proof_usage.after_lease_release,/inspect_again/);
  const unsupported=toolResult({visual_readback_verified:true,supported:false,visualProof:{supported:false}}).structuredContent.result;
  assert.equal(unsupported.proof_usage,undefined);
});

test('retained transactions return exact fresh-read arguments after releasing their lease', () => {
  const result=toolResult({schema:'aos.chrome_companion.transaction.v1',cleanup:{lease_released:true,retained:true},tab:{id:77},capsule:{target:{sessionId:'owned'}}}).structuredContent.result;
  assert.equal(result.lease_state,'released');
  assert.deepEqual(result.next_target_read.arguments,{sessionId:'owned',tabId:77});
  const closed=toolResult({schema:'aos.chrome_companion.transaction.v1',cleanup:{lease_released:true,closed:true},tab:{id:77},capsule:{target:{sessionId:'owned'}}}).structuredContent.result;
  assert.equal(closed.next_target_read,undefined);
});
test('action schema advertises and validates required typed arguments before dispatch', () => {
  const schema=transactionActionSchema(z.object({role:z.string(),label:z.string().optional()}));
  assert.equal(schema.safeParse({method:'page.type',params:{locator:{role:'textbox'}}}).success,false);
  assert.equal(schema.safeParse({method:'visual.click',params:{}}).success,false);
  const ok=schema.parse({method:'page.type',params:{locator:{role:'textbox'},text:'hello',clear:true,customFutureOption:1}});assert.equal(ok.params.customFutureOption,1);
});


test('local browser edits are not labelled as an externally completed action', () => {
  const result=toolResult({schema:'aos.chrome_companion.transaction.v1',effect_state:'known_effect',external_action_executed:true,applied_actions:[{index:0,mutation:true,reconciliationRequired:false}],capsule:{effect:{externalActionExecuted:true}}}).structuredContent.result;
  assert.equal(result.browser_mutation_executed,true);
  assert.equal(result.external_action_executed,false);
  assert.equal(result.external_action_dispatched,false);
  assert.equal(result.capsule.effect.browserMutationExecuted,true);
  assert.equal(result.capsule.effect.externalActionExecuted,false);
});


test('label matching excludes siblings that merely share the same question context', () => {
  const a=source.indexOf('  const matchesSimpleLocator =');
  const b=source.indexOf('  const matchesLocator =',a);
  const context={lower:x=>String(x??'').toLowerCase(),accessibleName:x=>x.name,implicitRole:x=>x.role,matchesState:()=>true,semanticContext:()=>true};
  const matches=vm.runInNewContext(`(()=>{${source.slice(a,b)}return matchesSimpleLocator;})()`,context);
  const field=(name,role)=>({name,role,getAttribute:()=>null});
  const choice=field('Audit choice','combobox'),name=field('Audit name','textbox');
  assert.equal(matches(choice,{label:'Audit choice'}),true);
  assert.equal(matches(name,{label:'Audit choice'}),false);
  assert.equal(matches(name,{question:'Audit choice'}),true);
});


test('injected locator errors survive serialization with their actionable code', async () => {
  const a=source.indexOf('async function injectedPageOperation(');
  const b=source.indexOf('\nchrome.runtime.onMessage',a);
  const context={document:{querySelectorAll:()=>[]},crypto:{randomUUID:()=> 'fixture-id'}};
  vm.createContext(context);vm.runInContext(source.slice(a,b),context);
  const result=await context.injectedPageOperation('inspectVisualTarget',{locator:{role:'button',name:'actually a checkbox'}});
  assert.equal(result.__aosCompanionError.code,'semantic_locator_not_found');
  assert.equal(result.__aosCompanionError.details.nextAction,'query_current_page_then_refine_locator');
  assert.equal(result.__aosCompanionError.details.operationEffectState,undefined);
});

test('page-operation runner unwraps a serialized locator error before target binding', async () => {
  const a=source.indexOf('async function runPageOperation(');
  const b=source.indexOf('\nasync function injectedPageOperation(',a);
  const context={READ_ONLY_PAGE_ACTIONS:new Set(['inspectVisualTarget']),executePageScriptWithReadRetry:async()=>[{frameId:0,result:{__aosCompanionError:{code:'semantic_locator_not_found',message:'No matching button',details:{nextAction:'refine_locator'}}}}],bindInjectionDocumentIdentity:x=>x,companionError:(code,message,details)=>Object.assign(new Error(message),{code,details})};
  context.PAGE_MUTATION_EXECUTION_TIMEOUT_MS=30_000;
  vm.createContext(context);vm.runInContext(source.slice(a,b),context);
  await assert.rejects(context.runPageOperation(1,'inspectVisualTarget',{locator:{role:'button'}}),error=>error.code==='semantic_locator_not_found'&&error.details.nextAction==='refine_locator');
});

test('upload execution has a bounded longer wait and a timeout never retries or reports no effect', async () => {
  const a=source.indexOf('async function runPageOperation('), b=source.indexOf('\nasync function injectedPageOperation(',a);
  for (const action of ['upload','uploadMultiple','click']) {
    let calls=0,timeout;
    const context={PAGE_MUTATION_EXECUTION_TIMEOUT_MS:30_000,READ_ONLY_PAGE_ACTIONS:new Set(),injectedPageOperation:()=>{},
      chrome:{scripting:{executeScript:async()=>{calls++;return [];}}},
      withTimeout:async(promise,ms,code)=>{await promise;timeout=ms;throw Object.assign(Error('late'),{code});}};
    vm.createContext(context);vm.runInContext(source.slice(a,b),context);
    await assert.rejects(context.runPageOperation(1,action,{}),error=>error.code==='page_mutation_execution_timeout'
      &&error.details.operationEffectState==='unknown'&&error.details.mutationDispatchAttempted===true&&error.details.timeoutMs===timeout);
    assert.equal(timeout,action==='click'?30_000:45_000);assert.equal(calls,1);
  }
});
