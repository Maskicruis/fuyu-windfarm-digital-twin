'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),crypto=require('node:crypto');
test('complete matching PDF.js decoder, font and CMap assets are bundled with valid digests',()=>{
 const root=path.resolve(__dirname,'../lib'),manifest=JSON.parse(fs.readFileSync(path.join(root,'PDFJS_ASSETS.json'),'utf8'));
 assert.equal(manifest.version,'6.3.289');assert.ok(manifest.files.length>=200);
 for(const item of manifest.files){const bytes=fs.readFileSync(path.join(root,item.path));assert.equal(bytes.length,item.bytes,item.path);assert.equal(crypto.createHash('sha256').update(bytes).digest('hex'),item.sha256,item.path);}
 for(const name of ['jbig2.wasm','openjpeg.wasm','qcms_bg.wasm'])assert.ok(manifest.files.some(f=>f.path==='wasm/'+name));
});
