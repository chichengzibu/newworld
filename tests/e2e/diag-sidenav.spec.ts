import { test, expect, shouldRunElectronE2E } from './helpers/electron-app'

/**
 * 诊断测试: 打印 SideNav 实际渲染的导航项
 *
 * 用途: 当 SideNav 文字变更(中英/i18n 调整)时,验证选择器是否需要更新
 *
 * 用法:
 *   E2E_ELECTRON=1 npx playwright test tests/e2e/diag-sidenav.spec.ts
 *
 * P1-T1.1: 跳到 describe 级,确保 E2E_ELECTRON 未设时也能正常 skip
 * (原在 test 体内 skip,但 fixture 在 skip 之前就抛错了)
 */
test.describe('SideNav diagnostic', () => {
  test.skip(!shouldRunElectronE2E, 'requires E2E_ELECTRON=1')

  test('dump SideNav items', async ({ window }) => {
    // v4.4 起侧栏是 icon-only rail:`nav.sidenav > a.nav-icon`,**没有可见文字**
    // → 诊断信息改为打印 aria-label / title(走 i18n,正是要看的文案来源)
    await window.waitForSelector('nav.sidenav a.nav-icon', { timeout: 10_000 })
    const items = await window.locator('nav.sidenav a.nav-icon').evaluateAll((els) =>
      els.map((el) => ({
        href: el.getAttribute('href') ?? '',
        aria: el.getAttribute('aria-label') ?? '',
        title: el.getAttribute('title') ?? '',
      })),
    )

    console.log('=== Nav items ===')
    for (const it of items) {
      console.log(`  ${it.href.padEnd(22)} aria="${it.aria}"  title="${it.title}"`)
    }

    console.log('=== End ===')
    expect(items.length).toBeGreaterThan(0)
    // 每个入口都要有非空文案(M4-G 实跑抓到的真实缺陷:nav.search / nav.voice 缺 key)
    for (const it of items) {
      expect(it.aria.trim(), `${it.href} 缺 aria-label`).not.toBe('')
    }
  })
})
