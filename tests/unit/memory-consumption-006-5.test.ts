/**
 * #006.5 记忆消费端接入 — V-W-R 用例 (按案计, 实跑为准)
 * ═══════════════════════════════════════════════════════════
 * 硬事实锚 (实读 file:line):
 *   - stub embedding = EmbeddingService.hashToVector (EmbeddingService.ts:154-165) = SHA-256(text)→64 维归一
 *     【完全确定性, 无网络, 无语义】→ 语义相近但文本不同 = 余弦≈0, 进不了 topK。
 *   - embedMemory = embedText(memory.content) (EmbeddingService.ts:75-77) → 向量只由 content 决定。
 *   - W1 幂等口径 = MemoryVectorStore.upsert 同 id 覆盖 (#006 V3 已测); ChatManager W1 用 sha256(convo|content) 派生 id。
 *   - 两处共用同一 recall() / upsert() 入口 (HermesAdapter) → 禁两套实现 (订单开工令 §4)。
 *
 * 断言口径声明 (禁"语义检索"措辞):
 *   Q1 是【管线往返验收】(store→persist→reload→search 全链走通), 用"原文作 query"证明,
 *      非语义相似召回 —— stub 无真实语义模型, 断语义召回 = 虚构 (踩红线)。真 embedding 接 DEV-027 同批后重审。
 * ═══════════════════════════════════════════════════════════
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import * as fs from 'node:fs'
import * as path from 'node:path'
import * as os from 'node:os'
import { MemoryVectorStore } from '../../electron/hermes/MemoryVectorStore'
import { EmbeddingService } from '../../electron/hermes/EmbeddingService'
import { HermesAdapter } from '../../electron/hermes/HermesAdapter'
import type { Memory } from '../../electron/contracts/types'

// ── Q1 管线往返 (持久化→reload→search 全链, 原文作 query) ──────────────
describe('#006.5 Q1 管线往返 (管线验收, 非语义验收)', () => {
  const WORK = path.join(os.tmpdir(), `#006.5-q1-${process.pid}`)
  const cacheFile = path.join(WORK, 'vector-cache.json')
  const contents = ['用户偏好 14 寸深色笔记本', '用户喜欢机械键盘 1.5mm 键程', '用户要求续航 8 小时以上']

  beforeAll(() => { fs.mkdirSync(WORK, { recursive: true }); if (fs.existsSync(cacheFile)) fs.unlinkSync(cacheFile) })
  afterAll(() => { if (fs.existsSync(WORK)) fs.rmSync(WORK, { recursive: true, force: true }) })

  it('Q1: 存 3 条 → flush → 新实例 load → 每条原文作 query 均命中 top-1 (管线走通)', async () => {
    const svc = EmbeddingService.getInstance()
    const w = MemoryVectorStore.__forTest()
    w.__setPersistencePathForTest(cacheFile)

    // 写侧: 存 3 条 (stub 确定性向量)
    for (let i = 0; i < contents.length; i++) {
      const m = { id: `q1-${i}`, content: contents[i], score: 80, createdAt: Date.now() } as Memory
      await w.upsert(m, await svc.embedText(contents[i], { cache: false }), 'stub-deterministic')
    }
    await w.flush()
    expect(fs.existsSync(cacheFile)).toBe(true)

    // 重启模拟: 新实例从磁盘 load
    const r = MemoryVectorStore.__forTest()
    r.__setPersistencePathForTest(cacheFile)
    r.__loadFromDiskForTest()
    expect(r.size()).toBe(3)

    // 读侧: 每条"原文"作 query → 余弦=1.0 → 必命中 top-1 (管线走通证明, 非语义)
    // 注意: VectorStore 只持久化 id/vector/norm/ts, memory.content 不入库 (由 adapter 回填)
    // → 断言 entry.id (而非 entry.memory.content, 后者从磁盘 load 后为 '')
    for (let i = 0; i < contents.length; i++) {
      const qv = await svc.embedText(contents[i], { cache: false })
      const res = await r.search(qv, 3, 0.0)
      expect(res.length).toBeGreaterThanOrEqual(1)
      expect(res[0].entry?.id).toBe(`q1-${i}`)
    }
  })

  it('Q1b minScore 闸行为: 同文命中 (score≈1.0) + 异文高阈值 0.99 全排除 (minScore 过滤断言)', async () => {
    // A 案 c 项: 0.7 生产闸 (R-2) 的行为本身必须有测试覆盖
    // 异文 = 不同文本 → SHA-256 哈希向量残差余弦 ≈ 0 < 0.99 → minScore 排除
    const svc = EmbeddingService.getInstance()
    const w = MemoryVectorStore.__forTest()
    w.__setPersistencePathForTest(cacheFile)

    const stored = 'Q2 探针串 Z1-alpha-beta'
    const other = 'completely different text 完全不同的异文查询串 xyz'
    await w.upsert({ id: 'q2', content: stored, score: 80, createdAt: Date.now() } as Memory,
      await svc.embedText(stored, { cache: false }), 'stub-deterministic')
    await w.flush()

    const r = MemoryVectorStore.__forTest()
    r.__setPersistencePathForTest(cacheFile)
    r.__loadFromDiskForTest()

    // 同文 query → 余弦 = 1.0 → top-1 (minScore 0.0 关闭闸)
    const same = await r.search(await svc.embedText(stored, { cache: false }), 3, 0.0)
    expect(same.length).toBeGreaterThanOrEqual(1)
    expect(same[0].entry?.id).toBe('q2')
    expect(same[0].score).toBeCloseTo(1.0, 5)

    // 异文 query + minScore 0.99 闸 → 残差余弦 < 0.99 → 全排除 → 空结果
    const qvOther = await svc.embedText(other, { cache: false })
    const out = await r.search(qvOther, 3, 0.99)
    expect(out.length).toBe(0)
  })
})

// ── W1 幂等 (同 id 二次 upsert → 零重复, content 取最新) ───────────────
describe('#006.5 W1 向量层沉淀幂等', () => {
  it('W1: 同 content 二次 store → vector 层 size 恒 1 (零重复), 内容取最新', async () => {
    const svc = EmbeddingService.getInstance()
    const w = MemoryVectorStore.__forTest()
    const vec = await svc.embedText('用户要求: 深色模式 14 寸', { cache: false })

    // 第一次 store (id 由 content 派生 — W1 ChatManager 用 sha256(convo|content))
    await w.upsert({ id: 'w1', content: '深色模式 14 寸 v1', score: 50, createdAt: 1 } as Memory, vec, 'stub-deterministic')
    // 二次 store 同 content (id 相同) → 覆盖, 不追加
    await w.upsert({ id: 'w1', content: '深色模式 14 寸 v2', score: 50, createdAt: 2 } as Memory, vec, 'stub-deterministic')
    await w.flush()

    expect(w.size()).toBe(1)
    const only = w.list()[0]
    expect(only.id).toBe('w1')
    expect(only.memory.content).toBe('深色模式 14 寸 v2') // 最新值
  })

  it('W1b: 两处同入口 — HermesAdapter.store 两连发同 content, vector 层不重复', async () => {
    const adapter = HermesAdapter.getInstance()
    const before = (adapter as unknown as { vectorStore: MemoryVectorStore }).vectorStore.size()
    await adapter.store({ id: 'w1b', content: '幂等探测串 X7', score: 50, createdAt: Date.now() })
    await adapter.store({ id: 'w1b', content: '幂等探测串 X7', score: 50, createdAt: Date.now() + 1 })
    const vs = (adapter as unknown as { vectorStore: MemoryVectorStore }).vectorStore
    expect(vs.size() - before).toBe(1) // 两次同 id store 只净增 1 条
  })
})

// ── R-2 活跃链读路径 (共用同一 recall() 入口, 存后召回) ────────────────
describe('#006.5 R-2 活跃链读路径 (共用 recall 入口)', () => {
  it('R-2: store → recall(原文) 命中 (W1 写 & R-2 读同一 adapter 入口)', async () => {
    const adapter = HermesAdapter.getInstance()
    const probe = `R-2 探针串 Z9-${process.pid}`
    await adapter.store({ id: 'r2', content: probe, score: 50, createdAt: Date.now() })
    const recalled = await adapter.recall(probe, { topK: 3, minScore: 0.0 })
    expect(recalled.some(m => m.content.includes('R-2 探针串 Z9'))).toBe(true)
  })
})

// ── R-1 机制单测 (brain run 的 memoryContext 显式参数 → systemPrompt) ──
describe('#006.5 R-1 机制 (memoryContext → systemPrompt, 显式参数)', () => {
  it('R-1: run({memoryContext}) → system 消息含注入串; 不传 → 不含', async () => {
    const captured: Array<Array<{ role: string; content?: string }>> = []
    const llmMockStream = (function* (_req: unknown) {
      captured.push((_req as { messages: Array<{ role: string; content?: string }> }).messages)
      yield { type: 'content', delta: 'ok', accumulated: { content: 'ok' } }
    }) as unknown as (req: unknown, signal: unknown) => AsyncGenerator

    // 运行时替换 LlmClient 实例的 streamChat (brain 内 this.llm = LlmClient.getInstance())
    const LlmClient = (await import('../../electron/llm/LlmClient')).LlmClient
    const inst = LlmClient.getInstance() as unknown as { streamChat: unknown }
    const origStream = inst.streamChat
    inst.streamChat = llmMockStream

    try {
      const { LlmAgentBrain } = await import('../../electron/agent/LlmAgentBrain')
      const brain = LlmAgentBrain.getInstance()
      const MC = '#006.5 R-1 注入记忆串 probe-ABC'
      await brain.run('你好', { memoryContext: MC, maxIterations: 1 })
      // 带 memoryContext 的 run → 该次调用 system 消息含注入串
      const withCtx = captured.find(m => (m[0]?.content ?? '').includes(MC))
      expect(withCtx).toBeDefined()
      expect((withCtx![0]?.content ?? '')).toContain(MC)

      // 不带 memoryContext 的 run → 最后一次调用 system 消息不含注入串
      await brain.run('你好', { maxIterations: 1 })
      const lastSys = captured[captured.length - 1][0]?.content ?? ''
      expect(lastSys).not.toContain(MC)
    } finally {
      inst.streamChat = origStream
    }
  })
})
