# NW 环境变量调用审计清单

> 日期：2026-11-23　｜　目的：评估 `PIPICLAW_*` 环境变量能否替换为 `NW_*`
> **最终结论（2026-11-23 执行完成）**：用户确认程序尚未推送、无老用户配置兼容负担 → 采用方案 ③ 全量硬替换，`PIPICLAW_*` → `NW_*` 及关联标识已全部落地。
> 下方 §0–§3 为替换前的审计态记录与方案对比，保留作决策依据；实际执行结果见下一节。

---

## 执行结果（2026-11-23 · 全量硬替换已落地）

### 1. 替换映射

| 旧标识 | 新标识 | 类型 / 范围 |
|---|---|---|
| `PIPICLAW_` | `NW_` | 26 个环境变量，代码 / 测试 / 脚本 / UI 文案 / `.claude` 权限白名单 |
| `pipiclaw_recent_commands` | `nw_recent_commands` | localStorage key（CommandPalette） |
| `pipiclaw:locale` | `nw:locale` | localStorage key（locales / Settings） |
| `pipiclaw_onboarding_events` | `nw_onboarding_events` | localStorage key（FirstLaunchGuide） |
| `pipiclaw-app` | `nw-app` | DOM id / CSS 选择器（App.vue） |
| `.pipiclaw-ohos` | `.nw-ohos` | 鸿蒙默认数据目录名（HarmonyHost） |
| `com.pipiclaw.app` | `com.newworld.nw` | 应用 / bundle 标识 |

### 2. 第一轮替换覆盖（grep 实测口径）

- 备份：`.nw-env-backup-1795402462/`，**52 个含旧标识文件 / 2.3MB**，保留原目录结构。
- 审计命中：**220 处 `PIPICLAW_*` 出现于 45 个文件**；另有 **11 个文件**含旧 localStorage / DOM 标识。
- 文件类型分布：31 `.ts`、5 `.vue`、5 `.md`、4 `.mjs`、4 `.json`、3 `.js`。
- 结果：`electron/ src/ scripts/ tests/ ohos/scripts/ .claude/` + 用户文档中旧标识零残留。

### 3. 第二轮补漏：鸿蒙壳 + 陈旧构建产物

首轮"零残留"结论的 grep 口径只覆盖 `PIPICLAW_*` 与 4 个具体 key，遗漏了**展示品牌名**、**鸿蒙 bundleName** 与**未被清理的旧构建 chunk**。已补齐：

- 备份：`.nw-ohos-backup-1795403046/`（9 个文件）。
- 定点替换 **87 处 / 8 个文件**：
  - `ohos/AppScope/app.json5`：`bundleName` → `com.newworld.nw`、`vendor` → `New World Team`、注释品牌
  - `ohos/AppScope/resources/base/element/string.json`、`ohos/entry/src/main/resources/base/element/string.json`：应用名 / 模块描述 → `New World`
  - `ohos/entry/src/main/ets/AppAbilityStage.ets`：注释中 13 处 `PIPICLAW_*` → `NW_*`（含 `PiPiClawStage` → `NWStage`）
  - `ohos/entry/src/main/resources/rawfile/.gitkeep`、`.gitignore`：旧变量名
  - `ohos/signature/README.md`：签名材料命名 + bundleName
  - `docs/鸿蒙PC-DevEco真机调试手册.md`：56 处（展示品牌 / bundleName / 签名文件名；**保留真实路径 `D:/pipiclaw/piclaw/`**）
- `ohos/scripts/sync-assets.mjs`：生成清单的元数据键 `pipiclaw` → `newworld`；`requiredEnv` 已是 `NW_*`。
- 删除孤立旧 chunk `dist-electron/index-B9TqVg5y.js`（10:39 旧构建残留，含 `PIPICLAW_E2E`，已被 `index-mYhbS_Bu.js` 取代且无任何引用）。
- 执行 `npm run ohos:sync` 从干净根产物重建 `ohos/entry/assets/app/`：`package.json` 现为 `name=new-world` / `author=New World Team` / `newworld` 键 / `NW_*` requiredEnv；渲染层 bundle 旧品牌清零。

### 4. 第五轮：内部小写运行时标识也已全量替换（用户追加要求）

用户明确要求"内部小写运行时标识不保留，都换成 `newworld`"，第四轮留下的最后一项已执行：

- 备份：`.nw-lowercase-backup-1795404510/`（**330 个文件 / 3.9MB**，镜像原目录结构）。
- 替换：**552 处 / 329 个文件**，大小写感知映射：
  - `pipiclaw`（小写标识符）→ `newworld`：`pipiclaw.log`、`app://pipiclaw`、`.pipiclaw-secrets`、`pipiclaw-url/skill/e2e/p0/locktest-*` 临时前缀、`pipiclaw-filesystem` MCP server 名、`pipiclaw/sandbox-base` Docker 镜像、`~/.pipiclaw/` 状态目录、测试夹具路径等。
  - `PiPiClaw`（展示品牌，多在注释头）→ `New World`；`piPiClaw` → `nwWorld`；`Pipiclaw` → `Newworld`；`PIPICLAW` → `NEWWORLD`。
- 跨文件契约同步：`newworld-filesystem`（serverInfo + McpManager 默认值 + PoC）、`newworld/sandbox-base`（4 个模板 + 构建/自检脚本）、`app://newworld`。
- 本地开发密钥 `~/.pipiclaw-secrets/clawhub-dev-ed25519.key` **复制**到 `~/.newworld-secrets/`（原件保留），保证签名仍能工作。
- 完整重建 `dist/` + `dist-electron/`（先删 `dist-electron/` 避免孤儿 chunk）后 `npm run ohos:sync`（3.13 MB）。
- 修复两处因替换产生的断言：`scripts/mcp-filesystem-poc.mjs`（`package.json` name 实为 `new-world`）、`tests/unit/agent-tools.test.ts`（忽略大小写测试 pattern 改为 `NEW WORLD`）。

### 5. 最终刻意保留（7 处，均为功能性例外）

- **历史记录**：`CHANGELOG.md`、`docs/audit/`、`docs/NOVA-*`、`docs/team/`、`.workbuddy/memory/`、各类 `.bak-*` 备份与旧 `release/` 包 —— 历史不改写。
- `electron-builder.json5` 的 `publish.repo`（`pipiclaw`）—— 自动更新源，改则失效。
- 真实上游 URL：`api.github.com/repos/chichengzibu/pipiclaw`、`github.com/pipiclaw`（校准脚本 User-Agent）。
- 真实工作区路径：`D:\pipiclaw\piclaw`（`get-release-id.py` 输出路径、filesystem-server 示例）。
- **安全 guard 保留旧目录名**：`SECRETS_GUARD_PATTERNS` 同时含 `.newworld-secrets` 与 `.pipiclaw-secrets` —— 本机旧密钥目录仍真实存在，必须继续 deny（含对应单测）。

### 5. 验证

| 检查项 | 结果 |
|---|---|
| `npx vue-tsc --noEmit` | ✅ Exit 0 |
| `npm test`（全量） | ✅ `npx vitest run --maxWorkers=2 --minWorkers=1`：149 files / 1635 passed / 18 skipped，Exit 0 |
| `npm run ohos:sync` | ✅ 3.13 MB，preload CJS 格式检查通过 |
| 构建产物残留 | ✅ 第五轮全量重建后，仅剩 2 处受保护字符串（旧 secrets guard + 真实工作区路径示例）；无 `PIPICLAW_*` / `app://pipiclaw` / `pipiclaw-filesystem` / `pipiclaw.log` |
| JSON 合法性 | ✅ 三个 string.json / package.json 均可解析 |
| 源码残留 | ✅ 仅 7 处功能性例外（真实路径/URL/publish.repo/安全 guard），无遗漏 |

---

## 0. 摘要（审计态 · 替换前记录）

| 类别 | 数量 | 含义 | 替换风险 |
|---|---|---|---|
| A · 内部开关 | 11 | 开发/测试/e2e 旁路，用户不感知 | 低 — 可整批替换 |
| B · 用户外部配置 | 3 | 用户在 shell / setx 显式设置 | 高 — 硬替换会让已有配置静默失效 |
| C · 鸿蒙壳注入 | 5 | 壳工程 `requiredEnv` 精确校验 | 中 — 需同步改壳，漏改则鸿蒙版起不来 |
| D · 构建/CI 辅助 | 7 | 构建脚本与离线基准 | 低-中 — 多为用户手动调用 |

> 注：此前我说"仅剩 CLAWHUB 两个环境变量"是不完整的，实际审计出 26 个。此处更正。

---

## 1. 完整清单（变量 → 读取位置 → 用途 → 风险）

### A 类 · 内部开关（低风险，可整批替换）

| 变量 | 读取位置 | 用途 | 默认值/触发值 |
|---|---|---|---|
| `PIPICLAW_E2E` | `electron/core/BootOrchestrator.ts:81`<br>`electron/core/WindowManager.ts:119`<br>`electron/core/search/providers/duckduckgo-html.ts:223`<br>`electron/main.ts:136,220`<br>`tests/e2e/helpers/electron-app.ts:276`<br>`tests/e2e/diag-launch.spec.ts:26`<br>`tests/e2e/verification-proxy.spec.ts:42`<br>`tests/e2e/_p0-helpers.ts:87`<br>`scripts/user-journey-ollama.mjs:41` | e2e 测试旁路：强制 prod 加载路径、搜索 stub、跳过 dev 分支 | `=== '1'` 触发 |
| `PIPICLAW_SKIP_SPLASH` | `electron/core/BootOrchestrator.ts:80`<br>`electron/main.ts:135`<br>`tests/e2e/helpers/electron-app.ts:281`<br>`tests/e2e/verification-proxy.spec.ts:43` | 跳过启动幕（e2e / OHOS） | `=== '1'` 触发 |
| `PIPICLAW_SKIP_UPDATE_CHECK` | `electron/core/AutoUpdater.ts:75`<br>`tests/unit/AutoUpdater.test.ts:76` | 关闭自动更新检查 | 任意非空值即跳过 |
| `PIPICLAW_DEV` | `electron/permissions/PermissionConfig.ts:414` | 开发模式，允许强制重置权限 | `'1'` 或 `'true'` |
| `PIPICLAW_RESET_PERMISSIONS` | `electron/permissions/PermissionConfig.ts:415` | 显式一次性重置权限 | `'1'` 或 `'true'` |
| `PIPICLAW_OPENCLAW_NO_AUTH` | `electron/openclaw/OpenClawServer.ts:149` | 关闭 OpenClaw token 鉴权（仅 warn 文案中出现，需确认实际判断） | `=== '1'` |
| `PIPICLAW_STRICT_PERMISSIONS` | 仅文档：`docs/audit/03-backend-report.md`、`docs/team/2026-08-05-architect.md` | 提案中的严格权限开关，代码未见实现 | 未落地 |
| `PIPICLAW_BUILD_EB_TIMEOUT_MS` | `scripts/build.mjs:62` | electron-builder 超时 | 默认 600000ms |
| `PIPICLAW_CALIBRATION` | `tests/integration/judge-calibration-live.test.ts:76` | 裁判校准总开关 | `=== '1'` |
| `PIPICLAW_CALIBRATION_MODEL` | `tests/integration/judge-calibration-live.test.ts:77` | 校准用模型 | 默认 `qwen3.5:9b` |
| `PIPICLAW_CALIBRATION_PER_CATEGORY` | `tests/integration/judge-calibration-live.test.ts:79` | 每类抽样数 | 默认 20 |
| `PIPICLAW_CALIBRATION_DATASET` | `tests/integration/judge-calibration-live.test.ts:81` | 数据集选择 | 默认 `panel` |
| `PIPICLAW_CALIBRATION_CONCURRENCY` | `tests/integration/judge-calibration-live.test.ts:85` | 并发数 | 默认 4 |
| `PIPICLAW_CALIBRATION_VERDICTS` | `tests/integration/judge-consensus-offline.test.ts:65` | 离线裁决 JSONL 路径 | 无默认 |
| `PIPICLAW_SKILL_ROUTING` | `tests/integration/skill-routing-live.test.ts:69` | 路由基准开关 | `=== '1'` |
| `PIPICLAW_SKILL_ROUTING_MODEL` | `tests/integration/skill-routing-live.test.ts:70`<br>`skill-routing-scale-live.test.ts:61` | 路由基准模型 | 默认 `qwen3.5:9b` |
| `PIPICLAW_SKILL_ROUTING_VARIANT` | `tests/integration/skill-routing-live.test.ts:79` | 基准变体 | 默认 `fixed` |
| `PIPICLAW_SKILL_SCALE` | `tests/integration/skill-routing-scale-live.test.ts:60` | 规模档基准开关 | `=== '1'` |
| `PIPICLAW_SKILL_HUB` | `tests/integration/skill-hub-live.test.ts:52` | SkillHub 联网测试开关 | `=== '1'` |

### B 类 · 用户外部配置（高风险，需双名兼容）

| 变量 | 读取位置 | 用途 | 查找优先级 | 风险说明 |
|---|---|---|---|---|
| `PIPICLAW_CLAWHUB_REGISTRY` | `electron/skill/ClawHubRegistry.ts:87`<br>UI 文案 `src/views/ClawHub.vue:61`<br>e2e 断言 `tests/e2e/clawhub-browse.spec.ts:54`<br>单测断言 `tests/unit/views/ClawHub.test.ts:125` | 插件仓库基址 | env > `userData/clawhub-registry.txt` > 默认 | **用户可能已 setx 设置**。硬改后新名无人读、旧名被忽略 → 配置静默失效 |
| `PIPICLAW_CLAWHUB_PUBKEY` | `electron/skill/ClawHubRegistry.ts:103`<br>UI 文案 `src/views/ClawHub.vue:62`<br>e2e 断言 `tests/e2e/clawhub-browse.spec.ts:55`<br>单测断言 `tests/unit/views/ClawHub.test.ts:126` | 仓库签名公钥 | env > `userData/clawhub-pubkey.txt` > 内置 | 同上，且关乎签名校验安全链 |
| `PIPICLAW_CLAWHUB_KEY` | `scripts/build-registry.mjs:69,81`（构建时私钥路径） | 构建仓库签名用私钥 | `--key` 参数 > env > `scripts/` 默认 | 用户在 `setx` 里配置过私钥路径，硬改会导致构建签名失败 |

### C 类 · 鸿蒙壳注入（中风险，需同步改壳）

| 变量 | 读取位置 | 用途 | 默认值 | 风险说明 |
|---|---|---|---|---|
| `PIPICLAW_PLATFORM` | `electron/platform/detect.ts:16`<br>`ohos/scripts/sync-assets.mjs:108` (requiredEnv) | 平台判定 | 无 | 壳工程注入这份精确名单；漏改 → 鸿蒙识别失败 |
| `PIPICLAW_USER_DATA` | `electron/platform/HarmonyHost.ts:44`<br>`ohos/scripts/sync-assets.mjs:108` (requiredEnv) | 数据/日志落点 | `~/.pipiclaw-ohos` | 鸿蒙沙箱下 `homedir()` 可能不可写，**此变量必须注入**，改名需同步壳 |
| `PIPICLAW_APP_PATH` | `electron/platform/HarmonyHost.ts:76`<br>`ohos/scripts/sync-assets.mjs:108` (requiredEnv) | 技能加载根路径 | `join(base,'app')` | 同上 |
| `PIPICLAW_VERSION` | `electron/platform/HarmonyHost.ts:68`<br>`ohos/scripts/sync-assets.mjs:108` (requiredEnv) | 版本显示 | `'0.0.0'` | 同上 |
| `PIPICLAW_OHOS_ASSET_DIR` | `ohos/scripts/sync-assets.mjs:32,33` | 构建输出目录覆盖 | 默认 rawfile 路径 | 打包脚本调用点需同步 |

> 相关声明文件也含这些名字（改则一并同步）：
> `ohos/entry/assets/app/package.json:13-16`、`ohos/third_party/runtime/.../app/package.json:13-16`、`docs/鸿蒙PC-DevEco真机调试手册.md` 多处、`ohos/README.md:83-93,128`。

### D 类 · 相关非环境变量（本次不在替换范围，但品牌一致性需知晓）

| 名称 | 位置 | 类型 | 说明 |
|---|---|---|---|
| `#pipiclaw-app` | `src/App.vue:3,41` | DOM id / CSS 选择器 | 改需同步改模板与样式 |
| `pipiclaw_recent_commands` | `src/components/common/CommandPalette.vue:131,392,399` | localStorage key | **改会导致用户历史命令丢失** |
| `pipiclaw:locale` | `src/locales/index.ts:12`、`src/views/Settings.vue:676` | localStorage key | 改会导致用户语言偏好重置 |
| `pipiclaw_onboarding_events` | `src/components/guide/FirstLaunchGuide.vue:178` | localStorage key | 改会导致引导状态丢失 |
| `~/.pipiclaw-ohos` | `electron/platform/HarmonyHost.ts:44` | 默认目录名 | 改会导致老数据找不到 |
| `.claude/settings.local.json` | 51-63 行 | 权限白名单 | 含 5 个 CALIBRATION 变量命令，改后白名单失效 |

---

## 2. 三种替换方案对比

| 方案 | 做法 | A 类 | B 类 | C 类 | 老用户影响 |
|---|---|---|---|---|---|
| **① 双名兼容（推荐）** | 统一读取层 `getEnv('NW_X','PIPICLAW_X')`，新名优先旧名兜底 | 换 | 双读 | 双读 | 零影响，后续可加弃用警告 |
| ② 只换 A 类 | 替换内部开关 + 测试注入点 | 换 | 不动 | 不动 | 零影响，但品牌不彻底 |
| ③ 全部硬替换 | 字符串全量替换 | 换 | 换 | 换 | **B 类配置失效、C 类鸿蒙启动失败** |

---

## 3. 建议

- **不要做方案 ③**。B 类属"看起来改完、实际把用户配置改坏"的静默故障，且 ClawHub 公钥关乎签名安全链。
- 若追求品牌彻底统一，走**方案 ①**：先加读取层双读，文档/UI 全部写 `NW_*`，观察一个大版本后移除旧名兜底。
- 若只想快速收尾，走**方案 ②**：A 类整批换，B/C 保持现状并在代码注释标注"兼容性保留"。

---

## 4. 本轮操作记录

- 仅执行读取与检索，**未修改任何代码**。
- 审计口径：`electron/`、`src/`、`scripts/`、`tests/`、`ohos/scripts/`、`bin/` 下的 `.ts/.vue/.mjs/.js/.json`，并交叉核对文档引用。
- 26 个变量的去重清单由 `grep -rho 'PIPICLAW_[A-Z0-9_]*' … | sort -u` 生成；行号来自逐文件 grep 结果。
