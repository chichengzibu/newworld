/**
 * New World — ProcessSandbox（进程隔离执行）
 * ═══════════════════════════════════════════════════════════════
 * 【要解决的问题】
 * 此前命令走 `execFile`,超时/中止时 Node 只杀**直接子进程**。
 * 实测(Windows):父进程被杀后,它起的长跑孙进程**仍然活着**
 *   → 孤儿进程堆积 → 用户的机器被慢慢拖垮(端口占着、内存吃着、CPU 烧着)
 *
 * 典型触发场景:
 *   - `npm install` 超时 → npm 死了,它起的 postinstall 子进程还在跑
 *   - 脚本里 `start-server &` → 父进程死了,后台服务永久驻留
 *   - 用户点了「停止」→ 只停住了最外层
 *
 * 【平台分支】
 *   POSIX(Linux/macOS): **进程组**隔离
 *     `detached: true` 让子进程成为新会话/新进程组的组长,
 *     杀进程组(`kill(-pgid)`) = 整棵树一起死。
 *   Windows: **tree-kill**
 *     Node 没有 Job Object 的原生 API(需原生模块,与本项目"零原生依赖"的
 *     取向冲突),故用系统自带的 `taskkill /T /F` —— /T 就是"连同子进程"。
 *     语义等价于 Job Object 的 `KILL_ON_JOB_CLOSE`(最后一个句柄关闭时全杀)。
 *
 * 【为什么不直接上 Job Object】
 * Job Object 能额外限制内存/CPU/进程数,但需要原生模块(N-API):
 *   - electron-builder 打包时原生模块需为 Electron ABI 重编译
 *   - 跨平台构建链(win/mac/linux/ohos)都要各自编译
 * 本项目 package.json **零原生依赖**,故本批先落地「不产生孤儿进程」这一
 * 最高价值的部分,Job Object 的资源限额能力留作接口扩展点(见 ProcessSandbox)。
 *
 * 【接口留出的扩展位】
 * `ProcessSandboxOptions.isolation` 显式声明用哪种隔离,
 * 将来加 Job Object / cgroup 分支时不必改调用方。
 */
import { spawn } from 'node:child_process'
import { LogManager } from '../core/LogManager'
import { ProcessLimiter } from './ProcessLimiter'

const log = LogManager.getInstance()

export type IsolationMode = 'process-group' | 'tree-kill' | 'none'

export interface ProcessSandboxOptions {
  /** 工作目录 */
  cwd?: string
  /** 环境变量(最小集,不继承 parent 敏感 env) */
  env?: Record<string, string>
  /** 超时(ms)—— 超时则**整棵树**被杀 */
  timeoutMs?: number
  /** stdout/stderr 各自上限(字节) */
  maxBuffer?: number
  /** 隔离方式;默认按平台自动选 */
  isolation?: IsolationMode
  /** 中止信号(用户点停止) */
  signal?: AbortSignal
  /**
   * 【M4.9 第三层·资源限额】是否启用资源采样。
   * 默认 true；测试可关掉（采样要 spawn 系统命令，单测里没必要）。
   */
  enforceLimits?: boolean
}

export interface ProcessSandboxResult {
  ok: boolean
  stdout: string
  stderr: string
  /** 退出码;被信号杀死时为 null */
  exitCode: number | null
  /** 是否因超时/中止被杀 */
  killed: boolean
  /** 杀人的原因 */
  killReason?: 'timeout' | 'aborted' | 'resource'
  durationMs: number
  /** 隔离方式(实际用的) */
  isolation: IsolationMode
  /** 【M4.9】超限被杀时的具体原因（内存/进程数） */
  limitReason?: string
}

/** 按平台选默认隔离方式 */
export function defaultIsolation(): IsolationMode {
  return process.platform === 'win32' ? 'tree-kill' : 'process-group'
}

/**
 * 杀整棵树。
 *
 * - Windows: `taskkill /pid <pid> /T /F`(/T = 连同子进程,/F = 强制)
 * - POSIX: 杀**进程组**(负 pid)——子进程是组长时,整组一起死
 */
export async function killProcessTree(pid: number, isolation: IsolationMode): Promise<void> {
  if (isolation === 'none') return
  if (process.platform === 'win32') {
    await new Promise<void>((resolve) => {
      try {
        const killer = spawn('taskkill', ['/pid', String(pid), '/T', '/F'], {
          windowsHide: true,
          stdio: 'ignore',
        })
        killer.on('close', () => resolve())
        killer.on('error', () => resolve())
        // 兜底:taskkill 本身卡住时不能无限等
        setTimeout(resolve, 3000).unref?.()
      } catch {
        resolve()
      }
    })
    return
  }
  // POSIX: 先杀进程组(负 pid),失败再杀单进程
  try {
    process.kill(-pid, 'SIGKILL')
  } catch {
    try { process.kill(pid, 'SIGKILL') } catch { /* 已退出 */ }
  }
}

/**
 * 在隔离环境里跑一条命令。
 *
 * 【与 execFile 的差别】
 *   1. 超时/中止时杀的是**整棵树**(execFile 只杀直接子进程)
 *   2. 返回结构化结果(不抛异常),调用方自己决定怎么记账
 *   3. stdout/stderr 超限时**截断并标注**,而不是直接报错丢全部输出
 */
export async function runInSandbox(
  command: string,
  args: string[],
  opts: ProcessSandboxOptions = {},
): Promise<ProcessSandboxResult> {
  const isolation = opts.isolation ?? defaultIsolation()
  const timeoutMs = opts.timeoutMs ?? 30_000
  const maxBuffer = opts.maxBuffer ?? 1024 * 1024
  const startedAt = Date.now()

  return await new Promise<ProcessSandboxResult>((resolve) => {
    let stdout = ''
    let stderr = ''
    let stdoutTruncated = false
    let stderrTruncated = false
    let settled = false
    let killReason: 'timeout' | 'aborted' | 'resource' | undefined
    /** 超限被杀时的具体原因（内存/进程数），随结果返回 */
    let limitDetail: string | undefined

    const child = spawn(command, args, {
      cwd: opts.cwd,
      // POSIX: 让子进程成为新进程组组长(否则 kill(-pid) 杀不到树)
      // Windows: 需要新控制台才能用 taskkill /T?—— 不需要,taskkill 按父子关系走
      detached: isolation === 'process-group',
      windowsHide: true,
      env: opts.env ?? {
        PATH: process.env.PATH ?? '',
        SYSTEMROOT: process.env.SYSTEMROOT ?? '',
        USERPROFILE: process.env.USERPROFILE ?? '',
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    })

    const append = (which: 'out' | 'err', chunk: Buffer) => {
      const text = chunk.toString('utf8')
      if (which === 'out') {
        if (stdout.length + text.length > maxBuffer) {
          stdout += text.slice(0, Math.max(0, maxBuffer - stdout.length))
          stdoutTruncated = true
        } else stdout += text
      } else {
        if (stderr.length + text.length > maxBuffer) {
          stderr += text.slice(0, Math.max(0, maxBuffer - stderr.length))
          stderrTruncated = true
        } else stderr += text
      }
    }

    child.stdout?.on('data', (c: Buffer) => append('out', c))
    child.stderr?.on('data', (c: Buffer) => append('err', c))

    /** 收尾:只做一次 */
    const finalize = (exitCode: number | null) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      opts.signal?.removeEventListener('abort', onAbort)
      if (stdoutTruncated) stdout += '\n[输出超出上限,已截断]'
      if (stderrTruncated) stderr += '\n[输出超出上限,已截断]'
      const payload: ProcessSandboxResult = {
        ok: !killReason && exitCode === 0,
        stdout,
        stderr,
        exitCode,
        killed: !!killReason,
        ...(killReason ? { killReason } : {}),
        ...(limitDetail ? { limitReason: limitDetail } : {}),
        durationMs: Date.now() - startedAt,
        isolation,
      }
      if (limitDetail) {
        payload.stderr += `\n[资源超限，已终止] ${limitDetail}`
      }
      resolve(payload)
    }

    const killTree = async (reason: 'timeout' | 'aborted' | 'resource', limitReason?: string) => {
      if (settled) return
      killReason = reason
      if (limitReason) limitDetail = limitReason
      try {
        await killProcessTree(child.pid!, isolation)
      } catch (e) {
        log.warn(`[ProcessSandbox] 杀进程树失败 pid=${child.pid}: ${String(e)}`)
      }
      // 杀完给一个短窗口让 close 事件到达;再兜底 finalize
      setTimeout(() => finalize(null), 1500).unref?.()
    }

    const timer = setTimeout(() => { void killTree('timeout') }, timeoutMs)
    timer.unref?.()

    const onAbort = () => { void killTree('aborted') }
    if (opts.signal) {
      if (opts.signal.aborted) { void killTree('aborted') }
      else opts.signal.addEventListener('abort', onAbort, { once: true })
    }

    /**
     * 【M4.9 第三层·资源限额采样】
     *
     * 每 sampleIntervalMs 采一次进程树的内存与进程数。
     * 超限 → 杀整棵树，并把具体原因带回给调用方。
     *
     * 为什么是轮询而不是 OS 限额：Job Object / cgroup 都要 native 依赖或 root，
     * 桌面应用不现实。轮询精度差一些（最坏晚一个采样周期才发现），
     * 但足以挡住"跑着跑着把内存吃满"和"fork 出一堆进程"这两类实际事故。
     *
     * 采样失败一律放行 —— 限额是护栏，不是安全边界。
     */
    let limitTimer: NodeJS.Timeout | undefined
    if (opts.enforceLimits !== false && child.pid) {
      const limiter = ProcessLimiter.getInstance()
      const interval = limiter.getLimits().sampleIntervalMs
      limitTimer = setInterval(() => {
        if (settled) return
        void limiter
          .checkTree(child.pid!)
          .then((reason) => {
            if (reason && !settled) {
              log.warn(`[ProcessSandbox] 资源超限，杀进程树 pid=${child.pid}: ${reason}`)
              void killTree('resource', reason)
            }
          })
          .catch(() => {
            /* 检查失败放行 */
          })
      }, interval)
      limitTimer.unref?.()
    }

    child.on('error', (err) => {
      stderr += `\n[spawn 失败] ${err.message}`
      finalize(null)
    })
    child.on('close', (code, signal) => {
      if (limitTimer) clearInterval(limitTimer)
      // 被信号杀死时 exitCode 为 null
      finalize(code === null && signal ? null : code)
    })
  })
}
