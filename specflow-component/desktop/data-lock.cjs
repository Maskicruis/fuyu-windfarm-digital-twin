'use strict';
const fs=require('node:fs'),path=require('node:path');
function alive(pid){if(!Number.isInteger(pid)||pid<1)return false;try{process.kill(pid,0);return true;}catch(e){return e.code==='EPERM';}}
class DataLock{
 constructor(data){this.file=path.join(data,'component-owner.lock');this.owned=false;}
 read(){try{return JSON.parse(fs.readFileSync(this.file,'utf8'));}catch{return null;}}
 create(){const fd=fs.openSync(this.file,'wx');try{fs.writeFileSync(fd,JSON.stringify({pid:process.pid,createdAt:Date.now()}));}finally{fs.closeSync(fd);}this.owned=true;return true;}
 acquire(){try{return this.create();}catch(e){if(e.code!=='EEXIST')throw e;}
  let guard;try{guard=fs.openSync(this.file+'.reclaim','wx');}catch(e){if(e.code==='EEXIST')return false;throw e;}
  try{const owner=this.read();if(owner&&alive(owner.pid))return false;if(!owner&&fs.statSync(this.file).mtimeMs>Date.now()-10000)return false;try{fs.unlinkSync(this.file);}catch(e){if(e.code!=='ENOENT')throw e;}try{return this.create();}catch(e){if(e.code==='EEXIST')return false;throw e;}}
  finally{fs.closeSync(guard);fs.unlinkSync(this.file+'.reclaim');}
 }
 publish(url){if(this.owned)fs.writeFileSync(this.file,JSON.stringify({pid:process.pid,url,createdAt:Date.now()}));}
 release(){if(this.owned&&this.read()?.pid===process.pid){try{fs.unlinkSync(this.file);}catch{}}this.owned=false;}
 async url(){for(let i=0;i<100;i++){const value=this.read();if(value&&alive(value.pid)&&/^http:\/\/127\.0\.0\.1:\d+\/$/.test(value.url||''))return value.url;await new Promise(r=>setTimeout(r,100));}throw Error('后台正在启动，请稍后重新打开。');}
}
module.exports={DataLock};
