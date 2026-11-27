import { test, expect, shouldRunElectronE2E } from './helpers/electron-app'

/**
 * New World UI 烟雾测试 - 模拟用户交互
 *
 * 用 E2E_ELECTRON=1 启动 Electron 真实进程,
 * 模拟用户导航、点击、输入等操作,验证 UI 完整性。
 */

test.describe('UI interaction smoke test', () => {
  test.skip(!shouldRunElectronE2E, 'requires E2E_ELECTRON=1')

  test('capture console + screenshot for diagnosis', async ({ window }) => {
    // 收集所有 console 消息
    const logs: string[] = []
    window.on('console', (msg) => {
      logs.push(`[${msg.type()}] ${msg.text()}`)
    })
    window.on('pageerror', (err) => {
      logs.push(`[pageerror] ${err.message}\n${err.stack ?? ''}`)
    })

    // 给 Vue 一些时间挂载
    await window.waitForTimeout(3000)

    // 截图
    await window.screenshot({ path: 'test-results/ui-smoke-screenshot.png', fullPage: true })

    // 打印所有 console
    console.log('=== Console logs from renderer ===')
    for (const log of logs) console.log(log)
    console.log('=== End console logs ===')
  })

  test('navigate through main pages', async ({ window }) => {
    // 【v4.7】四层信息架构:rail 只常驻 3 个工作对象(对话/技能/定时任务)
    // + 底部设置,共 4 个。配置页收进设置页,输入能力下沉到输入区,
    // 内容浏览收进「更多」面板 —— 不再是平铺的 8 个图标。
    const navItems = window.locator('nav.sidenav a.nav-icon')
    await expect(navItems).toHaveCount(4, { timeout: 10_000 })

    const expectedPaths = ['#/chat', '#/skills', '#/schedule', '#/settings']
    for (const p of expectedPaths) {
      const item = window.locator(`nav.sidenav a.nav-icon[href$="${p}"]`)
      await expect(item, `侧栏缺入口 ${p}`).toHaveCount(1)
      await expect(item).toBeVisible({ timeout: 5_000 })
      await expect(item).toHaveAttribute('aria-label', /\S+/)
    }

    // 配置页不得再平铺在 rail 上
    for (const p of ['#/models', '#/im-management', '#/permissions', '#/remote-control']) {
      await expect(window.locator(`nav.sidenav a.nav-icon[href$="${p}"]`), `${p} 不该在 rail`).toHaveCount(0)
    }

    // 「更多」面板承载 1 个内容浏览项（模型对比/帮助中心 v4.9 已下线）
    const trigger = window.locator('[data-testid="nav-more-trigger"]')
    await expect(trigger).toBeVisible()
    await trigger.click()
    const panel = window.locator('[data-testid="nav-more-panel"]')
    await expect(panel).toBeVisible({ timeout: 8_000 })
    for (const p of ['#/clawhub']) {
      const item = panel.locator(`a.nav-more-item[href$="${p}"]`)
      await expect(item, `更多菜单缺入口 ${p}`).toHaveCount(1)
      await expect(item.locator('.nav-more-item-title')).toHaveText(/\S+/)
    }
    await window.keyboard.press('Escape')
    await expect(panel).toHaveCount(0)

    await window.screenshot({ path: 'test-results/ui-smoke-sidenav.png' })

    // 设置页「配置中心」集中 4 个配置入口；模型管理是内建 tab，不重复列出
    await window.click('nav.sidenav a.nav-icon[href$="#/settings"]')
    await window.waitForURL(/#\/settings/, { timeout: 5_000 })
    await expect(window.locator('.settings-page, [class*="settings-view"]').first()).toBeVisible({ timeout: 5_000 })
    const configNav = window.locator('[data-testid="settings-config-nav"]')
    await expect(configNav).toBeVisible({ timeout: 5_000 })
    await expect(configNav.locator('a.settings-link')).toHaveCount(4)
    await expect(configNav.locator('a.settings-link[href$="#/models"]')).toHaveCount(0)

    // 模型管理入口唯一：设置页内建 tab
    await window.locator('.settings-nav__btn:has-text("模型管理"), .settings-nav__btn:has-text("Models")').first().click()
    await expect(window.locator('#settings-panel-models')).toBeVisible({ timeout: 5_000 })

    // 回到 AI Chat,输入能力工具条应有搜索 / 语音两个按钮
    await window.click('nav.sidenav a.nav-icon[href$="#/chat"]')
    await window.waitForURL(/#\/chat/, { timeout: 5_000 })
    await expect(window.locator('.input-tool-btn[data-path="/search"]')).toBeVisible({ timeout: 5_000 })
    await expect(window.locator('.input-tool-btn[data-path="/voice"]')).toBeVisible({ timeout: 5_000 })
  })

  test('chat flow: new conversation + type message', async ({ window }) => {
    // 通过 SideNav 导航到 /chat
    await window.click('nav.sidenav a.nav-icon[href$="#/chat"]')
    await window.waitForURL(/#\/chat/, { timeout: 5_000 })

    // 找到「新建」按钮并点击(实际按钮是 button.new-chat-btn,文案为「新建」;
    // 旧写法找 "New Chat" / "新建对话" 都匹配不到 → click 超时)
    const newChatBtn = window.locator('button.new-chat-btn').first()
    await expect(newChatBtn).toBeVisible({ timeout: 10_000 })
    await newChatBtn.click()
    await window.waitForTimeout(500)

    // 找到输入框
    const textarea = window.locator('.input-area textarea').first()
    await expect(textarea).toBeVisible({ timeout: 5_000 })

    // 模拟用户输入
    await textarea.fill('Hello, this is a UI smoke test message')

    // 验证输入框内容
    await expect(textarea).toHaveValue('Hello, this is a UI smoke test message')

    // 截图存档
    await window.screenshot({ path: 'test-results/ui-smoke-chat.png', fullPage: true })
  })

  test('language switcher in SideNav works', async ({ window }) => {
    // 【v4.4 起】语言切换器**不在侧栏了** —— 侧栏是 icon-only rail,
    // 语言选择挪到了「设置 → 基本设置 → 界面语言」的 radio 组。
    await window.click('nav.sidenav a.nav-icon[href$="#/settings"]')
    await window.waitForTimeout(1000)

    const langSwitcher = window.locator('.radio-group .radio').filter({ hasText: /English|中文/ }).first()
    await expect(langSwitcher).toBeVisible({ timeout: 10_000 })

    // 截图切换前
    await window.screenshot({ path: 'test-results/ui-smoke-lang-zh.png' })

    // 切到 English
    await window.locator('.radio-group .radio:has-text("English")').first().click()
    await window.waitForTimeout(800)

    // 切完侧栏图标文案应变英文(icon-only 侧栏的 i18n 信号在 aria-label)
    await expect(window.locator('nav.sidenav a.nav-icon[aria-label="AI Chat"]')).toHaveCount(1)

    // 截图切换后
    await window.screenshot({ path: 'test-results/ui-smoke-lang-en.png' })
  })
})
