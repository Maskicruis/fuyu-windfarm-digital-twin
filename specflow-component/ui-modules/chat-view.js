(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.SpecFlowChatView = factory();
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  function escape(value) {
    return String(value == null ? '' : value).replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  }
  function reference(value) {
    var match = String(value).match(/^(?:\[|【|［)?\s*(?:(?:片段|segment)\s*)?(\d{1,3})\s*(?:\]|】|］)?$/i);
    return match ? String(Number(match[1])) : '';
  }
  function safeLink(value) {
    return /^https?:\/\/[^\s<>]+$/i.test(value) && !/[\u0000-\u001f\u007f]/.test(value);
  }
  function inline(value, references, link, depth) {
    var text = String(value), out = '', i = 0;
    depth = depth || 0;
    if (depth > 8) return escape(text);
    while (i < text.length) {
      var rest = text.slice(i), match;
      if ((match = rest.match(/^(`+)([^\n]*?)\1(?!`)/))) {
        out += '<code>' + escape(match[2]) + '</code>'; i += match[0].length; continue;
      }
      if ((match = rest.match(/^\[([^\]\n]+)\]\(([^\s)]+)\)/))) {
        var known = references[reference(match[1])];
        if (known) out += link(known);
        else if (safeLink(match[2])) out += '<a class="chat-external-link" href="' + escape(match[2]) + '" target="_blank" rel="noopener noreferrer">' + inline(match[1], references, link, depth + 1) + '</a>';
        else out += escape(match[0]);
        i += match[0].length; continue;
      }
      if ((match = rest.match(/^(?:\[|【|［)\s*(?:(?:片段|segment)\s*)?(\d{1,3})\s*(?:\]|】|］)/i))) {
        out += references[String(Number(match[1]))] ? link(references[String(Number(match[1]))]) : escape(match[0]);
        i += match[0].length; continue;
      }
      if ((match = rest.match(/^(\*\*|__)([^\n]+?)\1/))) {
        out += '<strong>' + inline(match[2], references, link, depth + 1) + '</strong>'; i += match[0].length; continue;
      }
      if ((match = rest.match(/^\*([^*\n]+)\*/))) {
        out += '<em>' + inline(match[1], references, link, depth + 1) + '</em>'; i += match[0].length; continue;
      }
      if (text[i] === '\\' && /[\\`*_{}\[\]()#+.!|>-]/.test(text[i + 1] || '')) {
        out += escape(text[i + 1]); i += 2; continue;
      }
      // Consume plain runs together; never interpret model-provided HTML as DOM.
      var plain = rest.match(/^[^`\[【［*_\\]+/);
      if (plain) { out += escape(plain[0]); i += plain[0].length; }
      else { out += escape(text[i]); i++; }
    }
    return out;
  }
  function cells(line) {
    var text = line.trim().replace(/^\|/, '').replace(/\|$/, ''), parts = [], part = '', code = false;
    for (var i = 0; i < text.length; i++) {
      if (text[i] === '\\' && text[i + 1] === '|') { part += '|'; i++; }
      else if (text[i] === '`') { code = !code; part += text[i]; }
      else if (text[i] === '|' && !code) { parts.push(part.trim()); part = ''; }
      else part += text[i];
    }
    parts.push(part.trim()); return parts.slice(0, 24);
  }
  function tableRule(line) {
    return line && line.includes('|') && cells(line).every(function (part) { return /^:?-{3,}:?$/.test(part); });
  }
  function listItem(line) { return line.match(/^( *)([-+*]|\d+[.)、])\s+(.+)$/); }
  function blockStart(lines, i) {
    return /^\s*$|^\s{0,3}(?:#{1,6}\s|```|~~~|>\s?)|^\s*(?:---+|\*\*\*+|___+)\s*$/.test(lines[i]) || listItem(lines[i]) || (lines[i].includes('|') && tableRule(lines[i + 1]));
  }
  function blocks(lines, references, link, depth) {
    if ((depth || 0) > 8) return '<p>' + escape(lines.join('\n')) + '</p>';
    var out = '', i = 0;
    var renderInline = function (text) { return inline(text, references, link); };
    while (i < lines.length) {
      var line = lines[i], match;
      if (!line.trim()) { i++; continue; }
      if ((match = line.match(/^\s{0,3}(`{3,}|~{3,})([^\s]*)\s*$/))) {
        var fence = match[1], language = match[2], code = []; i++;
        var end = new RegExp('^\\s{0,3}' + fence[0] + '{' + fence.length + ',}\\s*$');
        while (i < lines.length && !end.test(lines[i])) code.push(lines[i++]);
        if (i < lines.length) i++;
        out += '<div class="chat-code"><div class="chat-code-head"><span>' + escape(language || '文本') + '</span><button type="button" data-act="copyCode" aria-label="复制代码">复制代码</button></div><pre><code>' + escape(code.join('\n')) + '</code></pre></div>'; continue;
      }
      if ((match = line.match(/^\s{0,3}(#{1,6})\s+(.+?)\s*#*\s*$/))) {
        var level = Math.min(4, match[1].length + 1);
        out += '<h' + level + '>' + renderInline(match[2]) + '</h' + level + '>'; i++; continue;
      }
      if (/^\s*(?:---+|\*\*\*+|___+)\s*$/.test(line)) { out += '<hr>'; i++; continue; }
      if (/^\s{0,3}>/.test(line)) {
        var quote = [];
        while (i < lines.length && /^\s{0,3}>/.test(lines[i])) quote.push(lines[i++].replace(/^\s{0,3}> ?/, ''));
        out += '<blockquote>' + blocks(quote, references, link, (depth || 0) + 1) + '</blockquote>'; continue;
      }
      if (line.includes('|') && tableRule(lines[i + 1])) {
        var headers = cells(line), rules = cells(lines[i + 1]); i += 2;
        var alignment = function (n) { var rule = rules[n] || ''; return rule.startsWith(':') && rule.endsWith(':') ? 'center' : rule.endsWith(':') ? 'right' : 'left'; };
        out += '<div class="chat-table-wrap" tabindex="0" role="region" aria-label="回答表格，可横向滚动"><table><thead><tr>';
        headers.forEach(function (cell, n) { out += '<th style="text-align:' + alignment(n) + '">' + renderInline(cell) + '</th>'; });
        out += '</tr></thead><tbody>';
        while (i < lines.length && lines[i].trim() && lines[i].includes('|')) {
          var row = cells(lines[i++]); out += '<tr>';
          headers.forEach(function (_, n) { out += '<td style="text-align:' + alignment(n) + '">' + renderInline(row[n] || '') + '</td>'; });
          out += '</tr>';
        }
        out += '</tbody></table></div>'; continue;
      }
      if ((match = listItem(line))) {
        var indent = match[1].length, ordered = /^\d/.test(match[2]), tag = ordered ? 'ol' : 'ul';
        out += '<' + tag + (ordered ? ' start="' + Number.parseInt(match[2], 10) + '"' : '') + '>';
        while (i < lines.length) {
          match = listItem(lines[i]);
          if (!match || match[1].length !== indent || /^\d/.test(match[2]) !== ordered) break;
          var content = [match[3]]; i++;
          while (i < lines.length) {
            if (!lines[i].trim() && listItem(lines[i + 1] || '')) { i++; break; }
            if (!lines[i].trim()) break;
            var spaces = lines[i].match(/^ */)[0].length;
            if (spaces <= indent) break;
            content.push(lines[i++].slice(Math.min(spaces, indent + 2)));
          }
          out += '<li>' + blocks(content, references, link, (depth || 0) + 1) + '</li>';
        }
        out += '</' + tag + '>'; continue;
      }
      var paragraph = [line]; i++;
      while (i < lines.length && !blockStart(lines, i)) paragraph.push(lines[i++]);
      out += '<p>' + paragraph.map(renderInline).join('<br>') + '</p>';
    }
    return out;
  }
  function render(text, citations, citationLink) {
    var references = Object.create(null);
    (Array.isArray(citations) ? citations : []).forEach(function (c) { references[String(c.n)] = c; });
    return blocks(String(text || '').replace(/\r\n?/g, '\n').replace(/\u0000/g, '').split('\n'), references, citationLink || function (c) { return '[' + Number(c.n) + ']'; });
  }
  function copyText(text, citations) {
    var result = String(text || ''), list = Array.isArray(citations) ? citations : [];
    if (list.length) result += '\n\n参考来源\n' + list.map(function (c) {
      return '[' + Number(c.n) + '] ' + (c.title || c.docId || '工程文档') + ' · 第 ' + Number(c.page || 1) + ' 页' + (c.ref ? ' · ' + c.ref : '') + (c.sourceUrl ? '\n' + c.sourceUrl : '');
    }).join('\n');
    return result;
  }
  function setState(turn, state) {
    var active = state === 'pending' || state === 'streaming';
    if (turn.root) { turn.root.setAttribute('data-state', state); turn.root.setAttribute('aria-busy', String(active)); }
    if (turn.copy) turn.copy.disabled = active || !turn.rawText;
  }
  function update(turn, text, citations, answerHtml, citationCard) {
    var list = Array.isArray(citations) ? citations : [];
    turn.rawText = String(text || ''); turn.answer.innerHTML = answerHtml(turn.rawText, list);
    if (turn.root) turn.root._copyText = copyText(turn.rawText, list);
    if (turn.sources) turn.sources.hidden = !list.length;
    if (turn.sourceSummary) turn.sourceSummary.textContent = '查看原文片段 · ' + list.length + ' 个来源';
    var key = JSON.stringify(list);
    if (turn._citationKey !== key) { turn.cites.innerHTML = list.map(citationCard).join(''); turn._citationKey = key; }
  }
  function nearBottom(stream, tolerance) {
    return stream.scrollHeight - stream.scrollTop - stream.clientHeight <= (tolerance == null ? 80 : tolerance);
  }
  return { render: render, copyText: copyText, setState: setState, update: update, nearBottom: nearBottom };
});
