'use strict';

const fs = require('node:fs');
const http = require('node:http');
const path = require('node:path');
const { DATA, ROOT } = require('./config');
const { KnowledgeBaseService } = require('./service');
const { toLegacyItems } = require('./transform');
const { IMAGE_LIMITS } = require('./chat-images');

let sea = null;
let runningAsSea = false;
try {
  sea = require('node:sea');
  runningAsSea = sea.isSea();
} catch {
  runningAsSea = false;
}

const API_VERSION = 'v1';
const MAX_UPLOAD_BYTES = 300 * 1024 * 1024;
const MAX_JSON_BYTES = 2 * 1024 * 1024;
const MIMES = {
  '.mjs': 'text/javascript; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.svg': 'image/svg+xml'
};

class HttpError extends Error {
  constructor(status, message, code = 'BAD_REQUEST') {
    super(message);
    this.status = status;
    this.code = code;
  }
}

function cors(request, response) {
  const origin = String(request.headers.origin || '');
  if (!origin) return;
  const configured = String(process.env.KB_CORS_ORIGIN || '');
  const sameOrigin = origin === `http://${request.headers.host}` || origin === `https://${request.headers.host}`;
  const allowed = configured === '*' || configured.split(',').map(value => value.trim()).includes(origin);
  if (!sameOrigin && !allowed) return;
  response.setHeader('Access-Control-Allow-Origin', configured === '*' ? '*' : origin);
  response.setHeader('Access-Control-Allow-Headers', 'X-File-Name, X-Group-Id, Content-Type');
  response.setHeader('Access-Control-Allow-Methods', 'GET, POST, PATCH, DELETE, OPTIONS');
  response.setHeader('Vary', 'Origin');
}

function sendJson(response, status, body) {
  const buffer = Buffer.from(JSON.stringify(body));
  response.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': buffer.length,
    'Cache-Control': 'no-store'
  });
  response.end(buffer);
}

function sendBuffer(response, buffer, contentType) {
  response.writeHead(200, {
    'Content-Type': contentType,
    'Content-Length': buffer.length,
    'Cache-Control': 'no-store'
  });
  response.end(buffer);
}

function sendHtml(response, status, html) {
  const buffer = Buffer.from(String(html || ''), 'utf8');
  response.writeHead(status, {
    'Content-Type': 'text/html; charset=utf-8',
    'Content-Length': buffer.length,
    'Cache-Control': 'no-store',
    Pragma: 'no-cache',
    'X-Content-Type-Options': 'nosniff'
  });
  response.end(buffer);
}

function getEmbeddedAsset(key) {
  if (!runningAsSea || !sea.getAssetKeys().includes(key)) return null;
  return Buffer.from(sea.getRawAsset(key));
}

function sendStaticAsset(request, response, key, fallbackFile, contentType) {
  const embedded = getEmbeddedAsset(key);
  if (embedded) return sendBuffer(response, embedded, contentType);
  return sendFile(request, response, fallbackFile, contentType);
}

function success(response, data, status = 200) {
  sendJson(response, status, { ok: true, apiVersion: API_VERSION, data });
}

function failure(response, error) {
  const status = Number(error.status) || (/不存在|尚无/.test(error.message || '') ? 404 : 400);
  sendJson(response, status, {
    ok: false,
    apiVersion: API_VERSION,
    error: { code: error.code || (status === 404 ? 'NOT_FOUND' : 'BAD_REQUEST'), message: String(error.message || error) }
  });
}

function readBody(request, maximum) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    let settled = false;
    request.on('data', chunk => {
      if (settled) return;
      size += chunk.length;
      if (size > maximum) {
        settled = true;
        reject(new HttpError(413, '请求体过大', 'PAYLOAD_TOO_LARGE'));
      } else {
        chunks.push(chunk);
      }
    });
    request.on('end', () => {
      if (!settled) resolve(Buffer.concat(chunks));
    });
    request.on('error', error => {
      if (!settled) reject(error);
    });
  });
}

async function readJsonBody(request) {
  const body = await readBody(request, MAX_JSON_BYTES);
  try {
    return JSON.parse(body.toString('utf8') || '{}');
  } catch {
    throw new HttpError(400, 'JSON 格式无效', 'INVALID_JSON');
  }
}

function sendFile(request, response, file, contentType) {
  if (!file || !fs.existsSync(file) || !fs.statSync(file).isFile()) throw new HttpError(404, '文件不存在', 'NOT_FOUND');
  const stat = fs.statSync(file);
  const range = request.headers.range;
  if (range) {
    const match = /^bytes=(\d*)-(\d*)$/.exec(range);
    if (!match) throw new HttpError(416, 'Range 格式无效', 'INVALID_RANGE');
    const start = match[1] ? Number(match[1]) : 0;
    const end = match[2] ? Math.min(Number(match[2]), stat.size - 1) : stat.size - 1;
    if (start > end || start >= stat.size) throw new HttpError(416, 'Range 超出文件范围', 'INVALID_RANGE');
    response.writeHead(206, {
      'Content-Type': contentType,
      'Content-Length': end - start + 1,
      'Content-Range': `bytes ${start}-${end}/${stat.size}`,
      'Accept-Ranges': 'bytes',
      'Cache-Control': 'no-store',
      Pragma: 'no-cache',
      'X-Content-Type-Options': 'nosniff'
    });
    return fs.createReadStream(file, { start, end }).pipe(response);
  }
  response.writeHead(200, {
    'Content-Type': contentType,
    'Content-Length': stat.size,
    'Accept-Ranges': 'bytes',
    'Cache-Control': 'no-store',
    Pragma: 'no-cache',
    'X-Content-Type-Options': 'nosniff'
  });
  return fs.createReadStream(file).pipe(response);
}

function decodeFileName(value) {
  try {
    return decodeURIComponent(String(value || ''));
  } catch {
    throw new HttpError(400, '文件名编码无效', 'INVALID_FILENAME');
  }
}

function createHttpServer({ service = new KnowledgeBaseService() } = {}) {
  const uiFile = path.join(ROOT, 'ui.html');
  const server = http.createServer(async (request, response) => {
    const url = new URL(request.url, 'http://localhost');
    const pathname = url.pathname;
    cors(request, response);
    if (request.method === 'OPTIONS') {
      response.writeHead(204);
      return response.end();
    }
    try {
      if (pathname === '/') return sendStaticAsset(request, response, 'ui.html', uiFile, 'text/html; charset=utf-8');
      if (pathname === '/brand/specflow-mark.svg') {
        return sendStaticAsset(request, response, 'build/specflow-mark.svg', path.join(ROOT, 'build', 'specflow-mark.svg'), 'image/svg+xml');
      }
      if (pathname === '/brand/app.png') {
        return sendStaticAsset(request, response, 'build/app.png', path.join(ROOT, 'build', 'app.png'), 'image/png');
      }
      if (pathname.startsWith('/lib/')) {
        const filename = path.basename(pathname);
        return sendStaticAsset(request, response, 'lib/' + filename, path.join(ROOT, 'lib', filename), MIMES[path.extname(filename).toLowerCase()] || 'application/octet-stream');
      }
      if (pathname.startsWith('/app/')) {
        const filename = path.basename(pathname);
        if (!['brand-theme.css', 'chat-images.js', 'chat-images.css', 'chat-view.js', 'chat-view.css', 'stream-client.js'].includes(filename)) throw new HttpError(404, '界面模块不存在', 'NOT_FOUND');
        return sendStaticAsset(request, response, 'ui-modules/' + filename, path.join(ROOT, 'ui-modules', filename), MIMES[path.extname(filename).toLowerCase()] || 'application/octet-stream');
      }
      if (pathname === '/open/citation' && request.method === 'GET') {
        const docId = String(url.searchParams.get('doc') || '');
        if (!docId || !service.get(docId)) throw new HttpError(404, '引用文档不存在', 'NOT_FOUND');
        const parseCoordinates = name => {
          const values = String(url.searchParams.get(name) || '').split(',').map(Number);
          return values.length >= 4 && values.slice(0, 4).every(Number.isFinite) ? values.slice(0, 4) : null;
        };
        const payload = {
          docId,
          page: Math.max(1, Number(url.searchParams.get('page')) || 1),
          itemId: String(url.searchParams.get('item') || ''),
          ref: String(url.searchParams.get('ref') || ''),
          bbox: parseCoordinates('bbox'),
          bboxNormalized: parseCoordinates('nbbox')
        };
        setImmediate(() => server.emit('specflow:open-citation', payload));
        const fallback = new URLSearchParams({ openCitation: '1', doc: payload.docId, page: String(payload.page) });
        if (payload.itemId) fallback.set('item', payload.itemId);
        if (payload.ref) fallback.set('ref', payload.ref);
        if (payload.bbox) fallback.set('bbox', payload.bbox.join(','));
        if (payload.bboxNormalized) fallback.set('nbbox', payload.bboxNormalized.join(','));
        return sendHtml(response, 200, '<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width"><title>正在打开 SpecFlow</title><style>body{margin:0;background:#0d0f12;color:#e8ebf2;font:14px system-ui;display:grid;place-items:center;min-height:100vh}.card{max-width:520px;padding:28px;border:1px solid #303746;border-radius:16px;background:#171a20;text-align:center}a{color:#86aaff}</style><div class="card"><h2>已发送到 SpecFlow</h2><p>原文定位已发送到正在运行的 SpecFlow Engineering Studio。</p><p>如果桌面窗口没有响应，请确认 SpecFlow 正在运行，或<a href="/?' + fallback.toString() + '">在浏览器中打开</a>。</p></div><script>setTimeout(function(){window.close()},900)</script>');
      }

      // Stable, versioned interface for agents and external schedulers.
      if (pathname === '/api/v1/health' && request.method === 'GET') return success(response, service.health());
      if (pathname === '/api/v1/settings' && request.method === 'GET') return success(response, service.settings);
      if (pathname === '/api/v1/settings' && request.method === 'PATCH') return success(response, service.updateSettings(await readJsonBody(request)));
      // schema 静态文件（供外部系统读取标准化契约）
      if (pathname.startsWith('/schemas/')) {
        const filename = path.basename(pathname);
        const file = path.join(ROOT, 'schemas', filename);
        if (!fs.existsSync(file)) throw new HttpError(404, 'schema 不存在', 'NOT_FOUND');
        return sendFile(request, response, file, 'application/json; charset=utf-8');
      }

      // 能力与接口清单（联动/发现预留）
      if (pathname === '/api/v1/capabilities' && request.method === 'GET') return success(response, service.capabilities());

      if (pathname === '/api/v1/chat/images' && request.method === 'POST') {
        const filename = decodeFileName(request.headers['x-file-name']) || '图片';
        return success(response, service.uploadChatImage(filename, await readBody(request, IMAGE_LIMITS.maxImageBytes)), 201);
      }
      const chatImage = pathname.match(/^\/api\/v1\/chat\/images\/([^/]+)$/);
      if (chatImage && request.method === 'GET') {
        const image = service.chatImage(decodeURIComponent(chatImage[1]));
        return sendFile(request, response, image.file, image.metadata.mime);
      }
      if (chatImage && request.method === 'DELETE') return success(response, service.deleteChatImage(decodeURIComponent(chatImage[1])));

      // SSE 流式问答
      if (pathname === '/api/v1/ask/stream' && request.method === 'POST') {
        const body = await readJsonBody(request);
        response.writeHead(200, {
          'Content-Type': 'text/event-stream; charset=utf-8',
          'Cache-Control': 'no-cache, no-transform',
          Connection: 'keep-alive',
          'X-Accel-Buffering': 'no'
        });
        response.flushHeaders();
        const controller = new AbortController();
        const cancel = () => controller.abort();
        response.once('close', cancel);
        const send = event => { if (!response.destroyed && !response.writableEnded) response.write('data: ' + JSON.stringify(event) + '\n\n'); };
        const heartbeat = setInterval(() => { if (!response.destroyed) response.write(': heartbeat\n\n'); }, 15000);
        heartbeat.unref();
        try {
          await service.askStream(body || {}, send, { signal: controller.signal });
          if (!response.destroyed) { response.write('event: end\ndata: {}\n\n'); response.end(); }
        } finally { clearInterval(heartbeat); response.off('close', cancel); }
        return;
      }

      // 会话历史
      if (pathname === '/api/v1/conversations' && request.method === 'GET') {
        const items = url.searchParams.get('summary') === '1'
          ? service.listConversationSummaries(url.searchParams.get('limit'))
          : service.listConversations(url.searchParams.get('limit'));
        return success(response, { items });
      }
      let conv = pathname.match(/^\/api\/v1\/conversations\/([^/]+)$/);
      if (conv && request.method === 'GET') {
        const item = service.getConversation(decodeURIComponent(conv[1]));
        if (!item) throw new HttpError(404, '会话不存在', 'NOT_FOUND');
        return success(response, item);
      }
      if (conv && request.method === 'DELETE') return success(response, service.deleteConversation(decodeURIComponent(conv[1])));

      // 文档分类/分组管理
      if (pathname === '/api/v1/groups' && request.method === 'GET') {
        return success(response, {
          items: service.listGroups(),
          ungroupedCount: service.list({ groupId: '' }).length
        });
      }
      if (pathname === '/api/v1/groups' && request.method === 'POST') {
        const body = await readJsonBody(request);
        return success(response, service.createGroup(body.name), 201);
      }
      let group = pathname.match(/^\/api\/v1\/groups\/([^/]+)$/);
      if (group && request.method === 'PATCH') return success(response, service.updateGroup(decodeURIComponent(group[1]), await readJsonBody(request)));
      if (group && request.method === 'DELETE') return success(response, service.deleteGroup(decodeURIComponent(group[1])));

      // 结构化条目导出（与设计流程/其它系统联动预留）
      if (pathname === '/api/v1/export/items' && request.method === 'POST') {
        return success(response, service.exportItems(await readJsonBody(request)));
      }

      // 平台能力：本地检索 / LLM 问答 / 场景 / LLM 状态
      if (pathname === '/api/v1/search' && request.method === 'GET') {
        const q = String(url.searchParams.get('q') || '').trim();
        if (!q) throw new HttpError(400, '缺少 q', 'MISSING_QUERY');
        const topK = Number(url.searchParams.get('topK') || 8);
        const doc = url.searchParams.get('doc');
        const hasGroup = url.searchParams.has('group');
        const docIds = doc ? [doc] : hasGroup ? service.resolveDocumentIds({ groupId: url.searchParams.get('group') }) : null;
        const result = typeof service.searchWithPlan === 'function'
          ? service.searchWithPlan(q, { topK, docIds })
          : { query: q, queryPlan: null, hits: service.search(q, { topK, docIds }) };
        return success(response, Object.assign({ groupId: hasGroup ? url.searchParams.get('group') : null }, result));
      }
      if (pathname === '/api/v1/ask' && request.method === 'POST') {
        const body = await readJsonBody(request);
        const result = await service.ask(body || {});
        return success(response, result, result && result.ok === false ? 502 : 200);
      }
      if (pathname === '/api/v1/scenarios' && request.method === 'GET') return success(response, { scenarios: service.scenarios() });
      if (pathname === '/api/v1/llm' && request.method === 'GET') return success(response, service.llmStatus());

      if ((pathname === '/api/v1/jobs' || pathname === '/api/v1/documents') && request.method === 'GET') {
        const hasGroup = url.searchParams.has('group');
        return success(response, { items: service.list(hasGroup ? { groupId: url.searchParams.get('group') } : {}), queue: service.queue.snapshot() });
      }
      if (pathname === '/api/v1/jobs' && request.method === 'POST') {
        const contentType = String(request.headers['content-type'] || '').toLowerCase();
        let document;
        if (contentType.includes('application/json')) {
          const body = await readJsonBody(request);
          if (!body.sourcePath) throw new HttpError(400, '缺少 sourcePath', 'MISSING_SOURCE_PATH');
          document = service.createFromPath(body.sourcePath, { title: body.title, parser: body.parser, groupId: body.groupId });
        } else {
          const filename = decodeFileName(request.headers['x-file-name']);
          if (!filename) throw new HttpError(400, '缺少 X-File-Name', 'MISSING_FILENAME');
          document = service.createFromBuffer(filename, await readBody(request, MAX_UPLOAD_BYTES), { groupId: request.headers['x-group-id'] || '' });
        }
        return success(response, { job: document }, 202);
      }

      let match = pathname.match(/^\/api\/v1\/jobs\/([^/]+)$/);
      if (match && request.method === 'GET') {
        const document = service.get(decodeURIComponent(match[1]));
        if (!document) throw new HttpError(404, '作业不存在', 'NOT_FOUND');
        return success(response, { job: service.publicDocument(document), queue: service.queue.snapshot() });
      }
      match = pathname.match(/^\/api\/v1\/jobs\/([^/]+)\/retry$/);
      if (match && request.method === 'POST') return success(response, { job: service.retry(decodeURIComponent(match[1])) }, 202);
      match = pathname.match(/^\/api\/v1\/jobs\/([^/]+)\/log$/);
      if (match && request.method === 'GET') {
        const id = decodeURIComponent(match[1]);
        if (!service.get(id)) throw new HttpError(404, '作业不存在', 'NOT_FOUND');
        const logFile = path.join(DATA, 'logs', id + '.log');
        return success(response, { text: fs.existsSync(logFile) ? fs.readFileSync(logFile, 'utf8') : '' });
      }
      match = pathname.match(/^\/api\/v1\/documents\/([^/]+)\/content$/);
      if (match && request.method === 'GET') return success(response, service.loadCanonical(decodeURIComponent(match[1])));
      match = pathname.match(/^\/api\/v1\/documents\/([^/]+)\/markdown$/);
      if (match && request.method === 'GET') {
        const record = service.get(decodeURIComponent(match[1]));
        const file = service.paths(record).markdown;
        if (!fs.existsSync(file)) throw new HttpError(404, 'Markdown 不存在', 'NOT_FOUND');
        return success(response, { title: record.title, markdown: fs.readFileSync(file, 'utf8') });
      }
      match = pathname.match(/^\/api\/v1\/documents\/([^/]+)\/source$/);
      if (match && request.method === 'GET') return sendFile(request, response, service.paths(service.get(decodeURIComponent(match[1]))).source, 'application/pdf');
      match = pathname.match(/^\/api\/v1\/documents\/([^/]+)\/assets\/([^/]+)$/);
      if (match && request.method === 'GET') {
        const record = service.get(decodeURIComponent(match[1]));
        const filename = path.basename(decodeURIComponent(match[2]));
        const file = path.join(service.paths(record).images, filename);
        return sendFile(request, response, file, MIMES[path.extname(filename).toLowerCase()] || 'application/octet-stream');
      }
      match = pathname.match(/^\/api\/v1\/documents\/([^/]+)\/items\/([^/]+)$/);
      if (match && request.method === 'PATCH') {
        const item = service.updateItem(decodeURIComponent(match[1]), decodeURIComponent(match[2]), await readJsonBody(request));
        return success(response, { item });
      }
      match = pathname.match(/^\/api\/v1\/documents\/([^/]+)$/);
      if (match && request.method === 'PATCH') {
        const body = await readJsonBody(request);
        return success(response, { document: service.assignDocumentGroup(decodeURIComponent(match[1]), body.groupId) });
      }

      // Compatibility routes used by the existing browser UI.
      if (pathname === '/api/health') return sendJson(response, 200, Object.assign({ ok: true }, service.health()));
      if (pathname === '/api/settings' && request.method === 'GET') return sendJson(response, 200, { ok: true, settings: service.settings });
      if (pathname === '/api/settings' && request.method === 'POST') return sendJson(response, 200, { ok: true, settings: service.updateSettings(await readJsonBody(request)) });
      if (pathname === '/api/documents') return sendJson(response, 200, { ok: true, docs: service.list(), queue: service.queue.pending.length, running: service.queue.active.size > 0 });
      if (pathname === '/api/import' && request.method === 'POST') {
        const filename = decodeFileName(request.headers['x-file-name']);
        const document = service.createFromBuffer(filename, await readBody(request, MAX_UPLOAD_BYTES), { groupId: request.headers['x-group-id'] || '' });
        return sendJson(response, 202, { ok: true, id: document.id });
      }
      if (pathname === '/api/reparse' && request.method === 'POST') {
        const body = await readJsonBody(request);
        return sendJson(response, 202, { ok: true, document: service.retry(body.id) });
      }
      if (pathname === '/api/view' && request.method === 'GET') {
        const record = service.get(url.searchParams.get('id'));
        const canonical = service.loadCanonical(record && record.id);
        return sendJson(response, 200, { ok: true, title: record.title, items: toLegacyItems(canonical) });
      }
      if (pathname === '/api/md' && request.method === 'GET') {
        const record = service.get(url.searchParams.get('id'));
        const file = service.paths(record).markdown;
        return sendJson(response, 200, { ok: true, title: record.title, md: fs.readFileSync(file, 'utf8') });
      }
      if (pathname === '/api/pdf' && request.method === 'GET') return sendFile(request, response, service.paths(service.get(url.searchParams.get('id'))).source, 'application/pdf');
      if (pathname === '/api/img' && request.method === 'GET') {
        const record = service.get(url.searchParams.get('id'));
        const filename = path.basename(url.searchParams.get('f') || '');
        return sendFile(request, response, path.join(service.paths(record).images, filename), MIMES[path.extname(filename).toLowerCase()] || 'application/octet-stream');
      }
      if (pathname === '/api/fix' && request.method === 'POST') {
        const body = await readJsonBody(request);
        const canonical = service.loadCanonical(body.id);
        const item = canonical.items[Number(body.idx)];
        if (!item) throw new HttpError(400, '内容块索引无效', 'INVALID_ITEM');
        const patch = item.type === 'table' ? { html: String(body.text == null ? '' : body.text) } : { text: String(body.text == null ? '' : body.text) };
        service.updateItem(body.id, item.id, patch);
        return sendJson(response, 200, { ok: true });
      }

      throw new HttpError(404, '接口不存在: ' + pathname, 'NOT_FOUND');
    } catch (error) {
      failure(response, error);
    }
  });
  server.on('close', () => { if (typeof service.shutdown === 'function') service.shutdown(); });
  return { server, service };
}

module.exports = { API_VERSION, HttpError, createHttpServer };
