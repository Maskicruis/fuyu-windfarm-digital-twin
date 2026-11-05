'use strict';
// Usage: node scripts/verify-component-detached-relay.cjs <bundled-pythonw.exe> <fresh-output-folder>
const fs=require('node:fs'),path=require('node:path'),assert=require('node:assert/strict'),{spawn}=require('node:child_process');
const python=path.resolve(process.argv[2]),root=path.resolve(process.argv[3]);
assert.equal(process.platform,'win32');assert.ok(fs.existsSync(python));assert.ok(!fs.existsSync(root));fs.mkdirSync(root,{recursive:true});
const ps=path.join(root,'apply-component-update.ps1'),plan=path.join(root,'install-plan.json');
fs.writeFileSync(ps,"param([string]$Plan)\n[IO.File]::WriteAllText($env:SF_PROBE,'executed')\n");fs.writeFileSync(plan,'{}');
function launch(executable,args,probe){return new Promise((resolve,reject)=>{
 const child=spawn(executable,args,{detached:true,windowsHide:true,stdio:'ignore',env:{...process.env,SF_PROBE:probe}});
 const timer=setTimeout(()=>{child.kill();reject(Error('Relay probe timed out'));},15000);
 child.once('error',reject);child.once('close',code=>{clearTimeout(timer);resolve({exitCode:code,scriptExecuted:fs.existsSync(probe)});});
});}
(async()=>{
 const direct=await launch('powershell.exe',['-NoProfile','-NonInteractive','-ExecutionPolicy','Bypass','-File',ps,'-Plan',plan],path.join(root,'direct.txt'));
 const relay=path.join(root,'update-relay.py');fs.copyFileSync(path.join(__dirname,'../specflow-component/desktop/update-relay.py'),relay);
 const bridged=await launch(python,[relay,plan],path.join(root,'relay.txt'));assert.equal(bridged.exitCode,0);assert.equal(bridged.scriptExecuted,true);
 const proof={passed:true,direct_detached_powershell:direct,bundled_python_relay:bridged};fs.writeFileSync(path.join(root,'proof.json'),JSON.stringify(proof,null,2));console.log(JSON.stringify(proof));
})().catch(error=>{console.error(error);process.exitCode=1;});
