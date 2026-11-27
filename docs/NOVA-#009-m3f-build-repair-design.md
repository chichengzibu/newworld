# NOVA #009 — M3-F 构建修复（应用此前打不出包）

> **状态**：已实现（2026-10-30）
> **对应台账**：DEV-089 ~ DEV-095
> **分支**：`feat/harness-wiring`
> **前置**：[M3-E 成本记账](NOVA-#009-m3e-cost-accounting-design.md)

## 一、为什么做这件事

### 1.1 动手才发现：应用根本构建不出来

跑一次 `npm run build` 才发现的：

```
error during build:
Could not resolve "../actor/ActorRegistry" from "electron/runtime/bridge/IpcBridge.ts"
```

**electron 主进程构建失败 → 应用打不出包 → 无法发布。**

### 1.2 根因：一次「清理无用文件」删掉了还在被 import 的模块

commit `7f6d988 chore: 清理无用文件 141 个` 删掉了：

```
electron/runtime/actor/Actor.ts
electron/runtime/actor/ActorRegistry.ts
electron/runtime/actor/index.ts
electron/runtime/conversation/State.ts
electron/runtime/conversation/Transition.ts
electron/runtime/conversation/index.ts
```

但 `IpcBridge.ts` / `Conversation.ts` / `MessageQueue.ts` **仍然 import 它们**。

那次清理的依据是「这些文件没人用」—— 而实际上：

| 模块 | 实际状态 |
|---|---|
| `IpcBridge` | **活的** —— `electron/main.ts:240` 调 `IpcBridge.getInstance().registerHandler()`，启动即注册 IPC 通道 |
| `Conversation` | 被 `AgentBrain.ts` 当类型用 |
| `Actor` / `ActorRegistry` | `IpcBridge` 的运行时依赖（桥接消息 → 派发给已注册 actor） |

**删文件与改 import 是两次独立的操作**，任何单测都覆盖不到它们的一致性。

### 1.3 为什么一直没被发现

因为**构建根本不做类型检查**。

`scripts/build.mjs` 只跑 `vite build`（esbuild，纯语法转译）——
类型错误一个都不报。于是：

| 事实 | 后果 |
|---|---|
| 30 条类型错误（含 7 条断链） | 长期无人理会 |
| 4 条断链 | 直接让主进程构建失败 |
| 构建不做类型检查 | 这类故障**只能靠真跑一次 build 才发现** |

而这一切**不报运行时错、不让任何单测变红**。

## 二、设计依据

### 2.1 类型检查必须成为构建门禁，不是「有空再跑」

vite/esbuild 只转译不检查类型 —— 这类工具**永远不会**告诉你 import 断了。
类型检查是独立的一道工序，不跑就等于没有。

### 2.2 「删文件」与「改 import」的一致性需要单独守

这不是任何现有测试能覆盖的维度（单测验的是行为，不是文件系统的存在性）。
所以它值得一条专门的护栏。

### 2.3 死代码要么删，要么接上 —— 不能留「看起来能用」的那套

`SkillManager` 曾是**第二个技能存储**（自带 CRUD + 自己的 ConfigStore 键），
但零生产调用方。真正在跑的是 `SkillLoader`。

一个自洽的 CRUD 看起来完全能用 → 后来者可能往 phantom 存储里写数据，
写完发现没有任何东西读它。**静默的空转比缺功能更难查。**

## 三、实现

### 3.1 修复断链（构建级）

| 动作 | 说明 |
|---|---|
| 恢复 6 个被删模块 | `Actor` / `ActorRegistry` / `actor/index` / `State` / `Transition` / `conversation/index` —— 从 `ba269d0` / `d432a0e` 原样恢复（不是重写） |
| 修 `preload.ts` 的 voice import | 原路径 `'../core/voice'` 指向**仓库根**（本文件在 `electron/` 下，正确是 `'./core/voice'`）；又因 `moduleResolution:'bundler'` 不解析目录索引，最终指向 `'./core/voice/index'` |

### 3.2 类型错误 30 → 0

分两类修：

**① 契约漏字段（4 处）** —— 代码在用，类型里没声明：

| 字段 | 情况 |
|---|---|
| `SplashOptions.onFailed` | 设计稿 F7 与类注释都写明「loadFile 失败 → onFailed 回调 → 主进程降级直开主窗（不做静默吞错）」，但**接口里漏了这个字段** → 5 处调用点全是类型错误。类型系统一直在替我们记着这笔债 |
| `ChannelMessage.from` / `.subject` | `IMMessageStore` 一直在用（按发送者过滤、按标题加权检索）→ 4 处类型错误 |

**② 代码本身的问题（18 处）**：

| 位置 | 问题 | 修法 |
|---|---|---|
| `SplashWindow` | `process.platform === 'test'` —— `'test'` 不在 `NodeJS.Platform` 里，TS 判为永假 | 显式转 string（确为刻意的测试短路） |
| `SplashWindow` | `webContents.on('mouse-down')` —— **不是 webContents 的事件名** | 改用 `before-input-event` + `input.type === 'mouseDown'`（主进程感知点击的正确 API） |
| `main.ts` | per-contents 的 `'crashed'` 监听与 app 级 `'render-process-gone'` **完全重复**（同一件事上报两次），且 `'crashed'` 在当前 Electron 版本的类型里已不存在 | 删掉重复的那个 |
| `WindowManager` | 回调闭包里 TS 无法窄化 `this.mainWindow`（`BrowserWindow \| null`） | 先取局部 const 再判空 |
| `LlmAgentBrain` | throw 之后 TS 把 `this.spawnCtx` 窄化成 `undefined` → `?.depth` 成 `never` | 深度在 throw 判断**之前**取出 |
| `ModelUsageTracker` | 两代 schema 的联合类型在 else 分支里被窄化，读不到 `callHistory` | 显式收窄 |
| `PermissionConfig` | `'upgrade-default'` 是合法的第 6 个 reason（配置升级把老 permissive 换成 safe），类型里没列 | 补进联合类型 |
| `ClawHubManager` | `publishedAt` 可能 undefined；模板字面量缺 `createdAt` | `?? 0` / 补字段 |

### 3.3 类型检查成为构建门禁

`scripts/build.mjs` 新增第 1 步：

```
=== [1/4] typecheck (主进程) ===   ← 不通过直接 exit 1,构建中止
=== [2/4] vite build ===
=== [3/4] electron-builder ===
=== [4/4] build-report ===
```

失败时明确提示：**typecheck 里的 "Cannot find module" 通常意味着有模块被删但 import 还在**。

### 3.4 冒烟测试的过期断言换成真门禁

`scripts/smoke-test.mjs` 原先断言 `dist-electron/tsconfig.node.tsbuildinfo` 存在 ——
那是「用 tsc 产 main.js」的年代留下的产物证明。构建早已改走 vite，
tsc 不再 emit → **这条断言永远失败**。

换成真正有意义的那道门：**主进程类型检查必须通过**。

### 3.5 导入完整性护栏（新增测试）

`tests/unit/import-integrity.test.ts` —— 全仓扫相对 import 并验证能解析：

| 用例 | 守住什么 |
|---|---|
| 所有相对 import 都能解析到文件 | 「模块被删但 import 还在」—— 正是本次构建失败的根因 |
| electron 目录不残留零字节文件 | 删除操作留下的空壳（本次修复过程中真的产生过 3 个） |
| 相对 import 不越出仓库根 | 防手滑写错 `../` 层级（`preload.ts` 的 voice import 就是这么错的） |

扫描前会**剥掉注释**（否则注释里提到的路径会被当成真 import）、
**跳过模板目录**（里面的 import 是要生成出去的代码文本，不是本仓库的依赖）。

### 3.6 死能力清理

| 删除 | 原因 |
|---|---|
| `SelfLearner.checkSkillMatch()` | 被 M4-A 的 `rankSkillsByRelevance`（单次 LLM 调用批量排序）取代，零调用方 |
| `SelfLearner.checkPatternThreshold()` | **恒返回 false** 的兼容壳 —— 调用方拿到的是错答案，不只是没答案 |
| `SelfLearner.generateSkillProposal(fingerprint)` | 忽略入参的兼容壳，返回的其实是 pendingProposal |
| `SkillManager` 的整套 CRUD + 自有存储（232 行 → 41 行） | **第二个 phantom 技能存储**，零生产调用方。只留 `getSkillsDir()`（路径单点，3 个活调用方） |

`SkillManager` 瘦身后仍明确标注「技能的真实存储在哪」：
正文在文件系统 `<skillsDir>/<skillId>/SKILL.md`，状态在 `skills.states`，接口在 `SkillLoader`。

## 四、验证

| 项 | 之前 | 现在 |
|---|---|---|
| `npm run build` | **失败**（主进程 bundle 解析不到模块） | **通过**，产出 `PiPiClaw-4.5.0-alpha-Setup.exe`（97MB） |
| 后端 typecheck | **30 error** | **0 error** |
| `scripts/smoke-test.mjs` | 21 passed / **1 failed** | **22 passed / 0 failed** |
| vitest | 117 files / 1398 passed | **118 files / 1401 passed / 0 FAIL** |
| 前端 vue-tsc | 0 | 0 |

新增测试 `tests/unit/import-integrity.test.ts`（3 例）。

## 五、遗留与后续

| # | 遗留 | 归属 | 说明 |
|---|---|---|---|
| 1 | **恢复的 4 个 runtime 模块仍无人真正使用** | 后续 | `IpcBridge` 活着（注册了通道），但没有 actor 注册进去 → 桥接的消息只走 EventBus。actor 模型要真正用起来，需要有 actor 实例注册 |
| 2 | **`Conversation` 状态机在 AgentBrain 里只是类型占位** | 后续 | `setConversation` 零调用方。要么接上（把 agent 的会话状态交给状态机管），要么删掉这个占位 |
| 3 | **构建不做前端 typecheck 门禁** | 后续 | `vue-tsc` 目前是独立脚本 `npm run typecheck`，没进 build。渲染层的类型错误同样能悄悄溜过 |
| 4 | **electron-builder 产物没进版本管理** | 遗留 | `release/` 已 gitignore；但本地要出包必须先过 typecheck 门禁（本批新增） |

## 六、参考资料

- TypeScript `moduleResolution: "bundler"` —— 不解析目录索引（`'../core/voice'` 这种目录写法要显式到 `index`）
- Electron `before-input-event` —— 主进程感知渲染侧输入事件的正确 API
- vite/esbuild —— 只做语法转译，**不做类型检查**
