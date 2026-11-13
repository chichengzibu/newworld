/**
 * PiPiClaw — 命令面板测试（M4-N）
 * ═══════════════════════════════════════════════════════════════════════
 * 【为什么补这个文件】
 * 命令面板是应用的「找不到功能就按 Ctrl+K」兜底，也是熟练用户的快路径 ——
 * 但它此前**零测试**，于是三个真 bug 一起待在那儿：
 *
 * ① **过滤漏**：`scoreItem` 的优先级加权(最近/模板 +0.5/+0.3)在**零匹配**时也加
 *    → 任何查询下,所有 prompt 模板都"匹配成功" → 搜索根本不起作用
 *    (实测:输「切换主题」仍列出 5 个模板)
 * ② **动作抛错 → 面板关不掉**：`await item.action()` 抛出(典型:`router.push`
 *    到当前路由 → vue-router 抛 NavigationDuplicated)→ `close()` 被跳过
 * ③ **查询变化后选中态不重置**：旧索引越界 → 高亮消失 + **Enter 什么都不发生**
 *
 * 【本测试不联网】router 与 store 都是本地假实现。
 *
 * 【注意】面板在 `el-dialog` 里 → **teleport 到 body** → 不在 wrapper 的
 * DOM 子树内 → 一律用 `document.querySelector` 取,不能用 `wrapper.find`。
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { mount, flushPromises } from '@vue/test-utils'

const routerPush = vi.fn(() => Promise.resolve())

vi.mock('vue-router', () => ({
  useRouter: () => ({ push: routerPush }),
  useRoute: () => ({ path: '/chat', query: {} }),
}))

vi.mock('@element-plus/icons-vue', () => ({
  Search: { template: '<i />' },
  Box: { template: '<i />' }, Connection: { template: '<i />' }, Document: { template: '<i />' },
  Warning: { template: '<i />' }, MagicStick: { template: '<i />' }, ChatDotRound: { template: '<i />' },
  Setting: { template: '<i />' }, Goods: { template: '<i />' }, Promotion: { template: '<i />' },
  Plus: { template: '<i />' }, Upload: { template: '<i />' },
}))

const appState = {
  themeMode: 'light' as 'light' | 'dark',
  // 面板读的是 `currentTheme`,写的是 `toggleTheme()` —— 替身要对齐这两个口
  get currentTheme() { return appState.themeMode },
  setTheme: vi.fn((m: 'light' | 'dark') => { appState.themeMode = m }),
  toggleTheme: vi.fn(() => { appState.setTheme(appState.themeMode === 'dark' ? 'light' : 'dark') }),
}

vi.mock('@/stores/app', () => ({
  useAppStore: () => appState,
}))

import CommandPalette from '../../src/components/common/CommandPalette.vue'

/** 面板是否可见(teleport 到 body → 用几何判断) */
function paletteVisible(): boolean {
  const el = document.querySelector('.palette') as HTMLElement | null
  if (!el) return false
  const r = el.getBoundingClientRect()
  return r.width > 0 && r.height > 0
}

function itemTexts(): string[] {
  return Array.from(document.querySelectorAll('.palette-item'))
    .map((e) => (e.textContent ?? '').split('\n')[0].trim())
}

async function mountPalette() {
  const ElementPlus = (await import('element-plus')).default
  const w = mount(CommandPalette, {
    attachTo: document.body,
    global: {
      plugins: [ElementPlus],
      mocks: { $route: { path: '/chat' }, $router: { push: routerPush } },
    },
  })
  await flushPromises()
  window.dispatchEvent(new CustomEvent('cmd:open-palette'))
  await flushPromises()
  await flushPromises()
  return w
}

/** 设置查询词(直接操作 DOM + 派发 input 事件,走 v-model) */
async function setQuery(text: string): Promise<void> {
  const el = document.querySelector('input.palette-input') as HTMLInputElement | null
  expect(el, '命令面板的输入框没渲染').not.toBeNull()
  el!.value = text
  el!.dispatchEvent(new Event('input', { bubbles: true }))
  await flushPromises()
}

async function pressEnter(): Promise<void> {
  const el = document.querySelector('input.palette-input') as HTMLInputElement | null
  el!.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }))
  await flushPromises()
  await flushPromises()
}

describe('M4-N 命令面板 · 过滤', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    appState.themeMode = 'light'
    document.body.innerHTML = ''
  })

  it('输入不匹配的词 → 结果为空(过滤真的在过滤)', async () => {
    const w = await mountPalette()
    await setQuery('绝对不存在的命令zzz')
    expect(document.querySelectorAll('.palette-item').length).toBe(0)
    w.unmount()
  })

  it('【回归】输入「切换主题」→ 只剩主题动作,prompt 模板不再混入', async () => {
    const w = await mountPalette()
    await setQuery('切换主题')
    const texts = itemTexts()
    expect(texts.length, `过滤后仍有 ${texts.length} 项:${texts.join(',')}`).toBe(1)
    expect(texts[0]).toContain('主题')
    w.unmount()
  })
})

describe('M4-N 命令面板 · 选中态', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    appState.themeMode = 'light'
    document.body.innerHTML = ''
  })

  it('【回归】查询变化后第一项被高亮(选中态跟着重置,不越界)', async () => {
    const w = await mountPalette()
    await setQuery('切换主题')
    const active = document.querySelectorAll('.palette-item.active')
    expect(active.length, '过滤后没有任何高亮项 —— Enter 会变成"什么都没发生"').toBe(1)
    w.unmount()
  })
})

describe('M4-N 命令面板 · Enter 提交', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    appState.themeMode = 'light'
    document.body.innerHTML = ''
  })

  it('【回归】Enter 执行最佳匹配项(而不是别的项)并关闭面板', async () => {
    const w = await mountPalette()
    await setQuery('切换主题')
    await pressEnter()
    // 主题被切换了 → 执行的是"切换主题"这一项,不是第一个 prompt 模板
    expect(appState.themeMode, 'Enter 没有执行「切换主题」').toBe('dark')
    expect(paletteVisible(), '面板没关闭').toBe(false)
    w.unmount()
  })

  it('【回归】动作抛错时面板仍要关闭(不能把用户困在面板里)', async () => {
    const w = await mountPalette()
    // 让 router.push 抛错(模拟 NavigationDuplicated)
    routerPush.mockImplementation(() => Promise.reject(new Error('NavigationDuplicated')) as never)
    await setQuery('翻译')
    await pressEnter()
    expect(paletteVisible(), '动作失败后面板没关 —— 用户只能按 Esc').toBe(false)
    routerPush.mockImplementation(() => Promise.resolve())
    w.unmount()
  })
})
