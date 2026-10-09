# PiPiClaw 四平台适配方案

> 目标平台：Windows / macOS / Linux / 鸿蒙 PC（HarmonyOS PC）
> 结论基于对 `electron/`（197 文件）、`package.json`、`vite.config.mts`、`electron-builder.json5` 的实测核查，非文档推断。
> 编写日期：2026-08-07

---

## 一、结论速览

| 平台 | 可行性 | 预估工作量 | 主要障碍 |
|------|--------|-----------|---------|
| Windows | ✅ 已支持 | — | 已是主力平台 |
| macOS | ✅ 几乎免费 | 1–3 人日 | 仅需构建脚本 + 真机验证 |
| Linux | ✅ 几乎免费 | 1–3 人日 | 同上 |
| 鸿蒙 PC | ✅ 可行（非重写） | 2–4 人周 | Electron 版本升级 + 壳工程 + 能力降级 |

**总判断：四平台全兼容可以做到，且比预想容易得多。**

---

## 二、三个决定性的实测发现

这三点是本项目跨平台成本远低于同类 Electron 应用的根本原因。

### 发现 1：零原生模块（最关键）

`package.json` 全部 11 个运行时依赖均为纯 JS/TS：

```
@element-plus/icons-vue, @webcontainer/api, docx, electron-log,
electron-updater, element-plus, highlight.js, marked, pinia,
vue, vue-i18n, vue-router
```

**没有 better-sqlite3、node-pty、sharp、keytar、robotjs 等任何 `.node` 二进制。**

这一条直接消除了跨平台迁移中 80% 的典型痛点——所有社区鸿蒙迁移案例（LX Music、Pomotroid）耗时最长的环节都是原生模块重编译或写兼容层，本项目完全不需要。

### 发现 2：平台耦合被很好地隔离

- 全项目仅 **11/197** 个文件含平台分支（`process.platform` 等）
- 引用 `electron` 的 49 个文件中，导入符号统计：

  | 符号 | 次数 | 性质 |
  |------|------|------|
  | `app` | 41 | 其中 `getPath` 44 次、`getVersion` 14 次、`isPackaged` 6 次 —— **纯只读环境信息** |
  | `BrowserWindow` | 11 | 窗口层 |
  | `safeStorage` / `ipcMain` | 各 4 | 需适配 |
  | 其余（shell/screen/Menu/dialog/clipboard/Tray/Notification/globalShortcut…） | 各 1–2 | 桌面特性，可降级 |

  即 `app` 的 77 次调用中，**64 次只是在问"数据目录在哪 / 版本号多少 / 是不是打包态"**——抽象成本极低。

### 发现 3：命令执行天然可移植

`BashTool.ts`、`OpenClawGateway.ts` 均使用 `execFile` + 数组传参、**强制不走 shell**：

```ts
// BashTool.ts:125
const { stdout, stderr } = await execFileAsync(baseCmd, safeArgs, { ... })
```

这原本是出于安全（防命令注入），意外收获是**天然跨平台**——不依赖 `cmd.exe` 或 `/bin/sh` 的语法差异。

已有的平台分支也处理得当，例如 `LogManager.ts:32` 的 `chcp 65001` 已用 `if (process.platform === 'win32')` 正确包裹。

---

## 三、macOS / Linux 改造清单

`electron-builder.json5` **已经配好了三平台目标**（win/nsis、mac/dmg x64+arm64、linux/AppImage），基础设施是现成的。

### 必做项

| # | 事项 | 文件 | 说明 |
|---|------|------|------|
| 1 | 补构建脚本 | `package.json` | 目前只有 `build:win`，需加 `build:mac` / `build:linux` |
| 2 | CI 构建矩阵 | `.github/workflows/` | macOS 产物必须在 macOS runner 上构建，无法交叉编译 |
| 3 | 沙箱 L1 真机验证 | `sandbox/l1/` | macOS 走 `seatbelt`、Linux 走 `bwrap`——代码已写，**从未在真机验证过** |
| 4 | Linux `bwrap` 缺失降级 | `l1/bwrap.ts` | 多数发行版不预装 bubblewrap，需引导安装或明确降级 |
| 5 | 托盘图标适配 | `TrayManager.ts` | macOS 需 Template Image（黑白），Linux 部分桌面环境无托盘 |
| 6 | 全局快捷键冲突 | `GlobalShortcut.ts` | macOS 需辅助功能授权；快捷键需按平台改 Cmd/Ctrl |
| 7 | 自动更新签名 | `electron-builder.json5` | 当前 `identity: null`、`hardenedRuntime: false`，正式分发需 Apple 公证 |

### 建议补充

- macOS 深色模式：`darkModeSupport` 已开，需 UI 实测
- Linux 增加 `deb` / `rpm` target，覆盖面更广

**结论：macOS 和 Linux 本质上"已经支持了"，缺的是构建流水线和真机测试，不是代码改造。**

---

## 四、鸿蒙 PC 改造清单

### 4.1 前提：官方已有适配版 Electron

华为与 Electron 社区合作提供了**鸿蒙 PC 版 Electron 运行时**，因此：

- ❌ 不需要用 ArkUI 重写 UI
- ✅ 保留 Electron + Vue 架构，通过 `ohos_hap` 壳工程构建为 HAP 包

架构差异：

| 特性 | 标准 Electron | 鸿蒙 PC Electron |
|------|--------------|-----------------|
| 渲染引擎 | Chromium | ArkWeb |
| 原生扩展 | Node Addon | NAPI |
| 包格式 | exe / dmg / AppImage | HAP |
| 进程模型 | Main + Renderer | 相同 |
| 分发 | 官网 / 商店 | 鸿蒙应用商店 |

### 4.2 逐项核对（对照社区踩坑清单）

| 社区已知坑 | 本项目现状 | 结论 |
|-----------|----------|------|
| 原生模块需重编译 | **零原生模块** | ✅ 完全规避 |
| preload 必须 CJS，ESM 会崩 | 产物 `preload.js` 首行 `require("electron")` | ✅ 已是 CJS |
| 静态资源根路径导致白屏 | `vite.config.mts` **未设 `base`**，默认 `/` | ⚠️ **必改** `base: './'` |
| 多窗口代理不存在 | 仅 2 个窗口（`WindowManager` 主窗 + `MiniWindow`） | ⚠️ MiniWindow 需降级为单窗口路由 |
| GPU 进程反复重启 | 未处理 | ⚠️ 需 `app.disableHardwareAcceleration()`（仅 ohos），且**不要**禁用软件光栅化回退 |
| `process.platform` 无 `ohos` 类型 | 现有分支只判 win32/darwin/linux | ⚠️ 需加 ohos 检测与类型扩展 |
| Electron 版本 | 本项目 **30.5.1**，鸿蒙适配版为 **34.x** | ⚠️ 需升级或改用其 fork |

### 4.3 需要降级的能力

| 能力 | 处理方式 |
|------|---------|
| `AutoUpdater` | 短路禁用，改走鸿蒙应用商店更新 |
| `TrayManager` | 探测不可用则跳过 |
| `GlobalShortcut` | try/catch 包裹，失败不阻断启动 |
| `MiniWindow` | 改为主窗口内路由切换 |
| 沙箱 L1 | 鸿蒙无 seatbelt/bwrap/JobObject，走 `stub` 并**明确返回失败**（不可假成功） |
| Docker 沙箱 | 鸿蒙不可用，仅保留进程级执行 |

---

## 五、架构改造建议：三层解耦

当前 `electron/` 把「UI 胶水 / 平台能力 / 纯业务逻辑」混在一起。要长期维护四平台，建议按下面三层切分。

```
core/          纯 TS 业务逻辑，零 Electron 依赖  ← 约占 60%，四平台 100% 复用
  agent/ hermes/ skill/ task/ llm/ models/ permissions/ channel/

platform/      平台能力接口 + 各平台实现        ← 新增薄适配层
  PlatformHost.ts        (接口)
  ElectronHost.ts        (win/mac/linux)
  HarmonyHost.ts         (ohos)

shell/         窗口 / 托盘 / 快捷键 / 更新       ← 平台专属，按需实现
```

### 关键接口设计

因为 `app` 的调用 83% 是只读环境信息，抽象层可以极薄：

```ts
// platform/PlatformHost.ts
export interface PlatformHost {
  // 覆盖现有 64/77 次 app.* 调用
  getPath(name: 'userData' | 'logs' | 'temp' | 'downloads'): string
  getVersion(): string
  isPackaged(): boolean

  // 平台能力（不支持时返回 null，调用方降级）
  tray(): TrayCapability | null
  shortcuts(): ShortcutCapability | null
  updater(): UpdaterCapability | null
  secureStorage(): SecureStorageCapability | null

  // 平台标识
  platform(): 'win32' | 'darwin' | 'linux' | 'ohos'
}
```

**改造方式**：把 `import { app } from 'electron'` 批量替换为 `host.getPath(...)`。这是机械替换，风险低、可增量进行——每次改几个文件都能独立验证，不需要大爆炸式重构。

改造后 `core/` 可以脱离 Electron 单独跑单元测试，测试速度也会显著提升。

---

## 六、分阶段路线图

### 阶段 1：macOS + Linux 上线（1–2 周）

无需架构改造，直接做：
1. 补 `build:mac` / `build:linux` 脚本
2. 建 GitHub Actions 三平台构建矩阵
3. 真机验证 seatbelt / bwrap
4. 修托盘、快捷键的平台差异

**产出：三平台正式安装包。**

### 阶段 2：核心层解耦（2–3 周）

1. 定义 `PlatformHost` 接口
2. 实现 `ElectronHost`
3. 分批替换 41 处 `app` 引用（按模块推进，每批可独立测试）
4. 让 `core/` 单测脱离 Electron 运行

**产出：零 Electron 依赖的业务核心层。这一步即使不做鸿蒙也值得——它会让测试更快、边界更清晰。**

### 阶段 3：鸿蒙 PC 适配（2–4 周）

1. 升级 Electron 30 → 34（或切鸿蒙 fork）
2. `vite.config.mts` 设 `base: './'`
3. 加 ohos 平台检测 + `disableHardwareAcceleration`
4. MiniWindow 降级为单窗口路由
5. 实现 `HarmonyHost`（能力探测 + 降级）
6. 搭 `ohos_hap` 壳工程，补 `ohos:sync` / `ohos:build` 脚本
7. DevEco Studio 真机调试 + `binary-sign-tool` 签名

**产出：HAP 安装包。**

---

## 七、风险与注意事项

| 风险 | 等级 | 应对 |
|------|------|------|
| Electron 30 → 34 破坏性变更 | 中 | 先在独立分支升级，跑完整 e2e（现有 32 个 e2e 用例是资产） |
| 鸿蒙 Electron 版本迭代快 | 中 | 锁定版本，不追最新 |
| macOS 公证证书成本 | 低 | 个人开发者证书年费；未公证需用户手动放行 |
| **沙箱假成功（已存在）** | **高** | `windowsJob` 在 Windows 返回 `ok:true, exitCode:0` 但未执行任何命令。**四平台适配前必须先修**，否则会把这个静默错误复制到所有平台 |

> ⚠️ 最后一条与跨平台无关但优先级最高：`SandboxL1` 目前在 Windows 上会返回"执行成功"而实际什么都没跑，调用方无法区分。建议在启动跨平台工作之前先修掉。

---

## 八、一句话总结

**四平台全兼容可以做到。** 零原生模块 + 平台耦合仅 11 文件 + 命令执行不走 shell，这三点让本项目的跨平台底子远好于典型 Electron 应用。macOS/Linux 本质上已经支持，补构建流水线即可；鸿蒙 PC 走官方适配版 Electron，不需要 UI 重写，主要成本在版本升级、壳工程和能力降级。

真正值得投入的是**阶段 2 的核心层解耦**——它不只服务于鸿蒙，更是让这个项目从「Electron 应用」变成「可跨端的 Agent 内核」的分界线。

---

## 九、进度追踪（2026-08-07 已落地）

按本方案已开工，下列项已完成：

| 项 | 状态 | 说明 |
|----|------|------|
| §7 SandboxL1 假阳性修复 | ✅ | windowsJob 与 bwrap 改为 `ok:false` 明确失败，与 capability 一致 |
| 阶段1 构建脚本 | ✅ | `build:mac`/`build:linux` 已加；linux target 加 `deb`+`rpm` |
| 阶段1 CI 矩阵 | ✅ | release.yml 三平台已存在；补 `rpm` 安装 + deb/rpm 上传发布 |
| 阶段2 PlatformHost 抽象层 | ✅(基础) | 新建 `electron/platform/`(PlatformHost/runtime/ElectronHost/HarmonyHost/detect/index)，main 注入 `initHost()`` |
| 阶段3 vite `base:'./'` | ✅ | 修 HAP 白屏 |
| 阶段3 ohos 能力降级 | ✅ | TrayManager/GlobalShortcut/AutoUpdater/MiniWindow 在 ohos 提前 return 降级 |
| 阶段3 ohos 检测 + disableHardwareAcceleration | ✅ | `isOhos()` 多信号判定；main 在 ready 前调 disableHardwareAcceleration |
| dockerDetector win32 短路 | ✅ | 删除硬编码 unsupported，统一走真实 docker 探测 |

| 阶段2 core 层 `app.*`→`getHost()` 批量替换 | ✅ | 33 个纯逻辑/core 模块已解耦：`app.getPath/getVersion/isPackaged` → `getHost().getPath/getVersion/isPackaged()`；31 个文件移除未用 `app` import，`core/ConfigStore.ts` 因仍用 `app` 其它 API 保留；`sandbox/workspace.ts` 模块级常量改为惰性求值避免早于 `initHost`；`AppPathName` 增补 `desktop`。预留脚本 `scripts/_decouple_app_calls.py` 等可复用于后续批次 |

| 阶段2 PlatformHost 生命周期/getAppPath 接口 | ✅ | 接口增补 `getAppPath()` 与生命周期方法(`on/once/quit/relaunch/exit/whenReady/isReady`)；ElectronHost 委托 `app`，HarmonyHost 用 EventEmitter+process 信号桥接 before-quit/quit；core 剩余 `app.getAppPath()`(SelfLearner/SkillLoader)与 `app.quit()`(TrayManager)已改走 `getHost()`，并修复 SelfLearner 因上轮误删 `app` import 导致的潜在 ReferenceError；预留 `scripts/_decouple_lifecycle.py` |

| Electron 34 升级分析 | ✅ | `docs/electron34升级与破坏性变更分析.md`：扫描确认本代码未使用任何 30→34 移除/弃用 API，两个 BrowserWindow 站点 webPreferences 已现代化，代码侧升级风险「低」，无需安全修复；版本号 bump 列为人工闸门 |
| ohos_hap 壳工程 | ✅ | `ohos/` 已脚手架（AppScope/build-profile/oh-package/module.json5 + entry ets 入口），`package.json` 追加 `ohos:build`；官方 runtime 集成点标 TODO |
| DevEco 真机调试手册 | ✅ | `docs/鸿蒙PC-DevEco真机调试手册.md`：DevEco/SDK/runtime 获取、签名、hdc 真机、ohos:build→assembleHap→install→start、hiLog 调试、PiPiClaw 专属验证清单 |

**未做（需鸿蒙运行时/工具链，非本机可验证）：** Electron 34 实际 `npm install electron@34` 版本 bump 与跨平台构建回归（人工闸门）、MiniWindow 完整单窗口路由 UI 改造、ohos 壳工程在 DevEco 侧的官方 runtime 闭合与真机签名验证。

**说明：** 生命周期类 `app.*` 已统一收敛到 `PlatformHost`（`main.ts` 作为 Electron 主进程入口，其 `app.whenReady()`/`app.on(...)` 仍按设计保留在 shell 层——鸿蒙 PC 同样运行 Electron 主进程，`app` 生命周期 API 原生可用，无需经 host 中转）。

