'use strict';
const fs=require('node:fs'),path=require('node:path'),crypto=require('node:crypto');
module.exports=async function(context){
 const root=path.join(context.appOutDir,'resources','app'),files=[];
 function walk(folder){for(const item of fs.readdirSync(folder,{withFileTypes:true})){const file=path.join(folder,item.name);if(item.isSymbolicLink())throw Error('打包运行目录不应包含符号链接');if(item.isDirectory())walk(file);else if(item.isFile()&&path.relative(root,file)!=='runtime-integrity.json'){const data=fs.readFileSync(file);files.push({path:path.relative(root,file).split(path.sep).join('/'),bytes:data.length,sha256:crypto.createHash('sha256').update(data).digest('hex')});}}}
 walk(root);files.sort((a,b)=>a.path.localeCompare(b.path,'en'));
 const pkg=JSON.parse(fs.readFileSync(path.join(root,'package.json'),'utf8'));
 fs.writeFileSync(path.join(root,'runtime-integrity.json'),JSON.stringify({schema:1,version:pkg.version,files},null,2));
 console.log(JSON.stringify({packagedRuntimeFiles:files.length,version:pkg.version}));
};
