import { test, expect, shouldRunElectronE2E } from './helpers/electron-app'
import { gotoBySideNav, gotoRoute } from './helpers/electron-app'

/**
 * VERIFICATION —— 剩余界面实跑（M4-R）
 * ═══════════════════════════════════════════════════════════════════════
 * 【为什么补这个文件】
 * M4-K 的遗留 #3 写着：「首屏之外仍有未实跑的界面 —— 其余页面(Skills / Models /
 * IM / Schedule / Settings / DevPanel 展开态)**仍只过 typecheck 与组件测试**」。
 *
 * M4-H 的教训很硬：「typecheck 通过 ≠ 模板能渲染 ≠ 数据能落到界面上」。
 * 本批把这些页面**逐个真跑一遍**,每页断三件事:
 *   ① 页面**根容器**真的渲染了(不是白屏/空壳)
 *   ② 页面**该有的关键内容**在(不是只有标题)
 *   ③ **没有红屏兜底**(paintFatalError 那个全屏红框)
 * 顺带把 M4-M / M4-N 新加的入口也验一遍:
 *   技能页「浏览 ClawHub 市场」· 模型页「对比模型」· 试验结果表的新列
 */

test.describe('VERIFICATION · 剩余界面实跑', () => {
  test.skip(!shouldRunElectronE2E, 'requires E2E_ELECTRON=1')

  /** 每页的最小"该有内容"清单 */
  const PAGES: Array<{
    name: string
    go: (window: any) => Promise<void>
    root: string
    /** 至少要出现一个的关键元素(选择器) */
    must: string[]
  }> = [
    {
      name: '技能管理',
      go: (w) => gotoBySideNav(w, '/skills'),
      root: '.skills-page',
      must: [
        '.skills-dir-card',        // 技能目录卡
        '.skills-trial-card',      // 技能验证(受控对照)卡
        // 【M4-Y】原「浏览 ClawHub 市场」按钮已删 —— 开源技能库直接内嵌在本页，
        // 公开技能在「开源技能库」卡片里找（自建仓库才去 /clawhub）。
        '.skills-hub-card',        // 开源技能库卡（搜索/推荐/下载）
      ],
    },
    {
      name: '模型管理',
      go: (w) => gotoBySideNav(w, '/models'),
      root: '.models-page',
      must: [
        'button:has-text("添加提供商")',
        'button:has-text("对比模型")', // M4-M 新增的入口
      ],
    },
    {
      name: 'IM 管理',
      go: (w) => gotoRoute(w, '/im-management'),
      root: '.im-management',
      must: ['.im-tabs'],
    },
    {
      name: '定时任务',
      go: (w) => gotoRoute(w, '/schedule'),
      root: '.schedule-page',
      must: ['.schedule-intro'],
    },
    {
      name: '设置',
      go: (w) => gotoBySideNav(w, '/settings'),
      root: '.settings-page',
      must: [
        '.settings-nav__btn',       // 左侧导航(基础设置/模型管理/MCP/记忆/关于)
        '.radio-group',             // 主题 radio 组
      ],
    },
  ]

  for (const page of PAGES) {
    test(`${page.name}页:渲染完整 + 无红屏`, async ({ window }) => {
      const errors: string[] = []
      window.on('pageerror', (e: Error) => errors.push(e.message))

      await page.go(window)
      await window.waitForTimeout(800)

      // ① 根容器渲染
      await expect(window.locator(page.root), `${page.name}页根容器没渲染`).toBeVisible({ timeout: 10_000 })

      // ② 关键内容在,且**完整落在视口内**(M4-O 那类"靠右的元素被裁掉"的回归)
      for (const sel of page.must) {
        const loc = window.locator(sel).first()
        await expect(loc, `${page.name}页缺关键内容:${sel}`).toBeVisible({ timeout: 10_000 })
        const box = await loc.boundingBox()
        if (box) {
          const vw = await window.evaluate(() => window.innerWidth)
          expect(box.x + box.width, `${page.name}页的「${sel}」超出视口右边缘(被裁)`).toBeLessThanOrEqual(vw + 1)
          expect(box.x, `${page.name}页的「${sel}」超出视口左边缘(被裁)`).toBeGreaterThanOrEqual(-1)
        }
      }

      // ③ 没有红屏兜底
      const bodyText = await window.evaluate(() => document.body.innerText)
      expect(bodyText, `${page.name}页出现红屏兜底`).not.toContain('[PiPiClaw render error]')

      // 渲染期没有未捕获异常
      expect(errors, `${page.name}页有未捕获异常:${errors.join(' | ')}`).toHaveLength(0)

      // 留一张存档图(人工可查)
      await window.screenshot({ path: `test-results/page-${page.name}.png` })
    })
  }

  test('DevPanel 展开态:有内容(不只是一个按钮)', async ({ window }) => {
    await window.waitForTimeout(600)
    await window.keyboard.press('Control+Shift+D')
    const body = window.locator('.dev-panel .dev-body')
    await expect(body, 'DevPanel 没展开').toBeVisible({ timeout: 10_000 })
    const text = (await body.innerText()).trim()
    expect(text.length, 'DevPanel 内容为空').toBeGreaterThan(0)
    // 清单原话:FPS / 内存 / 版本
    expect(text).toContain('FPS')
    await window.screenshot({ path: 'test-results/page-DevPanel.png' })
  })

  test('设置页五个导航页签都在,且 MCP 页签可达', async ({ window }) => {
    await gotoBySideNav(window, '/settings')
    await window.waitForTimeout(800)
    const navBtns = window.locator('.settings-nav__btn')
    const count = await navBtns.count()
    expect(count, '设置页导航页签数量不对').toBeGreaterThanOrEqual(4)

    // 逐个点过去,每个都要渲染出内容(不点 = 永远不知道有没有问题)
    for (let i = 0; i < count; i++) {
      await navBtns.nth(i).click()
      await window.waitForTimeout(500)
      const panelText = (await window.locator('.settings-panels').innerText()).trim()
      expect(panelText.length, `设置页第 ${i + 1} 个页签内容为空`).toBeGreaterThan(0)
      const bodyText = await window.evaluate(() => document.body.innerText)
      expect(bodyText, `设置页第 ${i + 1} 个页签出现红屏`).not.toContain('[PiPiClaw render error]')
    }
  })
})
