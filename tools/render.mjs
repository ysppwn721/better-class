#!/usr/bin/env node
/* ============================================================================
 * tools/render.mjs — 渲染 App 并截图 + 自检
 *
 * 走「本地开发服务器 + CDP 导航」这条链条（与 APK 的 http://localhost 环境一致）。
 * 渲染前先清空 localStorage 并重新载入，保证自检起点一致。
 *
 * 前置：先启动开发服务器  node server.mjs 5173
 *
 * 用法：
 *   node tools/render.mjs                 # 420x900 浅色 + 内置示例
 *   node tools/render.mjs --dark
 *   node tools/render.mjs --w 360 --h 780 --week 5 --season summer
 *   node tools/render.mjs --empty         # 空状态
 *   node tools/render.mjs --no-demo       # 不载入示例
 * ==========================================================================*/
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(__dirname, '..');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const argv = process.argv.slice(2);
const arg = (n, d) => { const i = argv.indexOf('--' + n); return i >= 0 ? argv[i + 1] : d; };
const has = (n) => argv.includes('--' + n);

const W = Number(arg('w', 420));
const H = Number(arg('h', 900));
const DARK = has('dark');
const WEEK = arg('week', null);
const SEASON = arg('season', null);
const EMPTY = has('empty');
const NO_DEMO = has('no-demo');
const BASE = arg('base', 'http://127.0.0.1:5173/');
const OUT = path.resolve(ROOT, arg('out', `docs/app-${DARK ? 'dark' : 'light'}-${W}x${H}.png`));
const PORT = Number(arg('port', 9520 + (DARK ? 1 : 0)));

const CHROME = [
  path.join(process.env.LOCALAPPDATA || '', 'Google/Chrome/Application/chrome.exe'),
  'C:/Program Files/Google/Chrome/Application/chrome.exe',
  'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
].find((p) => p && fs.existsSync(p));
if (!CHROME) { console.error('✗ 没找到 Chrome/Edge'); process.exit(1); }

// 先探一下服务器
try {
  const r = await fetch(BASE);
  if (!r.ok) throw new Error('HTTP ' + r.status);
} catch (e) {
  console.error(`✗ 开发服务器不可用（${BASE}）：${e.message}\n  请先运行： node server.mjs 5173`);
  process.exit(1);
}

const profileDir = fs.mkdtempSync(path.join(os.tmpdir(), 'bc-render-'));
const chrome = spawn(CHROME, [
  '--headless=new', '--disable-gpu', '--no-first-run', '--no-default-browser-check',
  '--hide-scrollbars', '--force-device-scale-factor=2',
  `--remote-debugging-port=${PORT}`, `--user-data-dir=${profileDir}`, 'about:blank',
], { stdio: 'ignore' });
const cleanup = () => { try { chrome.kill(); } catch {} try { fs.rmSync(profileDir, { recursive: true, force: true }); } catch {} };
process.on('exit', cleanup);

let wsUrl = null;
for (let i = 0; i < 60 && !wsUrl; i++) {
  try { wsUrl = (await (await fetch(`http://127.0.0.1:${PORT}/json/version`)).json()).webSocketDebuggerUrl; } catch {}
  if (!wsUrl) await sleep(200);
}
if (!wsUrl) { console.error('✗ Chrome 调试端口未就绪'); process.exit(1); }

const sock = new WebSocket(wsUrl);
await new Promise((res, rej) => { sock.onopen = res; sock.onerror = rej; });
let id = 0; const pend = new Map(); const pageErrors = [];
sock.onmessage = (e) => {
  const m = JSON.parse(e.data);
  if (m.id && pend.has(m.id)) {
    const p = pend.get(m.id); pend.delete(m.id);
    m.error ? p.reject(new Error(JSON.stringify(m.error))) : p.resolve(m.result);
    return;
  }
  if (m.method === 'Runtime.exceptionThrown') pageErrors.push('[exception] ' + (m.params.exceptionDetails.exception?.description || m.params.exceptionDetails.text));
  if (m.method === 'Runtime.consoleAPICalled' && m.params.type === 'error') {
    pageErrors.push('[console.error] ' + m.params.args.map((a) => a.value ?? a.description ?? a.type).join(' '));
  }
};
const send = (method, params = {}, sid) => new Promise((resolve, reject) => {
  const i = ++id; pend.set(i, { resolve, reject });
  sock.send(JSON.stringify({ id: i, method, params, ...(sid ? { sessionId: sid } : {}) }));
});

const { targetId } = await send('Target.createTarget', { url: 'about:blank' });
const { sessionId } = await send('Target.attachToTarget', { targetId, flatten: true });
const S = (m, p) => send(m, p, sessionId);

await S('Page.enable');
await S('Runtime.enable');
await S('Emulation.setDeviceMetricsOverride', { width: W, height: H, deviceScaleFactor: 2, mobile: true });
await S('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-color-scheme', value: DARK ? 'dark' : 'light' }] });

async function goto() {
  await S('Page.navigate', { url: BASE });
  await sleep(1400);
}
await goto();

// 清空存储 → 重新载入 → 载入示例
await S('Runtime.evaluate', { expression: `localStorage.clear()` });
await goto();
if (!NO_DEMO && !EMPTY) {
  await S('Runtime.evaluate', { expression: 'window.__loadDemo && window.__loadDemo()', awaitPromise: true });
  await sleep(400);
}
await S('Runtime.evaluate', {
  expression: `(() => {
    const a = window.__app; if (!a) return;
    ${EMPTY ? 'a.state.courses = [];' : ''}
    ${DARK ? "a.state.settings.theme='dark';" : "a.state.settings.theme='light';"}
    ${WEEK ? `a.ui.week=${Number(WEEK)};` : ''}
    ${SEASON ? `a.ui.autoSeason=false; a.ui.season='${SEASON}';` : ''}
    document.documentElement.dataset.theme = ${DARK} ? 'dark' : 'light';
    a.render();
  })()`,
});
await sleep(600);

const diag = await S('Runtime.evaluate', {
  expression: `(() => {
    try {
      const q = (s) => [...document.querySelectorAll(s)];
      const app = window.__app;
      const box = (e) => { if (!e) return null; const r = e.getBoundingClientRect(); return { w: +r.width.toFixed(1), h: +r.height.toFixed(1), x: +r.x.toFixed(1), y: +r.y.toFixed(1) }; };
      const cards = q('.course').map((c) => ({
        name: c.querySelector('.name')?.textContent || '',
        where: c.querySelector('.where')?.textContent || '',
        grid: 'col=' + (c.style.gridColumn || '?') + ' row=' + (c.style.gridRow || '?'),
        box: box(c),
        clipped: c.scrollHeight > c.clientHeight + 1,
      }));
      const sc = document.getElementById('boardScroll');
      const cols = document.getElementById('cols');
      const cs = getComputedStyle(document.documentElement);
      return JSON.stringify({
        booted: !!app,
        title: document.getElementById('appTitle')?.textContent,
        sub: document.getElementById('appSub')?.textContent,
        week: document.getElementById('weekLabel')?.textContent,
        range: document.getElementById('weekDate')?.textContent,
        theme: document.documentElement.dataset.theme,
        col: cs.getPropertyValue('--col').trim(),
        axisW: cs.getPropertyValue('--axis-w').trim(),
        dayhead: q('.dayhead-cell').map((c) => c.textContent),
        axisCells: q('.axis-cell').map((c) => c.textContent.replace(/\\s+/g, ' ')),
        cardCount: cards.length,
        total: app ? app.state.courses.length : -1,
        cards: cards.slice(0, 5),
        clipped: cards.filter((c) => c.clipped).map((c) => c.name),
        boardW: box(document.getElementById('board'))?.w,
        colsW: box(cols)?.w,
        scrollW: sc?.clientWidth,
        hOverflow: sc ? sc.scrollWidth > sc.clientWidth + 1 : null,
        nowline: !!document.querySelector('.nowline'),
        emptyHint: !!document.querySelector('.empty-hint'),
        viewport: innerWidth + 'x' + innerHeight,
      }, null, 1);
    } catch (err) { return 'DIAG_ERROR: ' + err.message; }
  })()`,
  returnByValue: true,
});

const shot = await S('Page.captureScreenshot', { format: 'png', captureBeyondViewport: true });
fs.mkdirSync(path.dirname(OUT), { recursive: true });
fs.writeFileSync(OUT, Buffer.from(shot.data, 'base64'));

console.log('=== 自检报告 ===');
console.log(diag.result.value);
if (pageErrors.length) console.log('\n=== 页面报错 ===\n' + pageErrors.join('\n'));
console.log(`\n截图：${OUT}  (${(fs.statSync(OUT).size / 1024).toFixed(0)} KB)`);
sock.close();
process.exit(0);
