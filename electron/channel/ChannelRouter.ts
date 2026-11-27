/**
 * New World - Channel / ChannelRouter (W7.1 → IM 真连通)
 *
 * 管理所有 Channel 实例,提供统一入口。
 * - register / unregister channel
 * - send via channel id
 * - subscribe message via channel id
 * - list / get metadata
 *
 * 【IM 真连通改动】
 *  1. register 的入站事件带上原始 ChannelMessage 与 channelKind ——
 *     此前只发 RouteDecision，InboundBridge 拿不到回复目标(chat_id)，
 *     这是「入站事件有发布、却无法闭环回复」的根因之一。
 *  2. send 成功后把消息记入 IMMessageStore('out')，消息查看器能看到完整来回。
 *  3. subscribeChannel 的 handlers 不再是只写不读的死 Map：
 *     放行后的消息会旁路通知订阅者。
 */

import { LogManager } from '../core/LogManager'
import { EventBus } from '../runtime/bridge/EventBus'
import { IMMessageRouter } from './IMMessageRouter'
import { IMMessageStore } from './IMMessageStore'
import { RetryPolicy } from '../agent/RetryPolicy'
import type {
  Channel,
  ChannelMessage,
  ChannelHealth,
  MessageHandler,
} from '../contracts/types'
import type { ChannelMetadata, ChannelKind } from './ChannelTypes'

/**
 * ChannelRouter: 管理所有 Channel 实例,提供统一入口
 */
export class ChannelRouter {
  private static instance: ChannelRouter
  private log = LogManager.getInstance()
  private bus = EventBus.getInstance()
  private messageRouter = IMMessageRouter.getInstance()
  private messageStore = IMMessageStore.getInstance()
  private channels: Map<string, Channel> = new Map()
  private metadata: Map<string, ChannelMetadata> = new Map()
  private handlers: Map<string, MessageHandler> = new Map()

  private constructor() {}

  public static getInstance(): ChannelRouter {
    if (!ChannelRouter.instance) ChannelRouter.instance = new ChannelRouter()
    return ChannelRouter.instance
  }

  /** 注册一个 channel 实例 */
  register(channel: Channel, meta: Omit<ChannelMetadata, 'createdAt'>): void {
    if (this.channels.has(channel.id)) {
      this.log.warn(`ChannelRouter: ${channel.id} 重复注册,覆盖`)
    }
    this.channels.set(channel.id, channel)
    this.metadata.set(channel.id, { ...meta, createdAt: Date.now() })
    // 订阅 channel 收到的消息
    channel.onMessage(async msg => {
      const m = this.metadata.get(channel.id)
      if (!m) return
      const result = await this.messageRouter.handleIncoming(channel.id, m.kind, msg)
      void this.bus.publish('im:channel:incoming', {
        channelId: channel.id,
        channelKind: m.kind,
        message: msg,
        ...result,
      })
      // subscribeChannel 的旁路观察者：只收经 permission + security 放行的消息
      const observer = this.handlers.get(channel.id)
      if (observer && result.allowed && result.sanitized) {
        try {
          void observer({ ...msg, text: result.cleanContent ?? msg.text })
        } catch (e) {
          this.log.warn(`ChannelRouter: ${channel.id} 旁路订阅者失败`, e)
        }
      }
    })
    this.log.info(`ChannelRouter: 注册 ${channel.id} (${meta.kind})`)
  }

  unregister(channelId: string): boolean {
    const ok1 = this.channels.delete(channelId)
    const ok2 = this.metadata.delete(channelId)
    this.handlers.delete(channelId)
    return ok1 || ok2
  }

  get(channelId: string): Channel | undefined {
    return this.channels.get(channelId)
  }

  getMetadata(channelId: string): ChannelMetadata | undefined {
    return this.metadata.get(channelId)
  }

  listMetadata(): ChannelMetadata[] {
    return [...this.metadata.values()]
  }

  listByKind(kind: ChannelKind): ChannelMetadata[] {
    return [...this.metadata.values()].filter(m => m.kind === kind)
  }

  /** 通过 channelId 发送消息 */
  async send(channelId: string, message: ChannelMessage): Promise<{ ok: boolean; error?: string }> {
    const channel = this.channels.get(channelId)
    if (!channel) return { ok: false, error: `channel ${channelId} not found` }
    // P3-04: 失败重试 (exponential backoff via RetryPolicy)
    // maxAttempts=3, baseDelay=1s, backoff 2x: 1s → 2s → 4s
    // 不可重试错误 (4xx 等) 会立即抛出,不走 retry
    const retry = new RetryPolicy({ maxAttempts: 3, baseDelayMs: 1000, maxDelayMs: 8000, backoffMultiplier: 2 })
    try {
      await retry.execute(() => channel.send(message), `channel-send:${channelId}`)
      // 出站消息入台账：IM 回复 / UI 快速回复都能在消息查看器里看到
      this.messageStore.record(channelId, 'out', message)
      void this.bus.publish('im:channel:send:ok', { channelId })
      return { ok: true }
    } catch (e) {
      void this.bus.publish('im:channel:send:fail', { channelId, error: String(e) })
      return { ok: false, error: String(e) }
    }
  }

  /** 订阅 channel 收到的事件(已通过 IMMessageRouter 处理) */
  subscribeChannel(channelId: string, handler: MessageHandler): void {
    this.handlers.set(channelId, handler)
  }

  /** 健康检查所有 channel */
  async healthCheckAll(): Promise<Record<string, ChannelHealth>> {
    const result: Record<string, ChannelHealth> = {}
    for (const [id, channel] of this.channels) {
      try {
        result[id] = await channel.healthCheck()
      } catch (e) {
        result[id] = { healthy: false, error: String(e) }
      }
    }
    return result
  }

  /** 健康检查单个 channel（channel:health IPC 用，不再恒返回 healthy:true） */
  async healthCheck(channelId: string): Promise<ChannelHealth> {
    const channel = this.channels.get(channelId)
    if (!channel) return { healthy: false, error: `channel ${channelId} not found` }
    try {
      return await channel.healthCheck()
    } catch (e) {
      return { healthy: false, error: String(e) }
    }
  }
}
