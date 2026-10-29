'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'specflow-stream-'));
process.env.KB_DATA_DIR = path.join(temporary, 'data');
const { createParser, consume, json } = require('../ui-modules/stream-client');
const { chatStream } = require('../src/llm');
const { KnowledgeBaseService } = require('../src/service');
const { createHttpServer } = require('../src/http-server');
test.after(() => fs.rmSync(temporary, { recursive: true, force: true }));

async function upstream(t, handler) {
  const server = http.createServer(handler); await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise(resolve => { server.closeAllConnections(); server.close(resolve); }));
  return { baseUrl: 'http://127.0.0.1:' + server.address().port, model: 'stream-test', timeoutMs: 2000 };
}
function frame(response, delta, finish) { response.write('data: ' + JSON.stringify({ choices: [{ delta, finish_reason: finish || null }] }) + '\r\n\r\n'); }

test('SSE parser handles split CRLF, comments, multiline data and a final frame without blank newline', async () => {
  const events = [], parser = createParser(event => events.push(event));
  for (const char of ': heartbeat\r\nevent: test\r\ndata: one\r\ndata: two\r\n\r\ndata: final') parser.feed(char);
  parser.finish(); assert.deepEqual(events, [{ event: 'test', data: 'one\ntwo' }, { event: 'message', data: 'final' }]);
  const bytes = Buffer.from('data: {"text":"工程设计"}\n\n');
  const body = new ReadableStream({ start(controller) { for (const byte of bytes) controller.enqueue(Uint8Array.of(byte)); controller.close(); } });
  const values = []; await json(new Response(body), value => values.push(value)); assert.equal(values[0].text, '工程设计');
});

test('upstream streaming delivers first text before completion and forwards reasoning separately', async t => {
  let ended = false;
  const cfg = await upstream(t, (request, response) => {
    request.resume(); response.writeHead(200, { 'Content-Type': 'text/event-stream' });
    frame(response, { reasoning_content: '分析图片' }); frame(response, { content: '第一段' });
    setTimeout(() => { frame(response, { content: '第二段' }, 'stop'); ended = true; response.end('data: [DONE]\n\n'); }, 80);
  });
  const deltas = [], reasoning = [];
  const result = await chatStream(cfg, [{ role: 'user', content: 'test' }], text => { if (!deltas.length) assert.equal(ended, false); deltas.push(text); }, { onReasoning: text => reasoning.push(text) });
  assert.equal(result.ok, true); assert.equal(result.content, '第一段第二段'); assert.deepEqual(reasoning, ['分析图片']);
});

test('truncated, malformed and cancelled model streams are not mistaken for complete answers', async t => {
  let stream = 'data: {"choices":[{"delta":{"content":"partial"}}]}\n\n';
  const cfg = await upstream(t, (request, response) => { request.resume(); response.writeHead(200, { 'Content-Type': 'text/event-stream' }); response.end(stream); });
  const incomplete = await chatStream(cfg, [], () => {}); assert.equal(incomplete.code, 'LLM_STREAM_INCOMPLETE');
  stream = 'data: bad-json\n\n'; assert.equal((await chatStream(cfg, [], () => {})).ok, false);
  const abort = new AbortController(); abort.abort(); assert.equal((await chatStream(cfg, [], () => {}, { signal: abort.signal })).code, 'LLM_ABORTED');
});

test('stream request timeout aborts the upstream connection', async t => {
  const cfg = await upstream(t, (request, response) => { request.resume(); response.writeHead(200, { 'Content-Type': 'text/event-stream' }); response.flushHeaders(); });
  const result = await chatStream({ ...cfg, timeoutMs: 50 }, [], () => {}); assert.equal(result.ok, false); assert.equal(result.code, 'LLM_TIMEOUT');
});

test('HTTP forwards live SSE without broadening CORS and persists only completed conversations', async t => {
  let upstreamEnded = false;
  const cfg = await upstream(t, (request, response) => {
    request.resume(); response.writeHead(200, { 'Content-Type': 'text/event-stream' }); frame(response, { reasoning_content: '思考' }); frame(response, { content: '实时内容' });
    setTimeout(() => { upstreamEnded = true; frame(response, { content: '完成' }, 'stop'); response.end('data: [DONE]\n\n'); }, 100);
  });
  const service = new KnowledgeBaseService(); service.updateSettings({ llm: cfg });
  const { server } = createHttpServer({ service }); await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => { service.shutdown(); server.closeAllConnections(); return new Promise(resolve => server.close(resolve)); });
  const base = 'http://127.0.0.1:' + server.address().port;
  const response = await fetch(base + '/api/v1/ask/stream', { method: 'POST', headers: { 'Content-Type': 'application/json', Origin: 'https://untrusted.example' }, body: JSON.stringify({ question: '问候', retrievalMode: 'general' }) });
  assert.equal(response.headers.get('access-control-allow-origin'), null); assert.equal(response.headers.get('x-accel-buffering'), 'no');
  const events = []; await json(response, event => { if (event.type === 'delta' && !events.some(item => item.type === 'delta')) assert.equal(upstreamEnded, false); events.push(event); });
  assert.equal(events.find(event => event.type === 'reasoning').text, '思考');
  const saved = events.find(event => event.type === 'saved'); assert.ok(saved); assert.equal(service.getConversation(saved.conversationId).turns[0].answer, '实时内容完成');
  const controller = new AbortController(); const before = service.conversations.length;
  await service.askStream({ question: '取消测试', retrievalMode: 'general' }, event => { if (event.type === 'delta') controller.abort(); }, { signal: controller.signal });
  assert.equal(service.conversations.length, before);
});
