import { defineConfig } from 'vitest/config'
import vue from '@vitejs/plugin-vue'

/**
 * New World - 纯 Web 渲染 e2e(vitest + Playwright chromium)
 *
 * 覆盖范围:
 *   - tests/e2e/routes-render.test.ts   (核心路由 no-fallback 冒烟)
 *
 * 前置条件(跑前必须就绪):
 *   1. 浏览器:  npx playwright install chromium
 *      浏览器装到项目内 node_modules/playwright-core/.local-browsers,
 *      通过 test:e2e 的 PLAYWRIGHT_BROWSERS_PATH=0 钉死该路径,
 *      不依赖用户环境的全局缓存(防被清)。
 *   2. dev server: 本配置 webServer 自动拉起 `npx vite --config vite.config.e2e.mts`
 *      (纯前端,不带 Electron);端口由 vite 自取,webServer.url 指向它。
 *
 * 跑法:  npm run test:e2e
 *   等价:PLAYWRIGHT_BROWSERS_PATH=0 npx vitest run --config vitest.e2e.config.ts
 *
 * ⚠️ 不要跑 tests/e2e/*.spec.ts(那些是 @playwright/test 起 Electron 应用的用例,
 *    走 `npx playwright test`,不是本 runner。把 spec 塞进 vitest 会假失败。)
 */
export default defineConfig({
  plugins: [vue()],
  test: {
    environment: 'node',
    pool: 'forks',
    isolate: true,
    include: [
      'tests/e2e/routes-render.test.ts',
      // NOVA #004-B · M3(第③笔): 联网搜索路由 + stub 结果渲染同族(纯前端 web e2e)
      'tests/e2e/nova-search.e2e.test.ts',
      // NOVA #005-B · M4(第③笔): 语音路由 + stub speak 状态机(纯前端 web e2e; 同型于 nova-search)
      'tests/e2e/nova-voice.e2e.test.ts'
    ],
    exclude: [
      'node_modules/**',
      'dist/**',
      'dist-electron/**',
      // 关键:.spec.ts 全部排除 — 那是 @playwright/test 起 Electron 的应用级用例,
      // 不属于本 web 渲染 e2e
      'tests/e2e/**/*.spec.ts'
    ],
    // Web server: 纯前端 vite。命令必须不带 Electron(用户规格要求)。
    // 端口 4173 与 dev(5173)分家。
    // 用 `node node_modules/vite/bin/vite.js` 直接起,绕开 Windows npx(.cmd) ENOENT;
    // 路径以仓库根为基准(vitest 的 cwd 就是仓库根)。
    webServer: {
      command: 'node node_modules/vite/bin/vite.js --config vite.config.e2e.mts --port 4173 --strictPort',
      url: 'http://localhost:4173',
      cwd: process.cwd(),
      timeout: 60000,
      reuseExistingServer: false,
    },
    // chromium 启动 + 页面加载需要时间
    testTimeout: 30000,
    hookTimeout: 60000,
    // 浏览器缺失 → 响亮报错(用户验收条件3)
    // routes-render 的 beforeAll 里 chromium.launch 若找不到浏览器会 throw,
    // vitest 会把用例标记 failed,文件级 failed,退出码 1。
    bail: 0,
  },
})
