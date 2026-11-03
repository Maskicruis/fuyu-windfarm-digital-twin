'use strict';
const fs=require('node:fs'),path=require('node:path'),crypto=require('node:crypto');
const REPOSITORY='Maskicruis/fuyu-windfarm-digital-twin',MAX_BYTES=512*1024*1024;
function version(value){if(!/^\d+\.\d+\.\d+$/.test(value))throw Error('组件版本无效');return value.split('.').map(Number);}
function newer(a,b){const x=version(a),y=version(b);for(let i=0;i<3;i++){if(x[i]!==y[i])return x[i]>y[i];}return false;}
function trustedUrl(value){const u=new URL(value);if(u.protocol!=='https:'||u.username||u.password||(u.port&&u.port!=='443')||!['api.github.com','github.com','release-assets.githubusercontent.com','objects.githubusercontent.com'].includes(u.hostname))throw Error('更新地址不受信任');return u;}
function selectRelease(releases,current){
 const choices=[];
 for(const release of releases){
  const match=/^component-v(\d+\.\d+\.\d+)$/.exec(release.tag_name||'');
  if(!match||release.draft||release.prerelease||!newer(match[1],current))continue;
  const v=match[1],name=`SpecFlow-Knowledge-Component-${v}-x64.exe`;
  const asset=(release.assets||[]).find(a=>a.name===name&&a.state==='uploaded');
  if(!asset||!/^sha256:[a-f0-9]{64}$/.test(asset.digest||'')||!Number.isSafeInteger(asset.size)||asset.size<1||asset.size>MAX_BYTES)continue;
  const url=trustedUrl(asset.browser_download_url);
  if(url.hostname!=='github.com'||decodeURIComponent(url.pathname)!==`/${REPOSITORY}/releases/download/component-v${v}/${name}`)continue;
  choices.push({version:v,name,size:asset.size,sha256:asset.digest.slice(7),url:url.href,notes:String(release.body||'').slice(0,12000),releaseUrl:`https://github.com/${REPOSITORY}/releases/tag/component-v${v}`});
 }
 return choices.sort((a,b)=>newer(a.version,b.version)?-1:newer(b.version,a.version)?1:0)[0]||null;
}
class ComponentUpdater{
 constructor({current,root,fetch,apply}){version(current);this.current=current;this.root=path.resolve(root);this.fetch=fetch;this.apply=apply;this.folder=path.join(this.root,'workspace/data/updates');this.item=null;this.busy=false;this.package=null;this.state={phase:'idle',message:'检查独立知识组件更新',progress:0};}
 status(){return {...this.state,currentVersion:this.current,availableVersion:this.item?.version||null,releaseUrl:this.item?.releaseUrl||null,notes:this.item?.notes||'',repository:REPOSITORY,busy:this.busy,canInstall:!!this.apply};}
 async response(url,timeout=45000){for(let redirects=0;redirects<6;redirects++){
  trustedUrl(url);const response=await this.fetch(url,{redirect:'manual',signal:AbortSignal.timeout(timeout),headers:{'User-Agent':'SpecFlow-Component-Updater/'+this.current,'Accept':new URL(url).hostname==='api.github.com'?'application/vnd.github+json':'application/octet-stream'}});
  if([301,302,303,307,308].includes(response.status)){const location=response.headers.get('location');if(!location)throw Error('更新重定向地址缺失');url=new URL(location,url).href;continue;}
  if(!response.ok)throw Error('更新服务返回 HTTP '+response.status+(response.status===403?'，请稍后重试':''));return response;
 }throw Error('更新重定向次数过多');}
 async check(){if(this.busy)throw Error('更新任务进行中');this.busy=true;this.state={phase:'checking',message:'正在检查知识组件发布…',progress:0};
  try{
   // Never use /releases/latest: that belongs to the digital twin application.
   const response=await this.response(`https://api.github.com/repos/${REPOSITORY}/releases?per_page=100`),text=await response.text();if(text.length>4*1024*1024)throw Error('更新元数据过大');
   const releases=JSON.parse(text);if(!Array.isArray(releases))throw Error('组件发布列表无效');
   this.item=selectRelease(releases,this.current);this.package=null;
   this.state={phase:this.item?'available':'current',message:this.item?'发现知识组件 V'+this.item.version:'当前知识组件已是最新版本 V'+this.current,progress:0};
  }catch(error){this.state={phase:'error',message:'检查更新失败：'+error.message,progress:0};throw error;}finally{this.busy=false;}return this.status();
 }
 async download(){if(this.busy||!this.item)throw Error('请先检查可用更新');this.busy=true;const item=this.item;
  this.state={phase:'downloading',message:'正在下载知识组件…',progress:0,received:0,total:item.size};fs.mkdirSync(this.folder,{recursive:true});
  const target=path.join(this.folder,item.name),partial=target+'.partial';let handle;
  try{
   const response=await this.response(item.url,7200000);handle=await fs.promises.open(partial,'w');const hash=crypto.createHash('sha256');let received=0;
   const reader=response.body.getReader();try{while(true){let timer;const part=await Promise.race([reader.read(),new Promise((_,reject)=>{timer=setTimeout(()=>reject(Error('更新下载连续 60 秒无数据，请重试')),60000);})]).finally(()=>clearTimeout(timer));const {value,done}=part;if(done)break;received+=value.byteLength;if(received>item.size||received>MAX_BYTES)throw Error('更新包超过声明大小');hash.update(value);await handle.writeFile(value);this.state.received=received;this.state.progress=Math.floor(received/item.size*100);}}catch(error){await reader.cancel().catch(()=>{});throw error;}finally{reader.releaseLock();}
   await handle.sync();await handle.close();handle=null;
   if(received!==item.size||hash.digest('hex')!==item.sha256)throw Error('更新包大小或 SHA256 校验失败，未安装');
   fs.renameSync(partial,target);this.package=target;this.state={phase:'ready',message:'更新包已校验，可安装并重启',progress:100,total:received,received};
  }catch(error){if(handle)await handle.close().catch(()=>{});await fs.promises.rm(partial,{force:true});this.package=null;this.state={phase:'error',message:'下载更新失败：'+error.message,progress:0};throw error;}finally{this.busy=false;}return this.status();
 }
 async install(){if(this.busy||!this.item||!this.package||this.state.phase!=='ready'||!this.apply)throw Error('没有可安装的已校验组件更新');
  this.busy=true;
  try{
  const file=this.package,item=this.item,hash=crypto.createHash('sha256');for await(const chunk of fs.createReadStream(file))hash.update(chunk);
  if(hash.digest('hex')!==item.sha256)throw Error('更新文件已变化，请重新下载');
  this.state={...this.state,phase:'installing',message:'正在保存数据并重启知识组件…'};await this.apply({file,item});return this.status();
  }finally{this.busy=false;}
 }
}
module.exports={ComponentUpdater,selectRelease,newer,trustedUrl};
