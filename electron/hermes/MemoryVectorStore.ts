/**
 * PiPiClaw - MemoryVectorStore: 向量缓存持久化层 (#006)
 *
 * ═══ 设计依据 (docs/#006-memory-persistence-design.md) ═══
 * 本层是 **语义向量缓存** (memoryId → vector) — 不是文本真源 (真源在 HermesMemory / ConfigStore)。
 * 本层持久化意义: "重启后不用对每条 memory 重算 embedding" (D5 本地优先 + 缓存效率)。
 *
 * ═══ 并发竞态三钉子 (#006 verdict N1-N3) ═══
 * N1 写队列: persist 串行队列 (this.writeChain), 并发 upsert/delete/reset 触发的落盘排队, 不并发写文件
 * N2 原子 rename: 写 `${file}.tmp` → fs.renameSync (原子替换), 不直接覆盖; rename 前若目标已存在 → 先删后 rename (跨平台兼容)
 * N3 先载后写: 实例构造/显式 load() 优先自磁盘恢复 entries; upsert 在既有 entries 之上合并 (同 id 覆盖, 不同 id 叠加), 不整体替换
 *
 * ═══ debounce flush 钩子 (#006 N2 裁决) ═══
 * 多次 upsert 在 500ms 窗口内合并一次原子替换 (减少 fs 写次数);
 * 显式 `flush()` = 同步落盘钩子 (测试可确定时机 + W5 生命周期 dispose 时消费);
 * `reset()` 立即同步落盘 (防退出前丢)。
 *
 * ═══ X1 双向注释 (SelfLearner ↔ HermesMemory 边界) ═══
 * 见 X1_BOUNDARY 注释段 + README.md — 语义正交 (执行侧学习 vs 用户语义记忆), 不共享存储, 文档即桥。
 * SelfLearner 侧对应注释在 `electron/learning/SelfLearner.ts` (X1 反向注释)。
 *
 * ═══ 红线 (继承 #004/#005) ═══
 * 禁新增模块态 (本类已单例, 实例内可变态不导出); 无 fs 外的外部依赖; 不写安全链; 不 touch brain/main.ts
 */
import * as fs from 'node:fs'
import * as path from 'node:path'
import { getHost } from '../platform/runtime'
import { LogManager } from '../core/LogManager'
import { EventBus } from '../runtime/bridge/EventBus'
import type { Memory } from '../contracts/types'

export interface VectorEntry {
  id: string
  memory: Memory
  vector: number[]
  norm: number
  ts: number
  model?: string
}

/**
 * X1_BOUNDARY — SelfLearner ↔ HermesMemory / MemoryVectorStore 边界
 * ════════════════════════════════════════════════════════════════════════
 *   MemoryVectorStore (本文件)   = 用户语义记忆的向量缓存 (用户要什么 / 偏好 / 指令)
 *   SelfLearner.observations    = 执行侧学习观察 (我做了什么 / 任务 → 技能)
 *
 *   两套语义正交。本单 ( #006 ) 不做代码级合并 — 防人为耦合, 语义混淆。
 *   若未来需要跨引用 (如"基于最近执行历史调整检索权重"), 走 HermesMemory 显式桥接口, 不经本层。
 *   见 electron/learning/SelfLearner.ts 的 X1 反向注释 (双向声明)。
 * ════════════════════════════════════════════════════════════════════════
 */

/** #006 B.2 (五裁决 #1): 容量上限, v1 锁死常量 — LRU 按 ts 保留最新 N 条 */
const MAX_CACHE_ENTRIES = 200
/** #006 N2 裁决: debounce 合并写窗口 */
const PERSIST_DEBOUNCE_MS = 500
/** 持久化文件版本 */
const SCHEMA_VERSION = 1

interface PersistedSchema {
  version: number
  model: string | null
  dimension: number
  entries: Array<{ id: string; vector: number[]; norm: number; model?: string; ts: number }>
}

/**
 * MemoryVectorStore: 语义向量缓存 (带持久化)
 */
export class MemoryVectorStore {
  private static instance: MemoryVectorStore
  private log = LogManager.getInstance()
  private bus = EventBus.getInstance()
  private entries: Map<string, VectorEntry> = new Map()
  private dimension: number = 0
  private activeModel: string | null = null

  // ── #006 新增 (裁决 N1-N3 + 五裁决落地) ─────────────────────────────────
  /** N1 写队列: 串行化 persist, 并发 upsert/delete 不并发写文件 */
  private writeChain: Promise<void> = Promise.resolve()
  /** N2 debounce: 窗口期内多次 upsert 合并一次写 */
  private persistTimer: NodeJS.Timeout | null = null
  private pendingPersist: Promise<void> | null = null
  /** 持久化路径 (测试用可覆盖; 默认 getHost().userData/hermes-memory/vector-cache.json) */
  private persistPath: string | null = null
  /** 容量上限: 生产锁 MAX_CACHE_ENTRIES (五裁决 #1 = 200); 测试可注入小值验 LRU */
  private maxE: number = MAX_CACHE_ENTRIES
  /** 加载标志 (N3 先载后写防重复) */
  private hasLoaded: boolean = false
  // ── 测试辅助 (仅测试消费, 生产零调用) ──────────────────────────────────
  /** 测试覆盖持久化路径 (避免多测试落同一文件) */
  __setPersistencePathForTest(p: string | null): void { this.persistPath = p; this.hasLoaded = false }
  /** 测试注入容量上限 (验 LRU 淘汰语义); 生产不调 → 恒 MAX_CACHE_ENTRIES */
  __setMaxEntriesForTest(n: number): void { this.maxE = n }
  /** 测试用: 显式触发 loadFromDisk (构造器已跑过, __forTest 绕过了构造器, 需手动调) */
  __loadFromDiskForTest(): void {
    this.hasLoaded = false
    this.loadFromDisk()
  }
  /** 测试独立实例工厂 (绕过单例), 生产用 getInstance() */
  static __forTest(): MemoryVectorStore {
    const s = Object.create(MemoryVectorStore.prototype) as MemoryVectorStore
    s.log = LogManager.getInstance()
    s.bus = EventBus.getInstance()
    s.entries = new Map()
    s.dimension = 0
    s.activeModel = null
    s.writeChain = Promise.resolve()
    s.persistTimer = null
    s.pendingPersist = null
    s.persistPath = null
    s.maxE = MAX_CACHE_ENTRIES
    s.hasLoaded = false
    return s
  }
  /** 测试显式同步落盘 (debounce 窗口外), 生产可用 flush() */
  __flushNow(): Promise<void> { return this.flush() }

  private constructor() {
    this.loadFromDisk()
  }

  public static getInstance(): MemoryVectorStore {
    if (!MemoryVectorStore.instance) MemoryVectorStore.instance = new MemoryVectorStore()
    return MemoryVectorStore.instance
  }

  /** 持久化文件路径 (默认 userData/hermes-memory/, 与 HermesMemory.md 同目录 — 语义记忆簇) */
  private cachePath(): string {
    if (this.persistPath) return this.persistPath
    return path.join(getHost().getPath('userData'), 'hermes-memory', 'vector-cache.json')
  }

  // ── upsert (写路径 = N1 串行 + N2 debounce + N3 先载后写自然继承) ────
  async upsert(memory: Memory, vector: number[], model?: string): Promise<void> {
    if (vector.length === 0) {
      this.log.warn('MemoryVectorStore: 空向量,跳过')
      return
    }
    /**
     * 【M3-A】拒收含 NaN/Infinity 的向量。
     *
     * 一个 NaN 会让整条召回链**静默失效**:余弦算出 NaN →
     * `score >= minScore` 恒为 false → 搜索返回空 → 记忆检索"没反应",
     * 而且不报任何错。用户只会觉得"这软件记忆功能坏了"。
     * 宁可丢掉这一条,也不能让一条坏向量毒死整个索引。
     */
    if (vector.some((v) => !Number.isFinite(v))) {
      this.log.warn('MemoryVectorStore: 向量含 NaN/Infinity,拒绝入库(否则整库召回静默失效)')
      return
    }
    // 维度 / 模型切换: 清空旧索引重建 (既有语义, 保留)
    if (this.dimension !== 0 && (vector.length !== this.dimension || (model && this.activeModel && model !== this.activeModel))) {
      this.log.warn(`MemoryVectorStore: 嵌入维度/模型变化(${this.activeModel}@${this.dimension} → ${model}@${vector.length}), 清空旧索引重建`)
      this.entries.clear()
    }
    this.dimension = vector.length
    if (model) this.activeModel = model
    const entry: VectorEntry = {
      id: memory.id,
      memory,
      vector,
      norm: this.l2Norm(vector),
      ts: Date.now(),
      model,
    }
    this.entries.set(memory.id, entry)
    void this.bus.publish('vector:upsert', { id: memory.id, dim: vector.length, model })
    this.schedulePersist()
  }

  // ── search (读路径, 零改动) ─────────────────────────────────────────
  async search(queryVector: number[], topK = 5, minScore = 0.1): Promise<Array<{ entry: VectorEntry; score: number }>> {
    if (this.dimension === 0) return []
    let q = queryVector
    if (queryVector.length !== this.dimension) {
      q = this.normalizeDim(queryVector)
    }
    const queryNorm = this.l2Norm(q)
    if (queryNorm === 0) return []
    const scored: Array<{ entry: VectorEntry; score: number }> = []
    for (const entry of Array.from(this.entries.values())) {
      if (entry.norm === 0) continue
      const dot = this.dotProduct(q, entry.vector)
      const score = dot / (queryNorm * entry.norm)
      if (score >= minScore) {
        scored.push({ entry, score })
      }
    }
    scored.sort((a, b) => b.score - a.score)
    return scored.slice(0, topK)
  }

  // ── delete (写路径 = N1 串行 + N2 立即落盘) ──────────────────────────
  async delete(id: string): Promise<boolean> {
    const removed = this.entries.delete(id)
    if (removed) void this.flush()
    return removed
  }

  // ── list / size (读路径, 零改动) ─────────────────────────────────────
  list(): VectorEntry[] {
    return [...this.entries.values()]
  }
  size(): number {
    return this.entries.size
  }
  /** 当前容量上限 (生产 = MAX_CACHE_ENTRIES 200, 测试注入后 = 注入值) */
  maxEntries(): number { return this.maxE }

  /**
   * 【M3-A】索引当前用的嵌入模型标识。
   *
   * 换后端/换模型后,库里的旧向量属于**另一个语义空间** ——
   * 拿新模型的查询向量去和旧模型的记忆向量算余弦,结果毫无意义
   * (不是"噪声",是"错的")。
   * 上层据此判断是否需要重新嵌入。
   */
  getActiveModel(): string | null { return this.activeModel }

  /** 当前索引的向量维度 */
  getDimension(): number { return this.dimension }

  // ── reset (清全量 + 立即落盘, 防退出前丢) ────────────────────────────
  async reset(): Promise<void> {
    this.entries.clear()
    this.dimension = 0
    this.activeModel = null
    await this.flush()
  }

  /** #006 N2 钩子: debounce 窗口外的显式落盘 — W5 生命周期 dispose 链可消费 (DEV-026) */
  async flush(): Promise<void> {
    // N1: 写入队列 (即使有 pending debounce 也立即排队执行, 防丢)
    if (this.persistTimer) {
      clearTimeout(this.persistTimer)
      this.persistTimer = null
    }
    const p = this.writeChain.then(() => this.persistNow())
    this.writeChain = p.catch(() => {})
    return p
  }

  // ── 内部: debounce 调度 (N2) ──────────────────────────────────────
  private schedulePersist(): void {
    if (this.persistTimer) {
      clearTimeout(this.persistTimer)
      this.persistTimer = this.schedulePersistDebounce()
      return
    }
    this.persistTimer = this.schedulePersistDebounce()
  }

  private schedulePersistDebounce(): NodeJS.Timeout {
    return setTimeout(() => {
      this.persistTimer = null
      const p = this.writeChain.then(() => this.persistNow())
      this.writeChain = p.catch(() => {})
    }, PERSIST_DEBOUNCE_MS)
  }

  // ── 内部: N1 串行 + N2 原子 rename ─────────────────────────────────
  private async persistNow(): Promise<void> {
    // LRU 遗忘 (B.2): 容量超限时按 ts LRU 保留最新 MAX_CACHE_ENTRIES 条
    this.evictIfOverflow()
    const file = this.cachePath()
    const dir = path.dirname(file)
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true })
    const payload: PersistedSchema = {
      version: SCHEMA_VERSION,
      model: this.activeModel,
      dimension: this.dimension,
      entries: Array.from(this.entries.values()).map(e => ({
        id: e.id, vector: e.vector, norm: e.norm, model: e.model, ts: e.ts,
      })),
    }
    const tmp = `${file}.tmp`
    fs.writeFileSync(tmp, JSON.stringify(payload, null, 2), 'utf8')
    // N2 原子替换: 若目标已存在, 先删后 rename (跨平台兼容)
    if (fs.existsSync(file)) fs.unlinkSync(file)
    fs.renameSync(tmp, file)
  }

  /** B.2 遗忘规则: LRU 按 ts, 保留最新 maxE 条 (简单可解释; 生产 maxE=200) */
  private evictIfOverflow(): void {
    if (this.entries.size <= this.maxE) return
    const sorted = Array.from(this.entries.values()).sort((a, b) => b.ts - a.ts)
    const survivors = new Set(sorted.slice(0, this.maxE).map(e => e.id))
    for (const id of [...this.entries.keys()]) {
      if (!survivors.has(id)) this.entries.delete(id)
    }
    this.log.warn(`MemoryVectorStore: LRU 淘汰 (保留 ${survivors.size}/${this.maxE})`)
  }

  // ── 内部: N3 先载后写 (构造器调用; 失败不抛, 清空重建) ─────────────
  private loadFromDisk(): void {
    if (this.hasLoaded) return // N3: 防重复
    this.hasLoaded = true
    try {
      const p = this.cachePath()
      if (!fs.existsSync(p)) return // 首次运行, 正常空
      const raw = fs.readFileSync(p, 'utf8')
      const data = JSON.parse(raw) as Partial<PersistedSchema>
      if (!data || !Array.isArray(data.entries)) throw new Error('bad schema shape')
      this.activeModel = data.model ?? null
      this.dimension = typeof data.dimension === 'number' ? data.dimension : 0
      for (const e of data.entries) {
        // #004 A1 同款: 撕裂行 (坏字段) 跳过, 不抛
        if (!e || typeof e.id !== 'string' || !Array.isArray(e.vector) || typeof e.ts !== 'number') {
          this.log.warn(`MemoryVectorStore: 跳过损坏条目 id=${(e as any)?.id ?? '(empty)'}`)
          continue
        }
        this.entries.set(e.id, {
          id: e.id,
          memory: { id: e.id, content: '', score: 0, createdAt: e.ts } as Memory, // content 由 HermesAdapter 从 legacy 回填
          vector: e.vector,
          norm: typeof e.norm === 'number' ? e.norm : this.l2Norm(e.vector),
          ts: e.ts,
          model: e.model,
        })
      }
      this.evictIfOverflow()
      this.log.info(`MemoryVectorStore: 加载 ${this.entries.size} 条 (model=${this.activeModel}, dim=${this.dimension})`)
    } catch (err) {
      this.log.warn(`MemoryVectorStore: 缓存文件损坏, 清空重建: ${String((err as Error)?.message ?? err)}`)
      this.entries.clear()
      this.dimension = 0
      this.activeModel = null
    }
  }

  // ── 既有内部工具 (零改动) ─────────────────────────────────────────
  private normalizeDim(vec: number[]): number[] {
    if (vec.length === this.dimension) return vec
    if (vec.length > this.dimension) return vec.slice(0, this.dimension)
    return [...vec, ...new Array(this.dimension - vec.length).fill(0)]
  }

  private l2Norm(vec: number[]): number {
    let sum = 0
    for (const v of vec) sum += v * v
    return Math.sqrt(sum)
  }

  private dotProduct(a: number[], b: number[]): number {
    let sum = 0
    for (let i = 0; i < a.length; i++) sum += a[i] * b[i]
    return sum
  }
}
