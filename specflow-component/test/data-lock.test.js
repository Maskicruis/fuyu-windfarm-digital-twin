'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),os=require('node:os'),path=require('node:path');
const {DataLock}=require('../desktop/data-lock.cjs');
test('only one desktop backend owns a data directory, including portable relaunches',async()=>{
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'kb-owner-')),a=new DataLock(dir),b=new DataLock(dir);
 try{assert.equal(a.acquire(),true);a.publish('http://127.0.0.1:8790/');assert.equal(b.acquire(),false);assert.equal(await b.url(),'http://127.0.0.1:8790/');b.release();assert.ok(fs.existsSync(a.file));a.release();assert.equal(b.acquire(),true);}finally{a.release();b.release();fs.rmSync(dir,{recursive:true,force:true});}
});
test('a crashed owner can be reclaimed without discarding documents',()=>{
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'kb-crash-')),lock=new DataLock(dir);
 try{fs.writeFileSync(lock.file,JSON.stringify({pid:0}));fs.writeFileSync(path.join(dir,'documents.json'),'[]');assert.equal(lock.acquire(),true);assert.equal(fs.readFileSync(path.join(dir,'documents.json'),'utf8'),'[]');}finally{lock.release();fs.rmSync(dir,{recursive:true,force:true});}
});
