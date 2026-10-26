// 別タブの実際の開き元はChromeの移動通知で確認する。
// noopenerのリンクではopenerTabIdだけで開き元を判定できない。
export async function notifyPopupTarget(details, { tabs, current, send }) {
  const owner = current();
  if (!owner.connected || !Number.isSafeInteger(details.sourceTabId)
    || !Number.isSafeInteger(details.tabId) || details.sourceTabId === details.tabId) return;
  let tab;
  try { tab = await tabs.get(details.tabId); } catch { return; }
  const fresh = current();
  if (!fresh.connected || fresh.profileInstanceId !== owner.profileInstanceId
    || fresh.generation !== owner.generation || fresh.port !== owner.port) return;
  send({ kind: "extension.event", event: "task.tab.popup_created",
    profileInstanceId: owner.profileInstanceId, generation: owner.generation,
    sourceTabId: details.sourceTabId, tabId: tab.id, windowId: tab.windowId,
    url: details.url }, { port: owner.port });
}
