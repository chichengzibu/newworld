/**
 * New World — OpenAI 兼容适配器的 thinking 开关（M4-J 回归）
 * ═══════════════════════════════════════════════════════════════════════
 * 【钉住的是什么】
 * ollama 的 OpenAI 兼容端点(`/v1/chat/completions`)**不认** `think` 字段 ——
 * 它只在原生 `/api/chat` 上认。实测(2026-11-09, ollama 0.40.14, qwen3.5:9b):
 *
 *   /v1/chat/completions + think:false             → reasoning 1073 字符,
 *                                                      max_tokens 全被 thinking 吃掉,
 *                                                      content 为空
 *   /v1/chat/completions + reasoning_effort:"none" → reasoning 长度 0,58 token 出内容
 *   /api/chat           + think:false              → reasoning 长度 0,58 token 出内容
 *
 * 【为什么这不是"慢一点"的问题】
 * 裁判这类调用**只要一行结论**。thinking 吃掉 token → content 空 →
 * 解析失败 → 记为 unknown → 裁判等于没跑。M4-F 的点式裁判(maxTokens 300)
 * 同样中招,这也是 M4-F 遗留里"裁判层未接入生产路径"的隐性原因之一。
 *
 * 故:ollama 端点用 reasoning_effort 关 thinking;非 ollama 端点不动
 * (它们各有各的扩展字段,乱发可能被拒)。
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'

vi.mock('electron', () => ({
  app: { getPath: vi.fn(() => '/tmp/newworld-thinking-test') },
}))
vi.mock('electron-log', () => ({
  default: {
    info: () => {}, warn: () => {}, error: () => {}, debug: () => {},
    transports: { file: { resolvePathFn: () => {}, maxSize: 0, format: '' }, console: { level: 'info' } },
  },
}))

import { OpenAiCompatibleAdapter } from '../../../electron/llm/adapters/openai-compatible'

function mockResponse(opts: { ok: boolean; json?: unknown; text?: string }) {
  return {
    ok: opts.ok,
    status: opts.ok ? 200 : 500,
    json: vi.fn().mockResolvedValue(opts.json ?? {}),
    text: vi.fn().mockResolvedValue(opts.text ?? ''),
  }
}

const OLLAMA_CFG = {
  provider: 'openai-compatible' as const,
  apiKey: 'ollama',
  enabled: true,
  updatedAt: 0,
  apiBaseUrl: 'http://localhost:11434/v1',
}

describe('OpenAI 兼容适配器 · thinking 开关', () => {
  let fetchMock: any

  beforeEach(() => {
    fetchMock = vi.fn()
    vi.stubGlobal('fetch', fetchMock)
  })

  afterEach(() => {
    vi.unstubAllGlobals()
  })

  const bodyOf = () => JSON.parse(fetchMock.mock.calls[0][1].body)

  it('ollama 端点:think=false → 用 reasoning_effort=none 关 thinking', async () => {
    fetchMock.mockResolvedValueOnce(mockResponse({ ok: true, json: { choices: [{ message: { content: 'a 4' } }] } }))
    const adapter = new OpenAiCompatibleAdapter()
    await adapter.chat(OLLAMA_CFG, {
      model: 'qwen3.5:9b',
      messages: [{ role: 'user', content: 'hi' }],
      think: false,
    })
    const body = bodyOf()
    expect(body.reasoning_effort).toBe('none')
    expect(body.think).toBeUndefined()
  })

  it('非 ollama 端点:原样发 think,不发 reasoning_effort', async () => {
    fetchMock.mockResolvedValueOnce(mockResponse({ ok: true, json: { choices: [{ message: { content: 'x' } }] } }))
    const adapter = new OpenAiCompatibleAdapter()
    await adapter.chat(
      { ...OLLAMA_CFG, apiBaseUrl: 'https://api.deepseek.com/v1' },
      { model: 'deepseek-chat', messages: [{ role: 'user', content: 'hi' }], think: false },
    )
    const body = bodyOf()
    expect(body.think).toBe(false)
    expect(body.reasoning_effort).toBeUndefined()
  })

  it('ollama 端点:think=true → 不动(要 thinking 就让它想)', async () => {
    fetchMock.mockResolvedValueOnce(mockResponse({ ok: true, json: { choices: [{ message: { content: 'x' } }] } }))
    const adapter = new OpenAiCompatibleAdapter()
    await adapter.chat(OLLAMA_CFG, {
      model: 'qwen3.5:9b',
      messages: [{ role: 'user', content: 'hi' }],
      think: true,
    })
    const body = bodyOf()
    expect(body.think).toBe(true)
    expect(body.reasoning_effort).toBeUndefined()
  })

  it('没指定 think → 两个字段都不发(不改既有行为)', async () => {
    fetchMock.mockResolvedValueOnce(mockResponse({ ok: true, json: { choices: [{ message: { content: 'x' } }] } }))
    const adapter = new OpenAiCompatibleAdapter()
    await adapter.chat(OLLAMA_CFG, { model: 'qwen3.5:9b', messages: [{ role: 'user', content: 'hi' }] })
    const body = bodyOf()
    expect(body.think).toBeUndefined()
    expect(body.reasoning_effort).toBeUndefined()
  })
})
