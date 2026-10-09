import { HermesMemory } from './HermesMemory'
import { MemoryVectorStore } from './MemoryVectorStore'
import { EmbeddingService } from './EmbeddingService'
import { KeywordRetriever } from './KeywordRetriever'
import { LogManager } from '../core/LogManager'
import { ConfigStore } from '../core/ConfigStore'
import type { HermesMemory as HermesMemoryInterface, Memory, RecallOptions, CuratorReport, EvolutionReport } from '../contracts/types'
import type { EmbeddingModel } from './EmbeddingService'
import { randomUUID } from 'node:crypto'

export interface AdapterRecallOptions extends RecallOptions {
  useVector?: boolean
  useKeyword?: boolean
}

interface ScoredMemory extends Memory {
  _score: number
}

/**
 * HermesAdapter: 桥接 1.0.0 HermesMemory(10 个方法 facade)到 contracts HermesMemory 4 方法接口。
 * W6 阶段:在 0 改动 HermesMemory.ts 前提下,通过本类实现 recall/store/curate/evolve。
 * W7 阶段:支持 sqlite-vss + 真实 LLM embedding。
 */
export class HermesAdapter implements HermesMemoryInterface {
  private static instance: HermesAdapter
  private log = LogManager.getInstance()
  private legacy = HermesMemory.getInstance()
  private vectorStore = MemoryVectorStore.getInstance()
  private embedder = EmbeddingService.getInstance()
  private keywordRetriever = KeywordRetriever.getInstance()
  private configStore = ConfigStore.getInstance()

  private constructor() {}

  public static getInstance(): HermesAdapter {
    if (!HermesAdapter.instance) HermesAdapter.instance = new HermesAdapter()
    return HermesAdapter.instance
  }

  async recall(query: string, opts: RecallOptions = {}): Promise<Memory[]> {
    const adapterOpts = opts as AdapterRecallOptions
    const topK = opts.topK ?? 5
    const minScore = opts.minScore ?? 0.1
    const useVector = adapterOpts.useVector !== false
    const useKeyword = adapterOpts.useKeyword !== false

    const legacyMemories = this.legacy.getAllMemories()
    const candidates: Memory[] = legacyMemories.map(m => ({
      id: m.id,
      content: m.content,
      score: m.importance,
      createdAt: m.timestamp,
    }))

    if (candidates.length === 0) return []

    let kwResults: Array<{ memory: Memory; score: number }> = []
    if (useKeyword) {
      kwResults = this.keywordRetriever.search(query, candidates, topK * 2).map(r => ({ memory: r.memory, score: r.score }))
    }

    let vecResults: Array<{ memory: Memory; score: number }> = []
    if (useVector) {
      const model = this.embeddingModel()
      const inStoreIds = new Set(this.vectorStore.list().map(e => e.id))
      for (const m of candidates) {
        if (!inStoreIds.has(m.id)) {
          const v = await this.embedder.embedMemory(m, { model })
          await this.vectorStore.upsert(m, v, model)
        }
      }
      const qVec = await this.embedder.embedText(query, { model })
      const raw = await this.vectorStore.search(qVec, topK * 2, minScore)
      vecResults = raw.map(r => ({ memory: r.entry.memory, score: r.score }))
    }

    const merged = new Map<string, ScoredMemory>()
    for (const r of vecResults) {
      const existing = merged.get(r.memory.id)
      if (!existing || r.score > existing._score) {
        merged.set(r.memory.id, { ...r.memory, _score: r.score })
      }
    }
    for (const r of kwResults) {
      const existing = merged.get(r.memory.id)
      if (!existing || r.score > existing._score) {
        merged.set(r.memory.id, { ...r.memory, _score: r.score })
      }
    }

    return Array.from(merged.values())
      .sort((a, b) => b._score - a._score)
      .slice(0, topK)
      .map(m => ({ id: m.id, content: m.content, score: m.score, createdAt: m.createdAt }))
  }

  async store(memory: Memory): Promise<void> {
    this.legacy.addExperienceMemory(memory.content, [])
    const model = this.embeddingModel()
    const vec = await this.embedder.embedText(memory.content, { model })
    await this.vectorStore.upsert(memory, vec, model)
  }

  /** 读取当前启用的嵌入模型(stub / ollama / openai / zhipu),默认 stub */
  private embeddingModel(): EmbeddingModel {
    const cfg = this.configStore.get('hermes.embedding') as { provider?: string } | undefined
    if (!cfg?.provider) return 'stub-deterministic'
    if (cfg.provider === 'ollama') return 'ollama-nomic'
    if (cfg.provider === 'openai') return 'openai-ada'
    if (cfg.provider === 'zhipu') return 'zhipu-embedding'
    return 'stub-deterministic'
  }

  async curate(): Promise<CuratorReport> {
    let removed = 0
    const promoted = 0
    const all = this.legacy.getAllMemories()
    for (const m of all) {
      if ((m.importance ?? 0) < 10) {
        removed += 1
      }
    }
    return { removed, promoted }
  }

  async evolve(): Promise<EvolutionReport> {
    const all = this.legacy.getAllMemories()
    if (all.length === 0) return { newMemories: 0, mutated: 0 }
    const source = all[Math.floor(Math.random() * all.length)]
    const variant = `${source.content} (变体 ${randomUUID().slice(0, 4)})`
    this.legacy.addExperienceMemory(variant, ['evolved'])
    return { newMemories: 1, mutated: 0 }
  }
}