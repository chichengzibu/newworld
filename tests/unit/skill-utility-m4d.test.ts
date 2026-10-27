/**
 * PiPiClaw — M4-D 技能效用测试
 * ═══════════════════════════════════════════════════════════════
 * 【这一批回答的问题】
 * 「这个技能到底有没有用?」
 *
 * 【为什么这个问题之前无法回答】
 * ① 数据里【没有"哪些技能被应用了"】—— 工具调用日志只有工具名,
 *    `load_skill` 是工具名,不是技能 id
 * ② 即便记下了,【绝对成功率也说明不了效用】——
 *    用户可能专挑难活儿时才启用技能,那时成功率低是任务难,不是技能没用
 * ③ 「不带该技能」的运行【无法归类对比】—— 没有任务类别,
 *    就无法把两组运行放到同一把尺子上量
 *
 * 【M4-D 的三条对应】
 * ① ToolExecResult.appliedEntity —— 工具自己声明"我动了什么"
 *    → brain 汇总成 appliedSkills → ChatManager 记技能级运行
 * ② SkillEffectivenessTracker.getMarginalUtility() —— 同类别任务下,
 *    带它 vs 不带它的成功率差
 * ③ SkillCallRecord.category —— 任务类别,两侧归一规则必须一致
 *    (故抽出 TaskCategory.ts 单一实现)
 *
 * 【口径红线】边际效用是【观察性对比】,不是受控实验。
 * 「不带技能」的运行是自然发生的,存在混杂 —— 所以只产信号,不做自动处置。
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'

vi.mock('electron', () => ({
  app: { getPath: vi.fn((k: string) => `/tmp/pipiclaw-m4d-${k}`) },
}))

vi.mock('electron-log', () => ({
  default: {
    info: () => {}, warn: () => {}, error: () => {}, debug: () => {},
    transports: { file: { resolvePathFn: () => {}, maxSize: 0, format: '' }, console: { level: 'info' } },
  },
}))

import { SkillEffectivenessTracker } from '../../electron/learning/SkillEffectivenessTracker'
import { normalizeTaskCategory } from '../../electron/learning/TaskCategory'

describe('M4-D 任务类别归一 (TaskCategory)', () => {
  it('大小写/标点/空白差异归到同一类别', () => {
    expect(normalizeTaskCategory('整理桌面!')).toBe(normalizeTaskCategory('整理桌面'))
    expect(normalizeTaskCategory('  整理   桌面  ')).toBe('整理 桌面')
    expect(normalizeTaskCategory('ABC')).toBe('abc')
  })

  it('不同任务归到不同类别', () => {
    expect(normalizeTaskCategory('整理桌面')).not.toBe(normalizeTaskCategory('清理桌面'))
  })

  it('空输入不炸', () => {
    expect(normalizeTaskCategory('')).toBe('')
  })
})

describe('M4-D 边际效用 (getMarginalUtility)', () => {
  let tracker: SkillEffectivenessTracker

  beforeEach(() => {
    vi.clearAllMocks()
    ;(SkillEffectivenessTracker as any).instance = undefined
    tracker = SkillEffectivenessTracker.getInstance()
  })

  /** 记一条技能级运行 */
  const rec = (skill: string, category: string, success: boolean) =>
    tracker.record({
      skillName: skill, unitType: 'skill', ts: Date.now(),
      durationMs: 0, success, category,
    })

  it('样本不足 → 不给差值(不给半成品结论)', () => {
    rec('S', 'cat', true)
    rec('S', 'cat', true)
    const u = tracker.getMarginalUtility('S')
    expect(u.insufficientData).toBe(true)
    expect(u.delta).toBeUndefined()
    expect(u.withSkill.runs).toBe(2)
  })

  it('同类别:带技能 100% vs 不带 40% → 差值 +0.6', () => {
    for (let i = 0; i < 5; i++) rec('S', 'cat', true)
    for (let i = 0; i < 5; i++) rec('OTHER', 'cat', i < 2)   // 2 成 3 败 = 40%
    const u = tracker.getMarginalUtility('S')
    expect(u.insufficientData).toBe(false)
    expect(u.withSkill.rate).toBe(1)
    expect(u.withoutSkill.rate).toBeCloseTo(0.4)
    expect(u.delta).toBeCloseTo(0.6)
  })

  it('负贡献:带技能 0% vs 不带 100% → 差值 −1', () => {
    for (let i = 0; i < 5; i++) rec('BAD', 'cat', false)
    for (let i = 0; i < 5; i++) rec('GOOD', 'cat', true)
    const u = tracker.getMarginalUtility('BAD')
    expect(u.delta).toBeCloseTo(-1)
  })

  it('【不同类别不参与对比】—— 否则会把"别的任务"混进来', () => {
    for (let i = 0; i < 5; i++) rec('S', 'catA', true)
    // 别的类别的运行再多也不算对比组
    for (let i = 0; i < 20; i++) rec('OTHER', 'catB', false)
    const u = tracker.getMarginalUtility('S')
    expect(u.withoutSkill.runs).toBe(0)
    expect(u.delta).toBeUndefined()
    expect(u.insufficientData).toBe(true)
  })

  it('工具级记录不参与技能效用对比(工具名不是技能名)', () => {
    for (let i = 0; i < 5; i++) {
      tracker.record({
        skillName: 'Read', unitType: 'tool', ts: Date.now(),
        durationMs: 1, success: true, category: 'cat',
      })
    }
    for (let i = 0; i < 5; i++) rec('S', 'cat', true)
    const u = tracker.getMarginalUtility('S')
    // Read 是工具级记录,不能进"同类别不带该技能"的对比组
    expect(u.withoutSkill.runs).toBe(0)
  })

  it('无类别的记录不参与对比(宁可样本少,不混口径)', () => {
    for (let i = 0; i < 5; i++) {
      tracker.record({
        skillName: 'S', unitType: 'skill', ts: Date.now(),
        durationMs: 0, success: true,   // 无 category
      })
    }
    const u = tracker.getMarginalUtility('S')
    expect(u.withSkill.runs).toBe(5)
    expect(u.withoutSkill.runs).toBe(0)
    expect(u.delta).toBeUndefined()
  })

  it('恒标记为观察性对比(消费方不得当因果结论用)', () => {
    rec('S', 'cat', true)
    expect(tracker.getMarginalUtility('S').observational).toBe(true)
  })

  it('listAllUtilities 按差值升序(最负的排最前)', () => {
    for (let i = 0; i < 5; i++) rec('GOOD', 'cat', true)
    for (let i = 0; i < 5; i++) rec('BAD', 'cat', false)
    for (let i = 0; i < 5; i++) rec('MID', 'cat', i < 3)
    const list = tracker.listAllUtilities()
    expect(list[0].skillName).toBe('BAD')
    expect(list[list.length - 1].skillName).toBe('GOOD')
  })
})

describe('M4-D 技能真实使用统计 (getSkillUsage)', () => {
  let tracker: SkillEffectivenessTracker

  beforeEach(() => {
    vi.clearAllMocks()
    ;(SkillEffectivenessTracker as any).instance = undefined
    tracker = SkillEffectivenessTracker.getInstance()
  })

  it('无记录 → undefined(UI 据此显示 "—" 而不是假的 100%)', () => {
    expect(tracker.getSkillUsage('never-used')).toBeUndefined()
  })

  it('有记录 → 真实次数与成功率', () => {
    tracker.record({ skillName: 'S', unitType: 'skill', ts: 1, durationMs: 0, success: true })
    tracker.record({ skillName: 'S', unitType: 'skill', ts: 2, durationMs: 0, success: false })
    const u = tracker.getSkillUsage('S')
    expect(u?.runs).toBe(2)
    expect(u?.successes).toBe(1)
    expect(u?.successRate).toBe(0.5)
  })

  it('工具级记录不计入技能的"使用次数"', () => {
    tracker.record({ skillName: 'Read', unitType: 'tool', ts: 1, durationMs: 1, success: true })
    expect(tracker.getSkillUsage('Read')).toBeUndefined()
  })
})
