import { test, expect, shouldRunElectronE2E } from './helpers/electron-app'
import { createConversationViaUi, gotoBySideNav } from './helpers/electron-app'

/**
 * VERIFICATION —— 小屏等比缩放（M4-N）
 * ═══════════════════════════════════════════════════════════════════════
 * 【为什么要有这条】
 * 应用布局按 **1280px** 铺开(`#app { min-width: 1280px }`),
 * 而窗口以前 `minWidth: 1280` → 屏幕比 1280 CSS px 窄时(1366×768 笔记本开
 * 125% 缩放 → CSS 宽度只有 1092),窗口会比屏幕还宽 → **右边一截在屏幕外**,
 * 「发送」这种靠右的按钮**用户根本够不着**。
 *
 * 现:窗口窄于设计宽度时按比例缩小页面(`setZoomFactor`)→ 布局仍按 1280 铺开,
 * 整体变小 → **什么都不裁切**。
 *
 * 【断的是什么】
 * 不是「缩放有没有生效」,而是**「缩放后还有没有东西被裁」**——
 * 后者才是用户真正遇到的故障。
 */

test.describe('VERIFICATION · 小屏等比缩放', () => {
  test.skip(!shouldRunElectronE2E, 'requires E2E_ELECTRON=1')

  test('窗口窄于设计宽度 → 整体等比缩放,靠右的发送按钮不被裁', async ({ electronApp, window }) => {
    // 先造一个会话(输入区才有发送按钮)
    await gotoBySideNav(window, '/chat')
    await createConversationViaUi(window)
    await window.waitForTimeout(600)

    // 物理窗口缩到 1000 宽(模拟窄屏)
    await electronApp.evaluate(({ BrowserWindow }) => {
      const w = BrowserWindow.getAllWindows()[0]
      w?.setSize(1000, 800)
    })
    // 等去抖 + 缩放生效
    await window.waitForTimeout(900)

    const info = await window.evaluate(() => {
      const sendBtn = document.querySelector('.send-btn') as HTMLElement | null
      const rect = sendBtn?.getBoundingClientRect()
      return {
        innerWidth: window.innerWidth,
        sendRight: rect ? Math.round(rect.right) : null,
        sendWidth: rect ? Math.round(rect.width) : null,
        sendVisible: rect ? rect.width > 0 && rect.height > 0 : false,
        // 元素中心点上最靠前的元素是谁(被别的盖住就会不是按钮自己/其后代)
        topAtSend: (() => {
          if (!sendBtn || !rect) return null
          const el = document.elementFromPoint(rect.left + rect.width / 2, rect.top + rect.height / 2)
          if (!el) return null
          // 命中点落在按钮**自己或其后代**(按钮里的图标/文字 span 是正常的)
          const hit = (el as HTMLElement).closest?.('.send-btn')
          return hit ? 'send-btn' : (el.className || el.tagName).toString()
        })(),
      }
    })

    // 缩放生效后:CSS 视口宽度回到设计宽度(1280),说明布局按 1280 铺开而不是被裁
    expect(info.innerWidth, '缩放没生效(视口仍是物理宽度 → 布局被裁)').toBeGreaterThanOrEqual(1280)

    // 发送按钮完整落在视口内
    expect(info.sendVisible, '发送按钮不可见').toBe(true)
    expect(info.sendRight, '发送按钮右边缘超出视口 → 被裁了').toBeLessThanOrEqual(info.innerWidth)

    // 点得到(最靠前的元素就是按钮自己,不是被别的盖住)
    expect(String(info.topAtSend)).toContain('send-btn')

    // 缩放系数与主进程一致
    const zoom = await electronApp.evaluate(({ BrowserWindow }) => {
      const w = BrowserWindow.getAllWindows()[0]
      return w ? { factor: w.webContents.getZoomFactor(), width: w.getContentSize()[0] } : null
    })
    expect(zoom, '拿不到窗口状态').not.toBeNull()
    expect(zoom!.factor).toBeGreaterThan(0.5)
    expect(zoom!.factor).toBeLessThan(1)      // 1000/1280 ≈ 0.78
  })
})
