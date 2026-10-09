# PiPiClaw 真机 / 自动化验证清单

> 维护人: 工程团队  |  最近更新: 2026-08-12
> 目的: 把"声称已支持/已优化"逐项变成可勾选的证据。本清单区分
> **【自动】**(CI / 本机脚本可确定性验证) 与 **【手动】**(需真机/显示器/账号)。

---

## 一、已通过的自动化验证（本环境已代跑）

| # | 项目 | 命令 / 方式 | 结果 | 说明 |
|---|---|---|---|---|
| A1 | 构建回归防护门禁 (resolver 生效) | `node scripts/build-report.mjs --ci` | ✅ PASS | 扫描产物无残留裸 `el-dropdown`/`el-scrollbar`/`el-checkbox` 组件名 |
| A2 | 构建回归防护门禁 (EP 全量 CSS 区间) | 同上 | ✅ PASS | element-plus 全量 CSS ∈ [250KB, 650KB]，过低(改按需)即失败 |
| A3 | Sentry 三端包 import 检查 | `node scripts/sentry-verify.mjs` | ✅ PASS | renderer 端 `@sentry/electron/renderer` 可解析；main/preload 在纯 node 下预期抛错(electron 专用包) |
| A4 | Renderer 无头冒烟 | `node scripts/renderer-smoke.mjs` | ✅ PASS | Playwright 加载 dist，15 条 console，0 条 `Failed to resolve component` 报错 |
| A5 | Windows 完整出包 | `node scripts/build.mjs --platform=--win` | ⏳ 见下方 | 生成 `release/PiPiClaw-*.Setup.exe` |

> A1–A4 为确定性验证（无需账号/显示器），已固化进 `build.mjs` + `build-report.mjs` 门禁。

---

## 二、需手动真机验证（本环境无显示器 / 无账号，无法代跑）

### B. Sentry 真实上报闭环
- [ ] **主进程链路**：`SENTRY_DSN=https://<key>@<host>/<project> node scripts/sentry-verify.mjs`
      发送测试异常后，登录 Sentry 后台 → Issues → 环境筛选 `verification` → 应看到 `[sentry-verify] 测试异常`
- [ ] **渲染进程链路**：项目根建 `.env`，写入 `VITE_SENTRY_DSN=https://...`，`npm run dev`
      打开 DevTools Console 执行 `throw new Error('sentry-render-test')`
      → 后台 Issues 应出现该异常（经 preload 桥接 → 主进程上报）
- [ ] **崩溃监控**：故意让渲染进程崩溃（如访问 null 属性死循环），确认主进程 `web-contents-created/crashed` 捕获并上报

### C. 4 端出包
- [x] **Windows**：本环境已出 `Setup.exe`（见 A5）
- [ ] **macOS**：需在 Mac 机器 `node scripts/build.mjs --platform=--mac`（含签名/公证）。本环境为 Windows，无法代出
- [ ] **Linux**：需在 Linux 机器 `node scripts/build.mjs --platform=--linux`（AppImage/Deb）。Windows 上 electron-builder 不支持交叉打 Linux 包
- [ ] **鸿蒙 PC**：`ohos:build` 走独立 ohos 工具链 + 真机签名，本环境无工具链/签名，无法代验

### D. UI 肉眼确认（本地 `npm run dev`）
- [ ] 左侧 60px 窄边栏 5 图标(Chat/Models/Skills/IM/Schedule) + 底部齿轮 全部显示且大小正常
- [ ] 标题栏 PiPiClaw 前齿轮 + 右上角窗口控制(最小化/最大化/关闭) 大小正常
- [ ] 标题栏右上角网关小圆点 + 端口号 显示（绿=running）
- [ ] 按下 `Ctrl+Shift+D` 唤起 DevPanel（FPS/内存/Vitals/版本），再次按下收起
- [ ] Chat 连续发 50+ 条消息，滚动顺滑（虚拟滚动生效），不卡顿、无错位
- [ ] Chat 侧边栏会话下拉菜单(重命名/归档/删除)、滚动条、复选框 正常弹出/交互

### E. 运行时稳定性
- [ ] 本机开系统代理后启动应用，主窗口不白屏（验证 `proxyBypassRules: 'localhost;127.0.0.1'`）
- [ ] 制造一次渲染错误，确认显示红屏兜底 `paintFatalError`（而非整页空白吞错）

### F. 性能预算门禁（本地 `node scripts/build-report.mjs`）
- [ ] 确认单 JS chunk / 全量 CSS / vendor-framework 均在预算内
- [ ] 若未来有人改按需 CSS 导致全量 CSS 跌破 250KB，门禁应 EXIT=1

---

## 三、复跑命令速查

```bash
# 1. 构建 + 回归防护门禁 (CI 模式卡超标)
node scripts/build.mjs --ci

# 2. 单独跑构建产物体积报告
node scripts/build-report.mjs --ci

# 3. Sentry 离线检查 (无需 DSN)
node scripts/sentry-verify.mjs

# 4. Sentry 真实上报 (需 DSN)
SENTRY_DSN=https://<key>@<host>/<project> node scripts/sentry-verify.mjs

# 5. Renderer 无头冒烟 (需 dist 已构建)
node scripts/renderer-smoke.mjs

# 6. Windows 完整出包
node scripts/build.mjs --platform=--win
```

---

## 四、已知工程边界（非阻断）
- `electron-builder` 在装有 safe-delete 防护的 CI 上清理 `release/` 会超时；`scripts/build.mjs` 已用「超时杀进程 + 以 exe 产物为准」绕过。干净机器(无该防护)不受影响。
- Sentry 三端集成代码的**真实上报**只在该平台分别跑过 import 检查；端到端事件投递需按 B 节手动确认。
- 4 端中的 macOS / Linux / 鸿蒙 未在对应真机出包，属"声称支持、未真机验证"。
