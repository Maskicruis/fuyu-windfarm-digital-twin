'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),os=require('node:os'),path=require('node:path');
const {writeJson,readJson}=require('../src/utils');
test('an interrupted JSON replacement preserves the previous complete task catalogue',()=>{
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'kb-atomic-')),file=path.join(dir,'documents.json'),rename=fs.renameSync;
 try{writeJson(file,[{id:'kept'}]);fs.renameSync=()=>{throw Error('simulated interruption before commit');};assert.throws(()=>writeJson(file,[{id:'new'}]),/interruption/);assert.deepEqual(readJson(file),[{id:'kept'}]);assert.deepEqual(fs.readdirSync(dir),['documents.json']);}finally{fs.renameSync=rename;fs.rmSync(dir,{recursive:true,force:true});}
});
