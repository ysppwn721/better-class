/* ============================================================================
 * extractor.js — 截图 → 课表 JSON
 *
 * 设计要点：把「识别」做成可插拔的链路，从便宜到贵依次尝试，任一条成功即返回。
 *   1) local  : 本机 DSH 视觉服务（/vision），无需任何 Key —— 默认
 *   2) 免费云  : 智谱 GLM-4V-Flash / 硅基流动 Qwen2.5-VL（填 Key 即可，均免费额度）
 *   3) 自备云  : 用户自己的 OpenAI 兼容视觉端点（OpenRouter / DashScope / 任意）
 *
 * 输出的 JSON 必须满足「课表数据格式 v1」：见 app.js normalizeState()
 * ==========================================================================*/

/** 要求模型输出的严格结构（提示词内嵌，保证跨模型稳定） */
export const SCHEMA_HINT = `{
  "settings": { "title": "课表标题，通常是姓名+课表", "semesterStart": "YYYY-MM-DD", "totalWeeks": 20 },
  "schedule": {
    "winter": { "label": "冬季作息", "units": [ { "periods": "第1-2节", "start": "08:00", "end": "08:50" } ] },
    "summer": { "label": "夏季作息", "units": [ { "periods": "第1-2节", "start": "08:00", "end": "08:50" } ] }
  },
  "courses": [
    {
      "name": "课程名",
      "teacher": "教师",
      "location": "上课地点",
      "campus": "校区",
      "day": 1,
      "startUnit": 1,
      "endUnit": 2,
      "weeks": "1-16周",
      "credit": "4",
      "classroomNote": "教学班/考核方式等补充",
      "confidence": 0.95
    }
  ]
}`;

export const EXTRACT_PROMPT = `你是高校课程表截图识别引擎。请把这张课程表截图转换成结构化 JSON。

【必须遵守】
1. 只输出一个 JSON 对象，不要 markdown 代码块，不要任何解释文字。
2. 严格按下面结构输出：
${SCHEMA_HINT}

【字段规则】
- day：1=星期一 … 7=星期日。必须根据表格左列的「星期X」确定，不要靠猜。
- startUnit/endUnit：该课程在一天中的第几个「大节」（1=第1-2节，2=第3-4节，3=第5-6节，4=第7-8节，5=第9-10节）。
  表格里若写「1-2」或「1、2」→ 第1大节；「3-4」→ 第2大节；依此类推。跨两个大节连上则 startUnit≠endUnit。
- weeks：原样保留周数字符串，如 "1-16周"、"1-10周"、"第2周"、"1-8周,10-16周"、"单周"。
- 若截图中有「作息时间表 / 上课时间」表格，请把时间填入 schedule.winter 或 schedule.summer 的 units；
  若截图里没有时间信息（很多教务系统截图没有），units 就输出空数组 []，不要编造时间。
- 若截图是「冬/夏两套作息」或分别标注，请分别填入 winter / summer；无法区分时全部放 winter，summer 留空数组。
- 课程卡片若为同一门课连续节次，合并成一条（startUnit~endUnit）。
- 同一课程名出现在不同星期/不同节次 → 拆成多条记录。
- 不要输出截图中不存在的课程。宁可少，不可编。
- 每门课给一个 confidence（0~1），表示你对该条识别准确度的估计；文字模糊、被裁切时给低分。`;

/* --------------------------------------------------------------------------
 * 图片预处理：等比缩放到长边 <= maxEdge，JPEG 压缩，降低 token 与失败率
 * ------------------------------------------------------------------------*/
export async function prepareImage(file, maxEdge = 1600) {
  const bitmap = await loadBitmap(file);
  const scale = Math.min(1, maxEdge / Math.max(bitmap.width, bitmap.height));
  const w = Math.max(1, Math.round(bitmap.width * scale));
  const h = Math.max(1, Math.round(bitmap.height * scale));
  const canvas = document.createElement('canvas');
  canvas.width = w;
  canvas.height = h;
  const ctx = canvas.getContext('2d');
  ctx.fillStyle = '#ffffff';
  ctx.fillRect(0, 0, w, h);
  ctx.imageSmoothingQuality = 'high';
  ctx.drawImage(bitmap, 0, 0, w, h);
  if (bitmap.close) bitmap.close();
  const dataUrl = canvas.toDataURL('image/jpeg', 0.86);
  return { dataUrl, base64: dataUrl.split(',')[1], width: w, height: h, originalWidth: bitmap.width || w, originalHeight: bitmap.height || h };
}

async function loadBitmap(file) {
  if (window.createImageBitmap) {
    try { return await createImageBitmap(file); } catch { /* fallthrough */ }
  }
  return await new Promise((resolve, reject) => {
    const img = new Image();
    const url = URL.createObjectURL(file);
    img.onload = () => { URL.revokeObjectURL(url); resolve(img); };
    img.onerror = () => { URL.revokeObjectURL(url); reject(new Error('图片读取失败')); };
    img.src = url;
  });
}

/* --------------------------------------------------------------------------
 * JSON 抽取：模型经常在 JSON 外面包 markdown 或说明文字，这里做鲁棒解析
 * ------------------------------------------------------------------------*/
export function parseModelJson(text) {
  if (!text || typeof text !== 'string') throw new Error('模型返回为空');
  let s = text.trim();
  s = s.replace(/^```(?:json)?\s*/i, '').replace(/```\s*$/, '').trim();
  try { return JSON.parse(s); } catch { /* 继续尝试 */ }
  // 括号配平扫描，取出第一个完整 JSON 对象
  const start = s.indexOf('{');
  if (start < 0) throw new Error('模型返回中没有 JSON 对象');
  let depth = 0, inStr = false, esc = false;
  for (let i = start; i < s.length; i++) {
    const ch = s[i];
    if (inStr) {
      if (esc) esc = false;
      else if (ch === '\\') esc = true;
      else if (ch === '"') inStr = false;
      continue;
    }
    if (ch === '"') inStr = true;
    else if (ch === '{') depth++;
    else if (ch === '}') {
      depth--;
      if (depth === 0) {
        const candidate = s.slice(start, i + 1);
        try { return JSON.parse(candidate); } catch { /* 修复常见问题后重试 */ }
        const repaired = candidate
          .replace(/,\s*([}\]])/g, '$1')          // 尾逗号
          .replace(/[\u201c\u201d]/g, '"')        // 中文引号
          .replace(/[\u2018\u2019]/g, "'");
        return JSON.parse(repaired);
      }
    }
  }
  throw new Error('模型返回的 JSON 不完整');
}

/* --------------------------------------------------------------------------
 * 供应商抽象
 * ------------------------------------------------------------------------*/
const FREE_ZHIPU = 'https://open.bigmodel.cn/api/paas/v4/chat/completions';
const FREE_SILICON = 'https://api.siliconflow.cn/v1/chat/completions';

/* --------------------------------------------------------------------------
 * 内嵌通道：构建时注入的服务端代理地址（用户零配置）
 *   构建时通过 BC_AI_ENDPOINT 写进 window.__BC_AI_ENDPOINT；
 *   也可由用户自己在「设置」里填。
 * ------------------------------------------------------------------------*/
export function builtinEndpoint() {
  try {
    return (globalThis.__BC_AI_ENDPOINT || '').trim();
  } catch { return ''; }
}

export function buildProviders({ apiKey = '', provider = 'local', endpoint = '', model = '' } = {}) {
  const list = [];

  // 0) 内嵌代理（零配置）——有就优先走它，用户什么都不用填
  const builtin = builtinEndpoint();
  if (builtin) {
    list.push({
      id: 'builtin',
      label: '内置识别通道',
      available: true,
      call: (payload) => callBuiltin(builtin, payload),
    });
  }

  // 1) 本机 DSH 视觉服务（开发环境用，无需 Key）
  list.push({
    id: 'local',
    label: '本机视觉服务（无需 Key）',
    available: true,
    call: (payload) => callLocal(payload),
  });

  // 1) 智谱 GLM-4V-Flash（免费）
  list.push({
    id: 'zhipu',
    label: '智谱 GLM-4V-Flash（免费额度）',
    available: !!apiKey && provider === 'zhipu',
    call: (payload) => callOpenAICompatible({
      url: FREE_ZHIPU, key: apiKey, model: model || 'glm-4v-flash', payload,
    }),
  });

  // 2) 硅基流动 Qwen2.5-VL（免费额度）
  list.push({
    id: 'siliconflow',
    label: '硅基流动 Qwen2.5-VL（免费额度）',
    available: !!apiKey && provider === 'siliconflow',
    call: (payload) => callOpenAICompatible({
      url: FREE_SILICON, key: apiKey, model: model || 'Qwen/Qwen2.5-VL-32B-Instruct', payload,
    }),
  });

  // 3) 任意 OpenAI 兼容端点（OpenRouter / DashScope / 自建）
  list.push({
    id: 'custom',
    label: '自定义 OpenAI 兼容端点',
    available: !!endpoint && (provider === 'custom' || provider === 'openrouter' || provider === 'dashscope'),
    call: (payload) => callOpenAICompatible({
      url: resolveEndpoint(provider, endpoint), key: apiKey, model: model || 'gpt-4o-mini', payload,
    }),
  });

  return list;
}

function resolveEndpoint(provider, endpoint) {
  if (provider === 'openrouter') return 'https://openrouter.ai/api/v1/chat/completions';
  if (provider === 'dashscope') return 'https://dashscope.aliyuncs.com/compatible-mode/v1/chat/completions';
  return endpoint;
}

/** 内嵌代理：POST {endpoint}  body: {image, prompt} → {text} */
async function callBuiltin(endpoint, { dataUrl, prompt }) {
  const url = endpoint.replace(/\/+$/, '') + '/api/extract';
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ image: dataUrl, prompt }),
  });
  const txt = await res.text().catch(() => '');
  let json = null;
  try { json = JSON.parse(txt); } catch { /* 可能不是 JSON */ }
  if (!res.ok || (json && json.error)) {
    throw new Error((json && json.error) || `内置通道不可用（HTTP ${res.status}）${txt.slice(0, 120)}`);
  }
  const text = (json && (json.text || json.content)) || txt;
  if (!text || !String(text).trim()) throw new Error('内置通道返回为空');
  return text;
}

/** 本机 DSH 视觉服务：由 better-class 插件在 DSH 侧暴露 /vision 路由 */
async function callLocal({ dataUrl, prompt }) {
  const res = await fetch('/vision/extract-schedule', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ image: dataUrl, prompt }),
  });
  if (!res.ok) {
    const t = await res.text().catch(() => '');
    throw new Error(`本机视觉服务不可用（HTTP ${res.status}）${t ? '：' + t.slice(0, 160) : ''}`);
  }
  const json = await res.json();
  if (json.error) throw new Error(json.error);
  return json.text || json.content || '';
}

async function callOpenAICompatible({ url, key, model, payload, timeoutMs = 90000 }) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        ...(key ? { Authorization: `Bearer ${key}` } : {}),
      },
      body: JSON.stringify({
        model,
        temperature: 0,
        max_tokens: 8000,
        messages: [{
          role: 'user',
          content: [
            { type: 'text', text: payload.prompt },
            { type: 'image_url', image_url: { url: payload.dataUrl } },
          ],
        }],
      }),
      signal: ctrl.signal,
    });
    if (!res.ok) {
      const t = await res.text().catch(() => '');
      throw new Error(`HTTP ${res.status} ${t.slice(0, 180)}`);
    }
    const json = await res.json();
    const text = json?.choices?.[0]?.message?.content;
    if (typeof text === 'string') return text;
    if (Array.isArray(text)) return text.map((p) => p?.text || '').join('');
    throw new Error('返回体中没有 content');
  } finally {
    clearTimeout(timer);
  }
}

/* --------------------------------------------------------------------------
 * 主入口：识别截图
 * @param {File|Blob} file
 * @param {object} opts  { apiKey, provider, endpoint, model, onProgress }
 * @returns {Promise<{data:object, via:string, image:object}>}
 * ------------------------------------------------------------------------*/
export async function extractFromImage(file, opts = {}) {
  const { onProgress = () => {}, ...cfg } = opts;
  onProgress('正在压缩图片…');
  const image = await prepareImage(file, 1600);

  const providers = buildProviders(cfg).filter((p) => p.available);
  const errors = [];

  for (let i = 0; i < providers.length; i++) {
    const p = providers[i];
    onProgress(`正在识别（${p.label}）…`);
    try {
      const text = await p.call({ dataUrl: image.dataUrl, prompt: EXTRACT_PROMPT });
      const data = parseModelJson(text);
      if (!data || (!Array.isArray(data.courses) && !data.schedule && !data.settings)) {
        throw new Error('返回结构不符合预期');
      }
      return { data, via: p.label, image };
    } catch (err) {
      errors.push(`${p.label}：${err.message}`);
      onProgress(`「${p.label}」失败，尝试下一条通道…`);
    }
  }
  const e = new Error('所有识别通道都失败了：\n' + errors.join('\n'));
  e.details = errors;
  throw e;
}
