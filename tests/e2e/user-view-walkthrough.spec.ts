import { test, expect } from './helpers/electron-app'
import {
  gotoRoute,
  createConversationViaUi,
  addProviderAndReload,
} from './helpers/electron-app'
import { mkdirSync, writeFileSync } from 'node:fs'

/**
 * 用户视角全量走查 —— 「以用户视角测试执行此程序是否正常使用，
 * 各个功能以及 UI 设计是否合理美观」
 *
 * 与既有断言型 spec 的区别：
 *  - all-nav-routes / verification-pages 只断言「页面能打开、无 JS 错误」；
 *  - 本 spec 模拟真实用户动作：首次启动 → 看空态 → 配模型 → 命令面板
 *    → 新建会话 → 输入 → 切主题 → 逐页浏览 → 设置六个 tab → 真创建备份；
 *  - 每一页都截图，并采集量化指标（文本量 / 溢出 / 控件密度 / 控制台错误）
 *    落到 walkthrough-report.json，供目视评估与后续回归对比。
 *
 * 运行：E2E_ELECTRON=1 npx playwright test tests/e2e/user-view-walkthrough.spec.ts
 * 产物：e2e-screenshots/user-view/*.png + walkthrough-report.json
 */

const DIR = 'e2e-screenshots/user-view'
const REPORT = `${DIR}/walkthrough-report.json`

/** 硬错误（CSP / i18n 编译 / 运行时崩溃），出现即视为功能不可用 */
const HARD_ERROR_RE =
  /EvalError|Refused to evaluate|Content Security Policy|Unexpected return type|NOT_SUPPORT_NON_STRING_MESSAGE|TypeError|ReferenceError|Cannot read properties/i

/** 无头 / 未联网环境的预期噪音，不视为 UI 缺陷 */
const IGNORE_RE =
  /favicon|Autofill\.enable|net::ERR|Failed to load resource|ERR_CONNECTION|ERR_NAME_NOT_RESOLVED|getUpdates|api\.telegram\.org|ECONNREFUSED/i

type PageStat = {
  route: string
  slug: string
  title: string
  textLen: number
  overflowXPx: number
  buttons: number
  inputs: number
  cards: number
  consoleErrors: string[]
  screenshot: string
}

/** 生产可见的全部 12 个页面（devOnly demo 已由 router 守卫重定向，不纳入；
 *  v4.9 模型对比 / 帮助中心已下线） */
const ROUTES = [
  { path: '/chat', slug: 'chat' },
  { path: '/models', slug: 'models' },
  { path: '/skills', slug: 'skills' },
  { path: '/im-management', slug: 'im-management' },
  { path: '/schedule', slug: 'schedule' },
  { path: '/search', slug: 'search' },
  { path: '/voice', slug: 'voice' },
  { path: '/clawhub', slug: 'clawhub' },
  { path: '/remote-control', slug: 'remote-control' },
  { path: '/permissions', slug: 'permissions' },
  { path: '/settings', slug: 'settings' },
  { path: '/settings/im-accounts', slug: 'im-accounts' },
] as const

function attachErrorCollector(window: import('@playwright/test').Page): string[] {
  const errors: string[] = []
  window.on('console', (m) => {
    if (m.type() === 'error') errors.push(m.text())
  })
  window.on('pageerror', (e) => errors.push(`[pageerror] ${String(e)}`))
  return errors
}

/** 通过 Settings → 基础设置 的真实主题单选按钮切换主题 */
async function setThemeViaUi(
  window: import('@playwright/test').Page,
  index: 0 | 1,
): Promise<string> {
  await gotoRoute(window, '/settings')
  await window.locator('.radio-group .radio').nth(index).click()
  await window.waitForTimeout(700)
  return window.evaluate(() => document.documentElement.dataset.theme || '')
}

test.describe('用户视角全量走查（真实 Electron）', () => {
  test.beforeEach(() => {
    mkdirSync(DIR, { recursive: true })
  })

  /**
   * U1 —— 首屏 / 对话主页：空态、控件齐全、无溢出、命令面板、新建会话、输入
   * 分两阶段：未配置模型的首次空态 → 配好模型后的完整态（更接近真实用户日常）
   */
  test('U1: 首屏与对话主页 —— 空态、控件、命令面板、新建会话、输入', async ({ window }) => {
    test.setTimeout(150_000)
    const errors = attachErrorCollector(window)
    await window.waitForTimeout(1200)

    // v4.8：首次引导已整体移除，首屏直接进入对话页，无遮罩
    const guideCount = await window.locator('.first-launch-guide').count()
    expect(guideCount, '首次启动引导组件不应再存在').toBe(0)

    // 无白屏
    const emptyTextLen = await window.evaluate(
      () => (document.querySelector('#app') as HTMLElement)?.innerText?.length ?? 0,
    )
    expect(emptyTextLen, '首屏渲染非空').toBeGreaterThan(50)

    // 无横向溢出（UI 布局合理性）
    const overflow = await window.evaluate(
      () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
    )
    expect(overflow, '首屏无横向溢出').toBeLessThanOrEqual(2)

    // 输入卡关键控件齐全
    for (const sel of [
      '.attach-btn',
      '.provider-pill',
      '.model-pill',
      '.memory-pill',
      '.send-btn',
    ]) {
      await expect(window.locator(sel).first(), `${sel} 可见`).toBeVisible({ timeout: 10_000 })
    }

    // 输入卡尺寸合理性
    const box = await window.locator('.input-area').first().boundingBox()
    expect(box, '输入卡存在').toBeTruthy()
    if (box) {
      expect(box.height, '输入卡不臃肿不被压扁').toBeGreaterThanOrEqual(100)
      expect(box.height).toBeLessThanOrEqual(300)
      const vw = (await window.viewportSize())?.width ?? 1280
      expect(box.width, '输入卡有足够宽度').toBeGreaterThan(vw * 0.4)
    }

    await window.screenshot({ path: `${DIR}/01-chat-empty-first-run.png` })

    // —— 第二阶段：配置模型后（真实用户完成初始配置后的日常态）——
    await addProviderAndReload(window, {
      name: '演示模型（走查）',
      baseUrl: 'http://127.0.0.1:9/v1',
      models: [{ id: 'demo-model', name: 'demo-model', capabilities: ['chat'] }],
    })
    await gotoRoute(window, '/chat')
    await window.waitForTimeout(800)

    // 有能力时才会出现建议 chips（空态动态生成契约）
    const chips = await window.locator('.nova-chip').count()
    expect(chips, '有可用模型时应出现建议 chips').toBeGreaterThanOrEqual(3)
    await window.screenshot({ path: `${DIR}/02-chat-empty-with-model.png` })

    // Ctrl+K 命令面板（全局快捷入口）
    await window.keyboard.press('Control+k')
    await expect(window.locator('.palette')).toBeVisible({ timeout: 8_000 })
    // 【走查修正】palette-fade 有 320ms 进入动画(opacity + scale + translateY),
    // 立刻截图会拍到半透明、偏位的中间帧,误判成"面板布局错乱"。等动画落定。
    await window.waitForTimeout(500)
    const paletteItems = await window.locator('.palette-item').count()
    expect(paletteItems, '命令面板有可执行项').toBeGreaterThan(0)
    await window.screenshot({ path: `${DIR}/03-command-palette.png` })
    await window.keyboard.press('Escape')
    await expect(window.locator('.palette')).toHaveCount(0)
    await window.waitForTimeout(300)

    // 新建会话（走 UI 的「新建」按钮）
    await createConversationViaUi(window)
    const convCount = await window.locator('.conversation-item').count()
    expect(convCount, '侧栏应出现新会话').toBeGreaterThan(0)
    await window.screenshot({ path: `${DIR}/04-chat-new-conversation.png` })

    // 输入文字 → 发送键可用（不点发送，避免依赖真实 LLM）
    const textarea = window.locator('.input-area textarea').first()
    await textarea.click()
    await textarea.fill('帮我整理一份本周工作周报')
    await window.waitForTimeout(300)
    await expect(window.locator('.send-btn').first()).toBeEnabled()
    await window.screenshot({ path: `${DIR}/05-chat-typing.png` })

    const hard = errors.filter((e) => HARD_ERROR_RE.test(e) && !IGNORE_RE.test(e))
    expect(hard, '首屏与对话主页不得有硬运行时错误').toEqual([])
  })

  /** U2 —— 主题切换真生效 + 浅色 / 深色双份截图，用于目视评估配色 */
  test('U2: 主题切换真实生效 —— 浅色 / 深色双态截图', async ({ window }) => {
    test.setTimeout(120_000)

    // 【走查修正】先配一个可用模型, 让建议 chips 在双主题下都渲染,
    // 否则浅色截图里没有 chips, 无法目视验证主题适配。
    await addProviderAndReload(window, {
      name: '演示模型（主题走查）',
      baseUrl: 'http://127.0.0.1:9/v1',
      models: [{ id: 'demo-model', name: 'demo-model', capabilities: ['chat'] }],
    })

    const light = await setThemeViaUi(window, 0)
    expect(light, '切浅色后 data-theme=light').toBe('light')
    await window.screenshot({ path: `${DIR}/06-settings-light.png` })

    await gotoRoute(window, '/chat')
    await window.waitForTimeout(600)
    await expect(window.locator('.nova-chip').first()).toBeVisible({ timeout: 8_000 })
    await window.screenshot({ path: `${DIR}/07-chat-light.png` })

    // 【视觉打磨复核】浅色主题下的 el-empty 空态插画(全局色阶覆盖后是否清晰)
    await gotoRoute(window, '/schedule')
    await window.waitForTimeout(500)
    await window.screenshot({ path: `${DIR}/07b-schedule-light.png` })

    const dark = await setThemeViaUi(window, 1)
    expect(dark, '切深色后 data-theme=dark').toBe('dark')
    await window.screenshot({ path: `${DIR}/08-settings-dark.png` })

    await gotoRoute(window, '/chat')
    await window.waitForTimeout(600)
    await window.screenshot({ path: `${DIR}/09-chat-dark.png` })
  })

  /** U3 —— 12 个生产页面逐页走查：截图 + 量化健康报告 */
  test('U3: 逐页走查 12 个生产页面 —— 截图 + 量化报告', async ({ window }) => {
    test.setTimeout(240_000)
    const errors = attachErrorCollector(window)

    // 统一在深色主题下评估（真实 UI 路径切换，不用 DOM 注入）
    await setThemeViaUi(window, 1)

    const stats: PageStat[] = []
    for (let i = 0; i < ROUTES.length; i++) {
      const { path, slug } = ROUTES[i]
      errors.length = 0
      await gotoRoute(window, path)
      await window.waitForTimeout(450)

      const metrics = await window.evaluate(() => {
        const root = document.documentElement
        const app = document.querySelector('#app') as HTMLElement | null
        return {
          title: document.title,
          textLen: (app?.innerText ?? '').length,
          overflowXPx: root.scrollWidth - root.clientWidth,
          buttons: document.querySelectorAll('button').length,
          inputs: document.querySelectorAll('input, textarea, select').length,
          cards: document.querySelectorAll(
            '.el-card, [class*="-card"], [class*="card-"]',
          ).length,
        }
      })

      const shot = `${DIR}/${String(i + 10).padStart(2, '0')}-page-${slug}.png`
      await window.screenshot({ path: shot })

      stats.push({
        route: path,
        slug,
        ...metrics,
        consoleErrors: errors.filter((e) => !IGNORE_RE.test(e)),
        screenshot: shot,
      })
    }

    writeFileSync(
      REPORT,
      JSON.stringify(
        {
          generatedAt: new Date().toISOString(),
          theme: 'dark',
          pageCount: stats.length,
          pages: stats,
        },
        null,
        2,
      ),
      'utf-8',
    )

    // 针对性锤实：搜索页 idle 空态必须真的渲染出引导，而不是一片空白
    const searchStat = stats.find((s) => s.route === '/search')
    expect(searchStat, '报告应包含 /search').toBeTruthy()
    if (searchStat) {
      expect(searchStat.textLen, '/search idle 空态应有引导文案').toBeGreaterThan(80)
    }

    // 硬门禁：不白屏、有可交互控件、不横向溢出、无硬运行时错误。
    // 阈值取 20 而非 25：极简页面的短标题也算「已渲染」，白屏的判据是
    // 「无文本 且 无控件」，不能只靠字符数（/search 曾因此误报）。
    for (const s of stats) {
      expect(s.textLen, `${s.route} 不得白屏`).toBeGreaterThan(20)
      expect(s.buttons + s.inputs, `${s.route} 应有可交互控件`).toBeGreaterThan(0)
      expect(s.overflowXPx, `${s.route} 不得横向溢出`).toBeLessThanOrEqual(2)
      const hard = s.consoleErrors.filter((e) => HARD_ERROR_RE.test(e))
      expect(hard, `${s.route} 不得有硬运行时错误`).toEqual([])
    }
  })

  /** U4 —— 设置页六个 tab 逐个走查 + 数据备份真功能闭环 */
  /** U4 —— 设置页六个 tab 逐个走查 + 数据备份真功能闭环 */
  test('U4: 设置页六个 tab + 本地备份真创建', async ({ window }) => {
    test.setTimeout(120_000)
    await gotoRoute(window, '/settings')
    await window.locator('.radio-group .radio').nth(1).click() // 深色
    await window.waitForTimeout(500)

    const tabs = ['basic', 'models', 'mcp', 'memory', 'data', 'about'] as const
    for (const key of tabs) {
      await window.locator(`#settings-tab-${key}`).click()
      await window.waitForTimeout(450)
      await expect(
        window.locator(`#settings-panel-${key}`),
        `设置 tab ${key} 面板可见`,
      ).toBeVisible({ timeout: 8_000 })
      const panelText = await window
        .locator(`#settings-panel-${key}`)
        .innerText()
        .catch(() => '')
      expect(panelText.length, `设置 tab ${key} 内容非空`).toBeGreaterThan(20)
      await window.screenshot({ path: `${DIR}/30-settings-tab-${key}.png` })
    }

    // 数据备份：真点「创建备份」→ 列表出现一行（验证主进程闭环可用）
    await window.locator('#settings-tab-data').click()
    await window.waitForTimeout(400)
    const createBtn = window.locator('.backup-actions .el-button').first()
    await expect(createBtn, '创建备份按钮可见').toBeVisible({ timeout: 8_000 })
    await createBtn.click()
    await window.waitForTimeout(2000)
    const rows = await window.locator('[data-testid^="backup-row-"]').count()
    expect(rows, '创建备份后列表应出现备份行').toBeGreaterThan(0)
    await window.screenshot({ path: `${DIR}/36-backup-created.png` })
  })

  /**
   * U5 —— 开发者性能浮标默认隐身（视觉打磨回归）
   * 之前 .dev-panel 常驻右下角、折叠态是红色 bad 点, 正式界面看起来像"程序报错"。
   * 现改为 Ctrl+Shift+D 唤醒; DOM 仍常驻, 既有 DevPanel e2e 断言不受影响。
   */
  test('U5: 右下角开发者浮标默认隐身、快捷键可唤醒', async ({ window }) => {
    await gotoRoute(window, '/settings')
    await window.waitForTimeout(600)

    const devPanel = window.locator('.dev-panel')
    await expect(devPanel, 'DevPanel DOM 仍常驻').toHaveCount(1)
    const visible = await devPanel.evaluate((el) => {
      const s = getComputedStyle(el)
      return s.visibility !== 'hidden' && Number(s.opacity) > 0.01
    })
    expect(visible, '正式界面右下角不应看到开发者红点浮标').toBe(false)

    // 快捷键唤醒 → 面板可见
    await window.keyboard.press('Control+Shift+d')
    await expect(
      window.locator('.dev-panel .dev-body'),
      'Ctrl+Shift+D 应展开 DevPanel',
    ).toBeVisible({ timeout: 8_000 })

    // 再按收起 → 重新隐身
    await window.keyboard.press('Control+Shift+d')
    await expect(window.locator('.dev-panel .dev-body')).toHaveCount(0)
    const visibleAfter = await devPanel.evaluate((el) => {
      const s = getComputedStyle(el)
      return s.visibility !== 'hidden' && Number(s.opacity) > 0.01
    })
    expect(visibleAfter, '收起后浮标应重新隐身').toBe(false)
  })

  /**
   * U6 —— 四层信息架构重组后的视觉回归（v4.7）
   * rail 只剩 3 个工作对象 + 底部设置;输入能力下沉到 ChatInput,
   * 配置页收进 Settings 配置中心,「更多」面板只留 3 个浏览项。
   * 深浅主题各截图,供目视确认分组、间距、文字对比度是否合理。
   */
  test('U6: 四层导航与「更多」面板 —— 深浅主题截图', async ({ window }) => {
    const trigger = window.locator('[data-testid="nav-more-trigger"]')
    const panel = window.locator('[data-testid="nav-more-panel"]')

    // 深色：rail 收起态
    await setThemeViaUi(window, 1)
    await gotoRoute(window, '/chat')
    await window.waitForTimeout(500)
    await expect(trigger).toBeVisible()
    await expect(window.locator('nav.sidenav a.nav-icon')).toHaveCount(4)
    await window.screenshot({ path: `${DIR}/37-sidenav-rail-dark.png` })

    // ChatInput 输入能力工具条（搜索 / 语音）
    await expect(window.locator('.input-tool-btn[data-path="/search"]')).toBeVisible()
    await expect(window.locator('.input-tool-btn[data-path="/voice"]')).toBeVisible()
    await window.screenshot({ path: `${DIR}/40-chat-input-tools-dark.png` })

    // 「更多」面板：现在只有 3 个同质浏览项
    await trigger.click()
    await expect(panel).toBeVisible({ timeout: 8_000 })
    await window.waitForTimeout(400) // 等 more-pop 过渡稳定
    await window.screenshot({ path: `${DIR}/38-nav-more-dark.png` })

    await expect(panel.locator('a.nav-more-item')).toHaveCount(1)
    const metrics = await window.evaluate(() => {
      const el = document.querySelector('[data-testid="nav-more-panel"]') as HTMLElement | null
      if (!el) return null
      return {
        overflowX: el.scrollWidth - el.clientWidth,
        overflowY: el.scrollHeight - el.clientHeight,
        bottom: el.getBoundingClientRect().bottom,
        viewportH: window.innerHeight,
      }
    })
    expect(metrics, '更多面板应存在').not.toBeNull()
    if (metrics) {
      expect(metrics.overflowX, '更多面板不得横向溢出').toBeLessThanOrEqual(2)
      expect(metrics.overflowY, '入口应一屏可见,不该需要滚动').toBeLessThanOrEqual(2)
      expect(metrics.bottom, '面板不得超出窗口底部').toBeLessThanOrEqual(metrics.viewportH - 4)
    }
    const labels = await panel.locator('.nav-more-item-title').allTextContents()
    expect(labels.filter((s) => s.trim()).length, '入口都应有可读名称').toBe(1)

    // Settings 配置中心：4 个独立入口（模型管理是内建 tab，不重复列出）
    await window.keyboard.press('Escape')
    await expect(panel).toHaveCount(0)
    await gotoRoute(window, '/settings')
    await window.waitForTimeout(400)
    const configNav = window.locator('[data-testid="settings-config-nav"]')
    await expect(configNav).toBeVisible({ timeout: 8_000 })
    await expect(configNav.locator('a.settings-link')).toHaveCount(4)
    await window.screenshot({ path: `${DIR}/41-settings-config-nav-dark.png` })

    // 浅色：「更多」面板再截一张
    await setThemeViaUi(window, 0)
    await gotoRoute(window, '/chat')
    await window.waitForTimeout(500)
    await trigger.click()
    await expect(panel).toBeVisible({ timeout: 8_000 })
    await window.waitForTimeout(400)
    await window.screenshot({ path: `${DIR}/39-nav-more-light.png` })
  })
})
