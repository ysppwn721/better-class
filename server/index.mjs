/* ============================================================================
 * server/index.mjs — 课表识别代理（可选自部署，让用户「零配置」用上 AI）
 *
 * 为什么要这一层：
 *   浏览器/APK 里直接放 API Key 一定会泄露。正确做法是让 Key 只待在服务端，
 *   客户端只调用你自己的一个地址。本文件就是那个服务端，可部署到：
 *     · Cloudflare Workers / Pages Functions（推荐，免费额度够用）
 *     · Deno Deploy / Vercel Edge / Netlify Edge
 *     · 任意 VPS（node server/index.mjs）
 *
 * 接口：
 *   GET  /health                 → { ok, providers:[...] }
 *   POST /api/extract            → { image, prompt } → { text, provider }
 *
 * 环境变量（至少配一个供应商）：
 *   ZHIPU_API_KEY       智谱 GLM-4V-Flash（免费额度）
 *   SILICONFLOW_API_KEY 硅基流动 Qwen2.5-VL（免费额度）
 *   OPENROUTER_API_KEY  OpenRouter（有免费模型）
 *   DASHSCOPE_API_KEY   阿里百炼
 *   CUSTOM_BASE_URL / CUSTOM_API_KEY / CUSTOM_MODEL   任意 OpenAI 兼容端点
 *   PROXY_TOKEN         可选。设置后客户端必须带 x-proxy-token，防止被别人白嫖
 *   RATE_LIMIT_PER_HOUR 可选，默认 20（按 IP 限流）
 * ==========================================================================*/

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'POST, GET, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type, x-proxy-token',
  'Access-Control-Max-Age': '86400',
};

const json = (obj, status = 200) =>
  new Response(JSON.stringify(obj), {
    status,
    headers: { 'Content-Type': 'application/json; charset=utf-8', ...CORS },
  });

/* ---------------------------- 供应商定义 ---------------------------- */
function providerList(env) {
  const out = [];
  if (env.ZHIPU_API_KEY) {
    out.push({
      id: 'zhipu', label: '智谱 GLM-4V-Flash',
      url: 'https://open.bigmodel.cn/api/paas/v4/chat/completions',
      key: env.ZHIPU_API_KEY, model: env.ZHIPU_MODEL || 'glm-4v-flash',
    });
  }
  if (env.SILICONFLOW_API_KEY) {
    out.push({
      id: 'siliconflow', label: '硅基流动 Qwen2.5-VL',
      url: 'https://api.siliconflow.cn/v1/chat/completions',
      key: env.SILICONFLOW_API_KEY, model: env.SILICONFLOW_MODEL || 'Qwen/Qwen2.5-VL-32B-Instruct',
    });
  }
  if (env.OPENROUTER_API_KEY) {
    out.push({
      id: 'openrouter', label: 'OpenRouter',
      url: 'https://openrouter.ai/api/v1/chat/completions',
      key: env.OPENROUTER_API_KEY, model: env.OPENROUTER_MODEL || 'google/gemini-2.0-flash-exp:free',
    });
  }
  if (env.DASHSCOPE_API_KEY) {
    out.push({
      id: 'dashscope', label: '阿里百炼',
      url: 'https://dashscope.aliyuncs.com/compatible-mode/v1/chat/completions',
      key: env.DASHSCOPE_API_KEY, model: env.DASHSCOPE_MODEL || 'qwen-vl-plus',
    });
  }
  if (env.CUSTOM_BASE_URL && env.CUSTOM_API_KEY) {
    out.push({
      id: 'custom', label: '自定义端点',
      url: env.CUSTOM_BASE_URL, key: env.CUSTOM_API_KEY, model: env.CUSTOM_MODEL || 'gpt-4o-mini',
    });
  }
  return out;
}

/* ---------------------------- 简易限流（内存，够单实例用） ---------------------------- */
const hits = new Map();
function rateLimited(ip, perHour) {
  const now = Date.now();
  const win = 3600_000;
  const arr = (hits.get(ip) || []).filter((t) => now - t < win);
  if (arr.length >= perHour) return true;
  arr.push(now);
  hits.set(ip, arr);
  if (hits.size > 5000) hits.clear();          // 防内存膨胀
  return false;
}

/* ---------------------------- 主处理 ---------------------------- */
export async function handle(request, env = {}) {
  if (request.method === 'OPTIONS') return new Response(null, { status: 204, headers: CORS });

  const url = new URL(request.url);

  if (url.pathname === '/health') {
    const ps = providerList(env);
    return json({ ok: true, providers: ps.map((p) => ({ id: p.id, label: p.label, model: p.model })) });
  }

  if (url.pathname !== '/api/extract') return json({ error: 'not found' }, 404);
  if (request.method !== 'POST') return json({ error: 'POST only' }, 405);

  // 可选令牌校验
  if (env.PROXY_TOKEN && request.headers.get('x-proxy-token') !== env.PROXY_TOKEN) {
    return json({ error: '令牌无效' }, 401);
  }

  // 限流
  const ip = request.headers.get('cf-connecting-ip')
    || request.headers.get('x-real-ip')
    || (request.headers.get('x-forwarded-for') || '').split(',')[0].trim()
    || 'unknown';
  const perHour = Number(env.RATE_LIMIT_PER_HOUR || 20);
  if (rateLimited(ip, perHour)) {
    return json({ error: `请求过于频繁（每小时上限 ${perHour} 次），请稍后再试` }, 429);
  }

  let body;
  try { body = await request.json(); } catch { return json({ error: '请求体不是 JSON' }, 400); }
  const { image, prompt } = body || {};
  if (typeof image !== 'string' || !image.startsWith('data:image/')) {
    return json({ error: 'image 必须是 data:image/... 的 base64' }, 400);
  }
  if (image.length > 12 * 1024 * 1024) return json({ error: '图片太大（>9MB）' }, 413);
  if (typeof prompt !== 'string' || !prompt.trim()) return json({ error: '缺少 prompt' }, 400);

  const providers = providerList(env);
  if (!providers.length) {
    return json({
      error: '服务端没有配置任何识别通道。请设置 ZHIPU_API_KEY / SILICONFLOW_API_KEY / OPENROUTER_API_KEY '
        + '之一后重新部署（见 docs/AI通道部署.md）。',
    }, 503);
  }

  const errors = [];
  for (const p of providers) {
    try {
      const text = await callProvider(p, image, prompt);
      return json({ text, provider: p.id, label: p.label });
    } catch (e) {
      errors.push(`${p.label}: ${e.message}`);
    }
  }
  return json({ error: '所有通道都失败了：' + errors.join(' | ') }, 502);
}

async function callProvider(p, image, prompt, timeoutMs = 100000) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const res = await fetch(p.url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${p.key}` },
      body: JSON.stringify({
        model: p.model,
        temperature: 0,
        max_tokens: 8000,
        messages: [{
          role: 'user',
          content: [
            { type: 'text', text: prompt },
            { type: 'image_url', image_url: { url: image } },
          ],
        }],
      }),
      signal: ctrl.signal,
    });
    if (!res.ok) {
      const t = await res.text().catch(() => '');
      throw new Error(`HTTP ${res.status} ${t.slice(0, 200)}`);
    }
    const j = await res.json();
    const c = j?.choices?.[0]?.message?.content;
    if (typeof c === 'string' && c.trim()) return c;
    if (Array.isArray(c)) {
      const s = c.map((x) => x?.text || '').join('');
      if (s.trim()) return s;
    }
    throw new Error('返回体里没有 content');
  } finally {
    clearTimeout(timer);
  }
}

/* ---------------------------- 各平台入口适配 ---------------------------- */
export default {
  // Cloudflare Workers / Deno Deploy（模块默认导出）
  async fetch(request, env) { return handle(request, env); },
};
