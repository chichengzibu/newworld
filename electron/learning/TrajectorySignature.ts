/**
 * PiPiClaw — 轨迹签名聚类（M4-I）
 * ═══════════════════════════════════════════════════════════════
 * 【要解决的问题】
 * 旧实现按**归一化指令**聚类 —— 要求指令**字面几乎相同**才算同一个模式。
 * 于是:
 *   「整理一下桌面」×2
 *   「收拾下桌面」   ×2
 * 这两件事**做的是同一套动作**,但分成两个簇,每个都够不到支持度门槛 → **永远不提提案**。
 *
 * 而「同一件事的不同说法」恰恰是最值得学的模式 —— 用户不会每次都用一样的措辞。
 *
 * 【业界依据 —— 三个独立工作收敛到同一结论】
 * - **TraceGraph**（arXiv:2605.31308）：把 agent 每一步编码成稀疏可观察键
 *   （动作/工具类型、观察模式、上下文线索），步骤相似度用**键重叠**算，
 *   **不依赖提示词文本** —— 明确指出按提示词聚类会丢掉有区分度的那个维度。
 * - **Hierarchical Clustering of Agent Traces**（2026-05）：对 agent 轨迹，
 *   存在**结构行为信号**（tool_call_sequence = 去重后的有序工具名、
 *   distinct_tools_invoked、tool_error_count…），而 chat 日志没有这些 ——
 *   所以按提示词聚类等于扔掉了区分维度。
 * - **AgentTrails**（arXiv:2607.18816）：把日志转成数据流图后**跨运行对齐**，
 *   高支持度的簇被提议用来播种可复用技能库。
 * - **Microsoft context-intelligence-gds**（图相似度配方）：把 Session→Tool
 *   投影成二部图，用 nodeSimilarity(Jaccard)/fastRP/node2vec 找
 *   「角色等价但邻居不完全相同」的会话。
 *
 * 【关键细节 —— 为什么要 IDF 加权】
 * 原始工具计数被**胶水工具**主导(Read/Bash/Glob 几乎出现在每条轨迹里),
 * 不加权的话所有轨迹看起来都一样 → 聚类塌成一个blob。
 * 业界配方是「比较前先给向量加权」—— 本模块用标准 IDF:
 *     idf(t) = log(N / df(t))
 * 出现在**所有**轨迹里的工具 → idf=0 → 权重为 0 → 完全不影响相似度。
 * 这正是我们要的:真正有区分度的是那些「偶尔才出现」的工具
 * (比如 load_skill、某个特定 Edit)。
 *
 * 【口径 —— 指令文本没有白扔】
 * 聚类键换成轨迹签名,但**指令文本仍是簇的代表**:提案的 name/description/
 * triggerCondition 来自簇内最高频的指令(用户自己的话最贴切)。
 * 换掉的是**分组依据**,不是丢掉指令。
 */
import type { TrajectorySummary } from './SelfLearner'

/** 一条轨迹用到的工具集合(有序去重) */
export type ToolSignature = string[]

/** 相似度阈值 —— 低于此视为不同模式 */
export const DEFAULT_SIGNATURE_THRESHOLD = 0.5

/**
 * 从一个步骤里取工具名。
 * 【三种形状都要认】
 * - agent loop:  `{ name: 'Read' }`
 * - TaskExecutor: `{ type: 'run_command' }` / `{ action: 'write_file' }`
 * - 旧观察:      `{ description: '...' }`（退化:用描述首词）
 */
export function toolOf(step: any): string | undefined {
  if (!step) return undefined
  const raw = step.name ?? step.type ?? step.action
  if (typeof raw === 'string' && raw.trim()) return raw.trim()
  if (typeof step.description === 'string' && step.description.trim()) {
    return step.description.trim().split(/\s+/)[0]
  }
  return undefined
}

/**
 * 一条轨迹的工具签名(有序去重)。
 * 【为什么保序】同一件事的执行**顺序**往往就是流程本身
 * (先列目录再写文件 vs 先写文件再列目录 —— 后者不对)。
 * 但**比较**时用集合(见 similarity)—— 顺序差异不该让同一模式分裂,
 * 因为用户每次的顺序可能略有出入。顺序信息保留在 signature 里供人工查看。
 */
export function signatureOf(trajectory: TrajectorySummary | undefined): ToolSignature {
  if (!trajectory || !Array.isArray(trajectory.steps)) return []
  const out: string[] = []
  const seen = new Set<string>()
  for (const step of trajectory.steps) {
    const t = toolOf(step)
    if (!t || seen.has(t)) continue
    seen.add(t)
    out.push(t)
  }
  return out
}

/**
 * IDF 权重表 —— idf(t) = log(N / df(t))。
 *
 * 【N 与 df 的口径】N = 参与聚类的**轨迹**条数(不是观察条数 ——
 * 一个观察可能含多次执行,每次都是一份证据)。
 * df(t) = 含工具 t 的轨迹条数。
 * 出现在全部轨迹里的工具 → idf = log(1) = 0 → 权重为零 → 不影响相似度。
 */
export function computeIdf(trajectories: TrajectorySummary[]): Map<string, number> {
  const N = trajectories.length
  const df = new Map<string, number>()
  for (const traj of trajectories) {
    for (const t of new Set(signatureOf(traj))) {
      df.set(t, (df.get(t) ?? 0) + 1)
    }
  }
  const idf = new Map<string, number>()
  for (const [tool, count] of df) {
    /**
     * 【用平滑 IDF,不是裸 IDF —— 这是个踩过的坑】
     * 裸 IDF: idf(t) = log(N / df(t))。
     * 出现在**全部**轨迹里的工具 → idf = log(1) = 0 → 权重为零。
     * 而学习闭环的分析窗口常常只有几条观察 —— 当轨迹数很少时,
     * **每个工具都出现在所有轨迹里** → 所有权重都是 0 →
     * 相似度恒为 0 → **一条都聚不到一起**(实测:2 条相同动作的轨迹聚不成簇)。
     *
     * 平滑 IDF(sklearn 的做法): idf(t) = log((1+N)/(1+df(t))) + 1
     *   - 权重恒 ≥ 1 → 任何语料规模下相似度都可算,小语料不再退化
     *   - 罕见工具权重仍显著高于胶水工具(N=4 时:胶水 1.0,罕见 2.22)
     *   → 胶水工具的压制从「绝对归零」变成「相对降权」,效果一样但不会把小语料打瞎
     */
    idf.set(tool, Math.log((1 + N) / (1 + count)) + 1)
  }
  return idf
}

/**
 * 加权 Jaccard 相似度 ∈ [0,1]。
 *
 *     sim(A,B) = Σ min(a_t, b_t) / Σ max(a_t, b_t)      (权重为 IDF)
 *
 * 用 min/max 而不是集合交的原始计数:权重必须参与"共有"与"任一方独有"两侧,
 * 否则高 IDF 的罕见工具会被稀释。
 */
export function similarity(
  a: Map<string, number>,
  b: Map<string, number>,
): number {
  let inter = 0
  let union = 0
  for (const [tool, w] of a) {
    const wb = b.get(tool) ?? 0
    inter += Math.min(w, wb)
    union += Math.max(w, wb)
  }
  for (const [tool, wb] of b) {
    if (!a.has(tool)) union += wb
  }
  if (union === 0) return 0
  return inter / union
}

/** 一个簇 */
export interface SignatureCluster<T> {
  /** 簇内成员 */
  members: T[];
  /** 簇的质心签名(成员签名的 IDF 加权平均) */
  centroid: Map<string, number>;
}

/**
 * 按轨迹签名做**贪心聚类**。
 *
 * 【为什么贪心而不是层次聚类】
 * 轨迹条数是几十到几百量级,层次聚类的 O(n²) 距离矩阵没必要;
 * 贪心「先到先得 + 相似度阈值」在这个量级上足够,且**结果可解释**
 * (能说清「这条轨迹和哪几条归到了一起」)。层次聚类的聚类树没人看得懂。
 *
 * 【确定性】按输入顺序处理,不引入随机 —— 同一批观察两次聚类结果相同,
 * 才能做回归对比。
 */
export function clusterBySignature<T extends { signature: ToolSignature }>(
  items: T[],
  idf: Map<string, number>,
  threshold: number = DEFAULT_SIGNATURE_THRESHOLD,
): SignatureCluster<T>[] {
  const clusters: SignatureCluster<T>[] = [];

  const toWeighted = (sig: ToolSignature): Map<string, number> => {
    const m = new Map<string, number>()
    for (const t of sig) m.set(t, idf.get(t) ?? 0)
    return m
  };

  for (const item of items) {
    const weighted = toWeighted(item.signature);
    if (weighted.size === 0) continue;
    // 与已有簇的质心比相似度,取最像的那个
    let bestIdx = -1;
    let bestSim = 0;
    for (let i = 0; i < clusters.length; i++) {
      const sim = similarity(weighted, clusters[i].centroid);
      if (sim > bestSim) { bestSim = sim; bestIdx = i; }
    }
    if (bestIdx >= 0 && bestSim >= threshold) {
      const c = clusters[bestIdx];
      c.members.push(item);
      // 质心 = IDF 加权平均
      const merged = new Map<string, number>();
      for (const m of c.members) {
        const w = toWeighted(m.signature);
        for (const [t, v] of w) merged.set(t, (merged.get(t) ?? 0) + v / c.members.length);
      }
      c.centroid = merged;
    } else {
      clusters.push({ members: [item], centroid: new Map(weighted) });
    }
  }
  return clusters;
}
