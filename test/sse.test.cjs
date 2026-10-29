const { test } = require('node:test');
const assert = require('node:assert/strict');
const { createParser } = require('../sse.js');
function parse(parts) { const events = []; const parser = createParser(data => events.push(data)); for (const part of parts) parser.feed(part); parser.end(); return events; }
test('2つのイベント', () => assert.deepEqual(parse(['data: one\n\ndata: two\n\n']), ['one', 'two']));
test('行の途中で分割', () => assert.deepEqual(parse(['da', 'ta: hel', 'lo\n', '\n']), ['hello']));
test('日本語JSONを全ての文字位置・バイト位置で分割', () => {
  const payload = 'data: {"content":"日本語🍵です"}\n\n';
  const expected = ['{"content":"日本語🍵です"}'];
  for (let i = 0; i <= payload.length; i++) assert.deepEqual(parse([payload.slice(0, i), payload.slice(i)]), expected);
  const bytes = new TextEncoder().encode(payload);
  for (let i = 0; i <= bytes.length; i++) {
    const decoder = new TextDecoder();
    assert.deepEqual(parse([decoder.decode(bytes.slice(0, i), { stream: true }), decoder.decode(bytes.slice(i))]), expected);
  }
});
test('CRLFを受信', () => assert.deepEqual(parse(['data: 一\r', '\n\r', '\ndata: 二\r\n\r\n']), ['一', '二']));
test('コメント・event行を無視し複数data行を結合', () => assert.deepEqual(parse([': comment\nevent: message\ndata: first\ndata: second\n\n']), ['first\nsecond']));
test('DONEも通常のデータとして通知', () => assert.deepEqual(parse(['data: [DONE]\n\n']), ['[DONE]']));
test('空dataイベントと未完了イベント', () => assert.deepEqual(parse(['data:\n\ndata: unfinished']), ['']));
