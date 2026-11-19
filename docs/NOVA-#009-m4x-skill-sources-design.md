# NOVA #009 — M4-X：技能来源体系（不集成 / 联网找 / 手动装 / 存储位置）

> **状态**：已实现（2026-11-19）
> **对应台账**：DEV-172 / DEV-173 / DEV-174
> **分支**：`feat/harness-wiring`
> **前置**：[M4-A 技能渐进披露](NOVA-#009-m4a-skill-progressive-disclosure-design.md) ·
> [M4-W 让 AI 真的能选对技能](NOVA-#009-m4w-skill-routing-design.md)

## 一、需求（四条）

> 技能部分不要集成，联网环境下自动去开源技能库寻找以及推荐用户联网下载，
> 有网和无网环境下可以手动添加技能包，技能包存储位置添加为应用本身结构目录的 skills 下面。

## 二、先量现状（不量就动手 = 改一堆不存在的东西）

| # | 要求 | 现状（实查） |
|---|---|---|
| 1 | 技能不集成 | 半成立：安装包本就不含 `skills/`（electron-builder 的 files 只有 dist/dist-electron），但仓库里有两个样例技能，且 dev 下**首启会被拷进用户数据目录** |
| 2 | 联网自动去开源技能库寻找 | ❌ **一条死路**：`ClawHubManager` 是**本地模拟市场**（数据在 userData/clawhub-skills.json，界面明写「本地演示模式」），「下载」按钮是 **stub**；`ClawHubRegistry` 是唯一走网络的，但指向 `https://example.com/pipiclaw-clawhub` —— **占位符，永远不可达** |
| 3 | 推荐用户联网下载 | ❌ 唯一叫「推荐」的界面（`SkillMarket.vue` 的「推荐模板」）是**写死的 `PRESET_SKILLS`**，安装按钮**没有 @click** |
| 4 | 有网无网都能手动添加 | ✅ **已有**：`.md` / 文件夹 / `.zip` 三种**纯本地**，URL 一种要网络 |
| 5 | 存储位置 = 应用自身结构目录的 skills | ❌ 原本是 `<userData>/skills` |

**为什么 ClawHubRegistry 不能直接拿来用**：它的信任模型是「作者用 Ed25519 私钥对 zip
签名 → 应用验签」—— 对**私有/自建仓库**是对的。但开源技能库没有签名，只有公开的
GitHub 内容。**信任模型不同，故分开**：私有仓库走 ClawHubRegistry（签名），开源库走
本批的新模块（公开可校验）。

## 三、做法

### 3.1 联网寻找（DEV-172）

新增 `electron/skill/SkillHub.ts`，内置**实测可达**的开源源：

| 源 | 索引 | 原生格式 | 实测 |
|---|---|---|---|
| `anthropics/skills`（官方） | `.claude-plugin/marketplace.json` | 插件 + 技能目录路径（**无逐技能描述**） | ✅ 19 条 |
| `DghostNinja/Skill-Shelf`（社区） | `index.json` | 完整元数据（name/description/category/tags/version） | ✅ 15 条 |

**为什么官方源要再取一次目录树**：marketplace.json 只给**技能目录路径**，
没有逐技能的描述 —— 而描述正是**路由依据**（M4-W 量的就是这件事：
AI 选得准不准，全看摘要质量）。故再取一次 tree + 各技能的 SKILL.md，
把 name/description/license 补齐。索引缓存一次长期复用，值得。

**索引落盘缓存** → 搜索与推荐是**纯本地过滤**，**断网照常能用**；
只有「下载安装」需要网络。这与「有网无网都能手动添加」是同一条要求的两面。

**搜索**：名称 / 描述 / 分类 / 标签，权重 名称 > 标签 > 分类 > 描述。
**推荐**：已装的**不重复**推荐；官方源优先于社区源；同分时新日期优先；
**没有描述的条目不推荐**（推荐了用户也不知道该不该装）。

**安装**：按目录枚举（GitHub tree API）+ 逐文件下载（raw 直链），
**整个目录**都装上（SKILL.md + references/ + scripts/）——
只装 SKILL.md 会让技能**缺一半**（正文常写"详见 REFERENCE.md"）。
装完补 `when_to_use`（由标签/分类合成）→ 提升被 AI 选中的概率。

### 3.2 存储位置（DEV-173）

```
开发态：<appPath>/skills            （实测 dev 下 electron 以 "." 启动 → appPath = 仓库根）
打包后：<dirname(appPath)>/skills    （<install>/resources/skills；app.asar 内部不可写）
兜底  ：<userData>/skills            （装到 Program Files 这类只读位置时）
```

**必须守住「读写同源」**——本文件的历史注释写着：曾经**写** `appPath/../skills`、
**读** `userData/skills`，两个不同路径，导致「保存的技能永远扫不到」。这次改路径
最怕的就是改出一模一样的岔路。故：

1. 选中的目录**落盘记住**（ConfigStore `skills.dir`），一旦定了不再变；
2. 读与写都走 `SkillManager.getSkillsDir()` —— **没有第二个拼路径的地方**；
3. 选之前**真写探针文件**测可写（目录权限可能与父目录不同，existsSync 说了不算）；
4. 不可写就落回 userData，并把**为什么**显示在界面上。

### 3.3 不集成（DEV-174）

- 仓库里的两个样例技能**删除**（用户 2026-11-19 明确指示）
- `SkillLoader` 构造器里「首启把项目 skills 拷进用户数据目录」的行为**删除**
- `.gitignore` 加 `skills/*` —— 目录只留 `.gitkeep` 占位，其余是用户下载/手动添加的

### 3.4 手动添加（现状即满足）

四种入口本就存在，其中**三种完全离线可用**（`.md` / 文件夹 / `.zip`）；
新增的开源技能库是**另一条路**，两条并存。

## 四、界面

技能页新增「开源技能库」卡片（紧挨「技能目录」卡片 —— 一个是"在哪"，一个是"从哪来"）：

- 搜索框 → `skills:hub:search`
- 推荐条目 → `skills:hub:recommend`（进页自动拉一次）
- 每条显示名称 / 说明 / 来源 / 标签 + 「下载安装」按钮
- **索引状态如实展示**：多少条、什么时候拉的、哪些源不可用
- 断网时提示「仍可用『导入技能』手动添加」

## 五、验证

| 项 | 结果 |
|---|---|
| `tests/integration/skill-hub-live.test.ts` | **实跑**：两源均 ✅（19 + 15 = 34 条）· 搜 "pdf" 命中 3 条 · 推荐 5 条 · **安装 docx 成功** · 装完 SkillLoader 能加载 |
| `tests/unit/skill-hub-m4x.test.ts` | **9 例**：搜索各字段命中 / 权重排序 / 限定源与分类 / 推荐不推荐无描述的 / 无缓存不抛错 / frontmatter 解析 |
| `tests/unit/skills-m4-panels.test.ts` | 新增 3 例：推荐条目落到界面 / 搜索把关键词传给主进程 / 点「下载安装」调主进程 |
| vitest | **144 files / 1619 passed / 0 FAIL / 17 skipped** |

**顺带修掉两个自己写出来的 bug（都是实跑才暴露的）**

① **下载直链丢了目录前缀** —— 列目录时返回"相对该目录的路径"，拼直链时
`skills/docx/scripts/x.py` 被请求成 `scripts/x.py` → 404。
② **安装失败留下半成品目录** —— 下载中途失败会留下缺文件的技能目录，
它**会被扫到并加载**，但正文/脚本残缺 —— 比"没装"更糟（用户看不出来它不完整）。
失败即清掉。

## 六、遗留与后续

| # | 遗留 | 归属 | 说明 |
|---|---|---|---|
| 1 | ~~**ClawHub 本地模拟市场仍在**~~ | ✅ **M4-Y 已清** | 4 个本地演示页签与其后端 `ClawHubManager` 整条删除（逐条查过读写路径：下载是 stub、审核通过的条目永远装不上、模板实例化写到 SkillLoader 从不扫的目录）。**保留** `ClawHubRegistry` —— 信任模型不同（自建仓库 zip 带签名、验签），不构成重叠；`/clawhub` 改名「私有技能仓库」 |
| 2 | ~~**`SkillMarket.vue` 是死页**~~ | ✅ **M4-Y 已清** | 整页 + 其 Pinia store 删除；路由 `/skill-market` 删除（本就全仓无入口） |
| 3 | **源不可配置** | 后续 | `SkillHub.setExtraSources()` 已有接口，但没做界面入口；用户想加自己的源还不行 |
| 4 | **无评分/无热度** | 后续 | 推荐只按「官方优先 + 日期新」，没有使用量/评分数据（ClawHubManager 里有本地评分，但那是模拟数据） |
| 5 | **未做内容安全检查** | 后续 | 下载的技能正文会进 LLM 上下文；含 scripts 的包可被 agent 执行（仍走 Bash 白名单+确认门）。可加"安装前列出可执行文件"的确认步骤 |
