/**
 * New World - Insight / CostTracker (W5.1)
 *
 * Per-model token usage + USD cost bookkeeping.
 * Persists to userData/cost-log.json. Provides today / recent / per-conversation aggregation
 * for the Insights view.
 */

import { LogManager } from '../core/LogManager'
import { getHost } from '../platform/runtime'
import { EventBus } from '../runtime/bridge/EventBus'
import * as fs from 'node:fs'
import * as path from 'node:path'

import { randomUUID } from 'node:crypto'

export interface UsageEntry {
  id: string
  ts: number
  model: string
  inputTokens: number
  outputTokens: number
  costUsd: number
  conversationId?: string
  skillName?: string
}

export interface ModelPricing {
  inputPer1kUsd: number
  outputPer1kUsd: number
}

export interface TodayCostSummary {
  totalCostUsd: number
  totalInputTokens: number
  totalOutputTokens: number
  byModel: Record<string, number>
}

export class CostTracker {
  private static instance: CostTracker
  private log = LogManager.getInstance()
  private bus = EventBus.getInstance()
  private usages: UsageEntry[] = []
  private pricing: Map<string, ModelPricing> = new Map()
  private storePath: string

  private constructor() {
    this.storePath = path.join(getHost().getPath('userData'), 'cost-log.json')
    this.loadFromDisk()
    this.seedDefaultPricing()
    // 【M4-H】加载用户自定义定价(叠加在默认表之上)
    this.loadPricing()
  }

  public static getInstance(): CostTracker {
    if (!CostTracker.instance) CostTracker.instance = new CostTracker()
    return CostTracker.instance
  }

  /** 默认定价表的模型名集合(用于区分「默认」与「用户自定义」) */
  private static readonly DEFAULT_PRICING_MODELS = [
    'gpt-4o', 'gpt-4o-mini', 'claude-sonnet-4', 'ollama-llama3',
    'ollama-qwen3.5', 'ollama-bge-m3', 'ollama-qwen3.8', 'zhipu-glm-4',
  ]

  private seedDefaultPricing(): void {
    this.pricing.set('gpt-4o', { inputPer1kUsd: 0.005, outputPer1kUsd: 0.015 })
    this.pricing.set('gpt-4o-mini', { inputPer1kUsd: 0.00015, outputPer1kUsd: 0.0006 })
    this.pricing.set('claude-sonnet-4', { inputPer1kUsd: 0.003, outputPer1kUsd: 0.015 })
    this.pricing.set('ollama-llama3', { inputPer1kUsd: 0, outputPer1kUsd: 0 })
    // 【M3-E】本地模型条目 —— 本地推理没有 API 费用,成本确实是 0,
    // 但要有条目才能在按模型分布里归到"本地"这一类(而不是落到"未知")。
    this.pricing.set('ollama-qwen3.5', { inputPer1kUsd: 0, outputPer1kUsd: 0 })
    this.pricing.set('ollama-bge-m3', { inputPer1kUsd: 0, outputPer1kUsd: 0 })
    this.pricing.set('ollama-qwen3.8', { inputPer1kUsd: 0, outputPer1kUsd: 0 })
    this.pricing.set('zhipu-glm-4', { inputPer1kUsd: 0.001, outputPer1kUsd: 0.001 })
  }

  /**
   * 【M4-H】设置某个模型的定价 —— 现**持久化**。
   *
   * 【为什么以前是死的】`setPricing` 此前只改内存里的 Map,**不落盘** →
   * 重启即丢。加上零调用方,等于完全不存在。
   * 而用户自己的模型(比如某个 API 中转站的模型名)不在默认表里 →
   * 查表落空 → 成本恒 0 → 「成本面板永远是 0」却看不出原因。
   */
  setPricing(model: string, p: ModelPricing): void {
    this.pricing.set(model, p)
    this.persistPricing()
  }

  /** 列出全部已知定价(默认表 + 用户自定义) */
  listPricing(): Array<{ model: string; inputPer1kUsd: number; outputPer1kUsd: number; custom: boolean }> {
    const defaults = new Set(CostTracker.DEFAULT_PRICING_MODELS)
    return [...this.pricing.entries()].map(([model, p]) => ({
      model,
      inputPer1kUsd: p.inputPer1kUsd,
      outputPer1kUsd: p.outputPer1kUsd,
      custom: !defaults.has(model),
    }))
  }

  getPricing(model: string): ModelPricing | undefined {
    return this.pricing.get(model)
  }

  /**
   * 【M3-E】定价查表 —— 精确命中 → 归一化命中。
   *
   * 【为什么需要归一化】
   * 定价表是按**基座名**建的('gpt-4o' / 'ollama-llama3'),而真实记录的是
   * **具体模型 id**('gpt-4o-2024-11-20' / 'qwen3.5:9b')。
   * 只做精确查表 → 大部分调用落到 0 定价 → 成本恒为 0(和那个 stub 一样没信息)。
   *
   * 【归一化规则】
   *   ① 精确命中
   *   ② 去掉 provider 前缀与版本后缀后再查('ollama/qwen3.5:9b' → 'qwen3.5')
   *   ③ 都查不到 → 0 定价(**本地模型本就该是 0** —— 没有 API 费用)
   *
   * 【口径提醒】本地模型记 0 美元是对的;对本地用户,真正有用的信号是
   * **token 数按模型的分布**(上下文预算),不是美元。
   */
  private lookupPricing(model: string): ModelPricing {
    const exact = this.pricing.get(model)
    if (exact) return exact

    const norm = (s: string): string =>
      s.toLowerCase()
        .replace(/^(ollama|openai|anthropic|zhipu|deepseek)[-/]/, '')
        .replace(/[:@].*$/, '')          // 去掉 ':9b' / '@latest' 标签
        .replace(/-latest$/, '')
        .replace(/-\d{4}-\d{2}-\d{2}$/, '')   // 去掉日期版本
        .trim()

    const target = norm(model)
    for (const [key, p] of this.pricing) {
      if (norm(key) === target) return p
    }
    // 前缀命中('qwen3.5' 命中 'qwen3.5-9b' 之类)
    for (const [key, p] of this.pricing) {
      const nk = norm(key)
      if (nk && target.startsWith(nk)) return p
    }
    return { inputPer1kUsd: 0, outputPer1kUsd: 0 }
  }

  recordUsage(
    entry: Omit<UsageEntry, 'id' | 'ts' | 'costUsd'> & { costUsd?: number },
  ): UsageEntry {
    const pricing = this.lookupPricing(entry.model)
    const computed =
      (entry.inputTokens / 1000) * pricing.inputPer1kUsd +
      (entry.outputTokens / 1000) * pricing.outputPer1kUsd
    const costUsd = entry.costUsd ?? computed
    const full: UsageEntry = {
      id: randomUUID(),
      ts: Date.now(),
      ...entry,
      costUsd,
    }
    this.usages.push(full)
    void this.bus.publish(
      'cost:usage:recorded',
      { model: full.model, costUsd: full.costUsd },
      'CostTracker',
    )
    this.persistToDisk()
    return full
  }

  getTodayCost(): TodayCostSummary {
    const startOfDay = new Date()
    startOfDay.setHours(0, 0, 0, 0)
    const todayStart = startOfDay.getTime()
    const today = this.usages.filter((u) => u.ts >= todayStart)
    let totalCostUsd = 0
    let totalInputTokens = 0
    let totalOutputTokens = 0
    const byModel: Record<string, number> = {}
    for (const u of today) {
      totalCostUsd += u.costUsd
      totalInputTokens += u.inputTokens
      totalOutputTokens += u.outputTokens
      byModel[u.model] = (byModel[u.model] ?? 0) + u.costUsd
    }
    return { totalCostUsd, totalInputTokens, totalOutputTokens, byModel }
  }

  getRecentUsage(limit = 50): UsageEntry[] {
    return this.usages.slice(-limit)
  }

  getUsageByConversation(conversationId: string): UsageEntry[] {
    return this.usages.filter((u) => u.conversationId === conversationId)
  }

  private loadFromDisk(): void {
    try {
      if (fs.existsSync(this.storePath)) {
        const data = fs.readFileSync(this.storePath, 'utf-8')
        this.usages = JSON.parse(data) as UsageEntry[]
      }
    } catch (e) {
      this.log.warn('CostTracker: load failed', e)
    }
  }

  private persistToDisk(): void {
    try {
      fs.writeFileSync(this.storePath, JSON.stringify(this.usages))
    } catch (e) {
      this.log.warn('CostTracker: persist failed', e)
    }
  }

  /**
   * 【M4-H】定价持久化 —— 与用量记录**分开**存。
   *
   * 用量是频繁追加的(每次 LLM 调用一条),定价是极少变的(用户手动配一次)。
   * 放同一个文件会让「改一次定价」重写整个用量数组。
   */
  private pricingPath(): string {
    return path.join(path.dirname(this.storePath), 'cost-pricing.json')
  }

  private loadPricing(): void {
    try {
      const p = this.pricingPath()
      if (!fs.existsSync(p)) return
      const raw = JSON.parse(fs.readFileSync(p, 'utf-8')) as Record<string, ModelPricing>
      for (const [model, price] of Object.entries(raw ?? {})) {
        if (price && typeof price.inputPer1kUsd === 'number' && typeof price.outputPer1kUsd === 'number') {
          this.pricing.set(model, price)
        }
      }
      this.log.info('CostTracker: 自定义定价已加载', { count: Object.keys(raw ?? {}).length })
    } catch (e) {
      this.log.warn('CostTracker: 定价加载失败', e)
    }
  }

  private persistPricing(): void {
    try {
      // 只存自定义的(默认表每次启动重新 seed,不必落盘)
      const defaults = new Set(CostTracker.DEFAULT_PRICING_MODELS)
      const custom: Record<string, ModelPricing> = {}
      for (const [model, price] of this.pricing) {
        if (!defaults.has(model)) custom[model] = price
      }
      fs.writeFileSync(this.pricingPath(), JSON.stringify(custom, null, 2))
    } catch (e) {
      this.log.warn('CostTracker: 定价保存失败', e)
    }
  }
}