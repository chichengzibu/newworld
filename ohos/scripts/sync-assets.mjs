#!/usr/bin/env node
/**
 * New World - 把 vite / vite-plugin-electron 产物同步进鸿蒙 HAP 壳工程
 *
 * 输入(需先执行 `vite build`):
 *   dist/                  渲染进程产物(vite base:'./',HAP 内相对路径不白屏)
 *   dist-electron/         主进程 main.js + preload.js(CJS)+ mcp/bin/*.mjs
 *
 * 输出(默认):
 *   ohos/entry/assets/app/package.json      Electron 应用清单
 *   ohos/entry/assets/app/dist/
 *   ohos/entry/assets/app/dist-electron/
 *
 * 输出目录可用环境变量覆盖:
 *   NW_OHOS_ASSET_DIR=ohos/entry/src/main/resources/rawfile/app
 *
 * 说明:任务书要求「dist/ + dist-electron/preload.js」,这里同步的是整个
 * dist-electron/ —— 因为 dist-electron/main.js 才是 Electron 主进程入口
 * (根 package.json 的 "main" 即指向它),只拷 preload 应用无法启动。
 */

import { existsSync, mkdirSync, rmSync, cpSync, readFileSync, writeFileSync, statSync, readdirSync } from 'node:fs';
import { join, resolve, dirname, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(__dirname, '..', '..'); // 仓库根目录

const DIST = join(ROOT, 'dist');
const DIST_ELECTRON = join(ROOT, 'dist-electron');

const OUT_APP = process.env.NW_OHOS_ASSET_DIR
  ? resolve(ROOT, process.env.NW_OHOS_ASSET_DIR)
  : join(ROOT, 'ohos', 'entry', 'assets', 'app');

function log(msg) {
  console.log(`[ohos:sync] ${msg}`);
}

function fail(msg) {
  console.error(`[ohos:sync] 错误: ${msg}`);
  process.exit(1);
}

function dirSize(dir) {
  let total = 0;
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    const st = statSync(p);
    total += st.isDirectory() ? dirSize(p) : st.size;
  }
  return total;
}

// ---- 1. 校验前置产物 ----
if (!existsSync(DIST)) {
  fail(`未找到 ${relative(ROOT, DIST)}/,请先执行 \`npm run build\` 或 \`vite build\``);
}
if (!existsSync(DIST_ELECTRON)) {
  fail(`未找到 ${relative(ROOT, DIST_ELECTRON)}/,请先执行 \`vite build\`(vite-plugin-electron 产出)`);
}
for (const required of ['main.js', 'preload.js']) {
  if (!existsSync(join(DIST_ELECTRON, required))) {
    fail(`缺少 dist-electron/${required}`);
  }
}
if (!existsSync(join(DIST, 'index.html'))) {
  fail('缺少 dist/index.html');
}

// preload 必须是 CJS —— 鸿蒙 runtime 下 ESM preload 会崩(见跨平台方案 §4.2)
const preloadHead = readFileSync(join(DIST_ELECTRON, 'preload.js'), 'utf-8').slice(0, 4096);
if (/^\s*import\s|^\s*export\s/m.test(preloadHead) && !/require\(/.test(preloadHead)) {
  fail('dist-electron/preload.js 疑似 ESM 产物,鸿蒙 runtime 要求 CJS(应含 require)');
}
log('preload.js 格式检查通过(CJS)');

// ---- 2. 清理并复制 ----
if (existsSync(OUT_APP)) {
  rmSync(OUT_APP, { recursive: true, force: true });
}
mkdirSync(OUT_APP, { recursive: true });

cpSync(DIST, join(OUT_APP, 'dist'), { recursive: true });
log(`dist/ → ${relative(ROOT, join(OUT_APP, 'dist'))}`);

cpSync(DIST_ELECTRON, join(OUT_APP, 'dist-electron'), { recursive: true });
log(`dist-electron/ → ${relative(ROOT, join(OUT_APP, 'dist-electron'))}`);

// ---- 3. 生成 Electron 应用清单 ----
// runtime 若按 Node 约定从 app 根读 package.json 定位入口,此文件即为依据;
// 同时它也是 HarmonyHost.getAppPath() 指向的目录(NW_APP_PATH)。
const rootPkg = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf-8'));
const appManifest = {
  name: rootPkg.name,
  version: rootPkg.version,
  description: rootPkg.description,
  main: 'dist-electron/main.js',
  author: rootPkg.author,
  license: rootPkg.license,
  // 提示 runtime 注入的环境变量(electron/platform/detect.ts 读取)
  newworld: {
    platform: 'ohos',
    renderer: 'dist/index.html',
    preload: 'dist-electron/preload.js',
    // TODO(需官方 OHOS Electron runtime 确认):
    // runtime 是否读取本字段未知,仅作为壳工程与主进程之间的约定记录。
    requiredEnv: ['NW_PLATFORM', 'NW_APP_PATH', 'NW_USER_DATA', 'NW_VERSION'],
  },
};
writeFileSync(join(OUT_APP, 'package.json'), `${JSON.stringify(appManifest, null, 2)}\n`, 'utf-8');
log(`已生成 ${relative(ROOT, join(OUT_APP, 'package.json'))}(main=dist-electron/main.js)`);

const mb = (dirSize(OUT_APP) / 1024 / 1024).toFixed(2);
log(`同步完成,共 ${mb} MB → ${relative(ROOT, OUT_APP)}`);

// TODO(需官方 OHOS Electron runtime 确认):
//   本脚本只做到「把 app 资源摆到壳工程里」。资源如何进入 HAP(rawfile 解压
//   / 官方 hvigor 插件声明 / runtime 直读)取决于官方 runtime 约定,
//   确认后可能需要把 OUT_APP 默认值改为 entry/src/main/resources/rawfile/app。
