# NOVA #009 — M4-W：让 AI 真的能选对技能

> **状态**：已实现（2026-11-19）
> **对应台账**：DEV-170 / DEV-171
> **分支**：`feat/harness-wiring`
> **前置**：[M4-A 技能渐进披露](NOVA-#009-m4a-skill-progressive-disclosure-design.md) ·
> [M4-D 技能效用对照](NOVA-#009-m4d-skill-utility-design.md) ·
> [M4-E 受控对照](NOVA-#009-m4e-controlled-skill-validation-design.md)

## 一、需求：「技能要用 AI 自行判断用哪个」

机制**早就有**（M4-A 渐进披露）：

```
L1  技能摘要常驻注入系统提示  →  模型自己判断"相关吗"  →  调 load_skill 取正文(L2)
```

代码里**没有任何关键词匹配**替 AI 做决定（旧实现才有，M4-A 已删）。
聊天界面也**没有**手动选技能的入口 —— 从设计上就是"AI 自己选"。

**但它从没被验过。** 既有测试只验**管道**：

| 已有测试 | 验的是 |
|---|---|
| `SkillLoaderProgressive` | 摘要里有没有 name/description/when_to_use |
| `LoadSkillTool` | 模型调了能不能拿到正文 |
| `skill-applied-tracking` | 调了之后 appliedSkills 有没有记上（**mock 模型**） |

**没有一条问「模型面对真实任务时，会不会挑对那个技能」。**
而路由是**模型行为** —— mock 掉模型，测的就是 mock 自己。

## 二、基准：怎么测才算公平

`tests/integration/skill-routing-live.test.ts` —— 接**真模型**（本机 ollama），
用**生产 agent 路径**（`LlmAgentBrain.run`）跑。

四条设计约束，缺一条这个数就没意义：

| # | 约束 | 为什么 |
|---|---|---|
| ① | 技能 **id ≠ name** | 真实技能目录名与展示名常常不同。若 id === name，就测不出"选对了却加载不了" |
| ② | 每个任务**只匹配一个**技能 | "正确"才有唯一定义 |
| ③ | 带**负样本**（不匹配任何技能） | 正确行为是**不加载任何技能** —— 只测正样本会把"什么都加载"也算对 |
| ④ | 任务措辞里**不提技能名** | 否则测的是"认字"，不是"判断" |

指标：选对率 / 漏选率 / 误选率 / 多选率 / 负样本误触发率 / `load_skill` 失败次数。

**A/B 怎么做得可信**：基准内含 `legacy` 变体 —— 在**测试里**把摘要格式 / 系统提示 /
加载兜底三处**打回修前行为**，**不改产品代码**。
（改产品代码再改回来容易把改动弄丢，也没法并行对比。）

```bash
PIPICLAW_SKILL_ROUTING=1 PIPICLAW_SKILL_ROUTING_VARIANT=legacy npx vitest run tests/integration/skill-routing-live.test.ts
PIPICLAW_SKILL_ROUTING=1 PIPICLAW_SKILL_ROUTING_VARIANT=fixed  npx vitest run tests/integration/skill-routing-live.test.ts
```

## 三、量出来的两个缺陷

### 3.1 DEV-170：摘要给的是**展示名**，工具只认 **skill_id**

技能的 **id 是目录名**，**展示名是 frontmatter 的 `name`**：

| 目录(id) | 展示名(name) |
|---|---|
| `file-organizer` | `文件整理器` |
| `sample-web-summary` | `Web Page Summarizer` |

> 注:这两个样例技能在 **M4-X 已按用户要求删除**(「技能部分不要集成」)。
> 本节保留的是当时的实测事实 —— 缺陷本身与它们是否还在仓库里无关。

而：
- `getSkillSummaries()` → 只给**展示名**
- `load_skill(skill_id)` → 只按 **id** 查

**模型只能把展示名当 id 传** → 报「技能不存在」→ 白花一轮模型往返读错误信息，
再改用 id 重试。

实测仓库自带技能：**两个 100% 命中**。

**为什么之前没被发现**：既有测试全部用 **id === name** 的技能
（`pdf-extract` / `name: pdf-extract`）—— 两种叫法恰好相同，缺陷被完全掩盖。

### 3.2 DEV-171：技能规则排在最后，被「优先用工具拿真实数据」压过

修前的系统提示准则：

```
1. 优先用工具拿真实数据, 不要靠记忆编        ← 普适规则
...
7. 若系统提示里有"可用技能"清单, 且某技能与用户需求相关, 先调 load_skill ...  ← 条件规则
```

第 1 条是普适规则，第 7 条是条件规则。模型遇到"先找文件再处理"的任务时，
**普适规则先命中** → 先 Glob → 后面懒得回头看技能 → **漏选**。

修法不是"再加一条提醒"，而是**把判断顺序写进准则**：
技能判断提到**第 1 条**，并给**反例**（不要先用 Glob/Read 去"找"技能）。

## 四、做法

### 4.1 DEV-170：让 id 看得见、猜对了能用、记账对得上

| 改动 | 位置 |
|---|---|
| L1 摘要带出 `skill_id` | `SkillLoader.getSkillSummaries()` / `getAllSkillSummaries()` |
| 按 **name 兜底**加载 | `SkillLoader.getSkillBody()`（大小写/空白不敏感） |
| 错误信息列 **id（名称）** 对照 | 同上 —— 模型能直接抄，不用猜哪个是 id |
| `appliedEntity` 记**规范 id** | `LoadSkillTool` + 新增 `SkillLoader.resolveCanonicalSkillId()` |

**为什么 `appliedEntity` 必须记规范 id**：学习闭环记的是「技能 S 被应用了」。
若记的是展示名，`skill-stats.json` 里的技能名就与 `load_skill` 寻址用的 id 对不上 ——
效用统计按一个**不存在的 id** 聚合，查不到、也对不上账。

### 4.2 DEV-171：把「先判断要不要用技能」提到第 1 条

```
工作准则:
1. 【M4-W】**先判断要不要用技能**:系统提示里的"可用技能"清单就是路由依据
   (每条含名称、描述、适用场景、以及 load_skill 要用的 skill_id)。
   有技能与用户需求相关 → **第一步**就调 load_skill 取它的完整步骤,再动手;
   拿不准或没有相关技能 → 当没有技能,直接干活。
   **不要**先用 Glob/Read 去"找"技能 —— 技能靠清单判断,不是靠搜目录。
2. 优先用工具拿真实数据, 不要靠记忆编
...
```

`load_skill` 工具描述同步写明「判断相关性**优先于**动手；skill_id 用清单里给出的那个」。

## 五、验证

**修前 / 修后 A/B（同一会话、同一条件、qwen3.5:9b、各 3 轮）**

| 指标 | 修前(legacy) | 修后(fixed) |
|---|---|---|
| 选对率 | 87.5% / 87.5% / 75.0% | **100% / 100% / 100%** |
| 漏选率 | 12.5% / 12.5% / 25.0% | **0% / 0% / 0%** |
| 误选率 | 0% | 0% |
| 多选率 | 0% | 0% |
| 负样本误触发 | 0% | 0% |
| `load_skill` **失败**次数 | **7 / 7 / 6** | **0 / 0 / 0** |

换模型（qwen3.8-27b-q4km:latest）复测：选对率 100%、漏选 0%、负样本误触发 0%。

**回归钉**

| 项 | 结果 |
|---|---|
| `tests/unit/skill-id-routing-m4w.test.ts` | **10 例**：摘要带 id / 按 name 兜底 / 大小写兜底 / resolveCanonicalSkillId / 错误信息含 id↔名称对照 / **appliedEntity 记规范 id** / 不存在则失败且不记账 |
| `tests/integration/skill-routing-live.test.ts` | 实跑基准（默认 skip，需 `PIPICLAW_SKILL_ROUTING=1`） |
| vitest | **143 files / 1607 passed / 0 FAIL** |

## 六、遗留与后续

| # | 遗留 | 归属 | 说明 |
|---|---|---|---|
| 1 | 基准只有 4 个技能 / 10 个任务 | 后续 | 单机小模型够用，但**技能多起来时**路由会不会退化（列表太长、描述互相重叠）还没量过。应加一档"20+ 技能"的压力场景 |
| 2 | 基准只测**选得对不对**，没测**用得好不好** | 后续 | 选对 → 加载 → 按技能步骤执行 → 结果好不好，是另一段（M4-E 的对照实验管的正是这一段） |
| 3 | 本地小模型 vs 云端模型 | 后续 | 本基准只测了本机 ollama 的两个模型；云端模型（工具调用更稳）大概率更好，但没证据 |
| 4 | **旧管道仍不做"AI 判断"** | 新 | `SkillLoader.getSkillContext()` 供旧管道（无 tool loop 时）使用：≤5 个技能直接注入全部正文、>5 个用**一次 LLM 调用排序**取前 3。这条路径仍是"代码/额外调用替 AI 选"，与本次目标不一致 —— 待旧管道退场后一并处理 |
