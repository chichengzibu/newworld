# PiPiClaw 记忆持久化层 (#006)

本目录实现 **"重启后记得你"** — 文本真源与向量缓存统一持久化。
设计依据: `docs/#006-memory-persistence-design.md` (B.1-B.7, N1-N3, D5)

## 数据流图

```
                         ┌─────────────────────────────────────────────┐
                         │  ChatManager                                │
                         │  用户对话 → addConversationMemory           │
                         │            (生产唯一写入入口, :468)        │
                         └──────────────┬──────────────────────────────┘
                                        │
                    ┌───────────────────┼──────────────────────┐
                    │                   ↓                      │
                    │       ┌──────────────────┐                │
                    │       │   HermesMemory   │                │
                    │       │  (文本真源)      │                │
                    │       │  hermes.memories │                │
                    │       │  [ConfigStore]   │                │
                    │       └────────┬─────────┘                │
                    │                │                            │
                    │                ↓                            │
                    │   ┌──────────────────────────┐              │
                    │   │   EmbeddingService       │              │
                    │   │   embedText → vector[]   │              │
                    │   │   (stub/ollama/openai)   │              │
                    │   └────────────┬─────────────┘              │
                    │                │                             │
                    │                ↓                             │
                    ┌───────────┐   ┌──────────────────────────┐   │
                    │  Self     │   │  MemoryVectorStore       │   │
                    │  Learner  │   │  (语义向量缓存)          │   │
                    │  (执行观  │   │  向量层                  │   │
                    │   察层)   │   │  LRU 容量 MAX=200        │   │
                    │ obs.json  │   │  写队列(N1)+原子rename   │   │
                    └───────────┘   └────────────┬─────────────┘   │
                                                 │
                                                 ↓
                                       ┌──────────────────┐
                                       │ userData/        │
                                       │ hermes-memory/   │
                                       │  vector-cache.json
                                       └──────────────────┘
```

## 三套体系定位 (B.5)

| 层 | 文件 | 真源 | 持久化 | 语义 |
|---|---|---|---|---|
| ① 文本真源 | `HermesMemory` | ConfigStore['hermes.memories'] | 已有 | "用户要什么" |
| ② 语义向量 | `MemoryVectorStore` | 本层 vector-cache.json | #006 新增 | "用户要什么语义" (embedding) |
| ③ 执行观察 | `SelfLearner` | observations.json | 已有 | "用户做了什么" (行为流) |

## 关键不变量 (红线)

- **模块态零新增**: 所有状态挂在 `MemoryVectorStore` 单例 (实例字段), 禁止 `let ...` 模块级
- **brain 零接触**: 本层不依赖 LlmAgentBrain, 仅读 `EmbeddingService`
- **安全链零接触**: 本层不 import `commandDecide` / `constants` / `BashTool`
- **幂等写**: `upsert(id)` 同 id 覆盖; LRU 淘汰按 `ts` 单调性, 重启重建不重复
- **main.ts 零接触**: 入口 `main.ts:201` 已在 `HermesAdapter.getInstance()` 链路上,
  本层通过构造器 `loadFromDisk` 自动挂载, 无需 main.ts 新增代码

## 文件

| 文件 | 职责 |
|---|---|
| `MemoryVectorStore.ts` | 向量层 (N1 写队列 + N2 原子 rename + N3 先载后写 + LRU 200) |
| `HermesMemory.ts` | 文本真源 (ConfigStore 键 `hermes.memories`, 不变) |
| `EmbeddingService.ts` | embedding 生成 (stub-deterministic / ollama / openai) |
| `HermesAdapter.ts` | facade (store/recall/curate/evolve, 休眠但接口已对齐) |
| `KeywordRetriever.ts` | keyword 检索 (fallback, 不受向量层影响) |

## 容量遗忘 (B.2)

`MAX_CACHE_ENTRIES = 200` (常量锁于 `MemoryVectorStore.ts` 顶部, 五裁决 #1)。
LRU 规则: 按 `ts` 升序, 超出 200 时淘汰最旧 (ts 最小) 若干条。
简单可解释, 无花哨衰减/相似度合并 (订单红线: "禁花哨")。

## D5 默认生效 (本地优先)

`EmbeddingService` 在无 provider 配置时走 `stub-deterministic`
(SHA-256, 64 维, 零网络) — D5 天然满足。
`ollama`/`openai` 为可选配置, 仅用户显式配置时启用。
**已持久化的向量重启后不重算** (D5 核心保证)。

## 测试

`tests/unit/memory-vector-persistence.test.ts` (7 例 V1-V7):

- V1 持久化往返 (upsert → flush → 新实例 → load → search 一致)
- V2 重启模拟 + 并发不吞 (N1 写队列)
- V3 精确去重 (同 id 覆盖)
- V4 容量遗忘 (maxE=5 验 LRU 规则)
- V5 损坏容错 (非法 JSON)
- V6 单条损坏 (vector 非数组)
- V7 D5 零网络 (stub 路径 fetch 零调用)

电池预期: #005 基线 82 文件 / 1011 过 + 本文件 1 文件 / 7 用例 = **83 文件 / 1018 过**
(实测口径, 见提交消息)。
