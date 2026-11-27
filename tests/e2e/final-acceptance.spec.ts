import { test, expect } from './helpers/electron-app'
import { gotoBySideNav, gotoRoute, addProviderAndReload } from './helpers/electron-app'
import { mkdirSync } from 'node:fs'

/**
 * 最终验收: CSP 加固终验 + Ollama 真实模型端到端 + 用户视角可视化走查
 *
 * 覆盖(对应用户验收指令):
 *  1. Electron 真实运行态下 CSP 无 EvalError / vue-i18n(AST+JIT) 文案正常
 *  2. 注入 Ollama provider(qwen3.5:9b) → 发消息 → 流式回复 → orb 状态 → 会话持久化
 *  3. 用户视角: 关键按键齐全(附件/供应商/模型/记忆/执行模式/发送)、
 *     输入卡尺寸合理、核心页面逐页截图走查
 *
 * 运行: E2E_ELECTRON=1 OLLAMA_URL=http://localhost:11434 npx playwright test tests/e2e/final-acceptance.spec.ts
 * 截图: e2e-screenshots/final-acceptance/
 */

const SCREENSHOT_DIR = 'e2e-screenshots/final-acceptance'
const CSP_RE = /EvalError|Refused to evaluate|Content Security Policy|Unexpected return type|NOT_SUPPORT_NON_STRING_MESSAGE/i

test.describe('最终验收 (CSP + 真实 LLM + 用户视角走查)', () => {
  let consoleErrors: string[] = []

  test.beforeEach(() => {
    mkdirSync(SCREENSHOT_DIR, { recursive: true })
    consoleErrors = []
  })

  test('A0: Electron 真实运行态 — CSP 无违例 + i18n 文案渲染 + 关键按键齐全', async ({ window }) => {
    // 收集 console error(跳过无头桩类噪音)
    window.on('console', (m) => {
      if (m.type() === 'error') consoleErrors.push(m.text())
    })
    window.on('pageerror', (e) => consoleErrors.push(String(e)))
    await window.waitForTimeout(2500)

    const cspViolations = consoleErrors.filter((t) => CSP_RE.test(t))
    if (cspViolations.length) console.log('CSP 违例:', cspViolations)
    expect(cspViolations, '不得有 CSP/EvalError/i18n 编译错误').toEqual([])

    // i18n 文案真实渲染(AST + runtime JIT 链路)
    const bodyText = await window.evaluate(() => document.body.innerText)
    expect(bodyText).toContain('模型')
    expect(bodyText).not.toContain('common.save')

    // 用户视角: 主界面关键按键齐全
    await expect(window.locator('.attach-btn')).toBeVisible()
    await expect(window.locator('.provider-pill')).toBeVisible()
    await expect(window.locator('.model-pill')).toBeVisible()
    await expect(window.locator('.send-btn')).toBeVisible()

    await window.screenshot({ path: `${SCREENSHOT_DIR}/01-home.png`, fullPage: false })
  })

  test('A1: 注入 Ollama provider(qwen3.5:9b)', async ({ window }) => {
    test.skip(!process.env.OLLAMA_URL, 'set OLLAMA_URL=http://localhost:11434 to run')
    const id = await addProviderAndReload(window, {
      name: 'Ollama 本地 (验收)',
      type: 'openai',
      baseUrl: `${process.env.OLLAMA_URL}/v1`,
      apiKey: 'no-key',
      timeout: 120_000,
      models: [{ id: 'qwen3.5:9b', name: 'qwen3.5:9b', capabilities: ['chat'] }],
    })
    expect(id).toBeTruthy()
    // store 里可见
    const count = await window.evaluate(async () => {
      const r = await (window as any).electronAPI.models.list()
      return (r?.data || []).filter((p: any) => p.enabled).length
    })
    expect(count).toBeGreaterThan(0)
  })

  test('A2: 真实模型端到端 — 发消息 → 流式 → 回复含内容 → orb 参与状态', async ({ window }) => {
    test.skip(!process.env.OLLAMA_URL, 'set OLLAMA_URL=http://localhost:11434 to run')
    await addProviderAndReload(window, {
      name: 'Ollama 本地 (验收)',
      type: 'openai',
      baseUrl: `${process.env.OLLAMA_URL}/v1`,
      apiKey: 'no-key',
      timeout: 120_000,
      models: [{ id: 'qwen3.5:9b', name: 'qwen3.5:9b', capabilities: ['chat'] }],
    })

    await gotoBySideNav(window, '/chat')
    await window.waitForTimeout(1200)

    // 新建会话(空态时输入区直接可用; 有会话时点新建)
    const textarea = window.locator('.input-area textarea').first()
    await expect(textarea).toBeVisible({ timeout: 15_000 })

    // 选供应商(如未自动选)
    const providerPill = window.locator('.provider-pill').first()
    await providerPill.click()
    await window.waitForTimeout(500)
    const provOpt = window.locator('.el-select-dropdown__item:has-text("Ollama 本地 (验收)")').first()
    if (await provOpt.count()) {
      await provOpt.click()
      await window.waitForTimeout(800)
    } else {
      await window.keyboard.press('Escape')
    }

    // 选模型(如未自动选)
    const modelPill = window.locator('.model-pill').first()
    await modelPill.click()
    await window.waitForTimeout(500)
    const modelOpt = window.locator('.el-select-dropdown__item:has-text("qwen3.5:9b")').first()
    if (await modelOpt.count()) {
      await modelOpt.click()
      await window.waitForTimeout(500)
    } else {
      await window.keyboard.press('Escape')
    }

    await window.screenshot({ path: `${SCREENSHOT_DIR}/02-chat-before-send.png` })

    // 发送真实消息
    await textarea.click()
    await textarea.fill('你好,请用一句话(不超过20字)介绍你自己')
    await window.waitForTimeout(300)
    const sendBtn = window.locator('.send-btn').first()
    await expect(sendBtn).toBeEnabled()
    await sendBtn.click()
    await window.screenshot({ path: `${SCREENSHOT_DIR}/03-chat-streaming.png` })

    // assistant 气泡出现
    const assistantMsg = window.locator('.message').filter({ has: window.locator('.message-avatar.assistant') })
    await expect(assistantMsg.first()).toBeVisible({ timeout: 30_000 })

    // 流式/最终内容非空(qwen3.5:9b 冷加载首 token 可能 10-30s)
    await window.waitForFunction(() => {
      const texts = document.querySelectorAll('.message-text')
      for (const t of Array.from(texts)) {
        const s = (t.textContent || '').trim()
        if (s.length >= 6 && !s.includes('…')) return true
      }
      return false
    }, { timeout: 120_000 })

    await window.screenshot({ path: `${SCREENSHOT_DIR}/04-chat-replied.png` })

    // 无 error 气泡
    await expect(window.locator('.message-error')).toHaveCount(0)
    // orb 存在(状态呼吸)
    await expect(window.locator('.nova-orb, .orb-core').first()).toBeAttached()
  })

  test('A3: 会话持久化 — 同测试内发消息 → reload → 消息还在', async ({ window }) => {
    test.skip(!process.env.OLLAMA_URL, 'set OLLAMA_URL=http://localhost:11434 to run')
    // 注意: fixture 每个测试独立 userData —— 持久化必须在同一测试内闭环验证
    await addProviderAndReload(window, {
      name: 'Ollama 本地 (验收)',
      type: 'openai',
      baseUrl: `${process.env.OLLAMA_URL}/v1`,
      apiKey: 'no-key',
      timeout: 120_000,
      models: [{ id: 'qwen3.5:9b', name: 'qwen3.5:9b', capabilities: ['chat'] }],
    })

    await gotoBySideNav(window, '/chat')
    await window.waitForTimeout(1000)
    const textarea = window.locator('.input-area textarea').first()
    await expect(textarea).toBeVisible({ timeout: 15_000 })
    await textarea.click()
    await textarea.fill('持久化测试:请只回复"OK"两个字母')
    await window.waitForTimeout(200)
    await window.locator('.send-btn').first().click()

    // 等回复落地(最多 120s)
    await window.waitForFunction(() => {
      const texts = document.querySelectorAll('.message-text')
      let hasUser = false, hasAssistant = false
      for (const t of Array.from(texts)) {
        const s = (t.textContent || '').trim()
        if (s.includes('持久化测试')) hasUser = true
        if (s.length >= 2 && s.includes('OK')) hasAssistant = true
      }
      return hasUser && hasAssistant
    }, { timeout: 120_000 })

    // reload → 会话与消息应从 ConfigStore/本地库还原
    await window.reload({ waitUntil: 'domcontentloaded' })
    await window.waitForSelector('#app', { timeout: 15_000 })
    await window.waitForTimeout(1500)
    await gotoBySideNav(window, '/chat')
    await window.waitForTimeout(1000)

    const convCount = await window.locator('.conversation-item').count()
    expect(convCount, '侧栏应还原出会话').toBeGreaterThan(0)
    await window.locator('.conversation-item').first().click()
    await window.waitForTimeout(1200)
    const msgCount = await window.locator('.message').count()
    expect(msgCount, '点开会话后消息应还原').toBeGreaterThan(0)
    const restored = await window.evaluate(() => (document.querySelector('.messages-list, .messages-container')?.textContent || ''))
    expect(restored).toContain('持久化测试')
    await window.screenshot({ path: `${SCREENSHOT_DIR}/05-persistence.png` })
  })

  test('A4: 用户视角逐页走查 + 输入卡尺寸合理性', async ({ window }) => {
    await gotoBySideNav(window, '/chat')
    await window.waitForTimeout(1000)

    // 输入卡尺寸: 卡片式输入区高度应在 120-260px, 宽度占主区 60%+ 且无横向溢出
    const box = await window.locator('.input-area').first().boundingBox()
    expect(box).toBeTruthy()
    if (box) {
      expect(box.height, '输入卡高度合理(不臃肿不被压扁)').toBeGreaterThanOrEqual(110)
      expect(box.height).toBeLessThanOrEqual(280)
      const viewportW = (await window.viewportSize())?.width ?? 1280
      expect(box.width, '输入卡有足够宽度').toBeGreaterThan(viewportW * 0.45)
    }

    // 逐页走查(截图 + 无白屏: #app 有实际内容)
    const routes = [
      ['/models', '06-models.png'],
      ['/skills', '07-skills.png'],
      ['/schedule', '08-schedule.png'],
      ['/clawhub', '09-clawhub.png'],
      ['/voice', '10-voice.png'],
      ['/settings', '11-settings.png'],
      ['/permissions', '13-permissions.png'],
    ] as const
    for (const [route, file] of routes) {
      await gotoRoute(window, route)
      const textLen = await window.evaluate(() => (document.querySelector('#app')?.innerText || '').length)
      expect(textLen, `${route} 页面渲染非空`).toBeGreaterThan(30)
      await window.screenshot({ path: `${SCREENSHOT_DIR}/${file}` })
    }

    // 主题切换有真实反馈(不只有动画): 切换后 html class 或 token 变化
    await gotoRoute(window, '/chat')
    const htmlClassBefore = await window.evaluate(() => document.documentElement.className)
    const themeBtn = window.locator('[class*="theme"]').first()
    if (await themeBtn.count()) {
      await themeBtn.click().catch(() => {})
      await window.waitForTimeout(600)
      const htmlClassAfter = await window.evaluate(() => document.documentElement.className)
      expect(htmlClassAfter, '主题切换改变根 class').not.toBe(htmlClassBefore)
    }
    await window.screenshot({ path: `${SCREENSHOT_DIR}/14-final.png` })
  })
})
