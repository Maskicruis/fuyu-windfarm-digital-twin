'use strict';
const fs=require('node:fs'),path=require('node:path'),assert=require('node:assert/strict');
const {JSDOM,VirtualConsole}=require('jsdom');
const source=fs.readFileSync(path.join(__dirname,'system-admin.js'),'utf8');
const results=[];let assertions=0;
const ok=(value,message)=>{assertions++;assert.ok(value,message);};
const eq=(a,b,message)=>{assertions++;assert.deepStrictEqual(JSON.parse(JSON.stringify(a)),JSON.parse(JSON.stringify(b)),message);};
const tick=async()=>{for(let n=0;n<4;n++)await new Promise(resolve=>setImmediate(resolve));};
const row={id:'a'.repeat(32),name:'风机进度',url:'https://example.com/progress?project=fuyu',unit:'WT',enabled:true,idField:'id',arrayPath:'data.items',fields:{percent:'actual',planned:'plan'},hasApiKey:true,keyHint:'已保存 · 尾号 demo',lastStatus:'unchecked'};
function fixture(options={}){
 const vc=new VirtualConsole(),errors=[];vc.on('jsdomError',e=>errors.push(e.message));
 const dom=new JSDOM('<!doctype html><html><body><header class="'+(options.front?'topbar':'studio-topbar')+'"><div class="top-actions"><button id="open-display-btn">展示</button></div></header><button id="edit-mode-btn">编辑</button></body></html>',{url:options.offline?'file:///G:/admin.html':'http://127.0.0.1:8779/admin.html',runScripts:'outside-only',pretendToBeVisual:true,virtualConsole:vc});
 const w=dom.window,d=w.document,calls=[],pending=[],events=[],order=[];
 w.HTMLDialogElement.prototype.showModal=function(){this.setAttribute('open','');};
 w.HTMLDialogElement.prototype.close=function(){this.removeAttribute('open');this.dispatchEvent(new w.Event('close'));};
 let records=options.empty?[]:[structuredClone(row)],testResult=options.testResult||{interfaceId:row.id,unit:'WT',rows:1,validRows:1,preview:[{objectId:'F08',values:{percent:58,planned:64,label:'F08风机'}}],warnings:[],rejectedRows:0,checkedAt:'2026-10-29T03:00:00Z'};
 w.FuyuStudio={flushDraft:async()=>{order.push('flush');}};
 w.FuyuKnowledge={open:()=>events.push('knowledge')};
 d.addEventListener('fuyu-interface-applied',e=>events.push({type:'applied',detail:e.detail}));
 w.fetch=async(url,request={})=>{
  const body=request.body?JSON.parse(request.body):undefined,method=request.method||'GET';calls.push({url,method,body,signal:request.signal});order.push(method+' '+url);
  const reply=(data,ok=true,status=200)=>({ok,status,json:async()=>data});
  if(url==='/api/system/status')return reply({revision:'10.0',mode:'local',knowledge:{ready:4,queued:1,parsing:1},interfaces:records.length});
  if(url==='/api/interfaces'&&method==='GET')return reply({interfaces:structuredClone(records)});
  if(url==='/api/interfaces'&&method==='POST'||/^\/api\/interfaces\/[a-f0-9]{32}$/.test(url)&&method==='PUT'){
   if(options.saveError)return reply({error:'配置保存失败'},false,503);
   const id=body.id||'b'.repeat(32),previous=records.find(r=>r.id===id)||{};
   const clean=Object.fromEntries(Object.entries(body).filter(([name])=>!['apiKey','clearApiKey'].includes(name)));
   const record={...previous,...clean,id,hasApiKey:body.clearApiKey?false:!!body.apiKey||!!previous.hasApiKey,keyHint:body.clearApiKey?'未配置':'已保存 · 尾号 demo'};
   records=records.filter(r=>r.id!==id).concat(record);return reply({interface:structuredClone(record)});
  }
  if(url.endsWith('/test')){
   if(options.defer)return new Promise(resolve=>pending.push(data=>resolve(reply(data))));
   if(options.testError)return reply({error:'数据接口认证失败'},false,401);
   return reply(structuredClone(testResult));
  }
  if(url.endsWith('/apply'))return reply({draft:{version:2,profiles:{},data:{objects:{'WT:F08':{percent:58,planned:64}}}},applied:1});
  throw Error('Unexpected API '+method+' '+url);
 };
 w.eval(source);
 return {dom,w,d,calls,pending,events,order,errors,click:id=>d.getElementById(id).click(),input:(id,value)=>{const el=d.getElementById(id);el.value=value;el.dispatchEvent(new w.Event('input',{bubbles:true}));},action:name=>d.querySelector('[data-sa-action="'+name+'"]').click(),select:()=>d.querySelector('[data-sa-select]').click(),records:()=>records,close:()=>dom.window.close()};
}
async function test(name,fn){try{await fn();results.push({name,passed:true});}catch(error){results.push({name,passed:false,error:error.stack});}}
(async()=>{
 await test('admin-only installation and offline state do not call network',async()=>{
  const front=fixture({front:true});try{ok(!front.d.getElementById('fuyu-system-admin-open'));eq(front.calls,[]);}finally{front.close();}
  const f=fixture({offline:true});try{f.click('fuyu-system-admin-open');await tick();ok(f.d.getElementById('fuyu-system-admin').open);ok(f.d.getElementById('sa-message').textContent.includes('启动控制后台'));ok(f.d.getElementById('sa-save').disabled);eq(f.calls,[]);}finally{f.close();}
 });
 await test('overview has live service counts and links to interface editing and knowledge management',async()=>{
  const f=fixture();try{f.click('fuyu-system-admin-open');await tick();const text=f.d.getElementById('sa-overview').textContent;ok(text.includes('10.0'));ok(text.includes('可检索资料'));ok(text.includes('4'));eq(f.calls.map(c=>c.url),['/api/system/status','/api/interfaces']);f.action('knowledge');ok(!f.d.getElementById('fuyu-system-admin').open);eq(f.events,['knowledge']);f.click('fuyu-system-admin-open');await tick();f.action('editor');eq(f.d.activeElement.id,'edit-mode-btn');ok(!f.d.getElementById('fuyu-system-admin').open);eq(f.errors,[]);}finally{f.close();}
 });
 await test('save creates a minimal config and clears bearer text without browser persistence',async()=>{
  const f=fixture({empty:true});try{f.click('fuyu-system-admin-open');await tick();f.action('interfaces');f.input('sa-name','新进度接口');f.input('sa-url','https://example.com/api/progress');f.input('sa-key','dummy-never-real-private');f.click('sa-save');await tick();const request=f.calls.find(c=>c.method==='POST'&&c.url==='/api/interfaces');eq(request.body.name,'新进度接口');eq(request.body.fields,{percent:'actual',planned:'plan'});eq(request.body.apiKey,'dummy-never-real-private');ok(!('hasApiKey'in request.body));ok(!('keyHint'in request.body));eq(f.d.getElementById('sa-key').value,'');ok(!f.d.documentElement.outerHTML.includes('dummy-never-real-private'));eq(f.w.localStorage.length,0);ok(f.d.getElementById('sa-message').textContent.includes('已保存'));ok(!f.d.getElementById('sa-test').disabled);ok(f.d.getElementById('sa-apply').disabled);eq(f.errors,[]);}finally{f.close();}
 });
 await test('mapping errors and unsaved edits prevent test and apply',async()=>{
  const f=fixture();try{f.click('fuyu-system-admin-open');await tick();f.action('interfaces');f.select();ok(!f.d.getElementById('sa-test').disabled);f.input('sa-fields','{bad');ok(f.d.getElementById('sa-test').disabled);f.click('sa-save');await tick();ok(f.d.getElementById('sa-message').textContent.includes('有效的 JSON'));ok(!f.calls.some(c=>c.method==='PUT'));f.input('sa-fields','{"unexpected":"value"}');f.click('sa-save');await tick();ok(f.d.getElementById('sa-message').textContent.includes('仅支持'));f.input('sa-fields','{"percent":"actual","planned":"plan"}');ok(!f.d.getElementById('sa-test').disabled);f.input('sa-url','https://example.com/new');ok(f.d.getElementById('sa-test').disabled);ok(f.d.getElementById('sa-apply-hint').textContent.includes('尚未保存'));}finally{f.close();}
 });
 await test('test only previews validated fields, escapes source text and never publishes',async()=>{
  const testResult={interfaceId:row.id,unit:'WT',rows:1,validRows:1,preview:[{objectId:'F08',values:{percent:58,planned:64,label:'<img src=x onerror=alert(1)>'}}],warnings:[],rejectedRows:0};
  const f=fixture({testResult});try{f.click('fuyu-system-admin-open');await tick();f.action('interfaces');f.select();f.click('sa-test');await tick();ok(f.d.getElementById('sa-preview').textContent.includes('F08'));ok(f.d.getElementById('sa-preview').textContent.includes('58 / 64'));ok(f.d.getElementById('sa-preview').textContent.includes('<img'));ok(!f.d.querySelector('#sa-preview img'));ok(!f.d.getElementById('sa-apply').disabled);eq(f.calls.filter(c=>c.url.endsWith('/test')).length,1);ok(!f.calls.some(c=>c.url.includes('/apply')||c.url.includes('/publish')));f.input('sa-id-field','asset.code');ok(f.d.getElementById('sa-apply').disabled);ok(!f.d.getElementById('sa-preview').textContent.includes('F08'));eq(f.errors,[]);}finally{f.close();}
 });
 await test('warnings, zero valid rows and disabled interface cannot be applied',async()=>{
  for(const result of [{rows:1,validRows:0,preview:[],warnings:[],rejectedRows:0},{rows:2,validRows:1,preview:[{objectId:'F08',values:{percent:50}}],warnings:['第2行比例越界'],rejectedRows:1}]){
   const f=fixture({testResult:result});try{f.click('fuyu-system-admin-open');await tick();f.action('interfaces');f.select();f.click('sa-test');await tick();ok(f.d.getElementById('sa-apply').disabled);ok(!f.calls.some(c=>c.url.endsWith('/apply')));}finally{f.close();}
  }
  const f=fixture();try{f.click('fuyu-system-admin-open');await tick();f.select();f.d.getElementById('sa-enabled').checked=false;f.d.getElementById('sa-enabled').dispatchEvent(new f.w.Event('change',{bubbles:true}));f.click('sa-save');await tick();ok(f.d.getElementById('sa-test').disabled);ok(f.d.getElementById('sa-interface-list').textContent.includes('已停用'));}finally{f.close();}
 });
 await test('apply flushes editor draft first and dispatches only validated server draft',async()=>{
  const f=fixture();try{f.click('fuyu-system-admin-open');await tick();f.action('interfaces');f.select();f.click('sa-test');await tick();f.click('sa-apply');await tick();const event=f.events.find(e=>e.type==='applied');ok(event);eq(event.detail.draft.data.objects['WT:F08'],{percent:58,planned:64});ok(f.order.indexOf('flush')<f.order.findIndex(x=>x.endsWith('/apply')));ok(!f.calls.some(c=>c.url.includes('/publish')));ok(f.d.getElementById('sa-message').textContent.includes('后台草稿'));ok(f.d.getElementById('sa-apply').disabled);eq(f.d.getElementById('sa-key').value,'');eq(f.errors,[]);}finally{f.close();}
 });
 await test('close aborts in-flight check, rejects late preview and removes unsaved bearer',async()=>{
  const f=fixture({defer:true});try{f.click('fuyu-system-admin-open');await tick();f.action('interfaces');f.select();f.click('sa-test');await tick();eq(f.pending.length,1);ok(f.d.getElementById('sa-enabled').disabled);f.action('close');const request=f.calls.find(c=>c.url.endsWith('/test'));ok(request.signal.aborted);f.pending[0]({rows:1,validRows:1,preview:[{objectId:'LATE-SHOULD-NOT-APPEAR',values:{percent:50}}],warnings:[],rejectedRows:0});await tick();ok(!f.d.getElementById('sa-preview').textContent.includes('LATE-SHOULD'));f.click('fuyu-system-admin-open');await tick();f.input('sa-key','dummy-unsaved-private');f.action('close');eq(f.d.getElementById('sa-key').value,'');ok(!f.d.documentElement.outerHTML.includes('dummy-unsaved-private'));eq(f.errors,[]);}finally{f.close();}
 });
 await test('saved-key clear is explicit and failed tests have actionable errors',async()=>{
  const f=fixture({testError:true});try{f.click('fuyu-system-admin-open');await tick();f.action('interfaces');f.select();f.click('sa-test');await tick();ok(f.d.getElementById('sa-message').textContent.includes('认证失败'));ok(f.d.getElementById('sa-apply').disabled);f.d.getElementById('sa-clear-key').checked=true;f.d.getElementById('sa-clear-key').dispatchEvent(new f.w.Event('change',{bubbles:true}));f.click('sa-save');await tick();const request=f.calls.find(c=>c.method==='PUT');eq(request.body.clearApiKey,true);ok(!('apiKey'in request.body));ok(f.d.getElementById('sa-clear-key').disabled);eq(f.d.getElementById('sa-key').value,'');eq(f.errors,[]);}finally{f.close();}
 });
 const report={passed:results.every(result=>result.passed),groups:results.length,assertions,environment:'Node.js + jsdom with mocked local APIs; no external requests',results};
 fs.writeFileSync(path.join(__dirname,'system-admin-test-report.json'),JSON.stringify(report,null,2));
 console.log(JSON.stringify(report,null,2));if(!report.passed)process.exitCode=1;
})();
