'use strict';
// A clean worker exit without a result is a failure, not a promise that waits forever.
function workerJob(worker,{onMessage=()=>{},timeoutMs=300000}={}){
 return new Promise((resolve,reject)=>{
  let settled=false,timer,timingOut=false;
  const finish=(error,result)=>{if(settled)return;settled=true;clearTimeout(timer);error?reject(error):resolve(result);};
  const arm=()=>{clearTimeout(timer);timer=setTimeout(async()=>{if(settled)return;timingOut=true;try{await worker.terminate();}finally{finish(Object.assign(Error('后台处理线程长时间没有响应'),{code:'PARSER_STALLED'}));}},timeoutMs);timer.unref?.();};arm();
  worker.on('message',message=>{arm();onMessage(message);if(message.error)finish(Error(message.error));else if('result'in message)finish(null,message.result);});
  worker.once('error',error=>finish(error));
  worker.once('exit',code=>{if(!timingOut)finish(Error('后台线程退出但未返回处理结果（退出码 '+code+'）'));});
 });
}
module.exports={workerJob};
