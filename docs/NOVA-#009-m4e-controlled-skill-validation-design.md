# NOVA #009 — M4-E 技能效用的受控对照（这个技能到底有没有用）

> **状态**：已实现（2026-11-02）
> **对应台账**：DEV-109 ~ DEV-113
> **分支**：`feat/harness-wiring`
> **前置**：[M4-D 技能效用验证](NOVA-#008-m4d-skill-utility-design.md)（观察性对比）

## 一、为什么做这件事

### 1.1 M4-D 的结论只能说到「看起来有关」

M4-D 给的是**观察性对比**：同类别任务下，带该技能的运行 vs 不带的运行。

但那个对比**有混杂**：用户可能专挑难活儿时才启用技能 → 带技能的组天然更难 →
差值被**系统性低估**。业界实测也正因如此才把判据定为**差值**而不是绝对值。

**要拿到因果结论，只能做受控对照**：同一个任务跑两遍，一遍允许用该技能，一遍禁止用。

### 1.2 但「禁止用」必须真的禁止

如果只是把技能从提示词里摘掉，模型仍可能凭记忆用同样的做法 —— 对照组就废了，
测出来的差值恒为 0（两个变体其实一样）。

所以抑制必须落到**工具层**：模型调 `load_skill` 时被真的拒绝。

## 二、调研依据（GitHub 高活跃项目对比）

| 来源 | 结论 | 采纳 |
|---|---|---|
| **OpenAI 自己的 eval 模型** | Eval = **(Dataset, Runner, Grader)** 三件套；Grader **分层**（先确定性检查，再相似度，最后 LLM 裁判兜底）；「顺序稳定化」—— 前面的检查挡住后面会漏掉的问题类型 | 本批 = Runner 是 `SkillTrial`，数据集是 tasks[]，Grader 是 `TaskGrader` |
| **LangSmith 实践共识** | **agent 输出很少有唯一正确答案，但几乎总能写出结构约束**（must_call / must_contain / must_not_call）；**pairwise 比绝对打分可靠得多** | 成功信号 = 硬信号 + 结构约束，**不用 golden answer**；对照本身就是 pairwise |
| **ACE 官方**（`ace-agent/ace`，ICLR 2026） | Generator→Reflector→Curator；playbook 每条带 helpful/harmful 计数；增量 delta 合并 | 效用按「配对差值」统计，不看绝对分 |
| **ACE 社区验证门**（AgentDescent 移植） | 「a bullet is committed only when it **raises held-out reward**」；官方 ACK 自己**没有**这个门，且弱点正是「noisy reflector silently pollutes the playbook with **no gate**」 | 所以本批有**准入门**，且样本不足时**明确不给结论** |
| **FlowEvo** | 有害阈值 −0.1 | 差值门槛取 ±0.1 |
| **LLM 裁判的已知问题** | 换模型/换提示词/换顺序都会改结果（judge drift）；裁判偏爱长答案；建议 **30% 启发式 + 40% pairwise + 20% 人工** 的混合，且只对 **2~5% 流量** 跑裁判 | 本批 ①②③ 层**全确定性**（离线可跑、零漂移）；LLM 裁判层留接口不实现 |

## 三、实现

### 3.1 抑制机制（让「不带技能」变体真的没有该技能）

```
RuntimeToolContext.suppressedSkills: string[]     ← 随 run 传,不做全局态
  → LlmAgentBrain.run(opts.suppressedSkills)
  → toolCtx.suppressedSkills
  → LoadSkillTool.execute:命中即拒绝
```

**为什么不做全局态**：全局抑制集会串味 —— 两个会话同时跑，一个的对照实验
会把另一个的技能也禁掉。随 run 传递（和 `contextKind` 同一套路）天然隔离。

拒绝时要说清原因：「技能 X 在本次运行中被禁用(对照实验分组),请直接完成任务」——
模型需要知道「这个技能不可用」而不是「工具坏了」，否则会反复重试，把对照做脏。

### 3.2 分层评分器（`electron/learning/TaskGrader.ts`）

| 层 | 判定 | 依据 |
|---|---|---|
| ① `hard_signal` | **必须过**：无工具失败、无 run 错误、有最终答复 | 确定性 |
| ② `structural` | 按需：must_call / must_not_call / must_contain | 确定性（替代 golden answer） |
| ③ `similarity` | **只作参考分**，单独不决定成败 | 确定性 |

**为什么相似度不决定成败**：话术像但没做成，不能算成功。
（这正是「结果正确不代表过程正确」的教训。）

### 3.3 配对对照运行器（`electron/learning/SkillTrial.ts`）

每个任务跑两遍 → 逐对打分 → 汇总：

| 指标 | 口径 |
|---|---|
| `withSkillRate` / `withoutSkillRate` | 两组各自的成功能率 |
| `delta` | 带 − 不带 |
| `verdict` | `positive` / `negative` / `neutral` / **`insufficient_data`** |
| 门槛 | 差值 ±0.1；样本 ≥ 5 个配对任务 |

**样本不足时明确说「样本不足」而不是给结论** —— 3 次运行得出的差值一次翻转就是 ±33%。

**执行故障的任务不计入统计**：那是实验故障，不是任务失败。

### 3.4 接线

- `ChatManager.runSkillUtilityTrial(skillId, tasks)` —— 建一个专用会话，逐任务跑两遍
- `dispatchToAgent(..., suppressedSkills)` —— 变体如何生效的通路
- IPC `skills:runUtilityTrial`
- UI「技能验证（对照实验）」卡片：选技能 + 每行一个任务 + **开始前弹确认说清 token 翻倍** + 结果表（逐任务的带/不带成败）+ 结论条

## 四、验证

| 项 | 之前 | 现在 |
|---|---|---|
| vitest | 119 files / 1403 passed | **121 files / 1427 passed / 0 FAIL** |
| 后端 typecheck | 0 error | **0 error** |
| 前端 vue-tsc | 0 | **0** |
| `npm run build` | 通过 | **通过** |

新增测试：

| 文件 | 例数 | 覆盖 |
|---|---|---|
| `tests/unit/skill-trial-m4e.test.ts` | 17 | 分层判定 10 例（硬信号必须过 / 结构约束 / **相似度单独不决定成败** / 无约束时跳过）+ 配对对照 7 例（**确实跑两遍且抑制集正确** / 有用 → positive / 有害 → negative / **样本不足不给结论** / **执行故障不计入** / 门槛内 → neutral） |
| `tests/unit/LoadSkillTool.test.ts` | +2 | **被抑制的技能 → 拒绝且说清原因** / 未被抑制 → 正常加载（抑制不能误伤） |

## 五、遗留与后续

| # | 遗留 | 归属 | 说明 |
|---|---|---|---|
| 1 | **「成功」信号仍是弱代理** | 后续 | 现在只有「工具调用是否全成功 + 有没有产出答复」。真正的信号是**用户是否接受**（没有立刻纠正/重跑）—— 需要渲染层采集 |
| 2 | **LLM 裁判层未实现** | 后续 | 接口留好了。业界建议只对 2~5% 流量跑裁判，且要定期校准。本项目可用本地 ollama 小模型跑，但要防 judge drift |
| 3 | **不做自动处置** | 刻意 | 负贡献只报告、不自动禁用技能 —— 自动处置需要更多样本 + 用户知情同意 |
| 4 | **对照实验要跑两遍模型** | 已知成本 | token 翻倍。UI 已明确告知并要求确认。桌面场景可接受（用户主动发起） |
| 5 | **任务集由用户手写** | 后续 | 现在是每行一个任务。可考虑从历史观察里**推荐**候选任务（用 M4-C 的候选模式） |
