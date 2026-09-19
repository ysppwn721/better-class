/* ============================================================================
 * parser.js — 纯文本 / HTML 表格 → 课表数据
 *
 * 目标：让「教务系统里复制一段文本」这条零成本路径 100% 准确，
 *       同时作为截图识别的兜底（识别失败时用户可以直接粘贴文本）。
 *
 * 覆盖的中北大学教务系统格式（也是国内多数教务系统的通用格式）：
 *   概率论与数理统计B
 *   周数：1-12周 校区:本部 上课
 *   地点：15106H 教师：李毅红 教学
 *   班：概率论与数理统计B-0021 教学班组
 *   成：25070141;25070142;25070143 考核
 *   方式：校级考试 选课备注： 课程
 *   学时组成：理论学时:48 周学时：4
 *   总学时：48 学分：3
 * ==========================================================================*/

/* ---------------------------- 星期 ---------------------------- */
const DOW_MAP = [
  [/(?:星期|周|礼拜)\s*[一1]/, 1],
  [/(?:星期|周|礼拜)\s*[二2]/, 2],
  [/(?:星期|周|礼拜)\s*[三3]/, 3],
  [/(?:星期|周|礼拜)\s*[四4]/, 4],
  [/(?:星期|周|礼拜)\s*[五5]/, 5],
  [/(?:星期|周|礼拜)\s*[六6]/, 6],
  [/(?:星期|周|礼拜)\s*(?:日|天|七|7)/, 7],
];

export function parseDay(text) {
  if (!text) return null;
  for (const [re, n] of DOW_MAP) if (re.test(text)) return n;
  return null;
}

/* --------------------------- 节次 → 大节 ---------------------------
 * 大节定义：1=第1-2节, 2=第3-4节, 3=第5-6节, 4=第7-8节, 5=第9-10节
 * 「1-2」/「1、2」→ 大节1 ；「3-4」→ 大节2 ；「7-8」→ 大节4
 * ----------------------------------------------------------------- */
export function periodsToUnits(spec) {
  if (spec == null) return null;
  let s = String(spec).trim();
  if (!s) return null;

  // 中文数字 → 阿拉伯数字
  s = s.replace(/[一二三四五六七八九十]/g, (m) => ({ 一: 1, 二: 2, 三: 3, 四: 4, 五: 5, 六: 6, 七: 7, 八: 8, 九: 9, 十: 10 }[m]));

  // 「第1大节」「大节2」
  const big = s.match(/(?:第)?\s*(\d+)\s*(?:大节|单元|时段)/);
  if (big) {
    const u = Number(big[1]);
    return u >= 1 && u <= 6 ? { startUnit: u, endUnit: u } : null;
  }

  // 抽取所有数字
  const nums = (s.match(/\d+/g) || []).map(Number).filter((n) => n >= 1 && n <= 12);
  if (!nums.length) return null;
  const lo = Math.min(...nums);
  const hi = Math.max(...nums);
  const toUnit = (p) => Math.ceil(p / 2);
  return { startUnit: toUnit(lo), endUnit: toUnit(hi) };
}

/* ----------------------------- 周数 ----------------------------- */
export function parseWeeks(raw) {
  if (!raw) return { kind: 'all', text: '' };
  const s = String(raw).replace(/\s+/g, '');
  if (/单周|单数周/.test(s)) return { kind: 'odd', text: s };
  if (/双周|双数周/.test(s)) return { kind: 'even', text: s };
  if (/全周|每周|1-\d+周?$/.test(s) && /^1-?2[0-9]$/.test(s)) return { kind: 'all', text: s };
  const ranges = [];
  const re = /(\d+)\s*(?:[-~—至到]\s*(\d+))?\s*周?/g;
  let m;
  while ((m = re.exec(s))) {
    const a = Number(m[1]);
    const b = m[2] ? Number(m[2]) : a;
    if (a >= 1 && a <= 30 && b >= a && b <= 30) ranges.push([a, b]);
  }
  if (!ranges.length) return { kind: 'all', text: s };
  if (ranges.length === 1 && ranges[0][0] === 1 && ranges[0][1] >= 18) return { kind: 'all', text: s };
  return { kind: 'ranges', ranges, text: s };
}

export function weeksFromCourse(course) {
  const w = course?.weeks;
  if (w && typeof w === 'object' && w.kind) return w;
  return parseWeeks(typeof w === 'string' ? w : '');
}

export function weeksToText(w) {
  if (!w) return '';
  if (w.kind === 'odd') return '单周';
  if (w.kind === 'even') return '双周';
  if (w.kind === 'all') return '每周';
  if (w.kind === 'ranges') return w.ranges.map(([a, b]) => (a === b ? `${a}` : `${a}-${b}`)).join(',') + '周';
  return '';
}

export function courseHitsWeek(course, week) {
  const w = weeksFromCourse(course);
  if (w.kind === 'all') return true;
  if (w.kind === 'odd') return week % 2 === 1;
  if (w.kind === 'even') return week % 2 === 0;
  if (w.kind === 'ranges') return w.ranges.some(([a, b]) => week >= a && week <= b);
  return true;
}

/* --------------------------- 字段抽取 --------------------------- */
const FIELD_RES = {
  location: /(?:上课地点|地点|教室)\s*[:：]\s*([^:：\n]+?)(?=\s*(?:教师|教学班|周数|校区|考核|选课备注|课程学时|学分|$))/,
  teacher: /教师\s*[:：]?\s*([^:：\n]*?)(?=\s*(?:教学班|上课地点|地点|周数|校区|考核|选课备注|课程学时|学分|$))/,
  weeks: /周数\s*[:：]\s*([^:：\n]*?)(?=\s*(?:校区|上课地点|地点|教师|教学班|考核|选课备注|课程学时|学分|$))/,
  campus: /校区\s*[:：]\s*([^:：\n]*?)(?=\s*(?:上课地点|地点|教师|教学班|周数|考核|选课备注|课程学时|学分|$))/,
  klass: /教学班\s*[:：]\s*([^:：\n]*?)(?=\s*(?:教学班组|考核|选课备注|课程学时|学分|教师|$))/,
  credit: /学分\s*[:：]\s*([\d.]+)/,
  hours: /(?:课程学时组成|学时组成)\s*[:：]\s*([^:：\n]*?)(?=\s*(?:周学时|总学时|学分|$))/,
};

export function extractFields(block) {
  const out = {};
  for (const [k, re] of Object.entries(FIELD_RES)) {
    const m = block.match(re);
    out[k] = m ? m[1].trim().replace(/[\s　]+/g, ' ') : '';
  }
  return out;
}

/* --------------------------- 主解析器 --------------------------- */
const HEADER_NOISE = [
  /^课表信息$/, /^星期$/, /^节次$/, /^课\s*表$/, /^备注/, /^注[:：]/,
  /^输出PDF/, /^版权所有/, /^实践课程[:：]/, /^其它课程[:：]/, /^其他课程[:：]/,
  /^带\*标记/, /^学号[:：]/, /^\d{4}-\d{4}学年/, /个人课表查询/, /^查询$/,
  // 页脚/表尾的碎词，绝不该被当成课程名
  /^其它$/, /^其他$/, /^实践$/, /^课程$/, /^学分$/, /^总计$/, /^合计$/, /^备注$/, /^说明$/,
  /^教务处$/, /^版本V?[-.\d]*$/i,
];

/** 教务系统把字段名拆成独立行时的碎片标签（"班："、"成："、"方式："…） */
const LABEL_RE = /^(课表信息|课程信息|上课地点|地点|教室|教师|周数|校区|教学班组|教学班|考核方式|考核|方式|选课备注|课程学时组成|学时组成|周学时|总学时|学分|班|成|学时|备注|人数|容量|类型|性质)\s*[:：]\s*/;
/** 值尾部常见的中文标签残留 */
const VALUE_TAIL_RE = /(教学班组成|教学班组|教学班|课程学时组成|学时组成|周学时|总学时|考核方式|选课备注|学分|教师|周数|校区|上课地点|地点|教室)\s*[:：]?\s*$/;
/** 值里混进别的字段标签时，从这里截断 */
const LABEL_CUT_RE = /(选课备注|课程学时组成|学时组成|周学时|总学时|教学班组成|教学班组|教学班|考核方式|考核|学分|教师|周数|校区|地点|教室|课程)\s*[:：]/;
/** 「星期三」这种整行就是星期标签的，不能当课程名 */
const DAY_ONLY_RE = /^(星期|周|礼拜)\s*[一二三四五六日天1-7]$/;
/** 「1-2」「第3节」这种整行是节次的，不能当课程名 */
const PERIOD_ONLY_RE = /^第?\s*\d{1,2}\s*(?:[-—~、,]\s*\d{1,2})?\s*(?:节|大节|课时)?$/;

/**
 * 取一行里的候选文字。
 * wanted=clean 时只认「没有字段名碎片」的行 —— 这种行才是课程名。
 * 教务系统的块里，课程名所在行不含冒号；"班：xxx-0021 教学班组" 这种是字段碎片。
 */
function lineCandidates(line, wanted = 'any') {
  const out = [];
  const segs = String(line || '').split(/[\t|　]|\s{2,}/);
  for (const raw of segs) {
    const original = raw.trim();
    if (!original) continue;
    const hadLabel = LABEL_RE.test(original);
    let s = original.replace(LABEL_RE, '').trim();
    // 值里混进了别的字段标签（"…教学 试 选课备注： 课程学时组成：理"）→ 从第一个标签处截断
    const cut = s.search(LABEL_CUT_RE);
    if (cut > 0) s = s.slice(0, cut);
    // 值本身就是「被劈开的字段名残片」（"时组成：理论学时:8"）→ 不是课程名
    const isFieldFragment =
      /学习|学时组成|课?学时|理论学时|实验学时|周学时|总学时|学分|考核方式|选课备注|教学班组成|教学班组/.test(s) ||
      /^[^:：]{0,6}[:：]/.test(s);
    s = s.replace(VALUE_TAIL_RE, '').trim();
    s = s.replace(/^[\s\d\-—~、,，;；:：]+/, '').replace(/[\s\-—~、,，;；:：]+$/, '').trim();
    if (!s) continue;
    if (isFieldFragment) continue;
    if (wanted === 'clean' && hadLabel) continue;
    if (wanted === 'rough' && !hadLabel) continue;
    out.push(s);
  }
  return out;
}

function looksLikeNoise(line) {
  if (!line) return true;
  const s = line.trim();
  if (s.length < 2) return true;
  if (HEADER_NOISE.some((re) => re.test(s))) return true;
  if (LABEL_RE.test(s)) return true;
  if (/^[\s\d\-—~、,，;；:：]*$/.test(s)) return true;      // 纯数字/分隔符（节次残片）
  if (/^(周数|校区|上课|地点|教师|教学班|教学班组|成|考核|方式|课程|学时组成|总学时|学分|选课备注)/.test(s)) return true;
  return false;
}

/**
 * 课程名：教务系统里课程名一行紧挨在「周数：」那一行的正上方，
 * 所以从 before 的末尾往前扫，遇到「周数：」行就停 —— 再往前就是上一个格子的内容了。
 * （实测：继续往前扫会把上一门课的名字当成本课程的，这是最容易出错的地方。）
 */
/** 课程名前的「第9周」残片会被切分逻辑带进来，这里用 isNameLine 统一挡掉 */
function pickCourseNameFromBefore(before) {
  const lines = String(before || '').split(/\r?\n/).map((s) => s.trim()).filter(Boolean);
  for (let i = lines.length - 1; i >= 0; i--) {
    const line = lines[i];
    if (/^周数\s*[:：]/.test(line)) return '';        // 到边界了：本格没有课程名行
    for (const cand of lineCandidates(line, 'clean').reverse()) {
      if (isNameLine(cand)) return cand.replace(/[。，,；;]$/, '');
    }
    for (const cand of lineCandidates(line, 'rough').reverse()) {
      if (isNameLine(cand)) return cand.replace(/-\d+$/, '').replace(/[。，,；;]$/, '');
    }
  }
  return '';
}

/** 候选是否像课程名：排除星期标签、节次编号、"第9周"这类周数残片 */
function isNameLine(s) {
  if (!s) return false;
  // "第9周" / "9周" 这种是周数行被换行劈出来的残片，不是课名
  const stripped = s.replace(/^第?\s*\d{1,2}\s*周(?:[一二三四五六日天])?$/, '').trim();
  if (!stripped) return false;
  return !looksLikeNoise(stripped) &&
    !DAY_ONLY_RE.test(stripped) &&
    !PERIOD_ONLY_RE.test(stripped) &&
    !/^(星期|周|礼拜)/.test(stripped) &&
    /[\u4e00-\u9fa5A-Za-z]/.test(stripped) &&
    stripped.length <= 40;
}

function pickCourseName(lines) {
  const clean = [], rough = [];
  for (let i = Math.max(0, lines.length - 12); i < lines.length; i++) {
    for (const cand of lineCandidates(lines[i], 'clean')) clean.push(cand);
    for (const cand of lineCandidates(lines[i], 'rough')) rough.push(cand);
  }
  for (let i = clean.length - 1; i >= 0; i--) if (isNameLine(clean[i])) return clean[i].replace(/[。，,；;]$/, '');
  for (let i = rough.length - 1; i >= 0; i--) if (isNameLine(rough[i])) return rough[i].replace(/-\d+$/, '').replace(/[。，,；;]$/, '');
  return '';
}

/** 节次：兼容「1-2」「1-4」以及被换行拆成「1-」+「2」的碎片 */
function pickPeriodsFromContext(before) {
  const lines = String(before).split(/\r?\n/).map((s) => s.trim()).filter(Boolean).slice(-10);
  for (let i = lines.length - 1; i >= 0; i--) {
    const s = lines[i];
    const m = s.match(/^(?:第)?\s*(\d{1,2})\s*[-—~、,，]\s*(\d{1,2})\s*(?:节)?$/);
    if (m) return unitsFromPeriods(Number(m[1]), Number(m[2]));
    const single = s.match(/^(?:第)?\s*(\d{1,2})\s*(?:节|大节)$/);
    if (single) {
      const p = Number(single[1]);
      return { startUnit: p <= 5 ? p : Math.ceil(p / 2), endUnit: p <= 5 ? p : Math.ceil(p / 2) };
    }
    // 「1-」换行后接「2」
    const half = s.match(/^(\d{1,2})\s*[-—~]$/);
    if (half) {
      for (let j = i + 1; j < lines.length; j++) {
        const nxt = lines[j].match(/^(\d{1,2})$/);
        if (nxt) return unitsFromPeriods(Number(half[1]), Number(nxt[1]));
        if (!/^[\s\d]*$/.test(lines[j])) break;
      }
    }
  }
  return null;
}

function unitsFromPeriods(a, b) {
  const lo = Math.min(a, b), hi = Math.max(a, b);
  const toUnit = (p) => Math.ceil(p / 2);
  return { startUnit: toUnit(lo), endUnit: toUnit(hi) };
}

/**
 * @param {string} raw 教务系统复制出来的文本（或 HTML 片段）
 * @returns {{courses:Array, stats:object}}
 */
export function parseScheduleText(raw) {
  if (!raw || !String(raw).trim()) return { courses: [], stats: { blocks: 0, skipped: 0 } };

  let text = String(raw);
  // HTML → 文本：单元格之间用制表符，行之间换行，保留列结构
  if (/<tr[\s>]|<td[\s>]|<table[\s>]/i.test(text)) {
    text = text
      .replace(/<\/(td|th)>\s*/gi, '\t')
      .replace(/<\/(tr|p|div|li)>\s*/gi, '\n')
      .replace(/<br\s*\/?>/gi, '\n')
      .replace(/<[^>]+>/g, '')
      .replace(/&nbsp;/gi, ' ')
      .replace(/&amp;/gi, '&')
      .replace(/&lt;/gi, '<')
      .replace(/&gt;/gi, '>');
  }

  const lines = text.split(/\r?\n/).map((l) => l.replace(/\u00a0/g, ' ').trim());

  /* --- 第 0 步：优先按「行式表格」解析（每行自带星期/节次） --- */
  const normalized = reflowWrappedLines(lines);
  const rowCourses = parseRowStyle(normalized);
  if (rowCourses.length) return { courses: rowCourses, stats: { blocks: rowCourses.length, mode: 'rows' } };

  /* --- 第 1 步：按「周数：」切块，还原一格一块的课程 --- */
  const joined = normalized.join('\n');
  const parts = joined.split(/(?=周数\s*[:：])/);
  const courses = [];
  let skipped = 0;

  for (let i = 1; i < parts.length; i++) {
    const block = parts[i];
    const before = parts[i - 1];      // 上一块的尾部 = 本块前面几行（课程名 / 星期 / 节次）
    const course = blockToCourse(block, before);
    if (course) courses.push(course);
    else skipped++;
  }

  return { courses: mergeDuplicateCourses(courses), stats: { blocks: parts.length - 1, skipped, mode: 'blocks' } };
}

/** 教务系统按列宽硬换行，会把「教学班」「上课地点」等词劈成两半。
 *  这里把被劈开的两行接回去，避免字段抽取时断在关键词中间。 */
const CONTINUE_RE = /(教学|上课|地点|教室|教师|周数|校区|考核|方式|选课|备注|学时|学分|总学|课程|课程学|班组成|教学班|理论|实验)$/;
function reflowWrappedLines(lines) {
  const out = [];
  for (const raw of lines) {
    const line = (raw || '').trim();
    if (!line) continue;
    const prev = out[out.length - 1];
    if (prev && CONTINUE_RE.test(prev)) {
      out[out.length - 1] = prev + line;
    } else {
      out.push(line);
    }
  }
  return out;
}

/** 从「上一块的文本」里回溯最近的一个星期标签，遇到上一块的周数行就停 */
function dayFromBefore(before) {
  const lines = String(before || '').split(/\r?\n/);
  for (let i = lines.length - 1; i >= 0; i--) {
    const s = lines[i].trim();
    if (!s) continue;
    if (/^周数\s*[:：]/.test(s)) break;      // 越界：这是上一块的开头
    const d = parseDay(s);
    if (d) return d;
  }
  return null;
}

/** 每个块拼成一条课程 */
function blockToCourse(block, before) {
  const fields = extractFields(block);
  if (!fields.weeks && !fields.location) return null;

  // 课程名：块内若没有（正常情况，课名在「周数」上方），就沿上文往前扫到边界
  const blockLines = String(block).split(/\r?\n/).slice(0, 4);
  const name = pickCourseName(blockLines) || pickCourseNameFromBefore(before);
  // 星期：只在本行的范围内找（本行 = 本块开头到「下一行的节次/星期」之前），
  // 找不到才回溯上一块的尾部，且遇到上一块的「周数」行就停 —— 避免串行。
  const ownLines = [];
  for (const raw of String(block).split(/\r?\n/).slice(1)) {
    const s = raw.trim();
    if (!s) continue;
    const isRowStart = PERIOD_ONLY_RE.test(s) || /^(星期|周|礼拜)\s*[一二三四五六日天1-7]$/.test(s);
    if (isRowStart) break;
    ownLines.push(s);
    if (ownLines.length > 12) break;
  }
  const dayFromCtx = parseDay(ownLines.join('\n')) ?? dayFromBefore(before);

  const course = {
    name: name || '未命名课程',
    teacher: fields.teacher || '',
    location: fields.location || '',
    campus: fields.campus || '',
    day: dayFromCtx || null,
    ...(pickPeriodsFromContext(before) || { startUnit: null, endUnit: null }),
    weeks: parseWeeks(fields.weeks),
    credit: fields.credit || '',
    hours: fields.hours || '',
    klass: fields.klass || '',
  };
  return course;
}

/** 行式：每行都带星期与节次（用户手抄、其他学校系统常见） */
function parseRowStyle(lines) {
  const out = [];
  for (const line of lines) {
    if (!line) continue;
    const day = parseDay(line);
    if (!day) continue;
    const per = line.match(/(\d{1,2})\s*[-—~、,，]\s*(\d{1,2})\s*节?/);
    const fields = extractFields(line);
    // 课程名：去掉星期/节次/字段后的残余
    let rest = line
      .replace(/(?:星期|周|礼拜)\s*[一二三四五六日天1-7]/g, ' ')
      .replace(/(?:第)?\s*\d{1,2}\s*[-—~、,，]\s*\d{1,2}\s*节?/g, ' ')
      .replace(/(?:上课地点|地点|教室|教师|周数|校区|学分|教学班)\s*[:：]\s*[^:：\s]*(?:[;；,，]\s*[^:：\s]*)*/g, ' ')
      .replace(/[\t|,，;；]+/g, ' ')
      .replace(/\s+/g, ' ')
      .trim();
    const name = rest.split(' ').filter((x) => x && !looksLikeNoise(x))[0];
    if (!name || name.length < 2) continue;
    const p = per ? periodsToUnits(`${per[1]}-${per[2]}`) : null;
    out.push({
      name,
      teacher: fields.teacher || '',
      location: fields.location || '',
      campus: fields.campus || '',
      day,
      ...(p || { startUnit: null, endUnit: null }),
      weeks: parseWeeks(fields.weeks),
      credit: fields.credit || '',
    });
  }
  return out;
}

/** 同一门课在相邻大节重复出现（教务系统按大节分行）→ 合并成一条 */
export function mergeDuplicateCourses(courses) {
  const map = new Map();
  const keyOf = (c) => [c.name, c.teacher, c.location, c.day, weeksToText(weeksFromCourse(c))].join('|');
  for (const c of courses) {
    const k = keyOf(c);
    if (map.has(k)) {
      const prev = map.get(k);
      if (Number.isFinite(c.startUnit) && Number.isFinite(c.endUnit)) {
        prev.startUnit = Math.min(prev.startUnit ?? c.startUnit, c.startUnit);
        prev.endUnit = Math.max(prev.endUnit ?? c.endUnit, c.endUnit);
      }
      if (c.credit && !prev.credit) prev.credit = c.credit;
      if (c.hours && !prev.hours) prev.hours = c.hours;
    } else {
      map.set(k, { ...c });
    }
  }
  return [...map.values()];
}

/* --------------------------- 补齐缺失信息 ---------------------------
 * 识别/解析出来的课程可能缺 day 或 startUnit；这里用「有没有课上」的
 * 排布信息做一次温和补齐，并标记 needsReview 让用户在界面上确认。
 * ----------------------------------------------------------------- */
export function auditCourses(courses) {
  return courses.map((c) => {
    const issues = [];
    if (!c.day) issues.push('缺星期');
    if (!Number.isFinite(c.startUnit)) issues.push('缺节次');
    if (!c.weeks || (!c.weeks.text && c.weeks.kind !== 'all')) issues.push('缺周数');
    return { ...c, needsReview: issues.length > 0, issues };
  });
}
