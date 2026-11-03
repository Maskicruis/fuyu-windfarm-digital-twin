'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),os=require('node:os'),path=require('node:path');
const directory=fs.mkdtempSync(path.join(os.tmpdir(),'sf-recovery-test-'));process.env.KB_DATA_DIR=directory;
const {KnowledgeBaseService}=require('../src/service'),{JobQueue}=require('../src/job-queue');
test('a stalled file retries at the tail once, allows the next file through, then stops retrying',async()=>{
 const s=Object.create(KnowledgeBaseService.prototype);s.documents=[{id:'a'},{id:'b'}];s.queue=new JobQueue();s.ocrQueue=new JobQueue();s.pendingRecovery=new Set();s.persist=()=>{};s.log=()=>{};
 const order=[];s.process=async d=>{order.push(d.id);if(d.id==='a')throw Object.assign(Error('fixture stalled'),{code:'PARSER_STALLED'});d.status='ready';};
 s.ocrQueue.on('jobError',({id,error})=>s.handleParseError(id,error));s.ocrQueue.on('changed',()=>s.requeueRecovery());
 const finished=new Promise(resolve=>s.ocrQueue.on('changed',state=>{if(!state.active.length&&!state.pending.length&&!s.pendingRecovery.size)resolve();}));
 for(const d of s.documents)s.ocrQueue.enqueue(d.id,()=>s.process(d,true));await finished;
 assert.deepEqual(order,['a','b','a']);assert.equal(s.get('a').status,'error');assert.equal(s.get('a').recoveryAttempts,1);assert.equal(s.get('b').status,'ready');
});
test('failed process-tree cleanup blocks further OCR launches and surfaces a reason',()=>{
 const s=Object.create(KnowledgeBaseService.prototype);s.documents=[{id:'a'}];s.ocrQueue=new JobQueue();s.persist=()=>{};s.log=()=>{};
 s.handleParseError('a',Object.assign(Error('fixture cleanup failed'),{code:'PARSER_CLEANUP_FAILED'}));assert.equal(s.ocrQueue.concurrency,0);assert.equal(s.get('a').status,'error');assert.match(s.parserBlockedReason,/cleanup failed/);
});
test('explicit reparse of a completed document bypasses cached OCR and resets the retry budget',()=>{
 const s=Object.create(KnowledgeBaseService.prototype);s.documents=[{id:'ready',status:'ready',recoveryAttempts:1},{id:'failed',status:'error',recoveryAttempts:1}];s.queue=new JobQueue();s.ocrQueue=new JobQueue();s.enqueue=()=>{};
 s.retry('ready');assert.equal(s.get('ready').forceReparse,true);assert.equal(s.get('ready').recoveryAttempts,0);
 s.retry('failed');assert.equal(s.get('failed').forceReparse,undefined);assert.equal(s.get('failed').recoveryAttempts,0);
});
test.after(()=>fs.rmSync(directory,{recursive:true,force:true}));
