/**
 * IM 真连通 · TelegramPoller 入站真往返测试
 *
 * 本机 mock server 充当 getUpdates / deleteWebhook，验证：
 *  - Update → ChannelMessage 映射（to=chat_id / from=user_id / text）
 *  - nextOffset 按最后 update_id+1 推进并持久化，重启不重复消费
 *  - 请求带 offset / timeout / allowed_updates
 *  - 忽略 bot 自身消息与非文本消息（防自回复循环）
 *  - API 错误可被捕获、stop() 能中断后台循环
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest'
import { createServer, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import * as os from 'node:os'
import * as path from 'node:path'
import * as fs from 'node:fs'
import { IMConfigStore } from '../../electron/channel/IMConfigStore'
import { TelegramPoller } from '../../electron/channel/TelegramPoller'
import type { ChannelMessage } from '../../electron/contracts/types'

interface Seen { url: string; body: Record<string, unknown> }

let server: Server
let baseUrl = ''
let seen: Seen[] = []
let updates: unknown[] = []
let forcedPayload: unknown = null
let forcedStatus = 200
let offsetPath = ''

const makeUpdate = (updateId: number, text: string, opts: { isBot?: boolean; chatId?: number } = {}) => ({
  update_id: updateId,
  message: {
    message_id: 1000 + updateId,
    from: { id: 555, is_bot: opts.isBot ?? false, first_name: 'Ada' },
    chat: { id: opts.chatId ?? -100123, type: 'private' },
    text,
  },
})

beforeAll(async () => {
  server = createServer((req, res) => {
    const chunks: Buffer[] = []
    req.on('data', (c) => chunks.push(Buffer.from(c)))
    req.on('end', () => {
      let body: Record<string, unknown> = {}
      try { body = JSON.parse(Buffer.concat(chunks).toString('utf-8') || '{}') } catch { body = {} }
      seen.push({ url: req.url || '', body })
      let out: { status: number; payload: unknown }
      if ((req.url || '').includes('/deleteWebhook')) {
        out = { status: 200, payload: { ok: true, result: true } }
      } else if (forcedPayload !== null) {
        out = { status: forcedStatus, payload: forcedPayload }
      } else {
        out = { status: 200, payload: { ok: true, result: updates } }
      }
      res.writeHead(out.status, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify(out.payload))
    })
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
})

afterAll(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()))
})

beforeEach(() => {
  seen = []
  updates = []
  forcedPayload = null
  forcedStatus = 200
  offsetPath = path.join(os.tmpdir(), `nw-tg-offset-${process.pid}-${Math.random().toString(36).slice(2)}.json`)
  try { fs.unlinkSync(offsetPath) } catch { /* noop */ }
  IMConfigStore.getInstance().set('im-telegram', {
    botToken: '123456:ABC-DEF',
    apiBaseUrl: baseUrl,
    enabled: true,
  })
})

describe('PL-1: getUpdates → ChannelMessage 映射', () => {
  it('文本消息映射为 to=chat_id / from=user_id / text，并带 tg- 审计 subject', async () => {
    updates = [makeUpdate(10, '你好，帮我查一下日程')]
    const received: ChannelMessage[] = []
    const poller = new TelegramPoller({
      onMessage: (m) => { received.push(m) },
      offsetPath,
      pollTimeoutSec: 0,
      skipDeleteWebhook: true,
    })

    const handled = await poller.pollOnce()
    expect(handled).toBe(1)
    expect(received).toHaveLength(1)
    expect(received[0]).toMatchObject({
      to: '-100123',
      from: '555',
      text: '你好，帮我查一下日程',
      subject: 'tg-1010',
    })
  })

  it('请求带 offset / timeout / allowed_updates', async () => {
    updates = []
    await new TelegramPoller({ onMessage: () => {}, offsetPath, pollTimeoutSec: 7, skipDeleteWebhook: true }).pollOnce()
    expect(seen[0].url).toContain('/getUpdates')
    expect(seen[0].body).toMatchObject({ offset: 0, timeout: 7, allowed_updates: ['message'] })
  })

  it('忽略 bot 自身消息、非文本消息与 caption 之外的空内容', async () => {
    updates = [
      makeUpdate(1, 'bot 自己发的', { isBot: true }),
      makeUpdate(2, ''),
      { update_id: 3, message: { message_id: 4, chat: { id: 9 }, from: { id: 7 } } },
      makeUpdate(4, '真实用户消息'),
    ]
    const received: ChannelMessage[] = []
    const poller = new TelegramPoller({ onMessage: (m) => received.push(m), offsetPath, pollTimeoutSec: 0, skipDeleteWebhook: true })
    expect(await poller.pollOnce()).toBe(1)
    expect(received[0].text).toBe('真实用户消息')
    // 即便被过滤，offset 仍推进到最后一条，避免重复拉同一批
    expect(poller.getOffset()).toBe(5)
  })
})

describe('PL-2: offset 持久化与断点续传', () => {
  it('nextOffset = max(update_id)+1，写盘后新实例从该 offset 继续', async () => {
    updates = [makeUpdate(41, 'a'), makeUpdate(42, 'b')]
    const p1 = new TelegramPoller({ onMessage: () => {}, offsetPath, pollTimeoutSec: 0, skipDeleteWebhook: true })
    await p1.pollOnce()
    expect(p1.getOffset()).toBe(43)
    expect(fs.existsSync(offsetPath)).toBe(true)
    expect(JSON.parse(fs.readFileSync(offsetPath, 'utf-8')).nextOffset).toBe(43)

    seen = []
    updates = []
    const p2 = new TelegramPoller({ onMessage: () => {}, offsetPath, pollTimeoutSec: 0, skipDeleteWebhook: true })
    expect(p2.getOffset()).toBe(43)
    await p2.pollOnce()
    expect(seen[0].body.offset).toBe(43)
  })

  it('无新消息时不写盘、不重复推进', async () => {
    updates = []
    const p = new TelegramPoller({ onMessage: () => {}, offsetPath, pollTimeoutSec: 0, skipDeleteWebhook: true })
    await p.pollOnce()
    expect(p.getOffset()).toBe(0)
    expect(fs.existsSync(offsetPath)).toBe(false)
    expect(p.getPollCount()).toBe(1)
  })
})

describe('PL-3: 错误处理与生命周期', () => {
  it('envelope ok:false → pollOnce 抛错', async () => {
    forcedPayload = { ok: false, error_code: 409, description: 'Conflict: webhook is active' }
    const p = new TelegramPoller({ onMessage: () => {}, offsetPath, skipDeleteWebhook: true })
    await expect(p.pollOnce()).rejects.toThrow(/409|webhook/)
  })

  it('通道未启用且未注入 token → 抛明确错误、不发请求', async () => {
    IMConfigStore.getInstance().set('im-telegram', { enabled: false, botToken: '' })
    const p = new TelegramPoller({ onMessage: () => {}, offsetPath, skipDeleteWebhook: true })
    await expect(p.pollOnce()).rejects.toThrow(/未启用|缺少 botToken/)
    expect(seen).toHaveLength(0)
  })

  it('start → 后台循环运行 → stop 能中断并置为未运行', async () => {
    // 让 getUpdates 恒失败，loop 进入长退避 sleep；stop() 应立刻打断
    forcedPayload = { ok: false, error_code: 500, description: 'mock down' }
    const p = new TelegramPoller({
      onMessage: () => {},
      offsetPath,
      skipDeleteWebhook: true,
      backoffBaseMs: 60_000,
      backoffMaxMs: 60_000,
      pollTimeoutSec: 0,
    })
    p.start()
    expect(p.isRunning()).toBe(true)
    await Promise.resolve()
    await p.stop()
    expect(p.isRunning()).toBe(false)
  })
})
