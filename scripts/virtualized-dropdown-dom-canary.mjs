import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { createHash } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import { isolatedBrowser } from './lib/isolated-browser-fixture.mjs';
const output = resolve(process.argv[2] ?? '../verification/virtualized-dropdown-dom', new Date().toISOString().replaceAll(':', '-'));
await mkdir(output, { recursive: true });
const source = await readFile(new URL('../extension/service-worker.js', import.meta.url), 'utf8');
const injected = source.slice(source.indexOf('async function injectedPageOperation('), source.indexOf('\nchrome.runtime.onMessage.addListener'));
const server = createServer((_req, res) => { res.setHeader('Content-Type', 'text/html; charset=utf-8'); res.end('<!doctype html><meta charset="utf-8"><style>body{font:18px sans-serif;margin:24px}button{font:18px sans-serif}#owned,#foreign{height:120px;width:340px;overflow-y:auto;border:1px solid #aaa;position:relative;margin:10px}.row{position:absolute;height:30px;left:0;width:100%;margin:0;border:0;text-align:left}</style><h1>Virtualized dropdown fixture</h1><main id="fixture"></main><pre id="report"></pre>'); });
const receipt = { schema: 'companion.virtualized_dropdown_dom_canary.v1', startedAt: new Date().toISOString(), sourceSha256: createHash('sha256').update(source).digest('hex'), cases: [], cleanup: {} };
let browser;
async function setup(mode) {
  await browser.evaluate(`(() => {
    window.virtualObserver?.disconnect();clearInterval(window.virtualChurnTimer);delete document.visibilityState;
    const mode=${JSON.stringify(mode)},fixture=document.querySelector('#fixture');
    fixture.replaceChildren();window.virtualCounts={own:0,foreign:0,ownScroll:0,foreignScroll:0};window.virtualRenderStarts=[];
    const control=document.createElement('button');control.dataset.testid='control';control.setAttribute('role','combobox');control.setAttribute('aria-controls',mode==='missing'?'unavailable':'owned');control.setAttribute('aria-expanded','true');control.textContent='Choose item';fixture.append(control);
    const foreign=document.createElement('div');foreign.id='foreign';foreign.setAttribute('role','listbox');foreign.innerHTML='<div style="height:1800px"><button role="option" data-value="v37">Item 37</button></div>';foreign.onscroll=()=>window.virtualCounts.foreignScroll++;foreign.querySelector('button').onclick=()=>window.virtualCounts.foreign++;fixture.append(foreign);
    if(mode==='missing')return;
    if(mode==='churn')window.virtualChurnTimer=setInterval(()=>{document.querySelector('#report').textContent=String(Date.now())},1);
    const list=document.createElement('div');list.id='owned';list.setAttribute('role','listbox');fixture.append(list);
    const spacer=document.createElement('div');spacer.style.height='1800px';list.append(spacer);
    const render=()=>{
      list.querySelectorAll('[role="option"]').forEach(e=>e.remove());
      const first=Math.min(56,Math.floor(list.scrollTop/30));window.virtualRenderStarts.push({first,top:list.scrollTop});
      for(let i=first;i<Math.min(first+5,60);i++){
        const row=document.createElement('button');row.className='row';row.style.top=(i*30)+'px';row.setAttribute('role','option');row.setAttribute('data-value','v'+i);row.textContent=mode==='ambiguous'&&i<2?'Same':'Item '+i;
        row.onclick=()=>{window.virtualCounts.own++;control.textContent=row.textContent;control.dataset.selected=row.getAttribute('data-value');row.setAttribute('aria-selected','true')};list.append(row);
      }
    };
    list.onscroll=()=>{window.virtualCounts.ownScroll++;render()};render();
    if(mode==='above'){list.scrollTop=1200;render()}
    if(mode==='recycle'){
      let visualizations=0;
      window.virtualObserver=new MutationObserver(records=>{
        for(const record of records)for(const node of record.addedNodes)if(node.id==='__aos_companion_cursor__')visualizations++;
        if(visualizations>=2){window.virtualObserver.disconnect();const row=list.querySelector('[data-value="v1"]');if(row){row.dataset.value='evil';row.textContent='Recycled wrong item'}}
      });window.virtualObserver.observe(document.documentElement,{childList:true});
    }
  })()`);
}
const counts=()=>browser.evaluate('({...window.virtualCounts, renders:window.virtualRenderStarts, selected:document.querySelector("[data-testid=control]").dataset.selected??null, top:document.querySelector("#owned")?.scrollTop??null, pageY:scrollY})');
const select=(option,timeoutMs=5000,requireVisible=false)=>browser.productionOperation(injected,'selectOption',{locator:{testId:'control'},option,timeoutMs,requireVisible});
async function run(name,mode,body){if(process.env.COMPANION_TEST_CASE && mode!==process.env.COMPANION_TEST_CASE)return;await setup(mode);try{receipt.cases.push({name,passed:true,...await body()})}catch(error){receipt.cases.push({name,passed:false,error:{code:error.code,message:error.message,details:error.details},counts:await counts()})}console.log(JSON.stringify(receipt.cases.at(-1)))}
try{
  await new Promise(r=>server.listen(0,'127.0.0.1',r));browser=await isolatedBrowser();receipt.browser=browser.version;
  await browser.navigate('http://127.0.0.1:'+server.address().port+'/');
  await run('Find a below-viewport virtual option by exact value','deep',async()=>{const result=await select({value:'v37'});const state=await counts();assert.equal(result.selectionCommitted,true);assert.equal(result.option.value,'v37');assert.equal(state.selected,'v37');assert.equal(state.own,1);assert.equal(state.foreign,0);assert.equal(state.foreignScroll,0);assert.ok(result.scrollSearch.steps>0);assert.ok(result.scrollSearch.steps<=64);return {result:result.scrollSearch,counts:state}});
  await run('Unrelated DOM churn cannot skip virtual scroll windows','churn',async()=>{const result=await select({value:'v37'});const state=await counts();assert.equal(result.selectionCommitted,true);assert.equal(state.selected,'v37');assert.equal(state.own,1);assert.equal(state.foreign,0);assert.equal(result.scrollSearch.observedSteps,result.scrollSearch.steps);assert.ok(state.renders.every((row,index)=>index===0 || row.first-state.renders[index-1].first<=5),'Every virtual window must be rendered before advancing');return {result:result.scrollSearch,counts:state}});
  await run('Wrap once to find an option above the initial scroll position','above',async()=>{const result=await select({label:'Item 2'});const state=await counts();assert.equal(result.selectionCommitted,true);assert.equal(state.selected,'v2');assert.equal(state.own,1);assert.equal(state.foreign,0);return {result:result.scrollSearch,counts:state}});
  await run('An absent candidate never clicks or scrolls the foreign list','absent',async()=>{await assert.rejects(select({value:'absent'},300),{code:'dropdown_option_not_found'});const state=await counts();assert.equal(state.own,0);assert.equal(state.foreign,0);assert.equal(state.foreignScroll,0);return {counts:state}});
  await run('An index remains a rendered index without automatic scrolling','index',async()=>{await assert.rejects(select({index:37},300),{code:'dropdown_option_index_invalid'});const state=await counts();assert.equal(state.own,0);assert.equal(state.ownScroll,0);assert.equal(state.top,0);return {counts:state}});
  await run('An ambiguous visible label rejects before any scroll or click','ambiguous',async()=>{await assert.rejects(select({label:'Same'}),{code:'dropdown_option_ambiguous'});const state=await counts();assert.equal(state.own,0);assert.equal(state.ownScroll,0);return {counts:state}});
  await run('A recycled option after visual inspection is not clicked','recycle',async()=>{await assert.rejects(select({value:'v1'}),{code:'dropdown_selection_target_changed'});const state=await counts();assert.equal(state.own,0);assert.equal(state.foreign,0);return {counts:state}});
  await run('A visibility interruption before click remains blocked after visibility returns (simulated event)','visibility',async()=>{const {frameTree}=await browser.call('Page.getFrameTree');const {executionContextId}=await browser.call('Page.createIsolatedWorld',{frameId:frameTree.frame.id,worldName:'companion-production-fixture'});await browser.evaluate(`(()=>{let n=0;const observer=new MutationObserver(records=>{for(const r of records)for(const e of r.addedNodes)if(e.id==='__aos_companion_cursor__')n++;if(n>=2){observer.disconnect();Object.defineProperty(document,'visibilityState',{value:'hidden',configurable:true});document.dispatchEvent(new Event('visibilitychange'));Object.defineProperty(document,'visibilityState',{value:'visible',configurable:true})}});observer.observe(document.documentElement,{childList:true})})()`,executionContextId);await assert.rejects(select({value:'v1'},5000,true),{code:'dropdown_selection_visibility_changed'});const state=await counts();assert.equal(state.own,0);assert.equal(state.foreign,0);return {counts:state}});
  await run('A missing associated popup never adopts the other list','missing',async()=>{await assert.rejects(select({value:'v37'},300),{code:'dropdown_options_not_visible'});const state=await counts();assert.equal(state.foreign,0);assert.equal(state.foreignScroll,0);return {counts:state}});
  await browser.evaluate('window.virtualObserver?.disconnect();document.querySelector("#report").textContent='+JSON.stringify(receipt.cases.map(c=>(c.passed?'PASS ':'FAIL ')+c.name).join('\n')));
  const shot=await browser.call('Page.captureScreenshot',{format:'png'});await writeFile(join(output,'verified.png'),Buffer.from(shot.data,'base64'));
  receipt.result=receipt.cases.every(c=>c.passed)?'passed':'failed';
}catch(error){receipt.result='failed';receipt.error={code:error.code,message:error.message}}
finally{if(browser){await browser.close();receipt.cleanup.browserClosed=true}await new Promise(r=>server.close(r));receipt.cleanup.serverClosed=true;receipt.finishedAt=new Date().toISOString();await writeFile(join(output,'receipt.json'),JSON.stringify(receipt,null,2));console.log(JSON.stringify({result:receipt.result,receipt:join(output,'receipt.json')}));if(receipt.result!=='passed')process.exitCode=1}
