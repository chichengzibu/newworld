/**
 * PiPiClaw - ClawHub 远程仓库 (registry) 拉取 + 验签 + 安装
 *
 * 这是把"作者推送技能 / 用户检查更新一键装"做实的最后一公里:
 *  - 之前 ClawHubManager 是纯本地模拟云端, fetchRegistry 为零, 用户装不进任何第三方技能。
 *  - 现在 ClawHubRegistry 真去拉一个 registry（GitHub Release / raw / 任意 CDN 目录都行）,
 *    拿到 index.json（技能清单）, 下载签名后的 .zip, 用 Ed25519 公钥验签, 再调 importSkillFromZip。
 *
 * 信任链:
 *  - 作者用 Ed25519 私钥 (scripts/clawhub-dev-ed25519.key, 生产请换自己的私钥) 对 zip 字节签名。
 *  - App 端用内置/配置的 Ed25519 公钥验签。公钥优先级:
 *      1. 环境变量 PIPICLAW_CLAWHUB_PUBKEY
 *      2. userData/clawhub-pubkey.txt
 *      3. 代码内置 DEFAULT_PUBLIC_KEY (开发用, 与 scripts/clawhub-dev-ed25519.key 配对)
 *  - 若三处都没有公钥 -> 跳过验签并 warn（仅限内部/可信源场景, 不建议对外分发时这样）。
 *
 * registry 基址优先级:
 *      1. 环境变量 PIPICLAW_CLAWHUB_REGISTRY
 *      2. userData/clawhub-registry.txt
 *      3. DEFAULT_REGISTRY 占位（请改成你的真实地址）
 *
 * index.json 规范见 scripts/build-registry.mjs 产物格式。
 */

import { LogManager } from '../core/LogManager'
import { getHost } from '../platform/runtime'
import { SkillLoader } from './SkillLoader'

import * as fs from 'node:fs'
import * as path from 'node:path'
import * as https from 'node:https'
import * as http from 'node:http'
import { URL } from 'node:url'
import { createHash, createPublicKey, verify as cryptoVerify } from 'node:crypto'

/** 开发用内置公钥 (SPKI DER, hex) — 与 scripts/clawhub-dev-ed25519.key 配对。生产请替换并移除私钥文件。 */
const DEFAULT_PUBLIC_KEY =
  '302a300506032b65700321001204d8cad802577773f194d0a1e6577496a81d1116e1f027136729a34a7b0c2c'

/** registry 默认基址 (结尾不要带 /)。请改成你的真实地址, 或靠环境变量覆盖。 */
const DEFAULT_REGISTRY = 'https://example.com/pipiclaw-clawhub'

export interface ClawHubRegistryEntry {
  id: string
  name: string
  description: string
  version: string
  author: string
  category: string
  tags: string[]
  /** 指向 .zip 的绝对 http(s) 地址 */
  zipUrl: string
  /** 对 zip 原始字节做 Ed25519 签名后的 hex 串 */
  signature: string
  changelog?: string
}

export interface ClawHubRegistryIndex {
  registry: string
  version: number
  updatedAt: number
  skills: ClawHubRegistryEntry[]
}

export interface ClawHubRegistryItem extends ClawHubRegistryEntry {
  /** 本地已装版本, 未装为 null */
  installedVersion: string | null
  /** 是否已装且可更新 */
  hasUpdate: boolean
}

export class ClawHubRegistry {
  private static instance: ClawHubRegistry
  private log = LogManager.getInstance()

  private constructor() {}

  public static getInstance(): ClawHubRegistry {
    if (!ClawHubRegistry.instance) ClawHubRegistry.instance = new ClawHubRegistry()
    return ClawHubRegistry.instance
  }

  /** 解析 registry 基址 */
  private resolveBaseUrl(): string {
    const env = process.env.PIPICLAW_CLAWHUB_REGISTRY
    if (env && env.trim()) return env.trim().replace(/\/+$/, '')
    try {
      const file = path.join(getHost().getPath('userData'), 'clawhub-registry.txt')
      if (fs.existsSync(file)) {
        const v = fs.readFileSync(file, 'utf-8').trim()
        if (v) return v.replace(/\/+$/, '')
      }
    } catch {
      /* ignore */
    }
    return DEFAULT_REGISTRY
  }

  /** 解析验签公钥 (hex) */
  private resolvePublicKey(): string | null {
    const env = process.env.PIPICLAW_CLAWHUB_PUBKEY
    if (env && env.trim()) return env.trim()
    try {
      const file = path.join(getHost().getPath('userData'), 'clawhub-pubkey.txt')
      if (fs.existsSync(file)) {
        const v = fs.readFileSync(file, 'utf-8').trim()
        if (v) return v
      }
    } catch {
      /* ignore */
    }
    return DEFAULT_PUBLIC_KEY
  }

  /** 拉取 index.json; 网络不可达时返回 null (调用方回退本地) */
  public async fetchIndex(baseUrl?: string): Promise<ClawHubRegistryIndex | null> {
    const base = baseUrl ?? this.resolveBaseUrl()
    const url = `${base}/index.json`
    try {
      this.log.info(`[ClawHubRegistry] 拉取 registry: ${url}`)
      const raw = (await this.httpGet(url, false)) as string
      const idx = JSON.parse(raw) as ClawHubRegistryIndex
      if (!idx.skills || !Array.isArray(idx.skills)) {
        this.log.warn('[ClawHubRegistry] index.json 格式异常, 缺 skills 数组')
        return null
      }
      return idx
    } catch (e) {
      this.log.warn(`[ClawHubRegistry] 拉取 registry 失败 (离线或地址不可达): ${url}`, e)
      return null
    }
  }

  /** 列出远程技能 + 本地安装状态 (离线时返回空数组) */
  public async list(baseUrl?: string): Promise<ClawHubRegistryItem[]> {
    const idx = await this.fetchIndex(baseUrl)
    if (!idx) return []
    const installed = this.installedByName()
    return idx.skills.map((s) => {
      const iv = installed.get(s.name.toLowerCase()) ?? null
      return {
        ...s,
        installedVersion: iv,
        hasUpdate: iv !== null && this.isNewer(s.version, iv),
      }
    })
  }

  /** 安装/更新某个 registry 技能: 下载 zip -> 验签 -> importSkillFromZip */
  public async install(
    entryId: string,
    baseUrl?: string,
  ): Promise<{ success: boolean; error?: string; skillId?: string }> {
    const idx = await this.fetchIndex(baseUrl)
    if (!idx) return { success: false, error: '无法连接 registry（离线或地址错误）' }
    const entry = idx.skills.find((s) => s.id === entryId)
    if (!entry) return { success: false, error: `registry 中找不到技能 ${entryId}` }

    try {
      this.log.info(`[ClawHubRegistry] 下载技能包: ${entry.zipUrl}`)
      const zipBuf = (await this.httpGet(entry.zipUrl, true)) as Buffer

      // 验签
      const pub = this.resolvePublicKey()
      if (pub) {
        const ok = verifyEd25519(zipBuf, entry.signature, pub)
        if (!ok) {
          this.log.warn(`[ClawHubRegistry] 验签失败, 拒绝安装: ${entry.name}`)
          return { success: false, error: '技能包签名校验失败,已拒绝安装（可能被篡改）' }
        }
        this.log.info(`[ClawHubRegistry] 验签通过: ${entry.name}@${entry.version}`)
      } else {
        this.log.warn('[ClawHubRegistry] 未配置公钥,跳过验签(不安全,仅内部可信源可用)')
      }

      // 落临时文件后走统一导入 (复用双格式解析 + 资源拷贝)
      const tmp = path.join(
        getHost().getPath('userData'),
        'clawhub-tmp',
        `${entry.id}-${Date.now()}.zip`,
      )
      fs.mkdirSync(path.dirname(tmp), { recursive: true })
      fs.writeFileSync(tmp, zipBuf)

      const skillLoader = SkillLoader.getInstance()
      const result = await skillLoader.importSkillFromZip(tmp)
      fs.rmSync(tmp, { force: true })
      if (!result.success) return result
      return { success: true, skillId: result.skillId }
    } catch (e: any) {
      this.log.error('[ClawHubRegistry] 安装失败', e)
      return { success: false, error: e.message || '安装失败' }
    }
  }

  // ============ 内部工具 ============

  /** 本地已装技能: name(小写) -> version。version 取自 SkillVersioning 历史; 取不到时用 null。 */
  private installedByName(): Map<string, string | null> {
    const map = new Map<string, string | null>()
    try {
      const all = SkillLoader.getInstance().getAllSkills()
      for (const s of all) {
        const name = (s.name || '').toLowerCase()
        if (name) map.set(name, (s as any).version ?? null)
      }
    } catch {
      /* ignore */
    }
    return map
  }

  private isNewer(a: string, b: string): boolean {
    const pa = a.split('.').map((x) => parseInt(x, 10) || 0)
    const pb = b.split('.').map((x) => parseInt(x, 10) || 0)
    for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
      const x = pa[i] || 0
      const y = pb[i] || 0
      if (x > y) return true
      if (x < y) return false
    }
    return false
  }

  /** http(s) GET, 支持重定向跟随。asBuffer=true 返回 Buffer, 否则 utf-8 文本。 */
  private httpGet(target: string, asBuffer: boolean, redirects = 5): Promise<Buffer | string> {
    return new Promise((resolve, reject) => {
      const request = (urlStr: string, depth: number) => {
        if (depth <= 0) return reject(new Error('重定向次数过多'))
        let u: URL
        try {
          u = new URL(urlStr)
        } catch (e) {
          return reject(e)
        }
        const lib = u.protocol === 'https:' ? https : http
        const req = lib.request(
          urlStr,
          { method: 'GET', headers: { 'User-Agent': 'PiPiClaw-ClawHub/1.0' } },
          (res) => {
            const code = res.statusCode ?? 0
            if (code >= 300 && code < 400 && res.headers.location) {
              res.resume()
              return request(new URL(res.headers.location, u).toString(), depth - 1)
            }
            if (code >= 400) {
              res.resume()
              return reject(new Error(`HTTP ${code} (${urlStr})`))
            }
            const chunks: Buffer[] = []
            res.on('data', (c) => chunks.push(c as Buffer))
            res.on('end', () => {
              const buf = Buffer.concat(chunks)
              resolve(asBuffer ? buf : buf.toString('utf-8'))
            })
          },
        )
        req.on('error', reject)
        req.setTimeout(15000, () => req.destroy(new Error('请求超时')))
        req.end()
      }
      request(target, redirects)
    })
  }
}

/**
 * Ed25519 验签: 对 zip 原始字节签名, 公钥 hex(SPKI DER)。
 * 返回 true 表示签名有效。
 */
export function verifyEd25519(content: Buffer, signatureHex: string, publicKeyHex: string): boolean {
  try {
    const pub = createPublicKey({ key: Buffer.from(publicKeyHex, 'hex'), format: 'der', type: 'spki' })
    const sig = Buffer.from(signatureHex, 'hex')
    return cryptoVerify(null, content, pub, sig)
  } catch (e) {
    LogManager.getInstance().warn('[ClawHubRegistry] 验签异常', e)
    return false
  }
}
