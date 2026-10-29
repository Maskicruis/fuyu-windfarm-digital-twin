'use strict';

const path = require('node:path');
const { nowIso } = require('./utils');

const SCHEMA_VERSION = '1.0';
const AUXILIARY_TYPES = new Set(['header', 'footer', 'page_number', 'aside_text', 'page_footnote']);

function clamp(value, min, max) {
  return Math.min(max, Math.max(min, Number(value)));
}

function pageMapFromMiddle(middle = {}) {
  const result = new Map();
  const pages = Array.isArray(middle.pdf_info) ? middle.pdf_info : [];
  for (let index = 0; index < pages.length; index++) {
    const page = pages[index] || {};
    const number = Number(page.page_idx == null ? index : page.page_idx) + 1;
    const size = Array.isArray(page.page_size) ? page.page_size : [];
    const width = Number(size[0]) || 595;
    const height = Number(size[1]) || 842;
    result.set(number, { number, width, height });
  }
  return result;
}

function flattenContentList(input) {
  if (!Array.isArray(input)) return [];
  const nested = input.some(Array.isArray);
  if (!nested) return input.map((item, sourceIndex) => ({ item, pageIndex: item && item.page_idx, sourceIndex, coordinateMode: 'thousand' }));
  const rows = [];
  let sourceIndex = 0;
  input.forEach((pageItems, pageIndex) => {
    for (const item of Array.isArray(pageItems) ? pageItems : []) {
      rows.push({ item, pageIndex, sourceIndex: sourceIndex++, coordinateMode: 'ratio' });
    }
  });
  return rows;
}

function normalizedBbox(raw, coordinateMode) {
  if (!Array.isArray(raw) || raw.length < 4) return null;
  let divisor = coordinateMode === 'ratio' ? 1 : 1000;
  if (coordinateMode !== 'ratio' && Math.max(...raw.map(Number)) <= 1.5) divisor = 1;
  const box = raw.slice(0, 4).map(value => clamp(Number(value) / divisor, 0, 1));
  if (!box.every(Number.isFinite) || box[2] <= box[0] || box[3] <= box[1]) return null;
  return box;
}

function pdfBbox(normalized, page) {
  if (!normalized) return null;
  const [x0, y0, x1, y1] = normalized;
  const result = [x0 * page.width, page.height - y1 * page.height, x1 * page.width, page.height - y0 * page.height];
  return result.map(value => Math.round(value * 100) / 100);
}

function pickString(...values) {
  for (const value of values) {
    if (typeof value === 'string' && value.trim()) return value;
  }
  return '';
}

function payload(item) {
  const content = item && item.content;
  return content && typeof content === 'object' && !Array.isArray(content) ? content : {};
}

function listText(value) {
  if (!Array.isArray(value)) return typeof value === 'string' ? value : '';
  return value.map(entry => {
    if (typeof entry === 'string') return entry;
    if (entry && typeof entry === 'object') return pickString(entry.text, entry.content, entry.markdown);
    return '';
  }).filter(Boolean).join('\n');
}

function itemText(item, type) {
  const data = payload(item);
  if (type === 'list' && Array.isArray(item.list_items)) return listText(item.list_items);
  if (type === 'list' && Array.isArray(data.items)) return listText(data.items);
  return pickString(
    item.text,
    typeof item.content === 'string' ? item.content : '',
    item.equation,
    item.code_body,
    item.chart_body,
    data.text,
    data.markdown,
    data.latex,
    data.code
  );
}

function tableHtml(item) {
  const data = payload(item);
  return pickString(item.table_body, item.html, data.table_body, data.html, data.content, typeof item.content === 'string' ? item.content : '');
}

function assetName(item) {
  const data = payload(item);
  const raw = pickString(item.img_path, item.image_path, data.img_path, data.image_path, data.path);
  return raw ? path.basename(raw) : '';
}

function canonicalType(item) {
  const raw = String(item.type || 'text').toLowerCase();
  if (raw === 'text' && Number(item.text_level) > 0) return 'title';
  if (raw === 'figure') return 'image';
  if (raw === 'interline_equation') return 'equation';
  return raw;
}

function makeItem(row, pages, options) {
  const source = row.item || {};
  const zeroBasedPage = Number(row.pageIndex == null ? source.page_idx : row.pageIndex);
  const pageNumber = Number.isInteger(zeroBasedPage) && zeroBasedPage >= 0 ? zeroBasedPage + 1 : 1;
  const page = pages.get(pageNumber) || { number: pageNumber, width: 595, height: 842 };
  if (!pages.has(pageNumber)) pages.set(pageNumber, page);
  const type = canonicalType(source);
  if (options.excludeAuxiliary !== false && AUXILIARY_TYPES.has(type)) return null;
  const normalized = normalizedBbox(source.bbox, row.coordinateMode);
  const text = itemText(source, type);
  const html = type === 'table' ? tableHtml(source) : '';
  const asset = (type === 'image' || type === 'chart' || type === 'table') ? assetName(source) : '';
  const caption = listText(source.table_caption || source.image_caption || source.chart_caption || payload(source).caption);
  const footnote = listText(source.table_footnote || source.image_footnote || source.chart_footnote || payload(source).footnote);
  if (!text && !html && !asset) return null;
  const id = `p${String(pageNumber).padStart(4, '0')}-i${String(row.sourceIndex).padStart(6, '0')}`;
  const result = {
    id,
    page: pageNumber,
    order: row.sourceIndex,
    sourceIndex: row.sourceIndex,
    type,
    bbox: normalized ? { normalized, pdf: pdfBbox(normalized, page) } : null
  };
  if (text) result.text = text;
  if (html) result.html = html;
  if (asset) result.asset = asset;
  if (caption) result.caption = caption;
  if (footnote) result.footnote = footnote;
  if (type === 'title') result.headingLevel = Math.min(6, Math.max(1, Number(source.text_level) || Number(source.level) || 1));
  if (source.sub_type) result.subtype = String(source.sub_type);
  return result;
}

function buildDocument({ id, title, sourceName, contentList, middle = {}, options = {} }) {
  const pages = pageMapFromMiddle(middle);
  const rows = flattenContentList(contentList);
  const items = [];
  for (const row of rows) {
    const item = makeItem(row, pages, options);
    if (item) items.push(item);
  }
  items.sort((a, b) => a.page - b.page || a.order - b.order);
  const pageList = [...pages.values()].sort((a, b) => a.number - b.number);
  const known = new Set(pageList.map(page => page.number));
  for (const item of items) {
    if (!known.has(item.page)) {
      pageList.push({ number: item.page, width: 595, height: 842 });
      known.add(item.page);
    }
  }
  pageList.sort((a, b) => a.number - b.number);
  for (const page of pageList) page.items = items.filter(item => item.page === page.number).map(item => item.id);
  return {
    schemaVersion: SCHEMA_VERSION,
    document: {
      id: String(id || ''),
      title: String(title || ''),
      sourceName: String(sourceName || ''),
      createdAt: nowIso(),
      pageCount: pageList.length
    },
    coordinateSystems: {
      normalized: { origin: 'top-left', unit: 'ratio', range: [0, 1] },
      pdf: { origin: 'bottom-left', unit: 'point' }
    },
    pages: pageList,
    items
  };
}

function toLegacyItems(document) {
  return document.items.map(item => {
    const output = {
      id: item.id,
      page: item.page,
      order: item.order,
      type: item.type,
      bbox: item.bbox ? item.bbox.pdf : null,
      bboxNormalized: item.bbox ? item.bbox.normalized : null
    };
    if (item.type === 'table') output.text = item.html || item.text || '';
    else if (item.text) output.text = item.text;
    if (item.asset) output.img = item.asset;
    if (item.caption) output.caption = item.caption;
    if (item.footnote) output.footnote = item.footnote;
    if (item.headingLevel) output.headingLevel = item.headingLevel;
    return output;
  });
}

function documentToMarkdown(document) {
  const blocks = [];
  for (const item of document.items) {
    if (item.type === 'title') {
      blocks.push('#'.repeat(Math.min(6, item.headingLevel || 1)) + ' ' + (item.text || ''));
    } else if (item.type === 'table') {
      if (item.caption) blocks.push(item.caption);
      blocks.push(item.html || item.text || '');
      if (item.footnote) blocks.push(item.footnote);
    } else if (item.type === 'image' || item.type === 'chart') {
      if (item.caption) blocks.push(item.caption);
      if (item.asset) blocks.push(`![${item.text || item.type}](images/${encodeURI(item.asset)})`);
      if (item.text) blocks.push(item.text);
      if (item.footnote) blocks.push(item.footnote);
    } else if (item.type === 'equation') {
      blocks.push('$$\n' + (item.text || '') + '\n$$');
    } else if (item.type === 'code' || item.type === 'algorithm') {
      blocks.push('```\n' + (item.text || '') + '\n```');
    } else if (item.text) {
      blocks.push(item.text);
    }
  }
  return blocks.filter(Boolean).join('\n\n') + '\n';
}

function applyCorrections(document, corrections = {}) {
  for (const item of document.items) {
    const correction = corrections[item.id];
    if (!correction) continue;
    if (typeof correction.text === 'string') item.text = correction.text;
    if (typeof correction.html === 'string') item.html = correction.html;
  }
  return document;
}

module.exports = {
  AUXILIARY_TYPES,
  SCHEMA_VERSION,
  applyCorrections,
  buildDocument,
  documentToMarkdown,
  flattenContentList,
  normalizedBbox,
  pdfBbox,
  toLegacyItems
};
