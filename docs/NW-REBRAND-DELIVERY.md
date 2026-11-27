# New World (NW) — 品牌替换 + 语义化生命动效 · 交付记录

> 日期：2026-11-23　｜　范围：PiPiClaw → New World (NW) 品牌重命名 + 数据驱动的呼吸/神经/token 动效落地 + Neural Core 深色主题 + 主进程真实 token usage 接入
> 备份目录：`.nw-backup-1795400369/`（第一轮）、`.nw-dark-backup-1795400955/`（深色主题）、`.nw-usage-backup-1795401282/`（usage 链路）、`.nw-env-backup-1795402462/`（环境变量全量替换）、`.nw-ohos-backup-1795403046/`（鸿蒙壳补漏）、`.nw-lowercase-backup-1795404510/`（小写运行时标识替换）、`.nw-theme-backup-1795413755/`（主题配色修复）、`.nw-breath-backup-1795414579/`（环境呼吸增强）

---

## 0-g. 追加：环境呼吸增强（第八轮）

针对第七轮量化评估结论（整页仅 1 个动画元素、活覆盖率 0.16%，"遥测真实但感知不足"）落地环境呼吸：让 **页面氛围层与 orb 光晕与生命体同频呼吸**。

### 设计

**周期单源**：呼吸周期只在 orb store 定义（`BREATH_MS: idle 4200 / listening 2400 / thinking 1500 / speaking 1050 / hidden 0`），通过 watch 广播为根级 CSS 变量 `--nw-breath`，氛围层与光晕层都引用同一变量 —— **永远同频，无第二处周期定义**。

### 实现（3 文件 + 1 测试）

1. `src/stores/orb.ts`：`syncBreathToRoot()` + `watch(breathDuration, syncBreathToRoot, { immediate: true, flush: 'sync' })` 广播 `--nw-breath`；hidden(0ms) 不同步，环境保持上一有效周期。
2. `src/components/nova/NovaOrb.vue`：`.orb-core` 加 `nw-glow` 光晕动画（scale 0.86↔1.14、opacity 0.5↔1，周期 `var(--breath)`）。
3. `src/styles/global.scss`：dark 主题 `body::after` 氛围层（网格+辉光）加 `nw-atmosphere` 动画（opacity 0.45↔1，周期 `var(--nw-breath, 4.2s)`）；`prefers-reduced-motion` 下全部关闭。
4. `tests/unit/orb.test.ts`：新增 B1-B4 广播测试（初始 4200ms / 状态迁移同步 / finish 回 idle / hidden 不覆盖）。

> 排错备忘：Vue watch 默认 `flush: 'pre'` 是异步微任务调度，同步断言 CSS 变量会拿到旧值；对根级变量广播用 `flush: 'sync'`（状态一变立即广播，语义也更正确）。

### 验证

| 检查项 | 结果 |
|---|---|
| `npx vue-tsc --noEmit` | ✅ Exit 0 |
| orb 单测 | ✅ 30/30（原 26 + 新 B1-B4） |
| 全量单测 | ✅ 149 files / 1639 passed / 18 skipped |
| `npx vite build` | ✅ dist + dist-electron 全部更新 |
| Electron 运行态：根级广播 | ✅ `--nw-breath = 4200ms` |
| Electron 运行态：氛围层 | ✅ `nw-atmosphere` 4.2s，opacity 实测 0.45↔1.00 涨落（14 次采样恰好一个周期） |
| Electron 运行态：光晕同步 | ✅ `.orb-core nw-glow` 4.2s 与 `.orb-circle nw-breathe` 4.2s 同频 running |
| 截图目视 | ✅ 中央 orb 光晕呼吸、背景辉光氛围、暗色一致（见 `.tmp-breath-verify.png`） |

**对比第七轮基线**：动画元素 1 → 3（orb 本体 + 光晕 + 氛围层，后者为伪元素不计入元素普查）；氛围层从静态 → 全页 0.45↔1.00 涨落；空状态页覆盖率 0.16% → 0.64%（元素口径），且新增的是**整页氛围**而非局部元素 —— 环境感显著增强。

> 运行态排错备忘：Playwright 驱动需 `NW_E2E=1` 旁路 BootOrchestrator（否则窗口被关闭）；首启欢迎向导（FirstLaunchGuide）是禁用了 Esc/点外关闭的 el-dialog，截图前需 `document.querySelectorAll('.el-overlay').forEach(o => o.style.display='none')` 隐藏。

---

## 0-f. 追加：深色主题配色修复（第七轮）

用户验收截图反馈：创建对话后**顶部标题栏与底部输入区是浅灰/白色块**，与深空蓝黑主题割裂。

### 根因

1. **直接原因**：`src/views/Chat.vue` 两处硬编码白底 —— `.chat-header`（`rgba(255,255,255,0.7)`）与 `.input-area`（`rgba(255,255,255,0.8)`），不随主题变化。
2. **系统性原因**：多个页面用 `var(--card-bg, #fafafa)` / `var(--text-secondary, #666)` 这类**带浅色 fallback 的局部变量**，而这些变量从未在主题里定义 → 两套主题都固定落到 hex fallback，深色底上出现深灰文字 / 浅色卡片。静态审计发现 **19 处浅色 fallback + 24 处深灰 fallback**，分布在 Chat/Demo/IM/ModelCompare/SkillsView 等 8+ 页面。

### 修复

- `Chat.vue`：`.chat-header` / `.input-area` 的 `background` → `var(--bg-material)`（light 下 `rgba(255,255,255,0.72)`、dark 下 `rgba(14,19,32,0.72)`，保留 backdrop blur）；border → `var(--border-subtle)`。
- `tokens.css`：在 light / dark / system-dark **三个主题块**统一补齐语义别名：`--card-bg`→`--bg-elevated`、`--border-color`→`--border-base`、`--text-primary/secondary`、`--muted-foreground`、`--fg-muted`、`--accent-color`、`--danger-color`、`--success-color`。一处定义覆盖全部 43 处 fallback，两套主题自动跟随。
- `A5ComputerUseDemo.vue`：两处硬编码状态色 → `var(--success-color/danger-color)`。
- **合理保留**：状态指示色（橙/红/黄圆点）、像素头像黄色渐变、toggle 白色圆点、主色按钮白字。
- 备份：`.nw-theme-backup-1795413755/`。

### 验证（真实 Electron 运行态）

| 检查项 | 结果 |
|---|---|
| `npx vue-tsc --noEmit` | ✅ Exit 0 |
| `npx vite build` | ✅ 产物无 `rgba(255,255,255,0.7/0.8)` 残留 |
| 浅色/深灰 fallback 审计 | ✅ 两项均归零（原 19 + 24 处） |
| Playwright 驱动 Electron 实测 | ✅ `.chat-header` 与 `.input-area` 计算样式均为 `rgba(14,19,32,0.72)`，文字 `rgba(233,244,255,0.94)`，主题 `dark` |
| 截图目视 | ✅ 顶部/底部浅色块消失，整体深空蓝黑一致 |

> 排错备忘：宿主环境残留 `ELECTRON_RUN_AS_NODE=1` 会让 Playwright 的 `electron.launch()` 报 "Process failed to launch"，需在 env 中 `delete` 该变量（e2e helper 已有同款处理）。

---

## 0-e. 追加：Windows 安装包重新打包（第六轮）

第五轮替换完成后重新打包 NSIS x64 安装包（此前 `release/` 里的包是 11:22 旧品牌产物）。

### 过程与踩坑

- 直接 `npm run build:win` 失败：`build.mjs` 的 moveAside 阶段要把 `release/` 重命名为备份，但 `release/win-unpacked/resources/app.asar`（122MB）被某进程持有**共享读句柄**，目录 rename 报 EPERM（3 次重试均失败）；无任何 electron / New World 进程，Defender/索引服务之类持有句柄。
- 规避：`build.mjs` 失败时已把第五轮干净的 `dist/`、`dist-electron/` 移到 `.bak`，先恢复这两个目录；再用临时配置 `.tmp-builder-new.json5`（仅把 `directories.output` 改为 `release-new`）直接跑 `npx electron-builder -c ... --win`，43 秒构建成功，绕开被锁的 `release/`。
- 新包生成后旧 `release/` 的 `app.asar` 句柄恰好释放（文件可独占打开），逐个 `cp -f` 覆盖 `Setup.exe`/blockmap/`latest.yml`/`builder-debug.yml` 与 `win-unpacked/`，标准 `release/` 目录更新为新包。
- 残留：`release-new/` 目录的 `app.asar` 仍被锁无法删除（117MB，句柄未释放，重启后清理即可）；不影响交付，`release/` 已是新包。

### 产物验证（asar 解包对比）

| 项 | 旧包（11:22） | 新包（13:07） |
|---|---|---|
| 文件大小 | 98,248,304 B | 98,179,954 B |
| `PiPiClaw` | 11 处 | 0 |
| `app://pipiclaw` / `pipiclaw-filesystem` / `pipiclaw.log` | 各 1 处 | 0 |
| `New World` / `NW_` | — | 14 / 27 处 |
| `app://newworld` / `newworld-filesystem` / `newworld.log` | — | 各 1 处 |

- 最终产物：`release/New World-4.5.0-alpha-Setup.exe`（94MB，2026-11-23 13:07）。
- `latest.yml` sha512 / size 已随新包更新；`electron-builder.json5` 的 `appId=com.newworld.nw` / `productName=New World` / `shortcutName=New World` 均生效；`publish.repo` 保留 `pipiclaw`。
- 签名：electron-builder 自动 signtool 签名通过（exe / elevate.exe / uninstaller）。

---

## 0-d. 追加：内部小写运行时标识全量替换（第五轮）

用户要求"不保留内部小写运行时标识，都换成 `newworld`"。

### 改动

- **552 处 / 329 文件**：`pipiclaw` → `newworld`（标识符）、`PiPiClaw` → `New World`（展示/注释）、`piPiClaw` → `nwWorld`、`Pipiclaw` → `Newworld`、`PIPICLAW` → `NEWWORLD`。
- 运行时标识落地：`newworld.log`、`app://newworld`、`.newworld-secrets`、`newworld-url-*/skill-*/e2e-*` 临时前缀、`newworld-filesystem` MCP server 名、`newworld/sandbox-base` Docker 镜像、`~/.newworld/` 状态目录、测试夹具路径。
- **本地密钥** `~/.pipiclaw-secrets/clawhub-dev-ed25519.key` 复制到 `~/.newworld-secrets/`（原件保留，功能不中断）。
- 安全 guard 加固：`SECRETS_GUARD_PATTERNS` 同时保留 `.newworld-secrets` 与 `.pipiclaw-secrets`（旧目录真实存在，必须继续 deny），补单测。
- 全量重建：`rm -rf dist-electron && npx vite build`（避免孤儿 chunk）→ `npm run ohos:sync`（3.13 MB）。
- 修复两处替换引入的断言：`mcp-filesystem-poc.mjs`（check `new-world`）、`agent-tools.test.ts`（pattern `NEW WORLD`）。

### 验证

| 检查项 | 结果 |
|---|---|
| `npx vue-tsc --noEmit` | ✅ Exit 0 |
| `npx vitest run --maxWorkers=2 --minWorkers=1` | ✅ 149 files / 1635 passed / 18 skipped，Exit 0 |
| `npx vite build`（全量重建） | ✅ |
| `npm run ohos:sync` | ✅ 3.13 MB |
| 源码残留 | ✅ 仅 7 处功能性例外（真实路径/URL/publish.repo/安全 guard） |
| 构建产物残留 | ✅ 仅 2 处受保护字符串 |

### 回滚

```bash
cd D:/pipiclaw/piclaw
cp -r .nw-lowercase-backup-1795404510/. ./
rm -rf dist-electron && npx vite build && npm run ohos:sync
```

---

## 0-c. 追加：环境变量全量替换 + 鸿蒙壳补漏（第四轮）

用户授权理由：**程序尚未推送，无老用户配置兼容负担** → 采用审计文档中的方案 ③（全量硬替换），而非原先推荐的双名兼容。

### 替换内容

- **主替换**：26 个 `PIPICLAW_*` → `NW_*`，同步替换 `nw_recent_commands` / `nw:locale` / `nw_onboarding_events` / `#nw-app` / `.nw-ohos`。
- **覆盖**：45 个文件含 220 处 `PIPICLAW_*`；11 个文件含旧 localStorage / DOM 标识；备份 `.nw-env-backup-1795402462/`（52 文件 / 2.3MB）。
- **补漏**（首轮 grep 口径未覆盖展示品牌与 bundle 标识）：87 处定点替换 / 8 文件，含 `bundleName` → `com.newworld.nw`、鸿蒙应用名 → `New World`、ETS 注释中的 13 处旧环境变量名、签名文档与调试手册；生成清单键 `pipiclaw` → `newworld`。
- **陈旧产物**：删除无引用的孤立 chunk `dist-electron/index-B9TqVg5y.js`（含旧 `PIPICLAW_E2E`），`npm run ohos:sync` 重建 `ohos/entry/assets/app/`（3.40 MB）。

完整映射、清单、保留项见 `docs/NW-ENV-VARIABLE-AUDIT.md` 的「执行结果」节。

### 验证

| 检查项 | 结果 |
|---|---|
| `npx vue-tsc --noEmit` | ✅ Exit 0 |
| `npm test` 全量 | 首轮高并行遇 Windows 临时目录锁竞态（`run-checkpoint.test.ts` 首个用例 5s 超时 → `EBUSY` 级联）；单独重跑 9/9 通过。改用 `npx vitest run --maxWorkers=2 --minWorkers=1` 后 **149 files / 1635 passed / 18 skipped，Exit 0** ✅ |
| `npm run ohos:sync` | ✅ preload CJS 检查通过，3.40 MB |
| 构建产物残留 | ✅ `dist/`、`dist-electron/`、`ohos/entry/assets/app/` 中 `PIPICLAW_` 零残留，`NW_E2E` 存在 |
| 源码 / 配置 / 用户文档残留 | ✅ 旧环境变量与旧标识零残留 |
| JSON 合法性 | ✅ 三个 `string.json` + 生成的 `package.json` |

### 回滚

```bash
cd D:/pipiclaw/piclaw
# 全量替换前状态（保留原目录结构，按相对路径逐文件覆盖）
cp -r .nw-env-backup-1795402462/. ./
# 鸿蒙补漏前状态
cp -r .nw-ohos-backup-1795403046/. ./
# 重新同步生成 ohos/entry/assets/app/
npm run ohos:sync
```

> 注：`cp -r` 会把备份目录本身也复制进工作区，仅需其中文件；回滚后删除 `.nw-*-backup-*` 目录即可。

---

## 0-b. 追加：主进程真实 token 精确计数（第三轮）

字符估算升级为**主进程 LLM 层真实 usage**（与 CostTracker 记账同源）：

| 文件 | 改动 |
|---|---|
| `electron/chat/ChatManager.ts` | `dispatchToAgent` 拿到真实 `promptTokens/completionTokens/totalTokens` 后，新增 `broadcastUsage()` 广播到 IPC 通道 `chat:usage`（与 CostTracker 记账同源，避免账上一个数界面另一个数） |
| `electron/preload.ts` | 新增 `CHAT_ON_USAGE` 通道常量 + `chat.onUsage()` 订阅方法 |
| `src/stores/chat.ts` | 订阅 `onUsage`，当前会话的 usage → `orbStore.setExactUsage()`，惰性 import 避免初始化环，含取消订阅清理 |
| `src/stores/orb.ts` | 新增 `setExactUsage()`（真实值覆盖估算、按 completion/耗时算真实 tok/s、用真实 promptTokens 更新上下文）、`markGenerationStart()`、`roundActive` 轮次状态机、`usageSource`/`exactPromptTokens`/`exactCompletionTokens`/`usageModel` 字段。流式期间仍用 `noteToken()` 字符估算做**实时**粒子反馈，精确值到达后覆盖 |
| `src/views/Chat.vue` | tooltip 显示数据来源（真实 usage / 流式估算）+ 输入/输出分项 + 模型名；状态栏精确值加 `✦` 标识 |
| `tests/unit/orb.test.ts` | 追加 6 项精确 usage 测试（U1–U6） |

**数据流**：LLM 适配器 usage chunk → `LlmAgentBrain` 聚合 → `ChatManager.dispatchToAgent` payload → CostTracker 记账 **+** `chat:usage` 广播 → preload `onUsage` → chat store → orb store `setExactUsage` → 生命体 Orb 精确遥测。

**降级策略**：老 provider 不回传 usage 时，仍用流式字符估算（~3 字符/token），`usageSource='estimate'`；精确值到达切换为 `'exact'`。

验证：`vue-tsc` ✅ / `vite build` ✅ / orb 测试 **26/26**（原 20 + 新 6）✅ / IPC 通道三端一致 ✅
备份：`.nw-usage-backup-1795401282/`

---

## 0. 追加：Neural Core 完整深色主题（第二轮）

概念图 01「神经核心」已落地为全局 dark 主题：

| 文件 | 改动 |
|---|---|
| `src/styles/tokens.css` | `:root[data-theme='dark']` 整块换成深空蓝黑（`#06080f`）+ 青紫辉光分层；强调色 `--accent-base` 由系统蓝 `#0a84ff` → NW 青 `#22d3ee`；同步全部 Element Plus dark 变量、阴影、滚动条、功能色。`@media (prefers-color-scheme: dark) :root:not([data-theme])` 跟随系统块同步同款配色 |
| `src/styles/global.scss` | 末尾追加 NW 氛围层：极淡青色网格 + 顶部青紫辉光，固定覆盖层 `pointer-events:none`，mask 渐隐；`prefers-reduced-motion` 下关闭 |

- **light 主题完全保留**——用户可在设置里切回浅色，两套主题并存。
- 验证：`vue-tsc` ✅ / `vite build` ✅ / Playwright 截图核对（深空底、青紫强调、对比度清晰）✅
- 备份：`.nw-dark-backup-1795400955/`（tokens.css / global.scss / Models.vue 改前）

---

## 1. MODIFIED — 改了什么

### A. 语义化生命动效（核心）
| 文件 | 改动 |
|---|---|
| `src/stores/orb.ts` | 追加数据层：`activity`(神经激活) / `tokenCount` / `tokenRate` / `contextUsage` / `pulseSeq`；`breathDuration`(呼吸周期随状态)；方法 `noteAttention` / `noteToken` / `setContextUsage` / `decayActivity` / `settleMetrics`。**原 4 态优先级逻辑完全不动** |
| `src/components/nova/NovaOrb.vue` | 重写为数据驱动：呼吸周期由 `breathMs` 控制、12 突触按 `activity` 点亮、神经脉冲按激活度发射、token 粒子由 `pulseSeq` 触发、上下文压力环青→紫→橙。向后兼容（只传 size/state 也能工作）；遵循 `prefers-reduced-motion` |
| `src/stores/chat.ts` | `handleStreamChunkEvent` 中：当前会话的 content delta → `orb.noteToken()` 并切 speaking，惰性 import 避免 store 初始化环 |
| `src/views/Chat.vue` | 两处 NovaOrb 传入全部数据 props；上下文占用按真实消息字符量估算（128k 窗口）；悬浮 tooltip 展示五项体征；新增 `tok/s` 显示 |
| `tests/unit/orb.test.ts` | 追加 8 项 NW 语义测试（N1–N8） |

**动效 → 数据映射契约**：
```
呼吸周期 ← state      (idle 4.2s / listening 2.4s / thinking 1.5s / speaking 1.05s)
神经放电 ← activity   (思考强度, 点亮突触数 = activity × 12)
token 粒子 ← pulseSeq (每枚 token 一次喷射)
上下文色 ← contextUsage (青 <0.5 → 紫 <0.8 → 橙 >0.8)
```

### B. 品牌重命名（仅用户可见层）
- **标题/启动**：`index.html`（title + 启动页 NW 呼吸球）、`resources/splash.html`（NW logo 文案）
- **应用内文案**：TitleBar、CommandPalette、UpdateBanner、DevPanel、FirstLaunchGuide、Chat、RemoteControl、PluginMarket、Settings
- **i18n**：`src/locales/zh-CN.ts` / `en-US.ts` 用户可见字符串
- **注释头**：各 store/style/util 顶部注释统一为 New World
- **应用身份**：`package.json`(name=`/description/author`)、`package-lock.json` root name、`electron-builder.json5`(appId=`com.newworld.nw` / productName / shortcutName / synopsis)
- **图标**：`resources/icon-source.svg` + 全平台图标（ico/icns/png）换成 NW 六边形 logo，新脚本 `scripts/gen_nw_icons.py`（纯标准库可复现）
- **README**：标题与结尾品牌

### 明确保留（第五轮后的实际状态）

> 下方为**第一轮**记录，"兼容性红线"已在用户授权全量替换后解除；此处保留原文以说明当时的取舍。

第一版曾刻意保留以下内部标识，现已全部替换：
- ~~`localStorage` keys：`pipiclaw_recent_commands`、`pipiclaw:locale`、`pipiclaw_onboarding_events`~~ → 已换为 `nw_*`
- ~~环境变量：`PIPICLAW_CLAWHUB_REGISTRY`、`PIPICLAW_CLAWHUB_PUBKEY`~~ → 已换为 `NW_*`
- ~~DOM id / CSS 选择器：`#pipiclaw-app`~~ → 已换为 `#nw-app`
- ~~内部运行时小标识（`pipiclaw.log`、`app://pipiclaw`、`.pipiclaw-secrets`、临时前缀、MCP server 名）~~ → 第五轮已换为 `newworld*`

**第五轮后仍然保留（功能性例外）**：
- 更新源 `electron-builder.json5` 的 `publish.repo`（`pipiclaw`）—— 否则自动更新失效。
- 真实上游 URL 与工作区路径（`D:\pipiclaw\piclaw`、`github.com/pipiclaw`）—— 改则链接/路径失效。
- 历史文档 / CHANGELOG / 旧备份与旧构建包中的旧名称 —— 历史不改写。
- 安全 guard 中的 `.pipiclaw-secrets` 旧目录名 —— 本机旧密钥目录仍存在，必须继续 deny。

---

## 2. DIFF — 关键差异摘要

```diff
# src/stores/orb.ts (追加)
+  const activity = ref(0); const tokenCount = ref(0); const tokenRate = ref(0);
+  const contextUsage = ref(0); const pulseSeq = ref(0);
+  const breathDuration = computed(() => BREATH_MS[state.value]);
+  function noteToken(deltaLen) { ... tokenCount += ~len/3; tokenRate = 近1s计数; pulseSeq++ }
+  function finish() { state=idle; settleMetrics(); }  // 瞬态体征归零

# src/components/nova/NovaOrb.vue (重写)
+  <div :style="{'--breath': breath+'ms'}"> 呼吸周期数据驱动
+  <line v-for synapses :class="{lit: i<litSynapses}"> 激活度→突触点亮
+  <circle v-for neuralPulses> 神经放电
+  <rect v-for tokenParticles> token 粒子 (watch pulseSeq)
+  <div class="orb-context-ring" :style="{'--ctx-fill': contextUsage*360+'deg'}">

# src/stores/chat.ts
+  if (当前会话 && type==='content' && delta) {
+    import('@/stores/orb').then(({useOrbStore}) => {
+      orb.setState('speaking'); orb.noteToken(delta.length);
+    })
+  }

# src/views/Chat.vue
+  <NovaOrb :breath-ms :activity :token-rate :context-usage :pulse-seq />
+  watch(消息字符量 → orbStore.setContextUsage(估算))
```

完整 diff：`git diff`（50 files changed, 590 insertions, 272 deletions）

---

## 3. VERIFICATION — 验证结果

| 检查项 | 命令 | 结果 |
|---|---|---|
| 类型检查 | `npx vue-tsc --noEmit` | ✅ Exit 0 |
| Vite 构建 | `npx vite build` | ✅ Exit 0（既有 dynamic-import 警告与本次无关） |
| Orb 单元测试 | `npx vitest run tests/unit/orb.test.ts` | ✅ 20/20 passed（原 12 + 新 8） |
| 构建产物品牌 | grep `dist/` `dist-electron/` `ohos/entry/assets/app/` | ✅ 第一轮：无 `PiPiClaw` 展示文案；**第四轮补漏后：`PIPICLAW_*` 亦零残留** |
| localStorage key | grep 源码 | ✅ 第一轮原样保留；**第四轮已全量换为 `nw_*`** |
| 图标视觉 | ViewImage icon-512.png | ✅ 深底六边形 + 青紫 NW + 辉光，正确 |

效果图预览：
- `docs/NW-UI-Concept-Gallery.html`（4 版界面风格概念）
- `docs/NW-Living-Systems.html`（语义化生命动效可交互原型，点击四态切换观察）

---

## 4. ROLLBACK — 回滚方法

完整备份在 `.nw-backup-1795400369/`。如需回滚：

```bash
cd D:/pipiclaw/piclaw
BK=.nw-backup-1795400369
# 恢复被修改的文件
cp $BK/package.json $BK/electron-builder.json5 $BK/index.html $BK/README.md ./
cp $BK/TitleBar.vue src/components/layout/TitleBar.vue
cp $BK/NovaOrb.vue src/components/nova/NovaOrb.vue
cp $BK/orb.ts src/stores/orb.ts
cp $BK/chat.ts src/stores/chat.ts
cp $BK/Chat.vue src/views/Chat.vue
cp $BK/zh-CN.ts src/locales/zh-CN.ts
cp $BK/en-US.ts src/locales/en-US.ts
cp $BK/splash.html resources/splash.html
cp $BK/icon-source.svg resources/icon-source.svg
# 图标二进制如需恢复: cp $BK/icon.png $BK/icon.ico $BK/icon.icns resources/
# 注释头批量替换的回滚: 将各文件 " * New World - " 改回 " * PiPiClaw - "
# 测试文件: git checkout -- tests/unit/orb.test.ts
```

**深色主题回滚**（如只撤销第二轮、保留动效+品牌）：
```bash
cd D:/pipiclaw/piclaw
cp .nw-dark-backup-1795400955/tokens.css src/styles/tokens.css
cp .nw-dark-backup-1795400955/global.scss src/styles/global.scss
cp .nw-dark-backup-1795400955/Models.vue src/views/Models.vue
```

**精确 usage 回滚**（如只撤销第三轮、保留前两轮）：
```bash
cd D:/pipiclaw/piclaw
cp .nw-usage-backup-1795401282/ChatManager.ts electron/chat/ChatManager.ts
cp .nw-usage-backup-1795401282/preload.ts electron/preload.ts
cp .nw-usage-backup-1795401282/chat.ts src/stores/chat.ts
cp .nw-usage-backup-1795401282/orb.ts src/stores/orb.ts
cp .nw-usage-backup-1795401282/orb.test.ts tests/unit/orb.test.ts
# Chat.vue 的 usage 相关改动需手动还原(tooltip/状态栏 ✦ 标识), 或 git checkout
```

或最简：`git checkout -- .`（丢弃所有未提交改动，回到上一次 commit 状态）。

---

## 5. 待确认事项（下一步可选）
1. ~~风格合体：套用概念图 01 深色视觉~~ ✅ 已完成（第二轮）。
2. ~~token 真实值：接主进程 usage~~ ✅ 已完成（第三轮，见 0-b 节）。
3. ~~内部运行时小写标识全量替换~~ ✅ 已完成（第五轮，见 0-d 节）。
4. ~~Windows 安装包重新打包~~ ✅ 已完成（第六轮，见 0-e 节）：`release/New World-4.5.0-alpha-Setup.exe`（94MB，13:07），asar 解包验证旧标识清零。
5. **usage 事件时机**：当前 usage 在 `dispatchToAgent` 完成后广播（一轮结束），因此精确 tok/s 是本轮平均值而非流式瞬时值；流式期间用字符估算做实时反馈。如需逐 token 精确瞬时速率，需 LLM 适配器在 SSE usage chunk 到达时逐条推送（改动适配器层，非必须）。
6. **构建产物卫生**：`vite build` 不会清空 `dist-electron/`，曾留下无引用的旧 chunk（第五轮已通过先 `rm -rf dist-electron` 规避）。发布前建议走完整 `npm run build`（含 `--skip-electron` 前的 moveAside 清理），或在构建配置中为 electron 输出加 `emptyOutDir`。
