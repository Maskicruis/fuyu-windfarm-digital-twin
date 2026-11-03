'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),os=require('node:os');
const {initializeBundle}=require('../desktop/bundle.cjs'),{installBundle,isBundleReady}=require('../desktop/install-bundle.cjs');
const {preferDiscoveredMineru,mineruCandidates}=require('../src/config');

test('a compatibility resource revision invalidates an older installed marker',()=>{
 const root=fs.mkdtempSync(path.join(os.tmpdir(),'sf-revision-'));
 try{fs.writeFileSync(path.join(root,'resources-manifest.json'),JSON.stringify({version:'9.0.0',revision:1,required:[]}));fs.writeFileSync(path.join(root,'resources-installed.json'),JSON.stringify({version:'9.0.0'}));assert.equal(isBundleReady(root),false);fs.writeFileSync(path.join(root,'resources-installed.json'),JSON.stringify({version:'9.0.0',revision:1}));assert.equal(isBundleReady(root),true);}finally{fs.rmSync(root,{recursive:true,force:true});}
});
test('bundled engine discovery follows a moved EXE and replaces stale build-machine settings',()=>{
 const bundle=path.join(os.tmpdir(),'moved component'),engine=path.join(bundle,'engines/python/python.exe');
 assert.equal(mineruCandidates('',{KB_BUNDLE_ROOT:bundle})[0],engine);
 assert.equal(preferDiscoveredMineru(path.join(os.tmpdir(),'missing-build-machine/mineru.exe'),engine),engine);
});
test('portable database rebases presets and preserves credentials and user records on repeat launch',()=>{
 const root=fs.mkdtempSync(path.join(os.tmpdir(),'sf-bundle-')),data=path.join(root,'workspace/data');fs.mkdirSync(data,{recursive:true});const folder=path.join(root,'database/library/book');fs.mkdirSync(folder,{recursive:true});fs.writeFileSync(path.join(folder,'source.pdf'),'%PDF-1.4');fs.writeFileSync(path.join(folder,'document.json'),'{}');fs.writeFileSync(path.join(root,'database/manifest.json'),JSON.stringify({documents:[{id:'book',title:'preset',dirName:'book',sourceFile:'source.pdf'}]}));fs.writeFileSync(path.join(data,'settings.json'),JSON.stringify({llm:{apiKey:'fixture-secret'}}));fs.writeFileSync(path.join(data,'documents.json'),JSON.stringify([{id:'user'}]));
 try{assert.equal(initializeBundle(root,data).installed,1);const docs=JSON.parse(fs.readFileSync(path.join(data,'documents.json')));assert.equal(docs.length,2);assert.equal(docs[1].inputPath,path.join(folder,'source.pdf'));assert.equal(docs[1].status,'ready');assert.equal(initializeBundle(root,data).installed,0);assert.equal(JSON.parse(fs.readFileSync(path.join(data,'settings.json'))).llm.apiKey,'fixture-secret');}finally{fs.rmSync(root,{recursive:true,force:true});}
});
test('resource installation rejects incomplete or corrupted download before extracting',async()=>{
 const root=fs.mkdtempSync(path.join(os.tmpdir(),'sf-parts-'));const manifest={version:'99.0.0',parts:[{name:'part.zip',sha256:'bad'}],required:[]};fs.writeFileSync(path.join(root,'resources-manifest.json'),JSON.stringify(manifest));
 try{await assert.rejects(installBundle(root),/缺少完整套件/);fs.writeFileSync(path.join(root,'part.zip'),'broken');await assert.rejects(installBundle(root),/校验失败/);}finally{fs.rmSync(root,{recursive:true,force:true});}
});
test('moving the complete folder rebases stored paths without losing model credentials',()=>{
 const base=fs.mkdtempSync(path.join(os.tmpdir(),'sf-move-')),old=path.join(base,'old'),next=path.join(base,'new'),data=path.join(old,'workspace/data');fs.mkdirSync(data,{recursive:true});const library=path.join(old,'database/library/book');fs.mkdirSync(library,{recursive:true});fs.writeFileSync(path.join(library,'source.pdf'),'%PDF-1.4');fs.writeFileSync(path.join(old,'database/manifest.json'),JSON.stringify({documents:[{id:'book',dirName:'book',sourceFile:'source.pdf'}]}));fs.writeFileSync(path.join(data,'settings.json'),JSON.stringify({llm:{apiKey:'fixture-only'}}));
 try{initializeBundle(old,data);fs.cpSync(old,next,{recursive:true});initializeBundle(next,path.join(next,'workspace/data'));const settings=JSON.parse(fs.readFileSync(path.join(next,'workspace/data/settings.json'))),records=JSON.parse(fs.readFileSync(path.join(next,'workspace/data/documents.json')));assert.equal(settings.library,path.join(next,'database/library'));assert.equal(settings.llm.apiKey,'fixture-only');assert.equal(records[0].inputPath,path.join(next,'database/library/book/source.pdf'));}finally{fs.rmSync(base,{recursive:true,force:true});}
});

test('preset specifications appear in a default group without duplicating a user-named group',()=>{
 const root=fs.mkdtempSync(path.join(os.tmpdir(),'sf-preset-group-')),data=path.join(root,'workspace/data'),folder=path.join(root,'workspace/资料库/book');fs.mkdirSync(data,{recursive:true});fs.mkdirSync(folder,{recursive:true});fs.mkdirSync(path.join(root,'database'));
 try{fs.writeFileSync(path.join(folder,'source.pdf'),'%PDF-1.4');fs.writeFileSync(path.join(folder,'document.json'),'{}');fs.writeFileSync(path.join(data,'document-groups.json'),JSON.stringify([{id:'user-group',name:'施工验收规范'}]));fs.writeFileSync(path.join(root,'database/manifest.json'),JSON.stringify({library:'workspace/资料库',groups:[{id:'preset',name:'施工验收规范'}],documents:[{id:'book',title:'规范',dirName:'book',sourceFile:'source.pdf',groupId:'preset',status:'ready',pages:8}]}));
 initializeBundle(root,data);const records=JSON.parse(fs.readFileSync(path.join(data,'documents.json'))),groups=JSON.parse(fs.readFileSync(path.join(data,'document-groups.json')));assert.equal(records[0].status,'ready');assert.equal(records[0].pages,8);assert.equal(records[0].groupId,'user-group');assert.equal(groups.length,1);initializeBundle(root,data);assert.equal(JSON.parse(fs.readFileSync(path.join(data,'documents.json'))).length,1);
 }finally{fs.rmSync(root,{recursive:true,force:true});}
});
