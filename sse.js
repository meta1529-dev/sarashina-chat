(function (root) {
  'use strict';
  function createParser(onEvent) {
    let buffer = '', data = [];
    function line(value) {
      if (value === '') {
        if (data.length) onEvent(data.join('\n'));
        data = [];
      } else if (value.startsWith('data:')) {
        let part = value.slice(5);
        if (part.startsWith(' ')) part = part.slice(1);
        data.push(part);
      }
    }
    return {
      feed(text) {
        buffer += text;
        let index;
        while ((index = buffer.indexOf('\n')) !== -1) {
          let value = buffer.slice(0, index);
          buffer = buffer.slice(index + 1);
          if (value.endsWith('\r')) value = value.slice(0, -1);
          line(value);
        }
      },
      end() { buffer = ''; data = []; }
    };
  }
  const api = { createParser, isDoneData: data => data === '[DONE]' };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  if (typeof window !== 'undefined') root.SarashinaSSE = api;
})(typeof globalThis !== 'undefined' ? globalThis : this);
