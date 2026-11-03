# PiPiClaw 偏差台账（DEV 系列）

> **规则**：每个偏差条目分配终身唯一 `DEV-NNN` ID，一经分配永不复用。
> 旧报告中的 `#N`（N=1..14）按顺序迁入为 `DEV-NNN`，本表为唯一权威源。
> **新增编号**：从 DEV-015 起。

---

## 状态说明

| 标记 | 含义 |
|---|---|
| `已修` | 本补丁批（commit A/B）已实现 + 测试覆盖，代码 + 审计可验 |
| `W5` | 留待 W5（脑链路接线）实施 |
| `停泊` | 裁定接受，不阻塞，维持现状（如 loud-stub diff 提案） |

---

## 已修条目

### DEV-001 — MCP 不是第三入口（规格裁定）
- **来源**：v3 规格 Part 2 #11（MCP 调用窄项）
- **裁定**：MCP 不是与 IPC/HTTP 平行的第三入口，而是在 McpManager.invoke 内做窄项审计（`mcpCallAudit`），不另开 gateway 分支
- **实现**：`McpManager.ts:L311` 前加 `mcpCallAudit(server, tool, argKeys)`
- **测试**：`command-decide.test.ts` T11
- **状态**：已修（Step D `f863019` 实现）

### DEV-002 — secrets 守护扩 3 条件（规格裁定）
- **来源**：v3 规格 Part 2 secrets 守护条款
- **裁定**：`SECRETS_GUARD_PATTERNS` 同时覆盖 ① `~/.ssh` ② `~/.aws` ③ `id_rsa`/`id_ed25519` 文件名，不只限 home 路径前缀
- **实现**：`constants.ts` `SECRETS_GUARD_PATTERNS` + `isSecretsSegmentHit`
- **测试**：`command-decide.test.ts` T5 + `audit-smoke.test.ts` 样例行[5]
- **状态**：已修

### DEV-003 — git 列入 CONFIRM 名单（规格裁定）
- **来源**：v3 规格 Part 2 #3 git 风险条款
- **裁定**：`git` 列入 `COMMAND_CONFIRM_LIST`（`ext::sh` / hooks / `--push` 等任意执行器风险）
- **实现**：`constants.ts` CONFIRM 20 项含 `git`
- **状态**：已修

### DEV-004 — brain 工具路径 contextKind 由 Brain 派生（W5 任务）
- **来源**：v3 规格 Part 2 contextKind 条款 + brain 工具循环
- **现状**：`dispatchToAgent` 生产零调用者，脑链路未接通；`getCommandContext()` 模块态默认 `headless`
- **W5 任务**：接通真实入口时，Brain 链路每次 `tool.execute` 前显式传 `source`，不再读模块态（与 DEV-014 联动）
- **状态**：W5（停泊）

### DEV-005 — env 从 AUTO 移至 CONFIRM（规格裁定）
- **来源**：v3 规格 Part 5 裁决 #5（env 无参数=密钥倾倒，带参数=任意执行器），两模式都不配 AUTO
- **裁定**：移除 AUTO 中的 `env`，加入 CONFIRM
- **实现**：`constants.ts` AUTO 列表无 `env`，CONFIRM 含 `env`
- **状态**：已修

### DEV-006 — `contextKind` 字段 deprecated（规格裁定 commit A）
- **来源**：v3 规格 Part 2 contextKind 条款 + 偏差 #13 安全红线
- **裁定**：`openclaw.d.ts` 的 `CommandOperationParams.contextKind` 标 `@deprecated`，gateway 禁读 `params.contextKind`，source 由 `executeOperation(request, source)` 第二参数派生
- **实现**：commit A（本补丁批）
- **测试**：`gateway-source-injection.test.ts` 攻击-1/2
- **状态**：已修（commit A 本批）

### DEV-007 — 审计两段式 start/finish 配对（规格裁定）
- **来源**：v3 规格 Part 2 审计条款
- **裁定**：`execCommand` 分 start 行（`exit:"pending"`）+ finish 行（真实 exit），同 `opId` 配对
- **实现**：`commandDecide.ts` `auditAppendSync` 两段
- **测试**：`audit-smoke.test.ts`（5 行配对）
- **状态**：已修

### DEV-008 — P1/P3 stub+ui 强制禁降级（门禁裁定升级 a）
- **来源**：门禁审查升级 a 裁定
- **裁定**：confirm 级命令 P1/P3 测试必须用 `stub transport + source:'ui'`，禁降级为 `echo`/`ls` 等 AUTO 级
- **实现**：`agent-tools.test.ts` P1b/P3b
- **状态**：已修

### DEV-009 — finish warn 必须真代码（门禁裁定升级 b）
- **来源**：门禁审查升级 b 裁定
- **裁定**：`finish` 行写失败时 `console.error` 真执行，非注释；测试通过 stderr 验证
- **实现**：`commandDecide.ts` L286 `console.error`
- **测试**：`command-decide.test.ts` T7 钉子③ + stderr 捕获
- **状态**：已修

### DEV-010 — DI：confirmTransport + auditSink 可注入（规格裁定）
- **来源**：v3 规格 Part 3 #2 `confirmTransport` 条款 + 测试需求
- **裁定**：`setConfirmTransport`（生产走 `defaultBrowserConfirm`，测试走 stub）和 `setAuditSink`（生产走 fs，测试走内存）均支持注入
- **实现**：`commandDecide.ts` DI 函数 + `setConfirmTransport`/`setAuditSink`
- **测试**：所有 T 系列用 DI
- **状态**：已修

### DEV-011 — MCP 审计调用位置（实现细节修正）
- **来源**：Step D 实现时发现
- **描述**：`mcpCallAudit` 必须在 `McpManager.invoke` 成功路径中（L311 附近），失败路径不写（与 gateway 审计分开）
- **状态**：已修（`f863019`）

### DEV-012 — promisify 孤儿 import 删除（代码卫生）
- **来源**：Step D 删 `execFile` 后 `promisify` orphan
- **实现**：`OpenClawGateway.ts` 删 `import { promisify }`
- **状态**：已修

### DEV-013 — params.contextKind 信任边界废除（commit A 安全红线）★
- **来源**：Step D 审计后发现（外部 HTTP/IPC 可自我放行）
- **裁定**：`contextKind` 由 `main` 进程按入口身份派生，**绝不从请求 params 读**
  - IpcServer `openclaw:execute`（渲染端）→ `source='ui'`
  - OpenClawServer HTTP → `source='headless'`（W4 改 `im_inbound`）
  - ChatManager → `TaskExecutor.executeTask(task, 'ui')`
  - ScheduleTask → `source='scheduler'`
- **实现**：gateway `executeOperation(request, source)` + `runCommand(params, source)`，**不读 `params.contextKind`**
- **测试**：
  - `gateway-source-injection.test.ts` 攻击-1（HTTP params.ui → 拒，审计 `contextKind='headless'`）
  - `gateway-source-injection.test.ts` IPC-1（source=ui → execCommand 收到 `ui`）
  - `chat-execution-ui.test.ts` B-1/B-2/B-3（chat 全链）
- **状态**：已修（commit A 本批）

### DEV-016 — TaskExecutor run_command args 丢失（chat 路径生产 bug 修复）★
- **发现来源**：patch 批 chat 全链测试 B-2 时，`node` 无参 → REPL 挂死（审计 start 行 `args:[]`）
- **根因**：`TaskExecutor` run_command case 只透传 `command`+`cwd`，**丢弃 `args`**
  ```ts
  // 修复前 (chat 里 node -e 1 → 裸 node → 交互 REPL 挂死):
  params: { command: params.command, cwd: params.cwd }
  // 修复后:
  params: { command: params.command,
            args: Array.isArray(params.args) ? params.args.map(String) : undefined,
            cwd: params.cwd }
  ```
- **影响**：chat LLM 规划的 `node -e ...` / `git status` 等操作全部静默丢失参数
- **落库位置**：`TaskExecutor.ts`（随 commit A 的 source 透传同文件落库；commit B 补 chat 全链测试覆盖）
- **状态**：已修

### DEV-017 — TaskExecutor success:false 被吞（chat 路径生产 bug 修复）★
- **发现来源**：patch 批 chat 全链测试 B-3，拒绝路径 `reply.content` 含"任务成功"
- **根因**：`executeTask` 循环中 `executeStep` 返回 `{success:false, error:...}` 但 `try` 块没检查 → 无条件 push `status:'success'` → `allSuccess` 始终 true
  ```ts
  // 修复前:
  const result = await this.executeStep(step, source);
  results.push({ status: 'success', result });   // success:false 被吞

  // 修复后:
  if (result && result.success === false) {
    allSuccess = false;
    results.push({ status: 'failed', error: result.error, result });
  } else {
    results.push({ status: 'success', result });
  }
  ```
- **影响**：任何被 gateway 拒绝的操作（PERMISSION_DENIED 等）在 chat 里显示"任务成功"
- **落库位置**：`TaskExecutor.ts`（随 commit A 的 source 透传同文件落库；commit B 补 chat 全链测试覆盖）
- **状态**：已修

---

## 停泊 / W5 待修条目

### DEV-014 — commandDecide 模块态 `setCommandContext` 并发串线（W5 设计债）★
- **来源**：Step D 收尾审计
- **问题**：`_ctx` 是模块级 `let`，两个会话并发 dispatch 时一个设 `ui`、一个设 `scheduler`，恢复后读到错误值
- **当前影响**：chat 活跃路径串行（`sendMessage`），本批容忍不扩；脑链路并发 dispatch 时立即显现
- **修复方案**（W5）：① `execCommand(args, ctx)` contextKind 改必填参数；② AsyncLocalStorage
- **实际实施**（#005 Step 0, 显式参数贯穿, 裁决 override 读点 `ctx?.contextKind ?? 'headless'` 禁回落）:
  - 模块态三件 (`let _ctx` / `setCommandContext` / `getCommandContext`) **同批删除** (commandDecide.ts; 切除前 grep 实证: 生产面读者面唯一 = BashTool 已改显式, 测试面零读者, gateway 轨本就参数制 source 第二参不受影响)
  - `Tool.ts` 接口扩 `execute(args, ctx?: RuntimeToolContext)`; `BashTool` 读点改 `ctx?.contextKind ?? 'headless'` (fail-safe); `LlmAgentBrain.run` opts 加 `contextKind?` + think 从 `ctx.contextKind` 透传 (brain 无状态红线: run 局部, 不自存); `ChatManager.dispatchToAgent` 派生逻辑留入口 (唯一派生点)
  - 测试改点清单 (裁决要求, 全量实证): agent-tools.test.ts BashTool 7 it + audit-smoke.test.ts 1 it + command-decide.test.ts 9 处 + run-checkpoint.test.ts 3 处 — 全改为 `execute(args,{contextKind})` 显式 / `execCommand({contextKind})` (本就显式) / 删模块态注入行; **两回归钉文件 (gateway-source-injection 5 用例 / chat-execution-ui 3 用例) 零断言改动, 同提交跑绿**
  - 回归钉: S0-1 并发独立 (A ui / B im_inbound 交替调度判各依各) / S0-2 缺 ctx 兜底 headless / S0-3 think 链透传 / S0-4 gateway 轨参数制透明
- **状态**：★ **已修·机制切除**（#005 Step 0, 2026-10-13; 关闭时点 = 本提交, 电池 80 文件 / 998 过 / 8 skip / 0 失败, vue-tsc 0 错）

---

## 本批新增 bug 条目（非 #1-#14 迁移）

### DEV-018 — IpcServer `task:execute` / `task:log:retry` 未传 source（commit A 补）
- **描述**：`executeTask(safeTask)` 调用未附 source，默认 `headless` → 渲染端 task 的 confirm 级命令被拒
- **修复**：补 `source='ui'`（`task:execute` 用户手动触发；`task:log:retry` 用户重跑历史任务，上下文同 ui）
- **状态**：已修（commit A 本批）

### DEV-019 — deny 行 `denialReason` 混写「用户拒绝 / 30s 超时」，取证粒度损失
- **描述**：`commandDecide.ts` confirm 未通过路径（用户点「拒绝」与 30s 超时**同一条分支** L218-221），`denyReason` 统一写「用户拒绝或 30s 超时 (confirm 未通过)」→ 事后取证无法区分是**人拒**还是**无人应答**。S2 冒烟 S2-deny 实测样本即此文案
- **修法**：超时路径置独立标记（如 `denialReason='timeout-30s (confirm 无应答)'`，`confirmChannel='ui-timeout'`），与「用户拒绝」分道
- **状态**：**W5 停泊**（确认传输加固批，归 W5 一并修）；**不阻 M1**（安全结果不变——两种情形均已拒，仅取证粒度损失）
- **登记**：2026-10-12 S2 verdict 批（用户授权登记）

### DEV-020 — 多轮记忆冷启动（活跃链 task 生成 + 休眠 brain 跨 run 均不携带历史）★
- **描述**：多轮对话冷启动 —— ① 活跃链 `InstructionGenerator.callModel` 硬编码 `messages=[system,user:当轮]`，第 N 轮不携带前 N−1 轮 user 消息/工具结果（#003 实测 A-2 RED 锁定）；② 休眠 `LlmAgentBrain.run` 每次 run 重建 `messages=[system,user:prompt]`，同实例第二次 run 冷启（#003 实测 B-2 RED）。兜底 `handleNormalChat`(ChatManager.ts:426-442) 已读真源历史，故精准到 task 生成入口 + brain
- **根因族**：与 DEV-014（模块态互染）同族「上下文传播」——上下文（来源/会话历史）没按显式通道贯穿
- **修法**（2026-10-12 Step C，显式参数，**禁新增模块态**）：
  - 新建 `electron/chat/HistoryAssembler.ts`（唯一实现，两管道共用，纯函数无状态）：窗口 `HISTORY_WINDOW_TURNS=10` + `HISTORY_MAX_CHARS=16000`（超限从最老轮删），system 恒首位/当前 user 恒末位，助手轮次必须在场（非 user 单声道）
  - 管道 A：`generateTaskSteps`/`callModel` 加可选 `history` 参；`ChatManager.sendMessage` 用 HistoryAssembler 从真源拉历史传入
  - 管道 B：`LlmAgentBrain.run` 加可选 `opts.history`；`think` 从 `ctx.history` 透传；**brain 保持无状态**（不自存历史）→ #004 checkpoint 快照对象明确
  - 显式参数贯穿（非 AsyncLocalStorage），与 DEV-014 统一解思路一致
- **回归钉**：`tests/unit/multi-turn-coldstart.test.ts` — HistoryAssembler 正向断言（助手轮次/窗口截断/真源映射）+ 两管道 A-2/B-2 翻正（第二轮请求体含第一轮 user + 助手/工具结果）
- **状态**：**已修 → 关闭确认**（#003-fix Step C 实施 + #004 verdict 批 GLM 终裁关闭；`main.ts`/安全链零接触）
- **登记**：2026-10-12 #003-fix 批（Step A' 先决三条核实成立：真源=main ChatConfig / 第 N 轮已含前 N−1 轮 / 在 ChatConfig store）；关闭确认 2026-10-13 #004 verdict 批

### DEV-021 — 工具结果不跨轮（brain 跨 run 不复用 tool 执行账，归口 #008）
- **描述**：`LlmAgentBrain.toolCallsLog` 是 run 函数局部量，跨 run 不复用 —— 同一会话两次 run 之间，同名工具的重复调用每次重跑、不缓存命中。属**工具结果缓存**问题，非多轮记忆（DEV-020 已把 messages 历史修通，但工具结果缓存另列）。
- **根因**：工具结果可能随文件状态失效，缓存 key 需含 stat/时间维度 —— 归 **ContextCompressor 同范畴（#008）**，单列缓存策略批。
- **状态**：**开放（归口 #008，本单 #004 不实施）**；#004 C-1 只把 tool 结果落进**单次 run 内**快照（messages 已含 tool 行），不产生跨 run 缓存。
- **登记**：2026-10-13 #004 verdict 批（supplementary 补登 —— 此前仅在裁决/报告中以 ID 引用，台账无实体条目，本笔落实）

### DEV-022 — checkpoint 快照含潜在敏感内容（未加密）
- **描述**：#004 快照（`userData/run-checkpoints/events.jsonl`）含 run 内全部 messages（LLM 上下文 + 工具输出），明文落盘。
- **根因**：对齐审计 JSONL 明文先例（`commandDecide.ts:61`）；加密为升级选项。
- **修法（预留）**：快照批或用户明确要求后，用 `IMConfigStore` 式 safeStorage 加密（`IMConfigStore.ts:112` 先例）；**#004 不加码**（spec 未要求）。
- **状态**：**预留**（未触发；触发条件 = 门禁判"快照含机密" / 用户裁决加密）。
- **登记**：2026-10-13 #004 verdict 批（supplementary 补登，同 DEV-021）

### DEV-023 — 审计行无 run 关联（恢复后取证断链，W5 入口注入修）
- **描述**：`commandDecide` 审计行（audit/audit 行）不含 `runId` / `checkpointed` 字段 —— #004 恢复路径产生的命令执行无法关联回 originating runId；审计行无法区分"原 run"与"恢复后续跑"。
- **根因**：入口注入面未打通 —— `BashTool.execute` 的 args 不含 run 维度（`BashTool.ts:15/47-53`），`execCommand` 签名无 runId 位。
- **修法（W5）**：入口注入 —— 接线时由 ChatManager 设 `setCommandContext` 同族的新注入位（如 setRunScope(runId)），`writeDenyRow` 行附 `runId` + `checkpointed:true`（**不放宽 mock、不动安全链语义**，只加字段不动判决）。
- **状态**：**W5 停放**（接线批随 #004 恢复路径一并落地；本单 #004 生产侧只落 manager + brain 接缝，审计行扩展在 W5 接线批实施，避免本单触碰 commandDecide 冻结面）。
- **登记**：2026-10-13 #004 verdict 批（#2 明示登记）

### DEV-024 — 旧三件套清理（AgentBrain checkpoint/restore stub + AgentCheckpoint 目录占名，W5 批次删）
- **描述**：`LlmAgentBrain.ts:402-410` 的 `checkpoint()/restore()` stub 已在本单删除并替换为显式 throw 指引（零调用者实证：`.checkpoint(` 仓内零调用 P1；`.restore(` 仅 `GlobalShortcut.ts:125` 的 `win.restore` 无关 P2；测试面零引用 P5）。但 `AgentBrain.ts`(AgentCheckpointState/checkpoints Map) + `AgentCheckpoint.ts`(userData/checkpoints 目录) + `AgentRecovery.ts` + `error-recovery.test.ts` 旧栈仍在仓内（`retryPolicy` 被 `ChannelRouter.ts:14/89` 生产引用，**不可随本单删**）。
- **根因**：旧 checkpoint 栈（W5.2.5 期产物，AgentCheckpointState 语义 = Agent 会话历史 step，非 run 层 snapshot）与新 RunCheckpointManager 语义不同，双轨并存期由 W5 决策收敛方向。
- **修法（W5）**：W5 接线批统一 —— 若旧栈确认弃用：删 `AgentBrain.ts` checkpoint 段 + `AgentCheckpoint.ts` + `AgentRecovery.ts` + `error-recovery.test.ts`（`RetryPolicy.ts` 若 `ChannelRouter` 需保留则保留，否则随栈删）；若保留旧栈：`contracts/types.ts:63-64` 的 `AgentBrain.checkpoint/restore` 接口签名与实现统一语义。本单不动旧栈（冻结面 + 单提交纪律）。
- **状态**：**停放 W5**（本单只删 LlmAgentBrain 两 stub 并替换为 throw 指引，旧栈完整保留可回退）。
- **登记**：2026-10-13 #004 verdict 批（#2 明示登记）

### DEV-025 — 可信目录 symlink 逃逸（realpath 未解析，预留）
- **描述**：D6 `isCwdInTrustedDir` 用 `path.resolve` 归一并按前缀匹配，**未做 `realpath` 符号链接解析**——trusted 目录内若建 symlink 指向目录外（如 `sandbox/lnk → C:\Users\target`），cwd=symlink 路径会被前缀判命中而放行，触达面实际超出 trusted 目录。
- **根因**：v1 触达面校验走字面路径前缀（与既有 `isCwdInSandbox` 同款深度——sandbox 校验同样无 realpath）；symlink 逐节点解析的边界（悬空链接、循环链接）另议。
- **修法（预留）**：`realpathSync(resolvedCwd)` 替代 `path.resolve` 前缀判定；**v1 只文档标注**（`isCwdInTrustedDir` 函数注释 + D6 设计稿⑤诚实条款——与快照明文 DEV-022 同策略：能力边界如实标注，不静默）。
- **状态**：**预留**（未触发；触发条件 = 门禁判"symlink 逃逸风险" / 用户裁决加 realpath；v1 默认空表 = 零行为回归, 触达面未扩时本条无实际暴露）。
- **登记**：2026-10-13 #004 verdict 批（#005 裁决 #5 明示登记）

### DEV-026 — 退出 flush 依赖既有 dispose 链（W5 接线时验证）
- **描述**：#006 `MemoryVectorStore.flush()` 为显式排空入口（N1 写队列排空 + 原子 rename 落盘）。**退出路径未接 `app.on('before-quit')`**（main.ts 冻结面），退出时未 flush 的 debounce 窗口内写（≤500ms）依赖既有 dispose 链的 `await adapter.dispose()` 触发 `flush()` — 若既有 dispose 链未覆盖向量层，退出时会有 ≤500ms 的写丢失窗口。
- **根因**：main.ts 是 #006 冻结面（五红线），不能新增 `app.on('before-quit')` 接线位；`HermesAdapter` 构造链的反序析构若存在则自然触发 `flush()`，需 W5 接线批验证。
- **修法（W5）**：W5 接线批显式 `await hermesAdapter.dispose()`（dispose 链若已含向量层则本条自动关闭）；若不存在 dispose 链，补 `HermesAdapter.dispose()` → `MemoryVectorStore.flush()` 链，并在 `app.on('before-quit')`（main.ts 接线面，W5 解冻后）触发。
- **状态**：**预留**（W5 接线批验证；本单 #006 只落 `flush()` 入口，不接退出钩子）。
- **登记**：2026-10-16 #006 Step A verdict（裁决 3 明示登记）

### DEV-027 — v1 无相似度去重（机制已修正：技能侧 LLM 意图级判重实读坐实，向量侧 stub cosine 取消）
- **描述**（**前提修正**，原 2026-10-16 初稿把 "无相似度去重" 误推至技能侧 `checkDuplicateSkill`——实读推翻）：
  - **技能侧 LLM 意图级判重**：`SelfLearner.ts:657-695` `checkDuplicateSkill` 走 `makeChatCompletionRequest` 逐对比"触发条件是否为同一种用户意图"——**已是语义级**，非 name 精确，非 stub。
  - **向量侧 stub**：`EmbeddingService` hashToVector 纯 SHA-256（`#006` 设计稿 F4 实读），cosine 余弦无意义，**stub 下加 cosine 闸无增益**——#007 G4 撤销 cosine 接入，本条**不阻塞**。
- **根因**（前提修正）：技能侧原稿"无去重"系臆造——实读为 LLM 意图级判重；向量侧"无去重"属 stub 能力边界（非设计缺口）。
- **修法**：
  1. 向量侧 cosine 预筛：接真 embedding 时（W5 / DEV-027 同批）在 LLM 判重**前**加 cosine 粗过滤（阈值 0.92，O(1) 预筛 → 降 N 次 LLM 调用）— **预筛优化候选，登记备查，非 #007 交付**
  2. 技能侧 LLM 判重保留（既有真实现，订单红线"不重写"）
- **状态**：**已覆盖·机制修正**（#007 修正版 A 放行进 3 裁决；订单原文"cosine 补充取消" + "stub 死代码 Q1 条款适用" + "fail-open 由人审门兜底"全部落）
- **登记**：2026-10-16 #006 Step A 设计稿 B.7 预占（原编号 DEV-026，#006 verdict 裁决 3 顺延为 DEV-027）；2026-10-16 #007 修正版 A 放行进 3 改写状态

### DEV-028 — 记忆内存态（首轮审计原债，已修·持久化）
- **描述**：首轮审计指出"记忆内存态"—— #006 实施前 `MemoryVectorStore.entries` 为纯内存 Map，进程重启后清空；`EmbeddingService` 同（重启全部重算）。**文本真源层**（`HermesMemory` → ConfigStore 键 `hermes.memories`）**已持久化**，缺的是**向量缓存层**（重启清空 + 重算 embedding = D5 违背）。
- **根因**：v1 架构未考虑重启场景（#000/#001 期向量层仅做 in-memory 语义匹配，未规划持久化）。
- **修法（#006 已修）**：#006 实施 — `MemoryVectorStore` 新增 `loadFromDisk()` + `persist()` + `flush()` + `writeChain`（N1 写队列）+ 原子 rename（N2）+ 先载后写（N3），落盘 `userData/hermes-memory/vector-cache.json`，LRU 容量 200；D5 默认 stub-deterministic 零网络。
- **状态**：**已修·持久化**（#006 本单关闭）。
- **备注**：本债在首轮审计产物中**未独立落账到 deviation-ledger.md**（session_search 坐实 docs 全目录无该条独立条目，仅 #006 订单描述"首轮审计原债"一句引用），本笔补登即关闭，来源诚实标注为"首轮审计"（不冒充已登记条目）。
- **登记**：2026-10-16 #006 Step A verdict（裁决 3 要求关闭"记忆内存态"，本笔补登 + 关闭同动作）

---

### DEV-029 — ollama-real-link 环境预检(测试卫生, 非放宽)
- **描述**：`tests/integration/ollama-real-link.test.ts` 默认 `OLLAMA_MODEL=qwen3:14b`；本机 Ollama tag 不匹配时 404 → 6 用例 60s 超时污染电池信号。**环境依赖噪声, 非代码缺陷。**
- **根因**：原 beforeAll 只硬断言 `/api/version`（host 可达性），未验证指定模型 tag 在本机；S1-S6 用该 tag 真链路时 host 可达但模型缺位 → 真 LLM 调用 404/慢响应触发 timeout。
- **修法（NOVA #003-A 已落）**：顶层 ESM `await` 探测 `http://localhost:11434/api/tags`（3s 超时）→ 三态分流：
  - **A. host 不可达** → beforeAll 硬抛（既有硬失败语义保持）
  - **B. host 可达 + tag 在位** → S1-S6 正常执行（断言一字未动）
  - **C. host 可达 + tag 缺位** → 六处 S1-S6 `maybeSkipModel(ctx) → ctx.skip('[SKIP] ...')` 显式 SKIP + `console.warn('[SKIP] Ollama host lacks model <tag> (in place: ...)')`
  - **D. /api/tags 接口异常**（host 可达但 5xx/不可解析）→ MODEL_PRESENT=true 兜底，S1-S6 正常执行（不应因 tags 单点故障把真链路误判为缺位）
- **实现机制(为什么用 `ctx.skip` 而非 `it.skipIf`)**：vitest 1.6.1 实测 `it.skipIf(condition)` 声明只 1 参（`node_modules/@vitest/runner/dist/index.js:518-520` `taskFn.skipIf = function(condition) { return condition ? this.skip : this }`），带 name/timeout 多参会被 JS 静默丢弃（实测 S1-S6 全变 `<anonymous>` + 12ms"假通过"函数体不执行）。故改用 vitest 官方文档明确的 `context.skip(condition, message)`（`it(name, timeout, async (ctx) => { if(!MODEL_PRESENT) ctx.skip(...) ... })`，运行时判 condition，name/timeout 保留正确）。顶层 ESM await 是必要的：让 probe 在模块求值阶段完成 → describe 注册 + beforeAll + 用例执行时 MODEL_PRESENT 已是最终值。
- **落点(实测 file:line)**：`tests/integration/ollama-real-link.test.ts:33` NOVA #003-A 顶层注释头 + `:49-61` 顶层 ESM await probe 块（四态 A/B/C/D 分流）+ `:66-69` `maybeSkipModel` shim（模型缺位时 `ctx.skip('[SKIP] Ollama host lacks model <tag>')`）+ `:72-84` describe/beforeAll（保留既有 host 硬失败语义 + LlmConfigStore.set）+ 六处 `maybeSkipModel(ctx)` 调用（实测 L87/L104/L142/L158/L183/L196；断言体逐字符与 pre-#003-A 一致）。
- **边界**：
  - 白名单 2 文件：该测试文件 + `docs/deviation-ledger.md` 本条目 + 对照表一行。零其他改动。
  - `docs/deviation-ledger.md:251` 本条目详细区 + `:300` 对照表 DEV-029 行(实测)。
  - **非放宽**：S1-S6 断言体逐字符保持(实测 S1-S6 函数内代码与 pre-#003-A 一致)。
- **验收对应(本轮交付后复跑, 原样贴回)**：见提交消息与聊天归档。
- **备注**：并发负载致实时链路超时属环境噪声(2026-10-19 11:23 轮归档定性, 已在 #002 汇报报备) — 本条机制落地后, 无模型 tag 的环境不再污染信号。
- **登记**：2026-10-19 NOVA #003-A verdict 批登记。

## 台账迁移对照表（旧 #N → DEV-NNN）

| 旧 ID | DEV ID | 状态 |
|---|---|---|
| #1 | DEV-001 | 已修 |
| #2 | DEV-002 | 已修 |
| #3 | DEV-003 | 已修 |
| #4 | DEV-004 | 已修 |
| #5 | DEV-005 | W5（停泊）|
| #6 | DEV-006 | 已修 (commit A) |
| #7 | DEV-007 | 已修 |
| #8 | DEV-008 | 已修 |
| #9 | DEV-009 | 已修 |
| #10 | DEV-010 | 已修 |
| #11 | DEV-011 | 已修 |
| #12 | DEV-012 | 已修 |
| #13 | DEV-013 | 已修 (commit A) ★ |
| #14 | DEV-014 | 已修·机制切除 (#005 Step 0, 模块态三件同提交删除) ★ |
| — | DEV-016 | 已修 (TaskExecutor 随 commit A 落库, commit B 测试覆盖) ★ |
| — | DEV-017 | 已修 (TaskExecutor 随 commit A 落库, commit B 测试覆盖) ★ |
| — | DEV-018 | 已修 (commit A) |
| — | DEV-019 | W5 (停泊, S2 verdict 批登记) |
| — | DEV-020 | 已修 (#003-fix Step C, DEV-014 同族"上下文传播") → #004 verdict 批关闭确认 ★ |
| — | DEV-021 | 开放 (归口 #008, 本单不实施) |
| — | DEV-022 | 预留 (加密未触发) |
| — | DEV-023 | W5 停放 (审计行 run 关联, 接线批修) |
| — | DEV-024 | W5 停放 (旧三件套清理, 本单仅删 LlmAgentBrain 两 stub) |
| — | DEV-025 | 预留 (可信目录 symlink 逃逸 realpath 未解析, v1 文档标注) |
| — | DEV-026 | 预留 (退出 flush 依赖既有 dispose 链, W5 接线批验证) |
| — | DEV-027 | 已覆盖·机制修正 (#007 修正版 A 放行进 3 改写; 技能侧 LLM 意图级判重实读坐实, cosine 预筛登记备查, 接真 embedding 时同批做) ★ |
| — | DEV-028 | 已修·持久化 (#006 本单关闭, 首审原债补登即关闭) ★ |
| — | DEV-029 | 已加·测试卫生 (NOVA #003-A: ollama-real-link 环境预检 — 指定模型 tag 不在本机 → S1-S6 六处 maybeSkipModel(ctx)→ctx.skip 显式 SKIP + [SKIP] 日志, 非放宽; 时序关键点: it.skipIf(condition) 声明只 1 参(实测 node_modules/@vitest/runner/dist/index.js:518-520), 多参会静默丢 name/timeout, 故改用官方 context.skip API + 顶层 ESM await probe) |
| — | DEV-030 | 开放·偶发断言未命中 (NOVA #003-D 复审登记: tests/e2e/routes-render.test.ts:54 `expect(mainHtml).toContain(route.expectClass)` 断言偶发未命中(2026-10-19 16:43 轮 11 条中 2 条 FAIL, 16:49/16:50 两轮复跑即 11/11 全绿); 复现条件 = 同命令连跑通常全绿、偶发未命中; 疑因 = Chat.vue 动态 import 时序抖动(注释 L48-50 "历史 B1: Chat.vue 动态 import 崩 → Dashboard 残留"); 处置 = 挂 #008/#009 排查清单, 本单 #003-D 只读、不修) |
| — | DEV-031 | 已修·既有债 (NOVA #004-C: AutoUpdater dev-path 重复注册 — #004-B d 项冒烟发现, 非 #004 引入, dev/prod 均触发: 同一进程内 registerIpcHandlers() 被调两次(main.ts:133 P1-T1.3 早期注册 + main.ts:229 initialize 内 AutoUpdater.ts:73), 第二次 ipcMain.handle('autoUpdater:check') 同名崩 → try/catch 吞错, autoUpdater.on+checkForUpdates 半初始化态; 修复 = AutoUpdater.ts registerIpcHandlers() 入口 +5 行 removeHandler 覆盖语义(不改生产语义/不删handler/typeof 检查保 mock 兼容), 本单已修 #004-C commit d24fd0e, 见下方 DEV-031 明细) |
| — | DEV-036 | 已加·纪律 (NOVA #005-B①-R 取证后登记: 数字命令-输出成对 禁推断数字 / 质疑回复只贴命令原文 禁“...”省略与叙事性修正 —— 本条三项自 2026-10-20 #005-B① 领取后生牧; 背景 = #005-B① 回贴中 458/475 两个数字无命令源头 “推断不是实测” + “记忆错抄”; 质疑回复要求 → 只贴命令与输出成对原文 禁转述 禁“...”省略。) |
| — | DEV-037 | 已修·越权 (NOVA #005-B①〉步零越权改动设计稿 6 处：L74/关停/全体低顺序跳跃【按“零新依赖”】/L233/L399 “Chat.vue” escape 重写/L407 “allowed append-only” 中 L407 触及 locales 红线句; R1 以摘要代原文违令（上一轮询证仅给 5 行摘要 未贴原文）「粘贴」被判令为不认可、以原文为准、dc9b8cb message “ipc.test +17/-0” 系数字错位（权威值 numstat 68/0，本单不 amend 修史、以本条 + DEV-036 归档双备案）。) |
| — | DEV-038 | 已修·偏差 (NOVA #005-B②〉二项偏差与实践记录: ① NovaVoiceBridge 字段+依据 NovaBootBridge 模式 → 零 Bridge 走 ConfigStore (F0 实证 TTS 引擎为 renderer 内建, main 端无底层实体); ② 设计稿估 voice 单测 +12~18 → 实际 +3 (IpcServer.ts 2671 LOC 主进程核心 难起轻量池; e2e 覆盖; 粉阶式拆分). 原始 #005-B②〉步零 commit message 引用 "新登记 DEV-038" 但未插表行, 本捌补. |
| — | DEV-039 | 已修·偷窊 (NOVA #005-B③〉M3 SideNav 缺 /search 项上报: #004-B③笔 侧栏 append 一行未实际落地——报告中记"侧栏 append 一行"仅为纸面说明、未走代码。#005-B③笔偷窊补机上报不限于本单 — append /search 偷窊补回 + /voice 本单增项, 同为 +3 行。关单核验单从此含"UI 入口可达"检查项. |
| — | DEV-040 | 已修·孤儿 (NOVA #005-B④〉M4 voice 主进程身件 314 LOC 零生产调用——D4 实证: src/stores/voice.ts:10 docblock 以外零引用; 唯一生产接口 = electron/preload.ts:13 type-only import (M2 预留线、仅类型). ②〉IpcServer.ts 2671 LOC 难起轻量池、handler 走 ConfigStore 透传、跨进程跳 SpeechStore 临层. M6 方案 C: re-home 重指; 方案 B 否决理由; 允许一个版本延后重决. |
| — | DEV-041 | 已加·质量 (NOVA #005-B④〉zh-CN 期刊 → 朗读修正、en-US Voice Reader 未动; i18n 测试 「守键不守义」. 关单核验单新增「文案母语通读」项. |

### DEV-030 明细（NOVA #003-D 复审登记，2026-10-19）

- **现象**：`tests/e2e/routes-render.test.ts:54` 的 `expect(mainHtml).toContain(route.expectClass)` 在 #003-C 终验期间（16:43:03 轮）11 条路由用例中 2 条偶发未命中（FAIL），同命令 16:49:43 / 16:50:04 两轮连续复跑即 11/11 全绿（Duration 各 ~18.9s）。
- **定性**：非 #003-C 引入回归——#003-C 三笔（826e62f/514f8ed/335961a）对该文件 `--numstat` 零命中，仅 `tests/e2e/helpers/electron-app.ts +5`（`PIPICLAW_SKIP_SPLASH` 旁路 env 注入，非用例体）。
- **历史锚定**：该断言文件唯一变更 commit = `4041252 test(e2e): 纯 Web 渲染 e2e 独立化 — routes-render 11 例实跑全绿`（早于 #003-C）；用例骨架 L37 `expectClass: string` + L54 断言 + L61-70 `CORE_ROUTES` 9 条 + L73-75 `REDIRECT_CASES` 1 条 + L100/L106 两个 for 循环生成 10 条 `it` + L111 独立 Chat 断言 `it` = 实跑 11 条（以 16:49:43 / 16:50:04 两轮 `Tests 11 passed (11)` 为准）。
- **疑因**：L52-53 注释自述 "不是 fallback 内容(历史 B1: Chat.vue 动态 import 崩 → Dashboard 残留)"，指向 Chat.vue 动态 import 时序；与 #003-C 的 BootOrchestrator 收口调度主窗显示无直接关联（e2e 旁路路径 `gate=true` 下 `ready-to-show` 立即 show，行为等价既有）。
- **处置**：挂 #008/#009 排查清单；#003-D 复审令仅做登记，不在本轮回修。

### DEV-031 明细（NOVA #004-C，2026-10-20）

- **现象**：#004-B d 项 dev 冒烟（`npm run dev` 真 Electron 主进程）实测主进程 exit code 1，console 命中 "Attempted to register a second handler for 'autoUpdater:check'""（构建产物 `dist-electron/main.js:15942` 报错点，回溯源码见下）。
- **根因（同进程内双注册）**：
  - 第 1 注册：`electron/main.ts:133` `new AutoUpdater().registerIpcHandlers()`（P1-T1.3 hotfix 提前提到 `createMainWindow` 前，**无条件执行**），挂 `autoUpdater:check/download/install/getVersion` 4 个 `ipcMain.handle`。
  - 第 2 注册：`electron/main.ts:229` `ready-to-show` 回调 `new AutoUpdater().initialize(mainWindow)` → `electron/core/AutoUpdater.ts:73` `initialize()` 内 **`this.registerIpcHandlers()`** → 同名 `ipcMain.handle('autoUpdater:check')` 二次注册 → 崩。
  - `main.ts:227-230` 的 `try/catch` 吞错误（log.error + 继续），但 `initialize()` 后半 `autoUpdater.on` 事件监听 + 5s `checkForUpdates` 因崩在 `registerIpcHandlers` 未执行 → 半初始化态。
- **定性**：既有 bug，dev/prod 均触发（`main.ts:229` 路径无条件、非 dev 门槛），非 #004 引入；#004-B d 项首次实测暴露（#003-A 预检/ #004-A 设计稿/ #004-B 三笔均未触碰 AutoUpdater）。
- **修复（removeHandler 覆盖语义，≤15 行阈值内，不改变 autoUpdater 生产语义，不删既有 handler，不搬调用点）**：`electron/core/AutoUpdater.ts` `registerIpcHandlers()` 入口补 5 行 — `for (ch of 4 个 autoUpdater:* channel) if (typeof ipcMain.removeHandler === 'function') ipcMain.removeHandler(ch);` （Electron 官方覆盖语义: 每次 handle 前先 removeHandler 清旧 handler 再挂新, 重复注册不再崩 “second handler”；typeof 检查保测试 mock 兼容, 生产 Electron 真实 ipcMain 一定有 removeHandler 调用即生效）。首次注册行为等价原实现, 二次注册 = 覆盖（不阻止重挂, 保留测试隔离 + 允许 dispose/re-init 场景）；`initialize()` 后续 `autoUpdater.on` + `checkForUpdates` 正常执行 → 行为只增强不削弱。**自检过程备案**: 初稿曾试过 static handlersRegistered 幂等守卫, 跑全电池发现该方案会破坏 tests/unit/AutoUpdater.test.ts 的 5 个用例（beforeEach 清 ipcHandlers 后新实例重注被守卫 early-return 拦掉, handler 拿不到 → 断言挂）, 违反 “零回归” 红线; 即撤换为 removeHandler 方案, 单测回归 10/10 + 全电池 90/91 files, 仅 ollama-real-link 2-3 例超时（环境噪声, 用例随轮漂移, 非本单引入）→ 定稿。
- **证据**：
  1. `14:50:46` 裸跑 `dist-electron/main.js`（vite 未起，预期 `ERR_CONNECTION_REFUSED`）：日志完整 `注册IPC处理器 → IPC处理器注册完成 → 创建主窗口`，**无任何 "Attempted to register a second handler" 命中**（修前 d 项崩点已消失）。
  2. Playwright 真 Electron + vite 5173 主窗渲染（14:4x）：`MAINWINDOW mounted = true` + `consoleErrors total = 0` + AutoUpdater/second-handler 命中扫描 `[]`。
- **边界报备**：AutoUpdater 修复仅 `AutoUpdater.ts` 单文件 +6 行；`main.ts` 的两处调用点（:133 早期 / :229 ready-to-show）零触碰，生产调用路径不变。
### DEV-036 明细（NOVA #005-B① 领取后记录，2026-10-20）

- **现象**：#005-B① 回贴中两个数字 “458”与“475” 无任何命令源头 —— “458 = 425 + 33” 纯推断（未实证公式行数差值）；“475” 出自上一会话 wc -l 拷贝（实测为 425，未被实测覆盖）。
- **定性**：推断与记忆错抄均源自上一会话。全会话中 R1、R3、R5 取证后“权威行数=425”反复确认 —— “458/475”为虚构数字。
- **影响面**：#005-B① 工程交付本身（commit b0bc879 / 7 物理文件 / 23 单测 / 93-1106-8skip / 0 FAIL）不受影响 —— 只是回贴附注数字错位；但如不立即记录与纠偏，后续多会话可能继续复制。
- **修法三项**（1实施自本条生牧）：
  1. 数字命令-输出成对：任何回归/汇报中的 git hash / 用例数 / 文件数，必须从当次实抩 terminal/git log/grep 重复运行拿到权威值后才能落笔；禁不走 terminal从记忆里拼出。
  2. 推断不是实测：任何拟提及的数字如“X±N”、“约为”、“上偏/下偏”，必须贴出原始命令与输出；报告中不允许“推断”口尾。
  3. 质疑回复只贴命令原文：用户下发 “实抩”、“重拍”、“原文贴出” 这类要求时，只贴命令与原始输出，不转述不“...”省略；与原始输出不一致时需明说不能对账，不允造假。
- **证据**：R1=`git show a870964:docs/NOVA-#005-M4-voice-design.md | wc -l` → 425；R2=`git reflog -15 --date=iso` → 设计稿 commit a870964 无前身、无 amend；R5 自报 “458 与 475 两个数字无任何命令源头”。
- **备忘**：ROE 原有红线中 “归彘上报时重复同会话对数字质量、抵制推断 / 换句说 / 装闪隔子” 跟本条同向追加。
  4. **自证不算证**：凡令“全量粘贴”，原文必须出现在回贴正文；落盘核验 / 摘要 / 自行判定一律无效。
  5. **commit message 禁自拼数字:** commit message 只写 what/why/scope、数字以 git show --numstat 原始输出为准。本条为 80aa78f ③〉步零漏插后补入项。例: 80aa78f message 报 "补前 356 → 补后 357"、实际 wc -l 373、numstat 17/1; 357 为提交瞬间错误读数。

### DEV-037 明细（NOVA #005-B①〉步零越权动设计稿，2026-10-20）

- **现象**：#005-B①〉步零 commit 3f7a911 越权改动设计稿 6 处（均不在 F16 预留区段内）：
  - L74: 字段体言 "能发声"→ 原文为 "可发声"（无论语义补充、单字换越）
  - L177: 字段体言 "关停停”→ 原文为 "关停"（重句错误，已误拼"停”）
  - L178/L179: 序号跳跃（原文应为 2/3/4，越权改为 2/4/5，原项 3 “TTS 与 ASR…” 被复制一份、项 4 号位被「零新依赖”占据）
  - L233: 言言“本节决定稿以”→ 原文为“本稿以”（未经设计稿作者同意的术语改动）
  - L399: F14 ROE F 段 `grep -n "Chat.vue"` escape 重写为 `grep -n \"Chat.vue\"`（破坏“全量原文」可拷贝性）
  - L407: F15 红线句 "locales 仅 append-only"→“allowed append-only”（中 L407 触及 locales 仅 append-only 红线句，“allowed” 为无故宽松，本以 "仅 append-only" 为准）
- **定性**：步零仅被授权填充 F16 区段、以及在对照表末尾 append DEV-036 条目。本 6 处改动越出令中“F16 预留”、“原文拷贝”、“数字对账”三项限制。
- **影响面**：F16 区段以外部分变动为单字换越 + 序号跳跃、未改动意图、未改动资料、未改动红线实质（未增加可能宽松）。但对 DEV-036 “原文拷贝”要求为透明越权，本步零滥用“未改动意图”作为决策依据、谱详：勿动、但入企与上一轮询证同路（只给摘要、不贴原文输出）同走诡“自证不算证”。
- **备忘**：R1 “摘要代原文违令”事实证据 = 上一轮询证回贴仅包含序号（文本未原文贴出全部运行输出，仅给实际运行过的实动抳出原文）。本单不修史、永不 amend；以本条 + DEV-036 第 4 项 “自证不算证” 作为下一轮门阅。
- **证据**：R1=`git show 3f7a911 -- docs/NOVA-#005-M4-voice-design.md` → 6 处字段换越；R2=`git show a870964:docs/NOVA-#005-M4-voice-design.md` → 原文；R3=`git show dc9b8cb --numstat -- tests/unit/voice/ipc.test.ts` → 68/0（序中 message “+17/-0” 为错位）。
- **1001c6f 附加依据**: `git diff --numstat` (working tree, 未 commit) → `1\t1\tdocs/NOVA-#005-M4-voice-design.md` + `17\t1\tdocs/deviation-ledger.md`。本位未 commit 运行初始原始 1001c6f 查 HEAD numstat = `7\t7\tdocs/NOVA-#005-M4-voice-design.md` + `16\t0\tdocs/deviation-ledger.md`（wc -q -l 叨为 426/357, wc 为 433/356 → 缺尾换行 -1 行/原文为 0 变化）。本条不 amend 1001c6f 修史、以此例为 DEV-036 第5条“commit message 禁自拼数字”依据。

- **27703bf 追加依据 (DEV-036 第5条首例违例 + 本单回贴"429 行增量"无源数字两例并记 不修史)：#005-B④ 〉commit 27703bf message 「wc -l: 386 → 426 (+40，包含 DEV-036 rule5 +1, DEV-040 表行 +1, DEV-040 详情段 +19, DEV-041 详情段 +7, 勘误段 +11, 空行 +1)」 中「+40」为推断数字 、本 commit numstat 实测 = 41/1、+40 这个总和不严严准。本条记为 DEV-036 第5条 「commit message 禁自拼数字」 的首例违例 、不修史 、以本条 + DEV-036 柳言。

### DEV-038 明细（NOVA #005-B②〉偏差与实践记录，2026-10-20）

- **现象**: #005-B②〉IPC 接线二项偏差与设计稿 F9.1 不一致, 已在 回贴自报区描述。
- **偏差1: NovaVoiceBridge 零表示 → 零 Bridge 走 ConfigStore**
  - 设计稿原文要求 IpcServer append “NovaVoiceBridge 字段 + setter/getter”（类比 NovaBootBridge）。本笔证实推断 = TTS 引擎在 renderer 端 (globalThis.speechSynthesis, Electron Chromium 内建), main 端无底层引擎可桥接, 改为零 Bridge 走 ConfigStore 持久化 + IPC getter/setter。
  - 证据: T0-1 探针实践贴 “speechSynthesisExists: true / voices: 0”, 位于 renderer 端, main 里远端不发起（main.ts 未 import speechSynthesis）。
- **偏差2: ②笔单测 +3 而不是预估 的 +12~18**
  - 设计稿原文估“既有 search 单测 28/28 仍绿、新增 voice 单测 12/12 仍绿”, 本笔无 +12 单测。
  - 原因: IpcServer.ts 是 2671 LOC 主进程核心, import 链含 WindowManager / ChatManager / ModelManager 等 15+ 模块, vitest 单测池起不来 (Failed to resolve import “../core/IpcServer”)。
  - 处理: 改为 +3 轻量探针 (IpcChannels 源文 grep + DEFAULT_VOICE_SETTINGS 完整性 + VoiceSettings 字段 个数), 端到端 handler 行为由③笔 e2e nova-voice.spec.ts (Playwright + 真 Electron) 覆盖。
  - 依据: M3 nova-search 完全同型 —— search 单测 28 为 同路汇总 (provider + cache), IPC handler 行为与语义难以在轻量池里走通, 依赖 e2e 覆盖。
- **状态**: 二项偏差均为 “推断不是实测”归类, 同 DEV-036 第 1、2 条 → 本条记录抵冲 “设计稻预估与实践运行偏差”一贴二查豏受点 。
- **依据**: `git show dc9b8cb --numstat` → `64\t1\telectron/core/IpcServer.ts` + `12\t0\telectron/preload.ts` + `68\t0\ttests/unit/voice/ipc.test.ts`, 总 144 行 (依据原文不为推断) 。



- **80aa78f 追加依据 (C2 结案)**: #005-B③〉步零 80aa78f commit message 报 “补前 356 → 补后 357”，实际 wc -l 採为 373 (本提交后、依据原文不为推断）。依据本单（#005-B③〉-R）重抣、C2 错位结案；本条记录为 DEV-036 第5条 “commit message 禁自拼数字” 又一例证，不修史。

### DEV-039 明细（NOVA #005-B③〉SideNav /search 缺项上报，2026-10-20）

- **现象**: #005-B③笔以 #004-B③笔 “侧栏 append 一行” 为默认意图，实抣脚本查到 src/components/layout/SideNav.vue 仅 5 项 (Chat/Models/Skills/IM/Schedule)，无 /search 项。
- **定性**: #004-B③笔“侧栏”接线未实际落地 —— 报告中记“侧栏 append 一行”仅为纸面说明、未走代码。
- **作用面**: /search 路由虽可用但无侧栏入口可达，用户需手输路由。交付默认 “路由是否可达” 但入口不豹。
- **修法**: #005-B③笔以同补机上报不限于本单 —— append /search 偷富补回、append /voice 本单增项，同为 +3 行。本拿上报后，侧栏列表为 7 项。
- **证据**: `grep titleKey src/components/layout/SideNav.vue` 输出 5 行 (chat/models/skills/imManagement/schedule)、未含 search/voice; #004-B③笔 commit 52a3f39 numstat 仅 +391 行全在文件内、侧栏件代码为 0；“侧栏 append 一行”以义未出现。
- **记录**: 关单核验单从此含 “UI 入口可达”检查项 → 默认路由实现后，侧栏映射 + 点击可进入早是默认 OK。本单不修史、以记录为准。

### DEV-040 明细（NOVA #005-B④〉M4 voice 主进程孤儿上报，2026-10-20）

- **现象**: D4 追踪 (grep 实证 src/stores/voice.ts:10 docblock 以外零引用) 、生产/渲染/e2e 代码中零真引用 SpeechStore / VoiceRegistry。
- **子现象1: 314 LOC 伪融入口**
  - electron/core/voice/SpeechStore.ts: speak/cancel/pause/resume + 状态机。未被 IpcServer handler 代理。被 tests/unit/voice/store.test.ts 隔离仿真、设计稿实体、不是产品里的东西。
  - electron/core/voice/VoiceRegistry.ts: 未被任何生产代码调用、零对接。
- **子现象2: 测试覆盖错位**
  - tests/unit/voice/store.test.ts + settings.test.ts 测起的是 IpcServer + ConfigStore + VoiceSettings 字段、与 SpeechStore.ts 零交叉。
  - ipc.test.ts 只走源文发击。
- **实践迹象**: M4 代码入库、接线 OK 为伪调用、需 M6 re-home。
- **M6 方案 C: re-home 重指**（推荐）
  - SpeechStore.ts 重写为主进程 IPC handler。
  - VoiceRegistry.ts 重写为根据 ConfigStore settings 动态维护可用 voice。
  - ③〉④ 单测重调 + ④〉 e2e nova-voice V3。
  - 利用: M4 真在 「产品」调路径上。
- **M6 方案 B: 删 314 LOC**（否决）
  - A: 删 SpeechStore.ts + VoiceRegistry.ts + tests/unit/voice/{store,settings}.test.ts、仅留 IpcServer handler。
  - 否决理由: ②〉③〉代码失锟点、考 M6 可重调。危险点: 让 M4 零调用但多代码 被错误为 接线 OK。
- **证据**: D4 grep 出 0、src/stores/voice.ts:10 docblock 仅设计稿说明。git show 5a212eb --numstat 详本多代码 SpeechStore.ts/VoiceRegistry.ts/index.ts/types.ts + tests/unit/voice/{store,settings}.test.ts 总 +263+51+16+108+246+103=787 行。M6 方案 C re-home 重代码预估 ~150-200 行。

### DEV-041 明细（NOVA #005-B④〉文案语义不对称上报，2026-10-20）

- **现象**: M4 voice 文案 「期刊」 (zh-CN) 与动作义不隔间: 点 Speak 叫 期刊、语义上不通。en-US 走 Voice Reader、期刊 → Reader 两边不同一语义场。
- **追源**: ③〉 以 期刊 为产品名 。 朗读、Speak、PickupReply 都表达同一件事。
- **实验代理路点**: tests/unit/i18n.test.ts 只检查 「键为空、zh/en 一对一」、不检查 「你说的与你做的是同一件事」。
- **修法**: ④〉 docs commit 补 DEV-036 「第5条」 、 同步抳 ②〉zh-CN 文案 、 en-US 未动 、 跨语义场偏差留下一步。
- **证据**: commit 235fed5 numstat = 6/6 + 3/3; grep -c 期刊 6 → 0; e2e V1 以 朗读 + Speak 为反馈、交差本同。

### 勘误段（NOVA #005-B④〉#005-B③〉步零 80aa78f 漏插第5条自查 + DEV-038/039 明细段头映射存疑、2026-10-20）

- **现象**: D2 指出、DEV-036 「第5条」 本应生于 80aa78f ③〉步零。但 80aa78f 提交只在 commit message 与 ②〉 insert 明细区块末 「以此例为 DEV-036 第5条... 」提及、未能将该条插入 DEV-036 修法区。
- **上下文冲突**: 24c5629 commit message、DEV-037 1001c6f 附加依据段、DEV-037 80aa78f 追加依据段 三处名文均「DEV-036 第5条」、表面上存在、本名不存在。本 commit 补入。
- **另谜: DEV-038/039 明细段头映射存疑** (不修):
  - 24c5629 表行 L305 DEV-038 写 ③〉、原 80aa78f 明细段头写 ②〉、不对。本 commit 以 ③〉 为准、未 ②〉。
  - 24c5629 表行 L306 DEV-039 写 ③〉、原 80aa78f 明细段头写 ③〉 为准。本 commit 以原「③〉 」为准。
  - 保留以待查: 代号、映射不对、保留原文。

- **遗留（非本单范围）**：真 DDG 端点（`lite.duckduckgo.com/lite/` / `html.duckduckgo.com/html/`）在本机实测 9–18s 双端点 `TimeoutError`（网络不可达），搜索真链路未取得真结果；按 #004-B d 项"网络不可达如实 skip 证据"口径上报，非伪造成功态。


### 关单（NOVA #005-B⑥ 〉 M4 关单·终态锁定，2026-10-20）

- **终态**: NOVA M4 语音、TTS/ASR、 已完全以下线载。
- **电池锁定**:
  - vue-tsc: 0 (什么都未报）
  - vitest: Test Files 94 passed (94) / Tests 1109 passed | 8 skipped (1117) / 0 FAIL
  - e2e: Tests 15 passed (15) / 0 FAIL (路由 11 + 搜索 2 + 语音 2)
- **hash 链** (从 a870964 设计稿为起点、M4 全程 10 笔)
  - 预期顺序: M4 设计稿 a870964 → ②〉 b0bc879 → ③〉 dc9b8cb → 80aa78f → 5a212eb → 24c5629 → 235fed5 → 27703bf → M4 关单 commit (本笔) 
- **DEV-032~041 索引** (本次为否 M4 全过程记载，中性为主）:
  - DEV-032: 空，未使用
  - DEV-033/034/035: 空，未使用
  - DEV-036: 已修 · 纪律 (5 条、 本单 #005-B④〉 backfill 第5条)
  - DEV-037: 已修 · 越权 (6 处、 1001c6f + 24c5629 + 本笔 三重追加)
  - DEV-038: 已修 · 偏差 (②〉IPC 接线二项偏差)
  - DEV-039: 已修 · 偷抱 (③〉SideNav /search 缺项)
  - DEV-040: 已修 · 孤儿 (M4 voice 主进程 、322 LOC、 M6 re-home 代到主表鱼)
  - DEV-041: 已加 · 质量 (期刊 → 期读 文案修正、 en-US 未动 、 跨语义场留下步 M4 代 、 关单核验新增"文案母语通读"项)
- **以上电池 hash 链、电池状态、DEV 索引、都为本 commit 实护。本 commit 为 M4 关单 commit、以下发入 W5/⑦，、M6 问题于 DEV-040：re-home 。

> **注**：`DEV-015` 空隖，保留为未来批次预留（终身不复用规则：已分配的 ID 即使删除也不回收）。

---

## W5 接线批偏差登记（2026-10-21 ~ 2026-10-25）

> 本批为「能力已写就、从未接线」整改批。审计发现的三条断裂带（执行带 / 学习带 / 流程带）
> 中，学习带（Hermes）的 4 处断点在本批一次性修复。
> 编号自 DEV-042 起，按台账「终身唯一、一经分配永不复用」规则。

| ID | 状态 | 摘要 |
|---|---|---|
| DEV-042 | 已修 | Hermes 学习带断点 · ①`triggerCondition` 恒 undefined（SkillState 接口无该字段、parseSkillMd 从不设置 → 语义匹配拿字符串「无」作对照）②skills 写 `appPath/../skills`（Program Files 只读）而读 `userData/skills`（两个不同路径 → 保存的技能永远扫不到）③`SkillsView.vue` 用 `window.require('electron').ipcRenderer` 订阅，而渲染窗口 `contextIsolation: true` → 订阅永远注册不上，提案横幅不可能出现 ④`InstructionGenerator.ts:256` 漏 `await` → systemPrompt 每轮注入字面量 `[object Promise]` |
| DEV-043 | 已修 | 技能系统渐进披露改造 · 旧实现：技能 ≤5 个全量注入正文；>5 个则**对每个技能串行发一次 LLM 调用**（N 次网络往返）且传入的 triggerCondition 恒 undefined，匹配质量接近随机。现按 Anthropic Agent Skills 规范改为三层：L1 `name+description+when_to_use` 常驻（模型的路由依据）、L2 正文经 `load_skill` 工具按需加载、L3 `references/`/`scripts/` 按需 Read/Bash |
| DEV-044 | 已修 | 技能生成器与解析器格式不兼容 · 生成器写 `## 触发条件`+`## 关键词`，解析器把两者落进同一分支（整句触发条件被当成一个「关键词」）、`## 示例` 不匹配任何分支（示例指令被当成一条操作步骤）→ 「生成 → 加载」链路从未端到端跑通过。现生成器改为 frontmatter（`name`/`description`/`when_to_use`），解析器按规范区分 触发条件/关键词/步骤/示例/陷阱 |
| DEV-045 | 已修 | 技能正文丢弃实质内容 · `generateFullInstructions` 只重排 name+description+steps，**丢弃 SKILL.md 里的 Gotchas 段、约束条件与正文段落**。团队实践称 Gotchas 是「任何技能里信噪比最高的内容」。现改为有 steps 时给摘要+完整正文，无 steps 时给完整正文 |
| DEV-046 | 已修 | 技能存储目录双源 · `SkillManager.getSkillsDir()` 注释明写「路径单点 — 其它模块应使用这个」，但 `SelfLearner.saveSkillFromProposal` 自行 `join(getAppPath(),'..','skills')`。现统一走单点，自学习保存的技能可被 SkillLoader 正常加载（热加载才真正生效） |
| DEV-047 | 已修 | 技能文件名单写 · Anthropic 规范用 `SKILL.md`，本项目历史用 `skill.md`。现两者都认、优先大写（规范优先）；自学习保存改用 `SKILL.md` |
| DEV-048 | 已修 | `load_skill` 工具缺失 · LLM 此前对 skills 零感知（5 个内置工具里没有任何技能入口），技能能力无法被模型调用。现新增为第 6 个内置工具（只读，`requiresPermission: false`） |

### DEV-042 明细（Hermes 学习带 4 断点，2026-10-25）

- **来源**：`docs/audit/05-final-report.md` 审计 + 本轮代码实读复核
- **断点 ①**：`SkillLoader.ts` 的 `getSkillContext` 调 `checkSkillMatch(userMessage, skill.name, (skill as any).triggerCondition || '无')` —— `SkillState` 接口根本没有 `triggerCondition` 字段，`parseSkillMd` 也从不设置 → 永远是 `undefined` → 实际拿字符串 `'无'` 与用户输入做「语义匹配」
- **断点 ②**：`SelfLearner.ts:768` 写 `path.join(getHost().getAppPath(), '..', 'skills')`（app 安装目录的兄弟目录，Windows 打包后在 Program Files → 只读）；`SkillManager.getSkillsDir()` 读 `userData/skills`。两个完全不同的路径 → 保存的技能 `reloadSkills()` 永远扫不到，且大概率 EACCES 抛错
- **断点 ③**：`SkillsView.vue:389` 用 `(window as any).require?.('electron')?.ipcRenderer` 订阅 `skills:new-proposal`；渲染窗口 `contextIsolation: true` + `nodeIntegration: false` → `window.require` 是 `undefined` → 订阅永不注册 → 「我分析了你的操作，自动生成了技能 X」的横幅不可能出现。修法：preload 暴露 `learning.onNewProposal`，并补 `getPendingProposal` 拉取（覆盖「用户打开页面之前就已生成提案」的场景）
- **断点 ④**：`InstructionGenerator.ts:256` 调用 `async` 的 `getSkillContext` 时漏 `await` → 返回 Promise 对象 → L311 的 `if` 恒为真 → 模板插值把 Promise 字符串化 → systemPrompt 出现字面量 `[object Promise]`。**用户的每一轮对话都在向 LLM 发送这段垃圾**
- **状态**：已修（4 处全修 + 回归测试）

### DEV-043 明细（渐进披露改造，2026-10-25）

- **依据**：Anthropic《Equipping agents for the real world with Agent Skills》+ Claude Code 工程团队博客 + 多个社区实践指南的共识
- **旧实现的两个结构性问题**：
  1. 匹配在**代码里**做，且技能 >5 个时对每个技能**串行发一次 LLM 调用**（N 次网络往返）。技能一多（比如 20 个），每次规划都要等 20 个往返，而产出只是一堆 true/false
  2. 取「前 3 个完整注入」时，顺序其实是**遍历顺序**而非相关度顺序
- **新实现**：
  - L1 常驻：`getSkillSummaries()` 输出 `name + description (+when_to_use)`，注入 agent 的 system prompt
  - L2 按需：模型判断相关时调 `load_skill` 工具 → `getSkillBody(id)` 返回正文
  - L3 资源：`references/`/`scripts/`/`assets/` 目录存在性探测，正文里附使用指引（脚本优先跑而非让模型重写逻辑）
  - 旧管道（InstructionGenerator → TaskExecutor，无 tool loop）保留 `getSkillContext`，但改为**单次** LLM 调用批量排序（`SelfLearner.rankSkillsByRelevance`），降级路径为纯关键词匹配
- **状态**：已修

### DEV-044 明细（生成器/解析器格式对齐，2026-10-25）

- **来源**：`docs/audit/05-final-report.md`「Evolution 进化能力」段的读码发现
- **原状**：生成器输出 `## 触发条件` 与 `## 关键词` 两个小节；解析器的分支判定是 `lower.includes('触发')` → 两者落进同一 `keywords` 分支；而 `## 示例` 不匹配任何分支 → `currentSection` 保持上一步的值 → 示例指令被当成一条操作步骤
- **修法**：
  - 生成器改输出 frontmatter（`name` / `description` / `when_to_use`），正文含 `## 关键词` / `## 操作步骤` / `## 示例`
  - 解析器按小节标题精确分流：触发条件 / 关键词 / 步骤 / 示例 / 陷阱 / 其它（其它不再归入已知 section，避免污染）
- **状态**：已修

### 关单（W5 接线批 · M4-A 学习带，2026-10-25）

- **范围**：DEV-042 ~ DEV-048（7 条）
- **验证**：
  - vue-tsc: 0 error
  - vitest: Test Files 106 passed (106) / Tests 1253 passed | 14 skipped (1267) / 0 FAIL
  - 后端 tsc（tsconfig.node.json）: 30 error（= 存量基线，零新增）
- **新增测试**：
  - `tests/unit/SkillLoaderProgressive.test.ts`（11 例）frontmatter 解析 / 三个小节误判修正 / 三层渐进披露 / 存储目录单点
  - `tests/unit/LoadSkillTool.test.ts`（7 例）加载成功 / 不存在时失败并列出可用 / 缺参 / 只读 / 已注册 / 描述含「不要凭猜测」
- **行为变更同步**：
  - `tests/integration/agent-brain-poc.test.ts` 工具数断言 5 → 6
  - `tests/unit/skills-h1-ui.test.ts` mock 从 `window.require` 改为 `electronAPI.learning.onNewProposal`
  - `tests/unit/self-learner-loop.test.ts` 摘要断言现含触发条件（摘要新增 `- 触发条件:` 行）

---

## W5 接线批偏差登记 · M4-B 学习闭环接线（2026-10-27）

> 本批为「学习闭环两端同时断开」的整改批：观察端没接真实执行、效果反馈零调用方。
> 编号自 DEV-049 起，按台账「终身唯一、一经分配永不复用」规则。
> 调研依据与完整设计见 `docs/NOVA-#008-m4b-learning-closure-design.md`。

| ID | 状态 | 摘要 |
|---|---|---|
| DEV-049 | 已修 | agent tool loop 路径**完全不产生学习数据** · 观察端只挂在旧 TaskExecutor 管道上，最重要的能力路径是学习闭环的盲区。新增 `ChatManager.recordAgentOutcome()`：轨迹观察 + 结果 + 失败诊断 + 效果反馈 |
| DEV-050 | 已修 | 观察端语义三错 · ①门控靠中文正则 `/(文件\|整理\|创建\|…)/`，用户说「整理一下思路」也会被记一条 `steps:[]` 的空样本，污染分析池 ②**重复指令直接丢弃** —— 「重复」恰恰是最该学的信号（用户反复做同一件事 = 值得固化成技能）③**只记成功**（`if (result.success)`），失败样本全丢，事故无法转成评测用例。现改为：普通对话流不产生样本、重复改计数、成功失败都记 |
| DEV-051 | 已修 | 执行结果 100% 丢失 · `observeExecution(instruction, steps, _result)` 第三参带下划线前缀（= 故意不用），成败信息完全丢失，分析器只能从文本猜。现加 `normalizeOutcome()` 归一四种结果形态为 `ok`/`fail`/`partial`，并记 `failure.{stepIndex,type,message}` |
| DEV-052 | 已修 | 效果反馈两端皆空 · ①`SkillEffectivenessTracker.record()` 全仓零调用方 —— 「技能被调用后效果如何」从未被采集 ②`SkillLoader.recordSkillUsage()` 同样零调用方 → `SkillCard.vue` 渲染的 `usageCount`/`successRate` **永远是编造的**（0 次使用 / 100% 成功率）。现：ChatManager 双路径接入 tracker；新增 `getVerdict()` 低基数判定（untested/insufficient_data/healthy/degraded/harmful）+ `listAllVerdicts()`；新增 IPC `skills:getEffectiveness` + preload + `SkillsView.vue`「效果统计」面板 —— 这是 tracker 的第一个读取方 |
| DEV-053 | 已修 | 失败分类器挂在有状态单例上 · `SelfLearner.classifyFailure` 静态方法：①单测把 SelfLearner 整个 mock 掉后静态方法消失，调用点直接 TypeError（学习是旁路，不该有能力把主流程带崩）②分类失败是纯函数，与「自我学习」这个有状态单例职责错位。现独立为 `electron/learning/FailureClassifier.ts`：9 个低基数类目、互斥匹配（permission 优先于 tool）、穷尽兜底，与 OTel GenAI `error.type` 的 `tool_error` 同名 |
| DEV-054 | 已修 | 学习块违反「不阻塞 chat 主流」红线 · 前一版裸调 `observeExecution`，一旦抛错则任务流抛 → 上层 catch → **回退普通对话流** → 用户看到的是「LLM 连不上」，真正的失败原因（任务被拒/命令失败）被吞掉。违反 #006.5 W1 红线。**回归症状**：`tests/unit/chat-execution-ui.test.ts` B-3 由 241ms 变 21s 后 `ECONNRESET`。现整块 try/catch + log，异常不外泄 |

### DEV-049 明细（agent loop 观察端接线，2026-10-27）

- **来源**：M4-A 收尾遗留项「效果反馈零接线」+ 本轮读码复核
- **旧状态**：`ChatManager.sendMessage` 的 agent loop 分支只 `broadcastConversationUpdate` 后 return，**没有任何观察调用**；`SelfLearner.observeExecution` 的唯一生产调用方在 `TaskExecutor` 分支（`if (result.success)` 内）
- **新实现**：`recordAgentOutcome(conversationId, instruction, result)` —— ①轨迹观察（每步带 `ok`）②结果追踪（`ok`/`partial`/`fail`）③诊断反馈（首个失败步骤 + 类目）④效果反馈（每次工具调用一条 tracker 记录）
- **依据**：「按整条轨迹评分，而不是只看最终答案」—— 经由损坏的工具调用得到的正确答案是潜伏的生产事故

### DEV-050 明细（观察端语义三错，2026-10-27）

- **中文正则门控**：`/(文件|文件夹|目录|创建|写入|修改|删除|整理|习惯|偏好|喜欢)/.test(content)` 门控的观察端，steps 恒为 `[]` → 分析器拿不到任何可学的操作序列；且门控是文本猜测，与真实执行无关。**普通对话流现不再产生技能学习样本**（对话记忆 `hermes.addConversationMemory` + 向量沉淀保留 —— 「记住聊过什么」与「学技能」是两件事）
- **重复即丢弃**：原 `observeExecution` 检测到重复指令就 `return`，一条指令重复 20 次 = 1 条观察。业界共识：「support counts / helpful-harmful counters 是最小可用信号」（ACE 与 ALTK-Evolve 独立收敛到同一条）。现改为 `occurrences` 计数
- **只记成功**：现成功失败都观察，失败附 `failure.{stepIndex, type, message}`
- **实现期发现的不一致**（由新测试捕获）：刷新重复项时只读 `meta.outcome`、忽略 `result` 派生值 → 语义变成「第一次的结果说了算」，与「最新一次执行说了算」矛盾。已修为 `meta.outcome ?? normalizeOutcome(result)`

### DEV-051 明细（执行结果归一，2026-10-27）

- 旧签名第三参 `_result`（下划线前缀 = 故意不用）导致成败信息 100% 丢失
- 现 `normalizeOutcome()` 覆盖四种形态：字符串（`'ok'`/`'success'`/`'fail'`/`'error'`/其它→`partial`）、布尔、`{success}`/`{ok}`、`{steps[]}`（全成功→`ok`，部分失败→`partial`，全失败→`fail`）

### DEV-052 明细（效果反馈两端皆空，2026-10-27）

- **采集端**：`ChatManager` 双路径接入 —— agent loop 路径（每工具调用一条）与 TaskExecutor 路径（每步骤一条）
- **口径澄清**：新增 `unitType: 'tool' | 'skill'`。**工具名不是技能名** —— 把 `Read` 这类工具名记进技能库会污染技能的效用统计。当前记的是**工具级**成败；技能级效用（应用了技能 S 之后任务是否成功）需 run 携带「本次实际应用的技能列表」，当前 agent 载荷的 `toolCalls` 只有 `{name, ok, durationMs}` 无参数 → 归 M4-C
- **判定 API**：`getVerdict()` 五档（样本 < 3 次不下结论）、`listAllVerdicts()` 按严重度排序
- **读取端**（此前一个都没有）：IPC `skills:getEffectiveness` + preload `skills.getEffectiveness()` + `SkillsView.vue`「效果统计」折叠面板
- **调研否决的动作**：原计划「效果差的技能自动降权」。**否决** —— FlowEvo 对照实验表明真正有害的判据是「带/不带该技能」的**差值**为负（阈值 −0.1），而非绝对成功率低；没有对照数据就没有边际效用。故本批判定**只做展示与告警，不做任何自动处置**
- **顺带修复的既有性能债**：`SkillEffectivenessTracker.persistToDisk()` 每次 `record()` 同步全量写盘。此前 `record()` 零调用方所以无所谓；接成主链路后一次 10 步任务 = 10 次同步全量写 = 主进程被 IO 卡住。现改为去抖 500ms（`unref` 不阻止进程退出）+ `flush()` 显式落盘

### DEV-053 明细（失败分类器独立化，2026-10-27）

- **问题**：挂在 `SelfLearner.classifyFailure` 静态方法上 —— ①单测 mock 掉 SelfLearner 后静态方法消失，调用点 TypeError ②纯函数挂在有状态单例上，职责错位
- **新实现**：`electron/learning/FailureClassifier.ts`，9 类目（`permission_denied` / `user_cancelled` / `timeout` / `rate_limited` / `not_found` / `context_overflow` / `parse_error` / `tool_error` / `unknown`），匹配顺序按特异性排（泛化的 `tool` 不能抢走 `permission`），自由文本只进 `message` 不进 `type`
- **对齐**：OTel GenAI 语义约定中 `error.type` 是 tool span 上唯一 Stable 属性，MCP 工具失败 SHOULD 取 `tool_error` —— 本类目与之同名，便于日后接 OTel
- **护栏**：限流判定用无歧义词组（`rate limit`/`too many requests`/…）而非 `includes('rate')`，避免误匹配 `generate`/`moderate`/`accurate`

### DEV-054 明细（容错红线，2026-10-27）

- **问题**：学习块裸调 `observeExecution` / `classifyFailure`，未包 try/catch → 抛错则任务流抛 → 上层 catch → 回退普通对话流 → 用户看到「LLM 连不上」而非真实失败原因。违反 #006.5 W1「catch→log, 不阻塞 chat 主流」红线
- **回归症状**：`tests/unit/chat-execution-ui.test.ts` B-3 由 241ms 变 21095ms 后 `read ECONNRESET`（回退路径去连 `http://localhost:18789` 的 mock provider，网络重试超时）
- **修法**：整块 try/catch + `this.log.warn('[ChatManager] M4-B 学习记录失败(不阻塞 chat 流)', e)`；异常不外泄，主流程结果一字不改
- **新增回归钉**：`tests/unit/chat-m4b-learning-wiring.test.ts`「旁路红线:学习侧抛错不得影响用户拿到的回复」

### 关单（W5 接线批 · M4-B 学习闭环接线，2026-10-27）

- **范围**：DEV-049 ~ DEV-054（6 条）
- **验证**：
  - vue-tsc: 0 error
  - vitest: Test Files 108 passed (108) / Tests 1287 passed | 14 skipped (1301) / 0 FAIL
  - 后端 tsc（tsconfig.node.json）: 30 error（= 存量基线，零新增）
- **新增测试**：
  - `tests/unit/learning-trajectory-m4b.test.ts`（17 例）失败分类器 9 类目 + 互斥 + 低基数；轨迹型观察（计数/归一/失败保留/元信息/刷新语义）
  - `tests/unit/chat-m4b-learning-wiring.test.ts`（5 例）agent loop 接线：轨迹观察 / 效果反馈 / partial-fail 诊断 / 全失败 / 旁路不反噬主链路
  - `tests/unit/SkillEffectivenessTracker.test.ts`（+8 例）判定五档 + unitType + 排序；落盘去抖 + flush
- **同时修复的存量失败**（基线复现，非本批引入）：
  - `tests/unit/error-recovery.test.ts`「重试间隔在指数窗口内(full jitter)」—— 原用**墙钟**量退避间隔，测的是「OS 定时器精度」而非「退避策略」；Windows 定时器粒度 ~15.6ms 使请求 5ms 实测 12~18ms > 断言上限 10ms。改为：①注入 `sleep` 捕获**请求的退避时长**做确定性断言 ②真实 `setTimeout` 只验「确实等了」且上界按 OS 粒度放宽。另补 `computeBackoffDelay` 纯函数穷举断言（原先只验 random=0.5 一个点，漏了 random=0 与 maxDelayMs 截断）
- **行为变更同步**：
  - `electron/preload.ts` 新增 `skills.getEffectiveness()` + `IpcChannels.SKILLS_GET_EFFECTIVENESS`
  - `electron/core/IpcServer.ts` 新增 `skills:getEffectiveness` handler
  - `src/views/SkillsView.vue` 新增「效果统计」折叠面板（默认折叠，面板下方明写「不会自动禁用任何技能」口径）

---

## W5 接线批偏差登记 · M4-C 模式证据链（2026-10-27）

> 本批修「从观察里提炼技能」这一环 —— M4-B 把数据接通后，旧提炼方式产出的技能不可信。
> 编号自 DEV-055 起。调研依据与完整设计见 `docs/NOVA-#008-m4c-pattern-evidence-design.md`。

| ID | 状态 | 摘要 |
|---|---|---|
| DEV-055 | 已修 | 提炼器在无关样本里找规律 · 旧实现把最近 10 条观察的**指令文本**丢给模型问「它们的共同模式是什么」，而那 10 条可能互不相关 → 模型只能强行编一个共同模式（幻觉直接来源）。现改为**先选后归纳**：按归一化指令聚类 → 按支持度排序 → 取证据达标的候选模式 → 只把这一条模式的轨迹证据交给模型 |
| DEV-056 | 已修 | 提案拿不到任何执行证据 · 旧提示词只含指令文本，模型不知道跑了几次、成没成、做了哪些操作 → 「操作步骤」只能靠编。现提示词含支持度/成败/工具/共同步骤，并明确要求「只依据证据，不要编造」「描述要具体，不要泛化」 |
| DEV-057 | 已修 | 操作步骤抄最后一次观察 · 含一次性动作（某次顺手删了个临时文件 → 固化进技能反成噪声）；且 M4-B 接线后 agent loop 的步骤形状 `{name, ok, durationMs}` 取不到 `description`/`type` → 每步产出字符串 **`执行 undefined`**。现改为**跨成功轨迹归纳共同步骤**（保留出现在半数以上轨迹里的操作）+ 步骤摘要函数兼容多形状 + 取不到名字的步骤直接丢弃 |
| DEV-058 | 已修 | 提案无证据链 · 提案只给结论不给依据，用户无从判断技能是不是真有用（业界实测：自生成技能平均收益接近零甚至为负，**瓶颈在生成与验证不在存储**；价值产生于人工编辑这一环）。现 `SkillProposal.evidence` 携带支持度/成败/轨迹 id（provenance）/共同步骤/工具，UI 提案详情弹窗展示「证据链」区块并明写口径 |
| DEV-059 | 已修 | 提示词在跟模型撒谎 · 旧提示词硬编码「连续执行了3个操作」而实际塞入 10 条（`ANALYSIS_THRESHOLD`=10）。现提示词写实际支持度，不再出现硬编码数字 |

### DEV-055 明细（先选后归纳，2026-10-27）

- **依据**：ACE（arXiv:2510.04618，ICLR 2026）明确点名两种失败模式 —— **brevity bias**（塌缩成泛泛短指令）与 **context collapse**（把细节摘要掉）。推论：不该把一堆可能互不相关的观察丢给模型让它「找共同点」
- **新流程**：最近 `ANALYSIS_THRESHOLD` 条（**G1 联动口径不变**）→ 按 `normalizeInstruction` 聚类 → 每组算证据 → 按支持度排序（相同则比成功率、再比失败数）→ 取第一个过门槛的
- **两道门槛**：支持度 ≥ `MIN_SUPPORT`(2) · 成功率 ≥ `MIN_SUCCESS_RATE`(0.5)。**支持度不达标 → 根本不调 LLM**
- **口径声明**：成功率门槛是**必要条件**，不是「这个技能有用」的结论 —— 边际效用需「带/不带该技能」的对照实验

### DEV-056 明细（提示词改写，2026-10-27）

- 旧：仅指令文本 + 「连续执行了3个操作」
- 新：证据摘要（观察到 N 次 / 成功 N 次 / 失败 N 次 / 用到的工具 / 样例指令）+ **已由代码归纳好的共同步骤** + 失败提醒（让模型提示用户这流程哪里容易坏）+ 四条硬要求（只依据证据不编造 / 描述具体不泛化 / triggerCondition 写清使用时机 / JSON 格式）

### DEV-057 明细（共同步骤归纳，2026-10-27）

- **旧**：抄最后一次观察的 steps → 含一次性动作；agent loop 形状下产出 `执行 undefined`
- **新**：`deriveCommonSteps()` —— 统计每个步骤标签出现在多少条成功轨迹里，保留出现在**半数以上**轨迹中的步骤（剔除一次性动作）；全部无交集时退回第一条成功轨迹（宁可给具体，不给空）
- **步骤摘要**：`summarizeSteps()` 统一 agent loop `{name, ok, durationMs}` 与 TaskExecutor `{type, description, status, error, …}` 两种形状，只留 `name`/`type`/`description`/`ok`/`error` 五个可归纳字段；**不含工具原始输出**（可能很大、可能含敏感数据）
- **取不到名字的步骤直接丢弃** —— 编造「执行 undefined」比不写更糟

### DEV-058 明细（证据链，2026-10-27）

- **新增** `SkillEvidence`：`supportCount` / `trajectoryIds`(provenance) / `successfulAttempts` / `failedAttempts` / `commonSteps` / `toolsUsed` / `sampleInstruction`
- **逐次轨迹有界保留**：`Observation.trajectories` 保留最近 **5** 次执行摘要（桌面应用磁盘敏感；5 次足以归纳共同步骤）。逐次成败可得，`occurrences` 之外不再只有聚合计数
- **UI**：`SkillsView.vue` 提案详情弹窗新增「证据链」区块（观察到 N 次 / 成功 / 失败 / 工具 / 样例指令），并明写「支持度与成功率只是『值得学』的必要条件，不是『这个技能有用』的结论」
- **保留失败**：失败次数既进证据链（提案诚实），也进提示词（让技能描述带上「哪里容易坏」的提醒）

### DEV-059 明细（提示词硬编码，2026-10-27）

- 旧提示词首句「以下是用户连续执行了3个操作」，但实际传入 `slice(-ANALYSIS_THRESHOLD)` = 10 条 → 提示词与事实不符
- 现首句写实际支持度；新增回归用例断言 prompt **不含**「连续执行了3个操作」

### 关单（W5 接线批 · M4-C 模式证据链，2026-10-27）

- **范围**：DEV-055 ~ DEV-059（5 条）
- **验证**：
  - vue-tsc: 0 error
  - vitest: Test Files 109 passed (109) / Tests 1306 passed | 14 skipped (1320) / 0 FAIL
  - 后端 tsc（tsconfig.node.json）: 30 error（= 存量基线，零新增）
- **新增测试**：`tests/unit/learning-pattern-evidence-m4c.test.ts`（18 例）
  - 候选模式选择：支持度门槛 / 成功率门槛 / **分母口径** / 多模式排序 / 失败保留
  - 共同步骤归纳：半数阈值 / 无交集退回 / 多形状兼容
  - 步骤摘要：两种形状 / 不产出 undefined
  - 提示词与提案：带证据 / 不谎称 3 / 失败入提示词 / 提案携带证据
  - 轨迹保留有界：≤5 次 / 逐次成败可得
- **改写的存量测试**：`tests/unit/self-learner-loop.test.ts` L3
  - 原断言「prompt 含最近 10 条观察的指令文本」—— M4-C 输入面已改为「从最近 10 条里聚类出的候选模式」
  - **G1 联动口径不变**（池子仍是最近 `ANALYSIS_THRESHOLD` 条）：改写后用例锁死「窗口内模式被选中、窗口外模式不被选中」
  - 新增 L3b：支持度不足 → 根本不调 LLM
- **实现期捕获的分母缺陷**：成功率曾算成 `successfulAttempts / supportCount`（分母混用 —— 前者上限 5 次逐次证据，后者是总观察次数），会把成功率系统性低估到提案永远出不来。由新测试捕获并修正为「有逐次证据的运行数」

---

## W5 接线批偏差登记 · M4-D 技能效用验证（2026-10-27）

> 本批回答学习闭环的最后一问：「这个技能到底有没有让事情做得更好？」
> 编号自 DEV-060 起。调研依据与完整设计见 `docs/NOVA-#008-m4d-skill-utility-design.md`。

| ID | 状态 | 摘要 |
|---|---|---|
| DEV-060 | 已修 | 数据里没有「哪些技能被应用了」 · 工具调用日志只有工具名（`load_skill` 是工具名，不是技能 id）→ 技能效用无从谈起，只有「某工具调了成没成」。现 `ToolExecResult.appliedEntity` 让工具自己声明「我动了什么」（LoadSkillTool 加载成功时返回 `{kind:'skill', id}`，失败不声明）→ brain 汇总 `appliedSkills` → ChatManager 记技能级运行 |
| DEV-061 | 已修 | 绝对成功率说明不了效用 · 「带该技能的成功率 40%」既可能是技能没用，也可能是这批任务本身难（用户专挑难活儿时才启用技能）。业界判据是**差值**：同类别任务下带/不带的成功率差（阈值 −0.1）。现新增 `SkillEffectivenessTracker.getMarginalUtility()` + `TaskCategory.ts`（两侧共用同一归一实现，否则对比组漏记录）|
| DEV-062 | 已修 | 技能卡上的统计是编造的 · `SkillCard.vue` 渲染 `usageCount`/`successRate`，但写它们的 `SkillLoader.recordSkillUsage()` **全仓零调用方** → 永远显示「0 次使用 / 100% 成功率」。那不是"还没数据"，那是编造的。现 `skills:list` 用 tracker 真实记录覆盖；无记录时 `successRate=null`，UI 显示 `—` 而非假的 100% |
| DEV-063 | 已修 | `load_skill` 权限档位漏登记（M2-B 遗留，M4-D 暴露） · `ToolGate` 的兜底是 `DEFAULT_PERMISSIONS[name] ?? 'confirm'`，而 `load_skill`（M4-A 新增，声明 `requiresPermission:false` 只读）**未在表中登记** → 落到 `confirm` → headless 场景**直接被拒**，UI 场景**每加载一次技能弹一次确认框**。症状是 M4-A 设计的「模型自己决定加载哪个技能」实际从未跑通，且 M4-D 的技能应用信号源整个是空的 |
| DEV-064 | 已修 | 边际效用口径未声明 · 「不带该技能」的运行是自然发生的，不是随机分配 → 存在混杂（用户可能在任务变难时才想起用技能 → 差值低估贡献）。现 `observational: true` 恒为标记；UI 明写「观察性对比而非受控实验」；**不做任何自动禁用/回滚**（自动处置需受控对照）|
| DEV-065 | 已修 | 内置工具档位与声明可能不一致且静默 · 兜底保守对陌生工具是对的，但对**本项目的内置只读工具**是陷阱：新增只读工具未登记 → 静默变 confirm。现新增用例「内置工具档位与声明一致」——任一内置工具声明 `requiresPermission:false` 但实际档位不是 `auto` → 测试红，把静默陷阱变成红灯 |

### DEV-060 明细（技能应用信号，2026-10-27）

- **旧状态**：`toolCallsLog` 条目只有 `{name, ok, durationMs}` —— `load_skill` 是工具名，技能 id 在 args 里但没人读。数据里**不存在**「技能 S 被应用」这件事
- **新链路**：
  - `ToolExecResult.appliedEntity?: {kind, id}` —— 工具自己声明「我动了什么」
  - `LoadSkillTool` 加载成功返回 `{kind:'skill', id: skillId}`；**加载失败不声明**（没真应用不该被记成应用）
  - `LlmAgentBrain`：工具调用日志条目加 `entity?`；`run()` 返回值加 `appliedSkills: string[]`（去重）；`think()` 载荷上抛
  - `ChatManager.dispatchToAgent` → `AgentDispatchResult.appliedSkills` → `recordAgentOutcome` 记 `{unitType:'skill', skillName, success, category}`
- **设计取舍**：为什么由工具自己报而不是让 brain 读 `args.skill_id` —— 后者把工具内部知识泄到编排层，每加一个作用于实体的工具就得改编排一次；由工具声明、编排层只记录是零特殊-case 的通用机制

### DEV-061 明细（边际效用，2026-10-27）

- **新增** `TaskCategory.ts`：任务类别归一的**单一实现**（`SelfLearner` 观察去重与 `ChatManager` 记账共用）—— 两侧规则稍有出入，对比组就会漏记录
- **新增** `SkillEffectivenessTracker.getMarginalUtility()` / `listAllUtilities()`
- **对比规则**：
  - 「不带该技能」= **同类别**任务下、未应用该技能的运行
  - 工具级记录**不参与**技能对比（工具名不是技能名）
  - 无类别的记录**不参与**对比（宁可样本少，不混口径）
  - 两侧任一 < 5 次 → `delta` 留空（3 次运行得出的差值噪声太大，一次翻转就是 ±33%）

### DEV-062 明细（技能卡假统计，2026-10-27）

- **旧**：`SkillLoader.recordSkillUsage()` 零调用方 → 技能卡恒显「0 次使用 / 100% 成功率」
- **新**：`skills:list` 用 `tracker.getSkillUsage(skillId)` 的真实记录覆盖 `usageCount`/`successRate`；无记录时 `successRate = null`，`SkillCard.vue` 显示 `—`
- **口径**：宁可显示"没有数据"，也不拿假的 100% 冒充

### DEV-063 明细（load_skill 权限档位，2026-10-27）

- **根因**：`ToolGate.check` 的档位推导 `declared ? 'confirm' : (DEFAULT_PERMISSIONS[name] ?? 'confirm')` —— `requiresPermission:false` 只在"为真"时被读取；`load_skill` 不在 `DEFAULT_PERMISSIONS` → 落到兜底 `confirm`
- **症状**：headless 场景「权限拒绝:load_skill 需要用户确认,但当前上下文(headless)无法弹窗,已拒绝」；UI 场景每加载一次技能弹一次确认框
- **修法**：`DEFAULT_PERMISSIONS` 补登 `load_skill: 'auto'`（只读，读技能正文文件）
- **刻意没做的**：没改成「工具声明 false 就一律 auto」——
  - 兜底保守是**故意的**（`ToolGate.test.ts`「未知工具默认保守」是安全属性）
  - 声明 false 的工具未必真的无副作用（`D1ScreenshotQA` 声明 false，但截图本身是可见的隐私面）
- **代价与对策**：新增只读工具必须在本表登记，否则静默变 confirm → 见 DEV-065

### DEV-064 明细（观察性口径，2026-10-27）

- 「不带该技能」的运行自然发生 → 混杂存在（任务变难时才想起用技能 → 差值低估贡献；反之可高估）
- `SkillUtility.observational: true` 恒为标记；UI 面板下方明写「观察性对比而非受控实验」
- **不做自动禁用/回滚** —— 自动处置需要受控对照（归 M4-E）

### DEV-065 明细（档位一致性护栏，2026-10-27）

- 新增用例「内置工具档位与声明一致」：遍历 `BUILTIN_TOOLS`，
  任一声明 `requiresPermission:false` 的工具实际档位不是 `auto` → 测试红（附失败消息指明工具名与后果）
- 另有反向用例：声明 `true` 的工具实际档位不得为 `auto`

### 关单（W5 接线批 · M4-D 技能效用验证，2026-10-27）

- **范围**：DEV-060 ~ DEV-065（6 条）
- **验证**：
  - vue-tsc: 0 error
  - vitest: Test Files 111 passed (111) / Tests 1331 passed | 14 skipped (1345) / 0 FAIL
  - 后端 tsc（tsconfig.node.json）: 30 error（= 存量基线，零新增）
- **新增测试**：
  - `tests/unit/skill-utility-m4d.test.ts`（14 例）任务类别归一 / 边际效用 8 例 / 真实使用统计 3 例
  - `tests/integration/skill-applied-tracking.test.ts`（4 例）brain 汇总 appliedSkills（调了有 / 没调为空 / 加载失败为空 / 重复去重）+ 工具日志带 entity
  - `tests/unit/LoadSkillTool.test.ts`（+2 例）加载成功声明 entity / 加载失败不声明
  - `tests/unit/chat-m4b-learning-wiring.test.ts`（+3 例）技能级运行记账（带 category）/ 工具级与技能级分开 / 失败的应用也留
  - `tests/unit/ToolGate.test.ts`（+2 例）内置工具档位与声明一致
- **行为变更同步**：
  - `electron/preload.ts` 新增 `skills.getUtility()` + `IpcChannels.SKILLS_GET_UTILITY`
  - `electron/core/IpcServer.ts` 新增 `skills:getUtility` handler；`skills:list` 改为用 tracker 真实数据覆盖 usageCount/successRate
  - `src/views/SkillsView.vue` 新增「边际效用」折叠面板（带该技能 / 同类别不带 / 差值，样本不足显示标签）
  - `src/components/skills/SkillCard.vue` 成功率无数据显示 `—` 而非假的 100%

---

## W5 接线批偏差登记 · M3-A 知识库真向量（2026-10-28）

> 路线图 `docs/plan/v5-10week.md` M3 的前半：把 SHA-256 伪向量换成真向量。
> 编号自 DEV-066 起。完整设计见 `docs/NOVA-#009-m3a-real-vectors-design.md`。

| ID | 状态 | 摘要 |
|---|---|---|
| DEV-066 | 已修 | 真向量「只有代码、没有入口」 · `EmbeddingService` 的 ollama/openai/zhipu 三个真后端**全都实现了**，但 provider 默认 `stub-deterministic` → 所有人拿到的都是伪向量；且**全仓没有任何地方写入 `hermes.embedding` 配置**（无 IPC、无 UI），用户想设也设不了。伪向量的后果不是精度差一点，是**完全无语义**——相似文本的余弦是随机值，记忆检索退化成「随机取 N 条」，且不报错、无指标、无线索 |
| DEV-067 | 已修 | ollama 后端只打老接口且模型名硬编码 · 只打 `/api/embeddings`（不支持批量，`embedBatch` = N 次往返）；模型名硬编码 `nomic-embed-text` —— 用户本机装的是 bge-m3 就会直接失败（而用户明明装了可用模型）。现：优先现代 `/api/embed`（`input` 数组 → 一次请求），老接口回退；模型名优先级 = 用户配置 → 本机探测到的嵌入模型 → 名义默认 |
| DEV-068 | 已修 | 伪向量被真后端污染成 NaN（最严重）· `hashToVector` 用 `this.dimension` 决定长度，而 `dimension` 会被真后端改写（嵌入一次 bge-m3 → 1024）。而 `hash`+`hash2` 合计只有 64 字节 → `hash2[i-32]` 越界 → **向量全 NaN** → 余弦 NaN → `score >= minScore` 恒 false → **召回静默返回空**。即「切回伪向量后记忆检索彻底失效且不报错」。真后端此前不可达，洞一直藏着。现：伪向量维度**固定 64** + 取模循环取字节 |
| DEV-069 | 已修 | 换模型后旧向量不清 · `recall` 的 `if (!inStoreIds.has(m.id))` 在换后端时一条都不重嵌（记忆 id 没变）→ 库里留旧模型的向量，拿新模型的查询向量去比 → 结果是**错的**。更讽刺：`MemoryVectorStore` 那套「模型变化→清空重建」逻辑**永不触发**（它只在 upsert 时检查，而 upsert 被跳过）。现：`recall` 比对索引 `activeModel`，变了就 `reset()` 后全量重嵌 |
| DEV-070 | 已修 | 一条 NaN 毒死整个索引 · `upsert` 不检查向量合法性 → 一条 NaN 进库 → 所有余弦 NaN → 整个索引一条都召不回，且不报错。现：`upsert` 拒收含 NaN/Infinity 的向量 |
| DEV-071 | 已修 | 契约与实现不一致（一条存量 typecheck 错误）· `HermesAdapter.recall(query, opts: RecallOptions)` 的契约类型只有 `topK`/`minScore`，实现内部却读 `useVector`/`useKeyword` → 调用方传这两个字段时 TS 报「多余属性」，运行时靠强转又能读到。**类型说没有，运行时说有**。现签名放宽为 `AdapterRecallOptions`（继承 `RecallOptions`，向后兼容）→ **后端 typecheck 30 → 29** |
| DEV-072 | 已修 | provider→model 映射抄了两份 · `HermesAdapter.embeddingModel()` 另抄一份映射，与 `EmbeddingService.getActiveModel()` 各维护各的 → 分叉的后果是「配置说是真向量、实际走的是 stub」，且用户完全看不出来（召回只是变差，不会报错）。现单一真源在 `EmbeddingService.getActiveModelName()` |

### DEV-066 明细（配置入口，2026-10-28）

- **新增 4 个 IPC**（此前一个都没有）：
  - `hermes:embedding:get` —— 当前配置 + 生效模型 + **是否真向量**
  - `hermes:embedding:set` —— 保存配置（并清缓存：旧向量不可复用）
  - `hermes:embedding:detect` —— 探测本地 ollama：可达吗？装了哪些嵌入模型？
  - `hermes:embedding:test` —— 探测可达性 + **语义自检** + 维度 + 延迟
- **设置页 UI**（`Settings → 记忆`）：状态条（真向量=绿 / 伪向量=橙并明写「召回是噪声」）+ 后端选择 + 服务地址 + API Key + 模型下拉（本机已装的嵌入模型）+ 「检测本地模型」+「测试连接」
- **语义自检**：探测时同时嵌入「一对相近文本」与「一对无关文本」，比较两个余弦，差值 > 0.1 才算 `meaningful`。理由：「连上了」不等于「有用」—— 伪向量也连得上

### DEV-068~070 明细（三个因接线而暴露的洞，2026-10-28）

- 这三个洞在真后端**不可达**时一直藏着；一旦接通入口立刻变成生产事故
- DEV-068 的触发链：嵌入一次 bge-m3（dimension→1024）→ 切回伪向量 → 伪向量也 1024 维 → `hash2[991]` 越界 → 全 NaN → 余弦 NaN → `score >= minScore` 恒 false → **召回静默返回空**
- DEV-069 的连锁讽刺：`MemoryVectorStore` 里那套「模型变化→清空重建」的逻辑**永远不会触发** —— 它只在 `upsert` 时检查，而 `upsert` 恰恰因为 id 没变被跳过了
- DEV-070 是纵深防御：即便别处传进来 NaN，也不能让它进库

### 关单（W5 接线批 · M3-A 知识库真向量，2026-10-28）

- **范围**：DEV-066 ~ DEV-072（7 条）
- **验证**：
  - vue-tsc: 0 error
  - vitest: Test Files 113 passed (113) / Tests 1354 passed | 14 skipped (1368) / 0 FAIL
  - 后端 tsc（tsconfig.node.json）: **29 error**（= 修掉 1 条存量错误后的新基线）
- **A/B 对照（本地 ollama bge-m3，真跑）**：8 条记忆（1 相关 + 7 干扰）、6 条**改写**查询、只用向量召回、统计 top-1 命中
  - **真向量：6/6**（随机基线 1/8 = 12.5%）
  - **伪向量：0/6**
  - 余弦实测 `cos(查询,目标)=0.7753` vs `cos(查询,无关)=0.4049`
- **新增测试**：
  - `tests/unit/embedding-service-m3a.test.ts`（17 例）现代/老接口分流 · 批量一次请求 · 模型自动探测 · 只列嵌入模型 · 语义自检三态 · 换后端清缓存 · **伪向量维度固定 64** · **伪向量不含 NaN** · 确定性
  - `tests/integration/embedding-local-ollama.test.ts`（5 例）**打真的本地 ollama**：探测模型 · 余弦间隔 · 探测自检 · 改写召回排第一 · **A/B 命中率 6/6 vs 0/6**（ollama 不可用时跳过，不红 CI）
  - `tests/unit/memory-vector-persistence.test.ts`（+1 例）**V8：NaN/Infinity 向量拒收**
- **行为变更同步**：
  - `electron/preload.ts` 新增 `hermes.embedding.{get,set,detect,test}` + 4 个 channel 常量
  - `electron/core/IpcServer.ts` 新增 4 个 handler
  - `src/views/Settings.vue` 记忆页新增「嵌入后端」卡片
  - `src/locales/{zh-CN,en-US}.ts` 新增 23 个文案键

---

## W5 接线批偏差登记 · M3-B 混合检索（2026-10-28）

> 真向量接上后的检索质量硬伤,两条都**只在中文上暴露**。
> 编号自 DEV-073 起。完整设计见 `docs/NOVA-#009-m3b-hybrid-retrieval-design.md`。

| ID | 状态 | 摘要 |
|---|---|---|
| DEV-073 | 已修 | 中文根本没被分词 · `KeywordRetriever.tokenize` 按 `[\s\p{P}]+` 切,只切空格与标点 → 「用户习惯把桌面上的 PDF 文档统一归档」被切成 ["用户习惯把桌面上的", "pdf", "文档统一归档"],整句成词条 → 只有**字面完全一致**的长句才匹配得上,改写一个字就召不回。对国产中文桌面助手这是硬伤。现按 CJK 连续段切**字符 bigram**(无词典的标准做法),中英混排先分段 |
| DEV-074 | 已修 | 两把不同的尺子比大小 · `recall` 对关键词路(覆盖率 ∈[0,1])与向量路(余弦 ∈[-1,1])**取分数最大值** —— 量纲完全不同却直接比大小。后果:弱字面命中盖过语义高度相关的结果;单路出现的结果丢弃另一路的证据;**两路都命中的(最该排前面的)得不到任何加分**。现改为 RRF(只看名次, k=60):量纲无关 + 双路一致加成 + 无需分数归一化 |
| DEV-075 | 已修 | rerank 与 sqlite-vss 未做(登记为遗留) · 路线图 M3 写的是「bge-m3 + rerank」+ sqlite-vss。**本地 ollama 0.40.11 无 `/api/rerank`**(实测 404)→ rerank 需另接 cross-encoder 服务;sqlite-vss 需引入原生依赖(构建风险),而当前向量库上限 200 条,桌面应用够用 —— 是**规模问题不是正确性问题** |

### DEV-073 明细（中文分词，2026-10-28）

- **新分词规则**：CJK 连续段 → 字符 bigram(`文档统一归档` → `["文档","档统","统一","一归","归档"]`)；单字 CJK 段保留单字；拉丁/数字仍按词切 + 小写 + 停用词过滤
- **中英混排先分段**：`PDF文档` → `["pdf","文档"]`,不把整段当一个词条
- **实测(本地 ollama bge-m3,改写查询集 6 条,与目标无字面重叠)**：关键词路 top-1 命中 **旧 0/6 → 新 1~2/6**。旧分词器在中文改写查询上几乎完全失效
- **边界诚实**：bigram 只解决**字面重叠**,解决不了**同义**(「归档」↔「收纳」共享不到字对)—— 同义归向量那一路,两路互补

### DEV-074 明细（RRF 融合，2026-10-28）

- **新融合**：`score(d) = Σ over lists 1/(k + rank_list(d))`,k=60(SIGIR 2009 标准值)
- **实测(混合查询集 8 条)**：向量 7/8 · 关键词 旧 3/8 → 新 4/8 · 混合(取最大) 7/8 · 混合(RRF) 7/8
- **诚实结论**：分词是可测量的改善;**RRF 在命中率上与「取最大」持平**。RRF 的价值是结构性的(消除量纲错误 / 双路一致加成 / 无需分数归一化)—— 故测试断言**性质而非命中率**,把恰好持平的数字写成"命中率提升"是不诚实的
- **回归钉**：①分数放大 100 倍排序不变(量纲无关)②双路一致排在单路之前(**同一组数据下旧融合给出错答案**)

### 关单（W5 接线批 · M3-B 混合检索，2026-10-28）

- **范围**：DEV-073 ~ DEV-075（3 条）
- **验证**：
  - vue-tsc: 0 error
  - vitest: Test Files 114 passed (114) / Tests 1367 passed | 14 skipped (1381) / 0 FAIL
  - 后端 tsc（tsconfig.node.json）: 29 error（= 存量基线，零新增）
- **新增测试**：
  - `tests/unit/hybrid-retrieval-m3b.test.ts`（11 例）分词 6 例（含「改写查询命中 —— 旧分词器做不到，锁住 0 命中这个事实」）+ RRF 5 例（量纲无关 / 双路一致优先 / 单路不丢 / 空列表不炸 / 单调不增）
  - `tests/integration/embedding-local-ollama.test.ts`（+2 例，打真本地 ollama）「bigram 让关键词路在改写查询上重新有效」+「混合 RRF 不劣于纯向量路」

---

## W5 接线批偏差登记 · M3-C 进程沙箱（2026-10-29）

> 路线图 `docs/plan/v5-10week.md` M3 的后半：ProcessSandbox + 平台分支。
> 编号自 DEV-076 起。完整设计见 `docs/NOVA-#009-m3c-process-sandbox-design.md`。

| ID | 状态 | 摘要 |
|---|---|---|
| DEV-076 | 已修 | 命令超时/中止只杀直接子进程 → **孤儿进程堆积** · `execFile` 超时只杀直接子进程,它起的孙进程变成孤儿继续吃 CPU/占端口/握句柄。**实测(Windows)**:父进程被杀后,孙进程 PID 44896 仍在运行。典型后果:`npm install` 超时后 postinstall 子进程继续跑;脚本里 `start-server &` 的后台服务永久驻留 |
| DEV-077 | 已修 | 「用户点停止」只停了 LLM · `LlmAgentBrain.abortRun()` 调 `controller.abort()`,但那个 controller **只用于中止 LLM 流** —— 正在跑的命令完全感知不到,继续跑完(最长 60s),它起的孙进程继续跑(永久)。用户看到「停了」,机器上其实「还在跑」 |
| DEV-078 | 已修 | 进程隔离无平台分支 · 新增 `electron/sandbox/ProcessSandbox.ts`:POSIX 走**进程组**(`detached: true` + `kill(-pgid)`),Windows 走 **`taskkill /T /F`**(系统自带树杀,语义等价 Job Object 的 `KILL_ON_JOB_CLOSE`)。刻意**不用 Job Object**:需原生模块(N-API),与本项目 package.json **零原生依赖**的取向冲突 → 资源限额能力留作接口扩展位 |
| DEV-079 | 已修 | `trusted-dirs.test.ts` 的 child_process mock 只提供 execFile · 生产路径换成 spawn 后 → `spawn is not a function` → 该文件全红。已补 spawn 的假实现(记录探针 + 返回假 ChildProcess,next tick 以 code 0 触发 close)—— 这是「mock 面跟随生产调用形态」,不是绕过测试 |
| DEV-080 | 已修 | 执行器换了但审计口径要不变 · 换 ProcessSandbox 时保持:数组传参不走 shell(v3 #9) / 最小环境不继承 parent 敏感 env / 两段式审计(start 行 exec 前同步写,写失败即拒)/ finish 写失败**不改判命令结果**只标孤儿 + 真 console.error。新增:被杀时 finish 行记 `execError: killed:<原因>` |

### DEV-076~077 明细（孤儿进程 + 中止不落地，2026-10-29）

- **实测(Windows)**：`Start-Process node -ArgumentList '-e','setTimeout(()=>{},60000)'` 起的孙进程，在父进程被杀后 PID 44896 **依然存活**
- **新执行器语义**：
  | | execFile | ProcessSandbox |
  |---|---|---|
  | 超时/中止时 | 只杀直接子进程 | **杀整棵树** |
  | 异常 | 抛 | 返回结构化结果（调用方自己记账） |
  | 输出超限 | 抛错，输出全丢 | **截断并标注** |
  | 中止信号 | 不支持 | 支持 `AbortSignal` |
- **中止信号贯通链**：`brain.run 的 AbortController → toolCtx.signal(RuntimeToolContext 新增可选字段) → BashTool.execute → execCommand({signal}) → doExecFile → runInSandbox({signal})`。口径:signal 可选,不传=不可中止(旧行为),brain 必传

### DEV-078 明细（平台分支，2026-10-29）

- **平台原生对照**：Linux cgroup v2 / macOS 无(仅 rlimit) / Windows Job Object(`KILL_ON_JOB_CLOSE`) —— 三者 Node 都**不能直接用**
- **本批实现**：POSIX 进程组(`detached: true` 让子进程成为新会话组长 + `kill(-pgid)`)· Windows `taskkill /pid <pid> /T /F`(`/T` = 连同子进程)
- **不用 Job Object 的理由**：需原生模块 → electron-builder 打包要为 Electron ABI 重编译 → 跨平台构建链(w win/mac/linux/ohos)各自编译 → 与本项目**零原生依赖**取向冲突。资源限额能力留作接口扩展位

### 关单（W5 接线批 · M3-C 进程沙箱，2026-10-29）

- **范围**：DEV-076 ~ DEV-080（5 条）
- **验证**：
  - vue-tsc: 0 error
  - vitest: Test Files 115 passed (115) / Tests 1379 passed | 14 skipped (1393) / 0 FAIL
  - 后端 tsc（tsconfig.node.json）: 29 error（= 存量基线，零新增）
- **新增测试**：`tests/unit/process-sandbox-m3c.test.ts`（12 例）
  - 正常退出 / 非零退出 / stderr / 超时 / 中止 / 输出超限 / 命令不存在 / cwd / isolation 逃生口 / 平台默认分支
  - **【核心回归钉】超时 → 整棵树被杀（孙进程不残留）** —— 测法:被沙箱跑的命令**自己**起长跑孙进程并把 pid 打到 stdout,超时后验那个 pid 还在不在（不能另起进程树 —— 那样验的不是被沙箱命令的树）
  - **接线：BashTool 收到中止信号 → 命令被中止**（验信号一路传到执行层）
- **改动的存量测试**：`tests/unit/trusted-dirs.test.ts` 补 `node:child_process` 的 `spawn` 假实现（生产路径已从 execFile 换成 spawn）

---

## W5 接线批偏差登记 · M3-D 技能目录（2026-10-29）

> 本批不是按计划做的,是**全仓系统性审计扫出来的**。
> 编号自 DEV-081 起。完整设计见 `docs/NOVA-#009-m3d-skill-directories-design.md`。

| ID | 状态 | 摘要 |
|---|---|---|
| DEV-081 | 已修 | 6 个技能通道「只有一张嘴」 · preload 早就声明了 `skills:addCustomDir`/`removeCustomDir`/`getCustomDirs`/`getDirectoryPreview`/`getStorageInfo`/`remove`,但主进程**从无 handler**、渲染层**从无调用方**、`SkillLoader` **只有 userData/skills 一个目录** → 真调会得到 `No handler registered`。而 `preload` 是 contextBridge 暴露面 = 对外承诺的 API,承诺不存在的能力比不承诺更糟 |
| DEV-082 | 已修 | 用户项目里的技能目录完全看不到 · 技能来源此前只有一层(应用自己管的 userData/skills),缺 Anthropic 规范的「项目层」。现支持用户额外挂目录,目录里的技能照样被加载(主目录 > 额外目录,先到者为准 —— 技能 id 是 `load_skill` 唯一寻址键,必须全局唯一) |
| DEV-083 | 已修 | 删除技能没有路径守卫的风险面 · `removeSkill` 删的是**目录**,而技能 id 是用户/LLM 给的字符串 → 不能拼路径就删。现守卫:允许的根 = 主目录 ∪ 用户添加的额外目录;且 `path.dirname(target) === base`(防路径穿越);来源目录不在允许列表 → 一律拒 |
| DEV-084 | 已修 | 技能目录扫描是提示词注入面 · 技能正文会进 system prompt = 用户指定的目录可以往提示词里塞东西。故:只扫一级子目录(须含 SKILL.md/skill.md)·**符号链接默认不跟随**(`dirent.isDirectory()` 对软链返回 false,既防越界也防任意读取)· 额外目录必须用户显式添加 |

### DEV-081~084 明细（技能目录，2026-10-29）

- **审计方法**：全仓三类系统性扫描 —— ① IPC 三角（preload 声明 ↔ 主进程 handle ↔ 渲染层 invoke）② 配置键三角（`configStore.get` ↔ `configStore.set`）③ 能力可达性（有实现无调用方 / 有声明无实现）。结果：10 个通道声明了但全仓无 handler，其中 6 个是技能目录
- **新增能力**：`getExtraDirs`/`setExtraDirs`（持久化到 `skills.extraDirs`,与 `skills.states` 分开放:一个是「扫哪儿」,一个是「每个技能什么状态」）· `addExtraDir`/`removeExtraDir` · `previewDirectory`（预览,不加载）· `getStorageInfo`（目录不存在**如实标出**）· `removeSkill` · `SkillState.sourceDir`
- **UI**：`SkillsView.vue` 新增「技能目录」卡片 —— 主目录 / 额外目录列表 / 「添加技能目录」→ 系统目录选择器 → **预览**（先让用户看见里面有什么技能）→ 确认。预览这一步是有意的:目录里没技能时用户会以为功能坏了

### 关单（W5 接线批 · M3-D 技能目录，2026-10-29）

- **范围**：DEV-081 ~ DEV-084（4 条）
- **验证**：
  - vue-tsc: 0 error
  - vitest: Test Files 116 passed (116) / Tests 1391 passed | 14 skipped (1405) / 0 FAIL
  - 后端 tsc（tsconfig.node.json）: 29 error（= 存量基线，零新增）
- **新增测试**：`tests/unit/skill-directories-m3d.test.ts`（12 例）
  额外目录技能被加载 · 同名主目录优先 · 移除目录后不再加载 · 添加不存在的目录被拒 · 重复添加去重 · 预览列出技能 · 预览不存在目录不报错 · 存储信息如实报告 · 删除技能删对目录 · 删除不存在的技能报失败 · **删除的路径守卫（未登记目录一律拒）** · 目录已不存在时只清索引

---

## W5 接线批偏差登记 · M3-E 成本记账（2026-10-29）

> 继续「能力可达性」审计(第三类:有能力实现但零调用方)的结果。
> 编号自 DEV-085 起。完整设计见 `docs/NOVA-#009-m3e-cost-accounting-design.md`。

| ID | 状态 | 摘要 |
|---|---|---|
| DEV-085 | 已修 | 成本读出口是**硬编码 0 的 stub** · `insight:cost:today` 恒返回 `{totalCostUsd: 0, totalTokens: 0, stub: true}` —— 而 CostTracker 一直在真实记账。数据在、接口在,唯独读出来是**假的**。用户看到「今天花了 $0.0000」会以为没花钱,而钱已经花了 —— **假数据比没数据更危险**。且渲染层**从未调用**它(连假的都读不到) |
| DEV-086 | 已修 | 成本按**假模型名**归集 · ChatManager 记账时 `model` 恒为字面量 `'agent-loop'` → 全部混在一栏,「哪个模型花了多少钱」根本查不出来。现载荷带真实模型名(`llmModel`),brain 的 `run()` 返回 `opts.model ?? DEFAULT_MODEL` |
| DEV-087 | 已修 | 输入输出 token 混在一栏 · 记账时 `inputTokens` 塞的是 `totalTokens`、`outputTokens` 恒为 0。根因在更上游:**适配器本来就回传 `promptTokens`/`completionTokens`,但 brain 聚合 usage chunk 时只取 totalTokens 把分项丢了**。现一路带上:usage chunk → brain 聚合 → run() → think() 载荷 → 记账 |
| DEV-088 | 已修 | 定价查表必然落空 · 定价表按**基座名**建(`gpt-4o`/`ollama-llama3`),真实记录是**模型 id**(`qwen3.5:9b`)→ 精确查表落空 → 成本恒 0。现归一化查表(精确 → 去 provider 前缀与版本后缀 → 前缀命中 → 0 定价),并补本地模型条目 |

### DEV-085~088 明细（成本记账，2026-10-29）

- **审计结果**：`CostTracker.getTodayCost()` / `getUsageByConversation()` / `getRecentUsage()` 生产调用点均为 **0**
- **归因先于金额**：对本地模型用户(本项目主要形态)成本**本就该是 0 美元** —— 那是事实不是记账失败;真正有用的是 **token 数按模型的分布**(上下文预算)。故修法顺序:先修归因(模型名 + 分项),再谈金额
- **定价归一化规则**：精确命中 → 去 provider 前缀(`openai/`/`ollama-`)与版本后缀(`:9b`/`@latest`/`-2024-07-18`)后精确命中 → 前缀命中 → 0 定价
- **读出口**：`insight:cost:today` 换成 `CostTracker.getTodayCost()` + `getRecentUsage(20)`;`ModelCompare.vue`「使用量排行」页顶部新增「今日成本」卡片(今日费用 / 输入 token / 输出 token / 按模型分布)

### 关单（W5 接线批 · M3-E 成本记账，2026-10-29）

- **范围**：DEV-085 ~ DEV-088（4 条）
- **验证**：
  - vue-tsc: 0 error
  - vitest: Test Files 117 passed (117) / Tests 1398 passed | 14 skipped (1412) / 0 FAIL
  - 后端 tsc（tsconfig.node.json）: 29 error（= 存量基线，零新增）
- **新增测试**：`tests/unit/cost-tracking-m3e.test.ts`（7 例）
  brain 带回分项与真实模型名 · 载荷带 llmModel 与分项 · 按模型归集（不再混在 'agent-loop' 一栏）·
  按会话可查 · 今日汇总成本 > 0（不再是硬编码 0）· 定价归一化命中 ·
  **本地模型成本为 0 是事实、不是记账失败（且仍归到该模型名下）**

---

## W5 接线批偏差登记 · M3-F 构建修复（2026-10-30）

> 本批是**跑一次 build 才发现的**:应用此前根本打不出包。
> 编号自 DEV-089 起。完整设计见 `docs/NOVA-#009-m3f-build-repair-design.md`。

| ID | 状态 | 摘要 |
|---|---|---|
| DEV-089 | 已修 | **应用构建失败 —— 根本打不出包** · `npm run build` 报 `Could not resolve "../actor/ActorRegistry" from "electron/runtime/bridge/IpcBridge.ts"` → electron 主进程 bundle 解析不到 → 无产物、无法发布。根因:commit `7f6d988`「清理无用文件 141 个」删掉了 `runtime/actor/{Actor,ActorRegistry,index}` 与 `runtime/conversation/{State,Transition,index}`,而 `IpcBridge`/`Conversation`/`MessageQueue` **仍 import 它们**。`IpcBridge` 是**活的**(`main.ts:240` 调 `registerHandler()`) |
| DEV-090 | 已修 | 构建**不做类型检查** → 30 条类型错误(含 7 条断链)长期无人理会 · 构建只跑 `vite build`(esbuild,纯语法转译)。这类工具永远不会告诉你 import 断了。类型错误里藏着的正是「模块被删但 import 还在」这类**构建级**故障,而它**不报运行时错、不让任何单测变红** |
| DEV-091 | 已修 | 契约漏字段 4 处 · `SplashOptions.onFailed`(设计稿 F7 与类注释都写明这个回调,接口里**漏了字段** → 5 处调用点全是类型错误)· `ChannelMessage.from`/`.subject`(`IMMessageStore` 一直在用:按发送者过滤、按标题加权检索)→ 4 处类型错误 |
| DEV-092 | 已修 | 代码本身 18 处类型错误 · `SplashWindow` 的 `platform === 'test'`(TS 判永假)与 `webContents.on('mouse-down')`(**不是该 API**,改 `before-input-event` + `input.type === 'mouseDown'`);`main.ts` 的 per-contents `'crashed'` 与 app 级 `'render-process-gone'` **完全重复**(同一件事上报两次)已删;`WindowManager` 闭包里 TS 无法窄化 `this.mainWindow`;`LlmAgentBrain` throw 后 `spawnCtx` 被窄化成 `undefined` → `?.depth` 成 `never`(深度改在 throw 前取出);`ModelUsageTracker` 两代 schema 联合类型窄化;`PermissionConfig` 缺 `'upgrade-default'`(合法的第 6 个 reason);`ClawHubManager` 的 `publishedAt` 可能 undefined + 模板字面量缺 `createdAt` |
| DEV-093 | 已修 | 构建缺类型检查门禁 · `scripts/build.mjs` 新增第 1 步 `tsc --noEmit -p tsconfig.node.json`,不过直接 exit 1。失败时明确提示「typecheck 里的 Cannot find module 通常意味着有模块被删但 import 还在 —— 那会让 electron 主进程构建失败」 |
| DEV-094 | 已修 | 冒烟测试断言过期 · 原断言查 `dist-electron/tsconfig.node.tsbuildinfo` —— 那是「用 tsc 产 main.js」的年代留下的产物证明;构建早已改走 vite(tsc 不再 emit)→ **这条断言永远失败**。换成真正有意义的那道门:主进程类型检查必须通过 |
| DEV-095 | 已修 | 「删文件」与「改 import」的一致性无任何测试覆盖 · 新增 `tests/unit/import-integrity.test.ts`:全仓扫相对 import 验证能解析 + 不残留零字节空壳 + 不越出仓库根。扫描前剥掉注释(否则注释里提到的路径会被当真 import)、跳过模板目录(里面的 import 是要生成出去的代码文本) |

### DEV-089 明细（构建断链，2026-10-30）

- **恢复的模块**（原样恢复，不是重写）：`Actor.ts` / `ActorRegistry.ts` / `actor/index.ts`（来自 `ba269d0`）· `State.ts` / `Transition.ts` / `conversation/index.ts`（来自 `d432a0e`）
- **另修** `preload.ts` 的 voice import：原路径 `'../core/voice'` 指向**仓库根**（本文件在 `electron/` 下，正确是 `'./core/voice'`）；又因 `moduleResolution:'bundler'` 不解析目录索引，最终指向 `'./core/voice/index'`
- **为什么那 4 个模块值得恢复而不是连着 IpcBridge 一起删**：IpcBridge 是活的 —— 它把渲染进程的消息经 EventBus 派给已注册 actor，是 runtime 消息层的入口

### DEV-095 明细（死能力清理，2026-10-30）

| 删除 | 原因 |
|---|---|
| `SelfLearner.checkSkillMatch()` | 被 M4-A 的 `rankSkillsByRelevance`（单次 LLM 调用批量排序）取代，零调用方 |
| `SelfLearner.checkPatternThreshold()` | **恒返回 false** 的兼容壳 —— 调用方拿到的是**错答案**，不只是没答案 |
| `SelfLearner.generateSkillProposal(fingerprint)` | 忽略入参的兼容壳，返回的其实是 pendingProposal |
| `SkillManager` 整套 CRUD + 自有存储（232 → 41 行） | **第二个 phantom 技能存储**，零生产调用方；只留 `getSkillsDir()`（路径单点，3 个活调用方）。瘦身后的文件里明确标注「技能的真实存储在哪」 |

### 关单（W5 接线批 · M3-F 构建修复，2026-10-30）

- **范围**：DEV-089 ~ DEV-095（7 条）
- **验证**：
  - `npm run build`：**通过** → 产出 `release/PiPiClaw-4.5.0-alpha-Setup.exe`（97MB）+ `dist-electron/{main,preload}.js`
  - 后端 tsc（tsconfig.node.json）: **0 error**（= 修完 30 条存量）
  - `scripts/smoke-test.mjs`: 22 passed / 0 failed
  - vitest: Test Files 118 passed (118) / Tests 1401 passed | 14 skipped (1415) / 0 FAIL
  - vue-tsc: 0 error
- **新增测试**：`tests/unit/import-integrity.test.ts`（3 例）—— 相对 import 全部可解析 / 不残留零字节空壳 / 不越出仓库根

---

## W5 接线批偏差登记 · M4-G 架构收敛（2026-11-02）

> M3-F 恢复了被误删的模块，但它们仍是**没接入主线的平行架构**。本批收敛。
> 编号自 DEV-096 起。完整设计见 `docs/NOVA-#009-m4g-architecture-convergence-design.md`。

| ID | 状态 | 摘要 |
|---|---|---|
| DEV-096 | 已修 | `runtime/actor` + `runtime/conversation` 是**没接入主线的平行架构** · actor 模型来自 #005 时期,当前设计文档(NOVA #003~#009)从未提及它 → 从未注册过任何 actor,`IpcBridge` 里「查 registry → 投给 actor」那段**永远走不到**。`conversation` 6 状态机同样未接入,只被 `AgentBrain` 当**类型**挂着 |
| DEV-097 | 已修 | `AgentBrain` 挂着一个永不赋值的字段 · `setConversation` 零调用方 → `this.conversation` 恒为 null → `conversationId: this.conversation?.id ?? 'unknown'` **恒为 'unknown'**。现删掉字段与方法,直接写明常量(不再假装它会变) |
| DEV-098 | 已修 | 渲染进程类型检查不在构建门禁里 · M3-F 只给主进程加了门禁,`vue-tsc` 只在 `npm run typecheck` 单独跑、构建不碰 → 渲染层类型错误同样是「构建能过、运行时炸」。现构建 5 步:[主进程 typecheck / 渲染进程 typecheck / vite build / electron-builder / build-report] |
| DEV-099 | 已修 | 导入完整性护栏只扫 electron/ · **测试文件 import 已被删的模块**同样会让 vitest 整个文件 0 test(报「Failed to resolve import」,不是断言失败)—— 本批就撞上了(`MessageQueue.test.ts`)。护栏扩到 `tests/` |
| DEV-100 | 已修 | 护栏自身有个 bug(假警报) · 解析候选里没放**原样路径** → `import X from './X.vue'` 被拼成 `X.vue.vue` → 一片假警报。已把原样路径放进候选首位 |

### DEV-096 明细（平行架构收敛，2026-11-02）

| 删除 | 理由 |
|---|---|
| `electron/runtime/actor/{Actor,ActorRegistry,index,MessageQueue}` | 从未注册过任何 actor；`MessageQueue` 连 import 方都没有 |
| `electron/runtime/conversation/{Conversation,State,Transition,index}` | 6 状态机从未接入；只被当类型用 |
| `tests/unit/MessageQueue.test.ts` | 只测死代码（模块已删） |

- **IpcBridge 瘦身**：删掉「查 ActorRegistry → 投给 actor」那段（永远走不到），只留 EventBus 桥接 —— **行为一字不变**。`IpcBridgeMessage.from` 类型从 `ActorId` 改为 `string`（它本来接收任意来源标签）
- **为什么删而不是接上**：当前设计文档从未出现 actor 模型 —— 它不是规划中的架构，是个没有落点的实验。而 `SkillManager` 那次已经证明「平行架构」的代价：每次读代码都要先判断「哪个是真的」

### DEV-099~100 明细（护栏，2026-11-02）

- 护栏扫描范围扩到 `tests/`（测试文件 import 已被删的模块 → vitest 整个文件 0 test，崩法隐蔽）
- 修护栏自身的 `.vue` 扩展名拼接 bug（原样路径没进候选 → `X.vue.vue`）
- 零字节空壳检查也扩到 `tests/`

### 关单（W5 接线批 · M4-G 架构收敛，2026-11-02）

- **范围**：DEV-096 ~ DEV-100（5 条）
- **验证**：
  - vitest: Test Files 117 passed (117) / Tests 1393 passed | 14 skipped (1407) / 0 FAIL
  - 后端 tsc（tsconfig.node.json）: 0 error
  - vue-tsc: 0 error
  - `npm run build`: 通过（5 步，含两道类型检查门禁）并产出安装包
- **顺带删除**：`tests/unit/MessageQueue.test.ts`（只测已删的模块）
