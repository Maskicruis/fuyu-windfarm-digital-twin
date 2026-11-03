"""Build portable offline runtime and sanitized preset database. No credentials/history."""
from pathlib import Path
import argparse,hashlib,json,os,shutil,sqlite3,urllib.request,zipfile,importlib.metadata,subprocess
from concurrent.futures import ThreadPoolExecutor

def write_json(p,value):
 p.parent.mkdir(parents=True,exist_ok=True);p.write_bytes((json.dumps(value,ensure_ascii=False,indent=2)+'\n').encode())
def native_runtime_part(release):
 if os.name!='nt':return None
 system=Path(os.environ['SystemRoot'])/'System32';files=[*system.glob('vcruntime140*.dll'),*system.glob('msvcp140*.dll'),system/'concrt140.dll',system/'vccorlib140.dll'];files=[p for p in files if p.exists()]
 if not any(p.name.lower()=='vcruntime140_threads.dll' for p in files):raise RuntimeError('The build machine needs the current Microsoft VC runtime, including vcruntime140_threads.dll')
 file=release/'SpecFlow-1.3.0-Resources-Native.zip'
 with zipfile.ZipFile(file,'w',zipfile.ZIP_DEFLATED,compresslevel=3) as z:
  for p in files:z.write(p,'engines/python/'+p.name)
  z.writestr('engines/native-runtime.json',json.dumps({'component':'Microsoft Visual C++ application-local runtime','license':'https://visualstudio.microsoft.com/license-terms/vs2022-cruntime/','copyright':'Microsoft Corporation','files':[p.name for p in files]},indent=2))
 return {'name':file.name,'bytes':file.stat().st_size,'sha256':hashlib.sha256(file.read_bytes()).hexdigest(),'url':'https://github.com/Maskicruis/fuyu-windfarm-digital-twin/releases/download/component-v1.3.0/'+file.name}
def build_engine(source,models,target,embed):
 target.mkdir(parents=True,exist_ok=True);python=target/'python';python.mkdir(exist_ok=True)
 if not embed.exists():urllib.request.urlretrieve('https://www.python.org/ftp/python/3.12.7/python-3.12.7-embed-amd64.zip',embed)
 with zipfile.ZipFile(embed) as z:
  assert z.testzip() is None;z.extractall(python)
 (python/'python312._pth').write_bytes(b'python312.zip\n.\nLib/site-packages\n')
 package_source=source/'Lib/site-packages';package_target=python/'Lib/site-packages'
 excluded={'__pycache__','tests','test','include','cmake'}
 files=[p for p in package_source.rglob('*') if not excluded.intersection(p.relative_to(package_source).parts) and p.is_file() and p.suffix not in ['.pyc','.pyo'] and p.name!='direct_url.json']
 def copy(p):
  target=package_target/p.relative_to(package_source);target.parent.mkdir(parents=True,exist_ok=True)
  if not target.exists() or target.stat().st_size!=p.stat().st_size or target.stat().st_mtime_ns!=p.stat().st_mtime_ns:shutil.copy2(p,target)
 if os.name=='nt':
  result=subprocess.run(['robocopy',str(package_source),str(package_target),'/E','/MT:32','/R:1','/W:1','/NP','/NFL','/NDL','/XD',*sorted(excluded),'/XF','*.pyc','*.pyo','direct_url.json'],stdout=subprocess.PIPE,stderr=subprocess.STDOUT)
  if result.returncode>=8:raise RuntimeError('Runtime copy failed: '+result.stdout.decode(errors='replace')[-2000:])
 else:
  with ThreadPoolExecutor(max_workers=16) as executor:list(executor.map(copy,files))
 print(json.dumps({'engine_packages_copied':len(files)}),flush=True)
 shutil.copytree(models,target/'models',dirs_exist_ok=True,ignore=shutil.ignore_patterns('.cache','.git'))
 shutil.copy2(Path(__file__).resolve().parent.parent/'specflow-component/engines/run_mineru.py',target/'run_mineru.py')
 packages=[]
 for dist in importlib.metadata.distributions(path=[str(source/'Lib/site-packages')]):
  packages.append({'name':dist.metadata['Name'],'version':dist.version,'license':dist.metadata.get('License-Expression') or dist.metadata.get('License',''),'homepage':dist.metadata.get('Home-page','')})
 write_json(target/'packages.json',sorted(packages,key=lambda p:p['name'].lower()))
 (target/'requirements-frozen.txt').write_text('\n'.join(p['name']+'=='+p['version'] for p in sorted(packages,key=lambda p:p['name'].lower()))+'\n',encoding='utf8')
 write_json(target/'engine.json',{'mineru':'3.4.5','python':'3.12.7','architecture':'win-x64','device':'cpu','formula':False,'table':True,'python_embed_sha256':hashlib.sha256(embed.read_bytes()).hexdigest(),'python_source':'https://www.python.org/ftp/python/3.12.7/','model_source':'https://huggingface.co/opendatalab/PDF-Extract-Kit-1.0','models':'bundled, local-only','licenses':'python/license.txt and Python Lib/site-packages/*dist-info/licenses'})
def build_database(data,target):
 records=json.loads((data/'documents.json').read_text('utf8'));settings=json.loads((data/'settings.json').read_text('utf8'));library=Path(settings['library']);dest=target/'library';dest.mkdir(parents=True,exist_ok=True);seeds=[]
 for record in records:
  original=Path(record.get('inputPath',''));current=Path(record.get('outputDir',library/record['dirName']));folder=dest/record['dirName'];folder.mkdir(exist_ok=True)
  if not original.is_file():original=next(current.glob('*.pdf'))
  name=record['title']+'.pdf';shutil.copy2(original,folder/name)
  ready=record['status']=='ready' and (current/'document.json').exists()
  if ready:
   for p in current.iterdir():
    if p.suffix.lower()=='.pdf':continue
    if p.is_dir() and p.name=='images':shutil.copytree(p,folder/p.name,dirs_exist_ok=True)
    elif p.is_file():shutil.copy2(p,folder/p.name)
  seeds.append({k:record[k] for k in ['id','title','dirName','file','createdAt','updatedAt','parserOptions'] if k in record}|{'sourceFile':name,'status':'ready' if ready else 'queued','groupId':''})
  print(json.dumps({'preset':len(seeds),'total':len(records),'ready':ready}),flush=True)
 # SQLite online backup creates a consistent snapshot while the original runs.
 source=library/'.search-index.sqlite'
 if source.exists():
  with sqlite3.connect(source) as a,sqlite3.connect(dest/'.search-index.sqlite') as b:a.backup(b)
 write_json(target/'manifest.json',{'version':'1.3.0','documents':seeds,'counts':{'total':len(seeds),'indexed':sum(d['status']=='ready' for d in seeds)},'origin':'User-provided construction acceptance specifications','license':'Standards retain their original publication rights; project MIT license does not relicense their content.'})
def archives(root,release):
 excluded={'__pycache__','tests','test','include','cmake'}
 files=[p for folder in ['engines','database'] for p in (root/folder).rglob('*') if not excluded.intersection(p.relative_to(root).parts) and p.is_file() and p.name not in ['.search-index.sqlite-wal','.search-index.sqlite-shm','direct_url.json']];groups=[];group=[];size=0
 for p in sorted(files):
  if group and size+p.stat().st_size>550*1024**2:groups.append(group);group=[];size=0
  group.append(p);size+=p.stat().st_size
 if group:groups.append(group)
 parts=[]
 for i,group in enumerate(groups,1):
  file=release/f'SpecFlow-1.3.0-Resources-{i:02}.zip'
  with zipfile.ZipFile(file,'w',zipfile.ZIP_DEFLATED,compresslevel=3) as z:
   for p in group:z.write(p,p.relative_to(root).as_posix())
  with zipfile.ZipFile(file) as z:assert z.testzip() is None
  parts.append({'name':file.name,'bytes':file.stat().st_size,'sha256':hashlib.sha256(file.read_bytes()).hexdigest(),'url':'https://github.com/Maskicruis/fuyu-windfarm-digital-twin/releases/download/component-v1.3.0/'+file.name});print(json.dumps(parts[-1]),flush=True)
 required=['engines/python/python.exe','engines/run_mineru.py','engines/models/models/Layout/PP-DocLayoutV2/model.safetensors','database/manifest.json']
 native=native_runtime_part(release)
 if native:parts.append(native);required.append('engines/python/vcruntime140_threads.dll')
 manifest={'version':'1.3.0','parts':parts,'required':required};write_json(release/'resources-manifest.json',manifest);write_json(root/'resources-manifest.json',manifest)
 # A materialized local folder can launch immediately. Downloaded archives install automatically.
 write_json(root/'resources-installed.json',{'version':'1.3.0','prepared':True})
 return manifest
def direct_distribution(data,engine,venv,models,release,originals=None):
 """Stream large originals into archives without duplicating them on a USB disk."""
 release.mkdir(parents=True,exist_ok=True);mapping={};stage=release/'catalog';stage.mkdir(exist_ok=True)
 def add(source,name):mapping[name]=Path(source)
 for p in (engine/'python').iterdir():
  if p.is_file():add(p,'engines/python/'+p.name)
 for p in (venv/'Lib/site-packages').rglob('*'):
  relative=p.relative_to(venv/'Lib/site-packages')
  if not {'__pycache__','tests','test','include','cmake'}.intersection(relative.parts) and p.is_file() and p.suffix not in ['.pyc','.pyo'] and p.name!='direct_url.json':add(p,'engines/python/Lib/site-packages/'+relative.as_posix())
 for p in models.rglob('*'):
  if p.is_file():add(p,'engines/models/'+p.relative_to(models).as_posix())
 for name in ['engine.json','packages.json','requirements-frozen.txt']:
  if (engine/name).exists():add(engine/name,'engines/'+name)
 for p in (engine/'third-party-notices').rglob('*'):
  if p.is_file():add(p,'engines/third-party-notices/'+p.relative_to(engine/'third-party-notices').as_posix())
 add(Path(__file__).resolve().parent.parent/'specflow-component/engines/run_mineru.py','engines/run_mineru.py')
 records=json.loads((data/'documents.json').read_text('utf8'));settings=json.loads((data/'settings.json').read_text('utf8'));library=Path(settings['library']);seeds=[]
 for record in records:
  folder=Path(record.get('outputDir',library/record['dirName']));original=originals/record['file'] if originals else Path(record.get('inputPath',''))
  if not original.is_file():original=next(folder.glob('*.pdf'))
  name=record['title']+'.pdf';prefix='workspace/资料库/'+record['dirName']+'/'
  add(original,prefix+name);ready=record['status']=='ready' and (folder/'document.json').exists()
  if ready:
   for p in folder.rglob('*'):
    if p.is_file() and p.suffix.lower()!='.pdf':add(p,prefix+p.relative_to(folder).as_posix())
  seeds.append({k:record[k] for k in ['id','title','dirName','file','createdAt','updatedAt','parserOptions'] if k in record}|{'sourceFile':name,'status':'ready' if ready else 'queued','groupId':''})
 manifest_file=stage/'database-manifest.json';write_json(manifest_file,{'version':'1.3.0','library':'workspace/资料库','documents':seeds,'counts':{'total':len(seeds),'indexed':sum(s['status']=='ready' for s in seeds)},'license':'Original publication rights retained; not relicensed under project MIT.'});add(manifest_file,'database/manifest.json')
 index=stage/'search-index.sqlite'
 with sqlite3.connect(library/'.search-index.sqlite') as source,sqlite3.connect(index) as dest:source.backup(dest)
 add(index,'workspace/资料库/.search-index.sqlite')
 groups=[];group=[];size=0
 for name,source in sorted(mapping.items()):
  if group and size+source.stat().st_size>550*1024**2:groups.append(group);group=[];size=0
  group.append((name,source));size+=source.stat().st_size
 if group:groups.append(group)
 parts=[]
 for i,group in enumerate(groups,1):
  file=release/f'SpecFlow-1.3.0-Resources-{i:02}.zip'
  with zipfile.ZipFile(file,'w',zipfile.ZIP_DEFLATED,compresslevel=3) as z:
   for name,source in group:z.write(source,name)
  with zipfile.ZipFile(file) as z:assert z.testzip() is None
  h=hashlib.file_digest(file.open('rb'),'sha256').hexdigest()
  part={'name':file.name,'bytes':file.stat().st_size,'sha256':h,'url':'https://github.com/Maskicruis/fuyu-windfarm-digital-twin/releases/download/component-v1.3.0/'+file.name};parts.append(part);print(json.dumps(part),flush=True)
 native=native_runtime_part(release)
 if native:parts.append(native)
 manifest={'version':'1.3.0','parts':parts,'required':['engines/python/python.exe','engines/python/Lib/site-packages/torch/testing/__init__.py','engines/run_mineru.py','engines/python/vcruntime140_threads.dll','engines/models/models/Layout/PP-DocLayoutV2/model.safetensors','database/manifest.json']};write_json(release/'resources-manifest.json',manifest)
 print(json.dumps({'complete':True,'documents':len(seeds),'indexed':sum(s['status']=='ready' for s in seeds),'files':len(mapping)}),flush=True)
if __name__=='__main__':
 p=argparse.ArgumentParser();p.add_argument('--output',type=Path,required=True);p.add_argument('--release',type=Path,required=True);p.add_argument('--venv',type=Path);p.add_argument('--models',type=Path);p.add_argument('--data',type=Path);p.add_argument('--originals',type=Path);p.add_argument('--archives-only',action='store_true');p.add_argument('--direct',action='store_true');a=p.parse_args();a.release.mkdir(parents=True,exist_ok=True)
 if a.direct:direct_distribution(a.data,a.output/'engines',a.venv,a.models,a.release,a.originals);raise SystemExit(0)
 if not a.archives_only:
  build_engine(a.venv,a.models,a.output/'engines',a.release/'python-3.12.7-embed-amd64.zip');build_database(a.data,a.output/'database')
 archives(a.output,a.release)
