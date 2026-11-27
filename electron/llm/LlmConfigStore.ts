import { LogManager } from '../core/LogManager'
import { getHost } from '../platform/runtime'
import * as fs from 'node:fs'
import * as path from 'node:path'
import {safeStorage} from 'electron'
import type { LlmConfig, LlmProvider } from './types'

/** 备份里的 API Key 占位符：导出时默认写这个，导入时保留本机现有密钥不覆盖 */
export const BACKUP_REDACTED_KEY = '__NW_REDACTED__'

export class LlmConfigStore {
  private static instance: LlmConfigStore
  private log = LogManager.getInstance()
  private storePath: string
  private configs: Map<string, LlmConfig> = new Map()

  private constructor() {
    this.storePath = path.join(getHost().getPath('userData'), 'llm-config.json.enc')
    this.loadFromDisk()
  }

  public static getInstance(): LlmConfigStore {
    if (!LlmConfigStore.instance) LlmConfigStore.instance = new LlmConfigStore()
    return LlmConfigStore.instance
  }

  get(provider: LlmProvider): LlmConfig | undefined {
    return this.configs.get(provider)
  }

  set(provider: LlmProvider, patch: Partial<LlmConfig>): void {
    const existing = this.configs.get(provider) ?? { provider, apiKey: '', enabled: false, updatedAt: Date.now() }
    const next: LlmConfig = { ...existing, ...patch, provider, updatedAt: Date.now() }
    this.configs.set(provider, next)
    this.persistToDisk()
    this.log.info(`LlmConfigStore: ${provider} updated (enabled=${next.enabled})`)
  }

  list(): LlmConfig[] {
    return [...this.configs.values()]
  }

  /**
   * 【本地备份】从备份恢复模型配置。
   * 占位符 apiKey 一律不覆盖本机现有值 —— 用户没勾选"包含密钥"时，换机恢复后
   * 仍需自己填 Key，但在同一台机器恢复不会把已填的 Key 清空。
   */
  importAll(configs: unknown, preserveRedacted = true): { total: number; redacted: number } {
    if (!Array.isArray(configs)) throw new Error('备份模型配置格式错误：llm-config 必须是数组')
    let redacted = 0
    for (const raw of configs) {
      if (!raw || typeof raw !== 'object' || typeof (raw as LlmConfig).provider !== 'string') continue
      const c = raw as LlmConfig
      let apiKey = c.apiKey
      if (preserveRedacted && apiKey === BACKUP_REDACTED_KEY) {
        apiKey = this.configs.get(c.provider)?.apiKey ?? ''
        redacted++
      }
      this.configs.set(c.provider, { ...c, apiKey, updatedAt: Date.now() })
    }
    this.persistToDisk()
    return { total: configs.length, redacted }
  }

  /** 获取当前启用的 provider config(按 enabled 顺序,优先第一个) */
  getActive(): LlmConfig | undefined {
    return [...this.configs.values()].find(c => c.enabled && c.apiKey)
  }

  remove(provider: LlmProvider): boolean {
    const ok = this.configs.delete(provider)
    if (ok) this.persistToDisk()
    return ok
  }

  private loadFromDisk(): void {
    try {
      if (!safeStorage.isEncryptionAvailable()) {
        this.log.warn('LlmConfigStore: safeStorage encryption not available, falling back to plain read')
      }
      if (fs.existsSync(this.storePath)) {
        const buf = fs.readFileSync(this.storePath)
        const plain = safeStorage.isEncryptionAvailable()
          ? safeStorage.decryptString(buf)
          : buf.toString('utf-8')
        const arr = JSON.parse(plain) as LlmConfig[]
        for (const c of arr) this.configs.set(c.provider, c)
      } else {
        this.migrateFromLegacyPlaintext()
      }
    } catch (e) {
      this.log.warn('LlmConfigStore: load failed', e)
    }
  }

  private migrateFromLegacyPlaintext(): void {
    const legacyPath = path.join(getHost().getPath('userData'), 'llm-config.json')
    if (!fs.existsSync(legacyPath)) return
    try {
      const data = fs.readFileSync(legacyPath, 'utf-8')
      const arr = JSON.parse(data) as LlmConfig[]
      for (const c of arr) this.configs.set(c.provider, c)
      this.log.info(`LlmConfigStore: migrated ${arr.length} entries from legacy plaintext file`)
      this.persistToDisk()
      fs.unlinkSync(legacyPath)
    } catch (e) {
      this.log.warn('LlmConfigStore: legacy migration failed', e)
    }
  }

  private persistToDisk(): void {
    try {
      fs.mkdirSync(path.dirname(this.storePath), { recursive: true })
      const plain = JSON.stringify([...this.configs.values()], null, 2)
      const buf = safeStorage.isEncryptionAvailable()
        ? safeStorage.encryptString(plain)
        : Buffer.from(plain, 'utf-8')
      fs.writeFileSync(this.storePath, buf)
    } catch (e) {
      this.log.warn('LlmConfigStore: persist failed', e)
    }
  }
}