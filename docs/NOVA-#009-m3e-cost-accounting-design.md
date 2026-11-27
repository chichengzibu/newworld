# NOVA #009 — M3-E 成本记账（数据在，读出来是假的）

> **状态**：已实现（2026-10-29）
> **对应台账**：DEV-085 ~ DEV-088
> **分支**：`feat/harness-wiring`
> **前置**：[M3-D 技能目录](NOVA-#009-m3d-skill-directories-design.md)

## 一、为什么做这件事

### 1.1 零调用方审计的第三个发现

M3-D 之后我继续做**能力可达性**审计（第三类：有能力实现但零调用方）。结果：

| 方法 | 生产调用点 |
|---|---|
| `CostTracker.getTodayCost()` | **0** |
| `CostTracker.getUsageByConversation()` | **0** |
| `CostTracker.getRecentUsage()` | **0** |

成本**一直在记**（agent 路径 + AgentBrain 都调 `recordUsage`），但**没人读得到**。

### 1.2 唯一的读出口是个硬编码 0 的 stub

顺着调用方往上找，找到了 preload 里的 `insight.costToday()`，
以及主进程里对应的 handler：

```ts
ipcMain.handle('insight:cost:today', async () => {
  return { success: true, data: { totalCostUsd: 0, totalTokens: 0, stub: true } };
});
```

**硬编码 0**。也就是说：

- 数据在 `CostTracker` 里真实记着 ✅
- 接口在 preload 里存在 ✅
- 唯独读出来是**假的** ❌
- 而且**没有任何渲染层调用它**（连假的都读不到）

假数据比没数据更危险 —— 用户看到「今天花了 $0.0000」会以为没花钱，而钱已经花了。

### 1.3 就算读出来也是错的

即便把 stub 换成真数据，记下来的数据本身也是失真的：

| # | 失真 | 后果 |
|---|---|---|
| ① | `model` 恒为字面量 `'agent-loop'` | 成本按**一个假模型名**归集 ——「哪个模型花了多少钱」根本查不出来，全部混在一栏 |
| ② | `inputTokens` 塞的是 `totalTokens`，`outputTokens` 恒为 `0` | 输入输出混在一栏，分不出「提示词长」还是「回答长」 |
| ③ | 定价表按**基座名**建（`gpt-4o`），真实记录是**模型 id**（`qwen3.5:9b`） | 精确查表必然落空 → 成本恒 0 |

第 ② 条的根因在更上游：**适配器本来就回传 `promptTokens` / `completionTokens`**，
但 brain 聚合 usage chunk 时只取 `totalTokens`，把分项**丢掉了**。

## 二、设计依据

### 2.1 归因先于金额

成本面板的第一价值不是「花了多少钱」，而是**「谁花的」**。

对本地模型用户（这个项目的主要形态）尤其如此：本地推理**没有 API 费用**，
成本是 0 美元 —— 这是事实，不是记账失败。真正有用的信号是
**token 数按模型的分布**（上下文预算管理）。

所以本批的修法顺序是：先把归因修对（模型名 + 分项），再谈金额。

### 2.2 定价查表要容忍「基座名 vs 模型 id」

定价表是人维护的（`gpt-4o` / `ollama-llama3`），
而记录是自动的（`openai/gpt-4o-mini-2024-07-18` / `qwen3.5:9b`）。
两者天然对不上。

解法是**归一化查表**（精确 → 去 provider 前缀与版本后缀 → 前缀命中），
而不是要求用户手填每个具体 id。

## 三、实现

### 3.1 分项 token 一路带上来

```
适配器 usage chunk {promptTokens, completionTokens, totalTokens}
  → brain 聚合 usage chunk  ← 【M3-E】此前只取 totalTokens,分项在此丢掉
  → run() 返回 {promptTokens, completionTokens}
  → think() 载荷 {promptTokens, completionTokens, llmModel}
  → ChatManager 记 {inputTokens, outputTokens, model: llmModel}
```

### 3.2 真实模型名

`run()` 现在返回 `model: opts.model ?? DEFAULT_MODEL`，
`think()` 的载荷多带一个 `llmModel`（保留 `model: 'agent-v0.1'` 作为脑的版本标签）。

ChatManager 记账改用 `payload.llmModel`，取不到才回落 `'agent-loop'`。

### 3.3 定价查表归一化

```ts
精确命中 → 去 provider 前缀/版本后缀后精确命中 → 前缀命中 → 0 定价
```

补了本地模型条目（`ollama-qwen3.5` / `ollama-bge-m3` / `ollama-qwen3.8`）——
本地模型成本确实是 0，但要有条目才能归到「本地」这一类，而不是落到「未知」。

### 3.4 读出口换成真数据 + UI

- `insight:cost:today` 从 stub 换成 `CostTracker.getTodayCost()` + `getRecentUsage(20)`
- `ModelCompare.vue` 的「使用量排行」页顶部新增「今日成本」卡片：
  今日费用 / 输入 token / 输出 token / 按模型分布

## 四、验证

| 项 | 基线 | 现在 |
|---|---|---|
| vitest | 116 files / 1391 passed | **117 files / 1398 passed / 0 FAIL** |
| 后端 typecheck | 29 error | **29 error（零新增）** |
| 前端 vue-tsc | 0 | **0** |

新增测试 `tests/unit/cost-tracking-m3e.test.ts`（7 例）：
brain 带回分项与真实模型名 · 载荷带 llmModel 与分项 · 按模型归集（不再混在 'agent-loop' 一栏）·
按会话可查 · 今日汇总成本 > 0（不再是硬编码 0）· 定价归一化命中 ·
**本地模型成本为 0 是事实、不是记账失败（且仍归到该模型名下）**

## 五、遗留与后续

| # | 遗留 | 归属 | 说明 |
|---|---|---|---|
| 1 | **定价表不能由用户维护** | 后续 | `setPricing` 是 public 但零调用方。真实 id 千变万化，应给设置页一个「按模型设价」的入口 |
| 2 | **「今日」按本地时区** | 口径 | `getTodayCost` 用 `setHours(0,0,0,0)`（本地时区）。跨时区用户看的是自己的自然日 —— 对个人应用这是对的 |
| 3 | **历史成本无清理/聚合** | 后续 | `usages` 只增不减（无上限）。长期使用后文件会变大；需要滚动聚合（按日/周）而不是保留每条 |
| 4 | **MCP / 其他 provider 的用量未汇总** | 后续 | 本批只覆盖 agent 路径与 AgentBrain |

## 六、参考资料

- OpenAI / Anthropic / 智谱 各家 usage 字段语义（`prompt_tokens`/`input_tokens` 等）
- 成本归因的通用实践：先按「维度」归集，再谈金额
