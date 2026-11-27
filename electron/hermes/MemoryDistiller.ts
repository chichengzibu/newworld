/**
 * New World — MemoryDistiller（LLM 记忆提炼 + 自进化闭环）
 * ═══════════════════════════════════════════════════════════════
 * 【要解决的问题】
 * 旧实现靠中文正则门控：
 *   /(文件|文件夹|创建|整理|习惯|偏好)/.test(content)
 * 命中就把「用户原话 + AI 回复前 500 字」整段塞进记忆库。
 *
 * 三个后果：
 *   ① 与语义无关 —— "帮我删除这个文件" 会沉淀（确实是操作），
 *      但 "我以后都用中文回复我" 不会（没有关键词），而后者才是真偏好。
 *   ② 存的是原文流水账，不是结论 —— 十轮对话存十条，值不值全看运气。
 *   ③ 无法归并 —— 同一件事说五遍就有五条记忆，互相稀释。
 *
 * 【本模块做什么】
 *   用一次轻量 LLM 调用，把一段对话提炼成 **0~2 条结构化记忆**：
 *     { content, importance, kind }
 *   没有值得记的就返回空数组 —— 宁可少记，不要记废话。
 *
 * 【与 SelfLearner 的分工（X1 边界延续）】
 *   SelfLearner  = 执行侧学习（我做了什么操作 → 能不能固化成技能）
 *   Distiller    = 语义侧记忆（用户要什么 / 偏好什么 → 以后怎么服务他）
 *   两者数据不混，但 **技能落盘后会回调 `onSkillCreated` 写一条"我会这个了"的记忆**，
 *   让下次召回知道"这类任务我以前做过"，这是闭环的反向回路。
 *
 * 【红线】
 *   · 单例；LLM 不可用时静默降级（返回空），绝不阻塞聊天主链路
 *   · 超时 20s；失败只 warn
 *   · 不 import ChatManager（防循环依赖）
 */

import { LogManager } from '../core/LogManager'
import { LlmClient } from '../llm/LlmClient'
import { ModelManager } from '../models/ModelManager'
import { LlmConfigStore } from '../llm/LlmConfigStore'
import { ChatConfig } from '../chat/ChatConfig'
import type { LlmProvider } from '../llm/types'
import type { MemoryItem } from './HermesMemory'

/** 提炼出的记忆（LLM 输出的结构化结果） */
export interface DistilledMemory {
  content: string
  /** 0-100，由 LLM 判断这条记忆有多重要 */
  importance: number
  /** preference=偏好/习惯；fact=事实；procedure=做法；correction=纠正 */
  kind: 'preference' | 'fact' | 'procedure' | 'correction'
}

const DISTILL_TIMEOUT_MS = 20_000
const MAX_DISTILL_INPUT_CHARS = 3000

const SYSTEM_PROMPT = `你是记忆提炼器。从这段对话里提取**值得长期记住**的信息。

规则：
- 只提取关于「用户」的稳定信息：偏好、习惯、常用路径/目录、工作方式、纠正过的错误做法。
- 不要提取一次性任务的具体内容（"帮我整理桌面" 不是记忆；"用户习惯把文件按类型归档到 D 盘" 才是）。
- 不要提取寒暄、确认、AI 自己的解释。
- 每条记忆必须是一句独立可读的陈述句，不超过 60 字。
- 最多 2 条。如果都不值得记，返回空数组。

importance 打分标准：
- 80-100：明确的长期偏好或反复纠正过的错误（说了多次）
- 50-79：一次性但明确的工作习惯
- 20-49：可能是习惯，但证据不足
- <20：不值得记（不要输出）

只返回 JSON，不要任何解释：
{"memories":[{"content":"...","importance":60,"kind":"preference"}]}`

export class MemoryDistiller {
  private static instance: MemoryDistiller
  private log = LogManager.getInstance()
  private inFlight = 0
  private static readonly MAX_CONCURRENT = 2

  private constructor() {}

  public static getInstance(): MemoryDistiller {
    if (!MemoryDistiller.instance) MemoryDistiller.instance = new MemoryDistiller()
    return MemoryDistiller.instance
  }

  /**
   * 从一轮对话里提炼记忆。
   *
   * @returns 提炼结果；LLM 不可用/超时/解析失败一律返回 []（静默降级）
   */
  async distill(userText: string, assistantText: string): Promise<DistilledMemory[]> {
    const user = (userText ?? '').trim()
    const assistant = (assistantText ?? '').trim()
    if (!user) return []
    // 太短的对话不值得花一次 LLM 调用
    if (user.length + assistant.length < 20) return []
    if (this.inFlight >= MemoryDistiller.MAX_CONCURRENT) return []

    const resolved = this.resolveModel()
    if (!resolved) return []

    this.inFlight += 1
    try {
      const payload = [
        '## 用户说',
        user.slice(0, MAX_DISTILL_INPUT_CHARS),
        '',
        '## 助手回复',
        assistant.slice(0, MAX_DISTILL_INPUT_CHARS),
      ].join('\n')

      const res = await this.withTimeout(
        LlmClient.getInstance().chat({
          model: resolved.model,
          messages: [
            { role: 'system', content: SYSTEM_PROMPT },
            { role: 'user', content: payload },
          ],
          temperature: 0.1,
          maxTokens: 400,
          ...(resolved.inline ? { config: resolved.inline } : {}),
          ...(resolved.provider ? { provider: resolved.provider } : {}),
        }),
        DISTILL_TIMEOUT_MS,
      )

      if (!res.ok || !res.content) return []
      return this.parse(res.content)
    } catch (e) {
      this.log.warn('[MemoryDistiller] 提炼失败（不阻塞主链路）', e)
      return []
    } finally {
      this.inFlight -= 1
    }
  }

  /**
   * 解析 LLM 输出。容忍 markdown 代码块包裹、前后多余文字。
   */
  parse(raw: string): DistilledMemory[] {
    let text = raw.trim()
    // 剥 ```json ... ``` 包裹
    const fence = text.match(/```(?:json)?\s*([\s\S]*?)```/)
    if (fence) text = fence[1].trim()
    // 抓第一个 JSON 对象
    const start = text.indexOf('{')
    const end = text.lastIndexOf('}')
    if (start < 0 || end <= start) return []
    let parsed: unknown
    try {
      parsed = JSON.parse(text.slice(start, end + 1))
    } catch {
      return []
    }
    const arr = (parsed as { memories?: unknown })?.memories
    if (!Array.isArray(arr)) return []

    const out: DistilledMemory[] = []
    for (const item of arr.slice(0, 2)) {
      const o = item as Record<string, unknown>
      const content = typeof o?.content === 'string' ? o.content.trim() : ''
      if (!content || content.length > 120) continue
      const importance = typeof o?.importance === 'number' ? Math.max(0, Math.min(100, Math.round(o.importance))) : 50
      if (importance < 20) continue
      const kindRaw = typeof o?.kind === 'string' ? o.kind : 'fact'
      const kind: DistilledMemory['kind'] =
        kindRaw === 'preference' || kindRaw === 'procedure' || kindRaw === 'correction' ? kindRaw : 'fact'
      out.push({ content, importance, kind })
    }
    return out
  }

  /**
   * 技能落盘后反哺记忆 —— 「我会做这件事了」。
   *
   * 【这是自进化闭环的反向回路】
   * 旧实现里 SelfLearner 写完 SKILL.md 就结束了，记忆库完全不知道。
   * 结果是：下次遇到同类任务，召回不到「我以前把这套流程固化成了技能」，
   * 于是又从头摸索一遍。
   *
   * 本方法生成一条 procedure 类型记忆，importance 80（技能是高价值沉淀），
   * 由调用方写入 HermesAdapter.store。
   */
  buildSkillMemory(skill: { name: string; description: string; triggerCondition: string; keywords: string[] }): DistilledMemory {
    const kw = skill.keywords?.length ? `（关键词：${skill.keywords.slice(0, 5).join('、')}）` : ''
    const trigger = skill.triggerCondition ? `触发场景：${skill.triggerCondition}。` : ''
    const content = `已固化为技能「${skill.name}」：${skill.description || skill.name}${trigger}${kw}`.slice(0, 200)
    return { content, importance: 80, kind: 'procedure' }
  }

  /**
   * 把提炼结果转换成 MemoryItem 可用的形态（保留 kind 到 tags）。
   */
  toMemoryTags(d: DistilledMemory, extra?: string[]): string[] {
    return [d.kind, 'distilled', ...(extra ?? [])]
  }

  private resolveModel(): { model: string; provider?: LlmProvider; inline?: { provider: LlmProvider; apiKey?: string; apiBaseUrl?: string } } | null {
    try {
      const chatConfig = ChatConfig.getInstance()
      const providerId = chatConfig.getLastProvider()
      const modelId = chatConfig.getLastModel()
      const manager = ModelManager.getInstance()

      const mp = providerId ? manager.getProvider(providerId) : manager.getEnabledProviders()[0]
      if (mp?.enabled) {
        const firstUsable = mp.models?.find((m) => !m.disabled)?.id
        const provider = (mp.type as LlmProvider) ?? 'openai'
        return {
          model: modelId || mp.defaultModel || firstUsable || 'gpt-4o-mini',
          inline: { provider, apiKey: mp.apiKey, apiBaseUrl: mp.baseUrl },
        }
      }

      const active = LlmConfigStore.getInstance().getActive()
      if (active) {
        return {
          model: modelId || active.defaultModel || 'gpt-4o-mini',
          provider: active.provider,
        }
      }
      return null
    } catch {
      return null
    }
  }

  private async withTimeout<T>(p: Promise<T>, ms: number): Promise<T> {
    let timer: ReturnType<typeof setTimeout> | undefined
    const timeout = new Promise<never>((_r, rej) => {
      timer = setTimeout(() => rej(new Error(`distill timeout ${ms}ms`)), ms)
    })
    try {
      return await Promise.race([p, timeout])
    } finally {
      if (timer) clearTimeout(timer)
    }
  }
}