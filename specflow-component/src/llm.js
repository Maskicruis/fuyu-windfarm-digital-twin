'use strict';
const { consume } = require('../ui-modules/stream-client');
/** LLM 接入层：OpenAI 兼容 /chat/completions（可对接 DeepSeek、vLLM、Ollama、任意兼容服务） */
function normalizeBase(baseUrl) {
  if (!String(baseUrl || '').trim()) return '';
  const url = new URL(chatEndpoint(baseUrl));
  url.pathname = url.pathname.replace(/\/chat\/completions$/, '');
  return url.toString().replace(/\/$/, '');
}
function chatEndpoint(baseUrl) {
  const url = new URL(String(baseUrl || '').trim());
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) throw Error('模型地址须为 HTTP(S) 地址，密钥请填写在 API Key 栏。');
  let path = url.pathname.replace(/\/{2,}/g,'/').replace(/\/+$/, '');
  if (isSiliconFlow(url.hostname) && ['', '/chat/completions'].includes(path)) path = '/v1' + path;
  if (!path.endsWith('/chat/completions')) {
    if (!path && url.hostname.toLowerCase() !== 'api.deepseek.com') path = '/v1';
    path += '/chat/completions';
  }
  url.pathname = path; url.hash = '';
  return url.toString();
}
function isSiliconFlow(host){return ['api.siliconflow.cn','api.siliconflow.com'].includes(String(host).toLowerCase());}
function resourceEndpoint(baseUrl,resource){const url=new URL(chatEndpoint(baseUrl));url.pathname=url.pathname.replace(/\/chat\/completions$/,'/'+resource);return url.toString();}
function mergeLlm(current={},patch={}){
 const next={...current,...patch};
 const origin=base=>{try{return new URL(base).origin;}catch{return '';}};
 if(next.baseUrl&&current.apiKey&&origin(next.baseUrl)!==origin(current.baseUrl)&&!Object.hasOwn(patch,'apiKey'))throw Error('已更换 API 平台，请填写新平台的 API Key；不会沿用原平台的密钥。');
 if(next.baseUrl)chatEndpoint(next.baseUrl);
 if(typeof next.apiKey==='string')next.apiKey=next.apiKey.trim().replace(/^Bearer\s+/i,'');
 return next;
}
function requestBody(cfg,messages,options,stream){
 const body={model:requestModel(cfg,messages),messages,temperature:options.temperature??0.2,stream};
 const host=new URL(cfg.baseUrl).hostname.toLowerCase();
 if(host==='api.deepseek.com')body.thinking={type:cfg.thinking===true?'enabled':'disabled'};
 // SiliconFlow uses enable_thinking, not DeepSeek's thinking object.
 if(isSiliconFlow(host)&&/(?:DeepSeek-V(?:3\.[12]|4)|Qwen3)/i.test(body.model))body.enable_thinking=cfg.thinking===true;
 const tokens=options.maxTokens??cfg.maxTokens??(isSiliconFlow(host)?4096:undefined);
 if(Number.isInteger(tokens)&&tokens>0)body.max_tokens=tokens;
 return body;
}
function httpFailure(response, text, cfg, endpoint) {
  let detail = String(text || '').trim();
  let providerCode='';try { const data = JSON.parse(detail); providerCode=data.code||data.error?.code||'';detail = typeof data==='string'?data:(data.error?.message || data.message || (typeof data.error==='string'?data.error:'') || providerCode || ''); } catch {}
  if(providerCode)detail='平台代码 '+String(providerCode).slice(0,80)+'：'+detail;
  if (cfg.apiKey) detail = detail.split(String(cfg.apiKey)).join('[密钥已隐藏]');
  detail = detail.replace(/Bearer\s+[^\s"<>]+/gi, 'Bearer [已隐藏]').replace(/<[^>]*>/g, '').slice(0, 350);
  const url = new URL(endpoint), address = url.origin + url.pathname;
  const hints = {400:'请核对平台完整模型 ID、输入长度和该模型支持的参数。',401:'请检查当前平台的 API 密钥。',402:'请检查服务商账户余额。',403:'当前平台或模型未授权，请检查账户权限。',404:'请检查接口地址和平台完整模型 ID；可填写基础地址、/v1 地址或完整 /chat/completions 地址。',429:'服务商请求限额，请稍后重试。'};
  const trace=response.headers?.get('x-siliconcloud-trace-id');if(trace)detail+=' [trace: '+trace.slice(0,100)+']';
  return {ok:false,code:'LLM_HTTP_ERROR',status:response.status,endpoint:address,error:'HTTP '+response.status+'。'+(hints[response.status]||'模型服务返回错误。')+' 请求：'+address+(detail?'；'+detail:'')};
}
function isConfigured(llm) {
  const c = llm || {};
  return !!(String(c.baseUrl || '').trim() && String(c.model || '').trim());
}
function visionModel(llm = {}) {
  if (String(llm.visionModel || '').trim()) return String(llm.visionModel).trim();
  let deepseek = false;
  try { deepseek = new URL(llm.baseUrl).hostname.toLowerCase() === 'api.deepseek.com'; } catch {}
  return deepseek ? 'deepseek-flash' : String(llm.model || '').trim();
}
function hasImages(messages) {
  return messages.some(message => Array.isArray(message.content) && message.content.some(part => part.type === 'image_url'));
}
function requestModel(llm, messages) { return hasImages(messages) ? visionModel(llm) : llm.model; }
async function chat(llm, messages, options = {}) {
  const cfg = llm || {};
  if (!isConfigured(cfg)) return { ok: false, error: '未配置 LLM（请在设置中填写 baseUrl 与 model）', code: 'LLM_NOT_CONFIGURED' };
  let url; try { url = chatEndpoint(cfg.baseUrl); } catch (error) { return {ok:false,code:'LLM_CONFIG_ERROR',error:error.message}; }
  const model = requestModel(cfg, messages);
  const body = requestBody(cfg,messages,options,false);
  const headers = { 'Content-Type': 'application/json' };
  if (String(cfg.apiKey || '').trim()) headers.Authorization = 'Bearer ' + String(cfg.apiKey).trim();
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), Number(cfg.timeoutMs) || 120000);
  try {
    const signal = options.signal ? AbortSignal.any([controller.signal, options.signal]) : controller.signal;
    const res = await fetch(url, { method: 'POST', headers, body: JSON.stringify(body), signal });
    const text = await res.text();
    if (!res.ok) return httpFailure(res, text, cfg, url);
    let data; try { data = JSON.parse(text); } catch { return { ok: false, error: '响应不是合法 JSON', code: 'LLM_BAD_RESPONSE' }; }
    if(data.error||(!data.choices&&data.code))return httpFailure(res,text,cfg,url);
    const content = data && data.choices && data.choices[0] && data.choices[0].message ? data.choices[0].message.content : '';
    return { ok: true, content: String(content || ''), usage: data.usage || null, model, finishReason: data.choices?.[0]?.finish_reason || '' };
  } catch (error) {
    return { ok: false, error: options.signal?.aborted ? '已停止生成' : controller.signal.aborted ? '请求超时' : String(error && error.message || error), code: options.signal?.aborted ? 'LLM_ABORTED' : 'LLM_REQUEST_FAILED' };
  } finally { clearTimeout(timer); }
}
/** 流式对话：SSE 逐块回调 onDelta(text) */
async function chatStream(llm, messages, onDelta, options = {}) {
  const cfg = llm || {};
  if (!isConfigured(cfg)) return { ok: false, error: '未配置 LLM（请在设置中填写 baseUrl 与 model）', code: 'LLM_NOT_CONFIGURED' };
  let url; try { url = chatEndpoint(cfg.baseUrl); } catch (error) { return {ok:false,code:'LLM_CONFIG_ERROR',error:error.message}; }
  const model = requestModel(cfg, messages);
  const body = requestBody(cfg,messages,options,true);
  const headers = { 'Content-Type': 'application/json' };
  if (String(cfg.apiKey || '').trim()) headers.Authorization = 'Bearer ' + String(cfg.apiKey).trim();
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), Number(cfg.timeoutMs) || 120000);
  try {
    const signal = options.signal ? AbortSignal.any([controller.signal, options.signal]) : controller.signal;
    const res = await fetch(url, { method: 'POST', headers, body: JSON.stringify(body), signal });
    if (!res.ok || !res.body) { const text = await res.text().catch(() => ''); return httpFailure(res, text, cfg, url); }
    let full = '', reasoning = '', ended = false, finishReason = '', usage = null;
    await consume(res, frame => {
      if (frame.data === '[DONE]') { ended = true; return; }
      const json = JSON.parse(frame.data);
      if (json.error||(!json.choices&&json.code)) throw new Error(httpFailure(res,JSON.stringify(json),cfg,url).error);
      if (json.usage) usage = json.usage;
      const choice = json.choices?.[0];
      if (choice?.finish_reason) finishReason = choice.finish_reason;
      const delta = choice?.delta || {};
      if (typeof delta.reasoning_content === 'string') { reasoning += delta.reasoning_content; options.onReasoning?.(delta.reasoning_content); }
      if (typeof delta.content === 'string' && delta.content) { full += delta.content; onDelta?.(delta.content); }
      if (full.length + reasoning.length > 2 * 1024 * 1024) throw new Error('模型输出超出大小限制');
    });
    if (!ended && !finishReason) return { ok: false, error: '模型连接中断，回答未完整接收。', code: 'LLM_STREAM_INCOMPLETE' };
    if (!full.trim()) return { ok: false, error: '模型未返回回答正文。', code: 'LLM_EMPTY_RESPONSE' };
    return { ok: true, content: full, model, usage, finishReason, warning: finishReason === 'length' ? '模型输出达到长度限制，回答可能不完整。' : '' };
  } catch (error) {
    return { ok: false, error: options.signal?.aborted ? '已停止生成' : controller.signal.aborted ? '请求超时' : String(error && error.message || error), code: options.signal?.aborted ? 'LLM_ABORTED' : controller.signal.aborted ? 'LLM_TIMEOUT' : 'LLM_REQUEST_FAILED' };
  } finally { clearTimeout(timer); }
}

async function listModels(cfg){
 const target=new URL(resourceEndpoint(cfg.baseUrl,'models'));if(isSiliconFlow(target.hostname))target.searchParams.set('sub_type','chat');
 const url=target.toString(),headers={};if(cfg.apiKey)headers.Authorization='Bearer '+cfg.apiKey;
 try{const res=await fetch(url,{headers,signal:AbortSignal.timeout(20000)}),text=await res.text();if(!res.ok)return httpFailure(res,text,cfg,url);if(text.length>2*1024*1024)throw Error('模型列表响应过大');const data=JSON.parse(text);if(!Array.isArray(data.data))throw Error('平台未返回标准模型列表，可手动填写完整模型 ID');return {ok:true,models:data.data.map(x=>x.id).filter(x=>typeof x==='string').slice(0,2000)};}catch(error){return {ok:false,error:'读取平台模型列表失败：'+error.message,code:'LLM_MODELS_FAILED'};}
}
module.exports = { chat, chatStream, isConfigured, normalizeBase, chatEndpoint, resourceEndpoint, visionModel, requestModel,requestBody,mergeLlm,listModels };
