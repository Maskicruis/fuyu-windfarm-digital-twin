'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const { citationSourceUrl, decorateCitation } = require('../src/citation-links');
const { planQuery } = require('../src/query-planner');

test('expands informal complex-building language into specification terminology', () => {
  const plan = planQuery('综合楼的消防间距和火灾危险性分类是什么？');
  assert.equal(plan.needsClarification, true);
  assert.ok(plan.expandedTerms.includes('民用建筑群'));
  assert.ok(plan.expandedTerms.includes('民用建筑'));
  assert.ok(plan.expandedTerms.includes('建筑群'));
  assert.ok(plan.expandedTerms.includes('防火间距'));
  assert.match(plan.retrievalQuery, /民用建筑/);
  assert.ok(plan.clarification.questions.length >= 2);
});

test('accepts a clarified complex-building description without asking the same questions again', () => {
  const plan = planQuery('综合楼属于公共建筑，高度24米，共6层，不含厂房、仓库、生产或储存；相邻建筑为二级耐火等级公共建筑。请查防火间距。');
  assert.equal(plan.needsClarification, false);
  assert.ok(plan.interpretations.some(item => item.id === 'complex-building'));
});

test('builds a stable SpecFlow desktop handoff URL for citations', () => {
  const citation = decorateCitation({ docId: 'doc fire/1', page: 8, itemId: 'p8-i3', ref: '5.2.7', bbox: [1, 2, 3, 4], bboxNormalized: [0.1, 0.2, 0.3, 0.4] });
  assert.equal(citation.sourceUrl, citationSourceUrl(citation));
  assert.match(citation.sourceUrl, /^\/open\/citation\?/);
  assert.match(citation.sourceUrl, /doc=doc\+fire%2F1/);
  assert.match(citation.rawSourceUrl, /\/api\/v1\/documents\/doc%20fire%2F1\/source#page=8$/);
});
