# 出 Android 安装包（APK）

两条路，任选：

| 方式 | 需要什么 | 耗时 | 适用 |
|---|---|---|---|
| **A. 直构建脚本**（推荐本机用） | Android SDK + JDK 17 | 约 20 秒 | 立刻拿到 APK 装手机 |
| **B. Gradle 工程**（推荐 CI/发布） | Gradle + AGP（GitHub Actions 自动装） | 首次约 5 分钟 | 长期维护、上架、签名发布 |

仓库里两者都备好了。

---

## A. 直构建脚本（不用 Gradle）

```bash
# 1) 准备工具链（一次性）
#    · JDK 17          → 设 JAVA_HOME
#    · Android SDK     → 设 ANDROID_SDK_ROOT（需 build-tools + platforms）
#    用命令行装 SDK：
#      sdkmanager "platform-tools" "platforms;android-35" "build-tools;35.0.1"

# 2) 出包
node tools/build_apk.mjs
#   → out/kebiao-debug.apk

# 3) 装到手机（USB 调试打开）
adb install -r out/kebiao-debug.apk
```

脚本内部做的事（透明可查）：

```
build.mjs               打包单文件网页 → android/app/src/main/assets/index.html
aapt2 compile           编译 res/（图标、strings、theme）
aapt2 link              生成基础 APK（含 AndroidManifest、resources.arsc）
javac --release 17      编译 MainActivity.java（classpath = android.jar）
d8 --min-api 24         转 classes.dex
jar uf                  把 classes.dex 与 assets 塞进 APK
zipalign -p 4           4 字节对齐
apksigner               debug 用自动生成的 android/debug.keystore 签名
```

想内嵌 AI 通道（用户零配置就能识别截图）：

```bash
BC_AI_ENDPOINT=https://你的代理地址 node tools/build_apk.mjs
```

---

## B. Gradle 工程（CI / 正式发布）

工程在 `android/`，标准 AGP 结构：

```bash
cd android
./gradlew assembleDebug        # → app/build/outputs/apk/debug/app-debug.apk
./gradlew assembleRelease      # 需签名配置
```

### 发布签名

```bash
keytool -genkeypair -v -keystore my-release.jks -keyalg RSA -keysize 2048 \
        -validity 10950 -alias mykey

export KEYSTORE_PATH=/abs/path/my-release.jks
export KEYSTORE_PASSWORD=xxx KEY_ALIAS=mykey KEY_PASSWORD=xxx
cd android && ./gradlew assembleRelease
```

`app/build.gradle.kts` 里已经写好：**只有提供了 `KEYSTORE_PATH` 才启用 release 签名**，
否则 release 包保持未签名（避免误把调试签名发出去）。

### GitHub Actions 自动出包

`.github/workflows/android.yml` 已经配好：

- 每次 push / PR → 构建 APK 并作为 **Artifact** 上传（在 Actions 页面下载）
- 打 `v*` 标签 → 自动创建 **Release** 并附上 APK（这个链接最适合分享给同学）

```bash
git tag v1.0.0 && git push origin v1.0.0
```

想让 CI 出的包也自带 AI 通道：仓库 **Settings → Secrets → Actions** 加
`BC_AI_ENDPOINT`，workflow 会自动注入。

---

## 体积与兼容性

| 项 | 值 |
|---|---|
| debug APK | 约 60 KB |
| minSdk | 24（Android 7.0） |
| targetSdk / compileSdk | 35 |
| 运行期网络 | 0（不点「截图识别」就不联网） |
| 权限 | 只有 `INTERNET` |
| 数据 | 全部在本机 WebView 的 localStorage，卸载即清 |

APK 这么小是因为**没有打包任何原生依赖**：界面全是网页，外壳只是一个 WebView +
文件选择回调。

---

## 常见问题

**装不上 / 提示「已存在签名不同的应用」**
卸载旧的再装，或改 `applicationId`（debug 包已自动加 `.debug` 后缀，可与正式包共存）。

**打开是白屏**
说明 `assets/index.html` 没打进去。检查 `android/app/src/main/assets/index.html` 是否存在，
然后重新 `node tools/build_apk.mjs`。

**识别按钮报错**
说明没配 AI 通道。两条出路：自部署代理（见 `docs/AI通道部署.md`），
或者改用「粘贴文本」导入（不花额度、且更准）。

**想改应用名/图标**
- 名字：`android/app/src/main/res/values/strings.xml`
- 图标：`android/app/src/main/res/drawable/ic_launcher_*.xml`（矢量，自适应图标）
        与 `mipmap-*`（位图兜底，`powershell -File tools/make_icons.ps1` 可重生成）
