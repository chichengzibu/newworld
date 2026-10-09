/**
 * PiPiClaw - Channel / TelegramChannel (W8)
 *
 * Telegram Bot API(真实 fetch 实现)。
 * 发消息: https://api.telegram.org/bot<token>/sendMessage
 * 健康检查: https://api.telegram.org/bot<token>/getMe
 * 配置: IMConfigStore['im-telegram'].botToken
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

export class TelegramChannel implements Channel {
  public readonly id: string
  private log = LogManager.getInstance()
  private configStore = IMConfigStore.getInstance()
  private bus = EventBus.getInstance()
  private handlers: MessageHandler[] = []

  constructor(id: string = 'telegram-main') {
    this.id = id
  }

  async send(msg: ChannelMessage): Promise<void> {
    const config = this.configStore.get('im-telegram')
    if (!config?.enabled) throw new Error('TelegramChannel: 通道未启用或未配置')
    if (!config.botToken) throw new Error('TelegramChannel: 缺少 botToken')
    const url = `https://api.telegram.org/bot${config.botToken}/sendMessage`
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ chat_id: msg.to, text: msg.text ?? '' }),
    })
    if (!res.ok) {
      const errText = await res.text()
      throw new Error(`TelegramChannel: HTTP ${res.status} ${errText.slice(0, 200)}`)
    }
    void this.bus.publish('im:channel:send:ok', { channelId: this.id, msgTo: msg.to }, 'TelegramChannel')
    this.log.info(`TelegramChannel: 消息已发送到 ${msg.to}`)
  }

  onMessage(handler: MessageHandler): Disposable {
    this.handlers.push(handler)
    return { dispose: () => { const i = this.handlers.indexOf(handler); if (i >= 0) this.handlers.splice(i, 1) } }
  }

  __pushIncoming(msg: ChannelMessage): void {
    for (const h of this.handlers) void h(msg)
  }

  async healthCheck(): Promise<ChannelHealth> {
    const config = this.configStore.get('im-telegram')
    if (!config?.enabled || !config.botToken) return { healthy: false, error: 'not configured' }
    const start = Date.now()
    try {
      const res = await fetch(`https://api.telegram.org/bot${config.botToken}/getMe`)
      if (!res.ok) return { healthy: false, error: `HTTP ${res.status}` }
      const data = (await res.json()) as { ok?: boolean; username?: string }
      if (!data.ok) return { healthy: false, error: 'getMe failed' }
      return { healthy: true, latencyMs: Date.now() - start }
    } catch (e) {
      return { healthy: false, error: String(e) }
    }
  }
}
