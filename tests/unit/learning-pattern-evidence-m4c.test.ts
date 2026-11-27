/**
 * New World — M4-C 模式证据链测试
 * ═══════════════════════════════════════════════════════════════
 * 【为什么这一批重要】
 * 业界实测:自生成技能的平均收益**接近零甚至为负** —— 瓶颈不在存储,
 * 在「生成」与「验证」。而旧实现的生成方式是:
 *   把最近 10 条观察的【指令文本】丢给模型,问"它们的共同模式是什么",
 *   然后把【最后一次】观察的步骤抄进技能。
 *
 * 三个问题,每条断言对应一个:
 *   ① 那 10 条可能互不相关 → 模型只能编一个共同模式(幻觉来源)
 *   ② 模型拿不到任何执行证据 → 不知道跑了几次、成没成、做了哪些操作
 *   ③ 抄最后一次的步骤 → 含一次性动作,且 agent loop 的步骤形状
 *      ({name, ok, durationMs})取不到 description/type → 产出"执行 undefined"
 *
 * 【M4-C 的做法】
 *   先选(聚类 + 支持度/成功率门槛),再归纳(把轨迹证据交给模型),
 *   提案带证据链(可溯源、可核对)。
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import * as fs from 'node:fs'
import * as path from 'node:path'

vi.mock('../../electron/models/ModelManager', () => ({
  ModelManager: { getInstance: () => ({ getEnabledProviders: () => [] }) },
}))

import { SelfLearner } from '../../electron/learning/SelfLearner'
import { getHost } from '../../electron/platform/runtime'

const LEARNING_DIR = path.join(getHost().getPath('userData'), 'hermes-learning')

function resetLearner() {
  ;(SelfLearner as unknown as { instance: SelfLearner | null }).instance = null
  const f = path.join(LEARNING_DIR, 'observations.json')
  if (fs.existsSync(f)) fs.rmSync(f, { force: true })
}

/** 造一条观察(M4-C 后 observations 带 trajectories) */
function pushObs(
  learner: any,
  instruction: string,
  opts: {
    occurrences?: number
    outcome?: 'ok' | 'fail' | 'partial'
    steps?: any[]
    toolsUsed?: string[]
    trajectoryId?: string
  } = {},
) {
  const outcome = opts.outcome ?? 'ok'
  learner.observations.push({
    id: `obs-${learner.observations.length}`,
    instruction,
    steps: opts.steps ?? [],
    timestamp: Date.now(),
    occurrences: opts.occurrences ?? 1,
    outcome,
    trajectories: [
      {
        ts: Date.now(),
        outcome,
        steps: opts.steps ?? [],
        ...(opts.toolsUsed ? { toolsUsed: opts.toolsUsed } : {}),
        ...(opts.trajectoryId ? { trajectoryId: opts.trajectoryId } : {}),
      },
    ],
  })
}

describe('M4-C 候选模式选择 (selectCandidatePattern)', () => {
  let learner: any

  beforeEach(() => {
    resetLearner()
    learner = SelfLearner.getInstance()
  })
  afterEach(() => resetLearner())

  it('支持度不足 → 不选(不把偶然当模式)', () => {
    for (let i = 0; i < 5; i++) pushObs(learner, `一次性 ${i}`, { occurrences: 1 })
    const c = learner.selectCandidatePattern(learner.observations)
    expect(c).toBeNull()
  })

  it('支持度达标 → 选中,且支持度 = occurrences 之和', () => {
    pushObs(learner, '重复的模式', { occurrences: 3 })
    pushObs(learner, '重复的模式', { occurrences: 4 })
    const c = learner.selectCandidatePattern(learner.observations)
    expect(c).not.toBeNull()
    expect(c.evidence.supportCount).toBe(7)
  })

  it('成功率不足 → 不选(失败的模式不值得固化成技能)', () => {
    // 3 次支持,但轨迹证据里 2 次失败 1 次成功 → 成功率 33% < 50%
    pushObs(learner, '常失败', { occurrences: 3, outcome: 'fail' })
    pushObs(learner, '常失败', { occurrences: 3, outcome: 'fail' })
    pushObs(learner, '常失败', { occurrences: 3, outcome: 'ok' })
    const c = learner.selectCandidatePattern(learner.observations)
    expect(c).toBeNull()
  })

  it('成功率的分母是"有逐次证据的运行数",不是支持度(分母混用会系统性低估)', () => {
    // support=15 但只有 3 次逐次证据(2 成 1 败)→ 成功率 67% ≥ 50% → 应选中
    // 若错用 supportCount 当分母 → 3/15 = 20% → 会被误杀
    pushObs(learner, '分母测试', { occurrences: 5, outcome: 'ok' })
    pushObs(learner, '分母测试', { occurrences: 5, outcome: 'fail' })
    pushObs(learner, '分母测试', { occurrences: 5, outcome: 'ok' })
    const c = learner.selectCandidatePattern(learner.observations)
    expect(c).not.toBeNull()
    expect(c.evidence.supportCount).toBe(15)
    expect(c.evidence.successfulAttempts).toBe(2)
    expect(c.evidence.failedAttempts).toBe(1)
  })

  it('多个模式时选支持度最高的', () => {
    pushObs(learner, '弱模式', { occurrences: 2 })
    pushObs(learner, '强模式', { occurrences: 9 })
    const c = learner.selectCandidatePattern(learner.observations)
    expect(c.instruction).toBe('强模式')
  })

  it('失败也保留在证据里(提案不该只展示成功的一面)', () => {
    pushObs(learner, '一半失败', { occurrences: 4, outcome: 'ok' })
    pushObs(learner, '一半失败', { occurrences: 4, outcome: 'fail' })
    const c = learner.selectCandidatePattern(learner.observations)
    expect(c.evidence.successfulAttempts).toBe(1)
    expect(c.evidence.failedAttempts).toBe(1)
  })
})

describe('M4-C 共同步骤归纳 (deriveCommonSteps)', () => {
  let learner: any

  beforeEach(() => {
    resetLearner()
    learner = SelfLearner.getInstance()
  })
  afterEach(() => resetLearner())

  it('只保留出现在半数以上成功轨迹里的步骤(剔除一次性动作)', () => {
    const steps = (n: number) => [
      { description: '读配置文件', ok: true },
      { description: '写入结果', ok: true },
      ...(n === 0 ? [{ description: '顺手删了个临时文件', ok: true }] : []),
    ]
    const trajectories = [
      { ts: 1, outcome: 'ok' as const, steps: steps(0) },
      { ts: 2, outcome: 'ok' as const, steps: steps(1) },
      { ts: 3, outcome: 'ok' as const, steps: steps(1) },
    ]
    const common = learner.deriveCommonSteps(trajectories)
    expect(common).toContain('读配置文件')
    expect(common).toContain('写入结果')
    expect(common).not.toContain('顺手删了个临时文件')
  })

  it('无交集时退回第一条轨迹的步骤(宁可给具体,不给空)', () => {
    const trajectories = [
      { ts: 1, outcome: 'ok' as const, steps: [{ description: 'A' }] },
      { ts: 2, outcome: 'ok' as const, steps: [{ description: 'B' }] },
    ]
    const common = learner.deriveCommonSteps(trajectories)
    expect(common.length).toBeGreaterThan(0)
    expect(common[0]).toBe('A')
  })

  it('agent loop 的步骤形状({name, ok})也能归纳出名字', () => {
    const trajectories = [
      { ts: 1, outcome: 'ok' as const, steps: [{ name: 'Read', ok: true }, { name: 'Edit', ok: true }] },
      { ts: 2, outcome: 'ok' as const, steps: [{ name: 'Read', ok: true }, { name: 'Edit', ok: true }] },
    ]
    const common = learner.deriveCommonSteps(trajectories)
    expect(common).toEqual(['Read', 'Edit'])
  })
})

describe('M4-C 步骤摘要 (summarizeSteps)', () => {
  let learner: any

  beforeEach(() => {
    resetLearner()
    learner = SelfLearner.getInstance()
  })
  afterEach(() => resetLearner())

  it('agent loop 形状 → 取 name,不产出"执行 undefined"', () => {
    const out = learner.summarizeSteps([{ name: 'Read', ok: true, durationMs: 12 }])
    expect(out[0].name).toBe('Read')
    expect(out[0].ok).toBe(true)
    expect(JSON.stringify(out)).not.toContain('undefined')
  })

  it('TaskExecutor 形状 → 取 type/description,status 转 ok', () => {
    const out = learner.summarizeSteps([
      { type: 'run_command', description: '跑命令', status: 'success', startTime: 1, endTime: 2 },
      { type: 'write_file', status: 'failed', error: 'EACCES' },
    ])
    expect(out[0].description).toBe('跑命令')
    expect(out[0].ok).toBe(true)
    expect(out[1].ok).toBe(false)
    expect(out[1].error).toBe('EACCES')
  })

  it('extractOperationSteps 兜底不再产出"执行 undefined"', () => {
    const out = learner.extractOperationSteps([{ name: 'Read', ok: true }])
    expect(out).toEqual(['Read'])
    expect(out.join('')).not.toContain('undefined')
  })
})

describe('M4-C 提示词与提案', () => {
  let learner: any
  let promptSpy: any

  beforeEach(() => {
    resetLearner()
    learner = SelfLearner.getInstance()
    promptSpy = vi
      .spyOn(SelfLearner.prototype as any, 'callModelForAnalysis')
      .mockResolvedValue({
        name: '测试技能',
        description: '描述',
        triggerCondition: '当用户要测试时',
        keywords: ['测试'],
      })
  })
  afterEach(() => {
    promptSpy.mockRestore()
    resetLearner()
  })

  it('提示词带证据(支持度/成败/共同步骤),不再只有指令文本', async () => {
    pushObs(learner, '整理桌面', { occurrences: 3, steps: [{ description: '列目录' }], toolsUsed: ['Glob'] })
    pushObs(learner, '整理桌面', { occurrences: 3, steps: [{ description: '列目录' }], toolsUsed: ['Glob'] })

    await learner.analyzeAndGenerateSkill()

    const prompt = promptSpy.mock.calls[0][0] as string
    expect(prompt).toContain('整理桌面')
    expect(prompt).toContain('列目录')
    expect(prompt).toContain('Glob')
    expect(prompt).toContain('6')   // 3 + 3 = 6 次观察
  })

  it('提示词不再谎称"3 个操作"(旧实现硬编码 3,实际给 10 条)', async () => {
    pushObs(learner, '重复的事', { occurrences: 5 })
    await learner.analyzeAndGenerateSkill()
    const prompt = promptSpy.mock.calls[0][0] as string
    expect(prompt).not.toContain('连续执行了3个操作')
  })

  it('失败次数写进提示词(让模型知道这流程哪里容易坏)', async () => {
    pushObs(learner, '会坏的流程', { occurrences: 3, outcome: 'ok' })
    pushObs(learner, '会坏的流程', { occurrences: 3, outcome: 'fail' })
    await learner.analyzeAndGenerateSkill()
    const prompt = promptSpy.mock.calls[0][0] as string
    expect(prompt).toContain('失败')
  })

  it('提案携带证据链(用户能核对提案凭什么成立)', async () => {
    pushObs(learner, '有证据的流程', { occurrences: 3, steps: [{ description: '读文件' }], trajectoryId: 'run_1' })
    pushObs(learner, '有证据的流程', { occurrences: 3, steps: [{ description: '读文件' }], trajectoryId: 'run_2' })

    await learner.analyzeAndGenerateSkill()

    const proposal = learner.getPendingProposal()
    expect(proposal).not.toBeNull()
    expect(proposal.evidence).toBeDefined()
    expect(proposal.evidence.supportCount).toBe(6)
    expect(proposal.evidence.commonSteps).toContain('读文件')
    expect(proposal.evidence.trajectoryIds).toContain('run_1')
    // 操作步骤来自共同步骤,不是抄最后一次
    expect(proposal.operationSteps).toContain('读文件')
  })
})

describe('M4-C 轨迹保留有界', () => {
  beforeEach(() => resetLearner())
  afterEach(() => resetLearner())

  it('每条观察最多保留 5 次执行的轨迹(observations.json 不会无限膨胀)', () => {
    const learner: any = SelfLearner.getInstance()
    for (let i = 0; i < 12; i++) {
      learner.observeExecution('反复做的事', [{ description: '步骤' }], 'ok')
    }
    const obs = learner.observations.find((o: any) => o.instruction === '反复做的事')
    expect(obs.occurrences).toBe(12)
    expect(obs.trajectories.length).toBe(5)
  })

  it('轨迹里保留每次的成败(逐次证据,不是聚合计数)', () => {
    const learner: any = SelfLearner.getInstance()
    learner.observeExecution('成败交替', [{ description: '步骤' }], 'ok')
    learner.observeExecution('成败交替', [{ description: '步骤' }], 'fail')
    const obs = learner.observations.find((o: any) => o.instruction === '成败交替')
    expect(obs.trajectories.map((t: any) => t.outcome)).toEqual(['ok', 'fail'])
  })
})
