import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
const source=await readFile(new URL('../scripts/install-local-macos.mjs',import.meta.url),'utf8');
test('installer verifies and atomically preserves old contract before app replacement',()=>{
  const verify=source.indexOf('await verifyInstalledRefreshContract(appDir, { expectedBuildId: previousInstallBuildId })');
  const save=source.indexOf('await saveRefreshContractHistory(refreshContractHistory.path, previousContract)');
  const swap=source.indexOf('await rename(appDir, backupDir)');
  assert.ok(verify>0&&save>verify&&swap>save);
  assert.match(source,/join\(dirname\(resolveBrokerSocketPath\(\)\), "refresh-contract-history.json"\)/);
});
test('failed old-tree verification cannot claim a captured trusted contract',()=>{
  assert.match(source,/captured: false, exactBlocker: null/);
  assert.ok(source.indexOf('refreshContractHistory.captured = true')>source.indexOf('await saveRefreshContractHistory'));
  assert.match(source,/refreshContractHistory.exactBlocker = error\?\.code \?\? error.message/);
  assert.match(source,/installBuildIdReused,\s+refreshContractHistory,/);
});
