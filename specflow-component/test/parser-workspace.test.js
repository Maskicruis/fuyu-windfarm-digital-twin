'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),os=require('node:os'),path=require('node:path');
const {workspace,prepareWorkspace}=require('../src/parser-workspace');
const {parserErrorSummary}=require('../src/parser-errors');
test('compact parsing workspace isolates databases and adopts legacy checkpoints without overwriting newer progress',{skip:process.platform!=='win32'},async()=>{
 const root=fs.mkdtempSync(path.join(os.tmpdir(),'sf-work-'));try{
 const python=path.join(root,'engines/python/python.exe');fs.mkdirSync(path.dirname(python),{recursive:true});fs.writeFileSync(python,'fixture');fs.writeFileSync(path.join(root,'engines/run_mineru.py'),'fixture');
 const data=path.join(root,'long Chinese delivery 资料库'.repeat(6),'data'),id='doc-fixture',env={LOCALAPPDATA:path.join(root,'local')};
 const a=workspace(data,id,python,env),b=workspace(data+'-other',id,python,env);assert.ok(a.directory.length<data.length);assert.notEqual(a.directory,b.directory);assert.ok(!a.directory.includes('资料库'));
 fs.mkdirSync(path.join(a.legacy,'checkpoints'),{recursive:true});fs.writeFileSync(path.join(a.legacy,'checkpoints/state.json'),'8 pages');await prepareWorkspace(a);assert.equal(fs.readFileSync(path.join(a.checkpoints,'state.json'),'utf8'),'8 pages');
 fs.writeFileSync(path.join(a.checkpoints,'state.json'),'16 pages');await prepareWorkspace(a);assert.equal(fs.readFileSync(path.join(a.checkpoints,'state.json'),'utf8'),'16 pages');
 }finally{fs.rmSync(root,{recursive:true,force:true});}
});
test('parser failure summaries retain the fatal cause instead of progress or checkpoint protocol noise',()=>{
 assert.equal(parserErrorSummary(Error('MinerU 退出码 1\nSPECFLOW_PROGRESS {"event":"checkpoint-warning"}\nTraceback:\nValueError: invalid PDF page')), 'ValueError: invalid PDF page');
 assert.match(parserErrorSummary(Error('ENOSPC: write')),/磁盘空间不足/);
 assert.match(parserErrorSummary(Error('PermissionError: [WinError 5]')),/权限/);
});
