'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),os=require('node:os'),path=require('node:path'),crypto=require('node:crypto');
const {ensureRuntime}=require('../desktop/runtime-cache.cjs');
test('PDF and background workers survive removal of disposable source and repair corruption on restart',()=>{
 const root=fs.mkdtempSync(path.join(os.tmpdir(),'specflow-runtime-')),source=path.join(root,'disposable'),cache=path.join(root,'persistent');
 try{
  const files={'lib/pdf.worker.min.mjs':'export const WorkerMessageHandler={};','src/package-worker.js':'worker fixture','desktop/main.cjs':'main fixture'};
  for(const [name,data] of Object.entries(files)){const file=path.join(source,name);fs.mkdirSync(path.dirname(file),{recursive:true});fs.writeFileSync(file,data);}
  fs.writeFileSync(path.join(source,'runtime-integrity.json'),JSON.stringify({schema:1,version:'1.3.3',files:Object.entries(files).map(([name,data])=>({path:name,bytes:Buffer.byteLength(data),sha256:crypto.createHash('sha256').update(data).digest('hex')}))}));
  const runtime=ensureRuntime(source,cache);assert.equal(runtime.repaired,3);assert.equal(ensureRuntime(source,cache).repaired,0);
  fs.writeFileSync(path.join(runtime.folder,'lib/pdf.worker.min.mjs'),'corrupt');assert.equal(ensureRuntime(source,cache).repaired,1);
  fs.rmSync(source,{recursive:true});assert.equal(fs.readFileSync(path.join(runtime.folder,'src/package-worker.js'),'utf8'),files['src/package-worker.js']);assert.equal(fs.readFileSync(path.join(runtime.folder,'lib/pdf.worker.min.mjs'),'utf8'),files['lib/pdf.worker.min.mjs']);
 }finally{fs.rmSync(root,{recursive:true,force:true});}
});
test('runtime manifest refuses traversal outside the persistent cache',()=>{
 const root=fs.mkdtempSync(path.join(os.tmpdir(),'specflow-runtime-'));
 try{fs.writeFileSync(path.join(root,'runtime-integrity.json'),JSON.stringify({schema:1,version:'1.3.3',files:[{path:'../escape',bytes:0,sha256:'0'.repeat(64)}]}));assert.throws(()=>ensureRuntime(root,path.join(root,'cache')),/路径|越界/);}finally{fs.rmSync(root,{recursive:true,force:true});}
});
