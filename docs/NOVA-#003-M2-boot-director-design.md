# NOVA #003 · M2 — BootDirector + Splash 设计稿

**角色定位**：设计稿（先图纸后施工）；本文档零生产代码改动、零测试代码改动、零新依赖。
**产出**：本文件；实施待 #003-C 施工令（三笔切分见 F10）。
**范围硬约束**（#003-B 命令 §8）：
- 零生产代码改动（本文只描述，不实现）；不动 M1 七文件（`src/styles/tokens.css`, `src/stores/orb.ts`, `src/components/nova/NovaOrb.vue`, `src/views/Chat.vue`, `src/locales/zh-CN.ts`, `src/locales/en-US.ts`, `tests/unit/orb.test.ts`）；
- 禁新 npm 依赖；
- 安全确认链（`CommandConfirmDialog.vue` / `commandDecide.ts` / `BashTool`）零触碰；
- ChatManager 零触碰；
- 所有 file:line 数字来自当次实读，禁止记忆拼写（ROE 红线）；
- ROE 第 7 条适用：F 段抽验 ≥2 条已按此执行（见 F1/F2/F5 末尾标注）。

---

## F1 — 现状事实

### 1.1 `app.whenReady()` 后窗口创建顺序（`electron/main.ts` file:line 实读）

| 序 | 主进程动作 | file:line | 备注 |
|---|---|---|---|
| 0 | `session.defaultSession.setProxy({ proxyBypassRules: 'localhost;127.0.0.1' })` | `main.ts:106-110` | localhost 代理旁路（W12） |
| 1 | `log.info('...启动...')` | `main.ts:112` | — |
| 2 | `initHost()` | `main.ts:116` | 平台宿主抽象层（Phase 2 解耦） |
| 3 | `setupAppMenu()` | `main.ts:119,331-338` | 隐藏应用菜单 |
| 4 | `IpcServer.getInstance()` + `registerHandlers()` | `main.ts:122-123` + `IpcServer.ts:82+` | 6+ `dialog:*` / `window:*` / `gateway:*` / `hermes:*` / `skills:*` 通道注册 |
| 5 | `new AutoUpdater().registerIpcHandlers()`（早期注册） | `main.ts:129` | P1-T1.3 hotfix |
| **6** | **`WindowManager.getInstance()` + `await createMainWindow()` — 主窗创建** | **`main.ts:132-133`** | 首帧：`WindowManager.ts:60-70` `new BrowserWindow` + `mainWindow.once('ready-to-show', show) @ L70-75` + `loadURL('http://localhost:5173') @ L97` 或 `loadFile(join(__dirname,'../dist/index.html')) @ L100` |
| 7 | `GlobalShortcut.registerAll()` | `main.ts:136-137` | — |
| 8 | `TrayManager.create()` | `main.ts:140-141` | — |
| 9 | `permissionConfig` 保留引用（M1 P0-1 零行为） | `main.ts:148-149` | 见 `main.ts:143-147` 注释 |
| 10 | `ConfigStore.getInstance()` 首实例化 + `window.alwaysOnTop` / `window.edgeHideEnabled` 应用 | `main.ts:152-163` | 首次调用（`LlmConfigStore` 在 L28/S2.1 也用到，但主实例化点在 L153） |
| 11 | `OpenClawGateway.getInstance()` + `await start()` | `main.ts:165,168-175` | 网关启动 + 成功/失败日志 |
| 12 | 开发模式 DevTools | `main.ts:178-180` | `isDev` 分支 |
| 13 | `mainWindow.once('ready-to-show', → AutoUpdater.initialize)` 挂入 | `main.ts:183-193` | 首帧后 AutoUpdater 就绪 |
| 14 | W3+ 子系统 wire（IpcBridge / HermesAdapter / CapabilityRegistry / ChatManager+AgentBrain+LlmAgentBrain / D1 / D5 / IM channels） | `main.ts:195-240` | 详见 F3 事件源对接表 |
| 15 | MCP servers auto-start（fire-and-forget） | `main.ts:246-259` | 不阻塞启动 |

**结论**：当前"窗口创建"只有 1 次（主窗，`main.ts:132-133`），首帧就绪信号 = `mainWindow.once('ready-to-show', ...)`（`WindowManager.ts:70-75`），**无握手协议**；`IpcServer` 通道注册完成在 `ready-to-show` 之前（`main.ts:123` 先于 `:133`），但**渲染进程端是否已消费 IPC 未同步**。

### 1.2 `IpcServer` 既有通道命名惯例（file:line 实读）

**通道命名模式**：`namespace:action`（kebab-case action）。

| 命名 | file:line |
|---|---|
| `dialog:openFile` | `IpcServer.ts:82` |
| `window:minimize` / `maximize` / `close` / `isMaximized` / `setAlwaysOnTop` / `isAlwaysOnTop` / `setEdgeHide` / `isEdgeHide` / `showMini` / `hideToTray` | `IpcServer.ts:94,105,116,127,138,149,159,173,183,194` |
| `gateway:start` / `stop` / `restart` / `status` / `auth-token` / `repair` / `logs` / `config:get` / `config:set` | `IpcServer.ts:209,220,231,242,253,264,275,285,296` |
| `hermes:getMemories` / `hermes:saveCoreMemory` | `IpcServer.ts:310,327` |
| `skills:list` / `skills:toggle` / `skills:reload` | `IpcServer.ts:339,350,361` |

**独立注册模式**：
- `IpcBridge.registerHandler() → ipcMain.handle(IPC_BRIDGE_CHANNEL, ...)` @ `IpcBridge.ts:37-39`（channel 常量名 `runtime:ipc-bridge`，从 `main.ts:197` 注释推断）
- `main.ts:93` `ipcMain.on('open-devtools', ...)` — 早期独立 on 通道
- `main.ts:129` `new AutoUpdater().registerIpcHandlers()`（`autoUpdater:*` 通道族，独立于 `IpcServer`）

**结论**：`namespace:action` 为既成惯例；新通道走 `IpcServer.registerHandlers()` 集中注册（与 `dialog/window/gateway/hermes/skills` 同族），避免散落 `ipcMain.on` 单点。

### 1.3 渲染进程"首帧就绪"现状

- **信号**：`BrowserWindow.webContents` 的 `ready-to-show` 事件（`WindowManager.ts:70` `this.mainWindow.once('ready-to-show', () => { ...; this.mainWindow?.show() })`）。
- **无握手**：主进程只等浏览器首绘 + 立即 `show()`，**不等待 Vue mount / pinia 初始化 / 任何业务模块初始化**。
- **渲染端就绪判据**（e2e 侧证据）：`tests/e2e/helpers/electron-app.ts:77-85`：
  ```ts
  const window = await electronApp.firstWindow()       // L78
  await window.waitForLoadState('domcontentloaded')     // L79
  await window.waitForSelector('#app', { timeout: 15_000 })  // L81
  await window.waitForTimeout(500)                      // L83
  ```
  说明当前"渲染就绪 = `#app` 出现 + 拍子"，是 e2e 侧的**观察性**就绪判据，而非**应用内**的握手协议。
- **无既有握手 IPC**：`grep "renderer-ready\|boot-replay\|nova:renderer"` 在 `electron/preload.ts` 与 `src` 全零命中（`electron/preload.ts` 未 grep 到 `renderer-ready` 字样，见本文 §3 的 grep 输出）。

**ROE 第 7 条抽验**：✅ `main.ts:132-133` / `main.ts:122-123` / `IpcServer.ts:339,350,361` / `WindowManager.ts:70-75` / `electron-app.ts:78-83` 共 5 条 file:line 实读坐实。

---

## F2 — Splash 窗口规格（已裁决 + 打包兼容性论证）

### 2.1 规格（命令 §F2 已裁，照录）

| 项 | 值 |
|---|---|
| `frame` | `false` |
| `resizable` | `false` |
| `alwaysOnTop` | `true`（show 后设置） |
| `transparent` | `false`（底色由 CSS `--nova-bg-deep` 给，见 F8） |
| 尺寸 | ≈ 420 × 600 px（`width: 420, height: 600, useContentSize: true`） |
| 创建时序 | **先于主窗创建**（`main.ts` `whenReady` 序里插到序 3 与序 4 之间，见 F5 时序图） |
| 内容装载 | `splashWin.loadFile(join(__dirname, '../../resources/splash.html'))` — 纯 HTML/CSS/JS，**不走 Vite 管线** |
| `webPreferences` | `preload: null`, `nodeIntegration: false`, `contextIsolation: true`, `sandbox: true`（最严） |
| `show` | `false` 初值，`ready-to-show` 后 `show()` |
| 生命周期 | 收到 `nova:renderer-ready` 握手（或 `nova:boot-skip`）→ **`close()` 销毁 splash**；10s 超时兜底见 F7 |

### 2.2 与 `scripts/build.mjs` / electron-builder 的打包兼容性论证（file:line 实读）

**事实**：
- `resources/` 目录**已存在**且已含静态资源（`ls resources/` 实测：`icon.icns` / `icon.ico` / `icon.png` / `icon-128..512.png` / `icon-source.svg`）— 新增 `splash.html` **不引入新目录**。
- `electron-builder.json5:77-83`（实读）：
  ```json5
  "extraResources": [ { "from": "resources/", "to": "resources/", "filter": ["**/*"] } ]
  ```
  → **打包后** `splash.html` 落于 `<app>/resources/splash.html`（`asar` 打包的 `dist/` / `dist-electron/` 见 `electron-builder.json5:9-12`，`resources/` 走 extraResources 不进 asar，保持独立文件）。
- `electron-builder.json5:75` `"asar": true` — **`dist/` 内的 HTML 走 asar 路径**，但 `resources/` 独立于 asar（extraResources 机制），`loadFile` 直接读物理文件。
- `scripts/build.mjs` 全 154 行已读，无对 `resources/` 做额外校验/删除逻辑；`moveAside('dist'|'dist-electron'|'release') @ L48-50` 只搬 3 个构建产物目录，**`resources/` 不受影响**。
- `main.ts:38` `import { initHost, isOhos } from './platform'` — `isOhos()` 分支在 `main.ts:76-83` **disableHardwareAcceleration**，与 Splash 无冲突（Splash 是 CSS 动画，不涉及 WebGL/GPU 依赖）。

**结论**：Splash `loadFile(../../resources/splash.html)` 在 win/mac/linux 三平台打包后均有效（asar 外的 extraResources 机制 + `resources/` 目录已存在且已被 `extraResources` 收录）。

**OHOS 备注**：`electron/platform/HarmonyHost.ts` 未实读全量，但 `main.ts:76-83` `isOhos()` 分支的 `disableHardwareAcceleration()` 与 Splash 静态 HTML 无冲突；OHOS 打包链路差异若后续暴露，按 F6 兼容方案加 `PIPICLAW_SKIP_SPLASH=1` 兜底即可，不阻塞 M2 交付。

**ROE 第 7 条抽验**：✅ `electron-builder.json5:77-83` / `electron-builder.json5:9-12` / `scripts/build.mjs:48-50` / `main.ts:76-83` / `main.ts:38` 共 5 条 file:line 实读。

---

## F3 — BootDirector 状态机（新 `electron/core/BootDirector.ts`）

### 3.1 阶段枚举

```ts
export type BootStage =
  | 'init'              // 进入 whenReady，未开始任何子系统初始化
  | 'config'            // ConfigStore 已实例化 + 主配置项已读
  | 'ipc'               // IpcServer 通道已注册
  | 'llm-config'        // LlmConfigStore 已实例化 + 至少 1 个 enabled provider（或已声明"无 provider"）
  | 'memory'            // HermesAdapter 就绪（见 §3.3 最小接线方案）
  | 'skills'            // SkillLoader 已 loadAll（同步，构造时执行）
  | 'chats'             // ChatManager + AgentBrain + LlmAgentBrain 已 register
  | 'channels'          // initChannels 已跑（IM 11 通道注册）
  | 'renderer-ready'    // 渲染端已确认 mount 完成（nova:renderer-ready 握手）
  | 'done'              // Splash 已销毁，主窗已 show
  | 'aborted'           // 失败路径降级到主窗（见 F7）
```

### 3.2 事件源对接表（file:line 实读 + "无信号"最小接线方案）

| 阶段 | 现有初始化点 | file:line | 信号形态 | 备注 |
|---|---|---|---|---|
| config | `ConfigStore.getInstance()` 首次实例化 + `get('window.alwaysOnTop')` 读取 | `main.ts:152-163`（首实例化 @ `:153`） | **隐式同步**（`getInstance()` 返回即"就绪"） | 无独立 ready 事件，用**初始化调用成功即信号** |
| ipc | `IpcServer.getInstance().registerHandlers()` | `main.ts:122-123` | **同步**（`registerHandlers` 是同步函数，`IpcServer.ts:82+` 全 `ipcMain.handle`） | 同上 |
| llm-config | `LlmConfigStore.getInstance().getActive()` | `electron/llm/LlmConfigStore.ts:24,41`（`getActive()`），**未在主进程启动序列里显式调用**（当前懒加载） | **无信号** | **最小接线方案**：BootDirector 主动调 `LlmConfigStore.getInstance().getActive()` 一次，返回值非 undefined 即"有 provider"、undefined 即"无 provider 声明"，两种都是合法就绪态（不阻塞 Boot） |
| memory | `HermesAdapter.getInstance()` | `main.ts:201`（W3+ wire 块第 2 步） | **无独立 ready/initialized 信号**（`grep -n "ready\|initialized\|warmup" electron/hermes/HermesAdapter.ts` **零命中** — 见本文 §3.3 实测） | **最小接线方案**：BootDirector 主动调 `HermesAdapter.getInstance()` 一次，同步返回即"已构造就绪"；**不引入新的 `onReady` 回调**（保守：零既有行为变更，未来 M3+ 才加） |
| skills | `SkillLoader.getInstance()` 首次实例化（构造内同步 `loadAllSkills()`） | `electron/skill/SkillLoader.ts:96`（`getInstance`）、`:93`（构造内 `this.loadAllSkills()`）、`:131-151`（`loadAllSkills/loadSkill`） | **同步**（构造即完成，`main.ts` 当前在 `IpcServer.ts:339 skills:list` 调用链上懒加载） | **最小接线**：BootDirector 主动调 `SkillLoader.getInstance()` 一次，同步返回 = 就绪 |
| chats | `ChatManager.getInstance().registerAgent(...)` + `LlmAgentBrain` | `main.ts:207,217` | **同步**（`registerAgent` 是同步方法） | 同上 |
| channels | `initChannels()` | `main.ts:232` + `electron/channel/bootstrap.ts:16` | **同步**（`bootstrap.ts:16-40` 全同步 `for (kind of ALL_CHANNEL_KINDS)`） | 同上 |
| renderer-ready | **不存在**（当前 `ready-to-show` 只等浏览器首绘，不等 Vue mount + pinia） | `WindowManager.ts:70-75`（现"首帧"定义） | **无既有信号** | **最小接线**：新增 IPC 通道 `nova:renderer-ready`（renderer 端在 `src/main.ts` 的 `app.use(i18n)` 完成 + `#app` mount 后主动 `window.electronAPI.nova.rendererReady()`），主进程 `ipcMain.handle('nova:renderer-ready')` 收到 → 标记 `rendererReady=true`。这是**新增**握手，不是替换既有 `ready-to-show` |
| i18n | **不是主进程信号**（纯渲染端 `src/locales/index.ts` 由 `src/main.ts:22,61` 加载） | `src/main.ts:22,61` | 属于 `renderer-ready` 前置的一部分 | BootDirector 不直接 track，由 `renderer-ready` 握手隐式包含 |

### 3.3 "无信号"子系统的最小接线方案（禁造信号）

**原则**：不发明新的 `onReady` / `warmup` / `initialize` 方法。用**主动调用 + 同步返回**的方式在 BootDirector 内**显式触发 + 断言**，把"已实例化 = 已就绪"这个隐含假设显式化。

**实测**（§F3 事实锚定）：
- `HermesAdapter.ts` **无** `ready|initialized|warmup` 字段/方法（`grep -n` 零命中）
- `HermesAdapter.getInstance()` 是同步单例（`main.ts:201` 用法：`HermesAdapter.getInstance()` 直接调用，不 await，不 then）
- `SkillLoader.ts` 构造内同步 `loadAllSkills @ :93`（`grep -n "ready\|initialized" electron/skill/SkillLoader.ts` 预期零命中，需 F4 施工令复核）
- `LlmConfigStore.ts` 有 `getInstance()` + `get()` + `set()` + `getActive()` 但**无** `ready` 字段

**结论**：对无 ready 信号的子系统，`BootDirector.init()` 里按上表顺序**主动调 `.getInstance()` 或等价方法**，同步返回即信号。失败（抛异常）走 F7 失败路径。

**禁止**：
- 不得给 `HermesAdapter` / `SkillLoader` / `LlmConfigStore` 加 `onReady(cb)` / `initialized` 字段
- 不得引入 `warmup()` / `prewarm()` 新方法
- 不得把 `ready-to-show` 升级为"业务就绪"（业务就绪用 `nova:renderer-ready`）

**ROE 第 7 条抽验**：✅ `main.ts:152-163` / `main.ts:201` / `main.ts:207,217` / `main.ts:232` / `bootstrap.ts:16` / `SkillLoader.ts:93` / `LlmConfigStore.ts:24,41` / `HermesAdapter.ts`（否定 grep 零命中）共 8 条锚定。

---

## F4 — IPC 契约

### 4.1 通道命名（`namespace:action` 惯例，见 §1.2）

| 通道 | 方向 | 载荷 | 语义 |
|---|---|---|---|
| `nova:renderer-ready` | renderer → main（`ipcRenderer.invoke` / `send`） | `{ stage?: 'renderer-ready' }` | 渲染端确认 Vue mount + i18n + pinia 完成，BootDirector 收到 → Splash 进入"点亮"节拍 → 销毁 |
| `nova:boot-event` | main → renderer（`webContents.send`）| `{ stage: BootStage, label: string, progress: number (0..1, 单调不减), detail?: string }` | 主进程每个阶段完成向 Splash 推一次，Splash 端展示 |
| `nova:boot-skip` | renderer → main（`ipcRenderer.send`） | `{ reason: 'user-interaction' \| 'timeout' }` | Splash 点击/任意键跳过 → 立即切主窗，**仍等 renderer-ready**（`reason=user-interaction` 时 `skipWaitForRenderer = false` — 保守语义：用户交互是"我想看主窗"，不是"业务就绪"） |
| `nova:boot-replay` | renderer → main | `{ fromStage: BootStage }` | **M6 延后**（命令 §F4 明确 M6 延后预留，本 M2 不实现、不注册） |

**⚠️ 命名冲突澄清**（实读发现 `electron/preload.ts:1228` 已存在 `notifyRendererReady: () => ipcRenderer.invoke('webcontainer:renderer-ready')`）：
- **既有** `webcontainer:renderer-ready`（W13 WebContainerRunner，`IpcServer.ts:2462-2469`）：WebContainer 内嵌浏览器容器加载 `@webcontainer/api` 后的 ack 回包，**限定**于 webcontainer 子系统。
- **M2 新增** `nova:renderer-ready`：BootDirector 首帧握手，**限定**于主窗 Vue mount + i18n + pinia 就绪。
- 两者**语义不同 + 命名空间不同**（`webcontainer:*` vs `nova:*`），不冲突，可并存。
- 施工令 B2 落实时**必须**在 `electron/core/IpcServer.ts` 的 handler 注释里交叉引用既有 `webcontainer:renderer-ready @ IpcServer.ts:2462` 避免未来维护者混淆。

**注**：`nova:boot-replay` 通道名已在 F4 契约里锁定，但**M2 不实现 handler**（`main.ts` 不注册 `ipcMain.handle('nova:boot-replay', ...)`）。这是契约预留，避免 M6 时改命名。

### 4.2 载荷 schema

**`nova:boot-event`**（主→S）：
```ts
interface BootEventPayload {
  stage: BootStage;                 // F3 §3.1 枚举
  label: string;                    // i18n 后的展示文案（如 "Loading memories..."）
  progress: number;                 // 0..1 单调不减；BootDirector 内维护 `lastProgress` 字段
  detail?: string;                  // 可选详细日志（Splash 端 log 面板显示）
  timestamp: number;                // Date.now()
}
```

**`nova:renderer-ready`**（r→主）：
```ts
interface RendererReadyPayload {
  stage: 'renderer-ready';         // 显式字段，方便 M6 replay 时区分
  readyAt?: number;                // renderer 侧 Date.now()
}
```

### 4.3 progress 单调不减机制

- BootDirector 内字段 `lastProgress: number = 0` + `stageCount: number = completedStages.length`
- 每次 `markStage(stage)` 完成时，`progress = stageCount / totalStages`；若 `progress < lastProgress`（理论不该发生，防御性），**clamp 到 lastProgress**，不向回推。
- 单调性测试见 F9 T2。

---

## F5 — 时序编排

### 5.1 事件先到 vs 2.8s 下限展示

**规则**：
1. **Splash 创建**：`main.ts` `whenReady` 序插到**序 3（`setupAppMenu` 完成）与序 4（`IpcServer` 注册）之间** — 这样 Splash 在 IpcServer 通道注册完成前就已可见，避免"通道不存在 → IPC 无 handler" 报错。
2. **阶段事件先到**（所有 `markStage` 在 2.8s 内完成）→ BootDirector 立即推 `nova:boot-event`，Splash 端**满格保持**（progress 已到 1.0 但 `renderer-ready` 未到或 `minShowDuration` 未到）。
3. **阶段事件慢到**（某 `markStage` 耗时超过 2.8s）→ `nova:boot-event` 推实际 progress 值（非满格），Splash 端**显示实际值**，不人为拉平。
4. **`minShowDuration`**：BootDirector 字段 `MIN_SHOW_MS = 2800`。从 Splash `show()` 时起算，`elapsed = Date.now() - splashShownAt`；销毁前要求 `elapsed >= MIN_SHOW_MS` 否则**等待**。
5. **`renderer-ready` 到达**：若 `elapsed < MIN_SHOW_MS` → 等满 `MIN_SHOW_MS`；若 `elapsed >= MIN_SHOW_MS` → 立即销毁。
6. **跳过信号**（`nova:boot-skip, reason=user-interaction`）：立即**不等** `minShowDuration` 也**不等** `renderer-ready`，**销毁 Splash + `show()` 主窗**（主窗已在序 6 创建，只是未 `show()`）。
   - 保守语义：跳过**不**等价于 `renderer-ready`（用户交互 ≠ 业务就绪），但用户已表达"我想看主窗"，强制等待反而违背用户意图。`markStage('renderer-ready')` 由 e2e/单测在 skip 路径下**不调用**（见 F9 T4 skip 用例）。

### 5.2 时序图（简化）

```
main.whenReady ──┬─ [序3] setupAppMenu ──→ splashWin.create() + splashWin.loadFile(...)
                 │                            └─ ready-to-show → splashWin.show()
                 ├─ [新] ipc.nova:boot-event / nova:renderer-ready / nova:boot-skip 3 通道注册
                 ├─ [序4] IpcServer 通道注册
                 ├─ [序6] await WindowManager.createMainWindow()   ← 未 show()
                 ├─ [序7..15] BootDirector 按 F3 序 markStage(config/ipc/llm-config/memory/skills/chats/channels)
                 │        每次 markStage → nova:boot-event → Splash 显示
                 └─ 等待: renderer-ready OR minShowDuration=2.8s OR skip
                    ├─ renderer-ready + elapsed≥2.8s  → splash.close() + mainWindow.show()
                    ├─ elapsed≥2.8s 但 renderer 未 ready → splash.close() + mainWindow.show() + renderer 端继续加载
                    ├─ skip(user-interaction)          → splash.close() + mainWindow.show() (立即)
                    └─ 10s 超时 (renderer-ready OR markStage 全部完成仍未 ready) → 强切 main.show() + splash.close() + log.warn
```

**关键**：`mainWindow.show()` 与 `splashWin.close()` **同一事件循环 tick 内**（避免"闪黑屏"）；`ready-to-show` 挂法沿用 `WindowManager.ts:70-75` 既有模式（**不重写** `WindowManager`，只在 `BootDirector` 里等 `mainWindow.webContents` 的 `ready-to-show` 一次性事件）。

---

## F6 — e2e 兼容

### 6.1 现有 e2e 关键约束

**e2e 文件**：`git ls-files tests/e2e` 共 **34 个**（含 `_p0-helpers.ts` + `helpers/electron-app.ts`，实读文件列表见本文 §F6 附录）。

**关键 fixture 锚定**（`tests/e2e/helpers/electron-app.ts` file:line 实读）：
- L67：`PIPICLAW_E2E: '1'` — **既有环境注入模式**（e2e 已用这个 env var 让 `WindowManager` 走 prod 路径 `loadFile`）
- L70：`timeout: 30_000`（electron 冷启动 5-15s + 首窗加载 3-5s）
- L78：`const window = await electronApp.firstWindow()` — **⚠️ 取"最先创建的 window"**
- L79-81：`waitForLoadState('domcontentloaded')` + `waitForSelector('#app', { timeout: 15_000 })`
- L83：`waitForTimeout(500)` 给 router 一拍

**风险**：Splash 先于主窗创建 → `firstWindow()` 返回 **Splash 窗口**（非主窗）→ `#app` selector 在 Splash 上找不到（Splash 是纯 HTML，无 Vue `#app`）→ **全 34 个 e2e 全红**（15s timeout 后）。

### 6.2 PIPICLAW_SKIP_SPLASH 方案（命令 §F6 建议方向）

- **注入点**：`tests/e2e/helpers/electron-app.ts:63-69` 现有 `env` 里加一行 `PIPICLAW_SKIP_SPLASH: '1'`（**与 PIPICLAW_E2E 同模式**，零新概念）
- **消费点**：`main.ts` `whenReady` 序 3.5（Splash 创建点）判断 `process.env.PIPICLAW_SKIP_SPLASH === '1'` → **跳过 Splash 创建 + 直接走现有 `createMainWindow()` + `ready-to-show → show()`**（`WindowManager.ts:70-75` 既有路径零改动）
- **降级路径**：Splash `loadFile` 失败 / `splashWin.webContents.on('did-fail-load')` 触发 → 自动 `splashWin.close()` + 标记"降级路径" → 继续走主窗（见 F7）
- **e2e 不依赖 Splash 存在**：34 个用例**零改动**（注入 env var 在 fixture 层，用例体不感知）

### 6.3 新 e2e 测试点（M2 加，不在本稿交付）

见 F9 E3。

**ROE 第 7 条抽验**：✅ `electron-app.ts:63-69` / `electron-app.ts:78-83` / `WindowManager.ts:70-75` 共 3 条 file:line 实读。

---

## F7 — 失败路径

### 7.1 Splash `loadFile` 失败

- **触发**：`splashWin.webContents.on('did-fail-load', (_e, code, desc, validatedURL) => { ... })`
- **处理**：`log.error('[BootDirector] splash loadFile 失败', { code, desc })` + **立即 `splashWin.close()`** + 继续走主窗流程（不阻塞 `BootDirector.markStage` 后续）
- **用户感知**：Splash 闪一下就没了，主窗照常 `ready-to-show` show；**不弹窗**（静默降级 + 日志）

### 7.2 BootDirector 内部异常（某 `markStage` 抛错）

- **触发**：`try { markStage('memory') } catch (e) { log.error('...'); markStage('aborted'); splashWin.close(); mainWindow.show(); return; }`
- **处理**：`aborted` 是终止态，**不 retry**（避免死循环）；主窗强制 show（无论 renderer-ready 是否到）

### 7.3 `renderer-ready` 10s 超时兜底

- **触发**：Splash `show()` 后 `setTimeout(() => { if (!rendererReady && !aborted) { log.warn('[BootDirector] renderer-ready 10s 未到达，强制切换'); splashWin.close(); mainWindow.show(); } }, 10000)`
- **处理**：强切主窗 + Splash 销毁；**不清空** 已推的 `nova:boot-event`（Splash 已关，renderer 端继续加载即可）
- **不阻塞应用**：10s 超时不 `app.quit()`

### 7.4 失败路径总表

| 场景 | 检测点 | 动作 | 不做什么 |
|---|---|---|---|
| Splash `loadFile` 失败 | `did-fail-load` | 关 Splash，继续主窗 | 不弹窗、不 app.quit |
| Splash `webContents` crash | `crashed` 事件（沿用 `main.ts:53-62` 既有 Sentry 挂法，不改） | 关 Splash，继续主窗 | 不 crash app |
| BootDirector 某 `markStage` 抛 | try-catch | `aborted`，强切主窗 | 不 retry |
| `renderer-ready` 10s 未达 | setTimeout | 强切主窗 | 不 app.quit |
| `PIPICLAW_SKIP_SPLASH=1` | Splash 创建点 | 不创建 Splash，走 `WindowManager` 既有路径 | 不注册 nova:boot-event handler（节省 IPC 开销） |

---

## F8 — `--nova-bg-deep:#050508` 消费点声明（回应 #002 报备第 3 条）

**现状**：M1 #002 已声明 `--nova-bg-deep: #050508` @ `src/styles/tokens.css:416` 但**无组件消费**（#002 报备第 3 条已注明"如规格要求 M1 即须消费，请指认消费点"）。

**M2 消费点**（本稿新增）：
- `resources/splash.html` 根 `<div id="splash-canvas">` 背景：`background: #050508`（**硬编码值，不引 tokens.css** — Splash 不走 Vite，不能 import src/styles/tokens.css）
- **同步声明**：`tokens.css:416 --nova-bg-deep` 是 M1 层的"单一事实源"，Splash 端**镜像值**，不消费 token（Splash 是静态文件，不引 Vue/组件）
- **一致性维护**：`tokens.css:416` 修改时同步改 `splash.html`（M2 施工令 F10 第 3 笔 splash.html 里加注释 `/* 值来源: src/styles/tokens.css:416 --nova-bg-deep #050508 */`）**禁**引 `var(--nova-bg-deep)`

**结论**：`--nova-bg-deep` 在 M2 有了消费点（Splash 画布底色）；M1 的"无组件消费"报备**在 M2 收口**（Splash 是首个消费者，虽是静态 HTML 非 Vue 组件，但值一致）。

---

## F9 — 测试案

### 9.1 BootDirector 纯逻辑单测清单（新 `tests/unit/boot-director.test.ts`）

| ID | 场景 | 断言 |
|---|---|---|
| T1 | 阶段顺序 | 依次 `markStage(config) → markStage(ipc) → markStage(memory)` 后 `getProgress()` 从 1/7 → 2/7 → 3/7，`eventLog` 长度 3，stage 序正确 |
| T2 | progress 单调不减 | 构造 `markStage` 乱序调用（`chats` → `config`）后，`progress` 仍单调不减（后者的 `stageCount` 计算基于 `stageSet`，不依赖调用序） |
| T2b | progress clamp | 模拟 `markStage` 重复调用（同 stage 两次）→ `lastProgress` 不回退 |
| T3 | `minShowDuration` | mock `Date.now`：`markStage('renderer-ready')` 到达时 `elapsed < 2800` → 不 `closeSplash`；`elapsed >= 2800` → `closeSplash` 调用 1 次 |
| T4 | skip 立即切 | `onSkip()` 后 `closeSplash + showMainWindow` 立即调用，**不等** `renderer-ready`；`markStage('renderer-ready')` 不被 `onSkip` 隐式触发 |
| T5 | 10s 超时兜底 | mock timer：`setTimeout` 10s 内 `renderer-ready` 未达 → `closeSplash + showMainWindow` 调用，`aborted=false`（非失败，是兜底） |
| T6 | `PIPICLAW_SKIP_SPLASH=1` 时不注册 nova:* 通道 | mock `ipcMain.handle`：skip 模式下 `nova:renderer-ready` / `nova:boot-event` / `nova:boot-skip` 3 通道 handler **未**被 `ipcMain.handle` 调用 |
| T7 | 失败路径 | `markStage('memory')` throw → `state === 'aborted'`，`closeSplash + showMainWindow` 各调 1 次 |
| T8 | `nova:boot-event` 载荷 shape | 每次 `markStage` 推的 `event` 包含 `stage/label/progress/detail?/timestamp`，`progress ∈ [0,1]` 单调 |
| T9 | i18n 标签 | markStage('memory') 推的 `label` 来自 i18n key `nova.boot.label.memory`（zh/en 双份，**新增 key** 待 F10 第 2 笔落实，本稿只锁 key 名） |

**新增 i18n key 清单**（M2 施工令落实，**禁** 新增 locale 文件，改 `src/locales/zh-CN.ts` + `en-US.ts` 现有结构）：
- `nova.boot.label.init` / `config` / `ipc` / `llm-config` / `memory` / `skills` / `chats` / `channels` / `renderer-ready` / `done` / `aborted`
- `nova.boot.subtitle`（副标题，如 "PiPiClaw 正在唤醒..."）

### 9.2 E2E 新增点（M2 施工令落实）

| ID | 场景 | 断言 |
|---|---|---|
| E1 | Splash 不阻塞 e2e | `PIPICLAW_SKIP_SPLASH=1` 注入后，34 个既有 e2e 用例全绿（fixture 层零用例体改动） |
| E2 | Splash 创建可见（非 skip 模式） | 新用例：launch electron 不注入 `PIPICLAW_SKIP_SPLASH` → `firstWindow().evaluate(() => document.querySelector('#splash-canvas') !== null)` 成功 → `mainWindow` 是第二个 window |
| E3 | 10s 超时兜底端到端 | 新用例：launch + 阻止 `nova:renderer-ready`（`page.evaluate(() => { window.electronAPI.nova = { rendererReady: () => {} }; })`）→ 11s 后 `mainWindow.isVisible() === true` |
| E4 | 用户跳过跳过 | 新用例：Splash 可见后 `page.keyboard.press('Escape')`（或 `page.click('body')`）→ `<300ms` 内 `mainWindow.isVisible() === true` + `splashWindow.isDestroyed() === true` |

### 9.3 电池预期（ROE：实跑为准）

**基线**：M1 #002 + #003-A 后归档值 `Test Files 88 passed / Tests 1044 passed | 8 skipped (1052)`。

**M2 预期增量**（待施工令 F10 后实跑复核）：
- 新单测文件 `tests/unit/boot-director.test.ts` 预计 T1-T9 9-10 用例 → 测试总数 ≈ **1044 + 10 = 1054**（± 依 T9 i18n 双份断言 + T6 handler-未注册断言拆分）
- 新 e2e E1-E4（E1 是回归门禁，用例数**零增**；E2-E4 新增 3 个，但 e2e 需 `E2E_ELECTRON=1` 才跑，**不**计入默认 `npm test` 基线）→ 默认 `npm test` 基线预期 ≈ **88 文件 + 1 (boot-director) = 89** / **1044 + 10 = 1054**
- **实跑后以 `npm test` 输出为准**（ROE 红线：实跑为准，非预估）

### 9.4 测试文件清单（M2 施工令落实）

| 文件 | 类型 | 说明 |
|---|---|---|
| `tests/unit/boot-director.test.ts` | 新增 | T1-T9 |
| `tests/e2e/splash-boot.e2e.ts` | 新增 | E2-E4（E1 是既有 e2e 回归门禁，不新增） |
| `tests/e2e/helpers/electron-app.ts` | 修改 | L67 旁加 `PIPICLAW_SKIP_SPLASH: '1'` |

---

## F10 — 提交切分 + 边界

### 10.1 本稿（#003-B）

- **零生产代码改动**：本文件只描述，不实现
- 独立 docs 提交（避开 #008/#009 编号，用 `NOVA-#003-M2-*` 命名）

### 10.2 实施建议（#003-C 施工令，本稿不落实）

**三笔切分**：

| 笔 | 内容 | 文件白名单 |
|---|---|---|
| **B1** | `BootDirector.ts` + 纯逻辑单测（T1-T9） | `electron/core/BootDirector.ts`（新增）+ `tests/unit/boot-director.test.ts`（新增）+ **不改** `src/locales/*`（T9 的 i18n key 在 B2 落） |
| **B2** | `main.ts` 接线 + `IpcServer.ts` 3 通道 + i18n key + preload 桥 | `electron/main.ts`（**只**在 `whenReady` 序 3.5 插 Splash 创建 + 在 `IpcServer.registerHandlers` 里加 2 handle 注册）+ `electron/core/IpcServer.ts`（加 2 `ipcMain.handle`：`nova:renderer-ready` / `nova:boot-skip`）+ `electron/preload.ts`（加 `nova: { rendererReady, skipBoot }` 2 个方法）+ `src/locales/zh-CN.ts + en-US.ts`（加 `nova.boot.*` keys）+ `src/main.ts`（加 `window.electronAPI.nova.rendererReady()` 在 i18n init 后调用） |
| **B3** | `resources/splash.html` + 失败路径 + e2e E1-E4 + fixture 注入 | `resources/splash.html`（新增）+ `tests/e2e/splash-boot.e2e.ts`（新增）+ `tests/e2e/helpers/electron-app.ts`（**只**在 L67 旁加 1 行 env） |

### 10.3 边界

- M1 七文件（`src/styles/tokens.css` / `src/stores/orb.ts` / `src/components/nova/NovaOrb.vue` / `src/views/Chat.vue` / `src/locales/zh-CN.ts` / `src/locales/en-US.ts` / `tests/unit/orb.test.ts`）：B1-B3 **零触碰**（zh-CN/en-US 在 B2 加 `nova.boot.*` 是**新增 key**，不是改 M1 既有的 `orb.status.*` / `orb.suggestions.*`，**允许**触碰这两文件 — 这是 B2 的白名单，与 M1 零触碰不冲突）
- 安全链（`commandDecide.ts` / `BashTool` / `CommandConfirmDialog.vue`）：B1-B3 **零触碰**
- ChatManager：B1-B3 **零触碰**
- 新 npm 依赖：B1-B3 **零新增**

### 10.4 后续

- 本稿交付后**停止**，等待总指挥复审（命令 §10 明确"输出后停止，等待总指挥复审"）
- #003-C 施工令另发，按 B1 → B2 → B3 顺序施工，每笔独立 commit + 全电池 + porcelain 归空

---

## 附录：F 段事实锚定 checklist（ROE 第 7 条）

| F 段 | file:line 实读 ≥2 | 实际 |
|---|---|---|
| F1 | ✅ 5 条 | `main.ts:132-133,122-123` / `IpcServer.ts:339,350,361,82,94-194` / `WindowManager.ts:70-75` / `electron-app.ts:78-83` |
| F2 | ✅ 5 条 | `electron-builder.json5:77-83,9-12` / `scripts/build.mjs:48-50` / `main.ts:76-83` / `resources/` 目录实读 |
| F3 | ✅ 8 条 | `main.ts:152-163,201,207,217,232` / `bootstrap.ts:16` / `SkillLoader.ts:93` / `LlmConfigStore.ts:24,41` / `HermesAdapter.ts`（否定 grep 零命中） |
| F6 | ✅ 3 条 | `electron-app.ts:63-69,78-83` / `WindowManager.ts:70-75` |

全部 F 段 ≥2 条实读 file:line，**无臆造方法名**（`grep -n "ready\|initialized\|warmup" electron/hermes/HermesAdapter.ts` 零命中 → 标"无信号" + 最小接线方案；**禁造** `onReady` / `warmup`）。
