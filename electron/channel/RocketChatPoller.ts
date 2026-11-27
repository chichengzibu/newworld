/**
 * New World — RocketChatPoller（Rocket.Chat 轮询真入站）
 * ═══════════════════════════════════════════════════════════════
 * 【为什么用轮询而不是 Realtime API】
 * Rocket.Chat 的入站三条路：
 *   · Outgoing Webhook —— 需要公网回调
 *   · Realtime API (DDP over WebSocket) —— 免公网，但 DDP 协议要自己实现
 *     （连接/心跳/method 调用/订阅/pub 流），工程量远大于轮询
 *   · REST `channels.history` / `im.history` 轮询 —— 免公网，实现简单可靠
 *
 * 对"个人助理接自己的 Rocket.Chat"这个场景，轮询 3 秒一次的延迟完全可以接受，
 * 而 DDP 的复杂度与收益不成比例。这里选轮询，并把位置（lastTs）落盘，
 * 重启后从断点续读，不丢消息。
 *
 * 【鉴权】
 *   Rocket.Chat 用 `X-Auth-Token` + `X-User-Id` 两个 header（不是 Bearer）。
 *   这两个值来自用户的 Personal Access Token（个人设置 → 令牌）。
 *
 * 【红线】
 *   · 拉到的消息超过 1 条时按时间正序逐条投递（避免乱序）
 *   · 自己发的消息要跳过（msg.u._id === userId）
 *   · 拉取失败只退避重试，不影响主进程
 */

import * as fs from 'node:fs'
import * as path from 'node:path'
import { getHost } from '../platform/runtime'
import { LogManager } from '../core/LogManager'
import type { ChannelMessage } from '../contracts/types'

export interface RocketChatPollerOptions {
  /** 服务器根地址，如 https://chat.example.com */
  serverUrl: string
  /** Personal Access Token */
  authToken: string
  /** 用户 id */
  userId: string
  /** 要监听的频道/私聊 id 列表；空数组则只轮询 im.history（私聊） */
  channelIds?: string[]
  onMessage: (msg: ChannelMessage) => void
  /** 轮询间隔（默认 3000ms） */
  intervalMs?: number
  /** 断点文件路径（测试可覆盖） */
  statePath?: string
}

interface PollerState {
  lastTs: string | null
  updatedAt: number
}

interface RcMessage {
  _id: string
  msg?: string
  rid?: string
  ts?: string
  u?: { _id?: string; username?: string }
}

export class RocketChatPoller {
  private log = LogManager.getInstance()
  private opts: RocketChatPollerOptions
  private statePath: string
  private state: PollerState = { lastTs: null, updatedAt: 0 }
  private running = false
  private abort = new AbortController()
  private loopPromise: Promise<void> | null = null
  private consecutiveErrors = 0
  private pollCount = 0
  private messageCount = 0
  private seenIds = new Set<string>()

  constructor(opts: RocketChatPollerOptions) {
    this.opts = opts
    this.statePath =
      opts.statePath ?? path.join(getHost().getPath('userData'), 'rocketchat-state.json')
    this.loadState()
  }

  isRunning(): boolean { return this.running }
  getPollCount(): number { return this.pollCount }
  getMessageCount(): number { return this.messageCount }
  getLastTs(): string | null { return this.state.lastTs }

  start(): void {
    if (this.running) return
    if (!this.opts.serverUrl || !this.opts.authToken || !this.opts.userId) {
      this.log.warn('[RocketChatPoller] 缺少 serverUrl / authToken / userId，无法启动')
      return
    }
    this.running = true
    this.abort = new AbortController()
    this.loopPromise = this.loop().catch((e) => {
      this.log.error('[RocketChatPoller] 循环异常退出', e)
    })
    this.log.info('[RocketChatPoller] 已启动')
  }

  async stop(): Promise<void> {
    if (!this.running) return
    this.running = false
    this.abort.abort()
    try {
      await this.loopPromise
    } catch {
      /* ignore */
    }
    this.loopPromise = null
    this.log.info('[RocketChatPoller] 已停止')
  }

  private loadState(): void {
    try {
      if (!fs.existsSync(this.statePath)) return
      const parsed = JSON.parse(fs.readFileSync(this.statePath, 'utf-8')) as PollerState
      if (parsed && (parsed.lastTs === null || typeof parsed.lastTs === 'string')) {
        this.state = { lastTs: parsed.lastTs ?? null, updatedAt: parsed.updatedAt ?? 0 }
      }
    } catch (e) {
      this.log.warn('[RocketChatPoller] 状态读取失败，从最新开始', e)
    }
  }

  private saveState(): void {
    try {
      fs.mkdirSync(path.dirname(this.statePath), { recursive: true })
      const data: PollerState = { lastTs: this.state.lastTs, updatedAt: Date.now() }
      fs.writeFileSync(this.statePath, JSON.stringify(data, null, 2), 'utf-8')
    } catch (e) {
      this.log.warn('[RocketChatPoller] 状态保存失败', e)
    }
  }

  private async loop(): Promise<void> {
    while (this.running) {
      if (this.abort.signal.aborted) break
      try {
        await this.pollOnce()
        this.consecutiveErrors = 0
      } catch (e) {
        if (!this.running) break
        this.consecutiveErrors += 1
        const base = 2000
        const max = 60_000
        const delay = Math.min(base * 2 ** Math.min(this.consecutiveErrors - 1, 5), max)
        this.log.warn(`[RocketChatPoller] 拉取失败（第 ${this.consecutiveErrors} 次），${delay}ms 后重试`, e)
        await this.sleep(delay)
        continue
      }
      await this.sleep(this.opts.intervalMs ?? 3000)
    }
  }

  private async pollOnce(): Promise<void> {
    const base = this.opts.serverUrl.replace(/\/$/, '')
    const headers = {
      'X-Auth-Token': this.opts.authToken,
      'X-User-Id': this.opts.userId,
      'Content-Type': 'application/json',
    }

    // 首次运行没有 lastTs → 用当前时间做基线，避免把历史消息全捞一遍
    if (!this.state.lastTs) {
      this.state.lastTs = new Date().toISOString()
      this.saveState()
      this.pollCount += 1
      return
    }

    this.pollCount += 1

    // 私聊历史（im.history 需要 roomId，这里用 groups.history 的通用形态：
    // 实际上 Rocket.Chat 没有"我所有私聊"的聚合接口，需要按 rid 逐个拉。
    // 因此 channelIds 为空时，仅拉取 im.messages 的全局增量（若服务器支持），
    // 否则提示用户配置具体频道。这里走 channels.history + 用户配置的 roomIds。
    const roomIds = this.opts.channelIds ?? []
    if (roomIds.length === 0) {
      if (this.pollCount === 1) {
        this.log.warn(
          '[RocketChatPoller] 未配置监听频道（channelIds 为空）。' +
          '请在 IM 管理里填入要监听的房间/私聊 id（Rocket.Chat 房间 URL 里的最后一段）。',
        )
      }
      return
    }

    for (const rid of roomIds) {
      if (!this.running) break
      const url = new URL(`${base}/api/v1/im.history`)
      url.searchParams.set('roomId', rid)
      url.searchParams.set('oldest', this.state.lastTs)
      url.searchParams.set('count', '50')
      url.searchParams.set('inclusive', 'false')

      let data: { success?: boolean; messages?: RcMessage[]; error?: string }
      try {
        const res = await fetch(url.toString(), {
          headers,
          signal: this.abort.signal,
        })
        if (!res.ok) {
          this.log.warn(`[RocketChatPoller] ${rid} HTTP ${res.status}`)
          continue
        }
        data = (await res.json()) as typeof data
      } catch (e) {
        if (this.abort.signal.aborted) return
        throw e
      }

      if (!data?.success || !Array.isArray(data.messages)) {
        // im.history 对公开频道会报错，降级试 channels.history
        const alt = await this.tryChannelsHistory(base, rid, headers)
        if (!alt) continue
        data = alt
      }

      const msgs = (data.messages ?? [])
        .slice()
        .sort((a, b) => String(a.ts ?? '').localeCompare(String(b.ts ?? '')))

      for (const m of msgs) {
        if (!m?._id || !m.msg) continue
        // 跳过自己发的
        if (m.u?._id && m.u._id === this.opts.userId) continue
        // 去重（同一 ts 边界会重复拉到）
        if (this.seenIds.has(m._id)) continue
        this.seenIds.add(m._id)
        if (this.seenIds.size > 2000) {
          // 简单限容：避免长期运行内存增长
          this.seenIds = new Set([...this.seenIds].slice(-1000))
        }

        this.messageCount += 1
        this.opts.onMessage({
          to: String(m.rid ?? rid),
          from: String(m.u?._id ?? m.u?.username ?? 'unknown'),
          text: String(m.msg).trim(),
          subject: `rc-${m._id}`,
        })

        if (m.ts) this.state.lastTs = m.ts
      }
    }

    this.saveState()
  }

  private async tryChannelsHistory(
    base: string,
    roomId: string,
    headers: Record<string, string>,
  ): Promise<{ success?: boolean; messages?: RcMessage[] } | null> {
    try {
      const url = new URL(`${base}/api/v1/channels.history`)
      url.searchParams.set('roomId', roomId)
      if (this.state.lastTs) url.searchParams.set('oldest', this.state.lastTs)
      url.searchParams.set('count', '50')
      const res = await fetch(url.toString(), { headers, signal: this.abort.signal })
      if (!res.ok) return null
      const d = (await res.json()) as { success?: boolean; messages?: RcMessage[] }
      return d
    } catch {
      return null
    }
  }

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