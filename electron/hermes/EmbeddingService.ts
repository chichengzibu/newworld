import { LogManager } from '../core/LogManager'
import { ConfigStore } from '../core/ConfigStore'
import { createHash } from 'node:crypto'
import type { Memory } from '../contracts/types'

export type EmbeddingModel = 'stub-deterministic' | 'ollama-nomic' | 'openai-ada' | 'zhipu-embedding'

export interface EmbeddingOptions {
  model?: EmbeddingModel
  cache?: boolean
}

/**
 * 嵌入配置(从 ConfigStore `hermes.embedding` 读取):
 * {
 *   provider: 'ollama' | 'openai' | 'zhipu',
 *   apiKey?: string,
 *   baseUrl?: string,   // openai/zhipu: API base(默认官方); ollama: 服务地址(默认 http://localhost:11434)
 *   model?: string      // 具体模型名(覆盖默认)
 * }
 */
export interface EmbeddingConfig {
  provider?: 'ollama' | 'openai' | 'zhipu'
  apiKey?: string
  baseUrl?: string
  model?: string
}

/**
 * 【M3-A】后端探测结果 —— 配置界面据此告诉用户「到底能不能用」。
 *
 * 【为什么要这个类型】
 * 嵌入有两种失败:
 *   ① 连不上(ollama 没起 / API Key 错) —— 明确报错
 *   ② 连上了但【语义是假的】—— 用的是 stub-deterministic,召回是噪声
 * 第二种更危险:用户以为记忆检索在工作,其实在随机匹配。
 * 故探测必须同时报告「后端可达」与「是否真向量」。
 */
export interface EmbeddingProbeResult {
  /** 探测是否成功 */
  ok: boolean;
  /** 生效的嵌入模型标识 */
  model: EmbeddingModel;
  /** 是否是真向量(stub-deterministic = 假) */
  realVectors: boolean;
  /** 向量维度(stub 为 64) */
  dimension?: number;
  /** 往返延迟(ms) */
  latencyMs?: number;
  /** 后端是否可达 */
  reachable: boolean;
  /**
   * 【语义自检】两条相近文本与两条无关文本的余弦相似度对比。
   * 真向量:相近的明显高于无关的;伪向量:两者随机,没有稳定区分。
   */
  semanticCheck?: {
    similar: number;
    unrelated: number;
    /** true = 相近文本确实比无关文本更相似 */
    meaningful: boolean;
  };
  error?: string;
}

/**
 * 【M3-A】本地 ollama 的嵌入模型探测结果。
 */
export interface OllamaEmbeddingModels {
  /** ollama 服务是否可达 */
  available: boolean;
  /** 可用的嵌入模型名 */
  models: string[];
  error?: string;
}

/**
 * EmbeddingService: 把文本转向量。
 * - stub-deterministic: SHA-256 伪随机向量(无需任何依赖,可离线,用于开发与回退)
 * - ollama-nomic: 本地 Ollama(`nomic-embed-text` / `bge-m3` 等,默认 http://localhost:11434)
 * - openai-ada: OpenAI / OpenAI 兼容 embeddings(默认 api.openai.com)
 * - zhipu-embedding: 智谱 embedding(OpenAI 兼容格式,默认 open.bigmodel.cn)
 *
 * 真实后端需要对应服务可用 / API Key 配置;不可用时自动降级 stub 并告警。
 *
 * 【M3-A 要点】
 * ① ollama 走**现代接口** `/api/embed`(支持批量:一次请求多条文本),
 *    老版本 `/api/embeddings` 作回退 —— 老代码只打老接口,批量时 N 次往返。
 * ② 模型名不再硬编码 `nomic-embed-text` —— 本机装的是 bge-m3 就用 bge-m3。
 *    新增 `listOllamaEmbeddingModels()` 供配置界面探测。
 * ③ 新增 `probe()` —— 报告「可达 / 是否真向量 / 维度 / 语义是否成立」。
 * ④ 后端函数一律**显式接收配置**,不临时改全局配置再改回来 ——
 *    那种做法在并发下会把别人的配置也改掉(探测窗口里另一个请求读到了临时值)。
 */
export class EmbeddingService {
  /**
   * 【M3-A】伪向量的**固定**维度。
   * 与真后端维度无关 —— 见 hashToVector 的说明。
   */
  private static readonly STUB_DIMENSION = 64

  private static instance: EmbeddingService
  private log = LogManager.getInstance()
  private configStore = ConfigStore.getInstance()
  private cache: Map<string, number[]> = new Map()
  private dimension: number = 64

  private constructor() {}

  public static getInstance(): EmbeddingService {
    if (!EmbeddingService.instance) EmbeddingService.instance = new EmbeddingService()
    return EmbeddingService.instance
  }

  async embedText(text: string, opts: EmbeddingOptions = {}): Promise<number[]> {
    const model = opts.model ?? this.getActiveModel()
    const cfg = this.getEmbeddingConfig()
    const cacheKey = `${model}::${cfg.model ?? ''}::${text}`
    if (opts.cache !== false && this.cache.has(cacheKey)) {
      return this.cache.get(cacheKey)!
    }
    let vector: number[]
    try {
      vector = await this.embedWith(model, text, cfg)
    } catch (e) {
      this.log.warn(`EmbeddingService: model ${model} 调用失败,降级 stub-deterministic: ${String(e)}`)
      vector = this.hashToVector(text)
    }
    if (opts.cache !== false) this.cache.set(cacheKey, vector)
    return vector
  }

  async embedMemory(memory: Memory, opts: EmbeddingOptions = {}): Promise<number[]> {
    return this.embedText(memory.content, opts)
  }

  /**
   * 【M3-A】批量嵌入 —— ollama 走一次请求(现代接口支持 input 数组),
   * 其余后端仍逐条(OpenAI 兼容接口本身支持批量,但改调用形态风险大于收益,
   * 且 openai/zhipu 的批量响应解析要另写一套 —— 保持简单)。
   */
  async embedBatch(texts: string[], opts: EmbeddingOptions = {}): Promise<number[][]> {
    const model = opts.model ?? this.getActiveModel()
    if (model === 'ollama-nomic' && texts.length > 1) {
      try {
        return await this.embedOllamaBatch(texts, this.getEmbeddingConfig())
      } catch (e) {
        this.log.warn(`EmbeddingService: ollama 批量嵌入失败,回退逐条: ${String(e)}`)
        // 落回逐条 —— 单条仍可能成功(批量接口不存在的老版本 ollama)
      }
    }
    return Promise.all(texts.map(t => this.embedText(t, opts)))
  }

  // ============ 真实后端 ============

  /** 按模型分派到对应后端(不吞异常 —— 由调用方决定是否降级) */
  private async embedWith(model: EmbeddingModel, text: string, cfg: EmbeddingConfig): Promise<number[]> {
    if (model === 'ollama-nomic') return this.embedOllama(text, cfg)
    if (model === 'openai-ada' || model === 'zhipu-embedding') return this.embedOpenAiCompatible(text, model, cfg)
    return this.hashToVector(text)
  }

  /** ollama 批量嵌入:POST {base}/api/embed {model, input:[...]} */
  private async embedOllamaBatch(texts: string[], cfg: EmbeddingConfig): Promise<number[][]> {
    const base = this.ollamaBase(cfg)
    const model = await this.resolveOllamaModel(cfg)
    const res = await fetch(`${base}/api/embed`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ model, input: texts }),
    })
    if (!res.ok) {
      throw new Error(`Ollama HTTP ${res.status}`)
    }
    const data = (await res.json()) as { embeddings?: number[][] }
    const list = data.embeddings
    if (!Array.isArray(list) || list.length !== texts.length) {
      throw new Error('Ollama 批量返回数量不符')
    }
    const first = list[0]
    if (!Array.isArray(first) || first.length === 0) {
      throw new Error('Ollama 返回空向量')
    }
    this.dimension = first.length
    return list
  }

  /** Ollama embeddings:优先现代 /api/embed,老版本回退 /api/embeddings */
  private async embedOllama(text: string, cfg: EmbeddingConfig): Promise<number[]> {
    const base = this.ollamaBase(cfg)
    const model = await this.resolveOllamaModel(cfg)

    // 现代接口(支持批量,返回已归一化的向量)
    try {
      const res = await fetch(`${base}/api/embed`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ model, input: text }),
      })
      if (res.ok) {
        const data = (await res.json()) as { embeddings?: number[][] }
        const vec = data.embeddings?.[0]
        if (Array.isArray(vec) && vec.length > 0) {
          this.dimension = vec.length
          return vec
        }
      }
    } catch {
      // 老版本 ollama 没有 /api/embed → 落回旧接口
    }

    // 老接口(未归一化;余弦相似度对缩放不敏感,不影响排序)
    const res = await fetch(`${base}/api/embeddings`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ model, prompt: text }),
    })
    if (!res.ok) {
      throw new Error(`Ollama HTTP ${res.status}`)
    }
    const data = (await res.json()) as { embedding?: number[] }
    if (!Array.isArray(data.embedding) || data.embedding.length === 0) {
      throw new Error('Ollama 返回空向量')
    }
    this.dimension = data.embedding.length
    return data.embedding
  }

  /** OpenAI / 智谱(OpenAI 兼容)embeddings:POST {base}/embeddings */
  private async embedOpenAiCompatible(text: string, model: EmbeddingModel, cfg: EmbeddingConfig): Promise<number[]> {
    if (!cfg.apiKey) {
      throw new Error('缺少 API Key(配置 hermes.embedding.apiKey)')
    }
    // 默认 base: openai → api.openai.com/v1; zhipu → open.bigmodel.cn/api/paas/v4
    const defaultBase = model === 'zhipu-embedding'
      ? 'https://open.bigmodel.cn/api/paas/v4'
      : 'https://api.openai.com/v1'
    const base = (cfg.baseUrl || defaultBase).replace(/\/$/, '')
    const modelName = cfg.model || (model === 'zhipu-embedding' ? 'embedding-3' : 'text-embedding-3-small')
    const res = await fetch(`${base}/embeddings`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${cfg.apiKey}`,
      },
      body: JSON.stringify({ model: modelName, input: text }),
    })
    if (!res.ok) {
      const errText = await res.text()
      throw new Error(`Embedding API HTTP ${res.status} ${errText.slice(0, 200)}`)
    }
    const data = (await res.json()) as { data?: Array<{ embedding?: number[] }> }
    const emb = data.data?.[0]?.embedding
    if (!Array.isArray(emb) || emb.length === 0) {
      throw new Error('Embedding API 返回空向量')
    }
    this.dimension = emb.length
    return emb
  }

  // ============ 探测与配置 ============

  /**
   * 【M3-A】探测后端 —— 报告可达性、维度、以及**语义是否真的成立**。
   *
   * 【为什么要有语义自检】
   * 「连上了」不等于「有用」。用 SHA-256 伪向量时,两条相近文本的余弦是随机的。
   * 探测时同时嵌入「一对相近文本」与「一对无关文本」,比较两个余弦:
   * 真向量 → 相近的明显更高;伪向量 → 两者随机,没有稳定区分。
   */
  async probe(opts: {
    model?: EmbeddingModel
    baseUrl?: string
    apiKey?: string
    modelName?: string
  } = {}): Promise<EmbeddingProbeResult> {
    const model = opts.model ?? this.getActiveModel()
    const realVectors = model !== 'stub-deterministic'
    const cfg: EmbeddingConfig = {
      ...this.getEmbeddingConfig(),
      ...(opts.baseUrl ? { baseUrl: opts.baseUrl } : {}),
      ...(opts.apiKey ? { apiKey: opts.apiKey } : {}),
      ...(opts.modelName ? { model: opts.modelName } : {}),
    }
    const t0 = Date.now()
    try {
      const [a, b, c] = await Promise.all([
        this.embedWith(model, '把桌面上的文件按类型整理好', cfg),
        this.embedWith(model, '请把桌面文件分类整理一下', cfg),
        this.embedWith(model, '今天天气怎么样,适合出门散步吗', cfg),
      ])
      const similar = cosine(a, b)
      const unrelated = cosine(a, c)
      const dim = a.length
      this.dimension = dim
      return {
        ok: true,
        model,
        realVectors,
        dimension: dim,
        latencyMs: Date.now() - t0,
        reachable: true,
        semanticCheck: {
          similar: round(similar),
          unrelated: round(unrelated),
          // 伪向量的两个余弦是随机的,差值可能偶然为正 —— 故要求有明显的间隔
          meaningful: realVectors ? similar - unrelated > 0.1 : false,
        },
      }
    } catch (e) {
      return {
        ok: false,
        model,
        realVectors: false,
        reachable: false,
        error: String(e),
      }
    }
  }

  /**
   * 【M3-A】列出本地 ollama 可用的嵌入模型。
   *
   * 用于配置界面:用户本机装了什么就选什么,而不是去背模型名。
   */
  async listOllamaEmbeddingModels(baseUrl?: string): Promise<OllamaEmbeddingModels> {
    const cfg = this.getEmbeddingConfig()
    const base = (baseUrl || cfg.baseUrl || 'http://localhost:11434').replace(/\/$/, '')
    try {
      const res = await fetch(`${base}/api/tags`, { method: 'GET' })
      if (!res.ok) {
        return { available: false, models: [], error: `Ollama HTTP ${res.status}` }
      }
      const data = (await res.json()) as {
        models?: Array<{ name?: string; details?: { families?: string[] }; capabilities?: string[] }>
      }
      const list = Array.isArray(data.models) ? data.models : []
      const embeddings = list
        .filter((m) => {
          // 优先按 capabilities 判定;老版本 ollama 没有该字段,退而看 families
          if (Array.isArray(m.capabilities)) return m.capabilities.includes('embedding')
          const fam = m.details?.families ?? []
          return fam.includes('bert') || fam.includes('nomic-bert') || fam.includes('gte')
        })
        .map((m) => m.name!)
        .filter(Boolean)
      return { available: true, models: embeddings }
    } catch (e) {
      return { available: false, models: [], error: String(e) }
    }
  }

  /** 读取当前配置(供 IPC 回给界面) */
  getConfig(): EmbeddingConfig {
    return this.getEmbeddingConfig()
  }

  /** 写入配置 —— 换后端/换模型后必须清缓存(旧向量不可复用) */
  setConfig(cfg: EmbeddingConfig): void {
    this.configStore.set('hermes.embedding', cfg)
    this.clearCache()
  }

  // ============ 工具 ============

  /**
   * 【M3-A】当前生效的嵌入模型标识(公开)。
   *
   * HermesAdapter 此前**自己**复制了一份 provider→model 的映射,
   * 两处各自维护 → 改一处忘另一处,就会"配置说是真向量、实际走的是 stub"。
   * 现单一真源在服务侧。
   */
  public getActiveModelName(): EmbeddingModel {
    return this.getActiveModel()
  }

  private getActiveModel(): EmbeddingModel {
    const cfg = this.getEmbeddingConfig()
    if (cfg.provider === 'ollama') return 'ollama-nomic'
    if (cfg.provider === 'openai') return 'openai-ada'
    if (cfg.provider === 'zhipu') return 'zhipu-embedding'
    return 'stub-deterministic'
  }

  private getEmbeddingConfig(): EmbeddingConfig {
    const cfg = (this.configStore.get('hermes.embedding') as EmbeddingConfig | undefined) ?? {}
    return cfg
  }

  private ollamaBase(cfg: EmbeddingConfig): string {
    return (cfg.baseUrl || 'http://localhost:11434').replace(/\/$/, '')
  }

  /**
   * 【M3-A】解析实际使用的 ollama 模型名。
   *
   * 优先级:用户显式配置 → 本机已装的嵌入模型 → 名义默认。
   * 老代码硬编码 `nomic-embed-text` —— 本机没装这个模型时会直接失败,
   * 而用户明明装了 bge-m3。现按实际可用的模型来。
   */
  private async resolveOllamaModel(cfg: EmbeddingConfig): Promise<string> {
    if (cfg.model) return cfg.model
    const detected = await this.listOllamaEmbeddingModels(cfg.baseUrl)
    if (detected.available && detected.models.length > 0) {
      return detected.models[0]
    }
    return 'nomic-embed-text'
  }

  /**
   * 【M3-A 修 bug】伪向量 —— **固定 64 维**,与真后端的维度无关。
   *
   * 【原来的 bug(只有在真后端可达后才会暴露)】
   * 原实现用 `this.dimension` 决定伪向量的长度,而 `this.dimension` 会被
   * 真后端改写(嵌入一次 bge-m3 就变成 1024)。于是:
   *   ① 伪向量长度跟着漂移 —— 同一段文本在切换后端前后得到不同长度的向量
   *   ② 更糟:`hash` 与 `hash2` 合计只有 64 字节,维度 > 64 时
   *      `hash2[i - hash.length]` **越界** → undefined → 向量里全是 NaN
   *   ③ NaN 向量进向量库 → 余弦 = NaN → `score >= minScore` 恒为 false
   *      → **召回静默返回空** —— 记忆功能看起来"没反应",且不报错
   *
   * 真后端此前不可达(无配置入口),所以这个洞一直藏着;
   * 一旦接上真向量就立刻变成"切回伪向量后记忆检索彻底失效"。
   *
   * 【修法】
   *   - 伪向量维度**固定** STUB_DIMENSION(64),不被真后端污染
   *   - 取字节用取模循环,任何维度都不会越界
   */
  private hashToVector(text: string): number[] {
    const hash = createHash('sha256').update(text).digest()
    const hash2 = createHash('sha256').update(hash).digest()
    const pool = new Uint8Array([...hash, ...hash2])   // 64 字节
    const vector: number[] = []
    for (let i = 0; i < EmbeddingService.STUB_DIMENSION; i++) {
      const byte = pool[i % pool.length]   // 取模循环 —— 任何维度都不越界
      vector.push((byte - 127.5) / 127.5)
    }
    const norm = Math.sqrt(vector.reduce((s, v) => s + v * v, 0))
    if (norm > 0) for (let i = 0; i < vector.length; i++) vector[i] = vector[i] / norm
    return vector
  }

  clearCache(): void {
    this.cache.clear()
  }

  cacheSize(): number {
    return this.cache.size
  }
}

/** 余弦相似度 —— 与 MemoryVectorStore 的实现一致(避免两处口径不同) */
function cosine(a: number[], b: number[]): number {
  const n = Math.min(a.length, b.length)
  let dot = 0, na = 0, nb = 0
  for (let i = 0; i < n; i++) {
    dot += a[i] * b[i]
    na += a[i] * a[i]
    nb += b[i] * b[i]
  }
  if (na === 0 || nb === 0) return 0
  return dot / (Math.sqrt(na) * Math.sqrt(nb))
}

function round(v: number): number {
  return Math.round(v * 10000) / 10000
}
