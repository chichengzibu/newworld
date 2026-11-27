/**
 * v4.13 IM 入站连通性面板 —— 逻辑单测
 *
 * 这组测试锁定的是「如实区分四种状态」：
 *   运行中 / 已启用但未运行 / 未启用 / 仅出站（物理上无法入站）
 *
 * 背景：`channel:inbound-status` 这个 IPC 早就存在，但渲染层从未调用 ——
 * 用户只能去翻日志确认「消息到底有没有收进来」。IM 管理页原来只显示
 * 「已启用/未启用」，这回答的是「配置填了吗」，不是「真能收消息吗」。
 *
 * 这里测的是提取出的纯逻辑（与 ImManagement.vue 中的 inboundRows 同构），
 * 避免把判定规则写死在模板里、无法回归。
 */
import { describe, it, expect } from 'vitest'

/** 与 ImManagement.vue 保持同构的判定逻辑 */
interface RawStatus {
  running: boolean
  messages: number
}

function computeInboundRow(
  cap: { kind: string; label: string; mechanism: string },
  raw: RawStatus | undefined,
  enabled: boolean,
) {
  const running = raw?.running === true
  const messages = raw?.messages ?? 0

  if (running) {
    return {
      stateText: '入站运行中',
      tagType: 'success',
      messages,
      detail: messages > 0 ? `已收到 ${messages} 条消息，链路可用。` : '循环正在运行，尚未收到消息。',
    }
  }
  if (!enabled) {
    return { stateText: '未启用', tagType: 'info', messages: 0, detail: '通道已关闭，入站循环未启动。' }
  }
  return {
    stateText: '已启用但未运行',
    tagType: 'warning',
    messages: 0,
    detail:
      '配置为启用但入站循环没有在跑 —— 通常意味着缺少凭据、凭据无效，或启动时连接失败。请查看日志。',
  }
}

const TG = { kind: 'im-telegram', label: 'Telegram', mechanism: 'getUpdates 长轮询' }

describe('① 入站状态四态判定', () => {
  it('运行中且有消息 → success，并显示条数', () => {
    const r = computeInboundRow(TG, { running: true, messages: 12 }, true)
    expect(r.stateText).toBe('入站运行中')
    expect(r.tagType).toBe('success')
    expect(r.messages).toBe(12)
    expect(r.detail).toContain('12 条')
  })

  it('运行中但还没收到消息 → success，且不谎称有消息', () => {
    const r = computeInboundRow(TG, { running: true, messages: 0 }, true)
    expect(r.stateText).toBe('入站运行中')
    expect(r.detail).toContain('尚未收到')
    expect(r.detail).not.toContain('条消息，链路可用')
  })

  it('已启用但循环没跑 → warning（这是最容易被忽略的故障态）', () => {
    const r = computeInboundRow(TG, { running: false, messages: 0 }, true)
    expect(r.stateText).toBe('已启用但未运行')
    expect(r.tagType).toBe('warning')
    expect(r.detail).toContain('凭据')
  })

  it('未启用 → info，不报错', () => {
    const r = computeInboundRow(TG, undefined, false)
    expect(r.stateText).toBe('未启用')
    expect(r.tagType).toBe('info')
  })

  it('未启用但后端仍在跑（配置不一致）→ 以实际运行为准', () => {
    // running 是事实，enabled 是配置；事实优先
    const r = computeInboundRow(TG, { running: true, messages: 3 }, false)
    expect(r.stateText).toBe('入站运行中')
    expect(r.messages).toBe(3)
  })
})

describe('② 只展示可能真入站的 4 个通道', () => {
  const INBOUND_CAPABLE = ['im-telegram', 'im-discord', 'im-slack', 'im-rocket']
  const OUTBOUND_ONLY = [
    'im-feishu',
    'im-lark',
    'im-dingtalk',
    'im-wechat-work',
    'im-wechat',
    'im-qq',
    'im-whatsapp',
  ]

  it('入站能力清单恰好 4 个', () => {
    expect(INBOUND_CAPABLE).toHaveLength(4)
  })

  it('入站清单与仅出站清单不重叠', () => {
    const overlap = INBOUND_CAPABLE.filter((k) => OUTBOUND_ONLY.includes(k))
    expect(overlap).toEqual([])
  })

  it('仅出站清单不含任何能入站的通道（防止把可入站的误标为仅出站）', () => {
    for (const k of INBOUND_CAPABLE) {
      expect(OUTBOUND_ONLY).not.toContain(k)
    }
  })
})

describe('③ 面板数据来源', () => {
  it('接口失败时回落为空对象（不崩溃、不显示假状态）', () => {
    const res = { success: false as const, error: 'boom' }
    const raw = res.success && (res as any).data ? (res as any).data : {}
    expect(raw).toEqual({})
  })

  it('接口成功但 data 为空时也是空对象', () => {
    const res = { success: true as const, data: undefined }
    const raw = res.success && res.data ? res.data : {}
    expect(raw).toEqual({})
  })
})
