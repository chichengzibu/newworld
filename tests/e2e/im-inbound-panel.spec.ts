/**
 * IM 入站连通性面板 —— e2e 回归
 *
 * 锁定三件事：
 *   ① 「状态仪表板」里有「入站连通性」这一块（IPC 早已存在，此前渲染层从未调用）
 *   ② 4 个可真入站的通道恒定展示（即使一个都没配置 —— 面板要告知「有什么选项」）
 *   ③ 仅出站通道如实标注，不假装能收消息
 */
import { test, expect } from './helpers/electron-app'

test.describe('IM 入站连通性面板', () => {
  test.beforeEach(async ({ window }) => {
    await window.evaluate(() => {
      window.location.hash = '#/im-management'
    })
    await window.waitForTimeout(1500)
    const tab = window.locator('.el-tabs__item', { hasText: '状态仪表板' })
    if ((await tab.count()) > 0) {
      await tab.first().click()
      await window.waitForTimeout(800)
    }
  })

  test('入站连通性面板存在且有 4 张可入站通道卡片', async ({ window }) => {
    const panel = window.locator('.inbound-panel')
    await expect(panel).toBeVisible({ timeout: 10000 })
    await expect(panel.locator('.inbound-head h3')).toHaveText('入站连通性')

    const cards = panel.locator('.inbound-card')
    await expect(cards).toHaveCount(4)

    const names = await panel.locator('.inbound-title strong').allInnerTexts()
    expect(names).toEqual(['Telegram', 'Discord', 'Slack', 'Rocket.Chat'])

    // 每个卡片必须说明入站机制，不能只给个名字
    const mechs = await panel.locator('.inbound-mech').allInnerTexts()
    expect(mechs.join(' ')).toContain('getUpdates')
    expect(mechs.join(' ')).toContain('Gateway')
    expect(mechs.join(' ')).toContain('Socket Mode')
    expect(mechs.join(' ')).toContain('REST')
  })

  test('每张卡片都有明确状态标签，不用含糊措辞', async ({ window }) => {
    const cards = window.locator('.inbound-card')
    await expect(cards).toHaveCount(4)
    const states = await cards.locator('.el-tag').allInnerTexts()
    // 未配置时应当是「未启用」，而不是「已连通」之类会误导的措辞
    for (const s of states) {
      expect(['未启用', '入站运行中', '已启用但未运行']).toContain(s.trim())
    }
  })

  test('仅出站通道如实标注（不假装能入站）', async ({ window }) => {
    const outbound = window.locator('.inbound-outbound')
    await expect(outbound).toBeVisible()
    await expect(outbound).toContainText('仅出站')
  })

  test('说明文字里没有裸露的 Markdown 星号', async ({ window }) => {
    const hint = await window.locator('.inbound-hint').innerText()
    expect(hint).not.toContain('**')
    expect(hint).toContain('无公网 IP')
  })

  test('刷新入站状态按钮可用', async ({ window }) => {
    const btn = window.locator('.inbound-head button', { hasText: '刷新入站状态' })
    await expect(btn).toBeVisible()
    await btn.click()
    await window.waitForTimeout(600)
    // 刷新后卡片仍在（不因接口失败而消失）
    await expect(window.locator('.inbound-card')).toHaveCount(4)
  })
})
