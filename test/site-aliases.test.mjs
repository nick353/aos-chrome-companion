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
