import { test, expect, shouldRunElectronE2E } from './helpers/electron-app'
import { addProviderAndReload, createConversationViaUi } from './helpers/electron-app'
import { spawn, type ChildProcess } from 'node:child_process'
import path from 'node:path'

/**
 * T+150: 长对话历史 + 滚动
 *
 * 真实场景:用户发多条消息,验证:
 * - 所有消息都在 history 里
 * - 滚动不卡顿
 * - 切回早期消息仍能看到
 * - 工具栏/输入框不消失
 *
 * 【这份 spec 原来靠"跨测试共享 userData,会有历史"拿到长对话】
 * —— 那正是 M4-K 修掉的**脏 profile 依赖**(userData 隔离从来没生效过,
 * 侧栏一度累积到 192 个会话)。隔离修好后历史不再凭空出现,
 * 依赖它的用例就全红了。
 *
 * 现:spec **自己造历史** —— 起仓库自带的 mock LLM(瞬时返回)、
 * 注入 provider、建会话、发 N 条消息。这样它测的才是"长对话"本身,
 * 且不依赖任何别的 spec 留下的残留。
 */

const MOCK_PORT = 9972
const MOCK_PROVIDER = 'Mock LLM (T+150)'

test.describe('T+150 Chat 长对话历史', () => {
  test.skip(!shouldRunElectronE2E, 'requires E2E_ELECTRON=1')

  let mock: ChildProcess | null = null

  test.beforeAll(async () => {
    const repoRoot = path.resolve(__dirname, '..', '..')
    mock = spawn(process.execPath, [path.join(repoRoot, 'scripts', 'mock-llm-server.mjs'), String(MOCK_PORT)], {
      cwd: repoRoot,
      stdio: 'ignore',
    })
    for (let i = 0; i < 30; i++) {
      try {
        const r = await fetch(`http://127.0.0.1:${MOCK_PORT}/health`)
        if (r.ok) return
      } catch { /* 还没起来 */ }
      await new Promise((r) => setTimeout(r, 200))
    }
    throw new Error(`mock LLM server 未能在 ${MOCK_PORT} 起来`)
  })

  test.afterAll(() => {
    mock?.kill()
  })

  /** 造一条有 N 轮对话的会话(自给自足,不依赖别的 spec) */
  async function seedConversation(window: any, rounds: number): Promise<void> {
    await addProviderAndReload(window, {
      name: MOCK_PROVIDER,
      baseUrl: `http://127.0.0.1:${MOCK_PORT}/v1`,
      models: [{ id: 'mock-model', name: 'mock-model', capabilities: ['chat'] }],
    })
    await window.click('nav.sidenav a.nav-icon[href$="#/chat"]').catch(() => {})
    await window.waitForTimeout(800)
    await createConversationViaUi(window)

    const conversationId = await window.evaluate(async () => {
      const api = (window as any).electronAPI
      const list = await api.chat.conversations()
      const arr = (list?.data || []).slice().sort((a: any, b: any) =>
        (b.updatedAt ?? b.createdAt ?? 0) - (a.updatedAt ?? a.createdAt ?? 0))
      return arr[0]?.id ?? null
    })
    if (!conversationId) throw new Error('造历史时拿不到会话 id')

    await window.evaluate(async ({ convId, n }: { convId: string; n: number }) => {
      const api = (window as any).electronAPI
      for (let i = 0; i < n; i++) {
        await api.chat.sendMessage(convId, `第 ${i + 1} 轮消息`, undefined, 'mock-model')
      }
    }, { convId: conversationId, n: rounds })

    await window.waitForTimeout(1500)
  }

  test('L1: 进 Chat 后选已存在会话(有历史)', async ({ window }) => {
    await seedConversation(window, 12)

    // 选第一个现有会话。
    // 【M4-M】**已经是 active 就不再点** —— 造的会话本身就是当前会话,
    // 而列表会随会话更新重排(updatedAt 变化 → 重排序 → 项在鼠标下移动),
    // 这时去点它就可能点到别的元素上(实测全量跑时 flake 过一次:
    // "locator.click: <div> intercepts pointer events")。
    const existingConv = window.locator('.conversation-item').first()
    await expect(existingConv).toHaveCount(1)
    const textarea = window.locator('.input-area textarea').first()
    if (!(await textarea.isVisible().catch(() => false))) {
      await existingConv.click()
      await window.waitForTimeout(1000)
    }
    await expect(textarea).toBeVisible({ timeout: 15_000 })
  })

  test('L2: 长对话 messages 容器可滚动', async ({ window }) => {
    await seedConversation(window, 20)

    const existingConv = window.locator('.conversation-item').first()
    if (!(await window.locator('.input-area textarea').first().isVisible().catch(() => false))) {
      await existingConv.click()
      await window.waitForTimeout(1000)
    }

    // 找 messages 容器,验证有 scroll 能力
    const messagesContainer = window.locator('.messages-container, .message-list, [class*="message"]').first()
    expect(await messagesContainer.count()).toBeGreaterThan(0)
    const exists = await messagesContainer.evaluate((el: any) => {
      // 找最近的 overflow:auto 父元素
      let cur: HTMLElement | null = el
      while (cur) {
        const style = getComputedStyle(cur)
        if (style.overflowY === 'auto' || style.overflowY === 'scroll') return true
        cur = cur.parentElement
      }
      return false
    })
    expect(exists).toBe(true)
  })

  test('L3: 多个 message 元素同时存在(历史可见)', async ({ window }) => {
    await seedConversation(window, 12)

    const existingConv = window.locator('.conversation-item').first()
    await existingConv.click()
    await window.waitForTimeout(1200)

    const messages = window.locator('.message-outer')
    const count = await messages.count()
    expect(count).toBeGreaterThan(0)
  })

  test('L4: 输入框始终可见(滚到底部)', async ({ window }) => {
    await seedConversation(window, 12)

    const existingConv = window.locator('.conversation-item').first()
    if (!(await window.locator('.input-area textarea').first().isVisible().catch(() => false))) {
      await existingConv.click()
      await window.waitForTimeout(1000)
    }

    // 滚到顶部
    await window.evaluate(() => {
      const m = document.querySelector('.messages-container') as HTMLElement
      if (m) m.scrollTop = 0
    })
    await window.waitForTimeout(500)

    // textarea 应该仍然可见(可能用 sticky / fixed)
    const textarea = window.locator('.input-area textarea').first()
    await expect(textarea).toBeVisible()
  })

  test('L5: 会话列表显示已选中的高亮', async ({ window }) => {
    await seedConversation(window, 6)

    const existingConv = window.locator('.conversation-item').first()
    await existingConv.click()
    await window.waitForTimeout(800)

    // 至少有一个 active 会话
    const activeCount = await window.locator('.conversation-item.active, .conversation-item.is-active, .conversation-item.selected').count()
    expect(activeCount).toBeGreaterThanOrEqual(1)
  })
})
