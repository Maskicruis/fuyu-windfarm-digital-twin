'use strict';

function compactBox(value) {
  return Array.isArray(value) && value.length >= 4
    ? value.slice(0, 4).map(item => Number(item)).filter(Number.isFinite).join(',')
    : '';
}

function citationSourceUrl(citation = {}) {
  const params = new URLSearchParams();
  params.set('doc', String(citation.docId || ''));
  params.set('page', String(Math.max(1, Number(citation.page) || 1)));
  if (citation.itemId) params.set('item', String(citation.itemId));
  if (citation.ref) params.set('ref', String(citation.ref));
  const bbox = compactBox(citation.bbox);
  const bboxNormalized = compactBox(citation.bboxNormalized);
  if (bbox) params.set('bbox', bbox);
  if (bboxNormalized) params.set('nbbox', bboxNormalized);
  return '/open/citation?' + params.toString();
}

function rawSourceUrl(citation = {}) {
  return '/api/v1/documents/' + encodeURIComponent(String(citation.docId || '')) + '/source#page=' + Math.max(1, Number(citation.page) || 1);
}

function decorateCitation(citation = {}) {
  const bbox = citation.bbox || null;
  const bboxNormalized = citation.bboxNormalized || null;
  return Object.assign({}, citation, {
    sourceUrl: citationSourceUrl(citation),
    rawSourceUrl: rawSourceUrl(citation),
    locate: citation.locate || {
      docId: citation.docId,
      page: citation.page,
      itemId: citation.itemId,
      bbox,
      bboxNormalized
    }
  });
}

module.exports = { citationSourceUrl, compactBox, decorateCitation, rawSourceUrl };
