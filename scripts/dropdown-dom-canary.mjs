import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import { isolatedBrowser } from './lib/isolated-browser-fixture.mjs';
const output=resolve(process.argv[2]??'../verification/dropdown-dom',new Date().toISOString().replaceAll(':','-'));await mkdir(output,{recursive:true});
const source=await readFile(new URL('../extension/service-worker.js',import.meta.url),'utf8');
const injected=source.slice(source.indexOf('async function injectedPageOperation('),source.indexOf('\nchrome.runtime.onMessage.addListener'));
const server=createServer((_req,res)=>{res.setHeader('Content-Type','text/html; charset=utf-8');res.end('<!doctype html><meta charset="utf-8"><style>body{font:18px system-ui;padding:24px}button{padding:12px;margin:8px}pre{white-space:pre-wrap}</style><h1>Companion custom dropdowns</h1><div id="fixture"></div><pre id="results"></pre>');});
const receipt={schema:'companion.dropdown_dom_canary.v1',startedAt:new Date().toISOString(),scope:'Production injected selectOption in real Chrome; owned local ARIA portal and asynchronous fixtures. Provider-specific UI and Native Messaging are separate.',cases:[],cleanup:{}};
let browser;
async function setup(mode){await browser.evaluate(`(()=>{
 const mode=${JSON.stringify(mode)},root=document.querySelector('#fixture');
 (window.dropdownFixtureTimers??[]).forEach(clearTimeout);window.dropdownFixtureTimers=[];
 root.innerHTML='<button data-testid="control" role="combobox" aria-controls="owned-options" aria-expanded="false">Choose a country</button><div role="listbox" id="foreign-options"><button role="option" data-value="foreign">Japan</button></div>';
 if(mode.startsWith('search-'))root.querySelector('[data-testid=control]').outerHTML='<input data-testid="control" role="combobox" aria-controls="owned-options" aria-expanded="false" aria-label="Search country">';
 document.body.dataset.own='0';document.body.dataset.foreign='0';
 const control=root.querySelector('[data-testid=control]');
 root.querySelector('[data-value=foreign]').onclick=e=>{document.body.dataset.foreign=String(Number(document.body.dataset.foreign)+1);e.currentTarget.setAttribute('aria-selected','true')};
 if(mode!=='missing-root'){const list=document.createElement('div');list.id='owned-options';list.setAttribute('role','listbox');document.body.append(list)}
 const populate=()=>{let list=document.querySelector('#owned-options');if(!list){list=document.createElement('div');list.id='owned-options';list.setAttribute('role','listbox');document.body.append(list)}list.innerHTML='<button role="option" data-value="jp-1">Japan</button>'+(['ambiguous','value'].includes(mode)?'<button role="option" data-value="jp-2">Japan</button>':'');for(const option of list.children)if(mode!=='search-noop')option.onclick=()=>{document.body.dataset.own=String(Number(document.body.dataset.own)+1);option.setAttribute('aria-selected','true');if(control instanceof HTMLInputElement)control.value=option.textContent;else control.textContent=option.textContent;control.setAttribute('aria-expanded','false')}};
 if(mode==='delayed-match')document.querySelector('#owned-options').innerHTML='<button role="option" data-value="loading">Loading countries</button>';
 control.onclick=()=>{if(['search-toggle','open-menu'].includes(mode)&&control.getAttribute('aria-expanded')==='true'){control.setAttribute('aria-expanded','false');document.querySelector('#owned-options').hidden=true;return}control.setAttribute('aria-expanded','true');if(mode==='no-options')return;if(['empty-root','missing-root','delayed-match'].includes(mode))window.dropdownFixtureTimers.push(setTimeout(populate,200));else populate()};
 if(mode.startsWith('search-'))control.oninput=()=>{control.setAttribute('aria-expanded','true');window.dropdownFixtureTimers.push(setTimeout(populate,200))};
 if(mode==='open-menu'){populate();control.setAttribute('aria-expanded','true')}
})()`);}
async function clean(){await browser.evaluate('(window.dropdownFixtureTimers??[]).forEach(clearTimeout);document.querySelectorAll("#owned-options").forEach(e=>e.remove());document.querySelector("#fixture").replaceChildren()');}
const counts=()=>browser.evaluate('({own:Number(document.body.dataset.own),foreign:Number(document.body.dataset.foreign)})');
const select=option=>browser.productionOperation(injected,'selectOption',{locator:{testId:'control'},option,timeoutMs:1000});
async function run(name,mode,body){await setup(mode);try{receipt.cases.push({name,passed:true,...await body()});}catch(error){receipt.cases.push({name,passed:false,error:{message:error.message,code:error.code},...await counts()});}finally{await clean();}console.log(JSON.stringify(receipt.cases.at(-1)));}
try{
 await new Promise(r=>server.listen(0,'127.0.0.1',r));browser=await isolatedBrowser();receipt.browser=browser.version;await browser.navigate(`http://127.0.0.1:${server.address().port}/`);
 for(const mode of ['empty-root','missing-root','delayed-match'])await run('Wait for the requested option in '+mode,mode,async()=>{const result=await select({label:'Japan'});assert.equal(result.selectionCommitted,true);assert.deepEqual(await counts(),{own:1,foreign:0});});
 await run('Duplicate names in the associated list remain ambiguous','ambiguous',async()=>{await assert.rejects(select({label:'Japan'}),{code:'dropdown_option_ambiguous'});assert.deepEqual(await counts(),{own:0,foreign:0});});
 await run('An exact value disambiguates equal visible labels','value',async()=>{const result=await select({value:'jp-2'});assert.equal(result.option.value,'jp-2');assert.deepEqual(await counts(),{own:1,foreign:0});});
 await run('An empty associated list never adopts a foreign option','no-options',async()=>{await assert.rejects(select({label:'Japan'}),{code:'dropdown_options_not_visible'});assert.deepEqual(await counts(),{own:0,foreign:0});});
 await run('An already open menu is not toggled closed','open-menu',async()=>{const result=await select({label:'Japan'});assert.equal(result.selectionCommitted,true);assert.deepEqual(await counts(),{own:1,foreign:0});});
 await run('A searchable portal remains open after typing its query','search-toggle',async()=>{await browser.productionOperation(injected,'type',{locator:{testId:'control'},text:'Japan',clear:true});const result=await select({label:'Japan'});assert.equal(result.selectionCommitted,true);assert.deepEqual(await counts(),{own:1,foreign:0});});
 await run('A matching search query alone is not evidence of selection','search-noop',async()=>{await browser.productionOperation(injected,'type',{locator:{testId:'control'},text:'Japan',clear:true});await assert.rejects(select({label:'Japan'}),{code:'dropdown_selection_not_committed'});assert.deepEqual(await counts(),{own:0,foreign:0});});
 await browser.evaluate('document.querySelector("#results").textContent='+JSON.stringify(receipt.cases.map(c=>(c.passed?'PASS ':'FAIL ')+c.name).join('\n')));const shot=await browser.call('Page.captureScreenshot',{format:'png'});await writeFile(join(output,'verified.png'),Buffer.from(shot.data,'base64'));
 receipt.result=receipt.cases.every(c=>c.passed)?'passed':'failed';
}catch(error){receipt.result='failed';receipt.error={message:error.message,code:error.code};}
finally{if(browser){await browser.close();receipt.cleanup.browserClosed=true;}await new Promise(r=>server.close(r));receipt.cleanup.serverClosed=true;receipt.finishedAt=new Date().toISOString();await writeFile(join(output,'receipt.json'),JSON.stringify(receipt,null,2));console.log(JSON.stringify({result:receipt.result,receipt:join(output,'receipt.json')}));if(receipt.result!=='passed')process.exitCode=1;}
