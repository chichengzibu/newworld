/**
 * New World — 对照实验的重复运行（M4-AF）
 * ═══════════════════════════════════════════════════════════════════════
 * 【这一批在测什么】
 * 单次运行自带随机性：同一任务、同一技能，一次成功一次失败并不罕见。
 * 拿"这一次"当"这个技能的效果"，就是把噪声当信号。
 *
 * 参照 **inspect_ai 的 epochs**：同一任务重复采样，再归约。我们取：
 *   - 二值 → **多数票**（平票按不通过，保守）
 *   - 连续分 → **均值**
 *   - 点式裁判只在第一遍上跑（裁判是一次模型调用，不能跟着重复数翻倍）
 *
 * 【本测试不联网、不调模型】执行器是本地假实现。
 */
import { describe, it, expect } from 'vitest'

import type { GradableRun } from '../../electron/learning/TaskGrader'
import { runSkillTrial, type TrialTask, type TrialExecutor } from '../../electron/learning/SkillTrial'

const okRun = (over: Partial<GradableRun> = {}): GradableRun => ({
  instruction: '整理文件',
  answer: '已完成',
  toolsUsed: ['Glob'],
  hadToolFailure: false,
  hadError: false,
  producedAnswer: true,
  ...over,
})

const tasks = (n: number): TrialTask[] =>
  Array.from({ length: n }, (_, i) => ({ id: `t${i}`, instruction: `任务${i}` }))

describe('M4-AF 重复运行 + 归约', () => {
  it('repeats=3 → 调用次数 = 任务数 × 2 变体 × 3', async () => {
    let calls = 0
    const exec: TrialExecutor = async () => {
      calls++
      return okRun()
    }
    const r = await runSkillTrial('s', tasks(5), exec, { repeats: 3 })
    expect(calls).toBe(5 * 2 * 3)
    expect(r.summary.repeats).toBe(3)
  })

  it('缺省不重复（repeats=1）—— 行为与之前一致', async () => {
    let calls = 0
    const exec: TrialExecutor = async () => {
      calls++
      return okRun()
    }
    const r = await runSkillTrial('s', tasks(5), exec)
    expect(calls).toBe(5 * 2)
    expect(r.summary.repeats).toBe(1)
  })

  it('多数票：3 遍里 2 遍成功 → 该变体算成功', async () => {
    let call = 0
    const exec: TrialExecutor = async (_t, o) => {
      const withSkill = o.suppressedSkills.length === 0
      const i = call++
      if (withSkill) return okRun({ producedAnswer: i !== 2 }) // 0,1 成功;2 失败
      return okRun({ producedAnswer: false })                   // 不带技能全失败
    }
    const r = await runSkillTrial('s', tasks(1), exec, { repeats: 3 })
    expect(r.pairs).toHaveLength(1)
    expect(r.pairs[0].withSkill.grade.passed).toBe(true) // 2/3 → 多数票通过
    expect(r.pairs[0].delta).toBe(1)
  })

  it('多数票：3 遍里只有 1 遍成功 → 该变体算失败（平票不够也按失败）', async () => {
    let call = 0
    const exec: TrialExecutor = async (_t, o) => {
      const withSkill = o.suppressedSkills.length === 0
      const i = call++
      if (withSkill) return okRun({ producedAnswer: i !== 1 && i !== 2 }) // 只有第 0 遍成功
      return okRun({ producedAnswer: false })
    }
    const r = await runSkillTrial('s', tasks(1), exec, { repeats: 3 })
    expect(r.pairs[0].withSkill.grade.passed).toBe(false) // 1/3 → 失败
    expect(r.pairs[0].delta).toBe(0)
  })

  it('某变体所有重复都抛错 → 该任务不计入（实验故障 ≠ 任务失败）', async () => {
    let call = 0
    const exec: TrialExecutor = async (_t, o) => {
      const withSkill = o.suppressedSkills.length === 0
      const i = call++
      if (!withSkill) throw new Error('不带技能这一组全炸') // 第 3..5 次
      void i
      return okRun()
    }
    const r = await runSkillTrial('s', tasks(2), exec, { repeats: 3 })
    expect(r.pairs).toHaveLength(0)
    expect(r.summary.n).toBe(0)
  })

  it('部分重复失败 → 用成功的那几遍归约（不整组作废）', async () => {
    let call = 0
    const exec: TrialExecutor = async (_t, o) => {
      const withSkill = o.suppressedSkills.length === 0
      const i = call++
      if (i === 1) throw new Error('偶发故障') // 带技能的第 2 遍炸
      return okRun({ producedAnswer: withSkill })
    }
    const r = await runSkillTrial('s', tasks(1), exec, { repeats: 3 })
    expect(r.pairs).toHaveLength(1)
    expect(r.pairs[0].withSkill.grade.passed).toBe(true) // 2 遍成功 → 多数票
  })
})
