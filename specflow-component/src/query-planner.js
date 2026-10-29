'use strict';

const TERM_RULES = [
  {
    id: 'complex-building',
    pattern: /综合楼|综合建筑|complex\s+building/i,
    label: '综合楼',
    canonical: ['民用建筑群', '民用建筑', '公共建筑', '建筑群', '多功能组合建筑']
  },
  {
    id: 'fire-separation',
    pattern: /消防间距|防火距离|fire\s+separation/i,
    label: '消防间距',
    canonical: ['防火间距', '建筑防火间距']
  },
  {
    id: 'fire-hazard-classification',
    pattern: /火灾危险(?:性)?分类|危险性类别|fire\s+hazard\s+classification/i,
    label: '火灾危险性分类',
    canonical: ['生产火灾危险性类别', '储存物品火灾危险性类别', '建筑分类']
  }
];

function unique(values) {
  return [...new Set(values.map(value => String(value || '').trim()).filter(Boolean))];
}

function complexBuildingClarification(text) {
  if (!/综合楼|综合建筑|complex\s+building/i.test(text)) return null;
  if (!/消防|防火|火灾|间距|危险性|fire/i.test(text)) return null;
  const questions = [];
  const hasUse = /住宅|公共建筑|民用建筑|办公|商业|旅馆|酒店|医院|学校|厂房|仓库|工业|生产|储存/.test(text);
  const hasGeometry = /建筑高度|高度\s*\d|层数|地上\s*\d|地下\s*\d|总建筑面积|单体|裙房|\d+(?:\.\d+)?\s*(?:m|米)/i.test(text);
  const hasHazard = /(?:甲|乙|丙|丁|戊)\s*类|生产.*(?:火灾危险性|类别)|储存.*(?:火灾危险性|类别)|物品.*(?:危险性|类别)|(?:不含|没有|无).{0,12}(?:生产|储存|厂房|仓库)/.test(text);
  const hasNeighbour = /相邻|周边|两栋|另一栋|防火墙|耐火等级|一二三四级|一级|二级|三级|四级/.test(text);
  if (!hasUse) questions.push('该综合楼具体包含哪些用途：住宅、办公、商业等民用功能，还是包含厂房、仓库、生产或储存功能？');
  if (!hasGeometry) questions.push('请补充建筑高度、层数、建筑面积，以及它是单体组合建筑还是由多栋建筑组成的建筑群。');
  if (!hasHazard) questions.push('如果包含生产或储存，请说明物品、工艺及已知的甲、乙、丙、丁、戊类火灾危险性信息。');
  if (!hasNeighbour) questions.push('需要核算防火间距时，请说明相邻建筑的用途、高度和耐火等级。');
  if (!questions.length) return null;
  return {
    required: true,
    reason: '“综合楼”不是足以直接确定防火间距或火灾危险性类别的规范分类，必须先判断对应的建筑用途和组合关系。',
    questions: questions.slice(0, 4),
    prompt: '在检索规范并给出结论前，还需要确认：\n' + questions.slice(0, 4).map((question, index) => (index + 1) + '. ' + question).join('\n')
  };
}

function planQuery(input, options = {}) {
  const originalQuery = String(options.currentQuery || input || '').trim();
  const context = String(input || originalQuery).trim();
  const interpretations = [];
  const expandedTerms = [];
  for (const rule of TERM_RULES) {
    if (!rule.pattern.test(context)) continue;
    const additions = rule.canonical.filter(term => !context.includes(term));
    if (additions.length) expandedTerms.push(...additions);
    interpretations.push({ id: rule.id, expression: rule.label, canonicalTerms: rule.canonical.slice() });
  }
  const terms = unique(expandedTerms);
  const retrievalQuery = unique([context, ...terms]).join(' ');
  const clarification = complexBuildingClarification(context) || { required: false, reason: '', questions: [], prompt: '' };
  return {
    originalQuery,
    retrievalQuery,
    expandedTerms: terms,
    interpretations,
    needsClarification: Boolean(clarification.required),
    clarification
  };
}

module.exports = { TERM_RULES, complexBuildingClarification, planQuery };
