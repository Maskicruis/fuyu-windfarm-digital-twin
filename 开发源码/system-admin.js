(function(){'use strict';
const topbar=document.querySelector('.studio-topbar .top-actions');
if(!topbar||window.FuyuSystemAdmin)return;
const $=id=>document.getElementById(id),h=value=>String(value??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const unitNames={WT:'风力发电机组工程',RD:'场内交通工程',CL:'集电线路工程',SS:'升压站工程'};
const fields=new Set(['percent','planned','label','location','group','actual','status']);
const icon='<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M3 5h18v5H3zM3 14h18v5H3zM7 7.5h.1M7 16.5h.1M12 7.5h6M12 16.5h6"/></svg>';
const state={open:false,tab:'overview',rows:[],selected:'',busy:false,operation:0,load:0,controller:null,returnFocus:null,status:null,test:null};
const online=()=>location.protocol==='http:'||location.protocol==='https:';
function show(dialog){if(typeof dialog.showModal==='function')dialog.showModal();else dialog.setAttribute('open','');}
function hide(dialog){if(typeof dialog.close==='function')dialog.close();else dialog.removeAttribute('open');}
function message(value,error=false){const el=$('sa-message');el.textContent=value;el.classList.toggle('error',error);if(value&&state.open)el.scrollIntoView?.({block:'nearest',inline:'nearest'});}
function localError(){return Error('请先通过“启动控制后台.cmd”打开本机服务，再管理系统和数据接口。');}
async function api(path,method='GET',body,externalSignal){
  if(!online())throw localError();
  const controller=new AbortController(),abort=()=>controller.abort();
  if(externalSignal?.aborted)controller.abort();
  externalSignal?.addEventListener('abort',abort,{once:true});
  const timer=setTimeout(abort,22000);
  try{
    const response=await fetch(path,{method,cache:'no-store',signal:controller.signal,headers:body?{'Content-Type':'application/json'}:undefined,body:body?JSON.stringify(body):undefined});
    let data;try{data=await response.json();}catch{throw Error('本机服务未提供系统管理接口，请使用最新版本启动器。');}
    if(!response.ok)throw Error(data.error||data.message||'服务返回 '+response.status);
    return data;
  }finally{clearTimeout(timer);externalSignal?.removeEventListener('abort',abort);}
}
function active(){return state.rows.find(row=>row.id===state.selected)||null;}
function sorted(value){if(!value||typeof value!=='object'||Array.isArray(value))return value;return Object.fromEntries(Object.keys(value).sort().map(k=>[k,sorted(value[k])]));}
function parseMapping(){
  let mapping;try{mapping=JSON.parse($('sa-fields').value);}catch{throw Error('字段映射须为有效的 JSON 对象，例如 {"percent":"actual","planned":"plan"}。');}
  if(!mapping||typeof mapping!=='object'||Array.isArray(mapping)||!Object.keys(mapping).length||Object.keys(mapping).some(key=>!fields.has(key)))throw Error('字段映射仅支持 percent、planned、label、location、group、actual、status。');
  if(Object.values(mapping).some(value=>typeof value!=='string'||!value.trim()))throw Error('每个目标字段都需要一个源 JSON 字段路径。');
  return mapping;
}
function formConfig(){return {name:$('sa-name').value.trim(),url:$('sa-url').value.trim(),unit:$('sa-unit').value,idField:$('sa-id-field').value.trim(),arrayPath:$('sa-array-path').value.trim(),fields:parseMapping(),enabled:$('sa-enabled').checked};}
function configOf(row){return Object.fromEntries(['name','url','unit','idField','arrayPath','fields','enabled'].map(key=>[key,row[key]]));}
function dirty(){const row=active();if(!row)return true;if($('sa-key').value.trim()||$('sa-clear-key').checked)return true;try{return JSON.stringify(sorted(formConfig()))!==JSON.stringify(sorted(configOf(row)));}catch{return true;}}
function statusLabel(row){if(!row.enabled)return '已停用';return ({success:'读取成功',warning:'存在数据警告',error:'连接失败',disabled:'已停用',unchecked:'待重新测试'})[row.lastStatus]||'尚未测试';}
function resetTest(){state.test=null;renderPreview();updateButtons();}
function renderList(){
  $('sa-interface-count').textContent=state.rows.length+' 个接口';
  $('sa-interface-list').innerHTML=state.rows.length?state.rows.map(row=>'<button type="button" class="sa-interface-row '+(state.selected===row.id?'selected':'')+'" data-sa-select="'+h(row.id)+'"><span><b>'+h(row.name)+'</b><small>'+h(unitNames[row.unit]||row.unit)+'</small></span><em class="'+(row.lastStatus==='success'&&row.enabled?'ready':row.lastStatus==='error'?'error':'')+'">'+h(statusLabel(row))+'</em></button>').join(''):'<div class="sa-empty"><b>尚未配置数据接口</b><p>新建一个 JSON 接口，将计划、实际进度或对象信息映射到展示数据。</p></div>';
}
function renderOverview(){
  const status=state.status||{},knowledge=status.knowledge||{},revision=status.revision||status.service?.revision||'—';
  const ready=Number.isFinite(knowledge.ready)?knowledge.ready:'—';
  const jobs=(Number(knowledge.queued)||0)+(Number(knowledge.parsing)||0);
  $('sa-overview').innerHTML='<div class="sa-overview-intro"><span>LOCAL SYSTEM CONSOLE</span><h3>界面、资料与接口，统一管理。</h3><p>这里管理系统结构与数据接入。前台负责模型展示、API 配置、资料导入与智能问答；布局草稿经过发布后才进入展示端。</p></div><div class="sa-metrics"><div><span>服务版本</span><strong>'+h(revision)+'</strong><small>'+h(online()?'本机服务':'离线页面')+'</small></div><div><span>可检索资料</span><strong>'+h(ready)+'</strong><small>已完成解析</small></div><div><span>后台解析任务</span><strong>'+h(state.status?jobs:'—')+'</strong><small>排队与解析中</small></div><div><span>数据接口</span><strong>'+state.rows.length+'</strong><small>手动读取 · 不自动同步</small></div></div><div class="sa-entry-grid"><button type="button" data-sa-action="editor"><span>01 · INTERFACE</span><b>界面编辑</b><p>调整组件、全部文字、样式与对象展示数据；保留草稿、发布和历史恢复。</p><em>返回编辑画布 →</em></button><button type="button" data-sa-action="knowledge"><span>02 · KNOWLEDGE</span><b>知识库管理</b><p>维护文档分组、解析队列、检索范围和工程关联，核查原文与引用。</p><em>打开知识库 →</em></button><button type="button" data-sa-action="interfaces"><span>03 · DATA CONNECTORS</span><b>数据接口</b><p>配置只读 JSON 接口与字段映射，先验证预览，再将有效数据写入布局草稿。</p><em>管理数据接口 →</em></button></div><div class="sa-boundary"><b>变更与发布</b><p>接口测试只读取数据。应用操作仅更新后台草稿，不会直接发布前端，也不会回写外部业务系统。认证密钥由本机服务保存，不写入界面配置。</p></div>';
}
function fill(row=null){
  state.selected=row?.id||'';state.test=null;
  $('sa-editor-title').textContent=row?'编辑接口':'新建接口';
  $('sa-name').value=row?.name||'';$('sa-url').value=row?.url||'';$('sa-unit').value=row?.unit||'WT';
  $('sa-id-field').value=row?.idField||'id';$('sa-array-path').value=row?.arrayPath||'';
  $('sa-fields').value=JSON.stringify(row?.fields||{percent:'actual',planned:'plan'},null,2);
  $('sa-enabled').checked=row?!!row.enabled:true;$('sa-key').value='';$('sa-clear-key').checked=false;
  $('sa-key').placeholder=row?.hasApiKey?'已保存；留空保留，输入新密钥可替换':'可选：填写 Bearer 认证密钥';
  $('sa-key-state').textContent=row?.keyHint||'未配置认证密钥';
  $('sa-checked').textContent=row?.lastCheckedAt?'最近检查：'+row.lastCheckedAt+' · '+statusLabel(row):'尚未进行连接测试';
  $('sa-form-message').textContent=row?.lastError||'';
  renderList();renderPreview();updateButtons();
}
function updateButtons(){
  if(!$('sa-save'))return;
  const row=active(),unsaved=dirty(),tested=state.test;
  $('sa-save').disabled=state.busy||!online();
  $('sa-test').disabled=state.busy||!online()||!row||unsaved||!row.enabled;
  $('sa-apply').disabled=state.busy||!online()||!row||unsaved||!row.enabled||!tested||!tested.validRows||tested.rejectedRows>0||(tested.warnings||[]).length>0;
  $('sa-new').disabled=state.busy;
  $('sa-enabled').disabled=state.busy;
  for(const node of $('sa-interface-list').querySelectorAll('button'))node.disabled=state.busy;
  for(const node of $('sa-interface-form').querySelectorAll('input,select,textarea'))node.disabled=state.busy;
  $('sa-clear-key').disabled=state.busy||!row?.hasApiKey;
  $('sa-apply-hint').textContent=!row?'保存接口后可测试连接。':unsaved?'当前配置尚未保存，请先保存再测试。':!row.enabled?'接口已停用。启用并保存后方可测试。':!tested?'先测试连接，核查对象与映射值。':tested.rejectedRows>0||(tested.warnings||[]).length?'存在数据警告，请修正源数据或字段映射后重新测试。':!tested.validRows?'没有有效对象数据，不能应用到草稿。':'预览已通过；应用会重新读取接口，仅写入后台草稿。';
}
function renderPreview(){
  const result=state.test;
  if(!result){$('sa-preview').innerHTML='<div class="sa-preview-empty">保存配置后点击“测试连接”，这里会显示经过校验的对象数据。上游原始响应不会直接展示。</div>';return;}
  const rows=Array.isArray(result.preview)?result.preview:[],warnings=Array.isArray(result.warnings)?result.warnings:[];
  const metrics='<div class="sa-preview-caption"><b>映射预览</b><span>'+Number(result.validRows||0)+' 条有效 / '+Number(result.rows||0)+' 条来源'+(rows.length>100?' · 仅显示前 100 条':'')+'</span></div>';
  const table=rows.length?'<div class="sa-table-scroll"><table><thead><tr><th>工程对象</th><th>实际 / 计划</th><th>其他映射字段</th></tr></thead><tbody>'+rows.slice(0,100).map(row=>{const values=row.values||{},extra=Object.entries(values).filter(([name])=>!['percent','planned'].includes(name));return '<tr><td>'+h(row.objectId)+'</td><td>'+h(values.percent??'—')+' / '+h(values.planned??'—')+'</td><td>'+extra.map(([name,value])=>'<span><b>'+h(name)+'</b> '+h(value)+'</span>').join('')+'</td></tr>';}).join('')+'</tbody></table></div>':'<p class="sa-muted">没有符合映射要求的数据行。</p>';
  const notes=warnings.length?'<div class="sa-warnings"><b>源数据需要核查</b><ul>'+warnings.slice(0,10).map(w=>'<li>'+h(w)+'</li>').join('')+'</ul>'+(warnings.length>10||result.truncated?'<small>仅显示部分警告，请在源接口修正数据后重新测试。</small>':'')+'</div>':'';
  $('sa-preview').innerHTML=metrics+table+notes;
}
function setTab(tab){state.tab=tab;for(const button of $('sa-nav').querySelectorAll('[data-sa-tab]')){const selected=button.dataset.saTab===tab;button.classList.toggle('active',selected);button.setAttribute('aria-selected',String(selected));}$('sa-overview').hidden=tab!=='overview';$('sa-connectors').hidden=tab!=='interfaces';message('');}
async function reload(){
  const id=++state.load;
  if(!online()){renderOverview();message(localError().message,true);updateButtons();return;}
  const results=await Promise.allSettled([api('/api/system/status'),api('/api/interfaces')]);
  if(id!==state.load||!state.open)return;
  if(results[0].status==='fulfilled')state.status=results[0].value;
  if(results[1].status==='fulfilled'){
    state.rows=Array.isArray(results[1].value.interfaces)?results[1].value.interfaces:[];
    renderList();updateButtons();
  }
  renderOverview();
  const errors=results.filter(r=>r.status==='rejected').map(r=>r.reason.message);
  if(errors.length)message(errors.join(' '),true);
}
async function operate(action){
  if(state.busy)return;
  let body,selected=active();
  try{
    if(action==='save'){
      body=formConfig();if(!body.name||!body.url)throw Error('请填写接口名称和 URL。');
      if(selected)body.id=selected.id;
      const key=$('sa-key').value.trim(),clear=$('sa-clear-key').checked;
      if(key&&clear)throw Error('替换密钥与清除密钥请分别执行。');
      if(key)body.apiKey=key;if(clear)body.clearApiKey=true;
    }else{
      if(!selected)throw Error('请先保存接口配置。');
      if(dirty())throw Error('当前配置尚未保存，请先保存再测试。');
      if(!selected.enabled)throw Error('接口已停用，请先启用并保存。');
      if(action==='apply'&&(!state.test||!state.test.validRows||state.test.rejectedRows>0||(state.test.warnings||[]).length))throw Error('请先取得无警告且包含有效数据的测试预览。');
    }
  }catch(error){message(error.message,true);return;}
  const id=++state.operation;state.busy=true;state.controller=new AbortController();updateButtons();
  message(action==='save'?'正在保存接口配置…':action==='test'?'正在读取并校验接口数据…':'正在重新读取接口并应用到后台草稿…');
  try{
    if(action==='save'){
      const result=await api(selected?'/api/interfaces/'+selected.id:'/api/interfaces',selected?'PUT':'POST',body,state.controller.signal);
      if(id!==state.operation)return;
      if(!result.interface?.id)throw Error('服务未返回有效的接口配置。');
      state.rows=state.rows.filter(row=>row.id!==result.interface.id).concat(result.interface);fill(result.interface);renderOverview();message('接口已保存。下一步可测试连接并核查映射。');
    }else if(action==='test'){
      state.test=null;renderPreview();
      const result=await api('/api/interfaces/'+selected.id+'/test','POST',{},state.controller.signal);
      if(id!==state.operation)return;
      if(!Array.isArray(result.preview)||!Number.isInteger(result.validRows))throw Error('接口测试返回格式无效。');
      state.test=result;
      selected.lastStatus=result.rejectedRows>0||(result.warnings||[]).length?'warning':'success';selected.lastCheckedAt=result.checkedAt||'';selected.lastError='';
      $('sa-checked').textContent='最近检查：'+(result.checkedAt||'本次')+' · '+statusLabel(selected);
      renderList();renderPreview();message(result.rejectedRows>0||(result.warnings||[]).length?'接口已读取，存在数据警告；请修正后重新测试。':'接口测试完成，未发布或改写展示数据。',result.rejectedRows>0||(result.warnings||[]).length>0);
    }else{
      await window.FuyuStudio?.flushDraft?.();
      if(id!==state.operation)return;
      const result=await api('/api/interfaces/'+selected.id+'/apply','POST',{},state.controller.signal);
      if(id!==state.operation)return;
      document.dispatchEvent(new CustomEvent('fuyu-interface-applied',{detail:result}));
      state.test=null;renderPreview();message('数据已写入后台草稿。请返回“界面编辑”核查，确认后再发布前端。');
    }
  }catch(error){if(id===state.operation){if(action==='test'||action==='apply'){state.test=null;renderPreview();}message(error.name==='AbortError'?'操作已停止或超时。保存或应用可能已在服务端完成，请刷新后核查。':error.message,true);}}
  finally{if(id===state.operation){$('sa-key').value='';$('sa-clear-key').checked=false;state.busy=false;state.controller=null;updateButtons();}}
}
function open(){
  if(state.open)return;
  state.open=true;state.returnFocus=document.activeElement;document.dispatchEvent(new Event('fuyu-settings-opening'));
  for(const dialog of [$('fuyu-settings-dialog'),$('fuyu-knowledge-dialog')])if(dialog?.open)hide(dialog);
  show($('fuyu-system-admin'));message('');setTab(state.tab);reload();
}
function close(){
  state.controller?.abort();state.controller=null;++state.operation;++state.load;state.busy=false;state.open=false;
  $('sa-key').value='';$('sa-clear-key').checked=false;hide($('fuyu-system-admin'));updateButtons();state.returnFocus?.focus?.();
}
const button=document.createElement('button');button.id='fuyu-system-admin-open';button.type='button';button.className='sa-trigger';button.innerHTML=icon+'<span>系统管理</span>';button.setAttribute('aria-label','系统管理');button.title='管理知识库与数据接口';topbar.insertBefore(button,topbar.querySelector('#open-display-btn'));button.onclick=open;
const dialog=document.createElement('dialog');dialog.id='fuyu-system-admin';dialog.className='sa-dialog';dialog.setAttribute('aria-labelledby','sa-title');
dialog.innerHTML='<header><div><span class="sa-eyebrow">FUYU · SYSTEM ADMINISTRATION</span><h2 id="sa-title">系统管理</h2><p>整体界面、知识库与业务数据的控制入口</p></div><button type="button" data-sa-action="close" class="sa-close" aria-label="关闭系统管理">×</button></header><nav id="sa-nav" class="sa-nav" role="tablist" aria-label="系统管理类别"><button type="button" data-sa-tab="overview" class="active" role="tab" aria-selected="true">系统概览</button><button type="button" data-sa-tab="interfaces" role="tab" aria-selected="false">数据接口</button><button type="button" class="sa-refresh" data-sa-action="refresh">刷新状态</button></nav><div class="sa-body"><section id="sa-overview"></section><section id="sa-connectors" hidden><aside class="sa-list-pane"><div class="sa-list-heading"><span id="sa-interface-count">0 个接口</span><button type="button" id="sa-new" data-sa-action="new">＋ 新建接口</button></div><div id="sa-interface-list" class="sa-interface-list"></div><p class="sa-list-note">仅支持只读 JSON。停用后保留配置；不会定时请求或删除源数据。</p></aside><div class="sa-interface-editor"><div class="sa-editor-heading"><div><span>READ-ONLY JSON CONNECTOR</span><h3 id="sa-editor-title">新建接口</h3></div><label class="sa-switch"><input id="sa-enabled" type="checkbox" checked>启用接口</label></div><div id="sa-interface-form" class="sa-form"><label>接口名称<input id="sa-name" maxlength="100" placeholder="例如：风机施工进度"></label><label>单位工程<select id="sa-unit">'+Object.entries(unitNames).map(([key,name])=>'<option value="'+key+'">'+name+'</option>').join('')+'</select></label><label class="sa-wide">JSON 接口 URL<input id="sa-url" type="url" maxlength="2000" placeholder="https://example.com/api/progress"><small>HTTPS；本机调试可用 HTTP 回环地址。认证密钥请填在独立密钥栏。</small></label><label>响应数组路径<input id="sa-array-path" maxlength="300" placeholder="data.items"><small>点分隔字段路径；根响应为数组时留空。</small></label><label>对象 ID 字段<input id="sa-id-field" maxlength="300" value="id" placeholder="id"><small>例如 id 或 asset.code，对应 F08、SS-G01 等既有对象。</small></label><label class="sa-wide">字段映射 · 目标字段 : 源 JSON 路径<textarea id="sa-fields" rows="5" spellcheck="false" aria-label="接口字段映射 JSON"></textarea><small>percent 实际比例、planned 计划比例、label 名称、location 位置、group 分区、actual 已报工序、status 状态。比例使用 0–100 数值。</small></label><label class="sa-wide">Bearer 认证密钥（可选）<input id="sa-key" type="password" maxlength="256" autocomplete="new-password" spellcheck="false"><small id="sa-key-state">未配置认证密钥</small></label><label class="sa-clear-label sa-wide"><input id="sa-clear-key" type="checkbox">清除已保存密钥<small>留空保留原密钥；密钥不回显，也不写入布局配置。</small></label></div><div class="sa-connector-actions"><button type="button" id="sa-save" data-sa-action="save" class="sa-primary">保存接口</button><button type="button" id="sa-test" data-sa-action="test">测试连接</button><span id="sa-checked">尚未进行连接测试</span></div><p id="sa-form-message" class="sa-inline-error"></p><div id="sa-preview" class="sa-preview"></div><div class="sa-apply-bar"><p id="sa-apply-hint"></p><button type="button" id="sa-apply" data-sa-action="apply">应用到后台草稿</button></div></div></section><div id="sa-message" class="sa-message" role="status" aria-live="polite"></div></div><footer><span>接口应用只写草稿 · 发布后展示端生效</span><button type="button" data-sa-action="editor">返回界面编辑</button><button type="button" data-sa-action="close">关闭</button></footer>';
document.body.appendChild(dialog);
dialog.addEventListener('cancel',event=>{event.preventDefault();close();});
dialog.addEventListener('close',()=>{$('sa-key').value='';$('sa-clear-key').checked=false;});
dialog.addEventListener('click',event=>{
  const tab=event.target.closest('[data-sa-tab]');if(tab){setTab(tab.dataset.saTab);return;}
  const row=event.target.closest('[data-sa-select]');if(row&&!state.busy){fill(state.rows.find(item=>item.id===row.dataset.saSelect));message('');return;}
  const action=event.target.closest('[data-sa-action]')?.dataset.saAction;if(!action)return;
  if(['save','test','apply'].includes(action)){operate(action);return;}
  switch(action){case'close':close();break;case'new':if(!state.busy){fill();message('');}break;case'refresh':if(!state.busy)reload();break;case'editor':close();$('edit-mode-btn')?.focus();break;case'interfaces':setTab('interfaces');break;case'knowledge':if(window.FuyuKnowledge?.open){close();window.FuyuKnowledge.open();}else message('知识库管理尚未载入，请刷新后台或使用最新启动器。',true);break;}
});
for(const eventName of ['input','change'])dialog.addEventListener(eventName,event=>{if(event.target.closest('#sa-interface-form')||event.target.id==='sa-enabled')resetTest();});
fill();renderOverview();
window.FuyuSystemAdmin={open,refresh:()=>{if(state.open&&!state.busy)return reload();}};
})();
