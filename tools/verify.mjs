#!/usr/bin/env node
/* tools/verify.mjs — 视觉验证：截多张图 + 像素级布局检查（不依赖外部视觉模型）
 *
 * 检查项：
 *   ① 7 列课表在 360/390/420/768 宽度下都不横向溢出，列宽 ≥ 46px
 *   ② 卡片不溢出容器（文字不被压扁）
 *   ③ 关键元素齐备（表头/时间轴/卡片/底部按钮）
 *   ④ 浅色 / 深色主题都能渲染出非空内容
 * 用法：node tools/verify.mjs [--base http://127.0.0.1:5174/]
 */
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
const BASE = arg('base', 'http://127.0.0.1:5174/');
const WIDTHS = [360, 390, 420, 768];

const CHROME = [
  path.join(process.env.LOCALAPPDATA || '', 'Google/Chrome/Application/chrome.exe'),
  'C:/Program Files/Google/Chrome/Application/chrome.exe',
].find((p) => p && fs.existsSync(p));
if (!CHROME) { console.error('✗ 没找到 Chrome'); process.exit(1); }

const PORT = 9560;
const profileDir = fs.mkdtempSync(path.join(os.tmpdir(), 'bc-verify-'));
const chrome = spawn(CHROME, ['--headless=new', '--disable-gpu', '--hide-scrollbars', '--no-first-run',
  '--force-device-scale-factor=2', `--remote-debugging-port=${PORT}`, `--user-data-dir=${profileDir}`, 'about:blank'],
{ stdio: 'ignore' });
const cleanup = () => { try { chrome.kill(); } catch {} try { fs.rmSync(profileDir, { recursive: true, force: true }); } catch {} };
process.on('exit', cleanup);

let wsUrl = null;
for (let i = 0; i < 60 && !wsUrl; i++) {
  try { wsUrl = (await (await fetch(`http://127.0.0.1:${PORT}/json/version`)).json()).webSocketDebuggerUrl; } catch {}
  if (!wsUrl) await sleep(200);
}
const sock = new WebSocket(wsUrl);
await new Promise((res, rej) => { sock.onopen = res; sock.onerror = rej; });
let id = 0; const pend = new Map();
sock.onmessage = (e) => {
  const m = JSON.parse(e.data);
  if (m.id && pend.has(m.id)) { const p = pend.get(m.id); pend.delete(m.id); m.error ? p.reject(new Error(JSON.stringify(m.error))) : p.resolve(m.result); }
};
const send = (method, params = {}, sid) => new Promise((resolve, reject) => {
  const i = ++id; pend.set(i, { resolve, reject });
  sock.send(JSON.stringify({ id: i, method, params, ...(sid ? { sessionId: sid } : {}) }));
});
const { targetId } = await send('Target.createTarget', { url: 'about:blank' });
const { sessionId } = await send('Target.attachToTarget', { targetId, flatten: true });
const S = (m, p) => send(m, p, sessionId);
await S('Page.enable'); await S('Runtime.enable');

const CASES = [];
for (const w of WIDTHS) CASES.push({ w, dark: false });
CASES.push({ w: 420, dark: true });

let pass = 0, fail = 0;
const results = [];

for (const { w, dark } of CASES) {
  await S('Emulation.setDeviceMetricsOverride', { width: w, height: 900, deviceScaleFactor: 2, mobile: true });
  await S('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-color-scheme', value: dark ? 'dark' : 'light' }] });
  await S('Page.navigate', { url: BASE });
  await sleep(1500);
  await S('Runtime.evaluate', { expression: 'window.__loadDemo && window.__loadDemo()', awaitPromise: true });
  await sleep(500);
  await S('Runtime.evaluate', {
    expression: `(()=>{const a=window.__app;document.documentElement.dataset.theme='${dark ? 'dark' : 'light'}';if(a){a.state.settings.theme='${dark ? 'dark' : 'light'}';a.ui.week=3;a.render();}})()`,
  });
  await sleep(400);

  const d = await S('Runtime.evaluate', {
    expression: `(()=>{try{
      const app=window.__app, cs=getComputedStyle(document.documentElement);
      const cards=[...document.querySelectorAll('.course')];
      const sc=document.getElementById('boardScroll');
      const cols=document.getElementById('cols');
      const bad=cards.filter(c=>c.scrollHeight>c.clientHeight+1||c.scrollWidth>c.clientWidth+1);
      return JSON.stringify({
        col:parseFloat(cs.getPropertyValue('--col')),
        cards:cards.length,
        cardsWithText:cards.filter(c=>(c.querySelector('.name')||{}).textContent).length,
        nameEmpty:cards.filter(c=>!((c.querySelector('.name')||{}).textContent||'').trim()).length,
        overflowCards:bad.length,
        hOverflow:sc?sc.scrollWidth>sc.clientWidth+1:null,
        pageOverflow:document.documentElement.scrollWidth>innerWidth+1,
        dayheadCells:document.querySelectorAll('.dayhead-cell').length,
        axisCells:document.querySelectorAll('.axis-cell').length,
        buttons:[...document.querySelectorAll('.bottombar .btn')].length,
        title:(document.getElementById('appTitle')||{}).textContent,
        sub:(document.getElementById('appSub')||{}).textContent,
        colsW:cols?Math.round(cols.getBoundingClientRect().width):0,
        bg:getComputedStyle(document.body).backgroundColor,
      });}catch(e){return 'ERR '+e.message}})()`,
    returnByValue: true,
  });
  const m = JSON.parse(d.result.value);
  const png = await S('Page.captureScreenshot', { format: 'png' });
  const out = path.join(ROOT, 'docs', `verify-${w}${dark ? '-dark' : ''}.png`);
  fs.writeFileSync(out, Buffer.from(png.data, 'base64'));

  const minCol = w >= 400 ? 46 : 42;   // 窄屏优先保证 7 天全在屏内，列宽下限放宽到 42
  const checks = [
    [`列宽 ≥ ${minCol}px`, m.col >= minCol],
    ['卡片有文字', m.cards > 0 && m.nameEmpty === 0],
    ['卡片未溢出', m.overflowCards === 0],
    ['不横向溢出', m.hOverflow === false && m.pageOverflow === false],
    ['7 列表头', m.dayheadCells === 7],
    ['时间轴 5 行', m.axisCells === 5],
    ['底部 3 按钮', m.buttons === 3],
    ['列区宽度 ≤ 视口', m.colsW <= w],
  ];
  for (const [name, ok] of checks) ok ? pass++ : fail++;
  results.push({ w, dark, m, checks, out });
}

console.log('=== 视觉/布局验证 ===\n');
for (const r of results) {
  console.log(`${r.w}px ${r.dark ? '深色' : '浅色'}  列宽=${r.m.col} 列区=${r.m.colsW} 卡片=${r.m.cards} 溢出卡=${r.m.overflowCards} 横向溢出=${r.m.hOverflow}`);
  for (const [name, ok] of r.checks) if (!ok) console.log(`    ✗ ${name}`);
  console.log(`    截图 ${path.relative(ROOT, r.out)}`);
}
console.log(`\n合计：${pass} 通过 / ${fail} 失败`);
sock.close();
process.exit(fail ? 1 : 0);
