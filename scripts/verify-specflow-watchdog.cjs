'use strict';
// Windows integration probe: real Python parent + descendant, no user files.
const {spawn,spawnSync}=require('node:child_process'),fs=require('node:fs'),path=require('node:path'),assert=require('node:assert/strict');
const {runMineru}=require('../specflow-component/src/mineru-adapter');
const {JobQueue}=require('../specflow-component/src/job-queue');
const python=process.argv[2],report=process.argv[3];if(!python||process.platform!=='win32')throw Error('Windows and a portable Python executable are required');
const code='import subprocess,sys,time\np=subprocess.Popen([sys.executable,"-c","import time;time.sleep(600)"])\nprint("WATCHDOG_CHILD",p.pid,flush=True)\ntime.sleep(600)';
let child,output='',caught;
const events=[],queue=new JobQueue();
queue.on('jobError',({error})=>{caught=error;events.push('timeout');});
const finished=new Promise(resolve=>queue.on('changed',state=>{if(!state.pending.length&&!state.active.length&&events.length)resolve();}));
queue.enqueue('hung',async()=>{events.push('start');await runMineru({executable:python,inputPath:'fixture',outputDir:path.resolve(process.argv[4]||'parser-watchdog-fixture'),limits:{quietMs:2000,stalledMs:5000,checkEveryMs:100},spawnProcess:(exe,_args,options)=>{child=spawn(exe,['-c',code],options);child.stdout.on('data',c=>output+=c);return child;}});});queue.enqueue('next',async()=>events.push('next'));
(async()=>{
 await finished;assert.equal(caught?.code,'PARSER_STALLED');assert.deepEqual(events,['start','timeout','next']);
 const grandchild=Number(output.match(/WATCHDOG_CHILD (\d+)/)?.[1]);assert.ok(grandchild,'real descendant did not start');
 const check=spawnSync('powershell.exe',['-NoProfile','-NonInteractive','-Command',`if(Get-Process -Id ${grandchild} -ErrorAction SilentlyContinue){exit 1}else{exit 0}`],{windowsHide:true});assert.equal(check.status,0,'parser descendant remains alive');
 const proof={passed:true,real_process_tree_killed:true,parent:child.pid,descendant:grandchild,next_queue_job_ran:true,retry_policy:'separately verified once at tail',event_order:events};if(report)fs.writeFileSync(report,JSON.stringify(proof,null,2));console.log(JSON.stringify(proof));
})().catch(error=>{console.error(error);process.exitCode=1;});
