# Changelog

All notable changes to PiPiClaw will be documented in this file.

## [Unreleased] - 2026-10-25 (W5 接线批 — 能力已写就,从未接线)

> 这一批不是新功能,是**把早已写好但从未接上生产路径的能力接通**。
> 审计发现 `LlmAgentBrain` 的 tool-call 循环完整可用,却零生产调用方;
> Hermes 学习系统有 4 处独立断点,闭环 0% 可达。
> 详见 `docs/NOVA-#008-m4-skill-progressive-disclosure-design.md` 与 `docs/deviation-ledger.md` DEV-042~048。

### 🔌 Agent 执行内核接线

- **tool loop 接入生产链路** — `dispatchToAgent` 此前只 log decision 就丢弃,
  且零调用方;现 `sendMessage` 优先路由到 agent loop,`handled: false` 一律回落旧管道
- **token 记账** — `run()` 返回类型新增 `totalTokens`(此前拿到即丢,无出口)
- **工具调用可视化** — 10 种 agent 事件此前零订阅者,现经中继关联会话后广播到渲染层,
  Chat 里能看到「读了哪个文件 / 跑了什么命令 / 哪一步失败」
- **执行确认闸门** — 渲染层的确认弹窗此前是死代码,LLM 生成步骤后【立即执行】;
  现计划模式下先展示计划、用户确认后才执行
- **执行模式可见** — safe / plan / craft 三档常驻输入区,切到全量模式需二次确认

### 🔒 安全

- **工具权限门 ToolGate** — `EditTool` 标注了 `requiresPermission` 但 run loop 从不读取,
  写文件零确认;现统一调度,敏感路径硬拒,拿不准一律拒绝
- **路径逃逸修复** — `rm -rf ~/.ssh` 的路径藏在 Bash 的 args 数组里,原检查只认字符串键
  → 已改为扁平化扫描所有参数

### ⚙️ 上下文管理

- **ContextEngine 三级降级** — 此前 run 内 `messages` 只增不减,10 轮 × Read 200KB 必然溢出;
  现按预算裁剪 / 摘要 / 中止,降级在调 LLM 之前而非溢出之后

### 🔁 可靠性

- **重试 + full-jitter 退避 + 熔断** — 单次 LLM 失败(429/5xx/网络抖动)此前整个多轮 run 直接崩;
  现可重试错误走退避重试,不可重试错误立即失败,持续故障时熔断开闸
- **错误分类修正** — 原实现用 `includes('rate')` 判定限流,会误匹配
  generate / moderate / accurate;改为状态码优先

### 🔌 MCP 生态

- **MCP 工具接入 agent 工具集** — `McpManager` 此前只挂 IPC 层,LLM 调不到任何 MCP 工具
  (装了 server 也白装);现 MCP 工具与内置工具走同一套 function calling / 权限门 / 可视化

### 🧠 技能系统渐进披露

依据 Anthropic Agent Skills 规范重做:

- **L1 常驻** — 技能的 `name` + `description` + `when_to_use` 始终可见,它本身就是路由依据
- **L2 按需** — 新增 `load_skill` 工具,模型自己决定何时加载正文
- **L3 资源** — `references/` `scripts/` `assets/` 按需 Read / Bash
- **匹配不再在代码里做** — 此前技能 >5 个时对每个串行发一次 LLM 调用(N 次往返);
  现改为单次批量排序,匹配决策交给模型
- **格式对齐规范** — `SKILL.md` + frontmatter(`name`/`description`/`when_to_use`),
  修复「生成器与解析器互不兼容」导致的自学习技能从未被真正加载

### 🧠 学习闭环接线(M4-B)

学习闭环两端此前**同时断开**:观察端只挂在旧管道上,效果反馈零调用方。
详见 `docs/NOVA-#008-m4b-learning-closure-design.md` 与台账 DEV-049~054。

- **agent loop 路径接上学习** — 此前最重要的能力路径**完全不产生学习数据**;
  现每轮记录轨迹(每步带成败)、结果、失败诊断与效果反馈
- **观察端语义三错** —
  ①中文正则门控(用户说「整理一下思路」也会被记一条空样本)→ 普通对话流不再产生样本
  ②**重复指令直接丢弃** → 改为计数(「重复」恰恰是最该学的信号)
  ③**只记成功** → 失败也记,并附「哪一步坏了 + 属于哪一类」
- **执行结果不再丢失** — `observeExecution` 第三参此前带下划线前缀(= 故意不用),
  成败信息 100% 丢失;现归一为 `ok`/`fail`/`partial`
- **失败分类器独立成模块** — 9 个低基数类目,互斥匹配、穷尽兜底;
  与 OpenTelemetry GenAI `error.type` 的 `tool_error` 同名
- **效果判定可读** — `SkillEffectivenessTracker` 此前收集了数据却**零读取方**;
  现新增低基数判定(untested / insufficient_data / healthy / degraded / harmful)
  + IPC + `SkillsView` 「效果统计」面板
- **调研否决了一个动作** — 原计划「效果差的技能自动降权」被**否决**:
  真正有害的判据是「带/不带该技能」的**差值**为负,不是绝对成功率低。
  没有对照数据就没有边际效用,故只做提示**不做自动处置**

### 🐛 修复

- `InstructionGenerator` 漏 `await` → 每轮 systemPrompt 注入字面量 `[object Promise]`
- 技能保存目录双源(写 `appPath/../skills` 读 `userData/skills`)→ 自学习技能永远扫不到
- 提案订阅用 `window.require`(`contextIsolation: true` 下恒 undefined)→ 横幅不可能出现
- `stdio.ts` 缺 `kill()` → MCP server 初始化超时时子进程泄漏
- **学习块违反「不阻塞 chat 主流」红线** — 裸调 `observeExecution`,
  一旦抛错则任务流抛 → 回退普通对话流 → 用户看到「LLM 连不上」而非真实失败原因;
  现整块兜住,异常只记日志
- **`SkillEffectivenessTracker` 每次记录同步全量写盘** — 接成主链路后,
  一次 10 步任务 = 10 次同步写 = 主进程被 IO 卡住;现改为去抖 500ms
- **full-jitter 退避测试测错了对象** — 原用墙钟量间隔,测的是「OS 定时器精度」;
  Windows 定时器粒度 ~15.6ms 使请求 5ms 实测 12~18ms > 断言上限 10ms;
  改为断言「请求的退避时长」,并补 `computeBackoffDelay` 纯函数穷举用例

### 🧠 模式证据链(M4-C)

从观察里提炼技能这一环此前产出的技能**不可信** —— 业界实测「自生成技能的平均收益
接近零甚至为负,瓶颈在生成与验证不在存储」。现改为**先选后归纳**:

- **不再在无关样本里找规律** — 旧实现把最近 10 条观察的指令文本丢给模型问
  「共同模式是什么」,而那 10 条可能互不相关 → 只能编。现按归一化指令聚类,
  选出证据达标的候选模式,只把**这一条模式的轨迹证据**交给模型
- **两道门槛** — 支持度 ≥ 2 次(1 次可能只是偶然)、成功率 ≥ 50%
  (一直失败的模式不值得固化)。支持度不达标**根本不调 LLM**
- **操作步骤来自跨成功轨迹归纳的共同步骤** — 不再抄最后一次执行
  (那会含一次性动作);顺带修掉 agent loop 步骤形状导致的
  **每步输出「执行 undefined」**
- **提案带证据链** — 支持度 / 成败 / 轨迹 id(provenance)/ 共同步骤 / 工具,
  提案详情弹窗展示,让用户能核对「这技能凭什么成立」
- **逐次轨迹有界保留** — 每条观察保留最近 5 次执行的成败摘要,
  不再只有聚合计数;只存摘要不存工具原始输出
- **提示词不再撒谎** — 旧提示词硬编码「连续执行了3个操作」而实际传入 10 条

### 🧠 技能效用验证(M4-D)

学习闭环的最后一问 ——「这个技能到底有没有让事情做得更好?」——
此前**无法回答**,因为数据里根本没有这个问题的答案。

- **技能应用信号从无到有** — 工具调用日志里只有工具名(`load_skill` 是工具名,
  不是技能 id)→ 数据里根本不存在「技能 S 被应用」这件事。
  现工具自己声明「我动了什么」(`appliedEntity`),brain 汇总成 `appliedSkills`,
  ChatManager 记技能级运行
- **边际效用** — 新增「同类别任务下,带该技能 vs 不带该技能」的成功率差值。
  这是比绝对成功率强得多的判据:绝对成功率低可能只是任务难
- **口径诚实** — 这是**观察性对比而非受控实验**(不带技能的运行是自然发生的,
  存在混杂),故只产信号,**不做任何自动禁用/回滚**
- **任务类别归一抽成单一实现** — 对比的两侧必须用同一套规则,否则对比组会漏记录
- **技能卡上的统计不再编造** — `usageCount`/`successRate` 的写入函数此前
  **零调用方**,界面恒显「0 次使用 / 100% 成功率」。现用真实记录,
  无数据显示 `—` 而非假的 100%

### 🐛 修复

- **`load_skill` 权限档位漏登记(M2-B 遗留)** — 只读工具未在 ToolGate 档位表登记 →
  落到兜底 `confirm` → headless 场景**直接被拒**,UI 场景**每加载一次技能弹一次确认框**。
  连带后果:M4-A 设计的「模型自己决定加载哪个技能」实际从未跑通
- **新增内置工具档位一致性用例** — 把「只读工具漏登记 → 静默变 confirm」
  这个静默陷阱变成红灯

### 🧠 知识库真向量(M3-A)

路线图 M3 的前半。此前 `EmbeddingService` 的三个真后端(ollama/openai/智谱)
**代码全都实现了**,但 provider 默认伪向量、且**没有任何配置入口** ——
用户想设也设不了。伪向量的后果不是精度差一点,是**完全无语义**:
相似文本的余弦是随机值,记忆检索退化成「随机取 N 条」,且不报错。

- **配置入口** — 新增 4 个 IPC + 「设置 → 记忆」页的「嵌入后端」卡片:
  后端选择 / 服务地址 / API Key / 模型(列出本机已装的嵌入模型)/ 检测 / 测试连接
- **诚实标注** — 界面明写「当前是伪向量 — 召回是噪声」;
  探测除「可达」外还报**语义自检**:相近文本是否确实比无关文本更相似
  (伪向量也连得上,但语义是假的 —— 那才是危险的那种失败)
- **ollama 后端现代化** — 优先现代 `/api/embed`(支持 `input` 数组 → 批量一次请求),
  老接口回退;模型名不再硬编码 `nomic-embed-text`(本机装 bge-m3 就用 bge-m3)
- **A/B 实测(本地 ollama bge-m3 真跑)** — 8 条记忆 + 6 条改写查询,
  top-1 命中:**真向量 6/6**,伪向量 **0/6**(随机基线 12.5%)

### 🐛 修复

- **伪向量被真后端污染成 NaN** — `hashToVector` 用 `this.dimension` 决定长度,
  而该字段会被真后端改写(嵌入一次 bge-m3 → 1024);而 hash+hash2 只有 64 字节
  → 越界 → **向量全 NaN** → 余弦 NaN → `score >= minScore` 恒 false
  → **召回静默返回空**。即「切回伪向量后记忆检索彻底失效且不报错」。
  该洞因真后端此前不可达而一直藏着,一接通入口就变成生产事故。现:伪向量维度固定 64
- **换模型后旧向量不清** — 记忆 id 没变 → 一条都不重嵌 → 库里留旧模型的向量,
  结果是**错的**而非噪声;连带 `MemoryVectorStore` 那套「模型变化→清空重建」的逻辑
  **永不触发**(它只在 upsert 时检查,而 upsert 被跳过)
- **一条 NaN 毒死整个索引** — `upsert` 现拒收含 NaN/Infinity 的向量
- **契约与实现不一致** — `recall` 的签名说没有 `useVector`,实现却在读
  (类型说没有、运行时说有)→ 修掉一条存量 typecheck 错误(30 → 29)
- **provider→model 映射抄了两份** — 分叉的后果是「配置说是真向量、实际走 stub」,
  且用户完全看不出来。现单一真源

### 🔀 混合检索(M3-B)

真向量接上后的检索质量硬伤,两条都**只在中文上暴露** —— 而这是国产中文桌面助手。

- **中文终于被分词了** — 原实现按空格/标点切,「用户习惯把桌面上的 PDF 文档统一归档」
  被切成三个词条,整句成词条 → 只有字面完全一致的长句才匹配得上,改写一个字就召不回。
  现按 CJK 连续段切**字符 bigram**(无词典的标准做法),中英混排先分段
- **融合方式改为 RRF** — 原实现对两路**取分数最大值**,而两路量纲完全不同
  (关键词=覆盖率 ∈[0,1],向量=余弦 ∈[-1,1]):弱字面命中能盖过语义高度相关的结果,
  两路都命中的(最该排前面的)还得不到加分。现只看名次(k=60):量纲无关 + 双路一致加成
- **实测(本地 ollama bge-m3)** — 改写查询集上关键词路 top-1 命中 **0/6 → 1~2/6**;
  混合查询集上 混合(RRF) 7/8 = 纯向量 7/8
  (诚实结论:分词是可测量的改善;RRF 在命中率上持平,它的价值是结构性的 ——
  故测试断言**性质**而非命中率)

### 📊 验证

vitest 114 files / 1367 passed / 0 FAIL · vue-tsc 0 error · 后端 tsc 29(= 修掉 1 条存量后的基线)

## [4.5.0-alpha] - 2026-08-06 (LlmAgentBrain v0.1 + MCP PoC + P0 安全,M1)

> M1 阶段总评 6.5/10 → 7.5/10 (verifier CONDITIONAL PASS)
> 仅供内部 dogfooding,不可 ship 给 GitHub 公开用户(剩 P0-2/3/4 阻塞)

### 🆕 AI 核心能力 — LlmAgentBrain v0.1 跟 ClaudeCode 对齐

**commit `dc35b3c`** — 15 files, 1850 insertions

| 5 工具 (跟 ClaudeCode 同款) | 用途 |
|---|---|
| Read | 读文件,路径强制 sandbox/workspace |
| Edit | 精确编辑 (old_string + new_string, 失败回滚) |
| Bash | 跑命令,execFile 数组传参 + 60+ 白名单 |
| Glob | 文件匹配 (pattern, cwd?) |
| Grep | 内容搜索 (pattern, cwd?, include?) |

- 多轮 tool call loop (max 10 轮, 防死循环)
- 9 类事件总线 (run_start / iteration / tool_call / tool_result / content_delta / thinking_delta / final_answer / run_error / run_aborted)
- abortRun (供 IPC 中止)
- 路径沙箱强制 (拒 `~/.ssh` / `C:\Windows\System32`)
- LLM 抽象统一: LlmClient + 4 provider + streamChat SSE

### 🆕 MCP 协议集成 — Anthropic Model Context Protocol 子集

**commits `1c9bdd3` ... `fb1e957`** — 5 commit, PoC 14/14 真链路测试通过

- stdio transport (JSON-RPC 2.0 over newline-delimited)
- filesystem server (5 工具: list_directory / read_file / write_file / search_files / get_file_info)
- McpManager (多 server 编排: start / stop / listAllTools / invoke / invokeByName)
- 8 个新 IPC channel: mcp:start-server / stop-server / start-all-enabled / stop-all / list-servers / list-tools / list-tools-by-server / invoke

### 🔒 P0 安全 6 项全修 (5 洞 + P0-1 forceReset 重做)

| # | 洞 | Commit | 状态 |
|---|---|---|---|
| 1 | OpenClawServer CORS `*` | `53047f7` | ✅ 默认拒绝跨域, 白名单 127.0.0.1 |
| 2 | 18789 端口无 token | `efe4102` | ✅ 256-bit token + safeStorage + Bearer 鉴权 |
| 3 | `runCommand` shell:true | `4bf0845` | ✅ execFile 数组传参 + 60+ 白名单 + cwd 沙箱 |
| 4 | `forceResetToPermissive` 覆盖用户选择 | `feec4a1` + `309375d` | ✅ 5 步完整重做 + 老 config migration (`b5ff363`) |
| 5 | `SkillSigner` 硬编码 HMAC | `4f182df` | ✅ safeStorage 持久化, 不再硬编码 |

**老用户 migration 真根因 (3 层, commit `b5ff363`)**:
v4.3.0 的 `activeSetId="preset_permissive"` 升级后无 migration 仍 permissive,
且 dev mode 下 `app.getVersion()` 返 electron 版本 30.5.1 导致比较 bypass。
修法:`loadConfig` 加 migration + `saveConfig` 用 `getAppVersion()`(dev fallback 读 package.json)。

### 📊 评分

| 维度 | v4.4.0 | v4.5.0-alpha | 提升 |
|---|---:|---:|---:|
| 总评 | 6.5/10 | **7.5/10** | +1.0 |
| AI / Agent | 4.0/10 | **6.5/10** | +2.5 |
| LLM 抽象 | 4.5/10 | **7.0/10** | +2.5 |
| MCP 集成 | 0/10 | **5.0/10** | +5.0 |
| 安全 | 3.0/10 | **6.5/10** | +3.5 |

### ⚠️ 已知限制

- 不带 cost tracking + 不带 zod schema 校验 (留 M1.1 / M2)
- 内部 dogfooding only,公开 GitHub 等 M2 修完 P0-2 (HMAC→Ed25519) / P0-3 (LlmClient ollama 副作用) / P0-4 (d5:run builtin bug)

## [4.4.0] - 2026-08-05 (P0 安全 + v4.4 视觉精简)

> 5 agent 团队架构审计总评 6.5/10 → 8.0/10 (verifier CONDITIONAL PASS)
> 安全子维度 3.0/10 → 6.0/10 (P0 修完)
> 仅供内部 dogfooding,不可 ship 给 GitHub 公开用户

### 🔒 P0 安全 5 洞全修 (5 commits, 7 文件改动)

| # | 洞 | Commit | 关键改动 |
|---|---|---|---|
| 1 | OpenClawServer CORS `*` 跨域放开 | `53047f7` | 默认拒绝跨域,白名单 127.0.0.1 + Electron 协议 |
| 2 | 18789 端口无 token 鉴权 | `efe4102` | 256-bit token + safeStorage;Bearer / X-OpenClaw-Token 双头 |
| 3 | `runCommand` shell:true 命令注入 | `4bf0845` | execFile 数组传参;60+ baseCmd 白名单 |
| 4 | `forceResetToPermissive` 覆盖用户选择 | `feec4a1` | 加 env 开关;生产环境尊重用户选择 |
| 5 | `SkillSigner` 硬编码 HMAC key | `4f182df` | safeStorage 启动加载/生成 key |

**影响**: 同机恶意软件 / 恶意网页 / 跨进程攻击者再也不能直接
`curl 127.0.0.1:18789/execute` 拿到执行权。

### 🎨 v4.4 视觉精简 (Linear/Raycast 路线)

- **#1 icon 系统** `dfb789c` — 全 app emoji → Element Plus SVG icon (100+ 处)
- **#2 Settings 重做** `705d778` + `2b489af` — el-tabs → 自定义 nav + 2 列 grid
- **#3 SideNav 60px rail** `2e51678` + `4040908` — icon-only rail
- **#4 TitleBar 删 theme 切换** — 主题切换统一放 Settings

### 📊 测试覆盖

- 单元: 897/916 (97.93%)
- e2e: 25 文件 + 5 个新 P0 安全 spec
- smoke: 22/22
- **user-journey-ollama: 31/31 pass** (本地 Ollama 11434 + qwen3.5:9b 真链路)

### ⚠️ 已知 P0 阻塞 (9 项)

forceReset 深度重做 / HMAC 升 Ed25519 + TOFU / LlmClient ollama 副作用 /
d5:run builtin bug / file path 沙箱 / 未知 op 默认 deny /
SkillLoader 强制 verify / ToolRegistry 路径细粒度 / IPC zod schema 校验

## [4.3.1] - 2026-07-24 (Ship-Ready 真用户测试套件)

从 v4.3.0 基础上,模拟真实用户跑 64 个 e2e + 869 个 unit + 22 个 smoke,验证
生产 build 成功。PiPiClaw v4.3.x 现已 ship-ready。

### v4.3.x 真用户测试累计(8 个测试阶段)

| 阶段 | 场景 | 文件 |
|------|------|------|
| T+0 新用户首次启动 | 17 | tests/e2e/user-journey.spec.ts |
| T+30 daily chat | 9 | tests/e2e/daily-chat.spec.ts |
| T+60 models CRUD | 8 | tests/e2e/models-crud.spec.ts |
| T+60 chat 真链路 send/receive | 3 | tests/e2e/chat-real-send.spec.ts |
| T+150 长对话历史 | 5 | tests/e2e/chat-long-conversation.spec.ts |
| T+240 ClawHub 技能市场 | 6 | tests/e2e/clawhub-browse.spec.ts |
| T+270 拖拽文件 | 5 | tests/e2e/file-drag-drop.spec.ts |
| T+300 主题切换 | 7 | tests/e2e/theme-toggle.spec.ts |
| T+420 状态持久化 | 4 | tests/e2e/restart-persistence.spec.ts |
| **累计新增 e2e** | **64** | **+ 36 已有 = 100 总计,23 dev-only skipped** |

### 真用户测试发现并修复的真问题

1. **sidebar "新建对话" Plus 按钮无文字/无 title** (`04d94ee`)— 用户创建
   第一个会话后,空状态大按钮消失,只剩角落小 Plus 图标无任何提示
   → 加 title + aria-label + 文字"新建"
2. **Element Plus dialog 关闭后 DOM 残留** — 测选用 .el-dialog:visible
   伪选择器,只对真正可见 dialog 计数
3. **TitleBar 主题按钮 title 双向依赖状态** — 测试改用 .theme-toggle
   class(稳定)+ aria-label 兜底
4. **现有 conversation 无 providerId 时 model select 不会自动选** — 已知
   UX gap,需要手动选 provider 才能发消息(R2 测试覆盖)
5. **Playwright Electron userDataDir 在 Windows + Electron 30 被忽略** —
   app 实际写 %APPDATA%/Electron/(productName 默认),不是 Playwright 路径
6. **app 实际 schema 写顶层 theme,不是 app.theme** — v4.2 重构遗留:
   cfg.app.theme 永远 'dark'(默认),用户实际选择写到 cfg.theme(顶层)

### 验证清单

- vitest 869/869 ✅ (从 v3.0.0 末期 486 → +383)
- e2e 64 passed + 23 skipped(dev-only 路由)✅
- smoke 22/22 ✅
- vue-tsc / eslint 0 errors ✅
- **production build success** ✅
  - `release\PiPiClaw-4.3.0-Setup.exe` 95.9 MB
  - NSIS installer + win-unpacked folder
  - electron-builder 26.15.7 / Electron 30.5.1 / Node 22.16.0

### 推荐部署

用户可执行 `npm run build` 生成 Setup.exe。已验证本地 Ollama 11434 端到端
send/receive 工作(qwen3.5:9b 速度冠军, gpt-oss:20b 高质量)。

## [4.3.0] - 2026-07-24 (真用户测试驱动修复)

模拟真实用户跑 Ollama 本地模型(11434 端口),从测试中发现 5 个真问题,逐个修。

### Fixed (P0 真 bug)
- **LlmClient 透传 tool_calls** (`commit 603e7ed`):
  - OpenAI adapter 解析 `choices[0].message.tool_calls` → 暴露 `LlmResponse.toolCalls`
  - 支持 `req.tools` / `req.toolChoice` 透传
  - Agent / Function Call 场景可用
  - 真链路验证(ollama qwen3:14b):模型真发出 `get_weather({"city":"北京"})`,PiPiClaw 解析正确
- **OpenAI adapter 兼容 Ollama thinking mode** (`commit 34eb72f`):
  - qwen3 / qwen3.5 / DeepSeek-R1 / gpt-oss 等 reasoning 模型,content 可能是空,实际答案在 `message.reasoning`
  - 加 fallback: `content ?? reasoning`
  - max_tokens 默认 2048 → 4096

### Added
- **ThinkingBlock 组件** (`commit 7f7e629`):Claude 3.7 Sonnet Extended Thinking 风格
  - 默认折叠,1-click 展开
  - 三种状态(已思考/思考过程/正在思考)
  - 展示 duration + tokens
  - 主题感知 + 无障碍 aria-expanded
- **多模型 benchmark 脚本** (`commit e9d1363`):5 场景 × 4 模型横向对比
  - qwen3.5:9b 是日常对话冠军(23s 总)
  - gpt-oss:20b 适合复杂任务
  - qwen3:14b / large 不推荐(慢)
- **Ollama 适配经验文档** (`commit ee0b8ee`):`docs/llm-quirks.md`
  - 5 个已知坑(thinking 吞 token / think 协议不生效 / 多轮短 ctx 失败等)
  - 推荐配置(用户日常 / 复杂任务)
- **Ollama 宕机降级验证** (`commit 676552f`):6 场景真链路
  - 端口不可达 / 协议不对 / 黑洞地址 / 空 apiKey / 模型不存在 / provider 未启用
  - 全部返回结构化 ok:false + 友好 error

### Stats
- 68 test files / **869 unit tests** (从 863 → +6)
- lint 0 / vue-tsc 0 / build success
- main.js 444KB → 446KB (+2KB 适配器增强)
- 真用户测试跑出 5 个问题,全修

## [4.2.0] - 2026-07-24 (UX 全面升级 — 超越 Claude/Hermes)

### Added (P5-UX)
- **CommandPalette (Cmd+K / Ctrl+K)** (`src/components/common/CommandPalette.vue`):
  - 全局命令面板,4 类命令(提示词 / 动作 / 页面 / 最近)
  - 智能模糊搜索(强匹配 + 字符顺序)
  - 6 个内置 prompt 模板(日报 / 审查 / 翻译 / bug / 头脑风暴 / 周报)
  - 4 个动作(切主题 / 重新加载 / 开发者工具 / 清缓存)
  - 13 个页面导航入口
  - 最近使用 localStorage 持久化
  - 键盘导航:↑↓ / ↵ / esc
  - Teleport 到 body + scale 渐入动画
- **UpdateBanner** (`src/components/common/UpdateBanner.vue`):
  - 顶部非阻塞更新提示
  - 3 状态:info(有新版) / success(已下载) / error(5s 自动消失)
  - 完整 releaseNotes 渲染(字符串 / 数组 / 对象)
- **Chat 空状态重设计**:
  - 时间感知问候(早/午/晚/深夜)
  - 6 个 prompt 模板卡片(响应式 grid)
  - 3 个主 CTA(新建对话 / 配置模型 / 命令面板)
  - 智能 warning banner(无模型配置时)
- **SideNav 修夏**: 加 3 个核心入口(ClawHub / 模型对比 / IM 管理),移除 2 个 dev demo
- **ImManagement Skeleton 接入**: 初次加载 6 个 Skeleton 卡片(替代白屏)
- **路由 devOnly 守卫**: D1/D2/D3/D5/A5 demo 路由生产重定向到 /dashboard

### Changed
- **主题系统重构 (v4.1.1 → v4.2.0 累计)**:
  - 5 套彩色主题 → 2 套极简主题 (Tare 浅色 + Cursor 深色)
  - 单一源真相 `data-theme="light|dark"`
  - Element Plus 主题变量全同步
- **tokens.css** (重写) — 完整语义化 token + Element Plus 同步
- **variables.scss** (简化) — 只留 SCSS 编译期变量
- **global.scss** (重写) — 530 行 !important → 200 行 semantic
- **App.vue** (简化) — 移除暖科技 radial-gradient 泄漏
- **AppLayout** 加 route-fade transition + 全局 toast 事件

### Stats
- 65 test files / **842 unit tests** (从 782 → +60)
- lint 0 / vue-tsc 0 / build success
- 新增 4 个组件:CommandPalette / UpdateBanner / Skeleton / ThemeToggle
- 命令面板 + 智能空状态 = 新用户 1 分钟 a-ha moment

## [4.1.0] - 2026-07-23 (竞品差距优化)

聚焦"IM 集成 / 技能生态 / 模型支持"三大竞品差距,IM 5→8/10,技能 4→7/10,模型 7→8/10。

### Added (P0 IM 配置 + 状态 + 消息 + 文件)
- **IM 配置面板** (`src/views/ImManagement.vue`):11 平台卡片 + 5-tab (配置/状态/消息/规则/权限)
- **IMMessageStore.getStats()** + IPC `channel:message-stats` / `channel:message-history`
- **FileTransferManager** 6 平台 (feishu/dingtalk/wechat-work/telegram/slack/discord) +
  IPC `file:upload-to-im` / `file:list-supported-platforms`
- **IMConfigStore / IMMessageStore / FileTransferManager** 单测覆盖(15+14+12)

### Added (P0 路由规则 + 权限管理)
- **IMMessageRouter 真实集成** (IPC `routing:list/add/remove`)
- **IMPermissionManager.listAll** + IPC `permission:list` 接入 ImManagement
- 8 个 IMMessageRouter 单测覆盖

### Added (P1 Discord + WhatsApp 真实集成)
- **DiscordChannel** 真实 REST API (validateToken/send/listMessages/pollMessages/healthCheck)
- **WhatsAppChannel** 真实 Cloud API (validateToken/send/markAsRead)
- 17+12 个 channel 单测

### Added (P1 ClawHub 技能市场)
- **ClawHubManager** publish/review/search/rate
- IPC `clawhub:publish`/`review`/`search`/`rate`/`list-pending`
- **ClawHub.vue** 3-tab 浏览/发布/审核
- 22 unit + 11 view tests

### Added (P1 模型对比 + 社区评分)
- **ModelRatingManager** rate/listForModel/getStats
- **ModelCompare.vue** 10 模型 / 4 排序 / 评分弹窗
- IPC `model:rate`/`list-ratings`/`get-stats`
- 12 unit tests

### Added (P2 权限 JSON 导入/导出)
- **IMPermissionManager** listAll/exportToJson/importFromJson/clearAll
- IPC `permission:export`/`permission:import`
- 18 unit tests (replace/merge/clear 三种模式)

### Added (P2 模型使用量排行)
- **ModelUsageTracker** record/getTop/getTotal
- IPC `model:usage-record`/`usage-top`/`usage-total`
- ModelCompare.vue 新增"使用量排行"Tab
- 13 unit tests

### Added (P2 IM 消息快捷回复)
- **channel:send** 真实调用 ChannelRouter.send(替代 stub)
- ImManagement.vue 消息查看器行可点击 + 6 个内置回复模板
- 9 unit tests for ChannelRouter + 10 view tests for ImManagement

### Added (P2 ClawHub 技能模板市场)
- **ClawHubTemplate** 6 个内置模板(每日总结/代码审查/周报/会议纪要/翻译/Bug 分流)
- **ClawHubManager.instantiateTemplate()** 写模板内容到 userData/templates/<id>/skill.md
- IPC `clawhub:list-templates`/`get-template`/`list-template-categories`/`instantiate-template`
- ClawHub.vue 新增"技能模板"Tab(响应式卡片网格 + 一键实例化弹窗)
- 13 unit + 11 view tests

### Stats
- **61 test files / 782 unit tests** (从 v4.0.0 末期 571 → +211)
- **lint 0 / vue-tsc 0 / smoke 22/22 / e2e 9 files 36 tests**
- 5 个新 commits:cf518cb / 5ae95c9 / d865351 / 6d9f655 / c7b97c4 / 404c368 / 1fd7ee3 / c4f5419 / 5dea698

## [4.0.0] - 2026-07-23 (100% Production-Ready)

P0-P5 全部完成。PiPiClaw 从 60% → 89%(未达 100% 是需要 1+ 周真实使用 / 证书 / pipeline)。

### Added (P5-T5.4)
- **CrashReport 收集器** (`electron/insight/CrashReport.ts`):process 级
  uncaughtException + unhandledRejection 监听,JSON 落盘 userData/crash-reports/,
  包含 timestamp / type / error{name,message,stack} / appVersion / platform / arch / nodeVersion / uptimeMs / context
- **CrashReport IPC** (4 个 channel):crash:list / crash:get / crash:clear / crash:count,
  preload 暴露 `window.electronAPI.taskLog.crashList/...`

### Added (P4-T4.2)
- **错误人话化** (`src/utils/humanizeError.ts`):9 类错误模式
  (network / auth / permission / rate-limit / config / not-found / oom / unknown)
  → 用户能懂的中文 + hint + action(route 跳转)

### Added (P3-T3.1)
- **FileOrganizer production 化** (`electron/automation/FileOrganizer.ts`):
  categorizeByExtension(9 类) + organizeDirectory(scan + move + 同名 + dryRun + 跳过 sorted/)
  → "整理下载文件夹" 真可用

### Added (P2 Hermes 2.0 架构验证)
- **HermesMemory** 8 个 integration test:store / recall / buildMemoryPrompt / 落盘 USER.md + MEMORY.md
- **SelfLearner** 9 个 integration test:observeExecution 去重 / saveSkillFromProposal 落盘 / SkillLoader 热加载

### Added (P1-T1.2 + T1.4)
- **sandbox-validation.mjs** 三阶段验证器(offline 4 模板 + 3 runtime + docker hello-world)
- **mock-llm-server.mjs** OpenAI chat/completions 兼容 mock server
- **sandbox-templates.test.ts** 4 模板 build 验证(offline, 5s 内)
- **llm-mock-server.test.ts** 4 集成测试验证 LlmClient 真 HTTP round-trip

### Added (P1-T1.1)
- **d3-demo.spec.ts** 真实 /d3-demo UI 挂载验证(替代原 placeholder d3-feishu)

### Removed (P1-T1.1)
- 6 个 placeholder e2e spec(d2prime-docker-missing/oom/port-conflict/screenshot/d3-feishu/insight-trace)
  均有 unit/integration 覆盖,placeholder 无价值

### Fixed
- `test.skip` 位置:统一在 describe 顶部(原 d2prime-30s 在 test 体内 skip,fixture 解析先抛错)
- hash router Playwright 导航:`window.goto('#/route')` 改用 `window.location.hash` + `waitForURL`
- SelfLearner 路径 mock:让 `getAppPath() + '/../skills'` 解析到 `userData/skills`

### Verified
- `npm run lint`: 0 errors, 0 warnings
- `npx vue-tsc --noEmit`: 0 errors
- `npx vitest run`: **48 files / 571 tests passed** (P0 末期 486 → +85)
- `npm run smoke`: 22/22 passed
- `E2E_ELECTRON=1 npx playwright test`: **34 passed, 2 skipped, 0 failed** (1.5min)
- `npm run build`: Windows .exe OK
- `node scripts/sandbox-validation.mjs`: Stage 1 100%

### Retros
- `docs/superpowers/retros/2026-07-23-p0-engineering-discipline.md`
- `docs/superpowers/retros/2026-07-23-p1-routes-and-sandboxes.md`
- `docs/superpowers/retros/2026-07-23-p2-hermes.md`(本版合并到 v4-100pct)
- `docs/superpowers/retros/2026-07-23-p3-openclaw.md`(同上)
- `docs/superpowers/retros/2026-07-23-p4-ux.md`(同上)
- `docs/superpowers/retros/2026-07-23-p5-distribution.md`(同上)
- `docs/superpowers/retros/2026-07-23-v4-100pct.md`(总收尾)

### Known Limitations
- T2.5(1 周真实用户回放)需 1+ 周使用
- T3.2 (D1 截屏问答) / T3.3 (D5 录屏转技能) 已有 demo,production 化需更多工作
- T4.3 性能优化 / T4.4 暗色模式实际主题 / T4.5 多窗口未做
- T5.1 code signing(需 EV cert)/ T5.2 GitHub Releases pipeline(需真 certs + token)
- T6.2 Beta 试用 5 个非开发者未做
- T0.1 推送 174 commit(无 GitHub PAT)

## [3.1.0] - 2026-07-23 (P1: 14 路由 × 7 沙箱)

### Added
- **7 个 sandbox runtime 验证** (P1-T1.2):
  - `tests/integration/sandbox-templates.test.ts` — 4 个 SandboxBuilder 模板
    (vite-react-ts / nextjs-app / fastapi / go-http) build 验证,5s 内 fileCount + 关键文件 size > 0
  - `scripts/sandbox-validation.mjs` — 三阶段验证编排器
    (Stage 1: offline 4 模板 / Stage 2: 3 runtime unit / Stage 3: docker hello-world)
  - `docs/perf/sandbox-validation-2026-07-23.md` + `.json` — 月度归档报告
  - `npm run sandbox:validate` 入口
- **LLM 真实链路验证** (P1-T1.4):
  - `scripts/mock-llm-server.mjs` — OpenAI chat/completions 兼容 mock server
    (端口 9999,返回 `MOCK_LLM_OK_<n>_*` marker)
  - `tests/integration/llm-mock-server.test.ts` — 4 个 test 验证
    真实 HTTP round-trip:health + chat/completions + LlmClient 全链路 + 错误路径
- **d3-demo UI 验证** (P1-T1.1): 新增 `tests/e2e/d3-demo.spec.ts`,
  替代原 placeholder d3-feishu,2 个 test 验证 /d3-demo 挂载 + 5 步流程卡

### Removed
- **6 个 placeholder e2e spec** (P1-T1.1): d2prime-docker-missing / oom / port-conflict /
  screenshot / d3-feishu / insight-trace — 均有 unit/integration 覆盖,placeholder 无价值

### Fixed
- **d2prime-30s.spec.ts skip 位置** (P1-T1.1): `test.skip(!shouldRunElectronE2E, msg)`
  移到 describe 顶部,避免同 describe 内其他 test 在 fixture 解析阶段先抛错
- **hash router Playwright 导航** (P1-T1.1): `window.goto('#/route')` 改用
  `window.evaluate(() => { window.location.hash = '#/route' })` + `waitForURL`

### Verified
- `npm run lint`: 0 errors, 0 warnings
- `npx vue-tsc --noEmit`: 0 errors
- `npx vitest run`: **42 files / 496 tests passed** (P0 末期 486 → +10)
- `npm run smoke`: 22/22 passed
- `E2E_ELECTRON=1 npx playwright test`: **34 passed, 2 skipped, 0 failed** (1.5min)
  (无 placeholder,active spec 全跑通)
- `npm run build`: 0 errors, Windows installer OK
- `node scripts/sandbox-validation.mjs`: Stage 1 1/1 100%

## [3.0.1] - 2026-07-23 (Hotfix)

### Fixed
- **SideNav 完全 broken**(v3.0.0 GA 严重回归): `src/main.ts` 缺 `app.component()` 全局注册
  `@element-plus/icons-vue`,导致 `<component :is="iconName">` 在 SideNav 渲染空元素
- **Vue 运行时 CSP 拦截**: `index.html` 的 script-src 缺 `'unsafe-eval'`,
  Vue 生产构建用 `new Function()` 抛 CSPViolationError,导致 #app 节点为空
- **WindowManager dev/prod 路径错乱**: e2e 测试下 `isDev = !app.isPackaged` 永远为 true,
  会去找 vite dev server (localhost:5173),加 `PIPICLAW_E2E` env 兜底
- **侧栏窗口被压时塌缩**: SideNav 加 `min-width: 180px` 兜底

### Added
- **CI hard-fail 守卫**: build 后 grep 验证 dist/index.html 含 `unsafe-eval` CSP + bundle
  含 5 个关键 element-plus 图标组件名 (ChatDotRound/HomeFilled/Setting/Box/Cpu)
- **e2e fresh userData**: 每次 playwright run mkdtempSync 一个新 userData 目录,
  通过 Playwright `userDataDir` 传给 Electron,避免 localStorage 跨 spec 污染
- **RELEASE_CHECKLIST.md** (docs/release/): 7 步必过清单,
  堵 v3.0.0 "主导航 broken 还能 release" 的口子
- **e2e locale-aware selectors**: chat-agent/settings-p7/a5-computer-use 全部改成中英文都匹配,
  修 Playwright 默认 en-US 下跑挂的问题
- **3 个新 e2e**: ui-smoke (14 nav 导航 + chat 输入 + 语言切换), diag-launch / diag-sidenav
- **100% product completion plan** (docs/superpowers/plans/2026-07-23-100pct-product-completion-plan.md):
  P0-P6 路线图,目标 v4.0.0 Production-Ready

### Verified
- `npm run lint`: 0 errors, 0 warnings
- `npx vue-tsc --noEmit`: 0 errors
- `npx tsc --noEmit`: 0 errors
- `npx vitest run`: **40 files / 486 tests passed**
- `npm run smoke`: 22/22 passed
- `E2E_ELECTRON=1 npx playwright test` (active specs): **15/15 passed**
  (chat-agent 4 + settings-p7 4 + a5-computer-use 3 + ui-smoke 4)
- `npm run build`: 0 errors, 91.44MB Windows installer
- Build artifact self-check: CSP fix present + 5 critical icons bundled

## [3.0.0] - 2026-07-22 (GA)

### Added
- **Vue i18n 全量接入** (Phase 5): vue-i18n 9.14.5 + 12 namespace (270 keys × 2 locale),8 个 view + 1 layout 组件 i18n 化,SideNav 语言切换器 + localStorage 持久化
- **性能基准脚本** (Phase 5): scripts/perf-benchmark.mjs 4 维度 (build 性能 / IPC surface / bundle size / SSE 延迟),docs/perf/baseline.md 自动生成
- **公开文档站点** (Phase 5): docs/site/ 完整结构 (9 markdown) + 25 FAQ + 8 domain how-to + 18 troubleshooting + architecture/ 3 docs + contributing
- **文档守护测试** (Phase 5): tests/unit/docs-structure.test.ts 20 case,防止 documentation rot

### Verified
- `npm run lint`: 0 errors
- `npx vue-tsc --noEmit`: 0 errors
- `npx tsc --noEmit`: 0 errors
- `npx vitest run`: **39 files / 481 tests passed**
- `npm run smoke`: 22/22 passed
- `npm run perf`: 8 指标实测 + 阈值对比

### Known Limitations
- Chat.vue (83 KB) 主聊天消息区仍部分硬编码中文 — namespace 已预留,后续 i18n 化
- 部分 demo 视图 (A5/D2/D3) 保留中文硬编码(plan 允许)
- 性能基准 SSE mock 留 stub(需要真 LLM server)
- macOS / Linux build 需 CI runner 验证(本地只能验配置完整性)
- 6 个 placeholder e2e spec 需凭证或外部资源 (d3-feishu / docker / sandbox)
- 性能基准未接入 CI hard-fail(波动大,仅供本地对比)

## [2.1.0] - 2026-07-22

### Added
- **macOS dmg + Linux AppImage build** (Phase 4): electron-builder.json5 加 mac (x64+arm64) 和 linux (x64 AppImage) target,3 平台图标生成脚本 `npm run icons`
- **Electron auto-update** (Phase 4): electron-updater ^6.8.9 集成,AutoUpdater.ts 自动检查 / 下载 / 提示重启,Settings.vue "关于" tab UI,GitHub publish provider 配置
- **真 e2e 测试** (Phase 4): 4 个核心 spec 从 placeholder 改为真 Playwright Electron 测试 (chat-agent / settings-p7 / a5-computer-use / d2prime-30s),6 个 placeholder spec 明确 skip 原因,docs/e2e-testing.md
- **端到端冒烟测试** (Phase 4): `npm run smoke` 22 项检查(< 10ms),验证 build 产物 / 配置完整性 / IPC surface / 源码完整性,CI step hard-fail
- **dist-electron/main.js 含 107 个 ipcMain.handle** (实测): IPC server 桥接层厚度

### Verified
- `npm run lint`: 0 errors / 0 warnings
- `npx tsc --noEmit`: 0 errors
- `npx vue-tsc --noEmit`: 0 errors
- `npx vitest run`: **37 files / 456 tests passed**
- `npm run smoke`: **22/22 passed**

### Known Issues
- macOS / Linux build 需要对应平台 CI runner(Windows 上不能 cross-build)
- electron-updater 首次启动会 checkForUpdates 失败(无 latest.yml),本地 dev 用 `PIPICLAW_SKIP_UPDATE_CHECK=1` 跳过
- 4 个真 e2e spec 需要 `E2E_ELECTRON=1` 主动启用,CI 默认 skip

## [2.0.3] - 2026-07-21

### Added
- **electronAPI 类型补全** (Phase 2): src/types/api.d.ts 23 namespace 用 ?: any 兜底,前端可拿准确类型
- **chat store 8 个 task 字段** (Phase 2): executingTask / currentTaskResult / isGenerating / showTaskConfirmDialog / pendingTaskPlan / cancelExecuteTask / confirmExecuteTask / setSearchKeyword

### Fixed
- **vue-tsc 52 → 0 errors** (Phase 2): 全量 strict 通过,CI hard-fail
- **marked v18+ 移除 highlight 字段** (Phase 2): Chat.vue 改用 marked.use({ renderer })
- **store 重声明 isGenerating** (Phase 2): chat store 字段去重
- **McpServerCard args 模板 narrowing** (Phase 2): 改 computed
- **McpServerFormDialog FormInstance 导入路径** (Phase 2): 从 element-plus 而非 vue

### Changed
- **CI vue-tsc 升 hard-fail** (Phase 2): .github/workflows/ci.yml 去 soft-fail
- **store 字段补全**: chat MessageStatus 加 'stopped' / models ModelInfo 加 connected / openclaw OpenClawRequest 加 resource

### Verified
- `npm run lint`: exit 0, 0 errors / 0 warnings
- `npx tsc --noEmit -p tsconfig.node.json`: exit 0
- `npx vue-tsc --noEmit`: **0 errors** (Phase 1 时 52 errors)
- `npx vitest run --reporter=dot`: 192/192 passed (22 test files)
- `npm run build`: electron-builder 成功生成 release/PiPiClaw-2.0.3-Setup.exe

### Known Issues
- src/views + src/stores coverage 0%(留给 Phase 3 Task 4-5)
- electron/llm coverage 0%(留给 Phase 3 Task 6)
- LLM 流式 token-by-token 推送链路断一环(留给 Phase 3 Task 1)
- TaskExecutor 业务执行 stub(留给 Phase 3 Task 2)
- apiKey 明文存盘(留给 Phase 3 Task 3)
- E2E 全 placeholder(留给 Phase 4 Task 3)

## [2.0.2] - 2026-07-17

### Added
- **ESLint flat config**: 完整 lint 规则(typescript-eslint + eslint-plugin-vue),`npm run lint` 真生效
- **playwright.config.ts**: 正式 e2e 配置,支持 CI 与本地双模式,加载 10 spec / 20 test case
- **CI hard-fail**: `npm run lint` / `npm run build` 改为 hard-fail(失败即红);vue-tsc / sandbox / e2e 保留 soft-fail 并标注 Phase 来源
- **scripts/ 辅助脚本进 git**: `check-routes.mjs` / `demo-probe.mjs` / `demo-screenshots.mjs` / `sass-probe.mjs` / `screenshot.ps1`
- **新 unit tests 进 git**: ChatManager / DockerDetector / NetworkPolicy / ResourceLimits / SandboxBuilder / Workspace (6 个 test 文件)
- **src/shims.d.ts 进 git**: 解决 `vue-i18n` / `element-plus/dist/locale/*.mjs` 模块声明缺失
- **docs/CHANGELOG-INDEX.md**: 7 retro + 7 plan + 4 spec 统一索引
- **README 同步**: LLM provider 改为 OpenAI/Anthropic/智谱 GLM 3 种(删除 Azure/Ollama 占位),加 `/settings/llm-config` 与 `/settings/im-accounts` 路由说明,加 P7 沙盒与 retro/plan 链接

### Changed
- **.gitignore 扩展**: `tsc-*.txt` / `test-*.txt` / `lint-step*.txt` / `vtsc-step*.txt` / `vitest-step*.txt` / `.smoke-tmp/` 进忽略列表

### Verified
- `npm run lint`: exit 0, 0 errors / 104 warnings
- `npx tsc --noEmit -p tsconfig.node.json`: exit 0
- `npx vitest run --reporter=dot`: 192/192 passed (22 test files)
- `npx playwright test --list`: 10 spec loaded / 20 test cases
- `npx vue-tsc --noEmit`: 41 errors(soft-fail,已 de-scope 到 Phase 2 follow-up)

### Out of Phase 1 scope
- vue-tsc 0 错完整修复(留给 Phase 2,需回填 stores 字段 + 扩 types)
- WebContainerRunner renderer 真接(Phase 2)
- LLM SSE 流式输出 / Provider fallback(Phase 2)
- Hermes 自我学习 AutoCreator 闭环(Phase 3)
- LlmConfigStore / IMConfigStore safeStorage 加密(Phase 3)
- 真实 docker e2e CI(Phase 4)
- coverage > 70%(Phase 3)

## [2.0.1] - 2026-07-17

### Fixed
- **Vue 整体白屏**:`src/styles/tokens.css` 嵌套注释触发 sass 500,移除嵌套 `/* */` 后 Vue app 恢复渲染
- **ImAccounts.vue loadConfigs 索引错误**:`IMConfigStore.list()` 返回数组,旧代码当对象用导致索引 undefined,改为 `configs.find(c => c.channelKind === ...)`
- **5 demo 是 W5-W8 阶段前端 stub**:D1/D2/D3/D5/A5 5 个 view 加 IPC wiring 调 main 进程的 `runD1/runD2Prime/runD3/runD5/runA5`,从假数据 → 真链路

### Added
- **B 子项目 IM 配置 UI**:`ImAccounts.vue` + `/settings/im-accounts` 路由 + IpcServer `channel-config:get/save/test` 3 handler + preload `electronAPI.channelConfig.{get, save, test}` 暴露
- **ngrok-setup.md 引导文档**:6 步骤齐(安装 / 账号 / 启动 / IM 平台配 / 验证)
- **B 准备就绪 retro**:`docs/superpowers/retros/2026-07-16-b-im-account-integration/ready-verification.md` 含 7 步凭证补全流程

### Verified
- Plan C 真实环境验证:P7 沙盒闭环(镜像 build + SandboxBuilder + PortForwarder + L1 + Lifecycle)
- Plan A 真实环境验证:5 demo 截图归档(v2.0.1 修好前端 stub→IPC 后可正常跑)
- Plan B 真实环境验证:无凭证下所有准备工作 100% 就位,用户加凭证后能立即跑通

## [2.0.0] - 2026-07-16

### Added
- **8 capability domains**: agent / channel / computeruse / connector / contentgen / hermes / insight / sandbox
- **6 demos**: D1 screenshot QA / D2-Prime project scaffold / D3 one-line remote via Feishu / D5 recording-to-skill / A5 Computer Use / Insight trace
- **11 IM channels** (3 truly connected + 8 placeholder): feishu / dingtalk / wechat-work / wechat / qq / telegram / slack / discord / whatsapp / lark / rocket
- **P7 sandbox foundation**: dockerDetector / L1 isolation 3 platforms / workspace abstraction / base image / SandboxBuilder + 4 templates / network whitelist / resource limits / selfcheck
- **W11 preview pipeline**: WebContainerRunner + PortForwarder + proxy + JupyterRunner + SandboxLifecycle + SandboxAgentTool
- **84+ unit tests + 5 integration tests + 10 e2e specs** (W7.0 + W12)
- **CI workflow** (macos / windows / ubuntu x 7 steps)
- **release-checklist + sync-readme scripts**

### Changed
- main.ts wires 6 W3+ subsystems (W7.0 boot wiring)
- 14 view routes all reachable (W7.0.2 router complete)
- SkillManager `getSkillsDir()` unified (W7.0.4)
- 31 W1-W6 tsc errors cleared (W7.0.3)

### Deprecated
- N/A

### Removed
- 1.0.0 old `gateway/` directory

### Fixed
- ScreenVision append-only OCR / image recognition hooks (W8)
- Connector interface complete implementation (W7.4 CalendarConnector)

### Security
- SandboxL1 3 platforms L1 isolation (macOS sandbox-exec / Linux bwrap / Windows Job Object stub)
- NetworkPolicy 9 package manager mirror whitelist + 4 AI API whitelist

## [1.0.0] - Initial release
