/**
 * New World - FileTransferManager (P0-06 / Stage 1 明确占位)
 *
 * 文件存在性 / 平台体积上限 / 配置读取 + 结构化结果 + 进度回放。
 *
 * ⚠️ 诚实边界（IM 真连通批次点名）：
 *   本类 **不做真实网络上传**，校验通过后即返回 ok:true + mock messageId/fileId，
 *   返回的 `stub: true` 就是给调用方的显式标记，任何 UI / agent 都不能把它
 *   当作「文件已送达 IM 平台」的证据。真实 multipart 上传属 Stage 2：
 *    - 飞书:https://open.feishu.cn/document/server-docs/im-v1/message-attachment
 *    - Telegram:https://core.telegram.org/bots/api#senddocument
 *    - Discord:https://discord.com/developers/docs/reference#multipart-file-upload
 *
 * 说明：本次「IM 真连通」范围是消息文本链路（入站接收 → agent → 出站发送），
 * 文件上传不在此批次，故保留占位但改为显式可识别，不再伪装成真实交付。
 */

import { LogManager } from '../core/LogManager'
import { IMConfigStore } from './IMConfigStore'
import * as fs from 'node:fs'
import * as path from 'node:path'
import { randomUUID } from 'node:crypto'

export type SupportedUploadPlatform = 'im-feishu' | 'im-dingtalk' | 'im-wechat-work' | 'im-telegram' | 'im-slack' | 'im-discord'

export interface UploadArgs {
  platform: SupportedUploadPlatform
  /** 本地文件绝对路径 */
  filePath: string
  /** 目标 channel / chat ID */
  channelId: string
  /** 目标 user / chat ID(对单聊) */
  targetUserId: string
  /** 可选:API base URL(测试用 mock) */
  apiBaseUrl?: string
  /** 可选:access token(覆盖 IMConfigStore 中的) */
  accessToken?: string
  /** 进度回调 */
  onProgress?: (percent: number) => void
}

export interface UploadResult {
  ok: boolean
  platform: SupportedUploadPlatform
  messageId?: string
  fileId?: string
  durationMs: number
  fileSize: number
  error?: string
  /** true = 未真正上传网络，仅供本地校验/进度演练 */
  stub: boolean
}

const PLATFORM_LIMITS: Record<SupportedUploadPlatform, number> = {
  'im-feishu': 30 * 1024 * 1024,        // 30MB
  'im-dingtalk': 20 * 1024 * 1024,       // 20MB
  'im-wechat-work': 20 * 1024 * 1024,    // 20MB
  'im-telegram': 50 * 1024 * 1024,       // 50MB
  'im-slack': 1024 * 1024 * 1024,        // 1GB
  'im-discord': 25 * 1024 * 1024,        // 25MB (Nitro boost 50MB)
}

const stubResult = (r: Omit<UploadResult, 'stub'>): UploadResult => ({ ...r, stub: true })

export class FileTransferManager {
  private static instance: FileTransferManager
  private log = LogManager.getInstance()

  private constructor() {}

  public static getInstance(): FileTransferManager {
    if (!FileTransferManager.instance) FileTransferManager.instance = new FileTransferManager()
    return FileTransferManager.instance
  }

  /** 获取某平台的文件大小上限 */
  getMaxFileSize(platform: SupportedUploadPlatform): number {
    return PLATFORM_LIMITS[platform] ?? 0
  }

  /**
   * Stage 1 主入口：校验 → 返回结构化结果（**不发起网络请求**）。
   * Stage 2 需接真 fetch + multipart/form-data + 平台特定字段。
   */
  async uploadToIM(args: UploadArgs): Promise<UploadResult> {
    const start = Date.now()
    const id = randomUUID().slice(0, 8)

    if (!(args.platform in PLATFORM_LIMITS)) {
      return stubResult({
        ok: false,
        platform: args.platform,
        durationMs: Date.now() - start,
        fileSize: 0,
        error: `unsupported platform: ${args.platform}`,
      })
    }

    if (!fs.existsSync(args.filePath)) {
      return stubResult({
        ok: false,
        platform: args.platform,
        durationMs: Date.now() - start,
        fileSize: 0,
        error: `file not found: ${args.filePath}`,
      })
    }

    const stat = fs.statSync(args.filePath)
    if (!stat.isFile()) {
      return stubResult({
        ok: false,
        platform: args.platform,
        durationMs: Date.now() - start,
        fileSize: 0,
        error: `not a file: ${args.filePath}`,
      })
    }
    const maxSize = PLATFORM_LIMITS[args.platform]
    if (stat.size > maxSize) {
      return stubResult({
        ok: false,
        platform: args.platform,
        durationMs: Date.now() - start,
        fileSize: stat.size,
        error: `file too large: ${stat.size} bytes > ${maxSize} limit for ${args.platform}`,
      })
    }

    let accessToken = args.accessToken
    if (!accessToken) {
      const config = IMConfigStore.getInstance().get(args.platform)
      if (!config?.accessToken && !config?.botToken && !config?.appSecret) {
        return stubResult({
          ok: false,
          platform: args.platform,
          durationMs: Date.now() - start,
          fileSize: stat.size,
          error: `no access token configured for ${args.platform}`,
        })
      }
      accessToken = config!.accessToken ?? config!.botToken ?? config!.appSecret
    }

    if (args.onProgress) {
      for (let p = 0; p <= 100; p += 25) args.onProgress(p)
    }

    this.log.info(
      `FileTransferManager: [${id}] ${path.basename(args.filePath)} (${stat.size}B) → ${args.platform} [STUB, 未上传]`,
    )
    return stubResult({
      ok: true,
      platform: args.platform,
      messageId: `mock-msg-${id}`,
      fileId: `mock-file-${id}`,
      durationMs: Date.now() - start,
      fileSize: stat.size,
    })
  }

  /** 列出所有支持上传的平台 */
  listSupportedPlatforms(): SupportedUploadPlatform[] {
    return Object.keys(PLATFORM_LIMITS) as SupportedUploadPlatform[]
  }
}
