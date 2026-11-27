import { HermesMemory } from './HermesMemory'
import { MemoryVectorStore } from './MemoryVectorStore'
import { EmbeddingService } from './EmbeddingService'
import { KeywordRetriever } from './KeywordRetriever'
import { LogManager } from '../core/LogManager'
import { ConfigStore } from '../core/ConfigStore'
import type { HermesMemory as HermesMemoryInterface, Memory, RecallOptions, CuratorReport, EvolutionReport } from '../contracts/types'
import type { EmbeddingModel } from './EmbeddingService'

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
      /**
       * 【M4.9 修严重 bug：重启后纯向量召回返回空 content】
       *
       * 现象：MemoryVectorStore 持久化只存 id/vector/norm（不存 content），
       * 进程重启 loadFromDisk 后 entry.memory.content 是 `''`。
       * 而 ChatManager 的活跃链（:655）用的是 `useKeyword: false` —— 只走向量路，
       * 于是重启后每一轮 memoryPrompt 都注入 `- ` 这种空条目。
       *
       * 修法：从文本真源（legacy）按 id 回填 content；回填不到的（孤儿向量）直接丢弃，
       * 不把空条目喂给模型。
       */
      const hitIds = raw.map((r) => r.entry.id)
      const backfill = this.legacy.getByIds(hitIds)
      const collected: Array<{ memory: Memory; score: number }> = []
      for (const r of raw) {
        const source = backfill.get(r.entry.id)
        const content = (r.entry.memory.content || source?.content || '').trim()
        if (!content) continue
        collected.push({
          memory: { id: r.entry.id, content, score: r.score, createdAt: r.entry.ts },
          score: r.score,
        })
      }
      vecResults = collected
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

  /**
   * 存一条记忆(文本记忆层 + 向量层)。
   *
   * 【M4-I 修 id 不一致】
   * 旧实现:记忆库的 id 是 `addExperienceMemory` **内部**生成的
   * (`mem_<ts>_<rand>`),调用方给的 id 被无视 → 两边 id 对不上:
   *   ① 召回时候选来自记忆库(真实 id)→ 在向量库里查不到 → **每次召回
   *      都重新嵌入一遍**,向量检索完全没起到缓存作用
   *   ② 调用方那个 id 的条目成了永远匹配不上的**孤儿**,白占索引容量
   *
   * 现:把调用方的 id 传下去当**记录 id**(它是 #006.5 W1 定的幂等键:
   * `chat-<sha256(conversationId|content)>`),两边用同一个 id →
   * 幂等(同 id 覆盖)与召回命中(同 id 查得到)同时成立。
   */
  async store(memory: Memory): Promise<void> {
    // 【M4-I】把调用方的 id 传下去 —— 它是幂等键,不是随手给的
    const saved = this.legacy.addExperienceMemory(memory.content, [], memory.id)
    const model = this.embeddingModel()
    const canonical: Memory = {
      id: saved.id,
      content: saved.content,
      score: saved.importance,
      createdAt: saved.timestamp,
    }
    const vec = await this.embedder.embedText(canonical.content, { model })
    await this.vectorStore.upsert(canonical, vec, model)
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

  /**
   * 记忆整理：真删除低价值条目 + 真晋升层级 + 压缩快照。
   *
   * 【M4.9 修空转】旧实现只 `removed += 1` 计数，一条都不删，
   * `promoted` 恒为 0 —— 名为 curate 实为统计。
   * 现在按三条规则真执行：
   *   ① importance < 10 且超过 30 天 → 遗忘（删）
   *   ② conversation 层 importance ≥ 70 → 晋升 experience
   *   ③ 重写 MEMORY.md 快照（去重 + 截断）
   */
  async curate(): Promise<CuratorReport> {
    const all = this.legacy.getAllMemories()
    const now = Date.now()
    const THIRTY_DAYS = 30 * 86400000

    // ① 遗忘：低重要性 + 陈旧
    const toForget = all
      .filter((m) => (m.importance ?? 0) < 10 && now - m.timestamp > THIRTY_DAYS)
      .map((m) => m.id)
    const removed = this.legacy.removeByIds(toForget)
    for (const id of toForget) {
      try {
        await this.vectorStore.delete(id)
      } catch {
        /* 向量删除失败不影响文本层 */
      }
    }

    // ② 层级晋升
    const { promoted } = this.legacy.promoteMemories()

    // ③ 压缩快照
    this.legacy.compactExperience()

    this.log.info('[HermesAdapter] curate 完成', { removed, promoted })
    return { removed, promoted }
  }

  /**
   * 记忆演化：从「高价值 + 近期」的真实候选里做归并，而不是随机拼字符串。
   *
   * 【M4.9 修空转】旧实现是 `随机取一条 + 拼 "(变体 xxxx)"` —— 纯占位。
   * 现在做两件有语义的事：
   *   ① 合并同主题碎片：找出词面高度重叠的两条，合成一条更完整的记忆（保留更高重要性）
   *   ② 强化被反复召回的记忆：把近期高重要性条目的 importance 上调（边际递减）
   */
  async evolve(): Promise<EvolutionReport> {
    const all = this.legacy.getAllMemories()
    if (all.length === 0) return { newMemories: 0, mutated: 0 }

    let newMemories = 0
    let mutated = 0

    // ① 合并词面重叠的短碎片（两条都很短且互相包含时合并）
    const shortOnes = all
      .filter((m) => m.type !== 'core' && m.content.length >= 8 && m.content.length <= 120)
      .sort((a, b) => b.timestamp - a.timestamp)
      .slice(0, 40)

    const mergePairs: Array<{ keep: typeof all[number]; drop: typeof all[number] }> = []
    const used = new Set<string>()
    for (let i = 0; i < shortOnes.length; i++) {
      const a = shortOnes[i]
      if (used.has(a.id)) continue
      for (let j = i + 1; j < shortOnes.length; j++) {
        const b = shortOnes[j]
        if (used.has(b.id)) continue
        const ca = a.content.trim()
        const cb = b.content.trim()
        // 一条包含另一条且长度接近 → 视为同主题碎片
        if (ca.includes(cb) || cb.includes(ca)) {
          mergePairs.push({ keep: ca.length >= cb.length ? a : b, drop: ca.length >= cb.length ? b : a })
          used.add(a.id)
          used.add(b.id)
          break
        }
      }
      if (mergePairs.length >= 3) break
    }

    for (const { drop, keep } of mergePairs) {
      this.legacy.updateMemory(keep.id, {
        importance: Math.min(100, Math.max(keep.importance ?? 50, drop.importance ?? 50) + 5),
        tags: [...new Set([...(keep.tags ?? []), ...(drop.tags ?? [])])],
      })
      this.legacy.removeByIds([drop.id])
      try {
        await this.vectorStore.delete(drop.id)
      } catch {
        /* 忽略 */
      }
      mutated += 1
    }

    // ② 强化近期高价值记忆（边际递减：每次 +2，上限 100）
    const recentCut = Date.now() - 7 * 86400000
    const toReinforce = all
      .filter((m) => m.timestamp >= recentCut && (m.importance ?? 0) >= 60 && (m.importance ?? 0) < 100)
      .slice(0, 10)
    for (const m of toReinforce) {
      this.legacy.updateMemory(m.id, { importance: Math.min(100, (m.importance ?? 60) + 2) })
      mutated += 1
    }

    if (mutated > 0 || newMemories > 0) {
      this.log.info('[HermesAdapter] evolve 完成', { newMemories, mutated })
    }
    return { newMemories, mutated }
  }
}