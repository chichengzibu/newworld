import { test, expect, shouldRunElectronE2E } from './helpers/electron-app'
import { gotoBySideNav } from './helpers/electron-app'

/**
 * T+300: 主题切换 dark/light 全链路
 *
 * 真实场景:用户在设置页切换主题,验证:
 * - html data-theme 切到 dark
 * - 背景色变化
 * - 主要文字色变化
 * - 重启后持久化
 * - 主要组件(sidebar / chat / settings)都跟随
 *
 * 【v4.4 改版后的变化 —— 这份 spec 原来按旧 UI 写,已对齐】
 * 旧版标题栏有个 `button.theme-toggle` 一点就切;v4.4 改成 icon-only rail 后
 * 那个按钮**不存在了** → 旧 spec 的 `if (await themeBtn.count() > 0)` 守卫
 * 静默跳过点击,于是「切了主题」根本没发生,后面三条颜色断言自然全红。
 * 现:主题开关在「设置 → 基本设置 → 主题」的 `.radio-group`(浅色/深色/跟随)。
 */

test.describe('T+300 主题切换 dark/light', () => {
  test.skip(!shouldRunElectronE2E, 'requires E2E_ELECTRON=1')

  /** 在设置页把主题切到指定值 */
  async function setTheme(window: any, mode: 'dark' | 'light'): Promise<void> {
    await gotoBySideNav(window, '/settings')
    // 主题 radio 是「浅色 / 深色 / 跟随」,与语言 radio(「中文 / English」)互不重叠,
    // 直接按文案定位即可(实测设置页共 5 个 .radio:3 个主题 + 2 个语言)
    const label = mode === 'dark' ? '深色' : '浅色'
    const labelEn = mode === 'dark' ? 'Dark' : 'Light'
    const radio = window.locator('.radio', { hasText: new RegExp(`${label}|${labelEn}`) }).first()
    await radio.click()
    await window.waitForTimeout(1000)
  }

  test('T1: 初始状态是 light 或 dark', async ({ window }) => {
    await window.waitForSelector('#app', { timeout: 10_000 })
    await window.waitForTimeout(800)
    const theme = await window.evaluate(() => document.documentElement.getAttribute('data-theme'))
    // 'system' 模式下 data-theme 是空的 —— 空值也算合法初态
    expect(['', 'light', 'dark']).toContain(theme)
  })

  test('T2: 切到 dark → html 有 .dark class', async ({ window }) => {
    await setTheme(window, 'dark')
    const isDark = await window.evaluate(() => document.documentElement.classList.contains('dark'))
    expect(isDark).toBe(true)
    const attr = await window.evaluate(() => document.documentElement.getAttribute('data-theme'))
    expect(attr).toBe('dark')
  })

  test('T3: 切到 dark → 背景色变深', async ({ window }) => {
    await setTheme(window, 'light')
    const lightBg = await window.evaluate(() => getComputedStyle(document.body).backgroundColor)
    await setTheme(window, 'dark')
    const darkBg = await window.evaluate(() => getComputedStyle(document.body).backgroundColor)
    expect(lightBg).not.toBe(darkBg)
  })

  test('T4: 切到 dark → 文字色变浅', async ({ window }) => {
    await setTheme(window, 'light')
    const lightFg = await window.evaluate(() => getComputedStyle(document.body).color)
    await setTheme(window, 'dark')
    const darkFg = await window.evaluate(() => getComputedStyle(document.body).color)
    expect(lightFg).not.toBe(darkFg)
  })

  test('T5: 主题切换后,sidebar 背景跟随变化', async ({ window }) => {
    await setTheme(window, 'light')
    const lightSidebarBg = await window.evaluate(() => {
      const s = document.querySelector('nav.sidenav') as HTMLElement
      return s ? getComputedStyle(s).backgroundColor : ''
    })
    await setTheme(window, 'dark')
    const darkSidebarBg = await window.evaluate(() => {
      const s = document.querySelector('nav.sidenav') as HTMLElement
      return s ? getComputedStyle(s).backgroundColor : ''
    })
    expect(lightSidebarBg).not.toBe('')
    expect(darkSidebarBg).not.toBe('')
    expect(lightSidebarBg).not.toBe(darkSidebarBg)
  })

  test('T6: 主题设置写入 config 持久化', async ({ window }) => {
    await setTheme(window, 'dark')
    // 持久化键是 'app.theme'(旧键 'theme' 会被迁移清空)
    const cfg = await window.evaluate(async () => {
      const api = (window as any).electronAPI
      if (!api?.config?.get) return null
      const r = await api.config.get('app.theme')
      return r?.data
    })
    expect(cfg).toBe('dark')
  })

  test('T7: 切回 light → 背景恢复', async ({ window }) => {
    await setTheme(window, 'dark')
    const darkBg = await window.evaluate(() => getComputedStyle(document.body).backgroundColor)
    await setTheme(window, 'light')
    const lightBg = await window.evaluate(() => getComputedStyle(document.body).backgroundColor)
    expect(lightBg).not.toBe(darkBg)
    const isDark = await window.evaluate(() => document.documentElement.classList.contains('dark'))
    expect(isDark).toBe(false)
  })
})
