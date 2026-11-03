'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),os=require('node:os'),path=require('node:path'),crypto=require('node:crypto');
const {ComponentUpdater,selectRelease,trustedUrl}=require('../desktop/component-updater.cjs');
const bytes=Buffer.from('controlled executable fixture'),sha=crypto.createHash('sha256').update(bytes).digest('hex');
function release(v='1.3.4'){return {tag_name:'component-v'+v,body:'fixture notes',assets:[{name:`SpecFlow-Knowledge-Component-${v}-x64.exe`,state:'uploaded',size:bytes.length,digest:'sha256:'+sha,browser_download_url:`https://github.com/Maskicruis/fuyu-windfarm-digital-twin/releases/download/component-v${v}/SpecFlow-Knowledge-Component-${v}-x64.exe`}]};}
test('public component channel works without GitHub API quota or credentials',async()=>{
 const root=fs.mkdtempSync(path.join(os.tmpdir(),'specflow-feed-'));let apiCalls=0;
 try{const update=new ComponentUpdater({current:'1.3.3',root,fetch:async url=>{if(!url.includes('component-update.json')){apiCalls++;return new Response('',{status:403});}return new Response(JSON.stringify({schema:1,version:'1.3.4',bytes:bytes.length,sha256:sha,url:release().assets[0].browser_download_url}));}});assert.equal((await update.check()).availableVersion,'1.3.4');assert.equal(apiCalls,0);}finally{fs.rmSync(root,{recursive:true,force:true});}
});
test('independent feed excludes digital twin releases, drafts, missing digests and foreign binaries',()=>{
 const bad=release('9.0.0');bad.assets[0].digest=null;
 assert.equal(selectRelease([{...release('9.0.1'),draft:true},bad,{...release('9.0.2'),tag_name:'v9.0.2'},release()], '1.3.3').version,'1.3.4');
 const foreign=release();foreign.assets[0].browser_download_url='https://github.com/other/repo/releases/file.exe';assert.equal(selectRelease([foreign],'1.3.3'),null);
 assert.throws(()=>trustedUrl('https://github.com.evil.example/file'),/不受信任/);
});
test('verified update downloads, checks integrity again before install, and preserves data',async()=>{
 const root=fs.mkdtempSync(path.join(os.tmpdir(),'specflow-update-'));let applied=null;
 try{
  const update=new ComponentUpdater({current:'1.3.3',root,fetch:async url=>url.includes('/releases?')?new Response(JSON.stringify([release()])):new Response(bytes),apply:async value=>{applied=value;}});
  fs.mkdirSync(path.join(root,'workspace/data'),{recursive:true});fs.writeFileSync(path.join(root,'workspace/data/settings.json'),'private fixture');
  assert.equal((await update.check()).phase,'available');assert.equal((await update.download()).phase,'ready');assert.equal(update.status().progress,100);
  fs.writeFileSync(update.package,'tampered');await assert.rejects(()=>update.install(),/文件已变化/);assert.equal(applied,null);
  await update.download();await update.install();assert.equal(applied.item.version,'1.3.4');assert.equal(fs.readFileSync(path.join(root,'workspace/data/settings.json'),'utf8'),'private fixture');
 }finally{fs.rmSync(root,{recursive:true,force:true});}
});
test('truncated or corrupted update never becomes installable; retry succeeds',async()=>{
 const root=fs.mkdtempSync(path.join(os.tmpdir(),'specflow-update-'));let corrupt=true;
 try{const update=new ComponentUpdater({current:'1.3.3',root,fetch:async url=>url.includes('/releases?')?new Response(JSON.stringify([release()])):new Response(corrupt?bytes.subarray(2):bytes),apply:async()=>{}});await update.check();await assert.rejects(()=>update.download(),/校验失败/);assert.equal(update.package,null);assert.equal(update.status().phase,'error');corrupt=false;assert.equal((await update.download()).phase,'ready');}finally{fs.rmSync(root,{recursive:true,force:true});}
});
