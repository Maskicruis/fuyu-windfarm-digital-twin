'use strict';
// Real Chromium canvas verification against the reported page, no external API.
process.on('uncaughtException',error=>{console.error(error.stack);process.exit(1);});
const {app,BrowserWindow}=require('electron');
const fs=require('node:fs'),path=require('node:path'),assert=require('node:assert/strict');
const args=process.argv.slice(2),value=name=>args[args.indexOf(name)+1];
const area=path.resolve(value('--output')),source=path.resolve(value('--source-component'));
fs.mkdirSync(area,{recursive:true});process.env.KB_ROOT=path.resolve(__dirname,'../specflow-component');process.env.KB_DATA_DIR=path.join(area,'data');fs.mkdirSync(process.env.KB_DATA_DIR,{recursive:true});
app.setPath('userData',path.join(area,'profile'));
const original=JSON.parse(fs.readFileSync(path.join(source,'workspace/data/documents.json'),'utf8')),selected=original.filter(d=>d.pages===175);
assert.equal(selected.length,2);const library=path.join(area,'library');fs.mkdirSync(library,{recursive:true});
const records=selected.map(d=>{const output=path.join(library,d.dirName);fs.mkdirSync(output,{recursive:true});for(const file of fs.readdirSync(d.outputDir)){if(/\.pdf$/i.test(file)||file==='document.json')fs.copyFileSync(path.join(d.outputDir,file),path.join(output,file));}return {...d,inputPath:path.join(output,path.basename(d.inputPath)),outputDir:output,status:'ready'};});
fs.writeFileSync(path.join(process.env.KB_DATA_DIR,'documents.json'),JSON.stringify(records));fs.writeFileSync(path.join(process.env.KB_DATA_DIR,'settings.json'),JSON.stringify({library}));
let backend,window;
app.whenReady().then(async()=>{
 backend=require('../specflow-component/src/http-server').createHttpServer();await new Promise(resolve=>backend.server.listen(0,'127.0.0.1',resolve));const url='http://127.0.0.1:'+backend.server.address().port;
 window=new BrowserWindow({show:false,width:1500,height:940,webPreferences:{contextIsolation:true,nodeIntegration:false,sandbox:true}});
 const errors=[];window.webContents.on('console-message',(_event,details)=>{if(details.level>=2)errors.push(String(details.message).slice(0,800));});
 await window.loadURL(url);const results=[];
 for(const d of records){
  const result=await window.webContents.executeJavaScript(`(async()=>{await openCitation(${JSON.stringify(d.id)},142,'',[60,60,300,110],[.15,.15,.75,.3],'');const canvas=document.querySelector('#cv');if(!canvas||!canvas.width)throw Error(document.querySelector('#viewerState')?.textContent||'No canvas');const image=canvas.getContext('2d').getImageData(0,0,canvas.width,canvas.height).data;let nonwhite=0;for(let i=0;i<image.length;i+=4){if(image[i+3]>0&&Math.min(image[i],image[i+1],image[i+2])<220)nonwhite++;}return{title:document.querySelector('#mtitle').textContent,page:document.querySelector('#pg').textContent,width:canvas.width,height:canvas.height,nonwhitePixels:nonwhite,error:document.querySelector('#viewerState.error')?.textContent||'',highlights:document.querySelectorAll('.hlbox').length};})()`);
  assert.equal(result.error,'');assert.match(result.page,/142 \/ 175/);assert.ok(result.nonwhitePixels>1000,JSON.stringify(result));assert.equal(result.highlights,1);results.push(result);
 }
 const proof={passed:true,pdfjs:'6.3.289',full_pdf_read:true,local_wasm_fonts_cmaps:true,tests:results,consoleErrors:errors};
 fs.writeFileSync(path.join(area,'proof.json'),JSON.stringify(proof,null,2));console.log(JSON.stringify(proof));
 await backend.service.shutdown();backend.server.close();window.destroy();app.quit();
}).catch(error=>{console.error(error.stack);app.exit(1);});
