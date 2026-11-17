# NOVA #009 — M4-Q e2e 进 CI 门禁（顺带挖出一条"一直在假通过"的 e2e）

> **状态**：已实现（2026-11-13）
> **对应台账**：DEV-159 ~ DEV-163
> **分支**：`feat/harness-wiring`
> **前置**：[M4-P MCP 运行时端到端](NOVA-#009-m4p-mcp-runtime-design.md)

## 一、为什么做这件事

上一批（M4-P）收尾时定的顺序：**先把「跑」变成「门禁」，再实跑剩余界面**。
理由很直接：前面几批挖到的 P0（Chat 整屏红屏 / 发送按钮被压 / 沙箱假成功）
**全都是"没人跑"造成的** —— 修了，但下一个同类 bug 还会来。

先量现状：CI 的 Playwright 步骤**只跑 4 个 spec 文件**
（chat-agent / settings-p7 / a5-computer-use / ui-smoke），
而这几批挖到的 P0 **全都不在那四个里**。

「跑」没有变成「门禁」。

## 二、做法

### 2.1 门禁改成跑全量

```yaml
- name: Playwright e2e - FULL suite (ubuntu only, hard-fail)
  run: |
    npx playwright install --with-deps chromium
    sudo apt-get update && sudo apt-get install -y xvfb
    node scripts/mock-llm-server.mjs 11434 &
    sleep 3
    xvfb-run -a env E2E_ELECTRON=1 npx playwright test --reporter=line
```

两个前置：

| 前置 | 为什么需要 |
|---|---|
| **xvfb** | Linux runner 没有 X server，Electron 起不来 |
| **mock LLM 顶在 11434** | 依赖 LLM 端点的 spec 用仓库自带的 mock，**不装 6GB 真模型**、不下载、且断言确定性 |

### 2.2 npm 脚本

| 脚本 | 是什么 |
|---|---|
| `test:e2e` | **原有**，浏览器侧 vitest + vite dev server（`scripts/test-e2e.mjs`）—— 本批**没动它** |
| `test:e2e:electron` | **新增**，Playwright + Electron 全量套件 |
| `test:all` | **新增**，vitest → build → electron e2e 一条龙 |

> 一度把 `test:e2e` 覆盖成了 Electron 套件 —— 发现后已还原。
> 两套东西名字太像，容易误用，另起名字而不是覆盖。

## 三、过程中的发现：一条**一直在假通过**的 e2e

要先把 e2e 变成门禁，就得先确认这些用例**真的在跑东西**。于是拿 mock LLM 做了一次端到端核对 ——
**结果助手气泡里是空的**（只有时间戳）。

### 3.1 三处叠在一起（DEV-160 ~ DEV-162）

```
sendMessage(convId, msg, providerId, modelId)
   │
   ├─ ① 会话上要有 providerId     ← 原实现只写进"用户消息",会话上没有   ★ 产品缺陷
   │
   ├─ ② dispatchToAgent 读会话上的 providerId → 映射成内联配置(M4-L 加的通道)
   │
   └─ ③ mock 要回 SSE              ← 原实现只回普通 JSON                  ★ 测试件缺陷
                                     → 适配器只认 data: 行 → 内容一行都进不来
```

**三处任缺其一，助手回复就是空的（或一句报错），而「消息条数 > 0」的断言照样通过** ——
因为**用户消息就够数**。

### 3.2 ① 是真的产品缺陷（DEV-160）

`sendMessage` 收了 `providerId` 却只写进「用户消息」里，**从不写回会话**；
而 agent 路径读的是**会话上的** providerId。于是：

- **经 IPC 发消息的调用方**（IM 通道 / 定时任务 / 语音 / 任何外部调用）→ agent 永远拿不到 provider
  → 每条消息报「no LLM provider configured」→ 回落旧管道
  → **学习闭环（M4-B / M4-F）记到的全是这种失败**
- UI 路径没暴露这个问题，是因为**模型选择器自己调了 `store.setCurrentModel`**（它会 updateConversation）
  —— 两条路径不一致。

修：`sendMessage` 把传入的 provider/model 落到会话上。

### 3.3 ③ 是测试件的缺陷（DEV-161）

适配器的 `streamChat` **只解析 `data:` 行**；mock 只回普通 JSON → 即使 provider 接通了，
**内容也一行都进不来**。修：mock 支持 `stream:true` 时回 SSE（分块 + `[DONE]`）。

### 3.4 断言本身太松（DEV-162）

`chat-long-conversation` 的 L3 断「message 元素 > 0」→ 助手回复全是报错也算过。
修：改为断言**助手气泡里出现 mock 的真回复标记**，且**不得**出现 provider 未配置的报错。

### 3.5 还有一处平台隐患（DEV-163）

mock 只绑 `127.0.0.1`，而 spec 写的是 `localhost` —— Linux 上 `localhost`
可能按 RFC 6724 优先解析到 `::1` → 连不上。修：统一用 `127.0.0.1`。

## 四、验证

| 项 | 结果 |
|---|---|
| 新增 e2e `tests/e2e/mock-llm.spec.ts` | app 必须把 mock 回复**真的显示出来**，且不得出现 provider 未配置的报错 |
| `chat-long-conversation` L3 | 改为断**内容**（mock 真回复标记） |
| 实测助手气泡内容 | `MOCK_LLM_OK_1_WITH_INPUT: 收到 "你好"` ✓ |
| 既有 e2e 套件 | 见关单 |
| vitest / 双 typecheck / build 门禁 | 见关单 |

## 五、遗留与后续

| # | 遗留 | 归属 | 说明 |
|---|---|---|---|
| 1 | **首次 CI 跑可能因 Linux 环境差异红** | 需实跑 | 本机是 Windows，Linux runner 的差异（路径、字体、Electron 版本）没法本地验。门禁第一次跑会暴露真问题 —— 那正是门禁的意义 |
| 2 | e2e 只在 ubuntu 上跑 | 已知 | Windows/macOS 也跑会让 CI 时间 ×3。平台差异由人工发版前验 |
| 3 | 「实跑剩余界面」（Skills/Models/IM/Schedule/Settings 展开态） | 下一批 | 本批先把门禁建起来 |
