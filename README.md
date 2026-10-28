# PipiClaw - 桌面 AI 自动化助手

基于 Electron + Vue 3 + OpenClaw 的国产桌面 AI 自动化助手，具有自我学习能力。

## ✨ 功能特性

### 🎯 核心功能
- **智能对话** - 自然语言交互，流式响应
- **任务执行** - 自动解析用户指令为可执行步骤
- **文件系统操作** - 读写、创建、删除文件，目录操作
- **Shell 命令执行** - 运行系统命令
- **剪贴板管理** - 读取和写入剪贴板
- **URL 打开** - 快速打开网站

### 🧠 Hermes 自我学习
- **行为观察** - 自动记录用户操作模式
- **模式识别** - 识别重复操作模式
- **技能生成** - 自动生成可重用技能
- **语义触发** - 自然语言匹配技能触发条件
- **热加载** - 新增技能无需重启

> **渐进披露的技能机制**（依据 Anthropic Agent Skills 规范）
> - **L1 常驻** — 技能的 `name` + `description` + `when_to_use` 始终可见（约 100 token/技能），
>   它本身就是模型的路由依据（description 写得含糊，技能就不会被触发）
> - **L2 按需** — 模型判断相关时调 `load_skill` 工具加载完整正文
> - **L3 资源** — `references/` `scripts/` `assets/` 按需 Read / Bash（优先跑脚本而非让模型重写逻辑）
> - 技能文件为 `SKILL.md` + frontmatter（`name` / `description` / `when_to_use`），
>   兼容旧的 `skill.md` 中文小节格式

> **学习闭环接的是真实执行，不是聊天文本**（依据业界轨迹级学习共识）
> - **轨迹捕获** — agent tool loop 与任务流每次执行都留下结构化轨迹（每步带成败），
>   不再靠中文正则猜「这次有没有执行」
> - **重复即信号** — 同一条指令重复出现会被**计数**而非丢弃 —— 反复做同一件事
>   恰恰是「值得固化成技能」的强度信号
> - **失败也留** — 失败样本保留并归类（权限 / 超时 / 不存在 / 限流 / 解析 / 上下文超限…），
>   事故可以转成评测用例，而不是消失
> - **提案带证据** — 技能提案会展示「证据链」：观察到几次、成功/失败几次、
>   归纳出的共同步骤、来自哪些执行。**支持度与成功率只是「值得学」的必要条件，
>   不是「这个技能有用」的结论** —— 真正的效用需要「带/不带该技能」的对照结果
> - **效果可查** — 「技能管理」页有「效果统计」面板：调用次数、成功率、判定标签。
>   判定基于绝对成功率，**仅作提示，不会自动禁用任何技能**
> - **边际效用可查** — 同类面板给出「带该技能 vs 同类别不带」的成功率差值。
>   这是比绝对成功率强得多的判据（绝对成功率低可能只是任务难）。
>   它是**观察性对比而非受控实验**，故只作提示，不做自动处置

### 🛠️ 技能管理
- **技能导入** - 从文件或 URL 导入技能
- **技能市场** - 浏览和使用社区技能
- **技能卡片** - 查看技能详情、启用/禁用
- **自动提案** - 发现新操作模式时自动显示提案

### ⚙️ 系统配置
- **模型管理** - 支持 OpenAI、Anthropic、智谱 GLM 3 种 LLM provider,通过 `/settings/llm-config` 配置 apiKey
- **IM 账号** - 飞书、钉钉、企业微信 3 个真实通道 + 8 个 placeholder(微信/QQ/Telegram/Slack/Discord/WhatsApp/Lark/Rocket),通过 `/settings/im-accounts` 配置
- **P7 沙盒** - Docker base 镜像 + SandboxBuilder 4 模板(Vite-React-TS / Next.js / FastAPI / Go HTTP) + PortForwarder + WebContainerRunner + JupyterRunner
- **权限管理** - 安全模式/标准模式/开放模式/自定义
- **MCP 配置** - 管理 Model Context Protocol 服务器
- **记忆管理** - Hermes 记忆系统
  - **真向量召回**（可选后端） — 「设置 → 记忆 → 嵌入后端」可切换本地 Ollama / OpenAI / 智谱。
    默认是**伪向量**（SHA-256）：相似文本的相似度是随机的，检索等于随机取 N 条 ——
    界面会如实标注这一点。启用真向量后界面会做**语义自检**
    （相近文本是否确实比无关文本更相似），实测改写查询的 top-1 命中率从 0/6 升到 6/6
- **快捷键** - 全局快捷键配置
- **执行模式** - 安全/计划/全量模式

### 📊 任务管理
- **任务历史** - 完整的执行记录
- **任务重试** - 失败任务一键重试
- **任务导出** - 导出对话和任务记录
- **定时任务** - Cron 调度自动化任务
- **实时监控** - 任务执行过程可视化

## 🚀 快速开始

### 系统要求
- Node.js 18+
- npm 9+

### 安装依赖
```bash
npm install
```

### 开发运行
```bash
npm run dev
```

### 构建发布
```bash
# 构建所有平台
npm run build

# 仅构建 Windows
npm run build:win
```

## 📖 使用教程

### 1. 首次启动
1. 启动应用后，进入「设置」页面
2. 配置你的 AI 模型（支持 OpenAI、Anthropic、智谱 GLM）
3. 根据需要配置权限（首次建议使用「标准模式」）
4. 返回「对话」页面开始使用

### 2. 对话与任务执行
#### 简单对话
```
用户：你好！
助手：你好！我是 PipiClaw，你的 AI 自动化助手。有什么我可以帮你的？
```

#### 执行文件操作
```
用户：在桌面上创建一个名为 test.txt 的文件，内容是 Hello World
```

系统会：
1. 解析用户指令
2. 生成任务步骤
3. 要求权限确认（如需要）
4. 执行并显示结果

#### Shell 命令
```
用户：列出当前目录的所有文件
用户：ping localhost
```

### 3. 技能使用与创建

#### 使用已导入的技能
1. 在「技能管理」页面查看可用技能
2. 确认技能已启用
3. 在对话中使用相关关键词触发

#### 自我学习流程（自动创建技能）
1. 重复执行 3 次类似的操作（如整理文件、重命名等）
2. 系统自动识别模式
3. 在技能管理页面显示提案横幅
4. 查看提案详情，确认无误后保存
5. 新技能自动生效

示例：
```
第1次：把桌面的 PDF 文件移动到 D:/Documents/PDF
第2次：把桌面的 Word 文件移动到 D:/Documents/Word
第3次：把桌面的图片移动到 D:/Pictures
→ 系统自动生成「自动文件分类整理」技能
```

### 4. 执行模式

#### 🔒 安全模式
- 所有操作需要手动确认
- 无自动执行
- 最安全选项

#### 📝 计划模式
- 显示执行计划预览
- 可编辑计划
- 确认后执行

#### 🚀 全量模式
- 自动执行所有操作
- 仅高危操作确认
- 最快速选项

### 5. 权限配置

#### 预设模板
- **安全模式** - 只读权限，禁止写入和执行
- **标准模式** - 常用功能开放，高危操作受限
- **开放模式** - 完全权限，无限制
- **自定义模式** - 精细控制每个权限类别

#### 自定义权限
可以单独控制：
- 文件系统（只读/写入/执行）
- 网络请求
- Shell 命令
- 剪贴板
- 系统操作
- 进程管理

### 6. 模型配置

#### 支持的供应商
- OpenAI (GPT-4, GPT-3.5)
- Anthropic (Claude 3)
- 智谱 GLM (GLM-4, GLM-3-Turbo)

#### 配置步骤
1. 进入「设置 → LLM 配置」页面(`/settings/llm-config`)
2. 选择供应商类型(OpenAI / Anthropic / 智谱 GLM)
3. 填写 API Key、Base URL、模型名
4. 测试连接成功后保存
5. 选择默认模型用于对话路由

### 7. MCP 服务器配置

1. 在「设置 → MCP 配置」页面
2. 点击「添加 MCP 服务器」
3. 填写服务器名称、命令、参数
4. 配置环境变量（可选）
5. 测试连接
6. 保存并启用

## 📂 项目结构

```
piclaw/
├── electron/              # 主进程代码
│   ├── agent/           # Agent 执行内核
│   │   ├── LlmAgentBrain.ts   # tool-call 循环(生产链路)
│   │   ├── ContextEngine.ts   # 上下文预算 + 三级降级
│   │   ├── ToolGate.ts        # 工具权限门(fail-safe)
│   │   ├── McpToolAdapter.ts  # MCP 工具适配
│   │   ├── RetryPolicy.ts     # 重试 + full-jitter 退避 + 熔断
│   │   └── AgentEventRelay.ts # 运行事件中继(接会话归属)
│   ├── chat/            # 聊天管理器
│   ├── core/            # 核心基础设施
│   ├── hermes/          # Hermes 记忆系统
│   ├── learning/        # 自我学习引擎
│   ├── mcp/             # MCP 客户端(stdio transport)
│   ├── models/          # 模型管理
│   ├── openclaw/        # OpenClaw 集成
│   ├── permissions/     # 权限管理
│   ├── platform/        # 平台抽象(win/mac/linux/ohos)
│   ├── skill/           # 技能加载器(渐进披露)
│   ├── task/            # 任务执行引擎
│   ├── types/           # 类型定义
│   ├── utils/           # 工具函数
│   ├── main.ts          # 主入口
│   └── preload.ts       # 预加载脚本
├── src/                 # 渲染进程代码
│   ├── components/      # Vue 组件
│   │   ├── chat/            # 输入区 / 工具调用轨迹 / 思考块
│   ├── views/           # 页面视图
│   ├── stores/          # Pinia 状态管理
│   ├── styles/          # 样式
│   ├── locales/         # 国际化
│   ├── router/          # 路由
│   └── App.vue          # 根组件
├── skills/              # 技能模板目录
├── tests/               # 测试
├── scripts/             # 脚本工具
└── package.json         # 项目配置
```

## 🎨 页面导航

- **仪表板** - 概览和快捷操作
- **对话** - 主要聊天和任务执行界面
- **任务** - 任务历史和监控
- **技能管理** - 技能列表和提案
- **技能市场** - 社区技能分享
- **插件市场** - 插件管理
- **定时任务** - Cron 调度
- **权限设置** - 权限配置
- **模型管理** - AI 模型配置
- **遥控** - 远程控制功能
- **帮助** - 使用说明
- **设置** - 系统设置

## 🔌 API 说明

### IPC 通信
前端通过 `window.electronAPI` 与主进程通信：

```typescript
// 发送消息
window.electronAPI.chat.sendMessage(conversationId, content, providerId, modelId)

// 加载技能
window.electronAPI.skills.list()

// 保存技能提案
window.electronAPI.learning.saveSkillProposal(proposal)

// 监听消息事件
const unsubscribe = window.electronAPI.chat.onMessage((data) => {
  console.log('收到新消息:', data)
})
```

### 技能定义
每个技能在 `skills/` 目录下有自己的文件夹，包含 `skill.md` 配置文件：

```markdown
# 技能名称

## 描述
技能描述文字

## 触发关键词
- 关键词1
- 关键词2

## 操作步骤
1. 步骤1
2. 步骤2
```

## 🛠️ 开发指南

### 代码规范
- 使用 TypeScript
- 遵循 Vue 3 Composition API 规范
- 使用 ESLint 检查代码

### 核心模块扩展

#### 添加新任务工具
在 `electron/task/TaskExecutor.ts` 中添加新的操作处理。

#### 扩展权限类别
修改 `electron/permissions/PermissionTypes.ts`。

#### 添加新的模型供应商
在 `electron/models/` 下添加新的供应商实现。

### 调试
- DevTools 可以通过顶部菜单打开
- 日志输出在 `console` 和日志文件中
- 日志文件位置：用户数据目录的 logs/ 文件夹

## 🤝 贡献

欢迎提交 Issue 和 PR！

## 📄 许可证

MIT License

## 🆘 支持与问题

如遇到问题，请查看：
1. 应用内「帮助」页面
2. 查看日志文件
3. 提交 Issue

## 📚 文档索引

### Retros(阶段回顾)
- [W1-W6 retro](docs/superpowers/retros/2026-07-15-w1-w6-retro.md)
- [A 5 demo real-env validation](docs/superpowers/retros/2026-07-16-a5demo-real-env/retros.md)
- [B IM account integration](docs/superpowers/retros/2026-07-16-b-im-account-integration/retros.md)
- [C sandbox validation](docs/superpowers/retros/2026-07-16-c-sandbox-validation/retros.md)
- [real LLM integration](docs/superpowers/retros/2026-07-17-real-llm-integration/retro.md)
- [real proxy wc jupyter](docs/superpowers/retros/2026-07-17-real-proxy-wc-jupyter/retro.md)
- [Phase 1 engineering hygiene](docs/superpowers/retros/2026-07-17-phase1-engineering-hygiene/retro.md)
- [Phase 2 vue-tsc zero errors](docs/superpowers/retros/2026-07-21-phase2-vue-tsc-zero/retro.md)
- [Phase 3 product quality](docs/superpowers/retros/2026-07-22-phase3-product-quality/retro.md)
- [Phase 4 cross-platform + auto-update](docs/superpowers/retros/2026-07-22-phase4-cross-platform/retro.md)
- [Phase 5 GA public release](docs/superpowers/retros/2026-07-22-phase5-ga/retro.md)

### 公开文档站点
- [docs/site/README.md](docs/site/README.md) - 文档中心入口
- [新手入门](docs/site/user-guide/getting-started.md)
- [用户手册](docs/site/user-guide/user-guide.md)
- [FAQ](docs/site/user-guide/faq.md)
- [故障排查](docs/site/user-guide/troubleshooting.md)
- [架构总览](docs/site/architecture/overview.md)
- [性能基准](docs/perf/baseline.md)

### Plans(实施计划)
- [v2 plan](docs/superpowers/plans/2026-07-10-pipiclaw-v2-plan.md)
- [real LLM integration](docs/superpowers/plans/2026-07-17-real-llm-integration.md)
- [real proxy wc jupyter](docs/superpowers/plans/2026-07-17-real-proxy-wc-jupyter.md)
- [Phase 1 engineering hygiene](docs/superpowers/plans/2026-07-17-phase1-engineering-hygiene.md)
- [Phase 3 product quality](docs/superpowers/plans/2026-07-21-phase3-product-quality.md)

### Specs(设计文档)
- [v2 design](docs/superpowers/specs/2026-07-10-pipiclaw-v2-design.md)
- [A demo validation design](docs/superpowers/specs/2026-07-16-a-5demo-real-env-validation-design.md)
- [B IM integration design](docs/superpowers/specs/2026-07-16-b-real-im-account-integration-design.md)
- [C sandbox validation design](docs/superpowers/specs/2026-07-16-c-sandbox-validation-design.md)

完整索引见 [docs/CHANGELOG-INDEX.md](docs/CHANGELOG-INDEX.md)。

---

**PipiClaw** - 让 AI 为你自动化一切！ 🎉
