/**
 * PiPiClaw - Channel / WeChatChannel (W8)
 *
 * 微信(公众号)开放平台 API(真实 fetch 实现)。
 * 取 token: https://api.weixin.qq.com/cgi-bin/token (appId + appSecret)
 * 发消息: https://api.weixin.qq.com/cgi-bin/message/custom/send
 * 配置: IMConfigStore['im-wechat'].appId / appSecret
 * 注:微信个人号无官方 API;本通道对接公众号(唯一官方路径),msg.to 为关注用户的 openid。
 *   若需个人号,可后续接入 wechaty(第三方 SDK)。
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

export class WeChatChannel implements Channel {
  public readonly id: string
  private log = LogManager.getInstance()
  private configStore = IMConfigStore.getInstance()
  private bus = EventBus.getInstance()
  private accessToken: string | null = null
  private accessTokenExpiresAt = 0
  private handlers: MessageHandler[] = []

  constructor(id: string = 'wechat-main') {
    this.id = id
  }

  async send(msg: ChannelMessage): Promise<void> {
    const config = this.configStore.get('im-wechat')
    if (!config?.enabled) throw new Error('WeChatChannel: 通道未启用或未配置')
    const token = await this.getAccessToken()
    if (!token) throw new Error('WeChatChannel: access_token 获取失败')
    const res = await fetch(`https://api.weixin.qq.com/cgi-bin/message/custom/send?access_token=${token}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ touser: msg.to, msgtype: 'text', text: { content: msg.text ?? '' } }),
    })
    const data = (await res.json()) as { errcode?: number; errmsg?: string }
    if (data.errcode !== 0) throw new Error(`WeChatChannel: ${data.errmsg ?? 'send failed'}`)
    void this.bus.publish('im:channel:send:ok', { channelId: this.id, msgTo: msg.to }, 'WeChatChannel')
    this.log.info(`WeChatChannel: 消息已发送到 ${msg.to}`)
  }

  onMessage(handler: MessageHandler): Disposable {
    this.handlers.push(handler)
    return { dispose: () => { const i = this.handlers.indexOf(handler); if (i >= 0) this.handlers.splice(i, 1) } }
  }

  __pushIncoming(msg: ChannelMessage): void {
    for (const h of this.handlers) void h(msg)
  }

  async healthCheck(): Promise<ChannelHealth> {
    const config = this.configStore.get('im-wechat')
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
    const config = this.configStore.get('im-wechat')
    if (!config?.appId || !config?.appSecret) return null
    if (this.accessToken && this.accessTokenExpiresAt > Date.now() + 60_000) return this.accessToken
    const url = `https://api.weixin.qq.com/cgi-bin/token?grant_type=client_credential&appid=${encodeURIComponent(config.appId)}&secret=${encodeURIComponent(config.appSecret)}`
    const res = await fetch(url, { method: 'GET' })
    if (!res.ok) return null
    const data = (await res.json()) as { access_token?: string; expires_in?: number; errcode?: number; errmsg?: string }
    if (data.errcode) { this.log.warn(`WeChatChannel: auth fail ${data.errmsg}`); return null }
    this.accessToken = data.access_token ?? null
    this.accessTokenExpiresAt = Date.now() + ((data.expires_in ?? 7200) * 1000)
    return this.accessToken
  }
}
