"""GitHub-hosted, SHA256-checked reconstruction of release resource archives.

Only draft assets in the explicitly selected component release can be replaced.
No user settings, application secrets or conversations are inputs to this job.
"""
from pathlib import Path
import argparse,gzip,hashlib,json,os,subprocess,sys,time,urllib.request,urllib.parse,zipfile,http.client
parser=argparse.ArgumentParser();parser.add_argument('--repository',required=True);parser.add_argument('--release-id',type=int,required=True);parser.add_argument('--recipe-sha256',required=True);parser.add_argument('--delta-sha256',required=True);parser.add_argument('--codec-sha256',required=True);parser.add_argument('--output',type=Path,required=True);args=parser.parse_args();args.output.mkdir(parents=True,exist_ok=True)
token=os.environ['GH_TOKEN'];api='https://api.github.com/repos/'+args.repository
class UploadConnection(http.client.HTTPSConnection):
 def __init__(self,*positional,**keywords):super().__init__(*positional,blocksize=1024*1024,**keywords)
class UploadHandler(urllib.request.HTTPSHandler):
 def https_open(self,request):return self.do_open(UploadConnection,request,context=self._context)
def sha(file):
 with file.open('rb') as stream:return hashlib.file_digest(stream,'sha256').hexdigest()
def call(url,body=None,method=None):
 headers={'Authorization':'Bearer '+token,'Accept':'application/vnd.github+json','User-Agent':'SpecFlow-Resource-Builder','X-GitHub-Api-Version':'2022-11-28'}
 if body is not None:headers['Content-Type']='application/json'
 with urllib.request.urlopen(urllib.request.Request(url,data=json.dumps(body).encode() if body is not None else None,headers=headers,method=method),timeout=120) as r:
  raw=r.read();return json.loads(raw) if raw else None
def download(url,file,digest,private=False):
 if file.is_file() and sha(file)==digest:return
 headers={'User-Agent':'SpecFlow-Resource-Builder'}
 if private:headers.update({'Authorization':'Bearer '+token,'Accept':'application/octet-stream','X-GitHub-Api-Version':'2022-11-28'})
 for attempt in range(3):
  try:
   with urllib.request.urlopen(urllib.request.Request(url,headers=headers),timeout=180) as response,file.open('wb') as stream:
    while data:=response.read(1024*1024):stream.write(data)
   assert sha(file)==digest,file.name;print(json.dumps({'downloaded':file.name,'bytes':file.stat().st_size}),flush=True);return
  except Exception:
   if attempt==2:raise
   time.sleep(2)
release=call(api+'/releases/'+str(args.release_id));assert release['draft'] and release['tag_name']=='component-v1.3.2'
build_files=[('BUILD-132-recipe.json.gz',args.recipe_sha256),('BUILD-132-payloads.bin',args.delta_sha256),('BUILD-132-codec.zip',args.codec_sha256)]
for name,digest in build_files:
 asset=next(a for a in release['assets'] if a['name']==name);download(api+'/releases/assets/'+str(asset['id']),args.output/name,digest,True)
with gzip.open(args.output/'BUILD-132-recipe.json.gz','rt',encoding='utf8') as f:recipe=json.load(f)
assert recipe['version']=='1.3.2'
targets=[t for t in recipe['targets'] if not any(a['name']==t['name'] and a['state']=='uploaded' and a.get('digest')=='sha256:'+t['sha256'] for a in release['assets'])]
needed={s['source']['archive'] for t in targets for s in t['segments'] if 'source' in s}
base_dir=args.output/'base';base_dir.mkdir(exist_ok=True)
for part in recipe['base']:
 if part['name'] not in needed:continue
 assert part['url']=='https://github.com/'+args.repository+'/releases/download/component-v1.3.0/'+urllib.parse.quote(part['name'])
 download(part['url'],base_dir/part['name'],part['sha256'])
codec=args.output/'codec';codec.mkdir(exist_ok=True)
with zipfile.ZipFile(args.output/'BUILD-132-codec.zip') as z:
 for item in z.infolist():
  dest=(codec/item.filename).resolve();assert dest.is_relative_to(codec.resolve());z.extract(item,codec)
out=args.output/'reconstructed';out.mkdir(exist_ok=True)
if targets:
 command=[str(codec/'python.exe'),str(Path(__file__).with_name('reconstruct-resource-codec.py')),'--recipe',str(args.output/'BUILD-132-recipe.json.gz'),'--base-dir',str(base_dir),'--delta',str(args.output/'BUILD-132-payloads.bin'),'--output',str(out),'--names',*[t['name'] for t in targets]]
 subprocess.run(command,check=True,env={**os.environ,'PYTHONUTF8':'1'})
for target in targets:
 file=out/target['name'];assert sha(file)==target['sha256']
 current=call(api+'/releases/'+str(args.release_id));assert current['draft']
 existing=next((a for a in current['assets'] if a['name']==file.name),None)
 if existing:
  if existing['state']=='uploaded' and existing.get('digest')=='sha256:'+target['sha256']:continue
  call(api+'/releases/assets/'+str(existing['id']),method='DELETE')
 headers={'Authorization':'Bearer '+token,'Accept':'application/vnd.github+json','User-Agent':'SpecFlow-Resource-Builder','Content-Type':'application/octet-stream','Content-Length':str(file.stat().st_size)}
 url=current['upload_url'].split('{',1)[0]+'?'+urllib.parse.urlencode({'name':file.name})
 with file.open('rb') as data:
  with urllib.request.build_opener(UploadHandler()).open(urllib.request.Request(url,data=data,headers=headers,method='POST'),timeout=1800) as response:asset=json.load(response)
 assert asset['digest']=='sha256:'+target['sha256'];print(json.dumps({'uploaded':file.name,'bytes':file.stat().st_size}),flush=True)
current=call(api+'/releases/'+str(args.release_id))
for target in recipe['targets']:assert next(a for a in current['assets'] if a['name']==target['name'])['digest']=='sha256:'+target['sha256']
print(json.dumps({'resource_archives_verified':True,'release_id':args.release_id}),flush=True)
