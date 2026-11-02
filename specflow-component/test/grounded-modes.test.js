'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),os=require('node:os'),path=require('node:path');
const {SqliteRagIndex}=require('../src/sqlite-rag');
const {ask,askStream,filterEvidence,checkCitations}=require('../src/qa');
const {createStubLlm}=require('./stub-llm-server');
test('incidental shared words do not establish evidence and invented citations fail closed',()=>{
 assert.deepEqual(filterEvidence([{title:'建筑电气工程施工质量验收规范',snippet:'发生过玻璃罩溅落的事件。'}],'黑洞的事件视界是什么？'),[]);
 assert.match(checkCitations('需要 28 天。[99]',[{n:1}]),/未通过/);
 assert.match(checkCitations('需要 28 天。',[{n:1}]),/未通过/);
});
test('persistent FTS index is reusable, scoped and reads bounded candidates without reopening canonical files',async()=>{
 const root=fs.mkdtempSync(path.join(os.tmpdir(),'component-fts-'));let index;
 try{
  for(const id of ['a','b']){fs.mkdirSync(path.join(root,id));fs.writeFileSync(path.join(root,id,'document.json'),JSON.stringify({document:{id,title:'施工规范'+id},pages:[{number:1}],items:Array.from({length:3000},(_,n)=>({id:id+n,page:1,order:n,type:'text',text:n===100?'5.2.3 承台混凝土养护应采用覆盖保湿。':'其他工作记录项目编号 '+n+'。',bbox:{pdf:[10,20,100,40],normalized:[.1,.2,.8,.4]}}))}));}
  index=new SqliteRagIndex({library:root});await index.refresh();assert.equal(index.loaded,6000);
  const read=fs.readFileSync;fs.readFileSync=()=>{throw Error('query must not read documents');};
  try{const hits=index.search('承台混凝土养护',{docIds:['a'],topK:3});assert.equal(hits[0].docId,'a');assert.deepEqual(hits[0].bboxNormalized,[.1,.2,.8,.4]);assert.deepEqual(index.search('混凝土',{docIds:[]}),[]);assert.ok(index.entries.length<=3);}finally{fs.readFileSync=read;}
  await index.close();index=new SqliteRagIndex({library:root});assert.ok(index.isReady);assert.equal(index.search('承台混凝土养护',{topK:1})[0].itemId,'a100');
 }finally{await index?.close();fs.rmSync(root,{recursive:true,force:true,maxRetries:20,retryDelay:50});}
});
test('three answering modes isolate evidence, unrelated history and general fallback for JSON and SSE',async()=>{
 const stub=createStubLlm({answer:'规范要求采用覆盖保湿。[1]'}),port=await stub.listen();
 const settings={llm:{baseUrl:'http://127.0.0.1:'+port+'/v1',model:'stub-model',timeoutMs:5000}};
 const rag={entries:[],build(){},search(){return [{docId:'foundation',title:'风机基础规范',page:12,itemId:'p12',snippet:'5.2.3 承台混凝土养护应采用覆盖保湿。',score:20,bboxNormalized:[.1,.2,.8,.4]}];}};
 try{
  const strict=await ask({question:'承台混凝土养护要求',retrievalMode:'knowledge'}, {rag,settings});assert.equal(strict.grounding,'knowledge');assert.match(strict.answer,/\[1\]/);
  const auto=await ask({question:'承台混凝土养护要求',retrievalMode:'auto'}, {rag,settings});assert.equal(auto.grounding,'knowledge');assert.match(JSON.stringify(stub.state.lastBody),/不得用常识补齐/);
  const before=stub.state.calls;
  const miss=await ask({question:'推荐咖啡豆',retrievalMode:'knowledge'}, {rag,settings});assert.equal(miss.mode,'empty');assert.equal(stub.state.calls,before);
  const general=await ask({question:'推荐咖啡豆',retrievalMode:'auto',history:[{role:'user',content:'承台混凝土养护要求'}]}, {rag,settings});assert.equal(general.grounding,'general');assert.deepEqual(general.citations,[]);assert.doesNotMatch(stub.state.lastBody.messages.at(-1).content,/可用资料片段/);
  let searches=0;const direct={...rag,search(){searches++;return [];}};await ask({question:'综合楼消防间距',retrievalMode:'general'}, {rag:direct,settings});assert.equal(searches,0);
  const events=[];await askStream({question:'承台混凝土养护要求',retrievalMode:'auto'}, {rag,settings},e=>events.push(e));assert.ok(events.some(e=>e.type==='delta'));assert.equal(events.find(e=>e.type==='done').grounding,'knowledge');assert.ok(events.find(e=>e.type==='done').timings.firstTokenMs>=0);
 }finally{await stub.close();}
});
