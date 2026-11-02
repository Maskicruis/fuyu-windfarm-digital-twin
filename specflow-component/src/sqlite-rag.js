'use strict';
// Persisted inverted index. Parsing and index writes run outside the HTTP thread.
const fs=require('node:fs'),path=require('node:path');
const {Worker}=require('node:worker_threads');
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
  this.refreshing=new Promise((resolve,reject)=>{
   const worker=this.worker=new Worker(path.join(__dirname,'sqlite-rag-worker.js'),{workerData:{library:this.settings.library,filename:this.filename}});
   worker.once('message',m=>m.error?reject(Error(m.error)):resolve(m));worker.once('error',reject);
   worker.once('exit',code=>{if(code)reject(Error('索引任务中断 '+code));});
  });
  try{await this.refreshing;if(!this.closed){this.syncStats();this.isReady=true;this.error='';}}
  finally{this.refreshing=null;this.worker=null;}
 }
 search(query,options={}){
  if(!this.isReady){const e=Error('资料索引正在后台建立，请稍后重试；通用模型可正常使用。');e.code='INDEX_BUILDING';throw e;}
  const tokens=[...new Set(tokenize(query))].filter(t=>t.length>1).slice(0,80);if(!tokens.length)return [];
  const ids=Array.isArray(options.docIds)?options.docIds:null;if(ids&&!ids.length)return [];
  const limit=Math.max(1,Math.min(50,Number(options.topK)||8));
  let match='('+tokens.map(t=>'"'+t.replace(/"/g,'""')+'"').join(' OR ')+')';
  if(ids)match+=' AND ('+ids.map(id=>'"'+scopeToken(id)+'"').join(' OR ')+')';
  const start=performance.now();
  const rows=this.db.prepare('SELECT e.payload, candidates.rank FROM (SELECT rowid,bm25(terms) rank FROM terms WHERE terms MATCH ? ORDER BY rank LIMIT ?) candidates JOIN entries e ON e.id=candidates.rowid ORDER BY candidates.rank').all(match,limit);
  this.lastSearchMs=performance.now()-start;
  this.entries=rows.map(r=>JSON.parse(r.payload)); // Only bounded candidates, never all documents.
  return rows.map((r,i)=>{const p=JSON.parse(r.payload);return {...p,n:i+1,score:-r.rank,snippet:p.text.slice(0,1200),matched:['fts5']};});
 }
 page(docId,page){return this.db.prepare("SELECT payload FROM entries WHERE docId=? AND json_extract(payload,'$.page') BETWEEN ? AND ? LIMIT 150").all(docId,page-1,page+1).map(r=>{const p=JSON.parse(r.payload);return {...p,bbox:p.bbox,bboxNormalized:p.bboxNormalized};});}
 async close(){this.closed=true;const worker=this.worker;try{this.db.close();}catch{}if(worker)await worker.terminate();}
}
module.exports={SqliteRagIndex,SCHEMA,scopeToken};
