/**
 * #007 L4 (订单 6 条件之 O1 三元组实证):
 *   chat 轮次完成 (任务流分支, result.success) → SelfLearner.observeExecution 被调 1 次
 *   三元组实证: instruction = 用户消息原文 / steps = <任务 steps[]> / _result = 'ok' | 'fail'
 *
 * 配方: 复用 tests/unit/chat-execution-ui.test.ts 的 mock 面 (真 ChatManager, mock 重依赖),
 *   InstructionGenerator 单步 stub (run_command) → TaskExecutor 真 → gateway spy (不真执行)。
 *   观察端锚: ChatManager.ts:383 (任务流分支, 既有链, #007 G3 O1 两分支覆盖之一)
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'

// ── 全局 electron mock (复用 chat-execution-ui 配方) ──
vi.mock('electron', () => ({
  BrowserWindow: Object.assign(vi.fn(function () {}), { getAllWindows: () => [] }),
  shell: { openExternal: vi.fn() },
  clipboard: { readText: vi.fn(() => ''), writeText: vi.fn() },
}))

// ── mock 重依赖; SelfLearner = spy 面 (L4 断言 observeExecution 调用三元组) ──
const observeCalls: any[][] = []
vi.mock('../../electron/learning/SelfLearner', () => ({
  SelfLearner: { getInstance: () => ({
    observeExecution: (...args: any[]) => { observeCalls.push(args) },
    checkAndTrigger: async () => null,
    getPendingProposal: () => null,
    saveSkillFromProposal: () => true,
  }) },
}))
vi.mock('../../electron/hermes/HermesMemory', () => ({
  HermesMemory: { getInstance: () => ({
    addConversationMemory: () => undefined,
    buildMemoryPrompt: () => '',
  }) },
}))
vi.mock('../../electron/hermes/HermesAdapter', () => ({
  HermesAdapter: { getInstance: () => ({ recall: async () => [], store: async () => undefined }) },
  RECALL_CHAT_MIN_SCORE: 0.7,
}))
vi.mock('../../electron/models/ModelManager', () => ({
  ModelManager: { getInstance: () => ({
    getProvider: () => ({ id: 'mock-prov', name: 'MockProv', type: 'openai', baseUrl: 'http://localhost:18789' }),
    getActiveModel: () => ({ id: 'mock-model' }),
  }) },
}))
vi.mock('../../electron/permissions/PermissionManager', () => ({
  PermissionManager: { getInstance: () => ({ checkPermission: () => ({ allowed: true, reason: 'test' }) }) },
}))
vi.mock('../../electron/browser/BrowserManager', () => ({ BrowserManager: { getInstance: () => ({}) } }))
vi.mock('../../electron/openclaw/OpenClawServer', () => ({ OpenClawServer: { getInstance: () => ({}) } }))
vi.mock('../../electron/skill/SkillLoader', () => ({
  SkillLoader: { getInstance: () => ({ listSkills: () => [], loadSkill: () => null }) },
}))
vi.mock('../../electron/core/LogManager', () => ({
  LogManager: { getInstance: () => ({ info: () => undefined, warn: () => undefined, error: () => undefined, debug: () => undefined }) },
}))

import { ChatManager } from '../../electron/chat/ChatManager'
import { ChatConfig } from '../../electron/chat/ChatConfig'
import { InstructionGenerator } from '../../electron/task/InstructionGenerator'
import { installAutoConfirm, uninstallAutoConfirm } from './auto-confirm'

describe('#007 L4: chat 任务流 → SelfLearner.observeExecution (G3 O1 三元组实证)', () => {
  let convId = ''
  let genSpy: any

  beforeEach(() => {
    // 【M1-D】同上:本测试关注 SelfLearner 观察,不关注确认流程
    installAutoConfirm()
    observeCalls.length = 0
    const cfg = ChatConfig.getInstance() as any
    convId = cfg.createConversation({ title: 'l4-observe' } as any).id
  })

  afterEach(() => {
    uninstallAutoConfirm()
    if (genSpy) { genSpy.mockRestore(); genSpy = null }
  })

  it('L4: chat 完成 (任务流 result.success) → observeExecution 被调 1 次, 三元组实证 (instruction/steps/_result)', async () => {
    genSpy = vi
      .spyOn(InstructionGenerator.prototype as any, 'generateTaskSteps' as any)
      .mockImplementation(async () => [
        { action: 'run_command', description: '测试创建文件夹', params: { command: 'mk', args: [] } },
      ])

    const chat = ChatManager.getInstance() as any
    const executorSpy = vi.spyOn(chat, 'streamModelResponse').mockImplementation(async () => undefined)

    // gateway 面: TaskExecutor 真 → 需 mock gateway 模块 (同 chat-execution-ui 链路, 不真执行命令)
    const taskExec = (await import('../../electron/task/TaskExecutor' as string)).TaskExecutor.getInstance() as any
    const taskSpy = vi.spyOn(taskExec, 'executeTask' as any).mockImplementation(async (_task: any, _ctx: any) => ({
      success: true,
      result: { steps: [{ status: 'success', description: '测试创建文件夹' }], summary: 'ok' },
      error: undefined,
      duration: 1,
    }))

    await chat.sendMessage(convId, '创建文件夹 test', 'mock-prov', 'mock-model')

    // 断言: observeExecution 恰好 1 次 (任务流分支 ChatManager.ts:383; 无重复观察 — 两分支覆盖声明)
    expect(observeCalls.length).toBe(1)
    const [instruction, steps, resultArg] = observeCalls[0]
    expect(instruction).toBe('创建文件夹 test')          // 三元组①: 用户消息原文
    expect(Array.isArray(steps)).toBe(true)              // 三元组②: <任务 steps[]>
    // 三元组③: 任务流分支 _result = TaskExecutor 返回对象 (既有链, 本分支不动) — result.success=true 语义
    expect(resultArg && typeof resultArg === 'object').toBe(true)
    expect(resultArg.success).toBe(true)

    taskSpy.mockRestore()
    executorSpy.mockRestore()
  }, 30000)
})
