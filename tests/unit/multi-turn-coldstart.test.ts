/**
 * #003-fix 多轮记忆实施验证 + 回归钉 (DEV-020)
 *
 * ═══ 本文件职责 (Step B-4) ═══
 *   修复已实施 (HistoryAssembler + 两管道 history 接缝)。判定测试从
 *   #003 的 it.fails(锁定冷启动)【翻正】为 it(验证多轮记忆生效), 并新增
 *   HistoryAssembler 正向断言 (助手轮次在场 / 窗口截断 / 真源映射回归钉)。
 *
 * ═══ 红线 (用户 2026-10-12) ═══
 *   "注入假 LLM server（替身，非放宽 mock）" → 被测单元走【真实代码】,
 *     只在【传输层】插替身:
 *       - 管道A: 假 http LLM server (真 makeRequest → 真 protocol.request → 127.0.0.1)
 *       - 管道B: 稳定 streamChat 委托 (真 callLlmOnce → async generator)
 *   → 请求体在传输边界被【真实捕获】。
 *
 * ═══ 架构 (修正确认, 非冷启动) ═══
 *   会话层 (ChatManager) 用 HistoryAssembler 从真源拉历史 → 显式参数传给
 *   InstructionGenerator.generateTaskSteps(history) / LlmAgentBrain.run({history})。
 *     - generator / brain 【无状态】, 不自存历史 (禁新增模块态; #004 checkpoint 前提)
 *     - 真源 = main 侧 ChatConfig.conversations[id].messages (前 N-1 轮在此)
 *   → 故断言场景 = "会话层接线后, 第二轮请求体应含第一轮"(修复生效的判据)
 *
 * ═══ 禁 ═══ main.ts 接线 / 安全链(咽喉/审计/确认)一律不碰 (本文件断言层零生产改动)
 */
import { describe, it, expect, vi, beforeAll, afterAll } from 'vitest'
import http from 'node:http'
import { HistoryAssembler, HISTORY_WINDOW_TURNS, HISTORY_MAX_CHARS } from '../../electron/chat/HistoryAssembler'

vi.mock('electron', () => ({
  BrowserWindow: Object.assign(vi.fn(function () {}), { getAllWindows: () => [] }),
  shell: { openExternal: vi.fn() },
  clipboard: { readText: vi.fn(() => ''), writeText: vi.fn() },
}))

// ── 管道A 替身: ModelManagerbaseUrl 委托 holderA (每次 getProvider 求值, 运行时重定向) ──
const holderA = vi.hoisted(() => ({ ref: { url: 'http://127.0.0.1:0' } }))
vi.mock('../../electron/models/ModelManager', () => ({
  ModelManager: { getInstance: () => ({
    getProvider: () => ({
      id: 'fake', name: 'FakeLLM', type: 'openai', apiKey: 'test-key',
      baseUrl: holderA.ref.url,
      models: [{ id: 'fake-model', name: 'Fake Model', enabled: true }],
    }),
    getAllProviders: () => [],
  }) },
}))
vi.mock('../../electron/skill/SkillLoader', () => ({
  SkillLoader: { getInstance: () => ({
    getAllSkillSummaries: () => '',
    getSkillContext: () => null,
  }) },
}))

// ── 管道B 替身: 空 tools + 稳定 streamChat 委托 (构造时绑定函数, 非值拷贝 null) ──
vi.mock('../../electron/agent/tools/index.ts', () => ({
  BUILTIN_TOOLS: [],
  toolsToLlmSchema: () => [],
}))
const llmCaptureB = vi.hoisted(() => ({ reqs: [] as any[] }))
vi.mock('../../electron/llm/LlmClient', () => ({
  LlmClient: { getInstance: () => ({
    streamChat: async function* (_req: any) {
      // 发送瞬间深拷贝 messages 快照 (忠实捕获"请求体", 避免 brain tool-loop 后续 push 污染)
      llmCaptureB.reqs.push({ ..._req, messages: JSON.parse(JSON.stringify(_req.messages ?? [])) })
      yield { type: 'content', delta: 'DONE', accumulated: { content: 'DONE' } }
    },
  }) },
}))

// ── 假 LLM http server (管道A): 捕获请求体, 恒返 200 空 choices ──
type FakeLlm = { url: string; captured: any[]; close: () => void }
async function startFakeLlmServer(): Promise<FakeLlm> {
  const captured: any[] = []
  const server = http.createServer((req, res) => {
    let data = ''
    req.on('data', (c) => { data += c })
    req.on('end', () => {
      let body: any
      try { body = JSON.parse(data) } catch { body = { raw: data } }
      captured.push(body)
      res.writeHead(200, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify({ id: 'fake', choices: [] }))
    })
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const port = (server.address() as { port: number }).port
  return { url: `http://127.0.0.1:${port}`, captured, close: () => server.close() }
}

// ═══════════════════════════════════════════════════════════════════
// HistoryAssembler 正向断言 (唯一实现, 两管道共用)
// ═══════════════════════════════════════════════════════════════════
describe('HistoryAssembler 正向断言 (助手轮次 + 窗口截断 + 真源映射)', () => {
  const turn = (n: number, assistant = true) =>
    assistant
      ? [{ id: `u${n}`, role: 'user', content: `USER-${n}`, status: 'sent' },
         { id: `a${n}`, role: 'assistant', content: `ASSISTANT-${n}`, status: 'sent' }]
      : [{ id: `u${n}`, role: 'user', content: `USER-${n}`, status: 'sent' }]

  it('H-1 助手轮次在场 + 当前 user 恒末位 (非 user 单声道)', () => {
    // 真实场景: 前两轮完整 (user+assistant), 当前轮 user 是【末条】(其后无 assistant, 那是未来回复)
    const src = [
      ...turn(1),   // u1, a1
      ...turn(2),   // u2, a2
      { id: 'u3', role: 'user', content: 'USER-3-CURRENT', status: 'sent' }, // 当前轮, 末条
    ]
    const h = HistoryAssembler.buildHistory(src, 'u3')   // 排除当前 u3
    expect(h.map((m) => m.content), '保留 u1,a1,u2,a2, 当前 u3 排除').toEqual(['USER-1', 'ASSISTANT-1', 'USER-2', 'ASSISTANT-2'])
    expect(h[h.length - 1].role, '历史段末位应是 assistant (非被排除的当前 user)').toBe('assistant')
    // compose: system 恒首位 + 当前 user 恒末位
    const full = HistoryAssembler.compose('SYS-PROMPT', h, 'CURRENT-INSTRUCTION')
    expect(full[0]).toEqual({ role: 'system', content: 'SYS-PROMPT' })
    expect(full[full.length - 1]).toEqual({ role: 'user', content: 'CURRENT-INSTRUCTION' })
  })

  it('H-2 窗口截断: K+1 轮时最老轮被丢 (超 maxTurns 保留最近 N 轮)', () => {
    // 5 轮, 窗口 10 → 全保留
    let src: any[] = []
    for (let i = 1; i <= 5; i++) src.push(...turn(i))
    expect(HistoryAssembler.buildHistory(src, 'u999').filter((m) => m.role === 'user').length).toBe(5)
    // 15 轮, 窗口 10 → 只留最近 10 user
    src = []
    for (let i = 1; i <= 15; i++) src.push(...turn(i))
    const h15 = HistoryAssembler.buildHistory(src, 'u999')
    const users = h15.filter((m) => m.role === 'user')
    expect(users.length, '15 轮超窗, 应剩 10 user').toBe(HISTORY_WINDOW_TURNS)
    expect(users[0].content, '最老 USER-1 被丢, 应从 USER-6 起').toBe('USER-6')
    expect(users[users.length - 1].content).toBe('USER-15')
  })

  it('H-3 字符上限: 超 maxChars 从最老 turn 删 (至少留 1 轮)', () => {
    // 4 轮, 每轮 content 6000 字符 (总 24000 > 16000) 窗口不限
    const big = (c: string) => ({ id: 'u', role: 'user', content: c, status: 'sent' })
    const src = [
      big('A'.repeat(6000)), big('B'.repeat(6000)),
      big('C'.repeat(6000)), big('D'.repeat(6000)),
    ]
    const h = HistoryAssembler.buildHistory(src, 'zzz', { maxTurns: 100 })
    const total = h.reduce((s, m) => s + m.content.length, 0)
    expect(total, '总字符应 <= HISTORY_MAX_CHARS').toBeLessThanOrEqual(HISTORY_MAX_CHARS)
    // 保留的应是最近的 (D 一定在, A 最老应被丢)
    expect(h.some((m) => m.content.startsWith('D'))).toBe(true)
    expect(h.some((m) => m.content.startsWith('A')), '最老 A 应被丢').toBe(false)
  })

  it('H-4 真源映射回归钉: streaming 空壳 + 当前 user 被剔除', () => {
    const src = [
      { id: 'u1', role: 'user', content: 'USER-1', status: 'sent' },
      { id: 'a1', role: 'assistant', content: '', status: 'streaming' }, // 空壳占位不入历史
      { id: 'a1f', role: 'assistant', content: 'ASSISTANT-1', status: 'sent' },
      { id: 'u2', role: 'user', content: 'USER-2-CURRENT', status: 'sent' }, // 当前轮
    ]
    const h = HistoryAssembler.buildHistory(src, 'u2')
    expect(h.map((m) => m.role)).toEqual(['user', 'assistant'])
    expect(h.some((m) => m.content === '')).toBe(false)
    expect(h.some((m) => m.content === 'USER-2-CURRENT'), '当前 user 排除').toBe(false)
  })
})

// ═══════════════════════════════════════════════════════════════════
// 管道A (活跃链) — 会话层接线后, 第二轮请求体含第一轮 (修复生效)
// ═══════════════════════════════════════════════════════════════════
describe('#003-fix 管道A (活跃链) 多轮记忆 — 会话层接线验证', () => {
  let fake: FakeLlm
  beforeAll(async () => {
    fake = await startFakeLlmServer()
    holderA.ref.url = fake.url
  })
  afterAll(() => { fake?.close() })

  const ctx = async () => {
    const { HistoryAssembler } = await import('../../electron/chat/HistoryAssembler')
    const { InstructionGenerator } = await import('../../electron/task/InstructionGenerator')
    return { HistoryAssembler, gen: InstructionGenerator.getInstance() }
  }

  it('A-1 [harness 绿] 通路可用 + 当轮指令在场 (证伪假阳性)', async () => {
    fake.captured.length = 0
    const { gen } = await ctx()
    await gen.generateTaskSteps('TURN-TWO-SENTINEL', 'fake', 'fake-model')
    const turn2 = fake.captured.find((b) => JSON.stringify(b).includes('TURN-TWO-SENTINEL'))
    expect(turn2, '请求体应被假 LLM 捕获').toBeTruthy()
    expect(JSON.stringify(turn2), '当轮指令应在请求体').toContain('TURN-TWO-SENTINEL')
    // system 恒首位
    expect(turn2.messages[0].role).toBe('system')
  })

  it('A-2 [翻正·多轮记忆生效] 会话层拉真源历史 → 第二轮请求体含第一轮 user + 助手轮次', async () => {
    fake.captured.length = 0
    const { HistoryAssembler, gen } = await ctx()
    // 真源 (main 侧 ChatConfig.conversations[id].messages): 第 1 轮 user + 助手已落盘 + 当前第 2 轮 user
    const source = [
      { id: 'u1', role: 'user', content: 'TURN-ONE-SENTINEL', status: 'sent' },
      { id: 'a1', role: 'assistant', content: 'TURN-ONE-ASSISTANT-SENTINEL', status: 'sent' },
      { id: 'u2', role: 'user', content: 'TURN-TWO-SENTINEL', status: 'sent' }, // 当前轮
    ]
    const history = HistoryAssembler.buildHistory(source, 'u2') // 排除当前轮
    await gen.generateTaskSteps('TURN-TWO-SENTINEL', 'fake', 'fake-model', history)
    const turn2 = fake.captured.find((b) => JSON.stringify(b).includes('TURN-TWO-SENTINEL'))
    expect(turn2, '第二轮请求体应被捕获').toBeTruthy()
    const blob = JSON.stringify(turn2.messages)
    expect(blob, '多轮记忆①: 第二轮应携带第一轮 user 消息').toContain('TURN-ONE-SENTINEL')
    expect(blob, '多轮记忆②: 助手轮次必须在场 (非 user 单声道)').toContain('TURN-ONE-ASSISTANT-SENTINEL')
    expect(turn2.messages[0].role, 'system 恒首位').toBe('system')
    expect(turn2.messages[turn2.messages.length - 1].content, '当前 user 恒末位').toBe('TURN-TWO-SENTINEL')
  })
})

// ═══════════════════════════════════════════════════════════════════
// 管道B (休眠 LlmAgentBrain) — run({history}) 多轮记忆验证
// ═══════════════════════════════════════════════════════════════════
describe('#003-fix 管道B (LlmAgentBrain) 多轮记忆 — run(history) 验证', () => {
  const brain = async () =>
    (await import('../../electron/agent/LlmAgentBrain')).LlmAgentBrain.getInstance()

  it('B-1 [harness 绿] run 发 LLM 请求且当轮 prompt 在场 (通路可用)', async () => {
    llmCaptureB.reqs.length = 0
    const b = await brain()
    await b.run('TURN-TWO-SENTINEL', { provider: 'openai' })
    const turn2 = llmCaptureB.reqs.find((r) => JSON.stringify(r.messages ?? []).includes('TURN-TWO-SENTINEL'))
    expect(turn2, 'run 的 LLM 请求应被捕获').toBeTruthy()
    expect(turn2.messages[0].role, 'system 恒首位').toBe('system')
  })

  it('B-2 [翻正·多轮记忆生效] run 携带会话层历史 → 请求体含第一轮 user + 工具结果', async () => {
    llmCaptureB.reqs.length = 0
    const b = await brain()
    // 会话层提供第一轮历史 (含工具结果 — OpenAI role:'tool')
    const history = [
      { role: 'user', content: 'TURN-ONE-SENTINEL' },
      { role: 'assistant', content: 'TURN-ONE-ASSISTANT' },
      { role: 'tool', content: 'TOOL-RESULT-ONE-SENTINEL' },
    ]
    await b.run('TURN-TWO-SENTINEL', { provider: 'openai', history })
    const turn2 = llmCaptureB.reqs.find((r) => JSON.stringify(r.messages ?? []).includes('TURN-TWO-SENTINEL'))
    expect(turn2, 'run 请求体应被捕获').toBeTruthy()
    const blob = JSON.stringify(turn2.messages)
    expect(blob, '多轮记忆①: 第二轮应携带第一轮 user 消息').toContain('TURN-ONE-SENTINEL')
    expect(blob, '多轮记忆②: 第二轮应携带第一轮工具结果').toContain('TOOL-RESULT-ONE-SENTINEL')
    expect(turn2.messages[turn2.messages.length - 1].role, '当前 user 恒末位').toBe('user')
    expect(turn2.messages[turn2.messages.length - 1].content).toBe('TURN-TWO-SENTINEL')
  })
})
