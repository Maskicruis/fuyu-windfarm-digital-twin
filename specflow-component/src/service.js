'use strict';

const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const { DATA, ROOT, executableAvailable, loadSettings, saveSettings } = require('./config');
const { JobQueue } = require('./job-queue');
const { normalizeOptions: normalizeParserOptions } = require('./mineru-adapter');
const { parseFile } = require('./pipeline');
const { documentToMarkdown, toLegacyItems } = require('./transform');
const { ensureDir, nowIso, readJson, resolveInside, safeName, stripAnsi, writeJson } = require('./utils');
const { version: VERSION } = require('../package.json');
const { RagIndex } = require('./rag');
const { ask: askWithContext, askStream: askStreamContext } = require('./qa');
const embeddings = require('./embeddings');
const { isConfigured: llmConfigured, visionModel } = require('./llm');
const { ChatImages, IMAGE_LIMITS, ImageInputError, DEFAULT_IMAGE_QUESTION, contentText } = require('./chat-images');
const { SCENARIOS } = require('./scenarios');
const { decorateCitation } = require('./citation-links');
const { planQuery } = require('./query-planner');

const DOCUMENTS_FILE = path.join(DATA, 'documents.json');
const GROUPS_FILE = path.join(DATA, 'document-groups.json');
const INBOX = ensureDir(path.join(DATA, 'inbox'));
const WORK = ensureDir(path.join(DATA, 'work'));
const LOGS = ensureDir(path.join(DATA, 'logs'));

class KnowledgeBaseService {
  constructor() {
    this.settings = loadSettings();
    this.documents = readJson(DOCUMENTS_FILE, []);
    if (!Array.isArray(this.documents)) this.documents = [];
    this.groups = readJson(GROUPS_FILE, []);
    if (!Array.isArray(this.groups)) this.groups = [];
    const groupIds = new Set(this.groups.map(group => group.id));
    let changed = false;
    for (const document of this.documents) {
      if (!groupIds.has(document.groupId)) {
        document.groupId = '';
        changed = true;
      }
      if (document.status === 'parsing') {
        document.status = 'error';
        document.progressText = '服务重启，需重试';
        document.error = '上次解析在服务重启时中断';
        document.updatedAt = nowIso();
        changed = true;
      }
    }
    if (changed) this.persist();
    this.rag = new RagIndex(this.settings);
    this.conversationsFile = path.join(DATA, 'conversations.json');
    this.conversations = readJson(this.conversationsFile, []);
    if (!Array.isArray(this.conversations)) this.conversations = [];
    this.chatImages = new ChatImages(DATA);
    this.queue = new JobQueue({ concurrency: 1 });
    this.queue.on('jobError', ({ id, error }) => this.fail(id, error));
    for (const document of this.documents.filter(item => item.status === 'queued')) {
      if (!document.inputPath && document.file) document.inputPath = path.join(INBOX, document.file);
      if (document.inputPath && fs.existsSync(document.inputPath)) {
        this.queue.enqueue(document.id, () => this.process(document));
      } else {
        this.fail(document.id, new Error('排队作业的源 PDF 已不存在'));
      }
    }
  }

  persist() {
    writeJson(DOCUMENTS_FILE, this.documents);
  }

  persistGroups() {
    writeJson(GROUPS_FILE, this.groups);
  }

  publicDocument(document) {
    if (!document) return null;
    const copy = Object.assign({}, document);
    delete copy.inputPath;
    delete copy.outputDir;
    return copy;
  }

  list(options = {}) {
    const hasGroup = options && Object.prototype.hasOwnProperty.call(options, 'groupId');
    const rows = hasGroup ? this.documents.filter(document => String(document.groupId || '') === String(options.groupId || '')) : this.documents;
    return rows.map(document => this.publicDocument(document));
  }

  get(id) {
    return this.documents.find(document => document.id === id) || null;
  }

  paths(document) {
    if (!document) throw new Error('文档不存在');
    const outputDir = path.resolve(document.outputDir || path.join(this.settings.library, document.dirName));
    return {
      outputDir,
      canonical: path.join(outputDir, 'document.json'),
      legacy: path.join(outputDir, 'view.json'),
      corrections: path.join(outputDir, 'corrections.json'),
      markdown: path.join(outputDir, safeName(document.title) + '.md'),
      source: path.join(outputDir, safeName(document.title) + '.pdf'),
      images: path.join(outputDir, 'images')
    };
  }

  validatePdfName(filename) {
    if (path.extname(filename).toLowerCase() !== '.pdf') throw new Error('目前仅支持 PDF 文件');
  }

  createRecord(filename, options = {}) {
    this.validatePdfName(filename);
    const id = 'doc_' + crypto.randomUUID();
    const title = safeName(options.title || path.parse(filename).name);
    const dirName = title + '--' + id.slice(4, 12);
    const outputDir = path.join(this.settings.library, dirName);
    return {
      id,
      file: filename,
      title,
      ext: '.pdf',
      dirName,
      outputDir,
      status: 'queued',
      createdAt: nowIso(),
      updatedAt: nowIso(),
      progress: 0,
      progressText: '排队中',
      groupId: this.validGroupId(options.groupId),
      parserOptions: Object.assign({}, this.settings.parser, options.parser || {})
    };
  }

  verifyPdf(file) {
    const descriptor = fs.openSync(file, 'r');
    try {
      const header = Buffer.alloc(5);
      fs.readSync(descriptor, header, 0, 5, 0);
      if (header.toString('ascii') !== '%PDF-') throw new Error('文件内容不是有效的 PDF');
    } finally {
      fs.closeSync(descriptor);
    }
  }

  createFromBuffer(filename, buffer, options = {}) {
    const document = this.createRecord(filename, options);
    const inputPath = resolveInside(INBOX, document.id + '.pdf');
    fs.writeFileSync(inputPath, buffer);
    try {
      this.verifyPdf(inputPath);
    } catch (error) {
      fs.rmSync(inputPath, { force: true });
      throw error;
    }
    document.inputPath = inputPath;
    this.documents.push(document);
    this.persist();
    this.enqueue(document);
    return this.publicDocument(document);
  }

  createFromPath(sourcePath, options = {}) {
    const resolved = path.resolve(sourcePath);
    if (!fs.existsSync(resolved) || !fs.statSync(resolved).isFile()) throw new Error('源文件不存在: ' + resolved);
    const document = this.createRecord(path.basename(resolved), options);
    const inputPath = resolveInside(INBOX, document.id + '.pdf');
    fs.copyFileSync(resolved, inputPath);
    try {
      this.verifyPdf(inputPath);
    } catch (error) {
      fs.rmSync(inputPath, { force: true });
      throw error;
    }
    document.inputPath = inputPath;
    this.documents.push(document);
    this.persist();
    this.enqueue(document);
    return this.publicDocument(document);
  }

  enqueue(document) {
    document.status = 'queued';
    document.progress = 0;
    document.progressText = '排队中';
    document.updatedAt = nowIso();
    this.persist();
    this.queue.enqueue(document.id, () => this.process(document));
  }

  retry(id) {
    const document = this.get(id);
    if (!document) throw new Error('文档不存在');
    if (this.queue.has(id)) throw new Error('该作业已在队列中');
    this.enqueue(document);
    return this.publicDocument(document);
  }

  log(id, text) {
    fs.appendFileSync(path.join(LOGS, id + '.log'), stripAnsi(text) + '\n', 'utf8');
  }

  fail(id, error) {
    const document = this.get(id);
    if (!document) return;
    document.status = 'error';
    document.progressText = '失败';
    document.error = String(error && error.message || error).slice(-3000);
    document.updatedAt = nowIso();
    this.persist();
    this.log(id, 'ERROR ' + document.error);
  }

  async process(document) {
    document.status = 'parsing';
    document.progressText = '分析版面…';
    document.error = '';
    document.updatedAt = nowIso();
    this.persist();
    if (!executableAvailable(this.settings.mineru)) {
      throw new Error('未找到 MinerU 解析引擎。请运行工具目录中的 setup-mineru.ps1，或在页面中填写 mineru.exe 的完整路径后重试。');
    }
    const workDir = resolveInside(WORK, document.id);
    if (fs.existsSync(workDir)) fs.rmSync(workDir, { recursive: true, force: true });
    ensureDir(workDir);
    const paths = this.paths(document);
    const corrections = readJson(paths.corrections, {});
    let lastSave = 0;
    const touch = () => {
      if (Date.now() - lastSave > 800) {
        lastSave = Date.now();
        document.updatedAt = nowIso();
        this.persist();
      }
    };
    const result = await parseFile({
      id: document.id,
      title: document.title,
      sourceName: document.file,
      inputPath: document.inputPath,
      workDir,
      outputDir: paths.outputDir,
      executable: this.settings.mineru,
      parserOptions: document.parserOptions,
      corrections,
      onProgress: progress => {
        document.progress = progress;
        document.progressText = '解析中 ' + progress + '%';
        touch();
      },
      onLog: tail => {
        document.logTail = stripAnsi(tail).slice(-1200);
        touch();
      }
    });
    document.status = 'ready';
    document.progress = 100;
    document.progressText = '完成';
    document.updatedAt = nowIso();
    document.pages = result.document.document.pageCount;
    document.chars = result.document.items.reduce((sum, item) => sum + String(item.text || item.html || '').length, 0);
    document.images = result.document.items.filter(item => item.type === 'image' || item.type === 'chart').length;
    document.items = result.document.items.length;
    delete document.logTail;
    this.persist();
    this.log(document.id, 'OK ' + JSON.stringify({ pages: document.pages, items: document.items }));
  }

  loadCanonical(id) {
    const document = this.get(id);
    if (!document) throw new Error('文档不存在');
    const value = readJson(this.paths(document).canonical, null);
    if (!value || !Array.isArray(value.items)) throw new Error('文档尚无规范化内容');
    return value;
  }

  updateItem(id, itemId, patch = {}) {
    const record = this.get(id);
    const paths = this.paths(record);
    const canonical = this.loadCanonical(id);
    const item = canonical.items.find(candidate => candidate.id === itemId);
    if (!item) throw new Error('内容块不存在');
    const correction = {};
    if (typeof patch.text === 'string') {
      if (patch.text.length > 2_000_000) throw new Error('修正内容过长');
      item.text = patch.text;
      correction.text = patch.text;
    }
    if (typeof patch.html === 'string') {
      if (patch.html.length > 2_000_000) throw new Error('修正内容过长');
      item.html = patch.html;
      correction.html = patch.html;
    }
    if (!Object.keys(correction).length) throw new Error('没有可更新字段');
    const corrections = readJson(paths.corrections, {});
    corrections[itemId] = Object.assign({}, corrections[itemId] || {}, correction, { updatedAt: nowIso() });
    writeJson(paths.corrections, corrections);
    writeJson(paths.canonical, canonical);
    writeJson(paths.legacy, toLegacyItems(canonical));
    fs.writeFileSync(paths.markdown, documentToMarkdown(canonical), 'utf8');
    record.updatedAt = nowIso();
    this.persist();
    return item;
  }

  updateSettings(patch = {}) {
    const next = Object.assign({}, this.settings);
    if (patch.library) next.library = String(patch.library);
    if (patch.mineru) next.mineru = String(patch.mineru);
    if (patch.port !== undefined) {
      const port = Number(patch.port);
      if (!Number.isInteger(port) || port < 1024 || port > 65535) throw new Error('端口必须是 1024–65535 的整数');
      next.port = port;
    }
    if (patch.host) next.host = String(patch.host);
    if (patch.parser) next.parser = normalizeParserOptions(Object.assign({}, next.parser, patch.parser));
    if (patch.llm) next.llm = Object.assign({}, next.llm, patch.llm);
    this.settings = saveSettings(next);
    this.rag = new RagIndex(this.settings);
    ensureDir(this.settings.library);
    return this.settings;
  }

  deps() { return { rag: this.rag, settings: this.settings, embeddings }; }

  search(query, options = {}) {
    const queryPlan = planQuery(query);
    return this.rag.search(queryPlan.retrievalQuery || query, options).map(decorateCitation);
  }

  searchWithPlan(query, options = {}) {
    const queryPlan = planQuery(query);
    const hits = this.rag.search(queryPlan.retrievalQuery || query, options).map(decorateCitation);
    return { query: String(query || ''), queryPlan, hits };
  }

  validGroupId(groupId) {
    const id = String(groupId || '');
    if (!id) return '';
    if (!this.groups.some(group => group.id === id)) throw new Error('文档分组不存在');
    return id;
  }

  listGroups() {
    return this.groups.map(group => Object.assign({}, group, {
      documentCount: this.documents.filter(document => document.groupId === group.id).length
    }));
  }

  createGroup(name) {
    const value = String(name || '').trim();
    if (!value) throw new Error('分组名称不能为空');
    if (value.length > 80) throw new Error('分组名称不能超过 80 个字符');
    if (this.groups.some(group => group.name.toLowerCase() === value.toLowerCase())) throw new Error('分组名称已存在');
    const group = { id: 'grp_' + crypto.randomUUID(), name: value, createdAt: nowIso(), updatedAt: nowIso() };
    this.groups.push(group);
    this.persistGroups();
    return Object.assign({}, group, { documentCount: 0 });
  }

  updateGroup(id, patch = {}) {
    const group = this.groups.find(item => item.id === id);
    if (!group) throw new Error('文档分组不存在');
    const value = String(patch.name || '').trim();
    if (!value) throw new Error('分组名称不能为空');
    if (value.length > 80) throw new Error('分组名称不能超过 80 个字符');
    if (this.groups.some(item => item.id !== id && item.name.toLowerCase() === value.toLowerCase())) throw new Error('分组名称已存在');
    group.name = value;
    group.updatedAt = nowIso();
    this.persistGroups();
    return Object.assign({}, group, { documentCount: this.documents.filter(document => document.groupId === id).length });
  }

  deleteGroup(id) {
    const index = this.groups.findIndex(item => item.id === id);
    if (index < 0) throw new Error('文档分组不存在');
    const [removed] = this.groups.splice(index, 1);
    let ungrouped = 0;
    for (const document of this.documents) {
      if (document.groupId === id) { document.groupId = ''; document.updatedAt = nowIso(); ungrouped += 1; }
    }
    this.persistGroups();
    if (ungrouped) this.persist();
    return { id: removed.id, name: removed.name, ungroupedDocuments: ungrouped };
  }

  assignDocumentGroup(documentId, groupId) {
    const document = this.get(documentId);
    if (!document) throw new Error('文档不存在');
    document.groupId = this.validGroupId(groupId);
    document.updatedAt = nowIso();
    this.persist();
    return this.publicDocument(document);
  }

  shutdown() {}

  resolveDocumentIds(payload = {}) {
    if (Array.isArray(payload.docIds)) return payload.docIds.map(String);
    if (Object.prototype.hasOwnProperty.call(payload, 'groupId')) {
      const groupId = this.validGroupId(payload.groupId);
      return this.documents.filter(document => String(document.groupId || '') === groupId).map(document => document.id);
    }
    return null;
  }

  normalizeConversation(record) {
    if (!record) return null;
    if (Array.isArray(record.turns)) return record;
    const turn = {
      id: 't_' + crypto.randomUUID(), createdAt: record.createdAt || nowIso(), question: record.question || '',
      answer: record.answer || '', citations: record.citations || [], scenario: record.scenario || 'design',
      mode: record.mode || '', retrieval: record.retrieval || null, retrievalMode: record.retrievalMode || 'auto',
      grounding: record.grounding || '', durationMs: record.durationMs || 0
    };
    return Object.assign({}, record, {
      title: record.title || String(record.question || '历史对话').replace(/\s+/g, ' ').slice(0, 42),
      updatedAt: record.updatedAt || record.createdAt || nowIso(), turns: [turn]
    });
  }

  recordConversation(entry, conversationId) {
    const now = nowIso();
    let index = conversationId ? this.conversations.findIndex(item => item.id === conversationId) : -1;
    let record = index >= 0 ? this.normalizeConversation(this.conversations[index]) : null;
    if (!record) {
      record = {
        id: 'c_' + crypto.randomUUID(),
        title: String(entry.question || '新对话').replace(/\s+/g, ' ').trim().slice(0, 42) || '新对话',
        createdAt: now,
        turns: []
      };
    }
    const turn = Object.assign({ id: 't_' + crypto.randomUUID(), createdAt: now }, entry);
    record.turns.push(turn);
    Object.assign(record, entry, { updatedAt: now });
    if (index >= 0) this.conversations.splice(index, 1);
    this.conversations.unshift(record);
    if (this.conversations.length > 500) this.conversations.length = 500;
    writeJson(this.conversationsFile, this.conversations);
    return record.id;
  }

  listConversations(limit = 50) {
    return this.conversations.slice(0, Math.max(1, Math.min(500, Number(limit) || 50))).map(item => this.normalizeConversation(item));
  }

  getConversation(id) { return this.normalizeConversation(this.conversations.find(item => item.id === id) || null); }

  listConversationSummaries(limit = 50) {
    return this.conversations.slice(0, Math.max(1, Math.min(500, Number(limit) || 50))).map(item => {
      const record = this.normalizeConversation(item);
      return {
        id: record.id, title: record.title, createdAt: record.createdAt, updatedAt: record.updatedAt,
        preview: String(record.answer || record.question || '').replace(/\s+/g, ' ').slice(0, 90),
        turnCount: record.turns.length, scenario: record.scenario || 'design', retrievalMode: record.retrievalMode || 'auto',
        groupId: record.groupId == null ? null : String(record.groupId), docIds: Array.isArray(record.docIds) ? record.docIds : []
      };
    });
  }

  deleteConversation(id) {
    const index = this.conversations.findIndex(item => item.id === id);
    if (index < 0) throw new Error('会话不存在');
    const removed = this.normalizeConversation(this.conversations[index]);
    this.conversations.splice(index, 1);
    writeJson(this.conversationsFile, this.conversations);
    const images = new Set(removed.turns.flatMap(turn => (turn.images || []).map(image => image.id)));
    for (const imageId of images) {
      if (!this.imageInUse(imageId)) {
        try { this.chatImages.remove(imageId); } catch (error) { if (error.code !== 'IMAGE_NOT_FOUND') throw error; }
      }
    }
    return { id };
  }

  conversationHistory(id) {
    const record = id ? this.getConversation(id) : null;
    if (!record) return [];
    return record.turns.flatMap(turn => {
      const rows = [];
      if (turn.question) rows.push({ role: 'user', content: turn.question + (turn.imageContext ? '\n图片识别摘要（待核实）：' + turn.imageContext.text + '\n' + turn.imageContext.searchTerms : ''), images: turn.images || [] });
      if (turn.answer) rows.push({ role: 'assistant', content: turn.answer });
      return rows;
    });
  }

  uploadChatImage(filename, buffer) { return this.chatImages.upload(buffer, filename); }

  chatImage(id) { return this.chatImages.get(id); }

  imageInUse(id) {
    return this.conversations.some(record => this.normalizeConversation(record).turns.some(turn => (turn.images || []).some(image => image.id === id)));
  }

  deleteChatImage(id) {
    if (this.imageInUse(id)) throw new ImageInputError('图片已在会话中使用，请先删除对应会话。', 'IMAGE_IN_USE', 409);
    return this.chatImages.remove(id);
  }

  prepareChat(payload) {
    const images = this.chatImages.resolve(payload.images);
    const question = String(payload.question || '').trim() || (images.length ? DEFAULT_IMAGE_QUESTION : '');
    if (!question) throw new Error('问题不能为空');
    const inputHistory = Array.isArray(payload.history) && payload.history.length ? payload.history : this.conversationHistory(payload.conversationId);
    const history = [];
    let availableBytes = IMAGE_LIMITS.maxTotalBytes - images.reduce((total, image) => total + image.size, 0);
    let availableCount = IMAGE_LIMITS.maxImages - images.length;
    // Keep the newest images first; cap the complete provider request, including past turns.
    for (const row of inputHistory.slice(-12).reverse()) {
      if (!row || !['user', 'assistant'].includes(row.role)) continue;
      const selected = [];
      let omitted = false;
      if (row.role === 'user') {
        for (const image of this.chatImages.resolve(row.images)) {
          if (availableCount > 0 && availableBytes >= image.size) {
            selected.push(image); availableCount--; availableBytes -= image.size;
          } else omitted = true;
        }
      }
      history.unshift({ role: row.role, content: contentText(row.content) + (omitted ? '\n[较早图片超出本轮容量，若需核查细节请重新添加图片。]' : ''), images: this.chatImages.hydrate(selected) });
    }
    return { question, images, modelImages: this.chatImages.hydrate(images), history };
  }

  /** 标准化条目导出：命中块 → 结构化卡片，供设计流程/其它系统消费（联动预留） */
  exportItems(payload = {}) {
    const record = this.get(payload.docId);
    if (!record) throw new Error('文档不存在: ' + payload.docId);
    const canonical = this.loadCanonical(record.id);
    const wanted = Array.isArray(payload.itemIds) && payload.itemIds.length ? new Set(payload.itemIds) : null;
    const items = (canonical.items || []).filter(item => !wanted || wanted.has(item.id));
    return {
      schemaVersion: '1.0',
      kind: 'item-cards',
      document: { id: record.id, title: record.title, sourceName: record.sourceName || record.file || '' },
      cards: items.map(item => ({
        itemId: item.id,
        page: item.page,
        type: item.type,
        ref: (String(item.text || '').match(/^\s*(\d+(?:\.\d+){0,3})/) || [])[1] || '',
        text: item.text || '',
        html: item.html || '',
        asset: item.asset || '',
        caption: item.caption || '',
        bbox: item.bbox ? item.bbox.pdf : null,
        bboxNormalized: item.bbox ? item.bbox.normalized : null,
        locate: { docId: record.id, page: item.page, itemId: item.id, bbox: item.bbox ? item.bbox.pdf : null, bboxNormalized: item.bbox ? item.bbox.normalized : null }
      })).map(decorateCitation)
    };
  }

  capabilities() {
    return {
      apiVersion: 'v1',
      product: 'specflow-knowledge-component',
      version: VERSION,
      features: [
        'pdf-parse(mineru)', 'canonical-document', 'page-bbox-coordinates',
        'local-search(bm25)', 'hybrid-search(bm25+embedding, optional)', 'llm-qa', 'llm-stream',
        'citation-jump-highlight', 'inline-citation-links', 'desktop-citation-handoff', 'conversation-history', 'multi-turn-chat',
        'image-paste', 'multimodal-chat', 'image-aware-retrieval',
        'stream-forwarding', 'stream-cancellation',
        'document-groups', 'group-scoped-retrieval', 'general-llm-fallback', 'item-export',
        'semantic-query-expansion', 'ambiguity-clarification'
      ],
      retrieval: { default: 'bm25', hybrid: embeddings.isConfigured(this.settings.llm) ? 'available' : 'requires embeddingModel' },
      images: { ...IMAGE_LIMITS, formats: ['image/png', 'image/jpeg', 'image/gif', 'image/webp'], visionModel: visionModel(this.settings.llm) },
      schemas: {
        ask: 'schemas/ask-response.schema.json',
        askRequest: 'schemas/ask-request.schema.json',
        chatImage: 'schemas/chat-image.schema.json',
        citation: 'schemas/citation.schema.json',
        search: 'schemas/search-response.schema.json',
        itemExport: 'schemas/item-export.schema.json'
      },
      endpoints: [
        { method: 'GET', path: '/api/v1/capabilities', desc: '能力与 schema 清单（供外部系统发现）' },
        { method: 'GET', path: '/api/v1/search?q=&topK=&doc=&group=', desc: '语义查询规划 + 本地检索（可按文档或分组限定）' },
        { method: 'POST', path: '/api/v1/ask', desc: '问答（结构化引用）' },
        { method: 'POST', path: '/api/v1/ask/stream', desc: '问答（SSE 流式）' },
        { method: 'POST', path: '/api/v1/chat/images', desc: '上传聊天图片（原始二进制，X-File-Name）' },
        { method: 'GET/DELETE', path: '/api/v1/chat/images/:id', desc: '查看图片或删除尚未使用的附件' },
        { method: 'GET', path: '/api/v1/conversations', desc: '会话历史' },
        { method: 'GET/POST', path: '/api/v1/groups', desc: '文档分组列表与创建' },
        { method: 'PATCH/DELETE', path: '/api/v1/groups/:id', desc: '重命名或删除文档分组' },
        { method: 'PATCH', path: '/api/v1/documents/:id', desc: '设置文档所属分组' },
        { method: 'POST', path: '/api/v1/export/items', desc: '导出结构化条目卡片（联动预留）' },
        { method: 'GET', path: '/api/v1/documents/:id/content', desc: 'canonical 文档' },
        { method: 'GET', path: '/api/v1/documents/:id/source', desc: '原 PDF' }
      ]
    };
  }

  async ask(payload = {}) {
    const { question, images, modelImages, history } = this.prepareChat(payload);
    const started = Date.now();
    const result = await askWithContext({
      question,
      scenarioId: payload.scenario,
      topK: payload.topK,
      docIds: this.resolveDocumentIds(payload),
      retrievalMode: payload.retrievalMode,
      images: modelImages,
      history
    }, this.deps());
    if (!result.ok) return Object.assign({ question, images }, result);
    const conversationId = this.recordConversation({
      question,
      scenario: result.scenario,
      mode: result.mode,
      answer: result.answer || '',
      images,
      imageContext: result.imageContext || null,
      model: result.model || '',
      citations: result.citations || [],
      retrieval: result.retrieval || null,
      queryPlan: result.queryPlan || null,
      retrievalMode: result.retrievalMode || 'auto',
      grounding: result.grounding || '',
      durationMs: Date.now() - started,
      groupId: Object.prototype.hasOwnProperty.call(payload, 'groupId') ? String(payload.groupId || '') : null,
      docIds: Array.isArray(payload.docIds) ? payload.docIds.map(String) : []
    }, payload.conversationId);
    return Object.assign({ conversationId, question, images }, result);
  }

  /** 流式问答（SSE）：emit 事件；结束时写入会话历史 */
  async askStream(payload = {}, emit = () => {}, options = {}) {
    let prepared;
    try { prepared = this.prepareChat(payload); } catch (error) { emit({ type: 'error', error: error.message, code: error.code || 'BAD_REQUEST' }); return; }
    const { question, images, modelImages, history } = prepared;
    const started = Date.now();
    let answer = ''; let citations = []; let mode = ''; let retrieval = null; let queryPlan = null; let retrievalMode = payload.retrievalMode || 'auto'; let grounding = ''; let imageContext = null; let model = '';
    await askStreamContext({
      question,
      scenarioId: payload.scenario,
      topK: payload.topK,
      docIds: this.resolveDocumentIds(payload),
      retrievalMode: payload.retrievalMode,
      images: modelImages,
      signal: options.signal,
      history
    }, this.deps(), event => {
      if (event.type === 'citations') { citations = event.citations || []; retrieval = event.retrieval || null; queryPlan = event.queryPlan || null; retrievalMode = event.retrievalMode || retrievalMode; grounding = event.grounding || grounding; imageContext = event.imageContext || null; }
      if (event.type === 'delta') answer += event.text || '';
      if (event.type === 'done') { mode = event.mode || 'llm'; model = event.model || ''; grounding = event.grounding || grounding; retrievalMode = event.retrievalMode || retrievalMode; if (event.answer || event.note) answer = event.answer || event.note; if (event.citations) citations = event.citations; }
      emit(event);
    });
    if (mode && !options.signal?.aborted) {
      const conversationId = this.recordConversation({ question, images, imageContext, model, scenario: payload.scenario || 'design', mode, answer, citations, retrieval, queryPlan, retrievalMode, grounding, durationMs: Date.now() - started, groupId: Object.prototype.hasOwnProperty.call(payload, 'groupId') ? String(payload.groupId || '') : null, docIds: Array.isArray(payload.docIds) ? payload.docIds.map(String) : [] }, payload.conversationId);
      emit({ type: 'saved', conversationId });
    }
  }

  scenarios() { return SCENARIOS; }

  llmStatus() {
    const llm = this.settings.llm || {};
    return { configured: llmConfigured(llm), baseUrl: llm.baseUrl || '', model: llm.model || '', visionModel: visionModel(llm), hasKey: !!String(llm.apiKey || '').trim() };
  }

  health() {
    try { this.rag.build(); } catch (error) { /* 索引构建失败不影响健康检查 */ }
    return {
      service: 'knowledge-base-tool',
      status: 'ok',
      version: VERSION,
      apiVersion: 'v1',
      library: this.settings.library,
      parserAvailable: executableAvailable(this.settings.mineru),
      mineru: {
        command: this.settings.mineru,
        available: executableAvailable(this.settings.mineru),
        setupScript: path.join(ROOT, 'setup-mineru.ps1')
      },
      capabilities: ['pdf', 'mineru', 'canonical-content', 'pdf-highlight', 'job-queue', 'local-search(bm25)', 'llm-qa', 'citation-jump-highlight'],
      llm: this.llmStatus(),
      retrieval: { default: 'bm25', hybrid: embeddings.isConfigured(this.settings.llm) ? 'available' : 'requires embeddingModel' },
      conversations: this.conversations.length,
      index: { entries: this.rag.loaded, documents: this.rag.docs.length },
      queue: this.queue.snapshot()
    };
  }
}

module.exports = { KnowledgeBaseService };
