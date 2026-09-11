import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
const source = await readFile(new URL('../extension/service-worker.js', import.meta.url), 'utf8');
const AsyncFunction = Object.getPrototypeOf(async function(){}).constructor;
const worker = new AsyncFunction('env', `with(env) { ${source.slice(source.indexOf('async function waitForPageLocator('), source.indexOf('async function runAndCheckMutation('))}; return waitForPageLocator(7, {locator:{testId:'ready'},timeoutMs:100}); }`);
function harness(responses, overshoot=0) {
  let now=0, probes=0, sleeps=0;
  const env={Date:{now:()=>now},setTimeout:fn=>{sleeps++;now+=100+overshoot;fn();},
    companionError:(code,message,details)=>Object.assign(new Error(message),{code,details}),
    runPageOperation:async()=>{const value=responses[Math.min(probes++,responses.length-1)];if(value instanceof Error)throw value;return value;}};
  return {env, probes:()=>probes, sleeps:()=>sleeps};
}
test('worker wait checks a fresh result after a delayed wakeup crosses the deadline',async()=>{
  const f=harness([{found:false},{found:true,url:'https://owned.test/'}],20000);
  assert.equal((await worker(f.env)).found,true);assert.equal(f.probes(),2);
});
test('worker wait times out with the last read, without retrying malformed locators',async()=>{
  const missing=harness([{found:false}]);await assert.rejects(worker(missing.env),{code:'page_wait_timeout'});assert.equal(missing.probes(),2);
  for(const code of ['semantic_selector_invalid','semantic_regex_invalid','semantic_locator_ambiguous']){
    const invalid=harness([Object.assign(new Error(code),{code})]);await assert.rejects(worker(invalid.env),{code});assert.equal(invalid.sleeps(),0);
  }
});
const start=source.indexOf('  if (action === "waitFor") {'),end=source.indexOf('  if (action === "delay") {',start);
const probe=new AsyncFunction('env',`with(env) { ${source.slice(start,end)} }`);
test('page probe returns immediately and suppresses only a missing element',async()=>{
  const env={action:'waitFor',payload:{locator:{}},location:{href:'https://owned.test/'},pageInstanceId:'doc',describe:()=>({}),find:()=>{throw Object.assign(new Error('missing'),{code:'semantic_locator_not_found'});}};
  assert.equal((await probe(env)).found,false);
  env.find=()=>{throw Object.assign(new Error('ambiguous'),{code:'semantic_locator_ambiguous'});};
  await assert.rejects(probe(env),{code:'semantic_locator_ambiguous'});
});
