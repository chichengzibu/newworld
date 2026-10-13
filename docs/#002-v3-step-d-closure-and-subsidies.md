# #002-v3 · Step D 收尾令落实 + 报告补遗

**落库基线**: `850a445`（docs）→ `f863019`（feat security, 7 文件）→ `2b2fca0`（feat ui, 3 文件）→ `20c967b`(test security, 3 文件)。
**提交 3 笔均 porcelain 归空, 禁一把梭 (合规)**。

---

## #1 偏差 — 生产 chat LLM 参与 (修正上一报告, 以实读为准)

### #1.1 精确判读 (file:line 实证)

**上一份报告**（我上一轮交付）说"AgentBrainImpl 是 stub，生产 brain 是 stub"——**这个措辞不准, 现更正**。
实读 (main.ts L200–222, LlmAgentBrain.ts L306–318, ChatManager L238–282):

| 路径 | 生产真链 (实证) |
|---|---|
| 注册 | `main.ts:207` 先注册 AgentBrainImpl → `main.ts:217` (try) **覆盖注册 LlmAgentBrain** (活代码非注释) |
| chat 主路径 | `IpcServer.chat:message:send` (L772) → `ChatManager.sendMessage` (L160) → **L238 真调 LLM** (`InstructionGenerator.generateTaskSteps` L171–178 `fetch /api/chat`+ `Bearer apiKey` 真实装) → 返回 task steps → `TaskExecutor.executeTask` → **TaskExecutor L183–191 `run_command` → gateway.executeOperation (L376) → runCommand (已改, 调 execCommand)** |
| brain 工具循环 | `LlmAgentBrain.think (L306)` → `run (L135)` → L219 `tool.execute` → **BashTool.execute (已改, 调 execCommand, 读 `getCommandContext()` 默认 headless)**。**但 `dispatchToAgent` (唯一入口) 在生产零调用者** (grep 空, 见 L3.3 证据) |

### #1.2 明确回答: "生产 chat 现在有没有任何 LLM 参与"

**答: 有, 但走的是 ChatManager → InstructionGenerator → TaskExecutor 路径, 不是 brain 工具循环路径。**

- **纯聊文本** (e.g.: "帮我总结一下"): `sendMessage` 走 `generateTaskSteps` 的 LLM 分支, **真 LLM 参与**(fetch /api/chat, LlmAgent 的 text 生成), 但结果只回填 chat 文本, **不触发命令执行**。
- **任务执行** (e.g.: "帮我运行 git status"): `sendMessage` → `generateTaskSteps`(LLM 把意图转 task steps) → **`TaskExecutor.executeTask → run_command → gateway.runCommand → execCommand`(咽喉, 已改)**。**这条是真 LLM 参与命令执行的路径**, 但 **TaskExecutor L188 只透传 `{command, cwd}` 不带 contextKind** → execCommand 收到 `contextKind: headless`(默认) → **confirm 级命令被 fail-safe 拒绝**。
- **brain 工具循环** (`LlmAgentBrain.run`): **生产零调用者** (见 L3.3), 不触发。

**结论**: 生产 chat 现在有真 LLM 参与, 但**命令执行路径** (TaskExecutor → runCommand) 上 contextKind 默认 headless → confirm 级 (git/node/curl 等) **全部 fail-safe 拒绝**, **只有 AUTO 级 (ls/cat/echo 等) 能真跑**。这是**安全 fail-safe 姿态**, 不是 bug——但**用户无法在 chat 里触发任何 confirm 级命令** (W5 接线时改)。

### #1.3 生产 brain (LlmAgentBrain) 挂在哪里

`LlmAgentBrain` 在 `ChatManager.registeredAgent` 里 (L945), 唯一入口是 `dispatchToAgent (L969)`——**grep 证实生产零调用者** (见 L3.3 证据)。
**含义**: brain 是活的 (LlmAgentBrain 类, 真 LLM + 真 tool 循环), 但**没从 chat 被触发**, 是"挂起来但没人按"。
**W5 接线任务**: 接通 `IpcServer.chat:agent-think` (或 `TaskExecutor` → `brain.think`) 的真入口, 把 chat 消息路由到 brain.think 路径。

### #1.4 loud-stub 最小 diff 提案 (只 diff 不实施)

**目标**: W5 接线时, 如果 `AgentBrainImpl` stub 被意外触发 (注册链错位), console.warn 提示。
**最小化**: 只加 warn, 不改 stub 逻辑。

```diff
--- a/electron/agent/AgentBrain.ts
+++ b/electron/agent/AgentBrain.ts
@@ [L75]
   async think(ctx: AgentContext): Promise<Decision> {
+    // [loud-stub PROOF] 此 think 是 stub, 生产 chat 不应触发 (LlmAgentBrain 才是真 brain).
+    // 若此 warn 在日志里出现, 说明 main.ts:207 的 AgentBrainImpl 注册没被 L217 LlmAgentBrain 覆盖 (接线错位).
+    this.log.warn(`[AgentBrainImpl.stub] think 被触发 (userMessage="${(ctx as {content?:string}).content?.slice(0,40)}"), 检查 main.ts 注册链 L207→L217`);
     const startMs = Date.now()
...
@@ [L123]
   async call(tool: ToolCall): Promise<ToolResult> {
+    // [loud-stub PROOF] 同上: call 被触发说明 stub 在跑, 不是 LlmAgentBrain.
+    this.log.warn(`[AgentBrainImpl.stub] call 被触发 (tool="${tool.name}"), 检查生产注册链`);
     const span = this.trace.startSpan({ name: 'agent.call', attrs: { toolName: tool.name } })
```

**理由**: 最小 (2 行 warn), 不破坏现有测试 (AgentBrainImpl 的 unit test 会打 warn 但不断言 log 内容 → 不受影响)。

---

## #2 设计债登记 (不阻塞 W5)

### #2.1 commandDecide 模块态 setCommandContext 异步并发互染

**问题**: `setCommandContext` 是模块级 `let _ctx`, 两个会话并发 `dispatchToAgent` 时, 一个会话设 `ctx='ui'` 然后 await, 另一个会话设 `ctx='scheduler'`, 第一个 resume 后读到的可能是 `'scheduler'` → **context 串线**。

**当前影响**: 小——生产 `dispatchToAgent` 零调用者, 脑链路还没真跑。W5 接线后如果并发 dispatch, 立即显现。

**W5 接线前**必改方案 (二选一):
1. **参数传递** (推荐): `execCommand(args, ctx)` 把 contextKind 改回**必填参数** (不再读模块态), Brain 链路每次 tool.execute 前显式传 ctx (闭包捕获)。
2. **AsyncLocalStorage** (Node 原生, 适合 Electron main 进程): `als.run(ctx, async () => { ... })` 隔离调用栈。

**本批动作**: 不修 (保持模块态), 只在文档登记, 避免 W5 接线时踩坑。

---

## #3 冒烟 (S2 改 2026-10-12: Playwright Electron 自动化轨, 签名人 = 自动化证据)

**裁决变更**: 用户解除人工点击要求, **「弹窗人工冒烟(待用户亲手)」改为「自动化冒烟(Playwright Electron)」**。
签名证据源 = `tests/e2e/confirm-dialog.smoke.spec.ts` (真 app 启动 + 真 DOM 点按钮 + 审计字段断言, 零生产代码改动)。

**运行配方 (S2 要求写进 docs)**:
```bash
npm run build                        # 前置: dist-electron/main.js 必须已产出
E2E_ELECTRON=1 PLAYWRIGHT_BROWSERS_PATH=0 npx playwright test tests/e2e/confirm-dialog.smoke.spec.ts --workers=1
```
> `E2E_ELECTRON=1` 才启动 Electron (不设时 2 skipped, CI 防御, 与其余 6 spec 同配方);
> `PLAYWRIGHT_BROWSERS_PATH=0` 钉死项目本地浏览器;
> 审计落 fresh temp userData (`<tmp>/pipiclaw-p0-confirm-dialog-*/audit/openclaw.audit.jsonl`), 不涉生产 %APPDATA% 路径。

**S1-allow / S2-deny 签名 (都绑本次调用: 行数差 + 字段解析, 禁只验"文件变长")**:
- S1-allow: 真点击「允许」→ `res.success===true` (`git --version` 真跑出 `git version 2.55.0.windows.2`); 审计**恰新增 2 行** (start `humanConfirm='true'` `confirmChannel='ui'` / finish `exit=0`, 同 opId)
- S2-deny: 真点击「拒绝」→ `res.data.errorCode==='PERMISSION_DENIED'`; 审计**恰新增 1 行** (`phase='deny'` `humanConfirm='false'` `confirmChannel='ui-reject/timeout'`)
- 两例 serial 同文件顺序写, 禁并行

> 命令选择注 (S1 用 `git --version` 而非 `git status`): exec 的 cwd 固定为 `<userData>/sandbox` (commandDecide.ts:256 实读), 该目录非 git repo, `git status` 必 fatal — 链路与审计均真跑通, 仅命令退出码非 0。属既有 sandbox 行为, 非本单引入, 未改生产码。

**devtools 手工复核参考路径** (保留供人工复核, 不再是签名路径; `electron/preload.ts:L937` 证据不变):
> **补丁批 commit A 后**: `contextKind` 改由 `main` 进程按入口身份派生(渲染端 IPC → `ui`),
> 渲染端 **不再也不能** 传 `params.contextKind` (gateway 忽略它, 防外部自放行)。
> 脚本相应改: 去掉 `contextKind` 字段, 直接走 `openclaw:execute` IPC 即可触发 `ui` 派生。

```javascript
// 冒烟: 验证 v3 confirm 弹窗全链 (commit A 后: 渲染端入口自动派生 ui)
// openclaw:execute IPC 由 IpcServer 硬编码 source='ui' → 渲染端弹 CommandConfirmDialog (30s 超时拒)
// 用户在弹窗里按 "允许" → 命令执行 → 审计 humanConfirm='true'
const res = await window.electronAPI.openclaw.execute({
  operationType: 'run_command',
  params: {
    command: 'git',
    args: ['status']
    // 注意: 不再传 contextKind — 由 main 进程 (IpcServer 'ui' 派生) 决定
  }
});
console.log('[冒烟结果]', res);
```

> **攻击自测 (可选)**: 同一段把 `command:'git'` 换成外部 HTTP 触发 (`localhost:18789/execute`) 且 params 塞 `contextKind:'ui'` →
> gateway 读不到 `ui` (source='headless') → confirm 级拒 → 冒烟攻击面关闭。已由 `tests/unit/gateway-source-injection.test.ts` 覆盖。

**冒烟通过标准 (S2 改: 自动化证据)**:
- ✅ spec **2 passed** (真回路全程: 真 app 起 → 弹窗真出现 → 真点击按钮 → IPC 真实返回, 无 DI stub)
- ✅ 审计断言绑定本次调用 (行数差 = 2 / 1 + 字段解析), 非"文件变长"
- ✅ 报告标注**签名人 = 自动化证据**, 禁出现"用户已验证"表述

~~**冒烟后动作**: 我读 `%APPDATA%/PiPiClaw/audit/openclaw.audit.jsonl` 末 2 行贴出来 + 用户口头确认 "冒烟过"。~~
(2026-10-12 作废 — S2 裁决改自动化签; 上列手工动作仅留作复核参考路径时的操作提示)

---

## #4 审计样例路径确认 (回应 #6)

**实读证据** (test-host.ts L37–39):
```typescript
export const TEST_USER_DATA = pathNode.join(
  os.tmpdir(),                              // Windows: C:\Users\Administrator\AppData\Local\Temp
  `pipiclaw-test-userdata-${process.pid}`,  // 按 worker pid 隔离
)
```
- 测试 audit 样例文件物理路径 = **`<os.tmpdir()>/pipiclaw-test-userdata-<pid>/audit/openclaw.audit.jsonl`** (Windows 是 `%LOCALAPPDATA%\Temp\pipiclaw-test-userdata-<pid>\...`)
- **不在 %APPDATA% (生产路径)** → 测试隔离生效, **非违规**
- 实跑验证: 我在测试环境里 `ls "$APPDATA/PiPiClaw/audit/openclaw.audit.jsonl"` → **"OK: %APPDATA% 无审计文件"** (上一轮终端输出已确认)
- **冒烟** 时才落 %APPDATA% (因为那是真 app 跑), 符合预期

---

## #5 偏差清单 (本批新增 #13)

**继承上批** (已备案, 不重复): #8 P1/P3 stub+ui 禁降级 / #9 finish warn 真代码

**本批新增**:
- **#13 (安全红线, W5 修)**: `OpenClawGateway.runCommand` 从 `params.contextKind` 读来源标记, 但 `params` 可由任何调用方 (外部 HTTP / 渲染 IPC / TaskExecutor) 设置 → **外部 HTTP 调用能自我放行 confirm 级命令**, 违背 "入口硬编码" 红线。**W5 接线时改**: IpcServer.openclaw → 注入 `'ui'` (renderer 侧), HTTP → 注入 `'headless'` (不可信), TaskExecutor → 注入 `'scheduler'`, 不再从 params 读
- **#14 (设计债, 不阻塞)**: `commandDecide.setCommandContext` 模块态, 异步并发 dispatch 时 context 串线。**W5 接线前**改参数传递 / AsyncLocalStorage (见 #2.1)

---

## #6 全电池 (本批交付, 数字全部实跑口径)

| 步骤 | 结果 | 口径 |
|---|---|---|
| npm test | **75 文件 / 969 过 / 8 skip / 0 失败** | `Test Files 75 passed`, `Tests 969 passed \| 8 skipped (977)` |
| vue-tsc | **0 错零新增** | `npx vue-tsc --noEmit` exit=0 |
| npm run build | 通过 | electron-vite 编译完成 |
| 渲染轨 e2e | **11/11** | `npm run test:e2e` (vitest e2e) |
| 注入三连 | **3/3** (PERMISSION_DENIED, PermissionManager 层) | Playwright spec |
| 审计样例 | 5 行全合法 JSON | audit-smoke.test.ts (test 环境, temp 路径) |
| porcelain | **纯空** (3 笔后) | `git status --porcelain` 无输出 |

**基线 → 终版**: Step A 基线 73 文件/930 过 → Step D 75 文件/969 过 (+2 文件 +39 用例, 数字全实测)。

---

## #7 提交链 (hash 从 git log 复制, 不凭记忆)

```
20c967b (HEAD) test(security):  T1-T12 + P1-P3 重写 + 审计样例 (3 files)
2b2fca0          feat(ui):       CommandConfirmDialog + App.vue + preload (3 files)
f863019          feat(security):  constants + commandDecide + 双咽喉 + DI + audit sink (7 files)
850a445          docs(#002-v3):  两处裁定升级备案 (上一轮基线)
```

---

## #8 冒烟待办 (留给用户亲手, 我**不代签**)

**待用户行动**:
1. 开 Hermes 桌面, chat 里按 F12 开 devtools
2. console 里贴 #3 的冒烟 script (git status)
3. 弹窗出现后**亲手按 "允许"**
4. 确认 res.success=true + 审计文件 (我可以帮你读)
5. 告诉 我 "冒烟过"
6. 我通知 GLM 复跑

**GLM 复跑范围** (7 触发器 + 2 新检查):
- 75/969 全绿
- vue-tsc 0
- 渲染轨 11/11
- 注入三连 3/3 (PERMISSION_DENIED)
- 审计样例 5 行合法
- 偏差 #13 (安全红线) 备案正确
- 偏差 #14 (设计债) 备案正确
- **冒烟** (用户亲手, 不在 GLM 范围)

GLM 全绿 + 用户亲手冒烟 → 正式收官。
