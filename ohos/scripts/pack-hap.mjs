#!/usr/bin/env node
/**
 * New World - 调用鸿蒙工具链把壳工程打成 HAP
 *
 * 现状:本机未安装 HarmonyOS SDK / DevEco Studio / 官方 OHOS Electron runtime,
 * 因此本脚本只做环境探测 + 明确失败,**不伪造成功**
 * (与仓库既有原则一致:沙箱能力不可用时必须显式返回失败,见跨平台方案 §7)。
 *
 * 环境就绪后本脚本会调用 hvigorw assembleHap。
 */

import { existsSync } from 'node:fs';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(__dirname, '..', '..');
const OHOS_DIR = join(ROOT, 'ohos');

const isWin = process.platform === 'win32';
const hvigorw = join(OHOS_DIR, isWin ? 'hvigorw.bat' : 'hvigorw');

function hint() {
  console.error(`
[ohos:pack] 鸿蒙打包环境未就绪,已停止(未产出 HAP)。

需要补齐的前置条件:
  1. 安装 DevEco Studio 与 HarmonyOS SDK,并设置 DEVECO_SDK_HOME
  2. 用 DevEco 打开 ${OHOS_DIR} 一次,由 IDE 生成 hvigorw / hvigorw.bat
     与 hvigor/hvigor-config.json5(hvigor wrapper 由 IDE 下发,不手工编造)
  3. 获取官方鸿蒙 PC Electron runtime v34.6.3-20260105.1,
     按 ohos/oh-package.json5 中的 TODO 填入依赖坐标后执行 \`ohpm install\`
  4. 在 ohos/build-profile.json5 补全 signingConfigs(见 ohos/signature/README.md)

就绪后本脚本将执行:
  cd ohos && ${isWin ? 'hvigorw.bat' : './hvigorw'} --mode module -p product=default assembleHap

详见 ohos/README.md 的「TODO 清单」。
`);
}

// ---- 环境探测 ----
const problems = [];
if (!process.env.DEVECO_SDK_HOME && !process.env.HOS_SDK_HOME) {
  problems.push('未设置 DEVECO_SDK_HOME / HOS_SDK_HOME(HarmonyOS SDK 未安装或未配置)');
}
if (!existsSync(hvigorw)) {
  problems.push(`未找到 hvigor wrapper: ${hvigorw}`);
}
if (!existsSync(join(OHOS_DIR, 'oh_modules'))) {
  problems.push('未找到 ohos/oh_modules(尚未执行 ohpm install)');
}

if (problems.length > 0) {
  console.error('[ohos:pack] 环境检查未通过:');
  for (const p of problems) console.error(`  - ${p}`);
  hint();
  process.exit(1);
}

// ---- 环境就绪:调用 hvigor ----
// TODO(需 DevEco 确认): 参数组合以本机 hvigor 版本为准,下列为通用形式。
const args = ['--mode', 'module', '-p', 'product=default', 'assembleHap'];
console.log(`[ohos:pack] 执行: ${hvigorw} ${args.join(' ')}`);
const r = spawnSync(hvigorw, args, { cwd: OHOS_DIR, stdio: 'inherit', shell: false });
if (r.error) {
  console.error(`[ohos:pack] 调用失败: ${r.error.message}`);
  process.exit(1);
}
process.exit(r.status ?? 1);
