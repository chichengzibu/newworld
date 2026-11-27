/**
 * New World — M3-A 嵌入后端测试
 * ═══════════════════════════════════════════════════════════════
 * 【这一批在测什么】
 * 知识库的「真向量」此前是【只有代码、没有入口】:
 *   - EmbeddingService 的 ollama/openai/zhipu 三个真后端都实现了
 *   - 但 provider 默认 stub-deterministic → 召回用 SHA-256 伪向量 = 噪声
 *   - 且没有任何配置入口(IPC/UI)→ 用户根本设不了
 *
 * 本批锁死四件事:
 *   ① ollama 后端走**现代接口** /api/embed(支持批量),老版本回退 /api/embeddings
 *   ② 模型名**不再硬编码** nomic-embed-text —— 本机装的是 bge-m3 就用 bge-m3
 *   ③ 探测要能区分「连得上」与「语义真的成立」(伪向量也连得上,但召回是噪声)
 *   ④ 换后端要清缓存(旧向量不可复用)
 *
 * 【本测试不联网】global fetch 被替换为本地 mock。
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'

vi.mock('electron', () => ({
  app: { getPath: vi.fn((k: string) => `/tmp/newworld-m3a-${k}`) },
}))

vi.mock('electron-log', () => ({
  default: {
    info: () => {}, warn: () => {}, error: () => {}, debug: () => {},
    transports: { file: { resolvePathFn: () => {}, maxSize: 0, format: '' }, console: { level: 'info' } },
  },
}))

import { EmbeddingService } from '../../electron/hermes/EmbeddingService'

/** 造一个假向量:相近的两条文本给相近的向量 */
function fakeVector(text: string): number[] {
  const desk = text.includes('桌面')
  const weather = text.includes('天气')
  return [
    desk ? 1 : 0,
    weather ? 1 : 0,
    desk ? 0.9 : 0.1,
    0.05,
  ]
}

function jsonResponse(body: unknown, ok = true, status = 200) {
  return {
    ok,
    status,
    json: async () => body,
    text: async () => JSON.stringify(body),
  }
}

describe('M3-A EmbeddingService', () => {
  let svc: EmbeddingService
  let fetchMock: any

  beforeEach(() => {
    vi.clearAllMocks()
    ;(EmbeddingService as any).instance = undefined
    svc = EmbeddingService.getInstance()
    // 默认无配置 → stub
    svc.setConfig({})
    fetchMock = vi.fn()
    vi.stubGlobal('fetch', fetchMock)
  })

  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it('默认 provider 是 stub → 伪向量(界面必须如实标注"召回是噪声")', () => {
    expect(svc.getActiveModelName()).toBe('stub-deterministic')
    expect(svc.getConfig().provider).toBeUndefined()
  })

  it('配置 provider=ollama → 生效模型变为 ollama-nomic', () => {
    svc.setConfig({ provider: 'ollama' })
    expect(svc.getActiveModelName()).toBe('ollama-nomic')
  })

  it('ollama 走现代接口 /api/embed(不是老接口)', async () => {
    svc.setConfig({ provider: 'ollama', model: 'bge-m3' })
    fetchMock.mockResolvedValue(jsonResponse({ embeddings: [[0.1, 0.2, 0.3]] }))

    const v = await svc.embedText('你好', { cache: false })

    expect(v).toEqual([0.1, 0.2, 0.3])
    expect(fetchMock).toHaveBeenCalledTimes(1)
    const url = fetchMock.mock.calls[0][0]
    expect(url).toContain('/api/embed')
    // 请求体用 input(现代字段),不是 prompt(老字段)
    const body = JSON.parse(fetchMock.mock.calls[0][1].body)
    expect(body.input).toBe('你好')
    expect(body.prompt).toBeUndefined()
  })

  it('老版本 ollama(无 /api/embed)→ 回退 /api/embeddings', async () => {
    svc.setConfig({ provider: 'ollama', model: 'bge-m3' })
    fetchMock
      .mockResolvedValueOnce(jsonResponse({ error: 'not found' }, false, 404))
      .mockResolvedValueOnce(jsonResponse({ embedding: [0.5, 0.6] }))

    const v = await svc.embedText('你好', { cache: false })

    expect(v).toEqual([0.5, 0.6])
    expect(fetchMock).toHaveBeenCalledTimes(2)
    expect(fetchMock.mock.calls[0][0]).toContain('/api/embed')
    expect(fetchMock.mock.calls[1][0]).toContain('/api/embeddings')
    const body = JSON.parse(fetchMock.mock.calls[1][1].body)
    expect(body.prompt).toBe('你好')
  })

  it('批量嵌入 → 一次请求(不是 N 次往返)', async () => {
    svc.setConfig({ provider: 'ollama', model: 'bge-m3' })
    fetchMock.mockResolvedValue(jsonResponse({
      embeddings: [[0.1, 0.2], [0.3, 0.4], [0.5, 0.6]],
    }))

    const out = await svc.embedBatch(['a', 'b', 'c'], { cache: false })

    expect(out.length).toBe(3)
    expect(fetchMock).toHaveBeenCalledTimes(1)
    const body = JSON.parse(fetchMock.mock.calls[0][1].body)
    expect(body.input).toEqual(['a', 'b', 'c'])
  })

  it('批量接口失败 → 回退逐条(老版本 ollama 也能用)', async () => {
    svc.setConfig({ provider: 'ollama', model: 'bge-m3' })
    fetchMock
      .mockResolvedValueOnce(jsonResponse({ error: 'not found' }, false, 404))  // 批量失败
      .mockResolvedValue(jsonResponse({ embeddings: [[0.1, 0.2]] }))             // 逐条成功
    const out = await svc.embedBatch(['a', 'b'], { cache: false })
    expect(out.length).toBe(2)
    expect(fetchMock.mock.calls.length).toBeGreaterThan(1)
  })

  it('模型名不硬编码:未指定 model 时用本机探测到的嵌入模型', async () => {
    svc.setConfig({ provider: 'ollama' })
    fetchMock.mockImplementation(async (url: string) => {
      if (url.includes('/api/tags')) {
        return jsonResponse({
          models: [
            { name: 'qwen3.5:9b', capabilities: ['completion'] },
            { name: 'bge-m3:latest', capabilities: ['embedding'] },
          ],
        })
      }
      return jsonResponse({ embeddings: [[0.1]] })
    })

    await svc.embedText('你好', { cache: false })

    const embedCall = fetchMock.mock.calls.find((c: any[]) => c[0].includes('/api/embed'))
    const body = JSON.parse(embedCall[1].body)
    expect(body.model).toBe('bge-m3:latest')
  })

  it('listOllamaEmbeddingModels 只列嵌入模型(不把对话模型算进去)', async () => {
    fetchMock.mockResolvedValue(jsonResponse({
      models: [
        { name: 'qwen3.5:9b', capabilities: ['completion', 'tools'] },
        { name: 'bge-m3:latest', capabilities: ['embedding'] },
        { name: 'nomic-embed-text:latest', capabilities: ['embedding'] },
      ],
    }))

    const r = await svc.listOllamaEmbeddingModels()
    expect(r.available).toBe(true)
    expect(r.models).toEqual(['bge-m3:latest', 'nomic-embed-text:latest'])
    expect(r.models).not.toContain('qwen3.5:9b')
  })

  it('ollama 未启动 → 探测报不可达(不假装成功)', async () => {
    fetchMock.mockRejectedValue(new Error('ECONNREFUSED'))
    const r = await svc.listOllamaEmbeddingModels()
    expect(r.available).toBe(false)
    expect(r.error).toBeDefined()
  })

  it('探测:真向量 → 相近文本明显比无关文本更相似', async () => {
    svc.setConfig({ provider: 'ollama', model: 'bge-m3' })
    fetchMock.mockImplementation(async (_url: string, init: any) => {
      const body = JSON.parse(init.body)
      const input = Array.isArray(body.input) ? body.input[0] : body.input
      return jsonResponse({ embeddings: [fakeVector(input)] })
    })

    const r = await svc.probe()

    expect(r.ok).toBe(true)
    expect(r.realVectors).toBe(true)
    expect(r.dimension).toBe(4)
    expect(r.semanticCheck?.meaningful).toBe(true)
    expect(r.semanticCheck!.similar).toBeGreaterThan(r.semanticCheck!.unrelated)
  })

  it('探测:伪向量 → 语义不成立(界面据此告知用户"召回是噪声")', async () => {
    svc.setConfig({})
    const r = await svc.probe()
    expect(r.ok).toBe(true)
    expect(r.realVectors).toBe(false)
    expect(r.semanticCheck?.meaningful).toBe(false)
  })

  it('探测:后端不可达 → 报失败而非静默降级', async () => {
    svc.setConfig({ provider: 'ollama', model: 'bge-m3' })
    fetchMock.mockRejectedValue(new Error('ECONNREFUSED'))
    const r = await svc.probe()
    expect(r.ok).toBe(false)
    expect(r.reachable).toBe(false)
  })

  it('embedText:后端挂了 → 降级 stub 而不是抛错(主链路不能被拖垮)', async () => {
    svc.setConfig({ provider: 'ollama', model: 'bge-m3' })
    fetchMock.mockRejectedValue(new Error('ECONNREFUSED'))
    const v = await svc.embedText('你好', { cache: false })
    expect(Array.isArray(v)).toBe(true)
    expect(v.length).toBeGreaterThan(0)
  })

  /**
   * 【回归钉】伪向量维度固定 64,不被真后端污染。
   *
   * 原实现用 `this.dimension`(会被真后端改写)决定伪向量长度,
   * 于是嵌入过一次 bge-m3(1024 维)之后,伪向量也变成 1024 维 ——
   * 而 hash+hash2 只有 64 字节 → 越界 → **向量里全是 NaN**。
   * NaN 向量进库 → 余弦 NaN → `score >= minScore` 恒 false
   * → **召回静默返回空**(记忆功能"没反应"且不报错)。
   */
  it('伪向量维度恒为 64,不受真后端维度影响', async () => {
    svc.setConfig({ provider: 'ollama', model: 'bge-m3' })
    fetchMock.mockResolvedValue(jsonResponse({ embeddings: [[0.1, 0.2, 0.3]] }))
    await svc.embedText('先用真后端把 dimension 改成 3', { cache: false })

    // 切回伪向量 —— 长度必须仍是 64,而不是刚才真后端的维度
    svc.setConfig({})
    const v = await svc.embedText('伪向量', { cache: false })
    expect(v.length).toBe(64)
  })

  it('伪向量不含 NaN(任何后端切换顺序下都不含)', async () => {
    svc.setConfig({ provider: 'ollama', model: 'bge-m3' })
    fetchMock.mockResolvedValue(jsonResponse({ embeddings: [[0.1, 0.2, 0.3]] }))
    await svc.embedText('真后端', { cache: false })

    svc.setConfig({})
    const v = await svc.embedText('伪向量', { cache: false })
    expect(v.some((x: number) => !Number.isFinite(x))).toBe(false)
  })

  it('伪向量是确定性的(同文本恒同向量)', async () => {
    svc.setConfig({})
    const a = await svc.embedText('同一段文本', { cache: false })
    const b = await svc.embedText('同一段文本', { cache: false })
    expect(a).toEqual(b)
  })

  it('setConfig 清缓存(换后端后旧向量不可复用)', async () => {
    svc.setConfig({ provider: 'ollama', model: 'bge-m3' })
    fetchMock.mockResolvedValue(jsonResponse({ embeddings: [[0.1, 0.2]] }))
    await svc.embedText('你好')   // 默认走缓存
    expect(svc.cacheSize()).toBeGreaterThan(0)

    svc.setConfig({ provider: 'openai', model: 'x' })
    expect(svc.cacheSize()).toBe(0)
  })
})
