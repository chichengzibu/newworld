import { test, expect, shouldRunElectronE2E } from './helpers/electron-app'
import { spawn, type ChildProcess } from 'node:child_process'
import path from 'node:path'

/**
 * VERIFICATION D5 —— 50+ 条消息 + 虚拟滚动
 * ═══════════════════════════════════════════════════════════════════════
 * 【这一条为什么单独一个 spec】
 * D5 是清单里最重的一项:要造 50+ 条消息,验「虚拟滚动生效」(长对话只渲染可视区)。
 * 用真模型跑 50 轮太慢 → 起仓库自带的 `scripts/mock-llm-server.mjs`
 * (OpenAI 协议,瞬时返回),消息条数不成为瓶颈。
 *
 * 【它同时钉住一个 P0 的回归】
 * 2026-11-09 修过一个 P0:`useVirtualizer` 返回的是 Ref,脚本里漏了 `.value`
 * → 打开任何**有消息的会话**就抛 `getVirtualItems is not a function`
 * → paintFatalError 盖全屏红框 → 聊天界面不可用(该缺陷自 2026-10-09 起
 * 一直带在 master 上,只因实跑只覆盖了首屏空状态而没被发现)。
 * 故本 spec 第一条断言就是「不出现红屏」。
 */
const MOCK_PORT = 9971
const MOCK_PROVIDER_NAME = 'Mock LLM (VERIFICATION D5)'

test.describe('VERIFICATION D5 · 50+ 条消息 + 虚拟滚动', () => {
  test.skip(!shouldRunElectronE2E, 'requires E2E_ELECTRON=1')

  let mock: ChildProcess | null = null

  test.beforeAll(async () => {
    // 起 mock LLM(仓库自带);失败则该 spec 直接失败 —— 不允许静默跳过
    const repoRoot = path.resolve(__dirname, '..', '..')
    mock = spawn(process.execPath, [path.join(repoRoot, 'scripts', 'mock-llm-server.mjs'), String(MOCK_PORT)], {
      cwd: repoRoot,
      stdio: 'ignore',
    })
    // 等它起来
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

  test('D5: 55 条消息 → 虚拟滚动只渲染可视区 + 滚动到底 + 无红屏', async ({ window }) => {
    await window.waitForTimeout(1200)

    // ── 1. 注入 mock provider ──
    const providerId = await window.evaluate(async ({ port, name }) => {
      const api = (window as any).electronAPI
      const list = await api.models.list()
      for (const p of list?.data || []) {
        if (p.name === name) await api.models.delete(p.id)
      }
      const r = await api.models.add({
        name,
        type: 'openai',
        baseUrl: `http://127.0.0.1:${port}/v1`,
        apiKey: 'mock',
        enabled: true,
        timeout: 10_000,
        models: [{ id: 'mock-model', name: 'mock-model', capabilities: ['chat'] }],
      })
      return r?.data?.id ?? null
    }, { port: MOCK_PORT, name: MOCK_PROVIDER_NAME })
    expect(providerId, '注入 mock provider 失败').not.toBeNull()

    // ── 2. 建一个会话(走 UI,store 才知道当前会话)──
    await window.locator('button.new-chat-btn').click({ force: true })
    await window.waitForTimeout(1000)

    const conversationId = await window.evaluate(async () => {
      const api = (window as any).electronAPI
      const list = await api.chat.conversations()
      const arr = (list?.data || []).slice().sort((a: any, b: any) =>
        (b.updatedAt ?? b.createdAt ?? 0) - (a.updatedAt ?? a.createdAt ?? 0))
      return arr[0]?.id ?? null
    })
    if (!conversationId) {
      const diag = await window.evaluate(async () => {
        const api = (window as any).electronAPI
        const list = await api.chat.conversations()
        return {
          items: document.querySelectorAll('.conversation-item').length,
          raw: JSON.stringify(list).slice(0, 300),
        }
      })
      throw new Error(`拿不到当前会话 id —— DOM 会话项=${diag.items} / API=${diag.raw}`)
    }
    expect(conversationId, '拿不到当前会话 id').not.toBeNull()

    // ── 3. 发 55 条(走 IPC —— mock 瞬时返回,不等 LLM)──
    const SENT = 55
    const sent = await window.evaluate(async ({ convId, provider, n }) => {
      const api = (window as any).electronAPI
      let ok = 0
      for (let i = 0; i < n; i++) {
        const r = await api.chat.sendMessage(convId, `第 ${i + 1} 条消息`, provider, 'mock-model')
        if (r?.success) ok++
      }
      return ok
    }, { convId: conversationId, provider: providerId, n: SENT })
    expect(sent, `消息发送失败(${sent}/${SENT})`).toBe(SENT)

    // ── 4. 等消息渲染出来 ──
    await window.waitForTimeout(2500)

    // 【P0 回归钉】不能出现红屏
    const bodyText = await window.evaluate(() => document.body.innerText)
    expect(bodyText, '出现了红屏兜底 —— Chat 视图崩了').not.toContain('[New World render error]')

    // 消息确实进了 store(用户消息 + 助手回复 = 110 条)
    const total = await window.evaluate(async ({ convId }) => {
      const api = (window as any).electronAPI
      const r = await api.chat.getConversation(convId)
      return (r?.data?.messages || []).length
    }, { convId: conversationId })
    expect(total, `消息条数不对:${total}`).toBeGreaterThanOrEqual(SENT)

    // ── 5. 虚拟滚动:DOM 里的行数应显著少于总消息数 ──
    const rendered = await window.locator('.message-outer').count()
    expect(rendered, '一条都没渲染').toBeGreaterThan(0)
    expect(rendered, `DOM 渲染了 ${rendered} 行(总消息 ${total})—— 虚拟滚动没生效`)
      .toBeLessThan(total)

    // ── 6. 容器可滚 ──
    const scroll = await window.locator('.messages-container').evaluate((el) => ({
      scrollHeight: el.scrollHeight,
      clientHeight: el.clientHeight,
    }))
    expect(scroll.scrollHeight, '消息容器没有内容高度').toBeGreaterThan(scroll.clientHeight)

    // ── 7. 能滚到底,且滚到底后出现更多行(说明确实按需渲染)──
    // 【为什么滚好几轮】虚拟列表的行高是**边滚边量**的:滚到底时新行才被测量,
    // 总高度随之变大 → 一次 scrollTop=scrollHeight 之后其实又"离底"了。
    // 真实用户也是这么滚的,故这里模拟同样的行为,而不是断言"一次就到底"。
    let atBottom = false
    for (let i = 0; i < 6 && !atBottom; i++) {
      await window.locator('.messages-container').evaluate((el) => { el.scrollTop = el.scrollHeight })
      await window.waitForTimeout(400)
      atBottom = await window.locator('.messages-container').evaluate((el) =>
        el.scrollHeight - el.scrollTop - el.clientHeight < 80)
    }
    const renderedAfter = await window.locator('.message-outer').count()
    expect(renderedAfter, '滚到底后没有渲染新行').toBeGreaterThan(0)
    expect(atBottom, '滚不到底').toBe(true)
  })
})
