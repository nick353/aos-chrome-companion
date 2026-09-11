import assert from 'node:assert/strict';
import test from 'node:test';
import {mkdtemp,writeFile,symlink,mkdir,rm,realpath} from 'node:fs/promises';
import {join,basename} from 'node:path';
import {tmpdir} from 'node:os';
import {createHash} from 'node:crypto';
import {verifyDownloadedArtifact} from '../src/broker/download-artifact.mjs';

async function fixture(t,body='名前,内容\n田中,保存済み 👩🏽‍💻\n') {
  const directory=await mkdtemp(join(tmpdir(),'companion-artifact-'));t.after(()=>rm(directory,{recursive:true,force:true}));
  const filePath=join(directory,'成果物.csv');await writeFile(filePath,body);
  return {directory,body,filePath,receipt:{source:'chrome.downloads',state:'complete',downloadId:19,tabId:7,filePath,fileSize:Buffer.byteLength(body),mimeType:'text/csv',bytesReceived:5,totalBytes:5}};
}
test('download verification reads the real UTF-8 file, returns its absolute artifact path and hashes decompressed content',async t=>{
  const f=await fixture(t);const artifact=await verifyDownloadedArtifact(f.receipt,{expectedTabId:7});
  assert.equal(artifact.verified,true);assert.equal(artifact.path,await realpath(f.filePath));assert.equal(artifact.filename,basename(f.filePath));assert.equal(artifact.bytes,Buffer.byteLength(f.body));
  assert.equal(artifact.sha256,createHash('sha256').update(f.body).digest('hex'));assert.equal(artifact.contentReturned,false);assert.doesNotMatch(JSON.stringify(artifact),/田中/);
});
test('an empty completed download is a real zero-byte artifact',async t=>{
  const f=await fixture(t,'');const result=await verifyDownloadedArtifact(f.receipt,{expectedTabId:7});assert.equal(result.bytes,0);assert.equal(result.sha256,createHash('sha256').update('').digest('hex'));
});
test('unknown Chrome fileSize still verifies readable stable content without treating transfer bytes as file length',async t=>{
  const f=await fixture(t);const result=await verifyDownloadedArtifact({...f.receipt,fileSize:-1},{expectedTabId:7});assert.equal(result.fileSizeMatched,null);assert.equal(result.bytes,Buffer.byteLength(f.body));
});
test('missing or mismatched completed files require readback and never a second download',async t=>{
  const f=await fixture(t);
  for(const [patch,code] of [[{filePath:join(f.directory,'missing')},'download_file_missing'],[{fileSize:1},'download_file_size_mismatch'],[{filePath:'relative.csv'},'download_file_path_missing']]){
    await assert.rejects(verifyDownloadedArtifact({...f.receipt,...patch},{expectedTabId:7}),error=>error.code===code&&error.details.downloadComplete===true&&error.details.retryDownload===false&&error.details.operationEffectState==='known_effect');
  }
});
test('download verification rejects links, directories and receipts for another target',async t=>{
  const f=await fixture(t);const link=join(f.directory,'link.csv'),directory=join(f.directory,'folder');await symlink(f.filePath,link);await mkdir(directory);
  for(const filePath of [link,directory])await assert.rejects(verifyDownloadedArtifact({...f.receipt,filePath},{expectedTabId:7}),{code:'download_file_not_regular'});
  for(const patch of [{source:'caller-input'},{state:'in_progress'},{downloadId:null},{tabId:8}])await assert.rejects(verifyDownloadedArtifact({...f.receipt,...patch},{expectedTabId:7}),{code:'download_completion_receipt_invalid'});
});
