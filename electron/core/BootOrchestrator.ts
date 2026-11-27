/**
 * NOVA #003-C · M2 BootOrchestrator — 真实启动日志驱动版
 *
 * 职责:
 *   1. splash 窗先建(SplashWindow; 420×600 / frame:false / alwaysOnTop)
 *   2. 桥接 IpcServer NovaBootBridge(nova:renderer-ready → 真就绪握手)
 *   3. 主进程真实初始化节点经 pushBootLog() 把真实日志行推给 splash 的终端日志流
 *      (splash 只展示真实发生的事件, 不再有固定节拍/预设文案/假进度)
 *   4. 放行判定收口: 关 splash + show 主窗(执行器由 main.ts 注入)
 *
 * 关键口径(本次改造):
 *   - 删除旧的 STAGE_TICK_MS=180 固定节拍与 runStagesTicker(): 不再人为推进 7 阶段
 *   - MIN_SHOW_MS=0: rendererReady 到达即 reveal, 无 2.8s 人为最短展示
 *   - skip 入口已全部移除(splash 键盘/点击/preload/IpcServer handler);
 *     BootDirector 仍保留 skipped 状态机语义与 markSkipped() 供降级路径内部使用
 *   - 保留 10s renderer-ready 超时兜底
 *
 * 降级链:
 *   a. NW_SKIP_SPLASH=1 / NW_E2E=1 → 全阶段同步推进 + 立即放行(e2e 旁路)
 *   b. splash 文件缺失 / 构造失败 → 全阶段推进 + 立即放行
 *   c. factory 抛 → markAborted 立即放行
 *   d. renderer-ready 10s 未到 → BootDirector timeout 兜底(轮询 250ms)
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

/** boot 日志级别(终端日志流方括号标记) */
export type BootLogLevel = 'INFO' | 'WARN' | 'ERROR';

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
   * 主进程真实初始化节点调用: 把一行"此刻真实发生的事"推给 splash 日志流。
   * 不写预设文案、不按顺序播放 —— 何时调用完全由 main.ts 的真实启动流程决定。
   * splash 未创建/已销毁(旁路、e2e)时静默 no-op。
   */
  pushBootLog(level: BootLogLevel, message: string, stage?: string): void {
    this.splash?.pushBootLog({
      level,
      message,
      timestamp: Date.now(),
      stage,
    });
  }

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
      process.env.NW_SKIP_SPLASH === '1' ||
      process.env.NW_E2E === '1';

    if (skipEnv) {
      // e2e 旁路(设计稿 F6): 全阶段同步推进 + 立即放行, 主窗不被 splash 拦截
      this.runAllStagesSync();
      this.director.markRendererReady();
      this.director.markSkipped('timeout');
      this.reveal('skip-env(NW_SKIP_SPLASH/NW_E2E, 设计稿 F6)');
      return;
    }

    let splashOk = true;
    try {
      this.splash = SplashWindow.getInstance();
      this.splash.setOptions({
        onFailed: () => {
          // loadFile 失败/文件缺失 → 立即放行(设计稿 F7-b)
          this.director.markRendererReady();
          this.director.markSkipped('timeout');
          this.reveal('splash-loadFile-failed(设计稿 F7-b)');
        },
        onClose: () => {
          // 窗口销毁(正常收口路径也会触发): 若尚未收口则走兜底放行
          if (!this.finished) {
            this.director.markRendererReady();
            this.director.markSkipped('timeout');
            this.reveal('splash-closed-fallback');
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
      });
    } catch (err) {
      this.log.warn('[M2-Boot] IPC bridge 挂载失败(非致命)', String(err));
    }

    // 收口轮询(renderer-ready 握手到达即 reveal; 兜底统一走 tryReveal)
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

  /** 判定收口(IPC 回调 / 轮询 / 兜底共用) */
  private tryReveal(): void {
    if (this.finished) return;
    if (this.director.canCloseSplash()) {
      this.reveal(this.director.decide().reason);
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
