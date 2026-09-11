const $ = id => document.getElementById(id);
let controls = { paused: false, blockedOrigins: [], recentOperations: [] }, activeOrigin = null;
const labels = { 'page.type':'文字を入力', 'page.click':'クリック', 'page.upload':'ファイルを添付', 'page.uploadMultiple':'ファイルを添付', 'page.query':'ページを読取', 'page.snapshot':'ページを確認', 'page.screenshot':'画面を確認', 'tabs.create':'タブを作成', 'tabs.close':'タブを終了', 'page.richText':'文章の書式を編集', 'clipboard.write':'クリップボードへコピー' };
Object.assign(labels, { 'browser.searchLibrary':'履歴・ブックマークを検索', 'browser.listWindows':'ウィンドウを確認', 'tabs.configure':'タブを整理', 'page.bookmark':'ブックマークに保存' });
const errorLabels = { companion_user_paused:'一時停止中', companion_site_blocked:'サイトへのアクセスを停止中', browser_library_permission_required:'追加のアクセス許可が必要です', target_not_found:'対象が見つかりません', operation_timeout:'結果の確認が必要です' };
async function request(message) { const result = await chrome.runtime.sendMessage(message); if (result?.error) throw Error(result.error); return result; }
function button(label, action) { const el = document.createElement('button'); el.type='button'; el.className='quiet'; el.textContent=label; el.onclick=()=>run(action); return el; }
function render() {
  $('activity').textContent = controls.paused ? '新しい操作を一時停止しています' : '操作を受け付けています';
  $('pause').textContent = controls.paused ? '操作を再開' : '新しい操作を一時停止';
  $('pause-note').textContent = controls.paused ? '進行中の操作は結果を確認します。読取と後片付けは続けられます。' : '一時停止しても、ページと入力内容はそのまま残ります。';
  document.querySelector('.control').dataset.paused = String(controls.paused);
  $('site').textContent = activeOrigin ?? '通常のWebページを開いてください';
  $('site-toggle').disabled = !activeOrigin;
  $('site-toggle').textContent = controls.blockedOrigins.includes(activeOrigin) ? 'このサイトへのアクセスを再開' : 'このサイトへのアクセスを停止';
  $('blocked-sites').replaceChildren();
  for (const origin of controls.blockedOrigins) { const li=document.createElement('li');li.textContent=origin;li.append(button('再開',async()=>{await request({kind:'controls.site',origin,blocked:false});await refresh();}));$('blocked-sites').append(li); }
  if (!controls.blockedOrigins.length) $('blocked-sites').textContent='停止したサイトはありません';
  $('operations').replaceChildren();
  for (const operation of controls.recentOperations.slice(0,8)) {
    const li=document.createElement('li'),title=document.createElement('strong'),detail=document.createElement('small');
    title.textContent=operation.taskLabel || 'Companionの操作';
    detail.textContent=(labels[operation.method] ?? 'ブラウザの操作')+' · '+({running:'実行中',finished:'完了',failed:'停止'}[operation.phase] ?? operation.phase);
    if (operation.errorCode) detail.textContent+=' · '+(errorLabels[operation.errorCode] ?? '結果を確認してください');
    li.append(title,detail);
    if (operation.tabId!==null) li.append(button('元のタブを開く',async()=>{const tab=await chrome.tabs.get(operation.tabId);await chrome.tabs.update(tab.id,{active:true});await chrome.windows.update(tab.windowId,{focused:true});}));
    $('operations').append(li);
  }
  if (!controls.recentOperations.length) { const li=document.createElement('li');li.className='empty';li.textContent='まだ操作はありません';$('operations').append(li); }
}
async function refresh() {
  const [state, current, site] = await Promise.all([request({kind:'status.get'}),request({kind:'controls.get'}),request({kind:'controls.activeSite'})]);
  controls=current;activeOrigin=site.origin;
  $('connection').textContent=state.connected?'Chromeに接続済み':state.connecting?'接続しています':'接続していません';
  await refreshLibraryPermissions();
  render();
}
async function refreshLibraryPermissions() {
  for (const [permission, label] of [['history','履歴検索'],['bookmarks','ブックマーク']]) {
    const granted = await chrome.permissions.contains({ permissions: [permission] });
    const control = $(permission+'-access');control.dataset.granted=String(granted);
    control.textContent=granted ? label+'の許可を取り消す' : label+'を許可';
  }
}
for (const permission of ['history','bookmarks']) $(permission+'-access').onclick=()=>run(async()=>{
  if ($(permission+'-access').dataset.granted === 'true') await chrome.permissions.remove({permissions:[permission]});
  else await chrome.permissions.request({permissions:[permission]});
  await refreshLibraryPermissions();
});
async function run(action) { $('error').textContent='';try{await action();}catch(error){$('error').textContent=error.message;} }
$('refresh').onclick=()=>run(refresh);
$('pause').onclick=()=>run(async()=>{controls=await request({kind:'controls.pause',paused:!controls.paused});render();});
$('site-toggle').onclick=()=>run(async()=>{controls=await request({kind:'controls.site',origin:activeOrigin,blocked:!controls.blockedOrigins.includes(activeOrigin)});render();});
$('clear').onclick=()=>run(async()=>{controls=await request({kind:'controls.clearRecent'});render();});
$('context').onclick=()=>run(async()=>{const context=await request({kind:'controls.context'});$('context-text').value=`ページ: ${context.title}\nURL: ${context.url}\nタブ: ${context.tabId}\n\n選択した文章:\n${context.selectedText || '（選択なし）'}`;$('copy').disabled=false;$('context-status').textContent='ページと選択文を取得しました';});
$('copy').onclick=()=>run(async()=>{await navigator.clipboard.writeText($('context-text').value);$('context-status').textContent='コピーしました。Codexの元のタスクへ貼り付けてください';});
void run(refresh);
