'use strict';
/** 测试用：最小 OpenAI 兼容 /chat/completions 桩服务，用于验证 LLM 接入链路 */
const http = require('node:http');

/** 确定性伪向量：按字符分布散列到 16 维，便于测试混合检索链路 */
function stubVector(text) {
  const dim = 16; const v = new Array(dim).fill(0);
  const s = String(text || '');
  for (let i = 0; i < s.length; i++) v[s.charCodeAt(i) % dim] += 1;
  const norm = Math.sqrt(v.reduce((sum, x) => sum + x * x, 0)) || 1;
  return v.map(x => x / norm);
}

function createStubLlm(options = {}) {
  const answer = options.answer || '【STUB 回答】依据片段 [1]：消防车道净宽度不应小于 4.0m。[1]';
  const state = { calls: 0, lastBody: null, bodies: [] };
  const server = http.createServer((request, response) => {
    let raw = '';
    request.on('data', chunk => { raw += chunk; });
    request.on('end', () => {
      state.calls++;
      try { state.lastBody = JSON.parse(raw || '{}'); } catch { state.lastBody = null; }
      state.bodies.push(state.lastBody);
      if (options.status) { response.writeHead(options.status, { 'Content-Type': 'application/json' }); return response.end(JSON.stringify({ error: { message: 'stub rejected image' } })); }
      if (String(request.url || '').includes('/embeddings')) {
        state.embeddingCalls = (state.embeddingCalls || 0) + 1;
        const inputs = (state.lastBody && state.lastBody.input) || [];
        const list = Array.isArray(inputs) ? inputs : [inputs];
        const body = {
          object: 'list',
          model: (state.lastBody && state.lastBody.model) || 'stub-embed',
          data: list.map((text, index) => ({ object: 'embedding', index, embedding: stubVector(text) }))
        };
        response.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
        return response.end(JSON.stringify(body));
      }
      const contextRequest = options.imageContext && state.lastBody.messages.some(message => message.role === 'system' && /为规范检索提取图片/.test(message.content));
      const content = contextRequest ? JSON.stringify(options.imageContext) : answer;
      if (state.lastBody && state.lastBody.stream) {
        response.writeHead(200, { 'Content-Type': 'text/event-stream' });
        response.write('data: ' + JSON.stringify({ choices: [{ delta: { content } }] }) + '\n\n');
        return response.end('data: [DONE]\n\n');
      }
      const payload = {
        id: 'stub-chatcmpl', object: 'chat.completion',
        choices: [{ index: 0, message: { role: 'assistant', content }, finish_reason: 'stop' }],
        usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 }
      };
      response.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
      response.end(JSON.stringify(payload));
    });
  });
  return {
    state,
    listen: (port = 0) => new Promise(resolve => server.listen(port, '127.0.0.1', () => resolve(server.address().port))),
    close: () => new Promise(resolve => server.close(resolve))
  };
}

module.exports = { createStubLlm };
