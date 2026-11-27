# NOVA #009 — M4-Z：让构建门禁"红得说得清"

> **状态**：已实现（2026-11-20）
> **对应台账**：DEV-176
> **分支**：`feat/harness-wiring`

## 一、起因

上一批（M4-Y）跑 `npm run build` 红过一次，我**说不清原因**：

- 分步跑 5 步 —— 全过
- 单独跑 `npx electron-builder` —— 也过
- 门禁却红了，报的是「未找到打包产物」

门禁红而原因不明，等于后面每一批的"三绿"都要打折。本批先把它查到底。

## 二、查到了什么

### 2.1 三处脚本缺陷，让"红"不可诊断

| # | 缺陷 | 后果 |
|---|---|---|
| ① | `run()` 用 `stdio:'inherit'` | 子进程输出**不落盘** → 红了没证据，只能靠"再跑一遍"猜 |
| ② | `timedOut` 在 `close` 回调里被写死成 `false`；真正判断超时那行是**同步执行**的死代码 | "超时被杀"与"普通失败"**长得一模一样** |
| ③ | `moveAside()` 的 `catch {}` 静默吞掉失败 | 旧 `release/` 被占着时照样跑 EB → EB 在 `unlink app.asar` 撞 `EBUSY` → 报成「未找到打包产物」，**真错误被埋两层** |

### 2.2 真实根因：一个外部文件锁

| 探针 | 结果 |
|---|---|
| `npx electron-builder` | `⨯ EBUSY: resource busy or locked, unlink 'release\win-unpacked\resources\app.asar'` |
| `fs.renameSync(app.asar)` | **EBUSY** |
| `fs.openSync(app.asar, 'r+')` | **成功**（能读能写） |
| `fs.renameSync('release')` | **EPERM** |
| `cmd /c del app.asar` | 「另一个程序正在使用此文件」 |
| 进程排查 | 无 PiPiClaw / electron / app-builder / 7za / MsMpEng |
| 另一份副本 | `release.bak-1795073156482/.../app.asar` **同样被锁** |
| 换输出目录打包 | ✅ 成功（97.8MB 安装包）→ **打包链本身健康** |

**判断**：有外部进程/驱动持有 `app.asar` 的句柄（可读写、未带 `FILE_SHARE_DELETE`，
故不可改名/删除），持续十几小时、跨两个目录副本。现有工具（无 Sysinternals
`handle.exe`）**无法定位持有者**。

### 2.3 第二层原因（被缺陷 ③ 放大）

上一次构建中止时 `dist-electron/` 已被移走却未重建 → 此后单独跑 electron-builder 会报
`Application entry file "dist-electron\main.js" ... was not found`。
与锁的问题**叠加**，让人更难看清。

## 三、做法

1. **核心逻辑抽到 `scripts/lib/build-runner.mjs`** —— `moveAside` / `runStep` /
   `readTail` / `findArtifact`。`scripts/build.mjs` 只负责编排与提示文案。
   抽出来是为了**可单测**：这三处缺陷都属于"出事了才知道它坏了"的类型。
2. **日志落盘**：`stdio:'pipe'` + tee，输出同时进控制台与
   `.tmp-build-logs/<step>.log`。失败时自动打印**日志路径 + 末尾 30 行**。
3. **超时如实上报** + 杀进程后 **15s 硬兜底**（`close` 不触发也不挂死）。
4. **移走失败 → 带诊断快速失败**：先重试 4 次（1.5/3/4.5s，覆盖杀毒扫描的瞬时锁），
   仍失败则中止并给出可操作说明（关应用 / 重试 / 重启 / `handle64.exe` 自检）。
5. `--skip-electron` 时不再移走 `release/`。

## 四、验证

| 项 | 结果 |
|---|---|
| `tests/unit/build-runner.test.ts` | **8 例**：正常执行落盘 / **超时如实上报且不挂死** / 移走成功 / 目录不存在跳过 / **移走失败必须返回失败** / `readTail` / `findArtifact` |
| `node scripts/build.mjs --skip-electron` | **退出码 0**，五个步骤日志全部落盘 |
| 完整 `npm run build` | **被外部文件锁挡住**（见下） |
| vitest | **144 files / 1564 passed / 0 FAIL / 17 skipped**（连跑两轮） |

**为什么探针用子进程**：`scripts/**` 下的 `.mjs` 在 vitest 里会被当作外部依赖按 CJS
加载 → ESM 语法直接炸；而构建脚本真实运行时就是纯 node，子进程跑反而更贴近真实。

## 五、仍未闭环

**那个外部文件锁还在**，需重启释放。故完整门禁（含 electron-builder）在当前机器上
**跑不成绿**。已分别验证：分步 1/2/3/5 全过；electron-builder 换输出目录成功产出安装包。

**重启后需要实跑确认 `npm run build` 恢复全绿** —— 这是本批唯一未闭合的验证项。

## 六、遗留与后续

| # | 遗留 | 说明 |
|---|---|---|
| 1 | 外部文件锁未定位 | 重启可释放。若复发，装 Sysinternals `handle64.exe` 定位持有者；可考虑把 `release/` 排除出杀毒扫描 |
| 2 | 构建日志不自动清理 | `.tmp-build-logs/` 每步一个文件，很小；暂不清理，必要时可并入 `cleanup-build-backups.mjs` |
| 3 | `moveAside` 的重试窗口 | 4 次共约 9s；若杀毒扫描更久仍会失败 —— 失败信息已足够可操作 |
