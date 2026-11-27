/**
 * IM 真连通 · 全链路真往返集成测试
 *
 * 一个本机 node:http server 同时充当：
 *   - Telegram Bot API（getUpdates / getMe / sendMessage / deleteWebhook）
 *   - OpenAI 兼容 LLM（/v1/chat/completions）
 *
 * 串起完整链路并断言两端都发生了真实 HTTP 请求（不是 stub、不是 __pushIncoming
 * 测试注入后的空转）：
 *
 *   getUpdates → TelegramPoller → TelegramChannel.__pushIncoming
 *   → ChannelRouter.register(handler) → IMMessageRouter.handleIncoming
 *   → EventBus('im:channel:incoming') → InboundBridge
 *   → LlmClient.chat(真 HTTP 到 mock LLM) → ChannelRouter.send
 *   → TelegramChannel.send(真 HTTP 到 mock Bot API sendMessage)
 *
 * 无需公网 / 域名 / TLS 证书，完全在本机闭环。
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach } from 'vitest'
import { createServer, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import * as os from 'node:os'
import * as path from 'node:path'
import * as fs from 'node:fs'
import { IMConfigStore } from '../../electron/channel/IMConfigStore'
import { TelegramChannel } from '../../electron/channel/TelegramChannel'
import { TelegramPoller } from '../../electron/channel/TelegramPoller'
import { ChannelRouter } from '../../electron/channel/ChannelRouter'
import { InboundBridge } from '../../electron/channel/InboundBridge'
import type { ReplyGenerator } from '../../electron/channel/InboundBridge'
import { IMMessageStore } from '../../electron/channel/IMMessageStore'
import { IMPermissionManager } from '../../electron/channel/IMPermissionManager'
import { IMMessageRouter } from '../../electron/channel/IMMessageRouter'
import { EventBus } from '../../electron/runtime/bridge/EventBus'
import { LlmClient } from '../../electron/llm/LlmClient'
import type { ChannelMetadata } from '../../electron/channel/ChannelTypes'

const TOKEN = '777777:TEST-TOKEN'
const CHAT_ID = -100987
const USER_ID = 4242
const USER_TEXT = '请帮我写一句问候'
const LLM_REPLY = '你好，很高兴为你服务！'

interface Recorded { url: string; body: Record<string, any> }

let server: Server
let baseUrl = ''
let records: Recorded[] = []
let updates: unknown[] = []
let offsetPath = ''
let bridge: InboundBridge | null = null
let poller: TelegramPoller | null = null

function makeUpdate(updateId: number, text: string) {
  return {
    update_id: updateId,
    message: {
      message_id: 900 + updateId,
      from: { id: USER_ID, is_bot: false, first_name: 'Ada' },
      chat: { id: CHAT_ID, type: 'private' },
      text,
    },
  }
}

async function waitFor(predicate: () => boolean, timeoutMs = 5000): Promise<void> {
  const start = Date.now()
  while (!predicate()) {
    if (Date.now() - start > timeoutMs) throw new Error('waitFor: 等待出站请求超时')
    await new Promise((r) => setTimeout(r, 20))
  }
}

beforeAll(async () => {
  server = createServer((req, res) => {
    const chunks: Buffer[] = []
    req.on('data', (c) => chunks.push(Buffer.from(c)))
    req.on('end', () => {
      let body: Record<string, any> = {}
      try { body = JSON.parse(Buffer.concat(chunks).toString('utf-8') || '{}') } catch { body = {} }
      const url = req.url || ''
      records.push({ url, body })

      let payload: unknown
      if (url.includes('/v1/chat/completions')) {
        payload = {
          id: 'chatcmpl-mock', object: 'chat.completion', created: Date.now(), model: 'mock-model',
          choices: [{ index: 0, message: { role: 'assistant', content: LLM_REPLY }, finish_reason: 'stop' }],
          usage: { prompt_tokens: 12, completion_tokens: 9, total_tokens: 21 },
        }
      } else if (url.includes('/getUpdates')) {
        payload = { ok: true, result: updates }
      } else if (url.includes('/deleteWebhook')) {
        payload = { ok: true, result: true }
      } else if (url.includes('/getMe')) {
        payload = { ok: true, result: { username: 'nw_test_bot' } }
      } else if (url.includes('/sendMessage')) {
        payload = { ok: true, result: { message_id: 99, text: body.text } }
      } else {
        payload = { ok: true, result: {} }
      }
      res.writeHead(200, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify(payload))
    })
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
})

afterAll(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()))
})

beforeEach(() => {
  records = []
  updates = []
  offsetPath = path.join(os.tmpdir(), `nw-im-rt-${process.pid}-${Math.random().toString(36).slice(2)}.json`)
  try { fs.unlinkSync(offsetPath) } catch { /* noop */ }

  // 各单例隔离，避免跨用例串数据
  ;(ChannelRouter as unknown as { instance: ChannelRouter | null }).instance = null
  ;(IMPermissionManager as unknown as { instance: IMPermissionManager | null }).instance = null
  ;(IMMessageRouter as unknown as { instance: IMMessageRouter | null }).instance = null
  InboundBridge.reset()
  EventBus.getInstance().clear()
  IMMessageStore.getInstance().clear()

  IMConfigStore.getInstance().set('im-telegram', {
    botToken: TOKEN,
    apiBaseUrl: baseUrl,
    enabled: true,
  })
})

afterEach(() => {
  bridge?.stop()
  bridge = null
  poller = null
})

/** 装配真实链路：TelegramChannel + ChannelRouter + InboundBridge(真 LLM 调用) + Poller */
function wire(): { tg: TelegramChannel; p: TelegramPoller } {
  const tg = new TelegramChannel('im-telegram')
  const meta: Omit<ChannelMetadata, 'createdAt'> = {
    id: 'im-telegram', kind: 'im-telegram', displayName: 'Telegram',
    enabled: true, priority: 1, configRef: 'im-telegram',
  }
  ChannelRouter.getInstance().register(tg, meta)

  // 生产路径等价物：用 LlmClient 真调用本机 mock LLM（inline config 绕开全局表）
  const generator: ReplyGenerator = async (ctx) => {
    const res = await LlmClient.getInstance().chat({
      model: 'mock-model',
      messages: [
        { role: 'system', content: 'You are New World IM assistant.' },
        { role: 'user', content: ctx.cleanContent },
      ],
      config: { provider: 'openai-compatible', apiKey: 'test-key', apiBaseUrl: `${baseUrl}/v1` },
      maxTokens: 256,
    })
    if (!res.ok) throw new Error(res.error || 'LLM 调用失败')
    return (res.content || '').trim()
  }

  bridge = InboundBridge.getInstance({ replyGenerator: generator })
  bridge.start()
  poller = new TelegramPoller({
    onMessage: (msg) => tg.__pushIncoming(msg),
    offsetPath,
    pollTimeoutSec: 0,
    skipDeleteWebhook: true,
  })
  return { tg, p: poller }
}

describe('RT-1: 入站 → LLM → 出站 真 HTTP 往返', () => {
  it('一条 Telegram 文本消息走完全链路，两端都产生真实网络请求', async () => {
    const { p } = wire()
    updates = [makeUpdate(1, USER_TEXT)]

    await p.pollOnce()
    await waitFor(() => records.some((r) => r.url.includes('/sendMessage')))

    const getUpdates = records.find((r) => r.url.includes('/getUpdates'))
    const llmCall = records.find((r) => r.url.includes('/v1/chat/completions'))
    const sendMessage = records.find((r) => r.url.includes('/sendMessage'))

    // 1) 入站真的从 Bot API 拉取
    expect(getUpdates).toBeDefined()
    expect(getUpdates!.body).toMatchObject({ offset: 0, allowed_updates: ['message'] })

    // 2) 消息真的进了 LLM，且是用户原文
    expect(llmCall).toBeDefined()
    expect(llmCall!.body.model).toBe('mock-model')
    expect(llmCall!.body.messages?.[1]?.content).toBe(USER_TEXT)

    // 3) 模型回复真的发回原会话
    expect(sendMessage).toBeDefined()
    expect(sendMessage!.body).toMatchObject({ chat_id: String(CHAT_ID), text: LLM_REPLY })

    // 4) offset 推进 + 消息台账有完整来回
    expect(p.getOffset()).toBe(2)
    const stored = IMMessageStore.getInstance().query({ channelId: 'im-telegram' })
    expect(stored).toHaveLength(2)
    expect(stored[0].direction).toBe('in')
    expect(stored[0].message).toMatchObject({ to: String(CHAT_ID), from: String(USER_ID), text: USER_TEXT })
    expect(stored[1].direction).toBe('out')
    expect(stored[1].message.text).toBe(LLM_REPLY)
  })

  it('权限拒绝时链路在 permission 处终止，不调用 LLM、不发送', async () => {
    const { p } = wire()
    // 白名单非空即启用校验；isAllowed 检查 message.to(chat_id)，此处只授权别人
    IMPermissionManager.getInstance().grant('im-telegram', 'some-other-user')
    updates = [makeUpdate(2, '这条应该被拒绝')]

    await p.pollOnce()
    await new Promise((r) => setTimeout(r, 200))

    expect(records.some((r) => r.url.includes('/v1/chat/completions'))).toBe(false)
    expect(records.some((r) => r.url.includes('/sendMessage'))).toBe(false)
    expect(p.getOffset()).toBe(3) // 拒绝也推进 offset，避免重复消费
  })

  it('危险内容被 security 拦截，不生成回复', async () => {
    const { p } = wire()
    updates = [makeUpdate(3, '<script>alert(1)</script>')]

    await p.pollOnce()
    await new Promise((r) => setTimeout(r, 200))

    expect(records.some((r) => r.url.includes('/v1/chat/completions'))).toBe(false)
    expect(records.some((r) => r.url.includes('/sendMessage'))).toBe(false)
  })
})
