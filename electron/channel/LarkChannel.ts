/**
 * New World - Channel / LarkChannel (W8)
 *
 * Lark(海外飞书)IM 通道(真实 fetch 实现,复用飞书逻辑,base 改为 open.larksuite.com)。
 * 鉴权: appId + appSecret → tenant_access_token
 * 发消息: {base}/open-apis/im/v1/messages
 * 配置: IMConfigStore['im-lark'].appId / appSecret / apiBaseUrl(可选)
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

export class LarkChannel implements Channel {
  public readonly id: string
  private log = LogManager.getInstance()
  private configStore = IMConfigStore.getInstance()
  private bus = EventBus.getInstance()
  private accessToken: string | null = null
  private accessTokenExpiresAt = 0
  private handlers: MessageHandler[] = []

  constructor(id: string = 'lark-main') {
    this.id = id
  }

  private baseUrl(): string {
    return (this.configStore.get('im-lark')?.apiBaseUrl || 'https://open.larksuite.com').replace(/\/$/, '')
  }

  async send(msg: ChannelMessage): Promise<void> {
    const config = this.configStore.get('im-lark')
    if (!config?.enabled) throw new Error('LarkChannel: 通道未启用或未配置')
    const token = await this.getAccessToken()
    if (!token) throw new Error('LarkChannel: accessToken 获取失败')
    const res = await fetch(`${this.baseUrl()}/open-apis/im/v1/messages?receive_id_type=open_id`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ receive_id: msg.to, msg_type: msg.text ? 'text' : 'post', content: JSON.stringify({ text: msg.text ?? '' }) }),
    })
    if (!res.ok) {
      const errText = await res.text()
      throw new Error(`LarkChannel: HTTP ${res.status} ${errText.slice(0, 200)}`)
    }
    void this.bus.publish('im:channel:send:ok', { channelId: this.id, msgTo: msg.to }, 'LarkChannel')
    this.log.info(`LarkChannel: 消息已发送到 ${msg.to}`)
  }

  onMessage(handler: MessageHandler): Disposable {
    this.handlers.push(handler)
    return { dispose: () => { const i = this.handlers.indexOf(handler); if (i >= 0) this.handlers.splice(i, 1) } }
  }

  __pushIncoming(msg: ChannelMessage): void {
    for (const h of this.handlers) void h(msg)
  }

  async healthCheck(): Promise<ChannelHealth> {
    const config = this.configStore.get('im-lark')
    if (!config?.enabled) return { healthy: false, error: 'not configured' }
    const start = Date.now()
    try {
      const token = await this.getAccessToken()
      if (!token) return { healthy: false, error: 'auth fail' }
      return { healthy: true, latencyMs: Date.now() - start }
    } catch (e) {
      return { healthy: false, error: String(e) }
    }
  }

  private async getAccessToken(): Promise<string | null> {
    const config = this.configStore.get('im-lark')
    if (!config?.appId || !config?.appSecret) return null
    if (this.accessToken && this.accessTokenExpiresAt > Date.now() + 60_000) return this.accessToken
    const res = await fetch(`${this.baseUrl()}/open-apis/auth/v3/tenant_access_token/internal`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ app_id: config.appId, app_secret: config.appSecret }),
    })
    if (!res.ok) return null
    const data = (await res.json()) as { code?: number; msg?: string; tenant_access_token?: string; expire?: number }
    if (data.code !== 0) { this.log.warn(`LarkChannel: auth fail ${data.msg}`); return null }
    this.accessToken = data.tenant_access_token ?? null
    this.accessTokenExpiresAt = Date.now() + ((data.expire ?? 7200) * 1000)
    return this.accessToken
  }
}
