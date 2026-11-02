'use strict';
const {parentPort,workerData}=require('node:worker_threads');
const fs=require('node:fs'),path=require('node:path');
const {pathToFileURL}=require('node:url');
(async()=>{
 // PDF.js 6 also runs in the bundled Node 24 test runtime.
 if(!Uint8Array.prototype.toHex)Uint8Array.prototype.toHex=function(){return Buffer.from(this).toString('hex');};
 if(!Math.sumPrecise)Math.sumPrecise=values=>{let sum=0,c=0;for(const v of values){const y=v-c,t=sum+y;c=(t-sum)-y;sum=t;}return sum;};
 const pdfjs=await import(pathToFileURL(path.join(__dirname,'../lib/pdf.min.mjs')).href);
 pdfjs.GlobalWorkerOptions.workerSrc=pathToFileURL(path.join(__dirname,'../lib/pdf.worker.min.mjs')).href;
 const task=pdfjs.getDocument({data:new Uint8Array(fs.readFileSync(workerData.inputPath)),useSystemFonts:true,isEvalSupported:false,cMapUrl:path.join(__dirname,'../lib/cmaps').replace(/\\/g,'/')+'/',cMapPacked:true,standardFontDataUrl:path.join(__dirname,'../lib/standard_fonts').replace(/\\/g,'/')+'/'});
 const pdf=await task.promise,pages=[],items=[];let empty=0,chars=0;
 for(let number=1;number<=pdf.numPages;number++){
  const page=await pdf.getPage(number),v=page.getViewport({scale:1}),content=await page.getTextContent();
  const lines=[];let count=0;
  for(const item of content.items){if(!item.str?.trim())continue;const t=pdfjs.Util.transform(v.transform,item.transform),h=Math.hypot(t[2],t[3])||item.height||10,style=content.styles[item.fontName]||{},top=t[5]-h*(style.ascent||.85),left=t[4],width=Math.max(item.width,1);let row=lines.find(r=>Math.abs(r.y-t[5])<Math.max(2,h*.22));if(!row){row={y:t[5],parts:[],x0:left,y0:top,x1:left+width,y1:top+h};lines.push(row);}row.parts.push({x:left,text:item.str});row.x0=Math.min(row.x0,left);row.y0=Math.min(row.y0,top);row.x1=Math.max(row.x1,left+width);row.y1=Math.max(row.y1,top+h);count+=item.str.trim().length;}
  if(number>3&&count<60)empty++;
  const ids=[];for(const row of lines.sort((a,b)=>a.y-b.y)){
   const text=row.parts.sort((a,b)=>a.x-b.x).map(p=>p.text).join(' ').replace(/([\u4e00-\u9fff])\s+(?=[\u4e00-\u9fff])/g,'$1');
   const id='p'+String(number).padStart(4,'0')+'-i'+String(items.length).padStart(6,'0');ids.push(id);
   const normalized=[row.x0/v.width,row.y0/v.height,row.x1/v.width,row.y1/v.height].map(n=>Math.max(0,Math.min(1,n)));
   const a=v.convertToPdfPoint(row.x0,row.y0),b=v.convertToPdfPoint(row.x1,row.y1);
   items.push({id,page:number,order:items.length,type:'text',text,bbox:{normalized,pdf:[Math.min(a[0],b[0]),Math.min(a[1],b[1]),Math.max(a[0],b[0]),Math.max(a[1],b[1])]}});chars+=text.length;
  }
  pages.push({number,width:v.width,height:v.height,items:ids});page.cleanup();parentPort.postMessage({progress:Math.round(number/pdf.numPages*100)});
 }
 const usable=chars>=Math.max(80,pdf.numPages*(pdf.numPages>3?120:40))&&empty<=Math.max(1,(pdf.numPages-3)*.08);
 await task.destroy();const document=usable?{schemaVersion:'1.0',document:{id:workerData.id,title:workerData.title,sourceName:workerData.sourceName,createdAt:new Date().toISOString(),pageCount:pages.length,parser:'pdf-text',parseNote:'文字层快速提取；复杂表格按原 PDF 核对，可用 OCR 重新解析。'},coordinateSystems:{normalized:{origin:'top-left',unit:'ratio',range:[0,1]},pdf:{origin:'bottom-left',unit:'point'}},pages,items}:null;
 if(document&&workerData.outputDir){const {writePackage}=require('./pipeline'),{safeName}=require('./utils');const files=writePackage({document,outputDir:workerData.outputDir,corrections:workerData.corrections||{}});const source=path.join(workerData.outputDir,safeName(workerData.title)+'.pdf');if(path.resolve(workerData.inputPath)!==path.resolve(source))fs.copyFileSync(workerData.inputPath,source);files.sourceFile=source;parentPort.postMessage({result:{document:{document:document.document},files,stats:{pages:pages.length,items:items.length,images:0,chars:items.reduce((n,i)=>n+i.text.length,0)}}});}else parentPort.postMessage({result:document});
})().catch(e=>parentPort.postMessage({error:e.message}));
