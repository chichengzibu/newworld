import { test, expect, shouldRunElectronE2E } from './helpers/electron-app'
import { _electron as electron, type Page } from '@playwright/test'
import path from 'node:path'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

/**
 * VERIFICATION E1 —— 开了系统代理时,主窗口不白屏
 * ═══════════════════════════════════════════════════════════════════════
 * 【清单原话】
 * 「本机开系统代理后启动应用,主窗口不白屏(验证 proxyBypassRules:
 *   'localhost;127.0.0.1')」
 *
 * 【为什么不真去改系统代理设置】
 * 改系统代理是**影响用户机器全局状态**的动作 —— 忘了还原会连别的应用一起
 * 断网,且本机无法保证还原。这里用**等效手段**:给 Electron 进程传一个指向
 * **死端口**的 `--proxy-server`,效果等价于"系统代理开着且不可用"。
 * 这是更狠的版本:真代理不可用时最容易白屏。
 *
 * 【被验的那行代码】
 * `electron/main.ts` → `session.defaultSession.setProxy({ proxyBypassRules: 'localhost;127.0.0.1' })`
 * 它保证本地网关(localhost:端口)不被代理拦截。
 */
test.describe('VERIFICATION E1 · 系统代理下不白屏', () => {
  test.skip(!shouldRunElectronE2E, 'requires E2E_ELECTRON=1')

  test('E1: 代理指向死端口 → 主窗口仍正常渲染', async () => {
    const repoRoot = path.resolve(__dirname, '..', '..')
    const mainEntry = path.join(repoRoot, 'dist-electron', 'main.js')
    const userDataDir = mkdtempSync(join(tmpdir(), 'newworld-e2e-proxy-'))

    let page: Page | null = null
    let app: Awaited<ReturnType<typeof electron.launch>> | null = null
    try {
      // 【宿主环境清理】删除 ELECTRON_RUN_AS_NODE,否则 electron.exe 按 Node
      // 模式启动 → "bad option: --remote-debugging-port=0",launch 阶段必红。
      const { ELECTRON_RUN_AS_NODE: _drop, ...cleanEnv } = process.env as Record<string, string | undefined>
      app = await electron.launch({
        // 死代理:连 127.0.0.1:9 必然失败
        args: [mainEntry, '--no-sandbox', `--user-data-dir=${userDataDir}`, '--proxy-server=http://127.0.0.1:9'],
        cwd: repoRoot,
        env: {
          ...cleanEnv,
          NW_E2E: '1',
          NW_SKIP_SPLASH: '1',
          ELECTRON_DISABLE_SECURITY_WARNINGS: '1',
        },
        timeout: 30_000,
      })

      page = await app.firstWindow()
      await page.waitForLoadState('domcontentloaded')
      await page.waitForSelector('#app', { timeout: 15_000 })
      await page.waitForTimeout(2500)

      // 1. 不是白屏:#app 里有内容(标题栏 + 侧栏都在)
      const titleBar = await page.locator('.title-bar').count()
      const sideNav = await page.locator('nav.sidenav').count()
      expect(titleBar, '标题栏没渲染 —— 白屏').toBe(1)
      expect(sideNav, '侧栏没渲染 —— 白屏').toBe(1)

      // 2. 没有红屏兜底(渲染错误)
      const body = await page.evaluate(() => document.body.innerText)
      expect(body, '出现红屏兜底').not.toContain('[New World render error]')

      // 3. 界面有实质内容(不是空壳)
      const visibleText = body.replace(/\s+/g, ' ').trim()
      expect(visibleText.length, '界面是空的').toBeGreaterThan(20)
    } finally {
      await app?.close().catch(() => {})
      rmSync(userDataDir, { recursive: true, force: true })
    }
  })
})
