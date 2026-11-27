import { defineConfig } from 'vitest/config'
import vue from '@vitejs/plugin-vue'
import { fileURLToPath } from 'node:url'
import { precompileI18nPlugin, vueI18nRuntimeAlias } from './build/precompile-i18n'

/**
 * Vitest 配置
 *
 * 覆盖范围：
 * - tests/unit/**\/*.test.ts        (单元测试)
 * - tests/integration/**\/*.test.ts (集成测试)
 *
 * 暂不覆盖：
 * - tests/e2e/**\/*.spec.ts        (Playwright e2e，W12 才建)
 * - dist-electron/**                (构建产物)
 *
 * 环境：jsdom（Vue / DOM API 友好）
 */
export default defineConfig({
  plugins: [vue(), precompileI18nPlugin()],
  define: {
    // 【CSP 加固】启用 vue-i18n JIT 特性标志(runtime bundle 需要它注册 AST 解释器)
    __INTLIFY_JIT_COMPILATION__: JSON.stringify(true),
  },
  test: {
    environment: 'jsdom',
    globals: false,
    // 【P0 工程规范】coverage 插桩会让耗时测试变慢(实测 chat-to-agent 5s 默认超时被顶爆) → 全局放宽到 15s
    testTimeout: 15_000,
    // 每个测试文件独立 mock 模块(避免共享 userData 路径污染)
    pool: 'forks',
    isolate: true,
    include: [
      'tests/unit/**/*.test.ts',
      'tests/integration/**/*.test.ts'
    ],
    exclude: [
      'node_modules/**',
      'dist/**',
      'dist-electron/**',
      'tests/e2e/**'
    ],
    setupFiles: ['./tests/unit/i18n-setup.ts', './tests/unit/electron-setup.ts'],
    // 成品交付库是 Node 侧实现（内部 import node:https 等内置模块）。
    // jsdom 环境若把 ESM 包内联解析会把 'https' 当裸包，报 "Failed to resolve entry for package https"。
    // 交给 Node 原生加载即可；这些库只在主进程 execute() 里用，不进渲染 bundle。
    server: {
      deps: {
        external: ['exceljs', 'pptxgenjs', 'docx', 'jszip'],
      },
    },
    coverage: {
      provider: 'v8',
      reporter: ['text', 'html', 'json-summary'],
      reportsDirectory: './coverage',
      // 【沙箱兼容】默认 true 会在跑前 rm 整个 coverage/(292 文件 > 垫片 50 阈值 → fail-closed)。
      // 关掉后报告同名覆盖写, CI(ubuntu 无垫片)行为不变。
      clean: false,
      include: [
        'electron/**/*.ts',
        'src/**/*.ts',
        'src/**/*.vue'
      ],
      exclude: [
        'electron/types/**',
        'electron/**/*.d.ts',
        '**/*.test.ts',
        '**/*.spec.ts'
      ],
      // 【P0 工程规范】覆盖率门禁: 基线 2026-11-24 = lines 54 / funcs 65.7 / branches 77.7。
      // 阈值略低于基线起步, 只许升不许降 —— 负责人: 新功能必须带测试, 老代码逐步补。
      thresholds: {
        lines: 50,
        functions: 60,
        branches: 70,
        statements: 50,
      },
    }
  },
  resolve: {
    alias: [
      { find: '@', replacement: fileURLToPath(new URL('./src', import.meta.url)) },
      { find: '~', replacement: fileURLToPath(new URL('./', import.meta.url)) },
      // 【CSP 加固】src/locales/index.ts 会加载预编译 AST 消息(generated/*.ast.json),
      // runtime bundle 才支持 AST 的 JIT 解释; full bundle 会抛错被吞、t() 返回 AST 对象
      ...Object.entries(vueI18nRuntimeAlias).map(([find, replacement]) => ({
        find,
        replacement: replacement as string,
      })),
      // 【成品交付】pptxgenjs 的 package.json 把 https/fs/os/path 等 node 内置模块
      // 在 browser 条件下映射成 false；jsdom 测试里这会让 vite 把 'https' 当裸包解析并报
      // "Failed to resolve entry for package https"。这里强制解析到 node: 内置模块。
      { find: /^https$/, replacement: 'node:https' },
      { find: /^http$/, replacement: 'node:http' },
      { find: /^fs$/, replacement: 'node:fs' },
      { find: /^os$/, replacement: 'node:os' },
      { find: /^path$/, replacement: 'node:path' },
    ],
  }
})
