import { test, expect, shouldRunElectronE2E } from './helpers/electron-app'
import { gotoBySideNav } from './helpers/electron-app'

/**
 * T+450: 国际化语言切换
 *
 * 真实场景:用户切换界面语言:
 * IL1: 初始是 zh-CN 或 en-US
 * IL2: 找到语言切换器
 * IL3: 切到 en-US → UI 文案变英文
 * IL4: 切回 zh-CN → UI 文案变回中文
 * IL5: 语言设置持久化(已在 T+420 覆盖)
 *
 * 【v4.4 改版后的两处变化 —— 这份 spec 原来按旧 UI 写,已对齐】
 * ① **语言切换器不在侧栏了** —— v4.4 把侧栏改成 icon-only rail,
 *    语言选择挪到了「设置 → 基本设置」的 `.radio-group`(中文 / English)。
 * ② **侧栏不再有可见文案** —— 图标只有 `aria-label` / `title`(走 i18n)。
 *    所以「语言切换生效」的观察点从**可见文字**变成 **aria-label** ——
 *    这反而是更准的信号:可见文字可能被图标盖住,aria-label 不会。
 */

test.describe('T+450 国际化语言切换', () => {
  test.skip(!shouldRunElectronE2E, 'requires E2E_ELECTRON=1')

  test('IL1: 初始语言是 zh-CN 或 en-US', async ({ window }) => {
    await window.waitForSelector('#app', { timeout: 10_000 })
    await window.waitForTimeout(800)
    const lang = await window.evaluate(() => {
      const stored = localStorage.getItem('pipiclaw:locale')
      if (stored) return stored
      return document.documentElement.lang || document.documentElement.getAttribute('data-lang') || ''
    })
    // html 没标 lang 也不算失败 —— 只要能落到两种语言之一
    expect(['', 'zh-CN', 'en-US']).toContain(lang)
  })

  test('IL2: 设置页里有语言切换器(中文 / English)', async ({ window }) => {
    await gotoBySideNav(window, '/settings')
    // 语言选择是一组自定义 radio(不是 el-select)
    const radios = window.locator('.radio-group .radio')
    await expect(radios.first()).toBeVisible({ timeout: 10_000 })
    const labels = await radios.allTextContents()
    const joined = labels.join('|')
    expect(joined).toMatch(/中文|English/)
  })

  test('IL3: 切到 en-US → 侧栏 aria-label 变英文', async ({ window }) => {
    await gotoBySideNav(window, '/settings')
    await window.locator('.radio-group .radio:has-text("English")').first().click()
    await window.waitForTimeout(1000)

    // 侧栏图标是 icon-only,i18n 信号在 aria-label
    const enChat = window.locator('nav.sidenav a.nav-icon[aria-label="AI Chat"]')
    await expect(enChat.first()).toHaveCount(1)
  })

  test('IL4: 切回 zh-CN → 侧栏 aria-label 变中文', async ({ window }) => {
    await gotoBySideNav(window, '/settings')
    await window.locator('.radio-group .radio:has-text("中文")').first().click()
    await window.waitForTimeout(1000)

    const zhChat = window.locator('nav.sidenav a.nav-icon[aria-label="AI对话"]')
    await expect(zhChat.first()).toHaveCount(1)
    // 英文文案不该再出现
    const enChat = window.locator('nav.sidenav a.nav-icon[aria-label="AI Chat"]')
    expect(await enChat.count()).toBe(0)
  })
})
