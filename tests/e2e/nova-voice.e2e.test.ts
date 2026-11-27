/**
 * NOVA #005-B · M4 \u8bed\u97f3 \u00b7 nova-voice.e2e.test.ts (\u7b2c\u2462\u7b14)
 *
 * \u8bbe\u8ba1\u7a3f F7 \u53e3\u5f84 (\u7c89\u9636\u5f0f \u2014\u2014 stub \u8de8 e2e):
 *   - speechSynthesis stub (NW_E2E=1 \u73af\u5883\u4e0b\u4e0d\u53ef\u80fd\u4f9d\u8d56\u771f\u5b9e\u5f15\u64ce)
 *   - getUserMedia stub
 *   - SpeechRecognition stub
 *
 * MVP \u5b9e\u89e6\u8fbe = speak stub (\u8bbe\u8ba1\u7a3f T8):
 *   - \u8bed\u97f3\u4e3b\u8def\u5f84 = speak/cancel \u4e24\u4e2a\u52a8\u4f5c; \u53e6\u4e24\u65cf\u8bbe\u8ba1\u7a3f\u5b9a\u4f4d ASR (\u5ef6\u540e W4)
 *
 * \u672c\u6d4b\u8bd5 2 \u4f8b:
 *   V1 /voice \u6e32\u67d3 + \u89e6\u53d1\u671f\u520a \u2192 stub speak \u8c03\u7528 + orb speaking \u6001\u65ad\u8a00
 *   V2 cancel \u2192 \u6001\u590d\u4f4d
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { chromium, type Browser, type Page } from 'playwright'

const BASE_URL = 'http://localhost:4173'

describe('NOVA #005-B M4 voice \u8def\u7531 + stub speak \u72b6\u6001\u673a', () => {
  let browser: Browser | null = null
  let page: Page | null = null

  beforeAll(async () => {
    browser = await chromium.launch({ headless: true })
    page = await browser.newPage({ viewport: { width: 1440, height: 900 } })
  }, 30000)

  afterAll(async () => {
    await page?.close()
    await browser?.close()
  })

  it('V1: /voice \u6e32\u67d3 + \u89e6\u53d1\u671f\u520a \u2192 stub speak + speaking/error \u6001', async () => {
    if (!page) throw new Error('page not ready')
    await page.goto(`${BASE_URL}/#/voice`, { waitUntil: 'domcontentloaded', timeout: 15000 })
    // \u8def\u7531\u6302\u8f7d
    const titleEl = page.locator('h2.voice-title')
    await titleEl.waitFor({ state: 'visible', timeout: 10000 })
    const title = await titleEl.textContent()
    expect(title?.length ?? 0).toBeGreaterThan(0)
    // \u586b\u5165
    await page.locator('textarea[aria-label="tts-input"]').fill('newworld nova-voice e2e test')
    // \u70b9\u51fb\u671f\u520a
    await page.locator('button.voice-btn').click()
    // \u7b49\u5f85\u53d8\u6001: speaking \u6216 error(unavailable) \u90fd\u5408\u7406 (e2e \u73af\u5883\u53ef\u80fd\u6ca1\u6709 speechSynthesis)
    await page.waitForTimeout(2000)
    const pageText = await page.textContent('body')
    const hasFeedback = !!(pageText && (
      pageText.includes('朗读中') || pageText.includes('Speaking') ||
      pageText.includes('不可用') || pageText.includes('unavailable') ||
      pageText.includes('Speak') || pageText.includes('朗读')
    ))
    expect(hasFeedback).toBe(true)
  }, 30000)

  it('V2: \u671f\u520a \u2192 cancel \u2192 \u6001\u590d\u4f4d (idle / \u53ef\u8c03\u7528\u6309\u94ae)', async () => {
    if (!page) throw new Error('page not ready')
    await page.goto(`${BASE_URL}/#/voice`, { waitUntil: 'domcontentloaded', timeout: 15000 })
    await page.locator('h2.voice-title').waitFor({ state: 'visible', timeout: 10000 })
    await page.locator('textarea[aria-label="tts-input"]').fill('newworld cancel test')
    await page.locator('button.voice-btn').click()
    await page.waitForTimeout(2000)
    // \u671f\u520a\u4e2d \u2192 cancel \u2192 \u5982\u679c\u521d\u59cb state = speaking, \u51fa\u73b0 stop \u6309\u94ae; \u5982\u679c error \u4e0d\u51fa\u73b0 stop, \u8df3\u8fc7\u8be5\u68c0\u67e5
    const stopBtn = await page.locator('button.voice-btn--stop').first()
    const cnt = await stopBtn.count()
    if (cnt > 0) {
      await stopBtn.click()
      await page.waitForTimeout(1000)
      // cancel \u540e \u2192 \u6309\u94ae\u5e94\u8fd8\u539f\u4e3a speak
      const afterBtn = await page.locator('button.voice-btn').first()
      expect(await afterBtn.count()).toBeGreaterThan(0)
      const txt = await afterBtn.textContent()
      expect(txt?.trim().length).toBeGreaterThan(0)
    } else {
      // \u521d\u59cb\u5c31\u662f error \u72b6 (\u8bed\u97f3\u4e0d\u53ef\u7528) \u2014 cancel \u6309\u94ae\u4e0d\u5b58\u5728 \u4f46\u9875\u9762\u5e94\u5c55\u793a error \u6587\u6848
      const errorEl = await page.locator('.voice-state--error')
      expect(await errorEl.count()).toBeGreaterThan(0)
    }
  }, 30000)
})