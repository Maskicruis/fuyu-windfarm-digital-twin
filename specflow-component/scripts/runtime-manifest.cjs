'use strict';
const fs=require('node:fs'),path=require('node:path'),crypto=require('node:crypto');
const root=path.resolve(process.argv[2]||path.join(__dirname,'..')),pkg=JSON.parse(fs.readFileSync(path.join(root,'package.json'),'utf8'));
const files=[];
function walk(folder){for(const item of fs.readdirSync(folder,{withFileTypes:true})){if(item.isSymbolicLink())throw Error('运行目录不应包含符号链接');const file=path.join(folder,item.name);if(item.isDirectory())walk(file);else if(item.isFile()){const data=fs.readFileSync(file);files.push({path:path.relative(root,file).split(path.sep).join('/'),bytes:data.length,sha256:crypto.createHash('sha256').update(data).digest('hex')});}}}
for(const folder of ['desktop','src','lib','schemas','ui-modules','engines','presets','integration','build'])walk(path.join(root,folder));
for(const name of ['ui.html','package.json','UPSTREAM-BACKEND.json','ui-provenance.json','NOTICE.md','resources-manifest.json']){const file=path.join(root,name),data=fs.readFileSync(file);files.push({path:name,bytes:data.length,sha256:crypto.createHash('sha256').update(data).digest('hex')});}
const visited=new Set();
function dependency(name,from){let directory=from,folder;while(true){const candidate=path.join(directory,'node_modules',name);if(fs.existsSync(path.join(candidate,'package.json'))){folder=candidate;break;}const parent=path.dirname(directory);if(parent===directory)throw Error('依赖不存在：'+name);directory=parent;}
 if(visited.has(folder))return;visited.add(folder);walk(folder);const metadata=JSON.parse(fs.readFileSync(path.join(folder,'package.json'),'utf8'));for(const child of Object.keys(metadata.dependencies||{}))dependency(child,folder);
}
for(const name of Object.keys(pkg.dependencies||{}))dependency(name,root);
const unique=[...new Map(files.map(item=>[item.path,item])).values()].sort((a,b)=>a.path.localeCompare(b.path,'en'));
fs.writeFileSync(path.join(root,'runtime-integrity.json'),JSON.stringify({schema:1,version:pkg.version,files:unique},null,2));
console.log(JSON.stringify({runtimeFiles:unique.length,bytes:unique.reduce((sum,item)=>sum+item.bytes,0),version:pkg.version}));
