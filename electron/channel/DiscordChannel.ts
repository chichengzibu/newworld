/**
 * PiPiClaw - Channel / DiscordChannel (W8)
 *
 * Discord REST API(真实 fetch 实现)。msg.to = 频道(channel) id。
 * 发消息: https://discord.com/api/v10/channels/{channelId}/messages
 * 健康检查: https://discord.com/api/v10/users/@me
 * 配置: IMConfigStore['im-discord'].botToken
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

export class DiscordChannel implements Channel {
  public readonly id: string
  private log = LogManager.getInstance()
  private configStore = IMConfigStore.getInstance()
  private bus = EventBus.getInstance()
  private handlers: MessageHandler[] = []

  constructor(id: string = 'discord-main') {
    this.id = id
  }

  async send(msg: ChannelMessage): Promise<void> {
    const config = this.configStore.get('im-discord')
    if (!config?.enabled) throw new Error('DiscordChannel: 通道未启用或未配置')
    if (!config.botToken) throw new Error('DiscordChannel: 缺少 botToken')
    const url = `https://discord.com/api/v10/channels/${msg.to}/messages`
    const res = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bot ${config.botToken}`,
      },
      body: JSON.stringify({ content: msg.text ?? '' }),
    })
    if (!res.ok) {
      const errText = await res.text()
      throw new Error(`DiscordChannel: HTTP ${res.status} ${errText.slice(0, 200)}`)
    }
    void this.bus.publish('im:channel:send:ok', { channelId: this.id, msgTo: msg.to }, 'DiscordChannel')
    this.log.info(`DiscordChannel: 消息已发送到 ${msg.to}`)
  }

  onMessage(handler: MessageHandler): Disposable {
    this.handlers.push(handler)
    return { dispose: () => { const i = this.handlers.indexOf(handler); if (i >= 0) this.handlers.splice(i, 1) } }
  }

  __pushIncoming(msg: ChannelMessage): void {
    for (const h of this.handlers) void h(msg)
  }

  async healthCheck(): Promise<ChannelHealth> {
    const config = this.configStore.get('im-discord')
    if (!config?.enabled || !config.botToken) return { healthy: false, error: 'not configured' }
    const start = Date.now()
    try {
      const res = await fetch('https://discord.com/api/v10/users/@me', {
        headers: { Authorization: `Bot ${config.botToken}` },
      })
      if (!res.ok) return { healthy: false, error: `HTTP ${res.status}` }
      return { healthy: true, latencyMs: Date.now() - start }
    } catch (e) {
      return { healthy: false, error: String(e) }
    }
  }
}
