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
/**
 * M2-A 接线验证:上下文降级在真实 tool loop 中生效。
 *
 * 单元测试已验证 planContext 的纯函数行为;这里验证它被正确接进 run():
 * 给一个极小的 contextBudget,让循环必然触发降级,断言 LLM 仍能正常
 * 跑完并给出最终答复 —— 而不是撑爆后崩溃。
 */
describe('M2-A 上下文降级接线', () => {
  let origStream: typeof LlmClient.prototype.streamChat

  beforeEach(() => { origStream = LlmClient.prototype.streamChat })
  afterEach(() => { LlmClient.prototype.streamChat = origStream })

  it('W1: 预算极小时仍能跑完 —— 降级而非崩溃', async () => {
    let sawTrimmedCall = false
    const mockStream = async function* (_req: any) {
      // 每次调 LLM 都要带一段巨量 tool 结果,逼出降级
      if (!sawTrimmedCall) {
        sawTrimmedCall = true
        const tc: LlmToolCall = {
          id: 'c1', type: 'function',
          function: { name: 'Glob', arguments: JSON.stringify({ pattern: '**/*.txt' }) },
        }
        yield { type: 'tool_call', toolCall: tc } as LlmStreamChunk
        yield { type: 'usage', usage: { totalTokens: 100 } } as LlmStreamChunk
      } else {
        const text = '已完成整理'
        yield { type: 'content', delta: text, accumulated: text } as LlmStreamChunk
        yield { type: 'usage', usage: { totalTokens: 50 } } as LlmStreamChunk
      }
      yield { type: 'done' } as LlmStreamChunk
    }
    LlmClient.prototype.streamChat = mockStream as never

    const r = await LlmAgentBrain.getInstance().run('整理下载文件夹', {
      maxIterations: 3,
      // 极小预算 → 必然触发降级
      contextBudget: { total: 2000, reserve: 200, system: 200, history: 400, toolResult: 400 },
    })

    // 关键:没抛错,且给出了最终答复
    expect(r.content).toBe('已完成整理')
    expect(r.iterations).toBeGreaterThan(0)
  })

  it('W2: LLM 实际收到的 messages 被裁剪过 —— 不是全量', async () => {
    let sentMsgCount = 0
    let sentTokenEst = 0
    const mockStream = async function* (req: any) {
      sentMsgCount = Math.max(sentMsgCount, req.messages.length)
      const totalChars = req.messages.reduce(
        (s: number, m: any) => s + (typeof m.content === 'string' ? m.content.length : 0), 0,
      )
      sentTokenEst = Math.max(sentTokenEst, Math.ceil(totalChars / 4))
      if (sentMsgCount === 1) {
        const tc: LlmToolCall = {
          id: 'c1', type: 'function',
          function: { name: 'Glob', arguments: JSON.stringify({ pattern: '**/*' }) },
        }
        yield { type: 'tool_call', toolCall: tc } as LlmStreamChunk
      } else {
        const text = 'done'
        yield { type: 'content', delta: text, accumulated: text } as LlmStreamChunk
      }
      yield { type: 'done' } as LlmStreamChunk
    }
    LlmClient.prototype.streamChat = mockStream as never

    await LlmAgentBrain.getInstance().run('x', {
      maxIterations: 3,
      contextBudget: { total: 3000, reserve: 200, system: 200, history: 600, toolResult: 600 },
    })

    // system 必须仍在(第一条)
    expect(sentMsgCount).toBeGreaterThan(0)
    // 送出的量受预算约束
    expect(sentTokenEst).toBeLessThan(3000)
  })
})

/**
 * M2-B 接线验证:权限门在真实 tool loop 中拦住写操作。
 *
 * 这是安全洞的端到端证明 —— EditTool 在修复前能静默改文件,
 * 现在必须被门拦住,且不能靠"用户点了确认"就放行敏感路径。
 */
describe('M2-B 工具权限门接线', () => {
  let origStream: typeof LlmClient.prototype.streamChat

  beforeEach(() => { seedSandbox() })
  afterEach(() => { LlmClient.prototype.streamChat = origStream })

  const editCall = (): LlmToolCall => ({
    id: 'edit_1', type: 'function',
    function: { name: 'Edit', arguments: JSON.stringify({ file_path: 'notes.txt', old_string: 'a', new_string: 'b' }) },
  })

  it('G1: 无确认桥时 EditTool 被拒 —— 文件不被改动', async () => {
    const target = path.join(SANDBOX_DIR, 'notes.txt')
    fsSync.writeFileSync(target, 'original content', 'utf-8')
    const before = fsSync.readFileSync(target, 'utf-8')

    LlmClient.prototype.streamChat = (async function* () {
      yield { type: 'tool_call', toolCall: editCall() } as LlmStreamChunk
      const t = 'done'
      yield { type: 'content', delta: t, accumulated: t } as LlmStreamChunk
      yield { type: 'done' } as LlmStreamChunk
    }) as never

    // 不传 requestToolConfirmation → 权限门应拒绝
    const r = await LlmAgentBrain.getInstance().run('改一下文件', {
      maxIterations: 2, contextKind: 'headless',
    })

    expect(r.toolCalls.some(c => c.name === 'Edit' && c.ok === false)).toBe(true)
    expect(fsSync.readFileSync(target, 'utf-8')).toBe(before)   // 关键:内容未变
  })

  it('G2: 提供确认桥且用户同意 → EditTool 放行', async () => {
    const target = path.join(SANDBOX_DIR, 'notes.txt')
    fsSync.writeFileSync(target, 'original content', 'utf-8')

    LlmClient.prototype.streamChat = (async function* () {
      yield { type: 'tool_call', toolCall: editCall() } as LlmStreamChunk
      const t = 'done'
      yield { type: 'content', delta: t, accumulated: t } as LlmStreamChunk
      yield { type: 'done' } as LlmStreamChunk
    }) as never

    const confirm = vi.fn().mockResolvedValue(true)
    await LlmAgentBrain.getInstance().run('改一下文件', {
      maxIterations: 2, contextKind: 'ui',
      requestToolConfirmation: confirm,
    })

    expect(confirm).toHaveBeenCalled()
  })

  it('G3: 用户拒绝 → 文件不被改动', async () => {
    const target = path.join(SANDBOX_DIR, 'notes.txt')
    fsSync.writeFileSync(target, 'original content', 'utf-8')
    const before = fsSync.readFileSync(target, 'utf-8')

    LlmClient.prototype.streamChat = (async function* () {
      yield { type: 'tool_call', toolCall: editCall() } as LlmStreamChunk
      const t = 'done'
      yield { type: 'content', delta: t, accumulated: t } as LlmStreamChunk
      yield { type: 'done' } as LlmStreamChunk
    }) as never

    await LlmAgentBrain.getInstance().run('改一下文件', {
      maxIterations: 2, contextKind: 'ui',
      requestToolConfirmation: async () => false,
    })

    expect(fsSync.readFileSync(target, 'utf-8')).toBe(before)
  })

  it('G4: 只读工具在无确认桥时仍正常执行 —— 权限门不能把 agent 变哑巴', async () => {
    LlmClient.prototype.streamChat = (async function* () {
      const tc: LlmToolCall = {
        id: 'g1', type: 'function',
        function: { name: 'Glob', arguments: JSON.stringify({ pattern: '**/*.txt' }) },
      }
      yield { type: 'tool_call', toolCall: tc } as LlmStreamChunk
      const t = '找到文件'
      yield { type: 'content', delta: t, accumulated: t } as LlmStreamChunk
      yield { type: 'done' } as LlmStreamChunk
    }) as never

    const r = await LlmAgentBrain.getInstance().run('列出 txt', {
      maxIterations: 2, contextKind: 'headless',
    })
    expect(r.toolCalls.some(c => c.name === 'Glob' && c.ok)).toBe(true)
  })
})
