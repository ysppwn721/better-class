/* ============================================================================
 * app.js — 课表应用主逻辑
 *   数据模型 → 渲染（WakeUp 风格网格）→ 导入 / 导出 / 多学期 / 周次过滤
 * ==========================================================================*/
import { parseScheduleText, auditCourses, weeksFromCourse, weeksToText, courseHitsWeek, parseWeeks } from './parser.js';

/* ============================ 作息时间预设 ============================
 * 中北大学（NUC）冬令作息：国庆后 ~ 次年五一前
 *   第一大节 08:00-09:40  第二大节 10:10-11:50
 *   第三大节 14:00-15:40  第四大节 16:10-17:50  第五大节 19:00-20:40
 * 夏令作息：五一后 ~ 国庆前
 *   第三、四大节整体后移 30 分钟，第五大节后移 30 分钟
 * 每个「大节」含 2 小节，各 50 分钟，课间休息 10 分钟。
 * ---------------------------------------------------------------*/
export const PRESET_SCHEDULES = {
  nuc: {
    key: 'nuc',
    name: '中北大学',
    winter: {
      label: '冬季作息',
      hint: '国庆后 ~ 次年五一前',
      units: [
        { periods: '第1-2节', start: '08:00', end: '09:40' },
        { periods: '第3-4节', start: '10:10', end: '11:50' },
        { periods: '第5-6节', start: '14:00', end: '15:40' },
        { periods: '第7-8节', start: '16:10', end: '17:50' },
        { periods: '第9-10节', start: '19:00', end: '20:40' },
      ],
    },
    summer: {
      label: '夏季作息',
      hint: '五一后 ~ 国庆前',
      units: [
        { periods: '第1-2节', start: '08:00', end: '09:40' },
        { periods: '第3-4节', start: '10:10', end: '11:50' },
        { periods: '第5-6节', start: '14:30', end: '16:10' },
        { periods: '第7-8节', start: '16:40', end: '18:20' },
        { periods: '第9-10节', start: '19:30', end: '21:10' },
      ],
    },
  },
  generic: {
    key: 'generic',
    name: '通用（45分钟/节）',
    winter: {
      label: '冬季作息',
      hint: '',
      units: [
        { periods: '第1-2节', start: '08:00', end: '09:30' },
        { periods: '第3-4节', start: '10:00', end: '11:30' },
        { periods: '第5-6节', start: '14:00', end: '15:30' },
        { periods: '第7-8节', start: '16:00', end: '17:30' },
        { periods: '第9-10节', start: '19:00', end: '20:30' },
      ],
    },
    summer: {
      label: '夏季作息',
      hint: '',
      units: [
        { periods: '第1-2节', start: '08:00', end: '09:30' },
        { periods: '第3-4节', start: '10:00', end: '11:30' },
        { periods: '第5-6节', start: '14:30', end: '16:00' },
        { periods: '第7-8节', start: '16:30', end: '18:00' },
        { periods: '第9-10节', start: '19:30', end: '21:00' },
      ],
    },
  },
};

const DOW_NAMES = ['一', '二', '三', '四', '五', '六', '日'];

/* ============================ 状态 ============================ */
const STORAGE_KEY = 'better-class.state.v1';

function defaultState() {
  return {
    version: 1,
    settings: {
      title: '我的课表',
      subtitle: '',
      preset: 'nuc',
      semesterStart: nextMondayISO(),   // 第 1 周周一
      totalWeeks: 20,
      vacationRanges: [],               // 假期周（显示为「假」）
      theme: 'system',
    },
    schedule: structuredClone(PRESET_SCHEDULES.nuc),
    courses: [],
    meta: { importedAt: '', source: '', via: '' },
  };
}

function nextMondayISO() {
  const d = new Date();
  const dow = d.getDay() === 0 ? 7 : d.getDay();
  d.setDate(d.getDate() - (dow - 1));
  return isoOf(d);
}
function isoOf(d) {
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

let state = load();
let ui = {
  week: 1,
  season: 'winter',      // winter | summer
  autoSeason: true,      // 依据当前日期自动选作息
  onboardDismissed: false,
};

function load() {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return defaultState();
    const parsed = JSON.parse(raw);
    return normalizeState(parsed);
  } catch (e) {
    console.warn('状态读取失败，使用默认值', e);
    return defaultState();
  }
}
function save() {
  try { localStorage.setItem(STORAGE_KEY, JSON.stringify(state)); }
  catch (e) { toast('保存失败：' + e.message); }
}

/** 外部数据（识别结果 / 导入文件）→ 规范化状态 */
export function normalizeState(input) {
  const base = defaultState();
  const s = { ...base, ...(input || {}) };
  s.settings = { ...base.settings, ...(input?.settings || {}) };
  s.meta = { ...base.meta, ...(input?.meta || {}) };

  // schedule：预设 + 覆盖，保证两季都有 units
  const presetKey = PRESET_SCHEDULES[s.settings.preset] ? s.settings.preset : 'nuc';
  const preset = PRESET_SCHEDULES[presetKey];
  const pick = (season) => {
    const incoming = input?.schedule?.[season];
    const units = Array.isArray(incoming?.units) && incoming.units.length
      ? incoming.units.map(normUnit)
      : structuredClone(preset[season].units);
    return { label: incoming?.label || preset[season].label, hint: incoming?.hint ?? preset[season].hint, units };
  };
  s.schedule = { winter: pick('winter'), summer: pick('summer') };

  s.courses = (Array.isArray(input?.courses) ? input.courses : []).map(normCourse).filter((c) => c.name);
  return s;
}
function normUnit(u) {
  return {
    periods: u?.periods || u?.name || '',
    start: normTime(u?.start || u?.begin),
    end: normTime(u?.end || u?.finish),
  };
}
function normTime(t) {
  if (!t) return '';
  const m = String(t).replace(/[：]/g, ':').match(/(\d{1,2}):?(\d{2})?/);
  if (!m) return String(t);
  return `${String(m[1]).padStart(2, '0')}:${m[2] || '00'}`;
}
function normCourse(c) {
  const day = Number(c?.day) || null;
  let startUnit = Number.isFinite(Number(c?.startUnit)) ? Number(c.startUnit) : null;
  let endUnit = Number.isFinite(Number(c?.endUnit)) ? Number(c.endUnit) : startUnit;
  if (startUnit && endUnit && endUnit < startUnit) [startUnit, endUnit] = [endUnit, startUnit];
  return {
    id: c?.id || uid(),
    name: String(c?.name || '').trim(),
    teacher: String(c?.teacher || '').trim(),
    location: String(c?.location || '').trim(),
    campus: String(c?.campus || '').trim(),
    klass: String(c?.klass || '').trim(),
    credit: String(c?.credit ?? '').trim(),
    day: day >= 1 && day <= 7 ? day : null,
    startUnit,
    endUnit,
    weeks: c?.weeks && typeof c.weeks === 'object' && c.weeks.kind ? c.weeks : parseWeeks(typeof c?.weeks === 'string' ? c.weeks : ''),
    note: String(c?.note || c?.classroomNote || '').trim(),
    color: Number.isInteger(c?.color) ? c.color : null,
    needsReview: !!c?.needsReview,
    confidence: typeof c?.confidence === 'number' ? c.confidence : null,
  };
}
function uid() { return 'c' + Math.random().toString(36).slice(2, 9); }

/* ============================ 课程配色 ============================ */
const PALETTE = [
  { bg: '#e3ecff', ink: '#2b53c7' },
  { bg: '#ffe6e3', ink: '#c0392b' },
  { bg: '#e2f7ea', ink: '#1f8a53' },
  { bg: '#fdf0d5', ink: '#a86a12' },
  { bg: '#efe4ff', ink: '#6a3fc0' },
  { bg: '#ffe4f2', ink: '#b4308a' },
  { bg: '#ddf6f8', ink: '#127c8c' },
  { bg: '#eaeee0', ink: '#5d7130' },
  { bg: '#ffe9d6', ink: '#b8560f' },
  { bg: '#e6e9f5', ink: '#4a5578' },
];
function colorOf(course) {
  if (Number.isInteger(course.color)) return PALETTE[course.color % PALETTE.length];
  const names = [...new Set(state.courses.map((c) => c.name))].sort();
  const idx = names.indexOf(course.name);
  return PALETTE[(idx < 0 ? 0 : idx) % PALETTE.length];
}

/* ============================ 时间与周次 ============================ */
function currentSeason() {
  // 中北大学：五一后 ~ 国庆前 = 夏季作息；其余 = 冬季作息
  const now = new Date();
  const m = now.getMonth() + 1, d = now.getDate();
  const afterMay1 = m > 5 || (m === 5 && d >= 1);
  const beforeOct1 = m < 10;
  return afterMay1 && beforeOct1 ? 'summer' : 'winter';
}
function seasonNow() { return ui.autoSeason ? currentSeason() : ui.season; }
function unitsOf() { return state.schedule[seasonNow()].units; }

function mondayOfWeek(week) {
  const base = new Date(state.settings.semesterStart + 'T00:00:00');
  if (isNaN(base)) return new Date();
  const d = new Date(base);
  d.setDate(d.getDate() + (week - 1) * 7);
  return d;
}
function dayDate(week, dow) {
  const d = mondayOfWeek(week);
  d.setDate(d.getDate() + (dow - 1));
  return d;
}
function currentWeek() {
  const start = new Date(state.settings.semesterStart + 'T00:00:00');
  if (isNaN(start)) return 1;
  const now = new Date();
  const days = Math.floor((startOfDay(now) - startOfDay(start)) / 86400000);
  const w = Math.floor(days / 7) + 1;
  return clamp(w, 1, state.settings.totalWeeks);
}
function startOfDay(d) { const x = new Date(d); x.setHours(0, 0, 0, 0); return x; }
function clamp(v, a, b) { return Math.max(a, Math.min(b, v)); }
function sameDay(a, b) { return startOfDay(a).getTime() === startOfDay(b).getTime(); }
function esc(s) {
  return String(s ?? '').replace(/[&<>"']/g, (m) =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[m]));
}
const appFlags = { booted: false, renderedOnce: false };

function timeToMinutes(t) {
  const m = String(t || '').match(/(\d{1,2}):(\d{2})/);
  return m ? Number(m[1]) * 60 + Number(m[2]) : null;
}

/* ============================ 自适应缩放 ============================
 * 7 天全在屏内 + 课名可读的矛盾：做法是「列固定宽度，整体等比缩放」。
 * 宽屏（平板/桌面）不放大；窄屏按比例缩到适配宽度为止，最多缩到 0.62。
 * ----------------------------------------------------------------*/
const BASE_AXIS_W = 52, BASE_COL_W = 74, MIN_COL_W = 41, MAX_COL_W = 96;
function fitScale() {
  const host = el('boardScroll');
  if (!host) return 1;
  // 先按常规轴宽算；若一屏放不下（小屏/字体放大），再压缩轴宽
  let axisW = BASE_AXIS_W;
  const avail0 = host.clientWidth - axisW - 1;
  if (avail0 / 7 < MIN_COL_W) {
    axisW = 42;                                   // 窄屏收紧时间轴，优先保证 7 天都在屏内
  }
  const avail = host.clientWidth - axisW - 1;
  if (avail <= 0) return 1;
  const colW = Math.max(MIN_COL_W, Math.min(MAX_COL_W, avail / 7));
  const root = document.documentElement.style;
  root.setProperty('--col', colW.toFixed(2) + 'px');
  root.setProperty('--col-w', BASE_COL_W + 'px');
  root.setProperty('--axis-w', axisW + 'px');
  root.setProperty('--fit', (colW / BASE_COL_W).toFixed(4));
  return colW / BASE_COL_W;
}

/* ============================ 渲染 ============================ */
const el = (id) => document.getElementById(id);

function render() {
  fitScale();
  renderHeader();
  renderWeekNav();
  renderDayHead();
  renderGrid();
  requestAnimationFrame(() => renderNowLine());
  if (!appFlags.renderedOnce) { appFlags.renderedOnce = true; }
}

function renderHeader() {
  el('appTitle').textContent = state.settings.title || '我的课表';
  const n = state.courses.length;
  const season = state.schedule[seasonNow()]?.label || '';
  const sub = el('appSub');
  if (n) {
    sub.innerHTML = `${n} 门课 <i class="dot"></i> <span class="hl">${esc(season)}</span> <i class="dot"></i> 共${state.settings.totalWeeks}周`;
  } else {
    sub.textContent = '截图 / 文本 → 可视化课表';
  }

  const seasonNow_ = seasonNow();
  el('chipWinter').classList.toggle('on', seasonNow_ === 'winter');
  el('chipSummer').classList.toggle('on', seasonNow_ === 'summer');
  el('chipWinter').style.opacity = ui.autoSeason ? .78 : 1;
  el('chipSummer').style.opacity = ui.autoSeason ? .78 : 1;
  el('chipWinter').title = ui.autoSeason ? '按日期自动切换（点一下改为手动冬季）' : '';
}

function renderWeekNav() {
  const w = ui.week;
  el('weekLabel').textContent = `第 ${w} 周`;
  const isNow = w === currentWeek();
  el('weekSub').textContent = isNow ? '· 本周' : '';
  const a = dayDate(w, 1), b = dayDate(w, 7);
  el('weekDate').textContent = `${a.getMonth() + 1}/${a.getDate()} - ${b.getMonth() + 1}/${b.getDate()}`;
  el('btnToday').style.visibility = isNow ? 'hidden' : 'visible';
  const prog = el('weekProgress');
  if (prog) prog.style.width = `${Math.round((w / state.settings.totalWeeks) * 100)}%`;
}

function renderDayHead() {
  const grid = el('dayheadGrid');
  const today = new Date();
  grid.innerHTML = '';
  for (let i = 1; i <= 7; i++) {
    const d = dayDate(ui.week, i);
    const isToday = sameDay(d, today);
    const cell = document.createElement('div');
    cell.className = 'dayhead-cell' + (isToday ? ' today' : '') + (i >= 6 ? ' weekend' : '');
    cell.innerHTML = `<span class="dow">${DOW_NAMES[i - 1]}</span><span class="dom">${d.getDate()}</span>`;
    grid.appendChild(cell);
  }
}

function renderGrid() {
  const units = unitsOf();
  const n = Math.max(units.length, 5);
  const board = el('board');
  const axis = el('axis');
  const cols = el('cols');

  board.style.setProperty('--rows', n);
  axis.innerHTML = '';
  cols.querySelectorAll('.course').forEach((x) => x.remove());

  // 左侧时间轴
  for (let u = 1; u <= n; u++) {
    const un = units[u - 1];
    const cell = document.createElement('div');
    cell.className = 'axis-cell';
    cell.style.height = 'var(--unit-h)';
    const no = un ? (un.periods.match(/\d+/g) || [String(u)])[0] : String(u);
    cell.innerHTML = un
      ? `<span class="u">${no}</span><span class="t">${un.start}<br>${un.end}</span>`
      : `<span class="u">·</span>`;
    if (!un) cell.classList.add('rest');
    axis.appendChild(cell);
  }

  // 7 列网格线
  const lines = el('gridlines');
  const today = new Date();
  lines.innerHTML = '';
  for (let i = 1; i <= 7; i++) {
    const d = dayDate(ui.week, i);
    const c = document.createElement('div');
    c.className = 'gridline-col' + (sameDay(d, today) ? ' today' : '');
    lines.appendChild(c);
  }
  cols.querySelectorAll('.hline').forEach((x) => x.remove());
  for (let u = 1; u <= n; u++) {
    const h = document.createElement('div');
    h.className = 'hline';
    h.style.top = `calc(${u} * var(--unit-h))`;
    cols.appendChild(h);
  }

  if (!state.courses.length) { renderEmpty(); return; }
  el('boardScroll').querySelectorAll('.empty-hint,.onboard-tip').forEach((x) => x.remove());
  el('onboardSlot').innerHTML = '';

  // 课程卡片
  const week = ui.week;
  const shown = state.courses.filter((c) => c.day && c.startUnit && courseHitsWeek(c, week));
  const hidden = state.courses.length - shown.length;

  for (const c of shown) {
    const card = document.createElement('button');
    card.className = 'course';
    const span = (c.endUnit || c.startUnit) - c.startUnit + 1;
    const col = colorOf(c);
    card.style.gridColumn = `${c.day}`;
    card.style.gridRow = `${c.startUnit} / span ${span}`;
    card.style.setProperty('--c-bg', col.bg);
    card.style.color = col.ink;
    card.style.setProperty('--c-ink', col.ink);
    card.style.setProperty('--d', `${Math.min(shown.indexOf(c) * 22, 260)}ms`);
    if (span >= 3) card.classList.add('tall');
    if (span === 1) card.classList.add('short');
    const wt = weeksToText(weeksFromCourse(c));
    card.innerHTML = `
      <span class="name">${esc(c.name)}</span>
      ${c.location ? `<span class="where">${esc(shortLoc(c.location))}</span>` : ''}
      ${c.teacher && span >= 2 ? `<span class="teacher">${esc(c.teacher)}</span>` : ''}
      ${c.needsReview ? '<span class="badge">!</span>' : ''}
    `;
    card.title = `${c.name}${wt ? ' · ' + wt : ''}${c.location ? ' · ' + c.location : ''}`;
    card.addEventListener('click', () => openCourseDetail(c));
    cols.appendChild(card);
  }

  renderNowLine(n);
  if (hidden > 0) {
    const tip = document.createElement('div');
    tip.style.cssText = 'padding:14px;text-align:center;font-size:12px;color:var(--text-3)';
    tip.textContent = `本周另有 ${hidden} 门课不上（周次不匹配）`;
    el('boardScroll').appendChild(tip);
  }
}

function shortLoc(loc) {
  // 15106H → 15106H ；本部;15106H → 15106H ；过长则截断
  const cleaned = String(loc).replace(/\s+/g, ' ').trim();
  return cleaned.length > 14 ? cleaned.slice(0, 13) + '…' : cleaned;
}

/** 把 #rrggbb 调亮/调暗（delta 为 -100~100 的百分比） */
function shade(hex, delta) {
  const m = /^#?([\da-f]{2})([\da-f]{2})([\da-f]{2})$/i.exec(String(hex).trim());
  if (!m) return hex;
  const f = (v) => {
    const n = parseInt(v, 16);
    const out = delta >= 0 ? n + (255 - n) * (delta / 100) : n * (1 + delta / 100);
    return Math.max(0, Math.min(255, Math.round(out))).toString(16).padStart(2, '0');
  };
  return `#${f(m[1])}${f(m[2])}${f(m[3])}`;
}

function renderNowLine(units) {
  document.querySelectorAll('.nowline').forEach((x) => x.remove());
  const today = new Date();
  const todayDow = today.getDay() === 0 ? 7 : today.getDay();
  // 只在「当前周 + 今天列」显示时间线
  if (ui.week !== currentWeek()) return;
  const list = unitsOf();
  const cur = today.getHours() * 60 + today.getMinutes();
  let row = null;
  for (let i = 0; i < list.length; i++) {
    const s = timeToMinutes(list[i].start), e = timeToMinutes(list[i].end);
    if (s == null || e == null) continue;
    if (cur >= s && cur <= e) { row = i + 1 + (cur - s) / (e - s); break; }
    if (cur < s) { row = i + 0.0001; break; }
  }
  if (row == null || row <= 0 || row > list.length + 1) return;
  const line = document.createElement('div');
  line.className = 'nowline';
  line.style.top = `calc(${row} * var(--unit-h))`;
  // 只覆盖今天那一列：时间线挂在本列容器内，随缩放一起走
  const cols = el('cols');
  const colW = cols.clientWidth / 7;
  line.style.left = `${(todayDow - 1) * colW}px`;
  line.style.width = `${colW}px`;
  cols.appendChild(line);
}

function renderEmpty() {
  const scroll = el('boardScroll');
  scroll.querySelectorAll('.empty-hint,.onboard-tip').forEach((x) => x.remove());
  el('boardScroll').appendChild(buildEmptyBox());
}

function buildEmptyBox() {
  const box = document.createElement('div');
  box.className = 'empty-hint';
  box.innerHTML = `
    <div class="art">
      <svg viewBox="0 0 24 24"><path d="M4 5.5h16v14H4z"/><path d="M4 10h16M9 5.5v14M4 15h5"/><path d="M13 13.5h4M13 16.5h3"/></svg>
    </div>
    <b>还没有课表</b>
    导入一张课表截图，或粘贴教务系统里的课表文本，<br>立刻生成可视化课表
    <div style="margin-top:20px;display:flex;gap:9px;justify-content:center">
      <button class="btn primary" data-act="import" style="flex:0 0 auto;padding:0 22px">导入课表</button>
      <button class="btn" data-act="demo" style="flex:0 0 auto;padding:0 20px">载入示例</button>
    </div>
    <div class="feats">
      <span>截图识别</span><span>粘贴文本</span><span>夏/冬作息</span><span>按周过滤</span><span>导出图片</span><span>日历提醒</span>
    </div>`;
  box.querySelector('[data-act="import"]').onclick = () => openImport();
  box.querySelector('[data-act="demo"]').onclick = () => loadDemo();
  return box;
}

function renderFooterState() { /* 预留：底部状态提示 */ }

/* ============================ 弹层 ============================ */
let sheetStack = [];
function openSheet(title, renderBody, opts = {}) {
  const mask = el('sheetMask');
  el('sheetTitle').textContent = title;
  const body = el('sheetBody');
  body.innerHTML = '';
  renderBody(body, (t, fn) => openSheet(t, fn, opts));
  mask.classList.add('open');
  body.scrollTop = 0;
}
function closeSheet() {
  el('sheetMask').classList.remove('open');
}
// 说明：这里的监听必须在 DOM 就绪后再挂。
// 单文件版把脚本内联在 </body> 前，但被注入到别处（如数据 URI / 预览器）时
// 脚本可能先于 DOM 执行，直接用 el(...) 会拿到 null 让整个脚本中断。
function bindStaticListeners() {
  const mask = el('sheetMask');
  if (mask) mask.addEventListener('click', (e) => { if (e.target === mask) closeSheet(); });
  const sc = el('sheetClose');
  if (sc) sc.addEventListener('click', closeSheet);
}
if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', bindStaticListeners, { once: true });
} else {
  bindStaticListeners();
}

let toastTimer;
function toast(msg, ms = 2200) {
  const t = el('toast');
  t.textContent = msg;
  t.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => t.classList.remove('show'), ms);
}

/* ============================ 课程详情 ============================ */
function openCourseDetail(c, reopen) {
  openSheet('课程详情', (body) => {
    const col = colorOf(c);
    const wt = weeksToText(weeksFromCourse(c)) || '未指定';
    const units = unitsOf();
    const u = units[c.startUnit - 1];
    const u2 = units[(c.endUnit || c.startUnit) - 1];
    const timeText = u ? `${u.start}-${(u2 || u).end}` : '';
    body.innerHTML = `
      <div class="detail-hero" style="background:${col.bg};color:${col.ink}">
        <h3>${esc(c.name)}</h3>
        <div class="sub">${esc([c.teacher, c.location].filter(Boolean).join(' · ') || '　')}</div>
      </div>
      <div class="detail-list">
        ${row('时间', `星期${DOW_NAMES[(c.day || 1) - 1]} ${units[c.startUnit - 1]?.periods || ''} ${timeText ? '（' + timeText + '）' : ''}`)}
        ${row('周次', wt)}
        ${row('地点', c.location || '—')}
        ${row('教师', c.teacher || '—')}
        ${row('校区', c.campus || '—')}
        ${c.klass ? row('教学班', c.klass) : ''}
        ${c.credit ? row('学分', c.credit) : ''}
        ${c.note ? row('备注', c.note) : ''}
      </div>
      <div class="row2" style="margin-top:16px">
        <button class="btn" id="dEdit">编辑这节课</button>
        <button class="btn" id="dDel" style="color:var(--danger)">删除</button>
      </div>
      <div class="hint" style="margin-top:10px;font-size:11px;color:var(--text-3);line-height:1.7">
        提示：同一门课在不同星期/不同节次是分开的记录，编辑只影响这一条。
      </div>`;
    body.querySelector('#dEdit').onclick = () => openCourseEditor(c, () => { closeSheet(); render(); });
    body.querySelector('#dDel').onclick = () => {
      state.courses = state.courses.filter((x) => x.id !== c.id);
      save(); closeSheet(); render(); toast('已删除');
    };
  });
}
function row(k, v) {
  return `<div class="detail-item"><span class="k">${esc(k)}</span><span class="v">${esc(v)}</span></div>`;
}

/* ============================ 课程编辑 ============================ */
function openCourseEditor(course, onDone) {
  const c = course ? { ...course } : normCourse({ name: '', day: 1, startUnit: 1, endUnit: 2, weeks: '1-16周' });
  openSheet(course ? '编辑课程' : '添加课程', (body) => {
    body.innerHTML = `
      <div class="field"><label>课程名</label><input class="input" id="fName" value="${esc(c.name)}" placeholder="如：数据结构"></div>
      <div class="field"><label>星期</label>
        <select class="select" id="fDay">${DOW_NAMES.map((n, i) => `<option value="${i + 1}" ${c.day === i + 1 ? 'selected' : ''}>星期${n}</option>`).join('')}</select>
      </div>
      <div class="row2">
        <div class="field"><label>起始大节</label>
          <select class="select" id="fStart">${unitOptions(c.startUnit)}</select></div>
        <div class="field"><label>结束大节</label>
          <select class="select" id="fEnd">${unitOptions(c.endUnit || c.startUnit)}</select></div>
      </div>
      <div class="field"><label>周次</label>
        <input class="input" id="fWeeks" value="${esc(weeksToText(weeksFromCourse(c)) === '每周' ? '' : (weeksFromCourse(c).text || ''))}" placeholder="如 1-16周 / 1-8,10-16周 / 单周">
        <div class="hint">留空表示每周都上</div>
      </div>
      <div class="row2">
        <div class="field"><label>地点</label><input class="input" id="fLoc" value="${esc(c.location)}" placeholder="如 15106H"></div>
        <div class="field"><label>教师</label><input class="input" id="fTeacher" value="${esc(c.teacher)}" placeholder="如 李毅红"></div>
      </div>
      <div class="row2">
        <div class="field"><label>校区</label><input class="input" id="fCampus" value="${esc(c.campus)}" placeholder="如 本部"></div>
        <div class="field"><label>学分</label><input class="input" id="fCredit" value="${esc(c.credit)}" placeholder="如 3"></div>
      </div>
      <div class="row2" style="margin-top:6px">
        <button class="btn primary" id="fSave">保存</button>
        <button class="btn" id="fCancel">取消</button>
      </div>
      <div class="hint" style="margin-top:12px;font-size:11px;line-height:1.7">
        当前作息：${esc(state.schedule[seasonNow()].label)}，第 1 大节 = 第1-2节。
        上课时间可在「设置」里改。
      </div>`;
    body.querySelector('#fCancel').onclick = () => (onDone ? onDone() : closeSheet());
    body.querySelector('#fSave').onclick = () => {
      const name = body.querySelector('#fName').value.trim();
      if (!name) { toast('请填写课程名'); return; }
      const day = Number(body.querySelector('#fDay').value);
      let s = Number(body.querySelector('#fStart').value);
      let e = Number(body.querySelector('#fEnd').value);
      if (e < s) [s, e] = [e, s];
      const weeksRaw = body.querySelector('#fWeeks').value.trim();
      const next = normCourse({
        ...c, name, day, startUnit: s, endUnit: e,
        weeks: parseWeeks(weeksRaw),
        location: body.querySelector('#fLoc').value.trim(),
        teacher: body.querySelector('#fTeacher').value.trim(),
        campus: body.querySelector('#fCampus').value.trim(),
        credit: body.querySelector('#fCredit').value.trim(),
        needsReview: false,
      });
      const idx = state.courses.findIndex((x) => x.id === next.id);
      if (idx >= 0) state.courses[idx] = next; else state.courses.push(next);
      save(); render();
      if (onDone) onDone(); else closeSheet();
      toast(idx >= 0 ? '已保存' : '已添加');
    };
  });
}
function unitOptions(sel) {
  let html = '';
  for (let u = 1; u <= 6; u++) {
    const un = unitsOf()[u - 1];
    html += `<option value="${u}" ${sel === u ? 'selected' : ''}>第${u}大节${un ? ' · ' + un.start : ''}</option>`;
  }
  return html;
}

/* ============================ 导入向导 ============================ */
function openImport() {
  let pickedFile = null;
  let previewUrl = null;
  let lastResult = null;

  openSheet('导入课表', (body) => {
    const cfg = getExtractConfig();
    const hasAi = !!(cfg.apiKey || cfg.endpoint || (globalThis.__BC_AI_ENDPOINT || '').trim());
    body.innerHTML = `
      <div class="seg" style="margin-bottom:16px">
        <button class="btn on" id="tabText"><span>📋 粘贴文本</span><small>零成本 · 最准 · 推荐</small></button>
        <button class="btn" id="tabImg"><span>📷 截图识别</span><small>${hasAi ? 'AI 自动读图' : '需先配通道'}</small></button>
      </div>
      <div id="paneText">
        <div class="field">
          <label>把教务系统的课表文本整段粘贴进来</label>
          <textarea class="textarea" id="rawText" placeholder="概率论与数理统计B&#10;周数：1-12周 校区:本部 上课&#10;地点：15106H 教师：李毅红 教学班：…&#10;总学时：48 学分：3"></textarea>
          <div class="hint">
            在教务系统课表页按 Ctrl+A / 全选 → Ctrl+C 复制，粘贴到这里即可。<br>
            也支持：手抄的「周一 1-2 高等数学 15106H」、以及从网页复制的整张表格（带 HTML 也行）。
          </div>
        </div>
        <button class="btn primary" id="btnParse" style="width:100%">解析并生成课表</button>
        <div class="hint" style="margin-top:10px">
          解析是纯规则、完全在本机完成 —— 不联网、不花钱、结果可预期。
        </div>
      </div>
      <div id="paneImg" style="display:none">
        <div class="field">
          <div class="dropzone" id="dz">
            <svg viewBox="0 0 24 24"><path d="M12 16V4M7.5 8.5L12 4l4.5 4.5"/><path d="M4 15v3.5A1.5 1.5 0 0 0 5.5 20h13a1.5 1.5 0 0 0 1.5-1.5V15"/></svg>
            <b>点击选择 / 拖入课表截图</b>
            <span>支持 jpg · png · webp，长截图也可以（自动压缩后识别）</span>
          </div>
          <input type="file" id="file" accept="image/*" hidden>
          <div id="preview"></div>
        </div>
        <div class="status" id="status" style="display:none"></div>
        <button class="btn primary" id="btnRun" style="width:100%;margin-top:12px" disabled>开始识别</button>
        <div class="hint" style="font-size:11px;color:var(--text-3);margin-top:10px;line-height:1.8">
          当前识别通道：<b>${esc(providerSummary(cfg))}</b><br>
          截图识别需要视觉模型支持。想在「设置」里配自己的通道，或改用上面的「粘贴文本」——
          后者不花任何额度，而且更准。
        </div>
      </div>
      <div id="resultBox"></div>`;

    const dz = body.querySelector('#dz');
    const file = body.querySelector('#file');
    const status = body.querySelector('#status');
    const btnRun = body.querySelector('#btnRun');

    const setStatus = (html, cls = '') => {
      status.style.display = html ? 'flex' : 'none';
      status.className = 'status ' + cls;
      status.innerHTML = html;
    };

    dz.onclick = () => file.click();
    dz.ondragover = (e) => { e.preventDefault(); dz.classList.add('over'); };
    dz.ondragleave = () => dz.classList.remove('over');
    dz.ondrop = (e) => {
      e.preventDefault(); dz.classList.remove('over');
      const f = e.dataTransfer.files?.[0];
      if (f) acceptFile(f);
    };
    file.onchange = () => { if (file.files[0]) acceptFile(file.files[0]); };

    async function acceptFile(f) {
      if (!/^image\//.test(f.type)) { setStatus('请选择图片文件（jpg/png/webp）', 'err'); return; }
      pickedFile = f;
      if (previewUrl) URL.revokeObjectURL(previewUrl);
      previewUrl = URL.createObjectURL(f);
      body.querySelector('#preview').innerHTML = `<img class="preview-img" src="${previewUrl}" alt="课表截图预览">`;
      btnRun.disabled = false;
      setStatus(`已选择：${esc(f.name)}（${(f.size / 1024).toFixed(0)} KB）`, 'ok');
    }

    btnRun.onclick = async () => {
      if (!pickedFile) return;
      btnRun.disabled = true;
      btnRun.textContent = '识别中…';
      setStatus('<span class="spinner"></span>准备中…');
      try {
        const { extractFromImage } = await import('./extractor.js');
        const { data, via } = await extractFromImage(pickedFile, {
          ...cfg,
          onProgress: (msg) => setStatus(`<span class="spinner"></span>${esc(msg)}`),
        });
        lastResult = { data, via };
        applyExtracted(data, via);
      } catch (err) {
        setStatus(`<span>识别失败：${esc(String(err.message).split('\n')[0])}</span>`, 'err');
        body.querySelector('#resultBox').innerHTML = `
          <div class="hint" style="font-size:11.5px;line-height:1.9;color:var(--text-3);margin-top:10px">
            失败详情：<br>${esc(String(err.message).replace(/\n/g, '<br>'))}<br><br>
            👉 建议改用「粘贴文本」通道：在教务系统里全选课表文本复制过来，解析 100% 准确且零成本。
          </div>`;
      } finally {
        btnRun.disabled = false;
        btnRun.textContent = '开始识别';
      }
    };

    body.querySelector('#btnParse').onclick = () => {
      const raw = body.querySelector('#rawText').value;
      if (!raw.trim()) { toast('请先粘贴课表文本'); return; }
      const { courses } = parseScheduleText(raw);
      if (!courses.length) {
        body.querySelector('#resultBox').innerHTML = `<div class="status err" style="margin-top:12px">没解析出课程。请确认粘贴的是课表内容（含「周数：」等字段，或「周一 1-2 课程名」这样的行）。</div>`;
        return;
      }
      const data = { courses };
      applyExtracted(data, '文本解析', true);
    };

    // Tab 切换
    const tabs = [['tabImg', 'paneImg'], ['tabText', 'paneText']];
    for (const [t, p] of tabs) {
      body.querySelector('#' + t).onclick = () => {
        tabs.forEach(([tt, pp]) => {
          body.querySelector('#' + tt).classList.toggle('on', tt === t);
          body.querySelector('#' + pp).style.display = pp === p ? '' : 'none';
        });
      };
    }
  });

  /** 识别/解析结果落地：合并进现有课表 + 给出复核入口 */
  function applyExtracted(data, via, silent) {
    const incoming = normalizeState({ ...data, settings: { ...data.settings, preset: data.settings?.preset || state.settings.preset } });
    const before = state.courses.length;

    // 合并策略：同名同星期同一节次 → 覆盖；否则追加
    const keyOf = (c) => [c.name, c.day, c.startUnit].join('|');
    const existing = new Map(state.courses.map((c) => [keyOf(c), c]));
    let added = 0, updated = 0;
    for (const c of incoming.courses) {
      if (!c.day || !c.startUnit) { state.courses.push(c); added++; continue; }
      const hit = existing.get(keyOf(c));
      if (hit) { Object.assign(hit, c, { id: hit.id }); updated++; }
      else { state.courses.push(c); added++; }
    }
    // 作息时间：识别到时间就覆盖（识别不到则保留预设）
    for (const s of ['winter', 'summer']) {
      const inc = data?.schedule?.[s];
      if (inc && Array.isArray(inc.units) && inc.units.length >= 3) {
        const norm = incoming.schedule[s];
        if (norm.units.every((u) => u.start && u.end)) state.schedule[s] = norm;
      }
    }
    if (data?.settings?.title) state.settings.title = data.settings.title;
    if (data?.settings?.semesterStart) state.settings.semesterStart = data.settings.semesterStart;
    if (data?.settings?.totalWeeks) state.settings.totalWeeks = data.settings.totalWeeks;
    state.courses = auditCourses(state.courses);
    state.meta = { importedAt: new Date().toISOString(), source: silent ? 'text' : 'image', via };
    save(); render();

    const needReview = state.courses.filter((c) => c.needsReview);
    const body = el('sheetBody');
    const box = body.querySelector('#resultBox');
    if (box) {
      box.innerHTML = `
        <div class="status ok" style="margin-top:12px">
          ✓ 通过「${esc(via)}」导入：新增 ${added} 条，更新 ${updated} 条，共 ${state.courses.length} 门课
        </div>
        ${needReview.length ? `<div class="status warn" style="margin-top:8px">有 ${needReview.length} 条信息不全（缺星期/节次/周数），已在课表上用 <b>?</b> 标记，请点开确认。</div>` : ''}
        <div class="row2" style="margin-top:12px">
          <button class="btn primary" id="rDone">完成，看课表</button>
          <button class="btn" id="rReview">去复核 (${needReview.length})</button>
        </div>`;
      box.querySelector('#rDone').onclick = () => { closeSheet(); render(); };
      box.querySelector('#rReview').onclick = () => openReviewList();
    } else {
      toast(`导入完成：共 ${state.courses.length} 门课`);
      closeSheet(); render();
    }
  }
  // 供 sheet 复用
  openImport._apply = applyExtracted;
}

/** 复核清单：逐条确认信息不全的课程 */
function openReviewList() {
  const list = state.courses.filter((c) => c.needsReview);
  openSheet(`复核课程（${list.length}）`, (body) => {
    if (!list.length) {
      body.innerHTML = `<div class="status ok">全部课程信息完整，无需复核 🎉</div>`;
      return;
    }
    body.innerHTML = `<div class="hint" style="margin-bottom:12px;font-size:12px">这些课程缺少关键信息，点一条修一条：</div>` +
      list.map((c) => `
        <button class="btn" data-id="${c.id}" style="width:100%;justify-content:space-between;margin-bottom:8px;height:auto;padding:12px 14px">
          <span style="text-align:left">
            <b style="font-size:13.5px">${esc(c.name)}</b>
            <span style="display:block;font-size:11px;color:var(--text-3);margin-top:3px">${esc(c.issues.join(' · '))}</span>
          </span>
          <span style="color:var(--text-3)">›</span>
        </button>`).join('');
    body.querySelectorAll('[data-id]').forEach((b) => {
      b.onclick = () => {
        const c = state.courses.find((x) => x.id === b.dataset.id);
        openCourseEditor(c, () => { openReviewList(); render(); });
      };
    });
  });
}

/* ============================ 设置 ============================ */
function openSettings() {
  openSheet('设置', (body) => {
    const cfg = getExtractConfig();
    body.innerHTML = `
      <div class="field"><label>课表标题</label>
        <input class="input" id="sTitle" value="${esc(state.settings.title)}" placeholder="如：张三的课表"></div>
      <div class="row2">
        <div class="field"><label>第 1 周周一</label><input class="input" type="date" id="sStart" value="${esc(state.settings.semesterStart)}"></div>
        <div class="field"><label>总周数</label><input class="input" type="number" id="sWeeks" min="1" max="30" value="${state.settings.totalWeeks}"></div>
      </div>

      <div class="field"><label>作息自动切换</label>
        <div class="seg">
          <button class="btn ${ui.autoSeason ? 'on' : ''}" id="sAuto1"><span>自动</span><small>五一后~国庆前用夏季</small></button>
          <button class="btn ${!ui.autoSeason ? 'on' : ''}" id="sAuto0"><span>手动</span><small>顶部按钮切换</small></button>
        </div>
      </div>

      <div class="field"><label>作息时间表（点击编辑，夏/冬分别设置）</label>
        <div class="seg" style="margin-bottom:10px">
          <button class="btn ${ui.season === 'winter' ? 'on' : ''}" data-season="winter">冬季作息</button>
          <button class="btn ${ui.season === 'summer' ? 'on' : ''}" data-season="summer">夏季作息</button>
        </div>
        <div id="unitEditor"></div>
        <div class="hint">总课时节数按最长的一季取；夏季/冬季切换只影响时间轴显示与「当前时间线」。</div>
      </div>

      <div class="field"><label>作息预设</label>
        <select class="select" id="sPreset">
          ${Object.values(PRESET_SCHEDULES).map((p) => `<option value="${p.key}" ${state.settings.preset === p.key ? 'selected' : ''}>${esc(p.name)}</option>`).join('')}
        </select>
        <div class="hint">切换预设会覆盖上面的时间表。</div>
      </div>

      <details style="margin-bottom:15px" ${cfg.provider !== 'local' ? 'open' : ''}>
        <summary style="cursor:pointer;font-size:12px;font-weight:700;color:var(--text-2);padding:4px 0">
          截图识别通道设置（可选，默认关闭）
        </summary>
        <div style="padding-top:10px">
          <div class="hint" style="margin:0 0 10px">
            日常建议用「粘贴文本」导入：不花钱、不联网、而且更准。
            只有当你手头<b>只有截图</b>时才需要在这里配识别通道。
          </div>
          <div class="field" style="margin-bottom:12px">
            <select class="select" id="eProvider">
              <option value="local" ${cfg.provider === 'local' ? 'selected' : ''}>本机视觉服务（开发环境用）</option>
              <option value="zhipu" ${cfg.provider === 'zhipu' ? 'selected' : ''}>智谱 GLM-4V-Flash（有免费额度）</option>
              <option value="siliconflow" ${cfg.provider === 'siliconflow' ? 'selected' : ''}>硅基流动 Qwen2.5-VL（有免费额度）</option>
              <option value="openrouter" ${cfg.provider === 'openrouter' ? 'selected' : ''}>OpenRouter（自备 Key）</option>
              <option value="dashscope" ${cfg.provider === 'dashscope' ? 'selected' : ''}>阿里百炼 DashScope（自备 Key）</option>
              <option value="custom" ${cfg.provider === 'custom' ? 'selected' : ''}>自定义端点 / 自建代理</option>
            </select>
          </div>
          <div class="field" style="margin-bottom:12px">
            <label>API Key（可选）</label>
            <input class="input" type="password" id="eKey" value="${esc(cfg.apiKey)}" placeholder="留空则不启用截图识别">
            <div class="hint">只保存在本机 localStorage，不会上传到本应用以外的地方。</div>
          </div>
          <div class="field" style="margin-bottom:0">
            <label>自定义端点 / 模型（可选）</label>
            <div class="row2">
              <input class="input" id="eEndpoint" value="${esc(cfg.endpoint)}" placeholder="https://.../api/extract">
              <input class="input" id="eModel" value="${esc(cfg.model)}" placeholder="模型名">
            </div>
            <div class="hint">
              想让所有人都免配置用上识别，可自建代理后填在这里 ——
              做法见仓库 <b>docs/AI通道部署.md</b>。
            </div>
          </div>
        </div>
      </details>

      <div class="row2" style="margin-top:18px">
        <button class="btn primary" id="sSave">保存设置</button>
        <button class="btn" id="sReset" style="color:var(--danger)">清空全部数据</button>
      </div>`;

    let editSeason = ui.season;
    const unitEditor = body.querySelector('#unitEditor');
    const drawUnits = () => {
      const units = state.schedule[editSeason].units;
      unitEditor.innerHTML = units.map((u, i) => `
        <div style="display:grid;grid-template-columns:1fr 1fr 1fr;gap:8px;margin-bottom:8px">
          <input class="input" data-i="${i}" data-k="periods" value="${esc(u.periods)}" placeholder="第1-2节">
          <input class="input" data-i="${i}" data-k="start" value="${esc(u.start)}" placeholder="08:00">
          <input class="input" data-i="${i}" data-k="end" value="${esc(u.end)}" placeholder="09:40">
        </div>`).join('');
      unitEditor.querySelectorAll('input').forEach((inp) => {
        inp.onchange = () => {
          state.schedule[editSeason].units[Number(inp.dataset.i)][inp.dataset.k] = inp.value.trim();
          render();
        };
      });
    };
    drawUnits();
    body.querySelectorAll('[data-season]').forEach((b) => {
      b.onclick = () => {
        editSeason = b.dataset.season;
        body.querySelectorAll('[data-season]').forEach((x) => x.classList.toggle('on', x === b));
        drawUnits();
      };
    });

    const setAuto = (on) => {
      ui.autoSeason = on;
      body.querySelector('#sAuto1').classList.toggle('on', on);
      body.querySelector('#sAuto0').classList.toggle('on', !on);
      if (!on) {
        // 手动模式下，若当前周不在所选季节，保持用户选择
        ui.season = seasonNow();
      }
      render();
    };
    body.querySelector('#sAuto1').onclick = () => setAuto(true);
    body.querySelector('#sAuto0').onclick = () => setAuto(false);

    body.querySelector('#sPreset').onchange = (e) => {
      const p = PRESET_SCHEDULES[e.target.value];
      state.settings.preset = p.key;
      state.schedule = structuredClone(p);
      drawUnits(); render(); toast('已套用预设：' + p.name);
    };
    body.querySelector('#sSave').onclick = () => {
      state.settings.title = body.querySelector('#sTitle').value.trim() || '我的课表';
      state.settings.semesterStart = body.querySelector('#sStart').value || state.settings.semesterStart;
      state.settings.totalWeeks = clamp(Number(body.querySelector('#sWeeks').value) || 20, 1, 30);
      saveExtractConfig({
        provider: body.querySelector('#eProvider').value,
        apiKey: body.querySelector('#eKey').value.trim(),
        endpoint: body.querySelector('#eEndpoint').value.trim(),
        model: body.querySelector('#eModel').value.trim(),
      });
      save(); render(); closeSheet(); toast('设置已保存');
    };
    body.querySelector('#sReset').onclick = () => {
      if (!confirm('确定清空全部课表数据与设置？此操作不可撤销。')) return;
      localStorage.removeItem(STORAGE_KEY);
      state = defaultState();
      ui.week = currentWeek();
      save(); render(); closeSheet(); toast('已清空');
    };
  });
}

/* ============================ 导出 ============================ */
function openExport() {
  openSheet('导出 / 备份', (body) => {
    body.innerHTML = `
      <div class="field">
        <label>课表数据（JSON）</label>
        <div class="hint" style="margin-bottom:8px">换手机、重装 App 时用它恢复；也可以分享给同学。</div>
        <div class="row2">
          <button class="btn" id="xCopyJson">复制 JSON</button>
          <button class="btn" id="xDownJson">下载文件</button>
        </div>
      </div>
      <div class="field">
        <label>课表图片（PNG）</label>
        <div class="hint" style="margin-bottom:8px">把当前这一周的课表导出成图片，方便发群里或设成壁纸。</div>
        <button class="btn primary" id="xPng" style="width:100%">生成当前周图片</button>
      </div>
      <div class="field">
        <label>日历文件（ICS）</label>
        <div class="hint" style="margin-bottom:8px">导入手机日历，每节课自动提醒。</div>
        <button class="btn" id="xIcs" style="width:100%">下载 .ics</button>
      </div>
      <div class="field">
        <label>文本导出</label>
        <button class="btn" id="xText" style="width:100%">导出为可粘贴文本</button>
      </div>`;

    body.querySelector('#xCopyJson').onclick = async () => {
      const txt = JSON.stringify(exportState(), null, 2);
      const ok = await copyText(txt);
      toast(ok ? 'JSON 已复制到剪贴板' : '复制失败，请用下载');
    };
    body.querySelector('#xDownJson').onclick = () => {
      download(`${safeName(state.settings.title)}.json`, JSON.stringify(exportState(), null, 2), 'application/json');
    };
    body.querySelector('#xPng').onclick = () => { exportPng(); };
    body.querySelector('#xIcs').onclick = () => { exportIcs(); };
    body.querySelector('#xText').onclick = async () => {
      const ok = await copyText(exportText());
      toast(ok ? '文本已复制' : '复制失败');
    };
  });
}

function exportState() {
  return {
    version: 1,
    settings: { ...state.settings },
    schedule: state.schedule,
    courses: state.courses.map(({ needsReview, confidence, ...rest }) => rest),
    meta: { ...state.meta, exportedAt: new Date().toISOString() },
  };
}

function exportText() {
  const lines = [];
  for (let d = 1; d <= 7; d++) {
    const list = state.courses.filter((c) => c.day === d);
    if (!list.length) continue;
    lines.push(`【星期${DOW_NAMES[d - 1]}】`);
    for (const c of list.sort((a, b) => a.startUnit - b.startUnit)) {
      const u = unitsOf();
      const t = u[c.startUnit - 1];
      lines.push(`  第${c.startUnit}大节${t ? `(${t.start}-${(u[(c.endUnit || c.startUnit) - 1] || t).end})` : ''} ${c.name} @${c.location || '—'} ${c.teacher || ''} [${weeksToText(weeksFromCourse(c)) || '每周'}]`);
    }
  }
  return lines.join('\n');
}

async function copyText(txt) {
  try {
    await navigator.clipboard.writeText(txt);
    return true;
  } catch {
    try {
      const ta = document.createElement('textarea');
      ta.value = txt;
      ta.style.position = 'fixed';
      ta.style.opacity = '0';
      document.body.appendChild(ta);
      ta.select();
      const ok = document.execCommand('copy');
      ta.remove();
      return ok;
    } catch { return false; }
  }
}
function download(filename, content, type = 'text/plain') {
  const blob = content instanceof Blob ? content : new Blob([content], { type: type + ';charset=utf-8' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = filename;
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 4000);
}
function safeName(s) { return String(s || 'course-table').replace(/[\\/:*?"<>|]/g, '_'); }

/** 用 canvas 画一张当前周的课表图片 */
async function exportPng() {
  const units = unitsOf();
  const rows = Math.max(units.length, 5);
  const scale = 2;
  const axisW = 62, headH = 54, cellW = 108, cellH = 84, pad = 22;
  const titleH = 62;
  const W = pad * 2 + axisW + cellW * 7;
  const H = pad * 2 + titleH + headH + cellH * rows;

  const cv = document.createElement('canvas');
  cv.width = W * scale;
  cv.height = H * scale;
  const ctx = cv.getContext('2d');
  ctx.scale(scale, scale);

  const dark = document.documentElement.dataset.theme === 'dark';
  const c = {
    bg: dark ? '#0f1420' : '#ffffff',
    line: dark ? '#28303f' : '#e6eaf2',
    text: dark ? '#eaeef7' : '#1b2436',
    text2: dark ? '#a4b0c6' : '#5b6780',
    text3: dark ? '#6f7c93' : '#93a0b8',
    brand: '#2f6bff',
  };
  ctx.fillStyle = c.bg;
  ctx.fillRect(0, 0, W, H);

  const font = (size, weight = 400) =>
    `${weight} ${size}px -apple-system,"PingFang SC","Microsoft YaHei",system-ui,sans-serif`;
  ctx.textBaseline = 'middle';

  // 标题
  ctx.fillStyle = c.text;
  ctx.font = font(19, 700);
  ctx.fillText(state.settings.title || '我的课表', pad, pad + 16);
  ctx.font = font(12);
  ctx.fillStyle = c.text3;
  const a = dayDate(ui.week, 1), b = dayDate(ui.week, 7);
  ctx.fillText(`第 ${ui.week} 周  ·  ${a.getMonth() + 1}/${a.getDate()} - ${b.getMonth() + 1}/${b.getDate()}  ·  ${state.schedule[seasonNow()].label}`, pad, pad + 40);

  const top = pad + titleH;
  // 星期表头
  ctx.font = font(12, 600);
  const todayDow = new Date().getDay() === 0 ? 7 : new Date().getDay();
  for (let d = 1; d <= 7; d++) {
    const x = pad + axisW + (d - 1) * cellW;
    const date = dayDate(ui.week, d);
    const isToday = ui.week === currentWeek() && d === todayDow;
    ctx.fillStyle = isToday ? c.brand : c.text2;
    ctx.textAlign = 'center';
    ctx.fillText(`周${DOW_NAMES[d - 1]}`, x + cellW / 2, top + 16);
    ctx.font = font(13, 700);
    ctx.fillStyle = isToday ? c.brand : c.text;
    ctx.fillText(String(date.getDate()), x + cellW / 2, top + 36);
    ctx.font = font(12, 600);
  }

  const gridTop = top + headH;
  // 网格
  ctx.strokeStyle = c.line;
  ctx.lineWidth = 1;
  for (let r = 0; r <= rows; r++) {
    ctx.beginPath();
    ctx.moveTo(pad, gridTop + r * cellH);
    ctx.lineTo(pad + axisW + cellW * 7, gridTop + r * cellH);
    ctx.stroke();
  }
  for (let d = 0; d <= 7; d++) {
    ctx.beginPath();
    ctx.moveTo(pad + axisW + d * cellW, top);
    ctx.lineTo(pad + axisW + d * cellW, gridTop + rows * cellH);
    ctx.stroke();
  }

  // 时间轴
  ctx.textAlign = 'center';
  for (let u = 1; u <= rows; u++) {
    const y = gridTop + (u - 1) * cellH;
    const un = units[u - 1];
    ctx.fillStyle = c.text2;
    ctx.font = font(12.5, 700);
    ctx.fillText(un ? (un.periods.match(/\d+/g) || [String(u)])[0] : '·', pad + axisW / 2, y + 24);
    ctx.fillStyle = c.text3;
    ctx.font = font(9.5);
    if (un) {
      ctx.fillText(un.start, pad + axisW / 2, y + 42);
      ctx.fillText(un.end, pad + axisW / 2, y + 54);
    }
  }

  // 课程块
  for (const course of state.courses) {
    if (!course.day || !course.startUnit || !courseHitsWeek(course, ui.week)) continue;
    const span = (course.endUnit || course.startUnit) - course.startUnit + 1;
    const x = pad + axisW + (course.day - 1) * cellW + 3;
    const y = gridTop + (course.startUnit - 1) * cellH + 3;
    const w = cellW - 6, h = cellH * span - 6;
    const col = colorOf(course);
    roundRect(ctx, x, y, w, h, 8);
    ctx.fillStyle = col.bg;
    ctx.fill();
    ctx.fillStyle = col.ink;
    ctx.fillRect(x, y + 6, 3, h - 12);

    ctx.textAlign = 'left';
    ctx.fillStyle = col.ink;
    ctx.font = font(12, 700);
    const nameLines = wrapText(ctx, course.name, w - 14, 2);
    let ty = y + 16;
    for (const ln of nameLines) { ctx.fillText(ln, x + 9, ty); ty += 15; }
    ctx.font = font(10);
    ctx.globalAlpha = .82;
    if (course.location) ctx.fillText(clip(ctx, shortLoc(course.location), w - 14), x + 9, ty + 2);
    if (course.teacher && span >= 2) { ctx.fillText(clip(ctx, course.teacher, w - 14), x + 9, ty + 16); }
    ctx.globalAlpha = 1;
  }

  ctx.textAlign = 'center';
  ctx.fillStyle = c.text3;
  ctx.font = font(10);
  ctx.fillText('由「课表」生成 · 数据完全本地', W / 2, H - 10);

  cv.toBlob((blob) => {
    if (!blob) { toast('图片生成失败'); return; }
    download(`${safeName(state.settings.title)}-第${ui.week}周.png`, blob);
    toast('图片已导出');
  }, 'image/png');
}
function roundRect(ctx, x, y, w, h, r) {
  ctx.beginPath();
  ctx.moveTo(x + r, y);
  ctx.arcTo(x + w, y, x + w, y + h, r);
  ctx.arcTo(x + w, y + h, x, y + h, r);
  ctx.arcTo(x, y + h, x, y, r);
  ctx.arcTo(x, y, x + w, y, r);
  ctx.closePath();
}
function wrapText(ctx, text, maxW, maxLines) {
  const chars = [...String(text)];
  const lines = [];
  let cur = '';
  for (const ch of chars) {
    if (ctx.measureText(cur + ch).width > maxW && cur) {
      lines.push(cur);
      cur = ch;
      if (lines.length >= maxLines) break;
    } else cur += ch;
  }
  if (lines.length < maxLines && cur) lines.push(cur);
  return lines.slice(0, maxLines);
}
function clip(ctx, text, maxW) {
  let s = String(text);
  if (ctx.measureText(s).width <= maxW) return s;
  while (s.length > 1 && ctx.measureText(s + '…').width > maxW) s = s.slice(0, -1);
  return s + '…';
}

/** 导出 ICS：把每门课按周展开成重复事件 */
function exportIcs() {
  const wkst = 'MO';
  const lines = [
    'BEGIN:VCALENDAR', 'VERSION:2.0', 'PRODID:-//better-class//course-table//CN', 'CALSCALE:GREGORIAN',
  ];
  const stamp = new Date().toISOString().replace(/[-:]/g, '').replace(/\.\d+/, '');
  const total = state.settings.totalWeeks;

  for (const c of state.courses) {
    if (!c.day || !c.startUnit) continue;
    const wk = weeksFromCourse(c);
    const unit = unitsOf()[c.startUnit - 1];
    const unitEnd = unitsOf()[(c.endUnit || c.startUnit) - 1] || unit;
    if (!unit?.start || !unitEnd?.end) continue;
    const emStart = mondayOfWeek(1);
    emStart.setDate(emStart.getDate() + (c.day - 1));

    for (let w = 1; w <= total; w++) {
      if (!courseHitsWeek(c, w)) continue;
      if (wk.kind === 'ranges' && !wk.ranges.some(([a, b]) => w >= a && w <= b)) continue;
      const d = new Date(emStart);
      d.setDate(d.getDate() + (w - 1) * 7);
      const [sh, sm] = unit.start.split(':').map(Number);
      const [eh, em] = unitEnd.end.split(':').map(Number);
      const s = new Date(d); s.setHours(sh, sm, 0, 0);
      const e = new Date(d); e.setHours(eh, em, 0, 0);
      lines.push(
        'BEGIN:VEVENT',
        `UID:${c.id}-w${w}@better-class`,
        `DTSTAMP:${stamp}`,
        `DTSTART:${icsTime(s)}`,
        `DTEND:${icsTime(e)}`,
        `SUMMARY:${icsEsc(c.name)}`,
        `LOCATION:${icsEsc([c.campus, c.location].filter(Boolean).join(' '))}`,
        `DESCRIPTION:${icsEsc([c.teacher && '教师：' + c.teacher, '周次：第' + w + '周'].filter(Boolean).join('\\n'))}`,
        'BEGIN:VALARM', 'TRIGGER:-PT15M', 'ACTION:DISPLAY', 'DESCRIPTION:上课提醒', 'END:VALARM',
        'END:VEVENT',
      );
    }
  }
  lines.push('END:VCALENDAR');
  download(`${safeName(state.settings.title)}.ics`, lines.join('\r\n'), 'text/calendar');
  toast('ICS 已导出，可导入手机日历');
}
function icsTime(d) {
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}T${p(d.getHours())}${p(d.getMinutes())}00`;
}
function icsEsc(s) {
  return String(s || '').replace(/\\/g, '\\\\').replace(/;/g, '\\;').replace(/,/g, '\\,').replace(/\n/g, '\\n');
}

/* ============================ 识别配置 ============================ */
const EXTRACT_KEY = 'better-class.extract.v1';
function getExtractConfig() {
  try {
    const raw = localStorage.getItem(EXTRACT_KEY);
    const cfg = raw ? JSON.parse(raw) : {};
    return { provider: cfg.provider || 'local', apiKey: cfg.apiKey || '', endpoint: cfg.endpoint || '', model: cfg.model || '' };
  } catch { return { provider: 'local', apiKey: '', endpoint: '', model: '' }; }
}
function saveExtractConfig(cfg) {
  try { localStorage.setItem(EXTRACT_KEY, JSON.stringify(cfg)); } catch { /* ignore */ }
}
function providerSummary(cfg) {
  const map = {
    local: '本机视觉服务（无需 Key）',
    zhipu: '智谱 GLM-4V-Flash',
    siliconflow: '硅基流动 Qwen2.5-VL',
    openrouter: 'OpenRouter',
    dashscope: '阿里百炼',
    custom: cfg.endpoint || '自定义端点',
  };
  return map[cfg.provider] || cfg.provider;
}

/* ============================ 主题 ============================ */
function applyTheme() {
  const pref = state.settings.theme || 'system';
  const dark = pref === 'dark' || (pref === 'system' && window.matchMedia('(prefers-color-scheme: dark)').matches);
  document.documentElement.dataset.theme = dark ? 'dark' : 'light';
}
function migrateThemeColor() {
  const meta = document.querySelector('meta[name=theme-color]');
  if (meta) meta.content = document.documentElement.dataset.theme === 'dark' ? '#0f1420' : '#f6f7fb';
}

/* ============================ 事件绑定 ============================ */
function bind() {
  el('btnPrevWeek').onclick = () => { ui.week = clamp(ui.week - 1, 1, state.settings.totalWeeks); render(); };
  el('btnNextWeek').onclick = () => { ui.week = clamp(ui.week + 1, 1, state.settings.totalWeeks); render(); };
  el('btnToday').onclick = () => { ui.week = currentWeek(); render(); toast('回到本周'); };
  el('btnWeeks').onclick = () => {
    openSheet('选择周次', (body) => {
      const total = state.settings.totalWeeks;
      const hasCourse = new Set();
      for (let w = 1; w <= total; w++) {
        if (state.courses.some((c) => c.day && c.startUnit && courseHitsWeek(c, w))) hasCourse.add(w);
      }
      body.innerHTML = `<div class="weeks-grid">${Array.from({ length: total }, (_, i) => i + 1)
        .map((w) => `<button data-w="${w}" class="${w === ui.week ? 'on' : ''} ${hasCourse.has(w) ? 'has-course' : ''}">${w}</button>`).join('')}</div>
        <div class="hint" style="margin-top:12px;font-size:11.5px;color:var(--text-3)">高亮边框 = 有课的周</div>`;
      body.querySelectorAll('[data-w]').forEach((b) => {
        b.onclick = () => { ui.week = Number(b.dataset.w); closeSheet(); render(); };
      });
    });
  };
  el('chipWinter').onclick = () => { ui.autoSeason = false; ui.season = 'winter'; render(); };
  el('chipSummer').onclick = () => { ui.autoSeason = false; ui.season = 'summer'; render(); };
  el('chipWinter').ondblclick = el('chipSummer').ondblclick = () => { ui.autoSeason = true; render(); toast('已恢复自动切换作息'); };
  el('btnAdd').onclick = () => openCourseEditor(null);
  el('btnImport').onclick = () => openImport();
  el('btnExport').onclick = () => openExport();
  el('btnSettings').onclick = () => openSettings();
  el('btnTheme').onclick = () => {
    const cur = document.documentElement.dataset.theme;
    state.settings.theme = cur === 'dark' ? 'light' : 'dark';
    applyTheme(); migrateThemeColor(); save();
  };

  // 键盘快捷键（桌面调试友好）
  document.addEventListener('keydown', (e) => {
    if (e.target.matches('input,textarea,select')) return;
    if (e.key === 'ArrowLeft') el('btnPrevWeek').click();
    else if (e.key === 'ArrowRight') el('btnNextWeek').click();
    else if (e.key === 'Escape') closeSheet();
  });

  window.matchMedia('(prefers-color-scheme: dark)').addEventListener('change', () => {
    if ((state.settings.theme || 'system') === 'system') { applyTheme(); migrateThemeColor(); }
  });

  // 触摸横滑切换周
  let sx = 0, sy = 0, tracking = false;
  const scroll = el('boardScroll');
  scroll.addEventListener('touchstart', (e) => {
    if (e.touches.length !== 1) return;
    sx = e.touches[0].clientX; sy = e.touches[0].clientY; tracking = true;
  }, { passive: true });
  scroll.addEventListener('touchend', (e) => {
    if (!tracking) return;
    tracking = false;
    const t = e.changedTouches[0];
    const dx = t.clientX - sx, dy = t.clientY - sy;
    if (Math.abs(dx) > 70 && Math.abs(dx) > Math.abs(dy) * 1.8) {
      ui.week = clamp(ui.week + (dx < 0 ? 1 : -1), 1, state.settings.totalWeeks);
      render();
    }
  }, { passive: true });

  window.addEventListener('resize', () => { fitScale(); renderNowLine(); });
  if (window.ResizeObserver) {
    new ResizeObserver(() => { fitScale(); renderNowLine(); }).observe(el('boardScroll'));
  }
}

/* ============================ 启动 ============================ */
function boot() {
  applyTheme();
  migrateThemeColor();
  ui.week = currentWeek();
  bind();
  render();
  appFlags.booted = true;

  // 首次使用提示
  if (!state.courses.length) {
    const slot = el('onboardSlot');
    slot.innerHTML = `
      <div class="onboard-tip" id="tip">
        <span>👋 <b>三步生成课表</b><br>① 点底部「导入课表」<br>② 传一张课表截图（或粘贴教务系统文本）<br>③ 自动生成，可切夏/冬作息</span>
        <button class="x" id="tipX">×</button>
      </div>`;
    slot.querySelector('#tipX').onclick = () => slot.innerHTML = '';
  }

  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible') render();
  });
}

/** 载入内置示例（用于第一次体验 / 演示） */
async function loadDemo() {
  try {
    const demo = await import('./demo-data.js');
    const data = demo.default || demo.DEMO;
    const incoming = normalizeState(data);
    state = incoming;
    state.courses = auditCourses(state.courses);
    ui.week = currentWeek();
    save(); render(); closeSheet();
    toast(`已载入示例：${state.courses.length} 门课`);
  } catch (e) {
    toast('示例载入失败：' + e.message);
  }
}
window.__loadDemo = loadDemo;
window.__openImport = () => openImport();

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', boot, { once: true });
} else {
  boot();
}

// 暴露给内联 onclick 与调试
window.__app = {
  get state() { return state; },
  ui, render, loadDemo, openImport, openSettings, PRESET_SCHEDULES,
  parseScheduleText, normalizeState, exportPng,
};
window.addEventListener('error', (e) => console.error('[better-class]', e.error || e.message));
