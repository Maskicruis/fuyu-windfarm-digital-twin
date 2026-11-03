"""Reassemble exact target archives. Runs with the bundled build-only codec."""
from pathlib import Path
import argparse,base64,gzip,hashlib,json,zipfile,zlib
parser=argparse.ArgumentParser();parser.add_argument('--recipe',type=Path,required=True);parser.add_argument('--base-dir',type=Path,required=True);parser.add_argument('--delta',type=Path,required=True);parser.add_argument('--output',type=Path,required=True);parser.add_argument('--names',nargs='*');args=parser.parse_args();args.output.mkdir(parents=True,exist_ok=True)
with gzip.open(args.recipe,'rt',encoding='utf8') as f:recipe=json.load(f)
assert zlib.ZLIB_RUNTIME_VERSION==recipe['zlib'],(zlib.ZLIB_RUNTIME_VERSION,recipe['zlib'])
base={};streams={}
def blocks(stream,length):
 while length:
  data=stream.read(min(length,1024*1024))
  if not data:raise EOFError('Missing compressed payload')
  length-=len(data);yield data
with args.delta.open('rb') as delta:
 for target in recipe['targets']:
  if args.names and target['name'] not in args.names:continue
  file=args.output/target['name']
  with file.open('wb') as result:
   for item in target['segments']:
    result.write(base64.b64decode(item['prefix']));h=hashlib.sha256();written=0
    def emit(data):
     global written
     result.write(data);h.update(data);written+=len(data)
    source=item.get('source')
    if source:
     name=source['archive']
     if name not in streams:streams[name]=(args.base_dir/name).open('rb');base[name]=zipfile.ZipFile(args.base_dir/name)
     if source['method']=='copy':
      streams[name].seek(source['offset'])
      for data in blocks(streams[name],source['length']):emit(data)
     else:
      compressor=zlib.compressobj(source['level'],zlib.DEFLATED,-15)
      with base[name].open(source['member']) as original:
       while True:
        data=original.read(1024*1024)
        if not data:break
        emit(compressor.compress(data))
      emit(compressor.flush())
    else:
     delta.seek(item['deltaOffset'])
     for data in blocks(delta,item['length']):emit(data)
    assert written==item['length'] and h.hexdigest()==item['sha256'],('Compressed member mismatch',target['name'],item['member'])
   result.write(base64.b64decode(target['tail']))
  with file.open('rb') as stream:actual=hashlib.file_digest(stream,'sha256').hexdigest()
  assert file.stat().st_size==target['bytes'] and actual==target['sha256'],target['name']
  print(json.dumps({'reconstructed':target['name'],'bytes':target['bytes'],'sha256':actual}),flush=True)
for z in base.values():z.close()
for f in streams.values():f.close()
