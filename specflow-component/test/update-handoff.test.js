'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),os=require('node:os'),{EventEmitter}=require('node:events');
const {startUpdateHelper,acknowledgeStartup}=require('../desktop/update-handoff.cjs');
test('desktop waits for a matching helper-ready receipt and reports a blocked helper without quitting',async()=>{
 const root=fs.mkdtempSync(path.join(os.tmpdir(),'sf-handoff-'));let detached=false;
 fs.mkdirSync(path.join(root,'engines/python'),{recursive:true});fs.writeFileSync(path.join(root,'engines/python/pythonw.exe'),'fixture');
 const item={name:'SpecFlow-Knowledge-Component-1.3.7-x64.exe',version:'1.3.7',sha256:'a'.repeat(64)};
 try{
  const launch=success=>(exe,args,options)=>{assert.equal(path.basename(exe),'pythonw.exe');assert.equal(path.basename(args[0]),'update-relay.py');assert.equal(options.windowsHide,true);const plan=JSON.parse(fs.readFileSync(args.at(-1),'utf8'));const child=new EventEmitter();child.unref=()=>{detached=true;};child.kill=()=>{};setTimeout(()=>fs.writeFileSync(path.join(root,'workspace/data/updates/last-result.json'),JSON.stringify({requestId:plan.requestId,phase:success?'waiting_exit':'failed',success:success?null:false,message:'blocked fixture'})),20);return child;};
  await startUpdateHelper({root,dataDir:path.join(root,'custom data'),file:'fixture',item,pid:process.pid,spawnProcess:launch(true),readyTimeoutMs:1000});assert.equal(detached,true);
  await assert.rejects(startUpdateHelper({root,dataDir:root,file:'fixture',item,pid:process.pid,spawnProcess:launch(false),readyTimeoutMs:1000}),/blocked fixture/);
 }finally{fs.rmSync(root,{recursive:true,force:true});}
});
test('startup acknowledgement requires a visible window and a valid request token',()=>{
 const root=fs.mkdtempSync(path.join(os.tmpdir(),'sf-startup-')),requestId='a'.repeat(32);try{
  assert.equal(acknowledgeStartup({root,requestId,version:'1.3.7',pid:process.pid,visible:false}),false);
  assert.equal(acknowledgeStartup({root,requestId:'bad',version:'1.3.7',pid:process.pid,visible:true}),false);
  assert.equal(acknowledgeStartup({root,requestId,version:'1.3.7',pid:process.pid,visible:true}),true);
  assert.equal(JSON.parse(fs.readFileSync(path.join(root,'workspace/data/updates','startup-'+requestId+'.json'))).visible,true);
 }finally{fs.rmSync(root,{recursive:true,force:true});}
});
