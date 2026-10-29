'use strict';
/** 向量层（可选）：OpenAI 兼容 /embeddings。未配置时平台自动回退纯 BM25。
 *  向量缓存写入 data/embeddings/<docId>.json，键为 itemId，含 model 与文本指纹，模型变更时自动失效。 */
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { DATA } = require('./config');
const { ensureDir, readJson, writeJson } = require('./utils');

const CACHE_DIR = path.join(DATA, 'embeddings');
function fingerprint(text) { return crypto.createHash('sha1').update(String(text || '')).digest('hex').slice(0, 16); }
function isConfigured(llm) { const c = llm || {}; return !!(String(c.baseUrl || '').trim() && String(c.embeddingModel || '').trim()); }
function cacheFile(docId) { return path.join(ensureDir(CACHE_DIR), docId + '.json'); }
function loadCache(docId, model) {
  const data = readJson(cacheFile(docId), null);
  if (!data || data.model !== model || !data.vectors) return {};
  return data.vectors;
}
function saveCache(docId, model, vectors) { writeJson(cacheFile(docId), { model, updatedAt: new Date().toISOString(), vectors }); }

async function embed(llm, texts) {
  const cfg = llm || {};
  if (!isConfigured(cfg)) return { ok: false, error: '未配置 embedding 模型', code: 'EMBEDDING_NOT_CONFIGURED' };
  const base = String(cfg.baseUrl).replace(/\/+$/, '');
  const url = (/\/v1$/.test(base) ? base : base + '/v1') + '/embeddings';
  const headers = { 'Content-Type': 'application/json' };
  if (String(cfg.apiKey || '').trim()) headers.Authorization = 'Bearer ' + String(cfg.apiKey).trim();
  try {
    const res = await fetch(url, { method: 'POST', headers, body: JSON.stringify({ model: cfg.embeddingModel, input: texts }) });
    const text = await res.text();
    if (!res.ok) return { ok: false, error: 'HTTP ' + res.status + ' ' + text.slice(0, 200), code: 'EMBEDDING_HTTP_ERROR' };
    const data = JSON.parse(text);
    const vectors = (data.data || []).map(item => item.embedding);
    if (vectors.length !== texts.length) return { ok: false, error: '返回向量数量不匹配', code: 'EMBEDDING_BAD_RESPONSE' };
    return { ok: true, vectors };
  } catch (error) { return { ok: false, error: String(error && error.message || error), code: 'EMBEDDING_REQUEST_FAILED' }; }
}

/** 批量获取（带缓存）：返回 { ok, vectors: Map(itemId -> vector) } */
async function embedItems(llm, docId, rows) {
  if (!isConfigured(llm)) return { ok: false, error: '未配置 embedding 模型', code: 'EMBEDDING_NOT_CONFIGURED' };
  const model = String(llm.embeddingModel);
  const cache = loadCache(docId, model);
  const missing = rows.filter(row => cache[row.itemId] == null || row.fingerprint !== (cache[row.itemId].fp || ''));
  const vectors = new Map();
  for (const row of rows) { const hit = cache[row.itemId]; if (hit && hit.fp === row.fingerprint) vectors.set(row.itemId, hit.v); }
  const BATCH = 32;
  for (let i = 0; i < missing.length; i += BATCH) {
    const slice = missing.slice(i, i + BATCH);
    const result = await embed(llm, slice.map(row => row.text.slice(0, 2000)));
    if (!result.ok) return { ok: false, error: result.error, code: result.code, vectors };
    slice.forEach((row, index) => {
      const v = result.vectors[index];
      vectors.set(row.itemId, v);
      cache[row.itemId] = { fp: row.fingerprint, v };
    });
    saveCache(docId, model, cache);
  }
  return { ok: true, vectors, cached: rows.length - missing.length, embedded: missing.length };
}

function cosine(a, b) {
  if (!a || !b || a.length !== b.length) return 0;
  let dot = 0, na = 0, nb = 0;
  for (let i = 0; i < a.length; i++) { dot += a[i] * b[i]; na += a[i] * a[i]; nb += b[i] * b[i]; }
  if (!na || !nb) return 0;
  return dot / (Math.sqrt(na) * Math.sqrt(nb));
}

module.exports = { isConfigured, embed, embedItems, cosine, fingerprint };