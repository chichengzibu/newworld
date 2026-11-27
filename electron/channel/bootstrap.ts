/**
 * New World - Channel / bootstrap (W8 → IM 真连通)
 *
 * 应用启动时：
 *  1. 把 IMConfigStore 中「已启用」的通道注册进 ChannelRouter；
 *  2. 启动 InboundBridge（订阅 im:channel:incoming → 生成回复 → ChannelRouter.send）；
 *  3. Telegram 已启用时启动 getUpdates 入站长轮询。
 *
 * 配置保存 / 删除后调 refreshChannels() 热重载，避免「改完配置必须重启 App
 * 才能发消息」。shutdownChannels() 在退出时停止轮询，避免后台残留请求。
 */

import { LogManager } from '../core/LogManager'
import { IMConfigStore } from './IMConfigStore'
import { ChannelRouter } from './ChannelRouter'
import { createChannelByKind, ALL_CHANNEL_KINDS } from './factory'
import { TelegramChannel } from './TelegramChannel'
import { TelegramPoller } from './TelegramPoller'
import { DiscordGatewayReceiver } from './DiscordGatewayReceiver'
import { SlackSocketReceiver } from './SlackSocketReceiver'
import { RocketChatPoller } from './RocketChatPoller'
import { InboundBridge } from './InboundBridge'
import { createLlmReplyGenerator } from './LlmReplyGenerator'
import type { ChannelKind } from './ChannelTypes'
import type { ChannelMessage } from '../contracts/types'

/** 通道里支持"免公网真入站"的接收器 */
interface InboundReceiver {
  start: () => void
  stop: () => Promise<void>
  isRunning?: () => boolean
  getMessageCount?: () => number
}

let poller: TelegramPoller | null = null
/** M4.9：其余免公网入站接收器（Discord Gateway / Slack Socket Mode / Rocket.Chat 轮询） */
const receivers = new Map<ChannelKind, InboundReceiver>()

function registerEnabledChannels(): number {
  const log = LogManager.getInstance()
  const configStore = IMConfigStore.getInstance()
  const router = ChannelRouter.getInstance()
  let registered = 0
  for (const kind of ALL_CHANNEL_KINDS) {
    const cfg = configStore.get(kind)
    if (!cfg?.enabled) continue
    try {
      const channel = createChannelByKind(kind, kind)
      router.register(channel, {
        id: kind,
        kind,
        displayName: kind,
        enabled: true,
        priority: 0,
        configRef: kind,
      })
      registered++
    } catch (e) {
      log.warn(`initChannels: 注册 ${kind} 失败`, e)
    }
  }
  log.info(`initChannels: 共注册 ${registered} 个已启用通道`)
  return registered
}

/** 入站 → 回复闭环，全局只启动一次 */
function ensureBridge(): void {
  const bridge = InboundBridge.getInstance({ replyGenerator: createLlmReplyGenerator() })
  if (!bridge.isStarted()) bridge.start()
}

/**
 * Telegram 入站长轮询。
 * 只在通道已启用且 botToken 存在时启动；apiBaseUrl 由 TelegramChannel 统一读取，
 * 因此本机 mock server / 自托管端点同样生效。
 */
function startPoller(): void {
  const log = LogManager.getInstance()
  if (poller) return
  const cfg = IMConfigStore.getInstance().get('im-telegram')
  if (!cfg?.enabled || !cfg.botToken) {
    log.info('initChannels: Telegram 未启用，跳过入站长轮询')
    return
  }
  const channel = ChannelRouter.getInstance().get('im-telegram') as TelegramChannel | undefined
  if (!channel || typeof channel.__pushIncoming !== 'function') {
    log.warn('initChannels: Telegram 实例缺少入站注入点，跳过轮询')
    return
  }
  poller = new TelegramPoller({
    onMessage: (msg) => channel.__pushIncoming(msg),
  })
  poller.start()
}

async function stopPoller(): Promise<void> {
  if (!poller) return
  const current = poller
  poller = null
  await current.stop()
}

/**
 * 【M4.9】启动其余免公网入站接收器。
 *
 * 三条都走"纯客户端出站"，本机无公网 IP / 域名 / 证书也能收消息：
 *   · Discord   —— Gateway WebSocket（需 botToken）
 *   · Slack     —— Socket Mode（需 app-level token xapp-）
 *   · Rocket.Chat —— REST 轮询（需 authToken + userId + 频道 id）
 *
 * 需要公网回调的三家（WhatsApp / 微信公众号 / 企微）不在此列 ——
 * 它们在本机环境物理上不可能真入站，强行加只会造一个假的"已连通"。
 */
function startInboundReceivers(): void {
  const log = LogManager.getInstance()
  const configStore = IMConfigStore.getInstance()
  const router = ChannelRouter.getInstance()

  const pushTo = (kind: ChannelKind, msg: ChannelMessage): void => {
    const ch = router.get(kind) as { __pushIncoming?: (m: ChannelMessage) => void } | undefined
    if (ch && typeof ch.__pushIncoming === 'function') {
      ch.__pushIncoming(msg)
    } else {
      log.warn(`[bootstrap] ${kind} 实例缺少入站注入点，消息被丢弃`)
    }
  }

  // ── Discord Gateway ──
  if (!receivers.has('im-discord')) {
    const cfg = configStore.get('im-discord')
    if (cfg?.enabled && cfg.botToken) {
      try {
        const r = new DiscordGatewayReceiver({
          botToken: cfg.botToken,
          onMessage: (m) => pushTo('im-discord', m),
          ...(cfg.apiBaseUrl ? { gatewayUrl: cfg.apiBaseUrl } : {}),
        })
        r.start()
        receivers.set('im-discord', r)
        log.info('[bootstrap] Discord Gateway 入站已启动')
      } catch (e) {
        log.warn('[bootstrap] Discord 入站启动失败', e)
      }
    }
  }

  // ── Slack Socket Mode ──
  if (!receivers.has('im-slack')) {
    const cfg = configStore.get('im-slack')
    if (cfg?.enabled && cfg.botToken) {
      // Slack Socket Mode 需要 app-level token (xapp-)；
      // 老配置可能把 xapp- 存在 signingSecret 里，这里两者都认。
      const appToken = cfg.appToken ?? (cfg as { signingSecret?: string }).signingSecret ?? ''
      try {
        const r = new SlackSocketReceiver({
          botToken: cfg.botToken,
          appToken,
          onMessage: (m) => pushTo('im-slack', m),
          ...(cfg.apiBaseUrl ? { apiBaseUrl: cfg.apiBaseUrl } : {}),
        })
        r.start()
        receivers.set('im-slack', r)
        log.info('[bootstrap] Slack Socket Mode 入站已启动')
      } catch (e) {
        log.warn('[bootstrap] Slack 入站启动失败', e)
      }
    }
  }

  // ── Rocket.Chat 轮询 ──
  if (!receivers.has('im-rocket')) {
    const cfg = configStore.get('im-rocket')
    if (cfg?.enabled && cfg.apiBaseUrl && cfg.botToken) {
      try {
        const roomIds = cfg.channelIds ?? []
        const r = new RocketChatPoller({
          serverUrl: cfg.apiBaseUrl,
          authToken: cfg.botToken,
          userId: cfg.userId ?? '',
          channelIds: roomIds,
          onMessage: (m) => pushTo('im-rocket', m),
        })
        r.start()
        receivers.set('im-rocket', r)
        log.info('[bootstrap] Rocket.Chat 轮询入站已启动')
      } catch (e) {
        log.warn('[bootstrap] Rocket.Chat 入站启动失败', e)
      }
    }
  }
}

/** 停止全部免公网接收器 */
async function stopInboundReceivers(): Promise<void> {
  const pending: Array<Promise<void>> = []
  for (const [kind, r] of receivers) {
    pending.push(
      r.stop().catch((e) => {
        LogManager.getInstance().warn(`[bootstrap] 停止 ${kind} 入站失败`, e)
      }),
    )
  }
  receivers.clear()
  await Promise.all(pending)
}

/** 应用启动入口（main.ts 调用） */
export function initChannels(): void {
  registerEnabledChannels()
  ensureBridge()
  startPoller()
  startInboundReceivers()
}

/** 配置变更后的热重载：先停轮询 → 清空旧注册 → 重新注册 → 重启轮询 */
export async function refreshChannels(): Promise<void> {
  await stopPoller()
  await stopInboundReceivers()
  const router = ChannelRouter.getInstance()
  for (const meta of router.listMetadata()) router.unregister(meta.id)
  registerEnabledChannels()
  ensureBridge()
  startPoller()
  startInboundReceivers()
}

/** 应用退出前停止后台轮询 */
export async function shutdownChannels(): Promise<void> {
  await stopPoller()
  await stopInboundReceivers()
  InboundBridge.getInstance().stop()
}

/** 供状态页 / 测试读取当前各通道入站状态 */
export function getInboundStatus(): Record<string, { running: boolean; messages: number }> {
  const out: Record<string, { running: boolean; messages: number }> = {
    'im-telegram': {
      running: poller?.isRunning() ?? false,
      // 【v4.13】原为硬编码 0 —— TelegramPoller 此前没统计消息数，
      // 面板只能显示「运行中但 0 条」，与事实不符（可能一直在收）。
      messages: poller?.getMessageCount() ?? 0,
    },
  }
  for (const [kind, r] of receivers) {
    out[kind] = {
      running: r.isRunning?.() ?? true,
      messages: r.getMessageCount?.() ?? 0,
    }
  }
  return out
}

/** 供状态页 / 测试读取当前轮询状态 */
export function getTelegramPollerStatus(): { running: boolean; offset: number; polls: number } {
  return {
    running: poller?.isRunning() ?? false,
    offset: poller?.getOffset() ?? 0,
    polls: poller?.getPollCount() ?? 0,
  }
}
