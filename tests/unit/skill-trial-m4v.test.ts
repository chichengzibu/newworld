/**
 * New World — 裁判对照的接线与门禁(M4-V)
 * ═══════════════════════════════════════════════════════════════════════
 * 【这一批在测什么】
 * 把 D7「LLM 裁判层保持默认关闭」从注释变成**会拦人的门**之后,
 * 门本身的行为必须被钉住:
 *
 *   ① 门禁不放行 → 裁判**一次都不被调用**(省下两次模型调用/配对)
 *   ② 门禁放行   → 裁判正常调用,结果照旧
 *   ③ 传了裁判但**没给凭据** → 同样不放行(注释挡不住人,门才能)
 *   ④ 没请求裁判 → 连"裁判状态"都不提(用户没开这个开关)
 *   ⑤ 被拦下时 → 结果里**写明为什么**(M4-S 的教训:输出层不能一片空白)
 *
 * 【本测试不联网、不调模型】裁判是本地假实现,用调用次数计数。
 */
import { describe, it, expect } from 'vitest'
import type { GradableRun } from '../../electron/learning/TaskGrader'
import { runSkillTrial, type TrialTask, type TrialExecutor } from '../../electron/learning/SkillTrial'
import type { PairwiseJudge } from '../../electron/learning/RunJudge'

const okRun = (over: Partial<GradableRun> = {}): GradableRun => ({
  instruction: '把桌面上的 PDF 归档到 D:/Documents/PDF',
  answer: '已完成,PDF 已归档到 D:/Documents/PDF',
  toolsUsed: ['Glob', 'Write'],
  hadToolFailure: false,
  hadError: false,
  producedAnswer: true,
  ...over,
})

const tasks = (n: number): TrialTask[] =>
  Array.from({ length: n }, (_, i) => ({ id: `t${i}`, instruction: `任务${i}` }))

const executor: TrialExecutor = async (task, opts) =>
  okRun({ toolsUsed: opts.suppressedSkills.length === 0 ? ['Glob', 'Write'] : ['Glob'] })

/** 会数调用次数的假裁判 */
const countingJudge = (): { judge: PairwiseJudge; calls: () => number } => {
  let calls = 0
  return {
    judge: async () => { calls++; return { winner: 'a' as const } },
    calls: () => calls,
  }
}

const trustedGate = { trusted: true, reason: '已通过校准门禁', basis: 'κ=0.72,n=220' }
const blockedGate = {
  trusted: false,
  reason: 'κ=0.411 < 门槛 0.6；换序改口率 67.9% > 门槛 10%',
}

describe('M4-V 裁判门禁(不跑,而不是跑了再说)', () => {
  it('门禁不放行 → 裁判一次都不被调用', async () => {
    const { judge, calls } = countingJudge()
    const res = await runSkillTrial('s1', tasks(5), executor, {
      pairwiseJudge: judge,
      pairwiseGate: blockedGate,
      judgeSampleRate: 1,
    })
    expect(calls()).toBe(0)
    // 结果里没有任何 pairwise 结论
    expect(res.summary.pairwise).toBeUndefined()
    for (const p of res.pairs) {
      expect(p.pairwise).toBeUndefined()
    }
  })

  it('门禁不放行 → 结果里写明为什么(不静默)', async () => {
    const { judge } = countingJudge()
    const res = await runSkillTrial('s1', tasks(5), executor, {
      pairwiseJudge: judge,
      pairwiseGate: blockedGate,
      judgeSampleRate: 1,
    })
    expect(res.summary.judgeStatus).toBeDefined()
    expect(res.summary.judgeStatus?.ran).toBe(false)
    expect(res.summary.judgeStatus?.trusted).toBe(false)
    expect(res.summary.judgeStatus?.reason).toContain('κ=0.411')
  })

  it('传了裁判但没给凭据 → 同样不放行(门才能挡住"忘了走流程")', async () => {
    const { judge, calls } = countingJudge()
    const res = await runSkillTrial('s1', tasks(5), executor, {
      pairwiseJudge: judge,
      judgeSampleRate: 1,
    })
    expect(calls()).toBe(0)
    expect(res.summary.judgeStatus?.ran).toBe(false)
    expect(res.summary.judgeStatus?.reason).toContain('放行凭据')
  })

  it('门禁放行 → 裁判正常调用,结论照旧', async () => {
    const { judge, calls } = countingJudge()
    const res = await runSkillTrial('s1', tasks(5), executor, {
      pairwiseJudge: judge,
      pairwiseGate: trustedGate,
      judgeSampleRate: 1,
    })
    // 5 个任务 × 正反两次 = 10 次调用
    expect(calls()).toBe(10)
    expect(res.summary.judgeStatus?.ran).toBe(true)
    expect(res.summary.judgeStatus?.trusted).toBe(true)
    expect(res.summary.judgeStatus?.reason).toContain('κ=0.72')
    expect(res.summary.pairwise?.n).toBe(5)
  })

  it('没请求裁判 → 连裁判状态都不提(用户没开这个开关)', async () => {
    const res = await runSkillTrial('s1', tasks(5), executor)
    expect(res.summary.judgeStatus).toBeUndefined()
    expect(res.summary.pairwise).toBeUndefined()
  })

  it('放行但采样率把样本全滤掉 → 说清楚"没产生任何裁判调用"', async () => {
    const { judge, calls } = countingJudge()
    const res = await runSkillTrial('s1', tasks(5), executor, {
      pairwiseJudge: judge,
      pairwiseGate: trustedGate,
      judgeSampleRate: 0,
    })
    expect(calls()).toBe(0)
    expect(res.summary.judgeStatus?.ran).toBe(false)
    expect(res.summary.judgeStatus?.reason).toContain('采样率')
  })

  it('裁判被门禁拦下时,主结论完全不受影响', async () => {
    const { judge } = countingJudge()
    const blocked = await runSkillTrial('s1', tasks(5), executor, {
      pairwiseJudge: judge,
      pairwiseGate: blockedGate,
      judgeSampleRate: 1,
    })
    const plain = await runSkillTrial('s1', tasks(5), executor)
    expect(blocked.summary.verdict).toBe(plain.summary.verdict)
    expect(blocked.summary.delta).toBe(plain.summary.delta)
    expect(blocked.summary.n).toBe(plain.summary.n)
  })
})
