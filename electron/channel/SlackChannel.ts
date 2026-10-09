/**
 * PiPiClaw - Channel / SlackChannel (W8)
 *
 * Slack Web API(真实 fetch 实现)。
 * 发消息: https://slack.com/api/chat.postMessage
 * 健康检查: https://slack.com/api/auth.test
 * 配置: IMConfigStore['im-slack'].botToken(xoxb-...)
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

export class SlackChannel implements Channel {
  public readonly id: string
  private log = LogManager.getInstance()
  private configStore = IMConfigStore.getInstance()
  private bus = EventBus.getInstance()
  private handlers: MessageHandler[] = []

  constructor(id: string = 'slack-main') {
    this.id = id
  }

  async send(msg: ChannelMessage): Promise<void> {
    const config = this.configStore.get('im-slack')
    if (!config?.enabled) throw new Error('SlackChannel: 通道未启用或未配置')
    if (!config.botToken) throw new Error('SlackChannel: 缺少 botToken')
    const res = await fetch('https://slack.com/api/chat.postMessage', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json; charset=utf-8',
        Authorization: `Bearer ${config.botToken}`,
      },
      body: JSON.stringify({ channel: msg.to, text: msg.text ?? '' }),
    })
    const data = (await res.json()) as { ok?: boolean; error?: string }
    if (!res.ok || !data.ok) {
      throw new Error(`SlackChannel: ${data.error ?? 'HTTP ' + res.status}`)
    }
    void this.bus.publish('im:channel:send:ok', { channelId: this.id, msgTo: msg.to }, 'SlackChannel')
    this.log.info(`SlackChannel: 消息已发送到 ${msg.to}`)
  }

  onMessage(handler: MessageHandler): Disposable {
    this.handlers.push(handler)
    return { dispose: () => { const i = this.handlers.indexOf(handler); if (i >= 0) this.handlers.splice(i, 1) } }
  }

  __pushIncoming(msg: ChannelMessage): void {
    for (const h of this.handlers) void h(msg)
  }

  async healthCheck(): Promise<ChannelHealth> {
    const config = this.configStore.get('im-slack')
    if (!config?.enabled || !config.botToken) return { healthy: false, error: 'not configured' }
    const start = Date.now()
    try {
      const res = await fetch('https://slack.com/api/auth.test', {
        method: 'POST',
        headers: { Authorization: `Bearer ${config.botToken}` },
      })
      const data = (await res.json()) as { ok?: boolean; error?: string; url?: string }
      if (!res.ok || !data.ok) return { healthy: false, error: data.error ?? `HTTP ${res.status}` }
      return { healthy: true, latencyMs: Date.now() - start }
    } catch (e) {
      return { healthy: false, error: String(e) }
    }
  }
}
