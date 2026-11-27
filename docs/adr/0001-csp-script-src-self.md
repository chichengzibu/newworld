# ADR-0001 · CSP 收紧为 script-src 'self'

- 状态: accepted · 日期: 2026-11-23 · 影响面: 渲染进程安全基线

## 背景

Electron 发布前安全扫描报 Insecure CSP 警告: index.html 原有 CSP 的 script-src 含
`unsafe-eval` 与 `unsafe-inline`。前者是 vue-i18n 对字符串消息运行时编译
(`new Function`)所必需, 后者被内联脚本利用。Electron 主进程承担全部 LLM 请求,
渲染进程不直接出网 —— CSP 收紧不影响 LLM 功能。

## 决策

```html
<meta http-equiv="Content-Security-Policy"
  content="default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline';
           img-src 'self' data: blob:; font-src 'self' data:;
           connect-src 'self' https: http://127.0.0.1:* http://localhost:*
           ws://127.0.0.1:* ws://localhost:*" />
```

- script-src 仅 `'self'`, eval 与 inline 双禁。
- connect-src 保留 https: 与本地网关/Ollama 端口(主进程代理场景)。

## 后果

- 渲染进程内任何依赖 eval 的库(运行时模板编译等)都会直接 EvalError。
- 因此 i18n 必须改走免 eval 管线 → 见 [ADR-0002](./0002-i18n-ast-precompile-pipeline.md)。
- 收益: Electron 安全警告消除; 脚本注入面从「eval+inline」收敛为「仅静态产物」。

## 防回退(机器守, 不靠人记)

1. `scripts/build-report.mjs` 隐患4: dist/assets 任一 JS 含 `new Function` → 构建失败。
2. `ci.yml`: 断言 dist/index.html 含 `script-src 'self'` 且不含 unsafe-eval/unsafe-inline。
3. `tests/e2e/final-acceptance.spec.ts` A0: Electron 真实运行态 console 零 CSP/EvalError。
