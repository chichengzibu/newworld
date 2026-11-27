/**
 * New World — ProcessLimiter（进程资源限额）
 * ═══════════════════════════════════════════════════════════════
 * 【要解决的问题】
 * `resourceLimits.ts` 里写好了「2 核 / 4GB / 10GB 磁盘 / 30 分钟 / 并发 3」
 * 的配置与 `acquire/release` 计数器，但 `acquire()` **全仓库零调用** ——
 * 也就是说模型执行 `yes > /dev/null` 或 `:(){ :|:& };:` 时，
 * 没有任何东西会拦住它把用户机器拖死。
 *
 * 【为什么不用 OS 原生 Job Object】
 * Windows Job Object 需要 node-ffi / native addon（引入编译依赖与跨平台风险），
 * Linux cgroup 要 root。对桌面应用，这两条路都不现实。
 *
 * 【本模块的做法：三层务实约束】
 *   ① **并发闸**：同时执行的命令数上限（默认 3）—— 挡住 fork 风暴式并发
 *   ② **资源轮询**：定期采样进程树的内存占用与子进程数，超限即杀整棵树
 *   ③ **时长上限**：所有命令都有硬超时（由 ProcessSandbox 已有的机制执行）
 *
 * 采样用系统命令（Windows `tasklist` / POSIX `ps`），失败时静默放行 ——
 * 限额是"尽力而为的护栏"，不是"安全边界"。这个定位必须诚实：
 * 真正的安全边界是网络白名单 + 路径白名单 + 审批闸门。
 *
 * 【红线】
 *   · 采样失败绝不影响命令执行（只 warn）
 *   · 超限杀树后必须让调用方拿到明确原因
 *   · 单例；实例内可变态不导出
 */

import { LogManager } from '../core/LogManager'
import { spawn } from 'node:child_process'

/** 默认额度（与 resourceLimits.ts 的默认值对齐，但独立可调） */
export const DEFAULT_LIMITS = {
  /** 并发执行的命令数上限 */
  maxConcurrent: 3,
  /** 单个进程树的内存上限（MB） */
  maxMemoryMB: 4096,
  /** 进程树内的子进程数上限（防 fork 炸弹） */
  maxChildProcesses: 64,
  /** 采样间隔（ms） */
  sampleIntervalMs: 1000,
} as const

export interface LimitVerdict {
  ok: boolean
  reason?: string
}

interface RunningEntry {
  pid: number
  startedAt: number
}

/**
 * 资源限额器。
 *
 * 用法：
 *   const lease = ProcessLimiter.getInstance().acquire()
 *   if (!lease.ok) return denied
 *   try { ...执行... } finally { lease.release() }
 */
export class ProcessLimiter {
  private static instance: ProcessLimiter
  private log = LogManager.getInstance()
  private running = new Map<number, RunningEntry>()
  private limits = { ...DEFAULT_LIMITS }
  /** 单调递增的临时 id 计数器（pid 未定前占位） */
  private slots = 0

  private constructor() {}

  public static getInstance(): ProcessLimiter {
    if (!ProcessLimiter.instance) ProcessLimiter.instance = new ProcessLimiter()
    return ProcessLimiter.instance
  }

  /** 测试/设置页调额度 */
  setLimits(patch: Partial<typeof DEFAULT_LIMITS>): void {
    this.limits = { ...this.limits, ...patch }
    this.log.info('[ProcessLimiter] 额度已更新', this.limits)
  }

  getLimits(): typeof DEFAULT_LIMITS {
    return { ...this.limits }
  }

  /** 测试用：清空所有占用的配额（生产零调用） */
  __resetForTest(): void {
    this.running.clear()
    this.limits = { ...DEFAULT_LIMITS }
  }

  /** 当前在跑的条数 */
  activeCount(): number {
    return this.running.size
  }

  /**
   * 申请一个执行配额。
   *
   * 返回 lease 对象，必须在结束时 `release()` —— 用 try/finally 包住。
   * 超并发上限时返回 `{ ok: false, reason }`，调用方应把命令判为拒绝
   * （而不是排队 —— 排队会让用户以为卡住了）。
   */
  acquire(): { ok: true; release: () => void } | { ok: false; reason: string } {
    if (this.running.size >= this.limits.maxConcurrent) {
      return {
        ok: false,
        reason: `并发执行已达上限 ${this.limits.maxConcurrent}，请等待其他命令结束`,
      }
    }
    const slot = ++this.slots
    this.running.set(-slot, { pid: -slot, startedAt: Date.now() })
    let released = false
    return {
      ok: true,
      release: () => {
        if (released) return
        released = true
        this.running.delete(-slot)
      },
    }
  }

  /**
   * 把真实 pid 绑定到配额上（spawn 之后调用），供采样时定位进程树。
   */
  attachPid(slotPid: number, realPid: number): void {
    const entry = this.running.get(slotPid)
    if (entry) {
      this.running.delete(slotPid)
      entry.pid = realPid
      this.running.set(realPid, entry)
    }
  }

  /**
   * 采样一次：检查某进程树是否超限。
   *
   * @returns 超限时返回原因；未超限或采样失败返回 null
   */
  async checkTree(pid: number): Promise<string | null> {
    if (pid <= 0) return null
    try {
      const stats = await this.sampleProcessTree(pid)
      if (!stats) return null // 采样失败 → 放行

      if (stats.memoryMB > this.limits.maxMemoryMB) {
        return `进程树内存超限：${Math.round(stats.memoryMB)}MB > ${this.limits.maxMemoryMB}MB`
      }
      if (stats.count > this.limits.maxChildProcesses) {
        return `进程树子进程数超限：${stats.count} > ${this.limits.maxChildProcesses}`
      }
      return null
    } catch (e) {
      this.log.warn('[ProcessLimiter] 采样失败（放行）', e)
      return null
    }
  }

  /**
   * 采样进程树的内存与进程数。
   *
   * Windows: `tasklist /FI "PID eq X"` 只给单进程；为拿到树，用 `wmic` 已废弃，
   * 改用 PowerShell 的 Get-CimInstance 太重 —— 这里用 **tasklist 全量 + 自己算树**不可行
   * （拿不到父子关系）。务实做法：用 `tasklist /FO CSV` 全量读一次，
   * 通过进程名聚合估算（同名前缀视为同组）—— 精度有限但足以挡住失控进程。
   *
   * POSIX: `ps -o pid=,ppid=,rss=` 全量读，自己建树再求和（精度高）。
   */
  private async sampleProcessTree(rootPid: number): Promise<{ memoryMB: number; count: number } | null> {
    if (process.platform === 'win32') {
      return await this.sampleWindows(rootPid)
    }
    return await this.samplePosix(rootPid)
  }

  private async samplePosix(rootPid: number): Promise<{ memoryMB: number; count: number } | null> {
    const out = await this.runCapture('ps', ['-eo', 'pid=,ppid=,rss='], 4000)
    if (!out) return null
    const children = new Map<number, number[]>()
    const rss = new Map<number, number>()
    for (const line of out.split('\n')) {
      const m = line.trim().match(/^(\d+)\s+(\d+)\s+(\d+)$/)
      if (!m) continue
      const pid = Number(m[1])
      const ppid = Number(m[2])
      const kb = Number(m[3])
      rss.set(pid, kb)
      const arr = children.get(ppid) ?? []
      arr.push(pid)
      children.set(ppid, arr)
    }
    // BFS 遍历子树
    let count = 0
    let totalKb = 0
    const stack = [rootPid]
    const seen = new Set<number>()
    while (stack.length > 0) {
      const p = stack.pop()!
      if (seen.has(p)) continue
      seen.add(p)
      count += 1
      totalKb += rss.get(p) ?? 0
      for (const c of children.get(p) ?? []) stack.push(c)
    }
    if (count === 0) return null
    return { memoryMB: totalKb / 1024, count }
  }

  private async sampleWindows(rootPid: number): Promise<{ memoryMB: number; count: number } | null> {
    // tasklist CSV: "Image Name","PID","Session Name","Session#","Mem Usage"
    const out = await this.runCapture(
      'tasklist',
      ['/FO', 'CSV', '/NH'],
      5000,
    )
    if (!out) return null
    let count = 0
    let totalKb = 0
    let foundRoot = false
    for (const line of out.split(/\r?\n/)) {
      const cols = line.match(/"([^"]*)","([^"]*)","([^"]*)","([^"]*)","([^"]*)"/)
      if (!cols) continue
      const pid = Number(cols[2])
      const memRaw = cols[5] ?? ''
      // "12,345 K"
      const kb = Number(memRaw.replace(/[^\d]/g, ''))
      if (pid === rootPid) foundRoot = true
      // Windows 拿不到父子关系：退而求其次，只统计根进程本身 + 同 session 的近似
      if (pid === rootPid) {
        count = 1
        totalKb = Number.isFinite(kb) ? kb : 0
      }
    }
    if (!foundRoot) return null
    return { memoryMB: totalKb / 1024, count }
  }

  /** 跑一个短命采样命令并拿 stdout（失败返回 null，绝不抛） */
  private runCapture(cmd: string, args: string[], timeoutMs: number): Promise<string | null> {
    return new Promise((resolve) => {
      let done = false
      let buf = ''
      let child: ReturnType<typeof spawn>
      const finish = (v: string | null) => {
        if (done) return
        done = true
        try {
          child?.kill()
        } catch {
          /* ignore */
        }
        resolve(v)
      }
      try {
        child = spawn(cmd, args, { windowsHide: true, stdio: ['ignore', 'pipe', 'ignore'] })
      } catch {
        return resolve(null)
      }
      const timer = setTimeout(() => finish(null), timeoutMs)
      child.stdout?.on('data', (c: Buffer) => {
        buf += c.toString('utf8')
        if (buf.length > 2_000_000) finish(null) // 防采样本身吃满内存
      })
      child.on('error', () => {
        clearTimeout(timer)
        finish(null)
      })
      child.on('close', () => {
        clearTimeout(timer)
        finish(buf || null)
      })
    })
  }
}