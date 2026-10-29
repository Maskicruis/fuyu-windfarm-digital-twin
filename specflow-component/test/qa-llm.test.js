'use strict';
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createStubLlm } = require('./stub-llm-server');
const { RagIndex } = require('../src/rag');
const { ask } = require('../src/qa');

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'kb-platform-'));
const library = path.join(root, '资料库');
const docDir = path.join(library, '测试规范--abcd1234');
fs.mkdirSync(docDir, { recursive: true });
const fixture = {
  schemaVersion: '1.0',
  document: { id: 'doc_test', title: '测试规范', sourceName: 't.pdf', createdAt: new Date().toISOString(), pageCount: 2 },
  coordinateSystems: { normalized: { origin: 'top-left', unit: 'ratio', range: [0, 1] }, pdf: { origin: 'bottom-left', unit: 'point' } },
  pages: [
    { number: 1, width: 595, height: 842, items: ['p0001-i000000', 'p0001-i000001'] },
    { number: 2, width: 595, height: 842, items: ['p0002-i000003', 'p0002-i000004', 'p0002-i000005'] }
  ],
  items: [
    { id: 'p0001-i000000', page: 1, order: 0, sourceIndex: 0, type: 'title', text: '消防车道与消防车登高操作场地', headingLevel: 2, bbox: { pdf: [50, 780, 300, 800], normalized: [0.08, 0.05, 0.5, 0.07] } },
    { id: 'p0001-i000001', page: 1, order: 1, sourceIndex: 1, type: 'text', text: '消防车道净宽度不应小于4.0m，净空高度不应小于4.0m，转弯半径不应小于9m。', bbox: { pdf: [50, 700, 420, 740], normalized: [0.08, 0.12, 0.7, 0.17] } },
    { id: 'p0001-i000002', page: 1, order: 2, sourceIndex: 2, type: 'table', html: '<table><tr><td>进站道路宽度</td><td>4.0m</td></tr></table>', bbox: { pdf: [50, 600, 420, 660], normalized: [0.08, 0.21, 0.7, 0.29] } },
    { id: 'p0002-i000003', page: 2, order: 3, sourceIndex: 3, type: 'text', text: '5.2.7 站内外道路的平面布置、设计标高及坡度应协调一致，相', bbox: { pdf: [50, 700, 420, 740], normalized: [0.08, 0.12, 0.7, 0.17] } },
    { id: 'p0002-i000004', page: 2, order: 4, sourceIndex: 4, type: 'text', text: '邻区域竖向布置宜结合自然地形，因地制宜确定竖向布置型式。', bbox: { pdf: [50, 660, 420, 700], normalized: [0.08, 0.17, 0.7, 0.22] } },
    { id: 'p0002-i000005', page: 2, order: 5, sourceIndex: 5, type: 'text', text: '5.2.8 下一条不得串入当前条文。', bbox: { pdf: [50, 620, 420, 660], normalized: [0.08, 0.22, 0.7, 0.27] } }
  ]
};
fs.writeFileSync(path.join(docDir, 'document.json'), JSON.stringify(fixture), 'utf8');

test('BM25 检索：命中携带 页/条文号/坐标', () => {
  const rag = new RagIndex({ library });
  const hits = rag.search('消防车道净宽度', { topK: 5 });
  assert.ok(hits.length >= 1, '至少命中一条');
  assert.equal(hits[0].title, '测试规范');
  assert.equal(hits[0].page, 1);
  assert.ok(Array.isArray(hits[0].bbox) && hits[0].bbox.length === 4, '命中带 bbox');
});

test('未配置 LLM：降级为检索模式并返回引用', async () => {
  const settings = { library, llm: { baseUrl: '', apiKey: '', model: '', timeoutMs: 5000 } };
  const rag = new RagIndex(settings);
  const res = await ask({ question: '进站道路宽度要求', scenarioId: 'design' }, { rag, settings });
  assert.equal(res.mode, 'retrieval');
  assert.ok(res.citations.length >= 1, '返回引用');
  assert.ok(res.citations[0].docId === 'doc_test');
  assert.ok(res.note && res.note.includes('LLM'));
});

test('规范术语含糊时先追问，不让模型直接给工程结论', async () => {
  const stub = createStubLlm();
  const port = await stub.listen();
  const settings = { library, llm: { baseUrl: 'http://127.0.0.1:' + port + '/v1', apiKey: '', model: 'stub-model', timeoutMs: 10000 } };
  const rag = new RagIndex(settings);
  const res = await ask({ question: '综合楼的消防间距和火灾危险性分类是什么？', scenarioId: 'design' }, { rag, settings });
  assert.equal(res.mode, 'clarification');
  assert.equal(res.needsClarification, true);
  assert.match(res.answer, /包含哪些用途/);
  assert.equal(stub.state.calls, 0);
  await stub.close();
});

test('配置 LLM 后：生成式回答并保留可定位引用', async () => {
  const stub = createStubLlm();
  const port = await stub.listen();
  const settings = { library, llm: { baseUrl: 'http://127.0.0.1:' + port + '/v1', apiKey: '', model: 'stub-model', timeoutMs: 10000 } };
  const rag = new RagIndex(settings);
  const res = await ask({ question: '消防车道净宽度要求是多少？', scenarioId: 'design' }, { rag, settings });
  assert.equal(res.mode, 'llm');
  assert.match(res.answer, /STUB/);
  assert.ok(res.citations.length >= 1, '引用不为空');
  assert.ok(res.citations[0].page === 1 && Array.isArray(res.citations[0].bbox), '引用可定位');
  assert.deepEqual(res.citations[0].bboxNormalized, [0.08, 0.12, 0.7, 0.17], '引用包含稳定的归一化高亮坐标');
  assert.deepEqual(res.citations[0].locate.bboxNormalized, res.citations[0].bboxNormalized, '标准定位对象包含归一化坐标');
  assert.match(res.citations[0].sourceUrl, /^\/open\/citation\?/, '引用包含可唤醒 SpecFlow 阅读器的 URL');
  assert.match(res.citations[0].rawSourceUrl, /\/source#page=1$/, '同时保留原始 PDF URL');
  const sent = JSON.stringify(stub.state.lastBody || {});
  assert.match(sent, /片段 1/, '提示词中包含带编号的上下文片段');
  assert.match(sent, /chat\/completions|messages/, '走 OpenAI 兼容接口');
  await stub.close();
});

test('显式空文档范围不会退化为搜索全部资料', () => {
  const rag = new RagIndex({ library });
  assert.deepEqual(rag.search('消防车道净宽度', { topK: 5, docIds: [] }), []);
});

test('连续条文碎片在检索层合并，且不会串入下一条', () => {
  const rag = new RagIndex({ library });
  const hits = rag.search('道路坡度协调', { topK: 1 });
  assert.equal(hits.length, 1);
  assert.equal(hits[0].ref, '5.2.7');
  assert.equal(hits[0].itemId, 'p0002-i000003', 'PDF 定位仍锚定条文起始块');
  assert.match(hits[0].snippet, /一致，相邻区域竖向布置/, '跨块中文连续拼接');
  assert.doesNotMatch(hits[0].snippet, /5\.2\.8/, '遇到下一条文立即停止');
  assert.deepEqual(hits[0].bbox, [50, 660, 420, 740], '同页连续块合并为完整高亮区域');
});

test('智能问答无资料命中时仍调用通用模型', async () => {
  const stub = createStubLlm({ answer: '【STUB 通用回答】这是一个通用知识问题。' });
  const port = await stub.listen();
  const emptyLibrary = path.join(root, '空资料库');
  fs.mkdirSync(emptyLibrary, { recursive: true });
  const settings = { library: emptyLibrary, llm: { baseUrl: 'http://127.0.0.1:' + port + '/v1', apiKey: '', model: 'stub-model', timeoutMs: 10000 } };
  const rag = new RagIndex(settings);
  const res = await ask({
    question: '请解释什么是检索增强生成。',
    scenarioId: 'general',
    retrievalMode: 'auto',
    history: [{ role: 'user', content: '我们刚才讨论了工程规范。' }, { role: 'assistant', content: '好的。' }]
  }, { rag, settings });
  assert.equal(res.mode, 'llm');
  assert.equal(res.grounding, 'general');
  assert.deepEqual(res.citations, []);
  const messages = stub.state.lastBody.messages;
  assert.ok(messages.some(message => message.role === 'user' && message.content === '我们刚才讨论了工程规范。'), '保留多轮上下文');
  assert.match(messages.at(-1).content, /检索增强生成/, '发送当前通用问题');
  await stub.close();
});

test('通用对话跳过资料检索且不生成资料引用', async () => {
  const stub = createStubLlm({ answer: '【STUB】通用回答，不附虚假引用。' });
  const port = await stub.listen();
  const settings = { library, llm: { baseUrl: 'http://127.0.0.1:' + port + '/v1', apiKey: '', model: 'stub-model', timeoutMs: 10000 } };
  const rag = new RagIndex(settings);
  const res = await ask({ question: '写一个简短的项目周报模板。', scenarioId: 'general', retrievalMode: 'general' }, { rag, settings });
  assert.equal(res.retrieval.mode, 'disabled');
  assert.equal(res.grounding, 'general');
  assert.deepEqual(res.citations, []);
  assert.doesNotMatch(JSON.stringify(stub.state.lastBody), /可用资料片段|\[片段 1\]/);
  await stub.close();
});

test('仅资料库模式无命中时不让模型用常识补齐', async () => {
  const stub = createStubLlm();
  const port = await stub.listen();
  const emptyLibrary = path.join(root, '另一空资料库');
  fs.mkdirSync(emptyLibrary, { recursive: true });
  const settings = { library: emptyLibrary, llm: { baseUrl: 'http://127.0.0.1:' + port + '/v1', apiKey: '', model: 'stub-model', timeoutMs: 10000 } };
  const rag = new RagIndex(settings);
  const res = await ask({ question: '资料里没有的问题', scenarioId: 'design', retrievalMode: 'knowledge' }, { rag, settings });
  assert.equal(res.mode, 'empty');
  assert.equal(stub.state.calls, 0);
  await stub.close();
});

test('场景模板：设计/科研/通用', () => {
  const { SCENARIOS, getScenario } = require('../src/scenarios');
  assert.ok(SCENARIOS.length >= 3);
  assert.equal(getScenario('design').id, 'design');
  assert.match(getScenario('research').system, /综述/);
});
