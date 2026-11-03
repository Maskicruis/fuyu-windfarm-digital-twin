'use strict';
// Persisted inverted index. Parsing and index writes run outside the HTTP thread.
const fs=require('node:fs'),path=require('node:path');
const {Worker}=require('node:worker_threads');
const {workerJob}=require('./worker-job');
const {DatabaseSync}=require('node:sqlite');
const {tokenize}=require('./rag');
const SCHEMA=`CREATE TABLE IF NOT EXISTS docs(id TEXT PRIMARY KEY, signature TEXT, meta TEXT);
CREATE TABLE IF NOT EXISTS entries(id INTEGER PRIMARY KEY, docId TEXT, payload TEXT);
CREATE INDEX IF NOT EXISTS entries_doc ON entries(docId);
CREATE TABLE IF NOT EXISTS index_meta(key TEXT PRIMARY KEY,value TEXT);
CREATE VIRTUAL TABLE IF NOT EXISTS terms USING fts5(tokens, docId UNINDEXED, itemId UNINDEXED);`;
const scopeToken=id=>'kbdoc'+Buffer.from(String(id)).toString('hex');
class SqliteRagIndex {
 constructor(settings){
  this.settings=settings;fs.mkdirSync(settings.library,{recursive:true});
  this.filename=path.join(settings.library,'.search-index.sqlite');
  this.db=new DatabaseSync(this.filename);this.db.exec('PRAGMA journal_mode=WAL; PRAGMA busy_timeout=1500;'+SCHEMA);
  this.entries=[];this.error='';this.closed=false;this.syncStats();this.isReady=this.loaded>0&&this.db.prepare("SELECT value FROM index_meta WHERE key='version'").get()?.value==='2';this.build(true);
 }
 syncStats(){this.loaded=this.db.prepare('SELECT count(*) n FROM entries').get().n;this.docs=this.db.prepare('SELECT meta FROM docs').all().map(r=>JSON.parse(r.meta));}
 status(){return {engine:'sqlite-fts5',entries:this.loaded,documents:this.docs.length,ready:this.isReady,indexing:!!this.refreshing,error:this.error};}
 build(force=false){if(force||!this.started){this.started=true;this.refresh().catch(e=>{this.error=e.message;});}return this;}
 async refresh(){
  if(this.closed)return;
  if(this.refreshing){await this.refreshing;return this.refresh();}
  const worker=this.worker=new Worker(path.join(__dirname,'sqlite-rag-worker.js'),{workerData:{library:this.settings.library,filename:this.filename}});
  this.refreshing=workerJob(worker);
  try{await this.refreshing;if(!this.closed){this.syncStats();this.isReady=true;this.error='';}}
  finally{this.refreshing=null;this.worker=null;}
 }
 search(query,options={}){
  if(!this.isReady){const e=Error('资料索引正在后台建立，请稍后重试；通用模型可正常使用。');e.code='INDEX_BUILDING';throw e;}
  const tokens=[...new Set(options.tokens||tokenize(query))].filter(t=>t.length>1).slice(0,80);if(!tokens.length)return [];
  const ids=Array.isArray(options.docIds)?options.docIds:null;if(ids&&!ids.length)return [];
  const limit=Math.max(1,Math.min(50,Number(options.topK)||8));
  let match='('+tokens.map(t=>'"'+t.replace(/"/g,'""')+'"').join(' OR ')+')';
  if(ids)match+=' AND ('+ids.map(id=>'"'+scopeToken(id)+'"').join(' OR ')+')';
  const start=performance.now();
  this.queryStatement ||= this.db.prepare('SELECT e.id entryId,e.payload,candidates.rank FROM (SELECT rowid,bm25(terms) rank FROM terms WHERE terms MATCH ? ORDER BY rank LIMIT ?) candidates JOIN entries e ON e.id=candidates.rowid ORDER BY candidates.rank');
  const rows=this.queryStatement.all(match,limit);
  this.lastSearchMs=performance.now()-start;
  this.entries=rows.map(r=>JSON.parse(r.payload)); // Only bounded candidates, never all documents.
  return rows.map((r,i)=>{const p=JSON.parse(r.payload);return {...p,_entryId:r.entryId,n:i+1,score:-r.rank,snippet:p.text.slice(0,1200),matched:['fts5']};});
 }
 expandRule(hit){
  if(!hit.ref||!hit._entryId||!/下列|如下/.test(hit.snippet))return hit;
  this.followingStatement ||= this.db.prepare('SELECT payload FROM entries WHERE docId=? AND id>? ORDER BY id LIMIT 12');
  const fragments=[hit.snippet],sourceItemIds=[hit.itemId];let length=hit.snippet.length;
  for(const row of this.followingStatement.all(hit.docId,hit._entryId)){const p=JSON.parse(row.payload);if(p.ref&&p.ref!==hit.ref&&!p.ref.startsWith(hit.ref+'.'))break;if(length+p.text.length>2200)break;fragments.push((p.page!==hit.page?'〔续至 PDF 第 '+p.page+' 页〕':'')+p.text);sourceItemIds.push(p.itemId);length+=p.text.length;}
  return {...hit,snippet:fragments.join('\n'),sourceItemIds};
 }
 searchCorpus(query,options={}){
  if(!this.isReady)this.search(query,options);
  const selected=Array.isArray(options.docIds)?new Set(options.docIds):null;
  const documents=this.docs.filter(d=>!selected||selected.has(d.id));
  const queries=[...new Set([query,...(options.queries||[])])].filter(Boolean).slice(0,3);
  const queryTerms=queries.map(q=>[...new Set(tokenize(String(q).replace(/数据库|资料库|请综合|请结合|全库|全部|所有|规范|文件|说明|哪些|要求|比较|差异|相关|统筹|如何|应当|应该|回答|一句话/g,' ')))].filter(t=>t.length>1&&!/[的是什哪吗呢]/.test(t)));
  const candidates=new Map();let matchedDocuments=0;
  for(const document of documents){let matched=false;
   const titleTerms=new Set(tokenize(document.title));
   for(const tokens of queryTerms){const contentTerms=tokens.filter(t=>!titleTerms.has(t));const rows=this.search('',{tokens:contentTerms.length?contentTerms:tokens,docIds:[document.id],topK:Math.min(6,options.perDocument||3)});if(rows.length)matched=true;for(const row of rows){const key=row.docId+'|'+row.itemId,old=candidates.get(key);if(!old)candidates.set(key,this.expandRule(row));else if(row.score>old.score)old.score=row.score;}}
   if(matched)matchedDocuments++;
  }
  const hits=[...candidates.values()].sort((a,b)=>b.score-a.score);
  this.entries=hits.map(h=>({...h,text:h.text||h.snippet}));
  return {hits,coverage:{scope:selected?'selected':'all',indexedDocuments:this.docs.length,searchedDocuments:documents.length,matchedDocuments,queryCount:queries.length,strategy:'per-document-balanced'}};
 }
 page(docId,page){return this.db.prepare("SELECT payload FROM entries WHERE docId=? AND json_extract(payload,'$.page') BETWEEN ? AND ? LIMIT 150").all(docId,page-1,page+1).map(r=>{const p=JSON.parse(r.payload);return {...p,bbox:p.bbox,bboxNormalized:p.bboxNormalized};});}
 async close(){this.closed=true;const worker=this.worker;try{this.db.close();}catch{}if(worker)await worker.terminate();}
}
module.exports={SqliteRagIndex,SCHEMA,scopeToken};
