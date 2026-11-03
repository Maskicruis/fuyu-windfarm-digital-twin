"""Fetch missing PDF.js support files from the exact upstream npm distribution."""
from pathlib import Path
import base64,hashlib,io,json,tarfile,urllib.request
root=Path(__file__).resolve().parent.parent/'specflow-component/lib'
version='6.3.289'
metadata=json.load(urllib.request.urlopen('https://registry.npmjs.org/pdfjs-dist/'+version,timeout=45))
assert metadata['repository']['url']=='git+https://github.com/mozilla/pdf.js.git'
raw=urllib.request.urlopen(metadata['dist']['tarball'],timeout=90).read()
assert 'sha512-'+base64.b64encode(hashlib.sha512(raw).digest()).decode()==metadata['dist']['integrity']
with tarfile.open(fileobj=io.BytesIO(raw),mode='r:gz') as archive:
    for name in ['pdf.min.mjs','pdf.worker.min.mjs']:
        assert archive.extractfile('package/build/'+name).read().replace(b'\r\n',b'\n')==(root/name).read_bytes().replace(b'\r\n',b'\n'), 'Original library must match this exact upstream version (allow checkout line endings)'
    added=[]
    for member in archive.getmembers():
        parts=Path(member.name).parts
        if member.isfile() and len(parts)==3 and parts[0]=='package' and parts[1] in {'wasm','iccs','cmaps','standard_fonts'}:
            file=root/parts[1]/parts[2];file.parent.mkdir(parents=True,exist_ok=True)
            data=archive.extractfile(member).read();file.write_bytes(data)
            added.append({'path':'/'.join(parts[1:]),'bytes':len(data),'sha256':hashlib.sha256(data).hexdigest()})
(root/'PDFJS_ASSETS.json').write_text(json.dumps({'version':version,'upstream':metadata['dist']['tarball'],'npm_integrity':metadata['dist']['integrity'],'files':added},indent=2)+'\n','utf8')
print(json.dumps({'version':version,'bundled_support_files':len(added),'wasm_files':[x['path'] for x in added if x['path'].startswith('wasm/')]}))
