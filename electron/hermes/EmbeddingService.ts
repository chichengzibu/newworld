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
interface EmbeddingConfig {
  provider?: 'ollama' | 'openai' | 'zhipu'
  apiKey?: string
  baseUrl?: string
  model?: string
}

/**
 * EmbeddingService: 把文本转向量。
 * - stub-deterministic: SHA-256 伪随机向量(无需任何依赖,可离线,用于开发与回退)
 * - ollama-nomic: 本地 Ollama `nomic-embed-text`(默认 http://localhost:11434)
 * - openai-ada: OpenAI / OpenAI 兼容 embeddings(默认 api.openai.com)
 * - zhipu-embedding: 智谱 embedding(OpenAI 兼容格式,默认 open.bigmodel.cn)
 *
 * 真实后端需要对应服务可用 / API Key 配置;不可用时自动降级 stub 并告警。
 */
export class EmbeddingService {
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
    const cacheKey = `${model}::${text}`
    if (opts.cache !== false && this.cache.has(cacheKey)) {
      return this.cache.get(cacheKey)!
    }
    let vector: number[]
    try {
      if (model === 'ollama-nomic') {
        vector = await this.embedOllama(text, opts)
      } else if (model === 'openai-ada' || model === 'zhipu-embedding') {
        vector = await this.embedOpenAiCompatible(text, model, opts)
      } else {
        vector = this.hashToVector(text)
      }
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

  async embedBatch(texts: string[], opts: EmbeddingOptions = {}): Promise<number[][]> {
    return Promise.all(texts.map(t => this.embedText(t, opts)))
  }

  // ============ 真实后端 ============

  /** Ollama embeddings: POST {base}/api/embeddings */
  private async embedOllama(text: string, _opts: EmbeddingOptions): Promise<number[]> {
    const cfg = this.getEmbeddingConfig()
    const base = (cfg.baseUrl || 'http://localhost:11434').replace(/\/$/, '')
    const model = cfg.model || 'nomic-embed-text'
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

  /** OpenAI / 智谱(OpenAI 兼容)embeddings: POST {base}/embeddings */
  private async embedOpenAiCompatible(text: string, model: EmbeddingModel, _opts: EmbeddingOptions): Promise<number[]> {
    const cfg = this.getEmbeddingConfig()
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

  // ============ 工具 ============

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

  private hashToVector(text: string): number[] {
    const hash = createHash('sha256').update(text).digest()
    const vector: number[] = []
    const hash2 = createHash('sha256').update(hash).digest()
    for (let i = 0; i < this.dimension; i++) {
      const byte = i < hash.length ? hash[i] : hash2[i - hash.length]
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
