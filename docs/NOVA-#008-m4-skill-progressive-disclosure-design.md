# NOVA #008 — M4-A 技能系统渐进披露改造（Hermes 学习带修复）

> **状态**：已实现（2026-10-25）
> **对应台账**：DEV-042 ~ DEV-048
> **分支**：`feat/harness-wiring`

## 一、为什么做这件事

### 1.1 起点：审计发现「能力已写就，从未接线」

`docs/audit/05-final-report.md` 在 2026-08-05 就写下了正确诊断：

> 「宣传与实际差距巨大」「Evolution 进化」实际 SelfLearner 只是统计

但后续两个月的执行方向落在 Orb 皮肤、Splash、联网搜索、语音输入等外围功能上，
「Agent runtime 对齐」始终没排进任何里程碑。

2026-10 起的 W5 接线批重新审计后，确认了三条平行的断裂带：

| 断裂带 | 性质 | 处置 |
|---|---|---|
| 执行带 | tool loop 完整但零生产调用方 | M1 已修（见 #005-B 之前的接线批） |
| **学习带** | Hermes 有 4 处独立断点，闭环 0% 可达 | **本单** |
| 流程带 | 治理开销吞噬交付节奏 | 流程侧调整 |

### 1.2 学习带的 4 处断点（彼此独立，修任一处用户仍无感）

| # | 断点 | 位置 | 后果 |
|---|---|---|---|
| ① | `triggerCondition` 恒 `undefined` | `SkillLoader.ts` | 「语义匹配」实际拿字符串 `'无'` 与用户输入作对照 |
| ② | skills 写读目录不一致 | `SelfLearner.ts:768` vs `SkillManager.getSkillsDir()` | 保存的技能永远扫不到；Program Files 只读 → EACCES |
| ③ | 提案订阅用 `window.require` | `SkillsView.vue:389` | `contextIsolation: true` → 订阅永不注册，横幅不可能出现 |
| ④ | `getSkillContext` 漏 `await` | `InstructionGenerator.ts:256` | 每轮 systemPrompt 注入字面量 `[object Promise]` |

## 二、设计依据（业界调研）

先调研后实现，比对对象：Anthropic《Equipping agents for the real world with
Agent Skills》（一手来源）、Claude Code 工程团队博客《Lessons from building
Claude Code: How we use skills》，以及多个社区实践指南。

### 2.1 核心模型：三层渐进披露

| 层 | 内容 | 何时加载 | 预算 |
|---|---|---|---|
| L1 | `name` + `description`（+`when_to_use`）frontmatter | 始终，启动时 | ~100 token/技能 |
| L2 | SKILL.md 正文 | 仅在技能触发时 | < 2000 字 / < 500 行 |
| L3 | `references/` `scripts/` `assets/` | 按需 Read / Bash | 无限 |

Anthropic 的比喻：「像一份组织良好的手册，先是目录，然后是具体章节，最后是详细附录」——
关键收益是**一份 5000 行的领域参考可以躺在磁盘上，在被需要之前不消耗任何 token**。

### 2.2 关键洞察：description 本身就是路由规则

模型在决定「要不要加载这个技能」时**只看得到 name + description**。
因此 description 不是文档，是**触发条件**。

规范的示例对比：

- ✅ `Extracts text and tables from PDF files, fills forms, merges documents. Use when working with PDF documents or when the user mentions PDFs, forms, or document extraction.`
- ❌ `Helps with documents`

社区共识的写法要点：
- 第三人称、祈使句（`Processes Excel files…` 而非 `I can help you…`）
- 「pushy」—— 把用户真实会说的词都塞进 description
- 主用例放最前（技能多时 description 会被截断）
- 全部「when to use」信息放 description，不埋在正文里

### 2.3 frontmatter 规范字段

| 字段 | 约束 |
|---|---|
| `name` | 必填，≤64 字符，小写连字符，与目录名一致 |
| `description` | 必填，≤1024 字符 |
| `when_to_use` | 额外触发上下文（与 description 一并呈现给模型） |
| `allowed-tools` | 限制技能可用的工具集 |
| `license` / `compatibility` / `metadata` | 可选 |

### 2.4 目录布局

```
my-skill/
├── SKILL.md          # frontmatter + 核心指令
├── references/       # 详细文档，按需 Read
├── scripts/          # 可执行脚本，按需 Bash
└── assets/           # 模板 / 图片
```

脚本很重要：「agent 直接执行脚本，这省 token 且消除了模型重写标准工具代码的变异」。

### 2.5 SKILL.md 正文的写法

- 控制在 500 行以内
- SKILL.md 是**目录不是手册** —— 细节移到 `references/`
- 写成 **runbook 而非散文**：何时用 → 怎么做 → 约束 → 示例
- 必带 **Gotchas** 段 —— 团队实践称之为「任何技能里信噪比最高的内容」
- 匹配任务脆弱度：灵活任务给轻量指引，脆弱任务（迁移/部署）给严格步骤或精确脚本

## 三、实现

### 3.1 解析层（`electron/skill/SkillLoader.ts`）

**frontmatter 扩展**：新增 `when_to_use`、`allowed-tools` 解析。

**小节分流精确化** —— 修掉三个误判：

| 小节 | 修前 | 修后 |
|---|---|---|
| `## 触发条件` | 与 `## 触发关键词` 同分支 → 整句成一个「关键词」 | 独立进 `whenToUse` |
| `## 关键词` | 侥幸正确 | 独立进 `triggerKeywords` |
| `## 示例` | 不匹配任何分支 → 落进 `steps` | 独立 section，不污染步骤 |
| `## Gotchas` | 无归属 | 独立 section |

**文件名单写**：`SKILL.md`（Anthropic 规范）与 `skill.md`（本项目历史）都认，优先大写。

**附属目录探测**：`hasReferences` / `hasScripts` / `hasAssets`。

**正文保真** —— `generateFullInstructions` 修前只重排
name+description+steps，**丢弃 Gotchas 段、约束条件与正文段落**。
现改为：有 steps 时给「结构化摘要 + 完整正文」，无 steps 时给完整正文。

### 3.2 渐进披露三层（`SkillLoader`）

```ts
getSkillSummaries(): string   // L1 —— 常驻注入 system prompt
getSkillBody(id): string      // L2 —— load_skill 工具按需调用
getSkillContext(msg): Promise<string>  // 旧管道用（无 tool loop）
```

`getSkillContext` 的**语义变更**：

- 旧：技能 ≤5 个全量注入；>5 个**对每个技能串行发一次 LLM 调用**
- 新：先给 L1 摘要；旧管道需要全文时，改为**单次** LLM 调用批量排序
  （`SelfLearner.rankSkillsByRelevance`），降级路径为纯关键词匹配

### 3.3 `load_skill` 工具（第 6 个内置工具）

```ts
execute({ skill_id }) → 技能正文 + 附属资源指引
```

- 只读操作 → `requiresPermission: false`
- 技能不存在 → 返回 `ok: false` **并列出可用技能**
  （关键：若返回 `ok: true`，模型会把错误提示当成技能内容照做）
- description 明确写「不要凭猜测执行技能步骤 —— 先加载，再照着做」

### 3.4 agent 侧接线

- `SYSTEM_PROMPT` 增加第 6 个工具说明 + 工作准则第 7 条
  （「若系统提示里有可用技能清单，且某技能与用户需求相关，先调 load_skill 拿到它的步骤再动手」）
- `run()` 时把 `getSkillSummaries()` 注入 system prompt（L1 常驻）

### 3.5 存储与通知（断点 ② ③）

| 项 | 修前 | 修后 |
|---|---|---|
| 保存路径 | `join(getAppPath(),'..','skills')` | `SkillManager.getSkillsDir()`（既有「路径单点」） |
| 保存文件名 | `skill.md` | `SKILL.md` |
| 提案订阅 | `window.require('electron').ipcRenderer` | preload 暴露 `learning.onNewProposal` |
| 退订 | `removeAllListeners`（会误杀其他监听） | 返回退订函数 |
| 冷启动漏单 | 无 | 补 `getPendingProposal()` 拉取 |

### 3.6 自学习生成器格式对齐（断点 ④ 关联）

`generateFullSkillInstructions` 从纯中文小节改为 frontmatter：

```
---
name: 目录文件整理
description: ...
when_to_use: 当用户要求目录文件整理时触发
---

## 关键词
- 整理
## 操作步骤
1. ...
## 示例
...
```

生成器与解析器从此用同一套语义，「生成 → 加载」链路真正闭合。

## 四、验证

| 项 | 结果 |
|---|---|
| `SkillLoaderProgressive.test.ts` | 11/11 |
| `LoadSkillTool.test.ts` | 7/7 |
| 全量 vitest | 106 files / 1253 passed / 0 FAIL |
| vue-tsc | 0 error |
| 后端 tsc（tsconfig.node.json） | 30（= 存量基线，零新增） |

## 五、遗留与后续

> **2026-10-27 更新**：前两项与「技能效果反馈」已由 [M4-B 学习闭环接线](NOVA-#008-m4b-learning-closure-design.md) 处理。

- ~~**观察端仍是中文正则门控**~~ → **M4-B 已修**：中文正则门控取消，
  普通对话流不再产生技能学习样本；去重改为计数（重复是最该学的信号）
- ~~**技能效果反馈未接线**~~ → **M4-B 已修**：`SkillEffectivenessTracker.record()`
  接入 agent loop 与 TaskExecutor 双路径，并新增判定 API + IPC + UI 面板
- **三套技能系统尚未统一**：`SkillLoader`（解析）/ `SkillManager`（增删改查，
  `executeSkill` 仍是 stub）/ `SkillRuntime`（registry + invoke，有真实
  permissionToken 检查）三者并存。本单只统一了「加载 + 注入 + 工具」这条主链
- **技能级效用未接**（M4-B 新增遗留）：M4-B 记的是**工具级**成败。
  「应用了技能 S 之后任务是否成功」需 run 携带「本次实际应用的技能列表」，
  当前 agent 载荷的 `toolCalls` 只有 `{name, ok, durationMs}` 无参数 → 后续批
- **Embedding 仍是 stub**：无配置时用 SHA-256 伪向量，召回是噪声。
  `EmbeddingService` 的 ollama/openai/zhipu 后端代码已存在，只差配置

## 六、参考资料

- [Anthropic: Equipping agents for the real world with Agent Skills](https://www.anthropic.com/research/equipping-agents-for-the-real-world-with-agent-skills) — 一手来源
- [Claude blog: Lessons from building Claude Code — how we use skills](https://claude.com/blog/lessons-from-building-claude-code-how-we-use-skills) — 团队实践
- [Claude Code Skills Best Practices: A Practical Guide (2026)](https://designrevision.com/blog/claude-code-skills-best-practices)
- [Mastering Claude Code Skills — 9 Principles from Analyzing the Top 100](https://stephenweber.io/blog/2021-02-29_Mastering-Claude-Code-Skills) — 数据驱动
- [The SKILL.md Format Explained](https://www.getclaudeskills.com/blog/skill-md-format-explained)
- [Agent Skill Best Practices](https://agentkit.best/blog/claude-code-guides/claude-code-skills-best-practices-build-reusable-ai-workflows)
