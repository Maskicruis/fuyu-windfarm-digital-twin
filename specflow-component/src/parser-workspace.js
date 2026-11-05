'use strict';
const fs=require('node:fs'),path=require('node:path'),os=require('node:os'),crypto=require('node:crypto');
const hash=value=>crypto.createHash('sha256').update(value).digest('hex');
function workspace(data,id,executable,env=process.env){
 const legacy=path.join(data,'work',id);
 const bundled=path.basename(executable||'').toLowerCase()==='python.exe'&&fs.existsSync(path.join(path.dirname(executable),'../run_mineru.py'));
 if(!bundled||process.platform!=='win32')return {directory:legacy,checkpoints:path.join(legacy,'checkpoints'),legacy};
 // Keep transient native-library paths short and independent of the delivery
 // folder and Chinese/long PDF titles. Scope caches by the exact data directory.
 const base=path.join(env.LOCALAPPDATA||os.tmpdir(),'SFWork',hash(path.resolve(data).toLowerCase()).slice(0,12));
 const directory=path.join(base,hash(id).slice(0,16));
 return {directory,checkpoints:path.join(directory,'cp'),legacy};
}
async function prepareWorkspace(layout){
 await fs.promises.mkdir(layout.directory,{recursive:true});
 if(layout.directory!==layout.legacy){
  const marker=path.join(layout.directory,'.legacy-adopted');
  if(!fs.existsSync(marker)){
   const old=path.join(layout.legacy,'checkpoints');
   if(fs.existsSync(old))await fs.promises.cp(old,layout.checkpoints,{recursive:true,force:false,errorOnExist:false});
   await fs.promises.writeFile(marker,'1');
  }
 }
 await fs.promises.mkdir(layout.checkpoints,{recursive:true});return layout;
}
module.exports={workspace,prepareWorkspace};
