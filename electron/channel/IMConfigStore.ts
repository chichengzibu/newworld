/**
 * New World - Channel / IMConfigStore (W7.1)
 *
 * 各 IM 通道鉴权信息存储:持久化到 userData/im-config.json.enc(safeStorage 加密)。
 */

import { LogManager } from '../core/LogManager'
import { getHost } from '../platform/runtime'
import * as fs from 'node:fs'
import * as path from 'node:path'
import {safeStorage} from 'electron'
import type { ChannelKind } from './ChannelTypes'

export interface IMConfig {
  channelKind: ChannelKind
  /** 各平台通用字段（通道实际读取的字段） */
  appId?: string
  appSecret?: string
  botToken?: string
  webhookUrl?: string
  /** 通用字段 */
  apiBaseUrl?: string
  accessToken?: string
  accessTokenExpiresAt?: number
  /**
   * 平台特有字段（IM 真连通批次补）。
   * ImManagement 的表单一直用 appKey / corpId / agentId / wxId 等原名保存，
   * 但通道只读 appId / appSecret —— 配置存了却永远不生效。
   * 这里把原名纳入 schema，通道侧按「特有字段 ?? 通用字段」读取，双向兼容：
   * 老配置(appId/appSecret) 与新 UI 配置都能跑。
   */
  appKey?: string
  corpId?: string
  corpSecret?: string
  agentId?: string
  wxId?: string
  signingSecret?: string
  phoneNumberId?: string
  /**
   * 【M4.9 免公网入站字段】
   *   · appToken   —— Slack Socket Mode 的 app-level token（xapp- 开头）。
   *                   与 botToken(xoxb-) 是两个不同的东西，缺了连不上。
   *   · userId     —— Rocket.Chat 的个人用户 id（`X-User-Id` header 用）。
   *   · channelIds —— Rocket.Chat 要监听的房间/私聊 id 列表
   *                   （Rocket.Chat 没有"我所有会话"的聚合接口，必须显式给）。
   */
  appToken?: string
  userId?: string
  channelIds?: string[]
  /** 元信息 */
  enabled: boolean
  updatedAt: number
}

/**
 * IMConfigStore: 各 IM 通道鉴权信息存储
 * 持久化到 userData/im-config.json.enc(safeStorage 加密)
 * 提供 get(key) / set(key, config) / list() / remove(key)
 */
export class IMConfigStore {
  private static instance: IMConfigStore
  private log = LogManager.getInstance()
  private storePath: string
  private configs: Map<string, IMConfig> = new Map()

  private constructor() {
    this.storePath = path.join(getHost().getPath('userData'), 'im-config.json.enc')
    this.loadFromDisk()
  }

  public static getInstance(): IMConfigStore {
    if (!IMConfigStore.instance) IMConfigStore.instance = new IMConfigStore()
    return IMConfigStore.instance
  }

  get(channelKind: ChannelKind): IMConfig | undefined {
    return this.configs.get(channelKind)
  }

  set(channelKind: ChannelKind, patch: Partial<IMConfig>): void {
    const existing = this.configs.get(channelKind) ?? {
      channelKind,
      enabled: false,
      updatedAt: Date.now(),
    }
    const next: IMConfig = { ...existing, ...patch, channelKind, updatedAt: Date.now() }
    this.configs.set(channelKind, next)
    this.persistToDisk()
    this.log.info(`IMConfigStore: ${channelKind} config updated`)
  }

  list(): IMConfig[] {
    return [...this.configs.values()]
  }

  remove(channelKind: ChannelKind): boolean {
    const ok = this.configs.delete(channelKind)
    if (ok) this.persistToDisk()
    return ok
  }

  private loadFromDisk(): void {
    try {
      if (!safeStorage.isEncryptionAvailable()) {
        this.log.warn('IMConfigStore: safeStorage encryption not available, falling back to plain read')
      }
      if (fs.existsSync(this.storePath)) {
        const buf = fs.readFileSync(this.storePath)
        const plain = safeStorage.isEncryptionAvailable()
          ? safeStorage.decryptString(buf)
          : buf.toString('utf-8')
        const arr = JSON.parse(plain) as IMConfig[]
        for (const c of arr) this.configs.set(c.channelKind, c)
      } else {
        this.migrateFromLegacyPlaintext()
      }
    } catch (e) {
      this.log.warn('IMConfigStore: load failed', e)
    }
  }

  private migrateFromLegacyPlaintext(): void {
    const legacyPath = path.join(getHost().getPath('userData'), 'im-config.json')
    if (!fs.existsSync(legacyPath)) return
    try {
      const data = fs.readFileSync(legacyPath, 'utf-8')
      const arr = JSON.parse(data) as IMConfig[]
      for (const c of arr) this.configs.set(c.channelKind, c)
      this.log.info(`IMConfigStore: migrated ${arr.length} entries from legacy plaintext file`)
      this.persistToDisk()
      fs.unlinkSync(legacyPath)
    } catch (e) {
      this.log.warn('IMConfigStore: legacy migration failed', e)
    }
  }

  private persistToDisk(): void {
    try {
      fs.mkdirSync(path.dirname(this.storePath), { recursive: true })
      const arr = [...this.configs.values()]
      const plain = JSON.stringify(arr, null, 2)
      const buf = safeStorage.isEncryptionAvailable()
        ? safeStorage.encryptString(plain)
        : Buffer.from(plain, 'utf-8')
      fs.writeFileSync(this.storePath, buf)
    } catch (e) {
      this.log.warn('IMConfigStore: persist failed', e)
    }
  }
}