"""Publish explicit engine/database bundles; never copy settings or conversations."""
from pathlib import Path
import argparse, csv, hashlib, io, json, os, sqlite3, zipfile, importlib.util

VERSION='1.3.2'
def write_json(path,value):
 path.parent.mkdir(parents=True,exist_ok=True);path.write_bytes((json.dumps(value,ensure_ascii=False,indent=2)+'\n').encode())
def sha(path):
 with path.open('rb') as file:return hashlib.file_digest(file,'sha256').hexdigest()
def archive(output,name,mapping,role,title):
 file=output/name
 with zipfile.ZipFile(file,'w',zipfile.ZIP_DEFLATED,compresslevel=3) as z:
  for target,source in sorted(mapping.items()):z.write(source,target)
 with zipfile.ZipFile(file) as z:
  assert z.testzip() is None
  assert all(not p.startswith('workspace/data/') for p in z.namelist())
 part={'name':name,'role':role,'title':title,'bytes':file.stat().st_size,'sha256':sha(file),'url':f'https://github.com/Maskicruis/fuyu-windfarm-digital-twin/releases/download/component-v{VERSION}/{name}'}
 print(json.dumps(part,ensure_ascii=False),flush=True);return part

def build(args):
 output=args.output;output.mkdir(parents=True,exist_ok=True);stage=output/'catalog';stage.mkdir(exist_ok=True)
 mapping={}
 def add(source,name):mapping[name]=source
 def allowed(file):
  n=file.name.lower()
  return file.is_file() and not {'__pycache__','test','tests','cmake','include'}.intersection(file.parts) and file.suffix not in ['.pyc','.pyo'] and n!='direct_url.json' and not(n.endswith('.dll') and ('clr0400' in n or n.startswith(('vcruntime140d','vcruntime140_1d','vcruntime140_threadsd','msvcp140d','msvcp140_1d','msvcp140_2d'))))
 for file in args.engine.rglob('*'):
  if allowed(file):add(file,'engines/'+file.relative_to(args.engine).as_posix())
 # The isolated validation runtime has binaries/models; retain the complete
 # provenance, license notices and frozen package inventory from the full bundle.
 for name in ['engine.json','packages.json','requirements-frozen.txt','compatibility-1.3.0.json']:
  file=args.metadata/name
  if file.is_file():add(file,'engines/'+name)
 for file in (args.metadata/'third-party-notices').rglob('*'):
  if file.is_file():add(file,'engines/third-party-notices/'+file.relative_to(args.metadata/'third-party-notices').as_posix())
 required_engine=['engines/python/python.exe','engines/python/python312._pth','engines/python/vcruntime140_threads.dll','engines/python/Lib/site-packages/torch/testing/__init__.py','engines/python/Lib/site-packages/fast_langdetect/ft_detect/resources/lid.176.ftz','engines/run_mineru.py']+[name for name in mapping if name.startswith('engines/models/')]
 assert all(name in mapping for name in required_engine),[n for n in required_engine if n not in mapping]
 parts=[archive(output,f'SpecFlow-{VERSION}-Parsing-Engine-Windows-x64.zip',mapping,'engine','离线解析引擎、运行库与模型')]
 records=json.loads((args.data/'documents.json').read_text('utf8'));settings=json.loads((args.data/'settings.json').read_text('utf8'));library=Path(settings['library']);mapping={};seeds=[];ready_ids=set()
 for record in records:
  source=args.originals/record['file'];assert source.is_file(),source
  folder=Path(record.get('outputDir',library/record['dirName']));prefix='workspace/资料库/'+record['dirName']+'/'
  add(source,prefix+record['title']+'.pdf')
  ready=record['status']=='ready' and (folder/'document.json').is_file()
  if ready:
   ready_ids.add(record['id'])
   for file in folder.rglob('*'):
    if not file.is_file():continue
    relative=file.relative_to(folder)
    if relative.parts[0]=='images' or relative.as_posix() in ['document.json','view.json','raw.mineru.md',record['title']+'.md']:add(file,prefix+relative.as_posix())
  keep=['id','title','dirName','file','createdAt','updatedAt','parserOptions']
  seed={k:record[k] for k in keep if k in record};seed.update({'sourceFile':record['title']+'.pdf','status':'ready' if ready else 'queued','groupId':'grp_preset_construction_acceptance'})
  if ready:
   for key in ['pages','chars','items','images','parser']:
    if key in record:seed[key]=record[key]
  seeds.append(seed)
 manifest={'version':VERSION,'library':'workspace/资料库','groups':[{'id':'grp_preset_construction_acceptance','name':'施工验收规范'}],'documents':seeds,'counts':{'total':len(seeds),'indexed':len(ready_ids)},'license':'Original publication rights retained; project MIT license does not relicense standards or models.'}
 assert len(seeds)==71
 write_json(stage/'database-manifest.json',manifest);add(stage/'database-manifest.json','database/manifest.json')
 catalog=io.StringIO(newline='');writer=csv.writer(catalog);writer.writerow(['序号','文件名','默认预置状态','页数','原件大小MB','分组'])
 for n,seed in enumerate(seeds,1):writer.writerow([n,seed['file'],'已预解析，可检索' if seed['status']=='ready' else '原件已预置，首次后台OCR',seed.get('pages',''),round((args.originals/seed['file']).stat().st_size/1024/1024,2),'施工验收规范'])
 (stage/'施工验收规范目录.csv').write_bytes(catalog.getvalue().encode('utf8'));add(stage/'施工验收规范目录.csv','database/施工验收规范目录.csv')
 index=stage/'search-index.sqlite'
 source=sqlite3.connect(library/'.search-index.sqlite');target=sqlite3.connect(index)
 try:source.backup(target)
 finally:target.close();source.close()
 db=sqlite3.connect(index)
 try:
  for (id,) in db.execute('SELECT id FROM docs').fetchall():
   if id not in ready_ids:
    db.execute('DELETE FROM terms WHERE docId=?',(id,));db.execute('DELETE FROM entries WHERE docId=?',(id,));db.execute('DELETE FROM docs WHERE id=?',(id,))
  for id,meta in db.execute('SELECT id,meta FROM docs').fetchall():
   item=json.loads(meta);seed=next(s for s in seeds if s['id']==id);item['dir']=seed['dirName'];db.execute('UPDATE docs SET meta=? WHERE id=?',(json.dumps(item,ensure_ascii=False),id))
  assert db.execute('SELECT count(*) FROM docs').fetchone()[0]==len(ready_ids)
  db.commit();db.execute('PRAGMA wal_checkpoint(TRUNCATE)')
 finally:db.close()
 add(index,'workspace/资料库/.search-index.sqlite')
 groups=[];group={};size=0
 for name,source in sorted(mapping.items()):
  if group and size+source.stat().st_size>1300*1024**2:groups.append(group);group={};size=0
  group[name]=source;size+=source.stat().st_size
 if group:groups.append(group)
 for number,group in enumerate(groups,1):parts.append(archive(output,f'SpecFlow-{VERSION}-Default-Database-{number:02}.zip',group,'database',f'默认施工验收规范数据库 {number}/{len(groups)}'))
 required=required_engine+['database/manifest.json','database/施工验收规范目录.csv','workspace/资料库/.search-index.sqlite']+['workspace/资料库/'+s['dirName']+'/'+s['sourceFile'] for s in seeds]
 resources={'version':VERSION,'parts':parts,'required':required,'presetCounts':manifest['counts']}
 write_json(output/'resources-manifest.json',resources)
 print(json.dumps({'complete':True,'documents':len(seeds),'indexed':len(ready_ids),'parts':len(parts),'bytes':sum(p['bytes'] for p in parts)},ensure_ascii=False),flush=True)

if __name__=='__main__':
 parser=argparse.ArgumentParser();parser.add_argument('--engine',type=Path,required=True);parser.add_argument('--metadata',type=Path,required=True);parser.add_argument('--data',type=Path,required=True);parser.add_argument('--originals',type=Path,required=True);parser.add_argument('--output',type=Path,required=True);build(parser.parse_args())
