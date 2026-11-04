"""Copy public, immutable 1.3.2 seed assets into the explicitly selected draft."""
from pathlib import Path
import argparse,hashlib,http.client,json,os,re,tempfile,time,urllib.request,urllib.parse
from concurrent.futures import ThreadPoolExecutor
p=argparse.ArgumentParser();p.add_argument('--release-id',type=int,required=True);p.add_argument('--repository',required=True);a=p.parse_args()
assert a.repository=='Maskicruis/fuyu-windfarm-digital-twin'
api='https://api.github.com/repos/'+a.repository;token=os.environ['GH_TOKEN']
def call(url,method=None):
    with urllib.request.urlopen(urllib.request.Request(url,headers={'Authorization':'Bearer '+token,'Accept':'application/vnd.github+json','User-Agent':'SpecFlow-Release-Resources'},method=method),timeout=90) as response:
        raw=response.read();return json.loads(raw) if raw else None
release=call(api+'/releases/'+str(a.release_id));assert release['draft'] and re.fullmatch(r'component-v\d+\.\d+\.\d+',release['tag_name'])
manifest=json.loads((Path(__file__).resolve().parent.parent/'specflow-component/resources-manifest.json').read_text('utf8'))
class LargeConnection(http.client.HTTPSConnection):
    def __init__(self,*args,**kwargs):super().__init__(*args,blocksize=1024*1024,**kwargs)
class LargeHandler(urllib.request.HTTPSHandler):
    def https_open(self,request):return self.do_open(LargeConnection,request,context=self._context)
def copy(part):
    existing=next((x for x in release['assets'] if x['name']==part['name']),None)
    if existing:
        assert existing['digest']=='sha256:'+part['sha256'];return
    with tempfile.TemporaryDirectory() as directory:
        file=Path(directory)/part['name'];url='https://github.com/'+a.repository+'/releases/download/component-v1.3.3/'+part['name']
        for attempt in range(3):
            try:
                with urllib.request.urlopen(url,timeout=180) as response,file.open('wb') as output:
                    while chunk:=response.read(1024*1024):output.write(chunk)
                with file.open('rb') as stream:assert hashlib.file_digest(stream,'sha256').hexdigest()==part['sha256']
                assert file.stat().st_size==part['bytes'];break
            except Exception:
                if attempt==2:raise
                time.sleep(2)
        assert call(api+'/releases/'+str(a.release_id))['draft']
        headers={'Authorization':'Bearer '+token,'Content-Type':'application/octet-stream','Content-Length':str(file.stat().st_size),'User-Agent':'SpecFlow-Release-Resources'}
        with file.open('rb') as stream,urllib.request.build_opener(LargeHandler()).open(urllib.request.Request(release['upload_url'].split('{')[0]+'?'+urllib.parse.urlencode({'name':file.name}),data=stream,headers=headers,method='POST'),timeout=1800) as response:asset=json.load(response)
        assert asset['digest']=='sha256:'+part['sha256'];print(json.dumps({'copied_verified':file.name,'bytes':file.stat().st_size}),flush=True)
with ThreadPoolExecutor(max_workers=2) as executor:list(executor.map(copy,manifest['parts']))
print(json.dumps({'base_resources_complete':True,'release_id':a.release_id}),flush=True)
