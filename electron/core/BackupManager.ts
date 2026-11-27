/**
 * New World - 本地备份 / 恢复（无服务器方案的落点）
 *
 * 【为什么存在】
 * 用户没有服务器，账号云同步不成立。换机 / 重装 / 配置改坏时仍需要一条退路：
 * 把「配置 + 权限 + 聊天设置 + 模型配置 + 技能」打成一个本地 zip，随时恢复。
 *
 * 【红线】
 * 1. 不含会话历史 —— 备份的是配置与技能，不是聊天记录；恢复不会覆盖对话。
 * 2. API Key 默认脱敏（__NW_REDACTED__），导入时不覆盖本机现有密钥。
 * 3. 恢复前先做一份保护性备份；只写当前状态，不删任何历史备份（沙箱 safe-delete）。
 * 4. 技能是合并而非替换：备份里没有的技能不会被删掉。
 * 5. zip 条目路径逐个校验，拒绝 .. / 绝对路径，防 zip-slip。
 * 6. manifest 格式/版本不符就整体拒绝，不写半个字。
 */
import * as fs from 'node:fs'
import * as path from 'node:path'
import JSZip from 'jszip'
import { getHost } from '../platform/runtime'
import { LogManager } from './LogManager'
import { ConfigStore } from './ConfigStore'
import { PermissionConfig } from '../permissions/PermissionConfig'
import { ChatConfig } from '../chat/ChatConfig'
import { LlmConfigStore, BACKUP_REDACTED_KEY } from '../llm/LlmConfigStore'
import { SkillManager } from '../skill/SkillManager'
import { SkillLoader } from '../skill/SkillLoader'

const FORMAT = 'nw-local-backup'
const VERSION = 1
const SKILLS_PREFIX = 'skills/'
const INCLUDES = ['config', 'permissions', 'chatSettings', 'llmConfig', 'skills'] as const

export interface BackupManifest {
  format: typeof FORMAT
  version: number
  createdAt: number
  appVersion: string
  includes: string[]
  apiKeysIncluded: boolean
  skillCount: number
}

export interface BackupCreateOptions {
  /** 默认 false：API Key 写成占位符，不在备份文件里留明文 */
  includeApiKeys?: boolean
}

export interface BackupInfo {
  fileName: string
  filePath: string
  createdAt: number
  size: number
  appVersion: string
  apiKeysIncluded: boolean
}

export interface BackupCreated {
  filePath: string
  size: number
  manifest: BackupManifest
}

export interface BackupRestoreResult {
  manifest: BackupManifest
  /** 恢复前自动生成的保护性备份 —— 出问题可以从这里退回去 */
  safetyBackupPath: string
  restored: string[]
  redactedKeys: number
  skillCount: number
}

interface SkillFile {
  zipPath: string
  absPath: string
}

export class BackupManager {
  private static instance: BackupManager
  private log = LogManager.getInstance()

  public static getInstance(): BackupManager {
    if (!BackupManager.instance) BackupManager.instance = new BackupManager()
    return BackupManager.instance
  }

  /** 备份固定落在 userData/backups；不删历史，用户自己清理 */
  private backupDir(): string {
    return path.join(getHost().getPath('userData'), 'backups')
  }

  private timestamp(fileNameSeed: number): string {
    const d = new Date(fileNameSeed)
    const p = (n: number) => String(n).padStart(2, '0')
    return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`
  }

  /** 递归收集技能目录，zip 路径一律用正斜杠 */
  private collectSkillFiles(root: string, rel = ''): SkillFile[] {
    const out: SkillFile[] = []
    const dir = rel ? path.join(root, rel) : root
    let entries: fs.Dirent[]
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true })
    } catch {
      return out
    }
    for (const e of entries) {
      const childRel = rel ? `${rel}/${e.name}` : e.name
      const abs = path.join(root, childRel)
      if (e.isDirectory()) out.push(...this.collectSkillFiles(root, childRel))
      else if (e.isFile()) out.push({ zipPath: `${SKILLS_PREFIX}${childRel}`, absPath: abs })
    }
    return out
  }

  /** zip-slip 防线：条目名必须是干净的相对路径 */
  private isSafeEntry(name: string): boolean {
    if (!name || name.startsWith('/') || /^[a-zA-Z]:/.test(name) || path.isAbsolute(name)) return false
    return name.split(/[\\/]/).every(seg => seg !== '' && seg !== '.' && seg !== '..')
  }

  private manifestOf(manifest: BackupManifest, skillCount: number): BackupManifest {
    return { ...manifest, skillCount }
  }

  private async buildZip(options: BackupCreateOptions): Promise<{ buffer: Buffer; manifest: BackupManifest }> {
    const includeApiKeys = options.includeApiKeys === true
    const skillFiles = this.collectSkillFiles(SkillManager.getSkillsDir())
    const skillIds = new Set(skillFiles.map(f => f.zipPath.split('/')[1]).filter(Boolean))

    const manifest: BackupManifest = this.manifestOf({
      format: FORMAT,
      version: VERSION,
      createdAt: Date.now(),
      appVersion: getHost().getVersion(),
      includes: [...INCLUDES],
      apiKeysIncluded: includeApiKeys,
      skillCount: skillIds.size,
    }, skillIds.size)

    const llmConfigs = LlmConfigStore.getInstance().list().map(c => ({
      ...c,
      apiKey: includeApiKeys ? c.apiKey : (c.apiKey ? BACKUP_REDACTED_KEY : ''),
    }))

    const zip = new JSZip()
    zip.file('manifest.json', JSON.stringify(manifest, null, 2))
    zip.file('config.json', JSON.stringify(ConfigStore.getInstance().getAll(), null, 2))
    zip.file('permissions.json', JSON.stringify(PermissionConfig.getInstance().exportSnapshot(), null, 2))
    zip.file('chat-settings.json', JSON.stringify(ChatConfig.getInstance().exportSnapshot(), null, 2))
    zip.file('llm-config.json', JSON.stringify(llmConfigs, null, 2))
    for (const f of skillFiles) zip.file(f.zipPath, fs.readFileSync(f.absPath))

    const buffer = await zip.generateAsync({
      type: 'nodebuffer',
      compression: 'DEFLATE',
      compressionOptions: { level: 6 },
    })
    return { buffer, manifest }
  }

  /** 创建本地备份（默认不含明文 API Key） */
  async create(options: BackupCreateOptions = {}): Promise<BackupCreated> {
    const { buffer, manifest } = await this.buildZip(options)
    const dir = this.backupDir()
    fs.mkdirSync(dir, { recursive: true })
    // 同一秒内连按两次「创建备份」不能互相覆盖 —— 历史备份一律保留
    const stamp = this.timestamp(manifest.createdAt)
    let filePath = path.join(dir, `nw-backup-${stamp}.zip`)
    let seq = 2
    while (fs.existsSync(filePath)) {
      filePath = path.join(dir, `nw-backup-${stamp}-${seq}.zip`)
      seq++
    }
    fs.writeFileSync(filePath, buffer)
    this.log.info(`[BackupManager] 备份已创建 ${filePath} (${buffer.length} bytes, skills=${manifest.skillCount})`)
    return { filePath, size: buffer.length, manifest }
  }

  /** 导出到用户指定路径（弹窗由 IPC 层负责） */
  async exportToFile(targetPath: string, options: BackupCreateOptions = {}): Promise<BackupCreated> {
    if (typeof targetPath !== 'string' || !targetPath.trim()) throw new Error('导出路径不能为空')
    const created = await this.create(options)
    fs.mkdirSync(path.dirname(targetPath), { recursive: true })
    fs.copyFileSync(created.filePath, targetPath)
    return { ...created, filePath: targetPath, size: fs.statSync(targetPath).size }
  }

  /** 只导出技能（给技能页用） */
  async exportSkills(targetPath: string): Promise<{ filePath: string; size: number; skillCount: number }> {
    if (typeof targetPath !== 'string' || !targetPath.trim()) throw new Error('导出路径不能为空')
    const skillFiles = this.collectSkillFiles(SkillManager.getSkillsDir())
    const skillIds = new Set(skillFiles.map(f => f.zipPath.split('/')[1]).filter(Boolean))
    const zip = new JSZip()
    zip.file('manifest.json', JSON.stringify({
      format: FORMAT,
      version: VERSION,
      createdAt: Date.now(),
      appVersion: getHost().getVersion(),
      includes: ['skills'],
      apiKeysIncluded: false,
      skillCount: skillIds.size,
    } satisfies BackupManifest, null, 2))
    for (const f of skillFiles) zip.file(f.zipPath, fs.readFileSync(f.absPath))
    const buffer = await zip.generateAsync({ type: 'nodebuffer', compression: 'DEFLATE' })
    fs.mkdirSync(path.dirname(targetPath), { recursive: true })
    fs.writeFileSync(targetPath, buffer)
    return { filePath: targetPath, size: buffer.length, skillCount: skillIds.size }
  }

  /** 列出本地备份；损坏文件跳过但不删除，也不谎报 */
  async list(): Promise<BackupInfo[]> {
    const dir = this.backupDir()
    if (!fs.existsSync(dir)) return []
    const out: BackupInfo[] = []
    for (const fileName of fs.readdirSync(dir).filter(f => /^nw-backup-.*\.zip$/i.test(f))) {
      const filePath = path.join(dir, fileName)
      try {
        const zip = await JSZip.loadAsync(fs.readFileSync(filePath))
        const mf = zip.file('manifest.json')
        if (!mf) continue
        const manifest = JSON.parse(await mf.async('string')) as BackupManifest
        if (manifest.format !== FORMAT || manifest.version !== VERSION) continue
        out.push({
          fileName,
          filePath,
          createdAt: manifest.createdAt,
          size: fs.statSync(filePath).size,
          appVersion: manifest.appVersion,
          apiKeysIncluded: manifest.apiKeysIncluded === true,
        })
      } catch {
        // 坏包不进列表；不删 —— 沙箱 safe-delete 限制，也避免用户数据丢失
      }
    }
    return out.sort((a, b) => b.createdAt - a.createdAt)
  }

  /** 从备份恢复。任何校验失败都在写入之前抛出，绝不写半个状态。 */
  async restore(filePath: string): Promise<BackupRestoreResult> {
    if (typeof filePath !== 'string' || !filePath.trim()) throw new Error('备份路径不能为空')
    const buf = fs.readFileSync(filePath)
    const zip = await JSZip.loadAsync(buf)

    // ① 全量路径校验（zip-slip）必须先于任何写入。
    //    JSZip 会为 "skills/demo/x" 隐式生成目录条目 "skills/"，先去掉尾斜杠再判。
    for (const name of Object.keys(zip.files)) {
      const normalized = zip.files[name].dir ? name.replace(/\/+$/, '') : name
      if (!this.isSafeEntry(normalized)) throw new Error(`备份包含不安全路径，已拒绝：${name}`)
    }

    // ② manifest 校验
    const mf = zip.file('manifest.json')
    if (!mf) throw new Error('备份缺少 manifest.json，无法确认格式')
    let manifest: BackupManifest
    try {
      manifest = JSON.parse(await mf.async('string')) as BackupManifest
    } catch {
      throw new Error('备份 manifest.json 不是合法 JSON')
    }
    if (manifest?.format !== FORMAT || manifest?.version !== VERSION) {
      throw new Error(`备份格式不兼容（format=${String(manifest?.format)}, version=${String(manifest?.version)}）`)
    }

    const readJson = async (name: string): Promise<unknown> => {
      const f = zip.file(name)
      if (!f) return undefined
      return JSON.parse(await f.async('string'))
    }

    // ③ 先把待恢复内容全部解析出来，解析失败同样不写入
    const configData = await readJson('config.json')
    const permissionsData = await readJson('permissions.json')
    const chatData = await readJson('chat-settings.json')
    const llmData = await readJson('llm-config.json')
    const skillEntries = Object.keys(zip.files).filter(n => n.startsWith(SKILLS_PREFIX) && !zip.files[n].dir)

    // ④ 保护性备份（不是可选项 —— 恢复覆盖前必须有退路）
    const safety = await this.create({ includeApiKeys: false })

    // ⑤ 逐项写回。每项都校验自己的结构，store 层会抛错则由上层捕获。
    const restored: string[] = []
    if (configData !== undefined) {
      if (!configData || typeof configData !== 'object' || Array.isArray(configData)) {
        throw new Error('备份 config.json 格式错误')
      }
      ConfigStore.getInstance().importAll(configData as Record<string, unknown>)
      restored.push('config')
    }
    if (permissionsData !== undefined) {
      PermissionConfig.getInstance().importSnapshot(permissionsData)
      restored.push('permissions')
    }
    if (chatData !== undefined) {
      ChatConfig.getInstance().importSnapshot(chatData)
      restored.push('chatSettings')
    }
    let redactedKeys = 0
    if (llmData !== undefined) {
      const r = LlmConfigStore.getInstance().importAll(llmData, true)
      redactedKeys = r.redacted
      restored.push('llmConfig')
    }

    // ⑥ 技能合并写入：备份里没有的技能不动
    const skillsDir = SkillManager.getSkillsDir()
    for (const name of skillEntries) {
      const rel = name.slice(SKILLS_PREFIX.length)
      if (!this.isSafeEntry(rel)) throw new Error(`备份技能路径不安全，已拒绝：${name}`)
      const target = path.join(skillsDir, rel)
      fs.mkdirSync(path.dirname(target), { recursive: true })
      fs.writeFileSync(target, await zip.files[name].async('nodebuffer'))
    }
    if (skillEntries.length > 0) {
      SkillLoader.getInstance().reloadSkills()
      restored.push('skills')
    }

    this.log.info(`[BackupManager] 恢复完成：${restored.join(', ')}；保护性备份 ${safety.filePath}`)
    return {
      manifest,
      safetyBackupPath: safety.filePath,
      restored,
      redactedKeys,
      skillCount: new Set(skillEntries.map(n => n.split('/')[1]).filter(Boolean)).size,
    }
  }
}
