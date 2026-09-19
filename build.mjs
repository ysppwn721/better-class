#!/usr/bin/env node
/* ============================================================================
 * build.mjs — 零依赖打包脚本
 *
 * 产出两个东西：
 *   1) apk/www/index.html  —— 单文件 App（把 CSS/JS 全部内联）
 *        · 可以直接双击用浏览器打开（file:// 也能跑，不受 ES Module CORS 限制）
 *        · 可以直接丢进 Android WebView / Capacitor 套壳成 APK
 *     同时把 apk/www 复制一份到 dist/ 方便分享
 *   2) 控制台打印产物大小
 *
 * 用法：node build.mjs
 * ==========================================================================*/
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SRC = path.join(__dirname, 'src');
const OUT_DIR = path.join(__dirname, 'apk', 'www');
const DIST_DIR = path.join(__dirname, 'dist');
const ASSET_DIR = path.join(__dirname, 'android', 'app', 'src', 'main', 'assets');

/** 模块按依赖顺序排列（后面的可以用前面的） */
const MODULES = ['parser.js', 'extractor.js', 'demo-data.js', 'app.js'];

function stripModuleSyntax(code, filename) {
  let out = code;

  // 单文件版没有模块系统：把对 demo 数据的动态 import 换成用已内联的全局 DEMO
  out = out.replace(
    /await\s+import\(\s*['"]\.\/demo-data\.js['"]\s*\)/g,
    '({ default: globalThis.DEMO, DEMO: globalThis.DEMO })',
  );
  out = out.replace(
    /await\s+import\(\s*['"]\.\/extractor\.js['"]\s*\)/g,
    '({ extractFromImage: globalThis.extractFromImage })',
  );

  // 去掉 import 语句（含多行形式）
  out = out.replace(/^\s*import\s+[\s\S]*?\s+from\s+['"][^'"]+['"];?\s*$/gm, '');
  out = out.replace(/^\s*import\s+['"][^'"]+['"];?\s*$/gm, '');

  // export ... from '...' （re-export）直接丢弃
  out = out.replace(/^\s*export\s+\*?\s*(?:\{[^}]*\})?\s*from\s+['"][^'"]+['"];?\s*$/gm, '');

  // export default function/class 名称
  out = out.replace(/^\s*export\s+default\s+(function|class)\s+([A-Za-z_$][\w$]*)/gm, '$1 $2');

  // export default <表达式>;  → 变量承接（放在文件末尾统一暴露）
  const defaults = [];
  out = out.replace(/^\s*export\s+default\s+([\s\S]*?);\s*$/gm, (m, expr) => {
    if (/^(function|class)\s/.test(expr.trim())) return expr + ';';
    const name = `__default_${defaults.length}`;
    // 若表达式是简单标识符（export default DEMO），把原名也登记上，
    // 这样内联版里 `window.DEMO` 这类回退引用依然可用（如 loadDemo 的降级分支）。
    const ident = expr.trim().match(/^[A-Za-z_$][\w$]*$/);
    defaults.push([name, expr.trim(), ident ? ident[0] : null]);
    return `const ${name} = ${expr.trim()};`;
  });

  // export const/let/var/function/class/async function
  out = out.replace(/^(\s*)export\s+(async\s+function|function|const|let|var|class)\s/gm, '$1$2 ');

  // export { a, b as c }   → 记录以便末尾统一暴露
  const namedForWindow = [];
  out = out.replace(/^(\s*)export\s*\{([^}]*)\}\s*;?\s*$/gm, (m, indent, body) => {
    for (const part of body.split(',')) {
      const seg = part.trim();
      if (!seg) continue;
      const mm = seg.match(/^([A-Za-z_$][\w$]*)(?:\s+as\s+([A-Za-z_$][\w$]*))?$/);
      if (mm) namedForWindow.push(mm[2] || mm[1]);
    }
    return '';
  });

  const tail = defaults.map(([n, expr, ident]) =>
    `globalThis.${n} = ${expr};` + (ident ? `\nglobalThis.${ident} = ${ident};` : '')).join('\n')
    + (namedForWindow.length ? '\n' + namedForWindow.map((n) => `globalThis.${n} = typeof ${n} !== 'undefined' ? ${n} : undefined;`).join('\n') : '');

  return { code: out, tail, filename };
}

function main() {
  // 去 BOM：某些编辑器/PowerShell 会给文件加 UTF-8 BOM，
  // 带 BOM 的单文件 HTML 在部分浏览器里会整页不渲染（body 为空），必须剥掉。
  const html = fs.readFileSync(path.join(SRC, 'index.html'), 'utf8').replace(/^\uFEFF/, '');

  const bundles = [];
  for (const file of MODULES) {
    const abs = path.join(SRC, file);
    const raw = fs.readFileSync(abs, 'utf8').replace(/^\uFEFF/, '');
    const { code, tail } = stripModuleSyntax(raw, file);
    bundles.push(`/* ===== ${file} ${'='.repeat(Math.max(0, 62 - file.length))} */\n${code}\n${tail}`);
  }

  const js = bundles.join('\n\n');
  // 关键：内联脚本里若出现字面量 </script>（哪怕在注释里），HTML 解析器会提前闭合 <script>，
  // 后面的 JS 会退化成页面文本 —— 表现就是「整页不渲染 / 只显示源码」。
  // 转义成 <\/script> 对 JS 语义无影响（/ 在字符串与注释里等价）。
  const safeJs = js.replace(/<\/script/gi, '<\\/script');
  // 把入口模块脚本换成内联脚本；演示用 seed 的 `import()` 已带 try/catch 回退到全局，无需处理
  const ENTRY_RE = /<script\s+type="module"\s+src="\.\/app\.js"\s*><\/script>/;
  if (!ENTRY_RE.test(html)) {
    console.error('✗ 没找到 <script type="module" src="./app.js"> 占位，index.html 结构可能变了');
    process.exit(1);
  }
  let out = html.replace(ENTRY_RE, () => `<script>\n${safeJs}\n</script>`);

  // 内嵌 AI 通道地址：构建时用 BC_AI_ENDPOINT 注入，让用户零配置即可识别
  const aiEndpoint = (process.env.BC_AI_ENDPOINT || '').trim().replace(/\/+$/, '');
  if (aiEndpoint) {
    const inject = `<script>window.__BC_AI_ENDPOINT=${JSON.stringify(aiEndpoint)};</script>`;
    out = out.replace('</body>', `${inject}\n</body>`);
  }

  // 内联后不再有相对路径依赖；顺便去掉多余的空白行压缩体积
  out = out.replace(/\n{3,}/g, '\n\n').replace(/^\uFEFF/, '');

  const buf = Buffer.from(out, 'utf8');
  for (const dir of [OUT_DIR, DIST_DIR, ASSET_DIR]) {
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'index.html'), buf);
  }

  const kb = (buf.length / 1024).toFixed(1);
  console.log('✓ 打包完成');
  console.log(`  单文件 App：${path.join(OUT_DIR, 'index.html')}  (${kb} KB)`);
  console.log(`  分享副本　：${path.join(DIST_DIR, 'index.html')}`);
  console.log(`  内嵌 AI 通道：${aiEndpoint || '（未设置 BC_AI_ENDPOINT，用户需自备 Key 或粘贴文本）'}`);
  console.log('  提示：直接双击 index.html 即可在浏览器使用；也可作为 APK 的 assets/index.html。');
  if (!aiEndpoint) {
    console.log('       想要「用户零配置开箱即用识别」，先部署 server/index.mjs 再这样构建：');
    console.log('       BC_AI_ENDPOINT=https://your-worker.workers.dev node build.mjs');
    console.log('       详见 docs/AI通道部署.md');
  }
}

main();
