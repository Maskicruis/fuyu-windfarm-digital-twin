'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),os=require('node:os'),{spawnSync}=require('node:child_process');
const script=path.resolve(__dirname,'../desktop/extract-resources.ps1');
function ps(code,env){const result=spawnSync('powershell.exe',['-NoProfile','-NonInteractive','-Command',code],{windowsHide:true,env:{...process.env,...env},encoding:'utf8'});assert.equal(result.status,0,result.stderr);}
test('database resource upgrades preserve user library files and replace only preset metadata',{skip:process.platform!=='win32'},()=>{
 const root=fs.mkdtempSync(path.join(os.tmpdir(),'sf-解压验证-')),source=path.join(root,'source'),destination=path.join(root,'destination'),archive=path.join(root,'database.zip');
 try{
  for(const folder of [source,destination]){fs.mkdirSync(path.join(folder,'database'),{recursive:true});fs.mkdirSync(path.join(folder,'workspace/资料库/book'),{recursive:true});}
  fs.writeFileSync(path.join(source,'database/manifest.json'),'new-preset');fs.writeFileSync(path.join(destination,'database/manifest.json'),'old-preset');fs.writeFileSync(path.join(source,'workspace/资料库/book/document.json'),'default-content');fs.writeFileSync(path.join(destination,'workspace/资料库/book/document.json'),'user-corrected-content');fs.writeFileSync(path.join(source,'workspace/资料库/book/new.pdf'),'%PDF-1.4');
  ps("Add-Type -AssemblyName System.IO.Compression.FileSystem; [IO.Compression.ZipFile]::CreateFromDirectory($env:SOURCE,$env:ZIP)",{SOURCE:source,ZIP:archive});
  const result=spawnSync('powershell.exe',['-NoProfile','-NonInteractive','-File',script],{windowsHide:true,env:{...process.env,SF_ARCHIVE:archive,SF_DEST:destination,SF_PRESERVE:'1'},encoding:'utf8'});assert.equal(result.status,0,result.stderr);assert.equal(fs.readFileSync(path.join(destination,'database/manifest.json'),'utf8'),'new-preset');assert.equal(fs.readFileSync(path.join(destination,'workspace/资料库/book/document.json'),'utf8'),'user-corrected-content');assert.ok(fs.existsSync(path.join(destination,'workspace/资料库/book/new.pdf')));assert.match(result.stdout,/SF_EXTRACT/);
 }finally{fs.rmSync(root,{recursive:true,force:true});}
});
test('resource archive traversal is rejected before any external file is written',{skip:process.platform!=='win32'},()=>{
 const root=fs.mkdtempSync(path.join(os.tmpdir(),'sf-zip-path-')),archive=path.join(root,'bad.zip'),destination=path.join(root,'destination');fs.mkdirSync(destination);
 try{
  ps("Add-Type -AssemblyName System.IO.Compression.FileSystem; $z=[IO.Compression.ZipFile]::Open($env:ZIP,'Create'); $e=$z.CreateEntry('../escaped.txt'); $w=New-Object IO.StreamWriter($e.Open()); $w.Write('bad');$w.Dispose();$z.Dispose()",{ZIP:archive});
  const result=spawnSync('powershell.exe',['-NoProfile','-NonInteractive','-File',script],{windowsHide:true,env:{...process.env,SF_ARCHIVE:archive,SF_DEST:destination,SF_PRESERVE:'1'},encoding:'utf8'});assert.notEqual(result.status,0);assert.ok(!fs.existsSync(path.join(root,'escaped.txt')));
 }finally{fs.rmSync(root,{recursive:true,force:true});}
});
