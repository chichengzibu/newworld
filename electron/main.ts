/**
 * New World - Electron主进程入口（修复版）
 * 
 * 核心改进：
 * 1. 简化网关启动逻辑，移除对不存在文件的依赖
 * 2. 使用内置的OpenClawServer直接启动HTTP服务
 * 3. 更好的错误处理和日志记录
 */

import { app, BrowserWindow, Menu, shell, ipcMain, dialog, session } from 'electron';
import { WindowManager } from './core/WindowManager';
import { IpcServer } from './core/IpcServer';
import { LogManager } from './core/LogManager';
import { GlobalShortcut } from './core/GlobalShortcut';
import { TrayManager } from './core/TrayManager';
import { MiniWindow } from './core/MiniWindow';
import { ConfigStore } from './core/ConfigStore';
import { OpenClawGateway } from './openclaw/OpenClawGateway';
import { PermissionConfig } from './permissions/PermissionConfig';
import { AutoUpdater } from './core/AutoUpdater';
import { ErrorLedger } from './core/ErrorLedger';
import { McpManager } from './mcp/McpManager';
import type { McpServerConfig } from './mcp/types';
import { initChannels, shutdownChannels } from './channel/bootstrap';

// ============ W7.0.1 boot wiring: 串接 W3+ 子系统 ============
import { CapabilityRegistry } from './contracts/CapabilityRegistry';
import { HermesAdapter } from './hermes/HermesAdapter';
import { AgentBrainImpl, asAgentBrain } from './agent/AgentBrain';
import { ChatManager } from './chat/ChatManager';
import { IpcBridge } from './runtime/bridge/IpcBridge';
import { registerD1ScreenshotShortcut } from './core/GlobalShortcut';
import { ensureD1SkillRegistered } from './skill/builtin/D1ScreenshotQA';
import { registerD5RecordingToSkill } from './skill/builtin/D5RecordingToSkill';
// 静态 import 让 vite-plugin-electron SSR build 把 LlmAgentBrain inline 进 bundle,
// 避免运行时 require() 找不到 dist-electron/agent/LlmAgentBrain.js 的路径问题.
// 若 LlmClient 不可用,getInstance()/构造函数会抛错,因此包在 try 中。
import { LlmAgentBrain } from './agent/LlmAgentBrain';
import { initHost, isOhos } from './platform';
// NOVA #003-C · M2(第②笔): Boot 编排 + 子系统无信号实例的 .getInstance() 触发
import { BootOrchestrator } from './core/BootOrchestrator';
import { LlmConfigStore } from './llm/LlmConfigStore';
import { SkillLoader } from './skill/SkillLoader';

// ============ 真实用户监控 (Sentry / Electron 主进程) ============
// 主进程统一持有 Sentry client;渲染端经 preload 桥接转发事件到此上报。
// DSN 来自 SENTRY_DSN 环境变量;未配置则完全不初始化(dev/内网零上报,零开销)。
import * as Sentry from '@sentry/electron/main';
const SENTRY_DSN = process.env.SENTRY_DSN;
if (SENTRY_DSN) {
  Sentry.init({
    dsn: SENTRY_DSN,
    environment: app.isPackaged ? 'production' : 'development',
    tracesSampleRate: 0.1,
    sampleRate: 1.0,
  });

  // 渲染进程崩溃/消失:真实用户监控闭环——主进程侧捕获并上报
  // 【M3-F 删】原先这里还有一个 per-webContents 的 'crashed' 监听,
  // 与紧随其后的 app 级 'render-process-gone' **完全重复**(同一件事上报两次)。
  // 而且 'crashed' 在当前 Electron 版本里已不在 webContents.on 的类型里
  // (只有 'render-process-gone',其 reason 枚举里含 'crashed')→ 类型错误。
  // 保留 app 级那一个即可。
  app.on('render-process-gone', (_e, _wc, details) => {
    try {
      Sentry.captureException(new Error('render-process-gone'), {
        extra: { reason: details?.reason, exitCode: details?.exitCode },
      });
    } catch { /* swallow */ }
  });
}

const log = LogManager.getInstance();
/** boot 日志流出口: pushBootLog 仅在 splash 存活时投递, 旁路/e2e 自动 no-op */
const boot = BootOrchestrator.getInstance();

// 鸿蒙 PC:禁用 GPU 硬件加速(仅 ohos),避免 ArkWeb GPU 进程反复重启。
// 必须在 app ready 之前调用。标准 Electron 平台不受影响。
if (isOhos()) {
  try {
    app.disableHardwareAcceleration();
    log.info('[main] ohos: disableHardwareAcceleration 已启用');
  } catch (e) {
    log.warn('[main] ohos: disableHardwareAcceleration 调用失败(非致命)', e);
  }
}

let windowManager: WindowManager;
let ipcServer: IpcServer;
let gateway: OpenClawGateway;
let globalShortcut: GlobalShortcut;
let trayManager: TrayManager;
const isDev = !app.isPackaged;

// 注册打开 DevTools 的 IPC 处理器
ipcMain.on('open-devtools', () => {
  const windowManager = WindowManager.getInstance();
  const win = windowManager.getMainWindow();
  if (win) {
    log.info('用户请求打开 DevTools');
    win.webContents.openDevTools();
  }
});

app.whenReady().then(async () => {
  // W12: localhost 直连旁路。开发机常开着 Clash/V2RayN 等代理(如 127.0.0.1:7890),
  // Electron 默认继承系统代理,会把 loadURL('http://localhost:5173') 转给代理导致
  // ERR_CONNECTION_RESET。让 localhost/127.0.0.1 直连,外部请求仍走系统代理(不影响生产调 LLM)。
  try {
    await session.defaultSession.setProxy({ proxyBypassRules: 'localhost;127.0.0.1' });
  } catch (e) {
    log.warn('[main] 设置代理旁路失败(非致命)', e);
  }

  log.info('========== New World 应用启动 ==========', { version: app.getVersion(), isDev });

  try {
    // 0. 初始化平台宿主抽象层(Phase 2 解耦:core 经 getHost() 取平台能力)
    initHost();

    // 1. 设置应用菜单
    setupAppMenu();

    // 2. 初始化IPC服务器
    ipcServer = IpcServer.getInstance();
    ipcServer.registerHandlers();

    // P1-T1.3 hotfix: 早期注册 autoUpdater IPC handler
    // 之前是放在 initialize() 里,只在 ready-to-show 之后跑,
    // 导致 Settings.vue 在 /settings 路由 mount 时 autoUpdater:getVersion
    // 还没注册。Settings.vue 调用 -> No handler registered -> console error
    new AutoUpdater().registerIpcHandlers()

    // 【P0 工程规范】本地错误台账: 渲染端错误经 preload 桥上报, 按 kind 分类落盘
    //   (见 docs/adr/README.md — 可观测性台账, 纯本地零云端)
    const errorLedger = new ErrorLedger();
    errorLedger.registerIpcHandlers();

    // 【P0 工程规范】主进程兜底: 未捕获异常/未处理 rejection 不再静默 ——
    //   进 electron-log + 错误台账(main-uncaught / main-rejection 分类)。
    //   注意: 只记录不退出 —— Electron 主进程崩溃等于白屏, 记录后保持存活让用户至少能保存数据。
    process.on('uncaughtException', (err) => {
      console.error('[main] uncaughtException:', err);
      try {
        errorLedger.append({ kind: 'main-uncaught', message: err?.message ?? String(err), source: 'main', stack: err?.stack });
      } catch { /* swallow */ }
    });
    process.on('unhandledRejection', (reason) => {
      console.error('[main] unhandledRejection:', reason);
      try {
        errorLedger.append({ kind: 'main-rejection', message: reason instanceof Error ? reason.message : String(reason), source: 'main', stack: reason instanceof Error ? reason.stack : undefined });
      } catch { /* swallow */ }
    });

    // 3. 主窗显示门(设计稿 §5 / F5): 在 createMainWindow 之前挂接, 让 ready-to-show 受 BootDirector 调度
    //   旁路(NW_SKIP_SPLASH / NW_E2E)= true → ready-to-show 立即 show, 等价既有行为
    //   正常路径 = false → 挂起, 待 BootOrchestrator.reveal() → WindowManager.revealMainWindow() 显示
    const bypass =
      process.env.NW_SKIP_SPLASH === '1' ||
      process.env.NW_E2E === '1';
    windowManager = WindowManager.getInstance();
    windowManager.setRevealGate(() => bypass);

    // 3.bis NOVA #003-C · M2(第②笔): 创建主窗(受门控) + Boot 编排 — 收口调度主窗显示 + splash 生命周期
    //   交叉引用: core/BootOrchestrator.ts(编排) + core/BootDirector.ts(状态机, 11 例单测)
    //   + core/SplashWindow.ts(splash) + WindowManager.setRevealGate/revealMainWindow(门控+收口)
    //   旁路: NW_SKIP_SPLASH=1 / NW_E2E=1 → 立即放行, splash 不启动(e2e 路径)
    await windowManager.createMainWindow();
    if (bypass) {
      // e2e 旁路: ready-to-show 已被 gate=true 直接 show; 显式补一次 revealMainWindow 兜底
      //   (若 ready-to-show 早于 gate 到位则 pendingReveal 挂起, revealMainWindow 补齐)
      windowManager.revealMainWindow();
    }
    try {
      boot.setLog({
          info: (m, e) => log.info(m, e),
          warn: (m, e) => log.warn(m, e),
          error: (m, e) => log.error(m, e),
        })
        .start(
          {
            // 三"无信号"子系统的同步 .getInstance() 触发(设计稿 F3: 禁造 onReady/warmup)
            'llm-config': () => LlmConfigStore.getInstance(),
            memory: () => HermesAdapter.getInstance(),
            skills: () => SkillLoader.getInstance(),
          },
          () => windowManager.revealMainWindow(),
        );
      // 真实启动日志流起点: 此刻 splash 已就绪, 后续每个真实初始化节点都会推一行
      boot.pushBootLog('INFO', '启动编排就绪，splash 已建立', 'boot');
    } catch (err) {
      // Boot 编排失败不致命: 降级直开主窗(设计稿 F7)
      log.warn('[main] NOVA boot 编排启动异常, 降级直开主窗', err);
      windowManager.setRevealGate(null); // 拆门 → ready-to-show 直接 show
      windowManager.revealMainWindow();
    }

    // 4. 初始化全局快捷键
    globalShortcut = GlobalShortcut.getInstance();
    globalShortcut.registerAll();
    boot.pushBootLog('INFO', '全局快捷键已注册', 'platform');

    // 5. 初始化托盘
    trayManager = TrayManager.getInstance();
    trayManager.create();
    boot.pushBootLog('INFO', '系统托盘已创建', 'platform');

    // 6. 权限初始化 (M1 P0-1 重构: 不调用 forceResetToPermissive)
    // - loadConfig 已处理: 首次启动 → initDefaultPermissionSets (默认 safe / least privilege)
    // - 已有 activeSetId → 尊重用户选择,不做任何事
    // - 显式重置路径: 1) IPC `permissions:reset` force:true 2) NW_DEV=1 3) NW_RESET_PERMISSIONS=1
    // 见 PermissionConfig.forceResetToPermissive (保留函数作 migration 工具, 不再每次启动调用)
    const permissionConfig = PermissionConfig.getInstance();
    void permissionConfig; // 保留 import, forceResetToPermissive 通过 IPC 调用
    boot.pushBootLog('INFO', '权限配置已加载', 'config');
    
    // 7. 加载配置
    const configStore = ConfigStore.getInstance();
    const alwaysOnTop = configStore.get('window.alwaysOnTop') || false;
    if (alwaysOnTop) {
      windowManager.setAlwaysOnTop(true);
    }
    
    const edgeHideEnabled = configStore.get('window.edgeHideEnabled') || false;
    if (edgeHideEnabled) {
      windowManager.setEdgeHideEnabled(true);
      windowManager.setupEdgeHide();
    }
    boot.pushBootLog('INFO', '窗口偏好配置已加载', 'config');

    // 8. 初始化网关
    gateway = OpenClawGateway.getInstance();

    // 9. 启动网关服务
    log.info('正在自动启动OpenClaw网关服务...');
    boot.pushBootLog('INFO', '正在启动 OpenClaw 网关服务…', 'gateway');
    const gatewayResult = await gateway.start();

    if (gatewayResult.success) {
      log.info('========== OpenClaw网关启动成功 ==========');
      boot.pushBootLog('INFO', 'OpenClaw 网关服务已就绪', 'gateway');
    } else {
      log.error('OpenClaw网关启动失败', { error: gatewayResult.error });
      boot.pushBootLog('ERROR', `OpenClaw 网关启动失败: ${String(gatewayResult.error)}`, 'gateway');
    }

    // 10. 开发模式下打开DevTools
    // 【M4-M 修】e2e 不开 —— DevTools 会 docked 住,实测把页面视口从 1280 挤到 725
    // (面板占 555px)→ e2e 一直在一个**被裁窄**的界面里跑:
    // 页面头部右侧的按钮落在视口外(看不见、点不到、位置断言全失真)。
    // e2e 自己有 console 捕获,不需要 DevTools。
    if (isDev && process.env.NW_E2E !== '1') {
      windowManager.getMainWindow()?.webContents.openDevTools();
    }

    // 11. 自动更新检查 — 在窗口 ready-to-show 之后启动
    const mainWindow = windowManager.getMainWindow();
    if (mainWindow) {
      mainWindow.once('ready-to-show', () => {
        try {
          new AutoUpdater().initialize(mainWindow);
          log.info('[main] AutoUpdater 初始化完成');
        } catch (e) {
          log.error('[main] AutoUpdater 初始化失败(非致命)', e);
        }
      });
    }

    // ============ W7.0.1 W3+ 子系统 wire ============
    try {
      // 1. IpcBridge: 注册 'runtime:ipc-bridge' channel
      IpcBridge.getInstance().registerHandler();
      boot.pushBootLog('INFO', 'IPC 运行时桥接已注册', 'ipc');

      // 2. HermesAdapter warmup(记忆检索桥接)
      HermesAdapter.getInstance();
      boot.pushBootLog('INFO', '记忆检索桥接已初始化', 'memory');

      // 3. CapabilityRegistry: 标记初始化完成(W3.2 骨架)
      CapabilityRegistry.getInstance().markInitialized();
      boot.pushBootLog('INFO', '能力注册表已就绪', 'skills');

      // 4. AgentBrain → ChatManager 接入
      ChatManager.getInstance().registerAgent(asAgentBrain(AgentBrainImpl.getInstance()));
      boot.pushBootLog('INFO', '会话管理已接入 Agent', 'chats');

      // 4.bis W14: 优先用 LlmAgentBrain (基于 LlmClient)。当 LLM provider 未配置时,
      //         LlmAgentBrain.think() 会 fallback 到 stub reply,不影响既有 ChatManager 流。
      // 修复: 从 require('./agent/LlmAgentBrain') 改为静态 import,
      //       这样 vite-plugin-electron 在 SSR build 时会 inline LlmAgentBrain,
      //       避免运行时 dist-electron/agent/LlmAgentBrain.js 找不到的 require 失败。
      //       LlmAgentBrain 实现 contracts/types 的 AgentBrain interface,
      //       而非 AgentBrainImpl 类,通过 as unknown as cast 兼容 asAgentBrain 类型签名。
      try {
        ChatManager.getInstance().registerAgent(asAgentBrain(LlmAgentBrain.getInstance() as unknown as AgentBrainImpl))
        log.info('[main] LlmAgentBrain registered')
        boot.pushBootLog('INFO', 'LLM Agent 已注册', 'llm-config');
      } catch (e) {
        log.warn('[main] LlmAgentBrain 注册失败,继续使用 AgentBrainImpl', e)
        boot.pushBootLog('WARN', 'LLM Agent 注册失败，回退默认 Agent', 'llm-config');
      }

      // 5. D1 截屏问答 skill 注册 + 全局快捷键
      registerD1ScreenshotShortcut();
      ensureD1SkillRegistered();

      // 6. D5 录屏转技能 skill 注册
      registerD5RecordingToSkill();
      boot.pushBootLog('INFO', '内置技能已注册', 'skills');

      // 6.bis W8: 注册已启用的 IM 通道到 ChannelRouter(使 channel:send 可用)
      try {
        initChannels();
      } catch (e) {
        log.warn('[main] initChannels 失败(非致命)', e);
        boot.pushBootLog('WARN', 'IM 通道初始化失败(非致命)', 'channels');
      }
      boot.pushBootLog('INFO', 'IM 通道已注册', 'channels');

      log.info('[main] W3+ 子系统 wire 完成');
    } catch (e) {
      log.error('[main] W7.0.1 W3+ wire 失败(非致命)', e);
    }

    log.info('========== New World应用启动完成 ==========');

    // ============ M1: MCP 运行时启动 (auto-start enabled servers) ============
    // 不阻塞启动: 启动失败只 log, 不影响 app
    try {
      const mgr = McpManager.getInstance();
      const servers = (configStore.get('mcp.servers') ?? []) as McpServerConfig[];
      boot.pushBootLog('INFO', `正在拉起 ${servers.filter((s) => s.enabled).length} 个 MCP server…`, 'mcp');
      for (const cfg of servers) {
        if (!cfg.enabled) continue;
        // 不 await, 让它们在后台启动; UI 可以通过 mcp:list-servers 看状态
        mgr.startServer(cfg).then(
          async (status) => {
            log.info('[main] MCP server started', { name: cfg.name, state: status.state, tools: status.toolCount });
            boot.pushBootLog('INFO', `MCP server ready: ${cfg.name}`, 'mcp');
            // 【M3-A】server 就绪后把它的工具同步进 agent 工具表 ——
            // 否则 MCP 能力只在 IPC 层,LLM 永远看不到(装了 server 也白装)。
            if (status.state === 'ready') {
              try {
                const res = await LlmAgentBrain.getInstance().syncMcpTools();
                if (res.added.length > 0) {
                  log.info('[main] MCP 工具已接入 agent', { added: res.added.length, total: res.added.length + res.skipped.length });
                }
              } catch (e) {
                log.warn('[main] MCP 工具同步失败(非致命)', e);
              }
            }
          },
          (err) => {
            log.warn('[main] MCP server start failed', { name: cfg.name, err: err?.message ?? String(err) });
            boot.pushBootLog('WARN', `MCP server 启动失败: ${cfg.name}`, 'mcp');
          }
        );
      }
    } catch (e) {
      log.warn('[main] MCP auto-start 失败(非致命)', e);
      boot.pushBootLog('WARN', 'MCP 自动启动失败(非致命)', 'mcp');
    }

    boot.pushBootLog('INFO', '启动完成', 'boot');
  } catch (error) {
    log.error('应用启动失败', error);
    boot.pushBootLog('ERROR', `应用启动失败: ${String(error)}`, 'boot');
    app.quit();
  }
});

app.on('window-all-closed', () => {
  log.info('所有窗口已关闭');
  if (process.platform !== 'darwin') {
    app.quit();
  }
});

app.on('activate', () => {
  if (BrowserWindow.getAllWindows().length === 0) {
    windowManager = WindowManager.getInstance();
    windowManager.createMainWindow();
  }
});

app.on('before-quit', async () => {
  log.info('应用即将退出');
  
  trayManager?.setQuitting(true);

  // IM 真连通:停止 Telegram 入站长轮询与入站桥接,避免退出后残留后台请求
  try {
    await shutdownChannels();
  } catch (e) {
    log.warn('[main] shutdownChannels 失败(非致命)', e);
  }

  if (gateway) {
    try {
      log.info('正在停止OpenClaw网关...');
      await gateway.stop();
      log.info('网关已停止');
    } catch (error) {
      log.error('停止网关时出错', error);
    }
  }

  // M1: 停止所有 MCP server 子进程
  try {
    log.info('正在停止所有 MCP server...');
    await McpManager.getInstance().stopAll();
    log.info('MCP servers 已停止');
  } catch (error) {
    log.error('停止 MCP servers 出错', error);
  }

  globalShortcut?.destroy();
  trayManager?.destroy();
  MiniWindow.getInstance().destroy();
  
  if (ipcServer) {
    ipcServer.destroy();
  }

  if (windowManager) {
    windowManager.destroy();
  }
});

process.on('uncaughtException', (error) => {
  log.error('未捕获的异常', error);
  if (!isDev) {
    // 用顶部静态 import 的 dialog,不要在这里 require('electron'):
    // 主进程产物若切到 ESM(Electron 28+ 已支持,鸿蒙 34.x runtime 同样),
    // 裸 require 会直接 ReferenceError,导致崩溃兜底弹窗自己先崩。
    dialog.showErrorBox('应用错误', `发生未知错误: ${error.message}`);
  }
});

process.on('unhandledRejection', (reason) => {
  log.error('未处理的Promise拒绝', reason);
});

function setupAppMenu(): void {
  const emptyMenu = Menu.buildFromTemplate([]);
  Menu.setApplicationMenu(emptyMenu);
  if (process.platform !== 'darwin') {
    Menu.setApplicationMenu(null);
  }
  log.debug('应用菜单已配置为隐藏');
}

app.on('web-contents-created', (_, contents) => {
  contents.setWindowOpenHandler(({ url }) => {
    shell.openExternal(url);
    return { action: 'deny' };
  });
});
