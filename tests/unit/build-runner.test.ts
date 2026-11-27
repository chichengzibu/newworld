/**
 * New World — 构建脚本核心的回归测试（M4-Z）
 * ═══════════════════════════════════════════════════════════════════════
 * 【为什么要有这个】
 * 构建门禁红过一次，**却说不清原因** —— 排查花了两轮构建。
 * 事后定位到三个缺陷，全都在 `scripts/build.mjs` 里，而它们有个共同点：
 * **只有在出事的时候才暴露**。
 *
 *   ① 子进程输出不落盘 → 红了没证据
 *   ② 超时永远报成普通失败（`timedOut` 写死 false）→ 分不清是卡住还是真失败
 *   ③ 移走旧产物失败被静默吞掉 → 构建继续走进注定 EBUSY 的路径
 *
 * 这里把 ①②③ 都钉成用例。核心逻辑已抽到 `scripts/lib/build-runner.mjs`
 * （`.mjs` 在 vitest 里会被当 CJS 加载，故用**子进程探针**跑，这也更贴近真实运行方式）。
 */
import { describe, it, expect, beforeAll } from 'vitest';
import { spawnSync } from 'node:child_process';
import path from 'node:path';

const PROBE = path.resolve(__dirname, '../fixtures/build-runner-probe.mjs');

function runProbe() {
  const r = spawnSync(process.execPath, [PROBE], { encoding: 'utf-8', timeout: 120_000 });
  const out = `${r.stdout ?? ''}${r.stderr ?? ''}`;
  const line = out.split(/\r?\n/).find((l) => l.startsWith('__PROBE__'));
  if (!line) throw new Error(`探针没有输出结果:\n${out.slice(0, 2000)}`);
  return JSON.parse(line.slice('__PROBE__'.length));
}

describe('M4-Z 构建脚本核心', () => {
  // 探针要起子进程(含一次超时+杀进程),高负载下可能超过默认 5s ——
  // 放进 beforeAll 并给足超时,避免整份 spec 因调度抖动偶发红。
  let results: any;
  beforeAll(() => {
    results = runProbe();
  }, 120_000);

  it('探针本身没有崩溃', () => {
    expect(results.fatal).toBeUndefined();
  });

  it('正常执行:退出码 0、日志落盘、耗时可用', () => {
    expect(results.ok.status).toBe(0);
    expect(results.ok.timedOut).toBe(false);
    expect(results.ok.hasLog).toBe(true);
    expect(results.ok.logContent).toContain('hello-from-child');
    expect(results.ok.durationPositive).toBe(true);
  });

  it('【回归】超时如实上报,且不会把构建挂死', () => {
    // 修前:`timedOut` 恒为 false —— "超时被杀"与"正常失败"无法区分
    expect(results.timeout.timedOut).toBe(true);
    // 被杀之后 close 的 code 可能是 null,也可能被 taskkill 记成非零 —— 都不重要:
    // 关键是 timedOut 必须为 true(调用方据此给"超时"而不是"普通失败"的提示)
    expect(results.timeout.status === null || typeof results.timeout.status === 'number').toBe(true);
    // 绝不能等满子进程的 30s:超时 0.8s + 杀进程,应远小于 10s
    expect(results.timeout.elapsedMs).toBeLessThan(10_000);
  });

  it('移走旧产物:正常路径改名成功', () => {
    expect(results.moveOk.ok).toBe(true);
    expect(results.moveOk.originalGone).toBe(true);
    expect(results.moveOk.movedExists).toBe(true);
  });

  it('移走旧产物:目录不存在 → 跳过,不算失败', () => {
    expect(results.moveMissing.ok).toBe(true);
    expect(results.moveMissing.skipped).toBe(true);
  });

  it('【回归】移走失败必须返回失败 —— 不许静默吞掉', () => {
    // 修前:catch {} 什么都不说,构建继续跑 electron-builder,
    // 最终在 unlink app.asar 撞 EBUSY,报成「未找到打包产物」—— 真错误被埋两层。
    // 该平台若允许改名(cwd 不锁目录),也必须是"没报错但目录确实被移走了",不能两者皆非。
    if (results.moveLocked.ok) {
      expect(results.moveLocked.originalStillThere).toBe(false);
    } else {
      expect(results.moveLocked.hasError).toBe(true);
    }
  });

  it('readTail 取末尾 N 行;文件不存在时返回空串(不抛)', () => {
    expect(results.tail).toEqual(['line-98', 'line-99', 'line-100']);
    expect(results.tailMissing).toBe('');
  });

  it('findArtifact 递归找打包产物', () => {
    expect(results.artifactEmpty).toBe(false);
    expect(results.artifactFound).toBe(true);
    expect(results.artifactMissingDir).toBe(false);
  });
});
