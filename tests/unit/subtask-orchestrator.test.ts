/**
 * 【P3】并行子任务编排器单测
 *
 * 钉住四件真事：真并发（且有上限）、失败隔离、取消级联、事件归属父 runId。
 * 这里用可控的假子 brain 验证编排器本身；真 brain 的接线在集成测试里覆盖。
 */
import { describe, it, expect, vi } from 'vitest'
import { orchestrateSubtasks, MAX_PARALLEL_SUBTASKS } from '../../electron/agent/SubtaskOrchestrator'
import type { LlmAgentBrain, LlmAgentEvent } from '../../electron/agent/LlmAgentBrain'

interface FakeChild {
  id: string
  run: ReturnType<typeof vi.fn>
  abortRun: ReturnType<typeof vi.fn>
}

function makeParent(handler: (instruction: string, index: number) => Promise<{ content: string; totalTokens: number }>) {
  const children: FakeChild[] = []
  const parent = {
    spawn: vi.fn(async (subtask: { instruction: string }) => {
      const index = children.length
      const child: FakeChild = {
        id: `sub-${index}`,
        run: vi.fn(async (prompt: string) => handler(prompt, index)),
        abortRun: vi.fn(() => true),
      }
      children.push(child)
      return { id: `handle-${index}`, brain: child }
    }),
  } as unknown as LlmAgentBrain
  return { parent, children }
}

function makeCtx(overrides: Partial<{ signal: AbortSignal; concurrency: number }> = {}) {
  const events: LlmAgentEvent[] = []
  return {
    events,
    ctx: {
      parentRunId: 'run-parent',
      instructions: [],
      emit: (e: LlmAgentEvent) => events.push(e),
      ...overrides,
    },
  }
}

describe('并行子任务编排器', () => {
  it('OR-1: 全部成功 → 聚合结果含每条指令，事件挂父 runId', async () => {
    const { parent, children } = makeParent(async (prompt) => ({ content: `answer:${prompt}`, totalTokens: 7 }))
    const { ctx, events } = makeCtx()
    const result = await orchestrateSubtasks({ ...ctx, parent, instructions: ['查 A', '查 B'] })
    expect(children).toHaveLength(2)
    expect(children[0].run).toHaveBeenCalledWith('查 A', expect.objectContaining({ runId: 'run-parent-child-0', parentRunId: 'run-parent' }))
    expect(result.ok).toBe(true)
    expect(result.result).toContain('成功 2')
    expect(result.result).toContain('answer:查 A')
    expect(events.every(e => e.runId === 'run-parent')).toBe(true)
    expect(events.some(e => e.type === 'subtask.aggregated')).toBe(true)
  })

  it('OR-2: 并发有上限，不会一次把 5 个子任务全铺开', async () => {
    let active = 0
    let maxActive = 0
    const { parent } = makeParent(async () => {
      active++
      maxActive = Math.max(maxActive, active)
      await new Promise(resolve => setTimeout(resolve, 15))
      active--
      return { content: 'ok', totalTokens: 1 }
    })
    const { ctx } = makeCtx({ concurrency: 2 })
    const result = await orchestrateSubtasks({
      ...ctx,
      parent,
      instructions: ['1', '2', '3', '4', '5'],
    })
    expect(maxActive).toBe(2)
    expect(result.result).toContain('成功 5')
  })

  it('OR-3: 单个子任务失败被隔离，其余结果仍回灌', async () => {
    const { parent } = makeParent(async (prompt) => {
      if (prompt === '坏任务') throw new Error('子任务炸了')
      return { content: `好结果:${prompt}`, totalTokens: 3 }
    })
    const { ctx, events } = makeCtx()
    const result = await orchestrateSubtasks({
      ...ctx,
      parent,
      instructions: ['好任务', '坏任务', '另一个好任务'],
    })
    expect(result.ok).toBe(true)
    expect(result.result).toContain('失败 1')
    expect(result.result).toContain('子任务炸了')
    expect(result.result).toContain('好结果:另一个好任务')
    expect(events.filter(e => e.type === 'subtask.failed')).toHaveLength(1)
  })

  it('OR-4: 父 run 取消 → 已启动子任务被 abort，剩余不再启动', async () => {
    const controller = new AbortController()
    const { parent, children } = makeParent(async () => {
      await new Promise(resolve => setTimeout(resolve, 20))
      return { content: 'ok', totalTokens: 1 }
    })
    const { ctx } = makeCtx({ signal: controller.signal, concurrency: 1 })
    const p = orchestrateSubtasks({
      ...ctx,
      parent,
      instructions: ['1', '2', '3', '4'],
    })
    await new Promise(resolve => setTimeout(resolve, 5))
    controller.abort()
    const result = await p
    expect(result.ok).toBe(false)
    expect(result.error).toContain('已取消')
    expect(children.length).toBeLessThan(4)
    expect(children[0].abortRun).toHaveBeenCalledWith('run-parent-child-0')
  })

  it('OR-5: 空任务与超量任务按契约拒绝/截断', async () => {
    const { parent } = makeParent(async () => ({ content: 'ok', totalTokens: 1 }))
    const empty = await orchestrateSubtasks({ ...makeCtx().ctx, parent, instructions: ['  ', ''] })
    expect(empty.ok).toBe(false)
    const many = Array.from({ length: MAX_PARALLEL_SUBTASKS + 3 }, (_, i) => `t${i}`)
    const result = await orchestrateSubtasks({ ...makeCtx().ctx, parent, instructions: many })
    expect(result.result).toContain(`并行子任务 ${MAX_PARALLEL_SUBTASKS} 个`)
  })
})
