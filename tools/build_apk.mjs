#!/usr/bin/env node
/* ============================================================================
 * tools/build_apk.mjs — 直接用 Android SDK 工具链出 APK（不需要 Gradle）
 *
 * 流程：aapt2 compile → aapt2 link → javac → d8 → 打包 → zipalign → apksigner
 * 优点：完全离线（工具都在 SDK 里）、几十秒出包、不拉 Gradle 发行版与 AGP 依赖。
 * 代价：只适合「极简原生工程」。要接第三方库/多模块，请用 android/ 里的
 *       Gradle 工程（见 docs/打包APK.md）。
 *
 * 用法：
 *   node tools/build_apk.mjs                  # debug 包（自动生成调试签名）
 *   node tools/build_apk.mjs --release        # release 包（需 KEYSTORE_* 环境变量）
 *
 * 环境变量（可选）：
 *   ANDROID_SDK_ROOT / ANDROID_HOME   覆盖 SDK 路径
 *   JAVA_HOME                         覆盖 JDK（需 17+）
 *   BC_AI_ENDPOINT                    内嵌 AI 通道地址，构建时注入网页
 * ==========================================================================*/
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import zlib from 'node:zlib';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(__dirname, '..');
const ANDROID = path.join(ROOT, 'android');
const APP = path.join(ANDROID, 'app');
const SRC_MAIN = path.join(APP, 'src', 'main');

const RELEASE = process.argv.includes('--release');
const log = (...a) => console.log('  ', ...a);
const step = (n, t) => console.log(`\n[${n}] ${t}`);

/* ---------------------------- 定位工具链 ---------------------------- */
function findSdk() {
  const cands = [
    process.env.ANDROID_SDK_ROOT, process.env.ANDROID_HOME,
    'D:/android-sdk', 'C:/Android/Sdk',
    path.join(process.env.LOCALAPPDATA || '', 'Android/Sdk'),
  ].filter(Boolean);
  for (const c of cands) {
    if (fs.existsSync(path.join(c, 'build-tools')) && fs.existsSync(path.join(c, 'platforms'))) return c;
  }
  throw new Error('找不到 Android SDK，请设置 ANDROID_SDK_ROOT');
}
const SDK = findSdk();
const BT = (() => {
  const dir = path.join(SDK, 'build-tools');
  const vers = fs.readdirSync(dir).filter((v) => /^\d+\.\d+\.\d+$/.test(v)).sort((a, b) => {
    const pa = a.split('.').map(Number), pb = b.split('.').map(Number);
    return pb[0] - pa[0] || pb[1] - pa[1] || pb[2] - pa[2];
  });
  return path.join(dir, vers[0]);
})();
const PLATFORM = (() => {
  const dir = path.join(SDK, 'platforms');
  const vers = fs.readdirSync(dir).filter((v) => /^android-\d+$/.test(v))
    .sort((a, b) => Number(b.split('-')[1]) - Number(a.split('-')[1]));
  return path.join(dir, vers[0]);
})();
/** 找 JDK 17+：环境变量优先，但必须真的支持 --release 17（别拿 JDK8 顶上） */
const JDK = (() => {
  const cands = [
    process.env.JAVA_HOME, 'D:/java/java17', 'D:/java/java21', 'D:/java/jdk17',
    'C:/Program Files/Java/jdk-17', 'C:/Program Files/Java/jdk-21',
    'C:/Program Files/Eclipse Adoptium/jdk-17',
  ].filter(Boolean);
  for (const c of cands) {
    const javac = path.join(c, 'bin', 'javac.exe');
    if (!fs.existsSync(javac)) continue;
    try {
      const v = execFileSync(javac, ['-version'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
      const m = String(v).match(/(\d+)/);
      if (m && Number(m[1]) >= 17) return c;
    } catch { /* 换下一个 */ }
  }
  throw new Error('找不到 JDK 17+（需要 --release 17 支持），请设置 JAVA_HOME 指向 JDK 17/21');
})();

const T = (name) => path.join(BT, name);
const JAVA = (name) => path.join(JDK, 'bin', name);
const exe = process.platform === 'win32' ? '.exe' : '';
const bat = process.platform === 'win32' ? '.bat' : '';

const LOG = [];
/** 把选定 JDK 的 bin 放到 PATH 最前面：
 *  d8.bat / apksigner.bat 内部要调 java，若 PATH 上是旧 JDK 会静默失败。 */
const CHILD_ENV = {
  ...process.env,
  JAVA_HOME: JDK,
  PATH: `${path.join(JDK, 'bin')}${path.delimiter}${process.env.PATH || ''}`,
  ANDROID_SDK_ROOT: SDK,
  ANDROID_HOME: SDK,
};
function run(cmd, args, opts = {}) {
  const line = `${path.basename(cmd)} ${args.join(' ')}`;
  LOG.push(line);
  try {
    const out = execFileSync(cmd, args, {
      encoding: 'utf8', maxBuffer: 64 * 1024 * 1024,
      stdio: ['ignore', 'pipe', 'pipe'], env: CHILD_ENV, ...opts,
    });
    return out;
  } catch (e) {
    console.error(`\n✗ 命令失败：${line}`);
    if (e.stdout) console.error(String(e.stdout).slice(-2500));
    if (e.stderr) console.error(String(e.stderr).slice(-2500));
    throw new Error(`构建中止：${path.basename(cmd)}`);
  }
}

console.log('=== 构建 APK（无 Gradle 直构建）===');
log('SDK      ', SDK);
log('build-tools', path.basename(BT));
log('platform ', path.basename(PLATFORM));
log('JDK      ', JDK);
log('模式     ', RELEASE ? 'release' : 'debug');

const WORK = fs.mkdtempSync(path.join(os.tmpdir(), 'bc-apk-'));
const OUT = path.join(ROOT, 'out');
fs.mkdirSync(OUT, { recursive: true });

/** 重写 zip：store(name) 返回 true 的条目用「不压缩」写入，其余用 deflate。
 *  纯手写 ZIP 结构（本地文件头 + 中央目录 + EOCD），不引第三方库。 */
function rebuildZip(srcApk, dstApk, store) {
  const buf = fs.readFileSync(srcApk);
  const sig = Buffer.from([0x50, 0x4b, 0x03, 0x04]);       // PK\x03\x04
  const cen = Buffer.from([0x50, 0x4b, 0x01, 0x02]);       // central directory

  // 先扫描本地文件头，拿到原始数据（stored 或 deflated）
  const entries = [];
  let p = 0;
  while (p + 30 <= buf.length && buf.compare(sig, 0, 4, p, p + 4) === 0) {
    const method = buf.readUInt16LE(p + 8);
    const crc = buf.readUInt32LE(p + 14);
    const csize = buf.readUInt32LE(p + 18);
    const usize = buf.readUInt32LE(p + 22);
    const nlen = buf.readUInt16LE(p + 26);
    const elen = buf.readUInt16LE(p + 28);
    const name = buf.slice(p + 30, p + 30 + nlen).toString('utf8');
    const dataStart = p + 30 + nlen + elen;
    const raw = buf.slice(dataStart, dataStart + csize);
    entries.push({ name, method, crc, usize, raw, data: method === 8 ? zlib.inflateRawSync(raw) : raw });
    p = dataStart + csize;
  }
  if (!entries.length) throw new Error('源 APK 没有可解析的 zip 条目');

  // 再写一遍
  const chunks = [];
  const central = [];
  let offset = 0;
  for (const e of entries) {
    const useStore = store(e.name);
    const data = e.data;
    const outData = useStore ? data : zlib.deflateRawSync(data, { level: 9 });
    const method = useStore ? 0 : 8;
    const nameBuf = Buffer.from(e.name, 'utf8');
    const lh = Buffer.alloc(30);
    lh.writeUInt32LE(0x04034b50, 0);
    lh.writeUInt16LE(20, 4);
    lh.writeUInt16LE(0, 6);
    lh.writeUInt16LE(method, 8);
    lh.writeUInt16LE(0, 10);      // time
    lh.writeUInt16LE(0x21, 12);   // date（固定值，保证可复现）
    lh.writeUInt32LE(e.crc, 14);
    lh.writeUInt32LE(outData.length, 18);
    lh.writeUInt32LE(data.length, 22);
    lh.writeUInt16LE(nameBuf.length, 26);
    lh.writeUInt16LE(0, 28);
    chunks.push(lh, nameBuf, outData);

    const ch = Buffer.alloc(46);
    ch.writeUInt32LE(0x02014b50, 0);
    ch.writeUInt16LE(20, 4);
    ch.writeUInt16LE(20, 6);
    ch.writeUInt16LE(0, 8);
    ch.writeUInt16LE(method, 10);
    ch.writeUInt16LE(0, 12);
    ch.writeUInt16LE(0x21, 14);
    ch.writeUInt32LE(e.crc, 16);
    ch.writeUInt32LE(outData.length, 20);
    ch.writeUInt32LE(data.length, 24);
    ch.writeUInt16LE(nameBuf.length, 28);
    ch.writeUInt16LE(0, 30);
    ch.writeUInt16LE(0, 32);
    ch.writeUInt16LE(0, 34);
    ch.writeUInt16LE(0, 36);
    ch.writeUInt32LE(0, 38);
    ch.writeUInt32LE(offset, 42);
    central.push(ch, nameBuf);

    offset += lh.length + nameBuf.length + outData.length;
  }
  const centralBuf = Buffer.concat(central);
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(0, 4);
  eocd.writeUInt16LE(0, 6);
  eocd.writeUInt16LE(entries.length, 8);
  eocd.writeUInt16LE(entries.length, 10);
  eocd.writeUInt32LE(centralBuf.length, 12);
  eocd.writeUInt32LE(offset, 16);
  eocd.writeUInt16LE(0, 20);

  fs.writeFileSync(dstApk, Buffer.concat([...chunks, centralBuf, eocd]));
}

try {
  /* ---------------- 0) 网页资源 ---------------- */
  step(0, '打包网页并放入 assets/');
  run(process.execPath, [path.join(ROOT, 'build.mjs')], {
    env: { ...process.env, BC_AI_ENDPOINT: process.env.BC_AI_ENDPOINT || '' },
    cwd: ROOT,
  });
  const assetHtml = path.join(SRC_MAIN, 'assets', 'index.html');
  if (!fs.existsSync(assetHtml)) throw new Error('assets/index.html 没生成');
  log('assets/index.html', `${(fs.statSync(assetHtml).size / 1024).toFixed(1)} KB`);

  /* ---------------- 1) 资源编译 ---------------- */
  step(1, 'aapt2 compile 资源');
  const resZip = path.join(WORK, 'res.zip');
  run(T('aapt2.exe'), ['compile', '--dir', path.join(SRC_MAIN, 'res'), '-o', resZip]);
  log('res.zip', `${(fs.statSync(resZip).size / 1024).toFixed(1)} KB`);

  /* ---------------- 2) 资源链接 ---------------- */
  step(2, 'aapt2 link 生成基础 APK');
  const baseApk = path.join(WORK, 'base.apk');
  const manifest = path.join(SRC_MAIN, 'AndroidManifest.xml');
  run(T('aapt2.exe'), [
    'link',
    '-o', baseApk,
    '-I', path.join(PLATFORM, 'android.jar'),
    '--manifest', manifest,
    '--java', path.join(WORK, 'gen'),
    '--min-sdk-version', '24',
    '--target-sdk-version', '35',
    '--version-code', '1',
    '--version-name', '1.0.0',
    '--no-version-vectors',
    'res.zip',
  ], { cwd: WORK });
  log('base.apk', `${(fs.statSync(baseApk).size / 1024).toFixed(1)} KB`);

  /* ---------------- 3) 编译 Java ---------------- */
  step(3, 'javac 编译 Java 源码');
  const javaSrc = path.join(SRC_MAIN, 'java');
  const javaFiles = [];
  (function walk(d) {
    for (const f of fs.readdirSync(d)) {
      const p = path.join(d, f);
      if (fs.statSync(p).isDirectory()) walk(p);
      else if (p.endsWith('.java')) javaFiles.push(p);
    }
  })(javaSrc);
  const classesDir = path.join(WORK, 'classes');
  fs.mkdirSync(classesDir, { recursive: true });
  run(JAVA('javac.exe'), [
    '-encoding', 'UTF-8',
    '--release', '17',      // JDK 9+ 不再允许 -bootclasspath 与 -source/-target 同用
    '-nowarn',
    '-classpath', path.join(PLATFORM, 'android.jar'),
    '-d', classesDir,
    ...javaFiles,
  ]);
  log('编译类数', String(javaFiles.length));

  /* ---------------- 4) dex ---------------- */
  step(4, 'd8 转 DEX');
  const dexDir = path.join(WORK, 'dex');
  fs.mkdirSync(dexDir, { recursive: true });
  const classList = [];
  (function walk(d) {
    for (const f of fs.readdirSync(d)) {
      const p = path.join(d, f);
      if (fs.statSync(p).isDirectory()) walk(p);
      else if (p.endsWith('.class')) classList.push(p);
    }
  })(classesDir);
  // 直接调 d8.jar，绕开 d8.bat（批处理在受限环境下会吞掉输出）
  run(JAVA('java.exe'), [
    '-cp', path.join(BT, 'lib', 'd8.jar'),
    'com.android.tools.r8.D8',
    '--min-api', '24',
    '--output', dexDir,
    '--lib', path.join(PLATFORM, 'android.jar'),
    ...classList,
  ]);
  const dexFile = path.join(dexDir, 'classes.dex');
  if (!fs.existsSync(dexFile)) throw new Error('d8 没有产出 classes.dex');
  log('classes.dex', `${(fs.statSync(dexFile).size / 1024).toFixed(1)} KB`);

  /* ---------------- 5) 合成未签名 APK ---------------- */
  step(5, '合成未签名 APK');
  const unsigned = path.join(WORK, 'unsigned.apk');
  fs.copyFileSync(baseApk, unsigned);
  run(JAVA('jar.exe'), ['uf', unsigned, '-C', dexDir, 'classes.dex']);
  run(JAVA('jar.exe'), ['uf', unsigned, '-C', path.join(SRC_MAIN), 'assets']);
  log('unsigned.apk', `${(fs.statSync(unsigned).size / 1024).toFixed(1)} KB（含 assets 与 classes.dex）`);

  /* 关于 assets/index.html 的压缩：
     APK 里用 Deflate 存储完全没问题（WebView 读 assets 时会解压，124KB 无明显开销）。
     试过手写 zip 重打包改成 Store，风险大于收益（jar 写的是 data descriptor，
     手写解析容易出错），所以这里保持 aapt2/jar 的默认行为。 */

  /* ---------------- 6) 签名 ---------------- */
  step(6, 'zipalign + 签名');
  const aligned = path.join(WORK, 'aligned.apk');
  run(T('zipalign.exe'), ['-f', '-p', '4', unsigned, aligned]);

  let keystore, ksPass, ksAlias, keyPass;
  if (RELEASE && process.env.KEYSTORE_PATH) {
    keystore = process.env.KEYSTORE_PATH;
    ksPass = process.env.KEYSTORE_PASSWORD || '';
    ksAlias = process.env.KEY_ALIAS || '';
    keyPass = process.env.KEY_PASSWORD || ksPass;
  } else {
    keystore = path.join(ROOT, 'android', 'debug.keystore');
    ksPass = 'android'; ksAlias = 'androiddebugkey'; keyPass = 'android';
    if (!fs.existsSync(keystore)) {
      log('生成调试签名 (android/debug.keystore)');
      run(JAVA('keytool.exe'), [
        '-genkeypair', '-v',
        '-keystore', keystore,
        '-alias', ksAlias,
        '-keyalg', 'RSA', '-keysize', '2048', '-validity', '10950',
        '-storepass', ksPass, '-keypass', keyPass,
        '-dname', 'CN=Android Debug,O=Android,C=US',
      ]);
    }
  }

  const name = RELEASE ? 'kebiao-release.apk' : 'kebiao-debug.apk';
  const finalApk = path.join(OUT, name);
  // 同样直接调 apksigner.jar，避开 .bat 包装
  run(JAVA('java.exe'), [
    '-jar', path.join(BT, 'lib', 'apksigner.jar'),
    'sign',
    '--ks', keystore,
    '--ks-pass', `pass:${ksPass}`,
    '--ks-key-alias', ksAlias,
    '--key-pass', `pass:${keyPass}`,
    '--min-sdk-version', '24',
    '--out', finalApk,
    aligned,
  ]);
  run(JAVA('java.exe'), [
    '-jar', path.join(BT, 'lib', 'apksigner.jar'),
    'verify', '--print-certs', finalApk,
  ]);

  /* ---------------- 7) 体检 ---------------- */
  step(7, '产物检查');
  const size = fs.statSync(finalApk).size;
  const badging = run(T('aapt.exe'), ['dump', 'badging', finalApk]);
  const line = (re) => (badging.split('\n').find((l) => re.test(l)) || '').trim();
  console.log('\n=== 构建成功 ===');
  console.log(`  APK      : ${finalApk}`);
  console.log(`  大小     : ${(size / 1024 / 1024).toFixed(2)} MB`);
  console.log(`  ${line(/^package:/)}`);
  console.log(`  ${line(/^sdkVersion/)}`);
  console.log(`  ${line(/^targetSdkVersion/)}`);
  console.log(`  ${line(/^application-label/)}`);
  console.log(`  launchable: ${line(/^launchable-activity/).replace('launchable-activity: ', '')}`);
  console.log('\n装到手机：');
  console.log(`  ${path.join(SDK, 'platform-tools', 'adb.exe')} install -r "${finalApk}"`);
} finally {
  try { fs.rmSync(WORK, { recursive: true, force: true }); } catch {}
}
