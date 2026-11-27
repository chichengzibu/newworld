/**
 * 【P2 可观测性】Voice 错误必须落本地台账
 *
 * 此前 Voice 的所有失败只写 UI 状态或静默吞掉（Voice.vue 注释还虚称"已 stub 上报"）。
 * 这里钉住：每条失败路径都会经 errors.report 进入 ErrorLedger，
 * 且领域 code 映射到独立 kind，不淹没在通用 unknown 里。
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { setActivePinia, createPinia } from 'pinia'
import { useVoiceStore } from '../../../src/stores/voice'

const report = vi.fn(async () => ({ success: true }))

function stubApi(voiceApi: Record<string, unknown> = {}): void {
  vi.stubGlobal('window', {
    electronAPI: {
      errors: { report },
      nova: { voice: voiceApi },
    },
  })
}

function lastRecord(): Record<string, unknown> {
  expect(report).toHaveBeenCalled()
  return report.mock.calls[report.mock.calls.length - 1][0] as Record<string, unknown>
}

describe('Voice 错误上报台账', () => {
  beforeEach(() => {
    setActivePinia(createPinia())
    report.mockClear()
    stubApi()
  })

  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it('V1: error 状态带 code 写入台账，用户文案与错误码同时保留', () => {
    const v = useVoiceStore()
    v.setState('error', '当前环境不支持语音合成。', { code: 'unavailable', source: 'voice:tts' })
    const rec = lastRecord()
    expect(rec.kind).toBe('voice-unavailable')
    expect(rec.source).toBe('voice:tts')
    expect(rec.message).toContain('unavailable')
    expect(v.errorText).toBe('当前环境不支持语音合成。')
  })

  it('V2: 领域 code → kind 映射齐全，不再统一落 unknown', () => {
    const v = useVoiceStore()
    const cases: Array<[string, string]> = [
      ['no-voice', 'voice-unavailable'],
      ['invalid-text', 'voice-invalid-text'],
      ['engine-error', 'voice-engine'],
      ['settings-failed', 'voice-settings'],
    ]
    for (const [code, kind] of cases) {
      report.mockClear()
      v.setState('error', 'msg', { code })
      expect(lastRecord().kind).toBe(kind)
    }
  })

  it('V3: 非 error 状态不产生台账记录', () => {
    const v = useVoiceStore()
    v.setState('speaking')
    v.setState('idle')
    expect(report).not.toHaveBeenCalled()
  })

  it('V4: 原始 Error 的 message/stack 原样透传', () => {
    const v = useVoiceStore()
    const cause = new Error('synthesis-failed')
    v.setState('error', '语音合成失败', { code: 'engine-error', cause })
    const rec = lastRecord()
    expect(rec.message).toBe('synthesis-failed')
    expect(String(rec.stack)).toContain('synthesis-failed')
  })

  it('V5: getSettings 返回 success:false 也上报，不再静默吞掉', async () => {
    stubApi({ getSettings: async () => ({ success: false, error: 'EIO' }) })
    const v = useVoiceStore()
    await v.loadSettings()
    const rec = lastRecord()
    expect(rec.kind).toBe('voice-settings')
    expect(rec.source).toBe('voice:settings')
    expect(rec.message).toContain('EIO')
  })

  it('V6: setSettings 抛错仍保留乐观值，同时上报', async () => {
    stubApi({ setSettings: async () => { throw new Error('IPC dead') } })
    const v = useVoiceStore()
    await v.persistSettings({ rate: 1.5 })
    expect(v.settings.rate).toBe(1.5)
    const rec = lastRecord()
    expect(rec.kind).toBe('voice-settings')
    expect(rec.message).toBe('IPC dead')
  })

  it('V7: 台账不可用（window 缺失）时不影响主流程', () => {
    vi.stubGlobal('window', undefined)
    const v = useVoiceStore()
    expect(() => v.setState('error', 'x', { code: 'unavailable' })).not.toThrow()
    expect(v.state).toBe('error')
  })
})
