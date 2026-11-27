/**
 * New World — WebSocketPoller（免公网 IM 入站基座）
 * ═══════════════════════════════════════════════════════════════
 * 【要解决的问题】
 * 11 个 IM 通道出站都是真 fetch，但入站只有 Telegram 一条（getUpdates 长轮询）。
 * 另外 10 个通道的 `__pushIncoming` 是**死入口** —— 没有任何网络路径能把
 * 消息喂进去，因为：
 *   · 需公网回调的平台（WhatsApp / 微信公众号 / 企微）本机环境不可能真通
 *   · 但 Discord / Slack / DingTalk / Rocket.Chat 都提供 **WebSocket 长连接**
 *     模式，是纯客户端出站，不需要公网 IP、域名、证书
 *
 * 【为什么抽基座】
 * 四个平台的长连接协议各不相同（Discord 有 IDENTIFY/HEARTBEAT/RESUME 状态机，
 * Slack 是 envelope 包装，DingTalk Stream 是自定义帧），但**生命周期完全一致**：
 *   连接 → 心跳 → 收消息 → 断线 → 指数退避重连 → 停止时优雅关闭
 * 把这部分抽出来，各平台只实现「怎么连」和「怎么解析消息」。
 *
 * 【与 TelegramPoller 的关系】
 * 不复用 TelegramPoller —— 它是「轮询」模型（定时拉取），本基座是「长连接」
 * 模型（服务端推）。两者生命周期相似但收发模式不同，强行合并会两边都别扭。
 * 相同的是设计纪律：指数退避、abort 可中断、失败不崩主进程。
 *
 * 【红线】
 *   · 断线重连绝不影响主进程（所有异常都在基座内消化）
 *   · 停止必须能立刻打断在途连接与退避等待
 *   · 不引入重量级 SDK —— 只依赖 Node 内置能力（Node 22 起有全局 WebSocket）
 */

import { LogManager } from '../core/LogManager'

export interface WsPollerOptions {
  /** 通道标识，用于日志 */
  channelKind: string
  /** 建立连接（返回可关闭句柄；抛错则由基座重试） */
  connect: (ctx: WsConnectionContext) => Promise<WsConnection>
  /** 退避基数（默认 1s） */
  backoffBaseMs?: number
  /** 退避上限（默认 30s） */
  backoffMaxMs?: number
  /** 心跳间隔（默认 30s）；传 0 关闭基座心跳（由协议自己管） */
  heartbeatMs?: number
  /** 心跳回调（很多协议要求发 ping 帧） */
  onHeartbeat?: (conn: WsConnection) => void
}

/** 传给 connect 的上下文（让实现方能把消息/关闭事件回传） */
export interface WsConnectionContext {
  /** 收到一条原始消息（实现方解析后自己转成 ChannelMessage） */
  onMessage: (raw: unknown) => void
  /** 连接已关闭 */
  onClose: (reason?: string) => void
  /** 是否已请求停止（实现方在长循环里可据此提前退出） */
  isAborted: () => boolean
}

/** 一个已建立的连接 */
export interface WsConnection {
  /** 主动关闭 */
  close: () => void | Promise<void>
  /** 发送原始数据（心跳/ack/identify 用） */
  send?: (data: unknown) => void
}

export class WebSocketPoller {
  private log = LogManager.getInstance()
  private opts: WsPollerOptions
  private running = false
  private abort = new AbortController()
  private loopPromise: Promise<void> | null = null
  private consecutiveErrors = 0
  private current: WsConnection | null = null
  private heartbeatTimer: NodeJS.Timeout | null = null
  private messageCount = 0
  private connectCount = 0

  constructor(opts: WsPollerOptions) {
    this.opts = opts
  }

  isRunning(): boolean { return this.running }
  getMessageCount(): number { return this.messageCount }
  getConnectCount(): number { return this.connectCount }

  start(): void {
    if (this.running) return
    this.running = true
    this.abort = new AbortController()
    this.loopPromise = this.loop().catch((e) => {
      this.log.error(`[${this.opts.channelKind}] WebSocketPoller 循环异常退出`, e)
    })
    this.log.info(`[${this.opts.channelKind}] WebSocketPoller 已启动`)
  }

  async stop(): Promise<void> {
    if (!this.running) return
    this.running = false
    this.abort.abort()
    this.clearHeartbeat()
    try {
      await this.current?.close()
    } catch (e) {
      this.log.warn(`[${this.opts.channelKind}] 关闭连接失败`, e)
    }
    this.current = null
    try {
      await this.loopPromise
    } catch {
      /* 已在上层 catch */
    }
    this.loopPromise = null
    this.log.info(`[${this.opts.channelKind}] WebSocketPoller 已停止`)
  }

  private clearHeartbeat(): void {
    if (this.heartbeatTimer) {
      clearInterval(this.heartbeatTimer)
      this.heartbeatTimer = null
    }
  }

  private async loop(): Promise<void> {
    while (this.running) {
      if (this.abort.signal.aborted) break

      // 等待一次连接关闭（connect 后立即返回，真正的生命周期由 onClose 驱动）
      const closed = new Promise<void>((resolve) => {
        let done = false
        const finish = () => {
          if (done) return
          done = true
          resolve()
        }
        const ctx: WsConnectionContext = {
          onMessage: (raw) => {
            this.messageCount += 1
            // 实现方在 connect 内部自己解析并调 channel.__pushIncoming；
            // 这里只计数（便于状态页观测），不再重复分发。
            void raw
          },
          onClose: (reason) => {
            if (reason) this.log.warn(`[${this.opts.channelKind}] 连接关闭: ${reason}`)
            finish()
          },
          isAborted: () => this.abort.signal.aborted || !this.running,
        }

        void (async () => {
          try {
            this.connectCount += 1
            const conn = await this.opts.connect(ctx)
            if (this.abort.signal.aborted || !this.running) {
              try { await conn.close() } catch { /* ignore */ }
              finish()
              return
            }
            this.current = conn
            this.consecutiveErrors = 0 // 连接成功即重置退避
            this.startHeartbeat(conn)
          } catch (e) {
            this.log.warn(`[${this.opts.channelKind}] 连接失败`, e)
            finish()
          }
        })()
      })

      await Promise.race([
        closed,
        new Promise<void>((resolve) => {
          this.abort.signal.addEventListener('abort', () => resolve(), { once: true })
        }),
      ])

      this.clearHeartbeat()
      if (this.current) {
        try { await this.current.close() } catch { /* ignore */ }
        this.current = null
      }
      if (!this.running || this.abort.signal.aborted) break

      // 指数退避重连（1s → 2s → 4s → ... 上限 30s）
      this.consecutiveErrors += 1
      const base = this.opts.backoffBaseMs ?? 1000
      const max = this.opts.backoffMaxMs ?? 30_000
      const delay = Math.min(base * 2 ** Math.min(this.consecutiveErrors - 1, 5), max)
      this.log.info(`[${this.opts.channelKind}] ${delay}ms 后重连（第 ${this.consecutiveErrors} 次）`)
      await this.sleep(delay)
    }
  }

  private startHeartbeat(conn: WsConnection): void {
    const ms = this.opts.heartbeatMs ?? 30_000
    if (!ms || !this.opts.onHeartbeat) return
    this.clearHeartbeat()
    this.heartbeatTimer = setInterval(() => {
      if (!this.running) return
      try {
        this.opts.onHeartbeat?.(conn)
      } catch (e) {
        this.log.warn(`[${this.opts.channelKind}] 心跳发送失败`, e)
      }
    }, ms)
    this.heartbeatTimer.unref?.()
  }

  /** 可被 abort 打断的 sleep */
  private sleep(ms: number): Promise<void> {
    return new Promise((resolve) => {
      if (this.abort.signal.aborted) return resolve()
      const timer = setTimeout(() => {
        this.abort.signal.removeEventListener('abort', onAbort)
        resolve()
      }, ms)
      const onAbort = () => {
        clearTimeout(timer)
        resolve()
      }
      this.abort.signal.addEventListener('abort', onAbort, { once: true })
    })
  }
}