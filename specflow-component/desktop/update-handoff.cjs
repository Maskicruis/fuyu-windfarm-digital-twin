'use strict';
const fs=require('node:fs'),path=require('node:path'),crypto=require('node:crypto'),{spawn}=require('node:child_process');
const read=file=>{try{return JSON.parse(fs.readFileSync(file,'utf8').replace(/^\uFEFF/,''));}catch{return null;}};
async function startUpdateHelper({root,dataDir,file,item,previous,pid,launcherPid,launchArgs=[],spawnProcess=spawn,readyTimeoutMs=20000}){
 const folder=path.join(root,'workspace/data/updates');fs.mkdirSync(folder,{recursive:true});
 const requestId=crypto.randomBytes(16).toString('hex'),worker=path.join(folder,'apply-component-update.ps1'),planFile=path.join(folder,'install-plan.json');
 const plan={schema:2,requestId,root,dataDir,file,name:item.name,version:item.version,sha256:item.sha256,pid,launcherPid,previous,launchArgs,shortcuts:[path.join(root,'打开知识组件.lnk'),path.join(path.dirname(root),'打开独立知识组件.lnk')]};
 fs.copyFileSync(path.join(__dirname,'apply-component-update.ps1'),worker);fs.writeFileSync(planFile,JSON.stringify(plan));
 const relay=path.join(folder,'update-relay.py');fs.copyFileSync(path.join(__dirname,'update-relay.py'),relay);
 const python=['pythonw.exe','python.exe'].map(name=>path.join(root,'engines/python',name)).find(file=>fs.existsSync(file));
 if(!python)throw Error('未找到随包提供的 Python 更新中继，请保留完整解析引擎资源后重试。');
 // DETACHED_PROCESS is safe for pythonw, but Windows PowerShell can exit 0
 // without executing its script in that mode. The relay uses CREATE_NO_WINDOW.
 const child=spawnProcess(python,[relay,planFile],{detached:true,windowsHide:true,stdio:'ignore'});
 let failure;child.once('error',error=>{failure=error;});
 const until=Date.now()+readyTimeoutMs;
 while(Date.now()<until){
  if(failure)throw failure;
  const result=read(path.join(folder,'last-result.json'));
  if(result?.requestId===requestId){
   if(result.phase==='waiting_exit'){child.unref();return plan;}
   if(result.success===false)throw Error('安装助手未能准备：'+result.message);
  }
  if(child.exitCode!=null)throw Error('安装助手提前退出（'+child.exitCode+'），请查看 updates/install.log');
  await new Promise(r=>setTimeout(r,100));
 }
 child.kill();throw Error('安装助手未响应，程序保持运行。请检查安全软件拦截及 updates/install.log。');
}
function acknowledgeStartup({root,requestId,version,pid,visible}){
 if(!/^[a-f0-9]{32}$/.test(requestId||'')||!visible)return false;
 const file=path.join(root,'workspace/data/updates','startup-'+requestId+'.json');fs.mkdirSync(path.dirname(file),{recursive:true});
 fs.writeFileSync(file,JSON.stringify({requestId,version,pid,visible:true,time:new Date().toISOString()}));return true;
}
module.exports={startUpdateHelper,acknowledgeStartup};
