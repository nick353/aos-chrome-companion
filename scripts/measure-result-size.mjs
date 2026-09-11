#!/usr/bin/env node
// Compare both presentations of the same recorded MCP result, without a new
// browser operation or any change to the source receipt.
import assert from 'node:assert/strict';
import {readFile,writeFile} from 'node:fs/promises';
import {resolve,dirname} from 'node:path';
import {createHash} from 'node:crypto';
import {toolResult} from '../src/mcp/result.mjs';
if(!process.argv[2] || !process.argv[3])throw Error('Usage: measure-result-size.mjs INPUT_RECEIPT OUTPUT_JSON');
const input=resolve(process.argv[2]),output=resolve(process.argv[3]);assert.notEqual(input,output);
const source=await readFile(input),receipt=JSON.parse(source);const size=value=>Buffer.byteLength(typeof value==='string'?value:JSON.stringify(value),'utf8'),cases=[];
for(const call of receipt.calls??[]){
  if(call.result?.schema!=='aos.chrome_companion.transaction.v1')continue;
  const value=structuredClone(call.result),screens=[];
  function visit(item){if(!item || typeof item!=='object')return;if(item.kind==='screenshot')screens.push(item);for(const child of Object.values(item))visit(child);}
  visit(value);assert.equal(screens.length,(call.images??[]).length,'Recorded image mapping must be unambiguous');
  for(const [i,file] of (call.images??[]).entries()){const imagePath=resolve(file);assert.equal(dirname(imagePath),dirname(input),'Read only image files beside this receipt');screens[i].dataBase64=(await readFile(imagePath)).toString('base64');}
  const full=toolResult(value,{textDetail:'full'}),summary=toolResult(value,{textDetail:'summary'});
  assert.deepEqual(full.structuredContent,summary.structuredContent,'Structured caller evidence must remain identical');
  assert.deepEqual(full.content.filter(block=>block.type==='image'),summary.content.filter(block=>block.type==='image'),'Native images must remain identical');
  const fullText=full.content.find(block=>block.type==='text').text,summaryText=summary.content.find(block=>block.type==='text').text;
  const savedText=size(fullText)-size(summaryText),savedPayload=size(full)-size(summary);
  cases.push({label:call.label,result:call.result.result,fullTextBytes:size(fullText),summaryTextBytes:size(summaryText),savedTextBytes:savedText,savedTextPercent:Number((savedText/size(fullText)*100).toFixed(2)),
    fullPayloadBytes:size(full),summaryPayloadBytes:size(summary),savedPayloadBytes:savedPayload,savedPayloadPercent:Number((savedPayload/size(full)*100).toFixed(2)),
    nativeImages:full.content.filter(block=>block.type==='image').length,structuredEvidenceUnchanged:true,nativeImagesUnchanged:true});
}
assert.ok(cases.length>0,'No transaction results in the supplied receipt');
const report={at:new Date().toISOString(),source:input,sourceSha256:createHash('sha256').update(source).digest('hex'),cases,
  totals:Object.fromEntries(['fullTextBytes','summaryTextBytes','savedTextBytes','fullPayloadBytes','summaryPayloadBytes','savedPayloadBytes'].map(key=>[key,cases.reduce((sum,item)=>sum+item[key],0)])),
  scope:'UTF-8 serialized bytes for identical recorded results and images. This is not a token count, model cost measurement, live latency comparison or a new browser success.'};
await writeFile(output,JSON.stringify(report,null,2)+'\n');console.log(JSON.stringify({output,cases:cases.length,totals:report.totals}));
