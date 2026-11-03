'use strict';
const fs=require('node:fs'),path=require('node:path'),crypto=require('node:crypto');
const hash=buffer=>crypto.createHash('sha256').update(buffer).digest('hex');
function inside(root,name){
 if(typeof name!=='string'||path.isAbsolute(name)||name.includes('\\')||name.split('/').some(p=>!p||p==='.'||p==='..'))throw Error('运行文件清单路径无效');
 const file=path.resolve(root,name);if(!file.startsWith(path.resolve(root)+path.sep))throw Error('运行文件越界');return file;
}
function matches(file,item){try{const stat=fs.statSync(file);return stat.isFile()&&stat.size===item.bytes&&hash(fs.readFileSync(file))===item.sha256;}catch{return false;}}
function ensureRuntime(source,cacheBase){
 const raw=fs.readFileSync(path.join(source,'runtime-integrity.json'));
 const manifest=JSON.parse(raw);if(manifest.schema!==1||!/^\d+\.\d+\.\d+$/.test(manifest.version)||!Array.isArray(manifest.files)||manifest.files.length<1)throw Error('运行文件校验清单无效');
 const folder=path.join(cacheBase,manifest.version+'-'+hash(raw).slice(0,16));fs.mkdirSync(folder,{recursive:true});let repaired=0;
 for(const item of manifest.files){
  if(!Number.isSafeInteger(item.bytes)||item.bytes<0||!/^[a-f0-9]{64}$/.test(item.sha256))throw Error('运行文件校验项无效');
  const target=inside(folder,item.path);if(matches(target,item))continue;
  const original=inside(source,item.path);if(!matches(original,item))throw Error('安装文件缺失或损坏：'+item.path+'。请重新下载此版本 EXE。');
  fs.mkdirSync(path.dirname(target),{recursive:true});const temp=target+'.'+process.pid+'.tmp';
  fs.copyFileSync(original,temp);fs.renameSync(temp,target);repaired++;
 }
 fs.writeFileSync(path.join(folder,'runtime-integrity.json'),raw);
 return {folder,repaired,version:manifest.version,files:manifest.files.length};
}
module.exports={ensureRuntime,inside};
