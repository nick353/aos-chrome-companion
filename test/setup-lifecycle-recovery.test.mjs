import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { chmod, lstat, mkdir, mkdtemp, readFile, realpath, rename, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { acquireCompanionLock, releaseCompanionLock } from "../src/setup/auto-setup.mjs";
import { companionLockTransaction } from "../src/setup/lock-transaction.mjs";

const api = new URL("../src/setup/auto-setup.mjs", import.meta.url).href;
const helper = fileURLToPath(new URL("../src/setup/lock-transaction.pl", import.meta.url));
const token = "12345678-1234-1234-1234-123456789abc";
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
async function fixture(run) {
  const root = await realpath(await mkdtemp(join(tmpdir(), "setup-kernel-lifecycle-")));
  try { await run(join(root, "setup.lock"), root); } finally { await rm(root, { recursive: true, force: true }); }
}
function reader(child) {
  const messages = [], waiters = []; let output = "";
  child.stdout.on("data", data => {
    output += data;
    while (output.includes("\n")) {
      const end = output.indexOf("\n"), line = output.slice(0, end); output = output.slice(end + 1);
      const message = JSON.parse(line); messages.push(message);
      for (const waiter of [...waiters]) if (waiter.predicate(message)) { waiters.splice(waiters.indexOf(waiter), 1); clearTimeout(waiter.timer); waiter.resolve(message); }
    }
  });
  return predicate => new Promise((resolve, reject) => {
    const found = messages.find(predicate); if (found) return resolve(found);
    const waiter = { predicate, resolve, timer: setTimeout(() => reject(Error("fixture child message timeout")), 4000) }; waiters.push(waiter);
  });
}
async function dead(pid) {
  for (let index = 0; index < 100; index++) {
    try { process.kill(pid, 0); } catch (error) { if (error.code === "ESRCH") return; throw error; }
    await delay(10);
  }
  throw Error(`owned fixture helper did not exit: ${pid}`);
}
function actor(path, phase, action = "acquire") {
  const code = `import {acquireCompanionLock,releaseCompanionLock} from ${JSON.stringify(api)};
    const path=process.argv[1], phase=process.argv[2], action=process.argv[3];
    const hook={testPauseAt:phase,onPhase:({phase,helperPid})=>{console.log(JSON.stringify({phase,helperPid,pid:process.pid})); return new Promise(()=>{});}};
    const lease=await acquireCompanionLock(path,action==='release'?{}:hook);
    const result=action==='release'?await releaseCompanionLock(lease,hook):lease;
    console.log(JSON.stringify({result,pid:process.pid}));setInterval(()=>{},1000);`;
  const child = spawn(process.execPath, ["--input-type=module", "-e", code, path, phase, action], { stdio: ["ignore", "pipe", "pipe"] });
  child.stderr.on("data", () => {});
  return { child, read: reader(child) };
}

test("SIGKILL parent at transaction boundaries releases kernel flock and only valid dead v2 markers recover", async () => {
  for (const [phase, action] of [["before_marker", "acquire"], ...["guard_stage_created", "guard_stage_partial", "guard_stage_written", "guard_before_publish",
    "work_stage_created", "work_stage_partial", "work_stage_written", "work_before_publish", "guard_published", "work_published"].map(phase => [phase,"acquire"]), ["after_guard", "acquire"], ["after_work", "acquire"],
    ["during_release", "release"], ["after_release", "release"]]) {
    await fixture(async path => {
      const a = actor(path, phase, action), message = await a.read(value => value.phase === phase);
      const inode = (await lstat(path + ".coordinator")).ino;
      a.child.kill("SIGKILL"); await once(a.child, "close"); await dead(message.helperPid);
      const recovered = await acquireCompanionLock(path);
      assert.equal(recovered.acquired, true, `${phase}: ${JSON.stringify(recovered)}`);
      assert.equal((await lstat(path + ".coordinator")).ino, inode);
      assert.equal((await releaseCompanionLock(recovered)).released, true);
    });
  }
});

test("helper loss recovers only an exact original commit without a second acquire", async () => fixture(async path => {
  for (const phase of ["before_marker", "after_guard", "after_work", "before_response"]) {
    const result = await acquireCompanionLock(path, { testPauseAt: phase, onPhase: ({ child }) => { child.kill("SIGKILL"); } });
    assert.equal(result.retryAllowed, false); assert.equal(result.reconciliation.inspected, true);
    if (phase === "after_work" || phase === "before_response") {
      assert.equal(result.reconciliation.workTokenMatches, true);
      assert.equal(result.reconciliation.work.pid, process.pid);
      assert.equal(result.acquired,true); assert.equal(result.originalCommitRecovered,true);
      const preserved = await readFile(path, "utf8");
      const blocked = await acquireCompanionLock(path); assert.equal(blocked.acquired, false);
      assert.equal(await readFile(path, "utf8"), preserved);
      assert.equal((await releaseCompanionLock(result)).released, true);
    } else if (phase === "after_guard") {
      assert.equal(result.acquired,false);
      assert.equal(result.reconciliation.work, null);
      assert.equal(result.reconciliation.originalGuardRecovered,true);
      const next = await acquireCompanionLock(path); assert.equal(next.acquired,true); await releaseCompanionLock(next);
    } else {
      assert.equal(result.acquired,false); assert.equal(result.exactBlocker,"companion_lock_transaction_result_unknown");
    }
  }
}));

test("lost release response reconciles absence without retrying release or claiming a new work owner", async () => fixture(async path => {
  const lease = await acquireCompanionLock(path);
  const result = await releaseCompanionLock(lease, { testPauseAt: "before_response", onPhase: ({ child }) => child.kill("SIGKILL") });
  assert.equal(result.released, true); assert.equal(result.retryAllowed, false);
  assert.equal(result.originalReleaseRecovered,true); assert.equal(result.work,null); assert.equal(result.guard,null);
  assert.equal((await acquireCompanionLock(path)).acquired, true);
}));

test("helper SIGKILL during staged partial/full writes never publishes malformed final markers", async () => {
  for (const kind of ["guard", "work"]) for (const cut of ["stage_created", "stage_partial", "stage_written", "before_publish"]) {
    await fixture(async path => {
      const phase = `${kind}_${cut}`;
      const result = await acquireCompanionLock(path, { testPauseAt: phase, onPhase: ({ child }) => child.kill("SIGKILL") });
      assert.equal(result.exactBlocker, "companion_lock_transaction_result_unknown");
      assert.equal(result.retryAllowed, false);
      await assert.rejects(lstat(path), { code: "ENOENT" });
      if (kind === "guard") await assert.rejects(lstat(path + ".guard.v2"), { code: "ENOENT" });
      else {
        await assert.rejects(lstat(path+".guard.v2"),{code:"ENOENT"});
        assert.equal(result.reconciliation.originalGuardRecovered,true);
      }
    });
  }
});

test("atomic publication refuses destination collisions and preserves foreign inode and bytes", async () => {
  for (const kind of ["guard", "work"]) await fixture(async path => {
    const destination = kind === "guard" ? path + ".guard.v2" : path;
    let foreign;
    const result = await acquireCompanionLock(path, { testPauseAt: `${kind}_before_publish`, onPhase: async () => {
      await writeFile(destination, "foreign-destination", { mode: 0o600, flag: "wx" }); foreign = await lstat(destination);
    } });
    assert.equal(result.acquired, false); assert.equal(result.exactBlocker, "companion_lock_marker_publish_failed");
    assert.equal((await lstat(destination)).ino, foreign.ino); assert.equal(await readFile(destination,"utf8"), "foreign-destination");
  });
});

test("helper loss at two-link publication retains complete final bytes and same original work inode", async () => {
  for (const kind of ["guard","work"]) await fixture(async path => {
    let stat;
    const result=await acquireCompanionLock(path,{testPauseAt:`${kind}_published`,onPhase:async({child})=>{
      stat=await lstat(kind==="work"?path:path+".guard.v2"); assert.equal(stat.nlink,2); child.kill("SIGKILL");
    }});
    if(kind==="work"){
      assert.equal(result.acquired,true); assert.equal(result.originalCommitRecovered,true);
      assert.equal((await lstat(path)).ino,stat.ino); assert.equal(JSON.parse(await readFile(path,"utf8")).acquireId,result.acquireId);
      assert.equal((await releaseCompanionLock(result)).released,true);
    }else{
      assert.equal(result.acquired,false); assert.equal(result.reconciliation.originalGuardRecovered,true);
      await assert.rejects(lstat(path+".guard.v2"),{code:"ENOENT"});
    }
  });
});

test("release killed immediately after work unlink reconciles absence without automatic retry", async () => fixture(async path => {
  const lease = await acquireCompanionLock(path);
  const result = await releaseCompanionLock(lease, { testPauseAt:"after_release", onPhase:({child})=>child.kill("SIGKILL") });
  assert.equal(result.released,true); assert.equal(result.retryAllowed,false);
  assert.equal(result.work,null); assert.equal(result.guard,null);
  const next=await acquireCompanionLock(path); assert.equal(next.acquired,true); await releaseCompanionLock(next);
}));

test("private parent identity replacement prevents protected writes under a replacement directory", async () => fixture(async (path,root) => {
  const moved = root + "-original";
  try {
    const result = await acquireCompanionLock(path, { testPauseAt:"after_guard", onPhase:async()=>{
      await rename(root,moved); await mkdir(root,{mode:0o700});
    } });
    assert.equal(result.exactBlocker,"companion_lock_parent_identity_changed");
    await assert.rejects(lstat(path),{code:"ENOENT"});
    await assert.rejects(lstat(join(moved,"setup.lock")),{code:"ENOENT"});
    assert.equal(JSON.parse(await readFile(join(moved,"setup.lock.guard.v2"),"utf8")).workPid,process.pid);
  } finally { await rm(moved,{recursive:true,force:true}); }
}));

test("live foreign work, mismatched token, legacy guard and malformed/mixed v2 markers stay intact", async () => fixture(async path => {
  const a = actor(path, ""), message = await a.read(value => value.result?.acquired);
  const original = await readFile(path, "utf8");
  assert.equal((await acquireCompanionLock(path)).acquired, false);
  assert.equal((await releaseCompanionLock(message.result)).released, false);
  assert.equal(await readFile(path, "utf8"), original);
  a.child.kill("SIGKILL"); await once(a.child, "close");
  const owned = await acquireCompanionLock(path);
  assert.equal((await releaseCompanionLock({ ...owned, token })).exactBlocker, "companion_lock_ownership_changed");
  assert.equal((await releaseCompanionLock(owned)).released, true);
  await mkdir(path + ".guard"); await writeFile(path + ".guard/owner.json", JSON.stringify({ pid: 2147483647, token }));
  const legacy = await readFile(path + ".guard/owner.json", "utf8");
  assert.equal((await acquireCompanionLock(path)).exactBlocker, "companion_lock_guard_legacy_or_uncertain");
  assert.equal(await readFile(path + ".guard/owner.json", "utf8"), legacy);
  await rm(path + ".guard", { recursive: true });
  const v2 = { ...owned, pid: 2147483647 }; delete v2.acquired; delete v2.lockPath;
  for (const changed of [{ ...v2, extra: true }, { ...v2, coordinator: { ...v2.coordinator, ino: "0" } }, { ...v2, pid: "2147483647" }]) {
    const bytes = JSON.stringify(changed); await writeFile(path, bytes);
    assert.equal((await acquireCompanionLock(path)).acquired, false); assert.equal(await readFile(path, "utf8"), bytes);
  }
}));

test("kernel contention is bounded separately from abandoned guards; concurrent leases retain one coordinator inode", async () => fixture(async path => {
  let continueTransaction, observed;
  const atPhase = new Promise(resolve => { observed = resolve; });
  const first = acquireCompanionLock(path, { testPauseAt: "after_guard", onPhase: () => { observed(); return new Promise(resolve => { continueTransaction = resolve; }); } });
  await atPhase;
  const blocked = await acquireCompanionLock(path, { guardWaitMs: 30 });
  assert.equal(blocked.exactBlocker, "companion_lock_coordinator_busy");
  continueTransaction(); const lease = await first; assert.equal(lease.acquired, true);
  const inode = (await lstat(path + ".coordinator")).ino; await releaseCompanionLock(lease);
  const leases = await Promise.all(Array.from({ length: 8 }, () => acquireCompanionLock(path)));
  assert.equal(leases.filter(value => value.acquired).length, 1);
  await releaseCompanionLock(leases.find(value => value.acquired));
  assert.equal((await lstat(path + ".coordinator")).ino, inode);
}));

test("dead helper guard cannot adopt mismatched work token or bypass a live foreign coordinator owner", async () => fixture(async path => {
  const result = await acquireCompanionLock(path,{testPauseAt:"after_work",onPhase:({child})=>child.kill("SIGKILL")});
  const guardPath = path + ".guard.v2", workBytes = await readFile(path,"utf8");
  const guardBytes = JSON.stringify({...result.reconciliation.work,schema:"companion_lock_guard.v3",pid:result.originalHelperPid,workPid:process.pid,transactionId:result.acquireId});
  await writeFile(guardPath,guardBytes);
  await writeFile(path,JSON.stringify({...JSON.parse(workBytes),token}));
  assert.equal((await acquireCompanionLock(path)).exactBlocker,"companion_lock_guard_work_binding_mismatch");
  assert.equal(await readFile(guardPath,"utf8"),guardBytes);
  await writeFile(path,workBytes);
  const liveGuard = JSON.stringify({...JSON.parse(guardBytes),pid:process.pid}); await writeFile(guardPath,liveGuard);
  assert.equal((await acquireCompanionLock(path)).exactBlocker,"companion_lock_guard_owner_live_or_unverifiable");
  assert.equal(await readFile(guardPath,"utf8"),liveGuard); assert.equal(await readFile(path,"utf8"),workBytes);
  await writeFile(guardPath,guardBytes);
  assert.equal((await releaseCompanionLock(result)).released,true);
}));

test("parent EOF terminates the helper before work creation; coordinator replacement/symlink/unsafe parent fail closed", async () => fixture(async (path, root) => {
  const child = spawn("/usr/bin/perl", [helper], { stdio: ["pipe", "pipe", "pipe"] }), read = reader(child);
  child.stderr.on("data", () => {});
  child.stdin.write(JSON.stringify({ action: "acquire", lockPath: path, pid: process.pid, token, acquireId:token, waitMs: 100, testPauseAt: "after_guard" }) + "\n");
  await read(value => value.phase === "after_guard"); child.stdin.end(); await once(child, "close");
  await assert.rejects(lstat(path), { code: "ENOENT" });
  assert.equal((await acquireCompanionLock(path)).acquired, false);
  await rm(path + ".guard.v2");
  const replaced = await acquireCompanionLock(path, { testPauseAt: "after_guard", onPhase: async () => {
    await rename(path + ".coordinator", path + ".saved-coordinator"); await writeFile(path + ".coordinator", "", { mode: 0o600 });
  } });
  assert.equal(replaced.exactBlocker, "companion_lock_coordinator_identity_changed");
  await assert.rejects(lstat(path), { code: "ENOENT" });
  assert.equal((await acquireCompanionLock(path)).acquired, false);
  await rm(path + ".guard.v2"); await rm(path + ".coordinator");
  await symlink(path + ".saved-coordinator", path + ".coordinator");
  assert.equal((await acquireCompanionLock(path)).exactBlocker, "companion_lock_symlink_not_allowed");
  await rm(path + ".coordinator"); await chmod(root, 0o777);
  assert.equal((await acquireCompanionLock(path)).exactBlocker, "companion_lock_path_not_private"); await chmod(root, 0o700);
}));

test("ambiguous wait timeout kills one helper and returns exact marker reconciliation", async () => fixture(async path => {
  const result = await acquireCompanionLock(path, { testPauseAt: "after_work", onPhase: () => new Promise(() => {}), transactionTimeoutMs: 500 });
  assert.equal(result.acquired, true); assert.equal(result.originalCommitRecovered,true); assert.equal(result.retryAllowed, false); assert.equal(result.reconciliation.workTokenMatches, true);
  assert.equal((await releaseCompanionLock(result)).released, true);
}));

test("original committed lease survives explicit postcommit IO failure and enters normal finally release", async () => fixture(async path => {
  const result = await acquireCompanionLock(path,{testFaultAt:"after_work"});
  assert.equal(result.acquired,true); assert.equal(result.originalCommitRecovered,true);
  assert.equal(result.originalFailure,"companion_lock_fixture_write_failed");
  const inode=(await lstat(path)).ino;
  assert.equal(JSON.parse(await readFile(path,"utf8")).acquireId,result.acquireId);
  assert.equal((await lstat(path)).ino,inode);
  assert.equal((await releaseCompanionLock(result)).released,true);
  const next=await acquireCompanionLock(path); assert.equal(next.acquired,true); await releaseCompanionLock(next);
}));

test("aborted original acquisition releases the recovered exact commit without starting protected work", async () => fixture(async path => {
  const controller=new AbortController(); let inode;
  const result=await acquireCompanionLock(path,{signal:controller.signal,testPauseAt:"after_work",onPhase:async({child})=>{
    inode=(await lstat(path)).ino; controller.abort(); child.kill("SIGKILL");
  }});
  assert.ok(inode); assert.equal(result.acquired,false); assert.equal(result.aborted,true);
  assert.equal(result.originalCommitRecovered,true); assert.equal(result.originalRelease.released,true);
  await assert.rejects(lstat(path),{code:"ENOENT"});
}));

test("original fullproof rejects live-helper, wrong acquireID, foreign guard and legacy without mutating markers", async () => fixture(async path => {
  let originalInode;
  const lease=await acquireCompanionLock(path,{testPauseAt:"after_work",onPhase:async({child})=>{
    originalInode=(await lstat(path)).ino; child.kill("SIGKILL");
  }});
  assert.equal(lease.originalCommitRecovered,true); assert.equal((await lstat(path)).ino,originalInode);
  const workBytes=await readFile(path,"utf8"), guardPath=path+".guard.v2";
  const base={token:lease.token,acquireId:lease.acquireId,coordinator:lease.coordinator,expectedHelperPid:lease.originalHelperPid,reconcileAcquire:true};
  for(const changed of [{expectedHelperPid:process.pid},{acquireId:token},{coordinator:{...lease.coordinator,ino:"0"}}]){
    const result=await companionLockTransaction("inspect",path,{...base,...changed});
    assert.notEqual(result.acquired,true); assert.equal(await readFile(path,"utf8"),workBytes); assert.equal((await lstat(path)).ino,originalInode);
  }
  const guard=JSON.stringify({...JSON.parse(workBytes),schema:"companion_lock_guard.v2",pid:lease.originalHelperPid,workPid:process.pid,acquireId:token,transactionId:token});
  await writeFile(guardPath,guard);
  assert.notEqual((await companionLockTransaction("inspect",path,base)).acquired,true);
  assert.equal(await readFile(guardPath,"utf8"),guard); assert.equal(await readFile(path,"utf8"),workBytes);
  assert.equal((await companionLockTransaction("inspect",path,{token:lease.token})).inspected,true);
  assert.equal(await readFile(guardPath,"utf8"),guard); await rm(guardPath);
  await mkdir(path+".guard");
  assert.notEqual((await companionLockTransaction("inspect",path,base)).acquired,true);
  assert.equal(await readFile(path,"utf8"),workBytes); await rm(path+".guard",{recursive:true});
  await releaseCompanionLock(lease);
}));

test("guard-only cleanup ACK loss stays terminal unknown and fresh ordinary inspection remains readonly", async () => fixture(async path => {
  const result=await acquireCompanionLock(path,{testPauseAt:"after_guard",onPhase:({child})=>child.kill("SIGKILL"),
    testReconcilePauseAt:"after_original_guard_cleanup",onReconcilePhase:({child})=>child.kill("SIGKILL")});
  assert.equal(result.acquired,false); assert.equal(result.retryAllowed,false);
  assert.equal(result.reconciliation.exactBlocker,"companion_lock_transaction_result_unknown");
  const fresh=await companionLockTransaction("inspect",path);
  assert.equal(fresh.work,null); assert.equal(fresh.guard,null);
  await assert.rejects(lstat(path),{code:"ENOENT"});
}));

test("committed-acquire proof ACK loss is recovered once by readonly proof and normal finally release", async () => fixture(async path => {
  let workInode,guardBytes;
  const lease=await acquireCompanionLock(path,{testPauseAt:"after_work",onPhase:async({child})=>{
    workInode=(await lstat(path)).ino; guardBytes=await readFile(path+".guard.v2","utf8"); child.kill("SIGKILL");
  },testReconcilePauseAt:"after_original_acquire_proof",onReconcilePhase:({child})=>child.kill("SIGKILL")});
  assert.equal(lease.acquired,true); assert.equal(lease.originalCommitRecovered,true);
  assert.equal((await lstat(path)).ino,workInode); assert.equal(await readFile(path+".guard.v2","utf8"),guardBytes);
  assert.equal((await releaseCompanionLock(lease)).released,true);
}));

test("original release helper loss before/after unlink is bounded and never orphans its living owner", async () => {
  for(const phase of ["before_binding","before_marker","guard_stage_partial","after_guard","during_release","after_release","before_response"])
    await fixture(async path=>{
      const lease=await acquireCompanionLock(path),coordinator=(await lstat(path+".coordinator")).ino;
      const released=await releaseCompanionLock(lease,{testPauseAt:phase,onPhase:({child})=>child.kill("SIGKILL")});
      assert.equal(released.released,true,`${phase}: ${JSON.stringify(released)}`); assert.equal(released.originalReleaseRecovered,true);
      assert.equal((await lstat(path+".coordinator")).ino,coordinator); await assert.rejects(lstat(path),{code:"ENOENT"});
      const next=await acquireCompanionLock(path); assert.equal(next.acquired,true); await releaseCompanionLock(next);
    });
});

test("release-finalizer ACK loss reconciles readonly absence while pre-unlink loss retains the exact lease", async () => {
  for(const phase of ["after_original_release_finalized","before_original_release_unlink"]) await fixture(async path=>{
    const lease=await acquireCompanionLock(path);
    const result=await releaseCompanionLock(lease,{testPauseAt:"during_release",onPhase:({child})=>child.kill("SIGKILL"),
      testReconcilePauseAt:phase,onReconcilePhase:({child})=>child.kill("SIGKILL")});
    if(phase==="after_original_release_finalized"){
      assert.equal(result.released,true); assert.equal(result.finalizerAckRecovered,true);
    }else{
      assert.equal(result.released,false); assert.equal(result.retryAllowed,false);
      assert.deepEqual(result.retainedLease.workIdentity,lease.workIdentity); assert.equal(result.retainedLease.workBytes,lease.workBytes);
      assert.equal(result.freshReadback.work.token,lease.token); assert.equal((await releaseCompanionLock(result.retainedLease)).released,true);
    }
  });
});

test("release original-proof rejects replacement inode, foreign guard and helper-live evidence without mutations", async()=>{
  for(const changed of ["inode","guard","helper_live"]) await fixture(async path=>{
    const lease=await acquireCompanionLock(path); let bytes;
    if(changed==="helper_live"){
      const proof=await companionLockTransaction("inspect",path,{reconcileRelease:true,expectedHelperPid:process.pid,
        token:lease.token,acquireId:lease.acquireId,coordinator:lease.coordinator,workIdentity:lease.workIdentity,workBytes:lease.workBytes,releaseId:token});
      assert.notEqual(proof.released,true); assert.equal(await readFile(path,"utf8"),lease.workBytes); await releaseCompanionLock(lease); return;
    }
    const result=await releaseCompanionLock(lease,{testPauseAt:"after_guard",onPhase:async({child})=>{
      if(changed==="inode") {await rename(path,path+".held-original"); await writeFile(path,lease.workBytes,{mode:0o600,flag:"wx"});}
      else{bytes=JSON.stringify({...JSON.parse(await readFile(path+".guard.v2","utf8")),transactionId:token}); await writeFile(path+".guard.v2",bytes);}
      child.kill("SIGKILL");
    }});
    assert.equal(result.released,false); assert.equal(result.retryAllowed,false); assert.ok(result.retainedLease);
    assert.equal(await readFile(path,"utf8"),lease.workBytes);
    if(changed==="guard")assert.equal(await readFile(path+".guard.v2","utf8"),bytes);
  });
});

test("normal release validates the complete held lease before clearing a present dead guard",async()=>{
  for(const changed of ["inode","coordinator","bytes","acquireId"]) await fixture(async path=>{
    const lease=await acquireCompanionLock(path,{testPauseAt:"after_work",onPhase:({child})=>child.kill("SIGKILL")});
    const guardPath=path+".guard.v2",guardBytes=await readFile(guardPath,"utf8"),workBytes=await readFile(path,"utf8");
    let badLease={...lease};
    if(changed==="inode"){
      await rename(path,path+".original-work"); await writeFile(path,workBytes,{mode:0o600,flag:"wx"});
    } else if(changed==="coordinator")badLease.coordinator={...lease.coordinator,ino:"0"};
    else if(changed==="bytes")badLease.workBytes=lease.workBytes+"\n";
    else badLease.acquireId=token;
    const workInode=(await lstat(path)).ino,guardInode=(await lstat(guardPath)).ino;
    const result=await releaseCompanionLock(badLease);
    assert.equal(result.released,false); assert.equal(result.exactBlocker,"companion_lock_ownership_changed");
    assert.equal(await readFile(guardPath,"utf8"),guardBytes); assert.equal((await lstat(guardPath)).ino,guardInode);
    assert.equal(await readFile(path,"utf8"),workBytes); assert.equal((await lstat(path)).ino,workInode);
  });
});
