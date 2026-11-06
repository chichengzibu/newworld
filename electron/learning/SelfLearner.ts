
/**
 * PiPiClaw - Hermes 自我学习引擎（重构版）
 * 
 * 职责：
 * 1. 观察用户的操作并收集到观察列表
 * 2. 达到阈值时调用大模型分析行为模式
 * 3. 生成泛化的技能提案（语义理解→抽象模式→创建技能）
 * 4. 为语义匹配提供素材(匹配本身在 SkillLoader.rankSkillsByRelevance:
 *    一次 LLM 调用批量排序;agent loop 路径则由模型按 description 自行路由)
 *
 * ── #006 X1 反向注释 (与 MemoryVectorStore 正反向一致) ─────────
 * 本类 = 执行行为层 (observations.json, "用户做了什么")。
 * 与 electron/hermes/ 的文本记忆层 (hermes.memories + vector-cache.json,
 * "用户要什么语义") 语义正交 — 两套体系不合并, 各自独立持久化。
 * 详见: electron/hermes/MemoryVectorStore.ts 顶部 X1 正向注释
 *       docs/#006-memory-persistence-design.md § B.5
 * 若未来需要跨层桥接 (如"从执行观察提炼语义偏好"), 应显式通过
 * HermesMemory.addExperienceMemory 入口, 而非本类直接写向量层。
 */

import * as fs from 'fs';
import { getHost } from '../platform/runtime'
import * as path from 'path';
import https from 'https';
import http from 'http';
import { URL } from 'url';
import {BrowserWindow} from 'electron';
import { LogManager } from '../core/LogManager';
import { ConfigStore } from '../core/ConfigStore';
import { SkillLoader } from '../skill/SkillLoader';
import { normalizeTaskCategory } from './TaskCategory';
import {
  clusterBySignature, computeIdf, signatureOf, toolOf,
  type ToolSignature,
} from './TrajectorySignature';
import { SkillManager } from '../skill/SkillManager';
import { ModelManager } from '../models/ModelManager';

/**
 * 观察记录
 */
/**
 * 【M4-B】观察条目 —— 升级为「轨迹」型。
 *
 * 【依据:业界调研】
 * - 「按【整条轨迹】评分,而不是只看最终答案」——
 *   "a correct answer reached through a broken tool call is a latent
 *   production incident"(经由损坏的工具调用得到的正确答案,是潜伏的生产事故)
 * - 「捕获轨迹级状态」:trajectory_id / policy_version / final_reward /
 *   steps / failure:{step,type} / checkpoint_rewards
 * - 「保留失败」——把事故转成评测用例,而不是让它们消失
 *
 * 原实现只有 {instruction, steps, timestamp},且 steps 是未类型化的裸数组,
 * 成败信息(_result)传进来就被丢弃(参数名带下划线 = 故意不用)。
 * 后果:分析器拿不到"这次成功了没有、哪一步失败",只能从文本猜。
 */
interface Observation {
  id: string;
  instruction: string;
  steps: any[];
  timestamp: number;

  /** 【M4-B】轨迹 id —— 同一次执行的多次观察可归并 */
  trajectoryId?: string;
  /**
   * 【M4-B】最终结果 —— 'ok' | 'fail' | 'partial'。
   * 此前 _result 参数被丢弃,成败信息完全丢失。
   */
  outcome?: 'ok' | 'fail' | 'partial';
  /**
   * 【M4-B】同一条指令被观察到的次数。
   *
   * 【关键语义修正】原实现检测到重复指令就【丢弃】—— 但"重复"恰恰是
   * 最该学的信号(用户反复做同一件事 = 一个值得固化的技能)。
   * 调研结论:「重复的操作模式」正是学习的目标;
   * 丢重复 = 把要学的东西扔了。现改为计数。
   */
  occurrences?: number;
  /**
   * 【M4-B】失败诊断 —— {stepIndex, type, message}
   * 调研:「失败模式分类 + 触发条件」是诊断反馈的必需项。
   */
  failure?: { stepIndex?: number; type: string; message?: string };
  /** 【M4-B】本次执行用到的工具(用于"哪类任务用哪类工具"的分析) */
  toolsUsed?: string[];
  /** 【M4-B】是否走的是 agent tool loop(与旧 TaskExecutor 管道区分) */
  source?: 'agent_loop' | 'task_executor' | 'chat';
  /**
   * 【M4-C】最近若干次执行的轨迹摘要 —— 提案的**原始证据**。
   *
   * 【为什么需要它】
   * occurrences 只告诉你"重复了几次",不告诉你"每次是怎么做的、成没成"。
   * 而业界调研(ACE)的两条结论都要求拿到逐次证据:
   *   - 「按整条轨迹评分,而非只看最终答案」→ 需要每次的步骤与成败
   *   - 「delta item 须带 provenance trajectory ids」→ 需要可溯源的轨迹 id
   * 只有聚合计数时,Reflector 拿不到任何可归纳的东西 —— 它只能去猜。
   *
   * 【为什么有界】
   * 无界保留会让 observations.json 无限膨胀(桌面应用,磁盘敏感)。
   * 只留最近 TRAJECTORY_HISTORY 次:足以归纳"共同步骤",又不至于撑爆磁盘。
   */
  trajectories?: TrajectorySummary[];
}

/**
 * 【M4-C】单次执行的轨迹摘要 —— 提案证据的最小单元。
 *
 * 【只存摘要,不存全量】
 * 步骤只留 name/type/description/ok/error —— 足以归纳"做了哪些操作、哪步坏了",
 * 又不会把工具返回的原始内容(可能很大、可能含敏感数据)写进学习数据。
 */
export interface TrajectorySummary {
  ts: number;
  /** 轨迹 id —— 提案的 provenance */
  trajectoryId?: string;
  outcome?: 'ok' | 'fail' | 'partial';
  steps: Array<{
    name?: string;
    type?: string;
    description?: string;
    ok?: boolean;
    error?: string;
  }>;
  toolsUsed?: string[];
}

/**
 * 【M4-C】技能提案的证据链。
 *
 * 【为什么提案必须带证据】
 * 业界实测:自生成技能的平均收益接近零甚至为负 —— 瓶颈在生成与验证,不在存储。
 * 让 LLM 凭空写一个技能,用户无从判断它是不是真的有用;带上证据后,
 * 人工编辑这一环(实测中价值真正产生的一环)才有素材可依。
 */
export interface SkillEvidence {
  /** 支持该模式的执行次数(总观察次数) */
  supportCount: number;
  /** 支撑轨迹 id(可溯源) */
  trajectoryIds: string[];
  /**
   * 成功执行次数 —— **分母是"有逐次证据的运行数",不是 supportCount**。
   * supportCount 是"发生过几次",这里是"我们留有轨迹证据的那些次里成功了几次"。
   * 两者分母不同,不可混用(混用会把成功率系统性低估)。
   */
  successfulAttempts: number;
  /** 失败执行次数 —— 保留失败,提案不该只展示成功的一面 */
  failedAttempts: number;
  /** 跨成功轨迹归纳出的共同步骤 */
  commonSteps: string[];
  /** 该模式用到的工具 */
  toolsUsed: string[];
  /** 样例指令 */
  sampleInstruction: string;
}

/**
 * 【M4-C】候选模式 —— 一个"被观察到若干次、证据够硬"的行为模式。
 * 提案的归纳输入 = 它,而不是"最近 N 条互不相关的观察"。
 */
interface CandidatePattern {
  /** 聚类键(归一化指令) */
  key: string;
  /** 代表性指令原文 */
  instruction: string;
  /** 支撑该模式的观察 */
  observations: Observation[];
  /** 证据链 */
  evidence: SkillEvidence;
}

/**
 * 技能提案（包含语义触发条件）
 */
export interface SkillProposal {
  id: string;
  name: string;
  description: string;
  triggerCondition: string; // 语义描述的触发条件
  keywords: string[];
  operationSteps: string[];
  fullInstructions: string;
  createdAt: number;
  /** 【M4-C】证据链 —— 提案凭什么成立 */
  evidence?: SkillEvidence;
}

/**
 * 模型返回的技能分析结果
 */
interface SkillAnalysisResult {
  name: string;
  description: string;
  triggerCondition: string;
  keywords: string[];
}

export class SelfLearner {
  private static instance: SelfLearner;
  private log = LogManager.getInstance();
  private configStore = ConfigStore.getInstance();
  private skillLoader = SkillLoader.getInstance();
  private modelManager = ModelManager.getInstance();
  private learningDir: string;
  private observations: Observation[] = [];
  private pendingProposal: SkillProposal | null = null;
  private analysisInProgress = false;

  /**
   * #007 W2: 分析阈值 (订单既定 3→10, 可配置类常量, 实例可覆盖)
   * — 非模块态 let, 红线: 模块态零新增
   * 联动 G1: analyzeAndGenerateSkill 内 slice(-ANALYSIS_THRESHOLD) 与本阈值同参
   */
  public ANALYSIS_THRESHOLD: number = 10;

  /**
   * #007 W1: 观察窗口 (订单既定 10→100, 观察数据是 LLM 分析输入池, 不主动清 — H1 观察保留钉)
   */
  private OBSERVATION_WINDOW: number = 100;

  /**
   * 【M4-C】每条观察保留的最近执行次数(有界)。
   *
   * 5 次足够归纳"共同步骤",又不会让 observations.json 膨胀 ——
   * 桌面应用的磁盘敏感度高于服务端。
   */
  private static readonly TRAJECTORY_HISTORY = 5;

  /**
   * 【M4-C】提案所需的最低支持度 —— 同一条模式至少被观察到这么多次才提。
   *
   * 依据:「support counts 是最小可用信号」(ACE / ALTK-Evolve 独立收敛)。
   * 1 次观察不足以说明是"模式",可能只是偶然 —— 拿偶然当模式做提案,
   * 正是"自生成技能收益为负"的来源之一。
   */
  private static readonly MIN_SUPPORT = 2;

  /**
   * 【M4-C】提案所需的最低成功率 —— 支撑轨迹里成功的占比下限。
   *
   * 【口径声明 — 重要】
   * 这是【必要条件】不是【充分条件】:一个模式至少得 Mostly 成功才值得提。
   * 它**不**等价于"这个技能有用" —— 真正的边际效用需要
   * 「带/不带该技能」的对照实验(带/不带两组的成功率差值)。
   * 没有对照数据时,只能给弱信号,不能给结论。
   */
  private static readonly MIN_SUCCESS_RATE = 0.5;

  private constructor() {
    // 初始化学习数据目录
    this.learningDir = path.join(getHost().getPath('userData'), 'hermes-learning');
    this.ensureLearningDir();
    this.loadObservations();
  }

  public static getInstance(): SelfLearner {
    if (!SelfLearner.instance) {
      SelfLearner.instance = new SelfLearner();
    }
    return SelfLearner.instance;
  }

  private ensureLearningDir(): void {
    if (!fs.existsSync(this.learningDir)) {
      fs.mkdirSync(this.learningDir, { recursive: true });
      this.log.info('[SelfLearner] 创建学习数据目录', { path: this.learningDir });
    }
  }

  private loadObservations(): void {
    try {
      const observationsPath = path.join(this.learningDir, 'observations.json');
      if (fs.existsSync(observationsPath)) {
        const data = JSON.parse(fs.readFileSync(observationsPath, 'utf-8'));
        this.observations = data;
        this.log.info('[SelfLearner] 加载观察记录成功', { count: this.observations.length });
      }
    } catch (error) {
      this.log.error('[SelfLearner] 加载观察记录失败', error);
    }
  }

  private saveObservations(): void {
    try {
      const observationsPath = path.join(this.learningDir, 'observations.json');
      fs.writeFileSync(observationsPath, JSON.stringify(this.observations, null, 2), 'utf-8');
    } catch (error) {
      this.log.error('[SelfLearner] 保存观察记录失败', error);
    }
  }

  /**
   * 【M4-B】观察一次执行 —— 轨迹型。
   *
   * 【两处语义修正】
   * 1. **重复不再被丢弃,改为计数。**
   *    原实现:检测到重复指令就 return,一条指令重复 20 次 = 1 条观察。
   *    但"重复"恰恰是最该学的信号 —— 用户反复做同一件事,说明它值得
   *    固化成技能。丢掉重复 = 把要学的东西扔了。现改为 occurrences 计数,
   *    并在分析时把高频指令作为模式候选。
   * 2. **结果不再被丢弃。**
   *    原实现的第三个参数 `_result`(下划线前缀 = 故意不用)导致成败信息
   *    完全丢失,分析器只能从文本猜。现在 outcome / failure 被记录。
   *
   * @param instruction 用户指令原文
   * @param steps       执行步骤(工具调用序列)
   * @param result      执行结果 —— 'ok' | 'fail' | 'partial' 或步骤数组
   * @param meta        轨迹元信息(trajectoryId / toolsUsed / source / failure)
   */
  public observeExecution(
    instruction: string,
    steps: any[],
    result?: any,
    meta?: {
      trajectoryId?: string
      toolsUsed?: string[]
      source?: 'agent_loop' | 'task_executor' | 'chat'
      outcome?: 'ok' | 'fail' | 'partial'
      failure?: { stepIndex?: number; type: string; message?: string }
    },
  ): void {
    try {
      // 归一化后匹配同一条指令
      const normalizedInstruction = this.normalizeInstruction(instruction);
      const existing = this.observations.find(obs =>
        this.normalizeInstruction(obs.instruction) === normalizedInstruction,
      );

      // 【M4-B 修正 2】刷新结果时【result 也要参与判定】——
      // 否则首次是 fail、二次是 ok 时,outcome 仍停在 fail,
      // 语义变成"第一次的结果说了算",与"最新一次执行说了算"矛盾。
      const latestOutcome = meta?.outcome ?? this.normalizeOutcome(result);

      // 【M4-C】本次执行的轨迹摘要 —— 提案证据的原料
      const trajectory: TrajectorySummary = {
        ts: Date.now(),
        outcome: latestOutcome,
        steps: this.summarizeSteps(steps),
        ...(meta?.trajectoryId ? { trajectoryId: meta.trajectoryId } : {}),
        ...(meta?.toolsUsed ? { toolsUsed: meta.toolsUsed } : {}),
      };

      // 【M4-B 修正 1】重复 → 计数 + 刷新结果,而不是丢弃
      if (existing) {
        existing.occurrences = (existing.occurrences ?? 1) + 1;
        existing.timestamp = Date.now();
        if (latestOutcome) existing.outcome = latestOutcome;
        if (meta?.failure) existing.failure = meta.failure;
        if (meta?.toolsUsed) existing.toolsUsed = Array.from(new Set([...(existing.toolsUsed ?? []), ...meta.toolsUsed]));
        // 【M4-C】保留最近 N 次执行的轨迹(有界,见 Observation.trajectories 注释)
        existing.trajectories = [...(existing.trajectories ?? []), trajectory].slice(-SelfLearner.TRAJECTORY_HISTORY);
        this.saveObservations();
        this.log.info('[SelfLearner] 重复指令 → 计数', {
          instruction,
          occurrences: existing.occurrences,
        });
        return;
      }

      // 结果归一:可能是字符串、布尔、或带 success 字段的对象
      const outcome = latestOutcome;

      const observation: Observation = {
        id: `obs_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`,
        instruction,
        steps,
        timestamp: Date.now(),
        occurrences: 1,
        outcome: meta?.outcome ?? outcome,
        trajectories: [trajectory],
        ...(meta?.trajectoryId ? { trajectoryId: meta.trajectoryId } : {}),
        ...(meta?.toolsUsed ? { toolsUsed: meta.toolsUsed } : {}),
        ...(meta?.source ? { source: meta.source } : {}),
        ...(meta?.failure ? { failure: meta.failure } : {}),
      };

      // #007 W1: 窗口 10→100 (订单既定; 观察数据 = LLM 分析输入池, H1 保留钉 — 不主动清)
      this.observations.push(observation);
      if (this.observations.length > this.OBSERVATION_WINDOW) {
        this.observations.shift();
      }

      this.saveObservations();

      this.log.info('[SelfLearner] 观察到执行', {
        instruction,
        observationCount: this.observations.length,
        outcome,
        tools: meta?.toolsUsed?.length ?? 0,
      });

      // #007 W2: 阈值 3→10 (类常量, 实例可覆盖; G1 联动 = slice(-ANALYSIS_THRESHOLD) 同参)
      if (this.observations.length >= this.ANALYSIS_THRESHOLD && !this.analysisInProgress) {
        this.analyzeAndGenerateSkill();
      }

    } catch (error) {
      this.log.error('[SelfLearner] 观察执行失败', error);
    }
  }

  /** 把各种形态的执行结果归一成 'ok' | 'fail' | 'partial' */
  private normalizeOutcome(result: any): 'ok' | 'fail' | 'partial' | undefined {
    if (result === undefined || result === null) return undefined;
    if (typeof result === 'string') {
      const s = result.toLowerCase();
      if (s === 'ok' || s === 'success' || s === 'true') return 'ok';
      if (s === 'fail' || s === 'failed' || s === 'error' || s === 'false') return 'fail';
      return 'partial';
    }
    if (typeof result === 'boolean') return result ? 'ok' : 'fail';
    if (typeof result === 'object') {
      if (typeof result.success === 'boolean') return result.success ? 'ok' : 'fail';
      if (typeof result.ok === 'boolean') return result.ok ? 'ok' : 'fail';
      if (Array.isArray(result.steps)) {
        const steps = result.steps as Array<{ status?: string; ok?: boolean }>;
        const failed = steps.filter(s => s.status === 'failed' || s.ok === false).length;
        if (failed === 0) return 'ok';
        if (failed < steps.length) return 'partial';
        return 'fail';
      }
    }
    return undefined;
  }

  /**
   * 标准化指令（忽略大小写和标点符号，保留语义差异）
   */
  /**
   * 归一化指令(忽略大小写与标点)。
   *
   * 【M4-D】实现已抽到 `electron/learning/TaskCategory.ts` ——
   * 任务类别归一必须与"记录侧"完全一致,否则对比组会漏记录。
   */
  private normalizeInstruction(instruction: string): string {
    return normalizeTaskCategory(instruction);
  }

  /**
   * 分析观察数据并生成技能（大模型驱动）
   */
  private async analyzeAndGenerateSkill(): Promise<void> {
    if (this.analysisInProgress) {
      return;
    }

    this.analysisInProgress = true;

    try {
      this.log.info('[SelfLearner] 开始分析用户行为模式');

      // #007 G1: 分析输入 = 最近 ANALYSIS_THRESHOLD 条 (联动 W2 阈值, 非硬编码 3)
      const recentObservations = this.observations.slice(-this.ANALYSIS_THRESHOLD);

      /**
       * 【M4-C】先选"证据够硬的模式",再让模型归纳 —— 顺序不能反。
       *
       * 旧实现把最近 10 条观察(指令文本)一股脑丢给模型,问"它们的共同模式是什么"。
       * 问题:那 10 条可能【互不相关】,模型只能强行编一个共同模式;
       * 而且它拿不到任何执行证据 —— 不知道每条跑了几次、成没成、做了哪些操作。
       *
       * 现改为:
       *   ① 按归一化指令聚类(同一件事的执行归为一组)
       *   ② 选支持度最高、成功率达标的一组作为候选模式
       *   ③ 把这组的【轨迹证据】交给模型去归纳(而不是让它凭空猜)
       *   ④ 支持度/成功率不达标 → 根本不提(宁缺勿滥)
       */
      const candidate = this.selectCandidatePattern(recentObservations);
      if (!candidate) {
        this.log.info('[SelfLearner] 无满足支持度/成功率门槛的模式,本轮不提提案', {
          observations: recentObservations.length,
        });
        return;
      }

      // 构造提示词
      const prompt = this.buildAnalysisPrompt(candidate);

      // 调用大模型分析
      const analysisResult = await this.callModelForAnalysis(prompt);

      if (analysisResult) {
        // 生成技能提案
        const proposal = this.generateSkillProposalFromAnalysis(analysisResult, candidate);

        if (proposal) {
          // 步骤1：检查是否与现有技能重复
          const isDuplicate = await this.checkDuplicateSkill(proposal);
          if (isDuplicate) {
            this.log.info('[SelfLearner] 检测到重复技能，放弃提案', { name: proposal.name });
            return;
          }

          this.pendingProposal = proposal;
          this.log.info('[SelfLearner] 技能提案生成成功', {
            name: proposal.name,
            triggerCondition: proposal.triggerCondition,
            support: candidate.evidence.supportCount,
          });

          // 通过IPC事件推送到前端
          this.notifyFrontend(proposal);
        }
      }

    } catch (error) {
      this.log.error('[SelfLearner] 分析失败', error);
    } finally {
      this.analysisInProgress = false;
    }
  }

  /**
   * 【M4-C】从观察池里挑出"证据够硬"的候选模式。
   *
   * 【为什么要先选再归纳】
   * 旧实现把最近 N 条观察的指令文本一股脑丢给模型,问"它们的共同模式是什么"。
   * 两个问题:
   *   ① 那 N 条可能互不相关 —— 模型只能强行编一个共同模式(幻觉的来源)
   *   ② 模型拿不到任何执行证据 —— 不知道跑了几次、成没成、做了哪些操作,
   *      于是"操作步骤"只能靠编
   *
   * 现按【归一化指令】聚类(同一件事的执行归为一组),再按支持度排序,
   * 取第一个满足门槛的作为候选:
   *   - 支持度 >= MIN_SUPPORT(同一模式至少被观察到 2 次)
   *   - 成功率 >= MIN_SUCCESS_RATE(支撑轨迹里成功的占比)
   *
   * 【口径】成功率门槛是【必要条件】,不是"这个技能有用"的结论 ——
   * 边际效用需要带/不带该技能的对照实验,那是更后面的事。
   */
  /**
   * 【M4-I】算出观察池的 IDF 权重表。
   *
   * 口径:N = **轨迹**条数(不是观察条数 —— 一个观察可能含多次执行,
   * 每次都是一份证据);df(t) = 含工具 t 的轨迹条数。
   * 出现在全部轨迹里的工具(胶水工具)→ idf=0 → 权重为零 → 不影响相似度。
   */
  private computeTrajectoryIdf(observations: Observation[]): Map<string, number> {
    const trajectories: TrajectorySummary[] = [];
    for (const obs of observations) {
      for (const traj of obs.trajectories ?? []) {
        if (signatureOf(traj).length > 0) trajectories.push(traj);
      }
    }
    // 全部观察都没有轨迹(老数据)→ 没有 IDF 可算 → 空表(权重全 0)
    // → 所有签名相似度都是 0 → 每个观察自成一簇(退化成旧的"按指令分组"以下的行为)
    if (trajectories.length === 0) return new Map();
    return computeIdf(trajectories);
  }

  /**
   * 【M4-I】一个观察的工具签名 = 它全部轨迹的**工具并集**。
   *
   * 用并集而非单条轨迹:一个观察代表「这类动作」,
   * 多次执行用到的工具合起来才是这类动作的完整面貌。
   */
  private observationSignature(obs: Observation): ToolSignature {
    const out = new Set<string>();
    for (const traj of obs.trajectories ?? []) {
      for (const t of signatureOf(traj)) out.add(t);
    }
    return [...out];
  }

  /**
   * 【M4-I】簇的代表指令 = 簇内**最高频**的那条(按出现次数,其次按最早)。
   *
   * 为什么用用户的原话:提案的 name/description/triggerCondition 来自它 ——
   * 用户自己的措辞比 LLM 润色的更贴切,也更可信。
   */
  private pickRepresentativeInstruction(group: Observation[]): string {
    const counts = new Map<string, { count: number; first: number; text: string }>();
    group.forEach((obs, i) => {
      const key = this.normalizeInstruction(obs.instruction);
      const cur = counts.get(key);
      if (!cur) {
        counts.set(key, { count: obs.occurrences ?? 1, first: i, text: obs.instruction });
      } else {
        cur.count += obs.occurrences ?? 1;
        if (i < cur.first) { cur.first = i; cur.text = obs.instruction; }
      }
    });
    const best = [...counts.values()].sort((a, b) => b.count - a.count || a.first - b.first)[0];
    return best?.text ?? group[0].instruction;
  }

  private selectCandidatePattern(observations: Observation[]): CandidatePattern | null {
    /**
     * ── 1. 按【轨迹签名】聚类(M4-I),不是按归一化指令 ──
     *
     * 旧实现要求指令**字面几乎相同**才算同一个模式。于是
     *   「整理一下桌面」×2 + 「收拾下桌面」×2
     * 这两件**做的是同一套动作**的事分成两簇,各自够不到支持度门槛 → 永远不提提案。
     * 而「同一件事的不同说法」恰恰是最值得学的模式 —— 用户不会每次都一样措辞。
     *
     * 业界三个独立工作收敛到同一结论(详见 TrajectorySignature.ts 的依据):
     * 轨迹的**结构行为信号**(工具序列)才是有区分度的维度,
     * 按提示词聚类等于把它扔掉。
     *
     * 指令文本没有白扔 —— 它仍是簇的**代表**(提案的措辞来自簇内最高频的指令)。
     */
    const idf = this.computeTrajectoryIdf(observations);

    // 有轨迹的观察 → 按【轨迹签名】聚类
    const withTraj = observations.filter(obs => this.observationSignature(obs).length > 0);
    const items = withTraj.map(obs => ({
      obs,
      // 一个观察代表「这类动作」→ 用它全部轨迹的工具并集做签名
      signature: this.observationSignature(obs),
    }));
    const clusters = clusterBySignature(items, idf);

    // ── 兜底:没有轨迹的观察(M4-C 之前落盘的老数据)→ 退回按指令分组 ──
    // 它们没有结构信号可用,只能靠文本;但**不能被丢掉**(那会让老数据永远学不到)
    const legacy = observations.filter(obs => this.observationSignature(obs).length === 0);
    const legacyGroups = new Map<string, Observation[]>();
    for (const obs of legacy) {
      const key = this.normalizeInstruction(obs.instruction);
      if (!key) continue;
      const bucket = legacyGroups.get(key);
      if (bucket) bucket.push(obs);
      else legacyGroups.set(key, [obs]);
    }

    // ── 2. 每簇算证据,按支持度排序 ──
    const candidates: CandidatePattern[] = [];
    for (const cluster of clusters) {
      const group = cluster.members.map(m => m.obs);
      const evidence = this.buildEvidence(group);
      if (!evidence) continue;
      candidates.push({
        key: this.normalizeInstruction(group[0].instruction),
        // 代表指令 = 簇内最高频的那条(用户自己的话最贴切)
        instruction: this.pickRepresentativeInstruction(group),
        observations: group,
        evidence,
      });
    }
    for (const [key, group] of legacyGroups) {
      const evidence = this.buildEvidence(group);
      if (!evidence) continue;
      candidates.push({
        key,
        instruction: this.pickRepresentativeInstruction(group),
        observations: group,
        evidence,
      });
    }
    if (candidates.length === 0) return null;

    // 支持度优先;支持度相同则成功率高的优先;再相同则失败少的优先
    candidates.sort((a, b) => {
      if (b.evidence.supportCount !== a.evidence.supportCount) {
        return b.evidence.supportCount - a.evidence.supportCount;
      }
      const ra = a.evidence.successfulAttempts / Math.max(1, a.evidence.supportCount);
      const rb = b.evidence.successfulAttempts / Math.max(1, b.evidence.supportCount);
      if (rb !== ra) return rb - ra;
      return a.evidence.failedAttempts - b.evidence.failedAttempts;
    });

    const best = candidates[0];
    if (best.evidence.supportCount < SelfLearner.MIN_SUPPORT) {
      this.log.info('[SelfLearner] 候选模式支持度不足', {
        support: best.evidence.supportCount,
        required: SelfLearner.MIN_SUPPORT,
      });
      return null;
    }
    /**
     * 【分母口径 — 重要,别写错】
     * 成功率的分母是【有逐次证据的运行数】(successful + failed),
     * **不是** supportCount(总观察次数)。
     *
     * 两者不是一回事:一条观察的 occurrences 可能是 15(这件事发生过 15 次),
     * 而我们只保留最近 5 次的轨迹证据 —— 拿 5 除以 15 会把成功率系统性低估,
     * 于是每次都判成"成功率不足",提案永远出不来。
     */
    const evidenced = best.evidence.successfulAttempts + best.evidence.failedAttempts;
    const rate = evidenced > 0 ? best.evidence.successfulAttempts / evidenced : 0;
    if (evidenced === 0 || rate < SelfLearner.MIN_SUCCESS_RATE) {
      this.log.info('[SelfLearner] 候选模式成功率不足,不提提案', {
        support: best.evidence.supportCount,
        evidencedRuns: evidenced,
        successRate: rate,
        required: SelfLearner.MIN_SUCCESS_RATE,
      });
      return null;
    }
    return best;
  }

  /**
   * 【M4-C】为一个模式聚类算证据链。
   *
   * 数据来源:
   *   - supportCount: 观察的 occurrences 之和(这条模式被观察到几次)
   *   - successfulAttempts / failedAttempts: 逐次轨迹的成败计数
   *   - commonSteps: 跨【成功】轨迹归纳出的共同步骤
   *   - trajectoryIds: provenance —— 提案可回溯到具体执行
   */
  private buildEvidence(group: Observation[]): SkillEvidence | null {
    const trajectories: TrajectorySummary[] = [];
    let supportCount = 0;
    const toolsUsed = new Set<string>();

    for (const obs of group) {
      supportCount += obs.occurrences ?? 1;
      for (const t of obs.trajectories ?? []) {
        trajectories.push(t);
        for (const tool of t.toolsUsed ?? []) toolsUsed.add(tool);
      }
    }
    // 旧的观察(M4-B 之前落盘的)没有 trajectories —— 用观察自身的 outcome 补一条
    if (trajectories.length === 0) {
      for (const obs of group) {
        trajectories.push({
          ts: obs.timestamp,
          outcome: obs.outcome,
          steps: this.summarizeSteps(obs.steps),
          ...(obs.trajectoryId ? { trajectoryId: obs.trajectoryId } : {}),
          ...(obs.toolsUsed ? { toolsUsed: obs.toolsUsed } : {}),
        });
      }
    }

    const successful = trajectories.filter(t => t.outcome === 'ok');
    const failed = trajectories.filter(t => t.outcome === 'fail' || t.outcome === 'partial');
    const commonSteps = this.deriveCommonSteps(successful.length > 0 ? successful : trajectories);

    return {
      supportCount,
      trajectoryIds: trajectories.map(t => t.trajectoryId).filter((x): x is string => !!x),
      successfulAttempts: successful.length,
      failedAttempts: failed.length,
      commonSteps,
      toolsUsed: Array.from(toolsUsed),
      sampleInstruction: group[0].instruction,
    };
  }

  /**
   * 【M4-C】把一次执行的步骤压成摘要 —— 只留可归纳的字段。
   *
   * 【为什么压】步骤的原始内容可能很大、可能含敏感数据;
   * 学习数据只该留"做了什么、成了没成",不该留整段工具输出。
   *
   * 【兼容多种步骤形状】不同来源的步骤结构不同:
   *   - agent loop:  { name, ok, durationMs }
   *   - TaskExecutor:{ type, description, status, error, startTime, endTime }
   *   - 旧观察:      { type } / { description }
   */
  private summarizeSteps(steps: any[]): TrajectorySummary['steps'] {
    if (!Array.isArray(steps)) return [];
    return steps.map((s: any) => ({
      ...(s?.name ? { name: String(s.name) } : {}),
      ...(s?.type ? { type: String(s.type) } : {}),
      ...(s?.description ? { description: String(s.description) } : {}),
      ...(s?.ok !== undefined ? { ok: !!s.ok } : {}),
      ...(s?.status ? { ok: s.status !== 'failed' && !s.error } : {}),
      ...(s?.error ? { error: String(s.error) } : {}),
    }));
  }

  /**
   * 【M4-C】跨多条成功轨迹归纳"共同步骤"。
   *
   * 【为什么要归纳而不是抄一条】
   * 旧实现直接抄【最后一次】观察的步骤 —— 那可能含一次性动作
   * (某次顺手删了个临时文件),把它固化进技能反而是噪声。
   * 共同步骤 = 在多条成功轨迹里都出现过的操作,才代表"这套流程的核心"。
   *
   * 【归纳规则】按步骤名/类型的出现比例排序,取出现在半数以上轨迹里的步骤;
   * 全部都没交集时退回第一条成功轨迹的步骤(宁可给具体,不给空)。
   */
  private deriveCommonSteps(trajectories: TrajectorySummary[]): string[] {
    if (trajectories.length === 0) return [];

    const labelOf = (s: TrajectorySummary['steps'][number]): string =>
      s.description || s.name || s.type || '';

    // 统计每个步骤标签出现在多少条轨迹里
    const docFreq = new Map<string, number>();
    for (const traj of trajectories) {
      const seen = new Set(traj.steps.map(labelOf).filter(Boolean));
      for (const label of seen) {
        docFreq.set(label, (docFreq.get(label) ?? 0) + 1);
      }
    }

    const threshold = Math.max(1, Math.ceil(trajectories.length / 2));
    const common = [...docFreq.entries()]
      .filter(([, count]) => count >= threshold)
      .map(([label]) => label);

    if (common.length > 0) return common;

    // 无交集(每次做法都不一样)→ 退回第一条,不给空步骤
    return trajectories[0].steps.map(labelOf).filter(Boolean);
  }

  /**
   * 【M4-C】构建分析提示词 —— 把【轨迹证据】交给模型,而不是只给指令文本。
   *
   * 【调研依据】
   * - ACE 明确点名两种失败模式:「brevity bias」(优化器塌缩成泛泛的短指令)
   *   与「context collapse」(模型每步重写上下文,把细节摘要掉)。
   *   → 提示词里给的是【具体轨迹】,并明确要求不要泛化、不要编步骤。
   * - 「不要压缩」→ 共同步骤已由代码归纳好,提示词要求模型照着证据描述,
   *   而不是自由发挥。
   * - 「保留失败」→ 失败轨迹也写进提示词,让模型知道这条流程哪里容易坏。
   */
  private buildAnalysisPrompt(candidate: CandidatePattern): string {
    const ev = candidate.evidence;
    let prompt = '你是专业的AI行为分析师。请基于下面【真实执行记录】提炼一个可复用的技能。\n\n';

    prompt += `## 证据\n`;
    prompt += `- 该模式被观察到 ${ev.supportCount} 次\n`;
    prompt += `- 成功 ${ev.successfulAttempts} 次 / 失败 ${ev.failedAttempts} 次\n`;
    prompt += `- 样例指令: ${ev.sampleInstruction}\n`;
    if (ev.toolsUsed.length > 0) {
      prompt += `- 用到的工具: ${ev.toolsUsed.join('、')}\n`;
    }

    prompt += `\n## 共同操作步骤(已由系统归纳,来自多次成功执行)\n`;
    if (ev.commonSteps.length > 0) {
      ev.commonSteps.forEach((s, i) => { prompt += `${i + 1}. ${s}\n`; });
    } else {
      prompt += `(本次执行没有可归纳的步骤 —— 请只描述意图,不要编造操作步骤)\n`;
    }

    if (ev.failedAttempts > 0) {
      prompt += `\n## 注意\n该模式有 ${ev.failedAttempts} 次失败 —— 描述技能时要提示用户在什么情况下容易失败。\n`;
    }

    prompt += `\n## 要求\n`;
    prompt += `1. **只依据上面的证据**,不要编造证据里没有的操作;\n`;
    prompt += `2. 描述要具体,不要泛化成"处理文件"这类空话 —— 宁可长一点也要可执行;\n`;
    prompt += `3. triggerCondition 要写清【什么情况下用户会想用这个技能】;\n`;
    prompt += `4. 以JSON格式返回,字段:\n`;
    prompt += `   - name: 技能名称(简洁描述)\n`;
    prompt += `   - description: 详细描述\n`;
    prompt += `   - triggerCondition: 语义描述的触发条件\n`;
    prompt += `   - keywords: 关键词数组(3-5个)\n`;
    prompt += `\n只返回JSON，不要包含markdown代码块标记。`;

    return prompt;
  }

  /**
   * 调用大模型进行分析
   */
  private async callModelForAnalysis(prompt: string): Promise<SkillAnalysisResult | null> {
    try {
      // 获取当前激活的模型提供商
      const enabledProviders = this.modelManager.getEnabledProviders();
      if (enabledProviders.length === 0) {
        this.log.warn('[SelfLearner] 没有启用的模型提供商');
        return null;
      }

      // 使用第一个启用的提供商
      const provider = enabledProviders[0];
      const modelId = provider.defaultModel || provider.models[0]?.id;

      if (!modelId) {
        this.log.warn('[SelfLearner] 没有可用的模型');
        return null;
      }

      this.log.info('[SelfLearner] 调用大模型分析行为模式', {
        provider: provider.name,
        model: modelId
      });

      // 调用大模型
      const response = await this.makeChatCompletionRequest(provider, modelId, prompt);

      if (response) {
        // 解析返回的JSON
        const analysisResult = this.parseModelResponse(response);
        return analysisResult;
      }

    } catch (error) {
      this.log.error('[SelfLearner] 调用大模型失败', error);
    }

    return null;
  }

  /**
   * 发起聊天补全请求
   */
  private async makeChatCompletionRequest(
    provider: any,
    modelId: string,
    prompt: string
  ): Promise<string | null> {
    return new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        reject(new Error('Request timeout'));
      }, provider.timeout || 60000);

      let req: http.ClientRequest;

      try {
        switch (provider.type) {
          case 'openai':
          case 'deepseek':
          case 'custom': {
            // OpenAI兼容格式
            const url = new URL('/v1/chat/completions', provider.baseUrl);
            const protocol = url.protocol === 'https:' ? https : http;
            
            const headers: Record<string, string> = {
              'Content-Type': 'application/json'
            };
            if (provider.apiKey) {
              headers['Authorization'] = `Bearer ${provider.apiKey}`;
            }

            const body = JSON.stringify({
              model: modelId,
              messages: [{ role: 'user', content: prompt }],
              temperature: 0.3,
              max_tokens: 500
            });

            req = protocol.request(url, { method: 'POST', headers }, (res) => {
              let data = '';
              res.on('data', (chunk) => { data += chunk; });
              res.on('end', () => {
                clearTimeout(timeout);
                try {
                  const parsed = JSON.parse(data);
                  if (parsed.choices?.[0]?.message?.content) {
                    resolve(parsed.choices[0].message.content);
                  } else {
                    resolve(null);
                  }
                } catch {
                  resolve(null);
                }
              });
            });
            req.write(body);
            break;
          }

          case 'anthropic': {
            const url = new URL('/v1/messages', provider.baseUrl);
            const protocol = url.protocol === 'https:' ? https : http;
            
            const headers: Record<string, string> = {
              'Content-Type': 'application/json',
              'x-api-key': provider.apiKey || '',
              'anthropic-version': '2023-06-01',
              'anthropic-dangerous-direct-browser-access': 'true'
            };

            const body = JSON.stringify({
              model: modelId,
              max_tokens: 500,
              messages: [{ role: 'user', content: prompt }],
              temperature: 0.3
            });

            req = protocol.request(url, { method: 'POST', headers }, (res) => {
              let data = '';
              res.on('data', (chunk) => { data += chunk; });
              res.on('end', () => {
                clearTimeout(timeout);
                try {
                  const parsed = JSON.parse(data);
                  if (parsed.content?.[0]?.text) {
                    resolve(parsed.content[0].text);
                  } else {
                    resolve(null);
                  }
                } catch {
                  resolve(null);
                }
              });
            });
            req.write(body);
            break;
          }

          case 'azure': {
            const deploymentName = provider.deploymentName || modelId;
            const url = new URL(
              `/openai/deployments/${deploymentName}/chat/completions?api-version=${provider.apiVersion || '2024-02-01'}`,
              provider.baseUrl
            );
            const protocol = url.protocol === 'https:' ? https : http;
            
            const headers: Record<string, string> = {
              'Content-Type': 'application/json',
              'api-key': provider.apiKey || ''
            };

            const body = JSON.stringify({
              messages: [{ role: 'user', content: prompt }],
              temperature: 0.3,
              max_tokens: 500
            });

            req = protocol.request(url, { method: 'POST', headers }, (res) => {
              let data = '';
              res.on('data', (chunk) => { data += chunk; });
              res.on('end', () => {
                clearTimeout(timeout);
                try {
                  const parsed = JSON.parse(data);
                  if (parsed.choices?.[0]?.message?.content) {
                    resolve(parsed.choices[0].message.content);
                  } else {
                    resolve(null);
                  }
                } catch {
                  resolve(null);
                }
              });
            });
            req.write(body);
            break;
          }

          case 'ollama': {
            const url = new URL('/api/chat', provider.baseUrl);
            const protocol = url.protocol === 'https:' ? https : http;
            
            const headers: Record<string, string> = {
              'Content-Type': 'application/json'
            };

            const body = JSON.stringify({
              model: modelId,
              messages: [{ role: 'user', content: prompt }],
              stream: false,
              options: { temperature: 0.3, num_predict: 500 }
            });

            req = protocol.request(url, { method: 'POST', headers }, (res) => {
              let data = '';
              res.on('data', (chunk) => { data += chunk; });
              res.on('end', () => {
                clearTimeout(timeout);
                try {
                  const parsed = JSON.parse(data);
                  if (parsed.message?.content) {
                    resolve(parsed.message.content);
                  } else {
                    resolve(null);
                  }
                } catch {
                  resolve(null);
                }
              });
            });
            req.write(body);
            break;
          }

          default:
            clearTimeout(timeout);
            resolve(null);
            return;
        }

        req.on('error', (error) => {
          clearTimeout(timeout);
          reject(error);
        });

        req.end();

      } catch (error) {
        clearTimeout(timeout);
        reject(error);
      }
    });
  }

  /**
   * 解析模型返回的响应
   */
  private parseModelResponse(response: string): SkillAnalysisResult | null {
    try {
      // 尝试直接解析JSON
      let jsonStr = response.trim();
      
      // 如果有```包裹，提取里面的内容
      if (jsonStr.startsWith('```json') || jsonStr.startsWith('```')) {
        const startIdx = jsonStr.indexOf('{');
        const endIdx = jsonStr.lastIndexOf('}');
        if (startIdx !== -1 && endIdx !== -1) {
          jsonStr = jsonStr.substring(startIdx, endIdx + 1);
        }
      }

      const parsed = JSON.parse(jsonStr);
      
      return {
        name: parsed.name || '自动学习技能',
        description: parsed.description || '',
        triggerCondition: parsed.triggerCondition || '',
        keywords: Array.isArray(parsed.keywords) ? parsed.keywords : []
      };

    } catch (error) {
      this.log.error('[SelfLearner] 解析模型响应失败', error);
      return null;
    }
  }

  /**
   * 从分析结果生成技能提案
   */
  private generateSkillProposalFromAnalysis(
    analysisResult: SkillAnalysisResult,
    candidate: CandidatePattern
  ): SkillProposal | null {
    try {
      const skillId = `auto_${Date.now()}`;

      /**
       * 【M4-C】操作步骤来自【跨成功轨迹归纳出的共同步骤】,不再抄最后一次执行。
       *
       * 旧实现抄最后一次观察的 steps —— 含一次性动作,且 agent loop 的步骤形状
       * ({name, ok, durationMs})根本取不到 description/type,会产出"执行 undefined"。
       */
      const operationSteps = candidate.evidence.commonSteps.length > 0
        ? candidate.evidence.commonSteps
        : this.extractOperationSteps(candidate.observations[candidate.observations.length - 1]?.steps ?? []);

      // 生成完整的技能文档
      const fullInstructions = this.generateFullSkillInstructions(
        analysisResult,
        candidate.evidence.sampleInstruction,
        operationSteps
      );

      const proposal: SkillProposal = {
        id: skillId,
        name: analysisResult.name,
        description: analysisResult.description,
        triggerCondition: analysisResult.triggerCondition,
        keywords: analysisResult.keywords,
        operationSteps,
        fullInstructions,
        createdAt: Date.now(),
        // 【M4-C】带上证据链 —— 提案凭什么成立,用户看得见
        evidence: candidate.evidence,
      };

      return proposal;

    } catch (error) {
      this.log.error('[SelfLearner] 生成技能提案失败', error);
      return null;
    }
  }

  /**
   * 从执行步骤中提取描述(兜底路径)。
   *
   * 【M4-C 修正】旧实现是 `step.description || \`执行 ${step.type}\`` ——
   * agent loop 的步骤形状是 {name, ok, durationMs},既无 description 也无 type,
   * 于是每一步都变成字符串 "执行 undefined"。现按多形状兜底,
   * 且**拿不到名字的步骤直接丢弃**(编造"执行 undefined"比不写更糟)。
   */
  private extractOperationSteps(steps: any[]): string[] {
    if (!Array.isArray(steps)) return [];
    return steps
      .map((step: any) => step?.description || step?.name || step?.type || step?.action || '')
      .filter((s: string) => !!s);
  }

  /**
   * 生成完整的技能文档
   */
  /**
   * 生成 skill.md 全文。
   *
   * 【M4-A 修正 —— 格式对齐 Anthropic Agent Skills 规范】
   * 原实现用纯中文小节(`# 名称` / `## 描述` / `## 触发条件` / `## 关键词` /
   * `## 操作步骤` / `## 示例`)。而本项目自己的解析器 parseSkillMd 有三个误判:
   *   1. `## 触发条件` 与 `## 触发关键词` 落进同一分支 → 整句触发条件被当成一个"关键词"
   *   2. `## 示例` 不匹配任何分支 → 示例指令被当成一条操作步骤
   *   3. `## 关键词` 侥幸落在 keywords,但语义已错位
   * 这意味着"生成 → 加载"链路从未被端到端跑通过 —— 生成器与解析器互不兼容。
   *
   * 现改为 frontmatter 格式(Anthropic 规范 + 本项目解析器都认):
   *   frontmatter: name / description / when_to_use
   *   body: 关键词、操作步骤、示例、陷阱
   * 这样生成器与解析器用同一套语义,链路真正闭合。
   */
  private generateFullSkillInstructions(
    analysisResult: SkillAnalysisResult,
    example: string,
    steps: string[]
  ): string {
    const escape = (v: string): string => String(v ?? '').replace(/\r?\n/g, ' ').trim();
    let instructions = '---\n';
    instructions += `name: ${escape(analysisResult.name)}\n`;
    instructions += `description: ${escape(analysisResult.description)}\n`;
    // when_to_use 是规范里的路由信号 —— 模型的匹配依据
    instructions += `when_to_use: ${escape(analysisResult.triggerCondition)}\n`;
    instructions += '---\n\n';
    instructions += `## 关键词\n`;
    analysisResult.keywords.forEach(keyword => {
      instructions += `- ${keyword}\n`;
    });
    instructions += '\n## 操作步骤\n';
    steps.forEach((step, index) => {
      instructions += `${index + 1}. ${step}\n`;
    });
    instructions += `\n## 示例\n${example}\n`;

    return instructions;
  }

  /**
   * 通知前端有新的技能提案
   */
  private notifyFrontend(proposal: SkillProposal): void {
    try {
      // 获取所有窗口并发送事件
      const windows = BrowserWindow.getAllWindows();
      windows.forEach(window => {
        if (!window.isDestroyed()) {
          window.webContents.send('skills:new-proposal', proposal);
        }
      });
      this.log.info('[SelfLearner] 已通知前端技能提案');
    } catch (error) {
      this.log.error('[SelfLearner] 通知前端失败', error);
    }
  }


  /**
   * 【M4-A】批量技能排序 —— 单次 LLM 调用返回相关技能 id 列表。
   *
   * 【为什么加这个】
   * 旧的 checkSkillMatch(已于 M3-F 删除)是"一个技能一次 LLM 调用"。N 个技能 = N 次往返,
   * 技能一多(比如 20 个)每次规划都要等 20 个网络往返,而结果只是拿到
   * 一堆 true/false。批量一次调用把成本降到 1/N,且能得到【排序】而非
   * 二元判断 —— 旧实现取前 3 个时,顺序其实是遍历顺序,不是相关度顺序。
   *
   * 依据 Anthropic Agent Skills 的渐进披露:匹配决策本就该交给模型
   * (它比关键词更懂用户意图),我们只需给它一张技能清单和用户输入。
   *
   * @param userInstruction 用户当前输入
   * @param skillList 形如 "- id: 描述 (适用:...)" 的清单行
   * @returns 按相关度降序的技能 id 数组(解析失败返回空数组)
   */
  public async rankSkillsByRelevance(
    userInstruction: string,
    skillList: string,
  ): Promise<string[]> {
    try {
      const enabledProviders = this.modelManager.getEnabledProviders();
      if (enabledProviders.length === 0) return [];

      const provider = enabledProviders[0];
      const modelId = provider.defaultModel || provider.models[0]?.id;
      if (!modelId) return [];

      const prompt = `用户当前指令：${userInstruction}

可用技能清单：
${skillList}

请判断哪些技能与该指令相关,并按相关度从高到低排列。
只输出技能 id,每行一个,最多 5 个,不要输出任何其他文字。
若都不相关,输出 NONE。`;

      const response = await this.makeChatCompletionRequest(provider, modelId, prompt);
      if (!response) return [];

      return response
        .split('\n')
        .map(l => l.trim().replace(/^[-*\d.\s]+/, '').replace(/^['"]|['"]$/g, '').trim())
        .filter(l => l && l.toUpperCase() !== 'NONE')
        .slice(0, 5)
    } catch (error) {
      this.log.warn('[SelfLearner] 批量技能排序失败', error);
      return []
    }
  }

  /**
   * 检查新提案是否与现有技能重复
   */
  private async checkDuplicateSkill(proposal: SkillProposal): Promise<boolean> {
    try {
      const enabledProviders = this.modelManager.getEnabledProviders();
      if (enabledProviders.length === 0) {
        this.log.warn('[SelfLearner] 没有启用的模型，无法进行去重检查');
        return false;
      }

      const provider = enabledProviders[0];
      const modelId = provider.defaultModel || provider.models[0]?.id;
      if (!modelId) {
        return false;
      }

      const skills = this.skillLoader.getAllSkills();
      
      for (const existingSkill of skills) {
        const prompt = `当前提案的技能触发条件：${proposal.triggerCondition}\n\n已安装技能"${existingSkill.name}"的触发条件：${(existingSkill as any).triggerCondition || '无'}。\n\n请判断：这两个触发条件描述的是否是同一种用户意图？只回答"是"或"否"。`;
        
        const response = await this.makeChatCompletionRequest(provider, modelId, prompt);
        
        if (response) {
          const normalized = response.toLowerCase().trim();
          if (normalized.includes('是') || normalized.includes('yes')) {
            this.log.info('[SelfLearner] 发现重复技能', { 
              existingSkillName: existingSkill.name,
              proposalName: proposal.name
            });
            return true;
          }
        }
      }

      return false;
    } catch (error) {
      this.log.error('[SelfLearner] 去重检查失败', error);
      return false;
    }
  }

  /**
   * 从提案保存技能
   * @returns { success: boolean; needsRestart: boolean }
   */
  public saveSkillFromProposal(proposal: SkillProposal): { success: boolean; needsRestart: boolean } {
    let needsRestart = false;
    
    try {
      /**
       * 【M4-A 修复 —— 读写目录不一致】
       * 此前写 `getHost().getAppPath() + '/../skills'`(app 安装目录的兄弟目录,
       * Windows 打包后通常在 Program Files → 只读),而 SkillLoader 读
       * `userData/skills`。两个完全不同的路径 —— 保存的技能【永远扫不到】,
       * 且大概率直接 EACCES 抛错。
       *
       * 现统一走 SkillManager.getSkillsDir() —— 该方法注释里本就写明
       * "路径单点 — 其它模块应使用这个而非自己 join(userData,'skills')"。
       * 自学习保存的技能因此能被 SkillLoader 正常加载(热加载也才真正生效)。
       */
      const skillsDir = SkillManager.getSkillsDir();
      let skillDir = path.join(skillsDir, proposal.id);
      
      // 检查目录是否已存在，如果存在则添加时间戳后缀
      let dirCounter = 0;
      while (fs.existsSync(skillDir)) {
        dirCounter++;
        const suffix = dirCounter === 1 ? Date.now().toString() : `${Date.now()}_${dirCounter}`;
        skillDir = path.join(skillsDir, `${proposal.id}_${suffix}`);
        this.log.info('[SelfLearner] 技能目录已存在，使用新目录', { skillDir });
      }

      // 确保目录存在（递归创建）
      fs.mkdirSync(skillDir, { recursive: true });
      
      // 写入 SKILL.md(Anthropic 规范的文件名;SkillLoader 两者都认,优先大写)
      const skillMdPath = path.join(skillDir, 'SKILL.md');
      fs.writeFileSync(skillMdPath, proposal.fullInstructions, 'utf-8');
      
      // 调用 SkillLoader 重新加载技能（热加载）
      try {
        const skillLoader = SkillLoader.getInstance();
        skillLoader.reloadSkills();
        this.log.info('[SelfLearner] 技能热加载成功');
      } catch (error) {
        this.log.warn('[SelfLearner] 技能热加载失败，需要重启', error);
        needsRestart = true;
      }
      
      this.log.info('[SelfLearner] 技能保存成功', { skillId: proposal.id, skillDir, name: proposal.name, needsRestart });
      
      // 清除待处理提案
      this.pendingProposal = null;
      
      return { success: true, needsRestart };
      
    } catch (error) {
      this.log.error('[SelfLearner] 保存技能失败', error);
      return { success: false, needsRestart: false };
    }
  }

  /**
   * 获取待处理的提案
   */
  public getPendingProposal(): SkillProposal | null {
    return this.pendingProposal;
  }

  /**
   * 清除待处理提案
   */
  public clearPendingProposal(): void {
    this.pendingProposal = null;
  }

  /**
   * #007 H1: 提案超时判定 (订单既定 30 分钟; 诚实文案"提案已超期自动忽略"由 UI 侧消费)
   * v1 口径: 主进程侧守卫 — 收到时刻或前端拉取时刻判定, 超期 → {expired:true, reason};
   *          未超期 → {expired:false, reason:null}. 纯判定不 clear, clear 由调用方 (UI 或 IPC) 显式执行,
   *          保持单飞语义 (主进程侧不做任何定时器 — 订单 H1 "IPC 定时器" 由前端 v2 扩展, 见 H2 备查)
   */
  public isProposalExpired(now: Date, timeoutMs: number = 30 * 60 * 1000): { expired: boolean; reason: string | null } {
    const p = this.pendingProposal;
    if (!p) return { expired: false, reason: null };
    const elapsed = now.getTime() - p.createdAt;
    if (elapsed > timeoutMs) {
      const min = Math.floor(elapsed / 60000);
      return { expired: true, reason: `提案已存在 ${min} 分钟, 超过 30 分钟有效期` };
    }
    return { expired: false, reason: null };
  }

  /**
   * 比较两个技能的相似度（公共方法）
   */
  public async checkSkillSimilarity(
    name1: string,
    description1: string,
    name2: string,
    description2: string
  ): Promise<number> {
    try {
      const enabledProviders = this.modelManager.getEnabledProviders();
      if (enabledProviders.length === 0) {
        this.log.warn('[SelfLearner] 没有启用的模型，无法进行相似度检查');
        return 0;
      }

      const provider = enabledProviders[0];
      const modelId = provider.defaultModel || provider.models[0]?.id;
      if (!modelId) {
        return 0;
      }

      const prompt = `请判断以下两个技能是否描述了相同或非常相似的用户意图？
请只回答0-100之间的数字表示相似度，100表示完全相同，0表示完全不同。

技能1名称：${name1}
技能1描述：${description1}

技能2名称：${name2}
技能2描述：${description2}
`;

      const response = await this.makeChatCompletionRequest(provider, modelId, prompt);

      if (response) {
        const match = response.match(/\d+/);
        return match ? parseInt(match[0], 10) : 0;
      }

      return 0;
    } catch (error) {
      this.log.error('[SelfLearner] 相似度检查失败', error);
      return 0;
    }
  }

  /**
   * 获取学习统计
   */
  public getStats(): Record<string, number> {
    return {
      observationCount: this.observations.length,
      analysisInProgress: this.analysisInProgress ? 1 : 0
    };
  }

  /**
   * 重置学习统计
   */
  public resetStats(): void {
    this.observations = [];
    this.pendingProposal = null;
    this.saveObservations();
    this.log.info('[SelfLearner] 学习统计已重置');
  }

}

