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

**F6** — `checkDuplicateSkill` 去重实现（`SelfLearner.ts:213` 调用，实现需核实）。**推断**：基于 name 字符串精确匹配。**缺口**：语义相近（"生成周报" vs "每周周报生成"）视为不同技能 → 重复提案 → 订单 DEV-027 要求接真 embedding 时一并闭环。

**F7** — **观察来源**（observe 方法）：全仓 grep 生产调用面**零命中**（仅 `SelfLearner.ts` 内部定义 + `test`/`spec`）。**观察端未接入** —— 用户执行操作后谁调 `observe(...)`？需核实（见 G3 缺口）。

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

### G2 缺口：`callModelForAnalysis` LLM 调用核实（需实跑 grep 后落地）

**设计稿假设**：走 `EmbeddingService` / `LlmClient` 任一。**核实方法**：`grep -n "callModelForAnalysis\|LlmClient\|embedText" electron/learning/SelfLearner.ts`。**加固方向**：
- 走 #006 `EmbeddingService`（已持久化的 embedding 链）— 语义匹配去重
- LLM 分析走 `LlmClient`（真实大模型，不 stub）
- **不重写**（订单红线），只补接口一致性

### G3 缺口：观察端未接入

`SelfLearner.observe` 生产调用面零命中。**加固方向**（三选一，订单裁决）：
- **O1** · `ChatManager` 对话轮次完成时 `SelfLearner.getInstance().observe({ instruction: finalMsg.content, steps: [] })` — **推荐**
- O2 · `BashTool` 命令执行后 — 需扩安全链面，**禁**（红线）
- O3 · 用户显式"记住这个"指令 — 后置

### G4 缺口：`checkDuplicateSkill` 精确匹配 → 语义去重（DEV-027 闭环）

**现状**：`name === proposal.name` 精确匹配（推断，需实跑核实）。

**加固方案**（接 #006 持久化 embedding 链）：
```ts
// SelfLearner.ts, checkDuplicateSkill 扩展
- if (existingSkill.name === proposal.name) return true
+ // DEV-027: 语义去重 — 接 #006 EmbeddingService
+ const v = await this.embedder.embedText(proposal.name + ' ' + proposal.triggerCondition)
+ for (const s of existingSkills) {
+   if (await this.cosineSimilarity(v, s.vector) > 0.92) return true
+ }
```
- 候选阈值 0.92（订单建议）
- Skill 需新增 `vector` 字段（或 skill 文件扩展）
- **不重写**，只扩 `checkDuplicateSkill`

### 既有加固 5 项（不动核心逻辑）

1. **W1 窗口 10 → 100**（F1）
2. **W2 阈值 3 → 10**（F2）
3. **G1 联动 slice + 类常量**（F3）
4. **G3 观察端接入 ChatManager**（O1，推荐）
5. **G4 checkDuplicateSkill 语义化**（DEV-027 闭环）

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
| `electron/learning/SelfLearner.ts` | W1 窗口 L147 / W2 阈值 L159 / G1 slice L196 / G3 observe 接入点 / G4 checkDuplicateSkill / H1-H3 |
| `electron/chat/ChatManager.ts` | G3: `observe` 调用点（1 行，对话轮次完成时，紧邻 #006.5 W1 块） |
| `electron/hermes/EmbeddingService.ts` | `embedText` 已存在，G4 调既有接口 — **零改** |
| `src/views/SkillsView.vue` | H1-H3：banner 加 `createdAt` 字段显示 + 超时逻辑（1 处） |
| `electron/skills/SkillLoader.ts` | G4: `vector` 字段存储（扩 schema） |
| `tests/unit/self-learner-loop.test.ts` | 新建（L1-L6 用例） |
| `tests/unit/self-learner-dedupe.test.ts` | 新建（G4 语义去重用例） |

## 测试案（以案计，6 例 + 2 备查）

**L1** · 窗口 10→100：写入 105 条 → 断言保留最近 100 条（最早 5 条被 shift）

**L2** · 阈值 3→10：`observations.length = 9` 不触发；`= 10` 触发 `analyzeAndGenerateSkill`（mock 断言）

**L3** · G1 联动：`observations.length = 10` 时 `slice(-this.ANALYSIS_THRESHOLD)` 返回最近 10 条（非 3 条）

**L4** · G3 observe 接入：chat 完成 → `SelfLearner.observe` 被调一次（spy mock）

**L5** · G4 语义去重：两提案 "生成周报"/"每周周报生成" cosine > 0.92 → `checkDuplicateSkill` 返回 true → 不重推

**L6** · H1 超时：pendingProposal `createdAt + 30min` 已过 → 自动 dismiss → `pendingProposal = null`

**L7**（备查）· H2 N 次忽略 → disable — v1 不实施，用例登记备查
**L8**（备查）· H3 版本追踪 — v1 不实施，用例登记备查

## 电池预期

基线 83 文件 / 1018 过（#006 收官）
+ #006.5 若先落：约 85 文件 / 1020 过
+ #007：+ 2 新测试文件 / + 6 用例 = **87 文件 / 1026 过**（实跑为准，禁口算）

## 红线核查

- **模块态零新增**：`ANALYSIS_THRESHOLD` 是类常量（实例可覆盖），非模块 `let ...` ✅
- **main.ts 零接触**：#007 不碰 main.ts（G3 observe 接入点在 ChatManager 活跃链）✅
- **安全链零接触**：`commandDecide`/`BashTool`/`constants` 零改 ✅
- **brain 无状态原则**：`analysisInProgress` 是实例字段（既有），不新增模块态 ✅
- **既有真实现上加固**：只改 5 处常量/方法，不动核心分析逻辑 ✅

## 开放点（待 GLM 逐条复审裁定）

1. **G3 观察端接入点**：O1 ChatManager 轮次完成（推荐，紧邻 #006.5 W1 块，#006.5 已交付 `ab5e9ac` 锚点就绪）/ O2 BashTool（禁，安全链面）/ O3 显式用户指令（后置）？
2. **G4 cosine 阈值**：0.92（订单建议）/ 0.85（宽）/ 0.95（严）？
3. **H1-H3 v1 是否落**：推荐 **H1 落**（超时防挂起），H2/H3 登记备查（v2 实施）
4. **"技能落地"定义**：订单"技能落地" = 保存技能文件（`SkillLoader` 既有面）？还是包含"下次用户触发时真的能跑"（涉及 `LlmAgentBrain` tool 注册，W5 接线批受益）？推荐 v1 只定义"保存技能文件 + 下次启动时 `SkillLoader` 加载"，W5 接线批时接"跑起来"。

> **既定（非开放）**：提交顺序 — #006.5 已交付 `ab5e9ac`（消费端先落地），#007 满足开工前置，本单随后实施。顺序铁律已执行，不再作开放点。
