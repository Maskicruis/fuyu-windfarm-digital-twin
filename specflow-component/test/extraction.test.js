'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),crypto=require('node:crypto');
const root=path.resolve(__dirname,'..');
test('retained SpecFlow parser, model and citation modules match declared upstream bytes',()=>{
 const manifest=require('../UPSTREAM-BACKEND.json');
 for(const entry of manifest.byte_identical_core)assert.equal(crypto.createHash('sha256').update(fs.readFileSync(path.join(root,entry.path))).digest('hex'),entry.sha256,entry.path);
 const ui=require('../ui-provenance.json');for(const [file,hash]of Object.entries(ui.retained_module_sha256))assert.equal(crypto.createHash('sha256').update(fs.readFileSync(path.join(root,file))).digest('hex'),hash,file);
});
test('removed business routes are absent from component code and desktop bridge',()=>{
 const server=fs.readFileSync(path.join(root,'src/http-server.js'),'utf8'),service=fs.readFileSync(path.join(root,'src/service.js'),'utf8'),preload=fs.readFileSync(path.join(root,'desktop/preload.cjs'),'utf8');
 for(const word of ['ProjectWorkspace','SpecificationMonitor','WordFormatService'])assert.ok(!service.includes(word),word);
 for(const route of ['/api/v1/projects','/api/v1/spec-monitors','/api/tools'])assert.ok(!server.includes(route),route);
 for(const feature of ['designTools:','connector:','updates:','balance:'])assert.ok(!preload.includes(feature),feature);
});
