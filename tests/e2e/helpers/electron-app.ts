import { test as base, _electron as electron, type ElectronApplication, type Page } from '@playwright/test'
import path from 'node:path'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

/**
 * 【v4.8 起为空兼容】首次启动引导已按用户决策整体移除（FirstLaunchGuide.vue
 * 不再挂载）。保留此导出,让既有 spec 的调用点无需改动；现在直接返回 false。
 *
 * 历史：这里曾负责走完 4 步 el-dialog + 隐藏遮挡「新建」按钮的欢迎 toast。
 * 引导移除后,首屏直接进入 /chat,不会再有遮罩或 toast。若未来捡回来,把下面
 * 的兼容实现换成真实走引导逻辑即可。
 *
 * @returns 恒为 false（引导不存在）
 */
export async function completeFirstLaunchGuide(_window: Page): Promise<boolean> {
  return false
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
 * 侧栏导航 —— v4.4 起侧栏是 **icon-only rail**:`nav.sidenav > a.nav-icon`。
 *
 * v4.7 四层信息架构:
 *   · rail    → 3 个工作对象 + 底部设置(`a.nav-icon`,选择器不变)
 *   · 更多    → 3 个内容浏览项(`a.nav-more-item`)
 *   · 设置页  → 4 个配置入口(`a.settings-link`) + 内嵌模型 tab
 *   · 输入区  → 语音能力(`.input-tool-btn`)；联网搜索已改为「给模型用的开关」
 * 本 helper 按真实用户路径依次尝试 rail → 输入区 → 更多 → 设置页配置中心,
 * 这样既有 spec 无需改动,新架构的可达性也由同一条路径验证。
 */
// v4.8：/search 的 ChatInput 按钮已从「跳转手动搜索页」改为「模型联网开关」，
// 点它不会改 hash。不能再把它当跳转型输入工具，否则 gotoBySideNav 会等 URL 超时。
const INPUT_TOOL_PATHS = ['/voice']
/** 独立路由页：入口在设置页内建 tab、命令面板或直达 hash，导航里不重复列出 */
const DIRECT_ROUTE_PATHS = ['/models', '/search']

export async function gotoBySideNav(window: Page, path: string): Promise<void> {
  const direct = window.locator(`nav.sidenav a.nav-icon[href$="#${path}"]`).first()
  if (await direct.count() > 0) {
    await direct.waitFor({ state: 'visible', timeout: 15_000 })
    await direct.click()
  } else if (INPUT_TOOL_PATHS.includes(path)) {
    // 输入能力在 ChatInput 工具条,既不在 rail 也不在更多/设置页
    await gotoViaInputTool(window, path)
  } else if (DIRECT_ROUTE_PATHS.includes(path)) {
    // /models 独立页：配置中心已去重（模型管理是设置页内建 tab），走直达路由
    await gotoRoute(window, path)
  } else if (!(await tryGotoByMore(window, path))) {
    await gotoViaSettings(window, path)
  }
  await window.waitForURL(new RegExp(`#${path.replace('/', '\\/')}`), { timeout: 10_000 })
}

/** 通过 ChatInput 工具条进入输入能力页面(v4.7 新增) */
export async function gotoViaInputTool(window: Page, path: string): Promise<void> {
  await gotoRoute(window, '/chat')
  const tool = window.locator(`.input-tool-btn[data-path="${path}"]`).first()
  await tool.waitFor({ state: 'visible', timeout: 10_000 })
  await tool.click()
}

/** 尝试从「更多」面板进入;面板里没有该路径就收起并返回 false */
async function tryGotoByMore(window: Page, path: string): Promise<boolean> {
  const trigger = window.locator('[data-testid="nav-more-trigger"]')
  await trigger.waitFor({ state: 'visible', timeout: 10_000 })
  const panel = window.locator('[data-testid="nav-more-panel"]')
  if (!(await panel.isVisible().catch(() => false))) {
    await trigger.click()
  }
  await panel.waitFor({ state: 'visible', timeout: 8_000 })
  const item = panel.locator(`a.nav-more-item[href$="#${path}"]`).first()
  if (await item.count() === 0) {
    await window.keyboard.press('Escape')
    await panel.waitFor({ state: 'hidden', timeout: 8_000 }).catch(() => {})
    return false
  }
  await item.waitFor({ state: 'visible', timeout: 8_000 })
  await item.click()
  // 点完应自动收起,不残留浮层遮住页面
  await panel.waitFor({ state: 'hidden', timeout: 8_000 }).catch(() => {})
  return true
}

/** 通过「更多」面板进入内容浏览页面(v4.6 新增,v4.7 收敛为 3 项) */
export async function gotoByMore(window: Page, path: string): Promise<void> {
  const ok = await tryGotoByMore(window, path)
  if (!ok) throw new Error(`「更多」面板里没有入口 ${path}`)
}

/** 通过设置页「配置中心」进入配置类页面(v4.7 新增) */
export async function gotoViaSettings(window: Page, path: string): Promise<void> {
  await gotoRoute(window, '/settings')
  const link = window.locator(`a.settings-link[href$="#${path}"]`).first()
  await link.waitFor({ state: 'visible', timeout: 10_000 })
  await link.click()
}

/**
 * 直接跳路由 —— 用于**侧栏没有入口**的页面(如 /clawhub 只在命令面板与
 * 「更多」面板里有入口)。比点不存在的导航项诚实。
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
 * 在输入卡的两个 pill 里选 provider + model。
 *
 * 【v4.6 修】旧实现找 `.model-selector .el-select` —— 那是**已删除的死 CSS**
 * (Chat.vue 里留了注释:「输入区已抽到 ChatInput.vue」),真实结构是
 * `.provider-pill` / `.model-pill` 两个 el-select。旧 helper 在
 * `providerSelect.click()` 上必等 30s 超时(实测 ER1/ER2 全挂)。
 * 现按真实 DOM 选,并用 :visible 过滤 Teleport 出来、可能同时存在的多个下拉。
 */
export async function selectProviderAndModel(
  window: Page,
  providerText: string,
  modelText: string,
): Promise<void> {
  const providerPill = window.locator('.provider-pill').first()
  await providerPill.waitFor({ state: 'visible', timeout: 15_000 })
  await providerPill.click()
  const providerOpt = window.locator(
    `.el-select-dropdown__item:visible:has-text("${providerText}")`,
  ).first()
  await providerOpt.waitFor({ state: 'visible', timeout: 10_000 })
  await providerOpt.click()

  // 【必须验证选中生效】选 provider 会先同步 lastProviderId 再 await 会话更新,
  // 期间就去点 model,setter 读到的可能是旧 provider → 发送时报
  // "no LLM provider configured"。故等 pill 真显示选中值再动 model。
  await window.waitForFunction(
    (text: string) =>
      (document.querySelector('.provider-pill')?.textContent ?? '').includes(text),
    providerText,
    { timeout: 15_000 },
  )

  const modelPill = window.locator('.model-pill').first()
  await modelPill.waitFor({ state: 'visible', timeout: 15_000 })
  await modelPill.click()
  const opt = window.locator(
    `.el-select-dropdown__item:visible:has-text("${modelText}")`,
  ).first()
  await opt.waitFor({ state: 'visible', timeout: 10_000 })
  await opt.click()
  await window.waitForFunction(
    (text: string) =>
      (document.querySelector('.model-pill')?.textContent ?? '').includes(text),
    modelText,
    { timeout: 15_000 },
  )
  await window.waitForTimeout(500)
}

const repoRoot = path.resolve(__dirname, '..', '..', '..')
const mainEntry = path.join(repoRoot, 'dist-electron', 'main.js')

export const shouldRunElectronE2E = !!process.env.E2E_ELECTRON

/**
 * 【M4-R 修】userData 改成**每个测试一个**目录。
 *
 * 【之前的问题】目录是**模块级**创建的:
 *   const sharedUserDataDir = mkdtempSync(...)
 * 而 Playwright 在同一个 worker 里**顺序跑多个 spec 文件**,
 * Node 的模块缓存让这个 helper **只被加载一次** → **所有 spec 文件共用同一个
 * userData** → 状态在文件之间泄漏。
 *
 * 实测踩到:`ui-smoke` 切到 English 后**没切回来** → 下一个 spec 文件启动时
 * 语言仍是英文 → 依赖中文文案的断言全红(而单跑那个 spec 是绿的)。
 * 同类泄漏还有:provider、会话、主题。
 *
 * 为什么之前没暴露:M4-K 修的是「别写开发者真实的 %APPDATA%」——
 * 那条成立且有效(隔开了真实 profile),但**没解决 spec 文件之间**的隔离。
 *
 * 【改成每个测试一个】应用本来就是**每个测试重启一次**(fixture 是函数作用域),
 * 顺带把 profile 也做成每个测试独立 → 零额外成本,状态彻底不串。
 */
function createUserDataDir(): string {
  return mkdtempSync(join(tmpdir(), 'newworld-e2e-'))
}

export const test = base.extend<{
  electronApp: ElectronApplication
  window: Page
  freshUserData: string
}>({
  // 每个测试一个独立的 userData 目录(见 createUserDataDir 上方说明)
  // —— 同时暴露给需要直接读 localStorage / 配置文件 的测试用
  freshUserData: async ({}, use) => {
    await use(createUserDataDir())
  },

  electronApp: async ({ freshUserData: userDataDir }, use) => {
    if (!shouldRunElectronE2E) {
      throw new Error(
        'E2E_ELECTRON is not set. Set E2E_ELECTRON=1 to run real Electron e2e.'
      )
    }

    const app = await electron.launch({
      // 【M4-K 实测发现】`--user-data-dir` 必须**显式**放进 args ——
      // Playwright 的 `_electron.launch()` **不支持** `userDataDir` 选项
      // (只有 `launchPersistentContext` 有),之前 fixture 传的那个字段被**静默忽略** →
      // 应用一直写真实的 %APPDATA%/newworld,于是:
      //   ① e2e 污染开发者的真实数据(P0-T0.4「每次测试用全新 userData」从未生效)
      //   ② 测试之间互相污染 —— 实测侧栏累积到 **192 个会话**,
      //      侧栏一次渲染 192 项 → DOM 持续重渲染 → Playwright 动作性检查超时 →
      //      「…」下拉菜单等交互点不动(实测 popper 数恒为 0)
      args: [mainEntry, '--no-sandbox', `--user-data-dir=${userDataDir}`],
      cwd: repoRoot,
      env: {
        // 【环境残留清除】宿主(WorkBuddy/CI)可能带 ELECTRON_RUN_AS_NODE=1,
        // 会让 electron.exe 按 Node 模式启动 → "bad option: --remote-debugging-port=0"。
        // 必须**删除**该键(置空字符串在部分 Electron 版本仍按存在处理)。
        ...(() => {
          const { ELECTRON_RUN_AS_NODE: _drop, ...rest } = process.env as Record<string, string | undefined>
          return rest
        })(),
        // 强制 WindowManager 走 prod 路径(loadFile dist/index.html),
        // 否则会去找 vite dev server (localhost:5173)
        NW_E2E: '1',
        // NOVA #003-C · M2(第③笔): 显式 splash 旁路(命令 §F6 硬条件)。
        //   BootOrchestrator 对 NW_E2E='1' 同样 bypass, 此处显式声明是
        //   双保险 + 自文档化: 防止未来重构拆开 E2E/SPLASH 耦合时 splash 劫持
        //   firstWindow()(34 个既有 e2e 全部会因首个窗口是 splash 而超时)。
        NW_SKIP_SPLASH: '1',
        ELECTRON_DISABLE_SECURITY_WARNINGS: '1',
      },
      timeout: 30_000,
    })

    await use(app)
    await app.close().catch(() => {})
    // 清理本测试的 profile(不留垃圾)。
    // 【护栏】只删「系统临时目录下 + 前缀 newworld-e2e-」的目录 ——
    // 万一将来有人把路径传错,这里不会误删别的东西。
    try {
      const resolved = path.resolve(userDataDir)
      const tmpRoot = path.resolve(tmpdir())
      const isTempProfile =
        resolved.startsWith(tmpRoot + path.sep) &&
        path.basename(resolved).startsWith('newworld-e2e-')
      if (isTempProfile) rmSync(resolved, { recursive: true, force: true })
    } catch { /* best-effort */ }
  },

  window: async ({ electronApp }, use) => {
    const window = await electronApp.firstWindow()
    await window.waitForLoadState('domcontentloaded')
    // 等 Vue 应用挂载 (#app 节点出现 + 端到端 PINIA 初始化)
    await window.waitForSelector('#app', { timeout: 15_000 })
    // 默认跳到 /dashboard。给 router 一拍时间切到目标
    await window.waitForTimeout(500)
    // v4.8：首次引导已移除，保留兼容调用（恒 false，不再遮界面）
    await completeFirstLaunchGuide(window)
    await use(window)
  },
})

export { expect } from '@playwright/test'
