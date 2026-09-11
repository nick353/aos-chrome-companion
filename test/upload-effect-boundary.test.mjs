import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import test from 'node:test';
const source=await readFile(new URL('../extension/service-worker.js',import.meta.url),'utf8');
const begin=source.indexOf('  if (action === "upload" || action === "uploadMultiple") {', source.indexOf('async function injectedPageOperation(')), end=source.indexOf('  if (action === "waitFor") {',begin);
const injectedEnd=source.indexOf('\nchrome.runtime.onMessage.addListener');
const catcher=source.lastIndexOf('  } catch (error) {',injectedEnd);
const AsyncFunction=Object.getPrototypeOf(async function(){}).constructor;
// Execute the production upload branches and production serialization catch,
// keeping the FileList assignment and event boundary observable in a DOM double.
const run=new AsyncFunction('env',`with(env){let uploadMutationAttempted=false;try {${source.slice(begin,end)}${source.slice(catcher,injectedEnd)}`);
function fixture({action='upload',findError=false,afterAssignmentError=false,badData=false}={}){
 let assignments=0,events=0;
 class Input {type='file';labels=[];stored=[];get files(){return this.stored;}set files(value){assignments++;this.stored=value;if(afterAssignmentError)throw Error('setter failed after write');}scrollIntoView(){}dispatchEvent(){events++;} }
 const element=new Input();
 class Transfer {files=[];items={add:file=>this.files.push(file)};}
 const file={name:'日本語.txt',mimeType:'text/plain',dataBase64:badData?'%%%':Buffer.from('fixture').toString('base64')};
 const env={action,payload:{locator:{label:'添付'},file,files:[file]},HTMLInputElement:Input,DataTransfer:Transfer,document:{visibilityState:'hidden'},
   find:(_locator,options)=>{assert.equal(options.fileInputOnly,true);if(findError)throw Object.assign(Error('ambiguous'),{code:'semantic_locator_ambiguous'});return element;},
   visible:()=>true,visualize:async()=>{},normalize:v=>String(v??''),describe:()=>({tag:'input'}),wait:async()=>{},pageInstanceId:'fixture-page',location:{href:'http://127.0.0.1:1234/'},
   operationError:(code,message,details)=>Object.assign(Error(message),{code,details})};
 return {env,assignments:()=>assignments,events:()=>events};
}
for(const action of ['upload','uploadMultiple'])test(action+' locator errors are explicitly before file assignment',async()=>{
 const f=fixture({action,findError:true});const value=await run(f.env);
 assert.equal(value.__aosCompanionError.code,'semantic_locator_ambiguous');
 assert.equal(value.__aosCompanionError.details.operationEffectState,'none');
 assert.equal(value.__aosCompanionError.details.mutationDispatchAttempted,false);
 assert.equal(f.assignments(),0);assert.equal(f.events(),0);
});
test('invalid upload bytes remain a no-effect preparation failure',async()=>{
 const f=fixture({badData:true});const value=await run(f.env);assert.equal(value.__aosCompanionError.details.mutationDispatchAttempted,false);assert.equal(f.assignments(),0);
});
test('a file setter error after assignment never reports no effect',async()=>{
 const f=fixture({afterAssignmentError:true});const value=await run(f.env);assert.equal(f.assignments(),1);assert.notEqual(value.__aosCompanionError.details?.operationEffectState,'none');
});
test('normal upload still assigns once and dispatches the native input and change events',async()=>{
 const f=fixture();const value=await run(f.env);assert.equal(value.uploaded,true);assert.equal(value.readback.file.size,7);assert.equal(f.assignments(),1);assert.equal(f.events(),2);
 assert.equal(value.uploadTiming.pageVisibility,'hidden');assert.ok(value.uploadTiming.prepareMs>=0);assert.ok(value.uploadTiming.assignmentReadbackMs>=0);
});
test('multiple upload verifies prepared file sizes without decoding the payload twice',async()=>{
 const f=fixture({action:'uploadMultiple'});let decodes=0;f.env.atob=v=>{decodes++;return atob(v);};
 const value=await run(f.env);assert.equal(value.uploaded,true);assert.equal(value.files[0].size,7);assert.equal(decodes,1);assert.equal(f.assignments(),1);assert.equal(f.events(),2);
});
