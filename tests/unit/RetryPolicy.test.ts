/**
 * PiPiClaw - RetryPolicy / ErrorClassifier / CircuitBreaker 测试 (M3-B)
 *
 * 【设计依据】业界调研:3 次重试捕获 97.3% 瞬时故障;full jitter 是并发
 * 场景下的最优退避(AWS 架构博客);熔断器三态 closed→open→half_open。
 *
 * 【为什么这些断言重要】
 * 退避逻辑错了 → 要么烧光配额,要么用户干等。
 * 分类逻辑错了 → 400 错误被重试(浪费),或 429 不被重试(该重试的没重试)。
 * 熔断逻辑错了 → 持续故障时疯狂重试,或误熔断把正常请求也挡掉。
 */
import { describe, it, expect, vi } from 'vitest'
import { classifyError } from '../../electron/agent/ErrorClassifier'
import {
  RetryPolicy, CircuitBreaker, computeBackoffDelay, type RetryPolicyOptions,
} from '../../electron/agent/RetryPolicy'

/** 确定性 sleep(记录等待时长,不真等) */
const mkSleep = () => {
  const waits: number[] = []
  const sleep = async (ms: number) => { waits.push(ms) }
  return { waits, sleep }
}

describe('M3-B ErrorClassifier', () => {
  describe('状态码优先(最可靠信号)', () => {
    it.each([
      [401, 'permission', false],
      [403, 'permission', false],
      [400, 'permanent', false],
      [404, 'permanent', false],
      [422, 'permanent', false],
      [429, 'rate-limit', true],
      [500, 'transient', true],
      [502, 'transient', true],
      [503, 'transient', true],
      [504, 'transient', true],
    ])('HTTP %i → %s (retryable=%s)', (status, kind, retryable) => {
      const c = classifyError(new Error(`HTTP ${status}: some body text`))
      expect(c.kind).toBe(kind)
      expect(c.retryable).toBe(retryable)
    })
  })

  describe('不误判正常词汇 —— 原版的真实缺陷', () => {
    it.each([
      'generate a summary',
      'moderate the temperature',
      'accurate result please',
      'create an accurate report',
    ])('"%s" 不被判为限流', (msg) => {
      // 原版用 lower.includes('rate') 判定限流,会误匹配 generate/moderate/accurate
      const c = classifyError(new Error(msg))
      expect(c.kind).not.toBe('rate-limit')
      expect(c.retryable).toBe(false)
    })
  })

  describe('provider 语义', () => {
    it('overloaded_error 可重试(容量不足,退避有用)', () => {
      const c = classifyError(new Error('HTTP 529: overloaded_error'))
      expect(c.retryable).toBe(true)
      expect(c.kind).toBe('overloaded')
    })

    it('配额耗尽(rate_limit_error)也可重试但走退避', () => {
      const c = classifyError(new Error('HTTP 429: rate_limit_error'))
      expect(c.kind).toBe('rate-limit')
      expect(c.retryable).toBe(true)
    })
  })

  describe('特殊错误类型', () => {
    it('context_length_exceeded → context-overflow(需压缩,同输入重试无意义)', () => {
      const c = classifyError(new Error('HTTP 400: context_length_exceeded'))
      expect(c.kind).toBe('context-overflow')
    })

    it('JSON 解析错 → syntax 可重试', () => {
      const c = classifyError(new Error('Unexpected token } in JSON at position 42'))
      expect(c.kind).toBe('syntax')
      expect(c.retryable).toBe(true)
    })

    it('网络类错误 → transient', () => {
      for (const m of ['socket hang up', 'ECONNRESET', 'ETIMEDOUT', 'request timeout']) {
        expect(classifyError(new Error(m)).kind).toBe('transient')
      }
    })

    it('未知错误不重试 —— 宁可让用户看原始错误', () => {
      const c = classifyError(new Error('something weird happened'))
      expect(c.kind).toBe('unknown')
      expect(c.retryable).toBe(false)
    })
  })

  describe('Retry-After 解析', () => {
    it('从错误文本抽出重试等待时间', () => {
      const c = classifyError(new Error('HTTP 429: rate limited, retry-after: 5'))
      expect(c.retryAfterMs).toBe(5000)
    })
  })
})

describe('M3-B full-jitter 退避', () => {
  it('延迟落在 [0, min(base*2^n, cap)] 窗口内 —— 不是固定指数值', () => {
    for (let attempt = 1; attempt <= 5; attempt++) {
      for (let i = 0; i < 50; i++) {
        const d = computeBackoffDelay(attempt, DEFAULT_TEST_OPTS, Math.random)
        const cap = Math.min(1000 * Math.pow(2, attempt - 1), 30_000)
        expect(d).toBeGreaterThanOrEqual(0)
        expect(d).toBeLessThanOrEqual(cap)
      }
    }
  })

  it('不同随机源产生不同延迟 —— 纯指数退避做不到这点', () => {
    const a = computeBackoffDelay(1, DEFAULT_TEST_OPTS, () => 0.1)
    const b = computeBackoffDelay(1, DEFAULT_TEST_OPTS, () => 0.9)
    expect(a).not.toBe(b)
  })

  it('封顶:第 10 次也不超过 maxDelayMs', () => {
    const d = computeBackoffDelay(10, DEFAULT_TEST_OPTS, () => 0.999)
    expect(d).toBeLessThanOrEqual(30_000)
  })
})

const DEFAULT_TEST_OPTS: RetryPolicyOptions = {
  maxAttempts: 3, baseDelayMs: 1000, maxDelayMs: 30_000, backoffMultiplier: 2,
  failureThreshold: 5, recoveryTimeoutMs: 30_000, halfOpenMaxCalls: 3, successThreshold: 2,
}

describe('M3-B RetryPolicy', () => {
  it('可重试错误:重试到成功为止', async () => {
    const { waits, sleep } = mkSleep()
    let calls = 0
    const policy = new RetryPolicy({ sleep, random: () => 0.5 })
    const result = await policy.execute(async () => {
      calls++
      if (calls < 3) throw new Error('HTTP 503: service unavailable')
      return 'ok'
    })
    expect(result).toBe('ok')
    expect(calls).toBe(3)
    expect(waits).toHaveLength(2)   // 失败了 2 次 → 退避 2 次
  })

  it('不可重试错误:一次都不重试', async () => {
    const { waits, sleep } = mkSleep()
    let calls = 0
    const policy = new RetryPolicy({ sleep })
    await expect(policy.execute(async () => {
      calls++
      throw new Error('HTTP 400: bad request')
    })).rejects.toThrow()
    expect(calls).toBe(1)
    expect(waits).toHaveLength(0)
  })

  it('超过 maxAttempts 就停 —— 3 次尝试(含首次)', async () => {
    const { sleep } = mkSleep()
    let calls = 0
    const policy = new RetryPolicy({ sleep, maxAttempts: 3 })
    await expect(policy.execute(async () => {
      calls++
      throw new Error('HTTP 500: internal error')
    })).rejects.toThrow()
    expect(calls).toBe(3)
  })

  it('Retry-After 优先于本地退避', async () => {
    const { waits, sleep } = mkSleep()
    let calls = 0
    const policy = new RetryPolicy({ sleep, random: () => 0.01 })
    await policy.execute(async () => {
      calls++
      if (calls === 1) throw new Error('HTTP 429: rate limited, retry-after: 7')
      return 'ok'
    })
    // 服务端说等 7 秒,本地算出来的是 ~10ms —— 必须用服务端的
    expect(waits[0]).toBe(7000)
  })

  it('AbortError 不重试 —— 用户点停止不该被当成失败', async () => {
    const { waits, sleep } = mkSleep()
    let calls = 0
    const policy = new RetryPolicy({ sleep })
    const abortErr = new Error('aborted')
    abortErr.name = 'AbortError'
    await expect(policy.execute(async () => {
      calls++
      throw abortErr
    })).rejects.toThrow('aborted')
    expect(calls).toBe(1)
    expect(waits).toHaveLength(0)
  })

  it('AbortError 不计入熔断器统计', async () => {
    const { sleep } = mkSleep()
    const policy = new RetryPolicy({ sleep })
    const abortErr = new Error('aborted')
    abortErr.name = 'AbortError'
    for (let i = 0; i < 10; i++) {
      await policy.execute(async () => { throw abortErr }).catch(() => {})
    }
    expect(policy.breakerState().totalFailures).toBe(0)
  })
})

describe('M3-B CircuitBreaker', () => {
  it('连续失败达阈值后开闸', () => {
    const b = new CircuitBreaker({ ...DEFAULT_TEST_OPTS, failureThreshold: 3 })
    expect(b.canAttempt()).toBe(true)
    b.recordFailure(new Error('x'))
    b.recordFailure(new Error('x'))
    expect(b.canAttempt()).toBe(true)   // 还没到阈值
    b.recordFailure(new Error('x'))
    expect(b.snapshot().state).toBe('open')
    expect(b.canAttempt()).toBe(false)  // 已开闸
  })

  it('成功会重置连续失败计数', () => {
    const b = new CircuitBreaker({ ...DEFAULT_TEST_OPTS, failureThreshold: 3 })
    b.recordFailure(new Error('x'))
    b.recordFailure(new Error('x'))
    b.recordSuccess()
    b.recordFailure(new Error('x'))
    expect(b.snapshot().state).toBe('closed')   // 计数被重置,未达阈值
  })

  it('冷却期后进入 half_open 并放行探测', () => {
    const b = new CircuitBreaker({ ...DEFAULT_TEST_OPTS, failureThreshold: 1, recoveryTimeoutMs: 0 })
    b.recordFailure(new Error('x'))
    expect(b.snapshot().state).toBe('open')
    // recoveryTimeoutMs=0 → 立即可尝试
    expect(b.canAttempt()).toBe(true)
    expect(b.snapshot().state).toBe('half_open')
  })

  it('half_open 成功达到阈值才关闭', () => {
    const b = new CircuitBreaker({ ...DEFAULT_TEST_OPTS, failureThreshold: 1, recoveryTimeoutMs: 0, successThreshold: 2 })
    b.recordFailure(new Error('x'))
    b.canAttempt()                       // → half_open
    b.recordSuccess()
    expect(b.snapshot().state).toBe('half_open')   // 还没到 2 次
    b.recordSuccess()
    expect(b.snapshot().state).toBe('closed')
  })

  it('half_open 探测失败 → 立即回到 open', () => {
    const b = new CircuitBreaker({ ...DEFAULT_TEST_OPTS, failureThreshold: 1, recoveryTimeoutMs: 0 })
    b.recordFailure(new Error('x'))
    b.canAttempt()                       // → half_open
    b.recordFailure(new Error('x'))
    expect(b.snapshot().state).toBe('open')
  })

  it('reset() 手动复位', () => {
    const b = new CircuitBreaker({ ...DEFAULT_TEST_OPTS, failureThreshold: 1 })
    b.recordFailure(new Error('x'))
    expect(b.snapshot().state).toBe('open')
    b.reset()
    expect(b.snapshot().state).toBe('closed')
    expect(b.canAttempt()).toBe(true)
  })
})

describe('M3-B RetryPolicy 与熔断器协作', () => {
  it('熔断开闸后不再发起调用 —— 不浪费配额', async () => {
    const { sleep } = mkSleep()
    let calls = 0
    // failureThreshold=1:第一次失败即开闸
    const policy = new RetryPolicy({ sleep, maxAttempts: 3, failureThreshold: 1 })

    await policy.execute(async () => { calls++; throw new Error('HTTP 500: down') }).catch(() => {})
    expect(policy.breakerState().state).toBe('open')

    const before = calls
    // 熔断已开 → 直接失败,不再调用 fn
    await policy.execute(async () => { calls++; return 'should not happen' }).catch(() => {})
    expect(calls).toBe(before)
  })
})
