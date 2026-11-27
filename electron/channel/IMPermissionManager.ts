/**
 * New World - Channel / IMPermissionManager (W7.1)
 *
 * 校验"谁可以对该通道说话 / 该通道可对谁说话"。W7 阶段:简单白名单。
 */

import { LogManager } from '../core/LogManager'
import { EventBus } from '../runtime/bridge/EventBus'
import { getHost } from '../platform/runtime'
import * as fs from 'node:fs'
import * as path from 'node:path'
import type { ChannelMessage } from '../contracts/types'
import type { ChannelKind } from './ChannelTypes'

/**
 * IMPermissionManager: 校验"谁可以对该通道说话/该通道可对谁说话"
 * W7 阶段:简单白名单(在内存 set 里)
 */
export class IMPermissionManager {
  private static instance: IMPermissionManager
  private log = LogManager.getInstance()
  private bus = EventBus.getInstance()
  /** channelKind → 允许的 userId/openId 列表 */
  private whitelist: Map<string, Set<string>> = new Map()

  private constructor() {
    this.loadFromDisk()
  }

  public static getInstance(): IMPermissionManager {
    if (!IMPermissionManager.instance) IMPermissionManager.instance = new IMPermissionManager()
    return IMPermissionManager.instance
  }

  // ── 持久化（M4.9）───────────────────────────────────────────────
  //
  // 【修真实缺陷】白名单此前**纯内存**，重启即清空 → 回到"空白名单=全允许"，
  // 等于每次重启都把授权撤销、又退回零鉴权状态。对一个能触发 LLM 调用与
  // 出站发消息的功能，这不可接受。
  private storePath(): string {
    return path.join(getHost().getPath('userData'), 'im-permissions.json')
  }

  private loadFromDisk(): void {
    try {
      const p = this.storePath()
      if (!fs.existsSync(p)) return
      const data = JSON.parse(fs.readFileSync(p, 'utf-8')) as Record<string, unknown>
      for (const [kind, list] of Object.entries(data ?? {})) {
        if (!Array.isArray(list)) continue
        const set = new Set(list.filter((x): x is string => typeof x === 'string' && x.length > 0))
        if (set.size > 0) this.whitelist.set(kind, set)
      }
      this.log.info('[IMPermissionManager] 白名单已加载', { channels: this.whitelist.size })
    } catch (e) {
      this.log.warn('[IMPermissionManager] 白名单加载失败，从空开始', e)
    }
  }

  private persist(): void {
    try {
      fs.mkdirSync(path.dirname(this.storePath()), { recursive: true })
      fs.writeFileSync(this.storePath(), JSON.stringify(this.listAll(), null, 2), 'utf-8')
    } catch (e) {
      this.log.warn('[IMPermissionManager] 白名单保存失败', e)
    }
  }

  grant(channelKind: ChannelKind, userId: string): void {
    const set = this.whitelist.get(channelKind) ?? new Set<string>()
    set.add(userId)
    this.whitelist.set(channelKind, set)
    this.persist()
    this.log.info(`IMPermissionManager: ${channelKind} 授权 ${userId}`)
  }

  revoke(channelKind: ChannelKind, userId: string): boolean {
    const set = this.whitelist.get(channelKind)
    if (!set) return false
    const ok = set.delete(userId)
    if (ok) this.persist()
    return ok
  }

  check(channelKind: ChannelKind, userId: string): boolean {
    const set = this.whitelist.get(channelKind)
    if (!set || set.size === 0) return true // 空白名单 = 全允许
    return set.has(userId)
  }

  /**
   * 入站鉴权。
   *
   * 【M4.9 修语义错位】旧实现用 `message.to` 做主体判定，但 `to` 是
   * **接收方/会话**（Telegram 里是 chat_id，Discord 里是 channel_id），
   * 而 `from` 才是**发送者**（user_id）。后果：
   *   · 白名单里填 user_id 永远匹配不上
   *   · 群聊里表现为"按群授权"而不是按人授权 —— 群里任何成员都能触发
   * 现在优先用 `from`（发送者），缺失时才回退到 `to`（部分平台私聊里两者相同）。
   */
  isAllowed(message: ChannelMessage, channelKind: ChannelKind): boolean {
    const subject = (message.from ?? '').trim() || (message.to ?? '').trim()
    return this.check(channelKind, subject)
  }

  listWhitelist(channelKind: ChannelKind): string[] {
    return [...(this.whitelist.get(channelKind) ?? new Set<string>())]
  }

  /**
   * P2-04: 列出所有通道的授权(全量快照)
   */
  listAll(): Record<string, string[]> {
    const out: Record<string, string[]> = {}
    for (const [ch, set] of this.whitelist) {
      out[ch] = [...set]
    }
    return out
  }

  /**
   * P2-04: 导出为 JSON
   */
  exportToJson(): string {
    return JSON.stringify(this.listAll(), null, 2)
  }

  /**
   * P2-04: 从 JSON 导入(覆盖式)
   * 格式:{ "im-feishu": ["user1", "user2"], ... }
   */
  importFromJson(json: string, mode: 'merge' | 'replace' = 'replace'): { imported: number; skipped: number } {
    let parsed: any
    try {
      parsed = JSON.parse(json)
    } catch (e) {
      throw new Error(`JSON 解析失败: ${(e as Error).message}`)
    }
    if (typeof parsed !== 'object' || parsed === null) {
      throw new Error('JSON 必须是 object')
    }
    let imported = 0
    let skipped = 0
    if (mode === 'replace') this.whitelist.clear()
    for (const [channel, users] of Object.entries(parsed)) {
      if (!Array.isArray(users)) {
        skipped += 1
        continue
      }
      const set = this.whitelist.get(channel) ?? new Set<string>()
      for (const u of users) {
        if (typeof u === 'string' && u.length > 0) {
          set.add(u)
          imported += 1
        }
      }
      this.whitelist.set(channel, set)
    }
    this.persist()
    this.log.info(`IMPermissionManager: 导入 ${imported} entries, mode=${mode}`)
    return { imported, skipped }
  }

  /**
   * P2-04: 清空(慎用)
   */
  clearAll(): void {
    this.whitelist.clear()
    this.persist()
  }
}