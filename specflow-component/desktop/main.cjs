'use strict';
const {app,BrowserWindow,ipcMain,dialog,shell}=require('electron');
const fs=require('node:fs'),path=require('node:path');
const args=process.argv.slice(1),value=name=>{const i=args.indexOf(name);return i>=0?args[i+1]:null;};
const portable=process.env.PORTABLE_EXECUTABLE_DIR||(app.isPackaged?path.dirname(app.getPath('exe')):path.resolve(__dirname,'..'));
const data=path.resolve(value('--data-dir')||path.join(portable,'workspace','data'));
fs.mkdirSync(data,{recursive:true});
process.env.KB_ROOT=path.resolve(__dirname,'..');process.env.KB_DATA_DIR=data;
app.setPath('userData',path.join(path.dirname(data),'desktop-profile'));
const headless=args.includes('--headless');let window=null,backend=null;
if(!headless&&!app.requestSingleInstanceLock())app.quit();
else{
 app.on('second-instance',()=>{if(window){if(window.isMinimized())window.restore();window.show();window.focus();}});
 app.whenReady().then(async()=>{
  const {createHttpServer}=require('../src/http-server');
  backend=createHttpServer();
  if(!fs.existsSync(path.join(data,'settings.json')))backend.service.updateSettings({library:path.join(path.dirname(data),'资料库')});
  const requested=Number(value('--port')||backend.service.settings.port||8790);
  if(!Number.isInteger(requested)||requested<0||requested>65535)throw Error('端口无效');
  await new Promise((resolve,reject)=>{const listen=port=>{backend.server.once('error',error=>{if(error.code==='EADDRINUSE'&&port!==0)listen(0);else reject(error);});backend.server.listen(port,'127.0.0.1',resolve);};listen(requested);});
  const port=backend.server.address().port,url='http://127.0.0.1:'+port+'/';
  fs.writeFileSync(path.join(data,'component-service.json'),JSON.stringify({pid:process.pid,port,version:app.getVersion(),upstream:'SpecFlow 0.11.1',data},null,2));
  ipcMain.handle('desktop:info',()=>({name:'SpecFlow 知识组件',version:app.getVersion(),platform:process.platform,dataDir:data,url,port,configuredPort:requested,fallback:requested>0&&requested!==port}));
  ipcMain.handle('desktop:open-data',()=>shell.openPath(data));
  ipcMain.handle('dialog:choose-directory',async()=>{const result=await dialog.showOpenDialog(window,{properties:['openDirectory','createDirectory']});return result.canceled?'':result.filePaths[0];});
  ipcMain.handle('dialog:choose-mineru',async()=>{const result=await dialog.showOpenDialog(window,{title:'选择 MinerU 可执行文件',properties:['openFile'],filters:[{name:'可执行文件',extensions:['exe','cmd','bat']}]});return result.canceled?'':result.filePaths[0];});
  ipcMain.handle('window:is-maximized',()=>!!window?.isMaximized());
  ipcMain.on('window:minimize',()=>window?.minimize());ipcMain.on('window:toggle-maximize',()=>{if(window?.isMaximized())window.unmaximize();else window?.maximize();});ipcMain.on('window:close',()=>window?.close());
  backend.server.on('specflow:open-citation',payload=>{if(!window||!payload.docId)return;if(window.isMinimized())window.restore();window.show();window.focus();const script='openCitation('+[String(payload.docId),Math.max(1,Number(payload.page)||1),String(payload.ref||''),payload.bbox||'',payload.bboxNormalized||'',String(payload.itemId||'')].map(x=>JSON.stringify(x)).join(',')+')';window.webContents.executeJavaScript(script).catch(()=>{});});
  if(headless)return;
  window=new BrowserWindow({title:'SpecFlow 知识组件',width:1500,height:940,minWidth:1000,minHeight:680,frame:false,backgroundColor:'#101317',icon:path.join(__dirname,'../build/app.ico'),webPreferences:{preload:path.join(__dirname,'preload.cjs'),nodeIntegration:false,contextIsolation:true,sandbox:true}});
  window.webContents.setWindowOpenHandler(({url:target})=>{if(/^https?:\/\//i.test(target))shell.openExternal(target);return{action:'deny'};});
  window.webContents.on('will-navigate',(event,target)=>{if(!target.startsWith(url)){event.preventDefault();if(/^https?:\/\//i.test(target))shell.openExternal(target);}});
  for(const event of ['maximize','unmaximize'])window.on(event,()=>window.webContents.send('window:maximized',window.isMaximized()));
  await window.loadURL(url);window.on('closed',()=>{window=null;});
 }).catch(error=>{fs.appendFileSync(path.join(data,'desktop-error.log'),String(error.stack||error)+'\n');if(!headless)dialog.showErrorBox('SpecFlow 知识组件启动失败',error.message);app.quit();});
 app.on('window-all-closed',()=>{if(!headless)app.quit();});
 app.on('before-quit',()=>backend?.server?.close());
}
