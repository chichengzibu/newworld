/**
 * 【P3】parallel_subtasks 工具契约 —— 参数校验 + 显式委派 + 无上下文不伪造结果
 */
import { describe, it, expect, vi } from 'vitest'
import { ParallelSubtasksTool } from '../../electron/agent/tools/ParallelSubtasksTool'

describe('parallel_subtasks 工具', () => {
  const tool = new ParallelSubtasksTool()

  it('PT-1: 拒绝空数组 / 超量 / 非字符串', async () => {
    expect((await tool.execute({ tasks: [] })).ok).toBe(false)
    expect((await tool.execute({ tasks: Array(6).fill('x') })).ok).toBe(false)
    expect((await tool.execute({ tasks: ['ok', 42] })).ok).toBe(false)
  })

  it('PT-2: 无委派上下文时明确拒绝，不返回假结果', async () => {
    const r = await tool.execute({ tasks: ['a'] })
    expect(r.ok).toBe(false)
    expect(r.error).toContain('未提供并行编排上下文')
  })

  it('PT-3: 通过 ctx.delegate 委派，指令被 trim 后原样下传', async () => {
    const delegate = vi.fn(async () => ({ ok: true, result: 'delegated' }))
    const r = await tool.execute({ tasks: ['  查 A  ', '查 B'] }, { contextKind: 'ui', delegate })
    expect(delegate).toHaveBeenCalledWith(['查 A', '查 B'])
    expect(r).toEqual({ ok: true, result: 'delegated' })
  })
})
