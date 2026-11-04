'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),os=require('node:os'),{spawnSync}=require('node:child_process');
const script=path.resolve(__dirname,'../desktop/extract-resources.ps1');
function ps(code,env){const result=spawnSync('powershell.exe',['-NoProfile','-NonInteractive','-Command',code],{windowsHide:true,env:{...process.env,...env},encoding:'utf8'});assert.equal(result.status,0,result.stderr);}
function createZip(archive,entries){ps("Add-Type -AssemblyName System.IO.Compression.FileSystem; $z=[IO.Compression.ZipFile]::Open($env:ZIP,'Create'); try { foreach($row in (ConvertFrom-Json $env:ENTRIES)) {$e=$z.CreateEntry($row.path); $w=New-Object IO.StreamWriter($e.Open());try {$w.Write($row.text)}finally{$w.Dispose()}} } finally {$z.Dispose()}",{ZIP:archive,ENTRIES:JSON.stringify(entries)});}
function extract(archive,destination){return spawnSync('powershell.exe',['-NoProfile','-NonInteractive','-File',script],{windowsHide:true,env:{...process.env,SF_ARCHIVE:archive,SF_DEST:destination,SF_PRESERVE:'1'},encoding:'utf8'});}
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

test('Windows PowerShell 5.1 extracts and replaces deep Unicode paths beyond MAX_PATH',{skip:process.platform!=='win32'},()=>{
 const root=fs.mkdtempSync(path.join(os.tmpdir(),'sf-long-中文 ')),destination=path.join(root,'领导测试 完整离线交付包',...Array(4).fill('安装目录与版本 V1.3.5'));
 const relative='engines/python/Lib/site-packages/modelscope/models/cv/image_quality_assessment_degradation/'+('nested-module/'.repeat(9))+'image_quality_assessment_degradation_dataset.py',target=path.join(destination,relative),archive=path.join(root,'engine.zip');
 try{
  assert.ok(target.length>320);createZip(archive,[{path:relative,text:'complete engine source 中文'}]);
  fs.mkdirSync(path.dirname(target),{recursive:true});fs.writeFileSync(target,'partial old install');
  for(let i=0;i<2;i++){const result=extract(archive,destination);assert.equal(result.status,0,result.stderr);assert.equal(fs.readFileSync(target,'utf8'),'complete engine source 中文');assert.match(result.stdout,/SF_EXTRACT 1\/1/);}
  assert.ok(!fs.readdirSync(path.dirname(target)).some(name=>name.startsWith('.sf-')));
 }finally{fs.rmSync(root,{recursive:true,force:true});}
});

test('failed replacement keeps the previous file and cleans its temporary sibling',{skip:process.platform!=='win32'},()=>{
 const root=fs.mkdtempSync(path.join(os.tmpdir(),'sf-atomic-')),destination=path.join(root,'destination'),target=path.join(destination,'原有文件.txt'),archive=path.join(root,'engine.zip');fs.mkdirSync(destination);
 try{
  createZip(archive,[{path:'原有文件.txt',text:'new content'}]);fs.writeFileSync(target,'previous complete content');fs.chmodSync(target,0o444);
  const result=extract(archive,destination);assert.notEqual(result.status,0);assert.match(result.stderr,/SF_EXTRACT_ERROR /);assert.ok(result.stderr.includes('原有文件.txt'));assert.ok(!result.stderr.includes('\ufffd'));assert.equal(fs.readFileSync(target,'utf8'),'previous complete content');assert.deepEqual(fs.readdirSync(destination),['原有文件.txt']);
 }finally{fs.chmodSync(target,0o666);fs.rmSync(root,{recursive:true,force:true});}
});

test('all archive names are validated before any writes, including Windows path aliases',{skip:process.platform!=='win32'},()=>{
 const root=fs.mkdtempSync(path.join(os.tmpdir(),'sf-path-alias-')),destination=path.join(root,'destination');
 try{
  for(const [i,bad] of ['..\\escaped.txt','C:/escaped.txt','/escaped.txt','safe/../escaped.txt','safe/file:stream','safe/CON.txt'].entries()){
   const archive=path.join(root,i+'.zip');createZip(archive,[{path:'first.txt',text:'must not be written'},{path:bad,text:'bad'}]);
   const result=extract(archive,destination);assert.notEqual(result.status,0,bad);assert.ok(!fs.existsSync(path.join(destination,'first.txt')),bad);assert.ok(!fs.existsSync(path.join(root,'escaped.txt')),bad);
  }
 }finally{fs.rmSync(root,{recursive:true,force:true});}
});
