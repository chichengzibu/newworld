/**
 * PiPiClaw - load_skill 工具测试 (M4-A)
 *
 * 这是渐进披露的 L2 入口:模型看到 L1 摘要后自己决定加载哪个技能。
 * 工具行为出错的后果:
 *   - 返回错内容 → 模型照着错的步骤执行(真实副作用)
 *   - 技能不存在时返回成功 → 模型把错误提示当成技能内容
 *   - 泄漏未启用技能 → 用户禁用了一个技能但它仍能被加载
 */
import { describe, it, expect, beforeEach } from 'vitest'
import * as fs from 'node:fs'
import * as path from 'node:path'
import { TestHost, TEST_USER_DATA } from './test-host'
import { setHost } from '../../electron/platform/runtime'

const SKILLS_DIR = path.join(TEST_USER_DATA, 'skills')

function writeSkill(id: string, content: string): void {
  const dir = path.join(SKILLS_DIR, id)
  fs.mkdirSync(dir, { recursive: true })
  fs.writeFileSync(path.join(dir, 'SKILL.md'), content, 'utf-8')
}

describe('M4-A load_skill 工具', () => {
  beforeEach(async () => {
    setHost(new TestHost())
    fs.mkdirSync(SKILLS_DIR, { recursive: true })
  })

  it('加载存在的技能 → 返回其正文', async () => {
    writeSkill('demo', `---
name: demo
description: 演示技能
---
## 操作步骤
1. 第一步做什么
2. 第二步做什么
`)
    const { LoadSkillTool } = await import('../../electron/agent/tools/LoadSkillTool')
    const { SkillLoader } = await import('../../electron/skill/SkillLoader')
    SkillLoader.getInstance().reloadSkills()

    const r = await new LoadSkillTool().execute({ skill_id: 'demo' })
    expect(r.ok).toBe(true)
    expect(r.result).toContain('demo')
    expect(r.result).toContain('第一步做什么')
  })

  it('技能不存在 → 失败并列出可用技能', async () => {
    writeSkill('exists', `---
name: exists
description: 存在的技能
---
正文
`)
    const { LoadSkillTool } = await import('../../electron/agent/tools/LoadSkillTool')
    const { SkillLoader } = await import('../../electron/skill/SkillLoader')
    SkillLoader.getInstance().reloadSkills()

    const r = await new LoadSkillTool().execute({ skill_id: 'nope' })
    // 关键:不能返回 ok:true —— 否则模型会把错误提示当技能内容照做
    expect(r.ok).toBe(false)
    expect(r.error).toContain('不存在')
    expect(r.error).toContain('exists')   // 告知可用技能
  })

  it('缺少 skill_id 参数 → 失败并说明', async () => {
    const { LoadSkillTool } = await import('../../electron/agent/tools/LoadSkillTool')
    const r = await new LoadSkillTool().execute({})
    expect(r.ok).toBe(false)
    expect(r.error).toContain('skill_id')
  })

  it('空字符串 id → 失败', async () => {
    const { LoadSkillTool } = await import('../../electron/agent/tools/LoadSkillTool')
    const r = await new LoadSkillTool().execute({ skill_id: '   ' })
    expect(r.ok).toBe(false)
  })

  it('是只读工具 → 不需要权限门', async () => {
    const { LoadSkillToolMetadata } = await import('../../electron/agent/tools/LoadSkillTool')
    expect(LoadSkillToolMetadata.requiresPermission).toBe(false)
  })

  it('已注册进内置工具表', async () => {
    const { BUILTIN_TOOLS } = await import('../../electron/agent/tools')
    expect(BUILTIN_TOOLS.map(t => t.metadata.name)).toContain('load_skill')
  })

  /**
   * 【M4-D】加载成功时声明"我作用在哪个技能上" ——
   * 这是"技能被应用后有没有用"能被回答的前提:
   * 工具调用日志里只有工具名(load_skill),不是技能 id,
   * 没有这个声明,学习闭环就不知道哪些技能被应用过。
   */
  it('加载成功 → 声明 appliedEntity(技能 id)', async () => {
    writeSkill('demo', `---
name: demo
description: 演示技能
---
## 操作步骤
1. 第一步做什么
`)
    const { LoadSkillTool } = await import('../../electron/agent/tools/LoadSkillTool')
    const { SkillLoader } = await import('../../electron/skill/SkillLoader')
    ;(SkillLoader as any).instance = null
    SkillLoader.getInstance().loadAllSkills()

    const tool = new LoadSkillTool()
    const r = await tool.execute({ skill_id: 'demo' })
    expect(r.ok).toBe(true)
    expect(r.appliedEntity).toEqual({ kind: 'skill', id: 'demo' })
  })

  it('加载失败 → 不声明 appliedEntity(没真应用就不该被记成"用了这个技能")', async () => {
    const { LoadSkillTool } = await import('../../electron/agent/tools/LoadSkillTool')
    const tool = new LoadSkillTool()
    const r = await tool.execute({ skill_id: '不存在的技能' })
    expect(r.ok).toBe(false)
    expect(r.appliedEntity).toBeUndefined()
  })

  /**
   * 【M4-E】对照实验的抑制机制。
   *
   * 「这个技能有没有用」要靠**配对对照**回答:同一个任务跑两遍,
   * 一遍允许用它、一遍禁止用。若「禁止」不真的生效,模型照样会调 load_skill
   * —— 对照组就废了,测出来的差值恒为 0(两个变体其实一样)。
   */
  it('被抑制的技能 → 拒绝加载,并说清原因', async () => {
    writeSkill('demo', `---
name: demo
description: 演示技能
---
## 操作步骤
1. 做点事
`)
    const { LoadSkillTool } = await import('../../electron/agent/tools/LoadSkillTool')
    const { SkillLoader } = await import('../../electron/skill/SkillLoader')
    ;(SkillLoader as any).instance = null
    SkillLoader.getInstance().loadAllSkills()

    const tool = new LoadSkillTool()
    const r = await tool.execute({ skill_id: 'demo' }, { contextKind: 'ui', suppressedSkills: ['demo'] } as any)
    expect(r.ok).toBe(false)
    // 错误要说清是"被禁用",不是"工具坏了" —— 否则模型会反复重试,把对照做脏
    expect(r.error).toContain('禁用')
    expect(r.error).toContain('demo')
  })

  it('未被抑制的技能 → 正常加载(抑制不能误伤)', async () => {
    writeSkill('demo', `---
name: demo
description: 演示技能
---
## 操作步骤
1. 做点事
`)
    const { LoadSkillTool } = await import('../../electron/agent/tools/LoadSkillTool')
    const { SkillLoader } = await import('../../electron/skill/SkillLoader')
    ;(SkillLoader as any).instance = null
    SkillLoader.getInstance().loadAllSkills()

    const tool = new LoadSkillTool()
    const r = await tool.execute({ skill_id: 'demo' }, { contextKind: 'ui', suppressedSkills: ['other'] } as any)
    expect(r.ok).toBe(true)
  })

  it('工具描述说明"先加载再执行" —— 引导模型正确使用', async () => {
    const { LoadSkillToolMetadata } = await import('../../electron/agent/tools/LoadSkillTool')
    // 依据 Anthropic 规范:description 是路由规则,必须写清"何时用"
    expect(LoadSkillToolMetadata.description).toMatch(/相关|需要/)
    // 并明确禁止凭猜测执行(否则模型会跳过加载直接动手)
    expect(LoadSkillToolMetadata.description).toContain('不要凭猜测')
    // 参数说明要能让模型知道传什么
    const p = LoadSkillToolMetadata.parametersJson as Record<string, unknown>
    expect((p.properties as Record<string, unknown>).skill_id).toBeDefined()
    expect(p.required).toEqual(['skill_id'])
  })
})
