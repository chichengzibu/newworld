# NOVA #009 — M4-L e2e 套件对齐（途中挖出两个 P0）

> **状态**：已实现（2026-11-11）
> **对应台账**：DEV-144 ~ DEV-148
> **分支**：`feat/harness-wiring`
> **前置**：[M4-K 真机验证清单自动化](NOVA-#009-m4k-verification-automation-design.md)

## 一、为什么做这件事

M4-K 修好 e2e 的 userData 隔离后，**51 个既有 e2e 用例从「被脏数据掩盖」变成「显式暴露」**。
本批把它们逐条对齐到当前 UI —— 过程中挖出**两个 P0 产品缺陷**（一个是发送按钮被压住，
一个是 agent 路径拿不到用户配的 provider）。

## 二、51 个失败怎么归类

| 类别 | 用例数 | 典型症状 | 修法 |
|---|---|---|---|
| 侧栏选择器过期 | ~30 | `locator('a.nav-item')` 找到 0 个 | v4.4 把侧栏改成 icon-only rail → 改 `nav.sidenav a.nav-icon[href$="#/xxx"]` |
| 老 spec 依赖脏 profile | ~8 | 找不到历史会话 / 模型选择器 disabled | 自己造：mock LLM 起服务、注入 provider、建会话、发消息 |
| 断言已不存在的元素 | ~8 | 状态栏 / 标题栏主题按钮 / 侧栏语言 combobox / 侧栏 ClawHub 入口 | 改成当前真实入口（设置页 radio 组 / 直接走路由） |
| 产品缺陷 | 3 | 见下 | 改产品 |

### 2.1 不逐个 spec 手改选择器 —— 抽共享 helper

15 个 spec 各写一份侧栏选择器、各错一次，是这次 51 个失败的一半来源。
故在 `tests/e2e/helpers/electron-app.ts` 加 5 个 helper：

| helper | 用途 |
|---|---|
| `gotoBySideNav(window, path)` | 按 href 走侧栏 |
| `gotoRoute(window, path)` | 直接跳路由（**侧栏没有入口**的页面，如 `/clawhub`） |
| `addProviderAndReload(window, provider)` | 注入 provider **并刷新页面** |
| `createConversationViaUi(window)` | 走 UI「新建」建会话 |
| `selectProviderAndModel(window, p, m)` | 选 provider + model，**并验证选中生效** |

`addProviderAndReload` 的「刷新」不是多余的：`Chat.vue` 只在 `onMounted` 调
`modelsStore.fetchProviders()`，IPC 塞进去的 provider 不会推给渲染层 →
模型选择器一直是 disabled → 点击等到超时（报错却是 "browser has been closed"，
那是超时被中断的后果，不是根因）。

### 2.2 顺带收紧两处「假通过」

- `network-failure` NW4：旧断言 `deleted >= 2` —— 只删掉 1 个时**也会过** → 改成 `=== 2`
- `ui-smoke` 侧栏：旧断言「有 14 个 nav-item」→ 改成**逐个入口断存在 + 断 aria-label 非空**
  （后者正是 M4-G 实跑抓到的真实缺陷：图标画得出、但没文案）

---

## 三、挖出来的两个 P0

### 3.1 悬浮命令按钮压住「发送」按钮（DEV-144）

**实测几何**（1280×800）：

| 元素 | x | y |
|---|---|---|
| 悬浮命令按钮 `.floating-cmd-btn` | 1132~1256 | 732~776 |
| 「发送」按钮 `.send-btn` | 1176~1256 | 724~784 |

两者**完全重叠**；`document.elementFromPoint(发送按钮中心)` 返回 `KBD`
（悬浮按钮里的 `⌘K`）。**用户点发送，点到的是命令按钮。**

- **为什么没被发现**：e2e 里点发送一直被 Playwright 判成 "intercepts pointer events"，
  报错写着「点击超时」—— 读起来像选择器问题，实际是产品缺陷。
- **修法**：Chat 路由下把悬浮按钮抬到输入区之上（`bottom:140px`）。
  不用「输入区让位」（padding-right）：那会在输入框右侧留一条 140px 的空档。

### 3.2 LLM 精神分裂：agent 路径拿不到用户配的 provider（DEV-145）

**症状**：用户在「设置 → 模型管理」配好 provider、聊天里选它 → 发送 →
气泡显示 `agent 执行失败:no LLM provider configured`，然后**回落旧管道**才出正常回答。

**三层错配**：

1. **两张表**：用户配的 provider 在 **ModelManager**；`LlmClient` 只认 **LlmConfigStore**
2. **入口**：设置页只有 basic / models / mcp / memory / about 五个 tab，
   **没有 LlmConfigStore 的入口**（`/settings/llm-config` 是孤岛路由）
3. **调用**：agent 路径调 `think()` 时**根本没把会话的 provider/model 传下去**

> 这条是路线图开篇就列的「**LLM 精神分裂**」，本批把它从"已知差距"变成了"已修的具体缺陷"。

**修法**（additive，不动既有路径）：

| # | 改动 | 文件 |
|---|---|---|
| ① | `LlmRequest` 增 `config?: InlineLlmConfig` —— 显式配置优先于 provider 查表 | `electron/llm/types.ts` |
| ② | `LlmClient.chat/streamChat` 认这个通道 | `electron/llm/LlmClient.ts` |
| ③ | `toLlmProviderConfig()` —— 类型映射 + ollama 的 baseUrl 补 `/v1` | `electron/models/ModelProvider.ts` |
| ④ | brain 透传 `provider / model / config` | `electron/agent/LlmAgentBrain.ts` |
| ⑤ | `dispatchToAgent` 按**会话**解析 provider → 内联配置带下去 | `electron/chat/ChatManager.ts` |

**为什么不写全局表**：LlmConfigStore 按 provider **类型**索引，
同类型的多个用户 provider 会互相覆盖；按会话带才正确。

**回归钉**：`tests/unit/llm/provider-bridge.test.ts`（10 例）+ e2e `error-recovery` ER2
（现在能拿到本地 ollama 的**真回复**，修前永远失败）。

### 3.3 顺带修的两个小问题

| # | 问题 | 修法 |
|---|---|---|
| DEV-146 | **浅色主题下 body 背景仍是深色** —— `boot-splash.css` 写死 `#0f1115`，且在 main.ts 里**最后引入**，压过了 tokens.css 的 `var(--bg-base)` | 改走 token `var(--bg-base, #0f1115)` |
| DEV-147 | **填完 prompt 输入框不聚焦** —— UI 抽取 `ChatInput.vue` 后 `.chat-input` 容器没了，两处 `querySelector` 成死代码 | 改 `.input-area textarea` |

---

## 四、验证

| 项 | 修前 | 修后 |
|---|---|---|
| **既有 e2e 套件** | 79 passed / **51 failed**（39.5 分钟） | **134 passed / 0 failed / 33 skipped**（**8.7 分钟**） |
| 新增单测 | — | `tests/unit/llm/provider-bridge.test.ts`（10 例） |
| vitest | 130 files / 1516 passed | 131 files / 1526 passed / 0 FAIL |
| 后端 tsc / vue-tsc | 0 / 0 | **0 / 0** |
| `npm run build` 门禁 | 5 步通过 | 5 步通过 |

> e2e 耗时从 39.5 分钟掉到 8.7 分钟，**不是变快了，是不再每次渲染 192 个会话**
> ——那是 userData 隔离修好前的残留。

---

## 五、遗留与后续

| # | 遗留 | 归属 | 说明 |
|---|---|---|---|
| 1 | **ClawHub / 模型对比没有侧栏入口** | 需产品决策 | 现在只能从命令面板（Ctrl+K）或 ModelCompare 页的链接进。侧栏收成 7 个固定 icon 时把这两个入口弄丢了 —— 要不要补回侧栏，是产品选择 |
| 2 | **`/settings/llm-config` 仍是孤岛路由** | 后续 | LlmConfigStore 现在只被 agent 路径的**内联配置**旁路使用；这张表本身没有 UI 入口。要么补入口，要么明确它只是内部兼容层 |
| 3 | 33 个 e2e 用例被 skip | 已知 | 需要真实账号/真机的用例（Sentry DSN、macOS/Linux/鸿蒙出包） |
| 4 | e2e 仍不进 CI | 后续 | 需要真实 Electron + 显示器；本机可跑但耗时 8.7 分钟 |

---

## 六、复跑命令

```bash
npm run build
E2E_ELECTRON=1 npx playwright test          # 全量
E2E_ELECTRON=1 npx playwright test tests/e2e/error-recovery.spec.ts   # 单个
```
