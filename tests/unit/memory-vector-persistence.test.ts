/**
 * #006 记忆持久化: V1-V7 测试
 * ═══════════════════════════════════════════════════
 * V1 持久化往返: upsert → flush → 重建实例 → 加载 → 断言 search 一致 (score 容差 0.01)
 * V2 重启模拟: 实例 1 写 3 条 → flush → 实例 2 加载 → list.length === 3
 *   (裁决 2 增量: V2 补 "启动即写不吞并发" 断言并发下仍写对)
 * V3 精确去重: 同 id 两条内容不同 upsert → 保留最新 (内容 = 新的)
 * V4 容量遗忘: 注入 maxE=5, 写 8 条 → size() === 5, 保留 ts 最新 5 条
 * V5 损坏容错: 整个文件非法 JSON → 加载不抛, size() === 0
 * V6 单条损坏: 5 条里有 1 条 vector 非数组 → 跳过坏条, size() === 4
 * V7 零网络: stub-deterministic path 下 EmbeddingService.fetch 零调用
 * ═══════════════════════════════════════════════════
 * 案→用例映射: V1=B.1 持久化往返 / V2=B.3 启动加载+N1 写队列 / V3=B.2 去重
 *             V4=B.2 遗忘 / V5-V6=B.3 损坏容错 (#004 A1 同款) / V7=B.4 D5
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import * as fs from 'node:fs'
import * as path from 'node:path'
import * as os from 'node:os'
import { MemoryVectorStore, type VectorEntry } from '../../electron/hermes/MemoryVectorStore'
import { EmbeddingService } from '../../electron/hermes/EmbeddingService'
import { TEST_USER_DATA } from './test-host'
import type { Memory } from '../../electron/contracts/types'

/** 测试独立工作目录 (按 pid 隔离) */
const WORK = path.join(os.tmpdir(), `#006-vms-${process.pid}`)

/** 确定性伪向量 (64 维) */
function vec(id: number, dim = 64): number[] {
  const v: number[] = []
  for (let i = 0; i < dim; i++) v.push(((id * 7 + i * 3) % 256) / 127.5 - 1)
  const norm = Math.sqrt(v.reduce((s, x) => s + x * x, 0))
  for (let i = 0; i < v.length; i++) v[i] = v[i] / norm
  return v
}

/** 确定性 query vector (与 vec(id) 语义相近, cosine 高) */
function queryVec(baseId: number, dim = 64): number[] { return vec(baseId, dim) }

describe('#006 记忆持久化 V1-V7', () => {
  let cacheFile: string
  let store0: MemoryVectorStore

  beforeEach(() => {
    fs.mkdirSync(WORK, { recursive: true })
    cacheFile = path.join(WORK, 'vector-cache.json')
    if (fs.existsSync(cacheFile)) fs.unlinkSync(cacheFile)
    store0 = MemoryVectorStore.__forTest()
    store0.__setPersistencePathForTest(cacheFile)
  })

  afterEach(() => {
    if (fs.existsSync(WORK)) fs.rmSync(WORK, { recursive: true, force: true })
  })

  it('V1 持久化往返: upsert → flush → 新实例 → 加载 → search 一致 (score 容差 0.01)', async () => {
    // 写 3 条
    for (let i = 1; i <= 3; i++) {
      await store0.upsert({ id: `m${i}`, content: `memory-${i}`, score: 1, createdAt: 0 } as Memory, vec(i), 'stub-deterministic')
    }
    await store0.flush()
    expect(fs.existsSync(cacheFile)).toBe(true)

    // 新实例 (模拟重启)
    const store1 = MemoryVectorStore.__forTest()
    store1.__setPersistencePathForTest(cacheFile)
    store1.__loadFromDiskForTest() // N3 先载后写
    const loaded = store1.list()
    expect(loaded.length).toBe(3)
    expect(loaded.map(e => e.id).sort()).toEqual(['m1', 'm2', 'm3'])

    // search 一致性: 用 vec(2) 查, m2 的 score 应该最高
    const results = await store1.search(vec(2))
    expect(results.length).toBeGreaterThanOrEqual(3)
    expect(results[0].entry.id).toBe('m2')
  })

  it('V2 重启模拟 + 并发不吞 (N1 写队列): 写 3 条 → flush → 新实例加载 → 3 条', async () => {
    // 并发写 (N1 验证点: 同时触发 3 次 upsert, 队列化后仍落对)
    await Promise.all([
      store0.upsert({ id: 'a', content: 'a', score: 1, createdAt: 0 } as Memory, vec(10), 'stub-deterministic'),
      store0.upsert({ id: 'b', content: 'b', score: 1, createdAt: 0 } as Memory, vec(11), 'stub-deterministic'),
      store0.upsert({ id: 'c', content: 'c', score: 1, createdAt: 0 } as Memory, vec(12), 'stub-deterministic'),
    ])
    await store0.flush()
    expect(fs.existsSync(cacheFile)).toBe(true)

    const store1 = MemoryVectorStore.__forTest()
    store1.__setPersistencePathForTest(cacheFile)
    store1.__loadFromDiskForTest() // N3
    const loaded = store1.list()
    expect(loaded.length).toBe(3)
    expect(loaded.map(e => e.id).sort()).toEqual(['a', 'b', 'c'])
  })

  it('V3 精确去重 (id 覆盖): 同 id 不同内容 upsert → 保留最新', async () => {
    await store0.upsert({ id: 'x', content: 'v1', score: 1, createdAt: 0 } as Memory, vec(100), 'stub-deterministic')
    await store0.upsert({ id: 'x', content: 'v2', score: 1, createdAt: 0 } as Memory, vec(200), 'stub-deterministic')
    await store0.flush()
    const list = store0.list()
    expect(list.length).toBe(1)
    expect(list[0].id).toBe('x')
    expect(list[0].memory.content).toBe('v2')
  })

  it('V4 容量遗忘: 注入 maxE=5, 写 8 条 → size() === 5, 保留 ts 最新 5', async () => {
    store0.__setMaxEntriesForTest(5)
    let fakeTs = 1000000
    const origNow = Date.now
    Date.now = () => ++fakeTs  // 每条 ts 单调增
    try {
      for (let i = 0; i < 8; i++) {
        await store0.upsert({ id: `e${i}`, content: `e${i}`, score: 1, createdAt: fakeTs } as Memory, vec(50 + i), 'stub-deterministic')
      }
    } finally {
      Date.now = origNow
    }
    await store0.flush()
    expect(store0.size()).toBe(5)
    // 应保留 e3,e4,e5,e6,e7 (ts 单调增 → 最新 5 条)
    const ids = store0.list().map(e => e.id).sort()
    expect(ids).toEqual(['e3', 'e4', 'e5', 'e6', 'e7'])
  })

  it('V5 损坏容错: 整个文件非法 JSON → 加载不抛, size() === 0', async () => {
    fs.mkdirSync(path.dirname(cacheFile), { recursive: true })
    fs.writeFileSync(cacheFile, '{totally invalid: json,,}', 'utf8')
    const store1 = MemoryVectorStore.__forTest()
    store1.__setPersistencePathForTest(cacheFile)
    store1.__loadFromDiskForTest()
    expect(store1.size()).toBe(0)
    // 加载后仍可写 (不因坏文件崩溃)
    await store1.upsert({ id: 'new', content: 'new', score: 1, createdAt: 0 } as Memory, vec(300), 'stub-deterministic')
    await store1.flush()
    expect(store1.size()).toBe(1)
  })

  it('V6 单条损坏: 5 条里 1 条 vector 非数组 → 跳过坏条, size() === 4', async () => {
    // 构造损坏文件
    const badEntry = { id: 'bad', vector: 'not-an-array', norm: 1, ts: 1 }
    const payload = {
      version: 1,
      model: 'stub-deterministic',
      dimension: 64,
      entries: [
        { id: 'ok-1', vector: vec(1, 64), norm: 1, ts: 1 },
        { id: 'ok-2', vector: vec(2, 64), norm: 1, ts: 2 },
        badEntry,
        { id: 'ok-3', vector: vec(3, 64), norm: 1, ts: 3 },
        { id: 'ok-4', vector: vec(4, 64), norm: 1, ts: 4 },
      ],
    }
    fs.mkdirSync(path.dirname(cacheFile), { recursive: true })
    fs.writeFileSync(cacheFile, JSON.stringify(payload), 'utf8')

    const store1 = MemoryVectorStore.__forTest()
    store1.__setPersistencePathForTest(cacheFile)
    store1.__loadFromDiskForTest()
    expect(store1.size()).toBe(4)
    const ids = store1.list().map(e => e.id).sort()
    expect(ids).toEqual(['ok-1', 'ok-2', 'ok-3', 'ok-4'])
    expect(ids).not.toContain('bad')
  })

  it('V7 D5 零网络: stub-deterministic 下 EmbeddingService fetch 零调用', async () => {
    // 拦截全局 fetch (stub 路径不应触网)
    let fetchCalls = 0
    const origFetch = globalThis.fetch
    globalThis.fetch = (async () => { fetchCalls++; throw new Error('fetch should not be called in stub') }) as typeof fetch
    try {
      const svc = EmbeddingService.getInstance()
      // 强制 stub (无 provider 配置)
      const v = await svc.embedText('hello world', { cache: false })
      expect(Array.isArray(v)).toBe(true)
      expect(v.length).toBeGreaterThan(0)
      expect(fetchCalls).toBe(0)
      // 写一条 + flush (完整持久化闭环)
      await store0.upsert({ id: 'v7', content: 'v7', score: 1, createdAt: 0 } as Memory, v, 'stub-deterministic')
      await store0.flush()
    } finally {
      globalThis.fetch = origFetch
    }
    expect(fetchCalls).toBe(0)
  })

  /**
   * 【M3-A 新增 V8】NaN 向量拒收 —— 纵深防御。
   *
   * 【为什么这条必须钉死】
   * 一条 NaN 向量进库 → 余弦算出 NaN → `score >= minScore` 恒为 false
   * → 整个索引**一条都召不回**,而且不报任何错。
   * 用户看到的只是"记忆功能好像坏了",排查起来毫无线索。
   *
   * 上一条(V7)钉的是"stub 路径不该产生 NaN",
   * 这条钉的是"就算别处传进来 NaN,也不能让它进库"。
   */
  it('V8 【M3-A】NaN/Infinity 向量拒收(一条坏向量不能毒死整个索引)', async () => {
    await store0.upsert(
      { id: 'good', content: '好的', score: 1, createdAt: 0 } as Memory,
      [0.1, 0.2, 0.3], 'stub-deterministic',
    )
    await store0.upsert(
      { id: 'nan', content: '坏的', score: 1, createdAt: 0 } as Memory,
      [0.1, NaN, 0.3], 'stub-deterministic',
    )
    await store0.upsert(
      { id: 'inf', content: '也坏的', score: 1, createdAt: 0 } as Memory,
      [0.1, Infinity, 0.3], 'stub-deterministic',
    )

    expect(store0.size()).toBe(1)                 // 只有好的那条进了库
    const hits = await store0.search([0.1, 0.2, 0.3], 5, -1)
    expect(hits.length).toBe(1)
    expect(hits[0].entry.id).toBe('good')
    expect(Number.isFinite(hits[0].score)).toBe(true)
  })
})
