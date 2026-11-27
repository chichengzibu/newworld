/**
 * 【P2】思考 token 真实数据链 —— 解析层回归
 *
 * 钉住：provider 回传的 reasoning_tokens 必须进 LlmUsage；
 * 没有回传时不能拿 total / completion 冒充，字段必须缺失。
 */
import { describe, it, expect, afterEach, vi } from 'vitest'

vi.mock('electron', () => ({
  app: {
    getPath: vi.fn(() => '/tmp/newworld-reasoning-test'),
    getName: () => 'newworld',
    getVersion: () => '0.0.0',
    isPackaged: false,
  },
}))

vi.mock('electron-log', () => ({
  default: {
    info: () => {},
    warn: () => {},
    error: () => {},
    debug: () => {},
    transports: {
      file: { resolvePathFn: () => {}, maxSize: 0, format: '', level: 'info' },
      console: { level: 'info', format: '' },
    },
  },
}))

import { parseReasoningTokens, parseOpenAiUsage } from '../../../electron/llm/usage'

function mockResponse(json: unknown): Response {
  return {
    ok: true,
    status: 200,
    json: vi.fn().mockResolvedValue(json),
    text: vi.fn().mockResolvedValue(''),
  } as unknown as Response
}

describe('LLM usage 思考 token 解析', () => {
  it('R1: 读 completion_tokens_details.reasoning_tokens（OpenAI o 系列 / DeepSeek-R1）', () => {
    expect(parseReasoningTokens({
      completion_tokens: 100,
      completion_tokens_details: { reasoning_tokens: 42 },
    })).toBe(42)
  })

  it('R2: 读平铺 reasoning_tokens（Ollama / 兼容网关）', () => {
    expect(parseReasoningTokens({ reasoning_tokens: 17 })).toBe(17)
  })

  it('R3: 缺失 / 非法 / 负数一律 undefined，不拿 total 冒充', () => {
    expect(parseReasoningTokens({ total_tokens: 999 })).toBeUndefined()
    expect(parseReasoningTokens({ completion_tokens_details: { reasoning_tokens: 'x' } })).toBeUndefined()
    expect(parseReasoningTokens({ reasoning_tokens: -1 })).toBeUndefined()
  })

  it('R4: parseOpenAiUsage 保留三项真实值，仅在有思考 token 时附带字段', () => {
    expect(parseOpenAiUsage({ prompt_tokens: 10, completion_tokens: 20, total_tokens: 30 }))
      .toEqual({ promptTokens: 10, completionTokens: 20, totalTokens: 30 })
    expect(parseOpenAiUsage({
      prompt_tokens: 10,
      completion_tokens: 20,
      total_tokens: 30,
      completion_tokens_details: { reasoning_tokens: 8 },
    })).toEqual({ promptTokens: 10, completionTokens: 20, totalTokens: 30, reasoningTokens: 8 })
  })

  it('R5: OpenAiAdapter.chat 把思考 token 带进 LlmResponse.usage', async () => {
    const fetchMock = vi.fn().mockResolvedValueOnce(mockResponse({
      choices: [{ message: { content: 'ok' } }],
      usage: {
        prompt_tokens: 10,
        completion_tokens: 20,
        total_tokens: 30,
        completion_tokens_details: { reasoning_tokens: 12 },
      },
    }))
    vi.stubGlobal('fetch', fetchMock)
    const { OpenAiAdapter } = await import('../../../electron/llm/adapters/openai')
    const res = await new OpenAiAdapter().chat(
      { provider: 'openai', apiKey: 'k', enabled: true, updatedAt: 0 },
      { model: 'm', messages: [{ role: 'user', content: 'hi' }] },
    )
    expect(res.usage).toEqual({ promptTokens: 10, completionTokens: 20, totalTokens: 30, reasoningTokens: 12 })
  })

  it('R6: OpenAI-compatible adapter（Ollama）同样带出思考 token', async () => {
    const fetchMock = vi.fn().mockResolvedValueOnce(mockResponse({
      choices: [{ message: { content: 'ok' } }],
      usage: { prompt_tokens: 5, completion_tokens: 9, total_tokens: 14, reasoning_tokens: 6 },
    }))
    vi.stubGlobal('fetch', fetchMock)
    const { OpenAiCompatibleAdapter } = await import('../../../electron/llm/adapters/openai-compatible')
    const res = await new OpenAiCompatibleAdapter().chat(
      { provider: 'openai-compatible', apiKey: 'k', enabled: true, updatedAt: 0, apiBaseUrl: 'http://127.0.0.1:11434/v1' },
      { model: 'qwen3', messages: [{ role: 'user', content: 'hi' }] },
    )
    expect(res.usage).toEqual({ promptTokens: 5, completionTokens: 9, totalTokens: 14, reasoningTokens: 6 })
  })

  afterEach(() => {
    vi.unstubAllGlobals()
  })
})
