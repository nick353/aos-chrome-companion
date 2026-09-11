import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import vm from 'node:vm';
const source=await readFile(new URL('../extension/service-worker.js',import.meta.url),'utf8');
const functions=source.slice(source.indexOf('  const controlledDropdownRoots ='),source.indexOf('  const chooseOption ='));
for(const rootPresent of [true,false])test('an associated dropdown never adopts a foreign option when its root is '+(rootPresent?'empty':'not yet created'),()=>{
 let foreignQueries=0;const root={matches:()=>false,querySelectorAll:()=>[]};
 const context={CSS:{escape:x=>x},visible:()=>true,querySemantic:selector=>selector.startsWith('#')?(rootPresent?[{...root,id:'owned'}]:[]):(foreignQueries++,[{name:'foreign'}])};
 vm.runInNewContext(functions+'\nglobalThis.options=dropdownOptions;',context);
 const result=context.options({getAttribute:name=>name==='aria-controls'?'owned':''});
 assert.equal(result.options.length,0);assert.equal(foreignQueries,0);
});
test('unassociated legacy dropdown fallback remains available',()=>{
 const context={CSS:{escape:x=>x},visible:()=>true,querySemantic:()=>[{name:'observed option'}]};
 vm.runInNewContext(functions+'\nglobalThis.options=dropdownOptions;',context);
  assert.equal(context.options({getAttribute:()=>null}).options.length,1);
});

function dropdownWaitHarness() {
  let mutation, timeout, disconnected=0, cleared=0;
  const roots=[{name:'document'},{name:'open shadow root'}], observed=[];
  const context={semanticRoots:roots,MutationObserver:class {
    constructor(callback){mutation=callback;}
    observe(root){observed.push(root);}
    disconnect(){disconnected++;}
  },setTimeout:callback=>{timeout=callback;return 17;},clearTimeout:id=>{assert.equal(id,17);cleared++;}};
  vm.runInNewContext(functions+'\nglobalThis.wait=waitForDropdownChange;',context);
  return {wait:context.wait,mutation:()=>mutation(),timeout:()=>timeout(),stats:()=>({disconnected,cleared,observed,roots})};
}
test('asynchronous dropdown changes wake a hidden-tab wait without the throttled timer firing',async()=>{
  const harness=dropdownWaitHarness();let finished=false;
  const pending=harness.wait(100).then(()=>{finished=true;});
  await Promise.resolve();assert.equal(finished,false);
  harness.mutation();await pending;
  assert.equal(finished,true);
  const state=harness.stats();assert.equal(state.disconnected,1);assert.equal(state.cleared,1);
  assert.deepEqual(state.observed,state.roots);
});
test('a dropdown with no DOM changes releases every observation at the poll timeout',async()=>{
  const harness=dropdownWaitHarness();const pending=harness.wait(100);
  harness.timeout();await pending;
  assert.equal(harness.stats().disconnected,1);assert.equal(harness.stats().cleared,1);
});
