# 上传到 GitHub

仓库内容已经整理好（`.gitignore`、`LICENSE`、CI workflow 都在），只差推送。
下面两种情况，挑一个。

---

## 情况一：你还没登录 gh（当前机器就是这个状态）

我这边执行 `gh auth status` 的结果是 **未登录**。你需要先登录一次：

```bash
gh auth login
# 选 GitHub.com → HTTPS → 用浏览器登录（或粘贴 Personal Access Token）
```

登录完告诉我，我就直接建仓库并推送。

**或者**你自己三步推完：

```bash
cd better-class
git init -b main
git add -A
git commit -m "feat: 课表 · 一张截图生成可视化课表（Web + Android）"
gh repo create better-class --public --source=. --push
```

没有 gh 也能推——先在网页上建个空仓库，然后：

```bash
git remote add origin https://github.com/你的用户名/better-class.git
git push -u origin main
```

---

## 情况二：已经有仓库了

```bash
git init -b main            # 如果还没 init
git add -A
git commit -m "feat: 课表工具"
git remote add origin https://github.com/你的用户名/仓库名.git
git push -u origin main
```

---

## 推上去之后会自动发生什么

`main` 分支一推上去，Actions 就开始跑（`.github/workflows/android.yml`）：

1. `node tests/parser.test.mjs` —— 解析器 29 条单测
2. `node build.mjs` —— 打包单文件网页
3. `./gradlew assembleDebug` —— 构建 APK
4. 把 APK 作为 Artifact 上传

在仓库的 **Actions** 页面能直接下载 `kebiao-apk`。

想发一个「长期可下载」的版本，打个标签：

```bash
git tag v1.0.0
git push origin v1.0.0
```

→ 自动创建 Release，APK 挂在 Release 附件里，这个链接最适合发给同学。

---

## 推之前建议确认的几件事

| 项 | 说明 |
|---|---|
| **不要提交密钥** | `.gitignore` 已排除 `.env`/`*.jks`/`*.keystore`/`local.properties`；API Key 只通过仓库 Secrets 传 |
| `android/local.properties` | 里面是本机 SDK 路径，已被忽略；CI 上由 workflow 自己配 |
| `docs/*.png` | 验证截图默认被忽略（避免仓库变胖）；想保留就删掉 `.gitignore` 里那两行 |
| 图片素材 | 根目录那两张课表截图**没有**纳入版本控制，不会上传 |

## 配 AI 密钥（可选，但推荐）

仓库 **Settings → Secrets and variables → Actions → New repository secret**：

- `BC_AI_ENDPOINT` = 你部署的识别代理地址（见 `docs/AI通道部署.md`）

配上之后，CI 构建出的 APK **自带识别能力**，用户装上就能用，不需要填任何 Key。
没配也不影响：用户还能走「粘贴文本」导入。

> 注意：这个 Secret 只是构建期变量，会被写进网页（本来就是公开的客户端地址），
> **千万不要**把真正的 API Key 放进 `BC_AI_ENDPOINT`，Key 只能待在代理服务端。
