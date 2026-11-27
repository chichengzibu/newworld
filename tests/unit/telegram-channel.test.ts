/**
 * IM 真连通 · TelegramChannel 出站真往返测试
 *
 * 用本机 node:http server 充当 Bot API，验证：
 *  - 请求真的发出（不是 stub），且打到 config.apiBaseUrl（官方默认可覆盖）
 *  - sendMessage / getMe 的请求体与响应 envelope 校验
 *  - HTTP 200 但 ok:false / HTTP 5xx 都判失败
 *  - 带超时的 signal 能中断挂起请求
 *
 * 无需公网 / 域名 / 证书，符合本机环境约束。
 */
import { describe, it, expect, vi, beforeAll, afterAll, beforeEach } from 'vitest'
import { createServer, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import { IMConfigStore } from '../../electron/channel/IMConfigStore'
import {
  TelegramChannel,
  callTelegramApi,
  telegramMethodUrl,
  resolveTelegramApiBase,
  TELEGRAM_DEFAULT_API_BASE,
} from '../../electron/channel/TelegramChannel'
import { EventBus } from '../../electron/runtime/bridge/EventBus'

interface Seen {
  method: string
  url: string
  body: Record<string, unknown>
}
type Responder = (path: string, body: Record<string, unknown>) => { status?: number; payload: unknown }

let server: Server
let baseUrl = ''
let seen: Seen[] = []
let responder: Responder

const defaultResponder: Responder = (path) => {
  if (path.includes('/getMe')) return { payload: { ok: true, result: { username: 'nw_bot' } } }
  if (path.includes('/sendMessage')) return { payload: { ok: true, result: { message_id: 42 } } }
  return { payload: { ok: true, result: {} } }
}

beforeAll(async () => {
  server = createServer((req, res) => {
    const chunks: Buffer[] = []
    req.on('data', (c) => chunks.push(Buffer.from(c)))
    req.on('end', () => {
      let body: Record<string, unknown> = {}
      try {
        body = JSON.parse(Buffer.concat(chunks).toString('utf-8') || '{}')
      } catch {
        body = {}
      }
      seen.push({ method: req.method || '', url: req.url || '', body })
      const out = responder(req.url || '', body)
      res.writeHead(out.status ?? 200, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify(out.payload))
    })
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const addr = server.address() as AddressInfo
  baseUrl = `http://127.0.0.1:${addr.port}`
})

afterAll(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()))
})

beforeEach(() => {
  seen = []
  responder = defaultResponder
  EventBus.getInstance().clear()
  IMConfigStore.getInstance().set('im-telegram', {
    botToken: '123456:ABC-DEF',
    apiBaseUrl: baseUrl,
    enabled: true,
  })
})

describe('TG-1: apiBaseUrl 解析与 URL 构造', () => {
  it('未配置 apiBaseUrl → 官方默认', () => {
    expect(resolveTelegramApiBase(undefined)).toBe(TELEGRAM_DEFAULT_API_BASE)
    expect(resolveTelegramApiBase({ channelKind: 'im-telegram', enabled: true, updatedAt: 0 })).toBe(
      TELEGRAM_DEFAULT_API_BASE,
    )
  })

  it('配置 apiBaseUrl → 去尾斜杠后可覆盖', () => {
    expect(resolveTelegramApiBase({
      channelKind: 'im-telegram', enabled: true, updatedAt: 0, apiBaseUrl: 'http://127.0.0.1:9999/',
    })).toBe('http://127.0.0.1:9999')
  })

  it('botToken 中的冒号不被 encodeURIComponent 破坏', () => {
    expect(telegramMethodUrl('https://api.telegram.org', '123456:ABC-DEF', 'sendMessage')).toBe(
      'https://api.telegram.org/bot123456:ABC-DEF/sendMessage',
    )
  })
})

describe('TG-2: send / healthCheck 真 HTTP 往返', () => {
  it('send 真发出 POST 到 apiBaseUrl，chat_id/text 正确', async () => {
    const channel = new TelegramChannel('tg-test')
    await channel.send({ to: 'chat-777', text: '你好 New World', from: 'user-1' })

    expect(seen).toHaveLength(1)
    expect(seen[0].method).toBe('POST')
    expect(seen[0].url).toContain('/bot123456:ABC-DEF/sendMessage')
    expect(seen[0].body).toMatchObject({ chat_id: 'chat-777', text: '你好 New World' })
    expect(channel.getApiBase()).toBe(baseUrl)
  })

  it('healthCheck 真打 getMe，返回 healthy + latencyMs', async () => {
    const channel = new TelegramChannel('tg-test')
    const health = await channel.healthCheck()
    expect(health.healthy).toBe(true)
    expect(typeof health.latencyMs).toBe('number')
    expect(seen[0].url).toContain('/getMe')
  })

  it('send 成功发布 im:channel:send:ok', async () => {
    const spy = vi.fn()
    EventBus.getInstance().subscribe('im:channel:send:ok', spy)
    await new TelegramChannel('tg-test').send({ to: 'chat-1', text: 'ping' })
    await Promise.resolve()
    expect(spy).toHaveBeenCalled()
  })

  it('HTTP 200 但 envelope ok:false → 判失败（不误报成功）', async () => {
    responder = () => ({ payload: { ok: false, error_code: 400, description: 'Bad Request: chat not found' } })
    await expect(new TelegramChannel('tg-test').send({ to: 'bad', text: 'x' })).rejects.toThrow(
      /API 400|chat not found/,
    )
  })

  it('HTTP 5xx → 判失败并带状态码', async () => {
    responder = () => ({ status: 502, payload: 'Bad Gateway' })
    await expect(new TelegramChannel('tg-test').send({ to: 'c', text: 'x' })).rejects.toThrow(/HTTP 502/)
  })

  it('healthCheck 在 HTTP 5xx 时返回 unhealthy（不抛）', async () => {
    responder = () => ({ status: 500, payload: 'oops' })
    const health = await new TelegramChannel('tg-test').healthCheck()
    expect(health.healthy).toBe(false)
    expect(health.error).toContain('HTTP 500')
  })

  it('未配置 botToken → send 抛错、healthCheck unhealthy', async () => {
    IMConfigStore.getInstance().set('im-telegram', { enabled: true, botToken: '' })
    const channel = new TelegramChannel('tg-test')
    await expect(channel.send({ to: 'c', text: 'x' })).rejects.toThrow(/缺少 botToken/)
    expect((await channel.healthCheck()).healthy).toBe(false)
    expect(seen).toHaveLength(0)
  })
})

describe('TG-3: 共享请求管线的超时与取消', () => {
  it('timeoutMs 到期会中断挂起请求', async () => {
    const slowFetch = ((_url: string, init: RequestInit) =>
      new Promise<Response>((_resolve, reject) => {
        const t = setTimeout(() => reject(new Error('unexpected resolve')), 5000)
        init.signal?.addEventListener('abort', () => {
          clearTimeout(t)
          reject(new Error('aborted by timeout'))
        })
      })) as unknown as typeof fetch

    await expect(
      callTelegramApi(baseUrl, '123456:ABC-DEF', 'getMe', { fetchImpl: slowFetch, timeoutMs: 80 }),
    ).rejects.toThrow()
  })

  it('外部 AbortSignal 可取消请求', async () => {
    const ctrl = new AbortController()
    const cancellableFetch = ((_url: string, init: RequestInit) =>
      new Promise<Response>((_resolve, reject) => {
        const t = setTimeout(() => reject(new Error('unexpected resolve')), 5000)
        const onAbort = () => { clearTimeout(t); reject(new Error('cancelled')) }
        init.signal?.addEventListener('abort', onAbort, { once: true })
        ctrl.signal.addEventListener('abort', () => init.signal?.dispatchEvent(new Event('abort')), { once: true })
      })) as unknown as typeof fetch

    const p = callTelegramApi(baseUrl, '123456:ABC-DEF', 'getMe', {
      fetchImpl: cancellableFetch,
      signal: ctrl.signal,
      timeoutMs: 5000,
    })
    ctrl.abort()
    await expect(p).rejects.toThrow()
  })
})
