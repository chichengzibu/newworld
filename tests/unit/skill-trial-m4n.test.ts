/**
 * PiPiClaw — M4-N 受控对照的结论增强测试
 * ═══════════════════════════════════════════════════════════════════════
 * 【这一批在测什么】
 * ① **综合分差**:二元「成功/失败」丢掉的信息(一次错 1 个工具 vs 一次错 5 个,
 *    二元都是"失败")能不能被找回来。
 * ② **pairwise 裁判路径**:正反两次顺序**一致才采信**,不一致记 'unstable'
 *    —— M4-J 实测本地裁判的换序改口率 68~80%,单次顺序的比较没有信息量。
 * ③ **裁判不改判定**(D7:LLM 裁判层保持默认关闭)—— pairwise 只进说明。
 *
 * 【本测试不联网、不调模型】执行器与裁判都是本地假实现。
 */
import { describe, it, expect } from 'vitest'
import type { GradableRun } from '../../electron/learning/TaskGrader'
import {
  runSkillTrial, summarize,
  type TrialTask, type TrialExecutor,
} from '../../electron/learning/SkillTrial'
import type { PairwiseJudge, PairwiseVerdict } from '../../electron/learning/RunJudge'

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

/** 两次都失败,但带技能那次"错得更少"(相似度更高) */
const executorBothFailButScored: TrialExecutor = async (task, opts) => {
  const withSkill = opts.suppressedSkills.length === 0
  return okRun({
    // 两次都有工具失败 → 两次都不通过(二元差值 = 0)
    hadToolFailure: true,
    toolsUsed: ['Glob'],
    // 但带技能那次答得更像参考答案 → 相似度层分数更高
    answer: withSkill ? '已完成,PDF 已归档到 D:/Documents/PDF' : '大概弄好了吧',
    referenceAnswer: '已完成,PDF 已归档到 D:/Documents/PDF',
  })
}

describe('M4-N 综合分差(二元判定丢掉的信息)', () => {
  it('每个配对都算出 scoreDelta', async () => {
    const res = await runSkillTrial('s1', tasks(3), executorBothFailButScored)
    expect(res.pairs.length).toBe(3)
    for (const p of res.pairs) {
      expect(typeof p.scoreDelta).toBe('number')
      // 带技能那次分数更高 → 正分差
      expect(p.scoreDelta).toBeGreaterThan(0)
      // 二元上两次都失败 → 二元差值是 0(信息被丢掉了)
      expect(p.delta).toBe(0)
    }
  })

  it('summarize 给出综合分差均值与方向', async () => {
    const res = await runSkillTrial('s1', tasks(5), executorBothFailButScored)
    expect(res.summary.meanScoreDelta).toBeGreaterThan(0)
    expect(res.summary.scoreDeltaDirection).toBe('consistent_with')
  })

  it('二元结论"看不出差别" + 综合分差一致且够大 → 说明里补一句(不瞒着用户)', async () => {
    const res = await runSkillTrial('s1', tasks(5), executorBothFailButScored)
    // 二元判定仍是 neutral(准入门不动)
    expect(res.summary.verdict).toBe('neutral')
    // 但说明里要点出"综合分上有稳定差异"
    expect(res.summary.note).toContain('综合分有稳定差异')
  })

  it('综合分差方向不一致(mixed)→ 不下"有差异"的结论', () => {
    const mkPair = (scoreDelta: number) => ({
      task: { id: 'x', instruction: 'x' },
      withSkill: { variant: 'with_skill' as const, run: okRun(), grade: { passed: false, score: 0.5, layers: [] } },
      withoutSkill: { variant: 'without_skill' as const, run: okRun(), grade: { passed: false, score: 0.5 - scoreDelta, layers: [] } },
      delta: 0,
      scoreDelta,
    })
    const sum = summarize(5, [mkPair(0.2), mkPair(-0.2)])
    expect(sum.scoreDeltaDirection).toBe('mixed')
    expect(sum.note).not.toContain('综合分有稳定差异')
  })
})

describe('M4-N pairwise 裁判(换序双向 + 一致性要求)', () => {
  /** 永远说"第一个更好" —— 典型的位置偏置裁判 */
  const alwaysFirst: PairwiseJudge = async () => ({ winner: 'a', reason: '第一个更好' })

  it('正反两次结论一致 → 采信为 with_better', async () => {
    // 一个"按内容判断"的裁判:带技能那次多调了 Write(工具列表可区分)
    const byContent: PairwiseJudge = async (a) => {
      const isWith = (a.toolsUsed ?? []).includes('Write')
      return { winner: isWith ? 'a' : 'b' }
    }
    // 正着跑:带技能是 a → 说 a 更好 = 带技能更好
    // 反着跑:不带技能是 a → 说 b 更好 = 带技能更好 → 两次一致 → with_better
    const executor: TrialExecutor = async (task, opts) => {
      const withSkill = opts.suppressedSkills.length === 0
      return okRun({
        toolsUsed: withSkill ? ['Glob', 'Write'] : ['Glob'],
        hadToolFailure: true,
      })
    }
    const res = await runSkillTrial('s1', tasks(5), executor, {
      pairwiseJudge: byContent,
      judgeSampleRate: 1,
    })
    for (const p of res.pairs) {
      expect(p.pairwise).toBe('with_better')
    }
    expect(res.summary.pairwise?.withBetter).toBe(5)
  })

  it('正反两次结论不一致 → unstable(不是"平局")', async () => {
    const res = await runSkillTrial('s1', tasks(5), executorBothFailButScored, {
      pairwiseJudge: alwaysFirst,
      judgeSampleRate: 1,
    })
    for (const p of res.pairs) {
      expect(p.pairwise).toBe('unstable')
    }
    expect(res.summary.pairwise?.unstable).toBe(5)
    // 说明里要点明"顺序敏感,不可当结论用"
    expect(res.summary.pairwise?.note).toContain('顺序敏感')
  })

  it('裁判输出无法解析(unknown)→ unstable,不当成平局', async () => {
    const broken: PairwiseJudge = async () => ({ winner: 'unknown' })
    const res = await runSkillTrial('s1', tasks(5), executorBothFailButScored, {
      pairwiseJudge: broken,
      judgeSampleRate: 1,
    })
    for (const p of res.pairs) {
      expect(p.pairwise).toBe('unstable')
    }
  })

  it('裁判不改判定(D7:裁判层保持默认关闭,结论不随裁判漂移)', async () => {
    const withJudge = await runSkillTrial('s1', tasks(5), executorBothFailButScored, {
      pairwiseJudge: alwaysFirst,
      judgeSampleRate: 1,
    })
    const withoutJudge = await runSkillTrial('s1', tasks(5), executorBothFailButScored)
    expect(withJudge.summary.verdict).toBe(withoutJudge.summary.verdict)
    expect(withJudge.summary.delta).toBe(withoutJudge.summary.delta)
  })

  it('不传 pairwiseJudge → 不产生任何 pairwise 字段', async () => {
    const res = await runSkillTrial('s1', tasks(5), executorBothFailButScored)
    expect(res.summary.pairwise).toBeUndefined()
    for (const p of res.pairs) {
      expect(p.pairwise).toBeUndefined()
    }
  })
})
