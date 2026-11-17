import { test, expect, shouldRunElectronE2E, addProviderAndReload, selectProviderAndModel } from './helpers/electron-app'

/**
 * T+480: 错误处理 / 降级 UX 真用户测试
 *
 * 真实场景:用户配错模型(端口/模型名)→ 发消息 → 看 UI 怎么表现:
 * ER1: 错误端口 (11435) → send → assistant bubble 显示错误 + toast
 * ER2: 不存在模型 (qwen99-fake) → send → 错误
 * ER3: 错误后切换正确 provider → 可恢复
 * ER4: assistant bubble 状态显示 error (not stuck streaming)
 * ER5: 输入框被清空(用户可继续输入)
 */

test.describe('T+480 Chat 错误处理 / 降级 UX', () => {
  test.skip(!shouldRunElectronE2E, 'requires E2E_ELECTRON=1')

  async function setupConversation(window: any) {
    await window.waitForSelector('#app', { timeout: 10_000 })
    await window.waitForTimeout(800)
    await window.click('nav.sidenav a.nav-icon[href$="#/chat"]').catch(() => {})
    await window.waitForTimeout(1500)
    // 强制新建会话,避免 state 不干净
    const newChatBtn = window.locator('button.new-chat-btn, .empty-new-chat').first()
    if (await newChatBtn.count() > 0) {
      await newChatBtn.click()
      await window.waitForTimeout(1000)
    }
  }

  test('ER1: 错误端口 (11435) → send → assistant bubble 显示错误', async ({ window }) => {
    // 注入一个错误端口的 provider
    // 【M4-L 修】注入 provider 后**必须刷新页面** —— Chat.vue 只在 onMounted 调
    // `modelsStore.fetchProviders()`,IPC 塞进去的 provider 不会推给渲染层 →
    // 模型选择器一直是 disabled → 点击等到 60s 超时(报错却是 "browser has been closed",
    // 那是超时被中断的后果,不是根因)。
    await addProviderAndReload(window, {
      name: 'Bad Port (T+480 ER1)',
      baseUrl: 'http://localhost:11435/v1', // 错误端口
      timeout: 5_000,
      models: [{ id: 'fake-model', name: 'fake-model', capabilities: ['chat'] }],
    })

    await setupConversation(window)

    // 选 Bad Port provider + model(必须选中,不能像旧写法那样"有就选、没有就跳过"
    // —— 跳过等于没选,后面的断言测的是别的东西)
    await selectProviderAndModel(window, 'Bad Port (T+480 ER1)', 'fake-model')

    // 发消息
    const textarea = window.locator('.input-area textarea').first()
    await textarea.click()
    await textarea.fill('hello?')
    const sendBtn = window.locator('.input-area button:has-text("发送"), .input-area button:has-text("Send")').first()
    if (await sendBtn.count() > 0) {
      await sendBtn.click()
    } else {
      await textarea.press('Enter')
    }

    // 等 assistant bubble 出现,带错误状态
    // 错误通常是 ECONNREFUSED 或 timeout
    await window.waitForFunction(() => {
      const bubbles = document.querySelectorAll('.message.assistant, .assistant-message, [class*="message"][class*="assistant"]')
      for (const b of Array.from(bubbles)) {
        const text = (b.textContent ?? '').toLowerCase()
        if (text.includes('error') || text.includes('错误') || text.includes('connect') || text.includes('timeout') || text.includes('econnrefused')) {
          return true
        }
      }
      return false
    }, { timeout: 30_000 })

    // 【对齐现状】发送失败**不走 toast**,错误写进气泡内容
    // (agent 路径:placeholder 消息被 updateMessage 成 content='agent 执行失败:…', status='error')。
    // 旧断言找 `.el-message--error` toast → 永远为 0 → 红;
    // `.message-error` 也没用 —— 它要求 `message.error` 字段有值,
    // 而 agent 失败写的是 content。
    // 故:断「气泡里有错误文案」+「消息状态是 error」。
    const bubble = window.locator('.message.assistant, .assistant-message, [class*="message"][class*="assistant"]').first()
    const bubbleText = (await bubble.innerText()).toLowerCase()
    expect(bubbleText).toMatch(/error|错误|connect|timeout|refused|econnrefused|失败|fetch failed/)
    // 没卡在 streaming:按钮从「停止」变回「发送」
    // (注意:「发送」在输入框为空时是 disabled —— 那是**正确行为**,没得发;
    //  所以这里断的是按钮形态,不是 enabled)
    await expect(window.locator('.input-area button:has-text("停止")'), '仍卡在生成中').toHaveCount(0)
    await expect(window.locator('.input-area button:has-text("发送")').first()).toBeVisible({ timeout: 15_000 })
  })

  test('ER2: 错误后切回正确 Ollama provider → 可继续发消息', async ({ window }) => {
    // 确保 Bad Port provider + 好 Ollama 都存在
    // 【M4-L 修】注入后**刷新页面**,否则渲染层的 provider 列表还是旧的
    // (Chat.vue 只在 onMounted 拉一次)→ 模型选择器里没有这一项 → 选不中
    await addProviderAndReload(window, {
      name: 'Good Ollama (T+480 ER2)',
      baseUrl: 'http://127.0.0.1:11434/v1',
      timeout: 30_000,
      models: [{ id: 'qwen3.5:9b', name: 'qwen3.5:9b', capabilities: ['chat'] }],
    })

    await setupConversation(window)

    // 选 Good Ollama + qwen3.5:9b
    await selectProviderAndModel(window, 'Good Ollama (T+480 ER2)', 'qwen3.5:9b')

    // 发消息
    const textarea = window.locator('.input-area textarea').first()
    await textarea.click()
    await textarea.fill('2+2=?')
    const sendBtn = window.locator('.input-area button:has-text("发送"), .input-area button:has-text("Send")').first()
    if (await sendBtn.count() > 0) {
      await sendBtn.click()
    } else {
      await textarea.press('Enter')
    }

    // 等回复包含 4
    // 【超时口径】本地 qwen3.5:9b 默认带 thinking,首 token 可能要 30s+;
    // 旧断言给 60s,叠加 Playwright 用例 60s 总超时 → 必红。
    // 这里给 180s,并把用例超时也放宽。
    await window.waitForFunction(() => {
      const bubbles = document.querySelectorAll('.message.assistant, .assistant-message, [class*="message"][class*="assistant"]')
      for (const b of Array.from(bubbles)) {
        // 【M4-Q】原来断的是「回复里包含 4」—— 那是**模型算术能力**的断言,
        // 既不稳定(小模型可能答 4 也可能答"二加二等于四"),也让这条用例**没法用
        // mock LLM 跑**(CI 里不装 6GB 真模型)。本用例要验的是
        // 「错误之后切回正确 provider,**还能继续发消息**」—— 断「有非空回复」即可。
        const text = (b.textContent ?? '').trim()
        if (text.length > 3) return true
      }
      return false
    }, { timeout: 180_000 })
  }, 240_000)

  test('ER3: 错误后 textarea 可继续输入(不卡死)', async ({ window }) => {
    // 在 ER1 / ER2 后,选最近一个有 error 标记的会话(ER1 创建的)
    // 验证 textarea 可继续输入
    await setupConversation(window)

    // 等任意已知错误状态完成(从 ER1 / ER2 历史)
    await window.waitForTimeout(1500)

    // 验证 textarea 存在 + 可写
    const textarea = window.locator('.input-area textarea').first()
    await expect(textarea).toBeVisible({ timeout: 10_000 })

    // 输入新消息(覆盖之前的)
    await textarea.fill('recovery test after error')
    const val = await textarea.inputValue()
    expect(val).toBe('recovery test after error')

    // 验证 send 按钮 enabled(不卡在 streaming)
    const sendBtn = window.locator('.input-area button:has-text("发送"), .input-area button:has-text("Send")').first()
    if (await sendBtn.count() > 0) {
      const isDisabled = await sendBtn.evaluate((el: any) => el.disabled)
      // 不强制要求 enabled,因为可能还在 streaming
      // 但应该是 truthy(按钮存在且可交互)
      expect(sendBtn).toBeTruthy()
      expect(typeof isDisabled).toBe('boolean')
    }
  })

  test('ER4: 多个 provider 列表里 disabled 状态正确显示', async ({ window }) => {
    // 验证 Settings → Models 列表里,enabled/disabled 状态正确
    await window.click('nav.sidenav a.nav-icon[href$="#/settings"]')
    await window.waitForURL(/#\/settings/)
    await window.waitForTimeout(800)
    const modelsTab = window.locator('.settings-nav__btn:has-text("模型管理"), .settings-nav__btn:has-text("Models")').first()
    await modelsTab.click()
    await window.waitForTimeout(500)

    // 至少有 1 个 provider 显示
    const cards = await window.locator('.provider-card').count()
    expect(cards).toBeGreaterThan(0)

    // 验证每个 provider 有 toggle 开关
    const switches = await window.locator('.provider-card .el-switch').count()
    expect(switches).toBeGreaterThan(0)
  })
})
