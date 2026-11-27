# NOVA #009 — M3-B 混合检索（中文分词 + RRF 融合）

> **状态**：已实现（2026-10-28）
> **对应台账**：DEV-073 ~ DEV-075
> **分支**：`feat/harness-wiring`
> **路线图**：`docs/plan/v5-10week.md` M3 ——「知识库真向量（sqlite-vss + bge-m3 + rerank）」
> **前置**：[M3-A 真向量](NOVA-#009-m3a-real-vectors-design.md)

## 一、为什么做这件事

M3-A 把真向量接上了，但检索质量还有两个硬伤 —— 它们都**只在中文上暴露**，
而这个产品是国产中文桌面助手。

### 1.1 硬伤一：中文根本没有被分词

`KeywordRetriever.tokenize` 按 `[\s\p{P}]+` 切分，只切空格与标点。对中文的后果：

```
「用户习惯把桌面上的 PDF 文档统一归档」
  → ["用户习惯把桌面上的", "pdf", "文档统一归档"]
```

整句成词条 → 只有**字面完全一致**的长句才匹配得上，**改写一个字就召不回**。

这不是"精度差一点"，是关键词这条路对中文**基本失效**。

### 1.2 硬伤二：两把不同的尺子比大小

`HermesAdapter.recall` 对两路结果**取分数的最大值**：

| 路 | 分数是什么 | 量纲 |
|---|---|---|
| 关键词路 | 命中词数 / 查询词数（覆盖率） | ∈ [0, 1] |
| 向量路 | 余弦相似度 | ∈ [-1, 1] |

两者量纲完全不同，却直接比大小。后果：

- 命中 1 个字面词的弱匹配（覆盖率 1.0）能盖过语义高度相关的结果（余弦 0.9）
- 只在一路出现的结果，得分完全由那一路决定，另一路的证据被丢弃
- **两路都命中的结果（最该排前面的）得不到任何加分**

## 二、设计依据

### 2.1 CJK bigram：不带词典的中文词法

中文没有词边界，又不想为此引入分词词典（体积大、更新难）。标准做法是
**字符 bigram**：把 CJK 连续段切成相邻两字的组合。

```
「文档统一归档」 → ["文档", "档统", "统一", "一归", "归档"]
```

- 不需要词典，无外部依赖
- 对**字面重叠**有效：改写后仍能通过共享字对命中
- 边界诚实：bigram 只解决字面重叠，**解决不了同义** —— 同义仍归向量那一路

### 2.2 RRF：只看排名，不看分数

RRF（Reciprocal Rank Fusion，Cormack et al. 2009）是混合检索的标准做法：

```
score(d) = Σ over lists  1 / (k + rank_list(d))     k = 60
```

- **量纲问题消失** —— 名次是序数，不是实数
- **双路一致加成** —— 两路都命中的结果得分接近翻倍，「双路一致」成为强信号
- **不需要给两路分数做归一化** —— 那一步最容易引入手工调参的偏差

这是 Elasticsearch / Weaviate / Cohere 都在用的做法。

### 2.3 口径：两路互补，不是二选一

- 关键词路（bigram）：管**字面重叠** —— 精确的路径名、命令、专有名词
- 向量路（bge-m3）：管**语义相近** —— 改写、同义、意图
- 融合：**取两路的名次**，而不是取两路的分数

## 三、实现

### 3.1 CJK bigram 分词（`electron/hermes/KeywordRetriever.ts`）

```ts
tokenize(text) {
  for (const seg of text.split(/[\s\p{P}]+/u)) {
    const runs = seg.match(/[CJK]+|[^CJK]+/gu)   // 中英混排也要分段
    for (const run of runs) {
      if (CJK.test(run)) {
        const chars = Array.from(run)
        if (chars.length === 1) out.push(chars[0])
        else for (let i = 0; i < chars.length - 1; i++) out.push(chars[i] + chars[i+1])
      } else {
        const t = run.toLowerCase()
        if (!STOP_WORDS.has(t)) out.push(t)
      }
    }
  }
}
```

要点：
- **中英混排先分段**（"PDF文档" → `["pdf", "文档"]`），不把整段当一个词条
- 单字 CJK 段保留单字
- 拉丁词仍按词切 + 小写 + 停用词过滤（原有行为不变）

### 3.2 RRF 融合（`electron/hermes/HermesAdapter.ts`）

```ts
export function rrfFuse(lists, k) {
  const fused = new Map<string, ScoredMemory>()
  for (const list of lists) {
    list.forEach((item, index) => {
      const contribution = 1 / (k + index + 1)
      const existing = fused.get(item.id)
      if (existing) existing._score += contribution
      else fused.set(item.id, { ...item.memory, _score: contribution })
    })
  }
  return Array.from(fused.values()).sort((a, b) => b._score - a._score)
}
```

口径：`minScore` 仍是**向量路的语义门**（低于此相似度不进候选）；
融合只决定候选之间的排序。关键词路没有分数门 —— 覆盖率不适合设门。

## 四、实测（本地 ollama bge-m3，真跑）

### 4.1 关键词路：改写查询集（6 条，与目标**无字面重叠**）

| 分词器 | top-1 命中 |
|---|---|
| 旧（按空格/标点切） | **0 / 6** |
| 新（CJK bigram） | **1 ~ 2 / 6** |

旧分词器在中文改写查询上**几乎完全失效**；bigram 把它救回来了一部分。

### 4.2 混合查询集（8 条：3 条字面 + 5 条改写）

| 路径 | top-1 命中 |
|---|---|
| 向量（真） | 7 / 8 |
| 关键词（旧分词） | 3 / 8 |
| 关键词（bigram） | 4 / 8 |
| 混合（取最大，旧融合） | 7 / 8 |
| 混合（RRF，新融合） | 7 / 8 |

### 4.3 诚实结论

**分词是可测量的改善；RRF 在命中率上与「取最大」持平（7/8）。**

RRF 的价值是**结构性的**，不是命中率上的：

1. 消除了「拿覆盖率比余弦」这个量纲错误
2. 双路一致加成（见 §2.2）
3. 不需要给两路分数做归一化

因此测试断言的是**性质**（量纲无关性、双路一致加成），**不是命中率** ——
把一个恰好持平的数字写成"命中率提升"是不诚实的。

## 五、验证

| 项 | 基线 | 现在 |
|---|---|---|
| vitest | 113 files / 1354 passed | **114 files / 1367 passed / 0 FAIL** |
| 后端 typecheck | 29 error | **29 error（零新增）** |
| 前端 vue-tsc | 0 | **0** |

新增测试 `tests/unit/hybrid-retrieval-m3b.test.ts`（11 例）：
- 分词：中文 bigram · 单字 · 中英混排分段 · 拉丁词行为不变 ·
  **改写查询命中(旧分词器做不到,锁住 0 命中这个事实)** · 覆盖率有区分度
- RRF：**分数放大 100 倍排序不变**(量纲无关) ·
  **双路一致排在单路之前(同一组数据下旧融合给错答案)** · 单路结果不丢 · 空列表不炸 · 单调不增

集成测试扩展 `tests/integration/embedding-local-ollama.test.ts`（+2 例，打真本地 ollama）：
- **CJK bigram 让关键词路在改写查询上重新有效**(旧 0/6 → 新 > 0)
- **混合(RRF)不劣于纯向量路**(融合的底线是"不添乱")

## 六、遗留与后续

| # | 遗留 | 归属 | 说明 |
|---|---|---|---|
| 1 | **rerank 未做** | 后续 | 路线图写的「bge-m3 + rerank」。**本地 ollama 0.40.11 没有 `/api/rerank`**（实测 404），要做需另接一个 cross-encoder 服务（TEI / Cohere / Jina） |
| 2 | **sqlite-vss 未做** | 后续 | 当前是 `vector-cache.json` 全量 JSON，上限 200 条。桌面应用这个量级够用；换 sqlite 是**规模问题不是正确性问题**，且要引入原生依赖（构建风险） |
| 3 | **bigram 解决不了同义** | 设计边界 | 「归档」↔「收纳」共享不到字对。这正是向量那一路的职责 —— 两路互补 |
| 4 | **关键词路无分数门** | 后续 | 覆盖率不适合设固定阈值。若要加,应按查询词数自适应 |

## 七、参考资料

- Cormack, Clarke, Buettcher — *Reciprocal Rank Fusion outperforms Condorcet and individual Rank Learning Methods*（SIGIR 2009）
  —— RRF 原始论文；k=60 为标准取值
- Elasticsearch / Weaviate / Cohere 的混合检索默认实现 —— 均为 RRF
- 中文 bigram 索引 —— 无词典的经典做法（与 CJK 分词器的取舍：体积 vs 准确率）
- 本地实测：ollama 0.40.11，`/api/embed` 与 `/api/embeddings` 可用，`/api/rerank` → 404
