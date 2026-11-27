/**
 * New World - Channel / InboundBridge (IM 真连通 · 入站 → agent → 出站闭环)
 *
 * 订阅 EventBus 的 `im:channel:incoming`，把经 IMMessageRouter 判定放行的消息
 * 交给 ReplyGenerator 生成回复，再用 ChannelRouter.send 发回 IM 通道。
 *
 * 这是此前整条链路唯一缺失的一段：
 *   send()/healthCheck() 一直是真 fetch，__pushIncoming 却只有测试在调，
 *   im:channel:incoming 没有订阅者，RouteDecision.matchedRule 没有消费方。
 *
 * 设计约束：
 *   - 不改 IMMessageRouter 的判定语义（既有单测仍成立）：
 *     无匹配规则时 allowed/sanitized 仍为 true，默认回原通道；
 *     有 matchedRule 时按 targetChannel / targetUserId 转发。
 *   - ReplyGenerator 可注入，便于本机 mock server 做真往返测试；
 *     生产由 bootstrap 注入 createLlmReplyGenerator（真 LLM 调用）。
 *   - 生成失败不静默吞掉：回一条明确、可操作的提示，并发布 reply:failed 事件。
 *   - 出站消息由 ChannelRouter.send 记入 IMMessageStore('out')，
 *     消息查看器能看到完整来回，而不是只有入站。
 */

import { LogManager } from '../core/LogManager'
import { EventBus } from '../runtime/bridge/EventBus'
import { ChannelRouter } from './ChannelRouter'
import type { Unsubscribe } from '../runtime/bridge/EventBus'
import type { ChannelKind, RouteRule } from './ChannelTypes'
import type { ChannelMessage } from '../contracts/types'

/** ChannelRouter.register 发布的入站事件载荷（含原始消息，见其 register 实现） */
export interface InboundEvent {
  channelId: string
  channelKind: ChannelKind
  message: ChannelMessage
  allowed: boolean
  sanitized: boolean
  matchedRule?: RouteRule
  rejectReason?: string
  cleanContent?: string
}

export interface ReplyContext {
  channelId: string
  channelKind: ChannelKind
  from?: string
  to: string
  cleanContent: string
  matchedRule?: RouteRule
}

export type ReplyGenerator = (ctx: ReplyContext) => Promise<string>

export interface InboundBridgeOptions {
  replyGenerator?: ReplyGenerator
  /** 单条回复最大长度（Telegram 单消息上限 4096 字符） */
  maxReplyLength?: number
}

const DEFAULT_MAX_REPLY_LENGTH = 4000
/** 未配置模型时的确定性兜底生成器（测试 / 无模型环境用，不编造内容） */
const echoGenerator: ReplyGenerator = async (ctx) =>
  `[New World] 已收到你的消息（${ctx.cleanContent.slice(0, 60)}）`

export class InboundBridge {
  private static instance: InboundBridge
  private log = LogManager.getInstance()
  private bus = EventBus.getInstance()
  private router = ChannelRouter.getInstance()
  private replyGenerator: ReplyGenerator
  private maxReplyLength: number
  private unsubscribe: Unsubscribe | null = null
  private started = false

  private constructor(opts: InboundBridgeOptions = {}) {
    this.replyGenerator = opts.replyGenerator ?? echoGenerator
    this.maxReplyLength = opts.maxReplyLength ?? DEFAULT_MAX_REPLY_LENGTH
  }

  public static getInstance(opts: InboundBridgeOptions = {}): InboundBridge {
    if (!InboundBridge.instance) InboundBridge.instance = new InboundBridge(opts)
    else if (opts.replyGenerator) InboundBridge.instance.replyGenerator = opts.replyGenerator
    return InboundBridge.instance
  }

  /** 仅供单测隔离单例状态 */
  public static reset(): void {
    if (InboundBridge.instance) InboundBridge.instance.stop()
    InboundBridge.instance = undefined as unknown as InboundBridge
  }

  /** 注入 / 替换回复生成器（配置热更新或测试用） */
  setReplyGenerator(gen: ReplyGenerator): void {
    this.replyGenerator = gen
  }

  isStarted(): boolean { return this.started }

  start(): void {
    if (this.started) return
    this.started = true
    this.unsubscribe = this.bus.subscribe('im:channel:incoming', (payload) =>
      this.handle(payload),
    )
    this.log.info('InboundBridge: 入站 → 回复闭环已启动')
  }

  stop(): void {
    if (!this.started) return
    this.started = false
    this.unsubscribe?.()
    this.unsubscribe = null
  }

  /** 处理一条入站事件。公开以便测试直调（不依赖 EventBus 时序）。 */
  async handle(payload: unknown): Promise<void> {
    const ev = payload as InboundEvent | undefined
    if (!ev || typeof ev !== 'object') return
    if (!ev.channelId || !ev.message) return
    if (!ev.allowed || !ev.sanitized) {
      this.log.debug(`InboundBridge: 消息被拒绝，跳过 (${ev.rejectReason ?? 'unknown'})`)
      return
    }
    const clean = (ev.cleanContent ?? '').trim()
    if (!clean) return

    const ctx: ReplyContext = {
      channelId: ev.channelId,
      channelKind: ev.channelKind,
      from: ev.message.from,
      to: ev.message.to,
      cleanContent: clean,
      ...(ev.matchedRule ? { matchedRule: ev.matchedRule } : {}),
    }

    let reply: string
    try {
      reply = (await this.replyGenerator(ctx)).trim()
    } catch (e) {
      const reason = e instanceof Error ? e.message : String(e)
      this.log.warn(`InboundBridge: 生成回复失败: ${reason}`)
      void this.bus.publish('im:channel:reply:failed', {
        channelId: ev.channelId,
        stage: 'generate',
        error: reason,
      })
      // 诚实回执：把可操作的原因告诉 IM 用户，而不是伪造一个回答
      reply = `[New World] 暂时无法生成回复：${reason}`
    }
    if (!reply) return

    const target = this.resolveTarget(ev)
    const outbound: ChannelMessage = {
      to: target.to,
      from: 'new-world',
      text: reply.slice(0, this.maxReplyLength),
    }
    const result = await this.router.send(target.channelId, outbound)
    void this.bus.publish(result.ok ? 'im:channel:reply:sent' : 'im:channel:reply:failed', {
      channelId: ev.channelId,
      targetChannelId: target.channelId,
      to: target.to,
      ...(result.ok ? {} : { stage: 'send', error: result.error }),
    })
  }

  /**
   * 决定回复目标：
   *   - 无规则 / 规则指向本通道 → 回原通道原会话；
   *   - 规则指向其它通道 → 找该 kind 已注册的通道，发到 targetUserId；
   *   - 目标通道未注册 → 回退原通道原会话，避免把消息发到错误的人。
   */
  private resolveTarget(ev: InboundEvent): { channelId: string; to: string } {
    const rule = ev.matchedRule
    if (!rule?.targetChannel || rule.targetChannel === ev.channelKind) {
      return { channelId: ev.channelId, to: ev.message.to }
    }
    const target = this.router.listByKind(rule.targetChannel)[0]
    if (!target) {
      this.log.warn(`InboundBridge: 目标通道 ${rule.targetChannel} 未注册，回退原通道`)
      return { channelId: ev.channelId, to: ev.message.to }
    }
    return {
      channelId: target.id,
      to: rule.targetUserId?.trim() || ev.message.to,
    }
  }
}
