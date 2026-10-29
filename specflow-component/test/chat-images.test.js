'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'specflow-image-tests-'));
process.env.KB_ROOT = path.resolve(__dirname, '..');
process.env.KB_DATA_DIR = path.join(root, 'data');
const { ChatImages, inspectImage, IMAGE_LIMITS } = require('../src/chat-images');
const { visionModel, requestModel } = require('../src/llm');
const { KnowledgeBaseService } = require('../src/service');
const { createHttpServer } = require('../src/http-server');
const { createStubLlm } = require('./stub-llm-server');
const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Wl6BkoAAAAASUVORK5CYII=', 'base64');

test.after(() => fs.rmSync(root, { recursive: true, force: true }));

function configure(service, port, patch = {}) {
  service.updateSettings({ library: path.join(root, 'library'), llm: { baseUrl: 'http://127.0.0.1:' + port + '/v1', model: 'text-model', visionModel: 'vision-model', apiKey: '', embeddingModel: '', ...patch } });
}

test('image storage uses actual formats and rejects invalid data, oversized images and unsafe IDs', () => {
  const store = new ChatImages(path.join(root, 'storage'));
  const image = store.upload(png, '..\\..\\截图.txt');
  assert.equal(image.mime, 'image/png');
  assert.equal(image.extension, '.png');
  assert.equal(image.name, '截图.txt');
  assert.equal(image.width, 1);
  assert.deepEqual(fs.readFileSync(store.get(image.id).file), png);
  assert.equal(store.hydrate([image])[0].dataUrl, 'data:image/png;base64,' + png.toString('base64'));
  assert.throws(() => store.get('../settings'), /ID 无效/);
  assert.throws(() => inspectImage(Buffer.from('<svg onload="alert(1)"></svg>')), /有效的/);
  assert.throws(() => inspectImage(Buffer.alloc(IMAGE_LIMITS.maxImageBytes + 1)), /8 MB/);
  const large = Buffer.from(png); large.writeUInt32BE(8193, 16);
  assert.throws(() => inspectImage(large), /8192/);
  assert.throws(() => store.resolve(Array(9).fill(image.id)), /最多添加 8/);
  assert.throws(() => store.resolve([{ dataUrl: 'https://private/image.png' }]), /ID 无效/);
  const bigPng = Buffer.concat([png, Buffer.alloc(7 * 1024 * 1024)]);
  const big = Array.from({ length: 4 }, () => store.upload(bigPng, 'big.png'));
  assert.throws(() => store.resolve(big), /24 MB/);
});

test('DeepSeek image requests select Flash while text requests and custom providers keep their configured models', () => {
  const cfg = { baseUrl: 'https://api.deepseek.com/v1', model: 'deepseek-v4-pro' };
  assert.equal(visionModel(cfg), 'deepseek-flash');
  assert.equal(requestModel(cfg, [{ role: 'user', content: 'text' }]), 'deepseek-v4-pro');
  assert.equal(requestModel(cfg, [{ role: 'user', content: [{ type: 'image_url', image_url: { url: 'data:image/png;base64,AA==' } }] }]), 'deepseek-flash');
  assert.equal(visionModel({ ...cfg, visionModel: 'vision-override' }), 'vision-override');
  assert.equal(visionModel({ baseUrl: 'http://localhost:8000/v1', model: 'local-vision' }), 'local-vision');
});

test('HTTP image-only chat forwards bytes, persists small references and restores images for a later turn', async t => {
  const stub = createStubLlm({ answer: '图片中有一处标高。' });
  const port = await stub.listen(); t.after(() => stub.close());
  const service = new KnowledgeBaseService(); configure(service, port);
  const { server } = createHttpServer({ service });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => { service.shutdown(); return new Promise(resolve => server.close(resolve)); });
  const base = 'http://127.0.0.1:' + server.address().port;
  const upload = await fetch(base + '/api/v1/chat/images', { method: 'POST', headers: { 'X-File-Name': encodeURIComponent('屏幕截图.png') }, body: png });
  assert.equal(upload.status, 201);
  const image = (await upload.json()).data;
  const viewed = await fetch(base + image.previewUrl);
  assert.equal(viewed.headers.get('content-type'), 'image/png');
  assert.equal(viewed.headers.get('cache-control'), 'no-store');
  assert.deepEqual(Buffer.from(await viewed.arrayBuffer()), png);
  const response = await fetch(base + '/api/v1/ask', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ images: [image.id], retrievalMode: 'general' }) });
  assert.equal(response.status, 200);
  const result = (await response.json()).data;
  assert.equal(result.mode, 'llm'); assert.equal(result.model, 'vision-model');
  assert.equal(stub.state.lastBody.model, 'vision-model');
  const user = stub.state.lastBody.messages.at(-1);
  assert.equal(user.role, 'user'); assert.equal(user.content[1].type, 'image_url');
  assert.equal(user.content[1].image_url.url, 'data:image/png;base64,' + png.toString('base64'));
  assert.ok(result.conversationId);
  assert.equal(service.getConversation(result.conversationId).turns[0].images[0].id, image.id);
  assert.doesNotMatch(fs.readFileSync(service.conversationsFile, 'utf8'), /base64|dataUrl/);
  const restart = new KnowledgeBaseService(); t.after(() => restart.shutdown());
  await restart.ask({ question: '请再核对图片中的标高。', conversationId: result.conversationId, retrievalMode: 'general' });
  const historical = stub.state.lastBody.messages.filter(row => row.role === 'user' && Array.isArray(row.content));
  assert.equal(historical.length, 1); assert.equal(historical[0].content[1].image_url.url, user.content[1].image_url.url);
  const inUse = await fetch(base + image.previewUrl, { method: 'DELETE' });
  assert.equal(inUse.status, 409);
  service.deleteConversation(result.conversationId);
  assert.equal((await fetch(base + image.previewUrl)).status, 404);
  const invalid = await fetch(base + '/api/v1/chat/images', { method: 'POST', body: 'not an image' });
  assert.equal(invalid.status, 400);
});

test('image-aware RAG searches extracted terms in the selected group and attaches only real document citations', async t => {
  const stub = createStubLlm({ imageContext: { text: '消防车道净宽度 4m', searchTerms: '消防车道 净宽度' }, answer: '图中尺寸符合所给条文。[1]' });
  const port = await stub.listen(); t.after(() => stub.close());
  const service = new KnowledgeBaseService(); configure(service, port);
  t.after(() => service.shutdown());
  const group = service.createGroup('图像测试规范');
  service.documents.push({ id: 'image_doc', groupId: group.id });
  let scope;
  service.rag = {
    build: () => {},
    search: (query, options) => {
      assert.match(query, /消防车道 净宽度/); scope = options.docIds;
      return [{ docId: 'image_doc', itemId: 'i1', title: '消防规范', page: 1, type: 'text', snippet: '消防车道净宽度不应小于4m。', score: 1 }];
    }
  };
  const image = service.uploadChatImage('drawing.png', png);
  const result = await service.ask({ question: '图中的设计符合规范吗？', images: [image.id], groupId: group.id, retrievalMode: 'auto' });
  assert.equal(stub.state.calls, 2, '识别检索信息，再生成有资料依据的回答');
  assert.deepEqual(scope, ['image_doc']);
  assert.equal(result.imageContext.searchTerms, '消防车道 净宽度');
  assert.equal(result.citations[0].docId, 'image_doc');
  assert.match(stub.state.lastBody.messages.at(-1).content[0].text, /片段 1/);
  assert.equal(stub.state.lastBody.messages.at(-1).content[1].type, 'image_url');
});

test('streaming image input preserves attachments and failed requests do not create a misleading conversation', async t => {
  const stub = createStubLlm({ answer: '流式图像回答' });
  const port = await stub.listen(); t.after(() => stub.close());
  const service = new KnowledgeBaseService(); configure(service, port); t.after(() => service.shutdown());
  const image = service.uploadChatImage('screenshot.png', png);
  const events = [];
  await service.askStream({ images: [image.id], retrievalMode: 'general' }, event => events.push(event));
  assert.equal(events.find(event => event.type === 'delta').text, '流式图像回答');
  const saved = events.find(event => event.type === 'saved');
  assert.equal(service.getConversation(saved.conversationId).turns[0].images[0].id, image.id);
  const rejected = createStubLlm({ status: 400 });
  const rejectedPort = await rejected.listen(); t.after(() => rejected.close());
  configure(service, rejectedPort);
  const before = service.conversations.length;
  const failed = await service.ask({ images: [image.id], retrievalMode: 'general' });
  assert.equal(failed.ok, false); assert.equal(service.conversations.length, before);
  service.updateSettings({ llm: { baseUrl: '', model: '', visionModel: '' } });
  const unconfigured = await service.ask({ images: [image.id], retrievalMode: 'general' });
  assert.equal(unconfigured.ok, false); assert.match(unconfigured.error, /配置模型/);
  assert.equal(service.conversations.length, before);
});
