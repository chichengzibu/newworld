# NOVA #009 — M3-D 技能目录（把「只有一张嘴」的能力补上）

> **状态**：已实现（2026-10-29）
> **对应台账**：DEV-081 ~ DEV-084
> **分支**：`feat/harness-wiring`
> **前置**：[M3-A 真向量](NOVA-#009-m3a-real-vectors-design.md) · [M4-A 渐进披露](NOVA-#008-m4-skill-progressive-disclosure-design.md)

## 一、为什么做这件事

### 1.1 一张系统性审计抓出来的洞

本批不是按计划做的，是**扫出来的**。我跑了一次全仓审计，检查三类系统性缺陷：

| 审计项 | 方法 | 结果 |
|---|---|---|
| IPC 三角 | preload 声明 ↔ 主进程 handle ↔ 渲染层 invoke | **10 个通道声明了但全仓无 handler** |
| 配置键三角 | `configStore.get('X')` ↔ `configStore.set('X')` | 3 个只读键（`shortcuts.*`，属正常） |
| 能力可达性 | 有实现无调用方 / 有声明无实现 | 见 §1.2 |

### 1.2 那 10 个通道里，6 个是「技能目录」

```
skills:addCustomDir      skills:removeCustomDir    skills:getCustomDirs
skills:getDirectoryPreview   skills:getStorageInfo    skills:remove
```

它们在 `electron/preload.ts` 里**早就声明了**（preload 是 contextBridge 暴露面，
等于对外承诺的 API），但：

- 主进程**从没有 handler** → 真调会得到 `No handler registered`
- 渲染层**从没有调用方** → 没有任何 UI
- `SkillLoader` **只有 `userData/skills` 一个目录** → 连后端能力都没有

**一张嘴都没有。** 而技能系统此时的处境是：技能要么是应用导入的，要么是自学习闭环
生成的——**用户自己项目里的技能目录完全看不到**。

### 1.3 为什么这类洞值得单独一批

这类缺陷的特征是：**不会报错、不会崩、不会让任何测试变红**。它只是让一部分功能
「看起来存在」。

而 `preload.ts` 是**安全边界**——它是渲染进程能触达主进程的唯一通道。
在那里承诺不存在的能力，比不承诺更糟：调用方（未来的自己、或第三方）会以为能用。

## 二、设计依据

### 2.1 Anthropic Agent Skills 的多层发现

规范里的技能来源是分层的（personal / project / plugin）。本项目此前只有一层
（应用自己管的 `userData/skills`），缺了「项目层」——也就是**用户仓库里的技能**。

补上的正是这一层：用户可以额外挂目录，目录里的技能照样被加载。

### 2.2 技能 id 必须全局唯一

`load_skill(skill_id)` 是 LLM 唯一的技能寻址入口。id 一旦不唯一，
「模型加载了哪个技能」就变得不确定 —— 这是不能容忍的。

因此同名冲突的裁决是**先到者为准**（主目录 > 额外目录），
而不是给额外目录的技能加前缀（那会让 id 变成 `dir:skill` 形态，
与 `SKILL.md` 的既有约定冲突，也会让 `load_skill` 的参数语义变得诡异）。

### 2.3 技能内容会进 LLM 上下文 —— 目录扫描是安全面

技能正文会被注入 system prompt，等于**用户指定的目录可以往提示词里塞东西**。
故：

- 只扫**一级子目录**，且子目录里必须有 `SKILL.md` / `skill.md`
- **符号链接默认不跟随**（`dirent.isDirectory()` 对软链返回 false）
  —— 既避免指向目录外的软链被加载，也避免「任意读取」；想软链请复制
- 额外目录必须由**用户显式添加**（不是自动扫描项目目录）

## 三、实现

### 3.1 加载器（`electron/skill/SkillLoader.ts`）

| 新增 | 说明 |
|---|---|
| `getExtraDirs()` / `setExtraDirs()` | 持久化到 `skills.extraDirs`（与 `skills.states` 分开放：一个是「扫哪儿」，一个是「每个技能什么状态」） |
| `addExtraDir()` / `removeExtraDir()` | 增删额外目录，改动后自动 reload |
| `previewDirectory()` | 预览目录里有哪些技能（给「添加目录」界面用，不加载） |
| `getStorageInfo()` | 主目录 + 各额外目录的技能数；**目录不存在要如实标出** |
| `removeSkill()` | 删除技能（删它所在的技能子目录） |
| `SkillState.sourceDir` | 记来源目录 —— 删除时要知道删哪个 |

加载顺序：**主目录 → 额外目录（按加入顺序）**，先到者为准。

### 3.2 删除技能的路径守卫

`removeSkill` 删的是**目录**，所以守卫不能少：

```
允许的根 = 主目录 ∪ 用户添加的额外目录
目标 = resolve(base, skillId)
① base 必须在允许的根里           → 否则拒
② path.dirname(target) === base   → 否则拒（路径穿越）
```

技能 id 是用户/LLM 给的字符串，**不能拿它拼路径就删**。

### 3.3 IPC（补齐 6 个缺失的 handler）

`skills:addCustomDir` · `skills:removeCustomDir` · `skills:getCustomDirs` ·
`skills:getDirectoryPreview` · `skills:getStorageInfo` · `skills:remove`

### 3.4 UI（`src/views/SkillsView.vue`）

新增「技能目录」卡片：

- 主目录路径 + 技能数
- 额外目录列表（路径 / 技能数 / 移除）
- 「添加技能目录」→ **系统目录选择器** → **预览**（先让用户看见里面有什么技能）→ 确认

预览这一步是有意的：目录里没技能时，用户会以为功能坏了。

## 四、验证

| 项 | 基线 | 现在 |
|---|---|---|
| vitest | 115 files / 1379 passed | **116 files / 1391 passed / 0 FAIL** |
| 后端 typecheck | 29 error | **29 error（零新增）** |
| 前端 vue-tsc | 0 | **0** |

新增测试 `tests/unit/skill-directories-m3d.test.ts`（12 例）：
额外目录技能被加载 · 同名主目录优先 · 移除目录后不再加载 ·
添加不存在的目录被拒 · 重复添加去重 · 预览列出技能 · 预览不存在目录不报错 ·
存储信息如实报告 · 删除技能删对目录 · 删除不存在的技能报失败 ·
**删除的路径守卫（未登记目录一律拒）** · 目录已不存在时只清索引。

## 五、遗留与后续

| # | 遗留 | 归属 | 说明 |
|---|---|---|---|
| 1 | **项目级技能不自动发现** | 后续 | 本批是「用户手动挂目录」。Anthropic 规范是按 cwd 自动发现项目级技能 —— 值得做，但要处理「不同项目不同技能集」的加载时机与缓存 |
| 2 | **软链目录不支持** | 设计边界 | 安全默认。需要软链的用户可复制目录 |
| 3 | **技能删除没有 UI 入口** | 后续 | IPC 已实现，UI 暂未加删除按钮（避免误删；可先加「从列表移除」而非「删文件」） |
| 4 | **`skills:remove` 与「禁用」的语义要分清** | 后续 | 禁用 = 不加载但保留文件；删除 = 删文件。当前 UI 只有禁用，删除只走 IPC |

## 六、参考资料

- Anthropic Agent Skills 规范 —— 技能来源分层（personal / project / plugin）
- `preload.ts` 作为 contextBridge 暴露面 —— 声明即承诺，承诺必须兑现
