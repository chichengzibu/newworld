/**
 * NOVA #004-B · M3 联网搜索 · e2e 用例（第③笔, 新文件）
 *
 * 口径: vitest + Playwright chromium(纯前端, 与 routes-render 同族;
 *   不碰 routes-render.test.ts 断言路径 — DEV-030 边界, 红线对齐)。
 *
 * stub 生效证据(命令 §c 明确要求):
 *   Search.vue 在纯前端 e2e 环境(__APP_VERSION__==='dev', 由 vite.config.e2e.mts define 注入)
 *   走内建桩 E2E_RESULTS —— 本用例断言固定桩结果('[e2e stub] result 1' + https://example.com/stub/1)
 *   出现, 证明渲染层 stub 生效且零网络依赖(无 electronAPI 也不崩)。
 *
 * 跑法: npm run test:e2e(需把本文件加入 vitest.e2e.config.ts include; 见该配置第③笔追加)
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { chromium, type Browser, type Page } from 'playwright'

const BASE_URL = 'http://localhost:4173'

describe('NOVA #004-B M3 search 路由 + stub 结果渲染', () => {
  let browser: Browser | null = null
  let page: Page | null = null

  beforeAll(async () => {
    browser = await chromium.launch({ headless: true })
    page = await browser.newPage({ viewport: { width: 1440, height: 900 } })
  }, 30000)

  afterAll(async () => {
    await page?.close()
    await browser?.close()
  })

  it('S1: /search 路由可挂载, 触发桩搜索后断言固定 stub 结果出现(stub 生效证据)', async () => {
    if (!page) throw new Error('page not ready')
    await page.goto(`${BASE_URL}/#/search`, { waitUntil: 'domcontentloaded', timeout: 15000 })
    await page.waitForTimeout(1500)

    // 断言输入框 + 搜索按钮在场(路由正确挂载, 非 fallback)
    const input = page.locator('input[aria-label="search-query"]')
    await input.waitFor({ state: 'visible', timeout: 10000 })
    await input.fill('e2e search probe')

    // 触发搜索(纯前端 stub 路径, 零网络)
    await page.locator('button[type="submit"]').first().click()

    // 等结果列表出现
    await page.locator('.result-list').waitFor({ state: 'visible', timeout: 10000 })

    // stub 生效证据: 固定桩 title + url 字面值断言(F7 §1 桩语义)
    const mainHtml = await page.locator('main, .search-page').first().innerHTML().catch(() => '')
    expect(mainHtml).toContain('[e2e stub] result 1')
    expect(mainHtml).toContain('https://example.com/stub/1')
    expect(mainHtml).toContain('[e2e stub] result 2')

    // 结果卡片 2 条(桩固定 2 条)
    const cards = page.locator('.result-card')
    expect(await cards.count()).toBe(2)

    // 不可信标注在场(稿 F4, 数据前标注)
    expect(mainHtml).toContain('nova-search-untrusted')
  }, 20000)

  it('S2: 触发桩搜索后"一键复制"按钮在场(裁定②, 纯 renderer clipboard)', async () => {
    if (!page) throw new Error('page not ready')
    await page.goto(`${BASE_URL}/#/search`, { waitUntil: 'domcontentloaded', timeout: 15000 })
    await page.waitForTimeout(1200)
    await page.locator('input[aria-label="search-query"]').fill('copy probe')
    await page.locator('button[type="submit"]').first().click()
    await page.locator('.result-list').waitFor({ state: 'visible', timeout: 10000 })
    // 结果出现后复制按钮必须渲染(裁定②落点实证)
    await page.locator('.copy-btn').first().waitFor({ state: 'visible', timeout: 5000 })
    const bar = await page.locator('.resultbar-copy, .search-resultbar').first().innerHTML().catch(() => '')
    expect(bar.length).toBeGreaterThan(0)
  }, 20000)
})
