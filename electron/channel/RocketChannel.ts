/**
 * New World - Channel / RocketChannel (W8)
 *
 * Rocket.Chat REST API(真实 fetch 实现)。
 * 发消息: {server}/api/v1/chat.postMessage
 * 健康检查: {server}/api/v1/me
 * 鉴权头: X-Auth-Token(botToken) + X-User-Id(appId 复用)
 * 配置: IMConfigStore['im-rocket'].apiBaseUrl(server) / botToken / appId(userId)
 */

import { LogManager } from '../core/LogManager'
import { IMConfigStore } from './IMConfigStore'
import { EventBus } from '../runtime/bridge/EventBus'
import type {
  Channel,
  ChannelMessage,
  MessageHandler,
  Disposable,
  ChannelHealth,
} from '../contracts/types'

export class RocketChannel implements Channel {
  public readonly id: string
  private log = LogManager.getInstance()
  private configStore = IMConfigStore.getInstance()
  private bus = EventBus.getInstance()
  private handlers: MessageHandler[] = []

  constructor(id: string = 'rocket-main') {
    this.id = id
  }

  private serverUrl(): string {
    const base = this.configStore.get('im-rocket')?.apiBaseUrl
    if (!base) throw new Error('RocketChannel: 缺少 apiBaseUrl(server 地址)')
    return base.replace(/\/$/, '')
  }

  async send(msg: ChannelMessage): Promise<void> {
    const config = this.configStore.get('im-rocket')
    if (!config?.enabled) throw new Error('RocketChannel: 通道未启用或未配置')
    if (!config.botToken || !config.appId) throw new Error('RocketChannel: 缺少 botToken(X-Auth-Token)与 appId(X-User-Id)')
    const res = await fetch(`${this.serverUrl()}/api/v1/chat.postMessage`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Auth-Token': config.botToken,
        'X-User-Id': config.appId,
      },
      body: JSON.stringify({ channel: msg.to, text: msg.text ?? '' }),
    })
    const data = (await res.json()) as { success?: boolean; error?: string }
    if (!res.ok || !data.success) {
      throw new Error(`RocketChannel: ${data.error ?? 'HTTP ' + res.status}`)
    }
    void this.bus.publish('im:channel:send:ok', { channelId: this.id, msgTo: msg.to }, 'RocketChannel')
    this.log.info(`RocketChannel: 消息已发送到 ${msg.to}`)
  }

  onMessage(handler: MessageHandler): Disposable {
    this.handlers.push(handler)
    return { dispose: () => { const i = this.handlers.indexOf(handler); if (i >= 0) this.handlers.splice(i, 1) } }
  }

  __pushIncoming(msg: ChannelMessage): void {
    for (const h of this.handlers) void h(msg)
  }

  async healthCheck(): Promise<ChannelHealth> {
    const config = this.configStore.get('im-rocket')
    if (!config?.enabled || !config.botToken || !config.appId) return { healthy: false, error: 'not configured' }
    const start = Date.now()
    try {
      const res = await fetch(`${this.serverUrl()}/api/v1/me`, {
        headers: { 'X-Auth-Token': config.botToken, 'X-User-Id': config.appId },
      })
      const data = (await res.json()) as { success?: boolean }
      if (!res.ok || !data.success) return { healthy: false, error: `HTTP ${res.status}` }
      return { healthy: true, latencyMs: Date.now() - start }
    } catch (e) {
      return { healthy: false, error: String(e) }
    }
  }
}
