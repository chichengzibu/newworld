/**
 * PiPiClaw — 裁判放行门禁测试（M4-V）
 * ═══════════════════════════════════════════════════════════════════════
 * 【这一批在测什么】
 * 门禁是 D7「裁判层保持默认关闭」从注释变成代码的那道门。
 * 它必须做到三件事:
 *   ① 没校准过的裁判 → **进不去**,且说清为什么
 *   ② 校准过且达标的 → **进得去**,并给出依据
 *   ③ 每一项不达标 → **单独**说清楚是哪一项(不能笼统地说"不合格")
 *
 * 【为什么第 ③ 条要测】
 * 门禁的价值在于"让人知道该改什么"。
 * 笼统的"未通过"会让人放弃 —— 那道门就变成了"以后再说"的借口。
 */
import { describe, it, expect, vi } from 'vitest'

vi.mock('electron', () => ({
  app: { getPath: vi.fn((k: string) => `/tmp/pipiclaw-trust-${k}`) },
}))
vi.mock('electron-log', () => ({
  default: {
    info: () => {}, warn: () => {}, error: () => {}, debug: () => {},
    transports: { file: { resolvePathFn: () => {}, maxSize: 0, format: '' }, console: { level: 'info' } },
  },
}))

import {
  evaluateJudgeTrust,
  buildCalibrationRecord,
  type JudgeCalibrationRecord,
} from '../../electron/learning/JudgeTrust'
import { JUDGE_CALIBRATION_RECORDS } from '../../electron/learning/JudgeCalibrationRecords'
import { calibrate, type CalibrationItem, type JudgeVerdictRecord } from '../../electron/learning/JudgeCalibration'

/* ─────────────────────────── 测试夹具 ─────────────────────────── */

/** 一条全部达标的记录 */
const passingRecord = (over: Partial<JudgeCalibrationRecord> = {}): JudgeCalibrationRecord => ({
  model: 'good-model',
  calibratedAt: '2026-11-19T00:00:00.000Z',
  dataset: 'panel,mt_bench',
  n: 220,
  kappa: 0.72,
  flipRate: 0.05,
  verbosityCorrelation: 0.08,
  stableRuleHolds: true,
  stableSubsetKappa: 0.70,
  beatsLengthBaseline: true,
  baselineMeasurable: true,
  conclusion: '达标',
  ...over,
})

/* ─────────────────────────── 门禁 ─────────────────────────── */

describe('M4-V 裁判放行门禁', () => {
  it('没有校准记录 → 不放行，且说清怎么解除', () => {
    const v = evaluateJudgeTrust('never-calibrated-model', [])
    expect(v.trusted).toBe(false)
    expect(v.reasons.join()).toContain('没有归档的校准记录')
    expect(v.reasons.join()).toContain('重新跑校准')
    expect(v.record).toBeUndefined()
  })

  it('没配模型 → 不放行', () => {
    const v = evaluateJudgeTrust('', [])
    expect(v.trusted).toBe(false)
    expect(v.reasons.join()).toContain('没有配置裁判模型')
  })

  it('模型标识必须完全一致 —— 换模型即失效(judge drift)', () => {
    const rec = passingRecord({ model: 'qwen3.5:9b' })
    // 同一模型 → 命中
    expect(evaluateJudgeTrust('qwen3.5:9b', [rec]).record).toBeDefined()
    // 差一个后缀 → 不命中
    expect(evaluateJudgeTrust('qwen3.5:9b:latest', [rec]).record).toBeUndefined()
    // 换个模型 → 不命中
    expect(evaluateJudgeTrust('qwen3.5:9b-v2', [rec]).record).toBeUndefined()
  })

  it('全部达标 → 放行，并给出依据', () => {
    const v = evaluateJudgeTrust('good-model', [passingRecord()])
    expect(v.trusted).toBe(true)
    expect(v.reasons).toEqual([])
    expect(v.basis).toContain('κ=0.720')
    expect(v.basis).toContain('已校准')
  })

  it('每一项不达标 → 单独说清是哪一项', () => {
    const cases: Array<[Partial<JudgeCalibrationRecord>, string]> = [
      [{ n: 12 }, '样本量不足'],
      [{ kappa: 0.41 }, 'κ=0.410 < 门槛'],
      [{ flipRate: 0.679 }, '位置偏置超标'],
      [{ verbosityCorrelation: 0.257 }, '冗长偏置超标'],
      [{ stableRuleHolds: false, stableSubsetKappa: -0.167 }, '两次顺序一致才采信'],
      [{ beatsLengthBaseline: false }, '平凡基线'],
    ]
    for (const [over, expected] of cases) {
      const v = evaluateJudgeTrust('good-model', [passingRecord(over)])
      expect(v.trusted).toBe(false)
      expect(v.reasons.join()).toContain(expected)
    }
  })

  it('多项同时不达标 → 逐条都列出来(不能只报第一条)', () => {
    const v = evaluateJudgeTrust('good-model', [
      passingRecord({ kappa: 0.41, flipRate: 0.679, stableRuleHolds: false, beatsLengthBaseline: false }),
    ])
    expect(v.trusted).toBe(false)
    expect(v.reasons.length).toBeGreaterThanOrEqual(4)
  })

  it('长度基线不可测 → 不据此否决(不可测 ≠ 裁判不行)', () => {
    const v = evaluateJudgeTrust('good-model', [
      passingRecord({ baselineMeasurable: false, beatsLengthBaseline: false }),
    ])
    expect(v.trusted).toBe(true)
    expect(v.reasons).toEqual([])
  })

  it('已归档的两条真实记录 → 门禁不放行，且理由指向具体项', () => {
    for (const rec of JUDGE_CALIBRATION_RECORDS) {
      const v = evaluateJudgeTrust(rec.model)
      expect(v.trusted).toBe(false)
      expect(v.record).toBeDefined()
      expect(v.reasons.length).toBeGreaterThan(0)
    }
    // 默认裁判模型(代码里的 DEFAULT_JUDGE_MODEL)必须过不了门禁
    const v = evaluateJudgeTrust('qwen3.5:9b')
    expect(v.trusted).toBe(false)
    expect(v.reasons.join()).toContain('顺序一致才采信')
    expect(v.reasons.join()).toContain('平凡基线')
  })
})

/* ─────────────────────────── 闭环:报告 → 记录 → 放行 ─────────────────────────── */

describe('M4-V 校准记录闭环', () => {
  const item = (id: string, over: Partial<CalibrationItem> = {}): CalibrationItem => ({
    id, dataset: 'panel', category: 'panel-msc', question: 'q',
    answerA: 'A 的答复', answerB: 'B 的答复', humanLabel: 'A', ...over,
  })
  const rec = (id: string, aFirst: string, bFirst: string): JudgeVerdictRecord => ({
    id,
    pickWhenAFirst: aFirst as JudgeVerdictRecord['pickWhenAFirst'],
    pickWhenBFirst: bFirst as JudgeVerdictRecord['pickWhenBFirst'],
    model: 'm',
  })

  it('记录只能从报告推导出来 —— 数字口径与报告同源', () => {
    const items: CalibrationItem[] = Array.from({ length: 60 }, (_, i) =>
      item(`i${i}`, { humanLabel: i % 2 === 0 ? 'A' : 'B' }),
    )
    // 两次顺序都指向人工选的那份内容 → 顺序无关、无位置偏置
    const records = items.map(it =>
      rec(it.id, it.humanLabel === 'A' ? 'first' : 'second', it.humanLabel === 'A' ? 'second' : 'first'),
    )
    const report = calibrate(items, records)
    const record = buildCalibrationRecord(report, { model: 'derived-model', dataset: 'panel' })

    expect(record.n).toBe(report.scored)
    expect(record.kappa).toBeCloseTo(report.kappa)
    expect(record.flipRate).toBeCloseTo(report.position.flipRate)
    expect(record.stableRuleHolds).toBe(report.consensus.stableRuleHolds)
    expect(record.stableSubsetKappa).toBeCloseTo(report.consensus.orderStable.kappa)
    expect(record.beatsLengthBaseline).toBe(report.lengthBaseline.judgeBeatsBaseline)
    expect(record.baselineMeasurable).toBe(report.lengthBaseline.baselineMeasurable)
    expect(record.conclusion).toBe(report.verdict.headline)
  })

  it('从报告推导出的记录 → 门禁按报告的结论放行或拦下', () => {
    const items: CalibrationItem[] = Array.from({ length: 60 }, (_, i) =>
      item(`i${i}`, { humanLabel: i % 2 === 0 ? 'A' : 'B' }),
    )
    const records = items.map(it =>
      rec(it.id, it.humanLabel === 'A' ? 'first' : 'second', it.humanLabel === 'A' ? 'second' : 'first'),
    )
    const report = calibrate(items, records)
    const record = buildCalibrationRecord(report, { model: 'derived-model', dataset: 'panel' })
    const v = evaluateJudgeTrust('derived-model', [record])
    // 门禁与报告结论必须一致:报告说可信 → 门禁放行;报告说不可信 → 门禁拦下
    expect(v.trusted).toBe(report.verdict.reliable)
  })

  it('报告说不可信 → 门禁也拦下(不会因为"记录存在"就放行)', () => {
    const items: CalibrationItem[] = Array.from({ length: 60 }, (_, i) =>
      item(`i${i}`, { humanLabel: i % 2 === 0 ? 'A' : 'B' }),
    )
    // 全部永远选先展示的 → 位置偏置超标
    const records = items.map(it => rec(it.id, 'first', 'first'))
    const report = calibrate(items, records)
    expect(report.verdict.reliable).toBe(false)
    const record = buildCalibrationRecord(report, { model: 'biased-model', dataset: 'panel' })
    const v = evaluateJudgeTrust('biased-model', [record])
    expect(v.trusted).toBe(false)
    expect(v.reasons.join()).toContain('位置偏置超标')
  })
})
