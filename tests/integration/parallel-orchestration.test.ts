/**
 * 【P3】真 brain 路径上的并行编排集成测试
 *
 * 不是直接调编排器：模型发起 parallel_subtasks tool_call →
 * brain 的 tool loop → delegate → spawn 真子 brain → 聚合结果回灌 → 最终答复。
 * 钉住"模型能用、子任务真跑、事件能到父 run"这条完整链。
 */
import { describe, it, expect, vi } from 'vitest'
import type { LlmStreamChunk } from '../../electron/llm/types'

vi.mock('../../electron/llm/LlmClient', () => ({
  LlmClient: {
    getInstance: () => ({
      streamChat: async function* (req: { messages?: Array<{ role: string; content: string }> }) {
        const all = (req.messages ?? []).map(m => String(m.content ?? '')).join('\n')
        if (all.includes('并行处理')) {
          // 父 run 第二轮：tool result 已回灌 → 给最终答复
          if (all.includes('并行子任务')) {
            yield { type: 'content', delta: '聚合完成', accumulated: '聚合完成' }
          } else {
            // 父 run 第一轮：让模型主动调 parallel_subtasks
            yield {
              type: 'tool_call',
              toolCall: {
                id: 'tc-parallel',
                function: {
                  name: 'parallel_subtasks',
                  arguments: JSON.stringify({ tasks: ['查 A', '查 B'] }),
                },
              },
            } as unknown as LlmStreamChunk
          }
        } else {
          // 子 run：收到的是自己的 instruction，而不是父对话
          yield { type: 'content', delta: '子结果已取得', accumulated: '子结果已取得' }
        }
        yield { type: 'done' }
      },
    }),
  },
}))

import { LlmAgentBrain, LlmAgentBrainEvents, type LlmAgentEvent } from '../../electron/agent/LlmAgentBrain'

describe('多 agent 并行编排（真 brain 路径）', () => {
  it('IT-1: 模型调 parallel_subtasks → 子任务真执行 → 聚合结果回灌最终答复', async () => {
    const events: LlmAgentEvent[] = []
    const unsub = LlmAgentBrainEvents.subscribe(e => events.push(e))
    try {
      const r = await LlmAgentBrain.getInstance().run('并行处理', {
        runId: 'run-integration',
        maxIterations: 3,
        contextKind: 'ui',
      })
      expect(r.content).toContain('聚合完成')

      expect(events.filter(e => e.type === 'subtask.started')).toHaveLength(2)
      expect(events.filter(e => e.type === 'subtask.done')).toHaveLength(2)
      // 所有编排事件都挂父 runId —— 否则 AgentEventRelay 会因为它们没有会话归属而静默丢弃
      const subtaskEvents = events.filter(e => e.type.startsWith('subtask.'))
      expect(subtaskEvents.length).toBeGreaterThan(0)
      expect(subtaskEvents.every(e => e.runId === 'run-integration')).toBe(true)

      const aggregated = subtaskEvents.find(e => e.type === 'subtask.aggregated') as unknown as { okCount: number; failedCount: number }
      expect(aggregated.okCount).toBe(2)
      expect(aggregated.failedCount).toBe(0)

      const toolResult = events.find(e => e.type === 'tool_result' && e.name === 'parallel_subtasks') as unknown as { result: string; ok: boolean }
      expect(toolResult.ok).toBe(true)
      expect(toolResult.result).toContain('查 A')
      expect(toolResult.result).toContain('子结果已取得')
    } finally {
      unsub()
    }
  })

  it('IT-2: 工具出现在 LLM 可见的工具表里', async () => {
    const tools = await LlmAgentBrain.getInstance().listTools()
    expect(tools.map(t => t.name)).toContain('parallel_subtasks')
  })
})
