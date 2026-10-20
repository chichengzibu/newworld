/**
 * NOVA #005-B · M4 语音 · types + VoiceRegistry 单测（第①笔）
 *
 * 设计稿:
 *   - DEFAULT_VOICE_SETTINGS 默认值锁定
 *   - VoiceRegistry 单例 + setTTSImpl 注入(可置 null 模拟缺失态) + getInstance 对标单例家族
 *   - defaultTTSImpl() 在 globalThis 无 speechSynthesis 时返回 null
 */
import { describe, it, expect, afterEach } from 'vitest'
import {
  DEFAULT_VOICE_SETTINGS,
  VoiceRegistry,
  defaultTTSImpl,
  type TTSImpl,
} from '../../../electron/core/voice'

describe('VoiceRegistry 单例家族', () => {
  afterEach(() => VoiceRegistry.resetForTest())

  it('getInstance 返同实例(对标 ConfigStore / GlobalShortcut / SearchRegistry 风格)', () => {
    const a = VoiceRegistry.getInstance()
    const b = VoiceRegistry.getInstance()
    expect(a).toBe(b)
  })

  it('resetForTest 后下次 getInstance 拿新实例', () => {
    const a = VoiceRegistry.getInstance()
    VoiceRegistry.resetForTest()
    const b = VoiceRegistry.getInstance()
    expect(a).not.toBe(b)
  })

  it('getTTSImpl 默认 = defaultTTSImpl()(globalThis.speechSynthesis 适配), 测试环境无 → null', () => {
    const r = VoiceRegistry.getInstance()
    expect(r.getTTSImpl()).toBe(defaultTTSImpl())
    expect(r.getTTSImpl()).toBeNull() // 单测 node 环境无 globalThis.speechSynthesis
  })

  it('setTTSImpl(mock) → getTTSImpl 返同 mock; hasInjected=true', () => {
    const r = VoiceRegistry.getInstance()
    const mockTTS: TTSImpl = {
      speak: () => {},
      cancel: () => {},
      pause: () => {},
      resume: () => {},
      getVoices: () => [],
    }
    r.setTTSImpl(mockTTS)
    expect(r.getTTSImpl()).toBe(mockTTS)
    expect(r.hasInjected()).toBe(true)
  })

  it('setTTSImpl(null) 显式置空模拟缺失态, hasInjected=true', () => {
    const r = VoiceRegistry.getInstance()
    r.setTTSImpl(null)
    expect(r.getTTSImpl()).toBeNull()
    expect(r.hasInjected()).toBe(true)
  })
})

describe('DEFAULT_VOICE_SETTINGS', () => {
  it('enabled=false, autoRead=false, rate=1, pitch=1, volume=1', () => {
    expect(DEFAULT_VOICE_SETTINGS).toEqual({
      enabled: false,
      autoRead: false,
      rate: 1.0,
      pitch: 1.0,
      volume: 1.0,
    })
  })

  it('Object.freeze: 任何字段写改均抛 TypeError(锁定语义, 禁止外部写)', () => {
    expect(() => { (DEFAULT_VOICE_SETTINGS as { enabled: boolean }).enabled = true }).toThrow(TypeError)
    expect(() => { (DEFAULT_VOICE_SETTINGS as { rate: number }).rate = 2 }).toThrow(TypeError)
  })
})

describe('defaultTTSImpl()', () => {
  it('globalThis 无 speechSynthesis → 返 null', () => {
    const g = globalThis as unknown as { speechSynthesis?: unknown }
    const before = g.speechSynthesis
    try {
      delete g.speechSynthesis
      expect(defaultTTSImpl()).toBeNull()
    } finally {
      if (before !== undefined) g.speechSynthesis = before
    }
  })

  it('globalThis 有 speechSynthesis → 返适配对象(返回同一对象引用)', () => {
    const g = globalThis as unknown as { speechSynthesis?: unknown }
    const before = g.speechSynthesis
    try {
      const fake = { speak: () => {} }
      g.speechSynthesis = fake
      const t = defaultTTSImpl()
      expect(t).toBe(fake)
    } finally {
      if (before !== undefined) g.speechSynthesis = before
      else delete g.speechSynthesis
    }
  })
})