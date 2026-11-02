'use strict';
const {parentPort,workerData:a}=require('node:worker_threads');
const fs=require('node:fs'),path=require('node:path');
try{
 const {convertArtifacts}=require('./pipeline'),{safeName}=require('./utils');
 const result=convertArtifacts({...a,sourcePath:null}),doc=result.document;
 const target=path.join(a.outputDir,safeName(a.title)+'.pdf');if(path.resolve(a.inputPath)!==path.resolve(target))fs.copyFileSync(a.inputPath,target);result.files.sourceFile=target;
 parentPort.postMessage({result:{document:{document:doc.document},files:result.files,stats:{pages:doc.document.pageCount,items:doc.items.length,images:doc.items.filter(i=>i.type==='image'||i.type==='chart').length,chars:doc.items.reduce((n,i)=>n+String(i.text||i.html||'').length,0)}}});
}catch(e){parentPort.postMessage({error:e.message});}
