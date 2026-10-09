# PiPiClaw 鸿蒙 PC（HarmonyOS PC）HAP 壳工程

对接 **鸿蒙 PC 官方 Electron runtime v34.6.3-20260105.1**。

本目录是一个标准 Stage 模型的 HarmonyOS 工程，职责**只有三件事**：

1. 声明入口 Ability、应用元信息与权限（`AppScope/app.json5` + `entry/src/main/module.json5`）
2. 把仓库根的既有 vite 产物（`dist/` + `dist-electron/`）搬进 HAP
3. 提供签名与打包配置

**不重写 UI，不改 `electron/` 业务逻辑。** 渲染进程仍是 `src/` 的 Vue3 应用，主进程仍是 `electron/main.ts`。

> ⚠️ **本机未安装 HarmonyOS SDK / DevEco Studio / 官方 OHOS Electron runtime。**
> 凡涉及官方运行时确切集成点的地方，文件内均以 `TODO（需官方 OHOS Electron runtime / DevEco 确认）` 显式标注，
> 未编造任何官方 API。完整清单见文末「TODO 清单」。

---

## 一、目录结构

```
ohos/
├── AppScope/
│   ├── app.json5                       应用级：bundleName / versionCode / 图标 / 名称
│   └── resources/base/
│       ├── element/string.json         app_name
│       └── media/app_icon.png          应用图标（复制自 resources/icon.png）
├── build-profile.json5                 工程级：product / SDK 版本 / 签名配置（signingConfigs 待补）
├── hvigorfile.ts                       工程级构建脚本（appTasks）
├── oh-package.json5                    ohpm 依赖（含 Electron runtime 依赖占位 TODO）
├── oh-package-lock.json5               最小锁文件（真实内容由 ohpm install 生成）
├── entry/                              主模块（HAP）
│   ├── build-profile.json5             模块级构建选项
│   ├── hvigorfile.ts                   模块级构建脚本（hapTasks）
│   ├── oh-package.json5                模块依赖（同样含 runtime 占位）
│   ├── obfuscation-rules.txt           release 混淆规则（当前关闭混淆）
│   ├── assets/                         ★ 构建产物暂存（由 ohos:build 生成，已 gitignore）
│   │   └── app/
│   │       ├── package.json            Electron 应用清单，main → dist-electron/main.js
│   │       ├── dist/                   vite 渲染进程产物
│   │       └── dist-electron/          main.js + preload.js(CJS) + mcp/bin
│   └── src/main/
│       ├── module.json5                Ability 声明 / metadata / 权限
│       ├── ets/
│       │   ├── AppAbilityStage.ets     进程级入口 —— Electron 主进程挂载点
│       │   ├── entryability/EntryAbility.ets   窗口宿主
│       │   └── pages/Index.ets         启动占位页（runtime 接管前短暂显示）
│       └── resources/base/
│           ├── element/string.json     module_desc / Ability 名称 / 权限申请理由
│           ├── element/color.json      start_window_background
│           ├── media/startIcon.png     启动图标
│           └── profile/main_pages.json 页面路由表
├── scripts/
│   ├── sync-assets.mjs                 dist/ + dist-electron/ → entry/assets/app/
│   └── pack-hap.mjs                    调用 hvigor 打 HAP（环境未就绪时显式失败）
├── signature/                          签名材料占位（证书已 gitignore，见其 README）
└── README.md                           本文件
```

---

## 二、与现有工程的对接关系

### 2.1 渲染进程：vite 产物直接复用

`vite.config.mts` 已设 `base: './'`（跨平台方案 §4.2 的必改项），产物内所有资源引用为相对路径，
放进 HAP 后不会因根路径错乱白屏。**无需为鸿蒙单独构建一份前端。**

### 2.2 主进程：`electron/main.ts` 不改一行

`electron/main.ts` 启动第 0 步调用 `initHost()`：

```ts
// electron/main.ts:74
initHost();
```

`initHost()` 内部经 `electron/platform/detect.ts` 判定平台，命中 ohos 时注入 `HarmonyHost`。
判定依赖三个信号（任一命中即可）：

| 信号 | 来源 | 壳工程需要做什么 |
|------|------|-----------------|
| `process.env.PIPICLAW_PLATFORM === 'ohos'` | 打包/运行时注入 | ★ **首选**，由 runtime 启动主进程时注入 |
| `process.platform === 'ohos'` | Node 未来可能支持 | 无需处理 |
| `/etc/os-release` 含 HarmonyOS/OpenHarmony/OHOS | 系统文件 | 真机上天然成立（兜底） |

`HarmonyHost` 还会读取以下环境变量，建议 runtime 一并注入：

| 环境变量 | 对应 | 建议值 |
|---------|------|--------|
| `PIPICLAW_APP_PATH` | `HarmonyHost.getAppPath()` | `${context.filesDir}/app` |
| `PIPICLAW_USER_DATA` | `getPath('userData'/'logs'/'cache')` 的基准目录 | `context.filesDir` |
| `PIPICLAW_VERSION` | `getVersion()` | `AppScope/app.json5` 的 `versionName` |

一旦 `HarmonyHost` 生效，以下能力**自动降级为 no-op**（阶段 3 已落地，无需壳工程干预）：

- `TrayManager` — 鸿蒙无系统托盘
- `GlobalShortcut` — 无全局快捷键
- `AutoUpdater` — 改走鸿蒙应用商店更新
- `MiniWindow` — 降级为主窗口内路由
- `secureStorage()` — 返回 `null`，调用方降级
- 沙箱 L1 — 走 stub 并**明确返回失败**（不假成功）

此外 `electron/main.ts` 在 `app.whenReady()` 之前对 ohos 调用了 `app.disableHardwareAcceleration()`，
规避 ArkWeb GPU 进程反复重启。

### 2.3 preload 必须是 CJS

鸿蒙 runtime 下 ESM preload 会崩。`dist-electron/preload.js` 当前首行即 `require("electron")`，
符合要求；`sync-assets.mjs` 每次同步都会做一次格式断言，不符合直接失败。

---

## 三、构建

```bash
# 一步到位（前端构建 → 同步产物 → 打 HAP）
npm run ohos:build

# 只同步产物（已有 dist/ 时用它，秒级）
npm run ohos:sync
```

`ohos:build` = `vite build` → `node ohos/scripts/sync-assets.mjs` → `node ohos/scripts/pack-hap.mjs`

- **第 1 步** 产出 `dist/`（渲染进程）与 `dist-electron/`（主进程 + preload，由 vite-plugin-electron 产出）
- **第 2 步** 复制到 `ohos/entry/assets/app/`，并生成 Electron 应用清单 `package.json`（`main: dist-electron/main.js`）
  - 输出目录可覆盖：`PIPICLAW_OHOS_ASSET_DIR=ohos/entry/src/main/resources/rawfile/app npm run ohos:build`
  - 注：任务描述里只提 `preload.js`，实际同步的是**整个 `dist-electron/`** —— `main.js` 才是主进程入口，只拷 preload 无法启动
- **第 3 步** 探测 DevEco/SDK/hvigor/oh_modules，**未就绪则打印指引并以退出码 1 明确失败**，绝不伪造成功
  （与仓库既有原则一致，见跨平台方案 §7 的沙箱假阳性教训）

当前在本机执行第 3 步的真实输出：

```
[ohos:pack] 环境检查未通过:
  - 未设置 DEVECO_SDK_HOME / HOS_SDK_HOME
  - 未找到 hvigor wrapper: <ohos>/hvigorw.bat
  - 未找到 ohos/oh_modules（尚未执行 ohpm install）
```

---

## 四、TODO 清单（需官方 runtime / DevEco 才能闭合）

按闭合优先级排列。**每一项在对应文件中都有同名 TODO 注释。**

| # | 集成点 | 文件 | 阻塞原因 |
|---|--------|------|---------|
| 1 | **启动 Electron 主进程的 runtime API** | `entry/src/main/ets/AppAbilityStage.ets` | 官方 runtime 初始化 API 未知。需完成：解出 app 资源 → 注入 `PIPICLAW_*` 环境变量 → 以 `dist-electron/main.js` 为入口启动 |
| 2 | **WindowStage 移交给 Electron** | `entry/src/main/ets/entryability/EntryAbility.ets` | runtime 如何接管窗口（ArkWeb 承载 BrowserWindow）未知；接管后需跳过 `loadContent('pages/Index')`，否则占位页遮挡 |
| 3 | **Electron runtime 依赖坐标** | `ohos/oh-package.json5`、`entry/oh-package.json5` | v34.6.3-20260105.1 的包名/来源（ohpm 公共仓 / 华为私有仓 / 本地 `.har`）未验证，故写为注释占位，避免 `ohpm install` 失败 |
| 4 | **app 资源注入 HAP 的方式** | `entry/hvigorfile.ts`、`scripts/sync-assets.mjs`、`entry/src/main/resources/rawfile/.gitkeep` | 三选一未定：rawfile 解压 / 官方 hvigor 插件声明 / runtime 直读文件路径。当前默认暂存到 `entry/assets/app` |
| 5 | **module.json5 的 metadata key 名** | `entry/src/main/module.json5` | `electron.main` / `electron.preload` / `electron.app.dir` 等为推导命名，官方真实 key 未验证；若 runtime 改从 app 根 `package.json` 的 `main` 定位入口，本段可整体删除 |
| 6 | **compatibleSdkVersion** | `build-profile.json5` | 当前填 `5.0.0(12)`，官方 runtime 对 SDK 下限的要求未知，需按官方文档调整 |
| 7 | **签名配置** | `build-profile.json5`、`signature/` | `signingConfigs` 为空数组、product 未引用 `signingConfig`；证书由 DevEco 自动生成或 AGConnect 下发。命令行签名工具参数亦未实测 |
| 8 | **hvigor wrapper** | `ohos/hvigorw`、`hvigor/hvigor-config.json5` | 由 DevEco 首次打开工程时下发，不手工编造，故本仓未创建 |
| 9 | **文件访问权限方案** | `entry/src/main/module.json5` | `FILE_ACCESS_MANAGER` 为 system_basic 级，普通应用会被驳回；鸿蒙 PC 上普通应用读写任意目录的合法方案待确认（可能只能走 FilePicker），影响 BashTool / 文件类技能 |
| 10 | **屏幕采集权限** | `entry/src/main/module.json5` | D1ScreenshotQA 截图技能所需权限在鸿蒙 PC 上的对应项未知 |
| 11 | **子进程执行是否被允许** | — | `BashTool` / `OpenClawGateway` 用 `execFile` 拉子进程，鸿蒙沙箱是否允许、需何权限待确认 |
| 12 | **Electron 30 → 34 升级** | 根 `package.json` | 本仓当前 `electron@^30.5.1`，官方鸿蒙 runtime 为 34.x。需在独立分支升级并跑完整 e2e（32 个用例） |
| 13 | **窗口尺寸 / 高 DPI / 多显示器** | `entry/src/main/ets/entryability/EntryAbility.ets` | 当前硬编码 1280×800，需真机对齐 `WindowManager` 默认值 |
| 14 | **versionName 同步** | `AppScope/app.json5` | 鸿蒙 `versionName` 只允许 `A.B.C`，根 `package.json` 为 `4.5.0-alpha`，此处取 `4.5.0`；发版时应由 CI 自动同步 |

---

## 五、环境就绪后的接入步骤

1. 安装 DevEco Studio + HarmonyOS SDK，设置 `DEVECO_SDK_HOME`
2. DevEco 打开 `ohos/` 目录一次 → 生成 `hvigorw` / `hvigorw.bat` / `hvigor/hvigor-config.json5`
3. 获取官方 Electron runtime v34.6.3-20260105.1，按 TODO #3 填入依赖坐标，执行 `ohpm install`
4. 按 TODO #1 / #2 补全 `AppAbilityStage.ets` 与 `EntryAbility.ets` 的 runtime 调用
5. 按 TODO #4 确定资源注入方式，必要时调整 `sync-assets.mjs` 的输出目录
6. 按 `signature/README.md` 配置签名
7. `npm run ohos:build` → 产出 HAP → `hdc install` 真机验证

---

## 六、参考

- 跨平台总方案：`docs/跨平台适配方案-Win-macOS-Linux-鸿蒙PC.md`（§4 鸿蒙 PC 改造清单、§9 进度追踪）
- 平台抽象层：`electron/platform/`（`PlatformHost.ts` / `HarmonyHost.ts` / `detect.ts`）
