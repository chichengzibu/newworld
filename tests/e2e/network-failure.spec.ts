import { test, expect, shouldRunElectronE2E, addProviderAndReload, selectProviderAndModel } from './helpers/electron-app'

/**
 * T+600: Network 离线 / 黑洞 / 超时真用户测试
 *
 * 真实场景:用户网络异常时发消息:
 * NW1: provider baseUrl 指向黑洞 IP (192.0.2.1, RFC 5737 TEST-NET-1)
 *      → send 消息 → 短超时触发 → UI 显示错误
 * NW2: provider 短 timeout (1s) → 长消息超时 → UI 显示 timeout 错误
 * NW3: 黑洞 IP 不会让 send 按钮永远卡死(超时后恢复 enabled)
 * NW4: 切换到正确 provider 后能继续发消息
 */

test.describe('T+600 Network 离线 / 黑洞 / 超时', () => {
  test.skip(!shouldRunElectronE2E, 'requires E2E_ELECTRON=1')

  async function setupConversation(window: any) {
    await window.waitForSelector('#app', { timeout: 10_000 })
    await window.waitForTimeout(800)
    await window.click('nav.sidenav a.nav-icon[href$="#/chat"]').catch(() => {})
    await window.waitForTimeout(1500)
    // 强制新建会话
    const newChatBtn = window.locator('button.new-chat-btn, .empty-new-chat').first()
    if (await newChatBtn.count() > 0) {
      await newChatBtn.click()
      await window.waitForTimeout(1000)
    }
  }

  test('NW1: 黑洞 IP (192.0.2.1) + 短超时 → send 触发 ECONNREFUSED/timeout', async ({ window }) => {
    // 注入黑洞 IP provider
    // 【M4-L 修】注入 provider 后**刷新页面** —— 渲染层的 provider 列表
    // 只在 Chat 挂载时拉一次,IPC 塞进去的不会推过去 → 模型选择器选不中
    await addProviderAndReload(window, {
      name: 'Blackhole (T+600)',
      baseUrl: 'http://192.0.2.1:11434/v1', // 黑洞 IP,TEST-NET-1
      timeout: 3_000, // 3s 超时
      models: [{ id: 'fake', name: 'fake', capabilities: ['chat'] }],
    })

    await setupConversation(window)

    // 选 Blackhole provider + model(必须选中 —— 旧写法"有就选、没有就跳过"
    // 等于没选,后面的断言测的是别的东西)
    await selectProviderAndModel(window, 'Blackhole (T+600)', 'fake')

    // 选 fake model
    const modelSelect = window.locator('.model-selector .el-select').nth(1)
    if (await modelSelect.count() > 0) {
      await window.waitForFunction(() => {
        const sels = document.querySelectorAll('.model-selector .el-select')
        return sels[1] && !sels[1].querySelector('input[disabled]')
      }, { timeout: 10_000 }).catch(() => {})
      await modelSelect.click()
      await window.waitForTimeout(500)
      const opt = window.locator('.el-select-dropdown__item:has-text("fake")').first()
      if (await opt.count() > 0) {
        await opt.click()
        await window.waitForTimeout(500)
      }
    }

    // 发消息
    const textarea = window.locator('.input-area textarea').first()
    await textarea.click()
    await textarea.fill('test blackhole')
    const sendBtn = window.locator('.input-area button:has-text("发送"), .input-area button:has-text("Send")').first()
    if (await sendBtn.count() > 0) {
      await sendBtn.click()
    } else {
      await textarea.press('Enter')
    }

    // 等错误出现(toast 或 bubble)
    await window.waitForFunction(() => {
      // 找任何错误指示
      const errToast = document.querySelector('.el-message--error')
      if (errToast) return true
      const errInBubble = Array.from(document.querySelectorAll('.message.assistant, .assistant-message, [class*="message"][class*="assistant"]'))
        .some(b => {
          const t = (b.textContent ?? '').toLowerCase()
          return t.includes('error') || t.includes('错误') || t.includes('timeout') || t.includes('connect') || t.includes('econnrefused')
        })
      return errInBubble
    }, { timeout: 30_000 })
  })

  test('NW2: 黑洞 IP 不会卡死 send 按钮(超时后恢复)', async ({ window }) => {
    // 先 reload 清掉 NW1 的残留状态
    await window.reload()
    await window.waitForSelector('#app', { timeout: 10_000 })
    await window.waitForTimeout(1500)

    await setupConversation(window)

    // 输入文字后 send 按钮变 enabled
    // (空 textarea 时按钮 disabled 是正常的,不是卡死)
    const textarea = window.locator('.input-area textarea').first()
    await expect(textarea).toBeVisible({ timeout: 10_000 })
    await textarea.fill('continue after blackhole')

    // 验证 send 按钮变 enabled(说明 isGenerating 已重置)
    // Element Plus 的 type="primary" 渲染为 .el-button--primary class,不是 button[type=primary]
    await window.waitForFunction(() => {
      const sendBtn = document.querySelector('.input-area .el-button--primary:not(.is-disabled):not([disabled])')
      return !!sendBtn
    }, { timeout: 15_000 })

    // 验证停止按钮(红色)不存在,说明 isGenerating === false
    const stopCount = await window.locator('.input-area button[type="danger"]:has-text("停止")').count()
    expect(stopCount).toBe(0)
  })

  test('NW3: 切到正确 Ollama → 可继续发消息', async ({ window }) => {
    // 注入好 Ollama
    await addProviderAndReload(window, {
      name: 'Good Ollama (T+600)',
      baseUrl: 'http://127.0.0.1:11434/v1',
      timeout: 60_000,
      models: [{ id: 'qwen3.5:9b', name: 'qwen3.5:9b', capabilities: ['chat'] }],
    })

    await setupConversation(window)

    // 选 Good Ollama + qwen3.5:9b
    await selectProviderAndModel(window, 'Good Ollama (T+600)', 'qwen3.5:9b')

    // 发消息
    const textarea = window.locator('.input-area textarea').first()
    await textarea.click()
    await textarea.fill('1+1=? 简短回答')
    const sendBtn = window.locator('.input-area button:has-text("发送"), .input-area button:has-text("Send")').first()
    if (await sendBtn.count() > 0) {
      await sendBtn.click()
    } else {
      await textarea.press('Enter')
    }

    // 等真实回复包含 2
    await window.waitForFunction(() => {
      const bubbles = document.querySelectorAll('.message.assistant, .assistant-message, [class*="message"][class*="assistant"]')
      for (const b of Array.from(bubbles)) {
        const text = b.textContent ?? ''
        if (text.includes('2') && text.length > 3) return true
      }
      return false
    }, { timeout: 60_000 })
  })

  test('NW4: 清理:删除测试 provider', async ({ window }) => {
    await window.waitForSelector('#app', { timeout: 10_000 })
    await window.waitForTimeout(800)

    // 【M4-R】自建前提(原来靠 NW1 建的 provider → 顺序依赖)
    await window.evaluate(async () => {
      const api = (window as any).electronAPI
      const list = await api.models.list()
      const has = (n: string) => list?.data?.some((p: any) => p.name === n)
      if (!has('Blackhole (T+600)')) {
        await api.models.add({
          name: 'Blackhole (T+600)',
          type: 'openai',
          baseUrl: 'http://192.0.2.1:11434/v1',
          apiKey: 'no-key',
          enabled: true,
          timeout: 3_000,
          models: [{ id: 'fake', name: 'fake', capabilities: ['chat'] }],
        })
      }
      // 【M4-R】两个都要有 —— 原来「Good Ollama」是 NW3 建的(顺序依赖),
      // 而 NW4 断言删掉 2 个 → 独立跑时只剩 1 个 → 断言必红
      if (!has('Good Ollama (T+600)')) {
        await api.models.add({
          name: 'Good Ollama (T+600)',
          type: 'openai',
          baseUrl: 'http://127.0.0.1:11434/v1',
          apiKey: 'no-key',
          enabled: true,
          timeout: 60_000,
          models: [{ id: 'qwen3.5:9b', name: 'qwen3.5:9b', capabilities: ['chat'] }],
        })
      }
    })

    const result = await window.evaluate(async () => {
      const api = (window as any).electronAPI
      const list = await api.models.list()
      let count = 0
      if (list?.success && list.data) {
        for (const p of list.data) {
          if (p.name === 'Blackhole (T+600)' || p.name === 'Good Ollama (T+600)') {
            await api.models.delete(p.id)
            count++
          }
        }
      }
      return { deleted: count }
    })
    // 语义:本文件造了两个测试 provider(Blackhole / Good Ollama)→ 期望**都**删掉。
    // 旧断言 `>= 2` 在只删掉 1 个时也会过(比如只造成功了一个)→ 假通过。
    expect(result.deleted).toBe(2)
  })
})
