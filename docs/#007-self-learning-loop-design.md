---
单号: #007
主题: 自学习闭环
定性: 中单（观察→分析→提案→人审门→技能落地的**加固单**，非重写）
前置: SelfLearner 既有真实现（首轮审计已证"存在且功能完整"）；本单加固而非重写
红线: main.ts / 安全链 零接触（W5 接线时解冻 main.ts 接线面）
---

# #007 自学习闭环设计稿

## 订单要点（原话摘录）
- 观察→分析→提案→人审门→技能落地，**窗口 10→100/阈值 3→10 按既定**
- SelfLearner **既有真实现**（首轮审计已证）上**加固**，不重写
- 人审门 UI 归 #007 或后置由设计稿论证
- **DEV-027（相似度去重）在 #007 接真 embedding 时一并闭环**

## 实读关键事实（file:line 级）

**F1** — `electron/learning/SelfLearner.ts:146-149`（窗口 10 既定）：
```ts
this.observations.push(observation);
if (this.observations.length > 10) {
  this.observations.shift();
}
```
→ **订单要求 10 → 100**：`> 10` 改 `> 100`（L147）。

**F2** — `electron/learning/SelfLearner.ts:158-161`（阈值 3 既定）：
```ts
if (this.observations.length >= 3 && !this.analysisInProgress) {
  this.analyzeAndGenerateSkill();
}
```
→ **订单既定阈值 3 → 10**：`>= 3` 改 `>= ANALYSIS_THRESHOLD`（L159），常量 `ANALYSIS_THRESHOLD = 10` 锁于类顶部（可注入测试）。

**F3** — `electron/learning/SelfLearner.ts:185-234`（`analyzeAndGenerateSkill` 完整链路）：
- `this.analysisInProgress` 单飞（无并发重入）
- `slice(-3)` (L196) —— 取最近 3 条做分析（**阈值改 10 后需同步扩到最近 ≥ 阈值**，见 G1 缺口）
- `this.callModelForAnalysis(prompt)` (L202) —— LLM 大模型分析（**当前调谁？需核实**，见 G2 缺口）
- `this.generateSkillProposalFromAnalysis` (L206-209) —— 生成提案
- `this.checkDuplicateSkill(proposal)` (L213) —— 去重检查（**基于 name 精确匹配**，需扩为语义去重 → DEV-027）
- `this.pendingProposal = proposal` (L219) —— 人审门挂起
- `this.notifyFrontend(proposal)` (L226) —— IPC 推送到前端

**F4** — `src/views/SkillsView.vue:30-44`（**人审门 UI 已存在**）：
```vue
<div v-if="pendingProposal" class="proposal-banner">
  <el-button type="primary" size="small" @click="handleAcceptProposal">保存技能</el-button>
  <el-button size="small" text @click="handleDismissProposal">忽略</el-button>
  <el-button size="small" text @click="showProposalDetail = true">查看详情</el-button>
</div>
```
→ **UI 三按钮已就位**（保存/忽略/详情），非缺口。待加固点：
- 无 **超时自动忽略**（用户不操作则永久挂起）
- 无 **同批多次忽略学习**（用户忽略 N 次相似提案后不再重复推）
- 无 **提案版本追踪**（同一 observation set 被拒绝后再次触发应降权）

**F5** — `electron/learning/SelfLearner.ts:602-605`（IPC 推送面）：
```ts
const windows = BrowserWindow.getAllWindows();
windows.forEach(window => {
  if (!window.isDestroyed()) {
    window.webContents.send('skills:new-proposal', proposal);
  }
});
```
→ 推送机制已就位，无缺口。

**F6** — `checkDuplicateSkill` 判重实现（`SelfLearner.ts:657-695` 实读实文，**非 name 精确匹配**）：
```ts
private async checkDuplicateSkill(proposal: SkillProposal): Promise<boolean> {
  const enabledProviders = this.modelManager.getEnabledProviders()
  if (enabledProviders.length === 0) {
    this.log.warn('[SelfLearner] 没有启用的模型，无法进行去重检查')
    return false
  }
  const skills = this.skillLoader.getAllSkills()
  for (const existingSkill of skills) {
    const prompt = `当前提案的技能触发条件：${proposal.triggerCondition}...请判断：这两个触发条件描述的是否是同一种用户意图？只回答"是"或"否"。`
    const response = await this.makeChatCompletionRequest(provider, modelId, prompt)
    if (normalized.includes('是') || normalized.includes('yes')) return true
  }
  return false
}
```
→ **事实定性**：判重机制 = **LLM 意图级语义判定**（非 name 精确，非 embedding cosine）
→ **fail-open 行为实读**：无启用模型 / LLM 调用失败 → `return false` → 走 `pendingProposal` 挂起 → 人审门兜底（UI 三按钮 `SkillsView.vue:41-43` 已在位）
→ **G4"cosine 补充"前提不成立**：现状**已是语义级**（LLM 意图级 > cosine 向量级），叠加 cosine 属双闸重复，替换则丢意图级粒度。本设计稿**撤销 G4**（详见 G4 段 + 收口段 + DEV-027 状态改写）。

**F7** — **观察来源**（`SelfLearner.observeExecution(...)` 生产调用面零命中，**实读坐实**）：
- **方法名实读**：`SelfLearner.ts:124` — `public observeExecution(instruction: string, steps: any[], _result: any): void`（**非** `observe()`，本设计稿早期"observe"写法为臆造，此处一并修正）
- **生产调用面**：全仓生产 grep 零命中（`SelfLearner.ts` 内部定义 + `test`/`spec`，`chat-execution-ui.test.ts:51` 为 mock 面）
- **内置去重**：L128-134 `normalizeInstruction` 精确比较 — **同指令跳过**（已存在，非 #007 新增）
- **窗口实读**：L145-149 固定 `> 10` shift（订单既定 10→100，本单改）
- **观察端未接入活链** —— 用户执行操作后谁调 `observeExecution`？见 G3

## 订单既定四项 (四裁决已落定, 非开放点)

**(A) 窗口 10→100 / 阈值 3→10**：订单原话既定值，非开放点。窗口 L147 改 `>100`，阈值 L159 改 `>= ANALYSIS_THRESHOLD`(10)，常量锁于类顶部可注入。

**(B) 加固不改写**：订单红线"既有真实现(首轮审计已证)上加固,不重写" → 本稿只动 5 处常量/方法(窗口/阈值/slice 联动/observe 接入/dedupe)，**分析核心逻辑零触碰**（`analyzeAndGenerateSkill`/`callModelForAnalysis`/`generateSkillProposalFromAnalysis` 全部保留原样）。

**(C) 人审门 UI 现状实读**：`src/views/SkillsView.vue:30-44` 三按钮 banner 已存在（"保存技能/忽略/查看详情"）——**非缺口**，是"待加固"。UI 归 #007 实施范围（**非后置**，UI 已就位，本单只补 H1 超时自动忽略一行定时器防挂起）；H2 N 次忽略学习 / H3 版本追踪登记备查（v2 实施）。

**(D) 顺序铁律**：#006.5 未落地 → #007 零实施。**#006.5 已落地并签收**（`ab5e9ac`，84 文件/1023 过/0 失败）→ G3 observe 接入锚 `ChatManager` shouldPrecipitate 块（#006.5 W1 相邻行）就绪，#007 满足开工前置。

## DEV-027 状态改写 (文档先行)

**原 DEV-027**（#006 收官登记，台账现状）：
> "v1 无相似度去重（LRU 按 ts 淘汰，语义重叠条目不去重）"
> 状态：**预留**（触发 = 用户反馈语义重叠 / 后续批次要求）

**#007 修订**：
> "向量层/技能去重的相似度判重（cosine 阈值 + 合并策略）**归 #007 实施范围** — #006.5 已交付 `HermesAdapter.recall()` + `EmbeddingService.embedText()` 共用入口，G4 `checkDuplicateSkill` 扩 cosine 判重时一并落"
> 状态：从"预留"改定为"**#007 实施范围**"（触发 = #007 开工，非用户反馈被动触发）

**理由**（实据）：#006 收官时 `HermesAdapter.recall/embedText` 无生产消费点 → 只能登记"预留"；#006.5 交付 `W1/R-1/R-2` 共用 recall() 入口（电池 84/1023 已实跑），G4 接入锚就绪 → 升级为"本单范围"。台账 `deviation-ledger.md` DEV-027 状态行在 #007 实施提交时同步改写（本笔仅设计稿修订，台账随实施一并落，保持"#007 实施与台账变更同提交"红线）。

## 加固清单（G1-G4 缺口 + 5 项既有加固）

### G1 缺口：`slice(-3)` 阈值不联动

`SelfLearner.ts:196` 的 `slice(-3)` 是写死的"最近 3 条"，但阈值要改 3 → 10 —— **取最近 3 条做分析不够**（10 条才触发，只拿最后 3 条做分析，前 7 条信息浪费）。

**加固方案**：
```ts
// SelfLearner.ts:196
- const recentObservations = this.observations.slice(-3);
+ const recentObservations = this.observations.slice(-this.ANALYSIS_THRESHOLD);
```
+ 类常量 `ANALYSIS_THRESHOLD = 10`（可配置，v1 锁 10）。

### G2 缺口：`callModelForAnalysis` LLM 调用核实（已实读坐实，撤回原假设）

**原稿假设**（撤回）：走 `EmbeddingService` / `LlmClient` 任一。

**实读坐实**（`SelfLearner.ts:261-303`）：
- `callModelForAnalysis(prompt)` → `makeChatCompletionRequest(provider, modelId, prompt)` — **走 LLM chat 请求**，**不走 EmbeddingService**
- provider 来源：`this.modelManager.getEnabledProviders()`（L280+ 实文）
- 无模型时 `return null` → L202 `analysisResult` 空 → 不生成提案
→ **不重写**：既有 LLM 调用路径已通，本单只在参数层微调（`slice(-ANALYSIS_THRESHOLD)`），不动调用面。

### G3 缺口：观察端未接入

`SelfLearner.observeExecution(...)` 生产调用面零命中（F7）。**加固方向**（三选一，**O1 已按订单 A 案裁决**）：
- **O1** · `ChatManager` 对话轮次完成时 `SelfLearner.getInstance().observeExecution(instruction, steps, _result)` — **已定案**
  - 接入点实文锚点：`ChatManager.ts` `shouldPrecipitate` 块末尾（紧邻 #006.5 W1 `store()` 块之后，#006.5 `ab5e9ac` 交付的既有锚点）
  - 参数三元组实证：`instruction: <final user msg content>` / `steps: <当前已执行的 step 摘要[]> (可空 [])` / `_result: <执行结果摘要 'ok' | 'fail' | ''>`
  - **注意**：`observeExecution` 第 3 参 `_result` 现签名带下划线（未用），#007 实施时可填"成功 / 失败"语义，不动方法签名（订单红线：只扩调用面，不改方法名与签名）
- O2 · `BashTool` 命令执行后 — 需扩安全链面，**禁**（红线）
- O3 · 用户显式"记住这个"指令 — 后置
- **技能消费面硬答（第④条）**：`saveSkillFromProposal` (`SelfLearner.ts:701-736`) 写 `skill.md` + `reloadSkills()` 热加载 → `InstructionGenerator.ts:255-284` 把 `getAllSkillSummaries()` 注入 systemPrompt "技能系统 - 优先使用" 段 → LLM 后续指令生成时优先选已有技能 → **G4 的判重保护的是活路，非死路**（fail-open 有真实代价：重复技能 → 触发匹配 `SelfLearner.ts:636-642` LLM 逐对问"是否符合触发条件" → 用户重复看到相似提案 → 人审门疲劳）。**定性**：v1 走 H1 人审门兜底（订单既定），无需 cosine 二次闸

### G4 缺口：**撤销**（原"cosine 语义去重"前提不成立）

**原稿前提**（撤回）：`checkDuplicateSkill` 是 `name === proposal.name` 精确匹配，需接 #006 embedding 加 cosine 闸。

**实读坐实推翻**（`SelfLearner.ts:657-695`）：
- 现状已是 **LLM 意图级语义判重**（非 name 精确，非 cosine）
- 每个 existing skill 逐问 LLM "触发条件是否为同一种用户意图" → "是/yes" 判重
- **fail-open 行为**：无启用模型 / LLM 调用失败 → `return false` → 不判重 → `pendingProposal` 挂起 → **人审门兜底**（`SkillsView.vue:41-43` 三按钮已在位）

**裁决**：撤销 cosine 接入。理由：
1. **LLM 意图级 > cosine 向量级**（cosine 只判向量近，意图判可覆盖同义/近义/反义）
2. **叠加 = 双闸重复**（cosine 先筛 + LLM 再判 = LLM 调用量翻 N 倍，无增益）
3. **替换 = 丢粒度**（LLM 的"是否同种意图"语义比"向量距离"细）
4. **stub 下 cosine 无意义**（stub = SHA-256 无余弦语义，#006 已证）

**替代加固**：
- H1 提案超时自动忽略（订单既定，人审门超时兜底）
- H2 同批 N 次忽略学习（v2 备查）
- **fail-open 成本定性**：重复提案 → 人审门疲劳（不是"技能错跑"），v1 可接受
- **预筛优化候选**（订单收口段登记）：接真 embedding 时（W5 / DEV-027 同批）在 LLM 判重**前**加 cosine 预筛（阈值 0.92 粗过滤），把 100 技能 × LLM N 调降为 O(1) cosine + O(少量) LLM — **非 #007 交付，登记备查**

### 既有加固 5 项（不动核心逻辑，**G4 撤销**）

1. **W1 窗口 10 → 100**（F1）
2. **W2 阈值 3 → 10**（F2）
3. **G1 联动 slice + 类常量**（F3）
4. **G3 观察端接入 ChatManager**（O1，已定案）
5. **G4 checkDuplicateSkill** — **撤销**（现状已是 LLM 意图级，无需 cosine；替代 = H1 人审门超时 + H2 v2 备查；cosine 预筛优化登记备查，W5 接真 embedding 时同批做）

### 分析周期小节（订单 c 项补，成本口径坐实）

**触发条件**（三重 AND）：
1. `observationCount >= this.ANALYSIS_THRESHOLD (= 10)`
2. `!this.analysisInProgress`（既有单飞锁，`SelfLearner.ts:204+`）
3. `!this.pendingProposal`（无挂起提案，`SelfLearner.ts:208+`）

**频率**：
- v1 同步：每轮 chat 完成时 `observeExecution` 推 1 条 → 10 轮触发 1 次 `analyzeAndGenerateSkill`
- 无定时器（**无 cron / schedule / setTimeout** 驱动 `analyzeAndGenerateSkill`，实读核）— 完全"事件驱动"（chat 完成是触发点）
- 若需后台定时分析（如每小时空跑一次），**v1 不加**，W5 接线批评估

**LLM 成本口径**（每 1 次 `analyzeAndGenerateSkill`，实读 `SelfLearner.ts:196-307`）：
| 调用 | 位置 | 触发 |
|---|---|---|
| ① 分析 | L202 `callModelForAnalysis(prompt)` → L261 `makeChatCompletionRequest` | 每次必触发（除非 analysisResult 空） |
| ② 判重 | L676 `makeChatCompletionRequest` | 仅当 analysisResult 通过 skillShape 且 checkDuplicateSkill 进入循环（每个现有技能 1 次，最多 = `getAllSkills().length`） |
| ③ 触发匹配 | L640 `makeChatCompletionRequest` | **不在分析链路**，在用户后续指令进来时 `SkillLoader` 触发侧（`InstructionGenerator` 消费面） |
| ④ 双技能路由 | L793 `makeChatCompletionRequest` | **同上**，在用户指令触发两个技能歧义时 |

**v1 成本上限（每 10 轮 chat）**：1 × 分析 + ≤ N × 判重（N = `getAllSkills().length`，冷启动无 skill = **1 次 LLM**）。
**单飞守卫**（订单 5 条件之一）：`analysisInProgress` 字段既有，并发 chat 只入队不并发分析 ✅。

### 人审门加固（F4 已存在，补 3 项）

**H1** · 提案超时自动忽略（30 分钟无人操作 → 降权至 0 后不再推）：
- `selfLearner.pendingProposal` 加 `createdAt`
- IPC 接收方定时器 30 min 触发 `handleDismissProposal({ silent: true })`

**H2** · 同批 N 次忽略学习（用户连续忽略 M 次相似提案 → 后续降阈值）：
- `ConfigStore['self-learner.dismissed-count']` 计数
- 阈值 N → 5，超过则跳过 `analyzeAndGenerateSkill`（v1 不启用，登记备查）

**H3** · 提案版本追踪：
- `skillMeta` 加 `version` 字段
- 同触发条件不同版本走 `upsert` 覆盖（同 #006 向量层同 id 覆盖模式）

## 变更清单

| 文件 | 改动 |
|---|---|
| `electron/learning/SelfLearner.ts` | W1 窗口 / W2 阈值 / G1 slice 联动 / H1 超时（**G4 撤销**，见 G4 段） |
| `electron/chat/ChatManager.ts` | G3: `observeExecution` 调用点（1 行，对话轮次完成时，紧邻 #006.5 W1 块） |
| `src/views/SkillsView.vue` | H1：`createdAt` 显示 + 超时提示"提案已超期自动忽略"（订单 d 4 诚实文案） |
| `tests/unit/self-learner-loop.test.ts` | 新建（L1-L4, L6 用例；**L5 G4 用例撤销**，见 G4 段） |
| `docs/deviation-ledger.md` | DEV-027 状态改写："已覆盖·机制修正"（cosine 补充取消，LLM 意图级实读坐实，预筛优化候选登记） |

## 测试案（以案计，**5 例 + 2 备查**，L5 G4 撤销）

**L1** · W1 窗口 10→100：写入 105 条 → 断言保留最近 100 条（最早 5 条被 shift）

**L2** · W2 阈值 3→10：`observations.length = 9` 不触发；`= 10` 触发 `analyzeAndGenerateSkill`（mock 断言）

**L3** · G1 联动：`observations.length = 10` 时 `slice(-this.ANALYSIS_THRESHOLD)` 返回最近 10 条（非 3 条）

**L4** · G3 observe 接入：chat 完成 → `SelfLearner.observeExecution` 被调一次（spy mock，**方法名实读 L124**）

**L5** · ~~G4 语义去重~~ — **撤销**（原"cosine 0.92 → checkDuplicateSkill 返回 true"前提错，现有 LLM 意图级判重无需 cosine，实读 L657-695）

**L6** · H1 超时：pendingProposal `createdAt + 30min` 已过 → 自动 dismiss → `pendingProposal = null` + **UI 提示文案**实断言"提案已超期自动忽略"（订单 d 诚实文案）

**L7**（备查）· H2 N 次忽略 → disable — v1 不实施，用例登记备查
**L8**（备查）· H3 版本追踪 — v1 不实施，用例登记备查

**新增 L9** · 技能消费面硬答实跑断言（订单 b 第④条）：`saveSkillFromProposal` 写入后 `getAllSkillSummaries()` 返回含新 skill 的摘要；`getSkillContext(instruction)` 用相同触发条件 query 时返回含该 skill 的上下文 — **消费面活的实证**

## 电池预期

基线 **84 文件 / 1024 过 / 8 skip**（#006.5 A 案收官 `1e00693`）
+ #007：+ 1 新测试文件（`self-learner-loop.test.ts`）/ + 6 用例（**L1-L4 + L6 + L9**，L5 G4 撤销） = **85 文件 / 1030 过**（实跑为准，禁口算）

## 红线核查

- **模块态零新增**：`ANALYSIS_THRESHOLD` 是类常量（实例可覆盖），非模块 `let ...` ✅
- **main.ts 零接触**：#007 不碰 main.ts（G3 observe 接入点在 ChatManager 活跃链）✅
- **安全链零接触**：`commandDecide`/`BashTool`/`constants` 零改 ✅
- **brain 无状态原则**：`analysisInProgress` 是实例字段（既有），不新增模块态 ✅
- **既有真实现上加固**：只改 5 处常量/方法，不动核心分析逻辑 ✅

## 开放点（已定案，非开放）

> **定案**（订单 A 案放行路径 2/3）：

1. **G3 观察端接入点**：**O1 已定案**（ChatManager 轮次完成 `observeExecution`，紧邻 #006.5 W1 块 `ab5e9ac` 既有锚点，O2 安全链禁，O3 后置）
2. **G4 cosine 阈值**：**撤销**（订单 A 案放行进 3 裁决）— 现状 LLM 意图级判重实读坐实（L657-695），cosine 叠加无增益，失败兜底走 H1 人审门
3. **H1-H3 v1 落位**：**H1 落**（超时防挂起 + UI 诚文案"提案已超期自动忽略"），H2/H3 登记备查（v2）
4. **"技能落地"定义**：**v1 只定义"保存技能文件 + 热加载 + 触发侧摘要可见"**（消费面实证 L9：`saveSkillFromProposal` → `reloadSkills` → `InstructionGenerator.ts:255-284` 注入 systemPrompt "技能系统 - 优先使用"）**+ "跑起来" = W5 接线批**（brain tool 注册）

> **ROE 附录**（订单 A 案放行进 4 新增，落点 = `docs/#002-v3-step-b-c-diff-and-matrix.md:806`）：

| 新行号 | 条款 | 等级 |
|---|---|---|
| 7 | 设计稿复审抽验 F 段 ≥2 条 file:line（指挥层自查条款，防臆造方法名 / 推断机制被误当事实） | 严格 |

> **既定（非开放）**：提交顺序 — #006.5 已交付 `ab5e9ac`（消费端先落地），#007 满足开工前置，本单随后实施。顺序铁律已执行，不再作开放点。
