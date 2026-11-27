# NOVA #009 — M4-I 记忆库/向量库 id 对齐（每次召回都在重嵌）

> **状态**：已实现（2026-11-02）
> **对应台账**：DEV-106 ~ DEV-108
> **分支**：`feat/harness-wiring`

## 一、为什么做这件事

### 1.1 症状:召回照样能返回记忆,但向量层一直在白烧算力

`HermesMemory.addExperienceMemory` **内部**生成 id（`mem_<ts>_<rand>`），
**无视**调用方给的 id。而 `HermesAdapter.store()` 只能拿调用方给的 id 写向量库。

两边 id 对不上，于是：

| 现象 | 机制 |
|---|---|
| **每次召回都重新嵌入全部记忆** | 召回的候选来自记忆库（真实 id）→ 在向量库里按调用方 id 建的条目**查不到** → 全部重新嵌入 |
| **一条永远匹配不上的孤儿** | 调用方那个 id 的条目在向量库里躺着，召回永远命中不了它，白占索引容量 |

### 1.2 为什么这么难发现

结果**看起来是对的** —— 召回照样返回正确的记忆（因为每次都重嵌了）。
唯一的破绽是「记忆被重复嵌入了几次」这个**计数**。

所以这类的正确测法是：**盯嵌入次数，而不是盯召回结果**。

### 1.3 我第一版修错了

我最初的修法是「两边都用记忆库自己生成的 id」。跑测试立刻挂了两个：

- `memory-consumption-006-5.test.ts` **W1b**：`store` 两连发同 content，向量层不得重复
- `hermes-memory.test.ts`：经验记忆文件落盘到 MEMORY.md

**W1b 让我看清了我漏掉的东西**：调用方给的 id 不是随手给的 ——

```ts
// ChatManager.ts
const idHash = createHash('sha256').update(`${conversationId}|${content05}`).digest('hex').slice(0, 16)
await adapter.store({ id: `chat-${idHash}`, content: content05, ... })
```

那是 #006.5 W1 定的**幂等键**：「同 conversationId+content → 同 id → Map 覆盖，不重复」。
而记忆库**无视**这个 id、自己另生成一个 → **幂等从一开始就没真正生效过**
（只是碰巧在同一层里覆盖了）。

## 二、修法

### 2.1 让记忆库认调用方的 id

```ts
public addExperienceMemory(content: string, tags?: string[], id?: string): MemoryItem {
  // 幂等:同一 id 已存在 → 不重复追加,返回既有条目
  if (id) {
    const existing = this.memories.find(m => m.id === id);
    if (existing) return existing;
  }
  const item: MemoryItem = { id: id ?? `mem_${Date.now()}_${rand}`, ... };
  ...
}
```

`HermesAdapter.store()` 把 id 传下去 → 记忆库与向量库用**同一个 id** →
**幂等（覆盖）与召回命中（查得到）同时成立**。

id 与返回值都是**可选**的 —— 既有用法（`addExperienceMemory(content, tags)`）行为完全不变。

### 2.2 我在过程中犯的两个错（都写进注释当护栏）

1. **`return item` 插错位置** —— 插在 `saveMemories()` 之后、`appendFileSync(MEMORY.md)` 之前 →
   **跳过了经验记忆落盘**。hermes-memory 测试立刻抓到。
   → 教训：改一个「有副作用的函数」时，返回值要放在**所有**副作用之后。
2. **测「不再重复嵌入」时把查询嵌入也算进去了** —— 每次召回都要嵌查询向量，那是必须的；
   要盯的是**记忆**被重复嵌入。→ 教训：断言「浪费」时，计数器必须按语义分开，
   否则测的是别的东西。

## 三、验证

| 项 | 之前 | 现在 |
|---|---|---|
| vitest | 119 files / 1403 passed | **121 files / 1427 passed / 0 FAIL** |
| 后端 typecheck | 0 error | **0 error** |
| 前端 vue-tsc | 0 | **0** |
| `npm run build` | 通过 | **通过** |

新增测试 `tests/unit/memory-store-id-m4i.test.ts`（5 例）：

- store 后向量库的 id == 记忆库的真实 id（两边对齐）
- 调用方给的 id 是**幂等键**（同 id 两次 store → 只净增一条，记忆库也只有一条）
- **第二次召回不再重复嵌入【记忆】**（向量索引真的当缓存用了）—— 记忆只嵌 1 次，查询每次 1 次
- 召回仍能命中该记忆（修 id 不能把功能修坏）
- `addExperienceMemory` 返回创建的条目

同时保持绿的既有测试：`memory-consumption-006-5`（W1/W1b 幂等、R-2 召回命中、Q1 管线往返）与 `hermes-memory`（MEMORY.md 落盘）。

## 四、遗留

| # | 遗留 | 归属 | 说明 |
|---|---|---|---|
| 1 | **记忆库只增不减** | 后续 | `memories` 数组无上限、无清理策略，长期使用会持续膨胀（与 CostTracker 的 usages 同类问题） |
| 2 | **向量库容量 200 条** | 后续 | 超出后按最旧淘汰 —— 但「最旧」不等于「最不重要」，可考虑按访问频次 |
| 3 | **跨会话同内容仍会各存一条** | 设计口径 | 幂等键含 conversationId → 同一内容在不同会话里是两条记忆。这是 #006.5 的原定口径（按会话去重），本批未改 |
