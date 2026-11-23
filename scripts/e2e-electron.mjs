#!/usr/bin/env node
/**
 * PiPiClaw — Electron e2e 启动器（跨平台）
 * ═══════════════════════════════════════════════════════════════════════
 * 【为什么需要这个文件】
 * 原脚本是 `"test:e2e:electron": "E2E_ELECTRON=1 playwright test --reporter=line"`。
 * 这是 **Unix 的 env 前置写法** —— 在 Windows 的 cmd.exe 里会报
 *   'E2E_ELECTRON' 不是内部或外部命令
 * 即：**在 Windows 上这条交付门禁根本跑不起来**（实测踩到）。
 *
 * 【为什么不用 cross-env】
 * 它既不在 devDependencies 里，也没装（`node_modules/cross-env` 不存在）——
 * 顺带说明 `perf:full` / `perf:sse` 两条脚本同样跑不了（已记台账）。
 * 而项目红线是零新 npm 依赖，故用 Node 自带能力写这个小包装器。
 *
 * 用法：npm run test:e2e:electron
 * 前置：先 `npm run build` 产出 dist-electron/main.js（Electron 入口）
 */
import { spawn } from 'node:child_process';
import path from 'node:path';
import process from 'node:process';

const binName = process.platform === 'win32' ? 'playwright.cmd' : 'playwright';
const bin = path.join('node_modules', '.bin', binName);

const child = spawn(bin, ['test', '--reporter=line', ...process.argv.slice(2)], {
  stdio: 'inherit',
  env: { ...process.env, E2E_ELECTRON: '1' },
  shell: process.platform === 'win32',
});

child.on('error', (err) => {
  console.error(`[e2e] 启动 playwright 失败: ${String(err)}`);
  console.error(`[e2e] 预期可执行文件: ${bin}`);
  process.exit(1);
});
child.on('close', (code) => process.exit(code ?? 1));
