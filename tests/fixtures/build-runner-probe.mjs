/**
 * 构建脚本核心的探针 —— 由 `tests/unit/build-runner.test.ts` 以**子进程**方式跑。
 *
 * 【为什么是子进程而不是直接 import】
 * `scripts/**` 下的 `.mjs` 在 vitest 里会被当作外部依赖按 CJS 加载 → ESM 语法直接炸。
 * 而构建脚本**真实运行时就是纯 node** —— 子进程跑反而是更贴近真实的验证。
 *
 * 输出一行 JSON（`__PROBE__{...}`），由测试断言。
 */
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { moveAside, runStep, readTail, findArtifact } from '../../scripts/lib/build-runner.mjs';

const results = {};

async function main() {
  const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'pipiclaw-buildrunner-'));
  const logDir = path.join(tmpRoot, 'logs');

  // ① 正常执行:退出码 / 日志落盘 / 耗时
  {
    const r = await runStep(
      'ok',
      process.execPath,
      ['-e', "console.log('hello-from-child')"],
      20000,
      // 直连 node 时不要经过 shell —— 否则 Windows 的 cmd 会把 -e 里的引号吃掉,
      // 子进程立刻报错退出,超时/正常两条路径都测不准
      { logDir, echo: false, shell: false },
    );
    results.ok = {
      status: r.status,
      timedOut: r.timedOut,
      hasLog: !!r.logPath && fs.existsSync(r.logPath),
      logContent: r.logPath ? fs.readFileSync(r.logPath, 'utf-8') : '',
      durationPositive: typeof r.durationMs === 'number' && r.durationMs >= 0,
    };
  }

  // ② 【回归】超时必须**如实上报**且不能挂死
  //    修前:`timedOut` 在 close 回调里写死 false → 超时与普通失败无法区分
  {
    const t0 = Date.now();
    const r = await runStep(
      'timeout',
      process.execPath,
      ['-e', 'setTimeout(() => {}, 30000)'],
      800,
      { logDir, echo: false, shell: false, killGraceMs: 5000 },
    );
    results.timeout = {
      timedOut: r.timedOut,
      status: r.status,
      elapsedMs: Date.now() - t0,
    };
  }

  // ③ 移走旧产物:正常路径
  {
    const dir = path.join(tmpRoot, 'dist-like');
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'a.txt'), 'x');
    const r = moveAside(dir, { retries: 1, sleep: () => {} });
    results.moveOk = {
      ok: r.ok,
      originalGone: !fs.existsSync(dir),
      movedExists: !!r.moved && fs.existsSync(r.moved),
    };
  }

  // ④ 移走旧产物:目录不存在 → 跳过(不算失败)
  {
    const r = moveAside(path.join(tmpRoot, 'nope'), { retries: 1, sleep: () => {} });
    results.moveMissing = { ok: r.ok, skipped: !!r.skipped };
  }

  // ⑤ 【回归】移走失败必须**返回失败**（修前是静默吞掉,构建继续走进 EBUSY）
  //    模拟:让一个子进程把该目录作为 cwd —— Windows 上会锁住目录改名。
  {
    const dir = path.join(tmpRoot, 'locked-like');
    fs.mkdirSync(dir, { recursive: true });
    const holder = spawn(process.execPath, ['-e', 'setTimeout(() => {}, 20000)'], {
      cwd: dir,
      stdio: 'ignore',
    });
    await new Promise((r) => setTimeout(r, 300));
    let r;
    try {
      r = moveAside(dir, { retries: 2, baseDelayMs: 50, sleep: (ms) => { Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms); } });
    } finally {
      try { holder.kill(); } catch { /* ignore */ }
    }
    results.moveLocked = {
      ok: r.ok,
      hasError: !!r.error,
      errorCode: r.error?.code ?? null,
      // 若该平台允许改名(cwd 不锁目录),如实记录 —— 断言只要求"不静默成功"
      originalStillThere: fs.existsSync(dir),
    };
  }

  // ⑥ readTail 取末尾 N 行
  {
    const f = path.join(tmpRoot, 'tail.log');
    fs.writeFileSync(f, Array.from({ length: 100 }, (_, i) => `line-${i + 1}`).join('\n'), 'utf-8');
    results.tail = readTail(f, 3).split('\n');
    results.tailMissing = readTail(path.join(tmpRoot, 'nope.log'), 3);
  }

  // ⑦ findArtifact 递归找产物
  {
    const rel = path.join(tmpRoot, 'release-like');
    fs.mkdirSync(path.join(rel, 'win-unpacked'), { recursive: true });
    results.artifactEmpty = findArtifact(rel);
    fs.writeFileSync(path.join(rel, 'win-unpacked', 'App.exe'), 'x');
    results.artifactFound = findArtifact(rel);
    results.artifactMissingDir = findArtifact(path.join(tmpRoot, 'nope-dir'));
  }

  try { fs.rmSync(tmpRoot, { recursive: true, force: true }); } catch { /* ignore */ }

  process.stdout.write(`__PROBE__${JSON.stringify(results)}\n`);
}

main().catch((e) => {
  process.stdout.write(`__PROBE__${JSON.stringify({ fatal: String(e && e.stack || e) })}\n`);
  process.exit(1);
});
