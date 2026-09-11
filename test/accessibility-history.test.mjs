import test from 'node:test';
import assert from 'node:assert/strict';
import { AccessibilityHistory } from '../extension/accessibility-history.js';
const owner={taskId:'task-a',sessionId:'session-a',generation:'gen-a',tabId:1};
const node=(nodeId,name)=>({nodeId,parentId:null,childIds:[],role:'button',name,properties:{}});
const snapshot=(nodes=[node('1','One')])=>({kind:'native_accessibility_snapshot',url:'https://example.test/',documentLoaderId:'doc-a',cdpFrameId:'frame-a',framePath:[],depth:12,maxNodes:500,includeIgnored:false,nodes,truncated:false});
test('AX indices belong to one snapshot and returned mutations cannot poison its baseline',()=>{
 const h=new AccessibilityHistory(),first=h.capture(snapshot(),owner);assert.equal(first.nodes[0].index,1);assert.equal(first.indicesAreSnapshotLocal,true);assert.equal(first.indexActionsSupported,false);
 first.nodes[0].name='forged';const next=h.capture(snapshot(),owner,first.snapshotId);assert.equal(next.kind,'native_accessibility_diff');assert.equal(next.nodes,undefined);assert.equal(next.diff.changed.length,0);assert.equal(next.diff.unchangedCount,1);
});
test('AX diff reports additions, removals and changed states from the observed nodes',()=>{
 const h=new AccessibilityHistory(),first=h.capture(snapshot([node('1','One'),node('2','Two'),node('3','Three')]),owner);
 const next=h.capture(snapshot([node('1','Changed'),node('2','Two'),node('4','Four')]),owner,first.snapshotId);
 assert.deepEqual(next.diff.added.map(n=>n.nodeId),['4']);assert.deepEqual(next.diff.removedNodeIds,['3']);assert.deepEqual(next.diff.changed.map(n=>n.nodeId),['1']);assert.equal(next.diff.unchangedCount,1);assert.equal(next.diff.complete,true);
});
test('foreign task, session, generation or tab cannot read a baseline',()=>{
 const h=new AccessibilityHistory(),first=h.capture(snapshot(),owner);
 for(const field of Object.keys(owner))assert.throws(()=>h.capture(snapshot(),{...owner,[field]:field==='tabId'?2:'foreign'},first.snapshotId),{code:'accessibility_baseline_unavailable'});
});
test('document and selected frame changes cannot be interpreted as a tree diff',()=>{
 const h=new AccessibilityHistory(),first=h.capture(snapshot(),owner);
 for(const patch of [{documentLoaderId:'replacement'},{cdpFrameId:'replacement'},{framePath:[0]},{url:'https://example.test/next'}])assert.throws(()=>h.capture({...snapshot(),...patch},owner,first.snapshotId),{code:'accessibility_document_changed'});
});
test('different tree bounds require a new baseline',()=>{
 const h=new AccessibilityHistory(),first=h.capture(snapshot(),owner);
 for(const patch of [{depth:3},{maxNodes:50},{includeIgnored:true}])assert.throws(()=>h.capture({...snapshot(),...patch},owner,first.snapshotId),{code:'accessibility_options_changed'});
});
test('truncated snapshots never claim complete document change coverage',()=>{
 const h=new AccessibilityHistory(),first=h.capture({...snapshot(),truncated:true},owner),next=h.capture(snapshot(),owner,first.snapshotId);assert.equal(next.diff.complete,false);assert.ok(next.diff.limitation);
});
test('baselines expire, have bounded capacity, and clear only the closed session',()=>{
 let now=0;const h=new AccessibilityHistory({now:()=>now,limit:2,ttlMs:100});const first=h.capture(snapshot(),owner);h.capture(snapshot(),owner);h.capture(snapshot(),{...owner,sessionId:'session-b'});
 assert.equal(h.records.size,2);assert.throws(()=>h.capture(snapshot(),owner,first.snapshotId),{code:'accessibility_baseline_unavailable'});
 h.closeSession('session-a','gen-a');assert.equal(h.records.size,1);now=101;const next=h.capture(snapshot(),owner);assert.equal(h.records.size,1);assert.ok(h.records.has(next.snapshotId));h.clear();assert.equal(h.records.size,0);
});
test('a read without an authenticated task/session owner cannot retain AX state',()=>{
 const h=new AccessibilityHistory();assert.throws(()=>h.capture(snapshot(),{},undefined),{code:'accessibility_owner_required'});assert.equal(h.records.size,0);
});
