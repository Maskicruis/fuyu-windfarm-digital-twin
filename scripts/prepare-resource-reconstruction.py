"""Describe exact release ZIP bytes using existing GitHub assets + small delta.

This avoids re-uploading gigabytes of unchanged standards over a slow upstream.
Headers and compressed-member digests make reconstruction byte-for-byte checked.
"""
from pathlib import Path
import argparse,base64,gzip,hashlib,json,struct,sys,zipfile,zlib

def sha(file):
 with file.open('rb') as stream:return hashlib.file_digest(stream,'sha256').hexdigest()
def payload_offset(z,file):
 z.fp.seek(file.header_offset);header=z.fp.read(30);a,b=struct.unpack_from('<HH',header,26);return file.header_offset+30+a+b
def chunks(stream,length):
 while length:
  data=stream.read(min(length,1024*1024))
  if not data:raise EOFError('Truncated archive')
  length-=len(data);yield data
parser=argparse.ArgumentParser();parser.add_argument('--base-dir',type=Path,required=True);parser.add_argument('--base-manifest',type=Path,required=True);parser.add_argument('--package-dir',type=Path,required=True);parser.add_argument('--output',type=Path,required=True);args=parser.parse_args();args.output.mkdir(parents=True,exist_ok=True)
base=json.loads(args.base_manifest.read_text('utf8'));manifest=json.loads((args.package_dir/'resources-manifest.json').read_text('utf8'));available={};base_zips=[]
for part in base['parts']:
 z=zipfile.ZipFile(args.base_dir/part['name']);base_zips.append(z)
 for info in z.infolist():available.setdefault((info.filename,info.CRC,info.file_size),[]).append((part['name'],info,payload_offset(z,info)))
delta=args.output/'BUILD-132-payloads.bin';targets=[];reused=0;new_bytes=0
with delta.open('wb') as output:
 for part in manifest['parts']:
  segments=[];last=0;file=args.package_dir/part['name']
  with zipfile.ZipFile(file) as archive,file.open('rb') as stream:
   for info in sorted(archive.infolist(),key=lambda i:i.header_offset):
    start=payload_offset(archive,info);stream.seek(last);prefix=stream.read(start-last);segment={'prefix':base64.b64encode(prefix).decode(),'length':info.compress_size,'member':info.filename}
    candidates=available.get((info.filename,info.CRC,info.file_size),[])
    if candidates:
     name,old,old_start=next((c for c in reversed(candidates) if c[1].compress_size==info.compress_size),candidates[-1]);recompress='Default-Database-01' in part['name'] or old.compress_size!=info.compress_size
     segment['source']={'archive':name,'member':old.filename,'offset':old_start,'length':old.compress_size,'method':'recompress' if recompress else 'copy','level':6 if 'Default-Database-01' in part['name'] else 3};reused+=info.compress_size
    else:segment['deltaOffset']=output.tell();new_bytes+=info.compress_size
    stream.seek(start);h=hashlib.sha256()
    for block in chunks(stream,info.compress_size):
     h.update(block)
     if not candidates:output.write(block)
    segment['sha256']=h.hexdigest();segments.append(segment);last=start+info.compress_size
   stream.seek(last);tail=stream.read()
  targets.append({**part,'segments':segments,'tail':base64.b64encode(tail).decode()})
for z in base_zips:z.close()
recipe={'version':'1.3.2','base':base['parts'],'targets':targets,'delta':{'name':delta.name,'bytes':delta.stat().st_size,'sha256':sha(delta)},'zlib':zlib.ZLIB_RUNTIME_VERSION}
file=args.output/'BUILD-132-recipe.json.gz'
with gzip.open(file,'wt',encoding='utf8') as stream:json.dump(recipe,stream,ensure_ascii=False,separators=(',',':'))
# The exact codec is small and has no site-packages or user configuration.
runtime=Path(sys.executable).parent;stdlib=args.output/'python312.zip'
with zipfile.ZipFile(stdlib,'w',zipfile.ZIP_DEFLATED,compresslevel=3) as z:
 for p in (runtime/'Lib').rglob('*.py'):
  if not {'site-packages','__pycache__','test','tests','idlelib','tkinter','ensurepip','venv'}.intersection(p.relative_to(runtime/'Lib').parts):z.write(p,p.relative_to(runtime/'Lib').as_posix())
codec=args.output/'BUILD-132-codec.zip'
with zipfile.ZipFile(codec,'w',zipfile.ZIP_DEFLATED,compresslevel=3) as z:
 for name in ['python.exe','python312.dll','python3.dll','vcruntime140.dll','vcruntime140_1.dll','LICENSE.txt','LICENSE']:
  p=runtime/name
  if p.is_file():z.write(p,name)
 for p in (runtime/'DLLs').glob('*.pyd'):z.write(p,'DLLs/'+p.name)
 z.write(stdlib,'python312.zip');z.writestr('python312._pth','python312.zip\n.\nDLLs\n')
print(json.dumps({'recipe':{'bytes':file.stat().st_size,'sha256':sha(file)},'delta':recipe['delta'],'codec':{'bytes':codec.stat().st_size,'sha256':sha(codec)},'reused_compressed_bytes':reused,'delta_bytes':new_bytes,'zlib':recipe['zlib']}),flush=True)
(args.output/'metadata.json').write_text(json.dumps({'recipe_sha256':sha(file),'delta_sha256':sha(delta),'codec_sha256':sha(codec)},indent=2),encoding='utf8')
