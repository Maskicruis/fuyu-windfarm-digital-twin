(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.SpecFlowStream = factory();
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';
  function createParser(onEvent) {
    var buffer = '', data = [], event = 'message';
    function dispatch() {
      if (data.length) onEvent({ event: event, data: data.join('\n') });
      data = []; event = 'message';
    }
    function line(value) {
      if (!value) return dispatch();
      if (value[0] === ':') return;
      var colon = value.indexOf(':'), key = colon < 0 ? value : value.slice(0, colon);
      var text = colon < 0 ? '' : value.slice(colon + 1).replace(/^ /, '');
      if (key === 'data') data.push(text);
      if (key === 'event') event = text;
    }
    return {
      feed: function (text) {
        buffer += text;
        if (buffer.length + data.join('\n').length > 2 * 1024 * 1024) throw new Error('流式数据帧过大');
        var end;
        while ((end = buffer.indexOf('\n')) >= 0) { line(buffer.slice(0, end).replace(/\r$/, '').replace(/^\uFEFF/, '')); buffer = buffer.slice(end + 1); }
      },
      finish: function () { if (buffer) line(buffer.replace(/\r$/, '')); buffer = ''; dispatch(); }
    };
  }
  async function consume(response, onEvent) {
    if (!response.body) throw new Error('响应不支持流式读取');
    var reader = response.body.getReader(), decoder = new TextDecoder('utf-8');
    var parser = createParser(onEvent), completed = false;
    try {
      while (true) {
        var chunk = await reader.read();
        if (chunk.done) break;
        parser.feed(decoder.decode(chunk.value, { stream: true }));
      }
      parser.feed(decoder.decode()); parser.finish(); completed = true;
    } finally {
      if (!completed) await reader.cancel().catch(function () {});
      reader.releaseLock();
    }
  }
  async function json(response, onEvent) {
    return consume(response, function (frame) {
      if (frame.data === '[DONE]') return onEvent({ type: 'end' });
      var value;
      try { value = JSON.parse(frame.data); } catch (_) { throw new Error('收到无效的流式 JSON 数据'); }
      if (!value.type && frame.event !== 'message') value.type = frame.event;
      return onEvent(value);
    });
  }
  return { createParser: createParser, consume: consume, json: json };
});
