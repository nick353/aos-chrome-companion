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
