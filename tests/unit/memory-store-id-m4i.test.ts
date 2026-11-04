/**
 * PiPiClaw — 记忆库/向量库 id 对齐测试（M4-I）
 * ═══════════════════════════════════════════════════════════════
 * 【这个 bug 的形状】
 * `HermesMemory.addExperienceMemory` **内部**生成 id(`mem_<ts>_<rand>`),
 * **无视**调用方给的 id → 两边 id 对不上,后果:
 *   ① 召回时候选来自记忆库(真实 id)→ 向量库里按调用方 id 建的条目查不到
 *      → **每次召回都重新嵌入**,向量检索完全没起到缓存作用(还白烧算力)
 *   ② 调用方那个 id 的条目成了永远匹配不上的**孤儿**,白占索引容量
 *
 * 【修法的关键:调用方给的 id 不是随手给的】
 * ChatManager 传的是 `chat-<sha256(conversationId|content)>`,
 * 即 #006.5 W1 定的**幂等键**:
 *   「同 conversationId+content → 同 id → 覆盖,不重复」
 * 所以记忆库必须**认**这个 id —— 修法不是"两边都改成随机 id",
 * 而是「让记忆库用调用方的 id」,幂等与召回命中同时成立。
 *
 * 【这类 bug 为什么难发现】
 * 结果**看起来是对的** —— 召回照样能返回记忆(因为每次都重嵌了)。
 * 只有「记忆被重复嵌入了几次」这个计数能暴露它。
 *
 * 【注意计数要分开】
 * 每次召回都会嵌入**查询向量**一次 —— 那是必须的(不 embed 查询就没法检索)。
 * 要盯的是「**记忆**被重复嵌入」—— 那才是浪费。
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'

/** 所有嵌入调用的文本(记忆与查询都走 embedText,故按内容区分) */
const embedCalls: string[] = []
/**
 * 每条用例用**唯一内容** —— 记忆库是落盘的,同 worker 内会跨用例累积
 * (这是本仓既有的隔离手法,见 memory-consumption-006-5 的探针串)。
 */
let seq = 0
const uniq = (base: string) => `${base} #${process.pid}-${seq++}`
const countOf = (needle: string) => embedCalls.filter(t => t === needle).length

vi.mock('electron', () => ({
  app: { getPath: vi.fn((k: string) => `/tmp/pipiclaw-m4i-${k}`) },
  ipcMain: { handle: () => {}, on: () => {}, removeHandler: () => {} },
  BrowserWindow: class {},
  dialog: { showMessageBox: () => {}, showOpenDialog: () => {} },
  shell: { openExternal: () => {}, openPath: () => {} },
}))
vi.mock('electron-log', () => ({
  default: {
    info: () => {}, warn: () => {}, error: () => {}, debug: () => {},
    transports: { file: { resolvePathFn: () => {}, maxSize: 0, format: '' }, console: { level: 'info' } },
  },
}))

/**
 * 假向量 —— 按文本内容哈希,不按长度。
 *
 * 【为什么要哈希而不是长度】
 * 早先用 `[text.length, 1, 0.5]` 当向量,结果余弦相似度实际跟**长度**相关
 * → 召回排序变成"谁跟查询长度像",测试断言的却是语义命中 → 假象。
 * 哈希向量没有语义(这正是伪向量的本质),所以断言只能是
 * 「目标记忆**在**召回结果里」(id 对齐 → 查得到),而不是「排第一」。
 */
function fakeVector(text: string): number[] {
  let h = 2166136261 >>> 0
  for (let i = 0; i < text.length; i++) {
    h = ((h ^ text.charCodeAt(i)) * 16777619) >>> 0
  }
  return [
    ((h >>> 0) % 997) / 997,
    ((h >>> 10) % 991) / 991,
    ((h >>> 20) % 983) / 983,
  ]
}

vi.mock('../../electron/hermes/EmbeddingService', () => ({
  EmbeddingService: {
    getInstance: () => ({
      embedText: async (text: string) => {
        // 记忆与查询的嵌入都走 embedText(见 EmbeddingService.embedMemory → embedText),
        // 所以按内容区分二者
        embedCalls.push(text)
        return fakeVector(text)
      },
      embedMemory: async (m: { content: string }) => {
        embedCalls.push(m.content)
        return fakeVector(m.content)
      },
      getActiveModelName: () => 'stub-deterministic',
    }),
  },
}))

import { HermesAdapter } from '../../electron/hermes/HermesAdapter'
import { HermesMemory } from '../../electron/hermes/HermesMemory'
import { MemoryVectorStore } from '../../electron/hermes/MemoryVectorStore'

describe('M4-I 记忆库/向量库 id 对齐', () => {
  beforeEach(async () => {
    embedCalls.length = 0
    ;(HermesAdapter as any).instance = undefined
    ;(HermesMemory as any).instance = undefined
    ;(MemoryVectorStore as any).instance = undefined
    const store = MemoryVectorStore.getInstance() as any
    // reset() 是 async —— 必须 await,否则上一个用例的条目会漏到下一个用例
    await store.reset?.()
  })

  it('store 后向量库的 id == 记忆库的真实 id(两边对齐)', async () => {
    const adapter = HermesAdapter.getInstance() as any
    await adapter.store({ id: uniq('caller-id'), content: uniq('用户喜欢把 PDF 归档到 D 盘'), score: 50, createdAt: 0 })

    const legacyIds = HermesMemory.getInstance().getAllMemories().map((m: any) => m.id)
    const vectorIds = MemoryVectorStore.getInstance().list().map((e: any) => e.id)

    expect(legacyIds.length).toBe(1)
    expect(vectorIds.length).toBe(1)
    // 关键断言:两边是**同一个** id —— 召回时才查得到
    expect(vectorIds[0]).toBe(legacyIds[0])
  })

  it('调用方给的 id 是**幂等键**(同 id 两次 store → 只净增一条)', async () => {
    // ChatManager 传的是 chat-<sha256(conversationId|content)>,
    // 即 #006.5 W1 定的幂等键。记忆库必须认这个 id,否则幂等就失效了。
    const adapter = HermesAdapter.getInstance() as any
    const store = MemoryVectorStore.getInstance() as any
    const before = store.size()

    const content = uniq('同一条内容')
    const idemKey = uniq('idem-key')
    await adapter.store({ id: idemKey, content, score: 50, createdAt: 0 })
    await adapter.store({ id: idemKey, content, score: 50, createdAt: 1 })

    expect(store.size() - before).toBe(1)
    // 记忆库也只有一条(不重复追加)
    expect(HermesMemory.getInstance().getAllMemories().filter((m: any) => m.id === idemKey)).toHaveLength(1)
  })

  it('第二次召回不再重复嵌入【记忆】(向量索引真的当缓存用了)', async () => {
    const adapter = HermesAdapter.getInstance() as any
    const memoryText = uniq('用户偏好深色主题')
    const queryText = uniq('深色主题')
    await adapter.store({ id: uniq('mem'), content: memoryText, score: 50, createdAt: 0 })

    expect(countOf(memoryText)).toBe(1)   // store 时嵌一次

    await adapter.recall(queryText, { topK: 3, minScore: -1 })
    // 记忆已在索引里 → 召回**不该**再嵌一次记忆
    expect(countOf(memoryText)).toBe(1)
    // 但查询向量每次召回都要嵌(那是必须的)
    expect(countOf(queryText)).toBe(1)

    await adapter.recall(queryText, { topK: 3, minScore: -1 })
    expect(countOf(memoryText)).toBe(1)
    expect(countOf(queryText)).toBe(2)
  })

  it('召回仍能命中该记忆(修 id 不能把功能修坏)', async () => {
    const adapter = HermesAdapter.getInstance() as any
    const memoryText = uniq('用户偏好深色主题')
    const queryText = uniq('深色主题')
    await adapter.store({ id: uniq('mem'), content: memoryText, score: 50, createdAt: 0 })

    const hits = await adapter.recall(queryText, { topK: 20, minScore: -1, useVector: true, useKeyword: false })
    expect(hits.length).toBeGreaterThan(0)
    // 断言「查得到」而不是「排第一」:假向量没有语义,
    // 排第一这件事只能由真向量保证(见 tests/integration/embedding-local-ollama.test.ts)。
    // 这里要验的是【id 对齐后,记忆能被向量检索找到】。
    expect(hits.some((h: any) => h.content === memoryText)).toBe(true)
  })

  it('addExperienceMemory 返回创建的条目(调用方能拿到真实 id)', () => {
    const mem = HermesMemory.getInstance()
    const content = uniq('一条新记忆')
    const item = mem.addExperienceMemory(content, ['tag'])
    expect(item).toBeDefined()
    expect(item.id).toBeTruthy()
    expect(item.content).toBe(content)
  })
})
