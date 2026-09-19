#!/usr/bin/env node
/* ============================================================================
 * server.mjs — 本地开发服务器（零依赖）
 *
 * 用途：浏览器直接打开 index.html（file://）时 ES Module 会被 CORS 拦住，
 *       所以开发/调试请走这个服务器。
 *
 * 用法：  node server.mjs [port]
 * 然后浏览器访问 http://127.0.0.1:5173
 *
 * 附加能力：
 *   POST /vision/extract-schedule  { image, prompt }
 *     → 由 DSH 侧 better-class 插件接管（若已注入插件则可用「本机视觉服务」通道）
 *     未注入插件时返回 503，前端会自动退到其它识别通道。
 * ==========================================================================*/
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
/** 静态根目录：默认 src（源码版，便于改完刷新即见）；BC_ROOT=apk 时服务打包后的单文件版 */
const ROOT = process.env.BC_ROOT === 'apk'
  ? path.join(__dirname, 'apk', 'www')
  : path.join(__dirname, 'src');
const PORT = Number(process.argv[2] || process.env.PORT || 5173);
const DSH_VISION = process.env.DSH_VISION_URL || 'http://127.0.0.1:3080/vision/extract-schedule';

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
  '.woff2': 'font/woff2',
};

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host}`);

  // --- 视觉识别代理：转发到 DSH 侧插件 ---
  if (url.pathname === '/vision/extract-schedule') {
    if (req.method !== 'POST') { res.writeHead(405).end('method not allowed'); return; }
    const body = await readBody(req);
    try {
      const upstream = await fetch(DSH_VISION, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body,
      });
      const text = await upstream.text();
      res.writeHead(upstream.status, { 'Content-Type': upstream.headers.get('content-type') || 'application/json' });
      res.end(text);
    } catch (e) {
      res.writeHead(503, { 'Content-Type': 'application/json; charset=utf-8' });
      res.end(JSON.stringify({
        error: `本机视觉服务未就绪（${e.message}）。请在「设置」里改用其它识别通道，或先用「粘贴文本」导入。`,
      }));
    }
    return;
  }

  // --- 静态文件 ---
  let rel = decodeURIComponent(url.pathname);
  if (rel === '/' || rel === '') rel = '/index.html';
  const abs = path.join(ROOT, path.normalize(rel).replace(/^([/\\])+/, ''));
  if (!abs.startsWith(ROOT)) { res.writeHead(403).end('forbidden'); return; }

  fs.readFile(abs, (err, data) => {
    if (err) {
      res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
      res.end('404 ' + rel);
      return;
    }
    // 注意：必须用「解析后的文件路径」判断 MIME，
    // 不能用带 query 的 URL（/?demo=1 的 extname 是 ".1"，会把 HTML 当二进制发出去）
    res.writeHead(200, {
      'Content-Type': MIME[path.extname(abs).toLowerCase()] || 'application/octet-stream',
      'Cache-Control': 'no-store',
    });
    res.end(data);
  });
});

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on('data', (c) => {
      size += c.length;
      if (size > 25 * 1024 * 1024) { reject(new Error('请求体过大')); req.destroy(); return; }
      chunks.push(c);
    });
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

server.listen(PORT, '127.0.0.1', () => {
  console.log(`课表应用开发服务器：http://127.0.0.1:${PORT}`);
  console.log(`静态根目录：${ROOT}`);
  console.log(`视觉代理：${DSH_VISION}`);
});
