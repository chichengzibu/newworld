# NOVA #008 — M4-B 学习闭环接线（观察端接真实执行 + 效果反馈）

> **状态**：已实现（2026-10-27）
> **对应台账**：DEV-049 ~ DEV-054
> **分支**：`feat/harness-wiring`
> **前置**：[NOVA #008 — M4-A 技能系统渐进披露改造](NOVA-#008-m4-skill-progressive-disclosure-design.md)

## 一、为什么做这件事

### 1.1 起点：M4-A 收尾时留下的两个洞

M4-A 修好了「技能怎么存、怎么被模型发现」，但自学习闭环仍是断的。审计出的两处断点：

| 断点 | 现象 | 后果 |
|---|---|---|
| 观察端只挂在旧管道 | `observeExecution` 只在 `TaskExecutor` 分支被调用 | **agent tool loop（最重要的能力路径）完全不产生学习数据** |
| 效果反馈零调用方 | `SkillEffectivenessTracker.record()` 全仓无调用方 | 「技能被调用后效果如何」这个信号从未被采集 |

一句话：**只记不反馈，学不到东西；只反馈没样本，无从反馈。** 两端都断着。

### 1.2 观察端本身的三个语义错误

除了「没接线」，旧观察端的实现还有三处会主动**污染**学习池的问题：

| 问题 | 旧实现 | 为什么错 |
|---|---|---|
| 门控靠中文正则 | `/(文件\|整理\|创建\|…)/.test(content)` 才记一条观察 | 用户说「整理一下思路」也会被记录，但没有任何执行发生；`steps` 恒为 `[]` → 分析器拿不到任何可学的操作序列 |
| 重复即丢弃 | 检测到重复指令就 `return` | 「重复」恰恰是**最该学的信号** —— 用户反复做同一件事 = 值得固化成技能。丢掉重复 = 把要学的东西扔了 |
| 只记成功 | `if (result.success)` 才观察 | 失败样本全丢。事故无法转成评测用例 |

外加一处「参数收进来就扔」：`observeExecution(instruction, steps, _result)` 的第三个参数
带下划线前缀（= 故意不用），**成败信息 100% 丢失**，分析器只能从文本猜。

### 1.3 效果反馈侧的两个空洞

| 空洞 | 现象 |
|---|---|
| tracker 有数据没人看 | `record()` 写进 `skill-stats.json`，但 `getStats`/`listAllStats`/`recommendRollback` **全部零调用方** |
| 技能卡上的统计是假的 | `SkillCard.vue` 渲染 `skill.usageCount` / `skill.successRate`，但 `SkillLoader.recordSkillUsage()` **零调用方** → 永远显示 `0 次使用 / 100% 成功率` |

用户看到的技能统计是**编造的**。这不是显示问题，是「数据采集了但没人用」的系统性空转。

## 二、设计依据（业界调研）

### 2.1 闭环四组件模型

学习闭环成立需要四个组件，缺一环则不成立：

| 组件 | 含义 | M4-B 前的状态 |
|---|---|---|
| ① 轨迹捕获 | 把执行过程记成**结构化轨迹** | 只有旧管道有，且 steps 恒空 |
| ② 结果追踪 | 记下每次执行的成功/失败 | `_result` 被丢弃，零信息 |
| ③ 诊断反馈 | 失败被**归类**，变成可统计信号 | 无 |
| ④ 效果反馈 | 「用完之后效果如何」被采集 | tracker 零调用方 |

### 2.2 按整条轨迹评分，而不是只看最终答案

> 「经由损坏的工具调用得到的正确答案是潜伏的生产事故」
> —— a correct answer reached through a broken tool call is a latent production incident

推论：**每一步的成败都要记**，不能只记最终答案。本批在轨迹里保留每步的 `ok` 标志。

### 2.3 保留失败，把事故转成评测用例

> 「保留失败 —— 把事故转成评测用例，而不是让它们消失」

失败样本是**最有学习价值的样本**，本批改为成功失败都观察，且失败必须带
「哪一步坏了 + 属于哪一类」。

### 2.4 失败类目：低基数、互斥、穷尽

`electron/learning/FailureClassifier.ts` 的类目设计：

- **低基数** —— 类目固定 9 个，自由文本只进 `message` 字段。
  高基数值会让「统计失败类型」退化成「统计失败字符串」。
- **互斥** —— 一次失败只归一类。匹配顺序按**特异性**排：
  `permission_denied` 优先于 `tool_error`（「permission denied, command failed」
  必须归权限类，不能被泛化的 tool 类抢走）。
- **穷尽** —— 永远有归属（兜底 `unknown`），不丢样本。

对齐参考：OpenTelemetry GenAI 语义约定中 `error.type` 是 tool span 上**唯一 Stable 的属性**，
且 MCP 工具调用失败时 `error.type` SHOULD 取 `tool_error` —— 本类目与之同名，便于日后接 OTel。

### 2.5 计数不要塌缩（support counts）

> 「support counts / helpful-harmful counters 是最小可用信号」
> —— ACE（Agentic Context Engineering）与 ALTK-Evolve 两个独立工作收敛到同一条

本批把「重复指令」从**丢弃**改成**计数**（`occurrences`），正是这条原则的落地：
重复不是噪声，是「这个模式值得固化成技能」的强度信号。

### 2.6 调研推翻了我原本打算做的一件事

原计划：把效果数据接进技能触发路径，效果差的技能自动降权。

**调研结论否决了这个做法**：

> 真正有害的判据是「带该技能 vs 不带该技能」的**成功率差值**为负（阈值 −0.1），
> 而非绝对成功率低 —— 绝对成功率低的技能可能只是任务本身难。
> —— FlowEvo 的对照实验

且：

> 「一万个平庸技能比十个高价值技能更糟；技能库需要按**效用**剪枝，不能按**时间**保留。」

**没有对照数据就没有边际效用。** 本批的绝对成功率判定**只做展示与告警，不做任何自动处置**。
自动回滚需要「带/不带该技能」的匹配任务对比 —— 那是 M4-C 的验证闸门。

## 三、实现

### 3.1 轨迹型观察（`electron/learning/SelfLearner.ts`）

观察条目从 `{instruction, steps, timestamp}` 升级为：

```ts
interface Observation {
  id: string
  instruction: string
  steps: any[]              // 每步带 ok 标志 —— 轨迹级而非结果级
  timestamp: number
  trajectoryId?: string     // 同一次执行可归并
  outcome?: 'ok' | 'fail' | 'partial'   // 成败不再丢失
  occurrences?: number      // 重复 → 计数,不丢弃
  failure?: { stepIndex?: number; type: string; message?: string }
  toolsUsed?: string[]
  source?: 'agent_loop' | 'task_executor' | 'chat'
}
```

三处语义修正：

| 修正 | 旧 | 新 |
|---|---|---|
| 重复 | 直接 `return` 丢弃 | `occurrences++`，并刷新 outcome / toolsUsed（工具取并集） |
| 结果 | `_result` 被丢弃 | `normalizeOutcome()` 归一：字符串 / 布尔 / `{success}` / `{steps[]}` 四种形态都成 `ok`/`fail`/`partial` |
| 失败 | 不记 | 记，且带 `failure.{stepIndex,type,message}` |

> **一处实现期发现的不一致**（由测试捕获）：刷新重复项时只读 `meta.outcome`，
> 忽略 `result` 派生的 outcome —— 语义变成「第一次的结果说了算」，
> 与「最新一次执行说了算」矛盾。已修为 `meta.outcome ?? normalizeOutcome(result)`。

### 3.2 观察端接到真实执行（`electron/chat/ChatManager.ts`）

| 路径 | 改前 | 改后 |
|---|---|---|
| agent tool loop | **无观察端** | `recordAgentOutcome()`：轨迹 + 结果 + 失败诊断 + 效果反馈 |
| TaskExecutor 任务流 | 只记成功 | 成功失败都记，失败带诊断 |
| 普通对话流 | 中文正则门控 → 记一条 `steps:[]` | **不再产生技能学习样本**（没有执行就没有可学的东西） |

> 对话记忆（`hermes.addConversationMemory` + 向量沉淀）**保留** ——
> 「记住聊过什么」与「学技能」是两件事，不该一起砍。

### 3.3 失败分类器独立成模块（`electron/learning/FailureClassifier.ts`）

原先挂在 `SelfLearner.classifyFailure` 静态方法上，有两个问题：

1. **测试耦合** —— 单测常把 `SelfLearner` 整个 mock 掉，静态方法随之消失，
   调用点直接 TypeError。而学习是旁路，不该有能力把主流程带崩。
2. **职责错位** —— 分类失败是纯函数，与「自我学习」这个有状态单例无关。

现为独立纯函数：无 Electron 依赖、可穷举测试、零 mock。

### 3.4 效果反馈 + 判定（`electron/learning/SkillEffectivenessTracker.ts`）

| 能力 | 说明 |
|---|---|
| `unitType` 标注 | 记录的是「可复用的工作单元」，目前有 `tool` / `skill` 两类。**工具名不是技能名** —— 混在一起会污染技能的效用统计 |
| `getVerdict()` | 低基数判定：`untested` / `insufficient_data` / `healthy`(≥80%) / `degraded`(50~80%) / `harmful`(<50%)。样本 < 3 次不下结论 |
| `listAllVerdicts()` | 按严重度排序（harmful 在最前） |
| 落盘去抖 | **M4-B 引入的必要修复**：原实现每次 `record()` 同步全量写盘。此前 `record()` 零调用方所以无所谓；接成主链路后，一次 10 步任务 = 10 次同步全量写 = 主进程被 IO 卡住。现改为去抖 500ms + `flush()` 显式落盘 |

### 3.5 效果判定的读取方（此前一个都没有）

- **IPC**：`skills:getEffectiveness` → `listAllVerdicts()`
- **preload**：`skills.getEffectiveness()`
- **UI**：`SkillsView.vue` 新增「效果统计」折叠面板 —— 名称 / 类型 / 调用次数 / 成功率 / 判定标签

面板下方明写口径：「判定基于绝对成功率……『表现不佳』仅作提示，不会自动禁用任何技能」。

### 3.6 容错红线（实现期踩到并修复）

学习是**旁路**，不是主链路的一部分。前一版把 `observeExecution` 裸调，
一旦它抛错（哪怕只是被单测 mock 掉一个静态方法），整个任务流就抛 →
被上层 catch → **回退普通对话流** → 用户看到的是「LLM 连不上」这种无关错误，
而真正的失败原因（任务被拒 / 命令失败）被吞掉了。

这违反 #006.5 W1 立的「catch→log, 不阻塞 chat 主流」红线。

**回归症状**：`tests/unit/chat-execution-ui.test.ts` B-3 从 241ms 变成 21s 后 `ECONNRESET`。
现：整块兜住，任何异常只记日志，主流程结果一字不改。

## 四、验证

| 项 | 基线 | 现在 |
|---|---|---|
| vitest | 106 files / 1253 passed + **2 FAIL** | **108 files / 1287 passed / 0 FAIL** |
| 后端 typecheck | 30 error | **30 error（零新增）** |
| 前端 vue-tsc | 0 | **0** |

新增测试：

| 文件 | 例数 | 覆盖 |
|---|---|---|
| `tests/unit/learning-trajectory-m4b.test.ts` | 17 | 失败分类器 9 类目 + 互斥 + 低基数；轨迹型观察（计数/归一/失败保留/元信息/刷新语义） |
| `tests/unit/chat-m4b-learning-wiring.test.ts` | 5 | agent loop 接线：轨迹观察 / 效果反馈 / partial-fail 诊断 / 全失败 / 旁路不反噬主链路 |
| `tests/unit/SkillEffectivenessTracker.test.ts` | +8 | 判定五档 + unitType + 排序；落盘去抖（突发合并成一次写）+ flush |

同时修复的存量失败（非本批引入，基线复现）：

- `tests/unit/error-recovery.test.ts`「重试间隔在指数窗口内」——
  原用**墙钟**量退避间隔，测的是「操作系统定时器精度」而非「退避策略对不对」。
  Windows 定时器粒度 ~15.6ms，请求 5ms 实测 12~18ms > 断言上限 10ms。
  改为两层：① 注入 `sleep` 捕获**请求的退避时长**做确定性断言；
  ② 真实 `setTimeout` 只验「确实等了」且上界按 OS 粒度放宽。
  另补 `computeBackoffDelay` 纯函数的穷举断言（原先只在一个随机值 0.5 上验证，漏了 random=0 与窗口截断）。

## 五、遗留与后续

| # | 遗留 | 归属 | 依据 |
|---|---|---|---|
| 1 | **技能级效用未接** —— 现在记的是**工具级**成败。「应用了技能 S 之后任务是否成功」需要 run 携带「本次实际应用的技能列表」，当前 agent 载荷的 `toolCalls` 只有 `{name, ok, durationMs}`，没有参数 | M4-C | §2.6：没有对照数据就没有边际效用 |
| 2 | **验证闸门缺失** —— 技能提案仍由 LLM 从观察文本自行生成。业界实测「自生成技能平均收益接近零甚至为负」，**瓶颈在生成与验证，不在存储** | M4-C | ACE / SkillsBench / AGENTS.md 论文 |
| 3 | **`SkillCard.vue` 的 `usageCount`/`successRate` 仍是假值** —— `SkillLoader.recordSkillUsage()` 零调用方，技能卡显示的「0 次使用 / 100% 成功率」是编造的 | M4-C | 需与 #1 的技能级信号一起修 |
| 4 | **Embedding 仍是 SHA-256 伪向量** —— 召回是噪声；三个后端代码都已存在，只差配置 | 后续 | M4-A 遗留 |
| 5 | **技能提案无对照实验** —— 提案采纳后没有「带/不带该技能」的成功率对照，无法回答「这个技能到底有没有用」 | M4-C | §2.6 |

## 六、参考资料

- ACE — Agentic Context Engineering（arXiv:2510.04618，ICLR 2026）· `github.com/ace-agent/ace`
  —— Generator/Reflector/Curator 三角色分工；support counts；避免 brevity bias 与 context collapse
- Anthropic《Equipping agents for the real world with Agent Skills》（2025-10）
  —— 渐进披露三层；description 即路由规则；自生成技能收益接近零，人工编辑才是价值所在
- OpenTelemetry GenAI 语义约定（`open-telemetry/semantic-conventions-genai`）
  —— `error.type` 是 tool span 上唯一 Stable 属性；MCP 工具失败取 `tool_error`
- FlowEvo —— 对照式评估：带/不带技能的成功率差值，低于 −0.1 判为有害
- SkillsBench / AGENTS.md 论文 —— 技能库按效用剪枝，不按时间保留；LLM 生成的知识文件平均为负
- SkillsBench 数据：49 个技能中 39 个无影响、3 个变差、仅 7 个改善
