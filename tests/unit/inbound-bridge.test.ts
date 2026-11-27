/**
 * IM 真连通 · InboundBridge 入站 → 回复 → 出站闭环测试
 *
 * 验证：
 *  - allowed + sanitized 的消息会经 ReplyGenerator 生成回复并 ChannelRouter.send 发回原通道
 *  - 无匹配路由规则（allowed/sanitized 仍 true）默认回原通道，不静默丢弃
 *  - matchedRule 指向其它通道时按 targetChannel/targetUserId 转发
 *  - 目标通道未注册时回退原通道原会话
 *  - 被拒绝 / 空内容 / 生成失败 的行为（失败回明确提示，不编造回答）
 *  - 出站消息进 IMMessageStore('out')，消息查看器能看到完整来回
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { ChannelRouter } from '../../electron/channel/ChannelRouter'
import { InboundBridge } from '../../electron/channel/InboundBridge'
import type { InboundEvent } from '../../electron/channel/InboundBridge'
import { IMMessageStore } from '../../electron/channel/IMMessageStore'
import { EventBus } from '../../electron/runtime/bridge/EventBus'
import type { Channel, ChannelMessage, ChannelHealth } from '../../electron/contracts/types'
import type { ChannelMetadata, ChannelKind } from '../../electron/channel/ChannelTypes'

function stubChannel(id: string, sendImpl?: (msg: ChannelMessage) => Promise<void>): Channel {
  return {
    id,
    send: sendImpl ?? (async () => {}),
    onMessage: () => ({ dispose: () => {} }),
    healthCheck: async (): Promise<ChannelHealth> => ({ healthy: true }),
  }
}

function meta(id: string, kind: ChannelKind): Omit<ChannelMetadata, 'createdAt'> {
  return { id, kind, displayName: id, enabled: true, priority: 1, configRef: id }
}

function inbound(overrides: Partial<InboundEvent> = {}): InboundEvent {
  return {
    channelId: 'im-telegram',
    channelKind: 'im-telegram',
    message: { to: 'chat-777', from: 'user-555', text: '帮我总结一下' },
    allowed: true,
    sanitized: true,
    cleanContent: '帮我总结一下',
    ...overrides,
  }
}

beforeEach(() => {
  ;(ChannelRouter as unknown as { instance: ChannelRouter | null }).instance = null
  InboundBridge.reset()
  EventBus.getInstance().clear()
  IMMessageStore.getInstance().clear()
})

describe('IB-1: 基本闭环', () => {
  it('入站 → generator → ChannelRouter.send 回原通道原会话', async () => {
    const sendSpy = vi.fn(async () => {})
    const router = ChannelRouter.getInstance()
    router.register(stubChannel('im-telegram', sendSpy), meta('im-telegram', 'im-telegram'))

    const generator = vi.fn(async () => '这是模型生成的回复')
    const bridge = InboundBridge.getInstance({ replyGenerator: generator })
    await bridge.handle(inbound())

    expect(generator).toHaveBeenCalledOnce()
    expect(generator.mock.calls[0][0]).toMatchObject({
      channelId: 'im-telegram',
      to: 'chat-777',
      from: 'user-555',
      cleanContent: '帮我总结一下',
    })
    expect(sendSpy).toHaveBeenCalledOnce()
    expect(sendSpy.mock.calls[0][0]).toMatchObject({
      to: 'chat-777',
      from: 'new-world',
      text: '这是模型生成的回复',
    })
  })

  it('出站消息进 IMMessageStore(out)，与入站构成完整来回', async () => {
    const router = ChannelRouter.getInstance()
    router.register(stubChannel('im-telegram'), meta('im-telegram', 'im-telegram'))
    IMMessageStore.getInstance().record('im-telegram', 'in', { to: 'chat-777', text: 'hi' })

    await InboundBridge.getInstance({ replyGenerator: async () => 'reply' }).handle(inbound())
    const all = IMMessageStore.getInstance().query({ channelId: 'im-telegram' })
    expect(all).toHaveLength(2)
    expect(all[0].direction).toBe('in')
    expect(all[1].direction).toBe('out')
    expect(all[1].message.text).toBe('reply')
  })

  it('start() 后经 EventBus 发布事件也能触发闭环', async () => {
    const sendSpy = vi.fn(async () => {})
    ChannelRouter.getInstance().register(stubChannel('im-telegram', sendSpy), meta('im-telegram', 'im-telegram'))
    const bridge = InboundBridge.getInstance({ replyGenerator: async () => 'via bus' })
    bridge.start()
    expect(bridge.isStarted()).toBe(true)

    await EventBus.getInstance().publish('im:channel:incoming', inbound())
    expect(sendSpy).toHaveBeenCalledOnce()
    expect(sendSpy.mock.calls[0][0].text).toBe('via bus')
    bridge.stop()
    expect(bridge.isStarted()).toBe(false)
  })

  it('未 start 时不消费事件（stop 幂等）', async () => {
    const sendSpy = vi.fn(async () => {})
    ChannelRouter.getInstance().register(stubChannel('im-telegram', sendSpy), meta('im-telegram', 'im-telegram'))
    InboundBridge.getInstance({ replyGenerator: async () => 'x' })
    await EventBus.getInstance().publish('im:channel:incoming', inbound())
    expect(sendSpy).not.toHaveBeenCalled()
  })
})

describe('IB-2: 路由规则消费', () => {
  it('无匹配规则但 allowed+sanitized → 仍回原通道（不静默丢弃）', async () => {
    const sendSpy = vi.fn(async () => {})
    ChannelRouter.getInstance().register(stubChannel('im-telegram', sendSpy), meta('im-telegram', 'im-telegram'))
    await InboundBridge.getInstance({ replyGenerator: async () => 'ok' }).handle(
      inbound({ rejectReason: 'no matching route rule' }),
    )
    expect(sendSpy).toHaveBeenCalledOnce()
  })

  it('matchedRule 指向其它通道 → 按 targetChannel + targetUserId 转发', async () => {
    const tgSend = vi.fn(async () => {})
    const fsSend = vi.fn(async () => {})
    const router = ChannelRouter.getInstance()
    router.register(stubChannel('im-telegram', tgSend), meta('im-telegram', 'im-telegram'))
    router.register(stubChannel('im-feishu', fsSend), meta('im-feishu', 'im-feishu'))

    await InboundBridge.getInstance({ replyGenerator: async () => 'forwarded' }).handle(
      inbound({
        matchedRule: {
          id: 'r1', trigger: '日程', targetChannel: 'im-feishu',
          targetUserId: 'ou-123', priority: 50, enabled: true,
        },
      }),
    )
    expect(tgSend).not.toHaveBeenCalled()
    expect(fsSend).toHaveBeenCalledOnce()
    expect(fsSend.mock.calls[0][0]).toMatchObject({ to: 'ou-123', text: 'forwarded' })
  })

  it('目标通道未注册 → 回退原通道原会话，不发到错误的人', async () => {
    const tgSend = vi.fn(async () => {})
    ChannelRouter.getInstance().register(stubChannel('im-telegram', tgSend), meta('im-telegram', 'im-telegram'))
    await InboundBridge.getInstance({ replyGenerator: async () => 'fallback' }).handle(
      inbound({
        matchedRule: {
          id: 'r2', trigger: '.*', targetChannel: 'im-slack',
          targetUserId: 'wrong-user', priority: 1, enabled: true,
        },
      }),
    )
    expect(tgSend).toHaveBeenCalledOnce()
    expect(tgSend.mock.calls[0][0].to).toBe('chat-777')
  })
})

describe('IB-3: 拒绝 / 失败 / 边界', () => {
  it('allowed=false 或 sanitized=false → 不生成、不发送', async () => {
    const sendSpy = vi.fn(async () => {})
    ChannelRouter.getInstance().register(stubChannel('im-telegram', sendSpy), meta('im-telegram', 'im-telegram'))
    const generator = vi.fn(async () => 'should not run')
    const bridge = InboundBridge.getInstance({ replyGenerator: generator })
    await bridge.handle(inbound({ allowed: false, rejectReason: 'permission denied' }))
    await bridge.handle(inbound({ sanitized: false, rejectReason: 'dangerous pattern' }))
    expect(generator).not.toHaveBeenCalled()
    expect(sendSpy).not.toHaveBeenCalled()
  })

  it('cleanContent 为空 → 跳过', async () => {
    const sendSpy = vi.fn(async () => {})
    ChannelRouter.getInstance().register(stubChannel('im-telegram', sendSpy), meta('im-telegram', 'im-telegram'))
    await InboundBridge.getInstance({ replyGenerator: async () => 'x' }).handle(inbound({ cleanContent: '   ' }))
    expect(sendSpy).not.toHaveBeenCalled()
  })

  it('generator 抛错 → 回明确提示 + 发布 reply:failed，不伪造回答', async () => {
    const sendSpy = vi.fn(async () => {})
    ChannelRouter.getInstance().register(stubChannel('im-telegram', sendSpy), meta('im-telegram', 'im-telegram'))
    const failSpy = vi.fn()
    EventBus.getInstance().subscribe('im:channel:reply:failed', failSpy)
    const bridge = InboundBridge.getInstance({
      replyGenerator: async () => { throw new Error('未配置可用的 LLM 模型') },
    })
    await bridge.handle(inbound())
    expect(sendSpy).toHaveBeenCalledOnce()
    expect(sendSpy.mock.calls[0][0].text).toContain('未配置可用的 LLM 模型')
    await Promise.resolve()
    expect(failSpy).toHaveBeenCalled()
  })

  it('超长回复按 maxReplyLength 截断（Telegram 4096 上限）', async () => {
    const sendSpy = vi.fn(async () => {})
    ChannelRouter.getInstance().register(stubChannel('im-telegram', sendSpy), meta('im-telegram', 'im-telegram'))
    const bridge = InboundBridge.getInstance({
      replyGenerator: async () => 'x'.repeat(5000),
      maxReplyLength: 100,
    })
    await bridge.handle(inbound())
    expect(sendSpy.mock.calls[0][0].text).toHaveLength(100)
  })

  it('send 失败 → 发布 reply:failed（stage=send）', async () => {
    const router = ChannelRouter.getInstance()
    router.register(
      stubChannel('im-telegram', async () => { throw new Error('network down') }),
      meta('im-telegram', 'im-telegram'),
    )
    const failSpy = vi.fn()
    const sendFailSpy = vi.fn()
    EventBus.getInstance().subscribe('im:channel:reply:failed', failSpy)
    EventBus.getInstance().subscribe('im:channel:send:fail', sendFailSpy)
    await InboundBridge.getInstance({ replyGenerator: async () => 'hi' }).handle(inbound())
    await Promise.resolve()
    expect(failSpy).toHaveBeenCalledOnce()
    expect(failSpy.mock.calls[0][0]).toMatchObject({ stage: 'send' })
    expect(sendFailSpy).toHaveBeenCalled()
  }, 20_000)
})
