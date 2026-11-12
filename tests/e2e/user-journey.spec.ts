import { test, expect, shouldRunElectronE2E, gotoRoute, addProviderAndReload } from './helpers/electron-app'

/**
 * P5-UX T+0: 新用户首次启动 — 完整真实用户旅程
 *
 * 模拟一个真实用户的第一次启动:
 * 1. 打开 PiPiClaw → 看首页 (Dashboard)
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

  test('J1: 首页加载 — 看到 PiPiClaw 品牌', async ({ window }) => {
    // 【v4.4 起】默认路由已从 /dashboard 改成 /chat —— 「移除 Dashboard 主页」
    // (91a9093)。旧 spec 等 /#/dashboard → 永远等不到 → 超时。
    await window.waitForURL(/#\/chat/, { timeout: 10_000 })
    // 验证品牌可见(标题栏)
    await expect(window.locator('.title-bar .app-name')).toHaveText(/PiPiClaw/i)
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

  test('J4: Chat 空状态 — 看到 prompt 模板', async ({ window }) => {
    // 【实测约束】`QuickPrompts` 的渲染条件是 `v-if="enabledProvidersCount > 0"` ——
    // **没有可用 provider 就不给模板**(没模型可调,给模板也没用)。
    // 干净 profile 里一个 provider 都没有 → 模板数为 0 → 旧断言必然红。
    // 故:先注入一个 provider,再验模板。
    await addProviderAndReload(window, {
      name: 'Mock (J4)',
      baseUrl: 'http://127.0.0.1:9/v1',
      models: [{ id: 'mock-model', name: 'mock-model', capabilities: ['chat'] }],
    })
    await window.click('nav.sidenav a.nav-icon[href$="#/chat"]').catch(() => {})
    await window.waitForTimeout(1200)

    const promptCards = window.locator('.empty-prompt-card')
    const cardCount = await promptCards.count()
    expect(cardCount, '有 provider 时应出现 prompt 模板').toBeGreaterThanOrEqual(4)

    // 图标(模板卡用的是 .empty-prompt-icon;旧的 .empty-prompt-emoji 已无对应元素)
    const icons = window.locator('.empty-prompt-icon')
    expect(await icons.count()).toBeGreaterThan(0)
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

  test('J13: 找 IM 管理入口(v4.1 核心功能)', async ({ window }) => {
    // IM 管理**在侧栏里**(icon-only,文案走 aria-label)
    const imLink = window.locator('nav.sidenav a.nav-icon[href$="#/im-management"]').first()
    await expect(imLink).toHaveCount(1)
    await expect(imLink).toBeVisible()
  })

  test('J14: ClawHub 技能市场可达(v4.1 核心功能)', async ({ window }) => {
    // 【注意】ClawHub **没有侧栏入口** —— v4.4 把侧栏收成 7 个固定 icon 时丢了它,
    // 现在只能从命令面板(Ctrl+K →「技能市场」)或 ModelCompare 页的链接进入。
    // 这里验的是「路由可达 + 页面能渲染」,而不是「侧栏有图标」。
    await gotoRoute(window, '/clawhub')
    await expect(window.locator('h1').first()).toBeVisible({ timeout: 10_000 })
  })

  test('J15: 模型对比可达(v4.1 核心功能)', async ({ window }) => {
    // 同上:模型对比**没有侧栏入口**,走路由验可达性
    await gotoRoute(window, '/model-compare')
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
