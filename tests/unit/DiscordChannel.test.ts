import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'

vi.mock('electron-log', () => ({
  default: { info: () => {}, warn: () => {}, error: () => {}, debug: () => {}, transports: { file: { resolvePathFn: () => {}, maxSize: 0, format: '' }, console: { level: 'info' } } },
}))

/**
 * P1-01: Discord 通道测试(W8 真实 API)
 *
 * 重写说明(2026-10-08):旧版针对 setConfig/validateToken/listMessages/pollMessages
 * 等"全功能 API"编写,而 W8 实现是精简真实版 — 只有 send / onMessage / healthCheck,
 * 配置统一走 IMConfigStore.set('im-discord', { enabled, botToken })。
 * 按实现重写真实存在的链路;实现中不存在的方法保留占位 skip 并注明,
 * 禁止为通过测试在实现里补造能力。
 */

import { DiscordChannel } from '../../electron/channel/DiscordChannel'
import { IMConfigStore } from '../../electron/channel/IMConfigStore'

let mockFetch: any

function resetChannelSingletons(): void {
  ;(IMConfigStore as unknown as { instance: unknown }).instance = null
}

beforeEach(() => {
  resetChannelSingletons()
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

function configDiscord(extra: Partial<Record<string, unknown>> = {}): void {
  IMConfigStore.getInstance().set('im-discord' as never, {
    enabled: true,
    botToken: 'tk',
    ...extra,
  } as never)
}

describe('P1-01: DiscordChannel.send', () => {
  it('POST 到 /channels/{id}/messages + Bot Authorization', async () => {
    configDiscord()
    const channel = new DiscordChannel()
    mockFetch.mockResolvedValueOnce(
      mockJsonResponse({ id: 'msg-1', channel_id: 'ch-1', content: 'hi' }),
    )
    await channel.send({
      id: 'm1',
      text: 'hello',
      channel: 'discord',
      from: 'nwWorld',
      to: 'ch-123456',
      ts: Date.now(),
    } as any)
    const [url, init] = mockFetch.mock.calls[0]
    expect(url).toBe('https://discord.com/api/v10/channels/ch-123456/messages')
    expect(init.method).toBe('POST')
    expect(init.headers.Authorization).toBe('Bot tk')
    expect(JSON.parse(init.body)).toEqual({ content: 'hello' })
  })

  it('未启用通道 → 抛错', async () => {
    IMConfigStore.getInstance().set('im-discord' as never, { enabled: false, botToken: 'tk' } as never)
    const channel = new DiscordChannel()
    await expect(
      channel.send({ id: 'm', text: 'x', channel: 'discord', from: 'me', to: 'ch', ts: 0 } as any),
    ).rejects.toThrow(/通道未启用或未配置/)
  })

  it('enabled 但缺 botToken → 抛错', async () => {
    IMConfigStore.getInstance().set('im-discord' as never, { enabled: true } as never)
    const channel = new DiscordChannel()
    await expect(
      channel.send({ id: 'm', text: 'x', channel: 'discord', from: 'me', to: 'ch', ts: 0 } as any),
    ).rejects.toThrow(/缺少 botToken/)
  })

  it('HTTP 429 → 抛错透传状态码', async () => {
    configDiscord()
    const channel = new DiscordChannel()
    mockFetch.mockResolvedValueOnce(mockJsonResponse({ message: 'rate limited' }, 429))
    await expect(
      channel.send({ id: 'm', text: 'x', channel: 'discord', from: 'me', to: 'ch-1', ts: 0 } as any),
    ).rejects.toThrow(/HTTP 429/)
    expect(mockFetch).toHaveBeenCalledTimes(1)
  })

  it.skip('msg.to 为空 → 抛错(W8 实现未做入参校验,补入参校验前不验证)', async () => {})
})

describe('P1-01: DiscordChannel.healthCheck', () => {
  it('未配置 → healthy=false', async () => {
    const channel = new DiscordChannel()
    const h = await channel.healthCheck()
    expect(h.healthy).toBe(false)
    expect(h.error).toContain('not configured')
  })

  it('token 有效 → healthy=true + latencyMs', async () => {
    configDiscord({ botToken: 'valid' })
    const channel = new DiscordChannel()
    mockFetch.mockResolvedValueOnce(
      mockJsonResponse({ id: '999', username: 'MyBot', discriminator: '0', bot: true }),
    )
    const h = await channel.healthCheck()
    expect(h.healthy).toBe(true)
    const [url, init] = mockFetch.mock.calls[0]
    expect(url).toBe('https://discord.com/api/v10/users/@me')
    expect(init.headers.Authorization).toBe('Bot valid')
  })

  it('HTTP 401 → healthy=false + 状态码', async () => {
    configDiscord({ botToken: 'bad' })
    const channel = new DiscordChannel()
    mockFetch.mockResolvedValueOnce(mockJsonResponse({ message: 'Invalid' }, 401))
    const h = await channel.healthCheck()
    expect(h.healthy).toBe(false)
    expect(h.error).toContain('HTTP 401')
  })
})

describe('P1-01: DiscordChannel.onMessage 回调', () => {
  it('__pushIncoming 触发 handler + dispose 后不再触发', () => {
    IMConfigStore.getInstance().set('im-discord' as never, { enabled: true, botToken: 'tk' } as never)
    const channel = new DiscordChannel()
    const handler = vi.fn()
    const disposable = channel.onMessage(handler)
    channel.__pushIncoming({ id: 'x', text: 'hello', channel: 'discord', from: 'u', to: '', ts: 0 } as any)
    expect(handler).toHaveBeenCalledTimes(1)
    disposable.dispose()
    channel.__pushIncoming({ id: 'y', text: 'again', channel: 'discord', from: 'u', to: '', ts: 0 } as any)
    expect(handler).toHaveBeenCalledTimes(1)
  })
})

describe('P1-01: 未实现能力占位(W8 范围外,勿当作已交付)', () => {
  it.skip('validateToken — W8 未实现(实现中无此方法)', () => {})
  it.skip('listMessages / lastSeenMessageId — W8 未实现(实现中无此方法)', () => {})
  it.skip('pollMessages 拉取式轮询 — W8 未实现(实现中无此方法)', () => {})
  it.skip('setConfig 通道内配置 — W8 配置统一走 IMConfigStore', () => {})
})
