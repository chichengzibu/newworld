import { test, expect, shouldRunElectronE2E } from './helpers/electron-app'

/**
 * Chat: 对话窗口与 Agent 集成
 *
 * 真实测试场景 (E2E_ELECTRON=1):
 *   1. 启动 Electron renderer,导航到 /chat
 *   2. 验证 Chat.vue 主区域挂载(空状态 / 已有会话 两种情形)
 *   3. 验证 model selector 与 input textarea 存在
 *   4. 创建新会话,验证 sidebar 出现一条 conversation
 *
 * 默认行为:
 *   - 在 CI / 未设 E2E_ELECTRON 时,所有 test.skip 防御性跳过
 *   - 本地跑:npm run build && E2E_ELECTRON=1 npx playwright test tests/e2e/chat-agent.spec.ts
 *
 * 已知限制:
 *   - 真实 LLM 回复依赖 LlmAgentBrain + LlmConfig;
 *     没配 LLM 时 ChatManager 会走 stub,功能仍可验证 UI 流程
 *   - 真要打 mock LLM server 见 docs/e2e-testing.md(LlmConfigStore 反代思路)
 */

test.describe('Chat Agent integration', () => {
  test.skip(!shouldRunElectronE2E, 'requires E2E_ELECTRON=1 to launch Electron renderer')

  test('app shell mounts and SideNav links to Chat', async ({ window }) => {
    // SideNav 必须有 Chat 入口(中英文都覆盖),链接到 /chat
    const chatLink = window.locator('nav.sidenav a.nav-icon[href$="#/chat"]')
    await expect(chatLink).toBeVisible({ timeout: 10_000 })
    // 【v4.4 起】侧栏是 icon-only → **没有可见文字**,文案在 aria-label
    // (中英双语都走 i18n → aria-label 随之变)
    await expect(chatLink).toHaveAttribute('aria-label', /Chat|对话/)

    // 【v4.4 起】没有状态栏了 —— 底部那圈变成了**悬浮命令按钮**
    // (`button.floating-cmd-btn`,macOS Spotlight 风格),版本号挪到了设置页「关于」
    const cmdBtn = window.locator('button.floating-cmd-btn')
    await expect(cmdBtn).toHaveCount(1)
    await expect(cmdBtn).toBeVisible()
    // 品牌在标题栏
    await expect(window.locator('.title-bar .app-name')).toHaveText(/PiPiClaw/i)
  })

  test('Chat page shows empty state or sessions list', async ({ window }) => {
    await window.click('nav.sidenav a.nav-icon[href$="#/chat"]')
    await window.waitForURL(/#\/chat/)

    // Chat.vue 顶层 .chat-page 必须渲染
    await expect(window.locator('.chat-page')).toBeVisible({ timeout: 10_000 })

    // 二选一:空状态(.empty-chat) 或 会话列表(.conversations-list)
    const emptyState = window.locator('.empty-chat')
    const sessionList = window.locator('.conversations-list')
    await expect(emptyState.or(sessionList).first()).toBeVisible({ timeout: 10_000 })
  })

  test('empty chat state exposes new-conversation CTA', async ({ window }) => {
    // 通过 SideNav 导航(file:// 协议下 window.goto 需完整 URL)
    await window.click('nav.sidenav a.nav-icon[href$="#/chat"]')
    await window.waitForURL(/#\/chat/)

    // 触发"新建"按钮 —— 【注意】它的可见文字是「新建」,
    // 「新建对话」只是 aria-label/title → 旧的 has-text("新建对话") 匹配不到
    const newChatButton = window.locator('button.new-chat-btn').first()
    await expect(newChatButton).toBeVisible({ timeout: 10_000 })
    await expect(newChatButton).toHaveAttribute('aria-label', /新建/)
  })

  test('input textarea is enabled when session is selected', async ({ window }) => {
    await window.click('nav.sidenav a.nav-icon[href$="#/chat"]')
    await window.waitForURL(/#\/chat/)

    // 如果有会话,直接点;否则新建
    const conversationItem = window.locator('.conversation-item').first()
    if (await conversationItem.count()) {
      await conversationItem.click()
    } else {
      await window.locator('button.new-chat-btn').first().click()
      // 等 chat-main 渲染
      await window.waitForSelector('.chat-main', { timeout: 10_000 })
    }

    // 文本输入框必须出现且非 disabled
    const textarea = window.locator('.input-row textarea').first()
    await expect(textarea).toBeVisible({ timeout: 10_000 })
    await expect(textarea).toBeEnabled()
    // placeholder 文案:输入消息... 或 Enter to send...
    await expect(textarea).toHaveAttribute('placeholder', /输入消息|message/i)
  })
})
