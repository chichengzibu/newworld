import { test as base, _electron as electron, type ElectronApplication, type Page } from '@playwright/test'
import path from 'node:path'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

/**
 * 走完首次启动引导（4 步 el-dialog）。
 *
 * 【为什么必须走】首次启动引导是 `close-on-click-modal=false` +
 * `close-on-press-escape=false` + `show-close=false` —— **没有任何快捷关闭方式**,
 * 只能一步步走完。用户不点完,整个界面(侧栏/标题栏/输入区)都被遮罩挡住,
 * 任何点击都会超时。
 *
 * 【为什么现在才遇到】userData 隔离修好之前(e2e 一直写真实 %APPDATA%),
 * 引导早就被手动关过了 —— 于是"新用户第一次打开"这条路径**从未被测过**。
 *
 * @returns 是否真的走过引导(false = 没出现,已跳过)
 */
export async function completeFirstLaunchGuide(window: Page): Promise<boolean> {
  const guide = window.locator('.first-launch-guide')
  const visible = await guide.isVisible().catch(() => false)
  if (!visible) return false

  // 步骤 0(欢迎) → 下一步
  const nextBtn = window.getByRole('button', { name: /下一步/ })
  if (await nextBtn.count()) await nextBtn.first().click().catch(() => {})
  await window.waitForTimeout(400)

  // 步骤 1(选模型) → 先选一张卡片,「下一步」才会出现
  const modelCard = window.locator('.model-option')
  if (await modelCard.count()) await modelCard.first().click().catch(() => {})
  await window.waitForTimeout(400)
  if (await nextBtn.count()) await nextBtn.first().click().catch(() => {})
  await window.waitForTimeout(400)

  // 步骤 2(权限) → 完成配置
  const finishCfg = window.getByRole('button', { name: /完成配置/ })
  if (await finishCfg.count()) await finishCfg.first().click().catch(() => {})
  await window.waitForTimeout(400)

  // 步骤 3(完成) → 开始使用
  const start = window.getByRole('button', { name: /开始使用/ })
  if (await start.count()) await start.first().click().catch(() => {})
  await window.waitForTimeout(600)

  // 【关键】引导结束后会弹一个「欢迎使用 PiPiClaw!」的 toast,
  // 它**正好盖在侧栏「新建」按钮上**(实测截图)→ 之后的点击被 toast 吃掉,
  // 表现为"点了新建但会话没建出来",且**随机**(取决于 toast 是否还在)。
  // 故:等 toast 消失再放行。
  await window.locator('.el-message').first()
    .waitFor({ state: 'detached', timeout: 10_000 })
    .catch(() => {})
  await window.waitForTimeout(200)
  return true
}

/**
 * 共享 Electron Fixture
 *
 * 用法:
 *   import { test, expect } from './helpers/electron-app'
 *
 *   test('my scenario', async ({ electronApp, window }) => {
 *     await window.click('text=对话')
 *     ...
 *   })
 *
 * 默认行为:
 * - 启动 dist-electron/main.js(vite-plugin-electron 产物)
 * - 工作目录为仓库根(相对 __dirname 解析)
 * - 启动时加 --no-sandbox,Windows / Linux CI 容器需要
 * - 超时 30s(electron 冷启动 5-15s,首窗加载再加 3-5s)
 * - userData 走临时目录(见下方 `--user-data-dir` 说明),跨 spec 隔离
 *
 * 跳过策略:
 * - E2E_ELECTRON=1 才跑(默认 CI 不跑,本地手动跑)
 * - 必须先 build:`npm run build` 生成 dist-electron/main.js
 */

/**
 * 侧栏导航 —— v4.4 改版后侧栏是 **icon-only rail**:
 *   `nav.sidenav > a.nav-icon`(不再是旧版的 `a.nav-item` 文本列表)
 * 统一走这个 helper,免得每个 spec 各写一份选择器、各错一次。
 */
export async function gotoBySideNav(window: Page, path: string): Promise<void> {
  const link = window.locator(`nav.sidenav a.nav-icon[href$="#${path}"]`).first()
  await link.waitFor({ state: 'visible', timeout: 15_000 })
  await link.click()
  await window.waitForURL(new RegExp(`#${path.replace('/', '\\/')}`), { timeout: 10_000 })
}

/**
 * 直接跳路由 —— 用于**侧栏没有入口**的页面(如 /clawhub 只在命令面板与
 * ModelCompare 里有入口)。比点不存在的导航项诚实。
 */
export async function gotoRoute(window: Page, path: string): Promise<void> {
  await window.evaluate((p: string) => { window.location.hash = p }, path)
  await window.waitForURL(new RegExp(`#${path.replace('/', '\\/')}`), { timeout: 10_000 })
  await window.waitForTimeout(600)
}

/**
 * 注入 provider 并让渲染层拿到它。
 *
 * 【为什么必须 reload】
 * `Chat.vue` 只在 `onMounted` 调 `modelsStore.fetchProviders()`。
 * 通过 IPC 加的 provider **不会**推给渲染层 → 模型选择器里没有可选项 →
 * `el-select` 一直是 disabled → 点击等到超时(实测整个用例 60s 超时,
 * 报错却是 "browser has been closed" —— 那是超时被中断的后果,不是根因)。
 * 真实用户路径不受影响(他在 Settings 页加,同一个 store 会刷新)。
 * 故:e2e 里加完 provider **必须刷新页面**让 store 重新拉。
 */
export async function addProviderAndReload(window: Page, provider: {
  name: string
  type?: string
  baseUrl: string
  apiKey?: string
  timeout?: number
  models?: Array<{ id: string; name: string; capabilities?: string[] }>
}): Promise<string> {
  const id = await window.evaluate(async (p) => {
    const api = (window as any).electronAPI
    const list = await api.models.list()
    for (const old of list?.data || []) {
      if (old.name === p.name) await api.models.delete(old.id)
    }
    const r = await api.models.add({
      name: p.name,
      type: p.type || 'openai',
      baseUrl: p.baseUrl,
      apiKey: p.apiKey || 'no-key',
      enabled: true,
      timeout: p.timeout ?? 10_000,
      models: p.models ?? [{ id: 'fake-model', name: 'fake-model', capabilities: ['chat'] }],
    })
    return r?.data?.id ?? null
  }, provider)
  if (!id) throw new Error(`注入 provider 失败:${provider.name}`)
  // 让渲染层重新拉 provider 列表
  await window.reload({ waitUntil: 'domcontentloaded' })
  await window.waitForSelector('#app', { timeout: 15_000 })
  await window.waitForTimeout(800)
  return id
}

/**
 * 建一个会话(走 UI 的「新建」按钮 —— 与真实用户同一条路径)。
 *
 * 【为什么不用 IPC 建】
 * 通过 IPC `chat.createConversation` 建的会话**侧栏不刷新**
 * (store 只在挂载时拉一次 + 响应自己的 action)→ 侧栏看不到新会话。
 */
export async function createConversationViaUi(window: Page): Promise<void> {
  const btn = window.locator('button.new-chat-btn')
  await btn.waitFor({ state: 'visible', timeout: 15_000 })
  await btn.click()
  await window.waitForTimeout(1000)
}

/**
 * 在模型选择器里选 provider + model(两个 el-select,第一个是 provider)。
 */
export async function selectProviderAndModel(
  window: Page,
  providerText: string,
  modelText: string,
): Promise<void> {
  const providerSelect = window.locator('.model-selector .el-select').first()
  await providerSelect.click()
  await window.waitForTimeout(500)
  const providerOpt = window.locator(`.el-select-dropdown__item:has-text("${providerText}")`).first()
  await providerOpt.click()

  // 【必须验证选中生效,不能盲等】选 provider 会走 `setCurrentModel(provider, '')`,
  // 它先把 `lastProviderId` 同步设上、再 **await** 会话更新 —— 期间如果就去点 model,
  // model 的 setter 读到的 provider 可能还是旧的 → 会话里只记了 model 没记 provider
  // → 发送时报 "no LLM provider configured"(实测踩到)。
  // 故:等选择框真的显示出该 provider 的名字,再动 model。
  await window.waitForFunction(
    (text: string) => {
      const sels = document.querySelectorAll('.model-selector .el-select')
      return ((sels[0] as HTMLElement)?.textContent ?? '').includes(text)
    },
    providerText,
    { timeout: 15_000 },
  )

  const modelSelect = window.locator('.model-selector .el-select').nth(1)
  await modelSelect.waitFor({ state: 'visible', timeout: 15_000 })
  await modelSelect.click()
  await window.waitForTimeout(500)
  const opt = window.locator(`.el-select-dropdown__item:has-text("${modelText}")`).first()
  await opt.click()
  await window.waitForFunction(
    (text: string) => {
      const sels = document.querySelectorAll('.model-selector .el-select')
      return ((sels[1] as HTMLElement)?.textContent ?? '').includes(text)
    },
    modelText,
    { timeout: 15_000 },
  )
  await window.waitForTimeout(500)
}

const repoRoot = path.resolve(__dirname, '..', '..', '..')
const mainEntry = path.join(repoRoot, 'dist-electron', 'main.js')

export const shouldRunElectronE2E = !!process.env.E2E_ELECTRON

// 跨测试共享一个 fresh userData 目录(同一 spec 内复用,跨 spec 隔离)
const sharedUserDataDir = shouldRunElectronE2E
  ? mkdtempSync(join(tmpdir(), 'pipiclaw-e2e-'))
  : ''

export const test = base.extend<{
  electronApp: ElectronApplication
  window: Page
  freshUserData: string
}>({
  // 暴露当前 spec 的 userData 路径,供需要直接读 localStorage 的测试用
  freshUserData: async ({}, use) => {
    await use(sharedUserDataDir)
  },

  electronApp: async ({}, use) => {
    if (!shouldRunElectronE2E) {
      throw new Error(
        'E2E_ELECTRON is not set. Set E2E_ELECTRON=1 to run real Electron e2e.'
      )
    }

    const app = await electron.launch({
      // 【M4-K 实测发现】`--user-data-dir` 必须**显式**放进 args ——
      // Playwright 的 `_electron.launch()` **不支持** `userDataDir` 选项
      // (只有 `launchPersistentContext` 有),之前 fixture 传的那个字段被**静默忽略** →
      // 应用一直写真实的 %APPDATA%/pipiclaw,于是:
      //   ① e2e 污染开发者的真实数据(P0-T0.4「每次测试用全新 userData」从未生效)
      //   ② 测试之间互相污染 —— 实测侧栏累积到 **192 个会话**,
      //      侧栏一次渲染 192 项 → DOM 持续重渲染 → Playwright 动作性检查超时 →
      //      「…」下拉菜单等交互点不动(实测 popper 数恒为 0)
      args: [mainEntry, '--no-sandbox', `--user-data-dir=${sharedUserDataDir}`],
      cwd: repoRoot,
      env: {
        ...process.env,
        // 强制 WindowManager 走 prod 路径(loadFile dist/index.html),
        // 否则会去找 vite dev server (localhost:5173)
        PIPICLAW_E2E: '1',
        // NOVA #003-C · M2(第③笔): 显式 splash 旁路(命令 §F6 硬条件)。
        //   BootOrchestrator 对 PIPICLAW_E2E='1' 同样 bypass, 此处显式声明是
        //   双保险 + 自文档化: 防止未来重构拆开 E2E/SPLASH 耦合时 splash 劫持
        //   firstWindow()(34 个既有 e2e 全部会因首个窗口是 splash 而超时)。
        PIPICLAW_SKIP_SPLASH: '1',
        ELECTRON_DISABLE_SECURITY_WARNINGS: '1',
      },
      timeout: 30_000,
    })

    await use(app)
    await app.close().catch(() => {})
  },

  window: async ({ electronApp }, use) => {
    const window = await electronApp.firstWindow()
    await window.waitForLoadState('domcontentloaded')
    // 等 Vue 应用挂载 (#app 节点出现 + 端到端 PINIA 初始化)
    await window.waitForSelector('#app', { timeout: 15_000 })
    // 默认跳到 /dashboard。给 router 一拍时间切到目标
    await window.waitForTimeout(500)
    // fresh profile 下首次启动引导会遮住整个界面 → 先走完它
    await completeFirstLaunchGuide(window)
    await use(window)
  },
})

// 测试套件结束后清理临时目录
if (shouldRunElectronE2E) {
  process.on('exit', () => {
    try {
      rmSync(sharedUserDataDir, { recursive: true, force: true })
    } catch {
      // best-effort
    }
  })
}

export { expect } from '@playwright/test'
