'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),{EventEmitter}=require('node:events'),{PassThrough}=require('node:stream'),{Worker}=require('node:worker_threads');
const {ParserActivity}=require('../src/parser-activity'),{runMineru}=require('../src/mineru-adapter'),{workerJob}=require('../src/worker-job');
const lease=setInterval(()=>{},1000);test.after(()=>clearInterval(lease));
function processStub(){const child=new EventEmitter();child.stdout=new PassThrough();child.stderr=new PassThrough();return child;}
test('document pages come from committed windows, never layout or table percentages',()=>{
 const a=new ParserActivity(0);a.consume('Pipeline processing-window multi-file run. total_pages=65\nPipeline processing window batch 2/9: 16/65 pages, batch_pages=8\nTable orientation: 100% 11/11\n',1);
 assert.equal(a.completed,8);assert.equal(a.total,65);assert.equal(a.currentStart,9);assert.equal(a.currentEnd,16);assert.equal(a.phase,'判断表格方向');
 a.consume('SPECFLOW_PROGRESS {"event":"checkpoint","completed":16,"total":65}\n',2);assert.equal(a.completed,16);assert.equal(a.checkpointPages,16);
});
test('silent engine is killed before the job rejects, and cleanup occurs once',async()=>{
 const child=processStub();let killed=0,cleaned=false;
 const job=runMineru({executable:'stub',inputPath:'x',outputDir:'y',spawnProcess:()=>child,limits:{quietMs:30,stalledMs:200,checkEveryMs:5},terminateProcess:async()=>{killed++;await new Promise(r=>setTimeout(r,10));child.emit('close',1);cleaned=true;}});
 await assert.rejects(job,e=>e.code==='PARSER_STALLED'&&cleaned);assert.equal(killed,1);child.emit('close',0);
});
test('repeated noisy logs cannot hide a window that makes no page progress',async()=>{
 const child=processStub(),noise=setInterval(()=>child.stderr.write('OCR-rec Predict: 10% 1/10\r'),8);
 try{await assert.rejects(runMineru({executable:'stub',inputPath:'x',outputDir:'y',spawnProcess:()=>child,limits:{quietMs:100,stalledMs:70,checkEveryMs:5},terminateProcess:async()=>child.emit('close',1)}),e=>e.code==='PARSER_STALLED');}finally{clearInterval(noise);}
});
test('ongoing completed pages reset the progress watchdog',async()=>{
 const child=processStub();let count=0;
 const ticker=setInterval(()=>{count++;child.stderr.write('SPECFLOW_PROGRESS '+JSON.stringify({event:'pages',completed:count,total:4})+'\n');if(count===4){clearInterval(ticker);child.emit('close',0);}},25);
 try{const result=await runMineru({executable:'stub',inputPath:'x',outputDir:'y',spawnProcess:()=>child,limits:{quietMs:100,stalledMs:70,checkEveryMs:5},terminateProcess:async()=>{throw Error('Healthy process must not be killed');}});assert.equal(result.activity.completed,4);}finally{clearInterval(ticker);}
});
test('worker exit without a result rejects rather than leaving the queue pending',async()=>{await assert.rejects(workerJob(new Worker('process.exit(0)',{eval:true})),/未返回/);});
test('hung worker is terminated and retains the recoverable timeout code',async()=>{await assert.rejects(workerJob(new Worker('setInterval(()=>{},100)',{eval:true}),{timeoutMs:50}),e=>e.code==='PARSER_STALLED');});
