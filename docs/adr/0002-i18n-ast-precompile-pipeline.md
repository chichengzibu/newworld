# ADR-0002 · vue-i18n 免 eval 管线: 构建期 AST 预编译 + runtime bundle JIT

- 状态: accepted · 日期: 2026-11-23 · 影响面: vite.config.mts / vite.config.e2e.mts / vitest.config.ts 三处配置, 缺一即静默坏

## 背景

ADR-0001 收紧 CSP 后, vue-i18n full bundle 对**字符串消息**的运行时编译
(`compileToFunction` → `new Function`)被 CSP 拦截, 界面文案全部 EvalError。
免 eval 的唯一路径: 消息以 **AST 形态**进入运行时, 由 core-base 的
`isMessageAST` 分支做 JIT 解释(`format(ast)`, 零 new Function)。

## 决策(三层, 全部必需)

1. **构建期预编译**: `build/precompile-i18n.ts`(共享模块)在 buildStart 把
   `src/locales/{zh-CN,en-US}.ts` 逐条 `baseCompile` 成 AST JSON →
   `src/locales/generated/*.ast.json`(gitignored, 每次构建重生成)。
   `src/locales/index.ts` 用 import.meta.glob 优先取 AST, 缺文件回退字符串(仅测试兜底)。
2. **runtime bundle**: 三配置都 alias
   `vue-i18n → vue-i18n/dist/vue-i18n.runtime.esm-bundler.js`。
   full bundle 注册的 compileToFunction 收到 AST 会抛
   `NOT_SUPPORT_NON_STRING_MESSAGE` 且被 onError 吞掉, translate 返回原始 AST
   对象 → `t()` 返回对象, 界面文案全坏。
3. **JIT 特性标志**: 三配置都 define
   `__INTLIFY_JIT_COMPILATION__: JSON.stringify(true)`。
   runtime bundle 由此门控 `registerMessageCompiler(compile)`; 不注入则
   messageCompiler 为 null, t() 返回原始 AST 对象, 报
   `Unexpected return type in composer`(code 24)。

## 后果

- **任何一处配置缺失 = 静默坏**(不报构建错误, 运行时文案消失) —— 这是本决策最大的运维风险。
- dist 产物零 `new Function`, 与 ADR-0001 的 CSP 兼容。
- 新增语言需同步: locales/*.ts + precompileI18nPlugin 的 locales 数组 + index.ts 的 glob 键。

## 防回退

- build-report 隐患4(见 ADR-0001)拦 new Function 回归。
- `scripts/csp-verify.mjs` 无头冒烟 + final-acceptance A0(Electron 真实态)双验证。
- 已知实现细节: 共享模块用 `process.cwd()` 定位项目根(**勿用 __dirname**, vitest ESM 打包下未定义); `transformWithEsbuild` 在本版 vite 是 async。
