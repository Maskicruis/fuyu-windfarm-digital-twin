const {JSDOM}=require('jsdom'),fs=require('fs'),path=require('path'),assert=require('node:assert/strict');
const dom=new JSDOM('<body><div id="v6-scene"><canvas data-camera-heading="30"></canvas></div><div id="unit"></div></body>',{runScripts:'outside-only'}),w=dom.window,d=w.document;
w.renderUnitWorkspace=()=>{d.getElementById('unit').innerHTML='<div id="u-scene"></div>';};
w.eval(fs.readFileSync(path.join(__dirname,'scene-compass.js'),'utf8'));
assert.equal(d.querySelectorAll('#unit-compass').length,0);
for(const unit of ['WT','RD','CL','SS']){
 w.renderUnitWorkspace(unit);assert.equal(d.querySelectorAll('#unit-compass').length,1);
 d.dispatchEvent(new w.CustomEvent('fuyu-scene-camera',{detail:{heading:-45}}));
 assert.equal(d.getElementById('unit-compass').dataset.heading,'315.0');
 assert.equal(d.getElementById('unit-compass').style.getPropertyValue('--heading'),'315deg');
 assert.equal(d.querySelector('#unit-compass small').textContent,'315°');
 w.FuyuUnitCompass.install();assert.equal(d.querySelectorAll('#unit-compass').length,1);
 d.dispatchEvent(new w.CustomEvent('fuyu-scene-camera',{detail:{heading:Infinity}}));
 assert.equal(d.getElementById('unit-compass').dataset.heading,'315.0');
}
dom.window.close();console.log('Unit compasses: four disciplines, heading normalization, rerender persistence, no duplicates and invalid camera events passed.');
