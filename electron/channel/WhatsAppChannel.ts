/**
 * PiPiClaw - Channel / WhatsAppChannel (W8)
 *
 * Meta WhatsApp Business Cloud API(真实 fetch 实现)。
 * 发消息: https://graph.facebook.com/v19.0/{phoneNumberId}/messages
 * 健康检查: https://graph.facebook.com/v19.0/me
 * 配置: IMConfigStore['im-whatsapp'].botToken(permanent access token) / appId(phone number id)
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

export class WhatsAppChannel implements Channel {
  public readonly id: string
  private log = LogManager.getInstance()
  private configStore = IMConfigStore.getInstance()
  private bus = EventBus.getInstance()
  private handlers: MessageHandler[] = []

  constructor(id: string = 'whatsapp-main') {
    this.id = id
  }

  async send(msg: ChannelMessage): Promise<void> {
    const config = this.configStore.get('im-whatsapp')
    if (!config?.enabled) throw new Error('WhatsAppChannel: 通道未启用或未配置')
    if (!config.botToken || !config.appId) throw new Error('WhatsAppChannel: 缺少 botToken 与 appId(phone number id)')
    const url = `https://graph.facebook.com/v19.0/${config.appId}/messages`
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${config.botToken}` },
      body: JSON.stringify({
        messaging_product: 'whatsapp',
        recipient_type: 'individual',
        to: msg.to,
        type: 'text',
        text: { body: msg.text ?? '' },
      }),
    })
    const data = (await res.json()) as { error?: { message?: string } }
    if (!res.ok) throw new Error(`WhatsAppChannel: ${data.error?.message ?? 'HTTP ' + res.status}`)
    void this.bus.publish('im:channel:send:ok', { channelId: this.id, msgTo: msg.to }, 'WhatsAppChannel')
    this.log.info(`WhatsAppChannel: 消息已发送到 ${msg.to}`)
  }

  onMessage(handler: MessageHandler): Disposable {
    this.handlers.push(handler)
    return { dispose: () => { const i = this.handlers.indexOf(handler); if (i >= 0) this.handlers.splice(i, 1) } }
  }

  __pushIncoming(msg: ChannelMessage): void {
    for (const h of this.handlers) void h(msg)
  }

  async healthCheck(): Promise<ChannelHealth> {
    const config = this.configStore.get('im-whatsapp')
    if (!config?.enabled || !config.botToken) return { healthy: false, error: 'not configured' }
    const start = Date.now()
    try {
      const res = await fetch('https://graph.facebook.com/v19.0/me', {
        headers: { Authorization: `Bearer ${config.botToken}` },
      })
      if (!res.ok) return { healthy: false, error: `HTTP ${res.status}` }
      return { healthy: true, latencyMs: Date.now() - start }
    } catch (e) {
      return { healthy: false, error: String(e) }
    }
  }
}
