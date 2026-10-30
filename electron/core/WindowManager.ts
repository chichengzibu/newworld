/**
 * PiPiClaw - 窗口管理器
 */

import { BrowserWindow, screen, app } from 'electron';
import { join } from 'path';
import { LogManager } from './LogManager';
import { ConfigStore } from './ConfigStore';

export class WindowManager {
  // NOVA #003-C · M2(第②笔): 主窗显示由 BootDirector 收口调度(设计稿 §5 / F5)。
  //   - 默认(null): 无 boot 编排(e2e 旁路/单测/降级)时 ready-to-show 立即 show, 与既有行为一致
  //   - 注入(返回 false): 挂起显示, BootDirector 收口后由 BootOrchestrator 调 show()
  private revealGate: ((win: BrowserWindow) => boolean) | null = null;
  private pendingReveal = false;

  /** 挂接显示门(BootOrchestrator 注入): 返回 true = 放行 show, false = 挂起待收口; null = 拆除门 */
  setRevealGate(gate: ((win: BrowserWindow) => boolean) | null): void {
    this.revealGate = gate;
    if (gate === null && this.pendingReveal) {
      this.finalizeReveal();
    }
  }

  /** BootDirector 收口后调用: 完成主窗显示(含竞态兜底: ready-to-show 尚未触发时直接 show) */
  revealMainWindow(): void {
    if (!this.mainWindow || this.mainWindow.isDestroyed()) return;
    if (this.pendingReveal) {
      this.finalizeReveal();
    } else if (!this.mainWindow.isVisible()) {
      // 竞态兜底(设计稿 F7): 收口早于 ready-to-show → 直接 show
      //   不吞错: show 若窗口已销毁会抛, 此处 isDestroyed 已过滤
      this.mainWindow.center();
      this.mainWindow.show();
    }
  }

  private finalizeReveal(): void {
    this.pendingReveal = false;
    this.mainWindow?.show();
  }
  private static instance: WindowManager;
  private mainWindow: BrowserWindow | null = null;
  private log = LogManager.getInstance();
  private initialized = false;
  private configStore: ConfigStore;
  private edgeHideEnabled = false;
  private alwaysOnTop = false;
  private hideTimer: NodeJS.Timeout | null = null;

  private constructor() {
    this.configStore = ConfigStore.getInstance();
  }

  public static getInstance(): WindowManager {
    if (!WindowManager.instance) {
      WindowManager.instance = new WindowManager();
    }
    return WindowManager.instance;
  }

  public async createMainWindow(): Promise<BrowserWindow> {
    // isDev 三重判断:
    // 1) !app.isPackaged — 未打包(开发/Playwright)
    // 2) 未设 PIPICLAW_E2E=1  — 不是 e2e 测试模式
    // 3) 存在 dev server 端口 — dev 时 vite 起来了
    // e2e 测试时强制走 prod 路径(用 dist/index.html),避免 vite 没起导致 ERR_CONNECTION_REFUSED
    const isDev =
      !app.isPackaged &&
      process.env.PIPICLAW_E2E !== '1' &&
      !process.env.CI;
    
    const primaryDisplay = screen.getPrimaryDisplay();
    const { width: screenWidth, height: screenHeight } = primaryDisplay.workAreaSize;

    const defaultWidth = Math.min(1280, screenWidth * 0.8);
    const defaultHeight = Math.min(800, screenHeight * 0.8);

    this.log.info('创建主窗口', { isDev, defaultWidth, defaultHeight });

    this.mainWindow = new BrowserWindow({
      width: defaultWidth,
      height: defaultHeight,
      minWidth: 1280,
      minHeight: 720,
      show: false,
      frame: false,
      titleBarStyle: 'hidden',
      titleBarOverlay: false,
      backgroundColor: '#fefcf3',
      webPreferences: {
        preload: join(__dirname, 'preload.js'),
        nodeIntegration: false,
        contextIsolation: true,
        sandbox: false,
        webSecurity: true
      },
      icon: join(__dirname, '../resources/icon.ico')
    });

    this.mainWindow.once('ready-to-show', () => {
      this.log.info('窗口准备就绪，显示窗口');
      this.initialized = true;
      // NOVA #003-C · M2(第②笔): 显示由 BootDirector 收口调度(命令 §2 "主窗显示改由 BootDirector 收口调度")
      //   门控返回 false → 挂起待收口(BootOrchestrator.reveal 时调 show);
      //   无门控(e2e 旁路/单测/降级直开) → 立即 show, 与既有行为逐字一致。
      if (this.revealGate) {
        // 【M3-F】this.mainWindow 是 `BrowserWindow | null`;在回调闭包里
        // TS 无法做属性窄化(可能被别处改掉)→ 先取局部 const 再判空。
        const win = this.mainWindow;
        if (!win) return;
        const allow = this.revealGate(win);
        if (allow) {
          this.mainWindow?.show();
        } else {
          this.pendingReveal = true;
        }
      } else {
        this.mainWindow?.show();
      }
    });

    this.mainWindow.on('maximize', () => {
      this.sendMaximizeChange(true);
    });

    this.mainWindow.on('unmaximize', () => {
      this.sendMaximizeChange(false);
    });

    // 注: focus/blur handlers 已被移除。
    // frameless Electron 窗口在 dev 模式 (Vite HMR + Playwright 延迟加载 +
    // Tray 创建) 下会反复触发 focus/blur,无功能影响但污染日志。
    // 调试窗口焦点状态请用 Chromium DevTools -> PerformanceObserver。
    // 见 tests/unit/WindowManager.test.ts 测试覆盖 registerFocusHandlers 行为。

    this.mainWindow.on('closed', () => {
      this.log.info('主窗口已关闭');
      this.mainWindow = null;
      this.initialized = false;
    });

    if (isDev) {
      await this.mainWindow.loadURL('http://localhost:5173');
      this.log.info('加载开发服务器: http://localhost:5173');
    } else {
      await this.mainWindow.loadFile(join(__dirname, '../dist/index.html'));
      this.log.info('加载生产构建页面');
    }

    return this.mainWindow;
  }

  private sendMaximizeChange(isMaximized: boolean): void {
    if (this.mainWindow && !this.mainWindow.isDestroyed()) {
      this.mainWindow.webContents.send('window:onMaximizeChange', isMaximized);
    }
  }

  public minimize(): void {
    if (this.mainWindow && !this.mainWindow.isDestroyed()) {
      this.mainWindow.minimize();
    }
  }

  public toggleMaximize(): void {
    if (this.mainWindow && !this.mainWindow.isDestroyed()) {
      if (this.mainWindow.isMaximized()) {
        this.mainWindow.unmaximize();
      } else {
        this.mainWindow.maximize();
      }
    }
  }

  public close(): void {
    if (this.mainWindow && !this.mainWindow.isDestroyed()) {
      this.mainWindow.close();
    }
  }

  public isMaximized(): boolean {
    return this.mainWindow?.isMaximized() ?? false;
  }

  public isInitialized(): boolean {
    return this.initialized;
  }

  public getMainWindow(): BrowserWindow | null {
    return this.mainWindow;
  }

  public setAlwaysOnTop(value: boolean): void {
    if (this.mainWindow && !this.mainWindow.isDestroyed()) {
      this.mainWindow.setAlwaysOnTop(value);
      this.alwaysOnTop = value;
      this.configStore.set('window.alwaysOnTop', value);
      this.log.info('[WindowManager] 设置窗口置顶:', value);
    }
  }

  public isAlwaysOnTop(): boolean {
    return this.alwaysOnTop;
  }

  public toggleAlwaysOnTop(): void {
    this.setAlwaysOnTop(!this.alwaysOnTop);
  }

  public setEdgeHideEnabled(value: boolean): void {
    this.edgeHideEnabled = value;
    this.configStore.set('window.edgeHideEnabled', value);
    this.log.info('[WindowManager] 设置贴边隐藏:', value);
  }

  public isEdgeHideEnabled(): boolean {
    return this.edgeHideEnabled;
  }

  public setupEdgeHide(): void {
    if (!this.mainWindow || this.mainWindow.isDestroyed()) return;

    const EDGE_THRESHOLD = 10;

    this.mainWindow.on('move', () => {
      if (!this.edgeHideEnabled) return;
      
      if (this.hideTimer) {
        clearTimeout(this.hideTimer);
      }

      this.hideTimer = setTimeout(() => {
        if (!this.mainWindow || this.mainWindow.isDestroyed()) return;

        const bounds = this.mainWindow.getBounds();
        const display = screen.getDisplayNearestPoint({ x: bounds.x, y: bounds.y });
        const workArea = display.workArea;

        let shouldHide = false;
        let targetX = bounds.x;
        let targetY = bounds.y;

        if (bounds.x <= workArea.x + EDGE_THRESHOLD) {
          shouldHide = true;
          targetX = workArea.x - bounds.width + 5;
        } else if (bounds.x + bounds.width >= workArea.x + workArea.width - EDGE_THRESHOLD) {
          shouldHide = true;
          targetX = workArea.x + workArea.width - 5;
        }

        if (bounds.y <= workArea.y + EDGE_THRESHOLD) {
          shouldHide = true;
          targetY = workArea.y - bounds.height + 5;
        } else if (bounds.y + bounds.height >= workArea.y + workArea.height - EDGE_THRESHOLD) {
          shouldHide = true;
          targetY = workArea.y + workArea.height - 5;
        }

        if (shouldHide) {
          this.mainWindow.setPosition(targetX, targetY);
          this.mainWindow.hide();
          this.log.debug('[WindowManager] 窗口贴边隐藏');
        }
      }, 100);
    });
  }

  public destroy(): void {
    if (this.mainWindow && !this.mainWindow.isDestroyed()) {
      this.mainWindow.destroy();
    }
    this.mainWindow = null;
    this.initialized = false;
    WindowManager.instance = null as any;
  }
}
