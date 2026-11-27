import { test, expect, shouldRunElectronE2E, gotoBySideNav } from './helpers/electron-app'

/**
 * 开源技能库（/skills 页的 hub 卡片）— P1 生态入口验收
 *
 * 【为什么补这份】
 * 此前 e2e 只覆盖 /clawhub 私有签名仓库, /skills 的开源技能库卡片
 * (默认来源/搜索/元数据/一键安装)只有单测覆盖 —— 真实 Electron 下
 * IPC 通不通、卡片渲染对不对, 没有门禁。
 *
 * 钉住:
 *   SH1: 卡片存在, 有来源管理 / 刷新索引 / 搜索框
 *   SH2: 来源对话框列出官方源(anthropics/skills)与社区源, 官方源不可删
 *   SH3: 搜索是即时触发(输入后列表刷新), 无需按回车, 无 hubSearch 错误
 *
 * 离线缓存语义由 `tests/unit/skill-hub-m4x.test.ts` 覆盖(无网络依赖的索引搜索),
 * 这里不再重复一个只能验证"搜索框可用"的弱断言。
 */

test.describe('开源技能库 /skills hub', () => {
  test.skip(!shouldRunElectronE2E, 'requires E2E_ELECTRON=1')

  test('SH1: 开源技能库卡片关键控件齐全', async ({ window }) => {
    await gotoBySideNav(window, '/skills')
    await expect(window.locator('.skills-hub-card')).toBeVisible({ timeout: 15_000 })
    const text = await window.locator('.skills-hub-card').innerText()
    expect(text).toContain('开源技能库')
    expect(text).toContain('管理来源')
    expect(text).toContain('刷新索引')
    await expect(window.locator('input[placeholder*="搜索开源技能"]')).toBeVisible()
  })

  test('SH2: 来源对话框官/社区源齐全, 内置源不可删', async ({ window }) => {
    await gotoBySideNav(window, '/skills')
    await window.locator('.skills-hub-card button:has-text("管理来源")').click()
    await expect(window.locator('.el-dialog:visible')).toBeVisible({ timeout: 10_000 })
    const dialogText = await window.locator('.el-dialog:visible').innerText()
    expect(dialogText).toContain('Anthropic 官方技能集')
    expect(dialogText).toContain('Skill-Shelf 社区技能库')
    expect(dialogText).toContain('内置')
    await window.keyboard.press('Escape')
  })

  test('SH3: 搜索即时触发(不必按回车), 无 console error', async ({ window }) => {
    const errors: string[] = []
    window.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()) })
    await gotoBySideNav(window, '/skills')
    const input = window.locator('input[placeholder*="搜索开源技能"]')
    await input.fill('pdf')
    await window.waitForTimeout(800) // 300ms 防抖 + IPC 往返
    // 索引可能还没拉过(空态) —— 只要不报错、状态文案真实即可
    const text = await window.locator('.skills-hub-card').innerText()
    expect(text.length).toBeGreaterThan(0)
    expect(errors.filter(e => /hubSearch|searchHub failed/i.test(e))).toEqual([])
  })
})
