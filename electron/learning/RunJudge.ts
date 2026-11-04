/**
 * PiPiClaw — LLM 裁判层（M4-F）
 * ═══════════════════════════════════════════════════════════════
 * 【它补的是哪一环】
 * TaskGrader 的前 ③ 层全是**确定性**判定:硬信号(工具失败/运行错误/有答复)、
 * 结构约束(must_call 等)、相似度。它们能判「过程有没有出错」,
 * 但判不了「**这个答复到底答没答到点上**」。
 *
 * 「答复到不到点上」需要语义判断 → 只能交给 LLM 裁判。
 *
 * 【为什么做成【可注入】而不是直接调 LLM】
 * ① **可测** — 单测里注入假裁判,不联网、不调模型
 * ② **可换** — 本地 ollama 小模型 / 云端模型 / 别的裁判,换实现不改判定层
 * ③ **可控成本** — 裁判是一次模型调用,不该每次评分都跑
 *
 * 【业界依据与据此的取舍】
 * - 「judge drift 是真问题」:换裁判模型、换提示词顺序、换评分描述都会改结果;
 *   裁判还偏爱长答案、对自己的输出有偏好。
 *   → 故:裁判层**默认关闭**、只在明确开启时跑、且**结果只作参考不作判定**。
 * - 推荐的配比是「~30% 启发式 + ~10% 参考答案 + ~40% pairwise 裁判 + ~20% 人工」,
 *   且**只对 2~5% 的流量跑裁判**(够统计置信度就行)。
 *   → 故:提供 `sampleRate`,默认 0.05。
 * - 「pairwise 比绝对打分可靠得多」
 *   → 故:裁判的提示词优先用**对比**口径(与参考答复比),而不是绝对打分。
 *
 * 【本实现的边界 —— 必须说清】
 * 这一层给的是**弱信号**,不是结论:
 *   - 它不参与「成功/失败」的判定,只进综合分与说明
 *   - 样本量小时(judgeCount < 5)整体结论仍按「样本不足」处理
 *   - 换裁判模型后,**历史分数不可直接比较**(judge drift)
 */
import { LlmClient } from '../llm/LlmClient'
import { LogManager } from '../core/LogManager'
import type { GradableRun, TaskExpectation } from './TaskGrader'
import type { LlmProvider } from '../llm/types' 

/** 裁判结论 */
export interface JudgeVerdict {
  passed: boolean;
  /** 一句话理由(给人看的) */
  reason: string;
  /** 0~1 的置信/评分(可选) */
  score?: number;
}

/** 裁判函数 —— 可注入 */
export type RunJudge = (
  run: GradableRun,
  expectation: TaskExpectation,
) => Promise<JudgeVerdict>

/** 裁判的默认配置 */
export interface JudgeConfig {
  /** 用哪个模型(默认本地 ollama 的小模型) */
  model?: string;
  /** provider(默认 openai-compatible —— 本项目的 ollama 走这个适配器,本地小模型、零外发) */
  provider?: LlmProvider;
  /** 采样率:只对这么大比例的样本跑裁判(业界建议 2~5%) */
  sampleRate?: number;
}

/** 默认裁判模型 —— 本地 ollama 的小参数模型(与项目「测试用本地小模型」的取向一致) */
export const DEFAULT_JUDGE_MODEL = 'qwen3.5:9b';
/** 业界建议的裁判采样率上限 */
export const DEFAULT_JUDGE_SAMPLE_RATE = 0.05;
/** 低于这个裁判样本量,整体结论不给 */
export const JUDGE_MIN_SAMPLES = 5;

/**
 * 裁判提示词 —— 按「对比」口径写(业界:pairwise 比绝对打分可靠)。
 *
 * 【约束裁判 —— 业界共识】
 * - 3~5 条明确标准,不要开放式打分
 * - 强制结构化输出(pass + reason)
 * - 校准:先用人工标注过的样本对齐,再放量
 */
function buildJudgePrompt(run: GradableRun, expectation: TaskExpectation): string {
  const criteria: string[] = [];
  if (expectation.mustCall?.length) criteria.push(`必须调用过这些工具:${expectation.mustCall.join('、')}`);
  if (expectation.mustNotCall?.length) criteria.push(`不应调用这些工具:${expectation.mustNotCall.join('、')}`);
  if (expectation.mustContain?.length) criteria.push(`答复里应包含这些内容:${expectation.mustContain.join('、')}`);
  criteria.push('答复是否直接回应了用户的诉求');
  criteria.push('答复是否给出了可执行的下一步或结果');

  return [
    '你是任务质量的评判者。给定一次助手执行的指令与最终答复，判断这次执行是否达成了用户的目标。',
    '',
    '## 判定标准',
    ...criteria.map((c, i) => `${i + 1}. ${c}`),
    '',
    '## 本次执行',
    `用户指令: ${run.instruction}`,
    `使用的工具: ${(run.toolsUsed ?? []).join('、') || '(无)'}`,
    `助手答复: ${run.answer ?? '(无答复)'}`,
    run.referenceAnswer ? `参考答案: ${run.referenceAnswer}` : '',
    '',
    '## 输出格式',
    '只输出一个 JSON 对象，不要有其他文字:',
    '{"pass": true 或 false, "reason": "一句话理由", "score": 0 到 1 之间的数字}',
    '',
    '注意：宁缺勿滥。答复看似相关但没有真正完成任务时，pass 应为 false。',
  ].filter(Boolean).join('\n');
}

/**
 * 本地/云端裁判 —— 用项目自己的 LlmClient 发一次请求。
 *
 * 【为什么用 LlmClient 而不是直接 fetch】
 * 它已处理了 provider 差异、流式/非流式、重试、错误分类 —— 直接调各家 API
 * 会把这些逻辑再写一遍(而且会写错)。
 */
export function createLlmJudge(config: JudgeConfig = {}): RunJudge {
  const log = LogManager.getInstance();
  const model = config.model ?? DEFAULT_JUDGE_MODEL;
  const provider = config.provider ?? 'openai-compatible';

  return async (run, expectation) => {
    try {
      const res = await LlmClient.getInstance().chat({
        model,
        provider,
        temperature: 0,
        maxTokens: 300,
        messages: [{ role: 'user', content: buildJudgePrompt(run, expectation) }],
      });
      const text = (res?.content ?? '').trim();
      const parsed = parseJudgeOutput(text);
      if (!parsed) {
        log.warn('[RunJudge] 裁判输出无法解析,按不确定处理(不判失败)', { model, text: text.slice(0, 120) });
        return { passed: false, reason: '裁判输出无法解析(不确定)' };
      }
      return parsed;
    } catch (e) {
      // 裁判不可用**不能**当成「失败」—— 那是把基础设施故障算成质量问题
      log.warn('[RunJudge] 裁判调用失败,按不确定处理', { model, error: String(e) });
      return { passed: false, reason: `裁判不可用(${String(e)})` };
    }
  };
}

/**
 * 解析裁判输出 —— 容错:允许 ```json 包裹、允许前后有杂字。
 */
export function parseJudgeOutput(text: string): JudgeVerdict | null {
  if (!text) return null;
  const m = text.match(/\{[\s\S]*\}/);
  if (!m) return null;
  try {
    const obj = JSON.parse(m[0]) as { pass?: unknown; reason?: unknown; score?: unknown };
    if (typeof obj.pass !== 'boolean') return null;
    return {
      passed: obj.pass,
      reason: typeof obj.reason === 'string' ? obj.reason : '(无理由)',
      ...(typeof obj.score === 'number' ? { score: Math.max(0, Math.min(1, obj.score)) } : {}),
    };
  } catch {
    return null;
  }
}

/**
 * 采样器 —— 决定这一次要不要跑裁判。
 *
 * 【为什么要有采样器】
 * 裁判是一次模型调用。全量跑会让评估的成本翻几倍,
 * 而业界实践是**只对 2~5% 的流量跑**(够统计置信度就行)。
 *
 * 【可复现】用确定性伪随机(按序号取模),不用 Math.random ——
 * 否则同一批样本两次评估跑出的裁判结果不可比,没法做回归对比。
 */
export function createJudgeSampler(sampleRate: number = DEFAULT_JUDGE_SAMPLE_RATE): (index: number) => boolean {
  const rate = Math.max(0, Math.min(1, sampleRate));
  if (rate <= 0) return () => false;
  if (rate >= 1) return () => true;
  // 确定性抽样:index % round(1/rate) === 0
  const every = Math.max(1, Math.round(1 / rate));
  return (index: number) => index % every === 0;
}
