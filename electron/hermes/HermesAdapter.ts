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

/**
 * #006.5 阈值常量 (顶层 const, 非模块态 let — 红线沿用 #005 模块态零新增)
 * 口径: 此处"相关度过滤"为【管线验收口径】— stub embedding 下 score 为伪向量余弦,
 *       不构成真实语义排序; 真 embedding 接入后 (DEV-027 同批) 重新裁定阈值语义。
 * 禁"语义检索"措辞: 全单统一用 "相关度过滤 / 管线召回"。
 */
export const RECALL_DEFAULT_TOPK = 5

/**
 * 【M3-B】RRF 的 k 常数 —— 行业标准值 60。
 * k 越大,头部名次之间的差距被压得越平(更看重"进没进前列");
 * k 越小,第一名优势越明显。
 */
const RRF_K = 60

/**
 * 【M3-B】RRF 融合 —— 只看排名,不看分数。
 *
 * @param lists 各路检索结果(已按相关性降序)
 * @param k     平滑常数(越大越平)
 */
export function rrfFuse(
  lists: Array<Array<{ id: string; memory: Memory; score: number }>>,
  k: number,
): ScoredMemory[] {
  const fused = new Map<string, ScoredMemory>()
  for (const list of lists) {
    list.forEach((item, index) => {
      const contribution = 1 / (k + index + 1)
      const existing = fused.get(item.id)
      if (existing) {
        existing._score += contribution
      } else {
        fused.set(item.id, { ...item.memory, _score: contribution })
      }
    })
  }
  return Array.from(fused.values()).sort((a, b) => b._score - a._score)
}
export const RECALL_DEFAULT_MIN_SCORE = 0.1
/**
 * #006.5 R-1 (休眠 brain 链) 阈值常量 — 宽召回 — 备选上下文宁多勿漏
 *
 * ═══ 消费点钉 (#006.5·A 案 b 项) ═══════════════════════════════════════
 * 当前生产消费面: **零** (grep 实查: 仅本定义处, 未在任何调用点出现)
 *   原因: #006.5 R-1 现行实现 = brain 内走 opts.memoryContext **显式参数**透传
 *   (ChatManager/会话层派生时调 recall() 渲染成字符串传 brain, #003-fix 同模式
 *    最严格读法 — brain 零 adapter import, 零 embedText 调用, 无状态红线)。
 *   → 本常量当前未消费。
 *
 * 未来消费点 (W5 接线批):
 *   会话层 (ChatManager / dispatchToAgent 入口) 派生 memoryContext 字符串时, 调用
 *   `HermesAdapter.getInstance().recall(query, { minScore: RECALL_BRAIN_MIN_SCORE })`
 *   → 把 0.5 作为 brain 链的宽召回阈值 (比 R-2 活跃链 0.7 宽, 备选上下文宁多勿漏)。
 *
 * 禁删除: 语义召回阈值面保留 (W5 接线 + DEV-027 真 embedding 接入后激活)。
 * 禁"已在生产生效"措辞: 当前零消费, 是**预留常量**, 非**生产闸**。
 * ═══════════════════════════════════════════════════════════════════
 */
export const RECALL_BRAIN_MIN_SCORE = 0.5
/** #006.5 R-2 (活跃链, 立即生效): 严召回 — 注入 prompt 的条目质量阈值更高 */
export const RECALL_CHAT_MIN_SCORE = 0.7

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

  /**
   * 【M3-A 修类型】签名改为 `AdapterRecallOptions`。
   *
   * 此前签名是 `RecallOptions`(契约里只有 topK/minScore),但实现内部读
   * `useVector`/`useKeyword` —— 于是调用方传这两个字段时,
   * TS 的多余属性检查直接报错(存量 30 条 typecheck 错误里的一条),
   * 而运行时靠 `as AdapterRecallOptions` 强转又能读到。
   *
   * 即:【类型说没有,运行时说有】。AdapterRecallOptions 继承 RecallOptions,
   * 放宽参数类型对既有调用方完全兼容(所有老调用方只传 topK/minScore)。
   */
  async recall(query: string, opts: AdapterRecallOptions = {}): Promise<Memory[]> {
    const adapterOpts = opts
    const topK = opts.topK ?? RECALL_DEFAULT_TOPK
    const minScore = opts.minScore ?? RECALL_DEFAULT_MIN_SCORE
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
      /**
       * 【M3-A 修 bug】模型变了 → 全部重新嵌入。
       *
       * 旧逻辑:`if (!inStoreIds.has(m.id))` 才重嵌。
       * 但换后端时,记忆 id 还在库里(id 没变),于是**一条都不会重嵌** ——
       * 库里留的是旧模型的向量,拿新模型的查询向量去和它们算余弦,
       * 结果不是"噪声"而是"错的"。而 MemoryVectorStore 里那套
       * 「维度/模型变化 → 清空重建」的逻辑因此**永远不会触发**
       * (它只在 upsert 时检查,而 upsert 被跳过了)。
       */
      const indexModel = this.vectorStore.getActiveModel()
      const modelChanged = !!indexModel && indexModel !== model
      if (modelChanged) {
        this.log.warn(`[HermesAdapter] 嵌入模型变化(${indexModel} → ${model}),记忆向量全部重新嵌入`)
        await this.vectorStore.reset()
      }
      const inStoreIds = new Set(this.vectorStore.list().map(e => e.id))
      for (const m of candidates) {
        if (modelChanged || !inStoreIds.has(m.id)) {
          const v = await this.embedder.embedMemory(m, { model })
          await this.vectorStore.upsert(m, v, model)
        }
      }
      const qVec = await this.embedder.embedText(query, { model })
      const raw = await this.vectorStore.search(qVec, topK * 2, minScore)
      vecResults = raw.map(r => ({ memory: r.entry.memory, score: r.score }))
    }

    /**
     * 【M3-B】融合方式改为 RRF(Reciprocal Rank Fusion)。
     *
     * 【旧实现的问题 —— 拿两把不同的尺子比大小】
     * 旧代码对两路结果**取分数的最大值**:
     *   关键词路的分数 = 命中词数 / 查询词数(覆盖率,∈[0,1])
     *   向量路的分数   = 余弦相似度(∈[-1,1])
     * 两者量纲完全不同,却直接比大小。后果:
     *   - 命中 1 个字面词的弱匹配(覆盖率 1.0)能盖过语义高度相关的结果(余弦 0.9)
     *   - 只在一路出现的结果,得分完全由那一路决定,另一路的证据被丢弃
     *   - 两路都命中的结果(最该排前面的)**得不到任何加分**
     *
     * 【RRF 怎么解决】
     * RRF 只看**排名**,不看分数:
     *     score(d) = Σ over lists 1 / (k + rank_list(d))     k=60(标准常数)
     *   - 量纲问题消失(名次是序数,不是实数)
     *   - 两路都命中的结果得分接近翻倍 → 「双路一致」成为强信号
     *   - 不需要给两路分数做归一化(那一步最容易引入手工调参的偏差)
     * 这是混合检索的标准做法(Elasticsearch / Weaviate / Cohere 都在用)。
     *
     * 【口径】minScore 仍是**向量路的语义门**(低于此相似度直接不进候选),
     * 融合只决定候选之间的排序。关键词路没有分数门 —— 覆盖率不适合设门。
     */
    const merged = rrfFuse(
      [
        vecResults.map(r => ({ id: r.memory.id, memory: r.memory, score: r.score })),
        kwResults.map(r => ({ id: r.memory.id, memory: r.memory, score: r.score })),
      ],
      RRF_K,
    )

    return merged
      .slice(0, topK)
      .map(m => ({ id: m.id, content: m.content, score: m.score, createdAt: m.createdAt }))
  }

  async store(memory: Memory): Promise<void> {
    this.legacy.addExperienceMemory(memory.content, [])
    const model = this.embeddingModel()
    const vec = await this.embedder.embedText(memory.content, { model })
    await this.vectorStore.upsert(memory, vec, model)
  }

  /**
   * 读取当前启用的嵌入模型(stub / ollama / openai / zhipu),默认 stub。
   *
   * 【M3-A】provider→model 的映射此前在本文件**另抄了一份**,
   * 与 EmbeddingService.getActiveModel() 各维护各的 ——
   * 两处分叉的后果是"配置说是真向量、实际走的是 stub",
   * 而且用户完全看不出问题(召回只是变差,不会报错)。
   * 现单一真源在 EmbeddingService。
   */
  private embeddingModel(): EmbeddingModel {
    return this.embedder.getActiveModelName()
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