#!/usr/bin/env node
/**
 * PiPiClaw - 为鸿蒙 HAP 内的 Electron app 收集运行期 node_modules
 *
 * 背景:
 *   vite 以 ssr:true 构建主进程,node_modules 依赖默认被 external
 *   (`require("docx")` 等仍留在 dist-electron/main.js 里)。
 *   HAP 内的 app/ 目录没有 node_modules,启动时 require 会直接抛错。
 *
 * 本脚本从仓库根 node_modules 递归复制「运行期实际用到的包 + 其传递
 * dependencies」到 app/node_modules,不含 devDependencies、不联网。
 *
 * 用法:
 *   node ohos/scripts/collect-node-deps.mjs <appDir> [pkg...]
 * 缺省包列表取自对 dist-electron/main.js 的 require() 扫描结果。
 */

import { existsSync, mkdirSync, cpSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { builtinModules } from 'node:module';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(__dirname, '..', '..');
const ROOT_MODULES = join(ROOT, 'node_modules');

const BUILTIN = new Set([...builtinModules, ...builtinModules.map((m) => `node:${m}`)]);
// electron 由鸿蒙 runtime 原生提供,不能也不该复制
const PROVIDED_BY_RUNTIME = new Set(['electron']);

const appDir = process.argv[2];
if (!appDir) {
  console.error('[ohos:deps] 用法: node ohos/scripts/collect-node-deps.mjs <appDir> [pkg...]');
  process.exit(1);
}
const APP = resolve(ROOT, appDir);
const OUT_MODULES = join(APP, 'node_modules');

function log(msg) {
  console.log(`[ohos:deps] ${msg}`);
}

/** 从 bundle 里扫出所有 require 的裸包名 */
function scanRequires(file) {
  const src = readFileSync(file, 'utf-8');
  const names = new Set();
  for (const m of src.matchAll(/require\(\s*["']([^"'.][^"']*)["']\s*\)/g)) {
    const spec = m[1];
    if (BUILTIN.has(spec) || PROVIDED_BY_RUNTIME.has(spec)) continue;
    // 取包名(处理 @scope/name 与 pkg/sub/path)
    const parts = spec.split('/');
    names.add(spec.startsWith('@') ? parts.slice(0, 2).join('/') : parts[0]);
  }
  return [...names];
}

function readPkg(name) {
  const p = join(ROOT_MODULES, name, 'package.json');
  if (!existsSync(p)) return null;
  try {
    return JSON.parse(readFileSync(p, 'utf-8'));
  } catch {
    return null;
  }
}

/** 递归解析 dependencies 闭包 */
function resolveClosure(seeds) {
  const visited = new Set();
  const missing = new Set();
  const queue = [...seeds];
  while (queue.length) {
    const name = queue.shift();
    if (visited.has(name) || PROVIDED_BY_RUNTIME.has(name) || BUILTIN.has(name)) continue;
    const pkg = readPkg(name);
    if (!pkg) {
      missing.add(name);
      continue;
    }
    visited.add(name);
    for (const dep of Object.keys(pkg.dependencies ?? {})) {
      if (!visited.has(dep)) queue.push(dep);
    }
  }
  return { resolved: [...visited], missing: [...missing] };
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

// ---- 1. 确定种子包 ----
let seeds = process.argv.slice(3);
if (seeds.length === 0) {
  const mainJs = join(APP, 'dist-electron', 'main.js');
  if (!existsSync(mainJs)) {
    console.error(`[ohos:deps] 错误: 未找到 ${mainJs},请先执行 ohos/scripts/sync-assets.mjs`);
    process.exit(1);
  }
  seeds = scanRequires(mainJs);
  log(`从 main.js 扫出外部依赖: ${seeds.join(', ') || '(无)'}`);
}
if (seeds.length === 0) {
  log('无需收集任何 node_modules');
  process.exit(0);
}

// ---- 2. 解析闭包 ----
const { resolved, missing } = resolveClosure(seeds);
if (missing.length) {
  console.error(`[ohos:deps] 错误: 根 node_modules 缺少 ${missing.join(', ')},请先 npm install`);
  process.exit(1);
}
log(`依赖闭包共 ${resolved.length} 个包`);

// ---- 3. 复制 ----
mkdirSync(OUT_MODULES, { recursive: true });
for (const name of resolved) {
  cpSync(join(ROOT_MODULES, name), join(OUT_MODULES, name), {
    recursive: true,
    // .bin 软链在 HAP 内无意义,且 Windows 上复制符号链接易失败
    filter: (src) => !src.includes(`${OUT_MODULES}`) && !/[\\/]\.bin[\\/]/.test(src),
  });
}

const mb = (dirSize(OUT_MODULES) / 1024 / 1024).toFixed(2);
log(`已写入 ${resolved.length} 个包,共 ${mb} MB → ${OUT_MODULES}`);
