import { describe, it, expect, beforeEach, vi } from 'vitest'

vi.mock('electron', () => ({
  app: { getPath: () => '/tmp', getAppPath: () => '/tmp', getVersion: () => '0.0.0', getName: () => 'pipiclaw' },
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
import { RetryPolicy } from '../../electron/agent/RetryPolicy'

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
    const baseDelayMs = 10
    const backoffMultiplier = 3
    const policy = new RetryPolicy({
      maxAttempts: 3, baseDelayMs, backoffMultiplier,
      // 固定随机源 → 确定性:window 内的中点
      random: () => 0.5,
    })
    const delays: number[] = []
    let lastT = Date.now()
    let calls = 0
    try {
      await policy.execute(async () => {
        const now = Date.now()
        if (calls > 0) delays.push(now - lastT)
        lastT = now
        calls += 1
        throw new Error('rate limit')  // retryable
      })
    } catch {
      // expected
    }
    expect(calls).toBe(3)
    expect(delays.length).toBe(2)
    // 第 1 次退避窗口 = 10*3^0 = 10ms,随机 0.5 → 期望 ~5ms
    // 第 2 次退避窗口 = 10*3^1 = 30ms,随机 0.5 → 期望 ~15ms
    // 计时精度有限,放宽到窗口的一半以下即可
    expect(delays[0]).toBeGreaterThanOrEqual(1)
    expect(delays[0]).toBeLessThanOrEqual(10)
    expect(delays[1]).toBeGreaterThanOrEqual(1)
    expect(delays[1]).toBeLessThanOrEqual(30)
    // 关键:full jitter 下第二次仍可能大于第一次(窗口更大),
    // 但两次都必须落在各自窗口内 —— 这正是与纯指数的本质区别
  })
})
