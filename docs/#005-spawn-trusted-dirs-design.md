# #005 设计稿 — spawn 真独立 + D6 可信目录联动（M2 收官单）

**版本**：v1 草案（2026-10-13）
**纪律**：本稿 = Step 0 + Step A 双章设计交付；**零生产码 / 零测试码**（过审后才落）。
**三提交计划**：① Step 0（DEV-014 地基）→ ② spawn → ③ D6，各带测试同体，每笔绿。

---

## 0. 关键实读清单（本稿全部论点的地基，门禁可逐行核）

| 事实 | 证据（file:line 实读） |
|---|---|
| contextKind 模块态单写点 | `ChatManager.ts:984` 唯一 `setCommandContext` 调用（`commandDecide.ts:48` 定义）|
| contextKind 单读点 | `BashTool.ts:52` 唯一 `getCommandContext()` 读（brain 链）|
| gateway 轨走参数（非模块态）| `OpenClawGateway` `executeOperation(request, source)` 第二参；回归钉 T 系列 `tests/unit/gateway-source-injection.test.ts:52-110` 5 用例 |
| spawn 生产调用者 = **零** | `grep .spawn(` 生产面空；`LlmAgentBrain.ts:398` `return { id, brain: this }` stub（`this` 自引用 = 独立性红线违反的既有债） |
| 旧子代理栈（休眠）| `SubAgentSpawner.ts:38-58`（`AgentBrainImpl.create()` + depth 参数）；`ExecutionEngine.ts:63` 注释"SubAgentSpawner W5.2.3 接管" |
| think 生产调用面 | `ChatManager.ts:985`（现役）/ `SubAgentSpawner.ts:67` / `ComputerUseHandler.ts:79` / `D3RemoteCommand.ts:36`（后三者休眠） |
| chat 活跃链回归钉 | `tests/unit/chat-execution-ui.test.ts:127/146/165` B-1/B-2/B-3 共 3 用例 |
| cwd 校验单点 | `commandDecide.ts:250` `isCwdInSandbox` 唯一关卡；无 cwd 默认 `<userData>/sandbox`（:256-258） |
| token usage 流面 | `LlmClient.ts:99-100` 流内含 `{type:'usage', usage}` chunk（brain `callLlmOnce` 现未聚合——聚合面天然存在） |
| 配置文件承载先例 | `ConfigStore.ts:137/155` `get/set`；`AgentConfig` 键 `agent:config` 先例；`maxSubAgentDepth: 3` 已在旧默认（本单 v1 钉 **1**，覆盖旧默认不删旧键） |
| 快照机制就绪 | `RunCheckpointManager`（#004, `22140e1`）append-only + `RunSnapshotPayload` 可扩字段 |
| 旧三件套/`RetryPolicy` 边界 | DEV-024 停放 W5；`RetryPolicy.ts` 有 `ChannelRouter.ts:14/89` 生产引用，**本单禁随栈删** |

---

## 1. Step 0 — DEV-014 专项前插（安全地基，本单硬前置）

### 1.1 风险模型（为什么"不修地基不盖楼"）

- 现状：`setCommandContext('headless'|'ui'|…)` 写**全局单例变量** `_ctx`（`commandDecide.ts:47-49`）。
- 并发互染场景：会话 A `chat:execute`(ui) 进行中（LLM 流式，秒级）→ 会话 B `im_inbound` 进入 → `dispatchToAgent` L984 写 `_ctx='im_inbound'` → A 的 brain 在下一轮 tool loop 调 `BashTool` → `getCommandContext()` 读到 **B 的 kind** → A 的命令被 B 的上下文判决（ui→im_inbound 降权，或反之 headless→ui 升权——双向都不对）。
- spawn 放大因子：子代理与父代理**同线程并发**（父 wait 子），子代理 tool 执行期间父代理 contextKind 若被 UI 侧改写 → 子代理判决被改写。**子代理是并发密度最高的面**——所以 Step 0 是 spawn 的硬前置。

### 1.2 两案对比（真二选一，链深论证首次成立）

链路：`ChatManager.dispatchToAgent(L985) → AgentBrain.think → LlmAgentBrain.run → 每轮 tool.execute` —— 4 层。

| 维度 | **案 P：显式参数贯穿** | **案 A：AsyncLocalStorage** |
|---|---|---|
| 触及面 | `tools/Tool.ts` 接口 `execute(args)` → `execute(args, ctx?)` + brain 传 + ChatManager 传。**BashTool 读点改 `ctx?.contextKind ?? getCommandContext()`** | `commandDecide` 新增 `RuntimeCtxStore`（ALS 封装 `run(ctx, fn)`）+ 读点改 `store.get() ?? _ctx` + ChatManager `run()` 包裹 |
| 漏传后果 | 缺 `ctx` → 默认 headless（**fail-safe 显式**，可 grep `execute(` 全量审计） | 缺 store → 落 `_ctx` 模块态（**fail-safe 隐式**，依赖"没跑到就是 headless"的语义推断） |
| 新增抽象量 | 1 个可选参 + 2 个类型（`RuntimeToolContext` / `RuntimeScope`） | 1 个新模块（store + run 包装 + 兼容层） |
| 并发安全保证 | **调用链逐跳显式持有** —— 每个 await 边界都携带自己的 ctx，无共享可变量 | 异步链内 store 绑定 —— **前提**是全程无 `Promise.resolve().then` 断链/无 worker_threads（Node 20.14 的 ALS 在 `await` 链内传播稳定，`child_process.execFile` 不影响父链） |
| 可测试性 | 参数 = 可直接断言（`execCommand` 收到什么就判什么，**与现有 gateway 5 用例同构**） | 需在测试内建 store 生命周期（现有 8 个回归钉的 mock 面要适配 `store.run`） |
| DEV-014 统一解一致性 | #003-fix 先例（HistoryAssembler 显式参数）/ #004 先例（opts.checkpoint 钩子）——**三次决策同方向** | 与前述三次"显式参数"先例反向 |
| 隐性风险 | 新增调用点忘传 → headless（降权，安全方向） | store 断链回落 `_ctx` → **可能读到别的会话残留 kind**（`_ctx` 全局态仍在，ALS 断链时行为 = 现状 bug 复现） |
| 结论 | ✅ **推荐** | ❌ 否决（隐性回落路径与要修掉的 bug 同构） |

### 1.3 推荐实现（案 P，最小触及）

| 文件 | 改动 | 冻结面自检 |
|---|---|---|
| `electron/agent/tools/Tool.ts` | `PiPiTool.execute` 签名扩：`execute(args: Record<string, unknown>, ctx?: RuntimeToolContext): Promise<ToolExecResult>`；新增类型 `RuntimeToolContext { contextKind: ContextKind; runScope: RunScope }`、`RunScope { runId: string; parentRunId?: string }`（预留 #006/#007） | 接口扩，**非咽喉文件**（Step 0 豁免面外但签名扩，BashTool/EditTool/ReadTool 三实现零改动——可选参） |
| `electron/agent/tools/BashTool.ts` | `execute(args, ctx?)`；`contextKind: ctx?.contextKind ?? getCommandContext()`（**读点唯一改**） | **豁免面（Step 0 明示）**；咽喉逻辑零改 |
| `electron/agent/LlmAgentBrain.ts` | `run` 内部 tool loop 传 `{ contextKind: this.runCtx?.contextKind, runScope: { runId, parentRunId } }`；`run` opts 加 `contextKind?` + `parentRunId?`；`think` 从 `ctx.contextKind` 透传（`AgentContext.contextKind` 字段已存在 `contracts/types.ts:124`） | 豁免面；**无状态红线**：contextKind **不作为字段存**——`run` 局部 const（`runCtx` 是 run 函数作用域，与 #004 `convId` 同位） |
| `electron/chat/ChatManager.ts` | L985 `registeredAgent.think({ ..., contextKind: effectiveKind })`（**字段已传**——`dispatchToAgent` L985 实读已含 `contextKind: effectiveKind`，**本单 ChatManager 零改动**）；L984 `setCommandContext` **保留**（gateway 轨兼容 + headless 兜底底） | **零接触**（字段已就位） |
| `tests/unit/runtime-context-propagation.test.ts`（新） | 并发互染攻击用例（§1.5） + gateway 5 用例原样绿 + chat 3 用例原样绿（不新增，跑既有文件验证） | 测试新增 |

**关键收敛**：`RuntimeToolContext` 是**最小接口**（2 字段），`RunScope` 为 #006 预留位——**本单只填 contextKind 值，runScope 传 `null`**（避免本单扩张范围）。`BashTool` 读 `ctx?.runScope` 留空给 W5 接线批（DEV-023 同点修）。

### 1.4 回归钉保绿方案

- 现 5 用例（gateway-source-injection）**全走 `execCommand` 参数轨**——本单**不动** `execCommand` 签名 → 5 用例语义零变（**机制变了：`contextKind` 参数值在 `BashTool` 内部从 `getCommandContext()` 改为 `ctx?.contextKind ?? getCommandContext()`——gateway 轨不经 `BashTool` 直读参数，读点语义不变**）。
- 现 3 用例（chat-execution-ui）——**同样**走 `execCommand` 参数，`ChatManager` 字段已传，机制变化对 3 例透明。
- **结论**：两回归钉文件**零断言修改**，只跑不删不改。

### 1.5 Step 0 测试（新增，1 文件 3 用例）

- S0-1 **并发互染攻击**：`chat A(ui)` 与 `im B(im_inbound)` 并发 `dispatchToAgent` → B 先跑（写 `_ctx='im_inbound'`）→ A 的 `BashTool` 调用后断言 A 的 `execCommand` 收到 `contextKind='ui'`（**不是 im_inbound**）。用 `setConfirmTransport` 探针 + `setCommandContext('im_inbound')` 制造污染面 + `await` 时序控制，**断言 A 的判决未被 B 的 _ctx 污染**。
- S0-2 **缺 ctx 兜底 fail-safe**：`BashTool.execute` 不传 ctx → `getCommandContext()` 兜底 headless（`_ctx` 未被会话污染面读到别家）。
- S0-3 **子代理 contextKind 继承**：父 run `contextKind='ui'` → 子 run（`spawn`）继承 `'ui'`（用 Step 0 机制承载，#004 `opts.checkpoint` 钩子透传同款思路）。

---

## 2. Step A 章 1 — spawn 真独立

### 2.1 七条 spec → 文件映射

| spec # | 实现 | 文件 |
|---|---|---|
| ① 返回新 LlmAgentBrain 实例, 禁 `brain: this` | `LlmAgentBrain.spawn(subtask, parent: SpawnContext): Promise<SubAgent>` **重写**（stub `:398-401` 删）→ 新建 `sub-brain-{ts}-{rand}` 实例（**非单例**，用 `Object.setPrototypeOf` 或**新公开构造**——**推荐**把 `LlmAgentBrain` 私有构造改**内部工厂方法** `LlmAgentBrain.create(ctx)`，子实例通过工厂建）；`SpawnContext { parentRunId, contextKind, checkpointHook?, runScope? }` 入参 | `electron/agent/LlmAgentBrain.ts`（新增 `static create(ctx)`；`spawn` 重写） |
| ② 子代理 contextKind = 父上下文显式传 | 父 `run` 构造时把 `this.runCtx`（run 局部）注入 `create(ctx)` 参数；子 `run` 启动后 `this.runCtx = ctx.contextKind`（**run 作用域局部**，非模块态）；**Step 0 机制承载**（§1.3） | 同文件 |
| ③ MAX_SPAWN_DEPTH=1 | 新增常量 `electron/agent/constants.ts`（新文件或 `LlmAgentBrain.ts` 顶部）；`spawn` 内 `ctx.depth >= MAX_SPAWN_DEPTH` → **throw** `SpawnDepthExceededError`（**非静默**——调用方 catch 后 `Decision { action:'reply', payload:{ error } }` 回传用户） | 同文件 |
| ④ 独立 token 预算上限 | `LlmClient.streamChat` 已产 `usage` chunk（`LlmClient.ts:99-100`）；`LlmAgentBrain.callLlmOnce` 聚合 `usage`（**新增** `totalTokens` 字段到返回）；`run` opts 加 `maxTokens?`（缺省 = 父 run 的 80%——**具体值待定见 §5 开放点**）；超 `maxTokens` → 停止 tool 循环（下轮前检查）+ `run_error` 事件 + `final_answer` 取最后 assistant | 同文件 + `electron/llm/types.ts`（`LlmStreamChunk.usage` 已存在，无需改） |
| ⑤ 工具面同注册表零提权 | 子实例 `this.tools` 从 `BUILTIN_TOOLS` 取（**与父同源**，`LlmAgentBrain.ts:85-93` 现有构造）；`run` opts 加 `tools?: string[]` 白名单（**可选**，父不传 = 全 5；**子实例不新增任何额外 tool**） | 同文件 |
| ⑥ 子代理快照复用 RunCheckpointManager, `parentRunId` 溯源 | `RunCheckpointEvent` 类型扩 `parentRunId?: string`（**非破坏**——#004 事件结构加可选字段）；子 `run` 钩子 `checkpointHook` **继承父钩子**（`SpawnContext.checkpointHook` 透传，append-only 同文件，`parentRunId` 落事件 → 审计可溯源父子） | `electron/agent/RunCheckpointManager.ts`（类型扩）+ `LlmAgentBrain.ts`（钩子透传） |
| ⑦ 审计关联与 DEV-023 同点修 | **本单不改 `commandDecide.writeDenyRow` 字段**（#004 DEV-023 同点 W5 修）——本单只**预留** `RunScope { runId, parentRunId }` 字段在 `RuntimeToolContext`（§1.3），值**暂传 `null`**（接线时填）；**不双轨**（不另开审计字段） | 无（类型预留，值待 W5） |

### 2.2 spawn 真独立的核心断言面（门禁可核）

- **独立性**：父 `LlmAgentBrain` 实例与子 `LlmAgentBrain` 实例 `!==`（对象引用）；父子各自的 `tools` Map / `runs` Map 独立（同文件不同实例 = 天然隔离）。
- **禁 `brain: this`**（`LlmAgentBrain.ts:400` 既有债）：**本单删**。回归钉 = 新增 spawn 用例断言 `sub.brain !== parent`。
- **contextKind 不串**（Step 0 机制保）：父 `contextKind='im_inbound'`，子 `contextKind='im_inbound'`（继承）；并发场景（S0-3）父 `ui` 子仍 `ui`（不读到别的会话 `_ctx` 残留）。
- **深度上限**：`spawn(ctx={depth:1})` → throw `SpawnDepthExceededError`（**非静默**）。
- **预算**：子 run 超 `maxTokens` → `final_answer`（取最后 assistant）+ `run_error` 事件；**不 throw**（**降级**到 final，不中断会话）。
- **快照溯源**：子 run checkpoint 事件带 `parentRunId`（`RunCheckpointEvent` 类型扩），`collectForRestore` 读回时父子可互查。

### 2.3 spawn 调用链（本单**只落接口**，接线 W5）

```
[本单落]
ChatManager.dispatchToAgent(msg, 'ui')
  → registeredAgent.think({ contextKind: 'ui' })             // 接口（已有）
  → LlmAgentBrain.run(prompt, opts)                           // 接口（#003 已有 + #005 扩 contextKind/parentRunId/maxTokens/spawnOpts）
  → sub-brain = LlmAgentBrain.create({ parentRunId, contextKind, maxTokens=parent*0.8, checkpointHook=parent.hook })
  → sub-brain.run(subtask.instruction, { contextKind, maxTokens, history=[] })
  → spawn 子 run 结束 → 父 run 续跑（子 run 的 final_answer 作为父 run 的一个 tool 结果 push 进父 messages）

[接线 W5（#006/#007 范畴）]
Decision.action === 'spawn' 的消费（ExecutionEngine 或 ChatManager 新增分支）
+ RunScope 字段填实值（非 null）
+ 子 run 的 checkpointHook 落到会话层（本单只继承父钩子，接线批由 ChatManager 注入）
```

### 2.4 spawn 测试（新增，1 文件 6 用例，Step B 案）

| 案 | 断言 |
|---|---|
| SP-1 独立性 | `parent !== sub`；`parent.runs.size !== sub.runs.size`（构造后各 0）；子 `tools` 与父**同源**（`BUILTIN_TOOLS` 同引用） |
| SP-2 深度上限 | 父 `depth=0` spawn → 子 `depth=1`；子再 spawn → **throw** `SpawnDepthExceededError`（非静默、非 fallback） |
| SP-3 contextKind 继承 | 父 `run` 传 `contextKind='im_inbound'` → 子 `run` 收到 `'im_inbound'`（**断言**子 `BashTool` 调用 `execCommand` 的 `contextKind` 字段 = `im_inbound`，探针 sink 捕获） |
| SP-4 并发互染 | 父 `ui` + 制造 `_ctx='im_inbound'` 污染面 → 子 `BashTool` 调用后 `execCommand` 收到 `ui`（**Step 0 机制在子代理场景生效**） |
| SP-5 预算隔离 | 子 run `maxTokens` 设小值 → 子 `final_answer` 触发（取最后 assistant）+ `run_error` 事件；**父 run 不受影响**（父 `maxTokens` 仍足） |
| SP-6 快照 parentRunId | 子 run 的 checkpoint 事件 `parentRunId` 字段 = 父 `runId`（`collectForRestore` 读回断言） |

---

## 3. Step A 章 2 — D6 可信目录联动

### 3.1 五钉子 → 文件映射

| spec # | 实现 | 文件 |
|---|---|---|
| ① TRUSTED_DIRS 数据表, v1 配置文件承载, **默认空 = 零回归** | `ConfigStore` 键 `agent:trusted-dirs`，值 `string[]`（**绝对路径数组**）；`configGetTrustedDirs(): string[]` 读 `ConfigStore`（**新公开函数**）；**默认 `[]`**（`ConfigStore` 缺键 = `null` → 读侧归一 `[]`）→ **默认行为与现状 100% 一致**（`isCwdInSandbox` 独扛 + 默认空 = `trusted` 永不命中） | `electron/agent/tools/commandDecide.ts`（新增 `configGetTrustedDirs` + `isCwdInTrustedDir`） |
| ② cwd 校验扩为 "sandbox ∪ 可信" | `commandDecide.ts:250` 单点改：`if (!isCwdInSandbox(resolvedCwd) && !isCwdInTrustedDir(resolvedCwd))` → **双 OR**（sandbox **或**可信任一命中即放行） | 同函数（**豁免面**，仅此单点） |
| ③ **触达面 × 授权级别解耦**（钉子） | `isCwdInTrustedDir` **只影响**:cwd 是否被放行；**完全不影响**:`decideCommand`（AUTO/CONFIRM/DENY）、`contextAllowsConfirm`、secrets guard、`writeDenyRow` 判决——**四层独立**。即：可信目录内的 CONFIRM 级命令**仍逐次弹窗**（`contextAllowsConfirm` 不变）；可信目录内的 DENY 级命令**仍拒**（`decideCommand` 不变）；可信目录**不授予**任何命令新权限 | **零代码**（机制保证——`isCwdInTrustedDir` **只**被 `doExecFile` :250 一处调用，不进 `decideCommand` / `contextAllowsConfirm` / `isSecretsSegmentHit` 任一函数） |
| ④ secrets guard 不变 | `isSecretsSegmentHit` 作用于 **args**（路径段），**与 cwd 无关**——可信目录扩 cwd，对 args 的 secrets 匹配**零影响** | **零代码**（机制保证——secrets 匹配 args，cwd 是不同维度，天然不重叠） |
| ⑤ args 路径穿越不强解析（诚实条款） | **文档注**（`constants.ts` `SECRETS_GUARD_PATTERNS` 注释段 + `commandDecide.ts` `isCwdInTrustedDir` 函数注释）：可信目录扩 **cwd 触达面**，**不解析** `args` 里的 `../` 路径（与快照明文同款诚实条款——#004 DEV-022）；即：可信目录内 `ls ../../.ssh` 仍被 secrets guard 拦（args 路径段匹配），**但若 `../` 指向 trusted 目录之外且不在 sandbox 内 → 不被 cwd 校验拦**（因为 cwd 是合法的可信目录内，`../` 是 args 行为，由具体命令自行处理） | 注释（无代码） |

### 3.2 D6 的核心断言面

- **零行为回归**（默认空）：`configGetTrustedDirs() === []` → `isCwdInTrustedDir` 恒 false → 行为 = 现状（`isCwdInSandbox` 独扛）——**跑既有 T 系列命令矩阵用例必须全绿**（**不新增断言**，既有行为不变是断言本身）。
- **可信目录内 AUTO 正向**：设 `trusted=[<tmp>]` → `cwd=<tmp>/a` + AUTO 级 → `execFile` **成功**（`ok:true`）。
- **可信目录外维持拒**：设 `trusted=[<tmp>]` → `cwd=<tmp2 不在 trusted 且不在 sandbox>` → **拒**（`cwd 必须在 sandbox/workspace 内`）。
- **CONFIRM 在可信目录内仍弹**：`trusted 内 cwd` + CONFIRM 级（`git`/`bash`）+ **不传** `contextKind` 探针 → 仍走 `contextAllowsConfirm`（**非**"可信即免确认"）——**触达面 × 授权级别解耦的硬断言**。
- **secrets guard 在可信目录内仍拒**：`trusted 内 cwd` + `args=[<tmp>/../.ssh/id_rsa]` → **拒**（secrets 路径段匹配，与 cwd 无关）。

### 3.3 D6 测试（新增，1 文件 5 用例，Step B 案）

| 案 | 断言 |
|---|---|
| D6-1 零回归 | `configGetTrustedDirs()` 默认 `[]`（不配任何键）+ `isCwdInTrustedDir('/any/where')` 恒 `false` |
| D6-2 AUTO 正向 | `setTrustedDirs([<tmp>])` + `cwd=<tmp>/a` + `ls`（AUTO）+ headless → `ok:true` + `exitCode:0`（探针 sink 断言 `phase:'finish'` 行 `exit:0`） |
| D6-3 目录外维持拒 | `setTrustedDirs([<tmp>])` + `cwd=<tmp2>`（不在 trusted）+ `ls` → `ok:false` + `denied:true` + `denialReason` 含 `cwd 必须在 sandbox` |
| D6-4 CONFIRM 仍弹（**解耦钉**） | `setTrustedDirs([<tmp>])` + `cwd=<tmp>/a` + `git status`（CONFIRM 级）+ headless → `ok:false` + `denied:true` + `denialReason` 含 `只允许 ui 上下文放行`（**不是**"cwd 拒"——**cwd 过了**，**授权级别判拒**） |
| D6-5 secrets 仍拦 | `setTrustedDirs([<tmp>])` + `cwd=<tmp>/a` + `cat <tmp>/../../.ssh/id_rsa` → `ok:false` + `denied:true` + `denialReason` 含 `secrets` |

---

## 4. Step B 测试总账

| 提交 | 新增文件 | 新增用例 | 回归钉（必须原样绿） |
|---|---|---|---|
| ① Step 0 | `tests/unit/runtime-context-propagation.test.ts` | 3（S0-1/2/3） | `tests/unit/gateway-source-injection.test.ts` 5 用例 + `tests/unit/chat-execution-ui.test.ts` 3 用例（**零断言改动**）+ **#004 `tests/unit/run-checkpoint.test.ts` 9 用例**（零改动，跑绿 = contextKind 变更不破坏 #004） |
| ② spawn | `tests/unit/spawn-independence.test.ts` | 6（SP-1..6） | #004 9 用例 + `run()` 既有签名不破坏（`tests/unit/multi-turn-coldstart.test.ts` 8 用例 + `error-recovery.test.ts` 156 行旧栈测——**旧栈走 `AgentBrainImpl`，不碰 LlmAgentBrain，跑绿零改**） |
| ③ D6 | `tests/unit/trusted-dirs.test.ts` | 5（D6-1..5） | **T 系列命令矩阵**（`command-decide.test.ts` / `p0-security-injection` 系列——**零改动**，跑绿 = D6 零回归的硬断言）+ C-3 伪造套件（`run-checkpoint.test.ts` 的 C-3 两条）不回归（**跑绿**） |

**用例算式**（Step C 交付报告口径基准）：
- 当前基线：`79 文件 / 994 过`（#004 交付值，`22140e1` 报告）
- ① +1 文件 +3 用例
- ② +1 文件 +6 用例
- ③ +1 文件 +5 用例
- **预期**：`82 文件 / 1008 过`（994 + 3 + 6 + 5 = **1008**；82 = 79 + 1 + 1 + 1）——**以实跑为准**，偏差必须实述（#004 994 vs 985 同款纪律）

---

## 5. 开放点（需裁决）

1. **SP-5 预算具体值**：子 run `maxTokens` 默认 = 父 run `maxTokens` 的 **80%**？还是 **固定 4000**？还是**继承父值**？（推荐**继承父值**——父多少子多少，简单无歧义；父未设 = 子不设 = 全跑，**本单不强加全局预算**）
2. **SP-2 深度上限位置**：`MAX_SPAWN_DEPTH=1` 钉在 `LlmAgentBrain` 顶部常量，还是 `AgentConfig` 键（`agent:max-spawn-depth`，默认 1，可被 `maxSubAgentDepth` 旧键覆盖）？（推荐**顶部常量**——v1 锁死，未来改值走 `AgentConfig` 批）
3. **SP-1 子实例构造**：`LlmAgentBrain` **私有构造改公开工厂**（`static create(ctx)`），现有**单例** `getInstance()` **保留**（`main.ts:217` 依赖）。**不重构单例**（`main.ts` 零接触红线）。
4. **D6 ① 配置文件路径**：`ConfigStore` 已有 `get/set`（键值面），**不新加文件**（复用现有 `userData/config.json`）；还是**独立 `trusted-dirs.json`**？（推荐**复用 ConfigStore**——减少配置面、对齐 `AgentConfig` 先例）
5. **DEV-025 预留**（本单发现的边界）：`isCwdInTrustedDir` 用 `realpathSync` 解析符号链接（防 symlink 逃逸到 trusted 目录外）——**本单不做**（与 #004 快照明文同款诚实条款，文档注），**触发条件** = 门禁判"symlink 逃逸风险" / 用户裁决加 realpath。**预留登记，不实施**。
6. **Step 0 的 `RuntimeScope` 字段**：本单只填 `contextKind`，`runScope` 字段**传 `null`**（避免本单扩张）——还是**填最小值** `{ runId: gen, parentRunId: ctx.parentRunId }`（让 DEV-023 接线批少改）？（推荐**传 `null`**——本单不碰审计字段，与 #004 DEV-023 停放同策略）

---

## 6. 红线核查（本稿声明，门禁可逐条核）

| 红线 | 本稿遵守 | 证据 |
|---|---|---|
| main.ts 零接触 | ✅（Step 0 ChatManager L985 字段已传零改 / L984 setCommandContext 保留 / spawn 不重构单例 / D6 不动 main） | §1.3 / §2.4 / §5.3 |
| 咽喉逻辑/名单/审计字段零改（Step 0 豁免面）**仅** contextKind 传播 | ✅（`decideCommand` / `COMMAND_AUTO_ALLOWLIST` / `COMMAND_CONFIRM_LIST` / `isSecretsSegmentHit` / `writeDenyRow` 全零改；`setCommandContext` / `getCommandContext` 保留 + 读点扩 `ctx?.contextKind ??`） | §1.3 / §3.1 |
| 回归钉 5+3 原样绿 | ✅（§4 矩阵 + §6 红线核查） | §4 |
| chat 接线（ChatManager:985 opts.checkpoint）仍 W5 | ✅（本单 spawn 子 run 钩子继承父钩子，**不**接线 ChatManager 新钩子） | §2.3 |
| Step 0 是 spawn 硬前置 | ✅（§2.2 SP-3/SP-4 依赖 §1.3 机制承载） | §1.1 |
| DEV-023 / DEV-024 / DEV-022 不扩张 | ✅（本单不删旧栈 `RetryPolicy` / 不加密快照 / 不扩审计字段） | §3.1 / §5.5 |

---

## 7. 门禁核对清单（按本稿交付物清单核）

- ☐ §1.3 两案对比表 + 推荐案 P 实现最小触及面
- ☐ §2.2 spawn 七条 spec 逐条 → 文件映射
- ☐ §3.2 D6 五钉子 + "触达面 × 授权级别解耦"硬断言面
- ☐ §4 测试总账 + 1008 算式基线
- ☐ §5 六个开放点（需裁决）
- ☐ §6 红线核查 + §7 门禁核对清单

**HOLD 待裁决**。裁决回传 = 开放点 1-6 定值 + 红线确认 + 进入 Step B/C（Step 0 先行）。
