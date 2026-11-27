/**
 * New World - 路由冒烟测试 (B1-Bugfix regression guard)
 *
 * 历史 bug: Chat.vue 用动态模板字符串 import(`highlight.js/lib/languages/${lang}`),
 *   浏览器原生 dynamic import 无法解析,导致 Chat.vue 挂载失败,
 *   整个路由显示 fallback 内容 (实际是 Dashboard 内容残留)
 *
 * 这个测试用 playwright + dev server 验证核心路由渲染正确。
 *
 * 跑法: `npm run test:e2e`
 *   (vitest 跑, 因为这文件用 vitest API;
 *    webServer 由 vitest.e2e.config.ts 自动拉起纯前端 vite —— vite.config.e2e.mts,
 *    不带 Electron; 浏览器路径经 scripts/test-e2e.mjs 钉为项目本地)
 *
 * 前置: 浏览器未装时报错前会提示执行
 *   PLAYWRIGHT_BROWSERS_PATH=0 npx playwright install chromium
 *
 * ⚠️ 不要用 npx playwright test 跑这个文件:
 *   @playwright/test 的 runner 看到 vitest 的 describe 会抛:
 *   "Playwright Test did not expect test.describe() to be called here"
 *   这是 vitest 跟 @playwright/test 的 API 不兼容
 *
 * 如果要跑 @playwright/test, 把这个文件改用
 *   import { test, expect } from '@playwright/test' + test.describe()
 *   并配 playwright.config.ts 的 testDir
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { chromium, type Browser, type Page } from 'playwright'

// 端口与 vitest.e2e.config.ts 的 webServer(url)保持一致
const BASE_URL = 'http://localhost:4173'

interface RouteCase {
  path: string
  /** 期望在 main-content 中渲染的 class 名片段 */
  expectClass: string
}

/** goto + 等 Vue 异步 chunk 加载 + 断言 main 内出现目标 class */
async function expectRouteRendered(page: Page, route: RouteCase, errors?: string[]): Promise<void> {
  if (!page) throw new Error('Page not initialized')
  await page.goto(`${BASE_URL}/#${route.path}`, {
    waitUntil: 'domcontentloaded',
    timeout: 15000,
  })
  // 等 Vue 异步组件加载 + route 切换完成
  await page.waitForTimeout(1500)
  const mainHtml = await page.locator('main').innerHTML().catch(() => '')
  // 关键断言: 不是 fallback 内容(历史 B1: Chat.vue 动态 import 崩 → Dashboard 残留)
  expect(
    mainHtml,
    `${route.path} 渲染了 fallback (可能是 Chat.vue 动态 import bug)`,
  ).toContain(route.expectClass)
}

/** 核心路由 — 对齐 v4.5 路由表(src/router/index.ts:12-154)。
 *  v4.5 起 Dashboard 已删除、主页即 Chat(见 release-body-v4.5.0-alpha.md),
 *  旧用例 "渲染 dashboard-page" 的期望已随业务下线,按实现为准更新。 */
const CORE_ROUTES: RouteCase[] = [
  { path: '/chat', expectClass: 'chat-page' },
  { path: '/skills', expectClass: 'skills-page' },
  { path: '/models', expectClass: 'models-page' },
  { path: '/im-management', expectClass: 'im-management' },
  { path: '/tasks', expectClass: 'tasks-page' },
  { path: '/schedule', expectClass: 'schedule-page' },
  { path: '/permissions', expectClass: 'permissions-page' },
  { path: '/settings', expectClass: 'settings-page' },
]

/** v4.5 回归:Dashboard 已删除,/ 应重定向到 /chat(router/index.ts:17-19) */
const REDIRECT_CASES: RouteCase[] = [
  { path: '/', expectClass: 'chat-page' },
]

/** TODO: 这些路由有预先存在的 row destructure 错误,留待后续修复 */
const SKIP_ROUTES: string[] = []

describe('B1-Bugfix: 核心路由正确渲染 (no fallback to Dashboard)', () => {
  let browser: Browser | null = null
  let page: Page | null = null
  const errors: string[] = []

  beforeAll(async () => {
    browser = await chromium.launch({ headless: true })
    page = await browser.newPage({ viewport: { width: 1440, height: 900 } })
    page.on('pageerror', (err) => errors.push(`pageerror: ${err.message}`))
    page.on('console', (msg) => {
      if (msg.type() === 'error') errors.push(`console: ${msg.text()}`)
    })
  }, 30000)

  afterAll(async () => {
    await page?.close()
    await browser?.close()
  })

  for (const route of CORE_ROUTES) {
    it(`${route.path} 渲染正确的 page class (回归 B1)`, async () => {
      await expectRouteRendered(page, route)
    }, 20000)
  }

  for (const route of REDIRECT_CASES) {
    it(`${route.path} 重定向后渲染正确的 page class (v4.5: 主页=Chat)`, async () => {
      await expectRouteRendered(page, route)
    }, 20000)
  }

  it('关键: Chat.vue 不再因 dynamic template literal import 崩溃', async () => {
    if (!page) throw new Error('Page not initialized')
    await page.goto(`${BASE_URL}/#/chat`, {
      waitUntil: 'domcontentloaded',
      timeout: 15000,
    })
    await page.waitForTimeout(1500)
    // 之前的 bug 是 "Failed to resolve module specifier 'highlight.js/lib/languages/javascript'"
    const chatErrors = errors.filter(
      (e) => e.includes('Failed to resolve module specifier') && e.includes('highlight.js'),
    )
    expect(
      chatErrors,
      'Chat.vue 不应再因 dynamic template literal import 报错',
    ).toEqual([])
  })
})