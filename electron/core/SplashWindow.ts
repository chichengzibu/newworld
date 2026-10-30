import { BrowserWindow, app, shell } from 'electron';
import * as path from 'node:path';
import { LogManager } from './LogManager';

export interface SplashOptions {
  /**
   * loadFile 失败 / 资源文件缺失 → 主进程降级直开主窗。
   *
   * 【M3-F 补】设计稿 F7 与本文件头注释都写明"loadFile 失败 → onFailed 回调 →
   * 主进程降级直开主窗(本类不做静默吞错)",但接口里**漏了这个字段** ——
   * 于是 5 处调用点全是类型错误,类型系统还在替我们记着这笔债。
   */
  onFailed?(reason?: string): void;
  /** 事件推给 splash 窗(nova:boot-event) */
  onEvent?(payload: Record<string, unknown>): void;
  /** 跳过请求 → 主进程侧立即放行 */
  onSkip?(): void;
  /** 用户点击 splash 外部/关闭 → 同跳过语义 */
  onClose?(): void;
}

/**
 * NOVA #003 · M2 Splash 窗口(第②笔)
 *
 * 规格(设计稿 F2):
 *   - frame:false / resizable:false / movable:false / alwaysOnTop
 *   - 420×600 · show:false → ready-to-show 才 show
 *   - loadFile 静态 resources/splash.html(不进 Vite 管线)
 *   - loadFile 失败 / 文件缺失 → onFailed 回调 → 主进程降级直开主窗(设计稿 F7, 本类不做静默吞错)
 *   - 渲染端 splash 内 click/keydown 经 nova:boot-skip 转发 → onSkip
 *
 * 命名/事件流交叉引用(只读不改): electron/preload.ts:1228 / IpcServer.ts:2463
 *   既有 webcontainer:renderer-ready 与本组件 nova:* 命名空间分属, 不冲突。
 */
export class SplashWindow {
  private static instance: SplashWindow;
  private log = LogManager.getInstance();
  private win: BrowserWindow | null = null;
  private opts: SplashOptions;

  // 尺寸硬规格(设计稿 F2)
  private static readonly W = 420;
  private static readonly H = 600;

  private constructor(opts: SplashOptions) {
    this.opts = opts;
  }

  static getInstance(opts?: SplashOptions): SplashWindow {
    if (!SplashWindow.instance) {
      SplashWindow.instance = new SplashWindow(opts ?? {});
    } else if (opts) {
      SplashWindow.instance.opts = { ...SplashWindow.instance.opts, ...opts };
    }
    return SplashWindow.instance;
  }

  /**
   * 在 create() 之前注入回调(跳过 onFailed / onSkip / onClose)。
   * 用于"先 getInstance 再装配 opts"的调用序列(BootOrchestrator 降级链)。
   */
  setOptions(opts: SplashOptions): void {
    this.opts = { ...this.opts, ...opts };
  }

  /**
   * 创建 splash 窗 + loadFile splash.html
   * 返回 true = splash 正常创建(等 ready-to-show 再 show);
   * 返回 false = loadFile 同步失败 / 文件不存在 → 主进程应降级(F7), 不静默吞。
   */
  create(): boolean {
    // 【M3-F】'test' 不在 NodeJS.Platform 联合类型里 → 比较被 TS 判为"永假"。
    // 这里确实是刻意的测试环境短路,显式转 string 保住意图。
    if ((process.platform as string) === 'test') return false;
    if (this.win && !this.win.isDestroyed()) return true;

    const splashPath = path.join(app.getAppPath(), 'resources', 'splash.html');
    let fs: typeof import('node:fs') | null = null;
    try {
      fs = require('node:fs') as typeof import('node:fs');
    } catch (err) {
      this.log.warn(`Splash: 无法加载 fs 模块, 降级: ${String(err)}`);
      this.opts.onFailed?.();
      return false;
    }

    if (!fs.existsSync(splashPath)) {
      this.log.warn(`Splash: 文件缺失, 降级直开主窗(设计稿 F7): ${splashPath}`);
      this.opts.onFailed?.();
      return false;
    }

    this.win = new BrowserWindow({
      width: SplashWindow.W,
      height: SplashWindow.H,
      frame: false,
      resizable: false,
      movable: false,
      minimizable: false,
      maximizable: false,
      fullscreenable: false,
      alwaysOnTop: true,
      skipTaskbar: true,
      show: false,
      backgroundColor: '#050508', // 值来源 src/styles/tokens.css:416 --nova-bg-deep
      webPreferences: {
        contextIsolation: true,
        nodeIntegration: false,
        sandbox: false,
        preload: path.join(app.getAppPath(), 'dist-electron', 'preload.js'),
      },
    });

    this.win.setMenu(null);
    this.win.on('closed', () => {
      this.win = null;
      this.opts.onClose?.();
    });
    // 外链安全: splash 不应触发默认新窗口
    this.win.webContents.setWindowOpenHandler(({ url }) => {
      if (/^https?:\/\//i.test(url)) shell.openExternal(url);
      return { action: 'deny' };
    });

    const filePath = path.join(app.getAppPath(), 'resources', 'splash.html');
    this.win.once('ready-to-show', () => {
      try {
        this.win?.center();
      } catch { /* ignore */ }
      this.win?.show();
    });

    try {
      this.win.loadFile(filePath).catch((err) => {
        this.log.warn(`Splash: loadFile 异步失败, 降级: ${String(err)}`);
        this.opts.onFailed?.();
      });

      // ---- 跳过(设计稿 F5/F6) ----
      // 主进程级点击跳过:splash 任意位置点击即跳过(不依赖渲染层)
      // 【M3-F】'mouse-down' 不是 webContents 的事件名(类型系统一直报错)。
      // 主进程侧要感知"用户在 splash 上点了鼠标",正确的 API 是
      // `before-input-event` —— 它把渲染侧收到的输入事件回传主进程,
      // 正好对应设计稿 F5/F6 的"主进程级点击跳过"。
      this.win.webContents.on('before-input-event', (_e, input) => {
        if (input.type === 'mouseDown') {
          this.opts.onSkip?.();
        }
      });
      // 键盘跳过走渲染端 splash.html keydown → window.nova?.skip()
      //   → preload nova.skip() → IpcServer nova:boot-skip → onSkip(同一链路, preload 双窗共用)
      return true;
    } catch (err) {
      this.log.warn(`Splash: loadFile 同步异常, 降级: ${String(err)}`);
      this.opts.onFailed?.();
      return false;
    }
  }

  /** 推一条 nova:boot-event 给 splash 渲染端(F4; splash 内 window.nova?.onBootEvent 消费) */
  pushEvent(payload: Record<string, unknown>): void {
    if (!this.win || this.win.isDestroyed()) return;
    try {
      this.win.webContents.send('nova:boot-event', payload);
    } catch { /* 窗口已销毁等瞬时态, 忽略 */ }
  }

  close(): void {
    const win = this.win;
    this.win = null;
    if (win && !win.isDestroyed()) {
      try { win.destroy(); } catch { /* ignore */ }
    }
  }

  isAlive(): boolean {
    return this.win != null && !this.win.isDestroyed();
  }

  width(): number { return SplashWindow.W; }
  height(): number { return SplashWindow.H; }
}
