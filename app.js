'use strict';
(() => {
  const $ = id => document.getElementById(id);
  const keyName = 'sarashina-chat:key', settingsName = 'sarashina-chat:settings';
  const thinking = 'sarashina3.2-mini-thinking', guardModel = 'sarashina3-guard';
  let history = [], controller = null, busy = false;
  const controls = ['model', 'effort', 'temperature', 'max-tokens', 'connection', 'stream'];
  function read(store, name) { try { return store.getItem(name); } catch { return null; } }
  function remove(store, name) { try { store.removeItem(name); } catch { /* 保存不可 */ } }
  $('connection').value = ['localhost', '127.0.0.1'].includes(location.hostname) ? 'proxy' : 'direct';
  try {
    const saved = JSON.parse(read(localStorage, settingsName) || '{}');
    for (const id of controls) {
      if (saved[id] !== undefined) {
        if (id === 'stream') $(id).checked = saved[id] === true;
        else $(id).value = saved[id];
      }
    }
    if (!$('model').value) $('model').value = thinking;
    if (!$('connection').value) $('connection').value = 'direct';
    if (!$('effort').value) $('effort').value = 'medium';
  } catch { /* 初期値を使用 */ }
  const persistentKey = read(localStorage, keyName);
  $('api-key').value = persistentKey || read(sessionStorage, keyName) || '';
  $('save-key').checked = Boolean(persistentKey);
  function saveKey() {
    const key = $('api-key').value;
    const keep = $('save-key').checked;
    remove(keep ? sessionStorage : localStorage, keyName);
    try { (keep ? localStorage : sessionStorage).setItem(keyName, key); }
    catch { $('connection-status').textContent = 'キーを保存できません。この画面を開いている間のみ使用します。'; }
  }
  function saveSettings() {
    const value = {};
    for (const id of controls) value[id] = id === 'stream' ? $(id).checked : $(id).value;
    try { localStorage.setItem(settingsName, JSON.stringify(value)); } catch { /* メモリのみ */ }
  }
  function modes() {
    const guard = $('model').value === guardModel;
    $('effort-control').hidden = $('model').value !== thinking;
    $('system-control').hidden = guard;
    $('system-prompt').disabled = guard || busy;
    $('temperature-control').hidden = guard;
    $('temperature').disabled = guard || busy;
    $('max-tokens').disabled = guard || busy;
    $('guard-note').hidden = !guard;
  }
  function notice(text) { const p = document.createElement('p'); p.className = 'notice'; p.textContent = text; $('chat-log').append(p); }
  function scroll() { $('chat-log').scrollTop = $('chat-log').scrollHeight; }
  function bubble(role, text) {
    const box = document.createElement('article'); box.className = 'message ' + role;
    const label = document.createElement('div'); label.className = 'speaker'; label.textContent = role === 'user' ? 'あなた' : 'Sarashina';
    const content = document.createElement('div'); content.className = 'content'; content.textContent = text;
    box.append(label, content); $('chat-log').append(box); scroll();
    return { box, content };
  }
  function note(target, text, warning = false) { const p = document.createElement('p'); p.className = warning ? 'note warning' : 'note'; p.textContent = text; target.box.append(p); scroll(); }
  const errors = {400:'パラメータが不正です',401:'APIキーが無効か未設定です',403:'アクセスが拒否されました。日本国外からの接続やVPN経由では利用できない場合があります',404:'エンドポイントが見つかりません',413:'入力が大きすぎます',429:'レート制限に達しました。少し待ってから再試行してください',500:'Sarashina側の障害の可能性があります。時間をおいて再試行してください',503:'Sarashina側の障害の可能性があります。時間をおいて再試行してください'};
  async function responseError(response) {
    let message = '';
    try { const body = await response.json(); if (typeof body.message === 'string') message = body.message; } catch { /* ステータスで説明 */ }
    return new Error((errors[response.status] || '応答を処理できませんでした') + '（HTTP ' + response.status + '）' + (message ? '：' + message : ''));
  }
  function errorText(error) {
    if (error.name === 'AbortError') return '停止しました。';
    if (error instanceof TypeError) return 'ネットワークエラー。直接接続がCORSでブロックされている可能性があります。ローカルプロキシ方式（node server.mjs）をお試しください。';
    return error.message || '処理に失敗しました。';
  }
  function endpoint(path) { return $('connection').value === 'proxy' ? '/api/' + path : 'https://api.sarashina.ai/v1/' + path; }
  function headers() { return { Authorization: 'Bearer ' + $('api-key').value, 'Content-Type': 'application/json' }; }
  function setBusy(value) {
    busy = value;
    for (const id of [...controls, 'api-key', 'save-key', 'test-connection', 'system-prompt', 'new-chat', 'send']) $(id).disabled = value;
    $('stop').hidden = !value; $('generation-status').textContent = value ? '生成中…' : '';
    modes();
  }
  function metadata(target, usage, finish) {
    if (finish === 'length') note(target, '出力上限に達して途中で終了しました（max_completion_tokensを大きくしてください）', true);
    if (usage) note(target, '使用トークン：' + JSON.stringify(usage));
  }
  $('toggle-key').addEventListener('click', () => { const show = $('api-key').type === 'password'; $('api-key').type = show ? 'text' : 'password'; $('toggle-key').textContent = show ? '隠す' : '表示'; });
  $('api-key').addEventListener('input', saveKey); $('save-key').addEventListener('change', saveKey);
  for (const id of controls) $(id).addEventListener('change', () => {
    if (id === 'model' && history.length) { history = []; notice('モデルを変更したため、会話をリセットしました'); }
    modes(); saveSettings();
  });
  $('new-chat').addEventListener('click', () => { history = []; $('chat-log').replaceChildren(); notice('新しい会話を開始しました'); });
  $('stop').addEventListener('click', () => controller?.abort());
  $('test-connection').addEventListener('click', async () => {
    if (!$('api-key').value.trim()) { $('connection-status').textContent = errors[401]; return; }
    $('test-connection').disabled = true; $('connection-status').textContent = '接続を確認中…';
    try {
      const response = await fetch(endpoint('models'), { headers: headers() });
      if (!response.ok) throw await responseError(response);
      const data = await response.json();
      $('connection-status').textContent = '接続OK（モデル' + (Array.isArray(data.data) ? data.data.length : 0) + '件）';
    } catch (error) { $('connection-status').textContent = errorText(error); }
    finally { $('test-connection').disabled = busy; }
  });
  $('message').addEventListener('keydown', event => {
    if (event.key === 'Enter' && !event.shiftKey && !event.isComposing && event.keyCode !== 229) { event.preventDefault(); if (!busy) $('composer').requestSubmit(); }
  });
  $('composer').addEventListener('submit', async event => {
    event.preventDefault(); if (busy) return;
    const input = $('message').value;
    if (!input.trim()) return;
    if (!$('api-key').value.trim()) { notice(errors[401]); return; }
    const model = $('model').value, guard = model === guardModel, streaming = $('stream').checked;
    const temperature = Number($('temperature').value), max = Number($('max-tokens').value);
    if (!guard && (!Number.isFinite(temperature) || temperature < 0 || temperature > 2 || !Number.isInteger(max) || max < 1 || max > 8000)) { notice('温度は0〜2、最大出力トークン数は1〜8000の整数で指定してください。'); return; }
    const user = { role: 'user', content: input };
    const messages = guard ? [user] : [...($('system-prompt').value ? [{ role: 'system', content: $('system-prompt').value }] : []), ...history, user];
    const payload = { model, messages, stream: streaming };
    if (!guard) { payload.temperature = temperature; payload.max_completion_tokens = max; }
    if (model === thinking) payload.reasoning_effort = $('effort').value;
    saveKey(); saveSettings(); setBusy(true); controller = new AbortController();
    bubble('user', input); const target = bubble('assistant', ''); $('message').value = '';
    let content = '', reasoning = '', usage, finish, done = false;
    try {
      const response = await fetch(endpoint('chat/completions'), { method: 'POST', headers: headers(), body: JSON.stringify(payload), signal: controller.signal });
      if (!response.ok || (streaming && !(response.headers.get('content-type') || '').toLowerCase().includes('text/event-stream'))) throw await responseError(response);
      let assistant;
      if (streaming) {
        if (!response.body) throw new Error('応答ストリームがありません。');
        const parser = SarashinaSSE.createParser(data => {
          if (done) return;
          if (SarashinaSSE.isDoneData(data)) { done = true; return; }
          const chunk = JSON.parse(data);
          if (chunk.error || (chunk.message && !chunk.choices)) throw new Error('APIエラー：' + (chunk.error?.message || chunk.message));
          if (chunk.usage) usage = chunk.usage;
          const choice = chunk.choices?.[0];
          if (choice?.finish_reason) finish = choice.finish_reason;
          if (typeof choice?.delta?.content === 'string') content += choice.delta.content;
          if (typeof choice?.delta?.reasoning === 'string') reasoning += choice.delta.reasoning;
          target.content.textContent = content; scroll();
        });
        const reader = response.body.getReader(), decoder = new TextDecoder('utf-8');
        try {
          while (!done) {
            const part = await reader.read();
            if (part.done) { parser.feed(decoder.decode()); parser.end(); break; }
            parser.feed(decoder.decode(part.value, { stream: true }));
          }
        } finally { await reader.cancel().catch(() => {}); reader.releaseLock(); }
        if (!done) throw new Error('完了通知を受信する前に接続が終了しました。');
        assistant = { role: 'assistant', content, ...(reasoning ? { reasoning } : {}) };
      } else {
        const data = await response.json(), message = data.choices?.[0]?.message;
        if (!message || !('content' in message)) throw new Error('応答の形式が不正です。');
        assistant = { role: 'assistant' };
        for (const field of ['content', 'reasoning', 'tool_calls']) if (Object.hasOwn(message, field)) assistant[field] = message[field];
        target.content.textContent = typeof message.content === 'string' ? message.content : '';
        usage = data.usage; finish = data.choices[0].finish_reason;
      }
      if (controller.signal.aborted) throw new DOMException('停止', 'AbortError');
      if (!guard) history.push(user, assistant);
      metadata(target, usage, finish);
    } catch (error) { note(target, '不完全：' + errorText(error) + '\nこの応答は会話履歴に追加していません。', true); }
    finally { controller = null; setBusy(false); $('message').focus(); scroll(); }
  });
  modes();
  if (location.protocol === 'file:') { notice('file://では動作しません。node server.mjsで起動し、http://127.0.0.1:8787 を開いてください。'); $('send').disabled = true; $('test-connection').disabled = true; }
})();
