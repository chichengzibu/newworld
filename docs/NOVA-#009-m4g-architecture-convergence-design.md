# NOVA #009 — M4-G 架构收敛（删掉没接入主线的平行架构）

> **状态**：已实现（2026-11-02）
> **对应台账**：DEV-096 ~ DEV-100
> **分支**：`feat/harness-wiring`
> **前置**：[M3-F 构建修复](NOVA-#009-m3f-build-repair-design.md)

## 一、为什么做这件事

### 1.1 M3-F 的遗留：恢复了模块，但它们仍然是死的

M3-F 为了修构建，把被误删的 6 个模块原样恢复了。但恢复只是**止血**：
那套 `runtime/actor` + `runtime/conversation` 是 #005 时期的一套**平行架构**，
从未接入当前主线（agent loop + skills + learning loop + memory）。

于是仓库里同时存在两套东西：

| 体系 | 状态 |
|---|---|
| `LlmAgentBrain`（真实 tool loop） | **主线**,`main.ts` 注册它 |
| `AgentBrainImpl`（W5.2.2 脚手架 stub） | 活 —— 但只是**兜底**（真实 brain 注册失败时用） |
| `runtime/actor/*`（Actor / ActorRegistry） | 死 —— **没有任何 actor 注册过** |
| `runtime/conversation/*`（6 状态机） | 死 —— 只被当**类型**用,字段从未赋值 |
| `runtime/skill/SkillRuntime` | 与 `SkillLoader` 并行的另一套技能运行时 |

### 1.2 「平行架构」比「缺功能」更难查

`SkillManager` 那次（见 M3-F）已经暴露过这个模式：一个自洽、看起来能用的
第二套实现，会让后来者往 phantom 存储里写数据，写完发现没有任何东西读它。

actor 模型同理 —— `IpcBridge` 里有一段「查 ActorRegistry → 把消息投给 actor」
的代码，看起来是核心能力，实际上**永远走不到**（没 actor 注册）。

而且它有真实成本：`Conversation` 状态机被 `AgentBrain` 当类型挂着，
而那个字段 `setConversation` 从没被调用过 → 恒为 `null` →
`conversationId: this.conversation?.id ?? 'unknown'` **恒为 `'unknown'`**。

## 二、设计依据

### 2.1 「没接入主线的架构」要么接上，要么删掉

留着两套并行的东西，代价是持续的：每个读代码的人都要先判断「哪个是真的」，
而错误的判断会导向写进 phantom 存储。

本批的选择是**删**：当前的设计文档（NOVA #003 ~ #009）里**从未出现 actor 模型**——
它不是规划中的架构，是个没有落点的实验。

### 2.2 保留 IpcBridge 真正的能力

`IpcBridge` **是活的**（`main.ts` 启动即 `registerHandler()`），
它真正的职责是「渲染进程 → EventBus」的消息桥接。删掉 actor 派发那段，
它的行为**一字不变**（因为那段永远走不到）。

## 三、实现

### 3.1 删除平行架构

| 删除 | 理由 |
|---|---|
| `electron/runtime/actor/{Actor,ActorRegistry,index,MessageQueue}` | 从未注册过任何 actor；`MessageQueue` 连 import 方都没有 |
| `electron/runtime/conversation/{Conversation,State,Transition,index}` | 6 状态机从未接入；只被当类型用 |
| `tests/unit/MessageQueue.test.ts` | 只测死代码（模块已删） |

### 3.2 IpcBridge 瘦身为纯 EventBus 桥接

```ts
// 改前:查 registry → 投给 actor(永远走不到)
// 改后:
await this.bus.publish(`ipc:${msg.type}`, msg.payload, msg.from)
```

行为不变（那段分支本就不可达），但代码不再**假装**有能力。

`IpcBridgeMessage.from` 的类型从 `ActorId` 改为 `string` —— 它本来接收的是
任意来源标签（会话 id / actor id），绑死 actor 类型反而是历史包袱。

### 3.3 AgentBrain 去掉永不赋值的字段

```ts
// 改前:conversationId: this.conversation?.id ?? 'unknown'   ← 恒为 'unknown'
// 改后:conversationId: 'unknown'                             ← 直接写明
```

并删掉 `setConversation` / `getConversation`（零调用方）与那个 import。

### 3.4 渲染进程类型检查也进构建门禁

M3-F 只给主进程加了门禁，渲染层还是裸的 —— `vue-tsc` 只在 `npm run typecheck`
里单独跑，构建不碰它。而渲染层的类型错误同样是「构建能过、运行时炸」。

现构建有 **5 步**：

```
[1/5] typecheck (主进程)    ← 不过直接中止
[2/5] typecheck (渲染进程)  ← 不过直接中止
[3/5] vite build
[4/5] electron-builder
[5/5] build-report
```

### 3.5 导入完整性护栏扩展到 tests/，并修了自己的一个 bug

M3-F 的护栏只扫 `electron/`。本批发现：**测试文件 import 已被删的模块**，
会让 vitest 整个文件 0 test（报「Failed to resolve import」，不是断言失败）——
本批就撞上了（`MessageQueue.test.ts`）。故护栏扩到 `tests/`。

同时修了护栏自己的一个 bug：解析候选里没放**原样路径**，
导致 `import X from './X.vue'` 被拼成 `X.vue.vue` → 假警报一片。

## 四、验证

| 项 | 之前 | 现在 |
|---|---|---|
| vitest | 118 files（1 个文件崩在 import） | **117 files / 1393 passed / 0 FAIL** |
| 后端 typecheck | 0 error | **0 error** |
| `npm run build` | 通过（1 道门禁） | **通过（2 道门禁）** |
| 死代码 | actor / conversation / SkillManager 三套并存 | 收敛为一套 |

## 五、遗留与后续

| # | 遗留 | 归属 | 说明 |
|---|---|---|---|
| 1 | **`AgentBrainImpl` 仍是脚手架 stub** | 后续 | 它是 `main.ts` 的兜底（真实 brain 注册失败时用）。stub 的 `think` 返回固定文本 → 真实 LLM 出问题时，用户会收到一个假答复而不知情。值得加一条「当前用的是兜底 stub」的提示 |
| 2 | **`runtime/skill/SkillRuntime` 仍在** | 后续 | 与 `SkillLoader` 并行的技能运行时。本批未动 —— 需先确认它是否被 SkillRuntime 的权限检查用到 |
| 3 | **`checkpoint` 的 conversationId 恒为 'unknown'** | 遗留澄清 | M1-D 的 checkpoint 事件按 runId 关联会话，不靠这个字段 → 无实际影响。已就地写明，不再假装它会变 |
| 4 | **M4-E 受控对照** | 后续 | 技能效用的受控 A/B（需一个可验证的成功信号） |

## 六、参考资料

- 「两套并行的实现」的成本：每次读代码都要先判断「哪个是真的」，
  判断错的代价是写进 phantom 存储（`SkillManager` 事件）
