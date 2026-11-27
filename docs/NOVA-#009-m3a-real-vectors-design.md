# NOVA #009 — M3-A 知识库真向量（召回不再是噪声）

> **状态**：已实现（2026-10-28）
> **对应台账**：DEV-066 ~ DEV-072
> **分支**：`feat/harness-wiring`
> **路线图**：`docs/plan/v5-10week.md` M3 ——「知识库真向量（替换 SHA-256 假向量）」
> **前置**：[M4-B 学习闭环接线](NOVA-#008-m4b-learning-closure-design.md) · [M4-C 模式证据链](NOVA-#008-m4c-pattern-evidence-design.md) · [M4-D 技能效用验证](NOVA-#008-m4d-skill-utility-design.md)

## 一、为什么做这件事

### 1.1 路线图上还剩这一件

`docs/plan/v5-10week.md` 的三个里程碑：

| 里程碑 | 内容 | 状态 |
|---|---|---|
| M1 | LlmAgentBrain + LLM 抽象统一 + MCP PoC | ✅ |
| M2 | max_iterations + cost tracking + 流式 tool call + MCP 实施 | ✅ |
| **M3** | **知识库真向量**（sqlite-vss + bge-m3 + rerank，替换 SHA-256 假向量）+ 沙箱起步 | 🔄 本批做前半 |

「知识库假向量」是这个项目从 2026-08 审计起就挂着的问题：
`docs/audit/05-final-report.md` 写的是「宣传与实际差距巨大」，
而差距的具体形态之一就是**记忆检索在假装工作**。

### 1.2 「只有代码，没有入口」

审计发现一件很典型的事：`EmbeddingService` 里 **ollama / openai / zhipu 三个真后端
全都实现了**，但：

| 事实 | 后果 |
|---|---|
| `getActiveModel()` 在没有 `hermes.embedding.provider` 配置时返回 `stub-deterministic` | 所有人拿到的都是 SHA-256 伪向量 |
| **全仓没有任何地方写入 `hermes.embedding` 配置** | 用户想设也设不了 —— 没有 IPC、没有 UI、只能手改配置文件 |
| `HermesAdapter.embeddingModel()` **另抄了一份** provider→model 映射 | 两处各维护各的，分叉了没人知道 |

伪向量的后果不是「慢一点」或「精度差一点」—— 是**完全无语义**：

```
相似文本的余弦 = 随机值
```

记忆检索退化成「随机取 N 条」。用户感知是「这软件好像不太记得事」，
但没有任何报错、没有指标、没有任何线索指向根因。

### 1.3 更糟的是：连上了也是假的

真后端接上后，「能不能用」又分两种：

| 失败 | 表现 |
|---|---|
| ① 连不上（ollama 没起 / API Key 错） | 明确报错，容易查 |
| ② 连上了但**语义是假的** | 用的是 stub，或后端返回了非语义向量 |

第 ② 种更危险 —— 用户以为检索在工作，其实没有。
所以本批的探测不只报「可达」，还要报**「相近文本确实比无关文本更相似」**。

## 二、设计依据

### 2.1 本地小参数模型优先

用户要求「平台需要链接模型测试时，用本地 ollama 小参数模型」。
本机 ollama 已装 **bge-m3（566M 参数，embedding 能力，1024 维）**——
正是路线图里点名要用的那个模型，且参数量足够小，本地可跑。

### 2.2 真向量的价值必须用**产品行为**证明，不是接口形状

「打对了接口」不等于「检索变好了」。验收标准应是：

> 一条**改写过的**查询（与记忆原文用词不同），
> 能不能把目标记忆排到第一。

这才是用户能感知的差异。

### 2.3 伪向量与真向量的分界线必须是可测的

对照实验设计：8 条记忆（1 条相关 + 7 条干扰），6 条改写查询，
统计 **top-1 命中率**。随机基线 = 1/8 = 12.5%。

## 三、实现

### 3.1 四个 IPC（此前一个都没有）

| 通道 | 作用 |
|---|---|
| `hermes:embedding:get` | 当前配置 + 生效模型 + **是否真向量** |
| `hermes:embedding:set` | 保存配置（并清缓存 —— 旧向量不可复用） |
| `hermes:embedding:detect` | 探测本地 ollama：可达吗？装了哪些嵌入模型？ |
| `hermes:embedding:test` | 探测可达性 + **语义自检** + 维度 + 延迟 |

### 3.2 ollama 后端现代化

| 项 | 旧 | 新 |
|---|---|---|
| 接口 | 只打老接口 `/api/embeddings` | 优先现代 `/api/embed`，老接口作回退 |
| 批量 | `embedBatch` = N 次 `Promise.all`（N 次往返） | 现代接口支持 `input` 数组 → **一次请求** |
| 模型名 | 硬编码 `nomic-embed-text` | 用户配置 → 本机探测到的嵌入模型 → 名义默认 |

**为什么模型名不能硬编码**：用户本机装的是 bge-m3，硬编码 nomic-embed-text
就会直接失败（而用户明明装了可用的模型）。

### 3.3 语义自检（探测的核心）

探测时同时嵌入「一对相近文本」与「一对无关文本」，比较两个余弦：

```
真向量 → 相近的明显高于无关的
伪向量 → 两者随机,没有稳定区分
```

判定门槛：差值 > 0.1 才算 `meaningful`。

### 3.4 设置页 UI（诚实标注）

`Settings → 记忆` 页新增「嵌入后端」卡片：

- **状态条**：真向量 → 绿色「已启用真实向量 — 记忆检索有语义」；
  伪向量 → 橙色「当前是伪向量 — 召回是噪声，相似文本不会被优先召回」
- 后端选择 / 服务地址 / API Key / 模型（下拉列出本机已装的嵌入模型）
- 「检测本地模型」—— 列出本机 ollama 可用的嵌入模型
- 「测试连接」—— 报维度 / 延迟 / 语义自检结论

### 3.5 单一真源

`HermesAdapter.embeddingModel()` 此前**另抄了一份** provider→model 映射。
两处分叉的后果是「配置说是真向量、实际走的是 stub」，且用户完全看不出来
（召回只是变差，不会报错）。现映射只在 `EmbeddingService` 一处。

## 四、实现期挖出的五个问题

这一批的价值不只在于「加了入口」，而在于**把入口接通后，藏着的洞全被踩出来了**。

### 4.1 伪向量被真后端污染成 NaN（最严重）

**原实现**：
```ts
private dimension: number = 64          // 会被真后端改写!
hashToVector(text) {
  for (let i = 0; i < this.dimension; i++) {
    const byte = i < hash.length ? hash[i] : hash2[i - hash.length]
    //                                        ↑ i 可达 991,而 hash2 只有 32 字节 → undefined → NaN
  }
}
```

**触发链**：嵌入一次 bge-m3 → `dimension` 变成 1024 → 切回伪向量 →
伪向量长度也是 1024 → `hash2[991]` 越界 → **向量里全是 NaN** →
余弦 = NaN → `score >= minScore` 恒为 false → **召回静默返回空**。

即：**用户切回伪向量后，记忆检索彻底失效，且不报任何错**。

真后端此前不可达，所以这个洞一直藏着 —— 一旦接上就立刻变成生产事故。

**修法**：伪向量维度**固定 64**（`STUB_DIMENSION`），与真后端维度无关；
取字节改用取模循环，任何维度都不越界。

### 4.2 换模型后旧向量不清（语义是「错的」不是「噪声」）

`HermesAdapter.recall` 的旧逻辑是 `if (!inStoreIds.has(m.id))` 才重嵌。
但换后端时**记忆 id 没变**，于是一条都不会重嵌 —— 库里留的是旧模型的向量，
拿新模型的查询向量去和它们算余弦，结果是**错的**。

更讽刺的是：`MemoryVectorStore` 里那套「维度/模型变化 → 清空重建」的逻辑
**永远不会触发** —— 它只在 `upsert` 时检查，而 `upsert` 恰恰被跳过了。

**修法**：`recall` 先比对索引的 `activeModel` 与当前模型，变了就
`reset()` 后全部重嵌。

### 4.3 一条 NaN 就能毒死整个索引

`upsert` 不检查向量合法性 → 一条 NaN 进库 → 所有余弦都是 NaN →
整个索引一条都召不回。

**修法**：`upsert` 拒收含 NaN/Infinity 的向量（纵深防御）。

### 4.4 契约与实现不一致（一条存量 typecheck 错误）

`HermesAdapter.recall(query, opts: RecallOptions)` —— 契约里 `RecallOptions`
只有 `topK`/`minScore`，但实现内部读 `useVector`/`useKeyword`。
于是调用方传这两个字段时 TS 报「多余属性」，运行时靠强转又能读到。
**类型说没有，运行时说有。**

**修法**：签名放宽为 `AdapterRecallOptions`（继承 `RecallOptions`，向后兼容）。
**后端 typecheck 错误数 30 → 29。**

### 4.5 「连上了」与「有用」被混为一谈

见 §1.3 / §3.3。

## 五、验证

### 5.1 A/B 对照（本地 ollama bge-m3，真跑）

8 条记忆（1 相关 + 7 干扰），6 条**改写**查询，只用向量召回（关掉关键词，
避免字面匹配掩盖向量效果），统计 top-1 命中：

| 后端 | top-1 命中 | 随机基线 |
|---|---|---|
| **真向量（bge-m3, 1024 维）** | **6 / 6** | 1/8 = 12.5% |
| 伪向量（SHA-256, 64 维） | **0 / 6** | 1/8 = 12.5% |

余弦实测：`cos(查询, 目标) = 0.7753` vs `cos(查询, 无关) = 0.4049`。

### 5.2 回归矩阵

| 项 | 基线 | 现在 |
|---|---|---|
| vitest | 111 files / 1331 passed | **113 files / 1354 passed / 0 FAIL** |
| 后端 typecheck | 30 error | **29 error（修掉 1 条存量）** |
| 前端 vue-tsc | 0 | **0** |

新增测试：

| 文件 | 例数 | 覆盖 |
|---|---|---|
| `tests/unit/embedding-service-m3a.test.ts` | 17 | 现代/老接口分流 · 批量一次请求 · 模型自动探测 · 只列嵌入模型 · 语义自检三态 · 换后端清缓存 · **伪向量维度固定 64** · **伪向量不含 NaN** · 确定性 |
| `tests/integration/embedding-local-ollama.test.ts` | 5 | **打真的本地 ollama**：探测模型 · 余弦间隔 · 探测自检 · 改写召回排第一 · **A/B 命中率 6/6 vs 0/6**（ollama 不可用时跳过，不红 CI） |
| `tests/unit/memory-vector-persistence.test.ts` | +1 | **V8：NaN/Infinity 向量拒收**（一条坏向量不能毒死整个索引） |

## 六、遗留与后续

| # | 遗留 | 归属 | 说明 |
|---|---|---|---|
| 1 | **rerank 未做** | M3-B | 路线图写的是「bge-m3 + rerank」。bge-m3 自带 reranker（`/api/rerank`），可在 top-k 上做二次排序 |
| 2 | **sqlite-vss 未做** | M3-B | 当前仍是 `vector-cache.json` 全量 JSON。条目上限 200，桌面应用够用；换 sqlite 是规模问题不是正确性问题 |
| 3 | **沙箱起步未做** | M3-C | 路线图 M3 的另一半：ProcessSandbox + Windows Job Object |
| 4 | **关键词与向量是「取最大值」合并** | 后续 | 混合检索通常用加权/RRF 融合，取 max 会让任一路的高分直接盖过另一路 |
| 5 | **`HermesAdapter.store()` 的 id 不一致** | 后续 | `store()` 传给向量库的 id 与 `HermesMemory` 自生成的 id 不同 → 向量库里有一条孤儿条目 + 每次召回重复嵌入一次。功能正确但浪费 |

## 七、参考资料

- 路线图 `docs/plan/v5-10week.md` M3 ——「知识库真向量（sqlite-vss + bge-m3 + rerank）」
- `docs/audit/05-final-report.md` ——「宣传与实际差距巨大」「Evolution 进化实际只是统计」
- BGE-M3 —— 多语言、多粒度嵌入模型，1024 维；ollama 官方提供 `bge-m3` 镜像
- Ollama API —— `/api/embed`（现代，支持 input 数组，返回归一化向量）
  与 `/api/embeddings`（老，单条，未归一化）
