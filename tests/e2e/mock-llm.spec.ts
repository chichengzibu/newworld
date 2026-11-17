import { test, expect, shouldRunElectronE2E } from './helpers/electron-app'
import { addProviderAndReload, createConversationViaUi } from './helpers/electron-app'
import { spawn } from 'node:child_process'
import path from 'node:path'

/**
 * mock LLM 与 app 的流式链路（M4-Q）
 * ═══════════════════════════════════════════════════════════════════════
 * 【为什么要有这个文件】
 * 这个 e2e 曾**一直在假通过**:用 mock LLM 发消息,断言"消息条数 > 0"——
 * 而**用户消息就够数**,助手回复其实是空的(甚至是一句
 * 「[LlmAgentBrain error] no LLM provider configured」)。
 *
 * 查下来是三处叠在一起:
 *   ① sendMessage 收了 providerId 却**不写回会话** → agent 路径拿不到 provider
 *   ② 适配器的 streamChat **只解析 SSE**(`data:` 行),而 mock 只回普通 JSON
 *      → 即使调通了,**内容也一行都进不来**
 *   ③ 于是气泡里只有时间戳
 *
 * 本用例把整条链钉住:**mock 回复的内容必须真的出现在助手气泡里**。
 * 它同时是 CI 的前提 —— CI 用 mock LLM 顶替真模型(不装 6GB 权重),
 * 这条链路不通,CI 的 e2e 就全是假绿。
 */

test.describe('mock LLM · 流式链路', () => {
  test.skip(!shouldRunElectronE2E, 'requires E2E_ELECTRON=1')

  test('app 能把 mock 的回复真的显示出来', async ({ window }) => {
    const repoRoot = path.resolve(__dirname, '..', '..')
    const mock = spawn(
      process.execPath,
      [path.join(repoRoot, 'scripts', 'mock-llm-server.mjs'), '9974'],
      { cwd: repoRoot, stdio: 'ignore' },
    )
    // 等 mock 起来
    for (let i = 0; i < 30; i++) {
      try {
        const r = await fetch('http://127.0.0.1:9974/health')
        if (r.ok) break
      } catch { /* 还没起来 */ }
      await new Promise((r) => setTimeout(r, 200))
    }

    try {
      // providerId 必须一路传到底:不传 → agent 路径拿不到 provider
      const providerId = await addProviderAndReload(window, {
        name: 'Mock (e2e 流式校验)',
        baseUrl: 'http://127.0.0.1:9974/v1',
        models: [{ id: 'mock-model', name: 'mock-model', capabilities: ['chat'] }],
      })
      expect(providerId, '注入 provider 失败').toBeTruthy()

      await window.click('nav.sidenav a.nav-icon[href$="#/chat"]').catch(() => {})
      await window.waitForTimeout(800)
      await createConversationViaUi(window)

      const convId = await window.evaluate(async () => {
        const api = (window as any).electronAPI
        const l = await api.chat.conversations()
        return (l?.data || [])[0]?.id ?? null
      })
      expect(convId, '拿不到会话').toBeTruthy()

      await window.evaluate(async ({ id, providerId }: { id: string; providerId: string }) => {
        const api = (window as any).electronAPI
        await api.chat.sendMessage(id, '你好', providerId, 'mock-model')
      }, { id: convId!, providerId })

      // 等助手气泡里出现 mock 的标记
      await window.waitForFunction(() => {
        const bubbles = document.querySelectorAll('.message.assistant')
        for (const b of Array.from(bubbles)) {
          if ((b.textContent ?? '').includes('MOCK_LLM_OK')) return true
        }
        return false
      }, { timeout: 30_000 })

      const texts = await window.evaluate(() =>
        Array.from(document.querySelectorAll('.message.assistant')).map((e: any) => (e.textContent ?? '').trim()))
      // 内容真的到了(不是只有时间戳)
      expect(texts.some(t => t.includes('MOCK_LLM_OK')), `助手气泡里没有 mock 回复:${JSON.stringify(texts)}`).toBe(true)
      // 也不能是"报错的回复"——那说明 provider 没接上
      expect(texts.some(t => t.includes('no LLM provider configured'))).toBe(false)
    } finally {
      mock.kill()
    }
  })
})
