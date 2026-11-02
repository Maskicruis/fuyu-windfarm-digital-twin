'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),vm=require('node:vm');
test('shipped UI classic scripts parse including upload and settings handlers',()=>{
 const html=fs.readFileSync(path.join(__dirname,'../ui.html'),'utf8');let count=0;
 for(const m of html.matchAll(/<script([^>]*)>([\s\S]*?)<\/script>/g)){if(m[1].includes('type="module"')||!m[2].trim())continue;new vm.Script(m[2],{filename:'ui-inline-'+(++count)});}
 assert.ok(count>=2);
});
