/**
 * New World — 技能效用对照实验（M4-E）
 * ═══════════════════════════════════════════════════════════════
 * 【要回答的问题】
 * 「这个技能到底有没有用?」
 *
 * M4-D 只能给**观察性对比**:同类别任务下,带该技能的运行 vs 不带的运行。
 * 那有混杂 —— 用户可能专挑难活儿时才启用技能,于是差值被系统性低估。
 *
 * 【本模块做的是受控对照】
 * 同一个任务跑**两遍**:一遍允许用该技能,一遍禁止用(靠 LoadSkillTool 拒绝)。
 * 两遍的差别只剩「有没有这个技能」—— 这才是干净的因果对比。
 *
 * 【业界依据】
 * - OpenAI 的 eval 模型:**Eval = (Dataset, Runner, Grader)**。本模块是 Runner,
 *   数据集是 tasks[],Grader 是 TaskGrader.ts。
 * - ACE 社区的验证门(官方 ACK 自己没有):「a bullet is committed only when it
 *   raises held-out reward」→ 所以这里有**准入门**,不是光看分数。
 * - FlowEvo 的有害阈值 −0.1 → 本模块用 ±0.1 作为「有用 / 有害」的判定线。
 *
 * 【口径诚实 — 必须说清的三点】
 * ① 这是**受控**的(同任务配对),但**样本量小**(桌面应用,任务集有限)。
 *    n < MIN_TASKS 时只报「样本不足」,不给结论。
 * ② 「成功」的判定用的是**硬信号 + 结构约束**(TaskGrader),
 *    不是「答案等于参考答案」—— agent 输出没有唯一正确答案。
 * ③ 本模块**不做自动处置**:负贡献只报告,不自动禁用技能
 *    (自动处置需要更多样本 + 用户的知情同意)。
 */
import {
  gradeRun, gradeRunWithJudge,
  type GradableRun, type GradeResult, type TaskExpectation,
} from './TaskGrader'
import {
  bootstrapMeanCI, mcnemarExactP, requiredPairsForDelta, formatCI,
  type MeanCI,
} from './TrialStatistics'
import {
  createJudgeSampler, JUDGE_MIN_SAMPLES,
  DEFAULT_JUDGE_SAMPLE_RATE,
  type RunJudge,
  type PairwiseJudge,
} from './RunJudge'
import type { JudgeGate } from './JudgeTrust'

/** 对照实验里的一个任务 */
export interface TrialTask {
  id: string;
  /** 用户指令原文 */
  instruction: string;
  /** 结构化期望(替代 golden answer) */
  expectation?: TaskExpectation;
}

/**
 * 对照实验的附加选项。
 */
export interface TrialOptions {
  /**
   * 【M4-F】LLM 裁判 —— 可选,不传就只用确定性层。
   *
   * 【默认不跑】裁判是一次模型调用,且 judge drift 真实存在
   * (换模型/换提示词/换顺序都会改结果)。要跑就显式传。
   */
  judge?: RunJudge;
  /**
   * 裁判采样率(默认 0.05 —— 业界建议的 2~5%)。
   * 只有被采样到的样本才跑裁判。
   */
  judgeSampleRate?: number;
  /**
   * 【M4-N】pairwise 裁判 —— 直接比较「带技能」与「不带技能」这**两次运行**。
   *
   * 【为什么是 pairwise 而不是各自打分再比大小】
   * ① 业界一致:pointwise 分数会挤在高分区间、需要额外做量表校准;
   *    pairwise(「哪一个更好」)稳定得多。
   * ② 「带/不带这个技能哪个更好」**本来就是**一个 pairwise 问题。
   *
   * 【为什么必须换序双向跑】
   * M4-J 实测:本地裁判的**换序改口率高达 68~80%** —— 单次顺序的比较几乎没有信息量。
   * 故:正反各跑一次,**两次结论一致才采信**;不一致记 'unstable'(不是"平局")。
   *
   * 【默认不跑】与 D7 一致(裁判层保持默认关闭);且它**不参与最终判定**,
   * 只作为参考信号进说明 —— judge drift 真实存在,不能让结论随裁判漂移。
   */
  pairwiseJudge?: PairwiseJudge;
  /**
   * 【M4-V】pairwise 裁判的**放行凭据** —— 校准门禁的判定结果。
   *
   * 【为什么传了 judge 还必须传它】
   * D7 原来只是一句注释:注释挡不住任何人。
   * 门禁把这句约定变成会拦人的东西:传了 `pairwiseJudge` 却没给
   * 放行凭据(或凭据说"不放行")→ **裁判不会被调用**,
   * 且试验结果里会写明为什么不跑。
   *
   * 【不跑而不是"跑了再说"】
   * 一次 pairwise 判定是**两次模型调用**。对一个没校准过的裁判花这个钱,
   * 换回来的结论既不能用、又会污染说明。宁可不跑,并说清楚。
   */
  pairwiseGate?: JudgeGate;
  /**
   * 【M4-AF】每个变体跑几遍（默认 1）。
   *
   * 【为什么】单次运行自带随机性：同样的任务、同样的技能，一次成功一次失败并不罕见。
   * 只跑一遍就把"这一次"当成"这个技能的效果"，会把噪声当信号。
   * 参照 inspect_ai 的 **epochs**：同一任务重复采样，再归约（它们默认用 mean）。
   *
   * 【口径】
   * - 二值：**多数票**（`passed × 2 > repeats`；平票按"不通过"—— 保守）
   * - 连续分：取**均值**
   * - 点式裁判只在**第一遍**上跑（裁判是一次模型调用，不能跟着重复数一起翻倍）
   * - 某次执行抛错 → 该次不计入；全抛错 → 该变体故障（与原来一致）
   *
   * 【成本】模型调用数 × repeats —— 界面上必须先告知。
   */
  repeats?: number;
}

/**
 * 裁判对照的状态 —— 调用方**请求过**裁判对照时必存在。
 *
 * 【为什么要有这个字段】
 * M4-S 的教训:输出层看不到任何东西,用户会以为"没这回事"。
 * 门禁拦下裁判时,用户必须看到**为什么**被拦,而不是看到一片空白。
 */
export interface TrialJudgeStatus {
  /** 裁判是否真的调用了 */
  ran: boolean;
  /** 门禁是否放行 */
  trusted: boolean;
  /** 中文说明(直接展示) */
  reason: string;
}

/**
 * 执行器 —— 把任务跑一遍并返回可评分的事实。
 *
 * 【为什么要抽出来】
 * 让本模块保持**纯逻辑**:测试里用假执行器,不联网、不调模型;
 * 生产里由 ChatManager 提供真执行器(带/不带技能各跑一次)。
 */
export type TrialExecutor = (
  task: TrialTask,
  opts: { suppressedSkills: string[] },
) => Promise<GradableRun>

/** 单个变体的结果 */
export interface TrialVariant {
  variant: 'with_skill' | 'without_skill';
  run: GradableRun;
  grade: GradeResult;
}

/**
 * pairwise 裁判对一次配对的判定。
 *
 * `unstable` = **两次顺序的结论不一致**(或裁判输出无法解析)——
 * 这不是"平局",而是"这个裁判在这一对上看不出稳定偏好"。
 */
export type PairwiseTrialVerdict = 'with_better' | 'without_better' | 'tie' | 'unstable';

/** 单个任务的配对结果 */
export interface TrialTaskPair {
  task: TrialTask;
  withSkill: TrialVariant;
  withoutSkill: TrialVariant;
  /** 成功率差值(-1 ~ 1)—— 只对「成/败」这个二值判定有意义 */
  delta: number;
  /**
   * 【M4-N】综合分差(= 带技能的综合分 − 不带技能的)。
   *
   * 【为什么二元 delta 不够】
   * `passed` 是二值的:两次都"失败"时,一次错 1 个工具、一次错 5 个,
   * 二值差值一律记 0 → 结论"看不出差别"。而 `GradeResult.score` 是**分层均值**
   * (硬信号/结构约束/相似度),能看出这层差别。
   * 故:二元差值仍为准入门(设计已定),综合分差作为**更敏感的辅助信号**。
   */
  scoreDelta: number;
  /** 【M4-N】pairwise 裁判的判定(没跑裁判则没有这个字段) */
  pairwise?: PairwiseTrialVerdict;
}

/** 总结论 */
export interface TrialSummary {
  /** 参与判定的任务数 */
  n: number;
  /** 【M4-AF】每个变体重复了几遍（1 = 未重复） */
  repeats: number;
  /** 带技能的成功能次数 */
  withSkillSuccesses: number;
  /** 不带技能的成功能次数 */
  withoutSkillSuccesses: number;
  withSkillRate: number;
  withoutSkillRate: number;
  /** 差值 = 带 - 不带 */
  delta: number;
  /**
   * 结论:
   *   positive        —— 有帮助(差值超过门槛)
   *   negative        —— 有害(差值低于门槛)
   *   neutral         —— 看不出差别
   *   insufficient_data —— 样本不足,不给结论
   */
  verdict: 'positive' | 'negative' | 'neutral' | 'insufficient_data';
  /** 判定门槛与样本量的说明(界面要如实展示) */
  note: string;
  /**
   * 【M4-N】各配对任务综合分差的均值(带 − 不带)。
   * 二元差值是 0 时,这个值仍可能说明"有差别、只是都没过线"。
   */
  meanScoreDelta: number;
  /**
   * 【M4-N】综合分差的方向一致性:
   *   consistent_with —— 各配对任务的分差同号(方向一致,说明不是噪声)
   *   mixed          —— 方向不一致(正负都有 → 差值不可信)
   *   none           —— 全是 0
   */
  scoreDeltaDirection: 'consistent_with' | 'consistent_against' | 'mixed' | 'none';
  /**
   * 【M4-AE】统计口径 —— 结论带不确定度,而不是只报一个差值。
   *
   * 【为什么要有】"5 个配对里全对全错"的 McNemar 精确 p 也只有 0.0625,
   * 达不到 0.05 —— 按效应量直接判"有帮助"会系统性高估。
   * 成熟评测框架(inspect_ai / promptfoo 生态)都要求报 CI;
   * 这里用零依赖的精密实现:二值 McNemar 精确检验 + 配对 bootstrap。
   */
  stats: {
    /** 带技能赢、不带技能输的配对数 */
    withOnly: number;
    /** 不带技能赢、带技能输的配对数 */
    withoutOnly: number;
    /** McNemar 精确检验(双侧)的 p 值 */
    pValue: number;
    /** 二值成功率差的 95% bootstrap 区间 */
    binaryCI: MeanCI;
    /** 综合分差均值的 95% bootstrap 区间 */
    scoreCI: MeanCI;
    /** 按当前效应外推:要达到 80% 功效大约需要的配对总数(无从估计则没有) */
    requiredPairs?: number;
  };
  /**
   * 【M4-N】pairwise 裁判的汇总(只作参考信号,不参与 verdict)。
   * `unstable` 占比高 = 裁判在这一批上顺序敏感 → 参考价值低。
   */
  pairwise?: {
    n: number;
    withBetter: number;
    withoutBetter: number;
    tie: number;
    unstable: number;
    note: string;
  };
  /**
   * 【M4-V】裁判对照的状态。
   *
   * 存在 = 调用方**请求过**裁判对照(不论有没有跑成)。
   * 没请求过 → 没有这个字段(用户没开这个开关,不必提)。
   */
  judgeStatus?: TrialJudgeStatus;
}

/** 一次对照实验的完整结果 */
export interface TrialResult {
  skillId: string;
  /** 每个任务的配对明细 */
  pairs: TrialTaskPair[];
  summary: TrialSummary;
  /** 结束时间 */
  finishedAt: number;
}

/**
 * 【M4-E】判定门槛。
 *
 * - 样本量:少于 5 个配对任务,差值不可靠(3 次运行得出的差值一次翻转就是 ±33%)→ 只报样本不足
 * - 差值门槛:±0.1(FlowEvo 用的是 −0.1 作为有害线,这里对称取)
 */
export const TRIAL_MIN_TASKS = 5;
export const TRIAL_DELTA_THRESHOLD = 0.1;

/**
 * 跑一次对照实验。
 *
 * 【顺序】每个任务先跑「带技能」再跑「不带技能」——
 * 带技能在前,因为那是真实使用路径(先跑能拿到真实轨迹)。
 *
 * 【失败隔离】某个任务的某个变体失败(执行抛错)时,
 * 该任务**不计入**统计(而不是当成失败)—— 那是实验故障,不是任务失败。
 */
export async function runSkillTrial(
  skillId: string,
  tasks: TrialTask[],
  executor: TrialExecutor,
  opts: TrialOptions = {},
): Promise<TrialResult> {
  const pairs: TrialTaskPair[] = [];
  const sampler = createJudgeSampler(opts.judgeSampleRate ?? DEFAULT_JUDGE_SAMPLE_RATE);
  let judgeRuns = 0;
  let pairwiseRuns = 0;

  // 【M4-V】门禁 —— 裁判对照要么跑,要么说清为什么不跑。
  //
  // 三种状态:
  //   没请求        → 不提裁判(用户没开这个开关)
  //   请求但未放行  → 不跑(省两次模型调用),并把原因写进结果
  //   请求且放行    → 跑,并把放行依据写进结果
  const pairwiseRequested = !!opts.pairwiseJudge;
  const gate = opts.pairwiseGate;
  const pairwiseAllowed = pairwiseRequested && !!gate && gate.trusted;
  const pairwiseBlockReason = pairwiseRequested && !pairwiseAllowed
    ? (gate
      ? gate.reason
      : '没有提供放行凭据 —— 裁判未通过校准门禁(D7:裁判层保持默认关闭)')
    : '';

  // 【M4-AF】重复运行 + 归约（参照 inspect_ai 的 epochs）
  const repeats = Math.max(1, Math.floor(opts.repeats ?? 1));

  for (const [taskIndex, task] of tasks.entries()) {
    const useJudge = !!opts.judge && sampler(taskIndex);

    /**
     * 跑一个变体 repeats 遍，再归约。
     *
     * 【为什么归约】单次运行自带随机性 —— 同一任务一次成功一次失败很常见，
     * 拿"这一次"当"这个技能的效果"就是把噪声当信号。
     * 【口径】二值取多数票（平票按不通过，保守）；连续分取均值；
     * 点式裁判只在第一遍上跑（裁判是一次模型调用，不能跟着 repeats 翻倍）。
     */
    const runVariant = async (suppressed: string[]): Promise<{ run: GradableRun; grade: GradeResult } | null> => {
      const runs: GradableRun[] = [];
      for (let i = 0; i < repeats; i++) {
        try {
          runs.push(await executor(task, { suppressedSkills: suppressed }));
        } catch { /* 该次故障 → 跳过（实验故障 ≠ 任务失败） */ }
      }
      if (runs.length === 0) return null;

      const first = runs[0];
      const grades: GradeResult[] = [
        useJudge
          ? await gradeRunWithJudge(first, task.expectation ?? {}, opts.judge)
          : gradeRun(first, task.expectation ?? {}),
      ];
      for (let i = 1; i < runs.length; i++) {
        grades.push(gradeRun(runs[i], task.expectation ?? {}));
      }

      const passedCount = grades.filter(g => g.passed).length;
      const passed = grades.length === 1 ? grades[0].passed : passedCount * 2 > grades.length;
      const score = grades.reduce((a, g) => a + g.score, 0) / grades.length;
      return { run: first, grade: { ...grades[0], passed, score } };
    };

    const withVariant = await runVariant([]);
    const withoutVariant = await runVariant([skillId]);
    if (!withVariant || !withoutVariant) continue;
    if (useJudge) judgeRuns++;

    const withRun = withVariant.run;
    const withGrade = withVariant.grade;
    const withoutRun = withoutVariant.run;
    const withoutGrade = withoutVariant.grade;

    const pair: TrialTaskPair = {
      task,
      withSkill: { variant: 'with_skill', run: withRun, grade: withGrade },
      withoutSkill: { variant: 'without_skill', run: withoutRun, grade: withoutGrade },
      delta: (withGrade.passed ? 1 : 0) - (withoutGrade.passed ? 1 : 0),
      scoreDelta: withGrade.score - withoutGrade.score,
    };

    // 【M4-N】pairwise 裁判:**正反各跑一次,两次一致才采信**。
    // 单次顺序的比较在本地裁判上几乎没有信息量(实测换序改口率 68~80%)。
    //
    // 【M4-V】这条规则现在有据可依了】
    // "顺序一致 ⇒ 更可信"这条代理**曾经是没验证过的**(实跑发现它反着:
    // 被采信的一致子集 κ 反而更低)。现在放行凭据里要求
    // `stableRuleHolds === true` —— 校准必须证明这条规则在该模型上成立,
    // 才允许跑到这一行。否则门禁在上一层就拦住了,根本到不了这里。
    if (pairwiseAllowed && opts.pairwiseJudge && sampler(taskIndex)) {
      const forward = await opts.pairwiseJudge(withRun, withoutRun, task.expectation);
      const backward = await opts.pairwiseJudge(withoutRun, withRun, task.expectation);
      const prefForward = forward.winner === 'a' ? 'with_better'
        : forward.winner === 'b' ? 'without_better' : 'tie';
      const prefBackward = backward.winner === 'a' ? 'without_better'
        : backward.winner === 'b' ? 'with_better' : 'tie';
      const unusable = forward.winner === 'unknown' || backward.winner === 'unknown';
      pair.pairwise = (unusable || prefForward !== prefBackward)
        ? 'unstable'
        : prefForward;
      pairwiseRuns++;
    }

    pairs.push(pair);
  }

  const summary = summarize(pairs.length, pairs, repeats);
  // 【M4-V】裁判对照的状态 —— 请求过就必须有说法,不允许静默
  if (pairwiseRequested) {
    summary.judgeStatus = pairwiseAllowed
      ? {
        ran: pairwiseRuns > 0,
        trusted: true,
        reason: pairwiseRuns > 0
          ? (gate?.basis ?? '已通过校准门禁')
          : '裁判对照已放行,但本次没有样本落在采样率内 —— 未产生任何裁判调用',
      }
      : { ran: false, trusted: false, reason: pairwiseBlockReason };
  }
  // 【M4-N】pairwise 裁判汇总(参考信号,不参与 verdict)
  if (pairwiseAllowed && pairwiseRuns > 0) {
    const withBetter = pairs.filter(p => p.pairwise === 'with_better').length;
    const withoutBetter = pairs.filter(p => p.pairwise === 'without_better').length;
    const tie = pairs.filter(p => p.pairwise === 'tie').length;
    const unstable = pairs.filter(p => p.pairwise === 'unstable').length;
    const unstableNote = unstable > 0
      ? `;其中 ${unstable} 个**两次顺序结论不一致**(unstable)——裁判在这些配对上顺序敏感,不可当结论用`
      : '';
    summary.pairwise = {
      n: pairwiseRuns,
      withBetter,
      withoutBetter,
      tie,
      unstable,
      note: `pairwise 裁判(参考信号,不参与判定):${pairwiseRuns} 个配对 —— 带技能更好 ${withBetter} / 不带更好 ${withoutBetter} / 平局 ${tie}${unstableNote}`,
    };
    summary.note += `;${summary.pairwise.note}`;
  }
  // 【M4-F】裁判样本量不足 → 裁判结论不给(与主结论同样的口径)
  if (judgeRuns > 0 && judgeRuns < JUDGE_MIN_SAMPLES) {
    summary.note += `;裁判只跑了 ${judgeRuns} 个样本(至少 ${JUDGE_MIN_SAMPLES} 个)—— 裁判结论仅供参考`;
  }

  return {
    skillId,
    pairs,
    summary,
    finishedAt: Date.now(),
  };
}

/**
 * 汇总 —— 纯函数,便于单测。
 */
export function summarize(n: number, pairs: TrialTaskPair[], repeats = 1): TrialSummary {
  const withSkillSuccesses = pairs.filter(p => p.withSkill.grade.passed).length;
  const withoutSkillSuccesses = pairs.filter(p => p.withoutSkill.grade.passed).length;
  const withSkillRate = n > 0 ? withSkillSuccesses / n : 0;
  const withoutSkillRate = n > 0 ? withoutSkillSuccesses / n : 0;
  const delta = withSkillRate - withoutSkillRate;

  // 【M4-N】综合分差(连续信号)—— 二元差值看不出来时,它还能看出差别
  const scoreDeltas = pairs.map(p => p.scoreDelta);
  const meanScoreDelta = n > 0 ? scoreDeltas.reduce((a, b) => a + b, 0) / n : 0;
  const pos = scoreDeltas.filter(d => d > 1e-9).length;
  const neg = scoreDeltas.filter(d => d < -1e-9).length;
  const scoreDeltaDirection: TrialSummary['scoreDeltaDirection'] =
    pos > 0 && neg === 0 ? 'consistent_with'
      : neg > 0 && pos === 0 ? 'consistent_against'
        : pos > 0 && neg > 0 ? 'mixed'
          : 'none';

  // 【M4-AE】统计口径 —— 参照 inspect_ai 的 CI 指标 / 配对评测方法论的 McNemar + 配对 bootstrap。
  //
  // 【为什么必须加】5 个配对里"全对全错"时 McNemar 精确 p 也只有 0.0625 > 0.05 ——
  // 按效应量直接判"有帮助"会系统性高估。Fullsend 文档里的经典反例同理:
  // 19/20 = 95%,其 95% CI 是 [76.4%, 99.1%],**不通过** 90% 门槛。
  const withOnly = pairs.filter(p => p.withSkill.grade.passed && !p.withoutSkill.grade.passed).length;
  const withoutOnly = pairs.filter(p => !p.withSkill.grade.passed && p.withoutSkill.grade.passed).length;
  const pValue = mcnemarExactP(withOnly, withoutOnly);
  const binaryCI = bootstrapMeanCI(pairs.map(p => p.delta));
  const scoreCI = bootstrapMeanCI(scoreDeltas);
  const estimatedPairs = requiredPairsForDelta(withOnly, withoutOnly, n);
  const stats: TrialSummary['stats'] = {
    withOnly,
    withoutOnly,
    pValue,
    binaryCI,
    scoreCI,
    ...(Number.isFinite(estimatedPairs) && estimatedPairs > n ? { requiredPairs: estimatedPairs } : {}),
  };

  if (n < TRIAL_MIN_TASKS) {
    return {
      n,
      repeats,
      withSkillSuccesses,
      withoutSkillSuccesses,
      withSkillRate,
      withoutSkillRate,
      delta,
      verdict: 'insufficient_data',
      meanScoreDelta,
      scoreDeltaDirection,
      stats,
      note: `样本不足:只有 ${n} 个配对任务(至少需要 ${TRIAL_MIN_TASKS} 个)—— 差值不可靠,不给结论;当前差值 95% CI ${formatCI(binaryCI)}`,
    };
  }

  const effect: 'positive' | 'negative' | 'neutral' =
    delta > TRIAL_DELTA_THRESHOLD ? 'positive'
      : delta < -TRIAL_DELTA_THRESHOLD ? 'negative'
        : 'neutral';
  // 【M4-AE】方向过门槛、但统计不显著 → **不冒充结论**。
  // 记 insufficient_data(与"样本不足"同一含义:数据还不足以支撑结论),
  // 并在说明里给出方向、p 值、以及还差多少对。
  const significant = pValue < 0.05;
  const verdict: TrialSummary['verdict'] =
    effect === 'neutral' ? 'neutral' : significant ? effect : 'insufficient_data';

  const verdictText = {
    positive: '有帮助:带该技能的成功率明显更高',
    negative: '有害:带该技能的成功率明显更低',
    neutral: '看不出差别:两组成功率接近',
    insufficient_data: '样本不足以支撑结论',
  }[verdict];

  const statsNote = verdict === 'insufficient_data' && effect !== 'neutral'
    ? `;方向为${delta > 0 ? '正向' : '负向'}(差值 ${(delta * 100).toFixed(0)}%),但 McNemar p=${pValue.toFixed(3)} ≥ 0.05 —— 不冒充结论`
      + (stats.requiredPairs ? `;按当前效应估计约需 ${stats.requiredPairs} 对配对(现有 ${n} 对)` : '')
    : `;McNemar p=${pValue.toFixed(3)},差值 95% CI ${formatCI(binaryCI)}`;

  // 【M4-N】二元结论是"看不出差别"时,若综合分差方向一致且够大,补一句说明 ——
  // 否则"看不出差别"会被读成"两者完全一样"(实测:两次都没过线,但一次只错 1 个工具、
  // 一次错 5 个 —— 二元看不见,综合分看得见)。
  const scoreNote = (verdict === 'neutral' && scoreDeltaDirection !== 'mixed'
    && scoreDeltaDirection !== 'none'
    && Math.abs(meanScoreDelta) >= TRIAL_DELTA_THRESHOLD)
    ? `;但综合分有稳定差异(带技能 ${meanScoreDelta >= 0 ? '高' : '低'} ${Math.abs(meanScoreDelta * 100).toFixed(0)}%)—— 成功率没看出差别,分数上能看出`
    : '';

  return {
    n,
    repeats,
    withSkillSuccesses,
    withoutSkillSuccesses,
    withSkillRate,
    withoutSkillRate,
    delta,
    verdict,
    meanScoreDelta,
    scoreDeltaDirection,
    stats,
    note: `${verdictText}(差值 ${(delta * 100).toFixed(0)}%,判定门槛 ±${TRIAL_DELTA_THRESHOLD * 100}%${statsNote})${scoreNote}`,
  };
}
