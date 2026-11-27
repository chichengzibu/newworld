/**
 * 【P2 可观测性】Voice 错误 → 本地台账真实 Electron e2e
 *
 * 单测只能证明 mock 被调；这里证明整条链路真的通：
 *   Voice.vue → voice store → errors.report IPC → ErrorLedger 落盘 → errors.summary 读回
 */
import type { Page } from '@playwright/test'
import { test, expect, shouldRunElectronE2E, gotoBySideNav } from './helpers/electron-app'

interface LedgerSummary {
  success: boolean
  data?: { total: number; counts: Record<string, number>; recent: Array<{ kind?: string; source?: string; message?: string }> }
}

function readSummary(window: Page): Promise<LedgerSummary> {
  return window.evaluate(async () => {
    const api = (window as any).electronAPI
    return await api.errors.summary()
  })
}

test.describe('Voice 错误上报台账', () => {
  test.skip(!shouldRunElectronE2E, 'requires E2E_ELECTRON=1')

  test('VE1: 语音不可用 / 引擎异常都落进台账并可查回', async ({ window }) => {
    await gotoBySideNav(window, '/voice')
    await expect(window.locator('h2.voice-title')).toBeVisible({ timeout: 15_000 })

    const before = await readSummary(window)
    expect(before.success).toBe(true)

    // ① 环境不支持语音合成 → voice-unavailable
    await window.evaluate(() => {
      // window.speechSynthesis 是原型上的只读 getter，普通赋值会静默失败；
      // 必须 defineProperty 覆盖自有属性，测完 delete 即恢复原型 getter。
      Object.defineProperty(window, 'speechSynthesis', { value: undefined, configurable: true })
    })
    await window.locator('textarea[aria-label="tts-input"]').fill('ledger test')
    await window.locator('button.voice-btn').first().click()
    await expect(window.locator('.voice-state--error')).toBeVisible({ timeout: 10_000 })
    await window.waitForTimeout(400)

    // ② 引擎抛错 → voice-engine（消息必须带原始 Error，便于定位）
    await window.evaluate(() => {
      Object.defineProperty(window, 'speechSynthesis', {
        value: {
          speak() { throw new Error('e2e-engine-fail') },
          cancel() {},
          getVoices() { return [] },
        },
        configurable: true,
      })
    })
    await window.locator('textarea[aria-label="tts-input"]').fill('ledger engine test')
    await window.locator('button.voice-btn').first().click()
    await expect(window.locator('.voice-state--error')).toBeVisible({ timeout: 10_000 })
    await window.waitForTimeout(400)

    const after = await readSummary(window)
    expect(after.success).toBe(true)
    const counts = after.data?.counts ?? {}
    expect((after.data?.total ?? 0)).toBeGreaterThan(before.data?.total ?? 0)
    expect(counts['voice-unavailable'] ?? 0).toBeGreaterThanOrEqual(1)
    expect(counts['voice-engine'] ?? 0).toBeGreaterThanOrEqual(1)
    expect(after.data?.recent?.some(r => r.source === 'voice:tts')).toBe(true)
    expect(after.data?.recent?.some(r => String(r.message ?? '').includes('e2e-engine-fail'))).toBe(true)

    await window.evaluate(() => {
      delete (window as any).speechSynthesis
    })
  })
})
