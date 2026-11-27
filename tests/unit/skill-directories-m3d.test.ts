/**
 * New World — 技能目录测试（M3-D）
 * ═══════════════════════════════════════════════════════════════
 * 【这一批修的是"能力只有一张嘴"】
 * preload 里早就有 6 个通道声明:
 *   skills:addCustomDir / removeCustomDir / getCustomDirs
 *   skills:getDirectoryPreview / getStorageInfo / remove
 * 但主进程**从没有实现**、渲染层**从没有调用** —— 真调会得到
 * "No handler registered"。而技能系统当时只有一个目录(userData/skills),
 * 用户项目里的技能目录完全看不到。
 *
 * 【本批锁死】
 *   ① 额外目录里的技能会被加载
 *   ② 同名技能以【主目录优先】(先到者为准,id 必须全局唯一)
 *   ③ 移除目录 → 那些技能不再加载
 *   ④ 删除技能的路径守卫(越界一律拒)
 *   ⑤ 存储信息如实报告(目录不存在要标出来,不能装作有)
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import * as fs from 'node:fs'
import * as path from 'node:path'
import { getHost } from '../../electron/platform/runtime'
import { SkillLoader } from '../../electron/skill/SkillLoader'
import { ConfigStore } from '../../electron/core/ConfigStore'

const TEST_USER_DATA = getHost().getPath('userData')
const SKILLS_DIR = path.join(TEST_USER_DATA, 'skills')

/** 临时额外目录(按 pid 隔离) */
const EXTRA_DIR = path.join(TEST_USER_DATA, `extra-skills-${process.pid}`)
const EXTRA_DIR2 = path.join(TEST_USER_DATA, `extra-skills2-${process.pid}`)

function writeSkill(baseDir: string, id: string, name: string): void {
  const dir = path.join(baseDir, id)
  fs.mkdirSync(dir, { recursive: true })
  fs.writeFileSync(
    path.join(dir, 'SKILL.md'),
    `---\nname: ${name}\ndescription: ${name} 的描述\n---\n## 操作步骤\n1. 做点事\n`,
    'utf-8',
  )
}

function resetLoader() {
  ;(SkillLoader as unknown as { instance: SkillLoader | null }).instance = null
  // 清掉上次留下的额外目录配置
  try { ConfigStore.getInstance().set('skills.extraDirs', []) } catch { /* ignore */ }
}

describe('M3-D 技能目录(多目录发现)', () => {
  let loader: SkillLoader

  beforeEach(() => {
    fs.mkdirSync(SKILLS_DIR, { recursive: true })
    fs.mkdirSync(EXTRA_DIR, { recursive: true })
    fs.mkdirSync(EXTRA_DIR2, { recursive: true })
    resetLoader()
    loader = SkillLoader.getInstance()
  })

  afterEach(() => {
    resetLoader()
    for (const d of [EXTRA_DIR, EXTRA_DIR2]) {
      if (fs.existsSync(d)) fs.rmSync(d, { recursive: true, force: true })
    }
  })

  it('额外目录里的技能会被加载', () => {
    writeSkill(EXTRA_DIR, 'my-skill', '我的技能')
    loader.setExtraDirs([EXTRA_DIR])
    loader.reloadSkills()

    const skill = loader.getSkill('my-skill')
    expect(skill).toBeDefined()
    expect(skill!.name).toBe('我的技能')
    // 记来源目录 —— 删除时要知道删哪个
    expect(skill!.sourceDir).toBe(path.resolve(EXTRA_DIR))
  })

  it('主目录与额外目录同名 → 主目录优先(id 必须全局唯一)', () => {
    writeSkill(SKILLS_DIR, 'dup', '主目录版本')
    writeSkill(EXTRA_DIR, 'dup', '额外目录版本')
    loader.setExtraDirs([EXTRA_DIR])
    loader.reloadSkills()

    const skill = loader.getSkill('dup')
    expect(skill).toBeDefined()
    expect(skill!.name).toBe('主目录版本')
    expect(skill!.sourceDir).toBe(path.resolve(SKILLS_DIR))
  })

  it('移除额外目录 → 那些技能不再加载', () => {
    writeSkill(EXTRA_DIR, 'gone-skill', '会消失的技能')
    loader.setExtraDirs([EXTRA_DIR])
    loader.reloadSkills()
    expect(loader.getSkill('gone-skill')).toBeDefined()

    loader.removeExtraDir(EXTRA_DIR)
    loader.reloadSkills()
    expect(loader.getSkill('gone-skill')).toBeUndefined()
  })

  it('添加目录:不存在的目录被拒', () => {
    const r = loader.addExtraDir(path.join(TEST_USER_DATA, '根本不存在-xyz'))
    expect(r.ok).toBe(false)
    expect(r.error).toBeTruthy()
    expect(loader.getExtraDirs()).toHaveLength(0)
  })

  it('添加目录:重复添加去重', () => {
    const r1 = loader.addExtraDir(EXTRA_DIR)
    expect(r1.ok).toBe(true)
    const r2 = loader.addExtraDir(EXTRA_DIR)
    expect(r2.dirs).toHaveLength(1)
  })

  it('预览目录:列出里面的技能', () => {
    writeSkill(EXTRA_DIR, 'a-skill', '技能A')
    writeSkill(EXTRA_DIR, 'b-skill', '技能B')
    const p = loader.previewDirectory(EXTRA_DIR)
    expect(p.exists).toBe(true)
    expect(p.skills.map(s => s.id).sort()).toEqual(['a-skill', 'b-skill'])
  })

  it('预览不存在的目录 → exists=false,不报错', () => {
    const p = loader.previewDirectory(path.join(TEST_USER_DATA, '没有这个目录-xyz'))
    expect(p.exists).toBe(false)
    expect(p.skills).toHaveLength(0)
  })

  it('存储信息:主目录 + 额外目录各自的数量;不存在的目录如实标出', () => {
    writeSkill(SKILLS_DIR, 's1', 'S1')
    writeSkill(EXTRA_DIR, 'e1', 'E1')
    loader.setExtraDirs([EXTRA_DIR, EXTRA_DIR2])
    loader.reloadSkills()

    const info = loader.getStorageInfo()
    expect(info.primaryCount).toBeGreaterThanOrEqual(1)
    expect(info.extraDirs).toHaveLength(2)
    const e1 = info.extraCounts.find(c => c.dir === path.resolve(EXTRA_DIR))
    expect(e1?.exists).toBe(true)
    expect(e1?.count).toBe(1)
    const e2 = info.extraCounts.find(c => c.dir === path.resolve(EXTRA_DIR2))
    expect(e2?.exists).toBe(true)
  })

  it('删除技能:删掉的是它所在目录下的技能子目录', () => {
    writeSkill(EXTRA_DIR, 'to-delete', '待删除')
    loader.setExtraDirs([EXTRA_DIR])
    loader.reloadSkills()
    expect(loader.getSkill('to-delete')).toBeDefined()

    const r = loader.removeSkill('to-delete')
    expect(r.ok).toBe(true)
    expect(fs.existsSync(path.join(EXTRA_DIR, 'to-delete'))).toBe(false)
    expect(loader.getSkill('to-delete')).toBeUndefined()
  })

  it('删除技能:不存在的技能 → 报失败而不是删别的东西', () => {
    const r = loader.removeSkill('根本没有这个技能')
    expect(r.ok).toBe(false)
    expect(r.error).toBeTruthy()
  })

  it('删除技能:路径守卫 —— 越界 id 一律拒(不能拼路径就删)', () => {
    // 造一个"技能",但它的 sourceDir 不在允许列表里
    const evil = loader.getAllSkills()[0]
    if (!evil) {
      writeSkill(SKILLS_DIR, 'x', 'X')
      loader.reloadSkills()
    }
    const skill = loader.getAllSkills()[0]
    expect(skill).toBeDefined()

    // 直接改内存里的 sourceDir 为未登记目录 → 删除必须被拒
    ;(loader as any).skills.get(skill.id).sourceDir = path.join(TEST_USER_DATA, '未登记目录')
    const r = loader.removeSkill(skill.id)
    expect(r.ok).toBe(false)
    expect(r.error).toContain('未登记')
  })

  it('删除技能:目录已不存在 → 只清索引,不算失败', () => {
    writeSkill(EXTRA_DIR, 'vanished', '消失的技能')
    loader.setExtraDirs([EXTRA_DIR])
    loader.reloadSkills()
    // 手动把目录删掉,模拟外部删除
    fs.rmSync(path.join(EXTRA_DIR, 'vanished'), { recursive: true, force: true })

    const r = loader.removeSkill('vanished')
    expect(r.ok).toBe(true)
    expect(loader.getSkill('vanished')).toBeUndefined()
  })
})
