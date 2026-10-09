# PiPiClaw 项目内容文档记录

> 本文档由对项目代码的静态检查（结构扫描、配置读取、源码抽样）自动整理而成，
> 用于记录 PiPiClaw 桌面 AI 自动化助手的当前内容、架构与规模。
> 生成时间：2026-08-06 ｜ 项目版本：`v4.5.0-alpha` ｜ 路径：`D:\pipiclaw\piclaw`

---

## 1. 项目概述

| 项 | 内容 |
|----|------|
| 名称 | pipiclaw（产品名 PiPiClaw） |
| 描述 | 国产桌面 AI 自动化助手，基于 Electron + Vue 3 + OpenClaw，具备 Hermes 自进化能力 |
| 版本 | `4.5.0-alpha`（已有 v4.4.0 正式发布） |
| 许可证 | MIT |
| 作者 | PiPiClaw Team |
| 入口 | 主进程 `electron/main.ts` → 渲染进程 `src/main.ts`，窗口加载 `index.html` |
| 构建产物 | `dist/`（渲染）、`dist-electron/`（主进程），发布到 `release/` |

**定位**：一句话生成项目 → 沙箱构建 → 命令交互 → 调试测试，并集成了类 Claude Code 的代码能力与类 Hermes 的自进化能力。

---

## 2. 技术栈

### 主进程（Electron）
- **Electron 30.5** + Node 运行时
- **vite-plugin-electron / vite-plugin-electron-renderer** 构建主进程与预加载脚本
- **electron-log**（日志）、**electron-updater**（自动更新）
- **@webcontainer/api**（浏览器内运行时沙箱）
- MCP 运行时：`electron/mcp/`（transport + bin 子进程）

### 渲染进程（Vue 3）
- **Vue 3.4** + **Vite 6** + **TypeScript 5.9**
- **Pinia 2**（状态管理）、**vue-router 4**（路由）、**vue-i18n 9**（中英双语）
- **Element Plus 2.5**（按需自动导入，见 `unplugin-vue-components` + `ElementPlusResolver`）
- **Sass**（样式），**highlight.js**（代码高亮）、**marked**（Markdown 渲染）
- **docx**（文档生成）

### 质量与测试
- **Vitest 1.6** + `@vitest/coverage-v8`（单元/集成）
- **Playwright 1.61**（e2e，含 Electron 应用测试）
- **ESLint 9** + `typescript-eslint` + `eslint-plugin-vue`，**vue-tsc**（类型检查）

### 发布
- **electron-builder 26**（NSIS/DMG/AppImage），GitHub 发布通道

---

## 3. 项目规模统计

| 目录 | 文件数 | 代码行数（主要语言） | 说明 |
|------|-------:|--------------------:|------|
| `electron/` | 197 | ~30,635（TS） | 主进程全部逻辑 |
| `src/` | 75 | ~23,244（Vue/TS） | 渲染进程界面与状态 |
| `tests/` | 110 | ~17,504（TS/JS） | 单测/集成/e2e |
| `docs/` | 139 | — | 设计评审、用户手册、回顾、计划 |
| `scripts/` | 63 | — | 构建/发布/测试/性能脚本 |
| `coverage/` | 270 | — | 测试覆盖率报告（生成物） |
| `dist/` `dist-electron/` | 65 / 4 | — | 构建产物 |
| 其他 | — | — | `skills/` `types/` `bin/` `sandbox/` `resources/` `release/` |

> 测试拆分：e2e 32 个 spec、unit 63 个、integration 13 个（CHANGELOG 显示累计 100 个 e2e，含 64 个真实用户旅程场景）。

---

## 4. 目录结构总览

```
piclaw/
├── electron/            # 主进程（TypeScript，190+ 文件）
│   ├── core/            # 窗口/IPC/日志/快捷键/托盘/配置/更新
│   ├── agent/           # Agent 大脑 + 工具集（21 文件）
│   ├── chat/            # ChatManager 对话管理
│   ├── openclaw/        # OpenClaw 网关/服务/执行器
│   ├── hermes/          # Hermes 记忆与检索（自进化）
│   ├── learning/        # 自我学习引擎（SelfLearner）
│   ├── skill/           # 技能加载/创建/市场/链路/版本
│   ├── task/            # 任务执行引擎
│   ├── sandbox/         # P7 沙箱（Docker/WebContainer/Jupyter）
│   ├── mcp/             # MCP 服务器管理
│   ├── channel/         # IM 通道（飞书/钉钉/企微等 11+）
│   ├── models/          # 模型管理/评分/用量
│   ├── permissions/     # 权限配置（安全/标准/开放/自定义）
│   ├── contentgen/      # 内容生成（13 文件）
│   ├── computeruse/     # 计算机使用（D1 截屏等，5 文件）
│   ├── insight/         # 洞察模块（8 文件）
│   ├── connector/       # 连接器（日历等）
│   ├── contracts/       # CapabilityRegistry 能力注册
│   ├── runtime/         # IpcBridge 运行时桥接
│   ├── llm/  browser/  automation/  types/  utils/
│   ├── main.ts          # 主入口
│   └── preload.ts       # 预加载脚本
├── src/                 # 渲染进程（Vue 3）
│   ├── views/           # 26 个页面（对话/技能/设置/模型/任务…）
│   ├── components/      # chat/common/layout/settings/skills/guide/schedule
│   ├── stores/          # Pinia（12 个 store）
│   ├── locales/         # zh-CN / en-US
│   ├── styles/          # scss + tokens.css
│   ├── router/          # 路由配置
│   ├── utils/           # 错误人性化/Toast
│   ├── App.vue  main.ts  types/api.d.ts
├── docs/                # 文档（见第 12 节）
├── scripts/             # 构建/发布/测试/性能脚本
├── tests/               # 单元/集成/e2e
├── vite.config.mts      # 构建配置
├── electron-builder.json5  # 打包配置
├── package.json  tsconfig.json  vitest.config.ts  playwright.config.ts
└── index.html
```

---

## 5. 主进程架构（`electron/`）

### 5.1 核心基础设施 `core/`
`WindowManager`（窗口）、`IpcServer`（IPC 处理注册）、`LogManager`（日志）、`GlobalShortcut`（全局快捷键，含 D1 截屏）、`TrayManager`（托盘）、`MiniWindow`（迷你窗）、`ConfigStore`（配置存储）、`AutoUpdater`（自动更新）。

### 5.2 Agent 引擎 `agent/`（21 文件）
核心自进化大脑，能力对标 Claude Code：
- `AgentBrain` / `LlmAgentBrain`（LLM 驱动思考，provider 未配置时降级 stub）
- `ExecutionEngine`（执行引擎）、`ToolRegistry`（工具注册）、`tools/`（Bash/Edit/Glob/Grep/Read + `_globInternals`）
- `ParallelScheduler`（并行调度）、`SubAgentSpawner`（子代理孵化）
- `ContextCompressor`（上下文压缩）、`PromptBuilder`、`AgentThinking`、`AgentEventBus`
- `RetryPolicy`、`ErrorClassifier`、`AgentRecovery`、`AgentCheckpoint`
- `AgentMetrics`、`AgentLogger`、`AgentConfig`、`AgentTypes`、`ToolSandboxAdapter`

### 5.3 对话与网关
- `chat/ChatManager`：对接 AgentBrain，流式响应
- `openclaw/`：`OpenClawGateway`（内置 HTTP 网关，启动时自动拉起）、`OpenClawServer`、`OpenClawExecutor`

### 5.4 Hermes 自进化记忆 `hermes/`
`HermesMemory` + `HermesAdapter`（记忆桥接）、`EmbeddingService`（向量化）、`KeywordRetriever`（关键词检索）、`MemoryVectorStore`（向量库）。配合 `learning/SelfLearner` 与 `SkillEffectivenessTracker` 实现行为观察→模式识别→技能生成。

### 5.5 技能系统 `skill/`
`SkillManager`、`SkillLoader`、`AutoCreator`（自动创建技能）、`ClawHubManager`（技能市场）、`SkillChain`（技能链）、`SkillVersioning`、`SkillSigner`、`HermesImporter`、`SkillSandboxStub`，以及 `builtin/`（D1 截屏问答、D5 录屏转技能）。

### 5.6 任务执行 `task/`
`TaskExecutor`（执行器）、`InstructionGenerator`（指令生成）、`ContentValidator`（内容校验）、`ScheduleTask`（定时任务）、`TaskExecutionMode`（执行模式）、`TaskLog`、`TaskTypes`。

### 5.7 沙箱 `sandbox/`（P7）
`SandboxBuilder`（4 模板：Vite-React-TS / Next.js / FastAPI / Go HTTP）、`PortForwarder`、`WebContainerRunner`、`JupyterRunner`、`SandboxLifecycle`、`SandboxL1`、`dockerDetector`、`networkPolicy`、`resourceLimits`、`proxy`、`workspace`、`SandboxAgentTool`、`templates/`。

### 5.8 通道与集成
- `channel/`（20 文件）：`ChannelRouter`、`IMMessageRouter/Store`、`IMSecurityManager`、`IMPermissionManager`、`FileTransferManager`、`IMConfigStore`；实现飞书、钉钉、企业微信（真实）+ 微信/QQ/Telegram/Slack/Discord/WhatsApp/Lark/Rocket（占位）。
- `mcp/`：`McpManager`、`transport/`、`bin/`、`types.ts`
- `connector/`：`CalendarConnector`
- `contentgen/`（13 文件）、`computeruse/`（5）、`insight/`（8）

### 5.9 模型与权限
- `models/`：`ModelManager`、`ModelConfig`、`ModelProvider`、`ModelRatingManager`、`ModelUsageTracker`（支持 OpenAI / Anthropic / 智谱 GLM）
- `permissions/`：`PermissionConfig`（安全 / 标准 / 开放 / 自定义 4 套模板，首次启动最小权限）

### 5.10 启动编排 `main.ts`
`app.whenReady` 中依次：菜单 → IPC 注册 → AutoUpdater handler → 主窗口 → 全局快捷键 → 托盘 → 权限 → 配置 → OpenClaw 网关 → 自动更新，并串接 W3+ 子系统（IpcBridge / HermesAdapter / CapabilityRegistry / AgentBrain→ChatManager / D1 / D5 / MCP 自动启动）。退出时优雅停止网关与 MCP。

---

## 6. 渲染进程架构（`src/`）

### 6.1 页面视图 `views/`（26 个）
- 业务页：Dashboard（首页）、Chat（对话）、SkillsView（技能管理）、SkillMarket（技能市场）、ClawHub（ClawHub 市场）、Tasks（任务）、PluginMarket（插件市场）、Schedule（计划任务）、ImAccounts / ImManagement、Models、ModelCompare、LlmConfig、Permissions、RemoteControl、Settings、Help
- 演示页（devOnly）：D1ScreenshotDemo、D2PrimeDemo、D3RemoteDemo、D5RecordingToSkill、A5ComputerUseDemo

### 6.2 组件 `components/`
`chat/`（ChatInput/Sidebar/TaskExecutionPanel/ThinkingBlock/HermesMemoryDrawer 等）、`common/`（CommandPalette/StatusIndicator/UpdateBanner 等）、`layout/`（AppLayout/SideNav/TitleBar/Breadcrumb）、`settings/`（McpServerCard/ShortcutRecorder）、`skills/`（SkillCard/SkillImportDialog）、`guide/`（FirstLaunchGuide）、`schedule/`（CronPicker）。

### 6.3 状态管理 `stores/`（Pinia，12 个）
`app`、`chat`、`executionMode`、`gateway`、`guide`、`hermesMemory`、`modelRouter`、`models`、`openclaw`、`permissions`、`schedule`、`skill`。

### 6.4 其他
- `router/index.ts`：`createWebHashHistory`，含 devOnly 路由守卫（生产重定向首页）
- `locales/`：zh-CN / en-US 双语
- `styles/`：reset.scss / global.scss / variables.scss / tokens.css
- `utils/`：humanizeError / toast / useHumanError

---

## 7. 构建与脚本

### npm scripts（关键）
| 命令 | 作用 |
|------|------|
| `npm run dev` | Vite 开发（HMR） |
| `npm run build` / `build:win` | Vite 构建 + electron-builder 打包 |
| `npm run typecheck` | vue-tsc 类型检查 |
| `npm run lint` | ESLint 修复 |
| `npm test` / `test:coverage` | Vitest 单元/集成 + 覆盖率 |
| `npm run smoke` / `smoke:full` | 冒烟测试 |
| `npm run perf` / `perf:full` / `perf:sse` | 性能基准 |
| `sandbox:build-base` / `sandbox:selfcheck` / `sandbox:validate` | 沙箱构建与自检 |
| `npm run docs:list` | 列出文档 |

### `vite.config.mts` 要点
- `copyMcpBinPlugin`：将 `electron/mcp/bin/*.mjs` 复制到 `dist-electron/mcp/bin/`
- `unplugin-vue-components` + `ElementPlusResolver`：Element Plus **按需自动导入**（降低 vendor 体积）
- `manualChunks`：框架（vue/pinia/vue-router）单独分块
- `/ollama` 代理到 `localhost:11434`（绕过 CORS 用于 E2E）

### `electron-builder.json5` 要点
- `appId: com.pipiclaw.app`，`productName: PiPiClaw`
- Windows：NSIS（x64，可改安装目录，桌面/开始菜单快捷方式）
- macOS：DMG（x64 + arm64）
- Linux：AppImage（x64）
- 发布：`github` 通道（owner `chichengzibu`，repo `pipiclaw`）
- `asar: true`，`compression: maximum`

---

## 8. 路由与页面导航

| 路由 | 页面 | 标题 |
|------|------|------|
| `/dashboard` | Dashboard | 首页 |
| `/chat` | Chat | 对话 |
| `/skills` | SkillsView | 技能管理 |
| `/skill-market` | SkillMarket | 技能市场 |
| `/clawhub` | ClawHub | ClawHub 技能市场 |
| `/tasks` | Tasks | 任务 |
| `/schedule` | Schedule | 计划任务 |
| `/models` | Models | 模型 |
| `/model-compare` | ModelCompare | 模型对比 |
| `/settings/llm-config` | LlmConfig | LLM 配置 |
| `/permissions` | Permissions | 权限 |
| `/plugin-market` | PluginMarket | 插件市场 |
| `/remote-control` | RemoteControl | 远程控制 |
| `/im-management` | ImManagement | IM 管理 |
| `/settings` | Settings | 设置 |
| `/help` | Help | 帮助 |
| demo（devOnly） | D1/D2/D3/D5/A5 | 演示 |

---

## 9. 关键子系统详解

1. **Hermes 自进化**：用户操作被观察记录 → 模式识别 → 自动生成可复用技能（重复 3 次类似操作触发提案）；记忆以向量 + 关键词双路检索，支持语义触发与热加载。
2. **OpenClaw 网关**：内置 HTTP 服务，应用启动自动拉起，作为对话/工具调用的本地网关。
3. **P7 沙箱**：Docker base 镜像 + 4 个工程模板 + 端口转发 + WebContainer + Jupyter 运行器，支撑「一句话生成项目并构建调试」。
4. **MCP**：`McpManager` 管理 MCP 服务器生命周期，支持 enabled 服务器随应用自动启动，UI 可查工具数。
5. **IM 通道**：11+ 通道（3 真实 + 8 占位），统一消息路由、安全与权限管理。
6. **Agent 引擎**：LLM 驱动思考（`LlmAgentBrain`），含工具集、子代理、并行调度、重试/恢复、上下文压缩，对标 Claude Code 代码能力。
7. **执行模式**：安全（全确认）/ 计划（预览后执行）/ 全量（自动执行，仅高危确认）/ 自定义。

---

## 10. 测试体系

- **Vitest**（unit 63 + integration 13）：任务执行、权限、技能、模型等核心逻辑
- **Playwright e2e**（32 spec，累计 100）：真实用户旅程（首次启动、日常对话、模型 CRUD、ClawHub 浏览、拖拽、主题、重启持久化等 64 个场景）
- **覆盖率**：`coverage/`（HTML 报告），`@vitest/coverage-v8`
- **冒烟/性能**：`scripts/smoke-test.mjs`、`perf-benchmark.mjs`
- CHANGELOG 记录 v4.3.1 已达 ship-ready（64 e2e + 869 unit + 22 smoke）

---

## 11. 文档资源索引（`docs/`，139 文件）

| 子目录/文件 | 内容 |
|------|------|
| `docs/site/` | 公开文档站点：architecture（overview/ipc/extension）、user-guide（getting-started/user-guide/faq/troubleshooting）、contributing、README |
| `docs/superpowers/retros/` | 阶段回顾（W1-W6、A/B/C 验证、real LLM、Phase 1-5） |
| `docs/superpowers/plans/` | 实施计划（v2、real LLM、Phase 1/3） |
| `docs/superpowers/specs/` | 设计文档（v2 design、A/B/C 验证设计） |
| `docs/redesign-*` | 2.1 / 2.1.1 / 2.1.2 系列设计提案与评审（self/designer/final review） |
| `docs/perf/` | 性能基线 `baseline.md` |
| `docs/release/`、`release-process.md` | 发布流程与发布物料 |
| `docs/audit/`、`e2e-testing.md`、`llm-quirks.md` | 审计、e2e 测试、LLM 行为笔记 |
| `docs/CHANGELOG-INDEX.md` | 变更日志总索引 |
| `CHANGELOG.md`（根） | 版本变更（最新 v4.3.1 ship-ready） |

现有顶层 README.md 已含功能特性、快速开始、使用教程、API（IPC/技能定义）、开发指南与文档索引。

---

## 12. 版本与发布状态

- 当前开发版本：**v4.5.0-alpha**（含 dogfooding 脚本与自进化/IM 集成）
- 已发布：**v4.4.0**（release 物料 `release-payload-v4.4.0.json`、`release-body-v4.4.0.md`）
- 发布通道：GitHub Releases（`owner: chichengzibu / repo: pipiclaw`）
- 自动化脚本：`scripts/prep-release-*.py`、`publish-release-*.py`、`get-release-id.py`

---

## 13. 关键观察与建议

- **代码规模健康**：主进程 ~3 万行、渲染 ~2.3 万行、测试 ~1.75 万行，测试与生产代码比约 1:3，质量投入显著。
- **架构分层清晰**：主进程按能力（agent/hermes/skill/sandbox/channel/mcp）垂直拆分，渲染进程按视图/组件/store 分层，耦合度可控。
- **能力完整度高**：对话、技能自进化、沙箱构建、IM 通道、MCP、多模型路由、权限体系齐备，符合「一句话生成项目 + 自进化」的定位。
- **可关注点**：
  - `electron/runtime/` 目录当前为空（仅 `bridge/IpcBridge` 实际在 `electron/runtime/bridge/`），文档与代码略有出入。
  - 部分 IM 通道为 placeholder（微信/QQ 等），如需商用需补齐实现。
  - `coverage/` 与 `dist/` 为生成物，建议纳入 `.gitignore` 或 CI 缓存，避免误提交。

---

*记录生成方式：结构扫描（find/文件计数）+ 关键配置读取（package.json / vite.config.mts / electron-builder.json5 / 路由 / main.ts）+ 模块目录抽样。*
