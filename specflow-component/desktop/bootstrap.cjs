'use strict';
// Keep code, PDF.js workers/fonts and background workers outside disposable TEMP.
const path=require('node:path');
const {app,dialog}=require('electron');
try{
 const source=path.resolve(__dirname,'..');
 if(app.isPackaged){
  const base=path.join(process.env.LOCALAPPDATA||app.getPath('appData'),'SpecFlowKnowledgeComponent','runtime');
  const runtime=require('./runtime-cache.cjs').ensureRuntime(source,base);
  process.env.KB_RUNTIME_ROOT=runtime.folder;
  require(path.join(runtime.folder,'desktop/main.cjs'));
 }else require('./main.cjs');
}catch(error){app.whenReady().then(()=>{dialog.showErrorBox('SpecFlow 运行文件准备失败',error.message);app.quit();});}
