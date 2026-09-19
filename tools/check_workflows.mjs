/* 校验工作流 YAML 的基本合法性（不引第三方库）
 * 用法：node tools/check_workflows.mjs
 *
 * 为什么需要它：工作流写错时 GitHub 常常是**静默失败**（运行记录里一个作业都没有，
 * 日志也拉不到），排查非常费时间。这个脚本把几个"致命但隐性"的错误挡在推送前。
 *
 * 检查项：
 *   1) 出现 C 风格块注释起始符（YAML 不支持 —— 曾经因此 0 作业）
 *   2) Tab 缩进（YAML 禁用）
 *   3) 顶层必需字段 name / on / jobs
 *   4) jobs.* 下必须有 runs-on
 *   5) 每个 step 必须是 - 开头的映射（极简结构检查，容忍块标量）
 *   6) 业务规则：workflow 里引用 secrets 时要如实标注
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const dir = path.join(root, '.github', 'workflows');

let files = [];
try { files = fs.readdirSync(dir).filter((f) => /\.ya?ml$/.test(f)); } catch { /* ignore */ }
if (!files.length) { console.error('✗ .github/workflows 下没有工作流文件'); process.exit(1); }

let bad = 0;
for (const f of files) {
  const raw = fs.readFileSync(path.join(dir, f), 'utf8');
  const lines = raw.split('\n');
  const problems = [];

  // 1) 块注释：只看行首（避免把 glob、字符串里的 /* 误判）
  lines.forEach((line, i) => {
    if (/^\s*\/\*/.test(line)) problems.push(`第 ${i + 1} 行以 /* 开头 —— YAML 不支持块注释，请用 #`);
  });
  // 2) Tab
  if (/^\s*\t/m.test(raw)) problems.push('使用了 Tab 缩进 —— YAML 禁用');
  // 3) 顶层字段
  for (const key of ['name:', 'on:', 'jobs:']) {
    if (!new RegExp(`^${key}`, 'm').test(raw)) problems.push(`缺少顶层字段 ${key}`);
  }
  // 4) runs-on
  if (!/^\s+runs-on:/m.test(raw)) problems.push('jobs 下缺少 runs-on');

  // 5) 结构检查：跟踪块标量（| 或 >），块内的行不做结构校验
  let inBlock = false, blockIndent = -1;
  lines.forEach((line, i) => {
    if (!line.trim() || /^\s*#/.test(line)) return;
    const indent = line.match(/^\s*/)[0].length;
    if (inBlock) {
      if (indent > blockIndent) return;      // 还在块标量里
      inBlock = false;
    }
    if (/:\s*[|>][-+]?\s*$/.test(line)) { inBlock = true; blockIndent = indent; return; }
    // step 必须在 steps: 之后，且以 "- " 开头
    if (/^\s+steps:\s*$/.test(line)) return;
    if (indent > 0 && /^[a-zA-Z_][\w.-]*:/.test(line.trim())) return;   // 普通键值行
    if (/^\s*-\s/.test(line)) return;                                    // 列表项
    if (/^\s*[a-zA-Z_][\w.-]*:\s*\S/.test(line)) return;                 // 缩进的 key: value
    problems.push(`第 ${i + 1} 行结构可疑：${line.trim().slice(0, 70)}`);
  });

  // 6) secrets 使用提示
  const secretRefs = [...raw.matchAll(/secrets\.([A-Z0-9_]+)/g)].map((m) => m[1]);
  if (secretRefs.length) {
    // 只做提示，不算错误
  }

  if (problems.length) {
    bad++;
    console.log(`✗ ${f}`);
    for (const p of problems) console.log(`    · ${p}`);
  } else {
    const steps = (raw.match(/^\s+- (name|uses):/gm) || []).length;
    console.log(`✓ ${f}   (${lines.length} 行, ${steps} 个步骤)`);
    if (secretRefs.length) console.log(`    引用 Secret：${[...new Set(secretRefs)].join(', ')}（需在仓库 Settings 里配置，未配置时为空值）`);
  }
}

console.log(bad ? `\n${bad} 个工作流有问题` : '\n所有工作流通过基本校验');
process.exit(bad ? 1 : 0);
