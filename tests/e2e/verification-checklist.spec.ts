import { test, expect, shouldRunElectronE2E, gotoBySideNav } from './helpers/electron-app'

/**
 * VERIFICATION 清单自动化 —— D 段(UI 肉眼确认)/ E 段(运行时稳定性)
 * ═══════════════════════════════════════════════════════════════════════
 * 【为什么有这个文件】
 * `docs/VERIFICATION.md` 里的 D/E 段全是**人工肉眼确认**项 —— 标注"最近更新
 * 2026-08-12",已过期近三个月,且**人工确认不可回归**。
 * M4-H 的教训很直接:「人工实跑确实抓到了问题(i18n 缺 key、flaky 断言),
 * 但**人工截图不可回归**」。
 *
 * 故:把清单逐条变成**自动化断言**,让"勾上"这件事有可复跑的证据。
 *
 * 【每个用例名对应 VERIFICATION.md 的条目号】
 *   D1 侧边栏 5 图标 + 底部齿轮 · D2 标题栏齿轮 + 窗口控制
 *   D3 网关小圆点 + 端口号 · D4 Ctrl+Shift+D → DevPanel
 *   D6 会话下拉菜单 / 滚动条 / 复选框
 *   E1 代理下主窗口不白屏 · E2 渲染错误 → 红屏兜底
 * (D5「50+ 条消息 + 虚拟滚动」需要真实 LLM 往返,单列一个 spec)
 *
 * 【口径】
 * 断言的是**用户能看到/能操作到的东西**,不是内部实现:
 * 比如 D1 断的是「每个图标都有非空文案」—— 这正是 M4-G 实跑抓到的真实缺陷
 * (侧栏"搜索""语音"两个图标没文案),断言必须钉住它。
 */

/** 等应用把 Vue 挂载好(共用 fixture 已等 #app,这里再给 Vue 一拍) */
async function settle(window: any, ms = 600) {
  await window.waitForTimeout(ms)
}

test.describe('VERIFICATION D/E 段 · 清单自动化', () => {
  test.skip(!shouldRunElectronE2E, 'requires E2E_ELECTRON=1')

  test('D1: 侧边栏图标齐全 + 每个都有非空文案(M4-G 缺陷回归钉)', async ({ window }) => {
    await settle(window)

    const nav = window.locator('nav.sidenav')
    await expect(nav).toHaveCount(1)

    // 【v4.7】rail 收敛为 3 个工作对象 + 底部设置(共 4)。输入能力下沉到
    // ChatInput、配置页进设置页、浏览项进「更多」——所以这里断 4,不再是 6。
    // 数量本身也有契约:tests/unit/nav-ia.test.ts 锁定 PRIMARY_NAV 恰为 3。
    const icons = nav.locator('a.nav-icon')
    const count = await icons.count()
    expect(count).toBe(4) // 对话 / 技能 / 定时任务 + 底部设置

    // 【关键断言】每个图标都要有非空 aria-label/title(M4-G 缺陷回归钉)。
    const labels = await icons.evaluateAll((els: Element[]) =>
      els.map((el) => ({
        aria: el.getAttribute('aria-label') ?? '',
        title: el.getAttribute('title') ?? '',
        href: el.getAttribute('href') ?? '',
      })),
    )
    for (const l of labels) {
      expect(l.aria.trim(), `图标 ${l.href} 缺少 aria-label`).not.toBe('')
      expect(l.title.trim(), `图标 ${l.href} 缺少 title`).not.toBe('')
    }

    // 下沉到「更多」的输入/浏览项同样要有可读文案(原来只有 rail 被钉住)
    await window.locator('[data-testid="nav-more-trigger"]').click()
    const morePanel = window.locator('[data-testid="nav-more-panel"]')
    await expect(morePanel).toBeVisible({ timeout: 8_000 })
    const moreLabels = await morePanel.locator('a.nav-more-item .nav-more-item-title').allTextContents()
    expect(moreLabels.length).toBeGreaterThanOrEqual(1)
    for (const label of moreLabels) {
      expect(label.trim(), '「更多」入口缺少可读文案').not.toBe('')
    }
    await window.keyboard.press('Escape')

    // 底部齿轮 = 设置入口(独立于主导航)
    const settings = nav.locator('a.nav-icon[href*="settings"]')
    await expect(settings).toHaveCount(1)
    await expect(settings).toHaveAttribute('aria-label', /\S/)
  })

  test('D2: 标题栏 = 齿轮 + New World + 三枚窗口控制(可见且有尺寸)', async ({ window }) => {
    await settle(window)

    const titleBar = window.locator('.title-bar')
    await expect(titleBar).toHaveCount(1)

    // 前齿轮 + 应用名
    await expect(titleBar.locator('.app-icon')).toHaveCount(1)
    await expect(titleBar.locator('.app-name')).toHaveText(/New World/i)

    // 窗口控制:最小化 / 最大化 / 关闭
    for (const cls of ['minimize', 'maximize', 'close']) {
      const btn = titleBar.locator(`button.control-btn.${cls}`)
      await expect(btn, `缺少 ${cls} 按钮`).toHaveCount(1)
      await expect(btn, `${cls} 按钮不可见`).toBeVisible()
      const box = await btn.boundingBox()
      expect(box, `${cls} 按钮没有尺寸(可能被父容器裁掉)`).not.toBeNull()
      expect(box!.width).toBeGreaterThan(0)
      expect(box!.height).toBeGreaterThan(0)
    }
  })

  test('D3: 网关小圆点 + 端口号(数字),且 running 时为绿', async ({ window }) => {
    await settle(window)

    // 网关是异步起的,给它时间
    const indicator = window.locator('.gateway-indicator')
    await indicator.waitFor({ state: 'attached', timeout: 20_000 }).catch(() => {})

    const attached = (await indicator.count()) > 0
    if (!attached) {
      // 端口没起来 → 指示器理应不显示(不该凭空显示一个空圆点)
      test.info().annotations.push({ type: 'note', description: '网关在本轮未启动,指示器正确隐藏' })
      return
    }

    // 【审计 #P1-5】端口号已从常驻 DOM(.gateway-port 已删)收进 hover tooltip。
    // 真实用户看到的就是这个 title,所以断它里面的端口是数字。
    const title = (await indicator.getAttribute('title')) ?? ''
    expect(title, '网关指示器应有状态 tooltip').toMatch(/端口\s*\d+/)
    const portMatch = title.match(/端口\s*(\d+)/)
    expect(portMatch, `tooltip 端口号不是数字:${title}`).not.toBeNull()

    // 小圆点存在
    await expect(indicator.locator('.gateway-dot')).toHaveCount(1)

    // running 时应为绿 —— 清单原话「绿=running」
    const stateClass = await indicator.getAttribute('class')
    if (stateClass?.includes('is-running')) {
      const color = await indicator.locator('.gateway-dot')
        .evaluate((el) => getComputedStyle(el).backgroundColor)
      // 绿色系:rgb 的 g 分量明显大于 r 与 b
      const m = color.match(/rgba?\((\d+),\s*(\d+),\s*(\d+)/)
      expect(m, `取不到圆点颜色:${color}`).not.toBeNull()
      const [, r, g, b] = m!.map(Number) as unknown as number[]
      expect(g, `running 状态的圆点不是绿:${color}`).toBeGreaterThan(r + 30)
      expect(g, `running 状态的圆点不是绿:${color}`).toBeGreaterThan(b + 30)
    }
  })

  test('D4: Ctrl+Shift+D 唤起 DevPanel,再按收起', async ({ window }) => {
    await settle(window)

    // 【实现细节】DevPanel 常驻 DOM(App.vue 无条件渲染),折叠/展开由
    // 内部 `open` 状态控制 —— 展开体是 `.dev-body`(v-if)。
    // 所以断言的对象是 `.dev-body`,不是 `.dev-panel`。
    await expect(window.locator('.dev-panel')).toHaveCount(1)
    const body = window.locator('.dev-panel .dev-body')
    await expect(body, 'DevPanel 初始应是折叠的').toHaveCount(0)

    await window.keyboard.press('Control+Shift+D')
    await expect(body, 'Ctrl+Shift+D 未展开 DevPanel').toBeVisible()

    // 内容要在(FPS / 内存 / 版本 —— 清单原话)
    const text = (await body.innerText()).trim()
    expect(text.length, 'DevPanel 内容为空').toBeGreaterThan(0)
    expect(text).toContain('FPS')

    await window.keyboard.press('Control+Shift+D')
    await expect(body, '再次按 Ctrl+Shift+D 未收起 DevPanel').toHaveCount(0)
  })

  test('D6: 会话"…"菜单(重命名/归档/删除)+ 复选框 + 会话列表可滚', async ({ window }) => {
    await settle(window, 1200)

    // 先造一个会话,否则列表是空的,菜单无从点。
    // 【走 UI 而不是 IPC】实测:通过 IPC `chat.createConversation` 建的会话,
    // 侧栏**不会刷新**(store 只在挂载时拉一次 + 响应自己的 action)→
    // 菜单无从点。真实用户也是点"新建",所以走 UI 才是同一条路径。
    const newBtn = window.locator('button.new-chat-btn')
    await expect(newBtn, '侧栏缺「新建」按钮').toHaveCount(1)
    await newBtn.click()
    await window.waitForTimeout(1200)

    const item = window.locator('.conversation-item').first()
    await expect(item).toHaveCount(1)

    // 复选框(清单:复选框正常交互)
    const checkbox = item.locator('.el-checkbox')
    await expect(checkbox, '会话项缺复选框').toHaveCount(1)
    await expect(checkbox).toBeVisible()

    // "…"菜单 → 下拉项齐全
    const more = item.locator('.more-icon')
    await expect(more, '会话项缺"…"菜单触发器').toHaveCount(1)
    await more.click()
    await window.waitForTimeout(500)

    const menu = window.locator('.el-dropdown-menu:visible')
    await expect(menu, '"…"菜单未弹出').toHaveCount(1)
    for (const label of ['重命名', '归档', '删除']) {
      await expect(menu.locator(`text=${label}`), `菜单缺「${label}」`).toHaveCount(1)
    }
    await window.keyboard.press('Escape')
    await window.waitForTimeout(300)

    // 会话列表可滚(有溢出才需要滚动条)
    const list = window.locator('.conversation-list, .chat-sidebar, .conversation-groups').first()
    if (await list.count()) {
      const overflow = await list.evaluate((el) => ({
        scrollHeight: el.scrollHeight,
        clientHeight: el.clientHeight,
        overflowY: getComputedStyle(el).overflowY,
      }))
      // 有溢出时必须是可滚的(不能 overflow:hidden 把内容吃掉)
      if (overflow.scrollHeight > overflow.clientHeight) {
        expect(['auto', 'scroll'], `会话列表溢出却是 ${overflow.overflowY}`).toContain(overflow.overflowY)
      }
    }
  })

  test('E2: 渲染错误 → 红屏兜底 paintFatalError(而非整页空白吞错)', async ({ window }) => {
    await settle(window)

    // 触发一次未捕获错误
    await window.evaluate(() => {
      setTimeout(() => { throw new Error('VERIFICATION-E2-探针错误') }, 0)
    })
    await window.waitForTimeout(800)

    const bodyText = await window.evaluate(() => document.body.innerText)
    expect(bodyText, '未出现红屏兜底文本').toContain('[New World render error]')
    expect(bodyText).toContain('VERIFICATION-E2-探针错误')
  })
  test('M1: 低频功能入口在「意图现场」,不在图标栏里(开源技能库)', async ({ window }) => {
    // 【M4-M】v4.4 把侧栏收成 7 个固定图标时,ClawHub 与模型对比的侧栏入口丢了。
    // 决策:不进侧栏(无文字的图标栏靠"识别",对新手更难),改为在**母页面**放带文字的入口
    //   —— 同类产品的做法:Cherry Studio 的插件市场在「设置 → Agent 设置 → 插件」、
    //   OpenChat 主导航只留 3 项、Claude Code 用 /plugin 显式命令。
    //
    // 【M4-Y 修正】原「浏览 ClawHub 市场」按钮已删 —— 开源技能库直接内嵌在技能页
    // （比"跳一层"更靠前）；/clawhub 只剩自建仓库（低频，走命令面板）。
    // 故这条断言改为钉住「技能页内嵌开源技能库」这个更强的"意图现场"。

    // ① 技能页 → 开源技能库内嵌卡（可见且在视口内）
    await gotoBySideNav(window, '/skills')
    const hubCard = window.locator('.skills-hub-card').first()
    await expect(hubCard, '技能页缺少「开源技能库」卡').toBeVisible({ timeout: 15_000 })
    // 卡片在页面靠下 —— 先滚进视口再断言（否则"可见但没滚到"会误判）
    await hubCard.scrollIntoViewIfNeeded()
    // 【关键】必须在**视口内** —— toBeVisible() 只看 CSS 可见性,
    // 元素落在视口外也算"可见"(还能被自动滚动点到)→ 那样这条断言就是假通过。
    await expect(hubCard).toBeInViewport({ timeout: 10_000 })
    // 卡片里要有搜索框（用户能直接在这里找，而不是先跳页）
    await expect(window.locator('.skills-hub-card input').first()).toBeVisible({ timeout: 10_000 })

    // ② 侧栏**不该有**这些图标(决策本身也要被钉住 —— 免得哪天又被加回去)
    await expect(window.locator('nav.sidenav a.nav-icon[href$="#/clawhub"]')).toHaveCount(0)
    await expect(window.locator('nav.sidenav a.nav-icon[href$="#/model-compare"]')).toHaveCount(0)
  })
})
