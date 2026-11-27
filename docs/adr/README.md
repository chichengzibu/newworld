# ADR 索引 — New World 工程决策记录

> 规则: 每条不可逆/易回退的工程决策落地时补一条 ADR(背景 → 决策 → 后果 → 防回退)。
> 新会话/新成员先读索引, 再按需进单篇。**改决策 = 新增 ADR 并把旧的标记为 superseded, 不改写旧篇。**

| # | 状态 | 标题 | 日期 |
|---|---|---|---|
| [0001](./0001-csp-script-src-self.md) | accepted | CSP 收紧为 script-src 'self'(移除 unsafe-eval/unsafe-inline) | 2026-11-23 |
| [0002](./0002-i18n-ast-precompile-pipeline.md) | accepted | vue-i18n 走「构建期 AST 预编译 + runtime bundle JIT」免 eval 管线 | 2026-11-23 |
| [0003](./0003-build-lock-degraded-output.md) | accepted | 打包锁三级响应: 定位 → 自愈 → 输出降级到项目外 | 2026-11-24 |
| [0004](./0004-dependency-audit-baseline.md) | accepted | 依赖审计基线: 生产面 critical 硬门禁 + dev 链放宽 + 已知 high 台账 | 2026-11-24 |
