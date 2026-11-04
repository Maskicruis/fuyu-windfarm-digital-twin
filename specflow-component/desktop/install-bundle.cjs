'use strict';
const fs=require('node:fs'),path=require('node:path'),crypto=require('node:crypto'),{spawn}=require('node:child_process');
const {readJson,writeJson}=require('../src/utils');
function digest(file){return new Promise((resolve,reject)=>{const hash=crypto.createHash('sha256'),stream=fs.createReadStream(file);stream.on('data',c=>hash.update(c));stream.on('error',reject);stream.on('end',()=>resolve(hash.digest('hex')));});}
function bundleManifest(root){
 const local=readJson(path.join(root,'resources-manifest.json')),embedded=readJson(path.join(__dirname,'../resources-manifest.json'));
 if(!local)return embedded;if(!embedded)return local;
 const version=s=>String(s).split('.').reduce((v,n)=>v*1000+Number(n||0),0);
 return version(embedded.version)>version(local.version)||(embedded.version===local.version&&(embedded.revision||0)>(local.revision||0))?embedded:local;
}
function isBundleReady(root){const manifest=bundleManifest(root),marker=readJson(path.join(root,'resources-installed.json'));return !manifest||marker?.version===manifest.version&&(marker.revision||0)===(manifest.revision||0)&&manifest.required.every(p=>fs.existsSync(path.join(root,p)));}
function adoptExistingBundle(root,manifest){
 if(!readJson(path.join(root,'resources-installed.json'))||fs.existsSync(path.join(root,'resources-installing.json')))return false;
 const metadata=new Set(['database/manifest.json','database/施工验收规范目录.csv']);
 if(!manifest.required.filter(p=>!metadata.has(p)).every(p=>fs.existsSync(path.join(root,p))))return false;
 for(const [target,source] of [['database/manifest.json','database-manifest.json'],['database/施工验收规范目录.csv','施工验收规范目录.csv']]){
  const file=path.resolve(__dirname,'../presets',source);if(!fs.existsSync(file))return false;
  fs.mkdirSync(path.dirname(path.join(root,target)),{recursive:true});fs.copyFileSync(file,path.join(root,target));
 }
 writeJson(path.join(root,'resources-installed.json'),{version:manifest.version,revision:manifest.revision||0,reusedExisting:true});return true;
}
async function installBundle(root,onProgress=()=>{},fetcher=globalThis.fetch){
 const manifest=bundleManifest(root);if(!manifest||isBundleReady(root))return;
 if(adoptExistingBundle(root,manifest)){onProgress('沿用本机完整资料库与解析引擎');return;}
 const baseReady=!!readJson(path.join(root,'resources-installed.json'))&&Array.isArray(manifest.baseRequired)&&manifest.baseRequired.length>0&&manifest.baseRequired.every(p=>fs.existsSync(path.join(root,p)));
 const parts=baseReady?manifest.parts.filter(part=>!part.base):manifest.parts;
 for(const part of parts){
  if(path.basename(part.name)!==part.name)throw Error('资源包名称无效');
  const archive=path.join(root,part.name);
  if(!fs.existsSync(archive)){
   if(!part.url)throw Error('缺少完整套件资源包：'+part.name+'。请从同一 Release 下载全部资源包，放在 EXE 同目录。');
   const expected='https://github.com/Maskicruis/fuyu-windfarm-digital-twin/releases/download/component-v'+manifest.version+'/'+encodeURIComponent(part.name);
   if(part.url!==expected)throw Error('资源下载地址无效');
   onProgress('首次下载离线资源：'+part.name+'（'+Math.ceil(part.bytes/1024/1024)+' MB）');
   const response=await fetcher(expected);if(!response.ok)throw Error('资源下载失败 HTTP '+response.status+'，可从 Release 手动下载同名资源包后重试。');
   const temporary=archive+'.download',fd=fs.openSync(temporary,'w');let received=0,last=0;
   try{for await(const chunk of response.body){fs.writeSync(fd,chunk);received+=chunk.length;if(Date.now()-last>600){last=Date.now();onProgress('正在下载 '+part.name+' · '+Math.floor(received/Math.max(part.bytes,1)*100)+'%');}}}finally{fs.closeSync(fd);}
   if(received!==part.bytes||await digest(temporary)!==part.sha256)throw Error('下载校验失败，请重新启动重试：'+part.name);
   fs.renameSync(temporary,archive);
  }
  onProgress('正在校验 '+part.name);if(await digest(archive)!==part.sha256)throw Error('资源包校验失败：'+part.name);
 }
 writeJson(path.join(root,'resources-installing.json'),{version:manifest.version,startedAt:new Date().toISOString()});
 for(const [i,part] of parts.entries()){
  onProgress('正在安装 '+(part.title||part.name)+' · '+(i+1)+' / '+parts.length);
  await new Promise((resolve,reject)=>{
   // Paths are passed through environment variables, never interpolated as code.
   const child=spawn('powershell.exe',['-NoProfile','-NonInteractive','-File',path.join(__dirname,'extract-resources.ps1')],{windowsHide:true,env:{...process.env,SF_ARCHIVE:path.join(root,part.name),SF_DEST:root,SF_PRESERVE:part.role==='database'?'1':'0'}});
   child.stdout.setEncoding('utf8');child.stderr.setEncoding('utf8');
   child.stdout.on('data',chunk=>{const matches=chunk.match(/SF_EXTRACT (\d+)\/(\d+)/g);if(matches?.length)onProgress('正在安装 '+(part.title||part.name)+' · 已处理 '+matches.at(-1).slice(11)+' 个文件');});
   let error='';child.stderr.on('data',c=>{error=(error+c).slice(-12000);});child.on('error',reject);child.on('close',code=>{
    if(code===0)return resolve();
    const structured=error.split(/\r?\n/).findLast(line=>line.startsWith('SF_EXTRACT_ERROR '));
    let message=error.trim();try{if(structured)message=JSON.parse(structured.slice(17)).message;}catch{}
    reject(Error('资源解压失败（'+part.name+'）：'+(message||'解压进程退出，代码 '+code)));
   });
  });
 }
 for(const required of manifest.required)if(!fs.existsSync(path.join(root,required)))throw Error('资源文件不完整：'+required);
 writeJson(path.join(root,'resources-installed.json'),{version:manifest.version,revision:manifest.revision||0,installedAt:new Date().toISOString()});
 fs.unlinkSync(path.join(root,'resources-installing.json'));
}
module.exports={installBundle,digest,isBundleReady,adoptExistingBundle};
