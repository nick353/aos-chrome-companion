import assert from 'node:assert/strict';
import test from 'node:test';
import * as z from 'zod/v4';
import { transactionActionSchema } from '../src/mcp/action-schema.mjs';
import { AUTHORIZED_TRANSACTION_METHODS } from '../src/shared/operation-schema.mjs';
const schema = transactionActionSchema(z.object({ label:z.string().min(1) }));
const locator = {label:'Target'};
const proof = {signature:'opaque',inspection:{point:{x:5,y:6}}};

test('required action arguments reject incomplete operations before dispatch', () => {
  for (const method of ['page.download','clipboard.write','page.handleDialog','page.waitFor','page.submit','page.webMcpCall','visual.drag']) {
    assert.equal(schema.safeParse({method,params:{visualProof:proof}}).success,false,method);
  }
  assert.equal(schema.safeParse({method:'page.selectOption',params:{locator,visualProof:proof,option:{}}}).success,false);
  assert.equal(schema.safeParse({method:'page.selectOption',params:{locator,visualProof:proof,option:{label:'Yes',index:0}}}).success,false);
  assert.equal(schema.safeParse({method:'page.type',params:{locator,text:'Text',physicalFallback:'always'}}).success,false);
});

test('supported visual controls and no-argument navigation remain expressible', () => {
  const destinationProof = {...proof,signature:'destination'};
  const drag=schema.parse({method:'visual.drag',params:{visualProof:proof,toVisualProof:destinationProof,steps:12}});
  assert.deepEqual(drag.params.toVisualProof,destinationProof);
  assert.equal(schema.safeParse({method:'visual.drag',params:{visualProof:proof,to:{x:10,y:20}}}).success,false);
  for (const modifiers of [['meta','shift'],'Meta+Shift']) {
    assert.equal(schema.safeParse({method:'visual.pressKey',params:{visualProof:proof,key:'a',modifiers,allowShortcut:true}}).success,true);
  }
  for (const method of ['tabs.back','tabs.forward','tabs.reload','page.delay']) assert.deepEqual(schema.parse({method}).params,{});
  assert.equal(schema.parse({method:'page.selectOption',params:{locator,visualProof:proof,option:{value:''}}}).params.option.value,'');
});

test('selectOption accepts a native multiple selection set while retaining the legacy object contract', () => {
  for (const option of [{label:'Yes'}, {value:'yes'}, {index:0}, [{label:'Yes'}], [{value:'yes'}, {index:2}], []]) {
    assert.equal(schema.safeParse({method:'page.selectOption',params:{locator,visualProof:proof,option}}).success,true,JSON.stringify(option));
  }
  for (const option of [{}, {label:'Yes',value:'yes'}, {label:'Yes',index:0}, [{label:'Yes',value:'yes'}], [{}], [{index:-1}], [{label:'Yes'}, {}], [{label:1}]]) {
    assert.equal(schema.safeParse({method:'page.selectOption',params:{locator,visualProof:proof,option}}).success,false,JSON.stringify(option));
  }
});

test('rich-text schema advertises only implemented operations and block tags', () => {
  for (const operation of ['bold', 'heading', 'formatBlock', 'unorderedList', 'ordered-list', 'horizontalRule']) {
    assert.equal(schema.safeParse({method:'page.richText',params:{locator,operation,text:'Title',blockTag:'h2'}}).success,true);
  }
  for (const params of [{operation:'insertLink'}, {operation:'strikethrough'}, {operation:'heading',blockTag:'table'}, {operation:'bold',text:''}]) {
    assert.equal(schema.safeParse({method:'page.richText',params:{locator,...params}}).success,false);
  }
  const json=z.toJSONSchema(schema,{target:'draft-7'});
  const drag=json.oneOf.find(branch => branch.properties.method.const === 'visual.drag').properties.params;
  assert.ok(drag.required.includes('toVisualProof'));
  assert.equal('to' in drag.properties,false);
});

test('every advertised transaction method has a concrete params object in MCP schema', () => {
  const json=z.toJSONSchema(schema,{target:'draft-7'});
  assert.equal(json.oneOf.length,AUTHORIZED_TRANSACTION_METHODS.length);
  for (const branch of json.oneOf) {
    assert.equal(branch.properties.params.type,'object');
    assert.ok(branch.properties.params.properties,branch.properties.method.const);
  }
});

test('dialog schema preserves explicit empty prompt text and browser-owned empty beforeunload messages', () => {
  for (const params of [
    {expectedMessage:'Label',expectedType:'prompt',accept:true,promptText:''},
    {expectedMessage:'',expectedType:'beforeunload',accept:false},
    {expectedMessage:'Label',expectedType:'prompt',accept:true,promptText:'日本語 👩🏽‍💻'},
  ]) assert.deepEqual(schema.parse({method:'page.handleDialog',params}).params,params);
  assert.equal(schema.safeParse({method:'page.handleDialog',params:{expectedMessage:'Label',accept:true,promptText:123}}).success,false);
  assert.equal(schema.safeParse({method:'page.handleDialog',params:{expectedMessage:'Label',accept:true,promptText:'x'.repeat(10001)}}).success,false);
});

test('download arguments select exactly one URL or a media locator', () => {
  assert.equal(schema.safeParse({method:'page.download',params:{url:'https://page.test/file'}}).success,true);
  assert.equal(schema.safeParse({method:'page.download',params:{locator}}).success,true);
  assert.equal(schema.safeParse({method:'page.download',params:{url:'https://page.test/file',locator}}).success,false);
  assert.equal(schema.safeParse({method:'page.download',params:{filename:'result.txt'}}).success,false);
});
