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
 * MemoryVectorStore: 内存版向量检索存储。
 * 维度自适应:首个向量插入时确定维度;若后续向量维度(或嵌入模型)变化,
 * 清空旧索引并以新维度重建,避免把 1536 维向量截断到 64 维导致语义丢失。
 * 数值计算纯 JS(向量数小,< 10000)。
 */
export class MemoryVectorStore {
  private static instance: MemoryVectorStore
  private log = LogManager.getInstance()
  private bus = EventBus.getInstance()
  private entries: Map<string, VectorEntry> = new Map()
  private dimension: number = 0
  private activeModel: string | null = null

  private constructor() {}

  public static getInstance(): MemoryVectorStore {
    if (!MemoryVectorStore.instance) MemoryVectorStore.instance = new MemoryVectorStore()
    return MemoryVectorStore.instance
  }

  async upsert(memory: Memory, vector: number[], model?: string): Promise<void> {
    if (vector.length === 0) {
      this.log.warn('MemoryVectorStore: 空向量,跳过')
      return
    }
    // 维度 / 模型切换:清空旧索引重建,避免维度混用
    if (this.dimension !== 0 && (vector.length !== this.dimension || (model && this.activeModel && model !== this.activeModel))) {
      this.log.warn(`MemoryVectorStore: 嵌入维度/模型变化(${this.activeModel}@${this.dimension} → ${model}@${vector.length}),清空旧索引重建`)
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
  }

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

  async delete(id: string): Promise<boolean> {
    return this.entries.delete(id)
  }

  list(): VectorEntry[] {
    return [...this.entries.values()]
  }

  size(): number {
    return this.entries.size
  }

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

  reset(): void {
    this.entries.clear()
    this.dimension = 0
    this.activeModel = null
  }
}
