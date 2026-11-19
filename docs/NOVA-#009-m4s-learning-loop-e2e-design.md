# NOVA #009 — M4-S 学习闭环端到端（把「自我学习」从声称变成事实）

> **状态**：已实现（2026-11-13）
> **对应台账**：DEV-166
> **分支**：`feat/harness-wiring`
> **前置**：[M4-Q e2e 进 CI 门禁](NOVA-#009-m4q-e2e-ci-gate-design.md)

## 一、为什么做这件事

「自我学习」是本项目对标 Hermes / Claude Code 的**核心差异点**，也是一直属于
「声称在工作」的那一类：观察 → 分析 → 提案 → 人审门 → 落地 的链路代码齐全，
但**从没被端到端验过「它真的在记东西」**。

而且 M4-Q 刚修掉一个会让它**变假**的东西：`sendMessage` 收了 providerId 却
不写回会话 → 经 IPC 发消息时 agent 路径永远拿不到 provider → 每条消息报错回落 →
**学习闭环记到的全是这种失败**。修完不等于闭环就通——得实测。

## 二、做法

新增 `tests/e2e/learning-loop.spec.ts`（2 例）：

### 2.1 一次成功的对话 → 真的落成观察记录

| 断什么 | 怎么断 |
|---|---|
| agent 路径**真的成功** | 助手气泡里有 mock 的真回复标记，**且不得**出现「no LLM provider configured」 |
| 观察**落到了磁盘** | 读 `<userData>/hermes-learning/observations.json` → 至少一条，且 `instruction` 是我发的那条、`outcome` ∈ {ok, fail, partial}、且**是 `ok`**（明明成功了却被记成失败 → 断） |
| 效果统计的**口径**对 | 这次**没有工具调用** → `skill-stats.json` **不该存在**（否则"没记录"和"记录了但是坏的"分不清） |

### 2.2 工具调用链：LLM 要工具 → 真的调了 → 观察里有步骤 → tracker 有记录

这是「Agent runtime 跟 ClaudeCode 对齐」这条**核心主张**，同样没端到端跑过。

做法：给 mock 加一个**工具调用模式** —— 用户消息里带 `__TOOL_CALL__` 时，
mock 首轮回一个 `Glob` 的 `tool_calls`，第二轮（带着工具结果回来）再回正文。
于是链路完整跑起来：LLM 要工具 → agent 调工具 → 工具执行 → 观察里有步骤 →
tracker 有工具级记录（`unitType='tool'`）。

| 断什么 | 怎么断 |
|---|---|
| 工具**真被调了** | 观察的 `steps` 里有一个 `name === 'Glob'` 的步骤 |
| tracker **真记到了** | `<userData>/skill-stats.json` 存在，且有一条 `skillName === 'Glob'`、`unitType === 'tool'` 的记录 |

### 2.3 为什么用得着读文件

e2e 的 profile 现在**每个测试独立**（`freshUserData` fixture 给的就是那个路径）
→ 可以直接读落盘结果，断的是「**数据真的到磁盘上了**」，而不是「内存里有」。

## 三、结果

**学习闭环是活的**，整条链一次跑通：

| 环节 | 结果 |
|---|---|
| agent 路径 | 成功（气泡里是 mock 的真回复，不是报错） |
| 观察记录 | 落盘，含 instruction + `outcome='ok'` |
| 工具调用 | mock 要 Glob → agent 真的调了 → 观察里有 Glob 步骤 |
| 效果统计 | `skill-stats.json` 有 Glob 的工具级记录（`unitType='tool'`） |

**没有发现新的产品缺陷** —— 但这个"没有"是有价值的：
它是 **M4-Q 那个修复的回归守卫**（修之前这条用例必然红：agent 拿不到 provider →
气泡里是报错 → 等不到 mock 回复 → 超时失败）。

## 四、验证

| 项 | 结果 |
|---|---|
| 新增 e2e `learning-loop.spec.ts` | **2 passed** |
| e2e 全量 | 见关单 |
| vitest / 双 typecheck / build 门禁 | 见关单 |

## 五、遗留与后续

| # | 遗留 | 归属 | 说明 |
|---|---|---|---|
| 1 | **技能级效用（`unitType='skill'`）仍未验** | 后续 | 需要 agent 真的**加载了一个技能**（`load_skill` 工具）→ 本批只验到工具级。技能级要等 M4-E 的受控对照跑起来才有数据 |
| 2 | 分析→提案→人审门→落地**未端到端** | 后续 | 需要累计够观察数（阈值 10）才会自动触发分析 —— 那是"跑久了才发生"的路径，e2e 里要么造够数据要么单测覆盖 |
| 3 | mock 的工具调用模式只支持 Glob | 已知 | 够验链路；要验别的工具再扩 |
