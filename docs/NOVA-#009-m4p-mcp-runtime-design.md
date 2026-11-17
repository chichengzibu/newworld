# NOVA #009 — M4-P MCP 运行时端到端（发现工具级错误被当成成功）

> **状态**：已实现（2026-11-13）
> **对应台账**：DEV-156 ~ DEV-158
> **分支**：`feat/harness-wiring`
> **前置**：[M4-O 小屏等比缩放](NOVA-#009-m4o-small-screen-scaling-design.md)

## 一、为什么做这件事

路线图开篇的差距里写着「**MCP 0%**」。但仓库里明明有 `McpManager`、stdio transport、
`McpToolAdapter`、设置页的 ServerCard/FormDialog —— 那这条差距是**陈旧**的，
还是它只是「看着在」？

**先量再下结论**，别猜。

## 二、量出来的结果

`scripts/mcp-filesystem-poc.mjs`（传输层真链路测试）跑下来 **14/14 PASS**：
stdio 传输、5 个工具、路径沙箱、JSON-RPC 错误处理 —— **底层是通的**。

但那份 PoC 里有两处降级：

- **Phase 2 跳过** ——「main.js 是 IIFE bundle，没法 import」
- **Phase 3 只 grep** `dist-electron/main.js` 里有没有 `McpManager` 字样

也就是说：**「配置 → 启动 → 工具同步进 agent → 真调用」这条集成链从没端到端跑过。**

于是本批补了真跑（`tests/e2e/mcp-runtime.spec.ts`），**一跑就挖出三个问题**。

## 三、挖出来的三个问题

### 3.1 ★ MCP 工具级错误被当成「调用成功」（DEV-156）

MCP 有**两层错误**：

| 层 | 形态 | 例子 |
|---|---|---|
| ① JSON-RPC error | 协议级 | 方法不存在、参数非法 |
| ② **工具级 `isError`** | **正常响应 + `isError:true`** | **路径沙箱拒绝、文件不存在、权限不足** |

`McpManager.invoke` 只查了 ① → **②被当成成功**：`success:true`，错误文本藏在 content 里。

**后果不是"日志不好看"**：
- 设置页的「测试」按钮会显示成功
- **LLM 会以为这次工具调用成功了** → agent 可能据此告诉用户「已完成」，
  而文件根本没读到（沙箱拒绝了）

修：invoke 检查 `result.isError` → 以 `success:false` 返回，错误文本提取出来给调用方/LLM 读。

### 3.2 ★ 默认路径白名单里含程序的工作目录（DEV-157）

```ts
const allowed = config.allowedPaths ?? [sandbox, process.cwd()];
```

`process.cwd()` 是开发期「方便读仓库」留下的，但对**装到用户机器上**的应用来说，
cwd 是任意的启动目录（快捷方式启动时甚至可能是 System32）。
**把「当前工作目录」无条件放进白名单 = 路径沙箱开了个洞。**

而设置页当时**还没有 `allowedPaths` 字段** → 用户根本没法自己收窄。

修：默认白名单**只给应用自己的沙箱目录**（`userData/sandbox`）；要访问别的目录，
由用户在设置页显式授权。

### 3.3 相对路径按 cwd 解析 → 配了却用不了（DEV-157 连带）

server 里相对路径按 `process.cwd()` 解析。默认白名单（`userData/sandbox`）与 cwd 毫无关系
→ **相对路径永远落在沙箱外** → 工具「配了但用不了」。

修：相对路径的基准改为**第一个白名单根**（语义即「在我被允许的那个目录里」）。

### 3.4 设置页补上「允许路径」（DEV-157 连带）

原来 MCP 表单只有 名称/命令/参数/环境变量/启用 —— **用户无法配置白名单**。
现补一个「允许路径」输入框（每行一个目录），并写清留空 = 只允许应用自己的沙箱目录。

## 四、验证

| 项 | 结果 |
|---|---|
| 新增 e2e `tests/e2e/mcp-runtime.spec.ts` | **2 passed**：集成链通（启动→列工具→真调用→停服）+ 默认白名单够不着程序工作目录 |
| 新增单测 `tests/unit/mcp-invoke-errors.test.ts` | **2 passed**：工具级失败必须以失败返回 / 正常返回要拼成 LLM 可读文本 |
| `scripts/mcp-filesystem-poc.mjs` | **14/14 PASS**（server 改动没弄坏底层） |
| vitest | 134 files / 1545 passed / 0 FAIL |
| e2e 全量 | 见关单 |

## 五、遗留与后续

| # | 遗留 | 归属 | 说明 |
|---|---|---|---|
| 1 | 「LLM 真的看得见 MCP 工具」这一环仍只有单测 | 后续 | e2e 能验到 server→工具清单→调用，但「brain 的工具表里确实有这些工具」需要暴露内部状态才能验 |
| 2 | 路线图「MCP 0%」这句该改了 | 后续 | 实测：传输层通、集成链通、agent 侧接线完整。**准确说法是「已实现且端到端验过，但只有内置的 filesystem server，没有真实第三方 server 的实跑」** |
| 3 | 自定义（非 filesystem）MCP server 没做端到端 | 后续 | 本批只验了内置 filesystem server 那条路径（它有白名单语义）；第三方 server 走 `config.command/args` 直连，没有额外防护逻辑 |
