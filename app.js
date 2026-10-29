'use strict';
(() => {
  const $ = id => document.getElementById(id);
  const keyName = 'sarashina-chat:key', settingsName = 'sarashina-chat:settings';
  const thinking = 'sarashina3.2-mini-thinking', guardModel = 'sarashina3-guard';
  let history = [], controller = null, busy = false;
  let effort = 'medium', connected = false, testVersion = 0, timer, started, previousModel;
  const fileMode = location.protocol === 'file:';
  const local = ['localhost', '127.0.0.1'].includes(location.hostname);
  const controls = ['model', 'temperature', 'max-tokens', 'connection', 'stream'];
  function read(store, name) { try { return store.getItem(name); } catch { return null; } }
  function remove(store, name) { try { store.removeItem(name); } catch { /* 保存不可 */ } }
  $('connection').value = 'auto';
  try {
    const saved = JSON.parse(read(localStorage, settingsName) || '{}');
    for (const id of controls) {
      if (saved[id] !== undefined) {
        if (id === 'stream') $(id).checked = saved[id] === true;
        else $(id).value = saved[id];
      }
    }
    if (!$('model').value) $('model').value = thinking;
    if (!$('connection').value) $('connection').value = 'auto';
    if (['low', 'medium', 'high'].includes(saved.effort)) effort = saved.effort;
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
    const value = { effort };
    for (const id of controls) value[id] = id === 'stream' ? $(id).checked : $(id).value;
    try { localStorage.setItem(settingsName, JSON.stringify(value)); } catch { /* メモリのみ */ }
  }
  function modes() {
    const guard = $('model').value === guardModel;
    $('effort-control').hidden = $('model').value !== thinking;
    $('system-badge').hidden = !$('system-prompt').value;
    $('system-prompt').disabled = guard || busy;
    $('temperature-control').hidden = guard;
    $('temperature').disabled = guard || busy;
    $('max-tokens').disabled = guard || busy;
    $('guard-note').hidden = !guard;
    for (const button of document.querySelectorAll('[data-effort]')) { button.setAttribute('aria-pressed', String(button.dataset.effort === effort)); button.disabled = busy; }
    refresh();
  }
  function notice(text) { const p = document.createElement('p'); p.className = 'notice'; p.textContent = text; $('chat-log').append(p); refresh(); }
  let nearBottom = true;
  function scroll() { if (nearBottom) window.scrollTo({ top: document.documentElement.scrollHeight }); }
  function refresh() {
    const demo = fileMode || (!local && $('connection').value === 'auto');
    $('welcome').hidden = $('chat-log').children.length > 0;
    $('demo-card').hidden = !demo;
    $('setup-card').hidden = demo || connected;
    $('send').disabled = busy || fileMode || !$('api-key').value.trim();
    $('message').placeholder = !$('api-key').value.trim() ? 'APIキーを設定すると送信できます' : $('model').value === guardModel ? '判定したいテキストを入力' : 'メッセージを入力';
    $('connection-chip').textContent = connected ? '接続済み' : '未接続';
    const assistants = [...document.querySelectorAll('.message.assistant')];
    for (const box of assistants) { const button = box.querySelector('.regenerate'); if (button) button.hidden = busy || box !== assistants.at(-1); }
    for (const button of document.querySelectorAll('.retry')) button.disabled = busy;
  }
  function action(label, callback, className = '') {
    const button = document.createElement('button'); button.type = 'button'; button.textContent = label; button.className = className; button.addEventListener('click', callback); return button;
  }
  function copyButton(text) {
    return action('コピー', async event => { const button = event.currentTarget; try { await navigator.clipboard.writeText(text); button.textContent = 'コピー済み'; } catch { /* 権限なし */ } });
  }
  function richText(target, text) {
    target.replaceChildren();
    text.split('```').forEach((part, index) => {
      if (index % 2) {
        const block = document.createElement('div'); block.className = 'code-block';
        const code = part.replace(/^[ \t]*[\w+#.-]*[ \t]*\r?\n/, '');
        const pre = document.createElement('pre'); pre.textContent = code; block.append(copyButton(code), pre); target.append(block);
      } else if (part) { const paragraph = document.createElement('p'); paragraph.textContent = part; target.append(paragraph); }
    });
  }
  function bubble(role, text) {
    const box = document.createElement('article'); box.className = 'message ' + role;
    const label = document.createElement('div'); label.className = 'speaker'; label.textContent = role === 'user' ? 'あなた' : 'Sarashina（' + $('model').value + '）';
    const content = document.createElement('div'); content.className = 'content'; content.textContent = text;
    box.append(label, content); $('chat-log').append(box); refresh(); scroll();
    return { box, content };
  }
  function note(target, text, warning = false) { const p = document.createElement('p'); p.className = warning ? 'note warning' : 'note'; p.textContent = text; target.box.append(p); scroll(); }
  const errors = {400:'パラメータが不正です',401:'APIキーが無効か未設定です',403:'アクセスが拒否されました。日本国外からの接続やVPN経由では利用できない場合があります',404:'エンドポイントが見つかりません',413:'入力が大きすぎます',429:'レート制限に達しました。少し待ってから再試行してください',500:'Sarashina側の障害の可能性があります。時間をおいて再試行してください',503:'Sarashina側の障害の可能性があります。時間をおいて再試行してください'};
  async function responseError(response) {
    let message = '';
    try { const body = await response.json(); if (typeof body.message === 'string') message = body.message; } catch { /* ステータスで説明 */ }
    return new Error((errors[response.status] || '応答を処理できませんでした') + '（HTTP ' + response.status + '）' + (message ? '：' + redact(message) : ''));
  }
  function errorText(error) {
    if (error.name === 'AbortError') return '停止しました。';
    if (error instanceof TypeError) return 'ネットワークエラー。直接接続がCORSでブロックされている可能性があります。ローカルプロキシ方式（node server.mjs）をお試しください。';
    return redact(error.message || '処理に失敗しました。');
  }
  function redact(text) { const key = $('api-key').value; return key ? text.split(key).join('［非表示］') : text; }
  function endpoint(path) { return ($('connection').value === 'proxy' || ($('connection').value === 'auto' && local)) ? '/api/' + path : 'https://api.sarashina.ai/v1/' + path; }
  function headers() { return { Authorization: 'Bearer ' + $('api-key').value, 'Content-Type': 'application/json' }; }
  function setBusy(value) {
    busy = value;
    for (const id of [...controls, 'api-key', 'save-key', 'test-connection', 'system-prompt', 'new-chat', 'send', 'settings-toggle', 'toggle-key', 'delete-key']) $(id).disabled = value;
    $('stop').hidden = !value; $('send').hidden = value;
    clearInterval(timer); started = Date.now();
    const tick = () => { $('generation-status').textContent = value ? ($('model').value === thinking ? '考えています… ' : '生成中… ') + Math.floor((Date.now() - started) / 1000) + '秒' : ''; };
    tick(); if (value) timer = setInterval(tick, 1000);
    modes();
  }
  function metadata(target, usage, finish) {
    if (finish === 'length') note(target, '出力上限に達して途中で終了しました（max_completion_tokensを大きくしてください）', true);
    if (usage) note(target, '使用トークン：' + JSON.stringify(usage));
  }
  $('toggle-key').addEventListener('click', () => { const show = $('api-key').type === 'password'; $('api-key').type = show ? 'text' : 'password'; $('toggle-key').textContent = show ? '隠す' : '表示'; });
  function invalidateConnection() { testVersion++; connected = false; $('connection-status').textContent = ''; refresh(); }
  $('api-key').addEventListener('input', () => { saveKey(); invalidateConnection(); });
  $('api-key').addEventListener('paste', () => { setTimeout(() => { saveKey(); testConnection(); }, 0); });
  $('save-key').addEventListener('change', saveKey);
  $('delete-key').addEventListener('click', () => { $('api-key').value = ''; remove(localStorage, keyName); remove(sessionStorage, keyName); invalidateConnection(); });
  function openSettings() { $('settings').hidden = false; $('settings-toggle').setAttribute('aria-expanded', 'true'); $('api-key').focus(); }
  $('setup-key').addEventListener('click', openSettings);
  $('settings-toggle').addEventListener('click', () => { $('settings').hidden = !$('settings').hidden; $('settings-toggle').setAttribute('aria-expanded', String(!$('settings').hidden)); });
  $('system-prompt').addEventListener('input', modes);
  for (const button of document.querySelectorAll('[data-effort]')) button.addEventListener('click', () => { effort = button.dataset.effort; modes(); saveSettings(); });
  function clearChat() { history = []; $('chat-log').replaceChildren(); refresh(); }
  previousModel = $('model').value;
  for (const id of controls) $(id).addEventListener('change', () => {
    if (id === 'model') {
      if (history.length && !confirm('モデルを切り替えると現在の会話はリセットされます。切り替えますか？')) { $('model').value = previousModel; return; }
      clearChat(); previousModel = $('model').value;
    }
    if (id === 'connection') invalidateConnection();
    modes(); saveSettings();
  });
  $('new-chat').addEventListener('click', clearChat);
  $('stop').addEventListener('click', () => controller?.abort());
  document.addEventListener('keydown', event => { if (event.key === 'Escape') controller?.abort(); });
  async function testConnection() {
    if (fileMode || busy) return;
    const version = ++testVersion;
    if (!$('api-key').value.trim()) { $('connection-status').textContent = errors[401]; return; }
    connected = false; $('connection-chip').textContent = '接続中…'; $('connection-status').textContent = '接続を確認中…';
    try {
      const response = await fetch(endpoint('models'), { headers: headers() });
      if (!response.ok) throw await responseError(response);
      const data = await response.json();
      if (version !== testVersion) return;
      connected = true; $('connection-status').textContent = '接続OK（モデル' + (Array.isArray(data.data) ? data.data.length : 0) + '件）';
    } catch (error) { if (version === testVersion) $('connection-status').textContent = errorText(error); }
    finally { if (version === testVersion) refresh(); }
  }
  $('test-connection').addEventListener('click', testConnection);
  function grow() { $('message').style.height = 'auto'; $('message').style.height = Math.min($('message').scrollHeight, 180) + 'px'; }
  $('message').addEventListener('input', grow);
  for (const button of $('examples').children) button.addEventListener('click', () => { $('message').value = button.textContent; grow(); $('message').focus(); });
  window.addEventListener('scroll', () => { nearBottom = document.documentElement.scrollHeight - window.innerHeight - window.scrollY < 150; $('latest').hidden = nearBottom; }, { passive: true });
  $('latest').addEventListener('click', () => { nearBottom = true; scroll(); $('latest').hidden = true; });
  function resend(input) { if (busy || fileMode || !$('api-key').value.trim()) return; $('message').value = input; $('composer').requestSubmit(); }
  $('message').addEventListener('keydown', event => {
    if (event.key === 'Enter' && !event.shiftKey && !event.isComposing && event.keyCode !== 229) { event.preventDefault(); if (!busy) $('composer').requestSubmit(); }
  });
  $('composer').addEventListener('submit', async event => {
    event.preventDefault(); if (busy || fileMode) return;
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
    if (model === thinking) payload.reasoning_effort = effort;
    saveKey(); saveSettings(); setBusy(true); controller = new AbortController();
    const userBubble = bubble('user', input); const target = bubble('assistant', ''); $('message').value = ''; grow();
    let content = '', reasoning = '', usage, finish, done = false, hasReasoning = false;
    const toolCalls = [];
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
          if (typeof choice?.delta?.reasoning === 'string') { hasReasoning = true; reasoning += choice.delta.reasoning; }
          for (const delta of choice?.delta?.tool_calls || []) {
            const index = delta.index ?? 0;
            const call = toolCalls[index] ||= { type: 'function', function: { name: '', arguments: '' } };
            if (delta.id) call.id = delta.id;
            if (delta.type) call.type = delta.type;
            if (delta.function?.name) call.function.name += delta.function.name;
            if (delta.function?.arguments) call.function.arguments += delta.function.arguments;
          }
          richText(target.content, content); scroll();
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
        assistant = { role: 'assistant', content, ...(hasReasoning ? { reasoning } : {}), ...(toolCalls.length ? { tool_calls: toolCalls } : {}) };
      } else {
        const data = await response.json(), message = data.choices?.[0]?.message;
        if (!message || !('content' in message)) throw new Error('応答の形式が不正です。');
        assistant = { role: 'assistant' };
        for (const field of ['content', 'reasoning', 'tool_calls']) if (Object.hasOwn(message, field)) assistant[field] = message[field];
        content = typeof message.content === 'string' ? message.content : ''; richText(target.content, content);
        usage = data.usage; finish = data.choices[0].finish_reason;
      }
      if (controller.signal.aborted) throw new DOMException('停止', 'AbortError');
      if (!guard) history.push(user, assistant);
      connected = true;
      metadata(target, usage, finish);
      const actions = document.createElement('div'); actions.className = 'message-actions'; actions.append(copyButton(content));
      actions.append(action('再生成', () => {
        if (busy || fileMode || !$('api-key').value.trim()) return;
        if (!guard) history.splice(-2);
        userBubble.box.remove(); target.box.remove(); resend(input);
      }, 'regenerate'));
      target.box.append(actions);
    } catch (error) { target.box.classList.add('incomplete'); note(target, errorText(error), true); note(target, '中断またはエラーのため履歴に含まれていません'); target.box.append(action('再試行', () => resend(input), 'retry')); }
    finally { controller = null; setBusy(false); $('message').focus(); scroll(); }
  });
  modes();
  if (fileMode) { $('demo-text').textContent = 'file://では動作しません。node server.mjsで起動し、http://127.0.0.1:8787 を開いてください。'; $('send').disabled = true; $('test-connection').disabled = true; }
  refresh();
})();
