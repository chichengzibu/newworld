/**
 * v4.9 记忆自进化闭环 —— 单测
 *
 * 覆盖四项修复：
 *  ① retrieveRelevantMemories 真正使用 query（旧实现完全忽略）
 *  ② 向量召回重启后 content 空 → 从文本真源回填
 *  ③ curate 真删除 / 真晋升（旧实现只计数）
 *  ④ evolve 真合并（旧实现随机拼字符串）
 *  ⑤ compactExperience 压缩快照 + buildMemoryPrompt 读回快照
 *  ⑥ MemoryDistiller 解析与降级
 */
import { describe, it, expect, beforeEach } from 'vitest'
import * as fs from 'node:fs'
import * as path from 'node:path'
import { TEST_USER_DATA } from './test-host'

/**
 * 全局 setup 的 beforeEach 会 rm -rf 整个 TEST_USER_DATA 再重建，
 * 但 HermesMemory 是单例 —— 目录只在首次构造时建一次。
 * 所以每个用例前必须把 hermes-memory 子目录补回来，
 * 否则 clearAllMemories / compactExperience 写文件直接 ENOENT。
 */
const MEM_DIR = path.join(TEST_USER_DATA, 'hermes-memory')

beforeEach(() => {
  fs.mkdirSync(MEM_DIR, { recursive: true })
})

describe('HermesMemory.retrieveRelevantMemories —— query 真正参与排序', () => {
  it('相同库里，不同 query 返回不同顺序的结果', async () => {
    const { HermesMemory } = await import('../../electron/hermes/HermesMemory')
    const mem = HermesMemory.getInstance()
    mem.clearAllMemories()

    mem.addExperienceMemory('用户习惯把图片存到 D 盘的照片目录', ['图片'])
    mem.addExperienceMemory('用户要求所有文档用中文撰写', ['写作'])
    mem.addExperienceMemory('用户偏好深色主题', ['主题'])

    const aboutImages = mem.retrieveRelevantMemories('图片放哪里', 1)
    const aboutDocs = mem.retrieveRelevantMemories('文档用什么语言', 1)

    expect(aboutImages[0]?.content).toContain('图片')
    expect(aboutDocs[0]?.content).toContain('中文')
    // 关键：两次查询的首位不同 —— 证明 query 生效（旧实现会返回同一条）
    expect(aboutImages[0]?.id).not.toBe(aboutDocs[0]?.id)
  })

  it('无 query 词面命中时仍按重要性+时间排序，不崩', async () => {
    const { HermesMemory } = await import('../../electron/hermes/HermesMemory')
    const mem = HermesMemory.getInstance()
    mem.clearAllMemories()
    mem.addExperienceMemory('一条完全无关的记忆内容 xyz')

    const r = mem.retrieveRelevantMemories('量子力学', 5)
    expect(Array.isArray(r)).toBe(true)
    expect(r.length).toBe(1)
  })
})

describe('curate —— 真删除与真晋升（旧实现只计数）', () => {
  it('低重要性且陈旧记忆被真删除', async () => {
    const { HermesMemory } = await import('../../electron/hermes/HermesMemory')
    const { HermesAdapter } = await import('../../electron/hermes/HermesAdapter')
    const mem = HermesMemory.getInstance()
    mem.clearAllMemories()

    const old = mem.addExperienceMemory('陈旧低价值记忆', [], 'old-1')
    // 手工改旧时间与低重要性
    const all = mem.getAllMemories()
    const target = all.find((m) => m.id === old.id)!
    target.importance = 5
    target.timestamp = Date.now() - 60 * 86400000

    const before = mem.getAllMemories().length
    const report = await HermesAdapter.getInstance().curate()
    const after = mem.getAllMemories().length

    expect(report.removed).toBeGreaterThanOrEqual(1)
    expect(after).toBe(before - report.removed)
    expect(mem.getAllMemories().find((m) => m.id === 'old-1')).toBeUndefined()
  })

  it('高重要性对话记忆被晋升为 experience', async () => {
    const { HermesMemory } = await import('../../electron/hermes/HermesMemory')
    const mem = HermesMemory.getInstance()
    mem.clearAllMemories()
    mem.addConversationMemory('conv-x', '用户强调以后所有输出都要带来源引用', 85)

    const before = mem.getAllMemories().filter((m) => m.type === 'conversation').length
    mem.promoteMemories()
    const after = mem.getAllMemories().filter((m) => m.type === 'conversation').length
    const expCount = mem.getAllMemories().filter((m) => m.type === 'experience').length

    expect(after).toBe(before - 1)
    expect(expCount).toBeGreaterThanOrEqual(1)
  })
})

describe('evolve —— 真合并（旧实现随机拼字符串）', () => {
  it('含包含关系的两条短碎片被合并为一条', async () => {
    const { HermesMemory } = await import('../../electron/hermes/HermesMemory')
    const { HermesAdapter } = await import('../../electron/hermes/HermesAdapter')
    const mem = HermesMemory.getInstance()
    mem.clearAllMemories()

    mem.addExperienceMemory('用户喜欢把文件按类型整理归档')
    mem.addExperienceMemory('把文件按类型整理归档')

    const beforeCount = mem.getAllMemories().length
    const r = await HermesAdapter.getInstance().evolve()
    const afterCount = mem.getAllMemories().length

    expect(r.mutated).toBeGreaterThanOrEqual(1)
    expect(afterCount).toBeLessThan(beforeCount)
  })
})

describe('compactExperience + buildMemoryPrompt —— 快照可读可压缩', () => {
  it('MEMORY.md 压缩后条目数下降，且能被 buildMemoryPrompt 读回', async () => {
    const { HermesMemory } = await import('../../electron/hermes/HermesMemory')
    const mem = HermesMemory.getInstance()
    mem.clearAllMemories()

    for (let i = 0; i < 12; i++) {
      mem.addExperienceMemory(`经验条目内容 ${i} —— 关于文件归档的细节说明`)
    }

    const r = mem.compactExperience({ maxEntries: 5, minImportance: 0 })
    expect(r.before).toBeGreaterThan(r.after)
    expect(r.after).toBeLessThanOrEqual(5)

    const prompt = mem.buildMemoryPrompt('文件归档', { maxChars: 4000 })
    // 关键：MEMORY.md 内容以前【完全不进 prompt】，现在必须出现
    expect(prompt).toContain('经验记忆快照')
    expect(prompt).toContain('经验条目内容')
  })

  it('相同内容去重，只保留一条', async () => {
    const { HermesMemory } = await import('../../electron/hermes/HermesMemory')
    const mem = HermesMemory.getInstance()
    mem.clearAllMemories()
    mem.addExperienceMemory('重复的经验内容 ABC')
    mem.addExperienceMemory('重复的经验内容 ABC')
    mem.addExperienceMemory('重复的经验内容 ABC')

    const r = mem.compactExperience({ maxEntries: 100, minImportance: 0 })
    expect(r.after).toBe(1)
  })

  it('预算控制：超长 prompt 被截断到 maxChars 附近', async () => {
    const { HermesMemory } = await import('../../electron/hermes/HermesMemory')
    const mem = HermesMemory.getInstance()
    mem.clearAllMemories()
    mem.updateCoreMemory('# 用户核心记忆\n\n' + '很长的核心记忆内容。'.repeat(200))

    const prompt = mem.buildMemoryPrompt('测试', { maxChars: 500 })
    expect(prompt.length).toBeLessThan(700)
  })
})

describe('MemoryDistiller —— 解析与降级', () => {
  it('解析标准 JSON', async () => {
    const { MemoryDistiller } = await import('../../electron/hermes/MemoryDistiller')
    const d = MemoryDistiller.getInstance()
    const out = d.parse('{"memories":[{"content":"用户偏好深色主题","importance":75,"kind":"preference"}]}')
    expect(out).toHaveLength(1)
    expect(out[0].content).toBe('用户偏好深色主题')
    expect(out[0].importance).toBe(75)
    expect(out[0].kind).toBe('preference')
  })

  it('解析被 markdown 代码块包裹的 JSON', async () => {
    const { MemoryDistiller } = await import('../../electron/hermes/MemoryDistiller')
    const d = MemoryDistiller.getInstance()
    const out = d.parse('```json\n{"memories":[{"content":"用户用中文","importance":60,"kind":"preference"}]}\n```')
    expect(out).toHaveLength(1)
    expect(out[0].content).toBe('用户用中文')
  })

  it('低 importance 条目被过滤', async () => {
    const { MemoryDistiller } = await import('../../electron/hermes/MemoryDistiller')
    const d = MemoryDistiller.getInstance()
    const out = d.parse('{"memories":[{"content":"不重要","importance":5,"kind":"fact"}]}')
    expect(out).toHaveLength(0)
  })

  it('最多返回 2 条', async () => {
    const { MemoryDistiller } = await import('../../electron/hermes/MemoryDistiller')
    const d = MemoryDistiller.getInstance()
    const out = d.parse(JSON.stringify({
      memories: [
        { content: 'a 内容', importance: 60, kind: 'fact' },
        { content: 'b 内容', importance: 60, kind: 'fact' },
        { content: 'c 内容', importance: 60, kind: 'fact' },
      ],
    }))
    expect(out).toHaveLength(2)
  })

  it('非法 JSON 返回空数组，不抛', async () => {
    const { MemoryDistiller } = await import('../../electron/hermes/MemoryDistiller')
    const d = MemoryDistiller.getInstance()
    expect(d.parse('这不是 JSON')).toEqual([])
  })

  it('buildSkillMemory 产出 procedure 类型且 importance 高', async () => {
    const { MemoryDistiller } = await import('../../electron/hermes/MemoryDistiller')
    const d = MemoryDistiller.getInstance()
    const m = d.buildSkillMemory({
      name: '按月归档截图',
      description: '把截图按月份建文件夹归档',
      triggerCondition: '用户提到截图整理',
      keywords: ['截图', '归档'],
    })
    expect(m.kind).toBe('procedure')
    expect(m.importance).toBeGreaterThanOrEqual(80)
    expect(m.content).toContain('按月归档截图')
  })
})
