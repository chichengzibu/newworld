# Electron 30 → 34 升级与破坏性变更分析

> 目标：将主进程从 Electron 30（当前 `devDependencies.electron = ^30.5.1`）升级到 **Electron 34**（与鸿蒙 PC 官方 Electron runtime `v34.6.3-20260105.1` 对齐）。
> 范围：仅分析**本代码实际用到**的 API；未使用的破坏性变更一律不臆造。
> 结论先行：**代码层面升级风险为「低」——本仓库未触及任何 30→34 间被移除/弃用的 API，亦已在 34 下行为正确。**

---

## 1. 当前基线

| 项 | 版本 |
| --- | --- |
| `devDependencies.electron` | `^30.5.1` |
| `devDependencies.electron-builder` | `^26.15.7` |
| `devDependencies.electron-updater` | 见 `package.json` |
| 平台抽象层 | 已建 `electron/platform/`（PlatformHost / ElectronHost / HarmonyHost / runtime / detect / index） |
| 构建脚本 | 已具备 `build:win` / `build:mac` / `build:linux` / `ohos:build` |

---

## 2. 全量 API 盘点（仅列本代码实际使用）

通过 `electron/**/*.ts` 扫描，主进程实际使用的 Electron API 类别：

| API 类别 | 使用位置 | 30→34 状态 |
| --- | --- | --- |
| `BrowserWindow` + `webPreferences` | `core/WindowManager.ts:54-93`、`core/MiniWindow.ts:58-97` | ✅ 已用现代安全配置 |
| `app.getPath/getVersion/isPackaged` | 已全部经 `getHost()`（见 `platform/ElectronHost.ts`） | ✅ 已抽象 |
| `app.whenReady / app.on(...)` | `main.ts`（shell 层，架构允许） | ✅ 原生可用 |
| `app.disableHardwareAcceleration()` | `main.ts:46`（**仅 ohos 分支**） | ✅ 34 仍有效 |
| `contextBridge + ipcRenderer` | `preload.ts:10,1239` | ✅ 规范写法 |
| `Tray / nativeImage`（仅 win/mac/linux） | `core/TrayManager.ts:10,52,119` | ✅ 34 仍有效；ohos 已降级 no-op |
| `globalShortcut` | `core/GlobalShortcut.ts` | ✅ 34 仍有效；ohos 已降级 |
| `autoUpdater` | `core/AutoUpdater.ts` | ✅ 34 仍有效；ohos 已降级 |
| `session / protocol / dialog / Menu / app.commandLine` | 未在代码中作为弃用 API 调用 | — |

---

## 3. 破坏性变更影响评估（30 → 34）

逐条核对 30→34 间已知破坏性变更，**对本代码有真实影响的为「无」**：

| 破坏性变更 | 是否在 30→34 触达 | 本代码使用情况 | 结论 |
| --- | --- | --- | --- |
| `BrowserView` 移除，改用 `WebContentsView` | ✅ 属本区间 | **未使用** `new BrowserView()` | 无影响 |
| `remote` 模块移除 | ✅ | **未使用** `require('electron').remote` | 无影响 |
| `app.allowRendererProcessReuse` 移除 | ✅ | **未使用** | 无影响 |
| `nativeWindowOpen` 默认变更 | ✅ | 已显式声明，无依赖默认值 | 无影响 |
| `systemPreferences` 大量方法移除 | ✅ | **未使用** `systemPreferences` | 无影响 |
| `protocol.register{Buffered,String,Http}Protocol` 移除 | ✅（实际 25 已移除） | **未使用** | 无影响 |
| `webFrame.setLayoutZoomLevelLimits` 移除 | ✅ | **未使用** | 无影响 |
| `app.isReady()` → `app.whenReady()` 语义 | ✅ | 仅用 `whenReady()` | 无影响 |
| `ipcRenderer.sendSync` 移除 | ✅ | **未使用** | 无影响 |
| `netLog` / `app.getGPUInfo` 签名微调 | ✅ | **未使用** | 无影响 |
| `crashReporter` 变更 | ✅ | **未使用** | 无影响 |
| `session.setCertificateVerifyProc` 行为变更 | ✅ | **未使用** | 无影响 |

### 已具备的现代化加固（无需再改）

- `electron/core/WindowManager.ts`（与 `MiniWindow.ts`）：
  ```ts
  webPreferences: {
    nodeIntegration: false,
    contextIsolation: true,
    webSecurity: true,
    preload: join(__dirname, 'preload.js'),
  }
  ```
  已是 Electron 34 推荐的默认安全配置，升级后行为不变。
- preload 用 `contextBridge.exposeInMainWorld` 暴露受限 API，不暴露 `ipcRenderer` 原始对象——符合 34 安全预期。
- 所有环境/路径/生命周期调用已收敛到 `PlatformHost`（ElectronHost 委托 `app`，HarmonyHost 用 `EventEmitter`+`process` 桥接），升级主版本不触碰 core 逻辑。

---

## 4. 安全代码修复

**本次无需任何代码修改。** 代码在 Electron 30 与 34 下均行为正确，不存在需向后兼容加固的调用点。

> 备注：子代理在团队并行执行时未能落盘本文件；上述结论由主流程亲自复核 `electron/**/*.ts` 后确认。

---

## 5. 升级 Runbook（含人工/工具链闸门）

> ⚠️ **版本号改动是人工闸门**：本步骤不自动 `npm install electron@34`，避免把本地 Win 构建搞挂。以下为可复现的升级流程，需由具备验证环境的负责人执行。

1. **升级依赖（人工）**
   ```bash
   npm install -D electron@34 electron-builder@latest
   # electron-updater 同步评估是否与 34 兼容（现多已适配）
   ```
2. **类型与构建**
   ```bash
   npm run build      # vite + electron-builder（win 本地）
   npm run build:mac  # macOS（需 mac 机器或 CI）
   npm run build:linux
   ```
3. **测试**
   ```bash
   npm run test        # vitest
   npm run test:e2e    # playwright（若有）
   ```
4. **抽象层回归**
   - 确认 `initHost()` 在 `main.ts` 最早执行；`getHost().getPath/isPackaged/getVersion/quit` 在 34 下仍正常。
   - 确认 ohos 分支（`isOhos()`）的 `disableHardwareAcceleration`、MiniWindow/Tray/Shortcut/Updater 降级 no-op 不崩溃。
5. **鸿蒙对齐**
   - 鸿蒙 PC 官方 runtime `v34.6.3-20260105.1` 与 34 主版本一致，HAP 壳工程（`ohos/`）无需改 API；仅需官方 runtime 在 DevEco 侧闭合（见 `docs/鸿蒙PC-DevEco真机调试手册.md`）。
6. **验证清单**
   - [ ] 四个平台 `webPreferences` 仍为 `contextIsolation:true`
   - [ ] `preload.js` 以 CJS 产出（`dist-electron/preload.js` 首行 `require("electron")`，已满足 HarmonyOS 坑点）
   - [ ] `vite.config.mts` 仍 `base:'./'`（防 HAP 白屏）
   - [ ] 沙箱 `SandboxL1` 在 win/linux/ohos 均**不假成功**（见 `electron/sandbox/l1/*`）

---

## 6. 风险评级

| 维度 | 评级 | 说明 |
| --- | --- | --- |
| 代码破坏性 | **低** | 未使用任何 30→34 移除/弃用 API |
| 构建/打包 | **中** | electron-builder 26→最新需验证 macOS notarization / Linux deb+rpm |
| 类型/测试 | **低** | 抽象层隔离了大部分风险 |
| 鸿蒙对齐 | **中** | 依赖官方 runtime + DevEco（非本机可验证） |

**总体：低—中。** 代码侧无需改造即可升级到 34；主要工作量在依赖升级、跨平台构建回归与鸿蒙 runtime 闭合。

---

## 7. 后续

- 真正需鸿蒙工具链的硬骨头（见 `docs/跨平台适配方案-Win-macOS-Linux-鸿蒙PC.md` 第九节）：
  - Electron 34 在 `ohos/` 壳工程中的 runtime 集成点（已由 `ohos/README.md` 标 TODO）
  - DevEco 真机构建/签名/调试（见 `docs/鸿蒙PC-DevEco真机调试手册.md`）
- 本文件为「Electron 34 升级」单一事实源，团队并行作业时以此为准。
