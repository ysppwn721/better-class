/* ============================================================================
 * demo-data.js — 内置示例课表（中北大学 2026-2027-1 学期，电子信息类）
 *
 * 作用：
 *   1) 第一次打开 App 时点「载入示例」即可看到完整效果，不需要先导入
 *   2) 作为「课表数据格式 v1」的参考样例：照着改就能手工维护自己的课表
 *
 * 数据格式说明：
 *   courses[].day       1=周一 … 7=周日
 *   courses[].startUnit 第几个「大节」：1=第1-2节, 2=第3-4节, 3=第5-6节,
 *                       4=第7-8节, 5=第9-10节
 *   courses[].weeks     周次，字符串形式："1-16周" / "1-8周,10-16周" / "单周"
 *                       留空 = 每周都上
 * ==========================================================================*/

export const DEMO = {
  version: 1,
  settings: {
    title: '示例课表（电子信息类）',
    subtitle: '2026-2027 学年第 1 学期',
    preset: 'nuc',
    semesterStart: '2026-08-31',
    totalWeeks: 19,
    theme: 'system',
  },
  schedule: {
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
  courses: [
    // ---- 星期一 ----
    { name: '概率论与数理统计B', teacher: '李毅红', location: '15106H', campus: '本部', day: 1, startUnit: 1, endUnit: 1, weeks: '1-12周', credit: '3' },
    { name: '电路电子技术', teacher: '任爱芝,鲜浩', location: '15106H', campus: '本部', day: 1, startUnit: 2, endUnit: 2, weeks: '1-10周', credit: '4.5' },
    { name: '形势与政策3', teacher: '王学良', location: '15106H', campus: '本部', day: 1, startUnit: 3, endUnit: 3, weeks: '13-16周', credit: '0.25' },
    // ---- 星期二 ----
    { name: '电路电子技术', teacher: '任爱芝,鲜浩', location: '15106H', campus: '本部', day: 2, startUnit: 1, endUnit: 2, weeks: '1-10周', credit: '4.5' },
    { name: '大学物理A2', teacher: '张秀清', location: '15102H', campus: '本部', day: 2, startUnit: 3, endUnit: 3, weeks: '1-16周', credit: '4' },
    { name: '毛泽东思想和中国特色社会主义理论体系概论', teacher: '高振兰', location: '07104H', campus: '本部', day: 2, startUnit: 4, endUnit: 4, weeks: '1-10周', credit: '3' },
    // ---- 星期三 ----
    { name: '大学物理A2', teacher: '张秀清', location: '07104H', campus: '本部', day: 3, startUnit: 1, endUnit: 2, weeks: '1-16周', credit: '4' },
    { name: '电路电子技术', teacher: '任爱芝,鲜浩', location: '15106H', campus: '本部', day: 3, startUnit: 3, endUnit: 3, weeks: '1-10周', credit: '4.5' },
    { name: '概率论与数理统计B', teacher: '李毅红', location: '15106H', campus: '本部', day: 3, startUnit: 4, endUnit: 4, weeks: '1-12周', credit: '3' },
    // ---- 星期四 ----
    { name: '大学英语A(3)', teacher: '陈俊芳', location: '15308H', campus: '本部', day: 4, startUnit: 1, endUnit: 2, weeks: '3-16周', credit: '2' },
    { name: '数据结构', teacher: '张钰嘉', location: '15207Z', campus: '本部', day: 4, startUnit: 3, endUnit: 3, weeks: '2-16周', credit: '4' },
    { name: '毛泽东思想和中国特色社会主义理论体系概论', teacher: '高振兰', location: '07104H', campus: '本部', day: 4, startUnit: 4, endUnit: 4, weeks: '1-10周', credit: '3' },
    // ---- 星期五 ----
    { name: '数据结构', teacher: '张钰嘉', location: '15207Z', campus: '本部', day: 5, startUnit: 1, endUnit: 1, weeks: '2-16周', credit: '4' },
    { name: '电动汽车与电力电子技术', teacher: '任爱芝', location: '15106H', campus: '本部', day: 5, startUnit: 2, endUnit: 2, weeks: '1-10周', credit: '2' },
    { name: '大学物理实验(1)', teacher: '刘丽丽', location: '大物实验室6', campus: '本部', day: 5, startUnit: 3, endUnit: 4, weeks: '9-17周', credit: '1' },
    // ---- 星期六（通识选修，示例占位） ----
    { name: '大学英语A(3)', teacher: '陈俊芳', location: '15308H', campus: '本部', day: 6, startUnit: 1, endUnit: 1, weeks: '3-16周', credit: '2' },
    // ---- 星期日 ----
    { name: '思想道德与法治', teacher: '贾文雅', location: '15307H', campus: '本部', day: 7, startUnit: 1, endUnit: 2, weeks: '1-12周', credit: '3' },
  ],
  meta: { source: 'demo', via: '内置示例' },
};

export default DEMO;
