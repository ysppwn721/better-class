#!/usr/bin/env node
/* tools/dump_dom.mjs — 用 Chrome --dump-dom 抓「单文件 App」真实渲染结果
 * 这是绕开 CDP 导航怪癖的可靠验证路径：把一个临时副本（剥掉旧脚本、注入 bundle）
 * 丢给 Chrome 渲染，然后解析 DOM 里的关键元素。
 *
 * 用法：node tools/dump_dom.mjs [file] [extraJs]
 *   extraJs 会在 bundle 之后执行，可用来注入演示数据
 */
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(__dirname, '..');
const CHROME = [
  path.join(process.env.LOCALAPPDATA || '', 'Google/Chrome/Application/chrome.exe'),
  'C:/Program Files/Google/Chrome/Application/chrome.exe',
  'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
].find((p) => p && fs.existsSync(p));
if (!CHROME) { console.error('✗ 没找到浏览器'); process.exit(1); }

const file = path.resolve(ROOT, process.argv[2] || 'apk/www/index.html');
// 第 3 个参数（非 -- 开头）作为额外注入的 JS；--demo 快捷注入内置示例
const extraArg = process.argv.slice(3).find((a) => !a.startsWith('--')) || '';
const wantDemo = process.argv.includes('--demo');
const extraJs = wantDemo
  ? `${extraArg}\nwindow.__loadDemo && window.__loadDemo();`
  : extraArg;
const html = fs.readFileSync(file, 'utf8').replace(/^\uFEFF/, '');

// 取出内联 bundle（就是那个不带 src 的 <script>）
const m = html.match(/<script>([\s\S]*?)<\/script>/);
if (!m) { console.error('✗ 找不到内联脚本'); process.exit(1); }
const bundle = m[1];

// 重建：保留 CSS / body 结构，去掉所有脚本，再注入 bundle + extraJs
const shell = html
  .replace(/<script[\s\S]*?<\/script>/g, '')
  .replace('</body>', '');
// --trace：把 bundle 包进 try/catch，并把错误写进 <title>，用于定位「脚本没跑起来」
const TRACE = process.argv.includes('--trace');
const wrapped = TRACE
  ? `window.onerror=function(m,s,l,c,e){document.title='ONERROR: '+String(m)+' @line'+l;};\n` +
    `try{\n${bundle}\n}catch(e){document.title='CATCH: '+String(e&&e.message||e).slice(0,180);}`
  : bundle;
const page = shell + '<script>' + wrapped + '\n' + extraJs + '</script></body></html>';

const tmp = path.join(os.tmpdir(), `bc-dump-${Date.now()}.html`);
fs.writeFileSync(tmp, Buffer.from(page, 'utf8'));

let dom = '';
try {
  dom = execFileSync(CHROME, ['--headless=new', '--disable-gpu', '--hide-scrollbars',
    '--virtual-time-budget=4000', '--dump-dom', 'file:///' + tmp.replace(/\\/g, '/')],
  { encoding: 'utf8', maxBuffer: 128 * 1024 * 1024, stdio: ['ignore', 'pipe', 'ignore'] });
} catch (e) {
  console.error('✗ Chrome 渲染失败：' + e.message);
  process.exit(1);
}

const count = (re) => (dom.match(re) || []).length;
const pick = (id) => {
  const mm = dom.match(new RegExp(`id="${id}"[^>]*>([^<]*)<`));
  return mm ? mm[1] : '(空)';
};
const cards = [...dom.matchAll(/<span class="name">([^<]*)<\/span>/g)].map((x) => x[1]);
const wheres = [...dom.matchAll(/<span class="where">([^<]*)<\/span>/g)].map((x) => x[1]);

console.log('=== 渲染结果（dump-dom）===');
console.log(`文件            : ${path.relative(ROOT, file)}  (${(html.length / 1024).toFixed(1)} KB)`);
console.log(`<title>         : ${(dom.match(/<title>([^<]*)<\/title>/) || [])[1] || '(空)'}`);
console.log(`标题            : ${pick('appTitle')}`);
console.log(`副标题          : ${pick('appSub')}`);
console.log(`当前周          : ${pick('weekLabel')} ${pick('weekDate')}`);
console.log(`星期表头格数    : ${count(/class="dayhead-cell/g)}  → ${[...dom.matchAll(/class="dow">([^<]*)<\/span><span class="dom">([^<]*)</g)].map((x) => x[1] + x[2]).join(' ')}`);
console.log(`时间轴行数      : ${count(/class="axis-cell/g)}`);
console.log(`课程卡片数      : ${count(/class="course"/g)}`);
console.log(`空态提示        : ${/class="empty-hint"/.test(dom) ? '有' : '无'}`);
console.log(`引导提示        : ${/class="onboard-tip"/.test(dom) ? '有' : '无'}`);
console.log(`当前时间线      : ${/class="nowline"/.test(dom) ? '有' : '无'}`);
if (cards.length) {
  console.log('卡片（课名 @地点）：');
  cards.forEach((n, i) => console.log(`  ${String(i + 1).padStart(2)}. ${n}  @${wheres[i] || '-'}`));
}

fs.rmSync(tmp, { force: true });
