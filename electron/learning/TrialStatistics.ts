/**
 * PiPiClaw — 受控对照的统计口径（M4-AE）
 * ═══════════════════════════════════════════════════════════════════════
 * 【它补的是哪一环】
 * M4-E 的技能对照原本只做一件事:**比大小** —— 带技能成功率 80%、不带 40%,
 * 差 40% > 门槛 10% → 判"有帮助"。
 *
 * 但那是在 **5 个配对任务**上得出的。5 个样本里多对一次,差值就翻 20 个百分点。
 * 成熟评测框架对此的处理很一致:
 *   - inspect_ai:每个指标都带 `stderr()` / `ci()`,二值用 Wilson 区间
 *   - promptfoo 本身不做显著性,要靠外挂脚本算 Wilson / bootstrap
 *   - 配对评测方法论:二值用 **McNemar**,连续量用**配对 bootstrap**,报效应量 + CI
 * 而且有个经典反例(Fullsend 文档):19/20 = 95% **不通过** 90% 门槛
 * (95% CI 是 [76.4%, 99.1%]),190/200 才通过 —— **同样的一致率,相反的结论**。
 *
 * 本模块把这套口径做成**零依赖**的纯函数(项目红线:不加 npm 包),
 * 让"这个技能有没有用"的结论带上不确定度,而不是只报一个差值。
 *
 * 【口径边界 —— 必须说清】
 * - 这是**频率派**的近似,不是贝叶斯;不做多重比较校正(一次只看一个技能)
 * - bootstrap 用**确定性伪随机**(固定种子)→ 同一批数据两次跑出同样的区间,
 *   否则回归对比没有意义(与 RunJudge 的采样器同一取向)
 * - McNemar 用**精确二项检验**(而非卡方近似)—— 小样本下卡方近似不可靠,
 *   而"小样本"正是本项目的常态
 */

/** 确定性伪随机(mulberry32)—— 不用 Math.random,保证区间可复现 */
export function mulberry32(seed: number): () => number {
  let a = seed >>> 0
  return function next(): number {
    a = (a + 0x6d2b79f5) >>> 0
    let t = a
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

export interface MeanCI {
  mean: number
  low: number
  high: number
}

/**
 * 配对差值的 bootstrap 置信区间。
 *
 * 【为什么是 bootstrap 而不是 t 区间】
 * 配对差值是 {-1, 0, +1} 的离散量(二值成功率差),正态近似在小样本上很粗糙;
 * bootstrap 对分布形状不做假设,且实现上就是"重采样取分位数"。
 *
 * 【为什么固定种子】同一批数据两次跑必须给出同样的区间 ——
 * 否则"改了一行代码,区间变了"分不清是真变化还是抖动。
 */
export function bootstrapMeanCI(
  values: number[],
  opts: { iterations?: number; level?: number; seed?: number } = {},
): MeanCI {
  const { iterations = 2000, level = 0.95, seed = 20261121 } = opts
  const n = values.length
  if (n === 0) return { mean: 0, low: 0, high: 0 }

  const mean = values.reduce((a, b) => a + b, 0) / n
  if (n === 1) return { mean, low: mean, high: mean }

  const rnd = mulberry32(seed)
  const means: number[] = new Array(iterations)
  for (let i = 0; i < iterations; i++) {
    let sum = 0
    for (let j = 0; j < n; j++) {
      sum += values[Math.floor(rnd() * n)]
    }
    means[i] = sum / n
  }
  means.sort((a, b) => a - b)

  const alpha = (1 - level) / 2
  const lowIdx = Math.max(0, Math.floor(alpha * iterations))
  const highIdx = Math.min(iterations - 1, Math.ceil((1 - alpha) * iterations) - 1)
  return { mean, low: means[lowIdx], high: means[highIdx] }
}

/**
 * McNemar 精确检验(双侧)—— 配对二值结果。
 *
 * 【为什么不是卡方近似】经典 McNemar 用 χ²=(|b−c|−1)²/(b+c) 近似,
 * 在 b+c 很小时不准 —— 而本项目的对照实验经常只有 5~10 个配对。
 * 精确版:在 H0(两种处理成功率相同)下,不一致对里"带技能赢"的次数
 * 服从 Binomial(b+c, 0.5);双侧 p = 2 × P(X ≤ min(b,c)),上限 1。
 *
 * 【示例】6 个配对全部"带技能赢"→ b=6, c=0 → p = 2×0.5^6 = 0.03125 < 0.05 ✅
 *          5 个配对全部"带技能赢"→ p = 2×0.5^5 = 0.0625 > 0.05 ❌ 不够
 *          —— 这正是"5 个配对就下结论"站不住的地方。
 */
export function mcnemarExactP(b: number, c: number): number {
  const n = b + c
  if (n === 0) return 1
  const k = Math.min(b, c)
  // P(X ≤ k) for X ~ Binomial(n, 0.5),用递推避免大阶乘
  let p = Math.pow(0.5, n) // C(n,0)
  let cum = p
  for (let i = 1; i <= k; i++) {
    p = p * ((n - i + 1) / i) // C(n,i)/2^n
    cum += p
  }
  return Math.min(1, 2 * cum)
}

/**
 * 估计"要达到显著,大约还需要多少个配对"。
 *
 * 【为什么不用闭式功效公式】
 * 配对二值的标准公式 n ≈ (z_{1−α/2} + z_{1−β})² × (p10 + p01 − Δ²) / Δ²
 * 在 Δ=1(全对全错)时方差项退化为 0 —— 会算出"需要 0 个"这种荒唐结果。
 * 而本项目最常见的恰恰就是这种极端分离。
 *
 * 【改用什么】**按当前的不一致比例外推 + 用同一个精确检验搜最小 n**:
 * 把 (b, c) 按比例放大到 n,找第一个使 McNemar 精确 p < 0.05 的 n。
 * 好处:与主判定用的是**同一个检验**,不会出现"公式说够了、检验说不够"的自相矛盾。
 *
 * 【口径边界】这是**按当前观察比例外推**的粗估:
 * - 如果真实效应比观察到的小,所需样本会更多;反之更少
 * - 已显著或无不一致对时返回 Infinity(调用方据此不显示"还差多少")
 */
export function requiredPairsForDelta(
  b: number,
  c: number,
  totalPairs: number,
  opts: { targetP?: number; maxDiscordant?: number } = {},
): number {
  const { targetP = 0.05, maxDiscordant = 500 } = opts
  const d0 = b + c
  // McNemar 只看不一致对；但"还差多少**对**"要按**总配对**报 ——
  // 所以用当前的不一致率把"需要的不一致对"折算回总对数。
  // 少了这一步会得出"还需要 6 对"(实际是 6 个不一致对,总对数要更多)。
  if (d0 === 0 || b === c || totalPairs <= 0) return Infinity
  if (mcnemarExactP(b, c) < targetP) return Infinity // 已经够了,不必外推
  const discordantRate = d0 / totalPairs
  for (let d = d0 + 1; d <= maxDiscordant; d++) {
    const scale = d / d0
    const bn = Math.round(b * scale)
    const cn = Math.round(c * scale)
    if (bn === cn) continue // 取整后方向丢了,继续放大
    if (mcnemarExactP(bn, cn) < targetP) {
      return Math.ceil(d / discordantRate)
    }
  }
  return Infinity
}

/** 把区间格式化成"±x%"的说明串(给 note 用) */
export function formatCI(ci: MeanCI): string {
  const f = (v: number) => `${(v * 100).toFixed(0)}%`
  return `[${f(ci.low)}, ${f(ci.high)}]`
}
