'use strict';
const {parentPort,workerData}=require('node:worker_threads');
const fs=require('node:fs'),path=require('node:path');
const {DatabaseSync}=require('node:sqlite');
const {assembleFlowEntries,tokenize}=require('./rag');
const db=new DatabaseSync(workerData.filename);
try{
 db.exec('PRAGMA busy_timeout=5000;');
 const seen=new Set();
 const clear=id=>{db.prepare('DELETE FROM terms WHERE rowid IN (SELECT id FROM entries WHERE docId=?)').run(id);db.prepare('DELETE FROM entries WHERE docId=?').run(id);db.prepare('DELETE FROM docs WHERE id=?').run(id);};
 const insert=db.prepare('INSERT INTO entries(docId,payload) VALUES(?,?)'),fts=db.prepare('INSERT INTO terms(rowid,tokens,docId,itemId) VALUES(?,?,?,?)');
 for(const entry of fs.readdirSync(workerData.library,{withFileTypes:true})){
  if(!entry.isDirectory())continue;const file=path.join(workerData.library,entry.name,'document.json');if(!fs.existsSync(file))continue;
  const stat=fs.statSync(file),signature=file+'|'+stat.size+'|'+stat.mtimeMs;
  const old=db.prepare('SELECT id FROM docs WHERE signature=?').get(signature);if(old){seen.add(old.id);continue;}
  const doc=JSON.parse(fs.readFileSync(file,'utf8')),meta=doc.document||{},id=meta.id||entry.name;seen.add(id);
  const rows=(doc.items||[]).filter(i=>!['header','footer','page_number'].includes(i.type)).map(i=>({docId:id,title:meta.title||entry.name,page:i.page,itemId:i.id,type:i.type,order:i.order,ref:(String(i.text||'').match(/^\s*(\d+(?:\.\d+){1,5})/)||[])[1]||'',text:i.text||String(i.html||'').replace(/<[^>]+>/g,' ')||i.caption||'',bbox:i.bbox?.pdf||null,bboxNormalized:i.bbox?.normalized||null})).filter(i=>i.text.trim()).sort((a,b)=>a.page-b.page||a.order-b.order);
  db.exec('BEGIN IMMEDIATE');
  try{clear(id);for(const row of assembleFlowEntries(rows)){const result=insert.run(id,JSON.stringify(row));fts.run(result.lastInsertRowid,tokenize(row.title+' '+row.text).filter(t=>t.length>1).join(' '),id,row.itemId);}db.prepare('INSERT INTO docs VALUES(?,?,?)').run(id,signature,JSON.stringify({id,title:meta.title,dir:path.dirname(file),pageCount:doc.pages?.length||0}));db.exec('COMMIT');}
  catch(e){db.exec('ROLLBACK');throw e;}
 }
 for(const row of db.prepare('SELECT id FROM docs').all())if(!seen.has(row.id)){db.exec('BEGIN IMMEDIATE');try{clear(row.id);db.exec('COMMIT');}catch(e){db.exec('ROLLBACK');throw e;}}
 parentPort.postMessage({ok:true});
}catch(e){parentPort.postMessage({error:e.message});}finally{db.close();}
