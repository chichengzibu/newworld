/**
 * IM 真连通 · LlmReplyGenerator 单测
 *
 * 验证生产回复生成器确实调用 LlmClient（不是 stub / echo），
 * 且能把「设置 → 模型管理」里已启用的 provider 解析成 inline config。
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'

const { chatSpy, getEnabledProviders, getLastProvider, getLastModel, getActive } = vi.hoisted(() => ({
  chatSpy: vi.fn(),
  getEnabledProviders: vi.fn(() => [] as any[]),
  getLastProvider: vi.fn(() => null as string | null),
  getLastModel: vi.fn(() => null as string | null),
  getActive: vi.fn(() => undefined as any),
}))

vi.mock('../../electron/llm/LlmClient', () => ({
  LlmClient: { getInstance: () => ({ chat: chatSpy }) },
}))
vi.mock('../../electron/llm/LlmConfigStore', () => ({
  LlmConfigStore: { getInstance: () => ({ getActive }) },
}))
vi.mock('../../electron/chat/ChatConfig', () => ({
  ChatConfig: { getInstance: () => ({ getLastProvider, getLastModel }) },
}))
vi.mock('../../electron/models/ModelManager', () => ({
  ModelManager: {
    getInstance: () => ({ getEnabledProviders, getProvider: () => undefined }),
  },
}))

import { createLlmReplyGenerator, NoModelConfiguredError } from '../../electron/channel/LlmReplyGenerator'
import type { ReplyContext } from '../../electron/channel/InboundBridge'

const ctx: ReplyContext = {
  channelId: 'im-telegram',
  channelKind: 'im-telegram',
  to: 'chat-1',
  from: 'user-1',
  cleanContent: '帮我总结今天的工作',
}

beforeEach(() => {
  vi.clearAllMocks()
  getEnabledProviders.mockReturnValue([])
  getLastProvider.mockReturnValue(null)
  getLastModel.mockReturnValue(null)
  getActive.mockReturnValue(undefined)
  chatSpy.mockResolvedValue({ ok: true, provider: 'openai-compatible', model: 'qwen3.5:9b', content: '  已完成总结  ', durationMs: 12 })
})

describe('LG-1: provider 解析', () => {
  it('无任何可用模型 → 抛 NoModelConfiguredError（不编造回复）', async () => {
    await expect(createLlmReplyGenerator()(ctx)).rejects.toBeInstanceOf(NoModelConfiguredError)
    expect(chatSpy).not.toHaveBeenCalled()
  })

  it('用户在模型管理里配了 enabled provider（聊天没手选）→ 仍能真调 LLM', async () => {
    getEnabledProviders.mockReturnValue([{
      id: 'p1', name: '本地 Ollama', type: 'ollama', enabled: true,
      baseUrl: 'http://localhost:11434', apiKey: '',
      models: [{ id: 'qwen3.5:9b', name: 'qwen3.5:9b', provider: 'p1', capabilities: ['chat'] }],
    }])

    const reply = await createLlmReplyGenerator()(ctx)

    expect(reply).toBe('已完成总结')
    expect(chatSpy).toHaveBeenCalledOnce()
    const req = chatSpy.mock.calls[0][0]
    expect(req.model).toBe('qwen3.5:9b')
    expect(req.config).toMatchObject({
      provider: 'openai-compatible',
      apiBaseUrl: 'http://localhost:11434/v1',
    })
    expect(req.messages[0].role).toBe('system')
    expect(req.messages[1]).toMatchObject({ role: 'user', content: '帮我总结今天的工作' })
  })

  it('ChatConfig 上次选中 provider 优先于自动挑选', async () => {
    getLastProvider.mockReturnValue('p1')
    getLastModel.mockReturnValue('custom-model')
    getEnabledProviders.mockReturnValue([{
      id: 'p1', name: 'Ollama', type: 'ollama', enabled: true,
      baseUrl: 'http://localhost:11434', models: [],
    }])
    // getProvider 在 mock 里恒 undefined → 回退到 LlmConfigStore.getActive
    getActive.mockReturnValue({ provider: 'openai-compatible', apiKey: 'k', enabled: true, defaultModel: 'fallback-model', updatedAt: 0 })

    await createLlmReplyGenerator()(ctx)
    expect(chatSpy.mock.calls[0][0].model).toBe('custom-model')
  })
})

describe('LG-2: 失败处理', () => {
  beforeEach(() => {
    getEnabledProviders.mockReturnValue([{
      id: 'p1', name: 'Ollama', type: 'ollama', enabled: true,
      baseUrl: 'http://localhost:11434', models: [], defaultModel: 'qwen3.5:9b',
    }])
  })

  it('LLM 返回 ok:false → 抛带原因的错误', async () => {
    chatSpy.mockResolvedValue({ ok: false, provider: 'openai-compatible', model: 'm', content: '', durationMs: 1, error: 'connection refused' })
    await expect(createLlmReplyGenerator()(ctx)).rejects.toThrow(/connection refused/)
  })

  it('LLM 返回空内容 → 抛错，不回空消息', async () => {
    chatSpy.mockResolvedValue({ ok: true, provider: 'openai-compatible', model: 'm', content: '', durationMs: 1 })
    await expect(createLlmReplyGenerator()(ctx)).rejects.toThrow(/未返回任何内容/)
  })
})
