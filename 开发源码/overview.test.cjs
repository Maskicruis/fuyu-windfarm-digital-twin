const {JSDOM}=require('jsdom'),fs=require('fs'),path=require('path'),assert=require('node:assert/strict');
(async()=>{
const dom=new JSDOM('<body><div id="left-rail"><section>legacy</section></div><div class="fuyu-settings-body"></div></body>',{url:'http://localhost/',runScripts:'outside-only'}),w=dom.window,d=w.document;
let preferences={overview:{demo:false,summary:'<project>',actual:0,planned:10,units:{WT:0}}},jump=null,selected=null;
w.esc=v=>String(v).replace(/</g,'&lt;').replace(/>/g,'&gt;');w.icon=()=>'<svg></svg>';w.s={scope:'ALL'};w.renderNav=()=>{};w.openModal=()=>{};w.openUnitWorkspace=u=>jump=u;w.selectUnitObject=id=>selected=id;
w.unitObjects=Object.fromEntries(['WT','RD','CL','SS'].map(u=>[u,[{id:u==='WT'?'F08':u+'-01',label:u,planned:20,percent:10}]]));
w.FuyuUnified={preferences:()=>preferences};w.fetch=async(url,options)=>{if(options)preferences={overview:JSON.parse(options.body).overview};return {ok:true,json:async()=>preferences};};
w.eval(fs.readFileSync(path.join(__dirname,'overview.js'),'utf8'));await new Promise(r=>setImmediate(r));
assert.equal(d.querySelectorAll('.ov-card').length,3);assert.ok(d.getElementById('ov-legacy-cache').hidden);
assert.equal(d.querySelector('.ov-ring strong').textContent,'0%');assert.equal(d.querySelector('.ov-summary').textContent,'<project>');assert.equal(d.querySelectorAll('project').length,0);
assert.equal(d.querySelectorAll('.ov-alert-list [data-ov-unit]').length,0);
d.querySelector('[data-ov-unit="WT"]').click();assert.equal(jump,'WT');
d.getElementById('ov-demo').checked=true;d.getElementById('ov-config-actual').value='30';d.getElementById('ov-config-planned').value='45';d.getElementById('ov-save').click();await new Promise(r=>setImmediate(r));
assert.equal(d.querySelector('.ov-ring strong').textContent,'30%');assert.match(d.querySelector('.ov-progress-main dl').textContent,/-15/);assert.equal(d.querySelectorAll('.ov-alert-list [data-ov-unit]').length,3);
d.querySelector('.ov-alert-list button').click();assert.ok(selected);assert.ok(preferences.overview.demo);
dom.window.close();console.log('Overview: three cards, genuine empty/zero states, escaping, configuration, progress and navigation passed.');
})().catch(e=>{console.error(e);process.exitCode=1;});
