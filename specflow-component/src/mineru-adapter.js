'use strict';

const { spawn } = require('node:child_process');
const fs=require('node:fs'),path=require('node:path');

const BACKENDS = new Set([
  'pipeline',
  'vlm',
  'hybrid',
  'vlm-engine',
  'hybrid-engine',
  'vlm-http-client',
  'hybrid-http-client',
  'hybrid-auto-engine'
]);
const METHODS = new Set(['auto', 'txt', 'ocr']);

function normalizeOptions(options = {}) {
  const backend = String(options.backend || 'pipeline');
  const method = String(options.method || 'auto');
  if (!BACKENDS.has(backend)) throw new Error('不支持的 MinerU backend: ' + backend);
  if (!METHODS.has(method)) throw new Error('不支持的 MinerU method: ' + method);
  return {
    backend,
    method,
    language: String(options.language || 'ch'),
    parseTables: options.parseTables !== false,
    parseFormula: options.parseFormula === true,
    modelSource: String(options.modelSource || 'modelscope'),
    effort: options.effort ? String(options.effort) : ''
  };
}

function buildArgs(inputPath, outputDir, options = {}) {
  const o = normalizeOptions(options);
  const args = [
    '-p', inputPath,
    '-o', outputDir,
    '-b', o.backend,
    '-m', o.method,
    '-t', String(o.parseTables),
    '-f', String(o.parseFormula),
    '-l', o.language
  ];
  if (o.effort && o.backend.startsWith('hybrid')) {
    args.push('--effort', o.effort);
  }
  return args;
}

function withLocalProxyBypass(env = process.env) {
  const entries = [env.NO_PROXY, env.no_proxy]
    .filter(Boolean)
    .flatMap(value => String(value).split(','))
    .map(value => value.trim())
    .filter(Boolean);
  for (const host of ['127.0.0.1', 'localhost', '::1']) {
    if (!entries.includes(host)) entries.push(host);
  }
  const noProxy = entries.join(',');
  return Object.assign({}, env, { NO_PROXY: noProxy, no_proxy: noProxy });
}

const {StringDecoder}=require('node:string_decoder');
const {ParserActivity,LIMITS}=require('./parser-activity');
const activeChildren=new Set();
function terminateTree(child){
 return new Promise((resolve,reject)=>{
  if(child.exitCode!=null||child.signalCode)return resolve();
  const timer=setTimeout(()=>reject(Error('无法确认解析子进程已经退出')),10000);
  const done=error=>{clearTimeout(timer);error?reject(error):resolve();};
  child.once('close',()=>done());
  if(process.platform==='win32'){
   const killer=spawn('taskkill',['/PID',String(child.pid),'/T','/F'],{windowsHide:true,stdio:'ignore'});
   killer.once('error',done);killer.once('close',code=>{if(code!==0&&child.exitCode==null)done(Error('终止进程树失败 '+code));});
  }else{child.kill('SIGKILL');}
 });
}
function stopMineru(){return Promise.allSettled([...activeChildren].map(child=>terminateTree(child)));}
async function runMineru({executable,inputPath,outputDir,options,onProgress,onLog,onStatus,checkpointDir,spawnProcess=spawn,terminateProcess=terminateTree,limits=LIMITS,now=Date.now}){
 const normalized=normalizeOptions(options),args=buildArgs(inputPath,outputDir,normalized);
 const bundledEntry=path.join(path.dirname(executable),'..','run_mineru.py');
 if(path.basename(executable).toLowerCase()==='python.exe'&&fs.existsSync(bundledEntry)){
  if(normalized.backend!=='pipeline'||normalized.parseFormula)throw Error('内置离线引擎提供 pipeline 中文OCR、版面与表格解析。高级公式或VLM请指定相应的外部引擎。');
  args.unshift(bundledEntry);
 }
 const sourceHash=checkpointDir?await new Promise((resolve,reject)=>{const hash=require('node:crypto').createHash('sha256'),stream=fs.createReadStream(inputPath);stream.on('data',chunk=>hash.update(chunk));stream.once('error',reject);stream.once('end',()=>resolve(hash.digest('hex')));}):'';
 return new Promise((resolve,reject)=>{
  const env=Object.assign(withLocalProxyBypass(),{MINERU_MODEL_SOURCE:normalized.modelSource,PYTHONIOENCODING:'utf-8'});
  if(checkpointDir){env.KB_PARSER_CHECKPOINT_DIR=checkpointDir;env.KB_PARSER_SOURCE_SHA256=sourceHash;}
  env.MINERU_API_OUTPUT_ROOT=path.join(outputDir,'api-work');
  const child=spawnProcess(executable,args,{windowsHide:true,shell:false,env});
  activeChildren.add(child);
  const activity=new ParserActivity(now());let output='',lastEmission=0,settled=false,terminating=false;
  const report=()=>onStatus?.(activity.snapshot(now()));
  const finish=(error,result)=>{if(settled)return;settled=true;clearInterval(watchdog);if(error?.code!=='PARSER_CLEANUP_FAILED')activeChildren.delete(child);report();error?reject(error):resolve(result);};
  const watchdog=setInterval(async()=>{
   if(settled||terminating)return;
   report();const reason=activity.timeout(now(),limits);if(!reason)return;
   terminating=true;
   const error=Object.assign(Error(reason+'。已终止本次解析，将保留检查点。'),{code:'PARSER_STALLED',diagnostic:activity.snapshot(now())});
   try{await terminateProcess(child);}catch(cause){error.code='PARSER_CLEANUP_FAILED';error.message='解析进程无法安全终止，已暂停队列，请重启组件。'+cause.message;}
   finish(error);
  },limits.checkEveryMs);
  watchdog.unref?.();
  report();
  onProgress?.(null);
  const attach=stream=>{
   const decoder=new StringDecoder('utf8');let pending='';
   const consume=text=>{
    if(!text)return;output+=text;if(output.length>200000)output=output.slice(-100000);
    activity.lastOutputAt=now();pending+=text;
    const lines=pending.split(/[\r\n]/);pending=lines.pop().slice(-8192);activity.consume(lines.join('\n'),now());
    if(now()-lastEmission>1000){lastEmission=now();onLog?.(output.slice(-1200));report();}
   };
   stream.on('data',chunk=>consume(decoder.write(chunk)));
   stream.once('end',()=>{consume(decoder.end());if(pending)activity.consume(pending,now());});
  };
  attach(child.stdout);attach(child.stderr);
  child.once('error',error=>finish(error));
  child.once('close',code=>{
   activeChildren.delete(child);
   onLog?.(output.slice(-1200));if(terminating)return;
   if(code===0)finish(null,{output,args,activity:activity.snapshot(now())});
   else finish(Object.assign(Error('MinerU 退出码 '+code+'\n'+output.slice(-3000)),{code:'PARSER_EXIT'}));
  });
 });
}
module.exports={buildArgs,normalizeOptions,runMineru,stopMineru,withLocalProxyBypass,terminateTree};
