import assert from 'node:assert/strict';
import {createServer} from 'node:http';
import {readFile,writeFile,mkdir} from 'node:fs/promises';
import {resolve,join} from 'node:path';
import {isolatedBrowser} from './lib/isolated-browser-fixture.mjs';
const out=resolve(process.argv[2]??'work/panel-dom',new Date().toISOString().replaceAll(':','-'));await mkdir(out,{recursive:true});
const prelude=`<script>
let paused=false,blocked=[];
const libraryPermissions=new Set();
window.chrome={permissions:{contains:async({permissions})=>permissions.every(p=>libraryPermissions.has(p)),request:async({permissions})=>{permissions.forEach(p=>libraryPermissions.add(p));return true;},remove:async({permissions})=>{permissions.forEach(p=>libraryPermissions.delete(p));return true;}},runtime:{sendMessage:async m=>{
 if(m.kind==='status.get')return {connected:true};
 if(m.kind==='controls.activeSite')return {origin:'https://example.test'};
 if(m.kind==='controls.pause')paused=m.paused;
 if(m.kind==='controls.site')blocked=m.blocked?[m.origin]:[];
 if(m.kind==='controls.context')return {tabId:27,title:'作業中の応募フォーム',url:'https://example.test/application',selectedText:'この説明の続きを確認してください。'};
 return {paused,blockedOrigins:blocked,recentOperations:m.kind==='controls.clearRecent'?[]:[{taskLabel:'応募フォームの確認',method:'page.query',phase:'finished',tabId:27},{taskLabel:'文書の編集',method:'page.richText',phase:'running',tabId:28}]};
}},tabs:{get:async id=>({id,windowId:1}),update:async()=>{}},windows:{update:async()=>{}}};
</script>`;
const server=createServer(async(req,res)=>{const name=req.url.split('?')[0].split('/').at(-1)||'sidepanel.html';if(!['sidepanel.html','sidepanel.js','sidepanel.css'].includes(name)){res.writeHead(404);res.end();return;}let text=await readFile(new URL('../extension/'+name,import.meta.url),'utf8');if(name.endsWith('.html'))text=text.replace('<head>','<head>'+prelude);res.writeHead(200,{'content-type':name.endsWith('.js')?'text/javascript':name.endsWith('.css')?'text/css':'text/html; charset=utf-8'});res.end(text);});
await new Promise(r=>server.listen(0,'127.0.0.1',r));
const receipt={scope:'Production panel HTML/CSS/JS in isolated real Chrome; controlled extension API fixture, no installed profile changes',cases:[]};let browser;
try{browser=await isolatedBrowser({width:420,height:1200});await browser.navigate(`http://127.0.0.1:${server.address().port}/sidepanel.html`);
 const wait=async text=>{for(let i=0;i<40;i++){if(await browser.evaluate(`document.body.innerText.includes(${JSON.stringify(text)})`))return;await new Promise(r=>setTimeout(r,50));}throw Error('Panel state missing: '+text);};
 await wait('Chromeに接続済み');receipt.cases.push({name:'connection_and_operations',passed:await browser.evaluate(`document.querySelectorAll('#operations li').length===2`)});
 await browser.evaluate(`document.getElementById('pause').click()`);await wait('新しい操作を一時停止しています');receipt.cases.push({name:'pause',passed:true});
 await browser.evaluate(`document.getElementById('site-toggle').click()`);await wait('このサイトへのアクセスを再開');receipt.cases.push({name:'block_site',passed:true});
 await browser.evaluate(`document.getElementById('context').click()`);await wait('ページと選択文を取得しました');receipt.cases.push({name:'selection_context',passed:await browser.evaluate(`document.getElementById('context-text').value.includes('この説明の続きを確認してください。')`)});
 await browser.evaluate(`document.getElementById('history-access').closest('details').open=true;document.getElementById('history-access').click()`);await wait('履歴検索の許可を取り消す');await browser.evaluate(`document.getElementById('history-access').click()`);await wait('履歴検索を許可');receipt.cases.push({name:'library_permission_grant_and_revoke',passed:true});
 receipt.cases.push({name:'no_horizontal_overflow',passed:await browser.evaluate('document.documentElement.scrollWidth<=innerWidth')});
 const screenshot=await browser.call('Page.captureScreenshot',{format:'png',captureBeyondViewport:true});receipt.image=join(out,'panel.png');await writeFile(receipt.image,Buffer.from(screenshot.data,'base64'));
 assert.ok(receipt.cases.every(c=>c.passed));receipt.result='passed';
}catch(error){receipt.result='failed';receipt.error=error.message;}finally{await browser?.close();await new Promise(r=>server.close(r));receipt.testChromeClosed=browser?.closed??true;await writeFile(join(out,'receipt.json'),JSON.stringify(receipt,null,2));console.log(JSON.stringify({...receipt,record:join(out,'receipt.json')}));if(receipt.result!=='passed')process.exitCode=1;}
