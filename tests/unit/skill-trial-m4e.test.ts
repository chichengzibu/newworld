/**
 * PiPiClaw — M4-E 评分器与对照实验测试
 * ═══════════════════════════════════════════════════════════════
 * 【这一批在测什么】
 * ① TaskGrader:分层判定的**口径** —— 硬信号必须过、结构约束按需、
 *    相似度只作参考(话术像但没做成,不能算成功)。
 * ② SkillTrial:配对对照的**统计口径** —— 样本不足不给结论、
 *    执行故障不计入统计、差值门槛 ±0.1。
 *
 * 【本测试不联网、不调模型】执行器是本地假实现。
 */
import { describe, it, expect } from 'vitest'
import { gradeRun, cosineSimilarity, type GradableRun } from '../../electron/learning/TaskGrader'
import {
  runSkillTrial, summarize,
  TRIAL_MIN_TASKS, TRIAL_DELTA_THRESHOLD,
  type TrialTask, type TrialExecutor,
} from '../../electron/learning/SkillTrial'

const okRun = (over: Partial<GradableRun> = {}): GradableRun => ({
  instruction: '把桌面上的 PDF 归档到 D:/Documents/PDF',
  answer: '已完成,PDF 已归档到 D:/Documents/PDF',
  toolsUsed: ['Glob', 'Write'],
  hadToolFailure: false,
  hadError: false,
  producedAnswer: true,
  ...over,
})

describe('M4-E TaskGrader — 分层判定', () => {
  it('全部正常 → 通过', () => {
    const r = gradeRun(okRun())
    expect(r.passed).toBe(true)
    expect(r.score).toBe(1)
  })

  it('硬信号:工具失败 → 不通过(哪怕答复很像)', () => {
    const r = gradeRun(okRun({ hadToolFailure: true }))
    expect(r.passed).toBe(false)
    expect(r.failedReason).toContain('工具调用失败')
  })

  it('硬信号:运行级错误 → 不通过', () => {
    const r = gradeRun(okRun({ hadError: true }))
    expect(r.passed).toBe(false)
  })

  it('硬信号:没产出最终答复 → 不通过', () => {
    const r = gradeRun(okRun({ producedAnswer: false }))
    expect(r.passed).toBe(false)
  })

  it('结构约束:必须调用的工具没调 → 不通过', () => {
    const r = gradeRun(okRun(), { mustCall: ['Write', 'Bash'] })
    expect(r.passed).toBe(false)
    expect(r.failedReason).toContain('未调用 Bash')
  })

  it('结构约束:不该调的工具调了 → 不通过', () => {
    const r = gradeRun(okRun({ toolsUsed: ['Glob', 'Bash'] }), { mustNotCall: ['Bash'] })
    expect(r.passed).toBe(false)
    expect(r.failedReason).toContain('不应调用')
  })

  it('结构约束:答复缺少关键内容 → 不通过', () => {
    const r = gradeRun(okRun(), { mustContain: ['D:/Documents/PDF'] })
    expect(r.passed).toBe(true)   // 答复里有 → 通过
    const r2 = gradeRun(okRun({ answer: '已完成' }), { mustContain: ['D:/Documents/PDF'] })
    expect(r2.passed).toBe(false)
    expect(r2.failedReason).toContain('缺少')
  })

  it('相似度**单独不决定成败**(话术像但没做成,不能算成功)', () => {
    const r = gradeRun(
      okRun({ hadToolFailure: true, referenceAnswer: '已完成,PDF 已归档到 D:/Documents/PDF' }),
      {},
    )
    const sim = r.layers.find(l => l.name === 'similarity')!
    expect(sim.score).toBeGreaterThan(0.5)   // 相似度高
    expect(sim.passed).toBeUndefined()        // 但不作为判定依据
    expect(r.passed).toBe(false)              // 硬信号失败 → 整体失败
  })

  it('没有结构约束时,structural 层跳过而不是给假分', () => {
    const r = gradeRun(okRun())
    const st = r.layers.find(l => l.name === 'structural')!
    expect(st.passed).toBeUndefined()
    expect(st.detail).toContain('跳过')
  })

  it('余弦相似度:相近文本高、无关文本低(中文友好)', () => {
    const a = cosineSimilarity('把桌面上的 PDF 归档到 D 盘', '将桌面的 PDF 归到 D 盘')
    const b = cosineSimilarity('把桌面上的 PDF 归档到 D 盘', '今天天气很好适合散步')
    expect(a).toBeGreaterThan(b)
  })
})

describe('M4-E SkillTrial — 配对对照', () => {
  /** 假执行器:带技能时成功,不带时失败(模拟"技能确实有用") */
  const executorWithEffect = (effect: boolean): TrialExecutor => async (task) => {
    const usedSkill = task.id === 'with' || effect
    return okRun({
      toolsUsed: usedSkill ? ['Glob', 'Write'] : ['Glob'],
      producedAnswer: true,
    })
  }

  const tasks = (n: number): TrialTask[] =>
    Array.from({ length: n }, (_, i) => ({ id: `t${i}`, instruction: '任务' }))

  it('每个任务跑两遍:一遍带技能、一遍禁技能', async () => {
    const calls: Array<{ id: string; suppressed: string[] }> = []
    const executor: TrialExecutor = async (task, opts) => {
      calls.push({ id: task.id, suppressed: opts.suppressedSkills })
      return okRun()
    }
    await runSkillTrial('my-skill', tasks(1), executor)

    expect(calls.length).toBe(2)
    expect(calls[0].suppressed).toEqual([])              // 带技能
    expect(calls[1].suppressed).toEqual(['my-skill'])    // 禁技能
  })

  it('技能确实有用 → 差值为正,结论 positive', async () => {
    // 带技能的成功、不带技能的失败
    const executor: TrialExecutor = async (task, opts) => {
      const withSkill = opts.suppressedSkills.length === 0
      return okRun({
        toolsUsed: withSkill ? ['Glob', 'Write'] : ['Glob'],
        // 不带技能时"没做成"
        producedAnswer: withSkill,
      })
    }
    const r = await runSkillTrial('s', tasks(6), executor)
    expect(r.summary.n).toBe(6)
    expect(r.summary.withSkillSuccesses).toBe(6)
    expect(r.summary.withoutSkillSuccesses).toBe(0)
    expect(r.summary.delta).toBe(1)
    expect(r.summary.verdict).toBe('positive')
  })

  it('技能有害 → 差值为负,结论 negative', async () => {
    const executor: TrialExecutor = async (_task, opts) => {
      const withSkill = opts.suppressedSkills.length === 0
      return okRun({ producedAnswer: !withSkill })   // 带技能反而做不成
    }
    const r = await runSkillTrial('s', tasks(6), executor)
    expect(r.summary.delta).toBe(-1)
    expect(r.summary.verdict).toBe('negative')
  })

  it('样本不足 → 不给结论(insufficient_data)', async () => {
    const r = await runSkillTrial('s', tasks(TRIAL_MIN_TASKS - 1), async () => okRun())
    expect(r.summary.n).toBe(TRIAL_MIN_TASKS - 1)
    expect(r.summary.verdict).toBe('insufficient_data')
    expect(r.summary.note).toContain('样本')
  })

  it('执行故障的任务**不计入**统计(实验故障 ≠ 任务失败)', async () => {
    let n = 0
    const executor: TrialExecutor = async (_task, opts) => {
      n++
      // 第一个任务的「不带技能」变体抛错
      if (n === 2) throw new Error('执行炸了')
      return okRun()
    }
    const r = await runSkillTrial('s', tasks(6), executor)
    expect(r.summary.n).toBe(5)          // 少了一个
    expect(r.pairs.length).toBe(5)
  })

  it('差值在门槛以内 → neutral(不是"略有效")', async () => {
    // 6 个任务里 1 个有差别 → delta = 1/6 ≈ 0.167 > 0.1 → 其实是 positive
    // 改用 10 个任务里 1 个 → delta = 0.1 → 不大于门槛 → neutral
    const executor: TrialExecutor = async (task, opts) => {
      const withSkill = opts.suppressedSkills.length === 0
      const ok = withSkill ? task.id !== 't0' : true
      return okRun({ producedAnswer: ok })
    }
    const r = await runSkillTrial('s', tasks(10), executor)
    expect(Math.abs(r.summary.delta)).toBeLessThanOrEqual(TRIAL_DELTA_THRESHOLD)
    expect(r.summary.verdict).toBe('neutral')
  })

  it('summarize 是纯函数 —— 同样的配对给同样的结论', () => {
    const fakePairs = [] as any[]
    const s = summarize(0, fakePairs)
    expect(s.n).toBe(0)
    expect(s.verdict).toBe('insufficient_data')
  })

})

describe('M4-AE 对照实验的统计支撑（参照 inspect_ai / McNemar 配对检验）', () => {
  const tasks = (n: number): TrialTask[] =>
    Array.from({ length: n }, (_, i) => ({ id: `t${i}`, instruction: `任务${i}` }))

  /** 每个配对都是"带技能成、不带技能败" */
  const perfectExecutor: TrialExecutor = async (_task, opts) => {
    const withSkill = opts.suppressedSkills.length === 0
    return okRun({ producedAnswer: withSkill })
  }

  it('【关键】5 个配对全对全错 → 方向为正,但**不冒充结论**', async () => {
    const r = await runSkillTrial('s', tasks(5), perfectExecutor)
    expect(r.summary.delta).toBe(1)                     // 效应量看起来"完美"
    expect(r.summary.stats.pValue).toBeCloseTo(0.0625, 4) // 但精确检验 p > 0.05
    expect(r.summary.verdict).toBe('insufficient_data') // 所以不给 positive
    expect(r.summary.note).toContain('不冒充结论')
  })

  it('6 个配对全对全错 → 达到精确检验门槛 → positive', async () => {
    const r = await runSkillTrial('s', tasks(6), perfectExecutor)
    expect(r.summary.stats.pValue).toBeLessThan(0.05)
    expect(r.summary.verdict).toBe('positive')
    expect(r.summary.note).toContain('McNemar p=')
    expect(r.summary.note).toContain('95% CI')
  })

  it('统计字段齐全:不一致对数 / 两类 CI', async () => {
    const r = await runSkillTrial('s', tasks(6), perfectExecutor)
    const st = r.summary.stats
    expect(st.withOnly).toBe(6)
    expect(st.withoutOnly).toBe(0)
    expect(st.binaryCI.low).toBeLessThanOrEqual(st.binaryCI.high)
    expect(st.scoreCI.low).toBeLessThanOrEqual(st.scoreCI.high)
  })

  it('方向过门槛但样本不足 → 说明里给出"约还需要多少对"', async () => {
    // 10 个配对里 3 个"带技能赢" → delta=0.3 过门槛,但 McNemar 不显著
    let call = 0
    const exec: TrialExecutor = async (_t, opts) => {
      const withSkill = opts.suppressedSkills.length === 0
      const idx = Math.floor(call / 2)
      call++
      const ok = withSkill || idx >= 3
      return okRun({ producedAnswer: ok })
    }
    const r = await runSkillTrial('s', tasks(10), exec)
    expect(r.summary.delta).toBeCloseTo(0.3, 6)
    expect(r.summary.stats.pValue).toBeGreaterThan(0.05)
    expect(r.summary.verdict).toBe('insufficient_data')
    expect(r.summary.note).toContain('约需')
    // 外推的总对数必须比现在多（3/10 的不一致率下,要显著需要更多配对）
    expect(r.summary.stats.requiredPairs ?? 0).toBeGreaterThan(10)
  })
})
