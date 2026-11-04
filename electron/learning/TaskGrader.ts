/**
 * PiPiClaw — 任务评分器（M4-E）
 * ═══════════════════════════════════════════════════════════════
 * 【要解决的问题】
 * 「这个技能到底有没有用」要能被回答,前提是能判定「这次任务**成功**了没有」。
 * 但桌面助手的任务**没有唯一正确答案** —— 用户说「把桌面上的 PDF 归一下」,
 * 有无数种合法回复。所以不能用「答案等于参考答案」来判成败。
 *
 * 【业界做法(本模块的依据)】
 * - OpenAI 自己的 eval 模型把评估拆成 **(Dataset, Runner, Grader)** 三件套,
 *   且 Grader 是**分层**的:先跑确定性检查,再跑相似度,最后 LLM 裁判兜底。
 *   「顺序稳定化」——前面的检查挡住后面会漏掉的问题类型。
 * - LangSmith 的实践共识:**agent 输出很少有唯一正确答案,但几乎总能写出结构约束**
 *   (must_call / must_contain / must_not_call)。
 *   → 所以成功信号 = **硬信号 + 结构约束**,不是 golden answer。
 *
 * 【本模块的分层】
 *   ① hard_signal —— 确定性:没有工具失败、没有 run 错误、产出了最终答复
 *   ② structural —— 确定性:期望调用的工具调了 / 不该调的工具没调
 *   ③ similarity —— 确定性:答复与参考答案的余弦相似度(抓主题漂移)
 *   ④ llm_judge  —— 留接口(用本地 ollama 小模型跑,只对少量样本)
 *   ⑤ user_accept —— 留接口(用户是否接受/是否立刻纠正)
 *
 * 【为什么 ①②③ 优先且全确定性】
 * - 桌面应用的评估要能**离线**跑(本地 ollama 即可)
 * - 确定性检查不漂移;LLM 裁判会漂移(换模型/换提示词/换顺序都会改结果)
 * - 便宜:确定性检查是毫秒级,LLM 裁判是一次模型调用
 *
 * 【口径】判定为「成功」是**分层合取**:硬信号必须过,结构约束按需满足,
 * 相似度只作参考分(不单独决定成败) —— 避免「话术相似但没做成」被算成功。
 */

/** 一次执行的可评分事实(来自 agent run 的轨迹) */
export interface GradableRun {
  /** 用户原始指令 */
  instruction: string;
  /** 最终答复 */
  answer?: string;
  /** 工具调用序列(工具名) */
  toolsUsed?: string[];
  /** 是否有工具失败 */
  hadToolFailure?: boolean;
  /** 是否有 run 级错误 */
  hadError?: boolean;
  /** 是否产出了最终答复 */
  producedAnswer?: boolean;
  /** 参考答复(可选)—— 用于相似度层 */
  referenceAnswer?: string;
}

/** 一次任务的结构化期望(替代 golden answer) */
export interface TaskExpectation {
  /**
   * 必须调用过的工具(如 'Write' / 'load_skill:pdf-extract')。
   * 命中即加分;全命中才算通过这一层。
   */
  mustCall?: string[];
  /**
   * 不该调用的工具 —— 越权/危险操作的前置约束。
   */
  mustNotCall?: string[];
  /**
   * 答复里应当出现的关键内容(例如用户提到的目录名)。
   */
  mustContain?: string[];
  /** 硬信号的最低要求:是否必须产出最终答复(默认 true) */
  requireAnswer?: boolean;
}

/** 单层的判定结果 */
export interface GradeLayer {
  name: 'hard_signal' | 'structural' | 'similarity';
  /** 该层是否通过(不适用时为 undefined) */
  passed?: boolean;
  /** 该层的可读说明 */
  detail: string;
  /** 该层的数值分(0~1) */
  score: number;
}

/** 总评分结果 */
export interface GradeResult {
  /** 是否判定为成功 */
  passed: boolean;
  /** 综合分(0~1) */
  score: number;
  /** 各层明细 */
  layers: GradeLayer[];
  /** 未通过时的原因(第一条失败) */
  failedReason?: string;
}

/**
 * 余弦相似度 —— 与 MemoryVectorStore 的实现同口径(避免两处算得不一样)。
 */
export function cosineSimilarity(a: string, b: string): number {
  // 字符 bigram 集合的 Jaccard 余弦近似 —— 零依赖、可离线、对中文友好
  const grams = (s: string): Set<string> => {
    const out = new Set<string>();
    const chars = Array.from(s);
    if (chars.length === 1) { out.add(chars[0]); return out; }
    for (let i = 0; i < chars.length - 1; i++) out.add(chars[i] + chars[i + 1]);
    return out;
  };
  const ga = grams(a);
  const gb = grams(b);
  if (ga.size === 0 || gb.size === 0) return 0;
  let dot = 0;
  for (const g of ga) if (gb.has(g)) dot++;
  return dot / Math.sqrt(ga.size * gb.size);
}

/**
 * 分层评分。
 *
 * 【判定为成功的口径】
 * ① hard_signal **必须过** —— 工具失败 / run 报错 / 没产出答复 → 直接不算成功
 * ② structural **按期望判定** —— 只在任务给了结构约束时才有约束力
 * ③ similarity **只作参考分** —— 单独不决定成败(话术像但没做成,不能算成功)
 */
export function gradeRun(run: GradableRun, expectation: TaskExpectation = {}): GradeResult {
  const layers: GradeLayer[] = [];

  // ── ① 硬信号 ──
  const requireAnswer = expectation.requireAnswer !== false;
  const hardProblems: string[] = [];
  if (run.hadToolFailure) hardProblems.push('有工具调用失败');
  if (run.hadError) hardProblems.push('运行级错误');
  if (requireAnswer && run.producedAnswer === false) hardProblems.push('没有产出最终答复');
  layers.push({
    name: 'hard_signal',
    passed: hardProblems.length === 0,
    detail: hardProblems.length === 0 ? '无工具失败、无运行错误、有最终答复' : hardProblems.join(';'),
    score: hardProblems.length === 0 ? 1 : 0,
  });

  // ── ② 结构约束 ──
  const used = new Set(run.toolsUsed ?? []);
  const missing: string[] = [];
  const forbidden: string[] = [];
  for (const t of expectation.mustCall ?? []) {
    if (!used.has(t)) missing.push(t);
  }
  for (const t of expectation.mustNotCall ?? []) {
    if (used.has(t)) forbidden.push(t);
  }
  const missingContent = (expectation.mustContain ?? []).filter(c => !(run.answer ?? '').includes(c));
  if ((expectation.mustCall ?? []).length || (expectation.mustNotCall ?? []).length || (expectation.mustContain ?? []).length) {
    const problems = [
      ...missing.map(t => `未调用 ${t}`),
      ...forbidden.map(t => `不应调用却调用了 ${t}`),
      ...missingContent.map(c => `答复缺少「${c}」`),
    ];
    layers.push({
      name: 'structural',
      passed: problems.length === 0,
      detail: problems.length === 0 ? '结构约束全部满足' : problems.join(';'),
      score: problems.length === 0 ? 1 : 0,
    });
  } else {
    layers.push({
      name: 'structural',
      passed: undefined,
      detail: '该任务没有结构约束(跳过)',
      score: 1,
    });
  }

  // ── ③ 相似度(仅参考) ──
  if (run.referenceAnswer && run.answer) {
    const sim = cosineSimilarity(run.answer, run.referenceAnswer);
    layers.push({
      name: 'similarity',
      passed: undefined,   // 单独不决定成败
      detail: `与参考答案的相似度 ${sim.toFixed(3)}`,
      score: Math.max(0, Math.min(1, sim)),
    });
  } else {
    layers.push({
      name: 'similarity',
      passed: undefined,
      detail: '无参考答案(跳过)',
      score: 1,
    });
  }

  const hard = layers.find(l => l.name === 'hard_signal')!;
  const structural = layers.find(l => l.name === 'structural')!;
  const passed = hard.passed !== false && structural.passed !== false;
  const score = layers.reduce((s, l) => s + l.score, 0) / layers.length;

  return {
    passed,
    score,
    layers,
    ...(passed ? {} : { failedReason: hard.passed === false ? hard.detail : structural.detail }),
  };
}
