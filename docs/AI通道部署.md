# 让用户「零配置」用上 AI 识别

## 为什么不能把 Key 写进 App

如果你把智谱/OpenRouter 的 Key 直接打进 APK：

- 任何人反编译 APK 或打开开发者工具就能拿到它；
- 拿到之后可以拿去刷别的模型、别的额度；
- 免费额度被刷完，所有用户一起失效。

**正确做法**：Key 只放在服务端，App 只请求你自己的一个地址。仓库里的
`server/index.mjs` 就是这一层，几十行、零依赖。

```
APK / 网页  ──POST 图片──►  你的代理（持 Key）  ──►  智谱 / 硅基流动 / OpenRouter
   ↑ 用户零配置                                              ↑ Key 只在这里
```

---

## 第 1 步：拿一个免费的视觉模型 Key（选一个就够）

| 供应商 | 免费额度 | 申请地址 | 备注 |
|---|---|---|---|
| **智谱 GLM-4V-Flash** | 有，且长期免费 | open.bigmodel.cn | 中文课表识别效果不错，推荐首选 |
| **硅基流动** | 新用户送额度 | siliconflow.cn | Qwen2.5-VL 系列 |
| **OpenRouter** | 有 `:free` 模型 | openrouter.ai | 海外，可能需要网络条件 |

拿到 Key 后先别写进代码，下一步配成环境变量。

---

## 第 2 步：部署代理

### 方案 A：Cloudflare Workers（推荐，免费额度足够个人/小范围使用）

1. 注册 Cloudflare → 进入 **Workers & Pages** → **Create** → **Worker**。
2. 把 `server/index.mjs` 的内容整段粘进编辑器（把 `export default { async fetch(...) }`
   那个块保留，它就是这个平台的入口）。
3. 在 **Settings → Variables and Secrets** 里加变量（Secret 类型）：
   - `ZHIPU_API_KEY` = 你的 Key
   - 可选：`RATE_LIMIT_PER_HOUR` = `20`
   - 可选：`PROXY_TOKEN` = 一串随机字符串（见下方「防盗刷」）
4. Deploy，拿到地址形如 `https://better-class-ai.你的账号.workers.dev`。

验证：

```bash
curl https://你的地址.workers.dev/health
# → {"ok":true,"providers":[{"id":"zhipu","label":"智谱 GLM-4V-Flash","model":"glm-4v-flash"}]}
```

### 方案 B：本机/VPS 跑 Node（最省事，适合自用）

```bash
cd better-class
ZHIPU_API_KEY=你的key node -e "
  import('./server/index.mjs').then(m => {
    const http = require('http');
    http.createServer((req,res)=>m.handle(req,{...process.env})).listen(8787);
    console.log('代理已启动 http://127.0.0.1:8787');
  })
"
```

（`server/index.mjs` 的 `handle()` 就是标准 `(Request) → Response`，
任何支持 Fetch API 的运行时都能直接接。）

### 方案 C：Vercel / Deno Deploy

把 `server/index.mjs` 放到 `api/extract.js`（Vercel）或直接作为 Deno 入口，
环境变量同样用上面的名字即可——`handle()` 用的是标准 Web API，不需要改代码。

---

## 第 3 步：把地址内嵌进 App

构建时注入（**推荐**，用户什么都不用填）：

```bash
BC_AI_ENDPOINT=https://你的地址.workers.dev node build.mjs
# 于是 apk/www/index.html 里会多一行：
#   <script>window.__BC_AI_ENDPOINT="https://…";</script>
```

然后正常打包 APK（见 `docs/打包APK.md`）。装到手机后打开 App →「导入课表」→
「截图识别」，**直接就能识别，不需要用户填任何 Key**。

没用构建变量的话，用户也可以在 App 内「设置 → 识别通道 → 自定义端点」里自己填地址。

---

## 防盗刷（可选但建议）

代理暴露在公网后，别人知道地址也能调。三层防护，按需要开：

1. **限流**（默认已开）：`RATE_LIMIT_PER_HOUR=20`，按 IP 每小时 20 次。
2. **共享令牌**：设 `PROXY_TOKEN=随机串`，构建时同时注入令牌：
   ```bash
   BC_AI_ENDPOINT=https://… BC_AI_TOKEN=随机串 node build.mjs
   ```
   （如需启用，`src/extractor.js` 的 `callBuiltin()` 里加一个
   `'x-proxy-token': window.__BC_AI_TOKEN` 请求头即可。）
3. **只允许图片请求**：代理已经校验 `image` 必须是 `data:image/*` 且小于 9MB。

> 老实说：只要客户端能拿到地址，就没有绝对安全的做法。真正兜底的是
> **免费额度 + 限流**，以及「粘贴文本」这条不花任何额度的通道。

---

## 成本与体验的取舍

| 通道 | 是否需要部署 | 用户操作 | 准确率 | 花费 |
|---|---|---|---|---|
| 内置代理（本文档） | 需要（一次性） | 选图 → 点识别 | 高 | 免费额度内 0 |
| 用户自备 Key | 不需要 | 填 Key → 选图 | 高 | 用户自己的 |
| **粘贴文本** | **不需要** | 全选复制 → 粘贴 | **100%（规则解析）** | **0** |

再多说一句：**粘贴文本永远是保底方案，而且比 AI 更准**。AI 那条路解决的是
「只有截图、拿不到文本」的场景（比如同学转发来的企业微信截图）。
所以就算代理挂了、额度用完了，产品依然可用——这才是该有的设计。
