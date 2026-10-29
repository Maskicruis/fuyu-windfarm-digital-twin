'use strict';
const { consume } = require('../ui-modules/stream-client');
/** LLM 接入层：OpenAI 兼容 /chat/completions（可对接 DeepSeek、vLLM、Ollama、任意兼容服务） */
function normalizeBase(baseUrl) {
  let b = String(baseUrl || '').trim();
  if (!b) return '';
  b = b.replace(/\/+$/, '');
  if (!/\/v1$/.test(b) && !/\/chat\/completions$/.test(b)) b += '/v1';
  return b;
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
  const url = normalizeBase(cfg.baseUrl) + '/chat/completions';
  const model = requestModel(cfg, messages);
  const body = { model, messages, temperature: options.temperature == null ? 0.2 : options.temperature, stream: false };
  const headers = { 'Content-Type': 'application/json' };
  if (String(cfg.apiKey || '').trim()) headers.Authorization = 'Bearer ' + String(cfg.apiKey).trim();
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), Number(cfg.timeoutMs) || 120000);
  try {
    const signal = options.signal ? AbortSignal.any([controller.signal, options.signal]) : controller.signal;
    const res = await fetch(url, { method: 'POST', headers, body: JSON.stringify(body), signal });
    const text = await res.text();
    if (!res.ok) return { ok: false, error: 'HTTP ' + res.status + ' ' + text.slice(0, 300), code: 'LLM_HTTP_ERROR' };
    let data; try { data = JSON.parse(text); } catch { return { ok: false, error: '响应不是合法 JSON', code: 'LLM_BAD_RESPONSE' }; }
    const content = data && data.choices && data.choices[0] && data.choices[0].message ? data.choices[0].message.content : '';
    return { ok: true, content: String(content || ''), usage: data.usage || null, model };
  } catch (error) {
    return { ok: false, error: options.signal?.aborted ? '已停止生成' : controller.signal.aborted ? '请求超时' : String(error && error.message || error), code: options.signal?.aborted ? 'LLM_ABORTED' : 'LLM_REQUEST_FAILED' };
  } finally { clearTimeout(timer); }
}
/** 流式对话：SSE 逐块回调 onDelta(text) */
async function chatStream(llm, messages, onDelta, options = {}) {
  const cfg = llm || {};
  if (!isConfigured(cfg)) return { ok: false, error: '未配置 LLM（请在设置中填写 baseUrl 与 model）', code: 'LLM_NOT_CONFIGURED' };
  const url = normalizeBase(cfg.baseUrl) + '/chat/completions';
  const model = requestModel(cfg, messages);
  const body = { model, messages, temperature: options.temperature == null ? 0.2 : options.temperature, stream: true };
  const headers = { 'Content-Type': 'application/json' };
  if (String(cfg.apiKey || '').trim()) headers.Authorization = 'Bearer ' + String(cfg.apiKey).trim();
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), Number(cfg.timeoutMs) || 120000);
  try {
    const signal = options.signal ? AbortSignal.any([controller.signal, options.signal]) : controller.signal;
    const res = await fetch(url, { method: 'POST', headers, body: JSON.stringify(body), signal });
    if (!res.ok || !res.body) { const text = await res.text().catch(() => ''); return { ok: false, error: 'HTTP ' + res.status + ' ' + String(text).slice(0, 200), code: 'LLM_HTTP_ERROR' }; }
    let full = '', reasoning = '', ended = false, finishReason = '', usage = null;
    await consume(res, frame => {
      if (frame.data === '[DONE]') { ended = true; return; }
      const json = JSON.parse(frame.data);
      if (json.error) throw new Error(json.error.message || '模型流式请求失败');
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

module.exports = { chat, chatStream, isConfigured, normalizeBase, visionModel, requestModel };
