/**
 * #003 多轮冷启动验证 —— 两管道各一组判定测试 (Step B, 测试先行, 禁直接修)
 *
 * ═══ 红线 (用户 2026-10-12) ═══
 *   "注入假 LLM server（替身，非放宽 mock——红线语义不变）"
 *   → 被测单元(管道A=InstructionGenerator / 管道B=LlmAgentBrain.run) 走【真实代码】,
 *     只在【传输层】插替身:
 *       - 管道A: 假 http LLM server (真 makeRequest → 真 protocol.request → 假 127.0.0.1)
 *       - 管道B: 假 LlmClient.streamChat (真 callLlmOnce → 稳定 async generator 委托)
 *   → 请求体在传输边界被【真实捕获】, 非对被测单元内部 mock。
 *
 * ═══ 判定的两个形态 (ROE: 禁假绿, 红=证据) ═══
 *   - [harness] = 普通断言 (绿): 证伪"假阳性 RED" —— 替身通路可用 + 当轮指令确实在请求体
 *   - [判定]    = `it.fails()` (绿 当前): 断言"多轮【应】携带第一轮 user 消息 + 工具结果"
 *                  当前该理想断言【失败】→ `.fails` 判为绿 = 正式锁定"冷启动【属实】"这一判定。
 *     ★ 语义: it.fails 绿 = 确认冷启动; 将来 Step C 修复后该断言转通过 → `.fails` 反而变红
 *                 → 即"冷启动已修, 移除 .fails 标记", 天然自校验, 无需人工记得。
 *
 * ═══ Step A 侦察结论 (file:line, 只读) ═══
 *   管道A (活跃): ChatManager.sendMessage ChatManager.ts:243
 *     → generateTaskSteps(content,...) 只带当轮 content (签名无 conversationId/历史)
 *     → InstructionGenerator.callModel InstructionGenerator.ts:308-311
 *         硬编码 messages = [{system},{user: userInstruction}]  ← 无历史入口
 *     → makeRequest → ollama/openai 走 /chat/completions | /api/chat (InstructionGenerator.ts:375-379)
 *   管道B (休眠): LlmAgentBrain.run LlmAgentBrain.ts:160-163
 *     每次 run 重建 messages = [{system},{user: prompt}]
 *     run 内 tool 结果 push 进【本次 run 局部数组】(L188/L228), 下一次 run 冷启
 *     think LlmAgentBrain.ts:312 → run(content) 也只传 content
 *     (代码自证: LlmAgentBrain.ts:12 "每次 think() 都是独立一次 multi-turn run")
 *
 * ═══ 禁 ═══ main.ts 接线 / 安全链(咽喉/审计/确认)一律不碰 (本文件纯读+断言, 零生产改动)
 */
import { describe, it, expect, vi, beforeAll, afterAll } from 'vitest'
import http from 'node:http'

// ── 替身: electron 文件级 mock (LogManager/tools 可能间接依赖 BrowserWindow) ──
vi.mock('electron', () => ({
  BrowserWindow: Object.assign(vi.fn(function () {}), { getAllWindows: () => [] }),
  shell: { openExternal: vi.fn() },
  clipboard: { readText: vi.fn(() => ''), writeText: vi.fn() },
}))

// ── 管道A 替身: ModelManager → baseUrl 委托到 holderA (每次 getProvider 调用时读当前值, 运行时可重定向) ──
const holderA = vi.hoisted(() => ({ ref: { url: 'http://127.0.0.1:0' } }))
vi.mock('../../electron/models/ModelManager', () => ({
  ModelManager: { getInstance: () => ({
    getProvider: () => ({
      id: 'fake', name: 'FakeLLM', type: 'openai', apiKey: 'test-key',
      baseUrl: holderA.ref.url,   // 每次调用求值 → beforeAll 里设成真假服务器端口
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

// ── 管道B 替身: 空 tools + 稳定 streamChat 委托 (构造时绑定本函数, 非值拷贝 null) ──
vi.mock('../../electron/agent/tools/index.ts', () => ({
  BUILTIN_TOOLS: [],
  toolsToLlmSchema: () => [],
}))
const llmCaptureB = vi.hoisted(() => ({ reqs: [] as any[] }))
vi.mock('../../electron/llm/LlmClient', () => ({
  LlmClient: { getInstance: () => ({
    // 稳定 async generator: 每次被调都 push 到 llmCaptureB (holder 引用不变, 避免构造时值拷贝 null)
    streamChat: async function* (_req: any) {
      llmCaptureB.reqs.push(_req)
      yield { type: 'content', delta: 'DONE', accumulated: { content: 'DONE' } }
    },
  }) },
}))

// ── 假 LLM http server (管道A): 捕获请求体, 恒返 200 空 choices (makeRequest → null) ──
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
// 管道A (活跃链) — InstructionGenerator 多轮冷启动判定
// ═══════════════════════════════════════════════════════════════════
describe('#003 管道A (活跃链 InstructionGenerator) 多轮冷启动判定', () => {
  let fake: FakeLlm
  beforeAll(async () => {
    fake = await startFakeLlmServer()
    holderA.ref.url = fake.url
  })
  afterAll(() => { fake?.close() })

  const gen = async () =>
    (await import('../../electron/task/InstructionGenerator')).InstructionGenerator.getInstance()

  it('A-1 [harness 绿] 两轮均发往假 LLM 且第二轮含当轮指令 (证伪假阳性 RED = 通路可用)', async () => {
    fake.captured.length = 0
    const g = await gen()
    await g.generateTaskSteps('TURN-ONE-SENTINEL', 'fake', 'fake-model')   // 第一轮
    await g.generateTaskSteps('TURN-TWO-SENTINEL', 'fake', 'fake-model')   // 第二轮
    const bodies = fake.captured
    expect(bodies.length, '两轮应各发出 LLM 请求 (含重试 ≥2)').toBeGreaterThanOrEqual(2)
    const turn2 = bodies.find((b) => JSON.stringify(b).includes('TURN-TWO-SENTINEL'))
    expect(turn2, '第二轮请求体应被假 LLM 捕获').toBeTruthy()
    expect(JSON.stringify(turn2), '通路证伪: 第二轮请求体应含当轮指令 TURN-TWO-SENTINEL').toContain('TURN-TWO-SENTINEL')
  })

  it.fails('A-2 [判定·冷启动属实] 第二轮请求【应】携带第一轮 user 消息 + 工具结果 (当前不成立)', async () => {
    fake.captured.length = 0
    const g = await gen()
    await g.generateTaskSteps('TURN-ONE-SENTINEL', 'fake', 'fake-model')   // 第一轮 (user 消息)
    await g.generateTaskSteps('TURN-TWO-SENTINEL', 'fake', 'fake-model')   // 第二轮
    const turn2 = fake.captured.find((b) => JSON.stringify(b).includes('TURN-TWO-SENTINEL'))
    expect(turn2, '第二轮请求体应被捕获').toBeTruthy()
    const blob = JSON.stringify(turn2)
    // ── 多轮对话的正确行为: 第二轮必须记得第一轮 (当前该断言失败 = 冷启动属实的判据) ──
    expect(blob, '应携带第一轮 user 消息').toContain('TURN-ONE-SENTINEL')
    expect(blob, '应携带工具结果').toMatch(/"role"\s*:\s*"tool"/)
  })
})

// ═══════════════════════════════════════════════════════════════════
// 管道B (休眠 LlmAgentBrain) — 同实例两轮 run 冷启动判定
// ═══════════════════════════════════════════════════════════════════
describe('#003 管道B (休眠 LlmAgentBrain) 同实例两轮 run 冷启动判定', () => {
  const brain = async () =>
    (await import('../../electron/agent/LlmAgentBrain')).LlmAgentBrain.getInstance()

  it('B-1 [harness 绿] 两次 run 均发 LLM 请求且第二次含当轮 prompt (证伪假阳性 RED = 通路可用)', async () => {
    llmCaptureB.reqs.length = 0
    const b = await brain()
    await b.run('TURN-ONE-SENTINEL', { provider: 'openai' })   // 第一轮 run
    await b.run('TURN-TWO-SENTINEL', { provider: 'openai' })   // 第二轮 run (同实例)
    expect(llmCaptureB.reqs.length, '两轮 run 应各发出 LLM 请求 (≥2)').toBeGreaterThanOrEqual(2)
    const turn2 = llmCaptureB.reqs.find((r) => JSON.stringify(r.messages ?? []).includes('TURN-TWO-SENTINEL'))
    expect(turn2, '第二次 run 的 LLM 请求应被捕获').toBeTruthy()
    expect(JSON.stringify(turn2.messages), '通路证伪: 应含当轮 prompt TURN-TWO-SENTINEL').toContain('TURN-TWO-SENTINEL')
  })

  it.fails('B-2 [判定·冷启动属实] 第二次 run【应】携带第一轮 user 消息 + 工具结果 (当前不成立)', async () => {
    llmCaptureB.reqs.length = 0
    const b = await brain()
    await b.run('TURN-ONE-SENTINEL', { provider: 'openai' })   // 第一轮
    await b.run('TURN-TWO-SENTINEL', { provider: 'openai' })   // 第二轮
    const turn2 = llmCaptureB.reqs.find((r) => JSON.stringify(r.messages ?? []).includes('TURN-TWO-SENTINEL'))
    expect(turn2, '第二次 run 的 LLM 请求应被捕获').toBeTruthy()
    const blob = JSON.stringify(turn2.messages)
    // ── 多轮对话的正确行为: 第二次 run 必须记得第一次 run 的 user 消息与工具结果 (当前失败 = 冷启动属实) ──
    expect(blob, '应携带第一轮 user 消息').toContain('TURN-ONE-SENTINEL')
    expect(blob, '应携带第一轮工具结果').toMatch(/"role"\s*:\s*"tool"/)
  })
})
