/**
 * PiPiClaw - #005 spawn 章 (R1 独立实例 + R2 深度封顶 + R3 单例保留 + 预算隔离 + 快照溯源)
 *
 * ═══ 被测机制（LlmAgentBrain.spawn 重写 + run 预算/快照扩展）═══
 *   R1: spawn 返回【新 LlmAgentBrain 实例】(独立 tools/runs), 禁 `brain: this` 自引用 (旧 stub 债已删)
 *   R2: MAX_SPAWN_DEPTH=1 — 子实例(带 spawnCtx)再 spawn → throw SpawnDepthExceeded (非静默降级)
 *   R3: getInstance() 单例保留 (main.ts:217 依赖); 子实例一律 create() 工厂
 *   ④: run opts.maxTokens 预算刹车 — usage 聚合, 超限停 tool 循环取最后 assistant 为 final + run_error
 *   ⑥: 子 run 快照 checkpoint 事件带 parentRunId (子继承 spawnCtx.checkpointHook, 同一 append-only 流)
 *   Step 0 机制承载: 子 contextKind 显式继承 (禁模块态, 全局态已删)
 *
 * ═══ SP-1..6 断言 ═══
 *   SP-1 独立性: parent !== sub; 子/父 tools 同源 BUILTIN_TOOLS (同引用); runs Map 各自独立
 *   SP-2 深度封顶: 父(单例) spawn 成功; 子再 spawn → throw; 缺 parentCtx → throw
 *   SP-3 contextKind 继承: spawn(parentCtx.contextKind=im_inbound) → 子 run → execCommand params.contextKind==='im_inbound'
 *   SP-4 并发互染免疫: 两实例各 ui / scheduler → 各自 execCommand 收到各自值 (无全局共享/串线)
 *   SP-5 预算隔离: run maxTokens=5 → run_error(budget)+取最后 assistant; run maxTokens=10000 → 不刹
 *   SP-6 快照溯源: 子 run checkpoint 事件 parentRunId = spawn 传入的父 runId
 *
 * ═══ 探针策略 ═══
 *   - execCommand 整体 mock (探针): 记录 params.contextKind + 返回成功 (不查名单/不弹窗)
 *   - LlmClient.streamChat 脚本化: n=1,2 轮 → tool_call(Bash node)+usage(10); n≥3 轮 → final
 *   - 断言"子收到哪个 contextKind / 是否触发预算 / 快照 parentRunId" 全靠显式探针, 不依赖模块态 (不存在了)
 */
import { describe, it, expect } from 'vitest'
import { vi } from 'vitest'
import type { LlmStreamChunk } from '../../electron/llm/types'

// ── 探针 hoist (vi.mock 因子引用需要) ──────────────────────────────────────
const execProbe = vi.hoisted(() => ({ calls: [] as Array<Record<string, unknown>>, reset: () => { execProbe.calls.length = 0 } }))
const llmCounter = vi.hoisted(() => ({ n: 0, reset: () => { llmCounter.n = 0 } }))

// 探针 execCommand: 记录 params, 返回成功 (不查名单/不弹窗/不审计)
vi.mock('../../electron/agent/tools/commandDecide', () => ({
  execCommand: (async (params: Record<string, unknown>) => {
    execProbe.calls.push(params)
    return { ok: true, exitCode: 0, stdout: 'probe-ok', stderr: '' }
  }) as (p: Record<string, unknown>) => Promise<{ ok: boolean; exitCode: number; stdout: string; stderr: string }>,
}))

// 脚本化 LLM: 前 2 轮 tool_call + usage(10), 第 3 轮起 final
vi.mock('../../electron/llm/LlmClient', () => ({
  LlmClient: {
    getInstance: () => ({
      streamChat: (async function* (): AsyncGenerator<LlmStreamChunk> {
        const n = ++llmCounter.n
        yield { type: 'content', delta: `iter${n}`, accumulated: `iter${n}` }
        if (n <= 2) {
          yield { type: 'tool_call', toolCall: { id: `tc${n}`, function: { name: 'Bash', arguments: JSON.stringify({ command: 'node', args: ['-e', 'x'] }) } } } as unknown as LlmStreamChunk
          yield { type: 'usage', usage: { prompt: 5, completion: 5, totalTokens: 10 } } as unknown as LlmStreamChunk
        }
      }) as unknown as (req: unknown, signal: unknown) => AsyncGenerator<LlmStreamChunk>,
    }),
  },
}))

import { LlmAgentBrain, LlmAgentBrainEvents } from '../../electron/agent/LlmAgentBrain'
import { BUILTIN_TOOLS } from '../../electron/agent/tools'

describe('#005 spawn 章 (R1 独立 + R2 深度 + 预算 + 快照溯源)', () => {
  it('SP-1 独立性: spawn 返回新实例 (非 brain:this); 子/父 tools 同源 BUILTIN_TOOLS; runs Map 各自独立', async () => {
    const parent = LlmAgentBrain.getInstance()
    const child = await parent.spawn({ instruction: 'sub task' }, { parentRunId: 'run-p1' })
    // R1: 非自引用
    expect(child.brain).not.toBe(parent)
    expect(child.brain).toBeInstanceOf(LlmAgentBrain)
    // 同源性: 子实例 tools.get('Bash') === BUILTIN_TOOLS 里同一个 Bash 实例 (零提权, 同注册表)
    const bash = BUILTIN_TOOLS.find((t) => t.metadata.name === 'Bash')
    expect((parent as unknown as { tools: Map<string, unknown> }).tools.get('Bash')).toBe(bash)
    expect((child.brain as unknown as { tools: Map<string, unknown> }).tools.get('Bash')).toBe(bash)
    // runs Map 独立 (同注册表 ≠ 同实例状态)
    expect((parent as unknown as { runs: Map<unknown, unknown> }).runs).not.toBe((child.brain as unknown as { runs: Map<unknown, unknown> }).runs)
    // 子实例带出生上下文 (深度1), 父(单例)不带
    expect((child.brain as unknown as { spawnCtx?: { depth: number } }).spawnCtx?.depth).toBe(1)
    expect((parent as unknown as { spawnCtx?: unknown }).spawnCtx).toBeUndefined()
  })

  it('SP-2 深度封顶: 子实例再 spawn → throw (非静默); 缺 parentCtx → throw', async () => {
    const parent = LlmAgentBrain.getInstance()
    const child = await parent.spawn({ instruction: 'sub task' }, { parentRunId: 'run-p2' })
    // 子 (spawnCtx 已设) 再 spawn → 抛 SpawnDepthExceeded
    await expect((child.brain as LlmAgentBrain).spawn({ instruction: 'grandchild' }, { parentRunId: 'run-p3' }))
      .rejects.toThrow(/深度超限|MAX_SPAWN_DEPTH/)
    // 缺 parentCtx 也抛 (显式强制)
    await expect(parent.spawn({ instruction: 'x' })).rejects.toThrow(/parentCtx/)
  })

  it('SP-3 contextKind 继承: spawn(parentCtx.contextKind=im_inbound) → 子 run → execCommand params.contextKind=im_inbound', async () => {
    llmCounter.reset(); execProbe.reset()
    const parent = LlmAgentBrain.getInstance()
    const child = await parent.spawn({ instruction: 'sub' }, { parentRunId: 'run-p3', contextKind: 'im_inbound' })
    await (child.brain as LlmAgentBrain).run('probe', { conversationId: 'c' } as never)
    expect(execProbe.calls.length).toBeGreaterThan(0)
    // 全部 execCommand 调用收到的 contextKind 都应是 im_inbound (继承自 spawnCtx, 无脑内自派生)
    expect(execProbe.calls.every((c) => c.contextKind === 'im_inbound')).toBe(true)
  })

  it('SP-4 并发互染免疫: 两实例各自 ui / scheduler → 各自 execCommand 收各自值 (无串线)', async () => {
    llmCounter.reset()
    const parent = LlmAgentBrain.getInstance()
    const a = await parent.spawn({ instruction: 'a' }, { parentRunId: 'r', contextKind: 'ui' })
    const b = await parent.spawn({ instruction: 'b' }, { parentRunId: 'r', contextKind: 'scheduler' })
    // 跑 a: 应全收 ui
    llmCounter.reset(); execProbe.reset()
    await (a.brain as LlmAgentBrain).run('pa', { conversationId: 'c' } as never)
    const aKinds = execProbe.calls.map((c) => c.contextKind)
    expect(aKinds.length).toBeGreaterThan(0)
    expect(aKinds.every((k) => k === 'ui')).toBe(true)
    // 跑 b: 应全收 scheduler (不被 a 的 ui 串染)
    llmCounter.reset(); execProbe.reset()
    await (b.brain as LlmAgentBrain).run('pb', { conversationId: 'c' } as never)
    const bKinds = execProbe.calls.map((c) => c.contextKind)
    expect(bKinds.length).toBeGreaterThan(0)
    expect(bKinds.every((k) => k === 'scheduler')).toBe(true)
  })

  it('SP-5 预算隔离: run maxTokens=5 → run_error(budget)+降级 final; run maxTokens=10000 → 不刹 (独立 budget)', async () => {
    const parent = LlmAgentBrain.getInstance()
    // (a) 小预算 → 触发刹车: 第 1 轮 usage=10 后总=10>=5, 第 2 轮顶判停, iterations=1, run_error(budget), final 取最后 assistant
    llmCounter.reset(); execProbe.reset()
    let gotBudgetErr = false
    let unsub: (() => void) | undefined
    unsub = LlmAgentBrainEvents.subscribe((e) => {
      if (e && (e as { type: string }).type === 'run_error' && /budget/i.test((e as { error?: string }).error ?? '')) gotBudgetErr = true
    })!
    let iterations = 0
    try {
      const r = await (parent as LlmAgentBrain).run('p', { maxTokens: 5, conversationId: 'c' } as never)
      expect(r.content).not.toBe('') // 降级到 final (最后 assistant content)
    } finally { unsub?.() }
    expect(gotBudgetErr).toBe(true)

    // (b) 大预算 → 不刹: 跑满工具轮 + final, 无 budget run_error
    llmCounter.reset(); execProbe.reset()
    gotBudgetErr = false
    unsub = LlmAgentBrainEvents.subscribe((e) => {
      if (e && (e as { type: string }).type === 'run_error' && /budget/i.test((e as { error?: string }).error ?? '')) gotBudgetErr = true
    })!
    try {
      const r = await (parent as LlmAgentBrain).run('p', { maxTokens: 10000, conversationId: 'c' } as never)
      expect(r.content).not.toBe('')
    } finally { unsub?.() }
    expect(gotBudgetErr).toBe(false)
  })

  it('SP-6 快照 parentRunId: 子 run 所有 checkpoint 事件 parentRunId = spawn 传入的父 runId', async () => {
    llmCounter.reset(); execProbe.reset()
    const parent = LlmAgentBrain.getInstance()
    const parentRunId = 'run-parent-777'
    // 给子一个 append sink (继承进 spawnCtx.checkpointHook), run 时不显式传 opts.checkpoint → 走继承
    const sink: unknown[] = []
    const child = await parent.spawn({ instruction: 'sub' }, { parentRunId, checkpoint: (e) => sink.push(e) } as never)
    await (child.brain as LlmAgentBrain).run('probe', { conversationId: 'c' } as never)
    // 至少一个快照事件, 其 parentRunId = 父 runId
    const snaps = sink.filter((e) => e && (e as { type: string }).type === 'run.snapshot') as Array<{ parentRunId?: string }>
    expect(snaps.length).toBeGreaterThan(0)
    expect(snaps.every((s) => s.parentRunId === parentRunId)).toBe(true)
    // status 事件也带 parentRunId
    const statuses = sink.filter((e) => e && (e as { type: string }).type === 'run.status') as Array<{ parentRunId?: string }>
    if (statuses.length > 0) expect(statuses.every((s) => s.parentRunId === parentRunId)).toBe(true)
  })
})
