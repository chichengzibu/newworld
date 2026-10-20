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
  4. **自证不算证**：凡令“全量粘贴”，原文必须出现在回贴正文；　落盘核验 / 摘要 / 自行判定一律无效。
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


- **遗留（非本单范围）**：真 DDG 端点（`lite.duckduckgo.com/lite/` / `html.duckduckgo.com/html/`）在本机实测 9–18s 双端点 `TimeoutError`（网络不可达），搜索真链路未取得真结果；按 #004-B d 项"网络不可达如实 skip 证据"口径上报，非伪造成功态。


> **注**：`DEV-015` 空隖，保留为未来批次预留（终身不复用规则：已分配的 ID 即使删除也不回收）。