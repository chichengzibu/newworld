/**
 * New World - Channel / LlmReplyGenerator (IM 真连通 · 生产回复生成器)
 *
 * 把 InboundBridge 的 ReplyGenerator 接口接到真实 LLM：
 *   ChatConfig(上次选的 provider/model) + ModelManager(用户自建 provider)
 *   → toLlmProviderConfig 内联配置 → LlmClient.chat → 回复文本。
 *
 * 与聊天主链路的区别：IM 入站不适合走完整 agent loop（工具调用 / 事件中继 /
 * 会话绑定），这里用单轮 chat 生成回复，仍然调用用户真实配置的模型与端点，
 * 不编造内容、不返回 stub 文案。未配置模型时抛 NoModelConfiguredError，
 * 由 InboundBridge 转成一条明确可操作的提示。
 */

import { LlmClient } from '../llm/LlmClient'
import { LlmConfigStore } from '../llm/LlmConfigStore'
import { DEFAULT_MODELS } from '../llm/types'
import type { InlineLlmConfig, LlmProvider } from '../llm/types'
import { ChatConfig } from '../chat/ChatConfig'
import { ModelManager } from '../models/ModelManager'
import { toLlmProviderConfig } from '../models/ModelProvider'
import type { ReplyContext, ReplyGenerator } from './InboundBridge'

const SYSTEM_PROMPT =
  '你是 New World 桌面 AI 助手，正在通过 IM 即时消息通道回复用户。' +
  '回答要简洁、准确、直接；不要编造未经验证的事实，不要输出 Markdown 表格。'

/** IM 单轮回复的硬超时，避免桥接被慢模型永久挂住 */
const REPLY_TIMEOUT_MS = 90_000

export class NoModelConfiguredError extends Error {
  constructor() {
    super('未配置可用的 LLM 模型，请在「设置 → 模型管理」启用一个模型后重试')
    this.name = 'NoModelConfiguredError'
  }
}

interface ResolvedModel {
  model: string
  inline?: InlineLlmConfig
  provider?: LlmProvider
}

function resolveModel(): ResolvedModel {
  const chatConfig = ChatConfig.getInstance()
  const providerId = chatConfig.getLastProvider()
  const modelId = chatConfig.getLastModel()
  const manager = ModelManager.getInstance()

  // 优先用聊天里上次选中的 provider；没选过就自动挑第一个已启用 provider ——
  // 用户在「设置 → 模型管理」配好 Ollama 却没在聊天里手动选时，IM 也能真回复。
  const mp = providerId ? manager.getProvider(providerId) : manager.getEnabledProviders()[0]
  if (mp?.enabled) {
    const inline = toLlmProviderConfig(mp)
    const firstUsableModel = mp.models?.find((m) => !m.disabled)?.id
    return {
      model: modelId || mp.defaultModel || firstUsableModel || DEFAULT_MODELS[inline.provider],
      inline,
      provider: inline.provider,
    }
  }

  const active = LlmConfigStore.getInstance().getActive()
  if (active) {
    return {
      model: modelId || active.defaultModel || DEFAULT_MODELS[active.provider],
      provider: active.provider,
    }
  }

  throw new NoModelConfiguredError()
}

async function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined
  const timeout = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => reject(new Error(`LLM 生成超时 ${ms}ms`)), ms)
  })
  try {
    return await Promise.race([promise, timeout])
  } finally {
    if (timer) clearTimeout(timer)
  }
}

export function createLlmReplyGenerator(): ReplyGenerator {
  return async (ctx: ReplyContext): Promise<string> => {
    const resolved = resolveModel()
    const res = await withTimeout(
      LlmClient.getInstance().chat({
        model: resolved.model,
        messages: [
          { role: 'system', content: SYSTEM_PROMPT },
          { role: 'user', content: ctx.cleanContent },
        ],
        ...(resolved.inline
          ? { config: resolved.inline, provider: resolved.inline.provider }
          : {}),
        ...(resolved.provider && !resolved.inline ? { provider: resolved.provider } : {}),
        maxTokens: 1024,
      }),
      REPLY_TIMEOUT_MS,
    )
    if (!res.ok) throw new Error(res.error || `LLM ${res.provider}/${res.model} 调用失败`)
    const text = (res.content ?? '').trim()
    if (!text) throw new Error('LLM 未返回任何内容')
    return text
  }
}
