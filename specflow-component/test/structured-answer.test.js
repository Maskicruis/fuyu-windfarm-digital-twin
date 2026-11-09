'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'sf-json-'));
process.env.KB_DATA_DIR = path.join(root, 'data');
const { createHttpServer } = require('../src/http-server');
const { SpecFlowKnowledgeClient } = require('../integration/client.cjs');
const { createStubLlm } = require('./stub-llm-server');

const schema = {
  type: 'array',
  items: {
    type: 'object', additionalProperties: false, required: ['startMile', 'childList'],
    properties: {
      startMile: { type: 'string' },
      childList: { type: 'array', items: {
        type: 'object', additionalProperties: false, required: ['nodeCode', 'title'],
        properties: { nodeCode: { type: 'string' }, title: { type: 'string' } }
      } }
    }
  }
};
const data = [{ startMile: 'YK17+004', childList: [{ nodeCode: '209723882444593971201', title: '超前地质钻孔开始' }] }];
const fixture = (result = data, sourceIds = []) => JSON.stringify({ result, sourceIds });
test.after(() => fs.rmSync(root, { recursive: true, force: true }));

test('JSON interface returns raw nested arrays, preserves long string IDs, carries conversation context and exposes a contract', async t => {
  const stub = createStubLlm({ answer: fixture() });
  const port = await stub.listen();
  const { server, service } = createHttpServer();
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(async () => {
    await service.shutdown();
    server.closeAllConnections();
    await Promise.all([stub.close(), new Promise(resolve => server.close(resolve))]);
  });
  service.updateSettings({ llm: { baseUrl: 'http://127.0.0.1:' + port + '/v1', model: 'stub' } });
  const base = 'http://127.0.0.1:' + server.address().port;
  const client = new SpecFlowKnowledgeClient(base);
  const ask = (input, contentType = 'application/json') => fetch(base + '/api/v1/ask/json', {
    method: 'POST', headers: { 'Content-Type': contentType }, body: JSON.stringify(input)
  });
  const question = { question: '提取工程里程和工序记录。', retrievalMode: 'general', responseSchema: schema };
  const raw = await ask({ ...question, responseMode: 'raw' });
  assert.equal(raw.status, 200);
  assert.match(raw.headers.get('content-type'), /^application\/json/);
  assert.equal(raw.headers.get('x-specflow-grounding'), 'general');
  assert.deepEqual(await raw.json(), data);
  const conversationId = raw.headers.get('x-specflow-conversation-id');
  assert.ok(conversationId);
  assert.equal(stub.state.lastBody.stream, false);
  assert.match(stub.state.lastBody.messages[0].content, /JSON Schema/);
  assert.equal(stub.state.calls, 1);
  const envelope = await client.askJson({ ...question, conversationId });
  assert.equal(envelope.data.conversationId, conversationId);
  assert.deepEqual(envelope.data.result, data);
  assert.equal(envelope.data.answer, undefined);
  assert.equal(stub.state.lastBody.messages.find(m => m.role === 'assistant').content, JSON.stringify(data));
  const plain = await client.askJson({ question: '写一句话。', retrievalMode: 'general' });
  assert.equal(plain.data.answer, fixture());
  const capabilities = (await client.capabilities()).data;
  assert.ok(capabilities.features.includes('structured-json-answer'));
  const spec = await (await fetch(base + capabilities.schemas.askJsonOpenApi)).json();
  assert.ok(spec.paths['/api/v1/ask/json'].post.responses['200'].content['application/json']);

  const before = stub.state.calls;
  for (const invalid of [
    { ...question, responseSchema: { ...schema, $ref: 'https://example.com/schema' } },
    { ...question, responseSchema: { ...schema, maxItems: '42' } },
    { ...question, responseSchema: undefined, responseMode: 'raw' }
  ]) {
    const response = await ask(invalid);
    assert.equal(response.status, 400);
    assert.equal((await response.json()).error.code, 'INVALID_RESPONSE_SCHEMA');
  }
  assert.equal((await ask(question, 'text/plain')).status, 415);
  assert.equal(stub.state.calls, before);
});

test('structured JSON errors do not save turns, guess facts or return a partial success', async t => {
  const stub = createStubLlm();
  const port = await stub.listen();
  const { server, service } = createHttpServer();
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(async () => {
    await service.shutdown();
    server.closeAllConnections();
    await Promise.all([stub.close(), new Promise(resolve => server.close(resolve))]);
  });
  service.updateSettings({ llm: { baseUrl: 'http://127.0.0.1:' + port + '/v1', model: 'stub' } });
  const client = new SpecFlowKnowledgeClient('http://127.0.0.1:' + server.address().port);
  const query = { question: '提取工序记录。', retrievalMode: 'general', responseSchema: schema, responseMode: 'raw' };
  const count = service.conversations.length;
  for (const answer of ['{"result":[', fixture([{}]), fixture(data, [42]),
    fixture([{ startMile: 'YK17+004', childList: [{ nodeCode: 209723882444593971201, title: '超前地质钻孔开始' }] }])]) {
    stub.state.answer = answer;
    await assert.rejects(client.askJson(query), { status: 502, code: 'INVALID_MODEL_OUTPUT' });
  }
  stub.state.answer = fixture(null);
  await assert.rejects(client.askJson(query), { status: 422, code: 'NO_STRUCTURED_RESULT' });
  const before = stub.state.calls;
  await assert.rejects(client.askJson({ ...query, retrievalMode: 'knowledge' }), { status: 422, code: 'NO_STRUCTURED_RESULT' });
  assert.equal(stub.state.calls, before);
  assert.equal(service.conversations.length, count);
});

test('grounded JSON supplies verified citation coordinates outside business fields', async () => {
  const stub = createStubLlm({ answer: fixture({ method: '覆盖保湿' }, [1]) });
  const port = await stub.listen();
  try {
    const { compileOutputSchema } = require('../src/structured-answer');
    const { ask } = require('../src/qa');
    const settings = { llm: { baseUrl: 'http://127.0.0.1:' + port + '/v1', model: 'stub' } };
    const hit = { docId: 'doc_foundation', title: '风机基础规范', page: 12, itemId: 'p12', snippet: '5.2.3 承台混凝土养护应采用覆盖保湿。', score: 20, bboxNormalized: [.1, .2, .8, .4] };
    const rag = { entries: [], build() {}, search: () => [hit] };
    const payload = { question: '承台混凝土养护要求', retrievalMode: 'auto',
      outputSchema: compileOutputSchema({ type: 'object', required: ['method'], properties: { method: { type: 'string' } } }) };
    const grounded = await ask(payload, { rag, settings });
    assert.deepEqual(grounded.result, { method: '覆盖保湿' });
    assert.equal(grounded.grounding, 'knowledge');
    assert.deepEqual(grounded.citations[0].bboxNormalized, hit.bboxNormalized);
    assert.equal(grounded.citations[0].page, 12);
    assert.match(stub.state.lastBody.messages[0].content, /不得用常识补齐/);
    stub.state.answer = fixture({ method: '覆盖保湿' }, [2]);
    const invalid = await ask(payload, { rag, settings });
    assert.equal(invalid.code, 'INVALID_MODEL_OUTPUT');
    assert.equal(invalid.result, undefined);
  } finally { await stub.close(); }
});
