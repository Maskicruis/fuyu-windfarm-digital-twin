'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const {
  buildDocument,
  documentToMarkdown,
  normalizedBbox,
  pdfBbox,
  toLegacyItems
} = require('../src/transform');

const fixture = name => JSON.parse(fs.readFileSync(path.join(__dirname, 'fixtures', 'mineru', name), 'utf8'));

test('uses content_list reading order instead of unordered middle.json blocks', () => {
  const document = buildDocument({
    id: 'doc_test',
    title: '变电工程总布置设计规程',
    sourceName: 'sample.pdf',
    contentList: fixture('sample_content_list.json'),
    middle: fixture('sample_middle.json')
  });
  assert.deepEqual(
    document.items.map(item => item.text || (item.type === 'table' ? 'TABLE' : '')),
    [
      '5.3.3 当站区采用强制排水时，雨水泵房（池）宜布置在站内场地较低处。',
      '5.3.4 变压器广场的搬运轨道基础、电缆沟（隧）道应统筹布置。',
      '5.4 建（构）筑物间距',
      '5.4.1 建（构）筑物的火灾危险性分类及其耐火等级不应低于表 5.4.1 的规定。',
      'TABLE'
    ]
  );
  assert.equal(document.items.filter(item => item.type === 'table').length, 1);
  assert.equal(document.items.some(item => item.type === 'footer'), false);
});

test('converts normalized top-left coordinates to exact PDF bottom-left coordinates', () => {
  const normalized = normalizedBbox([185, 360, 815, 908], 'thousand');
  assert.deepEqual(normalized, [0.185, 0.36, 0.815, 0.908]);
  assert.deepEqual(pdfBbox(normalized, { width: 595.32, height: 841.92 }), [110.13, 77.46, 485.19, 538.83]);
});

test('keeps the real table width when producing the browser compatibility view', () => {
  const document = buildDocument({
    id: 'doc_test',
    title: 'sample',
    sourceName: 'sample.pdf',
    contentList: fixture('sample_content_list.json'),
    middle: fixture('sample_middle.json')
  });
  const table = toLegacyItems(document).find(item => item.type === 'table');
  assert.deepEqual(table.bbox, [110.13, 77.46, 485.19, 538.83]);
  assert.deepEqual(table.bboxNormalized, [0.185, 0.36, 0.815, 0.908]);
  assert.match(table.text, /<table>/);
  assert.match(table.caption, /表 5\.4\.1/);
});

test('supports nested content_list_v2 ratio coordinates', () => {
  const document = buildDocument({
    id: 'doc_v2',
    title: 'v2',
    sourceName: 'v2.pdf',
    contentList: [[
      { type: 'title', content: '1 范围', bbox: [0.1, 0.2, 0.8, 0.25] },
      { type: 'text', content: '正文', bbox: [0.1, 0.3, 0.8, 0.4] }
    ]],
    middle: { pdf_info: [{ page_idx: 0, page_size: [600, 800] }] }
  });
  assert.equal(document.items[0].page, 1);
  assert.deepEqual(document.items[0].bbox.pdf, [60, 600, 480, 640]);
  assert.match(documentToMarkdown(document), /^# 1 范围\n\n正文/);
});
