/**
 * New World — 受控对照的统计口径（M4-AE）
 * ═══════════════════════════════════════════════════════════════════════
 * 【这一批在测什么】
 * 「技能有没有用」的结论必须带上**不确定度**，而不是只报一个差值。
 *
 * 参照三个成熟实现：
 * - **inspect_ai**（UK AISI）：每个指标都带 `stderr()` / `ci()`，二值用 Wilson 区间
 * - **promptfoo 生态（Fullsend）**：框架本身不做显著性，要外挂 Wilson / bootstrap；
 *   经典案例 —— 19/20 = 95% 的 95% CI 是 [76.4%, 99.1%]，**不通过** 90% 门槛
 * - **配对评测方法论**：二值用 McNemar，连续量用配对 bootstrap，报效应量 + CI
 *
 * 这里钉住三件事：
 *   ① McNemar **精确**检验（不是卡方近似）—— 小样本下近似不可靠
 *   ② bootstrap **确定性**（固定种子）—— 同批数据两次跑必须给同样的区间
 *   ③ "还差多少对"必须**与主判定用同一个检验**，不能公式说够、检验说不够
 */
import { describe, it, expect } from 'vitest'

import {
  mulberry32,
  bootstrapMeanCI,
  mcnemarExactP,
  requiredPairsForDelta,
  requiredPairsForPower,
  formatCI,
} from '../../electron/learning/TrialStatistics'

describe('M4-AE 受控对照的统计口径', () => {
  it('mulberry32 是确定性的（同种子 → 同序列）', () => {
    const a = mulberry32(42)
    const b = mulberry32(42)
    expect([a(), a(), a()]).toEqual([b(), b(), b()])
    // 不同种子 → 不同序列（极大概率）
    const c = mulberry32(43)
    expect(c()).not.toBe(mulberry32(42)())
  })

  describe('McNemar 精确检验', () => {
    it('没有不一致对 → p=1（无从判断）', () => {
      expect(mcnemarExactP(0, 0)).toBe(1)
      expect(mcnemarExactP(3, 3)).toBe(1)
    })

    it('6 个配对全对全错 → p=0.03125 < 0.05（刚够）', () => {
      expect(mcnemarExactP(6, 0)).toBeCloseTo(0.03125, 6)
      expect(mcnemarExactP(0, 6)).toBeCloseTo(0.03125, 6)
    })

    it('【关键】5 个配对全对全错 → p=0.0625 > 0.05（**不够**）', () => {
      // 这正是"5 个配对就下结论"站不住的地方
      expect(mcnemarExactP(5, 0)).toBeCloseTo(0.0625, 6)
      expect(mcnemarExactP(5, 0)).toBeGreaterThan(0.05)
    })

    it('对称（交换 b/c 不改变 p）', () => {
      expect(mcnemarExactP(4, 1)).toBeCloseTo(mcnemarExactP(1, 4), 10)
    })

    it('优势越大 p 越小', () => {
      expect(mcnemarExactP(10, 1)).toBeLessThan(mcnemarExactP(6, 1))
    })
  })

  describe('bootstrap 均值区间', () => {
    it('确定性：同数据同种子 → 同区间', () => {
      const v = [1, 0, 1, 1, 0, 1]
      expect(bootstrapMeanCI(v)).toEqual(bootstrapMeanCI(v))
    })

    it('区间包含均值，且落在数据范围内', () => {
      const v = [1, 0, 1, 1, 0, 0, 1, 1]
      const ci = bootstrapMeanCI(v)
      expect(ci.mean).toBeCloseTo(5 / 8, 10)
      expect(ci.low).toBeLessThanOrEqual(ci.mean)
      expect(ci.high).toBeGreaterThanOrEqual(ci.mean)
      expect(ci.low).toBeGreaterThanOrEqual(0)
      expect(ci.high).toBeLessThanOrEqual(1)
    })

    it('全同值 → 区间退化为该值', () => {
      const ci = bootstrapMeanCI([1, 1, 1, 1])
      expect(ci).toEqual({ mean: 1, low: 1, high: 1 })
    })

    it('空数组 / 单元素不崩', () => {
      expect(bootstrapMeanCI([])).toEqual({ mean: 0, low: 0, high: 0 })
      expect(bootstrapMeanCI([0.5])).toEqual({ mean: 0.5, low: 0.5, high: 0.5 })
    })

    it('样本越多区间越窄', () => {
      const few = bootstrapMeanCI([1, 0, 1, 1])
      const many = bootstrapMeanCI(Array.from({ length: 40 }, (_, i) => (i % 4 === 0 ? 0 : 1)))
      expect(many.high - many.low).toBeLessThan(few.high - few.low)
    })
  })

  describe('"还差多少对"—— 与主判定同一个检验', () => {
    it('已经显著 → 不报"还差多少"(Infinity)', () => {
      expect(requiredPairsForDelta(6, 0, 6)).toBe(Infinity)
    })

    it('6 对里 4 胜 1 负 → 外推出一个有限的、比现在大的 n', () => {
      const need = requiredPairsForDelta(4, 1, 5)
      expect(Number.isFinite(need)).toBe(true)
      expect(need).toBeGreaterThan(5)
      // 外推出来的 n 必须真的让同一个检验显著 —— 不许"公式说够、检验说不够"
      const n0 = 5
      const scale = need / n0
      expect(mcnemarExactP(Math.round(4 * scale), Math.round(1 * scale))).toBeLessThan(0.05)
    })

    it('方向为零 → 无从估计', () => {
      expect(requiredPairsForDelta(3, 3, 6)).toBe(Infinity)
      expect(requiredPairsForDelta(0, 0, 0)).toBe(Infinity)
    })
  })

  describe('M4-AG 开跑前估算样本量', () => {
    it('效应越小、需要的任务越多', () => {
      expect(requiredPairsForPower(0.5)).toBeLessThan(requiredPairsForPower(0.3))
      expect(requiredPairsForPower(0.3)).toBeLessThan(requiredPairsForPower(0.2))
    })

    it('30% 差异 ≈ 80 个量级；20% ≈ 190 个量级（默认 40% 不一致率）', () => {
      expect(requiredPairsForPower(0.3)).toBeGreaterThan(60)
      expect(requiredPairsForPower(0.3)).toBeLessThan(120)
      expect(requiredPairsForPower(0.2)).toBeGreaterThan(140)
      expect(requiredPairsForPower(0.2)).toBeLessThan(260)
    })

    it('0 效应无从规划；极端分离下限为 2', () => {
      expect(requiredPairsForPower(0)).toBe(Infinity)
      expect(requiredPairsForPower(1)).toBe(2)
    })

    it('不一致率低于效应时按效应钳住（不返回 0 个）', () => {
      const n = requiredPairsForPower(0.5, 0.2)
      expect(Number.isFinite(n)).toBe(true)
      expect(n).toBeGreaterThan(0)
    })
  })

  it('formatCI 输出百分比区间', () => {
    expect(formatCI({ mean: 0.5, low: 0.2, high: 0.8 })).toBe('[20%, 80%]')
  })
})
