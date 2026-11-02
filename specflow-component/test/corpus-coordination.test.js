'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),os=require('node:os');
const {SqliteRagIndex}=require('../src/sqlite-rag'),{ask,buildContexts}=require('../src/qa'),{createStubLlm}=require('./stub-llm-server');
test('whole-corpus Q&A considers every indexed document despite a dominant book and stale single-file scope',async()=>{
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'kb-corpus-'));let index;const stub=createStubLlm({answer:'各规范分别规定养护、温控和试验检验要求。[1][2][3]'}),port=await stub.listen();
 try{const texts={a:'混凝土养护施工要求，养护温度控制。',b:'混凝土养护应覆盖并洒水，湿度和养护时间应满足设计要求。',c:'混凝土养护低于5℃时不得洒水，试验检验取样应留存记录。'};
  for(const [id,text] of Object.entries(texts)){fs.mkdirSync(path.join(dir,id));fs.writeFileSync(path.join(dir,id,'document.json'),JSON.stringify({document:{id,title:'混凝土规范'+id},pages:[{number:1}],items:Array.from({length:id==='a'?300:1},(_,n)=>({id:id+n,page:1,type:'text',order:n,text,bbox:{normalized:[.1,.1,.8,.2]}}))}));}
  index=new SqliteRagIndex({library:dir});await index.refresh();
  const result=await ask({question:'请综合全部规范说明混凝土养护温度控制、养护时间及试验检验要求',retrievalMode:'knowledge',searchScope:'all',docIds:['a']},{rag:index,settings:{llm:{baseUrl:'http://127.0.0.1:'+port+'/v1',model:'stub-model'}},corpusStatus:()=>({totalDocuments:5,indexedDocuments:3,pendingDocuments:2})});
  assert.equal(result.retrieval.coverage.scope,'all');assert.equal(result.retrieval.coverage.searchedDocuments,3);assert.equal(result.retrieval.coverage.pendingDocuments,2);assert.deepEqual([...new Set(result.citations.map(c=>c.docId))].sort(),['a','b','c']);
  const prompt=stub.state.lastBody.messages.at(-1).content;for(const id of ['a','b','c'])assert.ok(prompt.includes('混凝土规范'+id));assert.match(stub.state.lastBody.messages[0].content,/不同规范有差异时并列引用/);
 }finally{await stub.close();await index?.close();fs.rmSync(dir,{recursive:true,force:true,maxRetries:20,retryDelay:50});}
});
test('bounded context retains balanced document sources and marks truncated excerpts',()=>{
 const hits=Array.from({length:60},(_,n)=>({docId:'d'+n,title:'规范'+n,page:1,itemId:'i'+n,snippet:'混凝土养护要求。'.repeat(160)}));const out=buildContexts(hits);assert.equal(new Set(out.citations.map(c=>c.docId)).size,60);assert.ok(out.contextText.length<=30000);assert.match(out.contextText,/片段截断/);
});
test('a clause introduction expands its numbered requirements across PDF pages without including the next clause',async()=>{
 const root=fs.mkdtempSync(path.join(os.tmpdir(),'kb-rule-'));let index;
 try{fs.mkdirSync(path.join(root,'book'));fs.writeFileSync(path.join(root,'book/document.json'),JSON.stringify({document:{id:'book',title:'混凝土规范'},pages:[{number:37},{number:38}],items:[{id:'head',page:37,type:'text',order:0,text:'9.5.10 混凝土养护应符合下列规定：'},{id:'sub',page:38,type:'text',order:1,text:'5、当气温低于5℃时不得向混凝土表面洒水。'},{id:'other',page:38,type:'text',order:2,text:'9.6 基础防腐施工要求。'}]}));index=new SqliteRagIndex({library:root});await index.refresh();const out=index.searchCorpus('混凝土养护');const hit=out.hits.find(h=>h.itemId==='head');assert.match(hit.snippet,/低于5℃/);assert.match(hit.snippet,/续至 PDF 第 38 页/);assert.doesNotMatch(hit.snippet,/基础防腐/);}finally{await index?.close();fs.rmSync(root,{recursive:true,force:true,maxRetries:20,retryDelay:50});}
});
test('desktop keeps application background mode separate from Chromium headless and isolates UI profile',()=>{
 const source=fs.readFileSync(path.join(__dirname,'../desktop/main.cjs'),'utf8');assert.match(source,/removeSwitch\('headless'\)/);assert.match(source,/desktop-profile-service/);assert.match(source,/desktop-profile-ui/);
});
