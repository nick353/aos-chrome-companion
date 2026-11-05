import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import vm from 'node:vm';

// tabs.navigate がサイトをまたぐとき、動く前のタブと着いたタブの両方が署名された許可リストの中にあることだけは変えずに、
// 呼ぶ側が URL で名指しした側との targetOrigin の比較を外す（2026-11-05。3日で別サイトへの移動27回のうち24回が止まった）。
const source = await readFile(new URL('../extension/service-worker.js', import.meta.url), 'utf8');
const block = source.slice(source.indexOf('const SITE_ALIAS_GROUPS = ['), source.indexOf('async function probeCommittedDocument('));
const navigate = source.slice(source.indexOf('case "tabs.navigate": {'), source.indexOf('case "tabs.back": {'));

const A = 'https://www.etsy.com', B = 'https://printify.com', C = 'https://other.example', D = 'https://outside.example';
const load = (liveOrigin) => {
  const context = {
    URL,
    chrome: { tabs: { get: async () => ({ id: 1, url: `${liveOrigin}/page` }) } },
    originOf: (value) => new URL(value).origin,
    companionError: (code, message) => Object.assign(new Error(message), { code }),
  };
  return vm.runInNewContext(`${block}\n({ assertLiveOrigin, navigationCheckParams, sameSiteOrigin })`, context);
};
// 実物の tabs.navigate と同じ判定を組み立てる（下の試験で、実物がこの形を使っていることも確かめる）。
const leave = async (live, params, requested) => {
  const f = load(live);
  return f.assertLiveOrigin(1, f.sameSiteOrigin(params.targetOrigin, requested) ? f.navigationCheckParams(params) : params);
};
const arrive = async (arrived, params, requested) => {
  const f = load(arrived);
  return f.assertLiveOrigin(1, f.sameSiteOrigin(requested, arrived) ? f.navigationCheckParams(params) : params);
};
const params = (targetOrigin, allowedOrigins = [A, B, C]) => ({ mutation: true, targetOrigin, allowedOrigins });

test('行き先を targetOrigin にした移動は、元のサイトを出て行き先に着ける', async () => {
  await leave(A, params(B), B);
  await arrive(B, params(B), B);
});

test('元のサイトを targetOrigin にした移動も、名指しした行き先に着いたら止めない', async () => {
  await leave(A, params(A), B);
  await arrive(B, params(A), B);
});

test('名指ししていない別のサイトへ転送されたら止める', async () => {
  await assert.rejects(arrive(C, params(A), B), { code: 'target_origin_mismatch' });
});

test('今のタブが targetOrigin でも行き先でもなければ、動く前に止める', async () => {
  await assert.rejects(leave(C, params(A), B), { code: 'target_origin_mismatch' });
});

test('許可リストは今までどおり両端に効く', async () => {
  await assert.rejects(leave(D, params(B), B), { code: 'target_origin_not_allowed' });
  await assert.rejects(arrive(D, params(B, [A, B]), D), { code: 'target_origin_not_allowed' });
});

test('実物の tabs.navigate が、動く前と着いたあとの両方でこの判定を使う', () => {
  assert.match(navigate, /sameSiteOrigin\(params\.targetOrigin, requestedOrigin\) \? navigationCheckParams\(params\) : params/u);
  assert.match(navigate, /sameSiteOrigin\(requestedOrigin, originOf\(committed\.url\)\) \? navigationCheckParams\(params\) : params/u);
  assert.match(navigate, /!allowed\.has\(requestedOrigin\)/u, '行き先の許可リストの確認は残す');
});

test('覆っている要素の名前を呼ぶ側へ返す', () => {
  assert.match(source, /coveredBy: \{\s*tag: cover\.tagName\.toLowerCase\(\)/u);
  assert.match(source, /error\?\.details\?\.coveredBy \? \{ coveredBy: error\.details\.coveredBy \}/u);
});

test('入力できない相手は、何も起きていないと返す（結果不明にしない）', () => {
  assert.match(source, /operationError\("text_input_required", "Matched element does not accept text input",\s*\{ operationEffectState: "none", mutationDispatchAttempted: false \}\)/u);
});

test('チェックは描き直しを待ってから判定し、押すのは1回だけ', () => {
  const block2 = source.slice(source.indexOf('if (action === "setChecked") {'), source.indexOf('checked_state_not_committed'));
  assert.equal(block2.match(/activateControl\(element\)/gu).length, 1);
  assert.match(block2, /waited < 1000/u);
});
