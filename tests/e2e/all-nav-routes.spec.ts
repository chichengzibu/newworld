import {
  test, expect, shouldRunElectronE2E,
  gotoBySideNav, gotoByMore, gotoViaSettings, gotoRoute,
} from './helpers/electron-app'

/**
 * v4.7 导航信息架构回归 —— 四层分组
 * ═══════════════════════════════════════════════════════════════
 * v4.6 只做「形式收敛」(rail 5 + 更多抽屉 8),但抽屉里混装了输入能力、
 * 配置管理和内容浏览,心智混乱。v4.7 按用户心智分四层,**不删任何路由**:
 *
 *   1. 工作对象  rail 常驻        /chat /skills /schedule  (+ 底部 /settings)
 *   2. 输入能力  ChatInput 工具条  /search /voice
 *   3. 配置容器  Settings 配置中心 /models /im-management /permissions
 *                                 /remote-control /settings/im-accounts
 *   4. 内容浏览  「更多」面板      /clawhub（模型对比/帮助中心 v4.9 已下线）
 *
 * 四层加起来恰好覆盖 12 个生产路由。清单与 nav-config.ts 的一致性由
 * tests/unit/nav-ia.test.ts 锁定,这里验证真实 Electron 里的四层行为。
 */
const RAIL_ROUTES = [
  '/chat', '/skills', '/schedule', '/settings',
] as const

const INPUT_TOOL_ROUTES = ['/search', '/voice'] as const

const CONFIG_CENTER_ROUTES = [
  '/im-management', '/permissions', '/remote-control', '/settings/im-accounts',
] as const
/** 模型管理是设置页内建 tab，不在配置中心重复列出 */
const SETTINGS_EMBEDDED_ROUTES = ['/models'] as const
const SETTINGS_ROUTES = [...CONFIG_CENTER_ROUTES, ...SETTINGS_EMBEDDED_ROUTES] as const

const MORE_ROUTES = ['/clawhub'] as const

/** 四类之外、不该平铺在 rail 上的所有路径 */
const NON_RAIL_ROUTES = [...INPUT_TOOL_ROUTES, ...SETTINGS_ROUTES, ...MORE_ROUTES] as const

test.describe('Navigation IA (v4.7 four-layer)', () => {
  test.skip(!shouldRunElectronE2E, 'requires E2E_ELECTRON=1')

  test('rail 只保留 3 个工作对象 + 底部设置，其余分层收纳', async ({ window }) => {
    await window.waitForSelector('nav.sidenav a.nav-icon', { timeout: 10_000 })

    const hrefs = await window.locator('nav.sidenav a.nav-icon').evaluateAll((els) =>
      els.map((el) => el.getAttribute('href') ?? ''),
    )
    expect(hrefs, 'rail 上应恰好是 3 个工作对象 + 1 个设置').toHaveLength(RAIL_ROUTES.length)
    for (const route of RAIL_ROUTES) {
      expect(hrefs.some((h) => h.endsWith(`#${route}`)), `rail 缺少 ${route}`).toBe(true)
    }
    for (const route of NON_RAIL_ROUTES) {
      expect(hrefs.some((h) => h.endsWith(`#${route}`)), `${route} 不应平铺在 rail 上`).toBe(false)
    }

    // 分组分隔线 + 更多触发器都在
    await expect(window.locator('nav.sidenav .nav-divider')).toHaveCount(1)
    const trigger = window.locator('[data-testid="nav-more-trigger"]')
    await expect(trigger).toBeVisible()
    await expect(window.locator('[data-testid="nav-more-panel"]')).toHaveCount(0)

    // 「更多」现在只剩 3 个同质的内容浏览项
    await trigger.click()
    const panel = window.locator('[data-testid="nav-more-panel"]')
    await expect(panel).toBeVisible({ timeout: 8_000 })
    await expect(panel.locator('a.nav-more-item')).toHaveCount(MORE_ROUTES.length)
    for (const route of MORE_ROUTES) {
      await expect(
        panel.locator(`a.nav-more-item[href$="#${route}"]`),
        `更多面板缺 ${route}`,
      ).toHaveCount(1)
    }
    const labels = await panel.locator('.nav-more-item-title').allTextContents()
    expect(labels.every((s) => s.trim().length > 0), '每个入口都要有可读文案').toBe(true)
  })

  test('ChatInput：联网搜索是开关，语音是跳转入口', async ({ window }) => {
    await gotoRoute(window, '/chat')
    for (const route of INPUT_TOOL_ROUTES) {
      const tool = window.locator(`.input-tool-btn[data-path="${route}"]`)
      await expect(tool, `输入区缺工具 ${route}`).toBeVisible({ timeout: 8_000 })
      await expect(tool).toHaveAttribute('aria-label', /\S+/)
    }
    // v4.8：点搜索按钮只切开关，不跳走（搜索是给模型用的能力）
    const toggle = window.locator('[data-testid="web-search-toggle"]')
    await expect(toggle).toHaveAttribute('aria-pressed', 'false')
    await toggle.click()
    await expect(toggle).toHaveAttribute('aria-pressed', 'true')
    expect(new URL(window.url()).hash, '点搜索开关不应跳走').toContain('/chat')
    // 语音仍是跳转入口
    await window.locator('.input-tool-btn[data-path="/voice"]').click()
    await window.waitForURL(/#\/voice/, { timeout: 10_000 })
  })

  test('Settings 配置中心 4 个入口，模型管理只在内嵌 tab（不重复）', async ({ window }) => {
    await gotoRoute(window, '/settings')
    const configNav = window.locator('[data-testid="settings-config-nav"]')
    await expect(configNav).toBeVisible({ timeout: 8_000 })
    await expect(configNav.locator('a.settings-link')).toHaveCount(CONFIG_CENTER_ROUTES.length)
    for (const route of CONFIG_CENTER_ROUTES) {
      const link = configNav.locator(`a.settings-link[href$="#${route}"]`)
      await expect(link, `配置中心缺 ${route}`).toHaveCount(1)
      await expect(link.locator('.settings-link__title')).not.toHaveText(/^\s*$/)
    }
    // 去重钉：配置中心不得再列 /models，否则左侧出现两个「模型管理」
    await expect(configNav.locator('a.settings-link[href$="#/models"]')).toHaveCount(0)
    // 模型管理仍作为设置页内建 tab 存在（唯一入口）
    await expect(window.locator('.settings-nav__btn:has-text("模型管理"), .settings-nav__btn:has-text("Models")')).toHaveCount(1)
  })

  test('全部 12 个生产路由按四层真实路径可达，且无 JS 错误', async ({ window }) => {
    test.setTimeout(180_000)
    const errors: string[] = []
    window.on('console', (msg) => {
      if (msg.type() !== 'error') return
      const text = msg.text()
      if (text.includes('favicon') || text.includes('Autofill.enable')) return
      errors.push(text)
    })
    window.on('pageerror', (err) => errors.push(`[pageerror] ${err.message}`))

    async function verifyRoute(route: string): Promise<void> {
      expect(new URL(window.url()).hash, `${route} 未跳转成功`).toContain(route)
      await expect(window.locator('main.main-content')).toBeVisible({ timeout: 5_000 })
      const textLen = (await window.locator('body').textContent())?.length ?? 0
      expect(textLen, `${route} 不应是空白页`).toBeGreaterThan(20)
    }

    // 第 1 层：rail 直达
    for (const route of RAIL_ROUTES) {
      await gotoBySideNav(window, route)
      await window.waitForTimeout(250)
      await verifyRoute(route)
    }

    // 第 2 层：输入能力 —— /voice 从 ChatInput 跳转；/search 是开关，
    // 手动搜索页仍保留（查看/复制结果），走路由验证可达
    await gotoRoute(window, '/chat')
    await window.locator('.input-tool-btn[data-path="/voice"]').click()
    await window.waitForURL(/#\/voice/, { timeout: 10_000 })
    await window.waitForTimeout(250)
    await verifyRoute('/voice')
    await gotoRoute(window, '/search')
    await window.waitForTimeout(250)
    await verifyRoute('/search')

    // 第 3 层：配置容器 —— 通过 Settings 页配置中心（4 个独立入口）
    // v4.9：点配置入口不再整页跳走，而是留在设置页、右侧面板内切换。
    // 故除可达性外，还要钉住「左侧选栏还在」这一内嵌语义。
    for (const route of CONFIG_CENTER_ROUTES) {
      await gotoViaSettings(window, route)
      await window.waitForURL(new RegExp(`#${route.replace('/', '\\/')}`), { timeout: 10_000 })
      await window.waitForTimeout(250)
      // 内嵌关键断言：设置页的左侧选栏仍挂载（没有整页替换成独立页）
      await expect(
        window.locator('nav.settings-nav'),
        `${route} 应内嵌在设置页，左侧选栏不应消失`,
      ).toBeVisible({ timeout: 8_000 })
      await verifyRoute(route)
    }
    // /models 是独立页，入口在设置页内建 tab；这里验证路由本身仍可达
    await gotoRoute(window, '/models')
    await window.waitForTimeout(250)
    await verifyRoute('/models')

    // 第 4 层：内容浏览 —— 通过「更多」面板
    for (const route of MORE_ROUTES) {
      await gotoByMore(window, route)
      await window.waitForURL(new RegExp(`#${route.replace('/', '\\/')}`), { timeout: 10_000 })
      await window.waitForTimeout(250)
      await verifyRoute(route)
    }

    if (errors.length > 0) {
      throw new Error(`导航过程出现 console error:\n${errors.join('\n')}`)
    }
  })

  test('被分层收纳的页面仍可从命令面板 Ctrl+K 搜到', async ({ window }) => {
    await window.keyboard.press('Control+k')
    const palette = window.locator('.palette')
    await expect(palette).toBeVisible({ timeout: 8_000 })
    await window.locator('.palette-input').fill('语音')
    const voiceItem = window.locator('.palette-item', { hasText: '语音' }).first()
    await expect(voiceItem).toBeVisible({ timeout: 8_000 })
    await voiceItem.click()
    await window.waitForURL(/#\/voice/, { timeout: 10_000 })
    await expect(window.locator('main.main-content')).toBeVisible({ timeout: 5_000 })
  })
})
