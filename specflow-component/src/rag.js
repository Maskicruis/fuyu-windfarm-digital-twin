'use strict';
/** 本地检索层：对资料库中各书的 document.json 建索引，BM25 关键词检索；
 *  命中天然携带 文档/页/块/坐标(bbox) —— 供问答引用与“跳转原文高亮”。 */
const fs = require('node:fs');
const path = require('node:path');

function htmlToText(html) {
  return String(html || '').replace(/<[^>]+>/g, ' ').replace(/&nbsp;/g, ' ').replace(/\s+/g, ' ').trim();
}
function tokenize(text) {
  const s = String(text || '').toLowerCase();
  const out = [];
  const words = s.match(/[a-z0-9_]+/g) || [];
  for (const w of words) if (w.length > 1) out.push(w);
  const cjk = s.replace(/[^\u4e00-\u9fff]/g, ' ');
  for (const seg of cjk.split(/\s+/)) {
    if (!seg) continue;
    for (let i = 0; i < seg.length; i++) {
      out.push(seg[i]);
      if (i + 1 < seg.length) out.push(seg.slice(i, i + 2));
    }
  }
  return out;
}
function refOf(text) { const m = String(text || '').match(/^\s*(\d+(?:\.\d+){0,3})/); return m ? m[1] : ''; }

const FLOW_TEXT_TYPES = new Set(['text', 'list']);

function endsCompleteSentence(text) {
  return /[。！？!?]\s*[”’"'）)】》]*\s*$/.test(String(text || ''));
}

function startsNumberedBlock(text) {
  return /^\s*(?:\d+(?:\.\d+){1,5}|\d+[、.)）])(?=\s|[^\d.]|$)/.test(String(text || ''));
}

function joinFlowText(left, right) {
  const a = String(left || '').trimEnd();
  const b = String(right || '').trimStart();
  if (!a) return b;
  if (!b) return a;
  // MinerU may split a Chinese word exactly at a layout-block boundary (for
  // example “相” + “邻”). CJK fragments must be joined without an artificial
  // space; Latin words retain one.
  const separator = /[A-Za-z0-9]$/.test(a) && /^[A-Za-z0-9]/.test(b) ? ' ' : '';
  return a + separator + b;
}

function unionBoxes(boxes) {
  const valid = boxes.filter(box => Array.isArray(box) && box.length >= 4 && box.every(Number.isFinite));
  if (!valid.length) return null;
  return [
    Math.min(...valid.map(box => box[0])),
    Math.min(...valid.map(box => box[1])),
    Math.max(...valid.map(box => box[2])),
    Math.max(...valid.map(box => box[3]))
  ];
}

/**
 * Assemble layout fragments into retrieval units without mutating the
 * canonical document. The first item remains the PDF/highlight anchor.
 */
function assembleFlowEntries(rows, maxChars = 1200) {
  const output = [];
  for (let index = 0; index < rows.length; index++) {
    const seed = rows[index];
    if (!FLOW_TEXT_TYPES.has(seed.type)) {
      output.push(seed);
      continue;
    }
    let text = seed.text;
    const sourceItemIds = [seed.itemId];
    const samePageRows = [seed];
    let cursor = index;
    while (!endsCompleteSentence(text) && text.length < maxChars && cursor + 1 < rows.length) {
      const next = rows[cursor + 1];
      if (!FLOW_TEXT_TYPES.has(next.type)) break;
      if (Number(next.page) - Number(rows[cursor].page) > 1) break;
      if (startsNumberedBlock(next.text)) break;
      text = joinFlowText(text, next.text);
      sourceItemIds.push(next.itemId);
      if (Number(next.page) === Number(seed.page)) samePageRows.push(next);
      cursor += 1;
    }
    output.push(Object.assign({}, seed, {
      text,
      sourceItemIds,
      fragmentCount: sourceItemIds.length,
      bbox: unionBoxes(samePageRows.map(row => row.bbox)),
      bboxNormalized: unionBoxes(samePageRows.map(row => row.bboxNormalized))
    }));
    index = cursor;
  }
  return output;
}

class RagIndex {
  constructor(settings) { this.settings = settings; this.loaded = 0; this.signature = ''; this.entries = []; this.docs = []; this.df = new Map(); this.avgLen = 0; }

  libraryDirs() {
    const lib = this.settings.library;
    if (!fs.existsSync(lib)) return [];
    return fs.readdirSync(lib, { withFileTypes: true })
      .filter(e => e.isDirectory())
      .map(e => path.join(lib, e.name))
      .filter(dir => fs.existsSync(path.join(dir, 'document.json')));
  }

  build(force = false) {
    const dirs = this.libraryDirs();
    const sig = dirs.map(d => d + ':' + fs.statSync(path.join(d, 'document.json')).mtimeMs).join('|') + '|' + this.settings.library;
    if (!force && sig === this.signature && this.entries.length) return this;
    const entries = []; const docs = []; const df = new Map();
    for (const dir of dirs) {
      let doc; try { doc = JSON.parse(fs.readFileSync(path.join(dir, 'document.json'), 'utf8')); } catch { continue; }
      const meta = doc.document || {};
      const docId = meta.id || path.basename(dir);
      docs.push({ id: docId, title: meta.title || path.basename(dir), dir, pageCount: (doc.pages || []).length });
      const rows = [];
      for (const item of (doc.items || [])) {
        const text = item.text || htmlToText(item.html) || item.caption || '';
        if (!text) continue;
        if (['header', 'footer', 'page_number'].includes(item.type)) continue;
        rows.push({
          docId, title: meta.title || '', page: item.page, order: item.order, itemId: item.id, type: item.type,
          ref: refOf(text), text,
          bbox: item.bbox && item.bbox.pdf ? item.bbox.pdf : null,
          bboxNormalized: item.bbox && item.bbox.normalized ? item.bbox.normalized : null,
          asset: item.asset || '', html: item.html || ''
        });
      }
      rows.sort((a, b) => Number(a.page) - Number(b.page) || Number(a.order || 0) - Number(b.order || 0));
      for (const row of assembleFlowEntries(rows)) {
        const text = row.text;
        const toks = tokenize(text);
        if (!toks.length) continue;
        const tf = new Map(); for (const t of toks) tf.set(t, (tf.get(t) || 0) + 1);
        for (const t of tf.keys()) df.set(t, (df.get(t) || 0) + 1);
        entries.push(Object.assign({}, row, { ref: refOf(text), len: toks.length, tf }));
      }
    }
    this.entries = entries; this.docs = docs; this.df = df;
    this.avgLen = entries.length ? entries.reduce((s, e) => s + e.len, 0) / entries.length : 1;
    this.loaded = entries.length; this.signature = sig;
    return this;
  }

  search(query, options = {}) {
    this.build();
    const topK = Math.max(1, Math.min(50, Number(options.topK) || 8));
    const qTokens = [...new Set(tokenize(query))];
    if (!qTokens.length || !this.entries.length) return [];
    const N = this.entries.length; const k1 = 1.5; const b = 0.75;
    const scoped = Array.isArray(options.docIds) ? new Set(options.docIds) : null;
    const scored = [];
    for (const e of this.entries) {
      if (scoped && !scoped.has(e.docId)) continue;
      let score = 0;
      for (const t of qTokens) {
        const f = e.tf.get(t); if (!f) continue;
        const dfv = this.df.get(t) || 0;
        const idf = Math.log(1 + (N - dfv + 0.5) / (dfv + 0.5));
        score += idf * (f * (k1 + 1)) / (f + k1 * (1 - b + b * e.len / this.avgLen));
      }
      if (score > 0) scored.push({ entry: e, score });
    }
    scored.sort((a, b2) => b2.score - a.score);
    // 去重：同一文档同一页同一位置且文本相同的块只保留一次
    const seen = new Set();
    const unique = [];
    for (const hit of scored) {
      const e = hit.entry;
      const key = e.docId + '|' + e.page + '|' + (e.bbox ? e.bbox.map(v => Math.round(v)).join(',') : '-') + '|' + e.text.slice(0, 40);
      if (seen.has(key)) continue;
      seen.add(key); unique.push(hit);
      if (unique.length >= topK) break;
    }
    return unique.map((hit, index) => ({
      n: index + 1, docId: hit.entry.docId, title: hit.entry.title, page: hit.entry.page, itemId: hit.entry.itemId,
      type: hit.entry.type, ref: hit.entry.ref, bbox: hit.entry.bbox, bboxNormalized: hit.entry.bboxNormalized, asset: hit.entry.asset,
      score: Math.round(hit.score * 1000) / 1000,
      snippet: makeSnippet(hit.entry.text, qTokens)
    }));
  }
}

function makeSnippet(text, tokens) {
  const s = String(text || '');
  if (s.length <= 900) return s;
  const lower = s.toLowerCase();
  let at = -1;
  for (const t of tokens) { const i = lower.indexOf(t); if (i >= 0) { at = i; break; } }
  if (at < 0) return s.slice(0, 900) + '…';
  const start = Math.max(0, at - 180);
  return (start > 0 ? '…' : '') + s.slice(start, start + 900) + (start + 900 < s.length ? '…' : '');
}

/** 混合检索：BM25 + 向量（可选）RRF 融合；未配置 embedding 时等价于 BM25 */
async function searchDetailed(index, query, options = {}, deps = {}) {
  index.build();
  const topK = Math.max(1, Math.min(50, Number(options.topK) || 8));
  const pool = Math.max(topK * 4, 20);
  const bm25 = index.search(query, { topK: pool, docIds: options.docIds });
  const meta = { mode: 'bm25', embeddingModel: '', vectors: 0, fused: false };
  const llm = (deps.settings && deps.settings.llm) || deps.llm || null;
  const embeddings = deps.embeddings;
  if (!embeddings || !embeddings.isConfigured(llm)) return { hits: bm25.slice(0, topK), retrieval: meta };
  try {
    const scoped = Array.isArray(options.docIds) ? new Set(options.docIds) : null;
    const rowsByDoc = new Map();
    for (const entry of index.entries) {
      if (scoped && !scoped.has(entry.docId)) continue;
      if (!rowsByDoc.has(entry.docId)) rowsByDoc.set(entry.docId, []);
      rowsByDoc.get(entry.docId).push({ itemId: entry.itemId, text: entry.text, fingerprint: embeddings.fingerprint(entry.text) });
    }
    const queryVector = await embeddings.embed(llm, [query]);
    if (!queryVector.ok) { meta.note = 'embedding 失败，已回退 BM25：' + queryVector.error; return { hits: bm25.slice(0, topK), retrieval: meta }; }
    const qv = queryVector.vectors[0];
    const vectorScores = [];
    let vectorCount = 0;
    for (const [docId, rows] of rowsByDoc) {
      const embedded = await embeddings.embedItems(llm, docId, rows);
      if (!embedded.ok) { meta.note = 'embedding 失败，已回退 BM25：' + embedded.error; return { hits: bm25.slice(0, topK), retrieval: meta }; }
      vectorCount += embedded.vectors.size;
      for (const row of rows) {
        const v = embedded.vectors.get(row.itemId);
        if (!v) continue;
        vectorScores.push({ docId, itemId: row.itemId, score: embeddings.cosine(qv, v) });
      }
    }
    vectorScores.sort((a, b) => b.score - a.score);
    const vectorTop = vectorScores.slice(0, pool);
    const K = 60;
    const fused = new Map();
    bm25.forEach((hit, rank) => {
      const key = hit.docId + '|' + hit.itemId;
      const cur = fused.get(key) || { hit, score: 0, from: [] };
      cur.score += 1 / (K + rank + 1); cur.from.push('bm25'); fused.set(key, cur);
    });
    const entryByKey = new Map(index.entries.map(e => [e.docId + '|' + e.itemId, e]));
    vectorTop.forEach((v, rank) => {
      const key = v.docId + '|' + v.itemId;
      const entry = entryByKey.get(key); if (!entry) return;
      const cur = fused.get(key) || { hit: { docId: entry.docId, title: entry.title, page: entry.page, itemId: entry.itemId, type: entry.type, ref: entry.ref, bbox: entry.bbox, bboxNormalized: entry.bboxNormalized, asset: entry.asset, score: 0, snippet: makeSnippet(entry.text, []) }, score: 0, from: [] };
      cur.score += 1 / (K + rank + 1); cur.from.push('vector'); fused.set(key, cur);
    });
    const hits = [...fused.values()].sort((a, b) => b.score - a.score).slice(0, topK)
      .map((item, index) => Object.assign({}, item.hit, { n: index + 1, score: Math.round(item.score * 10000) / 10000, matched: item.from }));
    meta.mode = 'hybrid'; meta.embeddingModel = String(llm.embeddingModel || ''); meta.vectors = vectorCount; meta.fused = true;
    return { hits, retrieval: meta };
  } catch (error) {
    meta.note = '混合检索异常，已回退 BM25：' + String(error && error.message || error);
    return { hits: bm25.slice(0, topK), retrieval: meta };
  }
}

module.exports = { RagIndex, assembleFlowEntries, endsCompleteSentence, joinFlowText, startsNumberedBlock, tokenize, searchDetailed };
