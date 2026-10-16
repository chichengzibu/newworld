# #006 记忆持久化——"重启后记得你"（W3 首单，设计稿）

> **定性：休眠向量层持久化 + 双体系桥接**
> 生产文本记忆层 (`HermesMemory` → ConfigStore) **已在持久化**，重启不丢文本。
> 真正缺的是：① 向量缓存层（`MemoryVectorStore`）纯内存，重启全量重算 embedding；
> ② SelfLearner 与 HermesMemory 两套体系零桥接（首轮审计原债）。
>
> **本单不重写记忆架构**——补持久化缺口 + 桥接口 + 容量上限，禁扩新体系。

---

## Step A 侦察事实表（file:line 权威）

### A.1 MemoryVectorStore（`electron/hermes/MemoryVectorStore.ts`，115 行）

| 要素 | 实文 |
|---|---|
| 类型 | **纯内存** `Map<string, VectorEntry>`，零 fs、零 ConfigStore |
| embedding 来源 | `EmbeddingService.embedText(text)` → 默认 `stub-deterministic`（SHA-256 → 64 维）；可选 `ollama-nomic`/`openai-ada`/`zhipu-embedding` |
| 落盘函数 | **无**（`reset()` 清空全量，唯一生命周期方法） |
| 读写方 | `HermesAdapter` 独占（`recall` L66-70 + `store` L102），全仓零其他调用方 |
| 维度策略 | 首向量定维，后续向量维度/模型变化 → 全清重建（`MemoryVectorStore.ts:41-44`） |
| 生产调用方（`HermesAdapter.recall/store/curate/evolve`） | **全仓 grep 空** — `HermesAdapter` 四方法零生产调用（C1 实读，2026-10-13） |

### A.2 SelfLearner observations（`electron/learning/SelfLearner.ts`）

| 要素 | 实文 |
|---|---|
| 落盘路径 | `userData/skills/learning/observations.json`（L105） |
| 数据格式 | `{id, instruction, steps: any[], timestamp}[]`（L27-32） |
| 与向量记忆桥接 | **零**（`SelfLearner` 不 import HermesMemory/EmbeddingService/vectorStore，S2 全仓 grep 空） |
| 容量控制 | 硬上限 10 条，>10 自动 shift（L138-139） |
| 与 HermesMemory 关系 | **两套体系并行分叉** — 首轮审计原债坐实（C2 grep：`electron/hermes/` 引用面不含 SelfLearner） |

### A.3 HermesMemory legacy（`electron/hermes/HermesMemory.ts`，222 行）

| 要素 | 实文 |
|---|---|
| 文本持久化 | `ConfigStore['hermes.memories']` → `saveMemories()`（L74-80） |
| MD 文件 | `userData/hermes-memory/USER.md` + `MEMORY.md`（append，`L135-140`） |
| 检索方式 | `buildMemoryPrompt` → `retrieveRelevantMemories`：重要性+时间排序（L166-176），**非向量** |
| 写入触发 | `ChatManager:468` 正则匹配"文件/偏好/习惯"→ `addConversationMemory`（L468-469） |
| **生产主路径** | `ChatManager:437` `buildMemoryPrompt` + `ChatManager:468` `addConversationMemory`（C2 实读） |
| **向量路径** | `HermesAdapter.recall` → `MemoryVectorStore.search` — 全仓零生产调用（**休眠**） |

### A.4 ChatManager 记忆集成（`electron/chat/ChatManager.ts`）

```
L436  const hermes = HermesMemory.getInstance()          ← 直接 legacy
L437  const memoryPrompt = hermes.buildMemoryPrompt(content)
L441  systemPrompt += `用户记忆:\n${memoryPrompt}`
L468  hermes.addConversationMemory(conversationId, ...)  ← 对话沉淀写入
```
**关键定案**：
- 生产记忆主路径 = `HermesMemory`（关键词排序检索）
- `HermesAdapter.recall`（向量检索）**当前零生产接线**，属休眠子系统
- `HermesAdapter` 初始化点 = `main.ts:201`（`HermesAdapter.getInstance()` warmup），但 `recall` 调用方零

### A.5 ChatConfig 持久化（`electron/chat/ChatConfig.ts`）
- 落盘：`userData/chat.json`（L27）
- 容错：read fail → 用默认值（L69-71）；write fail → backup + 保存默认（L57, L118）
- `HermesMemory` 加载不依赖 `ChatConfig`，走 `ConfigStore['hermes.memories']`

### A.6 EmbeddingService（`electron/hermes/EmbeddingService.ts`，174 行）

| 模型 | 来源 | 维度 | 依赖 |
|---|---|---|---|
| `stub-deterministic`（**默认**） | SHA-256 本地 hash | 64 | 零 |
| `ollama-nomic` | 本地 Ollama（`:11434`） | 由模型返回 | 本地进程 |
| `openai-ada` | OpenAI API | 1536 | apiKey 网络 |
| `zhipu-embedding` | 智谱 API | 由模型返回 | apiKey 网络 |

- `EmbeddingService.cache`（L42）= 纯内存，重启丢失
- `dimension`（L43）= 实例内可变，首次调用后确定

### A.7 D5 裁决原文（`docs/decisions.md:13`）
> "记忆存储本地优先 (不上云同步/不上远端 memory 服务)"  
> 否决窗：**至 #006 设计稿**（本单）  
> 默认 provider = `stub-deterministic`（本地）— D5 已自动满足，本单不引入远端

---

## Step B 设计方案

### B.1 持久化层架构决策

**现状三层**：
```
[文本真源]        HermesMemory.memories       ← ConfigStore['hermes.memories'] (已持久)
[语义缓存]        MemoryVectorStore.entries   ← 纯内存 (重启丢, 需补持久化)
[学习观察]        SelfLearner.observations    ← observations.json (已持久, 独立体系)
```

**定案：补中间层，不重写顶层**

**向量记忆落盘文件**（新）：
```
userData/hermes-memory/vector-cache.json
```
格式（快照式，非 append — 理由见下）：
```json
{
  "version": 1,
  "model": "stub-deterministic",
  "dimension": 64,
  "entries": [
    {
      "id": "conv_1717372800_abc123",
      "vector": [0.01, -0.23, ...],
      "norm": 0.87,
      "model": "stub-deterministic",
      "ts": 1717372800000
    }
  ]
}
```

**选快照而非 append**（#004 选型论证沿用）：
- append-only 适合审计流（不可变）；向量缓存需支持**覆盖/删除**（条目 update 时 upsert 语义，append 要额外读全量再截断）
- `MemoryVectorStore.upsert` 是幂等覆盖（同 id 替换），快照语义天然匹配
- `ResetPolicy`（维度/模型切换全清）在快照文件里 = 直接重写整个文件，比 append 流更简单
- **#004 sqlite 论证沿用**：3:0（零 ABI / 零新依赖 / append-only 天然审计流）→ 快照 JSON 同理由

**落盘时机**：`MemoryVectorStore.upsert` 后 debounce 500ms（防批量写入时 I/O 风暴）；`delete` 后立即落盘

**容量上限**（Step B.2 遗忘规则）：
- MAX_ENTRIES = **200**（v1 锁死常量，`MemoryVectorStore.ts` 顶部 — `const MAX_CACHE_ENTRIES = 200`）
- 超限时保留**最近 ts** 的 200 条，最早的先被逐出（LRU 变体，无花哨规则）

### B.2 去重 + 遗忘

**去重**：
- **精确键**：`MemoryVectorStore.entries` 是 `Map<string, VectorEntry>` 以 `memory.id` 为键 → **天然精确去重**，同 id upsert 即覆盖（已存在，零改动）
- **相似度去重**：v1 不做（相似度判定需每次 upsert 全量算 cosine，O(N)，且阈值选择需实证，进 backlog 不实现）
- **设计稿登记**：`SEEN_CONTENT_HASHES`（SHA-256 of `memory.content`）可作 v2 相似度预过滤，本单不实施

**遗忘**（容量上限，简单可解释）：
```ts
evictIfOverflow(): void {
  if (this.entries.size <= MAX_CACHE_ENTRIES) return
  // LRU 变体: 保留 ts 最大的 MAX_CACHE_ENTRIES 条
  const sorted = [...this.entries.values()].sort((a, b) => b.ts - a.ts)
  const survivors = new Set(sorted.slice(0, MAX_CACHE_ENTRIES).map(e => e.id))
  for (const [id] of this.entries) {
    if (!survivors.has(id)) this.entries.delete(id)
  }
  void this.persist()
}
```
- 规则说明：**按写入时间 LRU，最新 200 条永远保留**；无 importance 权重（`HermesMemory.importance` 字段存在但语义未定，v1 不引入）

### B.3 启动加载（零 main.ts 接触）

**入口**：`HermesMemory.getInstance()` 构造器（`L30-38`）已在 `main.ts:201` 间接触发（`HermesAdapter.getInstance()` → `HermesMemory.getInstance()`）。

**新增**：`MemoryVectorStore` 加载器（`load()`，构造器调用）：
```ts
// 在 MemoryVectorStore 构造器末尾添加（private constructor 内）
this.loadFromDisk()
```
```ts
private loadFromDisk(): void {
  if (this.loadFailed) return  // 二次调用防御
  try {
    const p = this.cachePath()
    if (!fs.existsSync(p)) return  // 文件不存在 = 首次运行，正常空
    const data = JSON.parse(fs.readFileSync(p, 'utf-8')) as {
      version: number; model: string | null; dimension: number
      entries: Array<{ id: string; vector: number[]; norm: number; model?: string; ts: number }>
    }
    if (!data || !Array.isArray(data.entries)) throw new Error('bad shape')
    this.activeModel = data.model ?? null
    this.dimension = data.dimension ?? 0
    for (const e of data.entries) {
      if (!e.id || !Array.isArray(e.vector) || typeof e.ts !== 'number') {
        this.log.warn(`MemoryVectorStore: 跳过损坏条目 id=${e.id}`)
        continue  // #004 A1 同款: 撕裂行跳过, 不抛
      }
      this.entries.set(e.id, {
        id: e.id,
        memory: { id: e.id, content: '', score: 0, createdAt: e.ts }, // content 从 HermesMemory 回填
        vector: e.vector,
        norm: e.norm ?? this.l2Norm(e.vector),
        ts: e.ts,
        model: e.model,
      })
    }
    this.evictIfOverflow()
    this.log.info(`MemoryVectorStore: 加载 ${this.entries.size} 条向量 (model=${this.activeModel}, dim=${this.dimension})`)
  } catch (err) {
    // 文件全坏: 清空缓存，重建（不 throw）
    this.log.warn(`MemoryVectorStore: 缓存文件损坏, 清空重建: ${String(err)}`)
    this.entries.clear()
    this.dimension = 0
    this.activeModel = null
  }
}
```

**回填内容**：加载后条目 `memory.content` 为空字符串，首次 `search` 时由 `HermesAdapter.recall` L48 `this.legacy.getAllMemories()` 回填（现有逻辑，零改动）

**幂等写**：`persist()` 写入临时文件后 rename 原子替换（Windows: `rename` 对非存在目标目录安全；失败 → log.warn，不抛）

### B.4 D5 本地优先落地

- 默认 `stub-deterministic`（SHA-256）：**已满足 D5**（零网络）
- 持久化存向量本身：**若用 stub，存了 = 重启不重算**；若用 ollama/openai，向量也存，重启不重算（D5"存了不重算"精确命中，即使 API 不可达，已存向量仍可用）
- **新条目 embedding 策略**（如实写入）：
  - 若配置了真实 provider（ollama/openai）：新条目尝试 API 调用；失败 → 降级 stub 并落 `model='stub-deterministic'`（已有逻辑，`EmbeddingService:68-69`）
  - 无配置（生产现状，D5）：直接 stub，本地完成，零网络

### B.5 两套体系桥接口（Step B ②，禁分叉）

> **⚠ 与订单②的偏差自述（如实上报，此项未完全达标）**
> 订单②原文："SelfLearner 观察与向量记忆必须同一层或显式桥接，禁两套体系并行分叉"。
> 实读后发现**并存的是三套，不是订单设想的两套**：
> 1. `HermesMemory`（文本/语义真源）— **活**，走 `ConfigStore`，**已持久**（A.3）
> 2. `MemoryVectorStore`（向量缓存）— **休眠**，`HermesAdapter.recall` 全仓零生产调用（A.1），**未持久**
> 3. `SelfLearner.observations`（执行观察）— **活**，`observations.json`，已持久，独立目录（A.2）
>
> 其中 ① ↔ ② **已有显式桥接**：`HermesAdapter.store` L99-102 把每条记忆双写（`legacy.addExperienceMemory` 真源 + `vectorStore.upsert` 缓存），不是分叉。
> 真正的独立体系是 ③ SelfLearner，但它的语义是"执行侧学习"（我做了什么），与"用户语义记忆"（用户要什么）**正交**——强代码桥接 = 人为耦合。
>
> **本稿对 ③ 给的是文档边界声明，不是代码级统一 → 未满足订单"必须同一层或显式桥接"的硬要求。** 两个选项待裁决：
> - **X1（本稿默认）**：文档声明边界，③ 保持独立（语义正交，避免耦合）
> - **X2**：加一条单向投影——SelfLearner 观察沉淀出技能后，回写一条 `HermesMemory.addExperienceMemory`（代码级桥接，增加耦合）
> **推荐 X1**，但这是订单硬要求点，由你拍板。

**现状**（自证分叉）：
- `SelfLearner.observations[]` — 学习观察，落 `observations.json`，容量 10，独立生命周期
- `HermesMemory.memories[]` — 对话经验，落 `ConfigStore['hermes.memories']`，无容量上限
- **两者零数据流向**（S2 全仓 grep 空）

**本单桥接方案（最小，不重构）**：
1. `SelfLearner` **不写入向量记忆**（语义不同：observations 是"我执行了什么"，memories 是"用户要什么"）
2. **文档化边界**（设计稿 §B.5 即桥接口声明）：
   > SelfLearner = 执行侧学习（任务 → 技能），与 HermesMemory = 语义记忆（用户偏好/请求历史）**互补独立**，不共享存储。  
   > 若未来统一：`HermesMemory` 为唯一长期记忆真源，SelfLearner 作为短期工作记忆（10 条上限），两者通过 `ChatManager` 协调注入，不直接 cross-reference。  
   > 本单不实施统一，边界声明即桥接口，防分叉扩大。

3. **实际代码桥接口**（一处，最小）：
   - `HermesMemory.retrieveRelevantMemories` 增加 `filterByTag?` 选项，调用方可传 SelfLearner observation id（若需要跨引用时启用）— **代码不改，文档预留**

   **v1 不实施**，理由：两套语义正交，强桥接增加耦合，违背"简单可解释"原则。

### B.6 红线核查表

| 红线 | 状态 |
|---|---|
| 禁新增模块态 | ✅ `MemoryVectorStore` 已是单例（既有），持久化方法在类内，无全局 let |
| brain 无状态 | ✅ 本单不碰 `LlmAgentBrain`；向量层独立于脑 |
| 安全链零接触 | ✅ `commandDecide` / `BashTool` / 名单 / audit 全零改 |
| 幂等写 | ✅ `persist()` 原子 rename；`upsert` 语义幂等 |
| main.ts 零接触 | ✅ 入口在 `HermesMemory` 构造器（`main.ts:201` 已既有调用） |
| D5 本地优先 | ✅ 默认 stub，零网络；真实 provider 为可选配置 |

### B.7 文件变更清单

| 文件 | 改动 |
|---|---|
| `electron/hermes/MemoryVectorStore.ts` | +`loadFromDisk()` +`persist()` +`evictIfOverflow()` +`MAX_CACHE_ENTRIES` +`cachePath()` +`loadFailed` guard；`upsert` 末尾 `this.persist()`；`delete` 末尾 `this.persist()`；`reset` 清文件 |
| `electron/hermes/MemoryVectorStore.ts` 新文件 | （无新文件） |
| `docs/deviation-ledger.md` | 新增 `DEV-027`（v1 无相似度去重，LRU 按 ts 保留最新 200 条，语义重叠条目去重进 backlog） + 新增 `DEV-026`（退出 flush 依赖既有 dispose 链，W5 接线时验证） |
| `docs/decisions.md` | D5 状态更新：`→ 已固化 (2026-10-13 #006，本地 stub 默认，向量落盘不重算)` |

### B.8 并发竞态三钉子（#006 Step A verdict 增量，N1-N3）

**背景**：`upsert → persist` 在并发场景（同帧多 upsert / debounce 窗口内多次触发 / 加载与写入交叉）会产生「后写覆盖前写」或「半截文件」竞态。三钉子：

**N1 写队列（单飞串行）**：所有 `persist()` 调用排入 `writeChain` Promise 队列（`this.writeChain = this.writeChain.then(() => writeToDisk(快照))`），同一实例内串行落盘，消除 in-flight 覆盖。`flush()` = 取消 debounce 定时器 + 触发一次排队写 + `await writeChain` 排空（退出/测试路径用）。

**N2 原子 rename**：先写 `vector-cache.json.tmp`，`fs.renameSync(tmp, final)` 覆盖目标（同卷原地改名）— 进程崩溃只留孤儿 tmp，不产生半截正式文件（#004 A1 原子写同款；加载侧启动时清理孤儿 tmp）。

**N3 先载后写断言**：构造器 `loadFromDisk()` 未完成前（`hasLoaded=false` 且非 loadFailed 态），`persist()` 早退不落盘 — 防止「加载中途」被 upsert 触发的 persist 把磁盘旧数据覆盖成空快照；V2 用例即此断言（新实例加载后**立即**并发 3 连写 + flush，断言磁盘含全部 3 条）。

**debounce flush 钩子定案（五裁决 #2，500ms 采纳默认值）**：`upsert` 触发 debounce 500ms 写；`flush()` 供显式排空；**退出路径不接 `app.on('before-quit')`（main.ts 冻结面）→ 依赖既有 dispose 链，登记 DEV-026（W5 接线时验证）**。

**X1 双向注释落点（裁决 #1）**：正向 = `MemoryVectorStore.ts` 顶部注释（本层定位 + 三套体系边界 + 桥接入口指向 `HermesMemory.addExperienceMemory`）；反向 = `SelfLearner.ts` 顶部注释（执行观察层定位 + 指向本层）。已落盘。

**README 数据流图（裁决 #1）**：`electron/hermes/README.md`（三套体系定位表 + ASCII 数据流图 + 红线不变量 + 测试映射 + 电池口径 83 文件/1018 过）。已落盘。

**V7 零网络断言（裁决 #2）**：V7 用例拦截 `globalThis.fetch`，stub-deterministic 路径 `embedText` + 完整 upsert→flush 闭环后断言 `fetchCalls === 0`（D5 天然满足，实测为证，非口算）。



---

## Step C 测试案

| 案 | 描述 | 预期 |
|---|---|---|
| V1 持久化往返 | `upsert(mem, vec)` → 等 debounce 落盘 → `reset()` 重建实例 → `loadFromDisk` → `search(query, topK)` 结果与落盘前一致 | `ok` (score 容差 0.001) |
| V2 重启模拟 | 实例 1 写 3 条 → `instances.clear` → 实例 2 `loadFromDisk` → `list().length === 3` | `3 === 3` |
| V3 去重（精确 id） | 同 id 两条不同内容 upsert；`list` 仅保留最新 | `length === 1`，content 为新值 |
| V4 容量遗忘 | MAX_CACHE_ENTRIES=5（测试用临时值）；写 8 条 → `size() === 5`，保留 ts 最新 5 | 最早 3 条被 evict |
| V5 损坏容错 | `vector-cache.json` = `{bad: ...}` → `loadFromDisk` 不抛，`size() === 0` | 0 |
| V6 损坏单条 | 5 条 entries，1 条 `vector` 字段非数组 → 跳过坏条，保留 4 条 | `size() === 4` |
| V7 D5 零网络 | `stub-deterministic` + 断言 `EmbeddingService` 不 fetch（mock fetch 记录 0 调用） | `fetchCalls === 0` |

**电池口径**：
- 基线 = 本单前实测（#005 收官）
- 预期 = 基线 + 7（V1-V7）
- 实跑为准，禁对齐口算值

---

## 开放点（待裁决）

| # | 问题 | 推荐 | 理由 |
|---|---|---|---|
| 1 | `MAX_CACHE_ENTRIES` 是 200 还是 500？ | **200** | 100KB × 200 × 64 维 ≈ 50MB 磁盘，合理；500 ≈ 125MB，过大 |
| 2 | 落盘 debounce 500ms 还是每次 upsert 即写？ | **500ms debounce** | 批量 upsert 时 I/O 风暴；500ms 窗口内多条落盘合并一次 fs.write |
| 3 | `HermesMemory.memories` 本身（文本层）是否加容量上限？ | **不加**（v1） | 文本在 ConfigStore，容量随磁盘；向量层有上限已够；两套上限分开管理更简单 |
| 4 | 两套体系桥接口实际是否要写代码？ | **文档声明即桥接口，零代码** | 语义正交（执行侧 vs 语义侧），强桥接增加耦合；文档边界防分叉已满足"禁两套分叉"要求 |
| 5 | `SelfLearner.observations` 落文件路径与 `hermes-memory/` 目录是否合并？ | **不合并**（保持独立路径） | 语义不同，合并目录增加认知负担，独立目录 + 文档桥接口是最低成本 |
