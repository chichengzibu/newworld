/**
 * PiPiClaw — 成本记账链路测试（M3-E）
 * ═══════════════════════════════════════════════════════════════
 * 【这一批修的三处记账失真】
 *
 * ① model 恒为字面量 'agent-loop'
 *    → 成本按**一个假模型名**归集,"哪个模型花了多少钱"根本查不出来。
 *
 * ② inputTokens 塞的是 totalTokens,outputTokens 恒为 0
 *    → 输入输出混在一栏,分不出"提示词长"还是"回答长"。
 *    (适配器本来就回传 promptTokens/completionTokens,此前被 brain 丢掉)
 *
 * ③ 唯一的读出口 insight:cost:today 是**硬编码 0 的 stub**
 *    → 数据在 CostTracker 里真实记着,唯独读出来是假的。
 *    用户看到"今天花了 $0.0000"会以为没花钱 —— 而钱已经花了。
 *    假数据比没数据更危险。
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'

vi.mock('electron', () => ({
  app: { getPath: vi.fn((k: string) => `/tmp/pipiclaw-m3e-${k}`) },
  ipcMain: { handle: () => {}, on: () => {}, removeHandler: () => {} },
  BrowserWindow: class {},
  dialog: { showMessageBox: () => {}, showOpenDialog: () => {} },
  shell: { openExternal: () => {}, openPath: () => {} },
  globalShortcut: { register: () => true, unregister: () => {} },
  Menu: { buildFromTemplate: () => ({}), setApplicationMenu: () => {} },
  Tray: class { setToolTip() {} setContextMenu() {} on() {} },
  screen: { getPrimaryDisplay: () => ({ workAreaSize: { width: 1920, height: 1080 } }) },
}))
vi.mock('electron-log', () => ({
  default: {
    info: () => {}, warn: () => {}, error: () => {}, debug: () => {},
    transports: { file: { resolvePathFn: () => {}, maxSize: 0, format: '' }, console: { level: 'info' } },
  },
}))

import { LlmAgentBrain } from '../../electron/agent/LlmAgentBrain'
import { LlmClient } from '../../electron/llm/LlmClient'
import { CostTracker } from '../../electron/insight/CostTracker'
import type { LlmStreamChunk } from '../../electron/llm/types'

describe('M3-E 成本记账链路', () => {
  let origStream: typeof LlmClient.prototype.streamChat

  beforeEach(() => {
    origStream = LlmClient.prototype.streamChat
    ;(CostTracker as any).instance = undefined
  })

  afterEach(() => {
    LlmClient.prototype.streamChat = origStream
  })

  it('brain 的 run() 带回【分项 token】与【真实模型名】', async () => {
    const mockStream = async function* () {
      yield {
        type: 'usage',
        usage: { promptTokens: 120, completionTokens: 45, totalTokens: 165 },
      } as LlmStreamChunk
      yield { type: 'content', delta: '好', accumulated: '好' } as LlmStreamChunk
      yield { type: 'done' } as LlmStreamChunk
    }
    LlmClient.prototype.streamChat = mockStream as never

    const r = await LlmAgentBrain.getInstance().run('你好', {
      maxIterations: 1,
      model: 'qwen3.5:9b',
    } as any)

    // 分项不再被丢掉
    expect(r.promptTokens).toBe(120)
    expect(r.completionTokens).toBe(45)
    expect(r.totalTokens).toBe(165)
    // 真实模型名(此前载荷里只有 'agent-v0.1' 这个脑版本标签)
    expect(r.model).toBe('qwen3.5:9b')
  })

  it('think() 的载荷带 llmModel + 分项 token', async () => {
    const mockStream = async function* () {
      yield {
        type: 'usage',
        usage: { promptTokens: 30, completionTokens: 10, totalTokens: 40 },
      } as LlmStreamChunk
      yield { type: 'content', delta: 'x', accumulated: 'x' } as LlmStreamChunk
      yield { type: 'done' } as LlmStreamChunk
    }
    LlmClient.prototype.streamChat = mockStream as never

    const d = await LlmAgentBrain.getInstance().think({
      content: '你好',
      conversationId: 'c1',
    } as any)
    const payload = d.payload as any
    expect(payload.llmModel).toBeTruthy()
    expect(payload.promptTokens).toBe(30)
    expect(payload.completionTokens).toBe(10)
  })

  it('CostTracker 按模型归集 —— 真实模型名让 byModel 有意义', () => {
    const tracker = CostTracker.getInstance()
    tracker.recordUsage({ model: 'qwen3.5:9b', inputTokens: 1000, outputTokens: 200, conversationId: 'c1' })
    tracker.recordUsage({ model: 'qwen3.5:9b', inputTokens: 500, outputTokens: 100, conversationId: 'c1' })
    tracker.recordUsage({ model: 'gpt-4o-mini', inputTokens: 300, outputTokens: 50, conversationId: 'c2' })

    const today = tracker.getTodayCost()
    expect(today.totalInputTokens).toBe(1800)
    expect(today.totalOutputTokens).toBe(350)
    // 两个模型分开归集(此前全记在 'agent-loop' 一个篮子里)
    expect(Object.keys(today.byModel)).toContain('qwen3.5:9b')
    expect(Object.keys(today.byModel)).toContain('gpt-4o-mini')
    expect(Object.keys(today.byModel)).not.toContain('agent-loop')
  })

  it('按会话能查到用量(此前 getUsageByConversation 零调用方)', () => {
    const tracker = CostTracker.getInstance()
    tracker.recordUsage({ model: 'm', inputTokens: 10, outputTokens: 2, conversationId: 'conv-A' })
    tracker.recordUsage({ model: 'm', inputTokens: 20, outputTokens: 4, conversationId: 'conv-B' })
    const a = tracker.getUsageByConversation('conv-A')
    expect(a.length).toBe(1)
    expect(a[0].inputTokens).toBe(10)
  })

  it('今日汇总是真的 —— 读出口不该再返回硬编码 0', () => {
    const tracker = CostTracker.getInstance()
    // 用有定价的模型(本地模型成本本就该是 0,那是事实不是 bug)
    tracker.recordUsage({ model: 'gpt-4o-mini', inputTokens: 777, outputTokens: 333, conversationId: 'c' })
    const today = tracker.getTodayCost()
    expect(today.totalInputTokens).toBe(777)
    expect(today.totalOutputTokens).toBe(333)
    // 成本必须 > 0(此前 stub 恒返回 0)
    expect(today.totalCostUsd).toBeGreaterThan(0)
  })

  it('定价查表能归一化命中(真实模型 id vs 基座名)', () => {
    const tracker = CostTracker.getInstance()
    // 带日期版本与 provider 前缀的真实 id,应命中 'gpt-4o-mini' 的定价
    tracker.recordUsage({ model: 'openai/gpt-4o-mini-2024-07-18', inputTokens: 1000, outputTokens: 1000, conversationId: 'c' })
    const today = tracker.getTodayCost()
    expect(today.totalCostUsd).toBeGreaterThan(0)
  })

  it('本地模型成本为 0 是事实,不是记账失败(且仍归到该模型名下)', () => {
    const tracker = CostTracker.getInstance()
    tracker.recordUsage({ model: 'qwen3.5:9b', inputTokens: 5000, outputTokens: 500, conversationId: 'c' })
    const today = tracker.getTodayCost()
    // 本地推理没有 API 费用
    expect(today.totalCostUsd).toBe(0)
    // 但 token 数照记,且按模型归集(本地用户真正看的信号)
    expect(today.totalInputTokens).toBe(5000)
    expect(Object.keys(today.byModel)).toContain('qwen3.5:9b')
  })
})
