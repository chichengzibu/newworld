import { describe, it, expect, beforeEach, vi } from 'vitest'

vi.mock('electron', () => ({
  app: { getPath: () => '/tmp', getAppPath: () => '/tmp', getVersion: () => '0.0.0', getName: () => 'newworld' },
  ipcMain: { handle: () => {}, on: () => {}, removeHandler: () => {} },
  BrowserWindow: class {},
  safeStorage: { isEncryptionAvailable: () => false, encryptString: (s: string) => Buffer.from(s), decryptString: (b: Buffer) => b.toString() },
  dialog: { showMessageBox: () => {}, showOpenDialog: () => {} },
  shell: { openExternal: () => {}, openPath: () => {} },
  globalShortcut: { register: () => true, unregister: () => {} },
  Menu: { buildFromTemplate: () => ({}), setApplicationMenu: () => {} },
  Tray: class { setToolTip() {} setContextMenu() {} on() {} },
  screen: { getPrimaryDisplay: () => ({ workAreaSize: { width: 1920, height: 1080 } }) },
}))

vi.mock('electron-log', () => ({
  default: { info: () => {}, warn: () => {}, error: () => {}, debug: () => {}, transports: { file: { resolvePathFn: () => {}, maxSize: 0, format: '' }, console: { level: 'info' } } },
}))

/**
 * P3-T3.4: 错误恢复
 *
 * 验证 ErrorClassifier + RetryPolicy + AgentRecovery 的错误恢复链路:
 * - classifyError 正确分类各种错误
 * - RetryPolicy 按 backoff 策略重试
 * - 重试 3 次后还失败,抛出可读错误
 */

import { classifyError } from '../../electron/agent/ErrorClassifier'
import { RetryPolicy, computeBackoffDelay } from '../../electron/agent/RetryPolicy'

describe('P3-T3.4: ErrorClassifier 错误分类', () => {
  it('permission/forbidden/unauthorized → permission 不可重试', () => {
    expect(classifyError(new Error('forbidden')).kind).toBe('permission')
    expect(classifyError(new Error('unauthorized')).retryable).toBe(false)
    expect(classifyError('Permission denied').kind).toBe('permission')
  })

  it('rate/429/quota → rate-limit 可重试', () => {
    expect(classifyError(new Error('rate limit exceeded')).kind).toBe('rate-limit')
    expect(classifyError(new Error('HTTP 429')).retryable).toBe(true)
    expect(classifyError(new Error('quota exceeded')).hint).toContain('backoff')
  })

  it('context overflow / token limit → context-overflow 可重试', () => {
    expect(classifyError(new Error('context length exceeded')).kind).toBe('context-overflow')
    expect(classifyError(new Error('token limit')).retryable).toBe(true)
  })

  it('json/parse/syntax → syntax 可重试(LLM 输出格式错)', () => {
    expect(classifyError(new Error('json parse error')).kind).toBe('syntax')
    expect(classifyError(new Error('syntax error in line 5')).retryable).toBe(true)
  })

  it('timeout/econnreset/network/503 → transient 可重试', () => {
    expect(classifyError(new Error('timeout')).kind).toBe('transient')
    expect(classifyError(new Error('ECONNRESET')).kind).toBe('transient')
    expect(classifyError(new Error('network error')).retryable).toBe(true)
    expect(classifyError(new Error('HTTP 503')).retryable).toBe(true)
  })

  it('400/404/422 → permanent 不可重试', () => {
    expect(classifyError(new Error('HTTP 400')).kind).toBe('permanent')
    expect(classifyError(new Error('404 not found')).retryable).toBe(false)
    expect(classifyError(new Error('422 unprocessable')).kind).toBe('permanent')
  })

  it('未知错误 → unknown 不重试,需人工确认', () => {
    const result = classifyError(new Error('something weird happened'))
    expect(result.kind).toBe('unknown')
    expect(result.retryable).toBe(false)
    expect(result.hint).toContain('人工')
  })

  it('所有分类都返回 hint 字段(可读错误信息)', () => {
    const errors = [
      new Error('permission denied'),
      new Error('rate limit'),
      new Error('context overflow'),
      new Error('json parse'),
      new Error('timeout'),
      new Error('HTTP 400'),
      new Error('weird error'),
    ]
    for (const e of errors) {
      const r = classifyError(e)
      expect(r.hint, `should have hint for ${e.message}`).toBeTruthy()
      expect(r.hint.length).toBeGreaterThan(0)
    }
  })
})

describe('P3-T3.4: RetryPolicy 重试', () => {
  beforeEach(() => {
    vi.useRealTimers()
  })

  it('成功执行:不重试,返回结果', async () => {
    const policy = new RetryPolicy({ maxAttempts: 3, baseDelayMs: 10, backoffMultiplier: 2 })
    let calls = 0
    const result = await policy.execute(async () => {
      calls += 1
      return 'ok'
    })
    expect(result).toBe('ok')
    expect(calls).toBe(1)
  })

  it('失败 2 次后成功:执行 3 次,最后成功', async () => {
    const policy = new RetryPolicy({ maxAttempts: 3, baseDelayMs: 5, backoffMultiplier: 2 })
    let calls = 0
    const result = await policy.execute(async () => {
      calls += 1
      if (calls < 3) throw new Error('rate limit exceeded')
      return 'ok-after-retry'
    })
    expect(result).toBe('ok-after-retry')
    expect(calls).toBe(3)
  })

  it('失败 maxAttempts 次后抛错(retryable error)', async () => {
    const policy = new RetryPolicy({ maxAttempts: 3, baseDelayMs: 5, backoffMultiplier: 2 })
    let calls = 0
    await expect(
      policy.execute(async () => {
        calls += 1
        throw new Error('timeout')  // 触发 transient → retryable
      }),
    ).rejects.toThrow('timeout')
    expect(calls).toBe(3) // 试了 3 次
  })

  it('重试间隔在指数窗口内(full jitter)', async () => {
    // 【M3-B 语义变更】退避从"纯指数值"改为"full jitter":
    //   delay = random(0, min(base * multiplier^attempt, cap))
    // 理由(业界实测):200 agent 规模下,纯指数退避会让重试聚成固定时间桶,
    // retry storm 原样保留;full jitter 在整个窗口内均匀散开,尾延迟最优。
    // 因此断言从"间隔必须 ≥ 指数值"改为"间隔必须落在指数窗口内"。
    //
    // 【M4-B 修正 — 断言对象改了】
    // 原版用【墙钟】量间隔(两次 execute 调用之间的 Date.now() 差),
    // 在 Windows 上必然失败:系统时钟粒度 ~15.6ms,请求 5ms 的 setTimeout
    // 实际 ~12-18ms 才回调,于是 delays[0]=12 > 断言上限 10。
    // 这测的是"操作系统定时器精度",不是"退避策略对不对"—— 测错了对象。
    //
    // 现在分两层:
    //   ① 策略层(确定性,主断言):注入 sleep 捕获【请求的退避时长】,
    //      断言它落在各自的 jitter 窗口内。这才是被测对象。
    //   ② 计时层(真实 setTimeout,宽松上界):确认真睡了一会儿,
    //      上界按 OS 定时器粒度留足余量。
    const baseDelayMs = 10
    const backoffMultiplier = 3
    const requested: number[] = []
    const policy = new RetryPolicy({
      maxAttempts: 3, baseDelayMs, backoffMultiplier,
      // 固定随机源 → 确定性:window 内的中点
      random: () => 0.5,
      // 注入 sleep:只记录请求的时长,不真等 → 断言与 OS 定时器无关
      sleep: async (ms: number) => { requested.push(ms) },
    })
    let calls = 0
    try {
      await policy.execute(async () => {
        calls += 1
        throw new Error('rate limit')  // retryable
      })
    } catch {
      // expected
    }
    expect(calls).toBe(3)
    expect(requested.length).toBe(2)
    // 第 1 次退避窗口 = 10*3^0 = 10ms,随机 0.5 → 5ms
    // 第 2 次退避窗口 = 10*3^1 = 30ms,随机 0.5 → 15ms
    expect(requested[0]).toBe(5)
    expect(requested[1]).toBe(15)
    // 关键:full jitter 下第二次仍可能大于第一次(窗口更大),
    // 但两次都必须落在各自窗口内 —— 这正是与纯指数的本质区别
    expect(requested[0]).toBeGreaterThanOrEqual(0)
    expect(requested[0]).toBeLessThan(baseDelayMs)
    expect(requested[1]).toBeLessThan(baseDelayMs * backoffMultiplier)
  })

  it('computeBackoffDelay:延迟恒落在 [0, 窗口) 内且随窗口增长', () => {
    // 【M4-B 新增】纯函数,穷举断言 —— 这是退避策略的真正不变量。
    // 旧版只在一个随机值(0.5)上验证,漏掉了:
    //   - random()=0 → 延迟 0(可能引发紧循环重试)
    //   - random() 接近 1 → 延迟逼近窗口上界
    //   - 窗口被 maxDelayMs 截断
    const opts = { baseDelayMs: 10, backoffMultiplier: 3, maxDelayMs: 1000 }
    // random=0 → 窗口左端点
    expect(computeBackoffDelay(1, opts, () => 0)).toBe(0)
    // random→1 → 逼近窗口上界但【不越界】
    expect(computeBackoffDelay(1, opts, () => 0.999)).toBeLessThan(10)
    // 第 n 次尝试的窗口 = base * multiplier^(n-1)
    expect(computeBackoffDelay(2, opts, () => 0.5)).toBe(15)  // 10*3^1=30 → 15
    expect(computeBackoffDelay(3, opts, () => 0.5)).toBe(45)  // 10*3^2=90 → 45
    // 窗口超过 maxDelayMs 时被截断
    expect(computeBackoffDelay(1, { ...opts, maxDelayMs: 5 }, () => 0.5)).toBe(2)
    // 穷举:任意随机值下延迟都不越界(100 个采样点)
    for (let i = 0; i < 100; i++) {
      const r = i / 100
      const d = computeBackoffDelay(3, opts, () => r)
      expect(d).toBeGreaterThanOrEqual(0)
      expect(d).toBeLessThan(90)
    }
  })

  it('真实 sleep:确实等了(上界按 OS 定时器粒度放宽)', async () => {
    // 【M4-B 新增】确认真实路径也走 setTimeout —— 注入 sleep 绕过了它,
    // 若默认 sleep 坏掉(比如永远 resolve),上面两条测试仍会绿。
    //
    // 【注意 random 必须钉死】full jitter 的延迟是 random(0, 窗口),
    // 不钉死的话延迟可能是 0ms → 断言随机挂。钉 random=0.5 → 延迟 = 50ms。
    // 下界给 40ms(容一次早触发),上界给 250ms:
    // Windows 定时器粒度 ~15.6ms,请求 50ms 实测 ~50-70ms。
    const policy = new RetryPolicy({
      maxAttempts: 2, baseDelayMs: 100, backoffMultiplier: 2,
      random: () => 0.5,   // → 延迟 = floor(0.5 * 100) = 50ms
    })
    const t0 = Date.now()
    await policy.execute(async () => { throw new Error('timeout') }).catch(() => {})
    const elapsed = Date.now() - t0
    expect(elapsed).toBeGreaterThanOrEqual(40)  // 至少等了个大概
    expect(elapsed).toBeLessThan(250)          // 没等成天
  })
})
