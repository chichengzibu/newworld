# NOVA #009 — M4-AA：旧管道对齐 D8（技能不再由代码替 AI 选）

> **状态**：已实现（2026-11-20）
> **对应台账**：DEV-177
> **分支**：`feat/harness-wiring`
> **决策**：[D8](../docs/decisions.md)（技能由 AI 自行判断选用）

## 一、起因

D8 写得很清楚：

> 技能由 **AI 自行判断**选用 —— 代码里**不做**关键词/相似度匹配替 AI 决定。

agent 路径（M4-A 渐进披露 + M4-W 的 id 对齐）已经是这个形态。
但**旧管道**（`InstructionGenerator → TaskExecutor`，agent loop 不可用时的回退）**没有对齐**：

| 位置 | 违反点 |
|---|---|
| `SkillLoader.getSkillContext()` | 技能 >5 个时**额外发一次 LLM 调用**去排序（`rankSkillsOnce` → `SelfLearner.rankSkillsByRelevance`），失败再**降级为关键词匹配**，取前 3 名注入 |
| `InstructionGenerator.callModel()` | 把技能清单**注入两遍**（`getAllSkillSummaries()` 一份 + `getSkillContext()` 内含一份），且两份口径不同（一份含**禁用**技能）；追加段的标题是「检测到匹配的技能」—— 而"匹配"是代码做的 |
| `getAllSkillSummaries()` | 列出**禁用**的技能（`getSkillSummaries()` 一直是过滤的，两者口径不一致） |

旧管道什么时候真的会跑？`shouldUseAgentLoop()` 返回 false 时：
无已注册 agent、无可用 provider、或**执行模式为 safe**。所以它是可达的回退路径。

## 二、做法：不是"改得更准"，而是**不做选择**

`getSkillContext()` 重写为两种行为，**都不含选择**：

| 条件 | 行为 |
|---|---|
| 全部技能正文合计 **≤ 16,000 字** | **全量注入**（清单 + 每个技能正文）。这不是"代码挑了哪些"，而是"把全部摆出来，由模型自己决定用不用" |
| 超出预算 | **只给清单**，并**如实说明**：正文合计多少字、超过预算、本路径没有工具循环拿不到全文、需要严格按步骤执行请切到「计划/全量」模式 |

**为什么不做"挑前 3 个"**：挑就是替 AI 做决定（D8 禁止）；而**挑一部分塞进去**更糟 ——
模型会以为拿全了，按残缺上下文规划。

**为什么用字符预算而不是"技能个数"**：一个技能正文可能几千字，五个技能就可能撑爆提示词。
字符预算是按**实际注入体量**设限，和"有几个技能"无关。

同时删除：

- `SkillLoader.rankSkillsOnce()`（LLM 排序 + 关键词降级的实现）
- `SelfLearner.rankSkillsByRelevance()`（唯一的调用方就是上面那个）
- `SkillLoader` 里为它服务的 `selfLearner` 懒加载 getter 与 `SelfLearner` import（已成死依赖）

并修正：

- `getAllSkillSummaries()` **只列启用技能**（与 `getSkillSummaries()` 口径一致）
- `InstructionGenerator` 去掉**第二份**清单注入
- 提示词规则 1：从「首先检查用户消息是否匹配上述任何技能的**触发关键词**」
  改为「**先判断**用户需求是否与某个技能相关（依据清单里的描述与适用场景）」—— 由模型判断
- 追加段标题从「检测到匹配的技能」改为「技能清单」，并明确：
  「清单里没有正文的技能，**不要臆造**它的步骤」

## 三、验证

| 项 | 结果 |
|---|---|
| `tests/unit/skill-context-d8.test.ts` | **5 例**：预算内全量给出（不做挑选）/ 超预算只给清单且如实说明 / **排序器已不存在**（`rankSkillsOnce`、`rankSkillsByRelevance` 都应为 undefined）/ 禁用技能不出现在清单 / InstructionGenerator 不再注入第二份清单、不再声称"检测到匹配" |
| vitest | **145 files / 1569 passed / 0 FAIL / 17 skipped** |
| 双 typecheck | 0 error |

## 四、影响面（诚实说明）

- **agent 路径完全不受影响** —— 它本来就不走 `getSkillContext`。
- **旧管道**：技能正文从"前 3 名"变成"全部（预算内）或没有（超预算）"。
  也就是说：技能很多、正文很长时，**回退路径下的技能会退化为只有清单**。
  这是有意的取舍 —— 宁可明说拿不到，也不用"代码替模型选"假装拿得到。
- **每次规划少一次 LLM 往返**（排序调用没了）。

## 五、遗留与后续

| # | 遗留 | 说明 |
|---|---|---|
| 1 | 旧管道仍无法按需加载正文 | 它没有 tool loop。真正的解法是让这条回退路径也用 agent 循环，或**逐步退场**（它只在 safe 模式/无 provider 时被用） |
| 2 | 预算 16k 字是拍定的 | 依据是"约 4~5k token、对规划提示词可接受"；如果实测有更合适的值（或按模型上下文比例算），应调整并复测 |
| 3 | 未做真模型验证 | 本次只验了逻辑（注入内容与选择行为）。旧管道在真实任务上"看不出技能就不硬套"的效果，尚未用真模型量过 |
