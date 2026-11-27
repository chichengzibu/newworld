/**
 * New World — DiscordGatewayReceiver（Discord Gateway WebSocket 真入站）
 * ═══════════════════════════════════════════════════════════════
 * 【为什么是 Gateway 而不是 Interactions HTTP】
 * Discord 的入站有两条路：
 *   · HTTP Interactions —— 需要公网 HTTPS 端点 + Ed25519 验签，本机不可能
 *   · Gateway WebSocket —— `wss://gateway.discord.gg`，**纯客户端出站**，
 *     不需要公网 IP、域名、证书。本机可直接跑通。
 *
 * 【协议要点（Discord Gateway v10）】
 *   ① 连接后服务端先发 op=10 (HELLO)，带 heartbeat_interval
 *   ② 客户端按间隔发 op=1 (HEARTBEAT)，否则会被断开
 *   ③ 发 op=2 (IDENTIFY) 带上 token + intents
 *   ④ 收 op=0 (DISPATCH)，t=MESSAGE_CREATE 就是新消息
 *   ⑤ 收 op=11 (HEARTBEAT_ACK) 表示心跳成功
 *   ⑥ 断线重连时若拿到 session_id + resume_gateway_url，可发 op=6 (RESUME)
 *
 * 【intents】
 *   MESSAGE_CONTENT (1<<15 = 32768) 是**特权 intent** ——
 *   需要在 Discord Developer Portal 里为 bot 手动开启，否则收到的
 *   message.content 会是空的。这里默认请求它，并在收到空内容时
 *   给出明确提示（而不是静默丢弃，那会让人以为"通了但没反应"）。
 *
 * 【红线】
 *   · token 绝不进日志
 *   · bot 自己发的消息必须过滤（否则自问自答死循环）
 *   · 解析失败只丢这一条，不断连接
 */

import { LogManager } from '../core/LogManager'
import type { ChannelMessage } from '../contracts/types'
import { WebSocketPoller, type WsConnection, type WsConnectionContext } from './WebSocketPoller'

const GATEWAY_URL = 'wss://gateway.discord.gg/?v=10&encoding=json'
const OP = {
  DISPATCH: 0,
  HEARTBEAT: 1,
  IDENTIFY: 2,
  RESUME: 6,
  RECONNECT: 7,
  INVALID_SESSION: 9,
  HELLO: 10,
  HEARTBEAT_ACK: 11,
} as const

/** GUILDS | GUILD_MESSAGES | DIRECT_MESSAGES | MESSAGE_CONTENT */
const INTENTS = (1 << 0) | (1 << 9) | (1 << 12) | (1 << 15)

export interface DiscordReceiverOptions {
  botToken: string
  /** 收到消息回调 */
  onMessage: (msg: ChannelMessage) => void
  /** 测试可注入 mock gateway URL */
  gatewayUrl?: string
}

export class DiscordGatewayReceiver {
  private log = LogManager.getInstance()
  private opts: DiscordReceiverOptions
  private poller: WebSocketPoller
  private heartbeatTimer: NodeJS.Timeout | null = null
  private seq: number | null = null
  private sessionId: string | null = null
  private resumeUrl: string | null = null
  private botUserId: string | null = null
  private warnedIntents = false

  constructor(opts: DiscordReceiverOptions) {
    this.opts = opts
    this.poller = new WebSocketPoller({
      channelKind: 'im-discord',
      heartbeatMs: 0, // 心跳间隔由 HELLO 动态决定，不用基座固定心跳
      connect: (ctx) => this.connect(ctx),
      backoffBaseMs: 2000,
      backoffMaxMs: 60_000,
    })
  }

  start(): void { this.poller.start() }
  async stop(): Promise<void> {
    this.clearHeartbeat()
    await this.poller.stop()
  }
  isRunning(): boolean { return this.poller.isRunning() }
  getMessageCount(): number { return this.poller.getMessageCount() }

  private clearHeartbeat(): void {
    if (this.heartbeatTimer) {
      clearInterval(this.heartbeatTimer)
      this.heartbeatTimer = null
    }
  }

  private async connect(ctx: WsConnectionContext): Promise<WsConnection> {
    const url = this.resumeUrl ?? this.opts.gatewayUrl ?? GATEWAY_URL
    const WS = (globalThis as { WebSocket?: typeof WebSocket }).WebSocket
    if (!WS) {
      throw new Error('当前 Node 运行时没有全局 WebSocket（需 Node 22+）')
    }

    const socket = new WS(url)
    let alive = true

    const close = (): void => {
      alive = false
      this.clearHeartbeat()
      try { socket.close() } catch { /* ignore */ }
    }

    // 等 HELLO，然后 IDENTIFY（或 RESUME）
    const helloPromise = new Promise<number>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('等待 HELLO 超时（15s）')), 15_000)
      socket.addEventListener('message', (ev: MessageEvent) => {
        let payload: any
        try {
          payload = JSON.parse(String(ev.data))
        } catch {
          return
        }
        if (payload?.op === OP.HELLO) {
          clearTimeout(timer)
          resolve(Number(payload?.d?.heartbeat_interval ?? 41_250))
        }
      })
      socket.addEventListener('error', () => {
        clearTimeout(timer)
        reject(new Error('WebSocket 连接失败'))
      })
    })

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

    socket.addEventListener('error', (e: Event) => {
      this.log.warn('[DiscordGateway] socket error', (e as ErrorEvent)?.message ?? '')
    })

    const interval = await helloPromise

    // 启动心跳
    this.startHeartbeat(interval, socket)

    // IDENTIFY 或 RESUME
    if (this.sessionId && this.seq !== null) {
      socket.send(JSON.stringify({
        op: OP.RESUME,
        d: { token: this.opts.botToken, session_id: this.sessionId, seq: this.seq },
      }))
      this.log.info('[DiscordGateway] 尝试 RESUME 恢复会话')
    } else {
      socket.send(JSON.stringify({
        op: OP.IDENTIFY,
        d: {
          token: this.opts.botToken,
          intents: INTENTS,
          properties: { os: process.platform, browser: 'new-world', device: 'new-world' },
        },
      }))
      this.log.info('[DiscordGateway] 已发送 IDENTIFY')
    }

    return {
      close,
      send: (data: unknown) => {
        try { socket.send(JSON.stringify(data)) } catch { /* ignore */ }
      },
    }
  }

  private startHeartbeat(intervalMs: number, socket: WebSocket): void {
    this.clearHeartbeat()
    // 首次心跳按规范要带随机抖动（0~interval），这里简化成立即发一次
    const beat = (): void => {
      try {
        socket.send(JSON.stringify({ op: OP.HEARTBEAT, d: this.seq }))
      } catch {
        /* socket 已断，基座会重连 */
      }
    }
    beat()
    this.heartbeatTimer = setInterval(beat, Math.max(5000, intervalMs))
    this.heartbeatTimer.unref?.()
  }

  private handlePayload(payload: any, ctx: WsConnectionContext, socket: WebSocket): void {
    const op = payload?.op

    if (typeof payload?.s === 'number') this.seq = payload.s

    switch (op) {
      case OP.DISPATCH: {
        this.handleDispatch(payload, ctx)
        break
      }
      case OP.HEARTBEAT_ACK:
        break
      case OP.RECONNECT:
        this.log.info('[DiscordGateway] 服务端要求重连')
        try { socket.close() } catch { /* ignore */ }
        break
      case OP.INVALID_SESSION:
        this.log.warn('[DiscordGateway] 会话失效，清空 resume 状态')
        this.sessionId = null
        this.seq = null
        this.resumeUrl = null
        try { socket.close() } catch { /* ignore */ }
        break
      default:
        break
    }
  }

  private handleDispatch(payload: any, ctx: WsConnectionContext): void {
    const t = payload?.t
    const d = payload?.d

    if (t === 'READY') {
      this.sessionId = d?.session_id ?? null
      this.resumeUrl = d?.resume_gateway_url ? `${d.resume_gateway_url}/?v=10&encoding=json` : null
      this.botUserId = d?.user?.id ?? null
      this.log.info('[DiscordGateway] READY', { botId: this.botUserId })
      return
    }

    if (t !== 'MESSAGE_CREATE') return

    // 过滤 bot 自己的消息（防自问自答）
    if (d?.author?.bot) return
    if (this.botUserId && d?.author?.id === this.botUserId) return

    const content = String(d?.content ?? '').trim()
    if (!content) {
      if (!this.warnedIntents) {
        this.warnedIntents = true
        this.log.warn(
          '[DiscordGateway] 收到 MESSAGE_CREATE 但 content 为空 —— ' +
          '通常是 MESSAGE_CONTENT (特权 intent) 未在 Developer Portal 开启。' +
          '请在 Bot 页面开启「Message Content Intent」后重启应用。',
        )
      }
      return
    }

    ctx.onMessage(payload)
    this.opts.onMessage({
      // 回复目标 = 频道 id
      to: String(d.channel_id),
      from: String(d.author?.id ?? 'unknown'),
      text: content,
      subject: `dc-${d.id}`,
    })
  }
}