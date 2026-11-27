import { test, expect, shouldRunElectronE2E, gotoRoute } from './helpers/electron-app'

/**
 * 私有技能仓库（M4-Y 起）
 * ═══════════════════════════════════════════════════════════════════════
 * 【这份 spec 的历史】
 * 它原先测的是 ClawHub 的 4 个**本地演示**页签（浏览市场 / 发布技能 / 审核队列 / 技能模板）。
 * M4-Y 审计后把那 4 个页签连同后端 ClawHubManager 一起删了（下载是 stub、
 * 审核通过的条目永远装不上、模板实例化写到 SkillLoader 从不扫的目录）。
 * 页面保留的是**远程仓库**（自建、带 Ed25519 签名）——信任模型与开源技能库不同。
 *
 * 【教训】删 UI 时必须同步改 e2e，否则交付门禁会红在一些"早已不存在的页面"上。
 *
 * 现在钉住：
 *   CB1: 页面是「私有技能仓库」，并说明公开技能去技能页的「开源技能库」
 *   CB2: 有 registry 基址输入 + 「连接仓库」按钮
 *   CB3: 未连接时给出配置指引（环境变量 / userData 文件）
 *   CB4: 旧的 4 个本地演示页签**不存在**
 */

test.describe('私有技能仓库（原 ClawHub）', () => {
  test.skip(!shouldRunElectronE2E, 'requires E2E_ELECTRON=1')

  test('CB1: 进 /clawhub → 是「私有技能仓库」,并指向开源技能库', async ({ window }) => {
    await gotoRoute(window, '/clawhub')
    await window.waitForTimeout(800)

    await expect(window.locator('.clawhub-page')).toBeVisible({ timeout: 10_000 })
    const heading = window.locator('h1').first()
    await expect(heading).toBeVisible({ timeout: 10_000 })
    expect(await heading.textContent()).toMatch(/私有技能仓库/)

    // 必须说清与「开源技能库」的分工 —— 否则用户不知道公开技能去哪找
    const body = await window.locator('.clawhub-page').innerText()
    expect(body).toContain('开源技能库')
  })

  test('CB2: 有 registry 基址输入与「连接仓库」按钮', async ({ window }) => {
    await gotoRoute(window, '/clawhub')
    await window.waitForTimeout(800)

    await expect(window.locator('.clawhub-page input').first()).toBeVisible({ timeout: 10_000 })
    const connectBtn = window.locator('button:has-text("连接仓库"), button:has-text("检查更新")').first()
    await expect(connectBtn).toBeVisible({ timeout: 10_000 })
    await expect(connectBtn).toBeInViewport({ timeout: 5_000 })
  })

  test('CB3: 未连接时给出配置指引（环境变量 / userData 文件）', async ({ window }) => {
    await gotoRoute(window, '/clawhub')
    await window.waitForTimeout(800)

    const page = window.locator('.clawhub-page')
    const body = await page.innerText()
    // 用户得知道下一步该配什么，而不是面对一个空页面
    expect(body, '未连接时要有清晰的空态指引').toMatch(/尚未连接|填入仓库地址|连接仓库/)
    // 具体的环境变量 / 文件路径放在指引的 title(tooltip) 里,不在正文
    const titled = await page.locator('[title]').evaluateAll((els: Element[]) =>
      els.map((el) => el.getAttribute('title') ?? '').join(' '),
    )
    expect(titled).toMatch(/NW_CLAWHUB_REGISTRY|clawhub-registry\.txt/)
    expect(titled).toMatch(/NW_CLAWHUB_PUBKEY|clawhub-pubkey\.txt/)
  })

  test('CB4: 本地演示的 4 个页签已移除（不许回潮）', async ({ window }) => {
    await gotoRoute(window, '/clawhub')
    await window.waitForTimeout(800)

    const body = await window.locator('.clawhub-page').innerText()
    for (const gone of ['浏览市场', '发布技能', '审核队列', '技能模板']) {
      expect(body, `旧页签「${gone}」不应再出现`).not.toContain(gone)
    }
    // 也不该再出现"本地演示模式"这种字样（那套是假的）
    expect(body).not.toContain('本地演示模式')
  })
})
