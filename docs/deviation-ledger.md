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

---

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

> **注**：`DEV-015` 空缺，保留为未来批次预留（终身不复用规则：已分配的 ID 即使删除也不回收）。
