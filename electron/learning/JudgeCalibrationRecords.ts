/**
 * PiPiClaw — 裁判校准记录存档（M4-V）
 * ═══════════════════════════════════════════════════════════════════════
 * 【这个文件是什么】
 * 每一条 = 一次**真实跑出来的**校准结果，进仓可审计。
 * 裁判放行门禁（JudgeTrust.ts）只认这里的记录。
 *
 * 【为什么把"没达标"的记录也留着】
 * 门禁对"没记录"的模型只会说"没有归档的校准记录"——
 * 用户看不懂那意味着什么。而这里两条记录各自写明了**哪一项不达标**:
 *   - qwen3.5:9b(默认裁判模型)     κ=0.411 / 改口率 67.9% / 冗长 0.257
 *   - qwen3.8-27b-q4km:latest       κ=0.467 / 改口率 79.5% / 冗长 0.412
 * 有记录才有具体原因;具体原因才可能有人去改。
 *
 * 【数据从哪来】
 * M4-J 实跑校准(2026-11-09)落盘的 240 条裁决 × 2 次换序,
 * 标注集 panel + mt_bench,每类抽 20 条。
 * 复算入口:tests/integration/judge-consensus-offline.test.ts
 * (纯计算,不调模型,秒级出结果)。
 *
 * 【怎么新增一条】
 * ① 重跑校准:PIPICLAW_CALIBRATION=1 npx vitest run tests/integration/judge-calibration-live.test.ts
 * ② 报告会打印可粘贴的记录(用 buildCalibrationRecord 推导,数字与报告同源)
 * ③ 贴到这里,并把结论写成人话 —— **不要只改数字不改结论**。
 */
import type { JudgeCalibrationRecord } from './JudgeTrust'

/**
 * 已归档的校准记录。
 *
 * 【注意两条都是"未达标"】
 * 这是**如实记录**,不是失败。门禁读到它们会给出具体的不达标项,
 * 而不是让用户面对一句"没有记录"。
 */
export const JUDGE_CALIBRATION_RECORDS: JudgeCalibrationRecord[] = [
  {
    model: 'qwen3.5:9b',
    calibratedAt: '2026-11-09T05:14:22.092Z',
    dataset: 'panel,mt_bench',
    n: 220,
    kappa: 0.411,
    flipRate: 0.679,
    verbosityCorrelation: 0.257,
    stableRuleHolds: false,
    stableSubsetKappa: -0.167,
    beatsLengthBaseline: false,
    baselineMeasurable: true,
    conclusion:
      '未达标:κ=0.411 < 0.6 · 换序改口率 67.9% > 10% · 冗长相关性 0.257 > ±0.2 · '
      + '「顺序一致才采信」规则不成立(一致子集 κ=-0.167 < 整体 0.411) · '
      + '裁判未强于「永远选更长的那个」这个平凡基线(基线 κ=0.638)。保持关闭。',
  },
  {
    model: 'qwen3.8-27b-q4km:latest',
    calibratedAt: '2026-11-09T05:19:32.500Z',
    dataset: 'panel,mt_bench',
    n: 220,
    kappa: 0.467,
    flipRate: 0.795,
    verbosityCorrelation: 0.412,
    stableRuleHolds: false,
    stableSubsetKappa: -0.003,
    beatsLengthBaseline: false,
    baselineMeasurable: true,
    conclusion:
      '未达标:κ=0.467 < 0.6 · 换序改口率 79.5% > 10% · 冗长相关性 0.412 > ±0.2 · '
      + '「顺序一致才采信」规则不成立(一致子集 κ=-0.003 < 整体 0.467) · '
      + '裁判未强于「永远选更长的那个」这个平凡基线(基线 κ=0.638)。'
      + '换更大的模型偏置反而更大 → 偏置不是容量问题,是提示词与采样口径问题。保持关闭。',
  },
]
