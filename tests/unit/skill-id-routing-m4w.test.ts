/**
 * New World — 技能 id 与展示名不匹配(M4-W)
 * ═══════════════════════════════════════════════════════════════════════
 * 【这一批在测什么】
 * 「技能要由 AI 自行判断用哪个」这条需求,**卡在一个很小的地方**:
 *
 *   摘要给模型的是**展示名**(frontmatter 的 name),
 *   而 load_skill(skill_id) 只认**目录名**(id)。
 *   两者常常不同 —— 实测仓库自带技能 100% 命中:
 *     目录 `file-organizer`      / 名称 `文件整理器`
 *     目录 `sample-web-summary`  / 名称 `Web Page Summarizer`
 *
 * 后果:模型**判断对了**却加载不了(报"技能不存在"),
 * 白花一轮模型往返去读错误信息再改用 id 重试。
 * 实跑(M4-W 路由基准,修前):**每次加载都先失败一次**。
 *
 * 修法三件套(这里逐条钉住):
 *   ① 摘要里带上 skill_id —— 模型该传的东西得看得见
 *   ② getSkillBody 按 name 兜底 —— 猜对了就该能用
 *   ③ appliedEntity 记**规范 id** —— 学习闭环不能记成展示名
 */
import { describe, it, expect, beforeEach, vi } from 'vitest'
import * as fs from 'node:fs'
import * as path from 'node:path'

import { TEST_USER_DATA } from '../unit/test-host'

const SKILLS_DIR = path.join(TEST_USER_DATA, 'skills')

/** 写一个**目录名 ≠ 展示名**的技能(复现真实形态) */
function writeSkill(id: string, name: string, description = '描述文本'): void {
  const dir = path.join(SKILLS_DIR, id)
  fs.mkdirSync(dir, { recursive: true })
  fs.writeFileSync(path.join(dir, 'SKILL.md'), [
    '---',
    `name: ${name}`,
    `description: ${description}`,
    '---',
    '',
    '## 操作步骤',
    '1. 做点事',
    '',
  ].join('\n'), 'utf-8')
}

describe('M4-W 技能 id 与展示名', () => {
  beforeEach(() => {
    fs.mkdirSync(SKILLS_DIR, { recursive: true })
    writeSkill('sample-web-summary', 'Web Page Summarizer', '抓取网页正文并提炼摘要')
    writeSkill('file-organizer', '文件整理器', '自动整理指定目录下的文件')
  })

  async function freshLoader(): Promise<any> {
    const { SkillLoader } = await import('../../electron/skill/SkillLoader')
    ;(SkillLoader as any).instance = null
    const loader = SkillLoader.getInstance() as any
    loader.skillsDir = SKILLS_DIR
    loader.reloadSkills()
    return loader
  }

  it('L1 摘要里带 skill_id —— 模型要传的东西得看得见', async () => {
    const loader = await freshLoader()
    const summary = loader.getSkillSummaries()
    expect(summary).toContain('skill_id: sample-web-summary')
    expect(summary).toContain('skill_id: file-organizer')
    // 展示名也留着(那是给人看的)
    expect(summary).toContain('Web Page Summarizer')
    expect(summary).toContain('文件整理器')
  })

  it('全部技能摘要也带 skill_id', async () => {
    const loader = await freshLoader()
    const summary = loader.getAllSkillSummaries()
    expect(summary).toContain('skill_id: sample-web-summary')
  })

  it('按 id 加载 —— 一直都能', async () => {
    const loader = await freshLoader()
    expect(loader.getSkillBody('sample-web-summary')).not.toContain('不存在')
  })

  it('【新增】按展示名加载也能拿到 —— 猜对了就该能用', async () => {
    const loader = await freshLoader()
    const body = loader.getSkillBody('Web Page Summarizer')
    expect(body).not.toContain('不存在')
    expect(body).toContain('做点事')
  })

  it('展示名大小写/空格不同也能兜底', async () => {
    const loader = await freshLoader()
    expect(loader.getSkillBody('  web page summarizer ')).not.toContain('不存在')
  })

  it('resolveCanonicalSkillId 把展示名解析成规范 id', async () => {
    const loader = await freshLoader()
    expect(loader.resolveCanonicalSkillId('Web Page Summarizer')).toBe('sample-web-summary')
    expect(loader.resolveCanonicalSkillId('sample-web-summary')).toBe('sample-web-summary')
    expect(loader.resolveCanonicalSkillId('不存在的技能')).toBeUndefined()
  })

  it('技能不存在 → 错误信息说清"该传 skill_id",并列出 id↔名称对照', async () => {
    const loader = await freshLoader()
    const body = loader.getSkillBody('不存在的技能')
    expect(body).toContain('不存在')
    expect(body).toContain('skill_id')
    // 列出可用技能,且是 **id（名称）** 的形式 —— 模型能直接抄
    expect(body).toContain('sample-web-summary（Web Page Summarizer）')
  })

  it('【关键】按展示名加载 → appliedEntity 记的是**规范 id**(学习闭环要对得上账)', async () => {
    const loader = await freshLoader()
    const { LoadSkillTool } = await import('../../electron/agent/tools/LoadSkillTool')
    const tool = new LoadSkillTool()
    const r = await tool.execute({ skill_id: 'Web Page Summarizer' })
    expect(r.ok).toBe(true)
    // 记的必须是真 id,不是展示名 —— 否则 skill-stats.json 按一个不存在的名字聚合
    expect(r.appliedEntity).toEqual({ kind: 'skill', id: 'sample-web-summary' })
  })

  it('按 id 加载 → appliedEntity 就是该 id', async () => {
    await freshLoader()
    const { LoadSkillTool } = await import('../../electron/agent/tools/LoadSkillTool')
    const tool = new LoadSkillTool()
    const r = await tool.execute({ skill_id: 'sample-web-summary' })
    expect(r.ok).toBe(true)
    expect(r.appliedEntity).toEqual({ kind: 'skill', id: 'sample-web-summary' })
  })

  it('【M4-E 对照实验】禁用的技能按**展示名**传也拦得住(否则对照组能偷用)', async () => {
    await freshLoader()
    const { LoadSkillTool } = await import('../../electron/agent/tools/LoadSkillTool')
    const tool = new LoadSkillTool()
    // 对照实验的「不带技能」变体:禁用的是 id
    const r = await tool.execute(
      { skill_id: 'Web Page Summarizer' },
      { suppressedSkills: ['sample-web-summary'] } as any,
    )
    expect(r.ok).toBe(false)
    expect(r.appliedEntity).toBeUndefined()
    expect(r.error).toContain('禁用')
  })

  it('不存在的技能 → 失败,且不记 appliedEntity(没加载就不算应用)', async () => {
    await freshLoader()
    const { LoadSkillTool } = await import('../../electron/agent/tools/LoadSkillTool')
    const tool = new LoadSkillTool()
    const r = await tool.execute({ skill_id: '不存在的技能' })
    expect(r.ok).toBe(false)
    expect(r.appliedEntity).toBeUndefined()
    expect(r.error).toContain('skill_id')
  })
})
