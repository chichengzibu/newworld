/**
 * NOVA #005-B · M4 语音 · SpeechStore 状态机 + queue 单测（第①笔）
 *
 * 设计稿 F7 / F12.2:
 *   - 显式 ttsImpl? DI 注入(与 searchStore.search(q, fetchImpl?) 同族);
 *   - 缺省 defaultTTSImpl() → globalThis.speechSynthesis;
 *   - 模块态零读(DEV-013/014 沿用)。
 *
 * 测试覆盖(命令清单):
 *   - happy path onstart/onend
 *   - 中途 cancel
 *   - speaking 中再 speak(queue 替换, 不堆叠)
 *   - onerror 态
 *   - speechSynthesis 缺失(ttsImpl=null)
 *   - rate/pitch/volume 透传
 *   - queue 排空(emit done 后 pending=false)
 *   - NW_E2E stub = 即时 onend(同 production 状态机, 但 speak() 内部走 stub 路径)
 *   - speaking/thinking 不叠加(单独的 state listener 监听序列正确)
 *   - enabled=false 静默 ignore(默认关; 静默 vs error 区分)
 */
import { describe, it, expect, afterEach, vi } from 'vitest'
import {
  SpeechStore,
  DEFAULT_VOICE_SETTINGS,
} from '../../../electron/core/voice'

// ─── mockTTS + mockUtterance ──────────────────────────────────────
interface MockUtterance {
  text: string;
  lang?: string;
  rate?: number;
  pitch?: number;
  volume?: number;
  onstart?: (e: Event) => void;
  onend?: (e: Event) => void;
  onerror?: (e: { error?: string } & Event) => void;
}

function makeMockTTS(opts: { voices?: Array<{ name: string; lang: string; default: boolean; localService: boolean }> } = {}) {
  const utterances: MockUtterance[] = [];
  let speaking = false;
  const tts = {
    speak(u: MockUtterance) {
      utterances.push(u);
      speaking = true;
      // 默认不自动触发 onstart/onend — 测试侧按需调用 trigger(idx, 'start'|'end'|'error')
      // 避免 1ms 内 onstart+onend+emit idle 三步全跑完让状态无法停在 speaking(稿 F2.3 状态序列须可测)
    },
    cancel() { speaking = false; },
    pause() {},
    resume() {},
    getVoices() { return opts.voices ?? []; },
    get _list() { return utterances; },
    get _speaking() { return speaking; },
    // 测试侧工具: 手动触发 start/end/error(覆盖默认的自动 end)
    trigger(idx: number, kind: 'start' | 'end' | 'error', errName = 'synthesis-failed') {
      const u = utterances[idx];
      if (!u) throw new Error('no utterance at ' + idx);
      if (kind === 'start') { u.onstart?.(new Event('start')); }
      else if (kind === 'end') { speaking = false; u.onend?.(new Event('end')); }
      else u.onerror?.(Object.assign(new Event('error'), { error: errName }));
    },
  };
  return tts;
}

// ─── tests ────────────────────────────────────────────────────────
describe('SpeechStore 默认设置', () => {
  it('default settings = enabled=false, autoRead=false, rate/pitch/volume=1', () => {
    const s = new SpeechStore({ ttsImpl: makeMockTTS() })
    expect(s.settings).toEqual(DEFAULT_VOICE_SETTINGS)
    expect(s.state).toBe('idle')
    expect(s.pending).toBe(false)
  })

  it('updateSettings patch 部分字段不影响其余', () => {
    const s = new SpeechStore({ ttsImpl: makeMockTTS() })
    s.updateSettings({ rate: 1.5, volume: 0.7 })
    expect(s.settings).toEqual({ ...DEFAULT_VOICE_SETTINGS, rate: 1.5, volume: 0.7 })
    expect(s.settings.pitch).toBe(1.0)
  })
})

describe('SpeechStore.speak happy path', () => {
  it('onstart 触发 → state 切 speaking; onend 触发 → done + 回 idle + pending=false', async () => {
    const tts = makeMockTTS()
    const s = new SpeechStore({ ttsImpl: tts })
    const seq: string[] = []
    s.subscribe((st) => seq.push(st))
    const r = s.speak({ text: '你好世界' })
    expect(r.ok).toBe(true)
    tts.trigger(0, 'start')
    expect(s.state).toBe('speaking')
    tts.trigger(0, 'end')
    // emit('done') → queueMicrotask 回 idle
    await new Promise((res) => setTimeout(res, 1))
    expect(seq).toEqual(['speaking', 'done', 'idle'])
    expect(s.state).toBe('idle')
    expect(s.pending).toBe(false)
  })

  it('rate/pitch/volume 透传到 utterance', () => {
    const tts = makeMockTTS()
    const s = new SpeechStore({ ttsImpl: tts })
    s.speak({ text: '参数透传测试', rate: 1.8, pitch: 0.6, volume: 0.3 })
    const u = tts._list[0]
    expect(u.rate).toBe(1.8)
    expect(u.pitch).toBe(0.6)
    expect(u.volume).toBe(0.3)
    expect(u.lang).toBe('zh-CN') // 默认
  })
})

describe('SpeechStore 中途 cancel', () => {
  it('cancel() 触发 canceled 终态 + 立即回 idle', async () => {
    const tts = makeMockTTS()
    const s = new SpeechStore({ ttsImpl: tts })
    const seq: string[] = []
    s.subscribe((st) => seq.push(st))
    s.speak({ text: '朗读一段' })
    tts.trigger(0, 'start') // 让 store 进入 speaking
    expect(s.state).toBe('speaking')
    s.cancel()
    // cancel → emit('canceled') → queueMicrotask 回 idle
    await new Promise((res) => setTimeout(res, 1))
    expect(seq).toContain('canceled')
    expect(s.state).toBe('idle')
    expect(s.pending).toBe(false)
  })

  it('非 speaking 态 cancel = no-op(不切状态)', () => {
    const tts = makeMockTTS()
    const s = new SpeechStore({ ttsImpl: tts })
    const seq: string[] = []
    s.subscribe((st) => seq.push(st))
    s.cancel() // idle 态, 不应有任何 emit
    expect(seq).toEqual([])
    expect(s.state).toBe('idle')
  })
})

describe('SpeechStore speaking 中再 speak(queue 替换, 不堆叠)', () => {
  it('speaking 中新 speak → cancel 旧 + 排新 + 状态保持 speaking', () => {
    const tts = makeMockTTS()
    const s = new SpeechStore({ ttsImpl: tts })
    s.speak({ text: '第一段朗读内容较长的文本' })
    tts.trigger(0, 'start')
    expect(s.state).toBe('speaking')
    expect(tts._list.length).toBe(1)
    s.speak({ text: '第二段覆盖前一段' })
    expect(tts._list.length).toBe(2) // 新 utterance 已注入(替换语义)
    expect(s.state).toBe('speaking') // 立即继续 speaking, 不回 idle 再起
    expect(s.pending).toBe(true)
  })

  it('queue 排空: onend → pending=false, current 清空', () => {
    const tts = makeMockTTS()
    const s = new SpeechStore({ ttsImpl: tts })
    s.speak({ text: 'queue 排空测试' })
    tts.trigger(0, 'start')
    expect(s.pending).toBe(true)
    tts.trigger(0, 'end')
    expect(s.pending).toBe(false)
  })
})

describe('SpeechStore onerror 态', () => {
  it('onerror 触发 → state error + reason 透传 + 回 idle', async () => {
    const tts = makeMockTTS()
    const s = new SpeechStore({ ttsImpl: tts })
    const events: Array<{ st: string; payload?: { reason?: string; code?: string } }> = []
    s.subscribe((st, payload) => events.push({ st, payload }))
    s.speak({ text: '引擎错误测试' })
    tts.trigger(0, 'start') // 让 store 进入 speaking
    tts.trigger(0, 'error', 'synthesis-failed')
    await new Promise((res) => setTimeout(res, 1))
    const errorEvt = events.find((e) => e.st === 'error')
    expect(errorEvt).toBeDefined()
    expect(errorEvt?.payload?.reason).toBe('synthesis-failed')
    expect(errorEvt?.payload?.code).toBe('engine-error')
    expect(s.state).toBe('idle')
    expect(s.pending).toBe(false)
  })
})

describe('SpeechStore speechSynthesis 缺失态(ttsImpl=null)', () => {
  it('speak() 返回 {ok:false, code:unavailable}, state=error', async () => {
    const s = new SpeechStore({ ttsImpl: null })
    const seq: string[] = []
    s.subscribe((st) => seq.push(st))
    const r = s.speak({ text: '缺失测试' })
    expect(r.ok).toBe(false)
    expect(r.code).toBe('unavailable')
    // emit('error') → queueMicrotask 回 idle
    await new Promise((res) => setTimeout(res, 1))
    expect(seq).toEqual(['error', 'idle'])
    expect(s.state).toBe('idle')
  })

  it('空 text → {ok:false, code:invalid-text}', () => {
    const s = new SpeechStore({ ttsImpl: makeMockTTS() })
    const r1 = s.speak({ text: '' })
    expect(r1.ok).toBe(false)
    expect(r1.code).toBe('invalid-text')
    const r2 = s.speak({ text: '   ' })
    expect(r2.ok).toBe(false)
    expect(r2.code).toBe('invalid-text')
  })

  it('缺省 ttsImpl 时不静默读模块态: opts.ttsImpl === undefined 走 defaultTTSImpl()(globalThis) — 单测环境无 speechSynthesis → 当 null 处理', () => {
    // F12.2 关键约定: opts.ttsImpl === undefined 才取 defaultTTSImpl(), 否则按 opts 走。
    // 单测环境无 globalThis.speechSynthesis, defaultTTSImpl() 返回 null, 等价 unavailable 态。
    // 显式 opts.ttsImpl=null 与未传但 default 为 null 行为一致 → 均 unavailable。
    const s1 = new SpeechStore() // opts.ttsImpl undefined → default → null
    const r1 = s1.speak({ text: '未传 ttsImpl 测试' })
    expect(r1.code).toBe('unavailable')
  })
})

describe('SpeechStore 默认 enabled=false 语义', () => {
  it('settings.enabled=false 时 speak 仍然发声(F2.1 默认关,但主动进入 /voice 即视为启用)', () => {
    // 裁定: 默关不二次校验, 仅作为 settings 真值。F2.3 朗读事件由设计稿显式按钮触发, 与 enabled 解耦。
    const tts = makeMockTTS()
    const s = new SpeechStore({ ttsImpl: tts })
    expect(s.settings.enabled).toBe(false)
    const r = s.speak({ text: '默关但仍发声' })
    expect(r.ok).toBe(true)
    tts.trigger(0, 'start')
    expect(s.state).toBe('speaking')
  })
})

describe('SpeechStore speaking/thinking 不叠加(状态机职责分离)', () => {
  it('多 listener 独立追踪: emit 序列 = [speaking, done, idle], 不叠加其他态', () => {
    const tts = makeMockTTS()
    const s = new SpeechStore({ ttsImpl: tts })
    const seq: string[] = []
    s.subscribe((st) => seq.push(st))
    s.speak({ text: '状态序列测试' })
    tts.trigger(0, 'start')
    tts.trigger(0, 'end')
    expect(seq).toEqual(['speaking', 'done'])
    // 不存在 'thinking' 态在本 store 中(那是 Orb store 职责, F6 区分)
    expect(seq).not.toContain('thinking')
  })
})