import http from 'node:http';
import { readFile, realpath, stat } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { once } from 'node:events';
const root = path.dirname(fileURLToPath(import.meta.url));
const types = { '.html': 'text/html; charset=utf-8', '.css': 'text/css; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.mjs': 'text/javascript; charset=utf-8', '.json': 'application/json; charset=utf-8', '.md': 'text/plain; charset=utf-8' };
function json(res, status, message) { if (!res.headersSent) { res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' }); res.end(JSON.stringify({ message })); } else res.destroy(); }
const server = http.createServer(async (req, res) => {
  const pathname = (req.url || '/').split('?')[0];
  if (pathname.startsWith('/api/')) {
    const routes = { '/api/chat/completions': ['POST', '/chat/completions'], '/api/models': ['GET', '/models'] };
    const route = routes[pathname];
    if (!route) { json(res, 404, 'エンドポイントが見つかりません'); return; }
    if (req.method !== route[0]) { json(res, 405, '許可されていないメソッドです'); return; }
    const abort = new AbortController();
    req.on('aborted', () => abort.abort());
    req.on('close', () => { if (!req.complete) abort.abort(); });
    res.on('close', () => { if (!res.writableEnded) abort.abort(); });
    try {
      const headers = {};
      for (const name of ['authorization', 'content-type']) if (req.headers[name]) headers[name] = req.headers[name];
      let body;
      if (req.method === 'POST') {
        const chunks = []; let size = 0;
        for await (const chunk of req) {
          size += chunk.length;
          if (size > 8 * 1024 * 1024) { json(res, 413, '入力が大きすぎます'); return; }
          chunks.push(chunk);
        }
        body = Buffer.concat(chunks);
      }
      const upstream = await fetch('https://api.sarashina.ai/v1' + route[1], {
        method: req.method, headers, signal: abort.signal,
        ...(body ? { body } : {}), redirect: 'error'
      });
      const outHeaders = {};
      for (const name of ['content-type', 'cache-control', 'retry-after']) if (upstream.headers.has(name)) outHeaders[name] = upstream.headers.get(name);
      res.writeHead(upstream.status, outHeaders); res.flushHeaders();
      if (upstream.body) {
        const reader = upstream.body.getReader();
        try {
          while (true) {
            const { done, value } = await reader.read(); if (done) break;
            if (!res.write(value)) await once(res, 'drain', { signal: abort.signal });
          }
        } finally { await reader.cancel().catch(() => {}); reader.releaseLock(); }
      }
      res.end();
    } catch { if (!abort.signal.aborted) json(res, 502, '上流APIへの接続に失敗しました'); }
    return;
  }
  if (!['GET', 'HEAD'].includes(req.method)) { json(res, 405, '許可されていないメソッドです'); return; }
  try {
    const decoded = decodeURIComponent(pathname);
    const filename = path.resolve(root, '.' + (decoded === '/' ? '/index.html' : decoded));
    const inside = candidate => candidate.startsWith(root + path.sep);
    if (!inside(filename) || decoded.includes('\0') || decoded.split('/').some(part => part.startsWith('.'))) { json(res, 403, 'アクセスが拒否されました'); return; }
    const resolved = await realpath(filename);
    if (!inside(resolved)) { json(res, 403, 'アクセスが拒否されました'); return; }
    if (!(await stat(resolved)).isFile()) { json(res, 404, 'ファイルが見つかりません'); return; }
    const body = await readFile(resolved);
    res.writeHead(200, { 'Content-Type': types[path.extname(resolved)] || 'text/plain; charset=utf-8', 'X-Content-Type-Options': 'nosniff', ...(path.extname(resolved) === '.html' ? { 'Cache-Control': 'no-store' } : {}) });
    res.end(req.method === 'HEAD' ? undefined : body);
  } catch { json(res, 404, 'ファイルが見つかりません'); }
});
server.requestTimeout = 0;
server.timeout = 0;
server.listen(Number(process.env.PORT || 8787), '127.0.0.1', () => console.log('Sarashina Chat: http://127.0.0.1:' + server.address().port));
