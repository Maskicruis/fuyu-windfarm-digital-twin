"""Fresh Windows deployment from EXE + four supplied ZIPs; no previous library.

The ZIPs are hard-linked on the same local NTFS volume only to avoid a second
download-sized copy. Every installed engine/model/database file is extracted by
the EXE itself. --offline-resources makes any missing resource a hard failure.
"""
from pathlib import Path
import argparse, hashlib, json, os, subprocess, time, urllib.request, urllib.parse, shutil

parser=argparse.ArgumentParser();parser.add_argument('--package-dir',type=Path,required=True);parser.add_argument('--output',type=Path,required=True);parser.add_argument('--extra-pdf',type=Path,required=True);args=parser.parse_args()
area=args.output.resolve();area.mkdir(parents=True,exist_ok=True)
assert not (area/'workspace').exists(),'Use a completely fresh output folder'
manifest=json.loads((args.package_dir/'resources-manifest.json').read_text('utf8'))
for part in manifest['parts']:os.link(args.package_dir/part['name'],area/part['name'])
exe=area/'SpecFlow-Knowledge-Component-1.3.2-x64.exe';shutil.copy2(args.package_dir/exe.name,exe)
env={k:v for k,v in os.environ.items() if not k.startswith('KB_') and k!='PORTABLE_EXECUTABLE_DIR'}
env.update({'HTTP_PROXY':'http://127.0.0.1:9','HTTPS_PROXY':'http://127.0.0.1:9','NO_PROXY':'127.0.0.1,localhost,::1','no_proxy':'127.0.0.1,localhost,::1','HF_HUB_OFFLINE':'1','TRANSFORMERS_OFFLINE':'1'})
client=urllib.request.build_opener(urllib.request.ProxyHandler({}));process=None;record=area/'workspace/data/component-service.json';started=time.monotonic()
def request(path,body=None,headers=None):
 req=urllib.request.Request(base+path,data=json.dumps(body,ensure_ascii=False).encode() if body is not None else None,headers=headers or ({'Content-Type':'application/json'} if body is not None else {}))
 with client.open(req,timeout=40) as response:return json.load(response)['data']
try:
 with (area/'launch.log').open('wb') as log:process=subprocess.Popen([str(exe),'--background','--offline-resources','--port','0'],stdout=log,stderr=subprocess.STDOUT,env=env)
 deadline=time.monotonic()+1200;last=0
 while not record.is_file():
  error=area/'workspace/data/desktop-error.log'
  if error.is_file():raise RuntimeError(error.read_text('utf8',errors='replace'))
  if process.poll() is not None:raise RuntimeError('EXE exited before completing offline installation')
  if time.monotonic()>deadline:raise TimeoutError('Offline installation exceeded 20 minutes')
  if time.monotonic()-last>15:print(json.dumps({'phase':'installing supplied resources','elapsed_seconds':round(time.monotonic()-started)}),flush=True);last=time.monotonic()
  time.sleep(1)
 info=json.loads(record.read_text('utf8'));base='http://127.0.0.1:'+str(info['port']);health=request('/api/v1/health')
 assert health['version']=='1.3.2' and health['mineru']['bundled'] and health['mineru']['available']
 docs=request('/api/v1/documents')['items'];assert len(docs)==71
 groups=request('/api/v1/groups')['items'];group=next(g for g in groups if g['name']=='施工验收规范');assert group['documentCount']==71
 assert not health['llm']['hasKey'] and health['conversations']==0
 raw=json.loads((area/'workspace/data/documents.json').read_text('utf8'))
 for d in raw:
  with Path(d['inputPath']).open('rb') as source:assert source.read(5)==b'%PDF-'
 for _ in range(120):
  health=request('/api/v1/health')
  if health['index']['ready'] and health['index']['documents']>=manifest['presetCounts']['indexed']:break
  time.sleep(1)
 assert health['index']['documents']>=manifest['presetCounts']['indexed'],health['index']
 query_started=time.monotonic();hits=request('/api/v1/search?q='+urllib.parse.quote('混凝土养护'))['hits'];search_ms=round((time.monotonic()-query_started)*1000);assert hits and hits[0]['bboxNormalized']
 extra_group=request('/api/v1/groups',{'name':'用户新增资料'})
 upload=urllib.request.Request(base+'/api/v1/jobs',data=args.extra_pdf.read_bytes(),headers={'Content-Type':'application/pdf','X-File-Name':'user-added-material.pdf','X-Group-Id':extra_group['id']})
 with client.open(upload,timeout=40) as response:uploaded=json.load(response)['data']
 id=uploaded.get('id') or uploaded['job']['id']
 for _ in range(120):
  job=request('/api/v1/jobs/'+id)['job']
  if job['status'] in ['ready','error']:break
  time.sleep(1)
 assert job['status']=='ready',job
 assert len(request('/api/v1/documents')['items'])==72
 assert next(g for g in request('/api/v1/groups')['items'] if g['id']==group['id'])['documentCount']==71
 # Confirm actual bundled OCR, not just a Python import or a developer cache.
 checkpoint=0;deadline=time.monotonic()+600
 while time.monotonic()<deadline:
  rows=request('/api/v1/documents')['items'];checkpoint=max((r.get('parserActivity',{}).get('checkpointPages',0) for r in rows),default=0)
  if checkpoint>=8:break
  errors=[r for r in rows if r['status']=='error'];assert not errors,errors
  time.sleep(2)
 assert checkpoint>=8,'Bundled OCR did not save a real processing-window checkpoint'
 code="import sys,json,importlib.metadata;import torch,mineru,fast_langdetect,pypdfium2;print(json.dumps({'python':sys.version.split()[0],'torch':torch.__version__,'mineru':importlib.metadata.version('mineru'),'paths':sys.path}))"
 result=subprocess.run([str(area/'engines/python/python.exe'),'-c',code],capture_output=True,text=True,encoding='utf8',env=env,check=True)
 runtime=json.loads(result.stdout.strip().splitlines()[-1]);assert all(str(area/'engines/python').lower() in p.lower() for p in runtime['paths'])
 proof={'passed':True,'version':'1.3.2','empty_directory_before_start':True,'no_network_resource_download':True,'original_pdfs':71,'default_group_count':71,'preindexed_documents':manifest['presetCounts']['indexed'],'search_hits':len(hits),'search_ms':search_ms,'positioned_hits':True,'extra_import_ready':True,'documents_after_import':72,'default_database_preserved_after_import':True,'bundled_ocr_checkpoint_pages':checkpoint,'clean_settings_and_conversations':True,'runtime':{k:v for k,v in runtime.items() if k!='paths'},'elapsed_seconds':round(time.monotonic()-started,1),'exe_sha256':hashlib.sha256(exe.read_bytes()).hexdigest()}
 (area/'proof.json').write_text(json.dumps(proof,ensure_ascii=False,indent=2),encoding='utf8');print(json.dumps(proof,ensure_ascii=False),flush=True)
finally:
 if process is not None and process.poll() is None:
  subprocess.run(['taskkill','/PID',str(process.pid),'/T','/F'],stdout=subprocess.DEVNULL,stderr=subprocess.DEVNULL)
  process.wait(timeout=30)
