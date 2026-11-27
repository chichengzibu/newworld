/**
 * New World - Channel / TelegramChannel (W8 → IM 真连通)
 *
 * Telegram Bot API 真实 fetch 实现，出站 / 健康检查 / 入站共用同一套请求管线。
 *  - 发消息:   POST {apiBase}/bot<token>/sendMessage
 *  - 健康检查: GET  {apiBase}/bot<token>/getMe
 *  - 入站轮询: POST {apiBase}/bot<token>/getUpdates (见 TelegramPoller)
 *
 * 【IM 真连通改动】
 *  1. apiBaseUrl 可注入（IMConfigStore.im-telegram.apiBaseUrl），默认官方 API；
 *     本机 mock server / 自托管 Bot API Server 都能做真往返验证。
 *  2. 所有请求带超时（自实现 signal，不依赖 jsdom 缺失的 AbortSignal.timeout）。
 *  3. 校验 Bot API envelope 的 ok 字段 —— HTTP 200 但 ok:false 也算失败，
 *     不再把「API 拒绝」误报成发送成功。
 *  4. callTelegramApi 导出为共享管线，TelegramPoller 复用同一套 URL / 超时 / 错误处理。
 */

import { LogManager } from '../core/LogManager'
import { IMConfigStore } from './IMConfigStore'
import type { IMConfig } from './IMConfigStore'
import { EventBus } from '../runtime/bridge/EventBus'
import type {
  Channel,
  ChannelMessage,
  MessageHandler,
  Disposable,
  ChannelHealth,
} from '../contracts/types'

export const TELEGRAM_DEFAULT_API_BASE = 'https://api.telegram.org'
/** 普通请求硬超时 */
export const TELEGRAM_REQUEST_TIMEOUT_MS = 15_000
/** getUpdates 长轮询硬超时（必须大于 Telegram 侧 50s long polling） */
export const TELEGRAM_POLL_TIMEOUT_MS = 65_000

/** 解析 API 根地址：默认官方，允许 config.apiBaseUrl 覆盖。 */
export function resolveTelegramApiBase(config?: IMConfig): string {
  const raw = config?.apiBaseUrl?.trim()
  if (!raw) return TELEGRAM_DEFAULT_API_BASE
  return raw.replace(/\/+$/, '')
}

/**
 * 构造 Bot API method URL。
 * token 保持原样拼接：Telegram token 只含数字/字母/:/-/_，均为 URL 路径安全字符，
 * encodeURIComponent 会把 ":" 编码成 %3A 反而导致官方 API 401。
 */
export function telegramMethodUrl(apiBase: string, botToken: string, method: string): string {
  const safeToken = botToken.trim().replace(/[\s/]/g, '')
  return `${apiBase}/bot${safeToken}/${method}`
}

export interface TelegramEnvelope<T> {
  ok: boolean
  result?: T
  description?: string
  error_code?: number
}

/**
 * 带超时的 AbortSignal（可再挂一个外部取消信号）。
 * 不用 AbortSignal.timeout —— jsdom / 部分 Node 环境没有该静态方法。
 */
export function withTimeoutSignal(
  ms: number,
  external?: AbortSignal,
): { signal: AbortSignal; cancel: () => void } {
  const ctrl = new AbortController()
  const onExternalAbort = (): void => ctrl.abort()
  if (external) {
    if (external.aborted) ctrl.abort()
    else external.addEventListener('abort', onExternalAbort, { once: true })
  }
  const timer = setTimeout(() => ctrl.abort(), ms)
  return {
    signal: ctrl.signal,
    cancel: () => {
      clearTimeout(timer)
      if (external) external.removeEventListener('abort', onExternalAbort)
    },
  }
}

/**
 * 真实 Bot API 调用：构造 URL → fetch → 校验 HTTP 状态 + envelope.ok。
 * 失败抛带 method 上下文的 Error，供上层退避 / 上报。
 */
export async function callTelegramApi<T>(
  apiBase: string,
  botToken: string,
  method: string,
  opts: {
    body?: Record<string, unknown>
    timeoutMs?: number
    fetchImpl?: typeof fetch
    signal?: AbortSignal
  } = {},
): Promise<T> {
  const url = telegramMethodUrl(apiBase, botToken, method)
  const { signal, cancel } = withTimeoutSignal(
    opts.timeoutMs ?? TELEGRAM_REQUEST_TIMEOUT_MS,
    opts.signal,
  )
  const doFetch = opts.fetchImpl ?? fetch
  try {
    const init: RequestInit = { method: opts.body ? 'POST' : 'GET', signal }
    if (opts.body) {
      init.headers = { 'Content-Type': 'application/json' }
      init.body = JSON.stringify(opts.body)
    }
    const res = await doFetch(url, init)
    if (!res.ok) {
      const errText = await res.text().catch(() => '')
      throw new Error(`Telegram ${method}: HTTP ${res.status} ${errText.slice(0, 200)}`)
    }
    const data = (await res.json()) as TelegramEnvelope<T>
    if (!data.ok) {
      throw new Error(
        `Telegram ${method}: API ${data.error_code ?? '?'} ${data.description ?? 'unknown error'}`,
      )
    }
    return data.result as T
  } finally {
    cancel()
  }
}

export class TelegramChannel implements Channel {
  public readonly id: string
  private log = LogManager.getInstance()
  private configStore = IMConfigStore.getInstance()
  private bus = EventBus.getInstance()
  private handlers: MessageHandler[] = []

  constructor(id: string = 'telegram-main') {
    this.id = id
  }

  /** 当前生效的 API 根地址（Poller 与 UI 测试可读取） */
  getApiBase(): string {
    return resolveTelegramApiBase(this.configStore.get('im-telegram'))
  }

  private requireConfig(): { config: IMConfig; apiBase: string; botToken: string } {
    const config = this.configStore.get('im-telegram')
    if (!config?.enabled) throw new Error('TelegramChannel: 通道未启用或未配置')
    if (!config.botToken) throw new Error('TelegramChannel: 缺少 botToken')
    return { config, apiBase: resolveTelegramApiBase(config), botToken: config.botToken }
  }

  async send(msg: ChannelMessage): Promise<void> {
    const { apiBase, botToken } = this.requireConfig()
    await callTelegramApi(apiBase, botToken, 'sendMessage', {
      body: { chat_id: msg.to, text: msg.text ?? '' },
    })
    void this.bus.publish('im:channel:send:ok', { channelId: this.id, msgTo: msg.to }, 'TelegramChannel')
    this.log.info(`TelegramChannel: 消息已发送到 ${msg.to}`)
  }

  onMessage(handler: MessageHandler): Disposable {
    this.handlers.push(handler)
    return {
      dispose: () => {
        const i = this.handlers.indexOf(handler)
        if (i >= 0) this.handlers.splice(i, 1)
      },
    }
  }

  /**
   * 入站注入点：TelegramPoller 拿到 getUpdates 结果后走这里，
   * 进入 ChannelRouter.register 注册的 handler 链（→ IMMessageRouter → EventBus）。
   * 保留同名方法以兼容既有单测的测试注入。
   */
  __pushIncoming(msg: ChannelMessage): void {
    for (const h of this.handlers) void h(msg)
  }

  async healthCheck(): Promise<ChannelHealth> {
    let creds: { apiBase: string; botToken: string }
    try {
      const r = this.requireConfig()
      creds = { apiBase: r.apiBase, botToken: r.botToken }
    } catch (e) {
      return { healthy: false, error: String(e) }
    }
    const start = Date.now()
    try {
      await callTelegramApi<{ username?: string }>(creds.apiBase, creds.botToken, 'getMe')
      return { healthy: true, latencyMs: Date.now() - start }
    } catch (e) {
      return { healthy: false, error: String(e) }
    }
  }
}
