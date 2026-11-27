/**
 * NOVA #002 · 生命体 Orb 状态机 (pinia store)
 *
 * 口径 (命令 #002 §2):
 *   - state: 'idle' | 'listening' | 'thinking' | 'speaking' | 'hidden'
 *   - 迁移优先级: listening > thinking > speaking > idle
 *     · 升级/平级 = 允许 (返回 true)
 *     · 非法降级 (向低优先级迁移) = 保持高优先级状态, 返回 false
 *   - 'hidden' = 显式隐藏意向, 视为"退出态": 任意状态 → hidden 允许;
 *     hidden → 任意状态 允许 (恢复生命感由新信号驱动)
 *   - statusText: i18n key (orb.status.<state>) — 文案在 zh-CN/en-US 维护
 *   - M4 预留: listening / speaking 由语音链路驱动, 本版 Chat 只走 thinking/idle
 */
import { defineStore } from 'pinia';
import { computed, ref, watch } from 'vue';

export type OrbState = 'idle' | 'listening' | 'thinking' | 'speaking' | 'hidden';

/** 优先级序 (数值越大越高); hidden 不参与序, 走独立分支 */
const PRIORITY: Record<Exclude<OrbState, 'hidden'>, number> = {
  listening: 3,
  thinking: 2,
  speaking: 1,
  idle: 0,
};

export const ORB_PRIORITY = PRIORITY;

export const useOrbStore = defineStore('nova-orb', () => {
  const state = ref<OrbState>('idle');
  const lastReason = ref<string | null>(null);

  /* ============================================================
     NW · 语义化生命体征数据层 (追加, 不改上方状态机语义)
     动效不再是装饰 — 每个视觉参数都对应一个真实数据:
       breathDuration ← state        (呼吸快慢 = 模型状态)
       activity       ← attention    (神经放电密度 = 思考强度)
       tokenRate      ← onToken 流   (粒子喷射 = token 消耗)
       contextUsage   ← 会话上下文   (环填充/变色 = 占用压力)
     ============================================================ */
  const activity = ref<number>(0);        // 0..1 神经激活度
  const tokenCount = ref<number>(0);      // 本次会话累计 token 数(流式估算 → 精确值覆盖)
  const tokenRate = ref<number>(0);       // 近 1s 的 tok/s
  const contextUsage = ref<number>(0);    // 0..1 上下文占用
  const pulseSeq = ref<number>(0);        // 脉冲序号: 每次数据事件自增, 供 NovaOrb watch 触发粒子
  /** 数据来源: 'estimate' = 字符估算(流式实时) | 'exact' = 主进程真实 usage */
  const usageSource = ref<'estimate' | 'exact'>('estimate');
  const exactPromptTokens = ref<number>(0);
  const exactCompletionTokens = ref<number>(0);
  /** 【P2】本轮思考 token —— 只在 provider 真回传时 > 0 */
  const exactReasoningTokens = ref<number>(0);
  const usageModel = ref<string>('');

  /** 呼吸周期(ms) — 状态驱动, 语义化动效的核心 */
  const BREATH_MS: Record<OrbState, number> = {
    idle: 4200,
    listening: 2400,
    thinking: 1500,
    speaking: 1050,
    hidden: 0,
  };
  const breathDuration = computed<number>(() => BREATH_MS[state.value]);

  /**
   * 呼吸周期广播到根级 CSS 变量 `--nw-breath`。
   * 全页氛围层(global.scss body::after)与 orb 光晕共用这一个周期源,
   * 保证"环境呼吸"与"生命体呼吸"永远同频 —— 周期只有 store 一处定义。
   * hidden(0ms) 不同步, 环境保持上一个周期继续呼吸(orb 本体隐藏)。
   */
  function syncBreathToRoot(): void {
    if (typeof document === 'undefined') return;
    const ms = breathDuration.value;
    if (ms > 0) {
      document.documentElement.style.setProperty('--nw-breath', `${ms}ms`);
    }
  }
  watch(breathDuration, syncBreathToRoot, { immediate: true, flush: 'sync' });

  /** token 到达时间戳滑动窗口(用于算真实 tok/s), 不参与响应式序列化 */
  let tokenTimestamps: number[] = [];

  /** 一次 attention / 工具调用事件 → 提升激活度并发一枚神经脉冲 */
  function noteAttention(weight = 0.14): void {
    activity.value = Math.min(1, activity.value + weight);
    pulseSeq.value++;
  }

  /** 本轮生成是否活跃 (区别于 generationStartedAt: finish 后归零但精确值可能后到) */
  let roundActive = false;

  /** 流式 token 到达: delta 为文本增量, 按 ~3 字符/token 估算, 发 token 脉冲 */
  function noteToken(deltaLen = 1): void {
    if (!roundActive) {
      // 新一轮开始: 打点 + 从上轮 exact 回到 estimate, 清零本轮计数
      roundActive = true;
      generationStartedAt = Date.now();
      usageSource.value = 'estimate';
      tokenCount.value = 0;
    }
    const approxTokens = Math.max(1, Math.round(deltaLen / 3));
    // 精确值已到达后不再用估算累加, 避免污染真实计数 (同轮迟到的 delta)
    if (usageSource.value !== 'exact') tokenCount.value += approxTokens;
    const now = Date.now();
    tokenTimestamps.push(now);
    tokenTimestamps = tokenTimestamps.filter(t => now - t < 1000);
    tokenRate.value = tokenTimestamps.length;
    activity.value = Math.min(1, activity.value + 0.03);
    pulseSeq.value++;
  }

  function setContextUsage(usage: number): void {
    contextUsage.value = Math.min(1, Math.max(0, usage));
  }

  /** 记录本轮生成开始时刻 (noteToken 首次触发时打点), 用于精确 tok/s 计算 */
  let generationStartedAt = 0;

  /**
   * 【NW 精确计数】主进程真实 usage (与 CostTracker 同源) 到达时调用, 覆盖流式估算。
   * - tokenCount 直接用 completionTokens (输出) + promptTokens (输入) 的真实总量
   * - tokenRate 用 completionTokens / 本轮生成耗时 算真实吞吐
   * - 误差修正: 流式期间 noteToken 已累加了估算值, 这里以精确值替换而非累加
   * - 上下文占用: 用 promptTokens(真实提示词长度) / 窗口 更新, 比字符估算准
   */
  function setExactUsage(usage: {
    promptTokens: number;
    completionTokens: number;
    totalTokens: number;
    model?: string;
    contextWindow?: number;
    reasoningTokens?: number;
  }): void {
    exactPromptTokens.value = usage.promptTokens;
    exactCompletionTokens.value = usage.completionTokens;
    // 未提供即清零：换模型/换 provider 后不能残留上一轮的思考计数
    exactReasoningTokens.value = usage.reasoningTokens ?? 0;
    usageModel.value = usage.model ?? '';
    usageSource.value = 'exact';

    // 用真实值替换估算的 tokenCount (以输出为准, 与 UI "已生成 tokens" 语义一致)
    tokenCount.value = usage.completionTokens || usage.totalTokens;

    // 真实吞吐: completionTokens / 耗时(s)。耗时缺失时保留流式窗口估算值。
    const elapsedMs = generationStartedAt ? Date.now() - generationStartedAt : 0;
    if (elapsedMs > 0 && usage.completionTokens > 0) {
      tokenRate.value = Math.max(1, Math.round(usage.completionTokens / (elapsedMs / 1000)));
    }

    // 真实上下文占用: promptTokens / 窗口。窗口未提供时不动(保留 Chat.vue 的估算)
    if (usage.contextWindow && usage.contextWindow > 0) {
      contextUsage.value = Math.min(1, Math.max(0, usage.promptTokens / usage.contextWindow));
    }
  }

  /** 显式开启一轮生成 (供无流式 delta 的场景打点, 供 setExactUsage 算真实吞吐) */
  function markGenerationStart(): void {
    roundActive = true;
    generationStartedAt = Date.now();
    usageSource.value = 'estimate';
    tokenCount.value = 0;
  }

  /** 自然衰减: 由 NovaOrb 在脉冲节拍中调用, 让激活度在静息时回落到状态基线 */
  function decayActivity(factor = 0.94): void {
    const floor = state.value === 'thinking' ? 0.72 : state.value === 'speaking' ? 0.88 : state.value === 'listening' ? 0.22 : 0.06;
    activity.value = Math.max(floor, activity.value * factor);
    if (Date.now() - (tokenTimestamps[tokenTimestamps.length - 1] ?? 0) > 1200) tokenRate.value = 0;
  }

  /** 会话轮结束: 归零瞬态数据(累计 token 与上下文保留, 属会话级) */
  function settleMetrics(): void {
    activity.value = 0;
    tokenRate.value = 0;
    tokenTimestamps = [];
    // 精确 usage 与累计 token 保留, 供 UI 展示"上一轮真实消耗";
    // 关闭轮次标记, 下一轮 noteToken/markGenerationStart 会重新开启并清零计数。
    roundActive = false;
    generationStartedAt = 0;
  }

  function setState(next: OrbState, reason?: string): boolean {
    const from = state.value;
    if (from === next) {
      if (reason !== undefined) lastReason.value = reason;
      return true; // 平级: 幂等
    }
    // hidden 独立分支: 任意 → hidden 允许; hidden → 任意允许
    if (from === 'hidden' || next === 'hidden') {
      state.value = next;
      lastReason.value = reason ?? null;
      return true;
    }
    if (PRIORITY[next] < PRIORITY[from]) {
      // 非法降级: 保持高优先级状态
      lastReason.value = reason ?? null;
      return false;
    }
    state.value = next;
    lastReason.value = reason ?? null;
    return true;
  }

  const statusText = computed<string>(() => `orb.status.${state.value}`);

  /**
   * M1 生命周期出口: 一次交互结束 → 归位 idle。
   * 与 setState 优先级语义区分: thinking/speaking/listening 是"进行中"态,
   * finish() 是"会话轮结束"信号 — 允许它们回 idle (非非法降级)。
   * idle/hidden 调 finish = 幂等空操作。
   */
  function finish(reason?: string): void {
    if (state.value === 'thinking' || state.value === 'speaking' || state.value === 'listening') {
      state.value = 'idle';
      lastReason.value = reason ?? null;
      settleMetrics(); // NW: 回复结束 → 瞬态体征归零, 核心回到静息呼吸
    }
  }

  return {
    state,
    lastReason,
    statusText,
    setState,
    finish,
    // NW 语义化生命体征
    activity,
    tokenCount,
    tokenRate,
    contextUsage,
    pulseSeq,
    breathDuration,
    noteAttention,
    noteToken,
    setContextUsage,
    decayActivity,
    settleMetrics,
    // NW 精确 usage (主进程真实 token 计数)
    usageSource,
    exactPromptTokens,
    exactCompletionTokens,
    exactReasoningTokens,
    usageModel,
    setExactUsage,
    markGenerationStart,
  };
});
