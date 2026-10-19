/**
 * NOVA #003-C · M2 BootOrchestrator(第②笔 — 主进程接线层)
 *
 * 职责(命令 #003-C 第②笔):
 *   1. splash 窗先建(SplashWindow; 420×600 / frame:false / alwaysOnTop)
 *   2. 按序推进 BootDirector 阶段(config/ipc/llm-config/memory/skills/chats/channels),
 *      三"无信号"子系统经 stageFactories 调 .getInstance() 触发同步就绪
 *      (设计稿 F3: 禁造 onReady/warmup; factory 抛 → markAborted 降级)
 *   3. 每阶段推进后推一条 nova:boot-event 给 splash(SplashWindow.pushEvent)
 *   4. 桥接 IpcServer NovaBootBridge(nova:renderer-ready / nova:boot-skip)
 *   5. 主窗显示收口: 放行 = 关 splash + show 主窗(执行器由 main.ts 注入)
 *   6. 降级链(设计稿 F7):
 *      a. PIPICLAW_SKIP_SPLASH=1 / PIPICLAW_E2E=1 → 全阶段同步推进 + 立即放行(e2e 旁路)
 *      b. splash 文件缺失 / 构造失败 → 全阶段推进 + 立即放行
 *      c. factory 抛 → markAborted 立即放行
 *      d. renderer-ready 10s 未到 → BootDirector timeout 兜底(轮询 250ms)
 *
 * 时序(设计稿 F5): 阶段事件先到 → 2.8s 下限内满格保持等"点亮"节拍;
 *   慢 → progress 显实际值, 点亮仍要 renderer-ready + 下限。
 *
 * 交叉引用(只读不改):
 *   - webcontainer:renderer-ready: electron/preload.ts:1228 / IpcServer.ts:2463
 *     本模块 nova:* 命名空间与其分属, 不冲突(设计稿 F4 §4.1)
 *   - 主窗创建点: electron/core/WindowManager.ts:49-75
 *
 * 测试约束: 本类 import electron 运行时(SplashWindow/IpcServer), 不进 node 单测;
 *   判定逻辑由 BootDirector 11 例单测覆盖(tests/unit/boot-director.test.ts);
 *   接线正确性由 e2e(PIPICLAW_E2E 旁路路径) + dev 冒烟覆盖。
 */

import { IpcServer } from './IpcServer';
import { BootDirector, BOOT_STAGE_ORDER, type BootStage } from './BootDirector';
import { SplashWindow } from './SplashWindow';

export type M2Log = {
  info: (msg: string, extra?: unknown) => void;
  warn: (msg: string, extra?: unknown) => void;
  error: (msg: string, extra?: unknown) => void;
};

const noopLog: M2Log = { info: () => {}, warn: () => {}, error: () => {} };

// 阶段节拍: 让 splash 幕间有可感知进度(事件先到→满格保持仍受 2.8s 下限约束)
const STAGE_TICK_MS = 180;

export class BootOrchestrator {
  private static instance: BootOrchestrator;

  private director: BootDirector = new BootDirector();
  private splash: SplashWindow | null = null;
  private onReveal: (() => void) | null = null;
  private log: M2Log = noopLog;
  private started = false;
  private finished = false;

  private constructor() {}

  static getInstance(): BootOrchestrator {
    if (!BootOrchestrator.instance) BootOrchestrator.instance = new BootOrchestrator();
    return BootOrchestrator.instance;
  }

  setLog(log: M2Log): this { this.log = log; return this; }

  /**
   * 启动编排(须在 WindowManager.createMainWindow 之后立即调用)。
   * @param stageFactories 阶段 → 就绪触发器(无信号子系统 = .getInstance(); 有信号阶段可空)
   * @param revealMain     放行时执行器(关 splash 已由本类做, 执行器负责 show 主窗)
   */
  start(
    stageFactories: Partial<Record<BootStage, () => unknown>>,
    revealMain: () => void,
  ): void {
    if (this.started) return;
    this.started = true;
    this.onReveal = revealMain;
    this.director = new BootDirector({ stageFactories, log: this.log });

    const skipEnv =
      process.env.PIPICLAW_SKIP_SPLASH === '1' ||
      process.env.PIPICLAW_E2E === '1';

    if (skipEnv) {
      // e2e 旁路(设计稿 F6): 全阶段同步推进 + 立即放行, 主窗不被 splash 拦截
      this.runAllStagesSync();
      this.director.markRendererReady();
      this.director.markSkipped('timeout');
      this.reveal('skip-env(PIPICLAW_SKIP_SPLASH/PIPICLAW_E2E, 设计稿 F6)');
      return;
    }

    let splashOk = true;
    try {
      this.splash = SplashWindow.getInstance();
      this.splash.setOptions({
        onSkip: () => {
          this.director.markSkipped('user-interaction');
          this.tryReveal();
        },
        onFailed: () => {
          // loadFile 失败/文件缺失 → 立即放行(设计稿 F7-b)
          this.director.markRendererReady();
          this.director.markSkipped('timeout');
          this.reveal('splash-loadFile-failed(设计稿 F7-b)');
        },
        onClose: () => {
          // 用户点 X / destroy: 也走 skip 路径
          if (!this.finished) {
            this.director.markSkipped('user-interaction');
            this.tryReveal();
          }
        },
      });
      splashOk = this.splash.create();
    } catch (err) {
      splashOk = false;
      this.log.warn('[M2-Boot] SplashWindow 创建异常, 降级(F7-b)', String(err));
    }

    if (!splashOk) {
      this.runAllStagesSync();
      this.director.markRendererReady();
      this.director.markSkipped('timeout');
      this.reveal('splash-missing-fallback(设计稿 F7-b)');
      return;
    }

    this.director.markSplashShown();

    try {
      IpcServer.getInstance().setNovaBootBootBridge({
        markRendererReady: () => { this.director.markRendererReady(); this.tryReveal(); },
        markSkipped: () => { this.director.markSkipped('user-interaction'); this.tryReveal(); },
      });
    } catch (err) {
      this.log.warn('[M2-Boot] IPC bridge 挂载失败(非致命)', String(err));
    }

    // 逐阶段推进 + 推事件(异步节拍; skip 后不再推进但允许收口)
    this.runStagesTicker();

    // 收口轮询(点亮/跳过/兜底统一走 tryReveal)
    const tick = setInterval(() => this.tryReveal(), 250);
    setTimeout(() => {
      clearInterval(tick);
      if (!this.finished) {
        // BootDirector timeout 分支兜底(renderer-ready 10s 未到达)
        this.reveal('renderer-ready-timeout-10s(设计稿 F7-d)');
      }
    }, this.director.rendererReadyTimeoutMs + 200);
  }

  /** e2e 旁路 / 降级路径用: 同步全阶段推进(工厂抛 → aborted) */
  private runAllStagesSync(): void {
    for (const stage of BOOT_STAGE_ORDER) {
      try {
        this.director.markStage(stage);
      } catch (err) {
        this.director.markAborted(`stage:${stage}:${String(err)}`);
        return;
      }
    }
  }

  /** 异步节拍推进(正常路径): 每阶段 STAGE_TICK_MS 一拍, 推 nova:boot-event */
  private runStagesTicker(): void {
    const stages = [...BOOT_STAGE_ORDER];
    let i = 0;
    const step = () => {
      if (this.finished) return;
      if (i >= stages.length) return;
      const stage = stages[i];
      if (!this.director.aborted) {
        try {
          this.director.markStage(stage);
        } catch (err) {
          this.log.warn('[M2-Boot] 阶段异常, 降级放行(F7-c)', { stage, err: String(err) });
          this.director.markAborted(`stage:${stage}:${String(err)}`);
          this.tryReveal();
          return;
        }
      }
      this.pushEvent();
      i += 1;
      if (i < stages.length) setTimeout(step, STAGE_TICK_MS);
      else this.tryReveal();
    };
    setTimeout(step, STAGE_TICK_MS);
  }

  private pushEvent(): void {
    const last = this.director.events[this.director.events.length - 1];
    if (!last) return;
    this.splash?.pushEvent({
      stage: last.stage,
      label: last.label,
      progress: this.director.progress,
      detail: last.detail,
      timestamp: last.timestamp,
    });
  }

  /** 判定收口(IPC 回调 / 轮询 / 兜底共用) */
  private tryReveal(): void {
    if (this.finished) return;
    if (this.director.canCloseSplash()) {
      this.reveal(this.director.decide().reason);
    } else {
      this.pushEvent(); // 期间进度仍推(事件先到→满格保持, 设计稿 F5)
    }
  }

  private reveal(reason: string): void {
    if (this.finished) return;
    this.finished = true;
    try { this.splash?.close(); } catch { /* ignore */ }
    try {
      this.onReveal?.();
    } catch (err) {
      this.log.error('[M2-Boot] reveal 执行器异常', String(err));
    }
    this.log.info(`[M2-Boot] 收口完成 reason=${reason}`);
  }

  get done(): boolean { return this.finished; }
}
