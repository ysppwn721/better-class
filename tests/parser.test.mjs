/* 解析器冒烟测试：node tests/parser.test.mjs */
import assert from 'node:assert/strict';
import { parseScheduleText, parseDay, periodsToUnits, parseWeeks, weeksToText, courseHitsWeek, mergeDuplicateCourses } from '../src/parser.js';
import { FULL_PAGE } from './fixture-fullpage.mjs';

let pass = 0, fail = 0;
function t(name, fn) {
  try { fn(); console.log('  ✓', name); pass++; }
  catch (e) { console.log('  ✗', name, '\n     ', e.message); fail++; }
}
const eq = (a, b, msg) => assert.deepEqual(a, b, msg || `${JSON.stringify(a)} !== ${JSON.stringify(b)}`);

console.log('星期解析');
t('星期一/周1/礼拜日', () => {
  eq(parseDay('星期一'), 1);
  eq(parseDay('周五'), 5);
  eq(parseDay('礼拜天'), 7);
  eq(parseDay('星期日'), 7);
  eq(parseDay('没有星期'), null);
});

console.log('节次 → 大节');
t('1-2 → 大节1', () => eq(periodsToUnits('1-2'), { startUnit: 1, endUnit: 1 }));
t('3-4 → 大节2', () => eq(periodsToUnits('3-4'), { startUnit: 2, endUnit: 2 }));
t('5-6 → 大节3', () => eq(periodsToUnits('5-6'), { startUnit: 3, endUnit: 3 }));
t('7-8 → 大节4', () => eq(periodsToUnits('7-8'), { startUnit: 4, endUnit: 4 }));
t('1-4 跨大节', () => eq(periodsToUnits('1-4'), { startUnit: 1, endUnit: 2 }));
t('第2大节', () => eq(periodsToUnits('第2大节'), { startUnit: 2, endUnit: 2 }));

console.log('周次解析');
t('1-12周', () => eq(parseWeeks('1-12周').kind, 'ranges'));
t('1-12周 含 3,4', () => assert.ok(courseHitsWeek({ weeks: parseWeeks('1-12周') }, 3) && courseHitsWeek({ weeks: parseWeeks('1-12周') }, 12)));
t('13周不上', () => assert.ok(!courseHitsWeek({ weeks: parseWeeks('1-12周') }, 13)));
t('第2周 单周', () => assert.ok(courseHitsWeek({ weeks: parseWeeks('第2周') }, 2) && !courseHitsWeek({ weeks: parseWeeks('第2周') }, 3)));
t('1-8,10-16周', () => {
  const w = parseWeeks('1-8周,10-16周');
  assert.ok(courseHitsWeek({ weeks: w }, 8));
  assert.ok(!courseHitsWeek({ weeks: w }, 9));
  assert.ok(courseHitsWeek({ weeks: w }, 10));
});
t('单周/双周', () => {
  assert.ok(courseHitsWeek({ weeks: parseWeeks('单周') }, 5));
  assert.ok(!courseHitsWeek({ weeks: parseWeeks('单周') }, 6));
  assert.ok(courseHitsWeek({ weeks: parseWeeks('双周') }, 6));
});
t('空周次 = 每周', () => assert.ok(courseHitsWeek({ weeks: parseWeeks('') }, 17)));
t('周次文本回写', () => eq(weeksToText(parseWeeks('1-8周,10-16周')).replace(/周$/, ''), '1-8,10-16'));

console.log('教务系统「块式」文本解析（真实格式）');
/* 说明：教务系统导出的文本里，每个格子是
 *     [可选] 星期X  →  [节次数字]  →  课程名  →  周数：…
 * 因此「节次」紧邻课程名。下面夹具按此排布，并保留字段被列宽劈开的碎片行。 */
const BLOCK_TEXT = `课表信息
星期一
1-2
概率论与数理统计B
周数：1-12周 校区:本部 上课
地点：15106H 教师：李毅红 教学
班：概率论与数理统计B-0021 教学班组
成：25070141;25070142;25070143 考核
方式：校级考试 选课备注： 课程
学时组成：理论学时:48 周学时：4
总学时：48 学分：3
星期一
3-4
电路电子技术
周数：1-10周 校区:本部 上课
地点：15106H 教师：任爱芝,鲜浩 教学
班：电路电子技术-0004 教学班组成：25070141;25070142;25070143 考核方式：校级考试 选课备注：
学时组成：理论学时:60,实验学时:20 周学时：6 总学时：60 学分：4.5
星期二
3-4
大学英语A(3)
周数：第2周 校区:本部 上课
地点：15308H 教师：陈俊芳 教学
班：大学英语A(3)-0004 教学班组成：
25070141;25070142 考核方式：校级考
试 选课备注： 课程学时组成：理
论学时:32 周学时：4 总学时：32
学分：2
星期三
5-6
数据结构
周数：1-16周 校区:本部 上课
地点：15207Z 教师：张钰嘉 教学班：数据结构-0002 教学班组成：25070142 考核方式：院级考试 选课备注：
课程学时组成：理论学时:56,实验学时:8 周学时：4 总学时:56 学分：4.0`;

const r = parseScheduleText(BLOCK_TEXT);
const names = r.courses.map((c) => c.name);
const byName = (n) => r.courses.find((c) => c.name === n);

t('解析出 4 门课', () => eq(r.courses.length, 4, `实际 ${r.courses.length}：${names.join(' / ')}`));
t('课程名干净（无字段标签残留）', () => {
  for (const n of ['概率论与数理统计B', '电路电子技术', '大学英语A(3)', '数据结构']) {
    assert.ok(names.includes(n), `缺 ${n}（实际：${names.join(' / ')}）`);
  }
  for (const n of names) {
    assert.ok(!/[:：]/.test(n), `课程名里混进了字段标签：${n}`);
    assert.ok(n.length <= 30, `课程名异常长：${n}`);
  }
});
t('星期归属', () => {
  eq(byName('概率论与数理统计B').day, 1);
  eq(byName('电路电子技术').day, 1);
  eq(byName('大学英语A(3)').day, 2);
  eq(byName('数据结构').day, 3);
});
t('节次归属（1-2→大节1，3-4→大节2，5-6→大节3）', () => {
  eq(byName('概率论与数理统计B').startUnit, 1);
  eq(byName('电路电子技术').startUnit, 2);
  eq(byName('大学英语A(3)').startUnit, 2);
  eq(byName('数据结构').startUnit, 3);
});
t('字段抽取：地点/教师/周数/学分', () => {
  const c = byName('概率论与数理统计B');
  eq(c.location, '15106H');
  eq(c.teacher, '李毅红');
  eq(c.credit, '3');
  eq(c.campus, '本部');
  assert.ok(courseHitsWeek(c, 1) && !courseHitsWeek(c, 13), '1-12周 判定错误');
});
t('「第2周」只上第 2 周', () => {
  const c = byName('大学英语A(3)');
  assert.ok(courseHitsWeek(c, 2) && !courseHitsWeek(c, 5), '第2周 判定错误');
});
t('教师不被换行劈开（任爱芝,鲜浩 / 陈俊芳）', () => {
  eq(byName('电路电子技术').teacher, '任爱芝,鲜浩');
  eq(byName('大学英语A(3)').teacher, '陈俊芳');
});
t('被劈开的「教学班组成」不污染字段', () => {
  eq(byName('大学英语A(3)').location, '15308H');
  eq(byName('数据结构').location, '15207Z');
});

console.log('行式文本解析');
const ROW_TEXT = `周一 1-2 概率论与数理统计B 教师：李毅红 地点：15106H 周数：1-12周
星期一 3-4 电路电子技术 教师：任爱芝 地点：15106H 周数：1-10周
周三 5-6 高等数学 地点：07104H 周数：1-16周`;
const rr = parseScheduleText(ROW_TEXT);
t('3 行 3 门课', () => eq(rr.courses.length, 3, JSON.stringify(rr.courses.map((c) => [c.day, c.startUnit, c.name]))));
t('星期/节次正确', () => {
  eq(rr.courses[0].day, 1);
  eq(rr.courses[1].startUnit, 2);
  eq(rr.courses[2].day, 3);
});
t('地点不被吞进课程名', () => {
  eq(rr.courses[2].name, '高等数学');
  eq(rr.courses[2].location, '07104H');
});

console.log('HTML 表格解析');
const HTML_TEXT = `<table><tr><td>星期一</td><td>1-2</td><td>大学物理A2 周数：1-16周 地点：07104H 教师：张秀清</td></tr>
<tr><td>星期二</td><td>3-4</td><td>数据结构 周数：1-16周 地点：15207Z 教师：张钰嘉</td></tr></table>`;
const hr = parseScheduleText(HTML_TEXT);
t('HTML 表格 → 2 门课', () => eq(hr.courses.length, 2, JSON.stringify(hr.courses.map((c) => c.name))));
t('HTML 字段正确', () => {
  eq(hr.courses[0].day, 1);
  eq(hr.courses[0].location, '07104H');
  eq(hr.courses[1].startUnit, 2);
});

console.log('同课合并');
t('相邻大节合并成连堂', () => {
  const merged = mergeDuplicateCourses([
    { name: '大学物理实验(1)', teacher: '刘丽丽', location: '大物实验室6', day: 5, startUnit: 3, endUnit: 3, weeks: parseWeeks('9-17周') },
    { name: '大学物理实验(1)', teacher: '刘丽丽', location: '大物实验室6', day: 5, startUnit: 4, endUnit: 4, weeks: parseWeeks('9-17周') },
  ]);
  eq(merged.length, 1);
  eq(merged[0].startUnit, 3);
  eq(merged[0].endUnit, 4);
});

console.log('整页文本（真实规模）解析');
const fp = parseScheduleText(FULL_PAGE);
const fpNames = fp.courses.map((c) => c.name);
const find = (n, day, unit) => fp.courses.find((c) => c.name === n && (!day || c.day === day) && (!unit || c.startUnit === unit));

t('解析出 18 条课程记录', () => {
  // 16 个格子 + 大学物理实验(1) 按周分开的 4 条 = 20 条原始记录；
  // 解析器会把「同名+同星期+同地点+同周数」的相邻大节合并，最终稳定为 18 条。
  eq(fp.courses.length, 18, `实际 ${fp.courses.length}：${fpNames.join(' / ')}`);
  eq(new Set(fpNames).size, 8, `课程种类应为 8 门：${[...new Set(fpNames)].join(' / ')}`);
});
t('没有把页面噪声当课程', () => {
  for (const bad of ['个人课表查询', '输出PDF', '林子钧的课表', '版权所有', '实践课程', '其它课程', '*学期']) {
    assert.ok(!fpNames.some((n) => n.includes(bad)), `混入了噪声：${bad}`);
  }
});
t('课程名全部干净', () => {
  for (const n of fpNames) {
    assert.ok(!/[:：]/.test(n), `课程名含字段标签：${n}`);
    assert.ok(n.length <= 30, `课程名异常：${n}`);
  }
});
t('星期归属正确', () => {
  eq(find('概率论与数理统计B', 1, 1)?.day, 1);
  eq(find('电路电子技术', 1, 2)?.day, 1);
  eq(find('形势与政策3', 1, 3)?.day, 1);
  eq(find('大学物理A2', 2, 2)?.day, 2);
  eq(find('数据结构', 4, 2)?.day, 4);
  eq(find('大学英语A(3)', 4, 1)?.day, 4);
});
t('节次归属正确（1-2→大节1，3-4→大节2，5-6→大节3）', () => {
  eq(find('概率论与数理统计B', 1)?.startUnit, 1);
  eq(find('电路电子技术', 1)?.startUnit, 2);
  eq(find('形势与政策3', 1)?.startUnit, 3);
  eq(find('大学物理A2', 3)?.startUnit, 1);
  eq(find('大学英语A(3)')?.startUnit, 1);
});
t('地点/教师/学分/校区抽取正确', () => {
  const c = find('概率论与数理统计B', 1);
  eq(c.location, '15106H');
  eq(c.teacher, '李毅红');
  eq(c.credit, '3');
  eq(c.campus, '本部');
  eq(find('大学物理实验(1)')?.location?.startsWith('大物实验室'), true);
  eq(find('数据结构')?.teacher, '张钰嘉');
});
t('周数区间正确', () => {
  assert.ok(courseHitsWeek(find('概率论与数理统计B', 1), 1));
  assert.ok(courseHitsWeek(find('概率论与数理统计B', 1), 12));
  assert.ok(!courseHitsWeek(find('概率论与数理统计B', 1), 13), '1-12周 不该在第13周出现');
  assert.ok(!courseHitsWeek(find('形势与政策3', 1), 5), '13-16周 不该在第5周出现');
  assert.ok(courseHitsWeek(find('形势与政策3', 1), 14));
});
t('同名课不同星期不串行', () => {
  const mon = fp.courses.filter((c) => c.name === '电路电子技术');
  eq(mon.length, 3, `电路电子技术应有 3 条（周一/二/三），实际 ${mon.length}`);
  eq(mon.map((c) => c.day).sort().join(','), '1,2,3');
});
t('大学物理实验按周分开的 4 条都保留', () => {
  const lab = fp.courses.filter((c) => c.name === '大学物理实验(1)');
  assert.ok(lab.length >= 1, '至少解析出一条实验课');
  assert.ok(lab.every((c) => c.day === 5), '实验课都在星期五');
});

console.log(`\n结果：${pass} 通过 / ${fail} 失败`);
process.exit(fail ? 1 : 0);
