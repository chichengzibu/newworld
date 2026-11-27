/**
 * New World - Channel / TelegramPoller (IM 真连通 · 入站接收)
 *
 * 为什么是长轮询而不是 webhook：
 *   本机环境无公网 IP / 无域名 / 无备案 / 用户未购买 TLS 证书，
 *   无法让 Telegram 反向回调。getUpdates 是纯客户端出站连接，
 *   不需要任何入站端口，是本机可跑通的最小真实闭环。
 *
 * 链路：
 *   getUpdates → Update → ChannelMessage → onMessage(TelegramChannel.__pushIncoming)
 *   → ChannelRouter.register 的 handler → IMMessageRouter.handleIncoming
 *   → EventBus('im:channel:incoming') → InboundBridge → ChannelRouter.send
 *
 * 可靠性：
 *   - nextOffset 持久化到 userData/telegram-offset.json，重启不重复消费；
 *   - 启动时 deleteWebhook（长轮询与 webhook 互斥，失败不致命）；
 *   - 连续错误指数退避，stop() 可立即中断 sleep 与在途请求；
 *   - 忽略 bot 自身消息与非文本消息，避免自回复循环。
 */

import { LogManager } from '../core/LogManager'
import { getHost } from '../platform/runtime'
import * as fs from 'node:fs'
import * as path from 'node:path'
import { IMConfigStore } from './IMConfigStore'
import {
  resolveTelegramApiBase,
  callTelegramApi,
  TELEGRAM_POLL_TIMEOUT_MS,
} from './TelegramChannel'
import type { ChannelMessage } from '../contracts/types'

export interface TelegramUpdate {
  update_id: number
  message?: {
    message_id: number
    from?: { id: number; is_bot?: boolean; first_name?: string; username?: string }
    chat: { id: number | string; type?: string }
    date?: number
    text?: string
    caption?: string
  }
}

export interface TelegramPollerOptions {
  /** 入站回调：生产接 TelegramChannel.__pushIncoming，测试可注入 spy */
  onMessage: (msg: ChannelMessage) => void | Promise<void>
  /** 覆盖 API 根地址（本机 mock server / 自托管） */
  apiBaseUrl?: string
  /** 覆盖 botToken（测试） */
  botToken?: string
  /** 覆盖 fetch（测试） */
  fetchImpl?: typeof fetch
  /** offset 持久化路径，默认 userData/telegram-offset.json */
  offsetPath?: string
  /** Telegram 侧长轮询秒数，默认 50 */
  pollTimeoutSec?: number
  /** 单次请求硬超时 ms，默认 65s */
  requestTimeoutMs?: number
  /** 错误退避基数 / 上限 ms */
  backoffBaseMs?: number
  backoffMaxMs?: number
  /** 跳过启动时的 deleteWebhook（测试可关） */
  skipDeleteWebhook?: boolean
}

interface OffsetFile {
  nextOffset: number
  updatedAt: number
}

export class TelegramPoller {
  private log = LogManager.getInstance()
  private configStore = IMConfigStore.getInstance()
  private opts: TelegramPollerOptions
  private offsetPath: string
  private nextOffset = 0
  private running = false
  private abort: AbortController = new AbortController()
  private loopPromise: Promise<void> | null = null
  private consecutiveErrors = 0
  private pollCount = 0
  /** 【v4.13】累计成功分发的消息数 —— 供入站状态面板展示「真收到几条」 */
  private messageCount = 0

  constructor(opts: TelegramPollerOptions) {
    this.opts = opts
    this.offsetPath =
      opts.offsetPath ?? path.join(getHost().getPath('userData'), 'telegram-offset.json')
    this.loadOffset()
  }

  getOffset(): number { return this.nextOffset }
  getPollCount(): number { return this.pollCount }
  getMessageCount(): number { return this.messageCount }
  isRunning(): boolean { return this.running }

  private creds(): { apiBase: string; botToken: string } | null {
    const cfg = this.configStore.get('im-telegram')
    if (!cfg?.enabled && !this.opts.botToken) return null
    const botToken = this.opts.botToken ?? cfg?.botToken
    if (!botToken) return null
    const apiBase = this.opts.apiBaseUrl ?? resolveTelegramApiBase(cfg)
    return { apiBase, botToken }
  }

  private loadOffset(): void {
    try {
      if (!fs.existsSync(this.offsetPath)) return
      const parsed = JSON.parse(fs.readFileSync(this.offsetPath, 'utf-8')) as OffsetFile
      if (Number.isInteger(parsed.nextOffset) && parsed.nextOffset >= 0) {
        this.nextOffset = parsed.nextOffset
      }
    } catch (e) {
      this.log.warn('TelegramPoller: offset 读取失败，从 0 开始', e)
    }
  }

  private saveOffset(): void {
    try {
      fs.mkdirSync(path.dirname(this.offsetPath), { recursive: true })
      const data: OffsetFile = { nextOffset: this.nextOffset, updatedAt: Date.now() }
      fs.writeFileSync(this.offsetPath, JSON.stringify(data), 'utf-8')
    } catch (e) {
      this.log.warn('TelegramPoller: offset 持久化失败', e)
    }
  }

  /**
   * 执行一次 getUpdates 并派发。生产由 loop() 循环调用，测试可直调做真往返验证。
   * 返回本轮派发的消息数。
   */
  async pollOnce(): Promise<number> {
    const creds = this.creds()
    if (!creds) throw new Error('TelegramPoller: Telegram 通道未启用或缺少 botToken')

    const pollTimeoutSec = this.opts.pollTimeoutSec ?? 50
    const body: Record<string, unknown> = {
      offset: this.nextOffset,
      timeout: pollTimeoutSec,
      allowed_updates: ['message'],
    }
    const updates = await callTelegramApi<TelegramUpdate[]>(
      creds.apiBase,
      creds.botToken,
      'getUpdates',
      {
        body,
        timeoutMs: this.opts.requestTimeoutMs ?? TELEGRAM_POLL_TIMEOUT_MS,
        fetchImpl: this.opts.fetchImpl,
        signal: this.abort.signal,
      },
    )

    let handled = 0
    for (const update of Array.isArray(updates) ? updates : []) {
      // nextOffset 按「最后处理 update_id + 1」推进，即使该 update 被过滤也不回退
      if (Number.isInteger(update.update_id)) {
        this.nextOffset = Math.max(this.nextOffset, update.update_id + 1)
      }
      const msg = this.toChannelMessage(update)
      if (!msg) continue
      try {
        await this.opts.onMessage(msg)
        handled++
      } catch (e) {
        this.log.warn('TelegramPoller: 入站回调失败', e)
      }
    }
    if (Array.isArray(updates) && updates.length > 0) this.saveOffset()
    // 【v4.13】累计成功分发的消息数 —— 供入站状态面板展示「真收到几条」。
    // 原来只有 pollCount（轮询次数），面板只能显示「循环在跑但 0 条消息」，
    // 与事实不符：消息可能一直在收，只是没被计数。
    this.messageCount += handled
    this.pollCount++
    this.consecutiveErrors = 0
    return handled
  }

  /** Telegram Update → 统一 ChannelMessage。返回 null 表示忽略。 */
  private toChannelMessage(update: TelegramUpdate): ChannelMessage | null {
    const m = update.message
    if (!m) return null
    if (m.from?.is_bot) return null
    const text = (m.text ?? m.caption ?? '').trim()
    if (!text) return null
    return {
      // to = chat_id，回复时原样回这个会话；from = 发送者，供权限与审计
      to: String(m.chat.id),
      from: m.from?.id != null ? String(m.from.id) : String(m.chat.id),
      text,
      subject: `tg-${m.message_id}`,
    }
  }

  /** 启动后台长轮询循环（幂等） */
  start(): void {
    if (this.running) return
    this.running = true
    this.abort = new AbortController()
    this.loopPromise = this.loop()
    this.log.info('TelegramPoller: 入站长轮询已启动')
  }

  private async loop(): Promise<void> {
    if (!this.opts.skipDeleteWebhook) {
      try {
        const creds = this.creds()
        if (creds) {
          await callTelegramApi(creds.apiBase, creds.botToken, 'deleteWebhook', {
            timeoutMs: 10_000,
            fetchImpl: this.opts.fetchImpl,
            signal: this.abort.signal,
          })
        }
      } catch (e) {
        // 已设置 webhook 时 getUpdates 会 409；清失败只告警，不阻断轮询
        this.log.warn('TelegramPoller: deleteWebhook 失败（非致命）', e)
      }
    }

    while (this.running) {
      if (this.abort.signal.aborted) break
      try {
        await this.pollOnce()
      } catch (e) {
        if (!this.running) break
        this.consecutiveErrors++
        const base = this.opts.backoffBaseMs ?? 1000
        const max = this.opts.backoffMaxMs ?? 30_000
        const delay = Math.min(base * 2 ** Math.min(this.consecutiveErrors - 1, 5), max)
        this.log.warn(
          `TelegramPoller: 轮询失败(${this.consecutiveErrors}) ${String(e)}，${delay}ms 后重试`,
        )
        await this.sleep(delay)
      }
    }
  }

  /** 可被 stop() 立即打断的 sleep */
  private sleep(ms: number): Promise<void> {
    return new Promise((resolve) => {
      const timer = setTimeout(resolve, ms)
      this.abort.signal.addEventListener(
        'abort',
        () => {
          clearTimeout(timer)
          resolve()
        },
        { once: true },
      )
    })
  }

  /** 停止轮询并等待在途请求退出 */
  async stop(): Promise<void> {
    if (!this.running) return
    this.running = false
    this.abort.abort()
    try {
      await this.loopPromise
    } catch {
      // loop 内部已吞掉错误
    }
    this.loopPromise = null
    this.log.info('TelegramPoller: 入站长轮询已停止')
  }
}
