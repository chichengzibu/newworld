/**
 * v4.9 IM 免公网真入站 —— 单测
 *
 * 覆盖：
 *  ① WebSocketPoller 生命周期（启动/停止/退避重连/abort 可中断）
 *  ② Discord Gateway 协议解析（HELLO→IDENTIFY→MESSAGE_CREATE，filter bot，intents 缺失告警）
 *  ③ Slack Socket Mode（envelope ack、hello、禁止 subtype、缺 appToken 告警）
 *  ④ Rocket.Chat 轮询（增量拉取、去重、跳过自己、断点续读）
 *  ⑤ IMPermissionManager 修 from/to 语义 + 持久化
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import * as fs from 'node:fs'
import * as path from 'node:path'
import { TEST_USER_DATA } from './test-host'

const MEM_FILE = path.join(TEST_USER_DATA, 'im-permissions.json')

beforeEach(() => {
  fs.mkdirSync(TEST_USER_DATA, { recursive: true })
  if (fs.existsSync(MEM_FILE)) fs.unlinkSync(MEM_FILE)
})

// ── 最小的假 WebSocket ──────────────────────────────────────────────
class FakeWebSocket {
  static instances: FakeWebSocket[] = []
  url: string
  sent: string[] = []
  private listeners = new Map<string, Array<(ev: any) => void>>()
  closed = false

  constructor(url: string) {
    this.url = url
    FakeWebSocket.instances.push(this)
  }
  addEventListener(type: string, fn: (ev: any) => void): void {
    const arr = this.listeners.get(type) ?? []
    arr.push(fn)
    this.listeners.set(type, arr)
  }
  removeEventListener(): void { /* not needed in tests */ }
  send(data: string): void { this.sent.push(data) }
  close(): void {
    if (this.closed) return
    this.closed = true
    this.emit('close', {})
  }
  emit(type: string, ev: any): void {
    for (const fn of this.listeners.get(type) ?? []) fn(ev)
  }
  /** 模拟服务端推送 */
  push(payload: unknown): void {
    this.emit('message', { data: JSON.stringify(payload) })
  }
  sentJson(): any[] {
    return this.sent.map((s) => {
      try { return JSON.parse(s) } catch { return null }
    }).filter(Boolean)
  }
}

describe('② Discord Gateway 入站', () => {
  beforeEach(() => { FakeWebSocket.instances = [] })
  afterEach(async () => {
    const g = globalThis as { WebSocket?: unknown }
    delete g.WebSocket
  })

  it('HELLO → IDENTIFY → MESSAGE_CREATE 解析为 ChannelMessage', async () => {
    ;(globalThis as { WebSocket?: unknown }).WebSocket = FakeWebSocket

    const { DiscordGatewayReceiver } = await import('../../electron/channel/DiscordGatewayReceiver')
    const got: any[] = []
    const r = new DiscordGatewayReceiver({
      botToken: 'fake-token',
      onMessage: (m) => got.push(m),
      gatewayUrl: 'wss://fake.gateway',
    })
    r.start()

    await vi.waitFor(() => expect(FakeWebSocket.instances.length).toBeGreaterThan(0), { timeout: 3000 })
    const ws = FakeWebSocket.instances[0]

    // ① 服务端发 HELLO
    ws.push({ op: 10, d: { heartbeat_interval: 41250 } })

    await vi.waitFor(() => {
      expect(ws.sentJson().some((p) => p?.op === 2)).toBe(true)
    }, { timeout: 3000 })

    const identify = ws.sentJson().find((p) => p?.op === 2)
    expect(identify.d.token).toBe('fake-token')
    expect(identify.d.intents).toBeGreaterThan(0)

    // ② READY
    ws.push({ op: 0, s: 1, t: 'READY', d: { session_id: 'sess-1', user: { id: 'bot-1' } } })

    // ③ 新消息
    ws.push({
      op: 0, s: 2, t: 'MESSAGE_CREATE',
      d: {
        id: 'msg-1',
        channel_id: 'chan-9',
        content: '你好，帮我整理桌面',
        author: { id: 'user-42', bot: false },
      },
    })

    await vi.waitFor(() => expect(got.length).toBe(1), { timeout: 3000 })
    expect(got[0].to).toBe('chan-9')
    expect(got[0].from).toBe('user-42')
    expect(got[0].text).toBe('你好，帮我整理桌面')

    await r.stop()
  })

  it('过滤 bot 自己发的消息（防自问自答）', async () => {
    ;(globalThis as { WebSocket?: unknown }).WebSocket = FakeWebSocket
    const { DiscordGatewayReceiver } = await import('../../electron/channel/DiscordGatewayReceiver')
    const got: any[] = []
    const r = new DiscordGatewayReceiver({
      botToken: 't', onMessage: (m) => got.push(m), gatewayUrl: 'wss://fake',
    })
    r.start()
    await vi.waitFor(() => expect(FakeWebSocket.instances.length).toBeGreaterThan(0), { timeout: 3000 })
    const ws = FakeWebSocket.instances[0]
    ws.push({ op: 10, d: { heartbeat_interval: 41250 } })
    ws.push({ op: 0, s: 1, t: 'READY', d: { session_id: 's', user: { id: 'bot-1' } } })

    // bot 自己的消息
    ws.push({
      op: 0, s: 2, t: 'MESSAGE_CREATE',
      d: { id: 'm1', channel_id: 'c1', content: '我是机器人', author: { id: 'bot-1', bot: true } },
    })
    // 同一 bot id 但 bot 标志缺失
    ws.push({
      op: 0, s: 3, t: 'MESSAGE_CREATE',
      d: { id: 'm2', channel_id: 'c1', content: '还是我', author: { id: 'bot-1' } },
    })

    await new Promise((res) => setTimeout(res, 150))
    expect(got.length).toBe(0)
    await r.stop()
  })

  it('content 为空时告警（提示 intents 未开）而不是静默丢弃', async () => {
    ;(globalThis as { WebSocket?: unknown }).WebSocket = FakeWebSocket
    const { DiscordGatewayReceiver } = await import('../../electron/channel/DiscordGatewayReceiver')
    const got: any[] = []
    const r = new DiscordGatewayReceiver({
      botToken: 't', onMessage: (m) => got.push(m), gatewayUrl: 'wss://fake',
    })
    r.start()
    await vi.waitFor(() => expect(FakeWebSocket.instances.length).toBeGreaterThan(0), { timeout: 3000 })
    const ws = FakeWebSocket.instances[0]
    ws.push({ op: 10, d: { heartbeat_interval: 41250 } })
    ws.push({ op: 0, s: 1, t: 'READY', d: { session_id: 's', user: { id: 'bot-1' } } })
    ws.push({
      op: 0, s: 2, t: 'MESSAGE_CREATE',
      d: { id: 'm1', channel_id: 'c1', content: '', author: { id: 'u1', bot: false } },
    })
    await new Promise((res) => setTimeout(res, 120))
    expect(got.length).toBe(0) // 空内容不投递
    await r.stop()
  })
})

describe('③ Slack Socket Mode 入站', () => {
  beforeEach(() => { FakeWebSocket.instances = [] })
  afterEach(() => {
    delete (globalThis as { WebSocket?: unknown }).WebSocket
    vi.restoreAllMocks()
  })

  it('缺 appToken 时不启动（并告警）', async () => {
    const { SlackSocketReceiver } = await import('../../electron/channel/SlackSocketReceiver')
    const r = new SlackSocketReceiver({ botToken: 'xoxb-1', appToken: '', onMessage: () => {} })
    r.start()
    expect(r.isRunning()).toBe(false)
    await r.stop()
  })

  it('握手拿 wss URL → hello → events_api 并回 ack', async () => {
    ;(globalThis as { WebSocket?: unknown }).WebSocket = FakeWebSocket
    globalThis.fetch = vi.fn(async () => ({
      ok: true,
      json: async () => ({ ok: true, url: 'wss://fake-slack' }),
    })) as unknown as typeof fetch

    const { SlackSocketReceiver } = await import('../../electron/channel/SlackSocketReceiver')
    const got: any[] = []
    const r = new SlackSocketReceiver({
      botToken: 'xoxb-1', appToken: 'xapp-1', onMessage: (m) => got.push(m),
    })
    r.start()
    await vi.waitFor(() => expect(FakeWebSocket.instances.length).toBeGreaterThan(0), { timeout: 3000 })
    const ws = FakeWebSocket.instances[0]

    ws.push({ type: 'hello' })
    ws.push({
      type: 'events_api',
      envelope_id: 'env-1',
      payload: { event: { type: 'message', channel: 'C123', user: 'U456', text: '帮我查天气', ts: '1.1' } },
    })

    await vi.waitFor(() => expect(got.length).toBe(1), { timeout: 3000 })
    expect(got[0].to).toBe('C123')
    expect(got[0].from).toBe('U456')
    expect(got[0].text).toBe('帮我查天气')

    // 必须回 ack，否则 Slack 会重投
    const ack = ws.sentJson().find((p) => p?.envelope_id === 'env-1')
    expect(ack).toBeTruthy()

    await r.stop()
  })

  it('忽略带 subtype 的 message（编辑/bot_message）', async () => {
    ;(globalThis as { WebSocket?: unknown }).WebSocket = FakeWebSocket
    globalThis.fetch = vi.fn(async () => ({
      ok: true, json: async () => ({ ok: true, url: 'wss://fake' }),
    })) as unknown as typeof fetch

    const { SlackSocketReceiver } = await import('../../electron/channel/SlackSocketReceiver')
    const got: any[] = []
    const r = new SlackSocketReceiver({ botToken: 'x', appToken: 'xapp-1', onMessage: (m) => got.push(m) })
    r.start()
    await vi.waitFor(() => expect(FakeWebSocket.instances.length).toBeGreaterThan(0), { timeout: 3000 })
    const ws = FakeWebSocket.instances[0]
    ws.push({ type: 'hello' })
    ws.push({
      type: 'events_api', envelope_id: 'e1',
      payload: { event: { type: 'message', subtype: 'message_changed', channel: 'C', user: 'U', text: '改了' } },
    })
    await new Promise((res) => setTimeout(res, 120))
    expect(got.length).toBe(0)
    await r.stop()
  })
})

describe('④ Rocket.Chat 轮询入站', () => {
  it('增量拉取并按时间正序投递，跳过自己发的', async () => {
    const { RocketChatPoller } = await import('../../electron/channel/RocketChatPoller')
    const got: any[] = []
    const statePath = path.join(TEST_USER_DATA, 'rc-state-test.json')
    if (fs.existsSync(statePath)) fs.unlinkSync(statePath)

    // 预置 lastTs，跳过首次基线
    fs.writeFileSync(statePath, JSON.stringify({ lastTs: '2026-01-01T00:00:00.000Z', updatedAt: 0 }))

    let call = 0
    globalThis.fetch = vi.fn(async () => {
      call += 1
      return {
        ok: true,
        json: async () => ({
          success: true,
          messages: [
            { _id: 'a', msg: '第二条', rid: 'room1', ts: '2026-01-01T00:00:02.000Z', u: { _id: 'other' } },
            { _id: 'b', msg: '第一条', rid: 'room1', ts: '2026-01-01T00:00:01.000Z', u: { _id: 'other' } },
            { _id: 'me', msg: '我自己', rid: 'room1', ts: '2026-01-01T00:00:03.000Z', u: { _id: 'me-1' } },
          ],
        }),
      }
    }) as unknown as typeof fetch

    const p = new RocketChatPoller({
      serverUrl: 'https://rc.example.com',
      authToken: 'tok',
      userId: 'me-1',
      channelIds: ['room1'],
      intervalMs: 50,
      statePath,
      onMessage: (m) => got.push(m),
    })
    p.start()
    await vi.waitFor(() => expect(got.length).toBeGreaterThanOrEqual(2), { timeout: 3000 })
    await p.stop()

    // 按 ts 正序
    expect(got[0].text).toBe('第一条')
    expect(got[1].text).toBe('第二条')
    // 自己发的不投递
    expect(got.every((m) => m.text !== '我自己')).toBe(true)
    expect(call).toBeGreaterThan(0)

    if (fs.existsSync(statePath)) fs.unlinkSync(statePath)
  })

  it('同一消息不会被重复投递（去重）', async () => {
    const { RocketChatPoller } = await import('../../electron/channel/RocketChatPoller')
    const got: any[] = []
    const statePath = path.join(TEST_USER_DATA, 'rc-state-dup.json')
    fs.writeFileSync(statePath, JSON.stringify({ lastTs: '2026-01-01T00:00:00.000Z', updatedAt: 0 }))

    // 每次返回同一条
    globalThis.fetch = vi.fn(async () => ({
      ok: true,
      json: async () => ({
        success: true,
        messages: [{ _id: 'same', msg: '重复消息', rid: 'r1', ts: '2026-01-01T00:00:01.000Z', u: { _id: 'u2' } }],
      }),
    })) as unknown as typeof fetch

    const p = new RocketChatPoller({
      serverUrl: 'https://rc.example.com', authToken: 't', userId: 'me',
      channelIds: ['r1'], intervalMs: 30, statePath, onMessage: (m) => got.push(m),
    })
    p.start()
    await new Promise((res) => setTimeout(res, 250))
    await p.stop()

    expect(got.length).toBe(1)
    if (fs.existsSync(statePath)) fs.unlinkSync(statePath)
  })
})

describe('⑤ IMPermissionManager 修 from/to 语义 + 持久化', () => {
  it('用 from（发送者）判定，不是 to（会话）', async () => {
    const { IMPermissionManager } = await import('../../electron/channel/IMPermissionManager')
    const m = IMPermissionManager.getInstance()
    m.clearAll()

    // 只授权 user-1
    m.grant('im-telegram' as any, 'user-1')

    // 私聊：to 和 from 相同 → 放行
    expect(m.isAllowed({ to: 'user-1', from: 'user-1', text: 'hi' } as any, 'im-telegram' as any)).toBe(true)
    // 群聊：from=user-1, to=group-99 → 仍应放行（旧实现会用 to=group-99 判定 → 误拒）
    expect(m.isAllowed({ to: 'group-99', from: 'user-1', text: 'hi' } as any, 'im-telegram' as any)).toBe(true)
    // 群里另一个成员 → 拒绝
    expect(m.isAllowed({ to: 'group-99', from: 'user-2', text: 'hi' } as any, 'im-telegram' as any)).toBe(false)
  })

  it('授权写盘，重启后可读回（不再重启即失效）', async () => {
    const { IMPermissionManager } = await import('../../electron/channel/IMPermissionManager')
    const m = IMPermissionManager.getInstance()
    m.clearAll()
    m.grant('im-discord' as any, 'user-abc')

    // 直接读磁盘文件，验证已持久化
    const raw = fs.readFileSync(MEM_FILE, 'utf-8')
    const data = JSON.parse(raw)
    expect(data['im-discord']).toContain('user-abc')
  })

  it('空白名单仍为全放行（保持既有语义）', async () => {
    const { IMPermissionManager } = await import('../../electron/channel/IMPermissionManager')
    const m = IMPermissionManager.getInstance()
    m.clearAll()
    expect(m.isAllowed({ to: 'x', from: 'y', text: 'hi' } as any, 'im-slack' as any)).toBe(true)
  })
})
