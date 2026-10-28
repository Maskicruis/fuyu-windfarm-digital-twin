'use strict';
// Regression tests for the construction update. Uses the existing jsdom dependency;
// no browser, server, production file mutation, or real scan attachment is required.
// Set NODE_PATH to an existing jsdom node_modules directory when it is not local.
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const assert = require('node:assert/strict');
const {JSDOM, VirtualConsole} = require('jsdom');

const updatePath = path.join(__dirname, 'construction-update.js');
const runtimePath = path.join(__dirname, 'runtime.js');
const updateSource = fs.readFileSync(updatePath, 'utf8');
const runtimeSource = fs.readFileSync(runtimePath, 'utf8');
const reportPath = path.join(__dirname, 'construction-update-test-report.json');
const results = [];
let assertions = 0;
const fixtures = new Set();
const clean = value => JSON.parse(JSON.stringify(value));
const eq = (actual, expected, message) => {
  assertions++;
  assert.deepStrictEqual(clean(actual), clean(expected), message);
};
const ok = (actual, message) => { assertions++; assert.ok(actual, message); };
const flush = () => new Promise(resolve => setImmediate(resolve));

function fixture() {
  const errors = [];
  const vc = new VirtualConsole();
  vc.on('jsdomError', error => errors.push(error.message));
  const dom = new JSDOM(`<!doctype html><html data-fuyu-studio="true"><body>
    <button id="read-boundary"></button><input id="ag-input"><small id="ag-launch-subtitle"></small>
    <main id="unit-workspace"></main><div id="scope-fixture"></div>
    <dialog id="modal"><div id="modal-body"></div></dialog>
    </body></html>`, {
    url: 'http://127.0.0.1:8779/admin.html',
    runScripts: 'outside-only',
    pretendToBeVisual: true,
    virtualConsole: vc
  });
  fixtures.add(dom);
  const w = dom.window, d = w.document;
  const requests = [], renders = [], modals = [];
  const exampleObjects = unit => [{id: unit + '-A01', label: unit + '示例对象', actual: unit + '-01'}];
  w.esc = value => String(value).replace(/[&<>"']/g, char => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[char]));
  w.icon = name => '<svg data-test-icon="' + name + '"></svg>';
  w.unitState = {key: 'WT', task: 'overview'};
  w.s = {scope: 'WT'};
  w.units = {WT:{name:'风力发电机组工程'},RD:{name:'场内交通工程'},CL:{name:'集电线路工程'},SS:{name:'升压站工程'}};
  w.unitObjects = Object.fromEntries(Object.keys(w.units).map(unit => [unit, exampleObjects(unit)]));
  w.unitSteps = unit => [{code:unit+'-01', step:'准备施工'}, {code:unit+'-02', step:'当前查看工序'}];
  w.stepName = row => row.step || row.code;
  w.currentUnitObject = () => w.unitObjects[w.unitState.key][0];
  w.currentUnitStep = () => w.unitSteps(w.unitState.key)[1];
  w.getStep = code => ({code, step:'施工工序', row:3, danger:'无', standard:'验收依据'});
  w.unitLeft = () => '<aside id="unit-left"></aside>';
  w.unitRight = () => '<aside id="unit-right"></aside>';
  w.unitCenter = () => w.unitState.task === 'records'
    ? '<section class="unit-center"><section class="v7-records-canvas">' + w.v7DocumentPage() + '</section></section>'
    : '<section class="unit-center"></section>';
  w.v7AttentionCard = () => '';
  w.v7DocumentPage = () => '';
  w.agentTopics = ['quality','process','resource','standard','defects','danger'].map(key => ({key, name:key}));
  w.sendAgentQuestion = () => {};
  w.renderAgentMessages = () => {};
  w.updateAgentLauncher = () => {};
  w.agentState = {process:'WT-01', messages:[]};
  w.toast = () => {};
  w.openModal = (title, body, kicker) => {
    modals.push({title, kicker});
    d.getElementById('modal-body').innerHTML = body;
    d.getElementById('modal').open = true;
  };
  w.HTMLDialogElement.prototype.close = function() { this.open = false; };
  w.renderUnitWorkspace = () => {
    renders.push({unit:w.unitState.key, scope:w.s.scope, task:w.unitState.task});
    d.getElementById('unit-workspace').innerHTML = w.unitLeft() + w.unitCenter() + w.unitRight();
  };
  w.fetch = (url, options = {}) => new Promise((resolve, reject) => {
    const record = {
      url:String(url), options,
      resolve(data) { resolve({ok:true, status:200, json:async()=>data}); },
      reject
    };
    requests.push(record);
  });
  // Export only closure references in memory; the production file is unchanged.
  const ending = updateSource.lastIndexOf('})();');
  assert.ok(ending >= 0, 'Expected construction update IIFE');
  const instrumented = updateSource.slice(0, ending) +
    'globalThis.__constructionTest={a,catalog,sync,ensureDocuments,categoryCard,recordsRight,documentPage,openRegistration,saveRegistration};\n' +
    updateSource.slice(ending);
  w.eval(instrumented);
  const scopeFunction = runtimeSource.split(/\r?\n/).find(line => line.startsWith('function objectScope('));
  assert.ok(scopeFunction, 'Expected runtime text scope function');
  w.eval(scopeFunction + '\nglobalThis.__textScope=objectScope;');
  function prime(unit = 'WT', branch = unit === 'SS' ? 'civil' : 'main') {
    const a = w.__constructionTest.a;
    Object.assign(a, {unit, branch, category:'all', object:'all', process:'all', status:'all',
      search:'', selected:'', loading:false, service:true, key:unit+':'+branch, items:[]});
    w.unitState.key = unit;
    w.unitState.task = 'records';
    w.s.scope = unit;
    w.renderUnitWorkspace();
    return a;
  }
  return {dom,w,d,requests,renders,modals,errors,prime,test:w.__constructionTest};
}

async function test(name, body) {
  const before = assertions;
  try {
    await body();
    results.push({name, passed:true, assertions:assertions-before});
  } catch (error) {
    results.push({name, passed:false, assertions:assertions-before, error:error.stack || error.message});
  }
}

(async () => {
  await test('cross-unit requests reject stale responses and settle the active scope', async () => {
    const f = fixture(), {a,sync} = f.test;
    f.w.unitState.task = 'records';
    sync();
    f.w.unitState.key = 'SS'; f.w.s.scope = 'SS'; sync();
    eq(f.requests.length, 2, 'Switching units must immediately request the new scope');
    ok(f.requests[0].url.includes('unit=WT'), 'First request belongs to WT');
    ok(f.requests[1].url.includes('unit=SS') && f.requests[1].url.includes('branch=civil'), 'SS starts in civil');
    f.requests[0].resolve({documents:[{id:'old-WT'}]}); await flush();
    eq(a.items, [], 'Old WT response must not populate SS');
    ok(a.loading, 'SS remains loading while its own request is pending');
    f.requests[1].resolve({documents:[{id:'current-SS'}]}); await flush();
    eq(a.items.map(row=>row.id), ['current-SS'], 'Only current response is displayed');
    ok(!a.loading && a.service, 'Current request settles and connects the service');
    ok(f.errors.length === 0, 'No jsdom errors');
    f.dom.window.close();
  });

  await test('returning to ALL leaves the hidden unit workspace and chrome state untouched', async () => {
    const f = fixture(); f.prime('SS');
    f.test.ensureDocuments(true);
    const count = f.renders.length;
    f.w.s.scope = 'ALL';
    f.requests[0].resolve({documents:[{id:'SS-result'}]}); await flush();
    eq(f.renders.length, count, 'Completion must not render a hidden unit workspace');
    eq(f.test.a.items[0].id, 'SS-result', 'The fetched data may still be retained');
    ok(!f.test.a.loading, 'A hidden-scope request still settles');
    f.dom.window.close();
  });

  await test('archive catalog contains the exact 34 categories including SS category 03', () => {
    const f = fixture();
    const expected = {
      WT:{main:['设计文件','管理体系','施工管理','材料、构件','施工及验收','单位工程验收','统计汇总']},
      RD:{main:['设计文件','管理体系','施工管理','材料、构件','施工及验收']},
      CL:{main:['设计文件','管理体系','施工管理','材料、构件','施工记录','试验报告','验收记录','统计汇总']},
      SS:{civil:['设计文件','管理体系','施工管理','材料、构件','施工记录','验收记录','统计汇总'],
        install:['设计文件','管理体系','施工管理','安装记录','电气设备试验','验收记录','统计汇总']}
    };
    eq(f.test.catalog, expected, 'All branch labels and order match the functional directory');
    eq(Object.values(f.test.catalog).flatMap(branches=>Object.values(branches)).reduce((n,categories)=>n+categories.length,0), 34);
    eq(f.test.catalog.SS.civil[3], '材料、构件');
    eq(f.test.catalog.SS.install[3], '安装记录');
    f.dom.window.close();
  });

  await test('branch and file text scopes stay separate using generated archive markup', () => {
    const f = fixture(), a = f.prime('SS', 'civil');
    const civilText = f.d.querySelector('[data-v91-category="03"] span');
    eq(civilText.textContent, '材料、构件');
    const civilScope = f.w.__textScope(civilText);
    eq(civilScope, 'SS:civil');
    a.branch='install'; a.key='SS:install'; f.w.renderUnitWorkspace();
    const installText = f.d.querySelector('[data-v91-category="03"] span');
    eq(installText.textContent, '安装记录');
    eq(f.w.__textScope(installText), 'SS:install');
    ok(civilScope !== f.w.__textScope(installText), 'Text overrides cannot bleed across SS branches');
    a.items = ['document-A','document-B'].map(id=>({id,category:'03',label:id,filename:id+'.pdf',bytes:2048,mime:'application/pdf',uploadedAt:'2026-10-28T10:00:00',archiveStatus:'registered'}));
    a.selected='document-A'; f.w.renderUnitWorkspace();
    eq(f.w.__textScope(f.d.querySelector('.v91-meta-body h4')), 'document-A');
    const row = f.d.querySelector('[data-v91-document="document-B"] td b');
    eq(f.w.__textScope(row), 'document-B', 'File scope has priority over containing branch scope');
    a.selected='document-B'; f.w.renderUnitWorkspace();
    eq(f.w.__textScope(f.d.querySelector('.v91-meta-body h4')), 'document-B');
    ok(f.d.querySelector('.v91-meta-body').textContent.includes('2 KB'), 'Server bytes is used for file size');
    const registeredAt = [...f.d.querySelectorAll('.v91-meta-body dt')].find(node=>node.textContent==='登记时间').nextElementSibling.textContent;
    ok(registeredAt.includes('2026') && registeredAt.includes('10:00:00'), 'Server uploadedAt is displayed with a readable date/time');
    f.dom.window.close();
  });

  await test('runtime origin handshake accepts explicit opaque or HTTP origin without reading parent.location', () => {
    const lines = runtimeSource.split(/\r?\n/);
    const channelLine = lines.find(line=>line.startsWith("const CHANNEL='fuyu-studio-v9'"));
    const originLine = lines.find(line=>line.startsWith('const expectedOrigin='));
    ok(channelLine && originLine, 'Origin initialization is available');
    for (const origin of ['null','http://127.0.0.1:8779']) {
      let parentLocationReads=0;
      const parent={};
      Object.defineProperty(parent,'location',{get(){parentLocationReads++;throw new Error('Blocked a frame with origin from accessing parent');}});
      const context={document:{documentElement:{dataset:{fuyuStudio:'true',fuyuParentOrigin:origin}},referrer:''},
        location:{origin:'null'},parent,URL};
      vm.createContext(context);
      vm.runInContext(channelLine+'\n'+originLine+'\nglobalThis.actualOrigin=expectedOrigin;',context);
      eq(context.actualOrigin, origin, 'Explicit parent origin is preserved');
      eq(parentLocationReads, 0, 'Opaque iframe must not inspect parent.location');
    }
  });

  await test('editing mode skips archive actions and the save button bypasses native form submission', async () => {
    const f=fixture(), a=f.prime('WT');
    f.d.documentElement.dataset.fuyuEditing='true';
    f.d.querySelector('[data-v91-category="01"]').click();
    eq(a.category,'all','Edit selection must not change archive category');
    const file=new f.w.File(['test-image'], '现场扫描.png', {type:'image/png'});
    f.test.openRegistration(file);
    const button=f.d.querySelector('[data-v91-action="save-document"]');
    eq(button.type,'button','Sandbox save must use explicit click handling');
    let nativeSubmits=0;
    f.d.getElementById('v91-document-form').addEventListener('submit',()=>nativeSubmits++);
    button.click();
    eq(f.requests.length,0,'Editing must not write documents');
    f.d.documentElement.dataset.fuyuEditing='false';
    button.click();
    eq(nativeSubmits,0,'Saving must not depend on allow-forms');
    eq(f.requests.length,1);
    const post=f.requests[0],query=new URL(post.url,'http://127.0.0.1:8779').searchParams;
    eq(post.options.method,'POST');
    ok(post.options.body===file,'The body is the raw selected file');
    eq(post.options.headers['Content-Type'],'image/png');
    eq(query.get('filename'),'现场扫描.png');
    eq(query.get('unit'),'WT');
    eq(query.get('branch'),'main');
    eq(query.get('category'),'00');
    post.resolve({document:{id:'saved-document'}}); await flush();
    ok(!f.d.getElementById('modal').open,'Successful current registration closes its own dialog');
    eq(f.requests.length,2,'Successful registration refreshes the archive index');
    f.requests[1].resolve({documents:[]}); await flush();
    ok(f.errors.length===0,'Explicit save raises no DOM errors');
    f.dom.window.close();
  });

  await test('completion of an older upload cannot close or clear a newer registration', async () => {
    const f=fixture(),a=f.prime('WT');
    f.d.documentElement.dataset.fuyuEditing='false';
    const fileA=new f.w.File(['A'],'A.png',{type:'image/png'});
    const fileB=new f.w.File(['B'],'B.png',{type:'image/png'});
    f.test.openRegistration(fileA);
    f.d.querySelector('[data-v91-action="save-document"]').click();
    const first=f.requests[0];
    f.d.getElementById('modal').close();
    f.test.openRegistration(fileB);
    const formB=f.d.getElementById('v91-document-form');
    first.resolve({document:{id:'saved-A'}}); await flush();
    ok(first.options.body===fileA,'In-flight upload retains file A');
    ok(f.d.getElementById('modal').open,'A completion leaves the newer dialog open');
    ok(f.d.getElementById('v91-document-form')===formB,'The B form is still current');
    ok(a.file===fileB,'The B file remains selected');
    eq(f.d.getElementById('v91-reg-label').value,'B.png');
    f.requests[1].resolve({documents:[]}); await flush();
    f.dom.window.close();
  });

  const report={
    passed:results.every(result=>result.passed),
    tests:results.length,
    assertions,
    environment:'Node.js VM + existing jsdom; mocked document API; no browser, server or disk attachments',
    sources:{constructionUpdate:fs.statSync(updatePath).mtime.toISOString(),runtime:fs.statSync(runtimePath).mtime.toISOString()},
    results
  };
  fs.writeFileSync(reportPath,JSON.stringify(report,null,2)+'\n','utf8');
  console.log(JSON.stringify(report,null,2));
  for(const fixture of fixtures)fixture.window.close();
  if(!report.passed)process.exitCode=1;
})().catch(error=>{
  for(const fixture of fixtures)fixture.window.close();
  console.error(error.stack||error);
  process.exitCode=1;
});
