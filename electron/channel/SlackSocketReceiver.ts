/**
 * New World — SlackSocketReceiver（Slack Socket Mode 真入站）
 * ═══════════════════════════════════════════════════════════════
 * 【为什么是 Socket Mode 而不是 Events API】
 * Slack 的入站两条路：
 *   · Events API —— 需要公网 HTTPS + 签名校验，本机不可能
 *   · Socket Mode —— 先用 app-level token 调 `apps.connections.open`
 *     拿一个 WSS URL，连上去收 envelope，**纯出站**，不需要公网
 *
 * 【协议要点】
 *   ① `POST https://slack.com/api/apps.connections.open`
 *      Header: `Authorization: Bearer <appToken>`（xapp- 开头）
 *   ② 拿到 `url`（wss://wss-primary.slack.com/...）
 *   ③ 连上后收 `{type:'hello'}` 表示就绪
 *   ④ 收 `{type:'events_api', envelope_id, payload:{event:{type:'message',...}}}`
 *   ⑤ **必须回 ack**：`{envelope_id}`，否则 Slack 会重投同一条
 *
 * 【两个 token 的区别（最容易踩的坑）】
 *   · botToken (xoxb-) —— 发消息用（chat.postMessage）
 *   · appToken (xapp-) —— 仅在 Socket Mode 握手用
 *   只配 botToken 是连不上的，必须额外生成 app-level token 并开启 Socket Mode。
 *   这里在缺 appToken 时给出明确错误，而不是静默不工作。
 *
 * 【红线】
 *   · ack 一定要回（否则消息会被无限重投，且 Slack 会降权）
 *   · bot 自己发的消息要过滤（event.bot_id / event.subtype === 'bot_message'）
 *   · token 绝不进日志
 */

import { LogManager } from '../core/LogManager'
import type { ChannelMessage } from '../contracts/types'
import { WebSocketPoller, type WsConnection, type WsConnectionContext } from './WebSocketPoller'

export interface SlackReceiverOptions {
  /** xoxb- bot token（发消息用，这里只用于日志判断是否配了） */
  botToken: string
  /** xapp- app-level token（Socket Mode 握手必需） */
  appToken: string
  onMessage: (msg: ChannelMessage) => void
  /** 测试可注入 */
  apiBaseUrl?: string
}

export class SlackSocketReceiver {
  private log = LogManager.getInstance()
  private opts: SlackReceiverOptions
  private poller: WebSocketPoller
  private botUserId: string | null = null
  private warnedNoAppToken = false

  constructor(opts: SlackReceiverOptions) {
    this.opts = opts
    this.poller = new WebSocketPoller({
      channelKind: 'im-slack',
      heartbeatMs: 30_000,
      // Slack 的 WSS 不要求应用层 ping，用 ws 自带 ping 即可；这里不发心跳帧
      connect: (ctx) => this.connect(ctx),
      backoffBaseMs: 2000,
      backoffMaxMs: 60_000,
    })
  }

  start(): void {
    if (!this.opts.appToken) {
      if (!this.warnedNoAppToken) {
        this.warnedNoAppToken = true
        this.log.warn(
          '[SlackSocket] 未配置 App-Level Token (xapp-)，Socket Mode 无法建立。' +
          '请在 Slack App 设置里：① 开启 Socket Mode ② 生成 App-Level Token（connections:write 权限）',
        )
      }
      return
    }
    this.poller.start()
  }

  async stop(): Promise<void> { await this.poller.stop() }
  isRunning(): boolean { return this.poller.isRunning() }
  getMessageCount(): number { return this.poller.getMessageCount() }

  private async connect(ctx: WsConnectionContext): Promise<WsConnection> {
    const base = this.opts.apiBaseUrl ?? 'https://slack.com'
    const res = await fetch(`${base}/api/apps.connections.open`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${this.opts.appToken}`,
        'Content-Type': 'application/x-www-form-urlencoded',
      },
      body: '',
    })
    if (!res.ok) throw new Error(`apps.connections.open HTTP ${res.status}`)
    const data = (await res.json()) as { ok?: boolean; url?: string; error?: string }
    if (!data.ok || !data.url) {
      throw new Error(`apps.connections.open 返回失败: ${data.error ?? 'unknown'}`)
    }

    const WS = (globalThis as { WebSocket?: typeof WebSocket }).WebSocket
    if (!WS) throw new Error('当前 Node 运行时没有全局 WebSocket（需 Node 22+）')

    const socket = new WS(data.url)
    let alive = true

    socket.addEventListener('message', (ev: MessageEvent) => {
      let payload: any
      try {
        payload = JSON.parse(String(ev.data))
      } catch {
        return
      }
      this.handlePayload(payload, ctx, socket)
    })

    socket.addEventListener('close', () => {
      if (alive) ctx.onClose('socket closed')
    })

    socket.addEventListener('error', () => {
      this.log.warn('[SlackSocket] socket error')
    })

    return {
      close: () => {
        alive = false
        try { socket.close() } catch { /* ignore */ }
      },
      send: (d: unknown) => {
        try { socket.send(JSON.stringify(d)) } catch { /* ignore */ }
      },
    }
  }

  private handlePayload(payload: any, ctx: WsConnectionContext, socket: WebSocket): void {
    const type = payload?.type

    if (type === 'hello') {
      this.log.info('[SlackSocket] 已连接（hello）')
      return
    }

    if (type === 'disconnect') {
      this.log.info('[SlackSocket] 服务端断开请求，等待重连')
      try { socket.close() } catch { /* ignore */ }
      return
    }

    if (type !== 'events_api') return

    // ① 无条件 ack —— 不回会被重投并降权
    const envelopeId = payload?.envelope_id
    if (envelopeId) {
      try {
        socket.send(JSON.stringify({ envelope_id: envelopeId }))
      } catch {
        /* ignore */
      }
    }

    const event = payload?.payload?.event
    if (!event) return

    // ② 只处理普通文本消息
    if (event.type !== 'message') return
    if (event.bot_id) return                      // bot 消息
    if (event.subtype) return                     // message_changed / bot_message 等
    if (this.botUserId && event.user === this.botUserId) return

    const text = String(event.text ?? '').trim()
    if (!text) return

    ctx.onMessage(payload)
    this.opts.onMessage({
      // 回复目标 = 频道 id
      to: String(event.channel),
      from: String(event.user ?? 'unknown'),
      text,
      subject: `slack-${event.ts ?? ''}`,
    })
  }
}