'use strict';
const fs=require('node:fs'),path=require('node:path'),crypto=require('node:crypto'),{spawn}=require('node:child_process');
async function prepareEngine(root){
 const engine=path.join(root,'engines'),python=path.join(engine,'python/python.exe');
 if(!fs.existsSync(python))return;
 const source=path.resolve(__dirname,'../engines');
 const hash=file=>crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
 const marker=path.join(engine,'component-patches.json');
 const wanted=Object.fromEntries(['apply_patches.py','checkpoint.py','run_mineru.py'].map(name=>[name,hash(path.join(source,name))]));
 try{const current=JSON.parse(fs.readFileSync(marker,'utf8'));if(JSON.stringify(current.source)===JSON.stringify(wanted)&&Object.entries(current.files).every(([name,digest])=>hash(path.join(engine,name))===digest))return;}catch{}
 await new Promise((resolve,reject)=>{
  const child=spawn(python,[path.join(source,'apply_patches.py'),engine],{windowsHide:true,shell:false,env:{...process.env,PYTHONIOENCODING:'utf-8'}});let output='';
  child.stdout.on('data',c=>output+=c);child.stderr.on('data',c=>output+=c);child.once('error',reject);child.once('close',code=>code===0?resolve():reject(Error('解析引擎兼容检查失败：'+output.slice(-1500))));
 });
 const current=JSON.parse(fs.readFileSync(marker,'utf8'));current.source=wanted;fs.writeFileSync(marker,JSON.stringify(current,null,2));
}
module.exports={prepareEngine};
