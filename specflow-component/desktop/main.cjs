'use strict';
const {app,BrowserWindow,ipcMain,dialog,shell,net}=require('electron');
const fs=require('node:fs'),path=require('node:path');
const {DataLock}=require('./data-lock.cjs');
const args=process.argv.slice(1),value=name=>{const i=args.indexOf(name);return i>=0?args[i+1]:null;};
const headless=args.includes('--background')||args.includes('--headless');
// --headless is also a Chromium flag. Keep its legacy service meaning without
// disabling native windows for the lifetime of a background host.
app.commandLine.removeSwitch('headless');
const portable=process.env.PORTABLE_EXECUTABLE_DIR||(app.isPackaged?path.dirname(app.getPath('exe')):path.resolve(__dirname,'..'));
const data=path.resolve(value('--data-dir')||path.join(portable,'workspace','data'));
fs.mkdirSync(data,{recursive:true});
process.env.KB_ROOT=path.resolve(__dirname,'..');process.env.KB_DATA_DIR=data;
process.env.KB_BUNDLE_ROOT=portable;
app.setPath('userData',path.join(path.dirname(data),headless?'desktop-profile-service':'desktop-profile-ui'));
let window=null,backend=null,serviceUrl='',opening=null,shuttingDown=false,updater=null;
const ownerLock=new DataLock(data);process.on('exit',()=>ownerLock.release());
async function openWindow(){
 if(opening)return opening;
 if(window){if(window.isMinimized())window.restore();window.show();window.focus();return window;}
 if(!serviceUrl)return null;
 opening=(async()=>{
  window=new BrowserWindow({title:'SpecFlow 知识组件 · 独立版',width:1500,height:940,minWidth:1000,minHeight:680,frame:false,backgroundColor:'#101317',icon:path.join(__dirname,'../build/app.ico'),webPreferences:{preload:path.join(__dirname,'preload.cjs'),nodeIntegration:false,contextIsolation:true,sandbox:true}});
  window.webContents.setWindowOpenHandler(({url:target})=>{if(/^https?:\/\//i.test(target))shell.openExternal(target);return{action:'deny'};});
  window.webContents.on('will-navigate',(event,target)=>{if(!target.startsWith(serviceUrl)){event.preventDefault();if(/^https?:\/\//i.test(target))shell.openExternal(target);}});
  for(const event of ['maximize','unmaximize'])window.on(event,()=>window?.webContents.send('window:maximized',window.isMaximized()));
  window.on('closed',()=>{window=null;});
  await window.loadURL(serviceUrl);window.show();window.focus();return window;
 })();
 try{return await opening;}finally{opening=null;}
}
// A headless host and a visible window must share one backend and one data writer.
if(!app.requestSingleInstanceLock())app.quit();
else{
 let showWhenReady=!headless;
 app.on('second-instance',(_event,argv)=>{if(!argv.includes('--headless')&&!argv.includes('--background')){showWhenReady=true;openWindow().catch(()=>{});}});
 app.whenReady().then(async()=>{
  const ownsData=ownerLock.acquire();
  let requested=0,port=0,url='';
  if(ownsData){
  let loading=null;
  if(!args.includes('--no-bundle')){
  if(!headless&&!require('./install-bundle.cjs').isBundleReady(portable)){loading=new BrowserWindow({width:580,height:210,resizable:false,backgroundColor:'#101d2e',autoHideMenuBar:true});await loading.loadURL('data:text/html;charset=utf-8,'+encodeURIComponent('<body style="background:#101d2e;color:#f4f7fb;font:16px Microsoft YaHei;padding:30px"><h3>SpecFlow 知识组件 · 首次准备</h3><p id="s">正在准备离线引擎和预置规范…</p></body>'));}
  await require('./install-bundle.cjs').installBundle(portable,message=>{if(loading&&!loading.isDestroyed())loading.webContents.executeJavaScript('document.getElementById("s").textContent='+JSON.stringify(message)).catch(()=>{});},url=>{if(args.includes('--offline-resources'))throw Error('离线模式缺少资源包，请将同一发布页的引擎包和数据库包放在 EXE 旁。');return net.fetch(url);});
  }
  await require('./prepare-engine.cjs').prepareEngine(portable);
  require('./bundle.cjs').initializeBundle(portable,data);
  const {createHttpServer}=require('../src/http-server');
  backend=createHttpServer();
  if(!fs.existsSync(path.join(data,'settings.json')))backend.service.updateSettings({library:path.join(path.dirname(data),'资料库')});
  requested=Number(value('--port')||backend.service.settings.port||8790);
  if(!Number.isInteger(requested)||requested<0||requested>65535)throw Error('端口无效');
  await new Promise((resolve,reject)=>{const listen=port=>{backend.server.once('error',error=>{if(error.code==='EADDRINUSE'&&port!==0)listen(0);else reject(error);});backend.server.listen(port,'127.0.0.1',resolve);};listen(requested);});
  port=backend.server.address().port;url=serviceUrl='http://127.0.0.1:'+port+'/';ownerLock.publish(url);
  fs.writeFileSync(path.join(data,'component-service.json'),JSON.stringify({pid:process.pid,port,version:app.getVersion(),upstream:'SpecFlow 0.11.1',data,runtimeRoot:process.env.KB_RUNTIME_ROOT||process.env.KB_ROOT},null,2));
  if(loading){if(showWhenReady)await openWindow();loading.close();}
  }else{if(headless){app.quit();return;}url=serviceUrl=await ownerLock.url();port=Number(new URL(url).port);requested=port;}
  ipcMain.handle('desktop:info',()=>({name:'SpecFlow 知识组件',version:app.getVersion(),platform:process.platform,dataDir:data,url,port,configuredPort:requested,fallback:requested>0&&requested!==port}));
  const {ComponentUpdater}=require('./component-updater.cjs');
  updater=new ComponentUpdater({current:app.getVersion(),root:portable,fetch:(url,options)=>net.fetch(url,options),apply:ownsData&&app.isPackaged?async({file,item})=>{
   await require('./update-handoff.cjs').startUpdateHelper({root:portable,dataDir:data,file,item,pid:process.pid,launcherPid:process.env.PORTABLE_EXECUTABLE_FILE?process.ppid:null,previous:process.env.PORTABLE_EXECUTABLE_FILE||'',launchArgs:args.filter(x=>['--no-bundle','--offline-resources'].includes(x))});
   // Do not close until the independent helper has validated the plan and is waiting.
   setTimeout(()=>app.quit(),250);
  }:null});
  for(const [name,action] of [['status',()=>updater.status()],['check',()=>updater.check()],['download',()=>updater.download()],['install',()=>updater.install()]])ipcMain.handle('component-update:'+name,(event)=>{if(window&&event.sender.id!==window.webContents.id)throw Error('更新请求来源无效');return action();});
  ipcMain.handle('desktop:open-data',()=>shell.openPath(data));
  ipcMain.handle('dialog:choose-directory',async()=>{const result=await dialog.showOpenDialog(window,{properties:['openDirectory','createDirectory']});return result.canceled?'':result.filePaths[0];});
  ipcMain.handle('dialog:choose-mineru',async()=>{const result=await dialog.showOpenDialog(window,{title:'选择 MinerU 可执行文件',properties:['openFile'],filters:[{name:'可执行文件',extensions:['exe','cmd','bat']}]});return result.canceled?'':result.filePaths[0];});
  ipcMain.handle('window:is-maximized',()=>!!window?.isMaximized());
  ipcMain.on('window:minimize',()=>window?.minimize());ipcMain.on('window:toggle-maximize',()=>{if(window?.isMaximized())window.unmaximize();else window?.maximize();});ipcMain.on('window:close',()=>window?.close());
  backend?.server.on('specflow:open-citation',async payload=>{if(!payload.docId)return;try{const target=await openWindow();if(!target)return;const script='openCitation('+[String(payload.docId),Math.max(1,Number(payload.page)||1),String(payload.ref||''),payload.bbox||'',payload.bboxNormalized||'',String(payload.itemId||'')].map(x=>JSON.stringify(x)).join(',')+')';await target.webContents.executeJavaScript(script);}catch{}});
  if(showWhenReady){await openWindow();if(ownsData&&require('./update-handoff.cjs').acknowledgeStartup({root:portable,requestId:value('--update-token'),version:app.getVersion(),pid:process.pid,visible:window?.isVisible()}))updater.state={phase:'current',message:'已更新至 V'+app.getVersion()+'，新版服务与窗口已启动。',progress:100};}
 }).catch(error=>{fs.appendFileSync(path.join(data,'desktop-error.log'),String(error.stack||error)+'\n');if(!headless)dialog.showErrorBox('SpecFlow 知识组件启动失败',error.message);app.quit();});
 app.on('window-all-closed',()=>{if(!headless)app.quit();});
 app.on('before-quit',event=>{if(!backend||shuttingDown)return;event.preventDefault();shuttingDown=true;backend.server.close();Promise.resolve(backend.service.shutdown()).catch(()=>{}).finally(()=>{ownerLock.release();app.quit();});});
}
