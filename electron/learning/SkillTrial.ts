/**
 * PiPiClaw — 技能效用对照实验（M4-E）
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
import { gradeRun, type GradableRun, type GradeResult, type TaskExpectation } from './TaskGrader'

/** 对照实验里的一个任务 */
export interface TrialTask {
  id: string;
  /** 用户指令原文 */
  instruction: string;
  /** 结构化期望(替代 golden answer) */
  expectation?: TaskExpectation;
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

/** 单个任务的配对结果 */
export interface TrialTaskPair {
  task: TrialTask;
  withSkill: TrialVariant;
  withoutSkill: TrialVariant;
  /** 成功率差值(-1 ~ 1)—— 只对「成/败」这个二值判定有意义 */
  delta: number;
}

/** 总结论 */
export interface TrialSummary {
  /** 参与判定的任务数 */
  n: number;
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
): Promise<TrialResult> {
  const pairs: TrialTaskPair[] = [];

  for (const task of tasks) {
    let withRun: GradableRun | null = null;
    let withoutRun: GradableRun | null = null;
    try {
      withRun = await executor(task, { suppressedSkills: [] });
    } catch { /* 该变体故障 → 不计入 */ }
    try {
      withoutRun = await executor(task, { suppressedSkills: [skillId] });
    } catch { /* 同上 */ }
    if (!withRun || !withoutRun) continue;

    const withGrade = gradeRun(withRun, task.expectation ?? {});
    const withoutGrade = gradeRun(withoutRun, task.expectation ?? {});

    pairs.push({
      task,
      withSkill: { variant: 'with_skill', run: withRun, grade: withGrade },
      withoutSkill: { variant: 'without_skill', run: withoutRun, grade: withoutGrade },
      delta: (withGrade.passed ? 1 : 0) - (withoutGrade.passed ? 1 : 0),
    });
  }

  return {
    skillId,
    pairs,
    summary: summarize(pairs.length, pairs),
    finishedAt: Date.now(),
  };
}

/**
 * 汇总 —— 纯函数,便于单测。
 */
export function summarize(n: number, pairs: TrialTaskPair[]): TrialSummary {
  const withSkillSuccesses = pairs.filter(p => p.withSkill.grade.passed).length;
  const withoutSkillSuccesses = pairs.filter(p => p.withoutSkill.grade.passed).length;
  const withSkillRate = n > 0 ? withSkillSuccesses / n : 0;
  const withoutSkillRate = n > 0 ? withoutSkillSuccesses / n : 0;
  const delta = withSkillRate - withoutSkillRate;

  if (n < TRIAL_MIN_TASKS) {
    return {
      n,
      withSkillSuccesses,
      withoutSkillSuccesses,
      withSkillRate,
      withoutSkillRate,
      delta,
      verdict: 'insufficient_data',
      note: `样本不足:只有 ${n} 个配对任务(至少需要 ${TRIAL_MIN_TASKS} 个)—— 差值不可靠,不给结论`,
    };
  }

  const verdict: TrialSummary['verdict'] =
    delta > TRIAL_DELTA_THRESHOLD ? 'positive'
      : delta < -TRIAL_DELTA_THRESHOLD ? 'negative'
        : 'neutral';

  const verdictText = {
    positive: '有帮助:带该技能的成功率明显更高',
    negative: '有害:带该技能的成功率明显更低',
    neutral: '看不出差别:两组成功率接近',
    insufficient_data: '样本不足',
  }[verdict];

  return {
    n,
    withSkillSuccesses,
    withoutSkillSuccesses,
    withSkillRate,
    withoutSkillRate,
    delta,
    verdict,
    note: `${verdictText}(差值 ${(delta * 100).toFixed(0)}%,判定门槛 ±${TRIAL_DELTA_THRESHOLD * 100}%)`,
  };
}
