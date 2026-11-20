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
| **M4-T** | **学习闭环端到端**（「自我学习」是本项目对标 Hermes / Claude Code 的**核心差异点**,但从没被端到端验过「它真的在记东西」;且 M4-Q 修掉的那个 bug(`sendMessage` 收 providerId 不写回会话)**本来会让闭环记到的全是失败**)。现新增 e2e(2 例)验成事实:成功的对话 → 观察落盘(outcome='ok')· 工具调用链(mock 加工具调用模式 → agent 真的调了 → 观察里有 Glob 步骤 → tracker 有工具级记录)。**未发现新的产品缺陷** —— 但它是 M4-Q 修复的**回归守卫** | `NOVA-#009-m4s-learning-loop-e2e-design.md` |
| **M4-U** | **构建备份不再无限累积**（`moveAside()` 每次构建把旧产物改名成 `<dir>.bak-<时间戳>`却从不清旧的 → 连续构建十几次后堆了 **39 个目录 / 5.1GB** → electron-builder 扫目录超时 → 「未找到打包产物」→ **构建门禁红**。现:构建前剪枝(每个目录留最近 1 代,护栏只认 `(dist|dist-electron|release).bak-<纯数字>`)→ 实测 39→6 个目录(473MB 封顶),构建重新产出安装包 | `scripts/cleanup-build-backups.mjs` |
| **M4-V** | **pairwise 裁判:先量,再接成一个「会被门禁拦住」的东西**（用户要求「接 pairwise 裁判」,但 M4-N 那条「两次顺序一致才采信」是条**从没验证过的代理** —— 实跑复算 M4-J 已落盘的 480 次裁决:被采信的**顺序一致子集 κ=-0.167 < 整体 κ=0.411**、一致率 44.9% vs 整体 70.9%、覆盖率仅 31% → **照它采信 = 系统性挑中裁判最不准的那批**;而顺序不一致那批的 82.8% 是**基准率假象**(拆组后组内准确率=多数类占比、组内 κ=0);裁判还**赢不了**「永远选更长的那个」这个平凡基线(基线 κ=0.638 vs 裁判 κ=0.411),且人工自己就有 82.1% 选了更长的那个 → 这份标注集区分不了「看懂内容」与「押注长度」。现:① 校准层增**顺序一致性分析**+**长度平凡基线**(随报告出、随门禁判,复算不调模型);② 新增 `JudgeTrust` **放行门禁** —— D7 从注释变成会拦人的门,**任一不达标则裁判一次都不被调用**,并逐条给出不达标项;③ 生产路径**真接线**(此前 `runSkillUtilityTrial` 从不传 judge,裁判在生产上从没跑过),按用户当前 provider 查门禁(校准记录按模型归档 → 换模型即失效);④ 界面勾选框不通过时**禁用**并写明原因,结果里独立渲染 `judgeStatus` | `NOVA-#009-m4v-pairwise-wiring-design.md` |
| **M4-W** | **让 AI 真的能选对技能**（用户要求「技能要用 AI 自行判断用哪个」。机制早就有(M4-A 渐进披露:L1 摘要常驻 → 模型自己判断 → 调 load_skill),代码里**没有关键词匹配**替 AI 做决定,界面也**没有**手动选技能入口 —— 设计上就是「AI 自己选」。**但从没验过**:既有测试只验管道(摘要有没有内容/load_skill 能不能拿到正文/appliedSkills 有没有记上),全部用 mock 模型,没有一条问「模型面对真实任务会不会挑对那个技能」。现新增**真模型路由基准**(接本机 ollama、走生产 agent 路径;四条约束:技能 id≠name · 每任务只匹配一个 · 带负样本 · 措辞不提技能名),量出两个真缺陷:① **摘要给的是展示名、工具只认 skill_id** —— id 是目录名(`sample-web-summary`)、展示名是 frontmatter 的 name(`Web Page Summarizer`),两者常常不同 → 模型**判断对了却用不上**,白花一轮模型往返;实测仓库自带两个技能 100% 命中(之前没发现,是因为测试全用 id===name 的技能)。② **技能规则排在最后,被「优先用工具拿真实数据」压过** → 一半任务压根不加载技能(漏选)。修:摘要带出 skill_id + getSkillBody 按 name 兜底 + appliedEntity 记规范 id(否则学习闭环按对不上的名字聚合)+ 技能判断提到系统提示第 1 条。**修前/修后 A/B(同条件各 3 轮)**:选对率 87.5%/87.5%/75.0% → **100%/100%/100%**,漏选 12.5%~25% → **0%**,`load_skill` 失败 **7/7/6 次 → 0/0/0 次**;换 qwen3.8-27b 复测同为 100% | `NOVA-#009-m4w-skill-routing-design.md` |
| **M4-X** | **技能来源体系:不集成 / 联网找 / 手动装 / 存储位置**（用户要求「技能部分不要集成,联网环境下自动去开源技能库寻找以及推荐用户联网下载,有网和无网环境下可以手动添加技能包,技能包存储位置添加为应用本身结构目录的 skills 下面」。**先量现状**:「联网自动寻找」此前是**一条死路** —— ClawHubManager 是本地模拟市场(「下载」按钮是 stub),ClawHubRegistry 指向 `https://example.com` **占位符**且其「zipUrl+Ed25519 签名」是私有仓库规范(开源库不签名,信任模型不同)。现:① 新增 `SkillHub` —— 内置两个**实测可达**的开源库(Anthropic 官方 19 条 / Skill-Shelf 社区 15 条),原生格式各自适配;官方源的 marketplace.json 只有目录路径没有描述,而描述正是路由依据(M4-W),故再取目录树补齐;索引**落盘缓存** → 搜索/推荐纯本地过滤(**断网照常**),只有下载要网络;推荐已装的**不重复**、无描述的**不推荐**;安装按目录枚举+逐文件下载,**整个目录**都装(含 references/scripts),装完补 when_to_use。② 存储位置改到**应用自身结构目录的 skills**(开发态=仓库 skills/,打包后=<install>/resources/skills,只读位落回 userData),守住**读写同源**(历史上「写一处读另一处」导致技能永远扫不到):目录落盘记住、读写同函数、选前真写探针测可写。③ 不集成:仓库两个样例技能删除 + 首启拷贝行为删除 + .gitignore 加 `skills/*`。④ 手动添加:`.md`/文件夹/`.zip` 三种**纯本地**原本就有(本次确认),与新卡片两条并存。**实跑**:两源均通(34 条)· 搜 pdf 命中 3 条 · 安装 docx 成功且装完能加载;顺带修掉两个自造 bug(下载直链丢目录前缀 404 / 安装失败留下半成品目录会被扫到加载) | `NOVA-#009-m4x-skill-sources-design.md` |
| **M4-Y** | **清掉与「开源技能库」重叠的两个旧界面**（M4-X 交付后用户指出:ClawHub 本地模拟市场与 SkillMarket 死页和新卡片功能重叠,且用户会同时看到「本地演示模式」和真能用的开源库两套东西,**容易以为后者也是假的**）。逐条查过读写路径才敢删:① **SkillMarket.vue 整页是死的** —— 「我的技能」恒空(onMounted 里 setSkills([]))、推荐列表是写死的 PRESET_SKILLS、安装按钮**没有 @click**、路由 `/skill-market` **全仓无入口**;整页 + 其 Pinia store 删除。② **ClawHub 的 4 个本地演示页签**:下载是 stub、发布/审核写的 userData 文件**审核通过的条目永远装不上**、「一键实例化」写到 `userData/templates/` 而**SkillLoader 从不扫那个目录**(它只扫技能目录 + 用户自加目录)→ 整条链是死的;连带删 `ClawHubManager.ts`(757 行)+ 9 个 IPC + 9 个 preload 方法 + 9 个通道常量(M3-F 先例)。**保留 ClawHubRegistry** —— 它是**信任模型不同**的能力(自建仓库 zip 带 Ed25519 签名、应用验签),与开源技能库的无签名公开集合不构成重叠;/clawhub 路由保留,页面改名**「私有技能仓库」**并说清与开源技能库的区别。入口一并修正:技能页头部按钮删、命令面板改标题、模型对比页链接删、路由与 i18n 文案对齐 | `docs/deviation-ledger.md` DEV-175 |
| **M4-Z** | **让构建门禁「红得说得清」**（M4-Y 时 `npm run build` 红过一次却说不清原因 —— 分步 5 步全过、单独跑 electron-builder 也过。查到**三处脚本缺陷**：① `stdio:'inherit'` 输出不落盘 → 红了没证据；② `timedOut` 在 close 里写死 false、判断超时那行是同步死代码 → 超时与普通失败无法区分；③ `moveAside()` 的 catch{} 静默吞错 → 旧 release/ 被占时照样跑 EB，撞 `EBUSY unlink app.asar`，最终报成「未找到打包产物」，真错误被埋两层。**真实根因是外部文件锁**：app.asar 可读写但不可改名/删除（EBUSY/EPERM），持续十几小时、跨两个副本，进程排查无 PiPiClaw/electron/app-builder/7za；**换输出目录打包成功** → 打包链健康。修：核心抽到 `scripts/lib/build-runner.mjs`（可单测）、每步日志落盘 `.tmp-build-logs/`、失败打印日志路径+末尾 30 行、超时如实上报+15s 硬兜底、移走失败带诊断快速失败（重试 4 次）、`--skip-electron` 不动 release/。回归钉 8 例。**未闭环**：外部锁需重启释放，完整门禁待重启后实跑确认 | `NOVA-#009-m4z-build-gate-diagnosability-design.md` |
| **M4-AA** | **旧管道对齐 D8：技能不再由代码替 AI 选**（D8 已定「技能由 AI 自行判断选用，代码不做匹配替它决定」，agent 路径已对齐，但旧管道没有：`getSkillContext()` 在 >5 技能时**额外发一次 LLM 调用**排序、失败再降级关键词匹配，取前 3 名注入；`InstructionGenerator` 把清单**注入两遍**且口径不同；追加段还写「检测到匹配的技能」。修法不是"选得更准"而是**不做选择**：正文合计 ≤16k 字全量注入（摆出来由模型自己决定），超预算只给清单并**如实说明**拿不到全文；删除 `rankSkillsOnce` / `rankSkillsByRelevance` 与死依赖；摘要只列启用技能；提示词改为「先判断是否相关」。影响：agent 路径不受影响；旧管道技能正文从"前 3 名"变成"全部或没有"，每次规划少一次往返。回归钉 5 例） | `NOVA-#009-m4aa-legacy-skill-context-d8-design.md` |
| **M4-AB** | **技能规模档基准**（M4-W 的 100% 是在 4 个技能上量的；开源库一次能装 30+。新建 `tests/integration/skill-routing-scale-live.test.ts`：真模型 + 生产 agent 路径，**10 目标 + 14 填充 = 24 技能**，13 正样本 + 3 负样本。**实测 100% / 92.3% / 92.3%**，多选 0、负样本 0 → **规模本身不是主要风险**；唯一复现的漏选是「扫描版 PDF 文字识别」—— 目标技能描述没覆盖 OCR/扫描件，**真正原因是描述覆盖不足**。另：主题重叠时"唯一正确答案"前提不成立（xlsx vs Excel 目标），且 27b 反而更差。**测量教训**：填充集必须冻结，否则测到的是网络波动（11~18 条/轮）） | `NOVA-#009-m4ab-skill-routing-scale-design.md` |

**构建门禁**（M3-F 引入，此后每批都守着）：
`[1/5] 主进程 typecheck → [2/5] 渲染进程 typecheck → [3/5] vite build → [4/5] electron-builder → [5/5] build-report`
—— 前两步任一不过，**构建直接中止**。外加 `tests/unit/import-integrity.test.ts`
扫全仓相对 import 能否解析（「模块被删但 import 还在」会让构建失败）。

**下一步（未排期，按价值排序）**
1. **裁判校准** —— ✅ **已完成（M4-J, 2026-11-09）**：接两套公开人工标注集
   （panel EMNLP2026 / MT-Bench），建零依赖校准模块（κ / 原始一致率 / Wilson CI /
   位置偏置探针 / 冗长偏置探针），并实跑两个本地裁判模型出结论。
   **结论：当前默认裁判模型未达可信门槛 → 裁判保持默认关闭**（详见设计文档第四节）
   —— ✅ **M4-V 补齐了门禁**：D7 从注释变成 `JudgeTrust` 会拦人的门；复算又量出
   「顺序一致才采信」这条规则**反着**、且裁判赢不了长度平凡基线（详见 M4-V 设计文档第二节）。
   **仍待办**：技能域人工标注集（D7 ②）——通用数据集被长度偏好主导，测不出质量
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
