/**
 * 【P2】Orb 精确 usage 的思考 token 维度
 */
import { describe, it, expect, beforeEach } from 'vitest'
import { setActivePinia, createPinia } from 'pinia'
import { useOrbStore } from '../../src/stores/orb'

describe('Orb 精确 usage / 思考 token', () => {
  beforeEach(() => {
    setActivePinia(createPinia())
  })

  it('provider 回传时记录真实思考 token', () => {
    const orb = useOrbStore()
    orb.setExactUsage({
      promptTokens: 100,
      completionTokens: 50,
      totalTokens: 150,
      model: 'qwen3',
      reasoningTokens: 37,
    })
    expect(orb.exactReasoningTokens).toBe(37)
  })

  it('未回传时清零，不残留上一轮（换 provider / 换模型场景）', () => {
    const orb = useOrbStore()
    orb.setExactUsage({ promptTokens: 10, completionTokens: 5, totalTokens: 15, reasoningTokens: 20 })
    orb.setExactUsage({ promptTokens: 10, completionTokens: 5, totalTokens: 15 })
    expect(orb.exactReasoningTokens).toBe(0)
  })
})
