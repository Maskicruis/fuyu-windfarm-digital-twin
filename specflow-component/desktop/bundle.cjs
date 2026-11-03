'use strict';
const fs=require('node:fs'),path=require('node:path');
const {readJson,writeJson}=require('../src/utils');
// Release data is relative to the portable EXE, never to the build computer.
function initializeBundle(root,data){
 const manifest=readJson(path.join(root,'database','manifest.json'));
 if(!manifest)return {installed:0};
 const locationFile=path.join(data,'bundle-location.json'),previous=readJson(locationFile);
 if(previous?.root&&previous.root!==root){
  const rebase=value=>typeof value==='string'&&(value===previous.root||value.startsWith(previous.root+path.sep))?path.join(root,path.relative(previous.root,value)):value;
  const oldSettings=readJson(path.join(data,'settings.json'),{});for(const key of ['library','mineru'])if(oldSettings[key])oldSettings[key]=rebase(oldSettings[key]);writeJson(path.join(data,'settings.json'),oldSettings);
  const oldRecords=readJson(path.join(data,'documents.json'),[]);for(const record of oldRecords)for(const key of ['outputDir','inputPath','sourcePath'])if(record[key])record[key]=rebase(record[key]);writeJson(path.join(data,'documents.json'),oldRecords);
 }
 const recordsFile=path.join(data,'documents.json'),settingsFile=path.join(data,'settings.json');
 const records=readJson(recordsFile,[]),existing=new Set(records.map(d=>d.id));
 const groupsFile=path.join(data,'document-groups.json'),groups=readJson(groupsFile,[]),groupMap=new Map();let groupsChanged=false;
 for(const seed of manifest.groups||[]){let group=groups.find(g=>g.id===seed.id||g.name===seed.name);if(!group){group={...seed,createdAt:new Date().toISOString(),updatedAt:new Date().toISOString()};groups.push(group);groupsChanged=true;}groupMap.set(seed.id,group.id);}
 if(groupsChanged)writeJson(groupsFile,groups);
 const library=path.resolve(root,manifest.library||'database/library');if(!library.startsWith(path.resolve(root)+path.sep))throw Error('预置资料库目录无效');let installed=0;
 for(const seed of manifest.documents||[]){
  if(existing.has(seed.id)){
   const record=records.find(d=>d.id===seed.id);
   if(record.status!=='ready'&&seed.status==='ready'&&fs.existsSync(path.join(record.outputDir||path.join(library,seed.dirName),'document.json'))){for(const key of ['pages','chars','images','items','parser'])if(seed[key]!=null)record[key]=seed[key];Object.assign(record,{status:'ready',progress:100,progressText:'预置索引就绪',error:''});writeJson(recordsFile,records);}
   continue;
  }
  // Only direct children of the bundled library can be selected by a manifest.
  if(!seed.dirName||path.basename(seed.dirName)!==seed.dirName)throw Error('预置资料目录无效');
  const outputDir=path.join(library,seed.dirName),inputPath=path.join(outputDir,seed.sourceFile);
  if(path.dirname(inputPath)!==outputDir||!fs.existsSync(inputPath))throw Error('预置规范原件缺失：'+seed.title);
  records.push({...seed,groupId:groupMap.get(seed.groupId)||seed.groupId||'',outputDir,inputPath,status:fs.existsSync(path.join(outputDir,'document.json'))?'ready':'queued',progressText:'随包预置资料',parseStage:'ocr',fastPassVersion:'1.1.0'});installed++;
 }
 // Preserve keys, conversations and user paths during upgrades. The new library
 // is used on first launch; additional seeds on a custom library are copied.
 const settings=readJson(settingsFile,{});
 if(settings.library&&path.resolve(settings.library)!==path.resolve(library)&&installed){
  for(const record of records.slice(-installed)){const target=path.join(settings.library,record.dirName);if(!fs.existsSync(target))fs.cpSync(record.outputDir,target,{recursive:true});record.outputDir=target;record.inputPath=path.join(target,record.sourceFile);}
 }else if(!settings.library){settings.library=library;writeJson(settingsFile,settings);}
 if(installed)writeJson(recordsFile,records);
 writeJson(locationFile,{root,version:manifest.version});
 return {installed,total:manifest.documents.length};
}
module.exports={initializeBundle};
