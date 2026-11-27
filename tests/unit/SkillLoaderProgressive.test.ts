/**
 * New World - SkillLoader 渐进披露测试 (M4-A)
 *
 * 【设计依据】Anthropic Agent Skills 规范:
 *   L1 name+description 常驻(约100 token/技能),description 本身即路由规则
 *   L2 正文仅在触发时加载
 *   L3 references/scripts 按需 Read/Bash
 *
 * 【这些断言守住的具体缺陷】
 *   - triggerCondition 恒 undefined → 语义匹配拿字符串"无"作对照
 *   - `## 触发条件` 整句被当成一个"关键词"
 *   - `## 示例` 被当成一条操作步骤
 *   - 技能多时串行 N 次 LLM 调用(现改为单次批量排序)
 *   - 写 userData/skills 但读 appPath/../skills → 保存的技能永远扫不到
 */
import { describe, it, expect, beforeEach } from 'vitest'
import * as fs from 'node:fs'
import * as path from 'node:path'
import { TestHost, TEST_USER_DATA } from './test-host'
import { setHost } from '../../electron/platform/runtime'

const SKILLS_DIR = path.join(TEST_USER_DATA, 'skills')

function writeSkill(id: string, content: string, extraDirs: string[] = []): void {
  const dir = path.join(SKILLS_DIR, id)
  fs.mkdirSync(dir, { recursive: true })
  fs.writeFileSync(path.join(dir, 'SKILL.md'), content, 'utf-8')
  for (const d of extraDirs) {
    fs.mkdirSync(path.join(dir, d), { recursive: true })
  }
}

describe('M4-A SkillLoader 渐进披露', () => {
  beforeEach(async () => {
    setHost(new TestHost())
    fs.mkdirSync(SKILLS_DIR, { recursive: true })
  })

  describe('frontmatter 解析', () => {
    it('读取 name / description / when_to_use', async () => {
      writeSkill('pdf-tool', `---
name: pdf-tool
description: 提取 PDF 里的文本和表格,填表单,合并文档
when_to_use: 用户提到 PDF、扫描件、表单或文档合并时
---

## 操作步骤
1. 打开文件
2. 提取内容
`)
      const { SkillLoader } = await import('../../electron/skill/SkillLoader')
      const loader = SkillLoader.getInstance()
      loader.reloadSkills()
      const s = loader.getSkill('pdf-tool')
      expect(s).toBeDefined()
      expect(s!.name).toBe('pdf-tool')
      expect(s!.description).toContain('PDF')
      // 关键:此前恒为 undefined
      expect(s!.whenToUse).toContain('PDF')
    })

    it('兼容小写 skill.md(项目历史格式)', async () => {
      const dir = path.join(SKILLS_DIR, 'legacy')
      fs.mkdirSync(dir, { recursive: true })
      fs.writeFileSync(path.join(dir, 'skill.md'), '# 旧技能\n\n## 描述\n老格式\n', 'utf-8')

      const { SkillLoader } = await import('../../electron/skill/SkillLoader')
      const loader = SkillLoader.getInstance()
      loader.reloadSkills()
      expect(loader.getSkill('legacy')).toBeDefined()
    })
  })

  describe('小节解析的三个误判修正', () => {
    it('`## 触发条件` 进 whenToUse,不进 keywords', async () => {
      writeSkill('cond', `---
name: cond
description: 测试
---

## 触发条件
当用户说"整理桌面"时

## 触发关键词
- 整理
- 桌面
`)
      const { SkillLoader } = await import('../../electron/skill/SkillLoader')
      const loader = SkillLoader.getInstance()
      loader.reloadSkills()
      const s = loader.getSkill('cond')!
      expect(s.whenToUse).toContain('整理桌面')
      // 关键词只应是列表项,不含整句触发条件
      expect(s.triggerKeywords).toEqual(['整理', '桌面'])
    })

    it('`## 示例` 不被当成操作步骤', async () => {
      writeSkill('ex', `---
name: ex
description: 测试
---

## 操作步骤
1. 真实步骤

## 示例
用户说: 帮我整理
`)
      const { SkillLoader } = await import('../../electron/skill/SkillLoader')
      const loader = SkillLoader.getInstance()
      loader.reloadSkills()
      const s = loader.getSkill('ex')!
      expect(s.operationSteps).toEqual(['真实步骤'])
    })

    it('`## Gotchas` 不污染步骤', async () => {
      writeSkill('got', `---
name: got
description: 测试
---

## 操作步骤
1. 唯一一步

## Gotchas
- 路径分隔符在 Windows 上是反斜杠
`)
      const { SkillLoader } = await import('../../electron/skill/SkillLoader')
      const loader = SkillLoader.getInstance()
      loader.reloadSkills()
      expect(loader.getSkill('got')!.operationSteps).toEqual(['唯一一步'])
    })
  })

  describe('渐进披露三层', () => {
    it('L1 摘要含 name+description+when_to_use', async () => {
      writeSkill('s1', `---
name: s1
description: 描述文本
when_to_use: 适用场景
---
正文
`)
      writeSkill('s2', `---
name: s2
description: 另一个描述
---
正文
`)
      const { SkillLoader } = await import('../../electron/skill/SkillLoader')
      const loader = SkillLoader.getInstance()
      loader.reloadSkills()

      const summaries = loader.getSkillSummaries()
      expect(summaries).toContain('s1')
      expect(summaries).toContain('描述文本')
      expect(summaries).toContain('适用场景')
      expect(summaries).toContain('s2')
    })

    it('L2 按需取正文 —— 不把全部正文塞进摘要', async () => {
      writeSkill('body1', `---
name: body1
description: 短描述
---
这是很长的正文内容,不应该出现在摘要里
`)
      const { SkillLoader } = await import('../../electron/skill/SkillLoader')
      const loader = SkillLoader.getInstance()
      loader.reloadSkills()

      const summaries = loader.getSkillSummaries()
      expect(summaries).not.toContain('很长的正文内容')
      // 按需取才拿到
      expect(loader.getSkillBody('body1')).toContain('很长的正文内容')
    })

    it('不存在的技能返回可用清单而非空串', async () => {
      const { SkillLoader } = await import('../../electron/skill/SkillLoader')
      const loader = SkillLoader.getInstance()
      loader.reloadSkills()
      const body = loader.getSkillBody('nope')
      expect(body).toContain('不存在')
    })

    it('探测 references/scripts/assets 目录', async () => {
      writeSkill('withres', `---
name: withres
description: 测试
---
正文
`, ['references', 'scripts'])
      const { SkillLoader } = await import('../../electron/skill/SkillLoader')
      const loader = SkillLoader.getInstance()
      loader.reloadSkills()
      const s = loader.getSkill('withres')!
      expect(s.hasReferences).toBe(true)
      expect(s.hasScripts).toBe(true)
      expect(s.hasAssets).toBe(false)
      // 加载提示里应告知资源位置
      expect(loader.getSkillBody('withres')).toContain('references/')
    })
  })

  describe('存储目录单点', () => {
    it('SkillManager.getSkillsDir 是唯一真源 —— 与 SkillLoader 读取路径一致', async () => {
      const { SkillManager } = await import('../../electron/skill/SkillManager')
      const { SkillLoader } = await import('../../electron/skill/SkillLoader')
      const managerDir = SkillManager.getSkillsDir()
      const loaderDir = (SkillLoader.getInstance() as unknown as { skillsDir: string }).skillsDir
      // 关键:写入路径与读取路径必须一致,否则保存的技能永远扫不到
      expect(loaderDir.replace(/[\\/]$/, '')).toBe(managerDir.replace(/[\\/]$/, ''))
    })

    it('getSkillsDir 落在 userData 下(不是 app 安装目录)', async () => {
      const { SkillManager } = await import('../../electron/skill/SkillManager')
      expect(SkillManager.getSkillsDir()).toContain('skills')
      expect(SkillManager.getSkillsDir().startsWith(TEST_USER_DATA)).toBe(true)
    })
  })
})
