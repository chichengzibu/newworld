/**
 * New World — 旧技能目录迁移（M4-AH）
 * ═══════════════════════════════════════════════════════════════════════
 * 【这一批在测什么】
 * M4-X 把技能目录从 `<userData>/skills` 改到了「应用自身目录的 skills」。
 * 只改路径不迁移 = **升级上来的用户原有技能全部"消失"**（旧目录还在，但没人读）。
 *
 * 这个缺陷测试发现不了：测试环境里 appPath 与 userData 是同一个目录，
 * 新旧路径恰好重合 —— 所以必须**显式**造出"两个不同的目录"来验。
 *
 * 三条口径逐条钉住：
 *   ① 复制不移动（旧目录保留，便于回退）
 *   ② 只补缺不覆盖（新位置改过的版本优先）
 *   ③ 幂等 + 互相包含时不动（避免递归自复制）
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'

import { TEST_USER_DATA } from './test-host'
import { SkillManager } from '../../electron/skill/SkillManager'

/** 旧位置固定是 <userData>/skills（TestHost 的 userData = TEST_USER_DATA） */
const LEGACY_DIR = path.join(TEST_USER_DATA, 'skills')

function writeSkill(dir: string, id: string, body: string): void {
  const d = path.join(dir, id)
  fs.mkdirSync(d, { recursive: true })
  fs.writeFileSync(path.join(d, 'SKILL.md'), body, 'utf-8')
}

describe('M4-AH 旧技能目录迁移', () => {
  let target: string

  beforeEach(() => {
    target = fs.mkdtempSync(path.join(os.tmpdir(), 'newworld-skills-target-'))
    fs.mkdirSync(LEGACY_DIR, { recursive: true })
  })

  afterEach(() => {
    try { fs.rmSync(target, { recursive: true, force: true }) } catch { /* ignore */ }
    try { fs.rmSync(LEGACY_DIR, { recursive: true, force: true }) } catch { /* ignore */ }
  })

  it('旧目录里的技能被复制到新目录，且旧目录**原样保留**（可回退）', () => {
    writeSkill(LEGACY_DIR, 'old-one', '---\nname: old\n---\n正文')
    const r = SkillManager.migrateLegacySkillsDir(target)

    expect(r.migrated).toContain('old-one')
    expect(fs.existsSync(path.join(target, 'old-one', 'SKILL.md'))).toBe(true)
    // ① 复制不移动
    expect(fs.existsSync(path.join(LEGACY_DIR, 'old-one', 'SKILL.md'))).toBe(true)
  })

  it('新目录已有同名技能 → 不覆盖（用户在新位置改过的版本优先）', () => {
    writeSkill(LEGACY_DIR, 'dup', '旧版本')
    writeSkill(target, 'dup', '新版本')

    const r = SkillManager.migrateLegacySkillsDir(target)
    expect(r.skippedExisting).toContain('dup')
    expect(fs.readFileSync(path.join(target, 'dup', 'SKILL.md'), 'utf-8')).toBe('新版本')
  })

  it('幂等：跑两遍，第二遍什么都不做', () => {
    writeSkill(LEGACY_DIR, 'once', '内容')
    const first = SkillManager.migrateLegacySkillsDir(target)
    const second = SkillManager.migrateLegacySkillsDir(target)

    expect(first.migrated).toContain('once')
    expect(second.migrated).toEqual([])
    expect(second.skippedExisting).toContain('once')
  })

  it('不含 SKILL.md 的目录不迁移（别把杂物搬过去）', () => {
    fs.mkdirSync(path.join(LEGACY_DIR, 'not-a-skill'), { recursive: true })
    fs.writeFileSync(path.join(LEGACY_DIR, 'not-a-skill', 'readme.txt'), 'x', 'utf-8')

    const r = SkillManager.migrateLegacySkillsDir(target)
    expect(r.migrated).toEqual([])
    expect(fs.existsSync(path.join(target, 'not-a-skill'))).toBe(false)
  })

  it('新旧目录相同 → 不动（fallback 到 userData 的场景）', () => {
    writeSkill(LEGACY_DIR, 'same', 'x')
    const r = SkillManager.migrateLegacySkillsDir(LEGACY_DIR)
    expect(r.migrated).toEqual([])
  })

  it('目标目录在旧目录内部 → 不动（避免递归自复制）', () => {
    writeSkill(LEGACY_DIR, 'inside', 'x')
    const nested = path.join(LEGACY_DIR, 'nested-target')
    fs.mkdirSync(nested, { recursive: true })
    const r = SkillManager.migrateLegacySkillsDir(nested)
    expect(r.migrated).toEqual([])
  })

  it('旧目录不存在 → 安静返回（不抛）', () => {
    fs.rmSync(LEGACY_DIR, { recursive: true, force: true })
    expect(() => SkillManager.migrateLegacySkillsDir(target)).not.toThrow()
    expect(SkillManager.migrateLegacySkillsDir(target).migrated).toEqual([])
  })
})
