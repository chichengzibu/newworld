/**
 * PiPiClaw — 顺序一致性分析 + 长度平凡基线（M4-V）
 * ═══════════════════════════════════════════════════════════════════════
 * 【这一批在测什么】
 * 两个**会决定"能不能接裁判"的数字**，必须有回归用例钉住：
 *
 * ① 顺序一致性分析 —— 「两次顺序一致才采信」这条规则（M4-N 用的就是它）
 *    到底买到了什么？实跑发现它**反着**：被采信的子集一致率反而更低。
 *    这里把那个形态固化成用例。
 *
 * ② 长度平凡基线 —— 拿一个「不看内容、只看答复有多长」的预测器跟裁判同台比。
 *    若裁判赢不了它,它测到的就可能只是长度偏好,不是质量。
 *
 * 【为什么值得单独测】
 * 这两个结论会直接决定生产路径接不接裁判（M4-V 的门禁）。
 * 它们要是哪天悄悄变了,门禁就形同虚设 —— 所以钉成用例。
 *
 * 【不测什么】
 * 不测"裁判准不准" —— 那是实跑校准的事（tests/integration/ 下）。
 */
import { describe, it, expect, vi } from 'vitest'

vi.mock('electron', () => ({
  app: { getPath: vi.fn((k: string) => `/tmp/pipiclaw-calib-${k}`) },
}))
vi.mock('electron-log', () => ({
  default: {
    info: () => {}, warn: () => {}, error: () => {}, debug: () => {},
    transports: { file: { resolvePathFn: () => {}, maxSize: 0, format: '' }, console: { level: 'info' } },
  },
}))

import {
  consensusAnalysis,
  lengthBiasBaseline,
  mcnemarPValue,
  mcnemarPValueOneSided,
  normalCdf,
  calibrate,
  renderCalibrationReport,
  type CalibrationItem,
  type JudgeVerdictRecord,
} from '../../electron/learning/JudgeCalibration'

/* ─────────────────────────── 测试夹具 ─────────────────────────── */

const item = (id: string, over: Partial<CalibrationItem> = {}): CalibrationItem => ({
  id,
  dataset: 'panel',
  category: 'panel-msc',
  question: '帮我整理一下桌面',
  answerA: 'A 的答复',
  answerB: 'B 的答复',
  humanLabel: 'A',
  ...over,
})

const rec = (id: string, aFirst: string, bFirst: string): JudgeVerdictRecord => ({
  id,
  pickWhenAFirst: aFirst as JudgeVerdictRecord['pickWhenAFirst'],
  pickWhenBFirst: bFirst as JudgeVerdictRecord['pickWhenBFirst'],
  model: 'test-model',
})

/** 长度可控的样本 */
const lenItem = (id: string, human: 'A' | 'B', aLen: number, bLen: number): CalibrationItem =>
  item(id, { humanLabel: human, answerA: 'x'.repeat(aLen), answerB: 'y'.repeat(bLen) })

/* ─────────────────────────── 顺序一致性分析 ─────────────────────────── */

describe('M4-V 顺序一致性分析', () => {
  /**
   * 造出「顺序一致的子集反而更差」这个形态 —— 实跑测到的正是它。
   *
   * 前 20 条:两次顺序都指向**另一份**内容 → 顺序一致但**稳定地判错**。
   * 后 20 条:永远选先展示的那个 → 顺序不一致;首次顺序对了一半样本判对。
   *
   * 【为什么要让每个子集内部的人工标签 A/B 都有】
   * 子集内人工标签单一类别时 κ 会退化成 0(pe=0)→ 比不出高低。
   * 夹逼的标签分布才能让"一致子集比整体差"这件事在 κ 上也显形。
   */
  const invertedItems: CalibrationItem[] = []
  const invertedRecords: JudgeVerdictRecord[] = []
  for (let i = 0; i < 20; i++) {
    const human = i % 2 === 0 ? 'A' : 'B'
    invertedItems.push(item(`s${i}`, { humanLabel: human }))
    // AFirst/BFirst 都指向"内容B"(人工选A时)或"内容A"(人工选B时)
    invertedRecords.push(rec(`s${i}`,
      human === 'A' ? 'second' : 'first',
      human === 'A' ? 'first' : 'second'))
  }
  for (let i = 0; i < 20; i++) {
    const human = i % 2 === 0 ? 'A' : 'B'
    invertedItems.push(item(`u${i}`, { humanLabel: human }))
    // 两次都选先展示的那个 → 顺序不一致
    invertedRecords.push(rec(`u${i}`,
      human === 'A' ? 'first' : 'second',
      human === 'A' ? 'first' : 'second'))
  }

  it('拆出「顺序一致」与「顺序不一致」两个子集，并给出各自的覆盖率', () => {
    const a = consensusAnalysis(invertedItems, invertedRecords)
    expect(a.orderStable.n).toBe(20)
    expect(a.orderUnstable.n).toBe(20)
    expect(a.overall.n).toBe(40)
    expect(a.orderStable.coverage).toBeCloseTo(0.5)
  })

  it('【关键】顺序一致的子集可以比整体更差 —— 规则不成立时必须说"不成立"', () => {
    const a = consensusAnalysis(invertedItems, invertedRecords)
    // 被采信的子集全错 → 一致率 0、κ 为负
    expect(a.orderStable.accuracy).toBe(0)
    expect(a.orderStable.kappa).toBeLessThan(0)
    // 整体:不一致子集全判对 → 一致率 0.5
    expect(a.overall.accuracy).toBeCloseTo(0.5)
    expect(a.overall.kappa).toBeGreaterThan(a.orderStable.kappa)
    expect(a.stableRuleHolds).toBe(false)
    expect(a.note).toContain('不成立')
  })

  it('位置偏置子集里每个组都是「恒定预测」—— 组内没有区分力', () => {
    const a = consensusAnalysis(invertedItems, invertedRecords)
    expect(a.positionGroups.length).toBe(2)
    for (const g of a.positionGroups) {
      expect(g.constantPredictor).toBe(true)
      expect(g.accuracy).toBeCloseTo(g.majorityRate)
    }
  })

  it('组内人工标签只有单一类别 → 组内 κ 不可定义（不能拿 1 冒充"完美一致"）', () => {
    // 12 条里人工 10 条选 A,裁判永远选先展示的 → 组内人工只有 A/B 两个类,
    // 但每一组内部只有单一类别 → pe=1 → κ 无定义
    const items = Array.from({ length: 12 }, (_, i) => item(`i${i}`, { humanLabel: i < 10 ? 'A' : 'B' }))
    const records = items.map(it => rec(it.id, 'first', 'first'))
    const a = consensusAnalysis(items, records)
    const g = a.positionGroups[0]
    expect(g.constantPredictor).toBe(true)
    expect(g.kappaDefined).toBe(true)   // 10A/2B 混合 → 可定义
    expect(g.kappa).toBeCloseTo(0)

    // 单一类别版本:全部人工都选 A
    const single = Array.from({ length: 10 }, (_, i) => item(`s${i}`, { humanLabel: 'A' }))
    const singleRecords = single.map(it => rec(it.id, 'first', 'first'))
    const b = consensusAnalysis(single, singleRecords)
    expect(b.positionGroups[0].kappaDefined).toBe(false)
    expect(b.positionGroups[0].kappa).toBe(0)
  })

  it('顺序一致的子集不比整体差时，规则成立', () => {
    const items = Array.from({ length: 20 }, (_, i) => item(`i${i}`, { humanLabel: i % 2 === 0 ? 'A' : 'B' }))
    // 两次都指向人工选的那份内容 → 顺序一致且全对
    const records = items.map(it =>
      rec(it.id, it.humanLabel === 'A' ? 'first' : 'second', it.humanLabel === 'A' ? 'second' : 'first'),
    )
    const a = consensusAnalysis(items, records)
    expect(a.orderStable.n).toBe(20)
    expect(a.orderUnstable.n).toBe(0)
    expect(a.orderStable.accuracy).toBe(1)
    expect(a.stableRuleHolds).toBe(true)
  })

  it('一致子集为空 → 规则「无从谈起」，不能空真', () => {
    const items = Array.from({ length: 10 }, (_, i) => item(`i${i}`, { humanLabel: i % 2 === 0 ? 'A' : 'B' }))
    // 全部永远选先展示的 → 没有任何一条满足"两次一致"
    const records = items.map(it => rec(it.id, 'first', 'first'))
    const a = consensusAnalysis(items, records)
    expect(a.orderStable.n).toBe(0)
    expect(a.stableRuleHolds).toBe(false)
    expect(a.note).toContain('无从谈起')
  })

  it('位置偏置子集拆开后，组内是「恒定预测」→ 它的"准"不是本事', () => {
    // 12 条里人工有 10 条选 A —— 裁判永远选先展示的
    const items = Array.from({ length: 12 }, (_, i) => item(`i${i}`, { humanLabel: i < 10 ? 'A' : 'B' }))
    const records = items.map(it => rec(it.id, 'first', 'first'))
    const a = consensusAnalysis(items, records)
    expect(a.positionGroups.length).toBe(1)
    const g = a.positionGroups[0]
    expect(g.group).toBe('always_first')
    expect(g.n).toBe(12)
    // 组内准确率 == 组内多数类占比 → 恒定预测
    expect(g.accuracy).toBeCloseTo(g.majorityRate)
    expect(g.constantPredictor).toBe(true)
    // 恒定预测在组内没有区分力 → κ = 0
    expect(g.kappa).toBeCloseTo(0)
  })

  it('人工平局 / 人工有歧义 / 裁判无法解析 —— 与主报告同一套排除口径', () => {
    const items = [
      item('keep', { humanLabel: 'A' }),
      item('tie', { humanLabel: 'tie' }),
      item('amb', { humanLabel: 'A', ambiguous: true }),
      item('unparsed', { humanLabel: 'B' }),
    ]
    const records = [
      rec('keep', 'first', 'second'),
      rec('tie', 'first', 'second'),
      rec('amb', 'first', 'second'),
      rec('unparsed', 'unknown', 'unknown'),
    ]
    const a = consensusAnalysis(items, records)
    expect(a.overall.n).toBe(1)
    expect(a.orderStable.n).toBe(1)
  })
})

/* ─────────────────────────── 长度平凡基线 ─────────────────────────── */

describe('M4-V 长度平凡基线', () => {
  it('裁判就是个长度启发式 → 赢不了基线，判为"没强于基线"', () => {
    // 40 条：人工有 32 条选了更长的那个（80% 偏长度）
    const items: CalibrationItem[] = []
    for (let i = 0; i < 20; i++) {
      items.push(lenItem(`longB${i}`, i < 16 ? 'B' : 'A', 3, 40))
      items.push(lenItem(`longA${i}`, i < 16 ? 'A' : 'B', 40, 3))
    }
    // 裁判永远选更长的那个
    const records = items.map(it =>
      rec(it.id, it.answerA.length > it.answerB.length ? 'first' : 'second',
        it.answerA.length > it.answerB.length ? 'second' : 'first'),
    )
    const b = lengthBiasBaseline(items, records)
    expect(b.baselineMeasurable).toBe(true)
    expect(b.n).toBe(40)
    // 人工偏长度 80%
    expect(b.humanPrefersLonger).toBeCloseTo(0.8)
    // 裁判与基线几乎完全重合
    expect(b.judgeAgreement).toBeCloseTo(1)
    // 两边一模一样 → 没有一条不一致对 → p=1，判为"没强于基线"
    expect(b.judgeOnly).toBe(0)
    expect(b.baselineOnly).toBe(0)
    expect(b.judgeBeatsBaseline).toBe(false)
    expect(b.note).toContain('没有')
  })

  it('裁判真的看懂了内容 → 显著强于基线', () => {
    const items: CalibrationItem[] = []
    for (let i = 0; i < 20; i++) {
      items.push(lenItem(`longB${i}`, i < 16 ? 'B' : 'A', 3, 40))
      items.push(lenItem(`longA${i}`, i < 16 ? 'A' : 'B', 40, 3))
    }
    // 裁判每次都选人工选的那份内容
    const records = items.map(it =>
      rec(it.id, it.humanLabel === 'A' ? 'first' : 'second', it.humanLabel === 'A' ? 'second' : 'first'),
    )
    const b = lengthBiasBaseline(items, records)
    // 人工偏长的 32 条两边都对；人工偏短的 8 条只有裁判对 → 裁判独对 8
    expect(b.judgeOnly).toBe(8)
    expect(b.baselineOnly).toBe(0)
    expect(b.pValue).toBeLessThan(0.05)
    expect(b.judgeBeatsBaseline).toBe(true)
  })

  it('两侧等长 → 基线不可测（既不拦门禁，也不能说裁判不强）', () => {
    const items = Array.from({ length: 10 }, (_, i) => item(`i${i}`, { humanLabel: i % 2 === 0 ? 'A' : 'B' }))
    const records = items.map(it =>
      rec(it.id, it.humanLabel === 'A' ? 'first' : 'second', it.humanLabel === 'A' ? 'second' : 'first'),
    )
    const b = lengthBiasBaseline(items, records)
    expect(b.n).toBe(0)
    expect(b.excludedEqualLength).toBe(10)
    expect(b.baselineMeasurable).toBe(false)
    expect(b.judgeBeatsBaseline).toBe(false)
    expect(b.note).toContain('不可测')
  })

  it('McNemar：无不一致对 → p=1；强优势 → p 很小', () => {
    expect(mcnemarPValue(0, 0)).toBe(1)
    // 连续性校正的 χ² = (|b−c|−1)²/(b+c):b=c=5 时 χ²=0.1 → p≈0.752(不显著)
    // 这正是 Yates 校正的既定行为(R 的 chisq.test(correct=TRUE) 同值)
    expect(mcnemarPValue(5, 5)).toBeCloseTo(0.752, 2)
    expect(mcnemarPValue(5, 5)).toBeLessThan(1)
    expect(mcnemarPValue(20, 0)).toBeLessThan(0.001)
    expect(mcnemarPValue(0, 20)).toBeLessThan(0.001)
    // 对称性:交换 b/c 不改变 p
    expect(mcnemarPValue(7, 2)).toBeCloseTo(mcnemarPValue(2, 7))
  })

  it('【回归】双侧 p 只说明"有差异" —— 方向必须用单向 p 判', () => {
    // 实跑踩到:裁判独对 21 / 基线独对 44 → 双侧 p=0.0064(差异显著)
    // 但**方向是裁判更差**。若拿双侧 p 当"裁判更强"的判据 → 结论完全反过来。
    const twoSided = mcnemarPValue(21, 44)
    expect(twoSided).toBeLessThan(0.05)          // 差异确实显著
    expect(mcnemarPValueOneSided(21, 44)).toBe(1) // 但裁判没有优势
    // 反过来:裁判独对得多 → 单向 p 才小
    expect(mcnemarPValueOneSided(44, 21)).toBeLessThan(0.05)
    // 同样大小的差,方向反过来结论就反过来 —— 单向 p 不对称
    expect(mcnemarPValueOneSided(21, 44)).not.toBeCloseTo(mcnemarPValueOneSided(44, 21), 6)
    // 无不一致对
    expect(mcnemarPValueOneSided(0, 0)).toBe(1)
  })

  it('【回归】裁判比基线差时,不能报"裁判显著优于基线"', () => {
    // 造一批"裁判更差"的样本:人工偏好更长的那个 8 成,裁判却常选短的
    const items: CalibrationItem[] = []
    for (let i = 0; i < 20; i++) {
      items.push(lenItem(`longB${i}`, i < 16 ? 'B' : 'A', 3, 40))
      items.push(lenItem(`longA${i}`, i < 16 ? 'A' : 'B', 40, 3))
    }
    // 裁判总是选**短**的那个(与人工偏好相反)
    const records = items.map(it =>
      rec(it.id, it.answerA.length > it.answerB.length ? 'second' : 'first',
        it.answerA.length > it.answerB.length ? 'first' : 'second'),
    )
    const b = lengthBiasBaseline(items, records)
    expect(b.judgeBeatsBaseline).toBe(false)
    expect(b.baselineOnly).toBeGreaterThan(b.judgeOnly)
    expect(b.pValue).toBeLessThan(0.05)   // 双侧:差异显著
    expect(b.pValueOneSided).toBe(1)      // 单向:裁判没有优势
  })

  it('标准正态 CDF：0 处 0.5，单调，尾部趋 0/1', () => {
    expect(normalCdf(0)).toBeCloseTo(0.5)
    expect(normalCdf(1.96)).toBeCloseTo(0.975, 2)
    expect(normalCdf(-1.96)).toBeCloseTo(0.025, 2)
    expect(normalCdf(10)).toBeGreaterThan(0.999999)
    expect(normalCdf(-10)).toBeLessThan(0.000001)
  })
})

/* ─────────────────────────── 接进主报告 ─────────────────────────── */

describe('M4-V 校准报告接入', () => {
  it('报告里必须有「顺序一致性分析」与「长度平凡基线」两块', () => {
    const items = Array.from({ length: 40 }, (_, i) => item(`i${i}`, { humanLabel: i % 2 === 0 ? 'A' : 'B' }))
    const records = items.map(it =>
      rec(it.id, it.humanLabel === 'A' ? 'first' : 'second', it.humanLabel === 'A' ? 'second' : 'first'),
    )
    const md = renderCalibrationReport(calibrate(items, records), { model: 'x', dataset: 'panel' })
    expect(md).toContain('## 顺序一致性分析')
    expect(md).toContain('## 长度平凡基线')
    expect(md).toContain('顺序一致')
    expect(md).toContain('平凡基线')
  })

  it('顺序一致子集更差 → 结论不可信，且理由里写明这条规则不成立', () => {
    const items: CalibrationItem[] = []
    const records: JudgeVerdictRecord[] = []
    // 一半"稳定地判错"、一半"换序改口"(首次顺序对了一半样本判对)
    for (let i = 0; i < 20; i++) {
      const human = i % 2 === 0 ? 'A' : 'B'
      items.push(item(`s${i}`, { humanLabel: human }))
      records.push(rec(`s${i}`,
        human === 'A' ? 'second' : 'first',
        human === 'A' ? 'first' : 'second'))
    }
    for (let i = 0; i < 20; i++) {
      const human = i % 2 === 0 ? 'A' : 'B'
      items.push(item(`u${i}`, { humanLabel: human }))
      records.push(rec(`u${i}`,
        human === 'A' ? 'first' : 'second',
        human === 'A' ? 'first' : 'second'))
    }
    const report = calibrate(items, records)
    expect(report.verdict.reliable).toBe(false)
    expect(report.verdict.reasons.join()).toContain('两次顺序一致才采信')
    expect(report.consensus.stableRuleHolds).toBe(false)
  })

  it('裁判赢不了长度基线 → 结论不可信，且理由里写明', () => {
    const items: CalibrationItem[] = []
    for (let i = 0; i < 20; i++) {
      items.push(lenItem(`longB${i}`, i < 16 ? 'B' : 'A', 3, 40))
      items.push(lenItem(`longA${i}`, i < 16 ? 'A' : 'B', 40, 3))
    }
    const records = items.map(it =>
      rec(it.id, it.answerA.length > it.answerB.length ? 'first' : 'second',
        it.answerA.length > it.answerB.length ? 'second' : 'first'),
    )
    const report = calibrate(items, records)
    expect(report.verdict.reliable).toBe(false)
    expect(report.verdict.reasons.join()).toContain('平凡基线')
    expect(report.lengthBaseline.judgeBeatsBaseline).toBe(false)
  })
})
