import { test, expect, shouldRunElectronE2E } from './helpers/electron-app'
import { addProviderAndReload, createConversationViaUi } from './helpers/electron-app'
import { spawn } from 'node:child_process'
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'

/**
 * 学习闭环端到端（M4-S）
 * ═══════════════════════════════════════════════════════════════════════
 * 【为什么验这个】
 * 「自我学习」是本项目对标 Hermes / Claude Code 的**核心差异点**,
 * 也一直是「声称在工作」的那一类:学习闭环有完整的观察→分析→提案→人审门→落地链路,
 * 但**从没被端到端验过「它真的在记东西」**。
 *
 * 而且 M4-Q 刚修掉一个会让它变假的东西:`sendMessage` 收了 providerId 却**不写回会话**
 * → 经 IPC 发消息时 agent 路径永远拿不到 provider → 每条消息报错回落 →
 * **学习闭环记到的全是这种失败**。修完不等于闭环就通 —— 得实测。
 *
 * 【断什么】
 * ① agent 路径**真的成功**了(助手气泡里是 mock 的真回复,不是报错)
 * ② `<userData>/hermes-learning/observations.json` **多了一条观察**,且带 outcome
 * ③ `<userData>/skill-stats.json` **有记录**(技能效果统计真的在攒)
 *
 * 【为什么用得着读文件】
 * e2e 的 profile 现在**每个测试独立**(`freshUserData` fixture 给的就是那个路径)
 * → 可以直接读落盘结果,断的是「数据真的到磁盘上了」而不是「内存里有」。
 */

test.describe('学习闭环 · 端到端', () => {
  test.skip(!shouldRunElectronE2E, 'requires E2E_ELECTRON=1')

  test('一次成功的对话 → 落成观察记录 + 技能效果统计', async ({ window, freshUserData }) => {
    const repoRoot = process.cwd()
    const mock = spawn(
      process.execPath,
      [join(repoRoot, 'scripts', 'mock-llm-server.mjs'), '9975'],
      { cwd: repoRoot, stdio: 'ignore' },
    )
    for (let i = 0; i < 30; i++) {
      try {
        const r = await fetch('http://127.0.0.1:9975/health')
        if (r.ok) break
      } catch { /* 还没起来 */ }
      await new Promise((r) => setTimeout(r, 200))
    }

    try {
      // 注入 provider(mock LLM)
      const providerId = await addProviderAndReload(window, {
        name: 'Mock LLM (学习闭环 e2e)',
        baseUrl: 'http://127.0.0.1:9975/v1',
        models: [{ id: 'mock-model', name: 'mock-model', capabilities: ['chat'] }],
      })
      expect(providerId, '注入 provider 失败').toBeTruthy()

      // 建会话并把 provider 绑上去(与真实用户选模型的路径一致)
      await window.click('nav.sidenav a.nav-icon[href$="#/chat"]').catch(() => {})
      await window.waitForTimeout(800)
      await createConversationViaUi(window)

      const convId = await window.evaluate(async () => {
        const api = (window as any).electronAPI
        const l = await api.chat.conversations()
        return (l?.data || [])[0]?.id ?? null
      })
      expect(convId, '拿不到会话').toBeTruthy()

      // 发一条消息(带 providerId —— M4-Q 修的就是它)
      await window.evaluate(async ({ id, providerId }: { id: string; providerId: string }) => {
        const api = (window as any).electronAPI
        await api.chat.sendMessage(id, '把桌面上的 PDF 归档到 D:/Documents/PDF', providerId, 'mock-model')
      }, { id: convId!, providerId })

      // ① agent 路径真的成功了(气泡里是 mock 的真回复,不是报错)
      await window.waitForFunction(() => {
        const bubbles = document.querySelectorAll('.message.assistant')
        for (const b of Array.from(bubbles)) {
          if ((b.textContent ?? '').includes('MOCK_LLM_OK')) return true
        }
        return false
      }, { timeout: 30_000 })
      const assistantTexts = await window.evaluate(() =>
        Array.from(document.querySelectorAll('.message.assistant')).map((e: any) => (e.textContent ?? '').trim()))
      expect(
        assistantTexts.some(t => t.includes('no LLM provider configured')),
        `agent 路径报错:${JSON.stringify(assistantTexts.slice(0, 2))}`,
      ).toBe(false)

      // ② 观察记录落盘了
      const obsPath = join(freshUserData, 'hermes-learning', 'observations.json')
      await window.waitForFunction(() => true)   // 给主进程落盘一拍
      await new Promise((r) => setTimeout(r, 1500))
      expect(existsSync(obsPath), `观察记录没落盘:${obsPath}`).toBe(true)
      const observations = JSON.parse(readFileSync(obsPath, 'utf-8')) as any[]
      expect(Array.isArray(observations), '观察记录不是数组').toBe(true)
      expect(observations.length, '一条观察都没有 —— 学习闭环是死的').toBeGreaterThan(0)
      // 观察里要有"做了什么"和"结果如何"
      const latest = observations[observations.length - 1]
      expect(typeof latest.instruction, '观察里没有 instruction').toBe('string')
      expect(String(latest.instruction)).toContain('PDF')
      expect(
        ['ok', 'fail', 'partial'],
        `观察的 outcome 不是三种之一:${JSON.stringify(latest.outcome)}`,
      ).toContain(latest.outcome)
      // 结果不能是失败 —— agent 路径刚才明明成功了
      expect(latest.outcome, '成功的对话却被记成失败').toBe('ok')

      // ③ 工具级效果统计:本条消息**没有工具调用**,所以 tracker 不该有记录 ——
      //    这一点本身要断(否则"没记录"和"记录了但是坏的"分不清)。
      //    真正的工具级记录由下面第二个用例验。
      const statsPath = join(freshUserData, 'skill-stats.json')
      expect(existsSync(statsPath), '没有工具调用却写出了效果统计 —— 统计口径不对').toBe(false)
    } finally {
      mock.kill()
    }
  })

  test('工具调用链:LLM 要工具 → 真的调了 → 观察里有步骤 → tracker 有工具级记录', async ({ window, freshUserData }) => {
    const repoRoot = process.cwd()
    const mock = spawn(
      process.execPath,
      [join(repoRoot, 'scripts', 'mock-llm-server.mjs'), '9976'],
      { cwd: repoRoot, stdio: 'ignore' },
    )
    for (let i = 0; i < 30; i++) {
      try {
        const r = await fetch('http://127.0.0.1:9976/health')
        if (r.ok) break
      } catch { /* 还没起来 */ }
      await new Promise((r) => setTimeout(r, 200))
    }

    try {
      const providerId = await addProviderAndReload(window, {
        name: 'Mock LLM (工具调用 e2e)',
        baseUrl: 'http://127.0.0.1:9976/v1',
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

      // 带 __TOOL_CALL__ 触发 mock 回一个 Glob 工具调用
      await window.evaluate(async ({ id, providerId }: { id: string; providerId: string }) => {
        const api = (window as any).electronAPI
        await api.chat.sendMessage(id, '找出仓库里的所有 markdown 文件 __TOOL_CALL__', providerId, 'mock-model')
      }, { id: convId!, providerId })

      // 等 agent 走完 tool loop(最终正文里会有 mock 的标记)
      await window.waitForFunction(() => {
        const bubbles = document.querySelectorAll('.message.assistant')
        for (const b of Array.from(bubbles)) {
          if ((b.textContent ?? '').includes('MOCK_LLM_OK')) return true
        }
        return false
      }, { timeout: 45_000 })

      // ① 观察里有**步骤**(工具调用被记下来了)
      const obsPath = join(freshUserData, 'hermes-learning', 'observations.json')
      await new Promise((r) => setTimeout(r, 1500))
      expect(existsSync(obsPath), '观察记录没落盘').toBe(true)
      const observations = JSON.parse(readFileSync(obsPath, 'utf-8')) as any[]
      expect(observations.length, '一条观察都没有').toBeGreaterThan(0)
      const latest = observations[observations.length - 1]
      expect(Array.isArray(latest.steps), '观察里没有 steps 数组').toBe(true)
      expect(latest.steps.length, '观察里有 0 个步骤 —— 工具调用没被记下来').toBeGreaterThan(0)
      expect(
        latest.steps.some((s: any) => s.name === 'Glob'),
        `观察里的步骤不是 Glob:${JSON.stringify(latest.steps.map((s: any) => s.name))}`,
      ).toBe(true)

      // ② tracker 有**工具级**记录(unitType='tool')
      const statsPath = join(freshUserData, 'skill-stats.json')
      expect(existsSync(statsPath), '工具调用了但没有效果统计落盘 —— tracker 没记到').toBe(true)
      const stats = JSON.parse(readFileSync(statsPath, 'utf-8'))
      const records = Array.isArray(stats) ? stats : (stats?.records ?? Object.values(stats ?? {}))
      expect(Array.isArray(records) && records.length > 0, '效果统计是空的').toBe(true)
      const globRec = records.find((r: any) => r?.skillName === 'Glob')
      expect(globRec, `效果统计里没有 Glob 的记录:${JSON.stringify(records).slice(0, 200)}`).toBeTruthy()
      expect(globRec.unitType ?? 'tool', 'Glob 记录的类型不对').toBe('tool')
    } finally {
      mock.kill()
    }
  })
})
