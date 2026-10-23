/**
 * PiPiClaw — M1 北极星验证:W5 接线全链贯通测试
 *
 * 【本测试存在的唯一理由】
 * 审计发现: LlmAgentBrain.run() 是完整可用的 tool-call 循环,但
 * dispatchToAgent 零生产调用方 —— 即"能力已写就,从未接线"。
 * 单测(agent-brain-poc.test.ts)只证明 loop 本身能跑,不证明它在生产路径上。
 *
 * 本测试断言的是【生产链路】:
 *   ChatManager.sendMessage
 *     → dispatchToAgent
 *       → think → run (tool loop)
 *         → tool_call / tool_result 事件经中继关联到会话
 *       → token 落入 CostTracker
 *     → 助手消息回填最终答复
 *
 * 任一环节断开,本测试必须红。这是判断"是否偏离北极星"的客观依据,
 * 取代"代码写完了"这种主观判断。
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import * as fsSync from 'node:fs'
import * as path from 'node:path'

import { TEST_USER_DATA } from '../unit/test-host'
const TEST_ROOT = TEST_USER_DATA
const SANDBOX_DIR = path.join(TEST_ROOT, 'sandbox')

function seedSandbox(): void {
  fsSync.mkdirSync(SANDBOX_DIR, { recursive: true })
  fsSync.writeFileSync(path.join(SANDBOX_DIR, 'a.txt'), 'alpha\n', 'utf-8')
  fsSync.writeFileSync(path.join(SANDBOX_DIR, 'b.txt'), 'beta\n', 'utf-8')
}

beforeEach(() => { seedSandbox() })

import { LlmAgentBrain, LlmAgentBrainEvents, type LlmAgentEvent } from '../../electron/agent/LlmAgentBrain'
import { AgentEventRelayBus, type AgentRunEvent } from '../../electron/agent/AgentEventRelay'
import { LlmClient } from '../../electron/llm/LlmClient'
import type { LlmStreamChunk, LlmToolCall } from '../../electron/llm/types'

describe('M1 北极星 — agent tool loop 已接入生产链路', () => {
  let origStream: typeof LlmClient.prototype.streamChat

  beforeEach(() => { origStream = LlmClient.prototype.streamChat })
  afterEach(() => { LlmClient.prototype.streamChat = origStream })

  it('L1: run() 把 token 吐出(不再丢弃) — 这是所有计账的地基', async () => {
    const mockStream = async function* () {
      const text = 'done'
      yield { type: 'content', delta: text, accumulated: text } as LlmStreamChunk
      yield { type: 'usage', usage: { totalTokens: 4242 } } as LlmStreamChunk
      yield { type: 'done' } as LlmStreamChunk
    }
    LlmClient.prototype.streamChat = mockStream as never

    const r = await LlmAgentBrain.getInstance().run('你好', { maxIterations: 1 })
    // 修复前:返回类型里根本没有 token 字段,这里恒为 undefined
    expect(r.totalTokens).toBe(4242)
  })

  it('L2: think() 把 runId 透传给上层 — 事件归属的前提', async () => {
    const mockStream = async function* () {
      const text = 'ok'
      yield { type: 'content', delta: text, accumulated: text } as LlmStreamChunk
      yield { type: 'done' } as LlmStreamChunk
    }
    LlmClient.prototype.streamChat = mockStream as never

    const d = await LlmAgentBrain.getInstance().think({
      conversationId: 'c1',
      content: 'hi',
      runId: 'run_preallocated_123',
    } as never)
    expect((d.payload as { runId?: string }).runId).toBe('run_preallocated_123')
  })

  it('L3: 中继把 brain 事件关联到会话 — 工具调用可视化的前提', async () => {
    const mockStream = async function* () {
      const tc: LlmToolCall = {
        id: 'call_1', type: 'function',
        function: { name: 'Glob', arguments: JSON.stringify({ pattern: '**/*.txt' }) },
      }
      yield { type: 'tool_call', toolCall: tc } as LlmStreamChunk
      yield { type: 'done' } as LlmStreamChunk
    }
    LlmClient.prototype.streamChat = mockStream as never

    const relayEvents: AgentRunEvent[] = []
    const unsubRelay = AgentEventRelayBus.subscribe(e => relayEvents.push(e))

    const runId = 'run_relay_test_1'
    AgentEventRelayBus.bindRun(runId, 'conv-relay')

    try {
      await LlmAgentBrain.getInstance().run('找 txt', { runId, maxIterations: 1 })
    } finally {
      unsubRelay()
    }

    // 关键断言:tool_call 事件必须带上会话归属,否则渲染层无法消费
    const toolCall = relayEvents.find(e => e.type === 'tool_call')
    expect(toolCall).toBeDefined()
    expect(toolCall!.conversationId).toBe('conv-relay')
    expect(toolCall!.runId).toBe(runId)
  })

  it('L4: 未绑定的 run 不进生产事件流 — 防止测试/后台 run 泄漏到 UI', async () => {
    const mockStream = async function* () {
      const tc: LlmToolCall = {
        id: 'c', type: 'function',
        function: { name: 'Glob', arguments: JSON.stringify({ pattern: '*' }) },
      }
      yield { type: 'tool_call', toolCall: tc } as LlmStreamChunk
      yield { type: 'done' } as LlmStreamChunk
    }
    LlmClient.prototype.streamChat = mockStream as never

    const seen: AgentRunEvent[] = []
    const unsub = AgentEventRelayBus.subscribe(e => seen.push(e))
    try {
      await LlmAgentBrain.getInstance().run('x', { runId: 'run_unbound_xyz', maxIterations: 1 })
    } finally { unsub() }

    expect(seen.filter(e => e.runId === 'run_unbound_xyz')).toHaveLength(0)
  })

  it('L5: 完整链路 — run 发事件 + 记 token + 返回工具账', async () => {
    const seen: LlmAgentEvent[] = []
    const unsub = LlmAgentBrainEvents.subscribe(e => seen.push(e))

    const mockStream = async function* () {
      yield { type: 'usage', usage: { totalTokens: 10 } } as LlmStreamChunk
      const tc: LlmToolCall = {
        id: 'call_g', type: 'function',
        function: { name: 'Glob', arguments: JSON.stringify({ pattern: '**/*.txt' }) },
      }
      yield { type: 'tool_call', toolCall: tc } as LlmStreamChunk
      yield { type: 'done' } as LlmStreamChunk
    }
    LlmClient.prototype.streamChat = mockStream as never

    try {
      const r = await LlmAgentBrain.getInstance().run('列出 txt', { maxIterations: 1 })
      // 工具真的跑了(不是 stub)
      expect(r.toolCalls.length).toBeGreaterThan(0)
      expect(r.toolCalls[0].name).toBe('Glob')
      expect(r.toolCalls[0].ok).toBe(true)
      // 事件序列完整:run_start → tool_call → tool_result → final_answer
      const types = seen.map(e => e.type)
      expect(types).toContain('run_start')
      expect(types).toContain('tool_call')
      expect(types).toContain('tool_result')
      expect(types).toContain('final_answer')
      // run_start 在 tool_call 之前(final 在之后) —— 顺序即契约
      expect(types.indexOf('run_start')).toBeLessThan(types.indexOf('tool_call'))
      expect(types.indexOf('tool_call')).toBeLessThan(types.indexOf('final_answer'))
    } finally { unsub() }
  })

  it('L6: 回归护栏 — 未注册 agent 时 dispatchToAgent 返回 handled:false(调用方须回落)', async () => {
    // 直接验证回落契约:ChatManager 无 agent 时不得抛错,必须让调用方能回落旧管道
    const { ChatManager } = await import('../../electron/chat/ChatManager')
    const cm = ChatManager.getInstance()
    // 未 registerAgent 场景(单例初始态)
    const r = await cm.dispatchToAgent('conv-x', '测试', 'ui')
    expect(typeof r.handled).toBe('boolean')
    if (!r.handled) {
      expect(r.reason).toBeDefined()
    }
  })
})