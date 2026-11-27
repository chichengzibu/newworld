/**
 * NOVA #003-C · BootDirector 状态机(纯逻辑核心)
 *
 * 口径 (F3/F5/F7):
 *   - 阶段序固定: config → ipc → llm-config → memory → skills → chats → channels
 *     (renderer-ready 不属于阶段序, 是独立握手信号)
 *   - progress = 已完成阶段数 / 阶段总数, 单调不减(防御 clamp)
 *   - markStage 必须按序推进: 乱序/跳序 → throw(调用方接线错误, 显式暴露)
 *   - 重复 markStage 同阶段 → 幂等空操作(不重复推事件)
 *   - canClose 判定(四选一, 任一满足即允许销毁 splash):
 *       1. skipped = true                     (保留状态机语义, 入口已移除)
 *       2. aborted = true                     (失败路径强切, 立即放行)
 *       3. rendererReady                      (真就绪即关; MIN_SHOW_MS=0, 无人为等待)
 *       4. elapsed >= RENDERER_READY_TIMEOUT_MS     (10s 超时兜底强切)
 *   - 三"无信号"子系统(llm-config/memory/skills)经 stageFactories 注入:
 *     BootDirector 不持有任何子系统引用, 只在 markStage 时调用对应 factory
 *     触发其 getInstance() 同步初始化。禁止给子系统加 onReady/warmup 新方法。
 *
 * 设计约束(命令 #003-C 第①笔):
 *   - 纯逻辑, 零 electron 直接 import(不 import electron/log 任何模块),
 *     日志经依赖注入 LogSink, 便于 node 单测环境运行。
 *   - 时间经 now() 注入, 便于测试冻结时钟。
 *   - 不持有 splash/mainWindow/BrowserWindow 引用: 窗口动作由上层
 *     (main.ts / WindowManager 接线, 第②笔) 依据本状态机判定执行。
 */

export type BootStage =
  | 'config'
  | 'ipc'
  | 'llm-config'
  | 'memory'
  | 'skills'
  | 'chats'
  | 'channels';

/** 阶段固定推进顺序(设计稿 F3 §3.1; renderer-ready 不在此列, 见类注释) */
export const BOOT_STAGE_ORDER: readonly BootStage[] = [
  'config',
  'ipc',
  'llm-config',
  'memory',
  'skills',
  'chats',
  'channels',
] as const;

/** 事件载荷(设计稿 F4 §4.2) */
export interface BootEventPayload {
  stage: BootStage;
  /** 展示文案; 默认 = stage 名, 第②笔可由 i18n labelProvider 覆盖 */
  label: string;
  /** 0..1, 单调不减 */
  progress: number;
  detail?: string;
  timestamp: number;
}

/** 日志出口(注入; 生产 = LogManager, 测试 = 收集数组) */
export interface LogSink {
  info: (msg: string, extra?: unknown) => void;
  warn: (msg: string, extra?: unknown) => void;
  error: (msg: string, extra?: unknown) => void;
}

export interface BootDirectorOptions {
  /** 时间源, 默认 Date.now */
  now?: () => number;
  /** 日志出口, 默认 no-op */
  log?: LogSink;
  /** 阶段 → 子系统触工厂(无信号子系统的 .getInstance() 触发器) */
  stageFactories?: Partial<Record<BootStage, () => unknown>>;
  /** 阶段标签(第②笔接 i18n), 默认取阶段名 */
  labelFor?: (stage: BootStage) => string;
  /** 最短展示(已归零: 真就绪即关, 无人为等待) */
  minShowMs?: number;
  /** renderer-ready 10s 超时兜底(设计稿 F7) */
  rendererReadyTimeoutMs?: number;
}

const NOOP_LOG: LogSink = { info: () => {}, warn: () => {}, error: () => {} };

export class BootDirector {
  /** 真就绪即关: 取消旧的 2.8s 人为最短展示 */
  static readonly MIN_SHOW_MS_DEFAULT = 0;
  static readonly RENDERER_READY_TIMEOUT_MS_DEFAULT = 10_000;

  private readonly now: () => number;
  private readonly log: LogSink;
  private readonly stageFactories: Partial<Record<BootStage, () => unknown>>;
  private readonly labelFor: (stage: BootStage) => string;
  readonly minShowMs: number;
  readonly rendererReadyTimeoutMs: number;

  private readonly completed = new Set<BootStage>();
  private lastProgress = 0;
  private splashShownAt: number | null = null;

  rendererReady = false;
  skipped = false;
  aborted = false;

  /** 每次 markStage 成功/幂等时追加(供单测断言事件流) */
  readonly events: BootEventPayload[] = [];

  constructor(options: BootDirectorOptions = {}) {
    this.now = options.now ?? (() => Date.now());
    this.log = options.log ?? NOOP_LOG;
    this.stageFactories = options.stageFactories ?? {};
    this.labelFor = options.labelFor ?? ((stage) => stage);
    this.minShowMs = options.minShowMs ?? BootDirector.MIN_SHOW_MS_DEFAULT;
    this.rendererReadyTimeoutMs =
      options.rendererReadyTimeoutMs ?? BootDirector.RENDERER_READY_TIMEOUT_MS_DEFAULT;
  }

  /** splash show() 时调用, 起算 10s 兜底时钟 */
  markSplashShown(): void {
    this.splashShownAt = this.now();
    this.log.info('[BootDirector] splash shown', { at: this.splashShownAt });
  }

  /** splash 是否已完成显示(下限/兜底时钟的基准); 未 show 时按已 show 处理(宽限) */
  private elapsed(): number {
    if (this.splashShownAt === null) return Infinity;
    return this.now() - this.splashShownAt;
  }

  private computeProgress(): number {
    return this.completed.size / BOOT_STAGE_ORDER.length;
  }

  /**
   * 推进一个阶段(必须按 BOOT_STAGE_ORDER 序)。
   * 成功: 触发对应 factory(无信号子系统的 .getInstance()), 推 BootEventPayload。
   * 幂等: 重复调用同阶段 = 空操作, 不重复推事件(设计稿 F9 T2b)。
   * 乱序/跳序: throw(接线错误显式暴露, 不静默吞)。
   */
  markStage(stage: BootStage, detail?: string): void {
    if (this.aborted) {
      this.log.warn('[BootDirector] markStage after aborted, ignored', { stage });
      return;
    }
    if (this.completed.has(stage)) {
      this.log.info('[BootDirector] markStage idempotent', { stage });
      return;
    }
    const nextExpected = BOOT_STAGE_ORDER[this.completed.size];
    if (stage !== nextExpected) {
      const err = new Error(
        `[BootDirector] 阶段乱序: 期望 ${String(nextExpected)}, 实收 ${stage} ` +
          `(已完成: ${[...this.completed].join(',')})`,
      );
      this.aborted = true;
      this.log.error('[BootDirector] markStage 乱序, 转入 aborted', {
        expected: String(nextExpected),
        got: stage,
      });
      throw err;
    }

    // 无信号子系统的显式触发(设计稿 F3: factory = .getInstance(), 禁造 onReady/warmup)
    const factory = this.stageFactories[stage];
    if (factory) {
      factory();
      this.log.info('[BootDirector] stage factory invoked', { stage });
    }

    this.completed.add(stage);
    this.lastProgress = Math.max(this.lastProgress, this.computeProgress());
    this.events.push({
      stage,
      label: this.labelFor(stage),
      progress: this.lastProgress,
      detail,
      timestamp: this.now(),
    });
  }

  /** 所有阶段是否完成(与 renderer-ready 无关, 后者独立) */
  get stagesComplete(): boolean {
    return BOOT_STAGE_ORDER.every((s) => this.completed.has(s));
  }

  /** progress 单调不减(对外只读, 恒 = 当前已完成比) */
  get progress(): number {
    return this.lastProgress;
  }

  /** 渲染进程握手(nova:renderer-ready 到达) */
  markRendererReady(): void {
    if (this.rendererReady) return;
    this.rendererReady = true;
    this.log.info('[BootDirector] renderer-ready');
  }

  /** 保留状态机语义: 立即放行(skip 入口已从 splash/窗口移除, 仅兜底/降级路径内部使用) */
  markSkipped(reason: 'user-interaction' | 'timeout' = 'user-interaction'): void {
    this.skipped = true;
    this.log.info('[BootDirector] skip', { reason });
  }

  /** 失败路径(子系统 factory 抛 / loadFile 失败等): 强切, 立即放行(设计稿 F7) */
  markAborted(reason: string): void {
    this.aborted = true;
    this.log.warn('[BootDirector] aborted', { reason });
  }

  /**
   * 是否允许立即销毁 splash + show 主窗(四选一):
   *   1. skipped 2. aborted 3. rendererReady(真就绪即关, minShowMs=0)
   *   4. elapsed>=rendererReadyTimeoutMs(兜底)
   * 未 show splash(splashShownAt=null)时 elapsed 按 Infinity(宽限: 允许立即点亮)。
   */
  canCloseSplash(): boolean {
    return this.decide().close;
  }

  /** 判定明细(供 main.ts 接线时区分"点亮/跳过/兜底"做日志) */
  decide(): { close: boolean; reason: 'pending' | 'light-up' | 'skip' | 'aborted' | 'timeout' } {
    if (this.aborted) return { close: true, reason: 'aborted' };
    if (this.skipped) return { close: true, reason: 'skip' };
    const elapsed = this.elapsed();
    if (this.rendererReady && elapsed >= this.minShowMs) {
      return { close: true, reason: 'light-up' };
    }
    if (elapsed >= this.rendererReadyTimeoutMs) {
      return { close: true, reason: 'timeout' };
    }
    return { close: false, reason: 'pending' };
  }
}
