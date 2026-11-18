# PiPiClaw v4.4.0 → v5.0.0 — 10 周硬骨头路线图

> **总目标**：Agent runtime 跟 ClaudeCode 对齐 + MCP 集成 + 知识库真向量 = 能力超越 ClaudeCode 起点
> **现状**：v4.4.0 ship 完成（5 P0 安全 + 14 v4.4 视觉），总评 6.5/10
> **差距**：~~MCP 0%~~（M4-P 实测：传输层与集成链均已通并端到端验过）/ 知识库假向量 / Agent 死代码 / 沙箱 stub / ~~LLM 精神分裂~~（M4-L 已修 agent 路径取不到用户 provider 这一半）

## M1 — v4.5.0-alpha（4 周）

| 任务 | 主导 | 周 | 关键交付 |
|---|---|---|---|
| LlmAgentBrain v0.1 | ai | 1-2 | tool call 透传 + 5 工具（Read/Edit/Bash/Glob/Grep）+ multi-turn |
| 9 P0 阻塞前 4 项 | backend | 1 | forceReset 重做 + Ed25519+TOFU + LlmClient 修复 + d5:run bug |
| LLM 抽象统一 | ai | 1 | LlmClient + ModelManager 合并，删 ModelManager 死代码 |
| MCP 调研 + PoC | mcp (新) | 1-2 | stdio transport + filesystem server PoC |

**ship**：v4.5.0-alpha → GitHub 公开（early adopter），**总评 7.5/10**

## M2 — v4.5.0-beta（4 周）

| 任务 | 主导 | 周 | 关键交付 |
|---|---|---|---|
| LlmAgentBrain v0.2 | ai | 5-6 | max_iterations + cost tracking + 流式 tool call |
| 9 P0 阻塞后 5 项 | backend | 5 | safeStorage Linux + file path 沙箱 + 未知 op deny + SkillLoader verify + ToolRegistry |
| MCP 实施 3 server | mcp | 5-8 | filesystem / github / postgres + UI 配置页 |

**ship**：v4.5.0-beta → GitHub 公开（general），**总评 8.5/10**

## M3 — v5.0.0（2 周）

| 任务 | 主导 | 周 | 关键交付 |
|---|---|---|---|
| 知识库真向量 | ai | 9-10 | sqlite-vss + bge-m3 + rerank（替换 SHA-256 假向量） |
| 沙箱起步 | backend | 9-10 | ProcessSandbox 接口 + Windows 平台分支（cgroup/Job Object） |

**ship**：v5.0.0 → production + 半商业化，**总评 9.0/10**

### M3 实际交付（2026-10-28 ~ 10-29）

| 原计划项 | 状态 | 说明 |
|---|---|---|
| bge-m3 真向量 | ✅ **已交付** | 三个真后端代码本就存在，但**零配置入口**（provider 默认伪向量、用户设不了）。现：4 个 IPC + 设置页卡片 + ollama 后端现代化（现代 `/api/embed` 批量 + 模型自动探测）+ **语义自检**。A/B 实测（本地 ollama bge-m3）：改写查询 top-1 命中 **6/6 vs 伪向量 0/6** |
| 混合检索 | ✅ **超出计划交付** | 计划里没有，但真向量接上后暴露两个硬伤：中文根本没被分词（整句成词条，改写就召不回）、两路检索**取分数最大值**（拿覆盖率比余弦）。现：CJK bigram 分词 + RRF 融合 |
| ProcessSandbox + 平台分支 | ✅ **已交付** | 实测发现 `execFile` 超时只杀直接子进程 → **孙进程变孤儿**（Windows 实测 PID 存活）。现：POSIX 进程组 / Windows `taskkill /T`，另把「用户点停止」的中止信号贯通到命令执行 |
| sqlite-vss | ⏸ **有意不做** | 当前向量库上限 200 条，桌面应用够用。换 sqlite 是**规模问题不是正确性问题**，且要引入原生依赖（构建风险） |
| rerank | ⏸ **有意不做** | 本地 ollama 0.40.11 **没有 `/api/rerank`**（实测 404），要做需另接 cross-encoder 服务（TEI/Cohere/Jina） |
| cgroup / Job Object 资源限额 | ⏸ **有意不做** | 需原生模块，与本项目**零原生依赖**取向冲突。「不产生孤儿进程」这一最高价值部分已用零依赖方式落地 |

**设计文档**：[NOVA #009 M3-A](../NOVA-#009-m3a-real-vectors-design.md) · [M3-B](../NOVA-#009-m3b-hybrid-retrieval-design.md) · [M3-C](../NOVA-#009-m3c-process-sandbox-design.md)

### M3/M4 后续补做（2026-11-02）

路线图 M3 完成之后，又扫出并修掉了几处**「看起来在工作，其实没有」**的缺陷：

| 批次 | 内容 | 文档 |
|---|---|---|
| M3-D | 技能目录（补上 preload 承诺但**全仓无 handler** 的 6 个通道） | `NOVA-#009-m3d-skill-directories-design.md` |
| M3-E | 成本记账（`insight:cost:today` 此前是**硬编码 0 的 stub**） | `NOVA-#009-m3e-cost-accounting-design.md` |
| **M3-F** | **构建修复 —— 应用此前根本打不出包**（4 条断链让主进程构建失败；构建**不做类型检查**） | `NOVA-#009-m3f-build-repair-design.md` |
| M4-G | 架构收敛（删掉没接入主线的平行架构：actor / conversation / SkillManager CRUD） | `NOVA-#009-m4g-architecture-convergence-design.md` |
| M4-H | 诚实性与定价可维护（兜底实现不再装作答了；定价表不再是双重死代码） | `NOVA-#009-m4h-honesty-and-pricing-design.md` |
| M4-I | 记忆库/向量库 id 对齐（此前**每次召回都在重嵌全部记忆**，且幂等键从未生效） | `NOVA-#009-m4i-memory-id-alignment-design.md` |
| **M4-E** | **技能效用的受控对照**（配对 A/B + 分层评分器 + 准入门；「禁止用技能」必须真的禁止） | `NOVA-#009-m4e-controlled-skill-validation-design.md` |
| M4-F | 用户接受度信号 + LLM 裁判层（成功信号从「过程」升级到「用户满不满意」） | `NOVA-#009-m4f-acceptance-and-judge-design.md` |
| M4-G | 实跑验证（第一次把应用跑起来看 —— 抓出 3 个 i18n 缺失 key + 1 个 flaky 墙钟断言 + 仓库卫生） | `NOVA-#009-m4g-runtime-verification-design.md` |
| M4-H | 面板渲染测试（typecheck 通过 ≠ 界面正常 —— 6 个新面板钉成 18 例组件测试） | `NOVA-#009-m4h-panel-render-tests-design.md` |
| M4-I | 轨迹签名聚类（学习闭环不再只认字面相同的指令 —— 按工具序列分组 + IDF 加权） | `NOVA-#009-m4i-trajectory-clustering-design.md` |
| **M4-J** | **裁判校准**（M4-F 遗留的最后一环：接两套公开人工标注集 + κ/偏置探针 + 诚实结论；顺带修产品级 bug「ollama thinking 吞 token → 裁判等于没跑」） | `NOVA-#009-m4j-judge-calibration-design.md` |
| **M4-K** | **真机验证清单自动化**（把 VERIFICATION.md 的 D/E 段人工肉眼项逐条变成 e2e 断言；过程中挖出**带在 master 上一个月的 P0**：打开任何有消息的会话 → Chat 视图整屏红框（`useVirtualizer` 返回 Ref，脚本漏 `.value`；且被 `as unknown as` 断言吞掉，typecheck 一直绿）） | `NOVA-#009-m4k-verification-automation-design.md` |
| **M4-L** | **e2e 套件对齐**（把 M4-K 暴露的 51 个既有 e2e 失败逐条对齐到当前 UI；途中挖出**两个 P0**：悬浮命令按钮压住「发送」按钮（用户点发送点到的是命令按钮）、**LLM 精神分裂**（agent 路径拿不到用户配的 provider → 每条消息先失败一次再回落旧管道） | `NOVA-#009-m4l-e2e-alignment-design.md` |
| **M4-M** | **低频功能的入口可达性**（ClawHub 技能市场 / 模型对比丢了侧栏入口 —— 技能市场只藏在「导入」对话框的页签里(2 层深),模型对比只有 Ctrl+K。对比 Claude Code / Cursor / Cherry Studio / OpenChat / 飞书后定:**不进侧栏**,改为在**母页面**放**带文字**的按钮(技能页「浏览 ClawHub 市场」+ 模型页「对比模型」); 顺带修 e2e harness 自身缺陷:DevTools 把视口从 1280 挤到 725,导致位置类断言失真且会假通过 | `NOVA-#009-m4m-entry-points-design.md` |
| **M4-N** | **受控对照的结论增强**（M4-E 的对照只用二值 `passed`,把 `GradeResult.score` 扔了 —— 两次都失败但一次错 1 个工具、一次错 5 个时结论只能写「看不出差别」。现:加连续分差与方向一致性(**准入门不动**),并新增 pairwise 裁判路径(可选/默认关/按 D7 不参与判定,且**强制换序双向 + 一致性要求** —— M4-J 实测本地裁判换序改口率 68~80%) | `NOVA-#009-m4n-trial-signal-design.md` |
| **M4-O** | **小屏等比缩放**（布局固定按 1280px 铺开 + 窗口 `minWidth: 1280` → 1366×768 笔记本开 125% 缩放这档（CSS 宽 1092）**右边一截在屏幕外**,发送按钮这类靠右的元素够不着。现:窗口窄于设计宽度时按比例缩小页面,布局仍按 1280 铺开 → 什么都不裁切;`minWidth` 放宽到 900、resize 去抖、缩放下限 0.6 | `NOVA-#009-m4o-small-screen-scaling-design.md` |
| **M4-P** | **MCP 运行时端到端**（路线图那句「MCP 0%」已陈旧 —— 传输层早通了(PoC 14/14),但「配置→启动→工具同步进 agent→真调用」这条集成链**从没端到端跑过**(PoC 的 Phase 2 跳过、Phase 3 只 grep 产物)。补了真跑 → 挖出三个问题:**工具级错误(isError)被当成「调用成功」**（沙箱拒绝被报告成功 → LLM 会说「已完成」）· **默认白名单含程序工作目录**（路径沙箱开了个洞）· 相对路径按 cwd 解析导致「配了却用不了」。三条全修 + 设置页补「允许路径」字段 | `NOVA-#009-m4p-mcp-runtime-design.md` |
| **M4-Q** | **e2e 进 CI 门禁**（CI 的 Playwright 步骤此前**只跑 4 个 spec 文件** —— 近几批挖到的 P0 全都不在那四个里,「跑」没有变成「门禁」。现改跑**全量**(ubuntu + xvfb,依赖 LLM 端点的 spec 用仓库自带的 mock 顶在 11434,不装 6GB 真模型）。过程中挖出一条**一直在假通过**的 e2e:sendMessage 收了 providerId 却**不写回会话**(产品缺陷 → 经 IPC 发消息时 agent 永远拿不到 provider → 学习闭环记到的全是失败)· mock 不支持 SSE(内容一行都进不来)· 断言只断「消息条数 > 0」(用户消息就够数) | `NOVA-#009-m4q-e2e-ci-gate-design.md` |
| **M4-R** | **剩余界面实跑**（M4-K 遗留 #3:首屏之外的 Skills / Models / IM / Schedule / Settings / DevPanel 展开态**只过 typecheck 与组件测试**,而近几批的 P0 全是实跑才看见的。现新增 e2e(7 例)逐页真跑:根容器渲染 / 关键内容在 / 无红屏兜底 / 关键元素完整落在视口内;**本批未发现新的产品缺陷** —— 5 页 + DevPanel + 5 个设置页签全部正常 | `NOVA-#009-m4r-pages-verification-design.md` |
| **M4-S** | **e2e 隔离补强**（M4-R 顺手挖出:M4-K 的隔离修复把 userData 建在**模块级**,而 Playwright 同 worker 顺序跑多个 spec 时 helper **只加载一次** → **所有 spec 文件共用一个 userData** → 状态跨文件泄漏(实测 `ui-smoke` 切到 English 没切回来 → 后续 spec 全红)。现:userData **每个测试一个** + 清理加护栏;连带暴露一批**顺序依赖**的 spec(`settings-full-crud` CR2~CR7 依赖 CR1、`network-failure` NW4 依赖 NW1/NW3 —— **单跑必红**)→ 改为各自自建前提 | `NOVA-#009-m4r-pages-verification-design.md` |

**构建门禁**（M3-F 引入，此后每批都守着）：
`[1/5] 主进程 typecheck → [2/5] 渲染进程 typecheck → [3/5] vite build → [4/5] electron-builder → [5/5] build-report`
—— 前两步任一不过，**构建直接中止**。外加 `tests/unit/import-integrity.test.ts`
扫全仓相对 import 能否解析（「模块被删但 import 还在」会让构建失败）。

**下一步（未排期，按价值排序）**
1. **裁判校准** —— ✅ **已完成（M4-J, 2026-11-09）**：接两套公开人工标注集
   （panel EMNLP2026 / MT-Bench），建零依赖校准模块（κ / 原始一致率 / Wilson CI /
   位置偏置探针 / 冗长偏置探针），并实跑两个本地裁判模型出结论。
   **结论：当前默认裁判模型未达可信门槛 → 裁判保持默认关闭**（详见设计文档第四节）
2. **Job Object / cgroup 资源限额** —— 需原生模块，作为可选增强而非硬依赖
3. **rerank** —— 需另接 cross-encoder 服务（本机 ollama 0.40.11 无 `/api/rerank`，实测 404）
4. **sqlite-vss** —— 当前向量库上限 200 条，桌面应用够用；是规模问题不是正确性问题
5. **裁判提示词迭代** —— M4-J 实测显示本地小模型裁判的位置敏感度极高
   （换序改口率实测 60%+），下一轮可试：更明确的 rubric 锚点 / 参考答案对比 /
   多次投票取多数（成本换稳定性）
6. ~~ClawHub / 模型对比要不要回侧栏~~ —— ✅ **M4-M 已定**：**不进侧栏**，
   改为在母页面放带文字的按钮（技能页「浏览 ClawHub 市场」/ 模型页「对比模型」）。
   依据：同类 AI 客户端（Cherry Studio / OpenChat / Claude Code / 飞书）都不把
   "市场"放一级图标导航；图标栏无文字靠"识别"，带文字按钮靠"阅读"，
   后者对新手门槛更低

## 节点 + ship 对象

| 节点 | 总评 | ship 给 |
|---|---|---|
| 现在 v4.4.0 | 6.5/10 | 内部 dogfooding |
| M1 v4.5.0-alpha | 7.5/10 | GitHub 公开（early adopter） |
| M2 v4.5.0-beta | 8.5/10 | GitHub 公开（general） |
| M3 v5.0.0 | 9.0/10 | production + 半商业化 |

## M1 第一波（今天启动）

| Agent | 任务 | 状态 |
|---|---|---|
| pipiclaw-ai | LlmAgentBrain v0.1 + LLM 抽象统一 | spawn now |
| pipiclaw-backend | 9 P0 阻塞前 4 项 | spawn now |
| **pipiclaw-mcp（新）** | MCP 调研 + filesystem PoC | spawn now |

verifier 每周末汇总 + 决定 ship 模式
