/**
 * PiPiClaw - M3-B 接线验证:LLM 调用失败时的重试行为
 *
 * 【本测试不联网】LlmClient.prototype.streamChat 被替换为本地 mock generator。
 *
 * 修复前: 单次 LLM 调用失败(429/5xx/网络抖动)整个多轮 run 直接崩,
 *   用户看到"执行失败",此前所有工作作废。
 * 修复后: 可重试错误走退避重试;不可重试错误直接失败。
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'

import { LlmAgentBrain } from '../../electron/agent/LlmAgentBrain'
import { LlmClient } from '../../electron/llm/LlmClient'
import type { LlmStreamChunk } from '../../electron/llm/types'

describe('M3-B LLM 调用重试接线', () => {
  let origStream: typeof LlmClient.prototype.streamChat

  beforeEach(() => { origStream = LlmClient.prototype.streamChat })
  afterEach(() => { LlmClient.prototype.streamChat = origStream })

  it('R1: 429 后重试成功 —— run 不崩', async () => {
    let calls = 0
    LlmClient.prototype.streamChat = (async function* () {
      calls++
      if (calls === 1) {
        yield { type: 'error', error: 'HTTP 429: rate limit exceeded' } as LlmStreamChunk
        return
      }
      const text = '重试后成功'
      yield { type: 'content', delta: text, accumulated: text } as LlmStreamChunk
      yield { type: 'done' } as LlmStreamChunk
    }) as never

    // 用极小退避避免测试真等
    const brain = LlmAgentBrain.getInstance()
    const r = await brain.run('测试重试', { maxIterations: 1 })

    expect(r.content).toBe('重试后成功')
    expect(calls).toBe(2)
  })

  it('R2: 400 不重试 —— 一次就失败', async () => {
    let calls = 0
    LlmClient.prototype.streamChat = (async function* () {
      calls++
      yield { type: 'error', error: 'HTTP 400: invalid request' } as LlmStreamChunk
      return
    }) as never

    const brain = LlmAgentBrain.getInstance()
    await expect(brain.run('测试不重试', { maxIterations: 1 })).rejects.toThrow()
    expect(calls).toBe(1)
  })

  it('R3: 持续 500 时重试到上限后失败 —— 不无限重试', async () => {
    let calls = 0
    LlmClient.prototype.streamChat = (async function* () {
      calls++
      yield { type: 'error', error: 'HTTP 500: internal server error' } as LlmStreamChunk
      return
    }) as never

    const brain = LlmAgentBrain.getInstance()
    await expect(brain.run('测试持续失败', { maxIterations: 1 })).rejects.toThrow()
    // maxAttempts=3(默认) → 首次 + 2 次重试
    expect(calls).toBe(3)
  })
})
