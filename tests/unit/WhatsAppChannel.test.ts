import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'

vi.mock('electron-log', () => ({
  default: { info: () => {}, warn: () => {}, error: () => {}, debug: () => {}, transports: { file: { resolvePathFn: () => {}, maxSize: 0, format: '' }, console: { level: 'info' } } },
}))

/**
 * P1-02: WhatsApp 通道测试(W8 真实 API)
 *
 * 重写说明(2026-10-08):旧版针对 setConfig/validateToken/markAsRead 等编写,
 * W8 实现是精简真实版 — 只有 send / onMessage / healthCheck,
 * 配置走 IMConfigStore.set('im-whatsapp', { enabled, botToken, appId })。
 * 按实现重写;未实现方法保留占位 skip,禁止为过测补造能力。
 */

import { WhatsAppChannel } from '../../electron/channel/WhatsAppChannel'
import { IMConfigStore } from '../../electron/channel/IMConfigStore'

let mockFetch: any

beforeEach(() => {
  ;(IMConfigStore as unknown as { instance: unknown }).instance = null
  mockFetch = vi.fn()
  vi.stubGlobal('fetch', mockFetch)
})

afterEach(() => {
  vi.unstubAllGlobals()
})

function mockJsonResponse(body: unknown, status = 200): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: vi.fn().mockResolvedValue(body),
    text: vi.fn().mockResolvedValue(JSON.stringify(body)),
  } as unknown as Response
}

function configWhatsApp(token = 'whtk', appId = 'phone-123', enabled = true): void {
  IMConfigStore.getInstance().set('im-whatsapp' as never, { enabled, botToken: token, appId } as never)
}

describe('P1-02: WhatsAppChannel.send', () => {
  it('POST 到 /{phoneNumberId}/messages + Bearer', async () => {
    configWhatsApp()
    const ch = new WhatsAppChannel()
    mockFetch.mockResolvedValueOnce(mockJsonResponse({ messages: [{ id: 'wamid.1' }] }))
    await ch.send({ id: 'm1', text: 'hi', channel: 'whatsapp', from: 'piPiClaw', to: '+8613800', ts: Date.now() } as any)
    const [url, init] = mockFetch.mock.calls[0]
    expect(url).toBe('https://graph.facebook.com/v19.0/phone-123/messages')
    expect(init.method).toBe('POST')
    expect(init.headers.Authorization).toBe('Bearer whtk')
    const body = JSON.parse(init.body)
    expect(body.messaging_product).toBe('whatsapp')
    expect(body.to).toBe('+8613800')
    expect(body.text.body).toBe('hi')
  })

  it('未启用 → 抛错', async () => {
    configWhatsApp(undefined, undefined, false)
    const ch = new WhatsAppChannel()
    await expect(
      ch.send({ id: 'm', text: 'x', channel: 'whatsapp', from: 'a', to: 'b', ts: 0 } as any),
    ).rejects.toThrow(/通道未启用或未配置/)
  })

  it('缺 appId → 抛错', async () => {
    configWhatsApp('whtk', '')
    const ch = new WhatsAppChannel()
    await expect(
      ch.send({ id: 'm', text: 'x', channel: 'whatsapp', from: 'a', to: 'b', ts: 0 } as any),
    ).rejects.toThrow(/botToken 与 appId/)
  })

  it('4xx 透传 message', async () => {
    configWhatsApp()
    const ch = new WhatsAppChannel()
    mockFetch.mockResolvedValueOnce(mockJsonResponse({ error: { message: 'Invalid recipient' } }, 400))
    await expect(
      ch.send({ id: 'm', text: 'x', channel: 'whatsapp', from: 'a', to: 'bad', ts: 0 } as any),
    ).rejects.toThrow(/Invalid recipient/)
  })
})

describe('P1-02: WhatsAppChannel.healthCheck', () => {
  it('未配置 → healthy=false', async () => {
    const ch = new WhatsAppChannel()
    const h = await ch.healthCheck()
    expect(h.healthy).toBe(false)
    expect(h.error).toContain('not configured')
  })

  it('配置有效 → healthy=true + GET /me Bearer', async () => {
    configWhatsApp('whtk', 'phone-9')
    const ch = new WhatsAppChannel()
    mockFetch.mockResolvedValueOnce(mockJsonResponse({ id: 'me' }))
    const h = await ch.healthCheck()
    expect(h.healthy).toBe(true)
    const [url, init] = mockFetch.mock.calls[0]
    expect(url).toBe('https://graph.facebook.com/v19.0/me')
    expect(init.headers.Authorization).toBe('Bearer whtk')
  })

  it('token 无效(HTTP 401)→ healthy=false', async () => {
    configWhatsApp('bad')
    const ch = new WhatsAppChannel()
    mockFetch.mockResolvedValueOnce(mockJsonResponse({ error: { message: 'bad token' } }, 401))
    const h = await ch.healthCheck()
    expect(h.healthy).toBe(false)
    expect(h.error).toContain('HTTP 401')
  })
})

describe('P1-02: WhatsAppChannel.onMessage 回调', () => {
  it('__pushIncoming 触发 handler', () => {
    const ch = new WhatsAppChannel()
    const handler = vi.fn()
    const d = ch.onMessage(handler)
    ch.__pushIncoming({ id: '1', text: 'hello', channel: 'whatsapp', from: '+861', to: '', ts: 0 } as any)
    expect(handler).toHaveBeenCalledTimes(1)
    d.dispose()
  })
})

describe('P1-02: 未实现能力占位(W8 范围外,勿当作已交付)', () => {
  it.skip('validateToken — W8 未实现(实现中无此方法)', () => {})
  it.skip('markAsRead — W8 未实现(实现中无此方法)', () => {})
  it.skip('setConfig 通道内配置 — W8 配置统一走 IMConfigStore', () => {})
})
