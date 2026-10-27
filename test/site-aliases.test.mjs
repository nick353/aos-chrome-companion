import test from 'node:test';
import assert from 'node:assert/strict';
import { withSiteAliases } from '../src/shared/site-aliases.mjs';

// Allowing one name of a service allows its other names (2026-10-18: threads.net and app.doda.jp stops).
test('naming one member of a group allows the whole group, nothing else is added', () => {
  assert.deepEqual(withSiteAliases(['https://www.threads.com']).sort(),
    ['https://threads.com', 'https://threads.net', 'https://www.threads.com', 'https://www.threads.net'].sort());
  assert.ok(withSiteAliases(['https://doda.jp']).includes('https://app.doda.jp'));
  assert.ok(withSiteAliases(['https://app.doda.jp']).includes('https://doda.jp'));
  assert.deepEqual(withSiteAliases(['https://www.etsy.com', 'https://mail.google.com']), ['https://www.etsy.com', 'https://mail.google.com']);
  assert.deepEqual(withSiteAliases(['not a url']), ['not a url']);
});

test('the list never grows past 32 origins', () => {
  const many = Array.from({ length: 31 }, (_, i) => `https://site${i}.example`);
  assert.equal(withSiteAliases([...many, 'https://www.threads.com']).length, 32);
});

// The extension checks a live tab against the authority's targetOrigin with its own copy of the groups.
test('the extension keeps the same alias groups and accepts only a member of the same group', async () => {
  const { readFile } = await import('node:fs/promises');
  const vm = await import('node:vm');
  const { SITE_ALIAS_GROUPS } = await import('../src/shared/site-aliases.mjs');
  const source = await readFile(new URL('../extension/service-worker.js', import.meta.url), 'utf8');
  const block = source.slice(source.indexOf('const SITE_ALIAS_GROUPS = ['), source.indexOf('async function assertLiveOrigin('));
  const { groups, sameSiteOrigin } = vm.runInNewContext(`${block}\n({ groups: SITE_ALIAS_GROUPS, sameSiteOrigin })`, {});
  assert.deepEqual(JSON.parse(JSON.stringify(groups)), SITE_ALIAS_GROUPS);
  assert.equal(sameSiteOrigin('https://doda.jp', 'https://app.doda.jp'), true);
  assert.equal(sameSiteOrigin('https://boards.greenhouse.io', 'https://job-boards.greenhouse.io'), true);
  assert.equal(sameSiteOrigin('https://doda.jp', 'https://www.threads.com'), false);
  assert.equal(sameSiteOrigin('https://www.etsy.com', 'https://evil.example'), false);
  assert.ok(withSiteAliases(['https://boards.greenhouse.io']).includes('https://job-boards.greenhouse.io'));
});

// 2026-10-26 オーナー承認の別名グループ。同じサービスの別ドメインだけで、他は増えない。
test('the approved service groups allow their own names and nothing else', () => {
  assert.ok(withSiteAliases(['https://access.line.me']).includes('https://manager.line.biz'));
  assert.ok(withSiteAliases(['https://career.levtech.jp']).includes('https://auth.levtech.jp'));
  assert.ok(withSiteAliases(['https://next.rikunabi.com']).includes('https://rikunabi-next.yahoo.co.jp'));
  assert.ok(withSiteAliases(['https://www.linkedin.com']).includes('https://lnkd.in'));
  assert.ok(withSiteAliases(['https://www.facebook.com']).includes('https://business.facebook.com'));
  assert.ok(withSiteAliases(['https://www.hays.co.jp']).includes('https://m.hays.co.jp'));
  assert.ok(withSiteAliases(['https://work.turing.com']).includes('https://www.turing.com'));
  assert.ok(withSiteAliases(['https://tiktok.com']).includes('https://www.tiktok.com'));
  assert.ok(withSiteAliases(['https://careerengine.jp']).includes('https://www.careerengine.jp'));
  // 2026-10-27: Indeed の応募の流れで実際に着いた cts.indeed.com（17回止まった）を同じ組にした。
  assert.ok(withSiteAliases(['https://jp.indeed.com']).includes('https://cts.indeed.com'));
  assert.ok(withSiteAliases(['https://secure.indeed.com']).includes('https://jp.indeed.com'));
  assert.ok(!withSiteAliases(['https://jp.indeed.com']).includes('https://www.indeed.com.evil.example'));
  // 入れていないもの: 別の会社、Google のログイン、Slack のワークスペース、Workday の別の区画、似せたドメイン。
  for (const [one, other] of [
    ['https://career.levtech.jp', 'https://accounts.google.com'],
    ['https://next.rikunabi.com', 'https://login.yahoo.co.jp'],
    ['https://www.hays.co.jp', 'https://www.jac-recruitment.jp'],
    ['https://app.slack.com', 'https://api.slack.com'],
    ['https://trendmicro.wd3.myworkdayjobs.com', 'https://wd3.myworkdayjobs.com'],
    ['https://line.me', 'https://line.me.evil.example'],
    ['https://www.linkedin.com', 'https://linkedin.evil.example'],
  ]) assert.ok(!withSiteAliases([one]).includes(other), `${one} must not allow ${other}`);
});

test('the extension copy knows the approved groups and still rejects other origins', async () => {
  const { readFile } = await import('node:fs/promises');
  const vm = await import('node:vm');
  const source = await readFile(new URL('../extension/service-worker.js', import.meta.url), 'utf8');
  const block = source.slice(source.indexOf('const SITE_ALIAS_GROUPS = ['), source.indexOf('async function assertLiveOrigin('));
  const { sameSiteOrigin } = vm.runInNewContext(`${block}\n({ sameSiteOrigin })`, {});
  assert.equal(sameSiteOrigin('https://career.levtech.jp', 'https://auth.levtech.jp'), true);
  assert.equal(sameSiteOrigin('https://access.line.me', 'https://chat.line.biz'), true);
  assert.equal(sameSiteOrigin('https://career.levtech.jp', 'https://accounts.google.com'), false);
  assert.equal(sameSiteOrigin('https://www.hays.co.jp', 'https://www.jac-recruitment.jp'), false);
});
