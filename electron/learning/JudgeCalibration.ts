/**
 * PiPiClaw — 裁判校准（M4-J）
 * ═══════════════════════════════════════════════════════════════════════
 * 【它补的是哪一环】
 * M4-F 把 LLM 裁判实现成了可选第四层,并在「遗留与后续」里明写:
 *   「裁判未做校准 —— 业界要求:先在人工标注样本上校准 judge 与人的一致度,
 *     再放量。本项目还没有人工标注集」
 * 本模块就是那半块:给裁判一把尺子。
 *
 * 【为什么校准是「先做」而不是「以后再说」】
 * 一个没校准过的裁判,它的分数不是数据,是噪声。业界实践一致:
 * 裁判在**人工标注集**上的一致度(κ)不到线,就不许参与放量决策
 * (LangSmith Align Evals / DIAL / openevals 均如此)。
 * 而 κ 这一层最容易被自欺: **原始一致率会高估 chance-corrected 一致度**
 * —— 在标签偏斜的数据集上,裁判全押多数类也能拿到 85% 原始一致率,
 * 而 κ 可能只有 0.25。所以本模块同时给两个数,不给单数。
 *
 * 【业界依据(本模块的每个数字都不是拍脑袋)】
 * - Cohen's κ(1960):chance-corrected 一致度 —— 校准的通用口径
 * - Wilson score interval:小样本下的二项比例置信区间(不像正态近似那样越界)
 * - Landis & Koch (1977):κ 的描述性分带(slight/fair/moderate/substantial/almost perfect)
 * - 位置偏置探针:同一对答案换序再问一次,看裁判会不会改口
 *   —— 出处:DIAL(arXiv 2609.31215)整篇论文的主贡献就是这个;
 *     业界经验做法是「跑两次、弃掉平局」(Michael Sam / arena-hard 社区共识)
 * - 冗长偏置探针:裁判偏爱长答复是公认缺陷,需单独测
 *
 * 【零依赖】
 * 本项目红线之一是「零新 npm 依赖」。所有统计量手写实现,数学可审计。
 * 做法对标 `bengodgart/llm-judge-calibration`(MIT,零依赖 Python 实现):
 * 同样的指标集、同样的「post-hoc 打分」架构(裁判跑一遍落盘 → 离线只算一致度)。
 *
 * 【与产品判决的关系】
 * 本模块**不改任何 pass/fail 结论**。它只回答一个问题:
 * 「这个裁判,和人的判断有多一致?在哪些范围内可信?」
 * 结论落进报告,由人决定要不要放量 —— 与 M4-F「裁判不改结论」同一条红线。
 */

/* ─────────────────────────── 数据类型 ─────────────────────────── */

/** 人工标注的一条 pairwise 样本 */
export interface CalibrationItem {
  id: string;
  /** 数据集名(panel / mt_bench) */
  dataset: string;
  /** 分类(panel-msc / mt_bench …)—— 报告里按类给结论 */
  category: string;
  /** 提问 */
  question: string;
  /** 参与比较的两个答复 */
  answerA: string;
  answerB: string;
  /** 人工标签:A / B / tie */
  humanLabel: 'A' | 'B' | 'tie';
  /** 逐票明细(MT-Bench 有多标注者;panel 已是共识标签) */
  humanVotes?: Record<string, number>;
  /** 人类内部有分歧(多标注者票数分散)—— 不进严格指标 */
  ambiguous?: boolean;
  /** 「两个都不好」(MT-Bench 的 tie(bothbad)) */
  bothBad?: boolean;
  license?: string;
  source?: string;
}

/**
 * 裁判在某条样本上的两次裁决 —— 两次只差**呈现顺序**。
 *
 * 【为什么必须跑两次】
 * 位置偏置(position bias)是裁判最稳定的缺陷: 偏爱先出现的那一个。
 * 单次跑**根本测不出来** —— 你只能看到"裁判选了 A",分不清
 * 「A 真的更好」还是「A 恰好排在前面」。换序再跑一次,答案自明。
 */
export interface JudgeVerdictRecord {
  id: string;
  /** A 在前时的选择: first(选中了先展示的) / second / tie / unknown */
  pickWhenAFirst: DisplayedPick;
  /** B 在前时的选择(同口径) */
  pickWhenBFirst: DisplayedPick;
  /** 裁判模型(用于 judge drift 对比) */
  model: string;
  /** 原始输出(取证用) */
  rawWhenAFirst?: string;
  rawWhenBFirst?: string;
  /**
   * 裁判给的理由/失败原因 —— 取证用。
   *
   * 【为什么必须留】实跑踩到:裁判模型名写错(装的是 `qwen3.8-27b-q4km:latest`,
   * 我写成 `qwen3.8:27b-q4km`)→ 240 次调用全部 "model not found" →
   * 全部记 unknown。报告诚实地写了"计入 0 条",但**看不出是模型名写错了**。
   * 留了 reason,失败原因就能直接进报告。
   */
  reasonWhenAFirst?: string;
  reasonWhenBFirst?: string;
  durationMs?: number;
}

/** 裁判选中的是展示位(而不是内容身份) */
export type DisplayedPick = 'first' | 'second' | 'tie' | 'unknown';

/* ─────────────────────────── 基础统计量 ─────────────────────────── */

/** 原始一致率 */
export function accuracy(pairs: Array<[string, string]>): number {
  if (pairs.length === 0) return 0
  let agree = 0
  for (const [h, j] of pairs) if (h === j) agree++
  return agree / pairs.length
}

/**
 * Cohen's κ —— chance-corrected 一致度(多分类版)。
 *
 * κ = (po - pe) / (1 - pe)
 *   po = 观测一致率; pe = 两人按各自基准率**独立**标注时的期望一致率
 *
 * 【为什么要它,不能只看原始一致率】
 * 标签偏斜时,裁判全押多数类也能拿高原始一致率。κ 扣掉这部分。
 */
export function cohenKappa(pairs: Array<[string, string]>): number {
  const n = pairs.length
  if (n === 0) return 0
  const labels = new Set<string>()
  for (const [h, j] of pairs) { labels.add(h); labels.add(j) }

  const po = accuracy(pairs)
  let pe = 0
  for (const label of labels) {
    const pHuman = pairs.filter(([h]) => h === label).length / n
    const pJudge = pairs.filter(([, j]) => j === label).length / n
    pe += pHuman * pJudge
  }
  if (pe >= 1) return 1
  return (po - pe) / (1 - pe)
}

/**
 * Wilson score 95% 置信区间(比例型)。
 *
 * 【为什么不用正态近似】
 * 正态近似在小 n 或比例贴近 0/1 时会算出越界区间。Wilson 永远落在 [0,1]。
 */
export function wilsonInterval(successes: number, n: number, z = 1.96): { low: number; high: number } {
  if (n <= 0) return { low: 0, high: 0 }
  const p = successes / n
  const z2 = z * z
  const denom = 1 + z2 / n
  const center = (p + z2 / (2 * n)) / denom
  const margin = (z * Math.sqrt((p * (1 - p)) / n + z2 / (4 * n * n))) / denom
  return { low: Math.max(0, center - margin), high: Math.min(1, center + margin) }
}

/** Pearson 相关系数 */
export function pearson(xs: number[], ys: number[]): number {
  const n = Math.min(xs.length, ys.length)
  if (n === 0) return 0
  const mx = xs.slice(0, n).reduce((a, b) => a + b, 0) / n
  const my = ys.slice(0, n).reduce((a, b) => a + b, 0) / n
  let sxy = 0, sxx = 0, syy = 0
  for (let i = 0; i < n; i++) {
    const dx = xs[i] - mx
    const dy = ys[i] - my
    sxy += dx * dy; sxx += dx * dx; syy += dy * dy
  }
  if (sxx === 0 || syy === 0) return 0
  return sxy / Math.sqrt(sxx * syy)
}

/** 混淆矩阵 —— 键为 "human|judge" */
export function confusionMatrix(pairs: Array<[string, string]>): Record<string, number> {
  const counts: Record<string, number> = {}
  for (const [h, j] of pairs) {
    const key = `${h}|${j}`
    counts[key] = (counts[key] ?? 0) + 1
  }
  return counts
}

/**
 * κ 的描述性分带 —— Landis & Koch (1977)。
 * 【注意】分带只是描述习惯,不是统计检验;样本量小时分带会过度自信,
 * 所以本模块的结论同时要求 n ≥ minN。
 */
export function kappaBand(kappa: number): string {
  if (kappa < 0) return '低于随机(worse than chance)'
  if (kappa < 0.21) return '微弱(slight)'
  if (kappa < 0.41) return '一般(fair)'
  if (kappa < 0.61) return '中等(moderate)'
  if (kappa < 0.81) return '较强(substantial)'
  return '几乎完美(almost perfect)'
}

/* ─────────────────────────── 偏置探针 ─────────────────────────── */

/** 位置偏置探针结果 */
export interface PositionProbe {
  /** 参与探针的样本数(两次都给出可解析结论的) */
  n: number;
  /** 换序后改口的样本数 */
  flips: number;
  /** 改口率 —— 0 = 完全顺序无关 */
  flipRate: number;
  /** 「纯位置偏置」次数:两次都选了先展示的那个 */
  firstPositionWins: number;
  /** 纯位置偏置占比 */
  firstPositionRate: number;
}

/**
 * 位置偏置探针。
 *
 * 【口径】只在两次都给出可解析结论(first/second)的样本上统计;
 * tie/unknown 的样本不参与 —— 它们说明不了顺序敏感性。
 */
export function positionProbe(records: JudgeVerdictRecord[]): PositionProbe {
  const usable = records.filter(r => r.pickWhenAFirst !== 'tie' && r.pickWhenAFirst !== 'unknown'
    && r.pickWhenBFirst !== 'tie' && r.pickWhenBFirst !== 'unknown')
  let flips = 0
  let firstPositionWins = 0
  for (const r of usable) {
    // 换序后改口 = 两次指向同一份内容
    const identityAFirst = r.pickWhenAFirst === 'first' ? 'A' : 'B'
    const identityBFirst = r.pickWhenBFirst === 'first' ? 'B' : 'A'
    if (identityAFirst !== identityBFirst) flips++
    // 纯位置偏置:A 在前选 A + B 在前选 B → 两次都是"先的那个赢"
    if (r.pickWhenAFirst === 'first' && r.pickWhenBFirst === 'first') firstPositionWins++
  }
  const n = usable.length
  return {
    n,
    flips,
    flipRate: n ? flips / n : 0,
    firstPositionWins,
    firstPositionRate: n ? firstPositionWins / n : 0,
  }
}

/** 冗长偏置探针结果 */
export interface VerbosityProbe {
  n: number;
  /** corr(lenA - lenB, 裁判是否选 A)—— 正值 = 偏好更长的那个 */
  correlation: number;
  /**
   * 相关性**是否可定义**。
   *
   * 【为什么要单独标】任一序列恒定时 Pearson 无定义(0/0)。
   * 例如裁判永远选 A → "是否选 A"全是 1 → 相关算不出来。
   * 此时若只报 correlation=0,读的人会以为"测过了、没有冗长偏置"——
   * 实际是"测不出来"。**算不出来 ≠ 没有**,必须分开说。
   */
  defined: boolean;
  /** 裁判选中的一侧的平均长度 */
  meanLenChosen: number;
  /** 未选中的一侧的平均长度 */
  meanLenOther: number;
}

/**
 * 冗长偏置探针。
 *
 * 【口径】用 (lenA - lenB) 与「裁判是否选 A」的相关:
 * 冗长偏置的表现是"长的一侧更容易被选中" → 相关为正。
 * 只统计裁判给出明确胜负的样本(tie/unknown 不算 —— 它们没有"选中"可言)。
 */
export function verbosityProbe(
  items: CalibrationItem[],
  records: JudgeVerdictRecord[],
): VerbosityProbe {
  const byId = new Map(items.map(i => [i.id, i]))
  const diffs: number[] = []
  const choseA: number[] = []
  let chosenLen = 0
  let otherLen = 0
  for (const rec of records) {
    const item = byId.get(rec.id)
    if (!item) continue
    const pick = resolveWinnerIdentity(rec)
    if (pick !== 'A' && pick !== 'B') continue
    const lenA = item.answerA.length
    const lenB = item.answerB.length
    diffs.push(lenA - lenB)
    choseA.push(pick === 'A' ? 1 : 0)
    if (pick === 'A') { chosenLen += lenA; otherLen += lenB }
    else { chosenLen += lenB; otherLen += lenA }
  }
  const n = diffs.length
  // 相关性可定义的前提:两个序列都要有方差
  const defined = n >= 2 && hasVariance(diffs) && hasVariance(choseA)
  return {
    n,
    correlation: defined ? pearson(diffs, choseA) : 0,
    defined,
    meanLenChosen: n ? chosenLen / n : 0,
    meanLenOther: n ? otherLen / n : 0,
  }
}

function hasVariance(xs: number[]): boolean {
  if (xs.length < 2) return false
  const mean = xs.reduce((a, b) => a + b, 0) / xs.length
  return xs.some(x => x !== mean)
}

/**
 * 把「展示位选择」翻译成「内容身份」。
 * A 在前时:first → A;B 在前时:first → B。
 */
export function resolveWinnerIdentity(rec: JudgeVerdictRecord, order: 'AFirst' | 'BFirst' = 'AFirst'): 'A' | 'B' | 'tie' | 'unknown' {
  const pick = order === 'AFirst' ? rec.pickWhenAFirst : rec.pickWhenBFirst
  if (pick === 'tie' || pick === 'unknown') return pick
  if (order === 'AFirst') return pick === 'first' ? 'A' : 'B'
  return pick === 'first' ? 'B' : 'A'
}

/* ─────────────────────────── 校准主流程 ─────────────────────────── */

/** 分类别结果 */
export interface CategoryResult {
  category: string;
  n: number;
  accuracy: number;
  kappa: number;
  band: string;
  /** 是否达到「可信」门槛 */
  reliable: boolean;
}

/** 分歧样本 */
export interface Disagreement {
  id: string;
  category: string;
  question: string;
  humanLabel: string;
  judgeLabel: string;
  /** 顺序是否改口 */
  orderFlipped: boolean;
}

/** 校准结论 */
export interface CalibrationVerdict {
  /** 是否达到可信门槛 */
  reliable: boolean;
  /** 一句话结论 —— 说清「可靠于什么、不可靠于什么」 */
  headline: string;
  /** 逐条理由 */
  reasons: string[];
  /** 建议(可执行) */
  recommendation: string;
}

/** 校准报告 */
export interface CalibrationReport {
  /** 样本总数 */
  n: number;
  /** 实际计入一致率的样本数 */
  scored: number;
  /** 裁判无法解析(unknown)的样本数 */
  unknown: number;
  /** 无法解析的原因归类(按条数降序)—— 用来区分"裁判能力差"与"基础设施故障" */
  unknownReasons: Array<{ reason: string; count: number }>;
  /** 人工标签是平局、不进 pairwise 指标的样本数 */
  excludedTie: number;
  /** 人工标注本身有歧义的样本数 */
  excludedAmbiguous: number;
  /** 原始一致率(在计入的样本上) */
  accuracy: number;
  /** 原始一致率的 95% Wilson 置信区间 */
  accuracyCI: { low: number; high: number };
  /** Cohen's κ(A/B/tie 三分类) */
  kappa: number;
  band: string;
  /** 混淆矩阵 "human|judge" → 条数 */
  confusion: Record<string, number>;
  /** 分类别结果(按 κ 升序,最差的在前) */
  perCategory: CategoryResult[];
  /** 位置偏置探针 */
  position: PositionProbe;
  /** 冗长偏置探针 */
  verbosity: VerbosityProbe;
  /** 分歧样本 */
  disagreements: Disagreement[];
  /** 结论 */
  verdict: CalibrationVerdict;
  /** 本次使用的门槛 */
  thresholds: CalibrationThresholds;
}

/** 校准门槛 —— 全部可见,不允许藏在代码里 */
export interface CalibrationThresholds {
  /** κ 门槛 */
  kappa: number;
  /** 最小样本量(样本太小则不给"可信"结论) */
  minN: number;
  /** 位置偏置换序改口率上限 */
  maxFlipRate: number;
  /** 冗长偏置相关系数绝对值上限 */
  maxVerbosityCorrelation: number;
}

export const DEFAULT_CALIBRATION_THRESHOLDS: CalibrationThresholds = {
  kappa: 0.6,
  minN: 30,
  maxFlipRate: 0.1,
  maxVerbosityCorrelation: 0.2,
}

/**
 * 跑一次校准。
 *
 * 【口径 —— 每一条都会写进报告,因为"悄悄换口径"是校准里最常见的自欺】
 * - 人工标签为 tie 的样本:**不进** pairwise 一致率(人都不分胜负,裁判凭什么分)
 * - 人工标注有歧义的样本(多标注者票数分散):不进严格指标
 * - 裁判输出无法解析:单独计数,不冒充"平局"
 * - κ 用三分类(A/B/tie)算 —— 把平局也当一类,比只算二分类严
 */
export function calibrate(
  items: CalibrationItem[],
  records: JudgeVerdictRecord[],
  thresholds: CalibrationThresholds = DEFAULT_CALIBRATION_THRESHOLDS,
): CalibrationReport {
  const itemById = new Map(items.map(i => [i.id, i]))
  const pairs: Array<[string, string]> = []
  const disagreements: Disagreement[] = []
  const unknownReasonCounts = new Map<string, number>()
  let unknown = 0
  let excludedTie = 0
  let excludedAmbiguous = 0

  for (const rec of records) {
    const item = itemById.get(rec.id)
    if (!item) continue
    if (item.ambiguous) { excludedAmbiguous++; continue }
    if (item.humanLabel === 'tie') { excludedTie++; continue }

    const judgeLabel = resolveWinnerIdentity(rec)
    if (judgeLabel === 'unknown') {
      unknown++
      // 归类失败原因:分清"裁判没给出可用结论"与"模型根本没跑起来"
      const reason = (rec.reasonWhenAFirst || rec.reasonWhenBFirst || '(未记录原因)').slice(0, 120)
      unknownReasonCounts.set(reason, (unknownReasonCounts.get(reason) ?? 0) + 1)
      continue
    }

    pairs.push([item.humanLabel, judgeLabel])
    if (judgeLabel !== item.humanLabel) {
      const identityAFirst = resolveWinnerIdentity(rec, 'AFirst')
      const identityBFirst = resolveWinnerIdentity(rec, 'BFirst')
      disagreements.push({
        id: rec.id,
        category: item.category,
        question: item.question,
        humanLabel: item.humanLabel,
        judgeLabel,
        orderFlipped: identityAFirst !== identityBFirst,
      })
    }
  }

  const scored = pairs.length
  const agreeCount = pairs.filter(([h, j]) => h === j).length
  const acc = accuracy(pairs)
  const kappa = cohenKappa(pairs)
  const position = positionProbe(records)
  const verbosity = verbosityProbe(items, records)

  // 分类别
  const byCategory = new Map<string, Array<[string, string]>>()
  for (const rec of records) {
    const item = itemById.get(rec.id)
    if (!item || item.ambiguous || item.humanLabel === 'tie') continue
    const judgeLabel = resolveWinnerIdentity(rec)
    if (judgeLabel === 'unknown') continue
    const list = byCategory.get(item.category) ?? []
    list.push([item.humanLabel, judgeLabel])
    byCategory.set(item.category, list)
  }
  const perCategory: CategoryResult[] = []
  for (const [category, list] of byCategory) {
    const k = cohenKappa(list)
    perCategory.push({
      category,
      n: list.length,
      accuracy: accuracy(list),
      kappa: k,
      band: kappaBand(k),
      reliable: list.length >= thresholds.minN && k >= thresholds.kappa,
    })
  }
  // 最差的排前面 —— 报告要让人先看到问题
  perCategory.sort((a, b) => a.kappa - b.kappa)

  const verdict = buildVerdict({
    scored, acc, kappa, position, verbosity, perCategory, thresholds,
  })

  return {
    n: records.length,
    scored,
    unknown,
    unknownReasons: [...unknownReasonCounts.entries()]
      .map(([reason, count]) => ({ reason, count }))
      .sort((a, b) => b.count - a.count),
    excludedTie,
    excludedAmbiguous,
    accuracy: acc,
    accuracyCI: wilsonInterval(agreeCount, scored),
    kappa,
    band: kappaBand(kappa),
    confusion: confusionMatrix(pairs),
    perCategory,
    position,
    verbosity,
    disagreements,
    verdict,
    thresholds,
  }
}

/** 按门槛生成诚实结论 —— 达标与不达标都要说清"到什么程度" */
function buildVerdict(input: {
  scored: number;
  acc: number;
  kappa: number;
  position: PositionProbe;
  verbosity: VerbosityProbe;
  perCategory: CategoryResult[];
  thresholds: CalibrationThresholds;
}): CalibrationVerdict {
  const { scored, acc, kappa, position, verbosity, perCategory, thresholds } = input
  const reasons: string[] = []

  const enoughN = scored >= thresholds.minN
  const kappaOk = kappa >= thresholds.kappa
  const flipOk = position.n > 0 && position.flipRate <= thresholds.maxFlipRate
  const verbosityOk = Math.abs(verbosity.correlation) <= thresholds.maxVerbosityCorrelation

  if (!enoughN) reasons.push(`样本量不足：计入 ${scored} 条 < 门槛 ${thresholds.minN} 条，结论不成立`)
  if (!kappaOk) reasons.push(`κ=${kappa.toFixed(3)} < 门槛 ${thresholds.kappa}（原始一致率 ${(acc * 100).toFixed(1)}%，但扣掉基准率后一致性不足）`)
  if (!flipOk) reasons.push(`位置偏置超标：换序改口率 ${(position.flipRate * 100).toFixed(1)}% > 门槛 ${(thresholds.maxFlipRate * 100).toFixed(0)}%`)
  if (!verbosityOk) reasons.push(`冗长偏置超标：长度相关性 ${verbosity.correlation.toFixed(3)} 超过 ±${thresholds.maxVerbosityCorrelation}`)
  // 不可测 ≠ 没有 —— 单独说明,免得读的人把"算不出来"当成"没问题"
  if (!verbosity.defined) {
    reasons.push(`冗长偏置**不可测**（n=${verbosity.n}，长度差或选择序列无方差）—— 不能据此说"没有冗长偏置"`)
  }

  const reliableCats = perCategory.filter(c => c.reliable)
  const unreliableCats = perCategory.filter(c => !c.reliable && c.n >= thresholds.minN)
  const reliable = enoughN && kappaOk && flipOk && verbosityOk

  const headline = reliable
    ? `裁判与人工的一致度达标（κ=${kappa.toFixed(3)} ${reasons.length ? '' : ''}），可用于${reliableCats.length ? `【${reliableCats.map(c => c.category).join('、')}】` : '所选场景'}的参考信号`
    : `裁判尚未达到可信门槛，不能用于放量决策（${reasons[0] ?? '综合门槛未达标'}）`

  if (reliable && unreliableCats.length) {
    reasons.push(`分类别看：${unreliableCats.map(c => `${c.category}(κ=${c.kappa.toFixed(2)}, n=${c.n})`).join('、')} 未达标 —— 别在这些类别上用`)
  }

  const recommendation = reliable
    ? '可按既定采样率（默认 5%）把裁判作为**参考信号**接入；仍不参与 pass/fail 判定。'
    : '保持裁判默认关闭（生产默认不传 judge）。先按上面的理由改提示词/换模型后重跑校准；每换一次裁判模型都要重新校准（judge drift）。'

  return { reliable, headline, reasons, recommendation }
}

/* ─────────────────────────── 报告渲染 ─────────────────────────── */

/**
 * 把校准结果渲染成 Markdown 报告。
 *
 * 【为什么要有报告而不是只给数字】
 * 校准的产物是**一个决定**(能不能放量),不是一堆指标。
 * 报告必须能让没参与跑数的人读完就知道结论是什么、依据是什么。
 */
export function renderCalibrationReport(
  report: CalibrationReport,
  meta: { model?: string; dataset?: string; generatedAt?: string } = {},
): string {
  const pct = (x: number) => `${(x * 100).toFixed(1)}%`
  const lines: string[] = []
  lines.push(`# 裁判校准报告${meta.model ? ` — ${meta.model}` : ''}`)
  lines.push('')
  if (meta.generatedAt) lines.push(`> 生成时间: ${meta.generatedAt}`)
  if (meta.dataset) lines.push(`> 标注集: ${meta.dataset}`)
  lines.push('')

  lines.push('## 结论')
  lines.push('')
  lines.push(`**${report.verdict.headline}**`)
  lines.push('')
  for (const r of report.verdict.reasons) lines.push(`- ${r}`)
  lines.push('')
  lines.push(`> 建议: ${report.verdict.recommendation}`)
  lines.push('')

  lines.push('## 一致度')
  lines.push('')
  lines.push('| 指标 | 值 |')
  lines.push('|---|---|')
  lines.push(`| 计入样本 | ${report.scored} |`)
  lines.push(`| 原始一致率 | ${pct(report.accuracy)} |`)
  lines.push(`| 原始一致率 95% CI (Wilson) | ${pct(report.accuracyCI.low)} ~ ${pct(report.accuracyCI.high)} |`)
  lines.push(`| Cohen's κ | ${report.kappa.toFixed(3)}（${report.band}） |`)
  lines.push(`| 排除：人工平局 | ${report.excludedTie} |`)
  lines.push(`| 排除：人工有歧义 | ${report.excludedAmbiguous} |`)
  lines.push(`| 裁判无法解析 | ${report.unknown} |`)
  lines.push('')
  if (report.unknownReasons.length) {
    lines.push('### 无法解析的原因（区分「裁判没结论」与「模型没跑起来」）')
    lines.push('')
    lines.push('| 原因 | 条数 |')
    lines.push('|---|---|')
    for (const r of report.unknownReasons) lines.push(`| ${r.reason} | ${r.count} |`)
    lines.push('')
  }

  lines.push('### 混淆矩阵（行=人工，列=裁判）')
  lines.push('')
  const labels = ['A', 'B', 'tie']
  lines.push(`| | ${labels.join(' | ')} |`)
  lines.push(`|---|${labels.map(() => '---').join('|')}|`)
  for (const h of labels) {
    const cells = labels.map(j => report.confusion[`${h}|${j}`] ?? 0)
    lines.push(`| ${h} | ${cells.join(' | ')} |`)
  }
  lines.push('')

  lines.push('## 偏置探针')
  lines.push('')
  lines.push('| 探针 | 结果 | 门槛 |')
  lines.push('|---|---|---|')
  lines.push(`| 位置偏置 · 换序改口率 | ${pct(report.position.flipRate)}（${report.position.flips}/${report.position.n}） | ≤ ${pct(report.thresholds.maxFlipRate)} |`)
  lines.push(`| 位置偏置 · 纯"先出现者赢"占比 | ${pct(report.position.firstPositionRate)} | — |`)
  lines.push(`| 冗长偏置 · 长度相关性 | ${report.verbosity.defined ? report.verbosity.correlation.toFixed(3) : '不可测（样本/方差不足）'} | ±${report.thresholds.maxVerbosityCorrelation} |`)
  lines.push(`| 冗长偏置 · 选中侧/未选中侧平均长度 | ${report.verbosity.meanLenChosen.toFixed(0)} / ${report.verbosity.meanLenOther.toFixed(0)} | — |`)
  lines.push('')

  lines.push('## 分类别')
  lines.push('')
  lines.push('| 类别 | n | 一致率 | κ | 分带 | 可信 |')
  lines.push('|---|---|---|---|---|---|')
  for (const c of report.perCategory) {
    lines.push(`| ${c.category} | ${c.n} | ${pct(c.accuracy)} | ${c.kappa.toFixed(3)} | ${c.band} | ${c.reliable ? '✅' : '❌'} |`)
  }
  lines.push('')

  if (report.disagreements.length) {
    lines.push(`## 分歧样本（前 20 / 共 ${report.disagreements.length}）`)
    lines.push('')
    lines.push('| id | 类别 | 人工 | 裁判 | 换序改口 |')
    lines.push('|---|---|---|---|---|')
    for (const d of report.disagreements.slice(0, 20)) {
      lines.push(`| ${d.id} | ${d.category} | ${d.humanLabel} | ${d.judgeLabel} | ${d.orderFlipped ? '是' : '否'} |`)
    }
    lines.push('')
  }

  lines.push('## 门槛')
  lines.push('')
  lines.push(`κ ≥ ${report.thresholds.kappa} · n ≥ ${report.thresholds.minN} · 换序改口率 ≤ ${report.thresholds.maxFlipRate} · 冗长相关性 ±${report.thresholds.maxVerbosityCorrelation}`)
  lines.push('')

  return lines.join('\n')
}
