'use strict';
const fs=require('node:fs'),path=require('node:path'),assert=require('node:assert/strict');
const fixtureSource=fs.readFileSync(path.join(__dirname,'system-settings.test.cjs'),'utf8').split('async function test(name,fn)')[0];
const base=new Function('require','__dirname','structuredClone',fixtureSource+'\nreturn {fixture,tick};')(require,__dirname,structuredClone);
let assertions=0;const results=[],ok=(v,m)=>{assertions++;assert.ok(v,m);},eq=(a,b,m)=>{assertions++;assert.deepStrictEqual(JSON.parse(JSON.stringify(a)),JSON.parse(JSON.stringify(b)),m);};
const tick=async()=>{for(let i=0;i<7;i++)await base.tick();};
const D='a'.repeat(32),C='b'.repeat(32),S='c'.repeat(32);
function fixture(options={}){
 const f=base.fixture(options),original=f.w.fetch,streams=[];
 f.w.fetch=async(url,opt={})=>{
  if(url!=='/api/chat/stream')return original(url,opt);
  f.calls.push({url,method:opt.method,body:JSON.parse(opt.body),signal:opt.signal});
  let control;const stream={cancelled:false,signal:opt.signal};
  const body=new ReadableStream({start(c){control=c;},cancel(){stream.cancelled=true;}});
  stream.bytes=bytes=>{if(!stream.cancelled)control.enqueue(bytes);};
  stream.raw=text=>stream.bytes(new TextEncoder().encode(text));
  stream.event=event=>stream.raw('data: '+JSON.stringify(event)+'\n\n');
  stream.done=(reply='完整回答',extra={})=>{stream.event({type:'done',reply,model:'deepseek-flash',conversationId:S,finishReason:'stop',...extra});};
  stream.close=()=>control.close();
  streams.push(stream);return {ok:true,headers:{get:()=>options.mime||'text/event-stream; charset=utf-8'},body};
 };
 return {...f,streams,original,ask:async q=>{f.input('ag-input',q);f.click('ag-send');await tick();return streams.at(-1);},text:()=>f.d.getElementById('ag-messages').textContent};
}
async function test(name,fn){try{await fn();results.push({name,passed:true});}catch(e){results.push({name,passed:false,error:e.stack});}}
(async()=>{
 await test('reasoning and answer render before done from actual UTF8 SSE byte fragments',async()=>{
  const f=fixture();try{await tick();const stream=await f.ask('如何准备当前工序？');eq(f.calls.filter(x=>x.url==='/api/chat/stream').length,1);ok(!f.d.querySelector('.ds-reasoning'));
   stream.event({type:'status',stage:'thinking'});await tick();ok(f.text().includes('正在接收模型思考'));ok(!f.d.querySelector('.ds-reasoning'));
   const event='data: '+JSON.stringify({type:'reasoning',delta:'先核对当前工序与资料。'})+'\r\n\r\n',bytes=new TextEncoder().encode(event);
   for(let i=0;i<bytes.length;i+=3)stream.bytes(bytes.slice(i,i+3));await tick();
   const details=f.d.querySelector('.ds-reasoning');ok(details);ok(!details.open);ok(details.textContent.includes('先核对当前工序'));ok(!f.text().includes('完整回答'));eq(f.w.agentState.messages.at(-1).status,'streaming');
   stream.event({type:'delta',delta:'第一步，复核钢筋。'});await tick();ok(f.d.querySelector('.ds-answer-content').textContent.includes('第一步'));eq(f.w.agentState.messages.at(-1).status,'streaming');
   stream.event({type:'delta',delta:'第二步，检查模板。'});await tick();ok(f.text().includes('第二步'));stream.done('第一步，复核钢筋。第二步，检查模板。',{reasoning:'先核对当前工序与资料。'});await tick();
   eq(f.w.agentState.messages.at(-1).status,'done');eq(f.w.agentState.messages.at(-1).reasoning,'先核对当前工序与资料。');ok(stream.cancelled);eq(f.errors,[]);
  }finally{f.dom.window.close();}
 });
 await test('comments, CRLF, multiple data lines and coalesced frames are parsed without fake tokens',async()=>{
  const f=fixture();try{await tick();const s=await f.ask('工序准备');s.raw(': keepalive\r\n\r\nevent: delta\r\ndata: {"type":"delta",\r\ndata: "delta":"真实片段"}\r\n\r\ndata: {"type":"delta","delta":"继续片段"}\n\n');await tick();ok(f.text().includes('真实片段继续片段'));ok(!f.text().includes('keepalive'));s.done('真实片段继续片段');await tick();eq(f.w.agentState.messages.at(-1).status,'done');}finally{f.dom.window.close();}
 });
 await test('missing terminal event and malformed SSE retain partial answer but never mark completion',async()=>{
  for(const fault of ['eof','json','utf8']){const f=fixture();try{await tick();const s=await f.ask('先查资料');s.event({type:'delta',delta:'已经收到的部分。'});await tick();if(fault==='eof')s.close();else if(fault==='json')s.raw('data: not-json\n\n');else{s.bytes(Uint8Array.from([0xff,0xff]));s.close();}await tick();const m=f.w.agentState.messages.at(-1);eq(m.status,'error');eq(m.text,'已经收到的部分。');ok(f.d.querySelector('[data-ds-retry]'));ok(!f.d.querySelector('[data-ds-copy]'));}finally{f.dom.window.close();}}
 });
 await test('streamed error after partial output keeps answer and actual reasoning separate from error notice',async()=>{
  const f=fixture();try{await tick();const s=await f.ask('分析当前资源');s.event({type:'reasoning',delta:'核查已有资料。'});s.event({type:'delta',delta:'可用材料包括'});await tick();s.event({type:'error',error:'上游连接中断，请重试。'});await tick();const m=f.w.agentState.messages.at(-1);eq(m.status,'error');eq(m.text,'可用材料包括');eq(m.reasoning,'核查已有资料。');ok(f.text().includes('上游连接中断'));ok(s.cancelled);}finally{f.dom.window.close();}
 });
 await test('stop, new session, context and library changes ignore late answer reasoning citations and done',async()=>{
  for(const action of ['stop','new','context','library']){const f=fixture();try{await tick();const s=await f.ask('检查当前资源');s.event({type:'delta',delta:'当前部分'});await tick();
   if(action==='stop')f.click('ag-send');else if(action==='new')f.d.querySelector('[data-ag-action=new]').click();else if(action==='library')f.d.dispatchEvent(new f.w.Event('fuyu-knowledge-scope-changed'));else{f.w.selection={unit:'WT',process:'WT-07',object:'F08',name:'F08风机'};f.w.s.scope='WT';f.w.unitState.key='WT';f.d.getElementById('unit-workspace').innerHTML='<div>工程已切换</div>';await tick();}
   ok(s.signal.aborted);s.event({type:'reasoning',delta:'不能插入的迟到思考'});s.event({type:'delta',delta:'不能插入的迟到答案'});s.done('不能插入的迟到终稿',{citations:[{number:1,documentId:D,label:'迟到引用'}]});await tick();
   ok(!f.text().includes('不能插入'));eq(f.d.querySelectorAll('.ds-citation-list').length,0);if(action==='new')eq(f.w.agentState.messages.length,0);else ok(f.w.agentState.messages.some(m=>m.status==='cancelled'));
  }finally{f.dom.window.close();}}
 });
 await test('thinking is collapsible and stays escaped through streaming completion',async()=>{
  const f=fixture();try{await tick();const s=await f.ask('说明工艺');s.event({type:'reasoning',delta:'<img src=x onerror=alert(1)> API思考'});await tick();let details=f.d.querySelector('.ds-reasoning');eq(details.open,false);details.open=true;details.dispatchEvent(new f.w.Event('toggle'));s.event({type:'delta',delta:'正常回答'});await tick();details=f.d.querySelector('.ds-reasoning');ok(details.open);eq(f.d.querySelectorAll('#ag-messages img, #ag-messages script').length,0);s.done('正常回答',{reasoning:'<img src=x onerror=alert(1)> API思考'});await tick();ok(f.d.querySelector('.ds-reasoning').open);eq(f.w.agentState.messages.at(-1).reasoning,'<img src=x onerror=alert(1)> API思考');}finally{f.dom.window.close();}
 });
 await test('stream updates respect reader scroll position instead of forcing latest output',async()=>{
  const f=fixture();try{await tick();const s=await f.ask('说明资源');const list=f.d.getElementById('ag-messages');Object.defineProperty(list,'scrollHeight',{configurable:true,get:()=>1000});Object.defineProperty(list,'clientHeight',{configurable:true,get:()=>100});list.scrollTop=200;s.event({type:'delta',delta:'新片段'});await tick();eq(list.scrollTop,200);list.scrollTop=850;s.event({type:'delta',delta:'继续片段'});await tick();eq(list.scrollTop,1000);s.done('新片段继续片段');await tick();}finally{f.dom.window.close();}
 });
 await test('stream citations use canonical source utility and reasoning is excluded from follow-up history and copy',async()=>{
  const f=fixture();try{await tick();const opened=[],copied=[];f.w.FuyuKnowledge={scope:()=>({mode:'auto',enabled:true,unit:'SS',groupId:'all',documentIds:[]}),openCitation:c=>opened.push(c)};Object.defineProperty(f.w.navigator,'clipboard',{configurable:true,value:{writeText:async text=>copied.push(text)}});
   const cite={number:1,id:C,documentId:D,label:'工艺来源',page:2,locator:'第2页'};const s=await f.ask('说明工艺资源');s.event({type:'citations',citations:[cite],retrieval:{status:'matched'}});s.event({type:'reasoning',delta:'仅用于展示的API思考'});s.event({type:'delta',delta:'可核查回答[1]'});await tick();f.d.querySelector('.ds-inline-cite').click();eq(opened[0].documentId,D);s.done('可核查回答[1]',{reasoning:'仅用于展示的API思考',citations:[cite]});await tick();f.d.querySelector('[data-ds-copy]').click();await tick();eq(copied,['可核查回答[1]']);const next=await f.ask('继续说明');const body=f.calls.filter(x=>x.url==='/api/chat/stream').at(-1).body;eq(body.conversationId,S);ok(!JSON.stringify(body.messages).includes('仅用于展示'));next.done('继续回答');await tick();}finally{f.dom.window.close();}
 });
 await test('wrong content type is actionable and never silently falls back to buffered JSON',async()=>{
  const f=fixture({mime:'application/json'});try{await tick();await f.ask('工艺资源');ok(f.text().includes('尚未提供流式接口'));eq(f.w.agentState.messages.at(-1).status,'error');eq(f.calls.filter(x=>x.url==='/api/chat').length,0);}finally{f.dom.window.close();}
 });
 await test('background settings reads cannot erase a newly typed key or edited settings',async()=>{
  const f=fixture({admin:true});try{await tick();let resolve;f.w.fetch=(url,opt={})=>url==='/api/settings'&&(!opt.method||opt.method==='GET')?new Promise(r=>resolve=r):f.original(url,opt);f.click('fuyu-settings-open');f.input('fuyu-settings-key','test-new-key-that-must-stay');f.input('fuyu-settings-tokens','4096');resolve({ok:true,json:async()=>({...f.settings(),maxTokens:1024})});await tick();eq(f.d.getElementById('fuyu-settings-key').value,'test-new-key-that-must-stay');eq(f.d.getElementById('fuyu-settings-tokens').value,'4096');ok(f.d.getElementById('fuyu-settings-connection').textContent.includes('无需重复填写'));f.click('fuyu-settings-cancel');eq(f.d.getElementById('fuyu-settings-key').value,'');}finally{f.dom.window.close();}
 });
 await test('temporary settings failure preserves last confirmed saved-key state and does not ask reconfiguration',async()=>{
  const f=fixture({admin:true});try{await tick();f.w.fetch=async()=>{throw Error('暂时断开');};f.click('fuyu-settings-open');await tick();ok(f.d.getElementById('fuyu-settings-connection').textContent.includes('保留上次'));ok(f.d.getElementById('fuyu-settings-message').textContent.includes('无需重新填写'));ok(f.d.getElementById('fuyu-settings-key-state').textContent.includes('无需重复输入'));ok(!f.d.getElementById('fuyu-settings-clear-key').disabled);}finally{f.dom.window.close();}
 });
 await test('reopening saved settings keeps no-key-echo semantics and save errors retain a replacement key for retry',async()=>{
  const f=fixture({admin:true});try{await tick();f.click('fuyu-settings-open');await tick();eq(f.d.getElementById('fuyu-settings-key').value,'');ok(f.d.getElementById('fuyu-settings-key').placeholder.includes('无需重复填写'));f.input('fuyu-settings-key','test-replacement-key');const original=f.w.fetch;f.w.fetch=async(url,opt={})=>opt.method==='PUT'?{ok:false,status:503,json:async()=>({error:'暂时无法保存'})}:original(url,opt);f.click('fuyu-settings-save');await tick();eq(f.d.getElementById('fuyu-settings-key').value,'test-replacement-key');f.click('fuyu-settings-cancel');eq(f.d.getElementById('fuyu-settings-key').value,'');eq(f.w.localStorage.length,0);}finally{f.dom.window.close();}
 });
 const report={passed:results.every(x=>x.passed),groups:results.length,assertions,environment:'jsdom + real Web ReadableStream byte chunks, no external provider or browser',results};fs.writeFileSync(path.join(__dirname,'stream-ui-test-report.json'),JSON.stringify(report,null,2));console.log(JSON.stringify(report,null,2));if(!report.passed)process.exitCode=1;
})();
