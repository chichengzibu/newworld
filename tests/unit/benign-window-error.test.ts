// @vitest-environment node
/**
 * 良性 window.error 白名单单测（v4.8）
 *
 * 钉住一条健壮性边界：Chromium 的 ResizeObserver loop 通知必须以 window.error
 * 派发，但它是良性的（下一帧自动收敛）。若挂全屏红框，会把整个应用伪装成崩溃
 * —— 实测长对话布局变化时稳定触发，e2e chat-long-conversation L3/L5 被它拦。
 * 同时反向锁定：真正的错误绝不能被误过滤，否则错误兜底形同虚设。
 */
import { describe, it, expect } from 'vitest'
import { isBenignWindowError } from '../../src/utils/reportLedger'

describe('isBenignWindowError', () => {
  it('ResizeObserver 两种良性通知都被识别', () => {
    expect(isBenignWindowError('ResizeObserver loop completed with undelivered notifications.')).toBe(true)
    expect(isBenignWindowError('ResizeObserver loop limit exceeded')).toBe(true)
  })

  it('空消息不误判', () => {
    expect(isBenignWindowError('')).toBe(false)
    expect(isBenignWindowError(undefined)).toBe(false)
    expect(isBenignWindowError(null)).toBe(false)
  })

  it('真错误不被误过滤（红屏兜底仍有效）', () => {
    expect(isBenignWindowError('TypeError: getVirtualItems is not a function')).toBe(false)
    expect(isBenignWindowError('ChunkLoadError: Loading chunk 5 failed')).toBe(false)
    expect(isBenignWindowError('Cannot read properties of undefined')).toBe(false)
    // 相似但不同的消息不能被前缀规则吞掉
    expect(isBenignWindowError('MyResizeObserver loop completed with undelivered notifications')).toBe(false)
  })
})
