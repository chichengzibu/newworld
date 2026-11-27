/**
 * New World - Channel / QQChannel (W8)
 *
 * QQ 机器人开放平台 API(真实 fetch 实现)。
 * 取 token: https://bots.qq.com/app/getAppAccessToken (appId + appSecret)
 * 发消息: https://api.sgroup.qq.com/v2/users/{openid}/messages
 * 配置: IMConfigStore['im-qq'].appId / appSecret
 * 注:msg.to 为目标用户 openid;个人 QQ 无官方 API,本通道面向官方机器人。
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

export class QQChannel implements Channel {
  public readonly id: string
  private log = LogManager.getInstance()
  private configStore = IMConfigStore.getInstance()
  private bus = EventBus.getInstance()
  private accessToken: string | null = null
  private accessTokenExpiresAt = 0
  private handlers: MessageHandler[] = []

  constructor(id: string = 'qq-main') {
    this.id = id
  }

  async send(msg: ChannelMessage): Promise<void> {
    const config = this.configStore.get('im-qq')
    if (!config?.enabled) throw new Error('QQChannel: 通道未启用或未配置')
    const token = await this.getAccessToken()
    if (!token) throw new Error('QQChannel: access_token 获取失败')
    const res = await fetch(`https://api.sgroup.qq.com/v2/users/${msg.to}/messages`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `QQBot ${token}`,
        'X-Im-Bot-Token': token,
      },
      body: JSON.stringify({ content: msg.text ?? '', msg_type: 0 }),
    })
    if (!res.ok) {
      const errText = await res.text()
      throw new Error(`QQChannel: HTTP ${res.status} ${errText.slice(0, 200)}`)
    }
    void this.bus.publish('im:channel:send:ok', { channelId: this.id, msgTo: msg.to }, 'QQChannel')
    this.log.info(`QQChannel: 消息已发送到 ${msg.to}`)
  }

  onMessage(handler: MessageHandler): Disposable {
    this.handlers.push(handler)
    return { dispose: () => { const i = this.handlers.indexOf(handler); if (i >= 0) this.handlers.splice(i, 1) } }
  }

  __pushIncoming(msg: ChannelMessage): void {
    for (const h of this.handlers) void h(msg)
  }

  async healthCheck(): Promise<ChannelHealth> {
    const config = this.configStore.get('im-qq')
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
    const config = this.configStore.get('im-qq')
    if (!config?.appId || !config?.appSecret) return null
    if (this.accessToken && this.accessTokenExpiresAt > Date.now() + 60_000) return this.accessToken
    const res = await fetch('https://bots.qq.com/app/getAppAccessToken', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ appId: config.appId, clientSecret: config.appSecret }),
    })
    if (!res.ok) return null
    const data = (await res.json()) as { access_token?: string; expires_in?: number }
    if (!data.access_token) { this.log.warn('QQChannel: auth fail'); return null }
    this.accessToken = data.access_token
    this.accessTokenExpiresAt = Date.now() + ((data.expires_in ?? 7200) * 1000)
    return this.accessToken
  }
}
