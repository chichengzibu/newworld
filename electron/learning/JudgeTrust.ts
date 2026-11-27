/**
 * New World — 裁判放行门禁（M4-V）
 * ═══════════════════════════════════════════════════════════════════════
 * 【它是什么】
 * 把 D7「LLM 裁判层保持默认关闭」从**一句注释**变成**一道会拦人的门**。
 *
 * 【为什么需要一道门，而不是一句约定】
 * D7 是 2026-11-09 用户的裁决：两个本地裁判模型实测都达不到可信门槛，
 * 裁判层保持默认关闭。注释挡不住任何人 —— 只要有人给 `runSkillTrial`
 * 传一个 judge，裁判就会在生产上跑起来，且**没人会看到任何提示**。
 * 门禁的职责：让"没校准过的裁判进生产"这件事**做不到**，而不是"不该做"。
 *
 * 【门禁放行什么】
 * 一次**归档的校准结果**。每条记录对应一个具体的裁判模型，含实测指标。
 * 门禁逐条核对，全部满足才放行；任一不满足就给出**具体是哪一条不满足**。
 *
 * 【D7 的解除条件与这道门的关系】
 * D7 写的是：「除非①换裁判模型或改提示词后**重新校准**达标，
 * 或②在**技能域**做人工标注校准」。
 * 本模块把 ① 变成可执行的:重跑校准 → 达标 → 生成记录 → 进仓 → 门禁放行。
 * ②(技能域标注集)尚未做，故门禁对它无话可说。
 *
 * 【记录为什么进仓，而不是放 userData】
 * 进仓 = **可审计**:谁在什么时候、用哪个模型、量到什么数、结论是什么，
 * 都在 git 历史里。放 userData 则随时可能被覆盖,且没人复核。
 * 一条"看起来达标"的记录必须有人为它负责 —— 进仓才有这个人。
 *
 * 【换模型即失效】
 * 记录的 `model` 必须与运行时用的模型**完全一致**才算命中。
 * judge drift 是真问题:换模型/换提示词/换采样口径都会改结果,
 * 旧模型的校准记录对新模型没有意义。
 */
import {
  DEFAULT_CALIBRATION_THRESHOLDS,
  type CalibrationReport,
  type CalibrationThresholds,
} from './JudgeCalibration'
import { JUDGE_CALIBRATION_RECORDS } from './JudgeCalibrationRecords'

/**
 * 一次归档的校准结果 —— 门禁的唯一依据。
 *
 * 【字段与来源一一对应】每个数字都能在校准报告里找到同名项，
 * 不引入报告里没有的指标(免得"门禁看的东西"和"校准量的东西"对不上)。
 */
export interface JudgeCalibrationRecord {
  /** 裁判模型标识 —— 必须与运行时使用的模型完全一致 */
  model: string;
  /** 校准时间(ISO 8601) */
  calibratedAt: string;
  /** 标注集 */
  dataset: string;
  /** 计入样本数 */
  n: number;
  /** 单次顺序判定的 Cohen's κ */
  kappa: number;
  /** 换序改口率 */
  flipRate: number;
  /** 冗长偏置相关系数 */
  verbosityCorrelation: number;
  /**
   * 「两次顺序一致才采信」这条规则在该模型上是否成立。
   *
   * 【为什么它是门禁项】
   * M4-N 的 pairwise 路径用的就是这条规则来决定"采信哪一次"。
   * 若它在该模型上不成立(实跑:被采信的一致子集 κ 反而更低),
   * 那么照它采信就是在**系统性地**挑中裁判最不准的那批配对。
   */
  stableRuleHolds: boolean;
  /** 顺序一致子集的 κ(审计用) */
  stableSubsetKappa: number;
  /** 裁判是否显著强于「永远选更长的那个」这个平凡基线 */
  beatsLengthBaseline: boolean;
  /**
   * 长度平凡基线在这份标注集上**是否可测**。
   *
   * 【为什么要分两个字段】
   * 标注集若两侧等长,基线无从判别 → 不可测。
   * "不可测"与"裁判没赢过基线"是**两回事**(DEV-036「自证不算证」同一条红线):
   * 前者不能拿来当后者的证据。故门禁只在**可测**时才拿它当否决项。
   */
  baselineMeasurable: boolean;
  /** 一句话结论 —— 进仓可审计 */
  conclusion: string;
}

/**
 * 门禁判定结果。
 */
export interface JudgeTrustVerdict {
  /** 是否允许这个裁判进生产 */
  trusted: boolean;
  /** 被查询的模型标识 */
  model: string;
  /** 命中的校准记录(没命中则没有) */
  record?: JudgeCalibrationRecord;
  /** 不放行的具体原因(中文,可直接展示给用户) */
  reasons: string[];
  /** 放行时的依据摘要(展示给用户看"凭什么信它") */
  basis?: string;
}

/**
 * 判定某个裁判模型能不能进生产。
 *
 * 【默认关闭是这里的第一条】
 * 没查到校准记录 → 不放行。这条排在最前，因为它是最常见的情形
 * (用户配了个从没校准过的模型)。
 */
export function evaluateJudgeTrust(
  model: string,
  records: JudgeCalibrationRecord[] = JUDGE_CALIBRATION_RECORDS,
  thresholds: CalibrationThresholds = DEFAULT_CALIBRATION_THRESHOLDS,
): JudgeTrustVerdict {
  const reasons: string[] = []
  const id = (model ?? '').trim()

  if (!id) {
    return { trusted: false, model: id, reasons: ['没有配置裁判模型 —— 无法判断它是否可信'] }
  }

  const record = records.find(r => r.model === id)
  if (!record) {
    return {
      trusted: false,
      model: id,
      reasons: [
        `裁判模型「${id}」没有归档的校准记录 —— 未校准的裁判,其分数不是数据,是噪声`,
        '解除方式:换裁判模型或改提示词后重新跑校准(见 tests/integration/judge-calibration-live.test.ts),达标后把记录进仓',
      ],
    }
  }

  if (record.n < thresholds.minN) {
    reasons.push(`校准样本量不足:计入 ${record.n} 条 < 门槛 ${thresholds.minN} 条`)
  }
  if (record.kappa < thresholds.kappa) {
    reasons.push(`κ=${record.kappa.toFixed(3)} < 门槛 ${thresholds.kappa}(扣掉基准率后一致性不足)`)
  }
  if (record.flipRate > thresholds.maxFlipRate) {
    reasons.push(`位置偏置超标:换序改口率 ${(record.flipRate * 100).toFixed(1)}% > 门槛 ${(thresholds.maxFlipRate * 100).toFixed(0)}%`)
  }
  if (Math.abs(record.verbosityCorrelation) > thresholds.maxVerbosityCorrelation) {
    reasons.push(`冗长偏置超标:长度相关性 ${record.verbosityCorrelation.toFixed(3)} 超过 ±${thresholds.maxVerbosityCorrelation}`)
  }
  if (!record.stableRuleHolds) {
    reasons.push(
      `「两次顺序一致才采信」这条规则在该模型上不成立(一致子集 κ=${record.stableSubsetKappa.toFixed(3)} < 整体 κ=${record.kappa.toFixed(3)})`
      + ` —— 照它采信会系统性地挑中裁判最不准的那批配对`,
    )
  }
  if (record.baselineMeasurable && !record.beatsLengthBaseline) {
    reasons.push('裁判没有显著强于「永远选更长的那个」这个平凡基线 —— 它测到的可能只是长度偏好,不是质量')
  }

  if (reasons.length > 0) {
    return { trusted: false, model: id, record, reasons }
  }

  return {
    trusted: true,
    model: id,
    record,
    reasons: [],
    basis: `已校准(${record.calibratedAt} 校准于 ${record.dataset},n=${record.n},κ=${record.kappa.toFixed(3)},`
      + `换序改口率 ${(record.flipRate * 100).toFixed(1)}%,顺序一致子集 κ=${record.stableSubsetKappa.toFixed(3)})`,
  }
}

/**
 * 放行凭据 —— 试验层(M4-E)用的形状。
 *
 * 【为什么要单独一个形状】
 * 门禁的判定结果带模型、记录、逐条理由;试验层只需要"能不能用 + 为什么"。
 * 让试验层直接吃 `JudgeTrustVerdict` 会把"记录"这种纯审计信息带进业务逻辑。
 */
export interface JudgeGate {
  /** 是否放行 */
  trusted: boolean;
  /** 中文说明:不放行时是原因,放行时是依据 */
  reason: string;
  /** 放行依据(不放行时没有) */
  basis?: string;
}

/**
 * 把门禁判定转成试验层用的放行凭据。
 */
export function toJudgeGate(verdict: JudgeTrustVerdict): JudgeGate {
  return {
    trusted: verdict.trusted,
    reason: verdict.trusted
      ? (verdict.basis ?? '已通过校准门禁')
      : verdict.reasons.join('；'),
    basis: verdict.basis,
  }
}

/**
 * 从一次校准报告生成归档记录 —— 校准跑完 → 记录生成 → 进仓 → 门禁放行。
 *
 * 【为什么要有这个函数,而不是手写记录】
 * 手写的记录迟早和报告对不上(改了一个数字忘了另一个)。
 * 这里让记录**只能**从报告推导出来,数字口径天然一致。
 */
export function buildCalibrationRecord(
  report: CalibrationReport,
  meta: { model: string; dataset: string; calibratedAt?: string },
): JudgeCalibrationRecord {
  return {
    model: meta.model,
    calibratedAt: meta.calibratedAt ?? new Date().toISOString(),
    dataset: meta.dataset,
    n: report.scored,
    kappa: report.kappa,
    flipRate: report.position.flipRate,
    verbosityCorrelation: report.verbosity.correlation,
    stableRuleHolds: report.consensus.stableRuleHolds,
    stableSubsetKappa: report.consensus.orderStable.kappa,
    beatsLengthBaseline: report.lengthBaseline.judgeBeatsBaseline,
    baselineMeasurable: report.lengthBaseline.baselineMeasurable,
    conclusion: report.verdict.headline,
  }
}
