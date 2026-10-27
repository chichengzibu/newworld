/**
 * PiPiClaw — M4-B 学习闭环【接线】验证
 * ═══════════════════════════════════════════════════════════════
 * 【为什么单独一个文件】
 * 上一份 learning-trajectory-m4b.test.ts 验的是【单元】:
 *   分类器归类对不对、SelfLearner 记不记得对。
 * 本份验的是【接线】—— 数据到底流没流到。
 *
 * 【接线为什么曾是最大的洞】
 * M4-B 之前,整个 agent tool loop(最重要的能力路径)【完全不产生学习数据】:
 *   - 观察端只挂在旧的 TaskExecutor 管道上
 *   - SkillEffectivenessTracker.record() 全仓零调用方
 *   → 闭环两端都断着:只记不反馈学不到东西,只反馈没样本无从反馈。
 *
 * 本文件锁死三条:
 *   ① agent loop 跑完 → 产生一条轨迹观察(source='agent_loop')
 *   ② 每次工具调用 → 产生一条效果反馈(SkillEffectivenessTracker.record)
 *   ③ 学习侧炸了 → 用户依然拿到正常回复(旁路不得反噬主链路)
 *
 * 【不联网】agent brain 是本地 fake,LLM 一行不调。
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'

vi.mock('electron', () => ({
  app: {
    getPath: vi.fn((key: string) => `/tmp/pipiclaw-m4b-${key}`),
    getAppPath: () => '/tmp',
    getVersion: () => '0.0.0',
    getName: () => 'pipiclaw',
    on: vi.fn(),
    off: vi.fn(),
  },
  ipcMain: { handle: vi.fn(), on: vi.fn(), removeHandler: vi.fn() },
  BrowserWindow: { getAllWindows: () => [] },
  dialog: { showMessageBox: () => {}, showOpenDialog: () => {} },
  shell: { openExternal: () => {}, openPath: () => {} },
  safeStorage: { isEncryptionAvailable: () => false, encryptString: (s: string) => s, decryptString: (b: Buffer) => b.toString() },
}))

vi.mock('electron-log', () => ({
  default: {
    info: () => {}, warn: () => {}, error: () => {}, debug: () => {},
    transports: { file: { resolvePathFn: () => {}, maxSize: 0, format: '' }, console: { level: 'info' } },
  },
}))

// ── ModelManager: 必须有一个"就绪"的 provider,否则 shouldUseAgentLoop 回落旧管道 ──
vi.mock('../../electron/models/ModelManager', () => ({
  ModelManager: {
    getInstance: () => ({
      getAllProviders: () => [{ id: 'mock-prov', name: 'Mock', type: 'openai', enabled: true, apiKey: 'k' }],
      getProvider: () => ({ id: 'mock-prov', name: 'Mock', type: 'openai', baseUrl: 'http://localhost:18789' }),
      getActiveModel: () => ({ id: 'mock-model' }),
      listModels: () => [],
      getEnabledProviders: () => [],
    }),
  },
}))

// ── 记忆召回: 返回空即可(不需要真的做向量检索) ──
vi.mock('../../electron/hermes/HermesAdapter', () => ({
  RECALL_CHAT_MIN_SCORE: 0.1,
  HermesAdapter: { getInstance: () => ({ recall: async () => [], store: async () => {} }) },
}))

// ── 效果反馈: 记录调用参数 ──
const trackerRecords: any[] = []
vi.mock('../../electron/learning/SkillEffectivenessTracker', () => ({
  SkillEffectivenessTracker: {
    getInstance: () => ({
      record: (r: any) => { trackerRecords.push(r) },
    }),
  },
}))

// ── 观察端: 记录调用参数 ──
const observeCalls: any[] = []
vi.mock('../../electron/learning/SelfLearner', () => ({
  SelfLearner: {
    getInstance: () => ({
      checkAndTrigger: async () => null,
      getPendingProposal: () => null,
      saveSkillFromProposal: () => true,
      observeExecution: (...args: any[]) => { observeCalls.push(args) },
    }),
  },
}))

// ── token 记账: 不碰真实文件 ──
vi.mock('../../electron/insight/CostTracker', () => ({
  CostTracker: { getInstance: () => ({ recordUsage: () => {} }) },
}))

import { ChatManager } from '../../electron/chat/ChatManager'

/**
 * 假 agent brain:返回可控的 payload。
 * payload 形状须与 LlmAgentBrain 一致(见 LlmAgentBrain.ts:629)
 */
function makeAgent(payload: any) {
  return { think: vi.fn(async () => ({ payload })) } as any
}

describe('M4-B 接线:agent loop 路径产生学习数据', () => {
  let convId: string

  beforeEach(() => {
    vi.clearAllMocks()
    observeCalls.length = 0
    trackerRecords.length = 0
    ChatManager.destroy()
    const cm = ChatManager.getInstance() as any
    convId = cm.createConversation({ title: 'm4b-wiring' }).id
  })

  afterEach(() => {
    ChatManager.destroy()
  })

  it('agent loop 跑完 → 产生一条 source="agent_loop" 的轨迹观察', async () => {
    const cm = ChatManager.getInstance() as any
    cm.registerAgent(makeAgent({
      text: '好的,做完了',
      totalTokens: 120,
      iterations: 2,
      runId: 'run_abc',
      toolCalls: [{ name: 'Read', ok: true, durationMs: 12 }],
    }))

    await cm.sendMessage(convId, '读一下 README', 'mock-prov', 'mock-model')

    expect(observeCalls.length).toBe(1)
    const [instruction, steps, result, meta] = observeCalls[0]
    expect(instruction).toBe('读一下 README')
    expect(meta.source).toBe('agent_loop')
    expect(meta.trajectoryId).toBe('run_abc')
    expect(meta.toolsUsed).toEqual(['Read'])
    expect(steps).toEqual([{ name: 'Read', ok: true, durationMs: 12 }])
    expect(result).toBe('ok')
  })

  it('每次工具调用 → 产生一条效果反馈(SkillEffectivenessTracker 此前零调用方)', async () => {
    const cm = ChatManager.getInstance() as any
    cm.registerAgent(makeAgent({
      text: '完成',
      totalTokens: 0,
      iterations: 1,
      runId: 'run_xyz',
      toolCalls: [
        { name: 'Read', ok: true, durationMs: 10 },
        { name: 'Edit', ok: true, durationMs: 30 },
      ],
    }))

    await cm.sendMessage(convId, '改个文件', 'mock-prov', 'mock-model')

    expect(trackerRecords.length).toBe(2)
    expect(trackerRecords[0]).toMatchObject({ skillName: 'Read', success: true, durationMs: 10 })
    expect(trackerRecords[1]).toMatchObject({ skillName: 'Edit', success: true, durationMs: 30 })
    expect(trackerRecords[0].conversationId).toBe(convId)
  })

  it('工具失败 → outcome 记 partial/fail,并带上失败分类(诊断反馈)', async () => {
    const cm = ChatManager.getInstance() as any
    cm.registerAgent(makeAgent({
      text: '部分完成',
      totalTokens: 0,
      iterations: 3,
      runId: 'run_fail',
      toolCalls: [
        { name: 'Read', ok: true, durationMs: 5 },
        { name: 'Edit', ok: false, durationMs: 8 },
      ],
    }))

    await cm.sendMessage(convId, '写个文件', 'mock-prov', 'mock-model')

    const [, , result, meta] = observeCalls[0]
    // 一成一败 → partial(不是"整体成功",也不是"整体失败")
    expect(result).toBe('partial')
    expect(meta.failure).toBeDefined()
    expect(meta.failure.stepIndex).toBe(1)
    expect(typeof meta.failure.type).toBe('string')

    // 效果反馈:失败的那条 success=false
    const failed = trackerRecords.find((r: any) => r.skillName === 'Edit')
    expect(failed.success).toBe(false)
  })

  it('全部工具失败 → outcome = fail', async () => {
    const cm = ChatManager.getInstance() as any
    cm.registerAgent(makeAgent({
      text: '失败',
      totalTokens: 0,
      iterations: 1,
      runId: 'run_allfail',
      toolCalls: [{ name: 'Edit', ok: false, durationMs: 3 }],
    }))

    await cm.sendMessage(convId, '写文件', 'mock-prov', 'mock-model')
    expect(observeCalls[0][2]).toBe('fail')
  })

  it('旁路红线:学习侧抛错不得影响用户拿到的回复', async () => {
    // 这是 chat-execution-ui B-3 踩过的坑:学习块裸调 → 一个 TypeError
    // 让整个任务流抛 → 回退普通对话 → 用户看到的是"LLM 连不上",
    // 真实失败原因被吞掉。现在学习块整体兜住。
    const cm = ChatManager.getInstance() as any
    cm.registerAgent(makeAgent({
      text: '任务照常完成',
      totalTokens: 0,
      iterations: 1,
      runId: 'run_throw',
      toolCalls: [{ name: 'Read', ok: true, durationMs: 1 }],
    }))

    // 让观察端抛
    const selfLearnerMod = await import('../../electron/learning/SelfLearner')
    ;(selfLearnerMod.SelfLearner.getInstance() as any).observeExecution = () => {
      throw new Error('学习侧炸了')
    }

    const reply = await cm.sendMessage(convId, '随便做点什么', 'mock-prov', 'mock-model')
    expect(reply).toBeDefined()
    expect(reply.content).toContain('任务照常完成')
  })
})
