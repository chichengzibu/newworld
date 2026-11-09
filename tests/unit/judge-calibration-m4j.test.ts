/**
 * PiPiClaw — 裁判校准测试（M4-J）
 * ═══════════════════════════════════════════════════════════════════════
 * 【这一批在测什么】
 * ① 校准指标算得对不对（κ / Wilson CI / 相关 / 混淆）
 * ② 偏置探针测的是不是真的偏置（位置 / 冗长）
 * ③ 结论门禁会不会放过一个不该放过的裁判
 * ④ pairwise 裁判的提示词与解析（**三个实现期踩到的坑都钉成回归用例**）
 *
 * 【不测什么】
 * 不测"裁判准不准" —— 那是实跑校准的事（tests/integration/judge-calibration-live.test.ts），
 * 本文件的断言全部是确定性的。
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'

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
  accuracy,
  cohenKappa,
  wilsonInterval,
  pearson,
  confusionMatrix,
  kappaBand,
  positionProbe,
  verbosityProbe,
  calibrate,
  renderCalibrationReport,
  resolveWinnerIdentity,
  type CalibrationItem,
  type JudgeVerdictRecord,
} from '../../electron/learning/JudgeCalibration'
import {
  buildPairwiseJudgePrompt,
  parsePairwiseJudgeOutput,
} from '../../electron/learning/RunJudge'

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

const rec = (id: string, aFirst: string, bFirst: string, model = 'test-model'): JudgeVerdictRecord => ({
  id,
  pickWhenAFirst: aFirst as JudgeVerdictRecord['pickWhenAFirst'],
  pickWhenBFirst: bFirst as JudgeVerdictRecord['pickWhenBFirst'],
  model,
})

/* ─────────────────────────── 指标 ─────────────────────────── */

describe('M4-J 校准指标', () => {
  it('原始一致率 = 一致的条数 / 总条数', () => {
    expect(accuracy([['A', 'A'], ['B', 'A'], ['A', 'A']])).toBeCloseTo(2 / 3)
    expect(accuracy([])).toBe(0)
  })

  it('κ：完全一致 = 1', () => {
    const pairs: Array<[string, string]> = [['A', 'A'], ['B', 'B'], ['A', 'A'], ['B', 'B']]
    expect(cohenKappa(pairs)).toBeCloseTo(1)
  })

  it('κ：比原始一致率低 —— 标签偏斜时原始一致率会骗人', () => {
    // 100 条里 90 条人工都选 A；裁判全押 A → 原始一致率 90%，但它什么都没学会
    const pairs: Array<[string, string]> = []
    for (let i = 0; i < 90; i++) pairs.push(['A', 'A'])
    for (let i = 0; i < 10; i++) pairs.push(['B', 'A'])
    const acc = accuracy(pairs)
    const kappa = cohenKappa(pairs)
    expect(acc).toBeCloseTo(0.9)
    // 关键断言:原始一致率很高,κ 接近 0(只比"全押多数类"好一点)
    expect(kappa).toBeLessThan(0.2)
    expect(kappa).toBeGreaterThanOrEqual(0)
  })

  it('κ：完全相反 → 负值(低于随机)', () => {
    const pairs: Array<[string, string]> = [['A', 'B'], ['B', 'A'], ['A', 'B'], ['B', 'A']]
    expect(cohenKappa(pairs)).toBeLessThan(0)
    expect(kappaBand(cohenKappa(pairs))).toContain('低于随机')
  })

  it('Wilson 区间永远落在 [0,1] 且小样本更宽', () => {
    const small = wilsonInterval(5, 10)
    const large = wilsonInterval(500, 1000)
    expect(small.low).toBeGreaterThanOrEqual(0)
    expect(small.high).toBeLessThanOrEqual(1)
    expect(small.low).toBeLessThan(large.low)
    expect(small.high).toBeGreaterThan(large.high)
    // 贴近 1 的比例不会算出 >1 的上界(正态近似会)
    const edge = wilsonInterval(10, 10)
    expect(edge.high).toBeLessThanOrEqual(1)
    expect(edge.low).toBeGreaterThan(0)
  })

  it('Pearson 相关：完全正相关 = 1，恒定序列 = 0', () => {
    expect(pearson([1, 2, 3], [2, 4, 6])).toBeCloseTo(1)
    expect(pearson([1, 1, 1], [1, 2, 3])).toBe(0)
  })

  it('混淆矩阵按 "人工|裁判" 计数', () => {
    const m = confusionMatrix([['A', 'A'], ['A', 'B'], ['B', 'B']])
    expect(m['A|A']).toBe(1)
    expect(m['A|B']).toBe(1)
    expect(m['B|B']).toBe(1)
    expect(m['B|A']).toBeUndefined()
  })

  it('κ 分带边界', () => {
    expect(kappaBand(0.1)).toContain('微弱')
    expect(kappaBand(0.3)).toContain('一般')
    expect(kappaBand(0.5)).toContain('中等')
    expect(kappaBand(0.7)).toContain('较强')
    expect(kappaBand(0.9)).toContain('几乎完美')
  })
})

/* ─────────────────────────── 偏置探针 ─────────────────────────── */

describe('M4-J 偏置探针', () => {
  it('顺序无关的裁判 → 改口率 0', () => {
    // 两次都指向同一份内容（A 在前选 first；B 在前选 second = 仍然是内容 A）
    const records = [
      rec('1', 'first', 'second'),
      rec('2', 'second', 'first'),
    ]
    const probe = positionProbe(records)
    expect(probe.n).toBe(2)
    expect(probe.flips).toBe(0)
    expect(probe.flipRate).toBe(0)
  })

  it('纯位置偏置的裁判（永远选先出现的）→ 改口率 100% 且"先出现者赢"占比 100%', () => {
    const records = [rec('1', 'first', 'first'), rec('2', 'first', 'first')]
    const probe = positionProbe(records)
    expect(probe.flips).toBe(2)
    expect(probe.flipRate).toBe(1)
    expect(probe.firstPositionRate).toBe(1)
  })

  it('平局/无法解析的样本不进位置探针(它们说明不了顺序敏感性)', () => {
    const records = [rec('1', 'tie', 'tie'), rec('2', 'unknown', 'first'), rec('3', 'first', 'second')]
    const probe = positionProbe(records)
    expect(probe.n).toBe(1)
  })

  it('冗长偏置：偏爱更长答复 → 长度相关性为正', () => {
    // 一条 A 短 B 长、一条 A 长 B 短 —— 两次都选长的那个。
    // 注意:若两条样本形态相同,"是否选 A"就是恒定序列,相关系数无定义(0/0)
    const items = [
      item('1', { answerA: '短', answerB: '很长很长很长很长' }),
      item('2', { answerA: '很长很长很长很长', answerB: '短' }),
    ]
    const records = [
      rec('1', 'second', 'first'),   // 选中 B(长的)
      rec('2', 'first', 'second'),   // 选中 A(长的)
    ]
    const probe = verbosityProbe(items, records)
    expect(probe.n).toBe(2)
    expect(probe.defined).toBe(true)
    expect(probe.correlation).toBeGreaterThan(0.5)
    expect(probe.meanLenChosen).toBeGreaterThan(probe.meanLenOther)
  })

  it('冗长偏置不可测 ≠ 没有偏置（恒定序列时必须标不可测）', () => {
    const items = [
      item('1', { answerA: '短', answerB: '很长很长很长很长' }),
      item('2', { answerA: '短', answerB: '很长很长很长很长' }),
    ]
    // 两次都选 B → "是否选 A"恒为 0 → 相关系数无定义
    const records = [rec('1', 'second', 'first'), rec('2', 'second', 'first')]
    const probe = verbosityProbe(items, records)
    expect(probe.defined).toBe(false)
    expect(probe.meanLenChosen).toBeGreaterThan(probe.meanLenOther)  // 长度差仍在
  })

  it('展示位选择 → 内容身份的翻译(A 在前/B 在前两种序)', () => {
    // 两次展示的槽位含义不同:
    //   A 在前 → slot1=内容A, slot2=内容B
    //   B 在前 → slot1=内容B, slot2=内容A
    // ① 两次都选 slot1 → 顺序依赖(纯位置偏置):A-first 判 A,B-first 判 B
    const alwaysFirst = rec('1', 'first', 'first')
    expect(resolveWinnerIdentity(alwaysFirst, 'AFirst')).toBe('A')
    expect(resolveWinnerIdentity(alwaysFirst, 'BFirst')).toBe('B')
    // ② A 在前选 slot1(=内容A)、B 在前选 slot2(=内容A) → 两次都是内容A,顺序无关
    const contentA = rec('1', 'first', 'second')
    expect(resolveWinnerIdentity(contentA, 'AFirst')).toBe('A')
    expect(resolveWinnerIdentity(contentA, 'BFirst')).toBe('A')
    // ③ A 在前选 slot2(=内容B)、B 在前选 slot1(=内容B) → 两次都是内容B
    const contentB = rec('1', 'second', 'first')
    expect(resolveWinnerIdentity(contentB, 'AFirst')).toBe('B')
    expect(resolveWinnerIdentity(contentB, 'BFirst')).toBe('B')
  })
})

/* ─────────────────────────── 校准主流程 ─────────────────────────── */

describe('M4-J 校准主流程', () => {
  const goodItems = (n: number): CalibrationItem[] =>
    Array.from({ length: n }, (_, i) => item(`i${i}`, { humanLabel: i % 2 === 0 ? 'A' : 'B' }))
  const matchingRecords = (items: CalibrationItem[]): JudgeVerdictRecord[] =>
    items.map(i => rec(i.id, i.humanLabel === 'A' ? 'first' : 'second', i.humanLabel === 'A' ? 'second' : 'first'))

  it('人工平局 / 有歧义 / 裁判无法解析 —— 三类都排除且**分别计数**', () => {
    const items: CalibrationItem[] = [
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
    const report = calibrate(items, records)
    expect(report.scored).toBe(1)
    expect(report.excludedTie).toBe(1)
    expect(report.excludedAmbiguous).toBe(1)
    expect(report.unknown).toBe(1)
    expect(report.accuracy).toBe(1)
  })

  it('样本量不足 → 明确说"结论不成立"，不给"可信"', () => {
    const items = goodItems(5)
    const report = calibrate(items, matchingRecords(items))
    expect(report.verdict.reliable).toBe(false)
    expect(report.verdict.reasons.join()).toContain('样本量不足')
    expect(report.verdict.recommendation).toContain('默认关闭')
  })

  it('κ 高 + 样本够 + 无偏置 → 可信，且逐类也判可信', () => {
    const items = goodItems(60)
    const report = calibrate(items, matchingRecords(items))
    expect(report.kappa).toBeCloseTo(1)
    expect(report.verdict.reliable).toBe(true)
    expect(report.perCategory[0].reliable).toBe(true)
  })

  it('位置偏置超标 → 即便 κ 高也不可信', () => {
    const items = goodItems(60)
    // 全部"永远选先出现的" → 顺序敏感
    const records = items.map(i => rec(i.id, 'first', 'first'))
    const report = calibrate(items, records)
    expect(report.verdict.reliable).toBe(false)
    expect(report.verdict.reasons.join()).toContain('位置偏置超标')
  })

  it('分类别结果按 κ 升序 —— 最差的排最前', () => {
    const items: CalibrationItem[] = [
      ...Array.from({ length: 30 }, (_, i) => item(`good${i}`, { category: 'good', humanLabel: 'A' })),
      ...Array.from({ length: 30 }, (_, i) => item(`bad${i}`, { category: 'bad', humanLabel: 'A' })),
    ]
    const records = [
      ...items.filter(i => i.category === 'good').map(i => rec(i.id, 'first', 'second')),
      ...items.filter(i => i.category === 'bad').map(i => rec(i.id, 'second', 'first')),
    ]
    const report = calibrate(items, records)
    expect(report.perCategory.map(c => c.category)).toEqual(['bad', 'good'])
    expect(report.perCategory[0].reliable).toBe(false)
    expect(report.perCategory[1].reliable).toBe(true)
  })

  it('分歧样本被记下来，并标注是否换序改口', () => {
    const items = [item('d1', { humanLabel: 'A' })]
    const report = calibrate(items, [rec('d1', 'second', 'first')])
    expect(report.disagreements.length).toBe(1)
    expect(report.disagreements[0].judgeLabel).toBe('B')
    expect(report.disagreements[0].orderFlipped).toBe(false)  // 两次都指向内容 B
  })

  it('报告里必须写明结论、门槛与口径（不能只给数字）', () => {
    const items = goodItems(40)
    const report = calibrate(items, matchingRecords(items))
    const md = renderCalibrationReport(report, { model: 'x', dataset: 'panel' })
    expect(md).toContain('## 结论')
    expect(md).toContain('κ')
    expect(md).toContain('门槛')
    expect(md).toContain('Wilson')
    expect(md).toContain('panel')
  })
})

/* ─────────────────────────── pairwise 裁判 ─────────────────────────── */

describe('M4-J pairwise 裁判提示词与解析', () => {
  const run = { instruction: '整理桌面', answer: '已完成', toolsUsed: ['Glob'] }

  it('提示词必须含:注入防御 / 反位置偏置 / 反冗长偏置 / 允许平局', () => {
    const p = buildPairwiseJudgePrompt(run, { ...run, answer: '另一份' })
    expect(p).toContain('待评数据')
    expect(p).toContain('呈现顺序不得影响判断')
    expect(p).toContain('长度不等于质量')
    expect(p).toContain('平局是合法结论')
    // 输出契约:一行 + 明确取值域
    expect(p).toContain('只输出一行')
    expect(p).toContain('tie')
  })

  it('解析:标准 "a 4"', () => {
    const v = parsePairwiseJudgeOutput('a 4')
    expect(v?.winner).toBe('a')
    expect(v?.confidence).toBe(4)
  })

  it('解析:模型把占位符原样抄回来（实测踩到）', () => {
    expect(parsePairwiseJudgeOutput('<winner> b\nconfidence 4')?.winner).toBe('b')
    expect(parsePairwiseJudgeOutput('<winner> a, confidence=5')?.winner).toBe('a')
  })

  it('解析:JSON 形态', () => {
    const v = parsePairwiseJudgeOutput('{"winner":"tie","confidence":3,"reason":"都差不多"}')
    expect(v?.winner).toBe('tie')
    expect(v?.reason).toBe('都差不多')
  })

  it('【回归】thinking 散文里的孤立字母**不得**被当成结论', () => {
    // 实测踩到:qwen3.5 输出 "Thinking Process:\n\n1. **Analyze the Request:** …"
    // 而结论被 max_tokens 截断 —— 宽松匹配会把散文里的 a/b 当成裁决,
    // 于是 12 次裁决全判成"第二位赢",看着像位置偏置,实则是解析假象。
    const thinking = [
      'Thinking Process:',
      '',
      '1.  **Analyze the Request:**',
      '    *   Role: Task Quality Evaluator.',
      '    *   Task: Compare two assistant responses.',
      '2.  **Compare:** the answer is b because...',
    ].join('\n')
    expect(parsePairwiseJudgeOutput(thinking)).toBeNull()
  })

  it('【回归】枚举式伪结论（"b. 某条说明"）不得被当成裁决', () => {
    expect(parsePairwiseJudgeOutput('b. The assistant answer')).toBeNull()
  })

  it('解析:完全认不出 → null（绝不猜成 tie）', () => {
    expect(parsePairwiseJudgeOutput('')).toBeNull()
    expect(parsePairwiseJudgeOutput('   ')).toBeNull()
    expect(parsePairwiseJudgeOutput('抱歉，我无法判断。')).toBeNull()
  })

  it('解析:大小写与多余空格容错', () => {
    expect(parsePairwiseJudgeOutput('  A  3 ')?.winner).toBe('a')
    expect(parsePairwiseJudgeOutput('**b** 2')?.winner).toBe('b')
    expect(parsePairwiseJudgeOutput('TIE 5')?.winner).toBe('tie')
  })

  it('置信度被夹在 1~5', () => {
    expect(parsePairwiseJudgeOutput('a 99')?.confidence).toBe(5)
    expect(parsePairwiseJudgeOutput('a 0')?.confidence).toBe(1)
  })
})
