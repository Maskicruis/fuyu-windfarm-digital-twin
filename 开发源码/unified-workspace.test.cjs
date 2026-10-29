'use strict';
const {JSDOM}=require('jsdom'),fs=require('node:fs'),path=require('node:path'),assert=require('node:assert/strict');
const html='<body><main id="unit-workspace"></main><dialog id="modal"></dialog><textarea id="ag-input"></textarea><button data-ag-action="adopt"></button></body>';
const dom=new JSDOM(html,{url:'file:///test/frontend.html',runScripts:'outside-only',pretendToBeVisual:true}),w=dom.window;
let selectedScope='',modal='',agent=false,animation=false;
w.esc=x=>String(x).replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));w.icon=x=>'<svg class="icon" data-icon="'+x+'"></svg>';
w.unitState={key:'WT',task:'records',group:'全部',search:'',mode:'3d',playing:false};w.s={scope:'WT'};
w.unitConfig={};w.unitObjects={};w.units={};
for(const key of ['WT','RD','CL','SS']){w.unitConfig[key]={title:key+'工程',subtitle:'construction',objectTitle:'目录',groupName:'分组',groups:['全部'],viewTitle:'模型',canvasLabel:'场景'};w.unitObjects[key]=[{id:key+'-A',label:'测试对象',actual:key+'-01',location:'测试位置',percent:20,planned:30}];w.units[key]={name:key+'工程'};}
w.unitSteps=key=>[{code:key+'-01',seq:1,stage:'施工阶段',step:'准备',quality:'1.检查。2.检验。',danger:'风险',row:3},{code:key+'-02',seq:2,stage:'施工阶段',step:'施工',quality:'检查',danger:'无',row:4}];
w.currentUnitObject=()=>w.unitObjects[w.unitState.key][0];w.currentUnitStep=()=>w.unitSteps(w.unitState.key)[0];w.unitStages=()=>[{name:'施工阶段',rows:w.unitSteps(w.unitState.key)}];w.stepName=r=>r.step;
w.unitObjectRows=()=>'<button data-u-object="'+w.currentUnitObject().id+'">对象</button>';
w.v7ProgressCard=()=>'<section class="panel v7-progress-card">20 / 30</section>';
w.unitLeft=w.unitRight=w.unitCenter=w.unitSceneFrame=w.unitFlow=()=>'';w.selectUnitObject=()=>{};
w.renderUnitWorkspace=()=>{w.document.getElementById('unit-workspace').innerHTML=w.unitLeft()+w.unitCenter()+w.unitRight();};w.syncV6=()=>{};w.unitClick=()=>{};
w.openUnitWorkspace=()=>{};w.setView=()=>{};w.getAsset=()=>({unit:'WT'});
w.selectScope=x=>{selectedScope=x;};w.FuyuScene={setAnimation:x=>{animation=x;},toggleLayer:()=>{},focus:()=>{}};
w.openModal=(title,body)=>{modal=title+body;};w.toggleAgent=x=>{agent=x;};w.toast=()=>{};w.chooseUnitStep=()=>{};
let items=[{id:'a',label:'<unsafe>',filename:'图纸.pdf',mime:'application/pdf',objectId:'WT-A',process:'WT-01',recordDate:'2026-10-29'},{id:'b',label:'其他对象',filename:'其他.pdf',objectId:'WT-B',process:'WT-01'}];
w.FuyuArchivePanel={sync:()=>{},items:()=>items,state:()=>({service:true}),knowledge:()=>'<p>配置提示</p>',manage:()=>{modal='档案';},preview:id=>{modal='预览'+id;}};
w.eval(fs.readFileSync(path.join(__dirname,'unified-workspace.js'),'utf-8'));
for(const unit of ['WT','RD','CL','SS']){w.unitState.key=unit;w.unitState.task='records';w.renderUnitWorkspace();assert.equal(w.unitState.task,'overview');assert.equal(w.document.querySelectorAll('.u-task-nav,[data-u-task]').length,0);assert.equal(w.document.querySelectorAll('.uw-knowledge-grid>button').length,8);assert.ok(w.document.querySelector('.uw-documents'));assert.ok(w.document.querySelector('.uw-flow'));assert.ok(w.document.querySelector('.uw-related'));}
w.unitState.key='WT';w.renderUnitWorkspace();assert.equal(w.document.querySelector('.uw-related .uw-file b').textContent,'<unsafe>');assert.equal(w.document.querySelectorAll('.uw-related .uw-file').length,1);assert.equal(w.document.querySelectorAll('.uw-documents .uw-file').length,2);assert.equal(w.document.querySelectorAll('unsafe').length,0);
w.document.querySelector('[data-uw-knowledge="process"]').click();assert.equal(agent,true);assert.match(w.document.getElementById('ag-input').value,/标准工艺/);assert.equal(selectedScope,'');
w.document.querySelector('[data-uw-knowledge="danger"]').click();assert.match(modal,/危大工程/);assert.equal(w.unitState.task,'overview');
w.document.querySelector('[data-uw-document="a"]').click();assert.equal(modal,'预览a');
w.unitState.playing=true;w.renderUnitWorkspace();assert.equal(animation,true);assert.ok(w.document.querySelector('[data-u-action="play"]').textContent.includes('暂停'));
dom.window.close();console.log('Unified workspace: four disciplines, single page, scoped archives, escaping, knowledge actions and playback passed.');
