/**
 * New World - LLM usage 归一化
 *
 * 【为什么单独拆一个模块】
 * OpenAI / OpenAI-compatible 两条适配器此前各写一份 usage 解析,
 * 两边都只取 prompt/completion/total —— provider 真实回传的
 * `completion_tokens_details.reasoning_tokens` 被静默丢弃。
 * 这里做单一解析入口,保证两条适配器口径一致。
 *
 * 契约: 缺失即 undefined, 绝不拿 total/completion 冒充思考 token。
 */
import type { LlmUsage } from './types'

/**
 * 取思考 token 数。兼容三种真实返回:
 *  - OpenAI o 系列 / DeepSeek-R1: completion_tokens_details.reasoning_tokens
 *  - camelCase 变体（部分网关）: completion_tokens_details.reasoningTokens
 *  - Ollama / 平铺实现: usage.reasoning_tokens
 */
export function parseReasoningTokens(usage: any): number | undefined {
  const candidates: unknown[] = [
    usage?.completion_tokens_details?.reasoning_tokens,
    usage?.completion_tokens_details?.reasoningTokens,
    usage?.reasoning_tokens,
    usage?.reasoningTokens,
  ]
  for (const v of candidates) {
    if (typeof v === 'number' && Number.isFinite(v) && v >= 0) return v
  }
  return undefined
}

/** 把 OpenAI 风格 usage 归一为内部 LlmUsage；无 usage 返回 undefined。 */
export function parseOpenAiUsage(usage: any): LlmUsage | undefined {
  if (!usage) return undefined
  const reasoningTokens = parseReasoningTokens(usage)
  return {
    promptTokens: usage.prompt_tokens ?? 0,
    completionTokens: usage.completion_tokens ?? 0,
    totalTokens: usage.total_tokens ?? 0,
    ...(reasoningTokens !== undefined ? { reasoningTokens } : {}),
  }
}
