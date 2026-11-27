<!--
  PR 说明(New World) — 合并前自查清单:
  □ CI 全绿(三 OS 矩阵 / 覆盖率门禁 / audit 门禁)
  □ 新增功能带测试; 纯重构不改变行为
  □ 涉及 CSP/i18n 的改动重读 docs/adr/0001、0002
  □ 主题零改动承诺: 未动颜色 token(若动了必须在下文报备)
-->

## 改动说明

<!-- 一两句话说清楚: 做了什么 / 为什么 -->

## 改动类型

- [ ] 功能 (feature)
- [ ] 修复 (fix)
- [ ] 重构 (refactor, 行为零变化)
- [ ] 工程/CI (build, test, docs)
- [ ] 视觉 (UI/样式)

## 自查清单

- [ ] 本地全量单测通过 (`npx vitest run --minWorkers=1 --maxWorkers=2`)
- [ ] 构建门禁通过 (`npm run build --skip-electron`, 含 CSP 零 new Function)
- [ ] 涉及 UI 的改动附了截图(改动前后各一张)
- [ ] 涉及 IPC / 主进程的改动过 electron e2e (`E2E_ELECTRON=1 npx playwright test`)
- [ ] 配色主题零改动 (若改动颜色 token, 在此说明原因与范围)

## 关联

<!-- 关联 issue / ADR / 设计文档, 没有则写"无" -->
