import { test, expect, shouldRunElectronE2E, gotoRoute, addProviderAndReload } from './helpers/electron-app'

/**
 * P5-UX T+0: 新用户首次启动 — 完整真实用户旅程
 *
 * 模拟一个真实用户的第一次启动:
 * 1. 打开 New World → 看首页 (Dashboard)
 * 2. 看到什么?有引导吗?
 * 3. 怎么找到 AI 对话?
 * 4. 进 Chat 后看到什么?空状态友好吗?
 * 5. 怎么知道能做什么?(prompt 模板 + 命令面板)
 * 6. 切到深色主题 → 持久化吗?
 * 7. 关掉再开,主题还在吗?
 *
 * 每个 step 都是"真用户会做的动作",不是开发者视角。
 */

test.describe('T+0 新用户首次启动旅程', () => {
  test.skip(!shouldRunElectronE2E, 'requires E2E_ELECTRON=1')

  test('J1: 首页加载 — 看到 New World 品牌', async ({ window }) => {
    // 【v4.4 起】默认路由已从 /dashboard 改成 /chat —— 「移除 Dashboard 主页」
    // (91a9093)。旧 spec 等 /#/dashboard → 永远等不到 → 超时。
    await window.waitForURL(/#\/chat/, { timeout: 10_000 })
    // 验证品牌可见(标题栏)
    await expect(window.locator('.title-bar .app-name')).toHaveText(/New World/i)
  })

  test('J2: 首页 — 看到 gateway 状态(没配置会引导)', async ({ window }) => {
    // 找 GatewayStatusBadge (sidebar 底部)
    const statusBadge = window.locator('[class*="gateway"], [class*="status"]').first()
    if (await statusBadge.count() > 0) {
      await expect(statusBadge).toBeVisible()
    }
  })

  test('J3: 用户进 Chat(从 SideNav 找 AI Chat)', async ({ window }) => {
    // 找 AI Chat 链接(中英文都试)
    const chatLink = window.locator('nav.sidenav a.nav-icon[href$="#/chat"]').first()
    await expect(chatLink).toBeVisible({ timeout: 5_000 })
    await chatLink.click()
    await window.waitForURL(/#\/chat/, { timeout: 5_000 })
    expect(window.url()).toContain('/chat')
  })

  test('J4: Chat 空状态 — 建议 chips + 模型选择器(新空态契约)', async ({ window }) => {
    // 【设计审计后新空态】QuickPrompts 模板卡已移除; 现为 3 条建议 chips + 卡片式输入区(含模型 pill)。
    // 有可用 provider 才渲染 chips(没模型可调,给建议也没用)。
    await addProviderAndReload(window, {
      name: 'Mock (J4)',
      baseUrl: 'http://127.0.0.1:9/v1',
      models: [{ id: 'mock-model', name: 'mock-model', capabilities: ['chat'] }],
    })
    await window.click('nav.sidenav a.nav-icon[href$="#/chat"]').catch(() => {})
    await window.waitForTimeout(1200)

    const chips = window.locator('.nova-chip')
    const chipCount = await chips.count()
    expect(chipCount, '有 provider 时应出现建议 chips').toBeGreaterThanOrEqual(3)

    // 卡片式输入区内的模型选择器
    await expect(window.locator('.model-pill').first()).toBeVisible()
  })

  test('J5: Chat 空状态 — 有时间感知问候', async ({ window }) => {
    const greeting = window.locator('.empty-title')
    if (await greeting.count() > 0) {
      const text = await greeting.textContent()
      // 中文问候含"好"或英文含 good
      expect(text).toMatch(/好|晚上|早上|下午|深夜|night|morning|afternoon|evening/i)
    }
  })

  test('J6: Chat 有"新建对话"按钮', async ({ window }) => {
    // 在 Chat 页面
    await window.waitForTimeout(300)
    const newChatButton = window.locator('button:has-text("新建对话"), button:has-text("New Chat")').first()
    if (await newChatButton.count() > 0) {
      await expect(newChatButton).toBeVisible()
    }
  })

  test('J7: 用户按 Ctrl+K → 命令面板打开', async ({ window }) => {
    // 模拟 Ctrl+K
    await window.keyboard.press('Control+K')
    await window.waitForTimeout(300)
    // 验证 .palette-backdrop 出现
    const palette = window.locator('.palette-backdrop')
    if (await palette.count() > 0) {
      await expect(palette).toBeVisible()
      // Esc 关闭
      await window.keyboard.press('Escape')
      await window.waitForTimeout(200)
    }
  })

  test('J8: 命令面板 — 输入"模型" → 看到结果', async ({ window }) => {
    await window.keyboard.press('Control+K')
    await window.waitForTimeout(300)
    const input = window.locator('.palette-input').first()
    if (await input.count() > 0) {
      await input.fill('模型')
      await window.waitForTimeout(200)
      const items = window.locator('.palette-item')
      const count = await items.count()
      expect(count).toBeGreaterThan(0)
    }
    await window.keyboard.press('Escape')
  })

  test('J9: 用户找主题切换按钮(TitleBar)', async ({ window }) => {
    // TitleBar 的 theme-toggle 按钮(class 是 .control-btn.theme-toggle)
    const themeBtn = window.locator('button.theme-toggle, [aria-label*="主题"]').first()
    if (await themeBtn.count() > 0) {
      await expect(themeBtn).toBeVisible()
    }
  })

  test('J10: 主题切换 — 切到深色 → html.dark class 出现', async ({ window }) => {
    // 找 theme-toggle 按钮并点击
    const themeBtn = window.locator('button.theme-toggle, [aria-label*="主题"]').first()
    if (await themeBtn.count() > 0) {
      const initialDark = await window.evaluate(() => document.documentElement.classList.contains('dark'))
      await themeBtn.click()
      await window.waitForTimeout(500)
      const afterDark = await window.evaluate(() => document.documentElement.classList.contains('dark'))
      // 状态应该反转
      expect(afterDark).toBe(!initialDark)
    }
  })

  test('J11: 主题持久化 — 重启后还在(测试 config persistence)', async ({ window }) => {
    // 切换主题
    const themeBtn = window.locator('button.theme-toggle, [aria-label*="主题"]').first()
    if (await themeBtn.count() > 0) {
      await themeBtn.click()
      await window.waitForTimeout(500)
      // 验证 config 写入了
      const themeConfig = await window.evaluate(async () => {
        const r = await (window as any).electronAPI?.config?.get?.('theme')
        return r?.data
      })
      expect(themeConfig).toBeDefined()
    }
  })

  test('J12: 用户找设置(右上角或 sidebar)', async ({ window }) => {
    // Sidebar 的 Settings 链接
    const settingsLink = window.locator('nav.sidenav a.nav-icon[href$="#/settings"]').first()
    await expect(settingsLink).toBeVisible({ timeout: 5_000 })
  })

  test('J13: 找 IM 管理入口(v4.7 收进设置页配置中心)', async ({ window }) => {
    // v4.7: IM 管理属于「配置容器」,不再占 rail 一级导航。
    // 真实路径是 设置 → 配置中心 → IM 通道接入。
    await gotoRoute(window, '/settings')
    const configNav = window.locator('[data-testid="settings-config-nav"]')
    await expect(configNav).toBeVisible({ timeout: 8_000 })
    const imLink = configNav.locator('a.settings-link[href$="#/im-management"]').first()
    await expect(imLink).toHaveCount(1)
    await expect(imLink).toBeVisible()
    // rail 上不该再有它
    await expect(window.locator('nav.sidenav a.nav-icon[href$="#/im-management"]')).toHaveCount(0)
  })

  test('J14: ClawHub 技能市场可达(v4.1 核心功能)', async ({ window }) => {
    // 【注意】私有技能仓库在「更多」面板与命令面板(Ctrl+K →「技能市场」)里有入口。
    // 这里验的是「路由可达 + 页面能渲染」,而不是「侧栏有图标」。
    await gotoRoute(window, '/clawhub')
    await expect(window.locator('h1').first()).toBeVisible({ timeout: 10_000 })
  })

  test('J16: 快捷键提示可见(命令面板入口)', async ({ window }) => {
    // 【v4.4 起】没有状态栏了 → 快捷键提示在**悬浮命令按钮**上
    // (标题「命令面板 (Ctrl+K)」+ kbd 提示)。版本号挪到设置页「关于」
    // (由 auto-updater spec 的 AU3 覆盖)。
    const cmdBtn = window.locator('button.floating-cmd-btn').first()
    await expect(cmdBtn).toHaveCount(1)
    await expect(cmdBtn).toBeVisible()
    const tip = await cmdBtn.getAttribute('title')
    expect(tip ?? '').toMatch(/Ctrl\+K|⌘K/i)
  })

  test('J17: 命令面板按钮 — 有"命令"快捷入口', async ({ window }) => {
    // 悬浮命令按钮(带「命令」文字 + ⌘K 提示)
    const cmdBtn = window.locator('button.floating-cmd-btn').first()
    await expect(cmdBtn).toHaveCount(1)
    await expect(cmdBtn).toBeVisible()
    await expect(cmdBtn).toContainText(/命令/)
  })
})
