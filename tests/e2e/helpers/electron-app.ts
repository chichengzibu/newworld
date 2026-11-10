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
 * - P0-T0.4: 默认 fresh=true,每次测试用全新 userData 目录,
 *   避免 localStorage / ConfigStore 跨测试污染
 *
 * 跳过策略:
 * - E2E_ELECTRON=1 才跑(默认 CI 不跑,本地手动跑)
 * - 必须先 build:`npm run build` 生成 dist-electron/main.js
 */

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
