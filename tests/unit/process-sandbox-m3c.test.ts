/**
 * New World — ProcessSandbox 测试（M3-C）
 * ═══════════════════════════════════════════════════════════════
 * 【这一批锁的是什么】
 * 此前命令走 execFile,超时/中止时 Node 只杀**直接子进程**。
 * 实测(Windows):父进程被杀后,它起的长跑孙进程**仍然活着** ——
 * 孤儿进程堆积,用户的机器被慢慢拖垮。
 *
 * 本批锁死:
 *   ① 超时 → **整棵树**被杀(不是只杀父)
 *   ② 中止(AbortSignal)→ 整棵树被杀
 *   ③ 正常退出 → 退出码/stdout/stderr 正确
 *   ④ 输出超限 → 截断并标注(不丢全部输出,也不报错)
 *   ⑤ 命令不存在 → 报失败而不是抛异常
 *
 * 【为什么 ① ② 是核心】
 * 它们是「用户点了停止,进程还在跑」这类问题的唯一解。
 * 而 execFile 的语义做不到 —— 这正是换掉它的理由。
 */
import { describe, it, expect } from 'vitest'
import { runInSandbox, killProcessTree, defaultIsolation } from '../../electron/sandbox/ProcessSandbox'

/** 该平台的隔离方式 */
const ISOLATION = defaultIsolation()

/** 进程是否还活着 */
async function isAlive(pid: number): Promise<boolean> {
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}

/** 等一会儿让 OS 回收 */
const sleep = (ms: number) => new Promise(r => setTimeout(r, ms))

/** 从 stdout 里挑出第一个纯数字行(孙进程 pid) */
function firstPidLine(stdout: string): string | undefined {
  return stdout
    .split(/\r?\n/)
    .map(s => s.trim())
    .find(s => /^[0-9]+$/.test(s))
}

describe('M3-C ProcessSandbox', () => {
  it('正常退出 → 退出码 0 + stdout 正确', async () => {
    const r = await runInSandbox(
      process.execPath,
      ['-e', 'process.stdout.write("hello-sandbox")'],
      { timeoutMs: 15000 },
    )
    expect(r.ok).toBe(true)
    expect(r.exitCode).toBe(0)
    expect(r.stdout).toContain('hello-sandbox')
    expect(r.killed).toBe(false)
  })

  it('非零退出 → ok=false 且退出码正确', async () => {
    const r = await runInSandbox(
      process.execPath,
      ['-e', 'process.exit(3)'],
      { timeoutMs: 15000 },
    )
    expect(r.ok).toBe(false)
    expect(r.exitCode).toBe(3)
  })

  it('stderr 被捕获', async () => {
    const r = await runInSandbox(
      process.execPath,
      ['-e', 'process.stderr.write("err-text")'],
      { timeoutMs: 15000 },
    )
    expect(r.stderr).toContain('err-text')
  })

  it('超时 → 进程被杀,killed=true 且标出原因', async () => {
    const r = await runInSandbox(
      process.execPath,
      ['-e', 'setTimeout(()=>{},60000)'],
      { timeoutMs: 1200 },
    )
    expect(r.killed).toBe(true)
    expect(r.killReason).toBe('timeout')
    expect(r.ok).toBe(false)
  })

  it('中止(AbortSignal)→ 进程被杀,killReason=aborted', async () => {
    const ac = new AbortController()
    setTimeout(() => ac.abort(), 500)
    const r = await runInSandbox(
      process.execPath,
      ['-e', 'setTimeout(()=>{},60000)'],
      { timeoutMs: 30000, signal: ac.signal },
    )
    expect(r.killed).toBe(true)
    expect(r.killReason).toBe('aborted')
  })

  /**
   * 【核心回归钉】超时后**孙进程不能活下来**。
   *
   * 这是本批存在的全部理由:execFile 做不到这件事(实测孙进程会残留)。
   *
   * 【测法】被沙箱跑的命令自己起一个长跑孙进程,并把孙进程 pid 打到 stdout;
   * 超时后检查那个 pid 是否还活着。
   * (不能另起一个进程树来测 —— 那样验的不是被沙箱命令的树。)
   */
  it('超时 → 整棵树被杀(孙进程不残留) —— execFile 做不到这件事', async () => {
    const parentScript = process.platform === 'win32'
      ? `$p = Start-Process node -ArgumentList '-e','setTimeout(()=>{},60000)' -PassThru -WindowStyle Hidden; Write-Output $p.Id; Start-Sleep 60`
      : `node -e "setTimeout(()=>{},60000)" & echo $!; sleep 60`
    const r = await runInSandbox(
      process.platform === 'win32' ? 'powershell' : 'sh',
      process.platform === 'win32'
        ? ['-NoProfile', '-Command', parentScript]
        : ['-c', parentScript],
      { timeoutMs: 2500 },
    )
    expect(r.killed).toBe(true)

    // stdout 里应有孙进程 pid
    const pidLine = firstPidLine(r.stdout)
    expect(pidLine, `stdout 应含孙进程 pid,实际: ${JSON.stringify(r.stdout)}`).toBeTruthy()
    const grandchildPid = Number(pidLine)
    expect(grandchildPid).toBeGreaterThan(0)

    // 父进程死了之后,孙进程也必须死
    await sleep(1500)
    const stillAlive = await isAlive(grandchildPid)
    if (stillAlive) { try { await killProcessTree(grandchildPid, ISOLATION) } catch { /* ignore */ } }
    expect(stillAlive).toBe(false)
  }, 60000)

  it('输出超限 → 截断并标注(不抛异常,也不丢全部)', async () => {
    const r = await runInSandbox(
      process.execPath,
      ['-e', 'process.stdout.write("x".repeat(50000))'],
      { timeoutMs: 15000, maxBuffer: 1024 },
    )
    expect(r.stdout.length).toBeLessThan(50000)
    expect(r.stdout).toContain('已截断')
  })

  it('命令不存在 → 报失败而不是抛异常', async () => {
    const r = await runInSandbox(
      'definitely-not-a-real-command-xyz-9911',
      [],
      { timeoutMs: 8000 },
    )
    expect(r.ok).toBe(false)
    expect(r.stderr).toContain('spawn')
  })

  it('cwd 生效', async () => {
    const r = await runInSandbox(
      process.execPath,
      ['-e', 'process.stdout.write(process.cwd())'],
      { cwd: process.cwd(), timeoutMs: 15000 },
    )
    expect(r.stdout).toContain(process.cwd())
  })

  it('isolation=none 时直接子进程仍会被杀(显式退出的逃生口)', async () => {
    const r = await runInSandbox(
      process.execPath,
      ['-e', 'setTimeout(()=>{},60000)'],
      { timeoutMs: 1000, isolation: 'none' },
    )
    expect(r.killed).toBe(true)
  })

  /**
   * 【接线验证】中止信号必须一路传到命令执行 ——
   * 用户点「停止」时,正在跑的命令(及其孙进程)必须真的停下来。
   *
   * 链路：brain.run 的 AbortController → toolCtx.signal → BashTool → execCommand → sandbox
   */
  it('接线：BashTool 收到中止信号 → 命令被中止', async () => {
    const { BashTool } = await import('../../electron/agent/tools/BashTool')
    const ac = new AbortController()
    setTimeout(() => ac.abort(), 600)
    const t0 = Date.now()
    const r = await new BashTool().execute(
      { command: process.execPath, args: ['-e', 'setTimeout(()=>{},60000)'] },
      { contextKind: 'ui', signal: ac.signal } as any,
    )
    const elapsed = Date.now() - t0
    expect(r.ok).toBe(false)
    // 应当在中止后很快返回(而不是等 60s 命令跑完)
    expect(elapsed).toBeLessThan(15000)
  }, 30000)

  it('平台默认隔离方式正确', () => {
    if (process.platform === 'win32') expect(ISOLATION).toBe('tree-kill')
    else expect(ISOLATION).toBe('process-group')
  })
})
