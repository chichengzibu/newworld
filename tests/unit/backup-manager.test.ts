/**
 * 本地备份 / 恢复回归 —— 无服务器方案的配置与技能闭环
 *
 * [ROUTE] 这里守的是「备份文件真的能恢复」而不是「点了个按钮」：
 *   - zip 必须是合法包，API Key 默认脱敏，会话历史不进包
 *   - restore 真写回配置与技能文件，且先生成保护性备份
 *   - 格式不符 / zip-slip 必须在任何写入之前拒绝
 */
// @vitest-environment node
import { describe, it, expect, beforeEach, vi } from 'vitest'
import * as fs from 'node:fs'
import * as path from 'node:path'
import JSZip from 'jszip'
import { TestHost, TEST_USER_DATA } from './test-host'

const SKILLS_DIR = path.join(TEST_USER_DATA, 'skills')
const BACKUPS_DIR = path.join(TEST_USER_DATA, 'backups')

function writeSkill(id: string, body: string): void {
  const dir = path.join(SKILLS_DIR, id)
  fs.mkdirSync(dir, { recursive: true })
  fs.writeFileSync(path.join(dir, 'SKILL.md'), body, 'utf-8')
}

/** 每个用例用全新模块实例，避免单例内存状态串味 */
async function fresh() {
  vi.resetModules()
  const runtime = await import('../../electron/platform/runtime')
  runtime.setHost(new TestHost())
  fs.rmSync(TEST_USER_DATA, { recursive: true, force: true })
  fs.mkdirSync(SKILLS_DIR, { recursive: true })

  const { BackupManager } = await import('../../electron/core/BackupManager')
  const { ConfigStore } = await import('../../electron/core/ConfigStore')
  const { LlmConfigStore, BACKUP_REDACTED_KEY } = await import('../../electron/llm/LlmConfigStore')
  return {
    manager: BackupManager.getInstance(),
    config: ConfigStore.getInstance(),
    llm: LlmConfigStore.getInstance(),
    REDACTED: BACKUP_REDACTED_KEY,
  }
}

describe('BackupManager 本地备份', () => {
  beforeEach(async () => {
    await fresh()
  })

  it('BK1 create → 合法 zip；API Key 脱敏；会话历史不进包；技能整目录入包', async () => {
    const ctx = await fresh()
    ctx.config.set('backup.marker', 'A')
    ctx.llm.set('ollama' as never, { apiKey: 'sk-super-secret', enabled: true } as never)
    writeSkill('demo', '# Demo\n\n步骤一')

    const created = await ctx.manager.create()
    expect(fs.existsSync(created.filePath)).toBe(true)
    expect(created.size).toBe(fs.statSync(created.filePath).size)
    expect(created.manifest.format).toBe('nw-local-backup')
    expect(created.manifest.version).toBe(1)
    expect(created.manifest.apiKeysIncluded).toBe(false)
    expect(created.manifest.skillCount).toBe(1)

    const zip = await JSZip.loadAsync(fs.readFileSync(created.filePath))
    expect(zip.file('manifest.json')).toBeTruthy()
    expect(zip.file('config.json')).toBeTruthy()
    expect(zip.file('permissions.json')).toBeTruthy()
    expect(zip.file('chat-settings.json')).toBeTruthy()
    expect(zip.file('llm-config.json')).toBeTruthy()
    expect(zip.file('skills/demo/SKILL.md')).toBeTruthy()
    // 只有设置，不带会话
    const chat = JSON.parse(await zip.file('chat-settings.json')!.async('string'))
    expect(chat.conversations).toBeUndefined()
    // 密钥绝不落明文
    const llmRaw = await zip.file('llm-config.json')!.async('string')
    expect(llmRaw).toContain(ctx.REDACTED)
    expect(llmRaw).not.toContain('sk-super-secret')
  })

  it('BK2 list → 只列出格式正确的备份，按时间倒序', async () => {
    const ctx = await fresh()
    await ctx.manager.create()
    const listed = await ctx.manager.list()
    expect(listed.length).toBe(1)
    expect(listed[0].filePath.startsWith(BACKUPS_DIR)).toBe(true)
    expect(listed[0].apiKeysIncluded).toBe(false)

    // 放一个格式不对的 zip 进去，不应被列出来，也不该被删掉
    const bad = new JSZip()
    bad.file('manifest.json', JSON.stringify({ format: 'other', version: 1 }))
    fs.writeFileSync(path.join(BACKUPS_DIR, 'nw-backup-bad.zip'), await bad.generateAsync({ type: 'nodebuffer' }))
    expect(await ctx.manager.list()).toHaveLength(1)
    expect(fs.existsSync(path.join(BACKUPS_DIR, 'nw-backup-bad.zip'))).toBe(true)
  })

  it('BK3 restore → 配置与技能真恢复，且先做保护性备份', async () => {
    const ctx = await fresh()
    ctx.config.set('backup.marker', 'A')
    writeSkill('demo', '# Demo\n\nv1')
    const created = await ctx.manager.create()

    ctx.config.set('backup.marker', 'B')
    writeSkill('demo', '# Demo\n\nv2')
    expect(ctx.config.get('backup.marker')).toBe('B')

    const result = await ctx.manager.restore(created.filePath)
    expect(result.restored).toContain('config')
    expect(result.restored).toContain('skills')
    expect(ctx.config.get('backup.marker')).toBe('A')
    expect(fs.readFileSync(path.join(SKILLS_DIR, 'demo', 'SKILL.md'), 'utf-8')).toContain('v1')
    expect(fs.existsSync(result.safetyBackupPath)).toBe(true)
    expect((await ctx.manager.list()).length).toBeGreaterThanOrEqual(2)
  })

  it('BK4 格式不兼容 → 拒绝且不产生任何写入', async () => {
    const ctx = await fresh()
    const zip = new JSZip()
    zip.file('manifest.json', JSON.stringify({ format: 'not-nw-backup', version: 99 }))
    const evil = path.join(TEST_USER_DATA, 'bad-format.zip')
    fs.writeFileSync(evil, await zip.generateAsync({ type: 'nodebuffer' }))

    await expect(ctx.manager.restore(evil)).rejects.toThrow('格式不兼容')
    expect(fs.existsSync(BACKUPS_DIR)).toBe(false)
  })

  it('BK5 zip-slip → 含 ../ 条目的包在任何写入前被拒绝', async () => {
    const ctx = await fresh()
    const zip = new JSZip()
    zip.file('manifest.json', JSON.stringify({
      format: 'nw-local-backup', version: 1, createdAt: Date.now(),
      appVersion: 'test', includes: ['skills'], apiKeysIncluded: false, skillCount: 0,
    }))
    zip.file('../evil.txt', 'pwned')
    const evil = path.join(TEST_USER_DATA, 'slip.zip')
    fs.writeFileSync(evil, await zip.generateAsync({ type: 'nodebuffer' }))

    await expect(ctx.manager.restore(evil)).rejects.toThrow('不安全路径')
    expect(fs.existsSync(path.join(TEST_USER_DATA, 'evil.txt'))).toBe(false)
    expect(fs.existsSync(BACKUPS_DIR)).toBe(false)
  })

  it('BK6 exportSkills → 只含技能目录的独立包', async () => {
    const ctx = await fresh()
    writeSkill('a', '# A')
    writeSkill('b', '# B')
    const target = path.join(TEST_USER_DATA, 'skills-export.zip')
    const r = await ctx.manager.exportSkills(target)

    expect(r.skillCount).toBe(2)
    expect(fs.existsSync(target)).toBe(true)
    const zip = await JSZip.loadAsync(fs.readFileSync(target))
    expect(zip.file('skills/a/SKILL.md')).toBeTruthy()
    expect(zip.file('skills/b/SKILL.md')).toBeTruthy()
    expect(zip.file('llm-config.json')).toBeNull()
  })
})
