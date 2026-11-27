import { describe, it, expect, vi } from 'vitest'

/**
 * New World — provider 桥接测试（M4-L）
 * ═══════════════════════════════════════════════════════════════════════
 * 【背景】本项目有**两套 provider 注册表**(路线图开篇的「LLM 精神分裂」):
 *   · ModelManager    —— 用户在「设置 → 模型管理」配的 provider(聊天选型器读它)
 *   · LlmConfigStore  —— LlmClient 唯一认的表(按 provider **类型**索引)
 * 两边不同步,且设置页**没有** LlmConfigStore 的入口 →
 * agent 路径(自 M4-B 起是聊天默认路径)永远拿不到 provider →
 * 每条消息先报一次 "no LLM provider configured" 再回落旧管道。
 *
 * 本测试钉住桥接的两端:
 *   ① 映射:ModelManager 的 provider 类型 → LlmClient 的 provider 类型 + baseUrl 归一
 *   ② 通道:LlmClient 收到**显式配置**时用它,不再要求 LlmConfigStore 里有同名条目
 */

vi.mock('electron', () => ({
  app: { getPath: vi.fn((k: string) => `/tmp/newworld-provider-bridge-${k}`) },
}))
vi.mock('electron-log', () => ({
  default: {
    info: () => {}, warn: () => {}, error: () => {}, debug: () => {},
    transports: { file: { resolvePathFn: () => {}, maxSize: 0, format: '' }, console: { level: 'info' } },
  },
}))

import { toLlmProviderType, toLlmProviderConfig } from '../../../electron/models/ModelProvider'
import type { ProviderConfig } from '../../../electron/models/ModelProvider'
import { LlmClient } from '../../../electron/llm/LlmClient'

const provider = (over: Partial<ProviderConfig> = {}): ProviderConfig => ({
  id: 'p1',
  name: '测试 provider',
  type: 'openai',
  enabled: true,
  baseUrl: 'https://api.example.com/v1',
  apiKey: 'sk-test',
  models: [],
  createdAt: 0,
  updatedAt: 0,
  ...over,
})

describe('M4-L provider 桥接 · 类型映射', () => {
  it('openai / anthropic 直通', () => {
    expect(toLlmProviderType('openai')).toBe('openai')
    expect(toLlmProviderType('anthropic')).toBe('anthropic')
  })

  it('ollama 走 openai-compatible', () => {
    expect(toLlmProviderType('ollama')).toBe('openai-compatible')
  })

  it('deepseek / azure / custom / volc_ark / openrouter 都走 openai-compatible', () => {
    for (const t of ['deepseek', 'azure', 'custom', 'volc_ark', 'openrouter'] as const) {
      expect(toLlmProviderType(t), t).toBe('openai-compatible')
    }
  })
})

describe('M4-L provider 桥接 · baseUrl 归一', () => {
  it('ollama 的 baseUrl 补 /v1', () => {
    const cfg = toLlmProviderConfig(provider({ type: 'ollama', baseUrl: 'http://localhost:11434' }))
    expect(cfg.provider).toBe('openai-compatible')
    expect(cfg.apiBaseUrl).toBe('http://localhost:11434/v1')
  })

  it('ollama 已带 /v1 时不重复加', () => {
    const cfg = toLlmProviderConfig(provider({ type: 'ollama', baseUrl: 'http://localhost:11434/v1' }))
    expect(cfg.apiBaseUrl).toBe('http://localhost:11434/v1')
  })

  it('ollama 没有 baseUrl 时用默认端口', () => {
    const cfg = toLlmProviderConfig(provider({ type: 'ollama', baseUrl: undefined }))
    expect(cfg.apiBaseUrl).toBe('http://localhost:11434/v1')
  })

  it('其它类型原样透传 baseUrl 与 apiKey', () => {
    const cfg = toLlmProviderConfig(provider({ type: 'openai', baseUrl: 'https://api.example.com/v1', apiKey: 'sk-x' }))
    expect(cfg).toEqual({ provider: 'openai', apiKey: 'sk-x', apiBaseUrl: 'https://api.example.com/v1' })
  })

  it('尾部斜杠被去掉', () => {
    const cfg = toLlmProviderConfig(provider({ baseUrl: 'https://api.example.com/v1///' }))
    expect(cfg.apiBaseUrl).toBe('https://api.example.com/v1')
  })
})

describe('M4-L LlmClient · 显式配置通道', () => {
  it('给了 config 就用它,不查 LlmConfigStore(原来这里必然报 no LLM provider configured)', async () => {
    const client = LlmClient.getInstance()
    // 故意给一个不存在的 provider 类型在 store 里 —— 显式配置必须照样能发
    const res = await client.chat({
      model: 'm',
      messages: [{ role: 'user', content: 'hi' }],
      config: { provider: 'openai-compatible', apiKey: 'sk-x', apiBaseUrl: 'http://127.0.0.1:1/v1' },
    })
    // 断言的是「没有落到 no LLM provider configured 这条错误」——
    // 请求本身会失败(端口 1 连不上),但那证明配置**被读到了**
    expect(res.error ?? '').not.toContain('no LLM provider configured')
    expect(res.error ?? '').not.toContain('not enabled or apiKey missing')
  })

  it('没有 config 且 store 里没有 provider → 仍然是原来那条错误(行为不变)', async () => {
    const client = LlmClient.getInstance()
    const res = await client.chat({
      model: 'm',
      messages: [{ role: 'user', content: 'hi' }],
      provider: 'anthropic',   // store 里没有这个 provider
    })
    expect(res.ok).toBe(false)
    expect(res.error).toContain('not enabled or apiKey missing')
  })
})
