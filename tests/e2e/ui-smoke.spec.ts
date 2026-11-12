import { test, expect, shouldRunElectronE2E } from './helpers/electron-app'

/**
 * PiPiClaw UI 烟雾测试 - 模拟用户交互
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
    // 【v4.4 起】侧栏是 icon-only rail:`nav.sidenav > a.nav-icon`,
    // 没有可见文字 —— 旧的 `a.nav-item` × 14 断言永远不成立。
    // 改按**入口是否齐 + 每个入口有没有文案**来断(后者是 M4-G 实跑抓到的真实缺陷)。
    const navItems = window.locator('nav.sidenav a.nav-icon')
    await expect(navItems).toHaveCount(8, { timeout: 10_000 })

    // 2. 逐个入口都在 + 都有非空文案(aria-label 走 i18n)
    const expectedPaths = [
      '#/chat', '#/models', '#/skills', '#/im-management', '#/schedule',
      '#/search', '#/voice', '#/settings',
    ]
    for (const p of expectedPaths) {
      const item = window.locator(`nav.sidenav a.nav-icon[href$="${p}"]`)
      await expect(item, `侧栏缺入口 ${p}`).toHaveCount(1)
      await expect(item).toBeVisible({ timeout: 5_000 })
      await expect(item).toHaveAttribute('aria-label', /\S+/)
    }

    // 截图 SideNav
    await window.screenshot({ path: 'test-results/ui-smoke-sidenav.png' })

    // 3. 点击"Models",验证跳转
    await window.click('nav.sidenav a.nav-icon[href$="#/models"]')
    await window.waitForURL(/#\/models/, { timeout: 5_000 })
    await expect(window.locator('.models-page').first()).toBeVisible({ timeout: 5_000 })

    // 4. 点击"Settings"
    await window.click('nav.sidenav a.nav-icon[href$="#/settings"]')
    await window.waitForURL(/#\/settings/, { timeout: 5_000 })
    await expect(window.locator('.settings-page, [class*="settings-view"]').first()).toBeVisible({ timeout: 5_000 })

    // 5. 回到 AI Chat
    await window.click('nav.sidenav a.nav-icon[href$="#/chat"]')
    await window.waitForURL(/#\/chat/, { timeout: 5_000 })
  })

  test('chat flow: new conversation + type message', async ({ window }) => {
    // 通过 SideNav 导航到 /chat
    await window.click('nav.sidenav a.nav-icon[href$="#/chat"]')
    await window.waitForURL(/#\/chat/, { timeout: 5_000 })

    // 找到"New Chat"按钮并点击
    const newChatBtn = window.locator('button:has-text("New Chat"), button:has-text("新建对话")').first()
    await newChatBtn.click()
    await window.waitForTimeout(500)

    // 找到输入框
    const textarea = window.locator('.input-row textarea, textarea[placeholder*="消息"], textarea[placeholder*="message"]').first()
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
