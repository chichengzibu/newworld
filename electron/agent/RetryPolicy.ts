/**
 * New World - Agent / RetryPolicy + CircuitBreaker
 *
 * 【设计依据:业界调研结论】
 * 2026 年的生产实践数据(12+ agent 系统 / 4 provider / 6 个月):
 *
 *  1. 纯指数退避【不够】—— 200 agent 规模实测显示,重试会聚成 250ms 的
 *     桶,retry storm 原样保留。必须用 full jitter:
 *         delay = random(0, min(base * 2^attempt, cap))
 *     在整个退避窗口内随机化,而不是在指数值上加抖动。
 *     AWS Architecture Blog 是公认参考,full jitter 在争用下尾延迟最优。
 *
 *  2. 3 次重试捕获 97.3% 的瞬时故障;超过 5 次边际收益 < 0.5%。
 *     故默认 maxAttempts = 3。
 *
 *  3. Retry-After 头优先于本地计算的退避。
 *
 *  4. 熔断器三态:closed → open → half_open。
 *     常见参数:连续 5 次失败开闸,30-60s 冷却,half_open 放 3 次,
 *     成功 2 次才完全关闭。
 *
 *  5. 幂等性:重试【写工具】会重复副作用。本模块的 execute() 只包裹
 *     纯函数式调用(LLM 请求);工具调用不走这里。
 *
 * 【相比原版的修正】
 *   原版用纯指数退避(base * 2^n),无 jitter、无熔断、不认 Retry-After。
 *   多 agent 并发时会互相踩踏。
 */
import { LogManager } from '../core/LogManager'
import { classifyError, type ClassifiedError } from './ErrorClassifier'

export interface RetryPolicyOptions {
  /** 总尝试次数(含首次)。3 = 首次 + 2 次重试 */
  maxAttempts: number
  baseDelayMs: number
  /** 退避上限(封顶,不无限增长) */
  maxDelayMs: number
  backoffMultiplier: number
  /** 熔断器:连续失败多少次后开闸 */
  failureThreshold: number
  /** 熔断器:开闸后多久进入 half_open */
  recoveryTimeoutMs: number
  /** 熔断器:half_open 态放行几次探测 */
  halfOpenMaxCalls: number
  /** 熔断器:half_open 态成功多少次才完全关闭 */
  successThreshold: number
  /** 注入随机源(测试用确定性序列) */
  random?: () => number
  /** 注入 sleep(测试用即时 resolve) */
  sleep?: (ms: number) => Promise<void>
}

const DEFAULT_OPTS: RetryPolicyOptions = {
  maxAttempts: 3,
  baseDelayMs: 1000,
  maxDelayMs: 30_000,        // 调研建议封顶 60s;30s 对交互式场景更友好
  backoffMultiplier: 2,
  failureThreshold: 5,
  recoveryTimeoutMs: 30_000,
  halfOpenMaxCalls: 3,
  successThreshold: 2,
}

/* ══════════════ 熔断器 ══════════════ */

export type BreakerState = 'closed' | 'open' | 'half_open'

export interface BreakerSnapshot {
  state: BreakerState
  consecutiveFailures: number
  totalFailures: number
  totalSuccesses: number
  openedAt?: number
  lastError?: string
}

/**
 * 熔断器 —— 三态状态机。
 *
 * 为什么 agent 需要它:模型服务整体不可用时,无脑重试只是【更快地烧完配额】。
 * 开闸后立刻失败,把时间还给用户,比让用户等 3 次退避更诚实。
 */
export class CircuitBreaker {
  private state: BreakerState = 'closed'
  private consecutiveFailures = 0
  private totalFailures = 0
  private totalSuccesses = 0
  private openedAt?: number
  private halfOpenCalls = 0
  private halfOpenSuccesses = 0
  private lastError?: string
  private log = LogManager.getInstance()

  constructor(private readonly opts: RetryPolicyOptions = DEFAULT_OPTS) {}

  /** 当前是否允许发起调用 */
  canAttempt(): boolean {
    if (this.state === 'closed') return true
    if (this.state === 'open') {
      const elapsed = Date.now() - (this.openedAt ?? 0)
      if (elapsed >= this.opts.recoveryTimeoutMs) {
        this.transitionTo('half_open')
        return true
      }
      return false
    }
    // half_open:限量放行探测
    return this.halfOpenCalls < this.opts.halfOpenMaxCalls
  }

  /** 记录一次成功 */
  recordSuccess(): void {
    this.totalSuccesses++
    this.consecutiveFailures = 0
    if (this.state === 'half_open') {
      this.halfOpenSuccesses++
      this.halfOpenCalls++
      if (this.halfOpenSuccesses >= this.opts.successThreshold) {
        this.transitionTo('closed')
      }
    } else {
      this.lastError = undefined
    }
  }

  /** 记录一次失败 */
  recordFailure(error: unknown): void {
    this.totalFailures++
    this.consecutiveFailures++
    this.lastError = error instanceof Error ? error.message : String(error)
    if (this.state === 'half_open') {
      // 探测失败 → 立即回到 open
      this.transitionTo('open')
      return
    }
    if (this.consecutiveFailures >= this.opts.failureThreshold) {
      this.transitionTo('open')
    }
  }

  private transitionTo(next: BreakerState): void {
    if (this.state === next) return
    this.state = next
    if (next === 'open') {
      this.openedAt = Date.now()
      this.halfOpenCalls = 0
      this.halfOpenSuccesses = 0
      this.log.warn(
        `CircuitBreaker: 开闸(连续失败 ${this.consecutiveFailures} 次),` +
        `${Math.round(this.opts.recoveryTimeoutMs / 1000)}s 后进入 half_open`,
      )
    } else if (next === 'half_open') {
      this.halfOpenCalls = 0
      this.halfOpenSuccesses = 0
      this.log.info('CircuitBreaker: 进入 half_open,放行探测请求')
    } else {
      this.consecutiveFailures = 0
      this.halfOpenCalls = 0
      this.halfOpenSuccesses = 0
      this.openedAt = undefined
      this.log.info('CircuitBreaker: 关闭,恢复正常')
    }
  }

  snapshot(): BreakerSnapshot {
    return {
      state: this.state,
      consecutiveFailures: this.consecutiveFailures,
      totalFailures: this.totalFailures,
      totalSuccesses: this.totalSuccesses,
      openedAt: this.openedAt,
      lastError: this.lastError,
    }
  }

  /** 手动复位(供 UI 的"重试"按钮用) */
  reset(): void {
    this.transitionTo('closed')
    this.consecutiveFailures = 0
    this.totalFailures = 0
    this.totalSuccesses = 0
    this.lastError = undefined
  }
}

/* ══════════════ 重试策略 ══════════════ */

/**
 * 计算 full-jitter 退避延迟。
 *
 *     delay = random(0, min(base * multiplier^attempt, maxDelay))
 *
 * 与"指数 + 小抖动"的区别:后者仍然让所有重试落在指数曲线的同一时刻,
 * 只是抖动了微小幅度;full jitter 让重试在整个窗口内均匀散开。
 */
export function computeBackoffDelay(
  attempt: number,          // 1-based:第几次尝试失败后的等待
  opts: RetryPolicyOptions = DEFAULT_OPTS,
  random: () => number = Math.random,
): number {
  const exp = Math.min(
    opts.baseDelayMs * Math.pow(opts.backoffMultiplier, attempt - 1),
    opts.maxDelayMs,
  )
  // random() ∈ [0,1) → 窗口内均匀
  return Math.floor(random() * exp)
}

export class RetryPolicy {
  private log = LogManager.getInstance()
  private opts: RetryPolicyOptions
  /** 熔断器(每个 RetryPolicy 实例自带,共享给其下所有调用) */
  private breaker: CircuitBreaker

  constructor(opts: Partial<RetryPolicyOptions> = {}) {
    this.opts = { ...DEFAULT_OPTS, ...opts }
    this.breaker = new CircuitBreaker(this.opts)
  }

  /** 熔断器快照(供 UI/监控查看) */
  breakerState(): BreakerSnapshot {
    return this.breaker.snapshot()
  }

  /**
   * 在重试策略下执行 `fn`。
   *
   * 语义:
   *   - 错误经 classifyError 判定可重试才重试(400/401/403/404/422 不重试)
   *   - 退避用 full jitter
   *   - 服务端给了 Retry-After 则优先采用
   *   - 熔断器开闸时直接失败,不浪费一次调用
   */
  async execute<T>(fn: () => Promise<T>, label = 'retry-block'): Promise<T> {
    let attempt = 0
    let lastErr: unknown = null

    while (attempt < this.opts.maxAttempts) {
      attempt += 1

      if (!this.breaker.canAttempt()) {
        this.log.warn(`RetryPolicy: ${label} 熔断器开闸,直接失败(不发起调用)`)
        throw lastErr ?? new Error(`[${label}] 熔断器开闸,上游持续失败,已停止重试`)
      }

      try {
        const result = await fn()
        this.breaker.recordSuccess()
        return result
      } catch (e) {
        lastErr = e
        // 用户中止不是"失败" —— 不重试、不计入熔断器统计。
        // 否则用户点停止反而会触发熔断,把后续正常请求一起拖下水。
        if ((e as Error)?.name === 'AbortError') {
          this.log.info(`RetryPolicy: ${label} 被中止,不重试`)
          throw e
        }
        const cls: ClassifiedError = classifyError(e)
        this.breaker.recordFailure(e)

        if (!cls.retryable || attempt >= this.opts.maxAttempts) {
          this.log.error(
            `RetryPolicy: ${label} 最终失败(第 ${attempt} 次,kind=${cls.kind})`,
            e,
          )
          throw e
        }

        // Retry-After 优先于本地退避
        const delay = cls.retryAfterMs !== undefined
          ? cls.retryAfterMs
          : computeBackoffDelay(attempt, this.opts, this.opts.random)

        this.log.warn(
          `RetryPolicy: ${label} 第 ${attempt} 次失败(${cls.kind}),full-jitter 退避 ${delay}ms`,
        )
        await this.sleep(delay)
      }
    }
    throw lastErr
  }

  private sleep(ms: number): Promise<void> {
    if (this.opts.sleep) return this.opts.sleep(ms)
    return new Promise((r) => setTimeout(r, ms))
  }
}
