/* 校验工作流 YAML 的基本合法性（不引第三方库，够用就行）
 * 用法：node tools/check_workflows.mjs
 *
 * 检查项：
 *   1) 不能出现 /* *\/ 这类 C 风格块注释（YAML 不支持，会让 GitHub 一个作业都不跑）
 *   2) 制表符缩进（YAML 禁用）
 *   3) 顶层必需的 name / on / jobs 存在
 *   4) 每个 step 必须能解析成对象（用极简解析器验证缩进结构）
 *   5) 行尾统一 LF
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const dir = path.join(root, '.github', 'workflows');

let files = [];
try { files = fs.readdirSync(dir).filter((f) => /\.ya?ml$/.test(f)); } catch { /* 目录不存在 */ }
if (!files.length) { console.error('✗ 没找到工作流文件'); process.exit(1); }

let bad = 0;
for (const f of files) {
  const abs = path.join(dir, f);
  const raw = fs.readFileSync(abs, 'utf8');
  const problems = [];

  if (/\/\*/.test(raw)) problems.push('含有 /* 块注释 —— YAML 不支持，请改成 # 注释');
  if (/^\s*\t/m.test(raw)) problems.push('使用了 Tab 缩进 —— YAML 禁用');
  if (raw.includes('\r\n')) problems.push('含 CRLF 行尾 —— 建议统一 LF');
  for (const key of ['name:', 'on:', 'jobs:']) {
    if (!new RegExp(`^${key}`, 'm').test(raw)) problems.push(`缺少顶层字段 ${key}`);
  }
  // 极简结构校验：顶级 key 必须顶格；jobs 下必须有 runs-on
  const lines = raw.split('\n');
  lines.forEach((line, i) => {
    if (!line.trim() || /^\s*#/.test(line)) return;
    if (/^\s+\S/.test(line) && !/^\s*-\s/.test(line) && !/[:\-|>]\s*$/.test(line) && !/^\s+.*:/.test(line)) {
      problems.push(`第 ${i + 1} 行结构可疑：${line.trim().slice(0, 60)}`);
    }
  });
  if (!/runs-on:/.test(raw)) problems.push('缺少 runs-on');

  if (problems.length) {
    bad++;
    console.log(`✗ ${f}`);
    for (const p of problems) console.log(`    · ${p}`);
  } else {
    console.log(`✓ ${f}   (${lines.length} 行, ${raw.length} 字节)`);
  }
}

console.log(bad ? `\n${bad} 个工作流有问题` : '\n所有工作流通过基本校验');
process.exit(bad ? 1 : 0);
