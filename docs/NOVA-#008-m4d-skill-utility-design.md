# NOVA #008 — M4-D 技能效用验证（这个技能到底有没有用）

> **状态**：已实现（2026-10-27）
> **对应台账**：DEV-060 ~ DEV-065
> **分支**：`feat/harness-wiring`
> **前置**：[M4-B 学习闭环接线](NOVA-#008-m4b-learning-closure-design.md) · [M4-C 模式证据链](NOVA-#008-m4c-pattern-evidence-design.md)

## 一、为什么做这件事

### 1.1 整个学习闭环的最后一问

M4-A 修好了「技能怎么存、怎么被发现」，M4-B 接通了「执行 → 学习数据」，
M4-C 让「提案带证据」。链条至此完整：

```
执行 → 轨迹 → 观察 → 候选模式 → 提案(带证据) → 用户采纳 → 技能生效
```

但链条**止于"技能生效"**。最后一步从没被回答：

> **这个技能，到底有没有让事情做得更好？**

答不了，不是因为没人想答，而是因为**数据里根本没有这个问题的答案**。

### 1.2 三处具体的缺口

| # | 缺口 | 后果 |
|---|---|---|
| ① | 数据里**没有"哪些技能被应用了"** —— 工具调用日志只有工具名，`load_skill` 是工具名，不是技能 id | 技能的效用无从谈起 —— 只有「某工具调了成没成」 |
| ② | 即使记下了，**绝对成功率也说明不了效用** | 用户可能专挑难活儿时才启用技能，那时成功率低是**任务难**，不是技能没用 |
| ③ | 「不带该技能」的运行**无法归类对比** | 没有任务类别，两组运行放不到同一把尺子上量 |

### 1.3 顺带发现：一个真 bug 让①永远成立

M4-D 接线时发现：`load_skill` 在 **headless 场景被直接拒绝**，
在 UI 场景**每加载一次技能就弹一次确认框**。

根因在 `ToolGate`（M2-B 引入）：

```ts
const declared = metadata.requiresPermission === true
const permission = declared ? 'confirm' : (DEFAULT_PERMISSIONS[name] ?? 'confirm')
```

`load_skill` 声明 `requiresPermission: false`（M4-A 明确注明「只读」），
但**不在 `DEFAULT_PERMISSIONS` 表里** → 落到兜底 `'confirm'`。

于是：**技能在 headless 下压根加载不了，在 UI 下要反复打断用户**。
M4-A 设计的「模型自己决定加载哪个技能」实际上从来没跑通过。

## 二、设计依据（业界调研）

### 2.1 核心结论：判据是差值，不是绝对值

> 真正有害的判据是「带该技能 vs 不带该技能」的**成功率差值**为负（阈值 −0.1），
> 而非绝对成功率低 —— 绝对成功率低的技能可能只是任务本身难。
> —— FlowEvo 的对照实验

> 「估计一个候选技能的**上下文相关边际效用**，方法是匹配 rollout 组之间的 reward gap
> （base skills vs base + one candidate）。这把瓶颈从生成挪到了验证。」
> —— arXiv:2606.08755《Co-Evolving Skill Generation and Policy Optimization》

本批据此实现**观察性**版本的差值对比（受控 rollout 留待后续，见 §五）。

### 2.2 技能库需要按效用剪枝

> 「一万个平庸技能比十个高价值技能更糟；技能库需要按**效用**剪枝，不能按**时间**保留。」

前提是效用可测。本批把这个前提补上。

### 2.3 交付方式影响结果

> ALTK-Evolve：交付不是"存储"问题 —— 小而高支持度的核心 + 按任务选取的扩展，
> 比一次性塞一整个 playbook 省得多。

推论：效用的呈现也应**按需**（折叠面板），而不是铺满界面。

## 三、实现

### 3.1 工具自己声明「我动了什么」（`ToolExecResult.appliedEntity`）

```ts
export interface ToolExecResult {
  ok: boolean
  result: string
  error?: string
  /** 【M4-D】本次执行"作用在哪个实体上" */
  appliedEntity?: { kind: string; id: string }
}
```

`LoadSkillTool` 加载成功时返回 `{ kind: 'skill', id: skillId }`；
**加载失败不声明**（没真应用就不该被记成"用了这个技能"）。

**设计取舍：为什么由工具自己报，而不是让 brain 读 `args.skill_id`**
—— 后者把工具的内部知识泄到编排层，每加一个作用于实体的工具就得改编排一次。
由工具声明、编排层只记录，是零特殊-case 的通用机制
（未来「应用工作流」「套用模板」同样适用）。

### 3.2 三段链

```
LoadSkillTool --声明--> ToolExecResult.appliedEntity
         ↓
LlmAgentBrain --汇总--> run().appliedSkills  →  think() payload
         ↓
ChatManager --记账--> tracker.record({ unitType:'skill', skillName, success, category })
```

brain 侧：`toolCallsLog` 条目新增 `entity?` 字段；`run()` 返回值新增 `appliedSkills: string[]`
（去重）；载荷随之上抛。

### 3.3 任务类别（`electron/learning/TaskCategory.ts`）

对比的两侧必须用**同一套**归一规则，否则对比组会漏记录。故抽成单一实现，
`SelfLearner`（观察去重）与 `ChatManager`（记账）都从这里取。

只做**表面形式**归一（大小写/标点/空白），不做语义归一 ——
语义归一需要 embedding，而当前 embedding 仍是伪向量（遗留项）。
代价：「整理桌面」与「清理桌面」算两个类别 → 样本量偏少，
但**口径诚实**比「看起来样本多」重要。

### 3.4 边际效用（`SkillEffectivenessTracker.getMarginalUtility`）

```ts
interface SkillUtility {
  skillName: string
  withSkill:    { runs: number; successes: number; rate?: number }
  withoutSkill: { runs: number; successes: number; rate?: number }
  delta?: number          // with − without;undefined = 样本不足
  insufficientData: boolean
  observational: true     // 口径标记:恒为 true
}
```

对比规则：

| 规则 | 理由 |
|---|---|
| 「不带该技能」= **同类别**任务下、未应用该技能的运行 | 不同类别的运行放不到同一把尺子上 |
| 工具级记录**不参与**技能对比 | 工具名不是技能名 |
| 无类别的记录**不参与**对比 | 宁可样本少，不混口径 |
| 两侧任一 < 5 次 → `delta` 留空 | 3 次运行得出的差值噪声太大（一次翻转就是 ±33%） |

### 3.5 口径红线：观察性，不是受控实验

「不带该技能」的运行是**自然发生的**，不是随机分配的 —— 存在混杂：

- 用户可能在**任务变难时**才想起用技能 → 带技能的组天然更难 → 差值**低估**技能贡献
- 反之也可能**高估**

因此：
- `observational: true` 恒为标记，消费方不得当因果结论用
- UI 明写「观察性对比而非受控实验」
- **不做任何自动禁用/回滚** —— 自动处置需要受控对照

### 3.6 修掉编造的技能卡统计

`SkillCard.vue` 此前渲染 `usageCount` / `successRate`，二者写它们的
`SkillLoader.recordSkillUsage()` **全仓零调用方** → 永远显示
「0 次使用 / 100% 成功率」。

那不是"还没数据"，那是**编造的**。现：
- `skills:list` 用 tracker 的真实记录覆盖这两个字段
- 无记录时 `successRate = null`，UI 显示 `—` 而不是假的 100%

### 3.7 ToolGate 补登 `load_skill`

```ts
const DEFAULT_PERMISSIONS = {
  Read: 'auto', Glob: 'auto', Grep: 'auto',
  load_skill: 'auto',   // ← M4-D 补登
  Edit: 'confirm', Write: 'confirm', Bash: 'auto',
}
```

**没有改成「工具声明 false 就一律 auto」** —— 因为兜底保守是**故意的**
（`ToolGate.test.ts`「未知工具默认保守」是安全属性），而且声明 false 的工具
未必真的无副作用（`D1ScreenshotQA` 声明 false，但截图本身是可见的隐私面）。

代价是「新增只读工具必须在本表登记」。为把这个**静默陷阱**变成红灯，
新增用例「内置工具档位与声明一致」：任一内置工具声明 `requiresPermission: false`
但实际档位不是 `auto` → 测试红。

## 四、验证

| 项 | 基线 | 现在 |
|---|---|---|
| vitest | 109 files / 1306 passed | **111 files / 1331 passed / 0 FAIL** |
| 后端 typecheck | 30 error | **30 error（零新增）** |
| 前端 vue-tsc | 0 | **0** |

新增测试：

| 文件 | 例数 | 覆盖 |
|---|---|---|
| `tests/unit/skill-utility-m4d.test.ts` | 14 | 任务类别归一；边际效用（样本不足/正差/负差/跨类别不混/工具级不混/无类别不混/观察性标记/排序）；真实使用统计 |
| `tests/integration/skill-applied-tracking.test.ts` | 4 | brain 汇总 `appliedSkills`（调了有/没调为空/加载失败为空/重复去重）+ 工具日志带 entity |
| `tests/unit/LoadSkillTool.test.ts` | +2 | 加载成功声明 entity / 加载失败不声明 |
| `tests/unit/chat-m4b-learning-wiring.test.ts` | +3 | 技能级运行记账（带 category）/ 工具级与技能级分开 / 失败的应用也留 |
| `tests/unit/ToolGate.test.ts` | +2 | 内置工具档位与声明一致（防漏登记） |

## 五、遗留与后续

| # | 遗留 | 归属 | 说明 |
|---|---|---|---|
| 1 | **受控对照实验未做** —— 边际效用是观察性的，存在混杂。要拿因果结论，需在同一批任务上随机带/不带各跑一遍 | M4-E | §2.1 的 reward gap 协议；桌面应用场景成本高，需要用户显式开启 |
| 2 | **任务类别只做表面归一** —— 「整理桌面」与「清理桌面」算两类，样本量偏少 | 后续 | 依赖真实 embedding（当前仍是 SHA-256 伪向量） |
| 3 | **旧 TaskExecutor 管道的技能级信号未接** —— 该路径是「推测性注入」（≤5 个技能时全部注入），"应用"语义弱于 agent loop 的显式 `load_skill` | 后续 | 有意为之：M4-D 只覆盖 agent loop 的显式应用 |
| 4 | **自动处置仍未做** —— 负贡献技能不会自动禁用 | 待定 | 需要 #1 的受控对照才敢做 |
| 5 | **Embedding 仍是 SHA-256 伪向量** | 后续 | 三个后端代码已存在，只差配置 |

## 六、参考资料

- arXiv:2606.08755《Co-Evolving Skill Generation and Policy Optimization》
  —— 上下文相关的边际效用；reward gap 协议；瓶颈在验证不在生成
- FlowEvo —— 对照式评估：带/不带技能的成功率差值 < −0.1 判为有害
- Anthropic《Equipping agents for the real world with Agent Skills》（2025-10）
  —— 自生成技能收益接近零；人工编辑才是价值产生的一环
- ACE（arXiv:2510.04618）—— support counts；helpful/harmful 计数器；delta item 带 provenance
- ALTK-Evolve —— 效用剪枝而非按时间保留；交付方式（核心 + 按需扩展）影响结果
- SkillsBench / AGENTS.md 论文 —— 技能库按效用剪枝；LLM 生成的知识文件平均为负
